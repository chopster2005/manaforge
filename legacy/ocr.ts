// On-device OCR — the PRIMARY recognition path.
//
// Tesseract.js is lazy-loaded from CDN the first time the Scan tab opens and
// exactly ONE worker is created and kept alive for the whole session. The
// worker only ever sees the card's TITLE BAND, cropped relative to the
// DETECTED CARD rectangle (see detect.ts) — never relative to the on-screen
// guide, which is wrong whenever the card doesn't fill the guide (scanner
// box!). Matching against the downloaded name index is 100% local, so a
// confident scan makes ZERO server calls.
//
// Robustness rules (learned from real-phone failures):
// - Every recognize is capped at 4s; a timed-out attempt's late result is
//   discarded and the SAME worker is reused — restarting on a single
//   timeout made the next card pay the multi-second re-warm (the user's
//   "Scanner restarted, 6.6s" stalls). The worker is terminated and
//   recreated only after TWO CONSECUTIVE timeouts (a genuinely wedged
//   worker) or two consecutive plain errors — and at most ONE such
//   automatic restart happens per scanning session (resetOcrSession);
//   beyond that the failure surfaces as a "scanner is struggling" event
//   instead of another restart loop. Recognition therefore ALWAYS
//   settles — no scan can hang forever and need a page refresh.
// - Burst scans read ONE title band + ONE bottom band per frame (fast
//   settings only) and pool across frames; the wider variant pool is
//   reserved for manual Snap when the burst pool comes back empty.

import { analyzeBottomBand, assessStripInk, BLEACHED_BAND_REASON, classifyBandBleach, raceWithCap, stripAimShift, STRIP_INK_FLOOR, stripWindowCentred, type BandBleachAnalysis, type BottomBandAnalysis, type StripInkAssessment } from "./scanflow";

export type OcrStatus = "idle" | "loading" | "ready" | "error";

interface TesseractWorkerLike {
  setParameters: (params: Record<string, string>) => Promise<unknown>;
  recognize: (image: HTMLCanvasElement) => Promise<{ data: { text: string } }>;
  terminate?: () => Promise<unknown>;
}

interface TesseractGlobal {
  createWorker: (langs: string) => Promise<TesseractWorkerLike>;
}

declare global {
  interface Window {
    Tesseract?: TesseractGlobal;
  }
}

const TESSERACT_CDN = "https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/tesseract.min.js";
export const OCR_TIMEOUT_MS = 4000;

let status: OcrStatus = "idle";
let statusError = "";
const listeners = new Set<(s: OcrStatus) => void>();
const eventListeners = new Set<(msg: string) => void>();
let workerPromise: Promise<TesseractWorkerLike> | null = null;
let scriptPromise: Promise<void> | null = null;
// Serialize recognize calls — one worker, one read at a time.
let queue: Promise<unknown> = Promise.resolve();
let consecutiveFailures = 0;
let consecutiveTimeouts = 0;
// At most ONE automatic worker restart per scanning session: the user's
// Snap failures looped restart → re-warm → timeout → restart while the
// card sat there correctly identified by detection. After the one
// restart is spent, further timeout streaks surface as a "scanner is
// struggling" event and the worker is simply reused.
let autoRestartsUsed = 0;
const MAX_AUTO_RESTARTS_PER_SESSION = 1;

/** Reset the per-session restart budget (Scan tab mount / new session). */
export function resetOcrSession(): void {
  autoRestartsUsed = 0;
}

export function getAutoRestartsUsed(): number {
  return autoRestartsUsed;
}

// ---------------------------------------------------------------------------
// Pass 15 — per-attempt job tagging + zombie recycle (Evidence B).
//
// The sequence test (tests/harness/sequence.ts) REPRODUCED the user's
// "first card works, the next one is worse" on the real worker: a
// speckle attempt's reads were abandoned at their caps, but the
// abandoned jobs kept EXECUTING serially inside the single shared
// worker; the next two attempts' title reads queued behind the
// zombies, paid their full caps, and settled with nothing (title
// ~2.5s, no identification) until the queue drained. Deadline
// settlement discards a timed-out read's RESULT — it cannot stop the
// worker spending the time, and the old swap budget (one silent swap
// per session) is spent by the first poisoned attempt.
//
// Two mechanisms, both measured by the sequence test:
//  1. ATTEMPT GENERATIONS. Every identifyBurst begins a new
//     generation (beginScanAttempt) and tags its reads with it. A
//     queued job that reaches the front of the queue under an OLD
//     generation is dropped WITHOUT touching the worker — its result
//     would be discarded by the attempt token anyway, so the worker
//     must not spend time producing it.
//  2. ZOMBIE RECYCLE BETWEEN ATTEMPTS. Reads abandoned by an outer
//     cap (the capped readers below) and reads that hit the queue's
//     own timeout are tracked as outstanding zombies until their
//     underlying job actually settles. If any zombie is still
//     outstanding when the NEXT attempt begins, the worker is
//     terminated and recreated once, right there — between attempts,
//     never mid-attempt, and only with a live zombie to kill. This is
//     deliberately separate from the max-1-auto-restart budget: that
//     budget governs mid-attempt restarts (which used to wedge
//     Rapid); a between-attempt recycle gated on a live zombie
//     cannot loop — a clean attempt leaves no zombie behind.
// ---------------------------------------------------------------------------

let ocrGeneration = 0;
let zombieOutstanding = 0;
let zombieRecycles = 0;

/** Track a read that was abandoned while its worker job may still be
 * executing; the count clears when the job actually settles. */
function trackZombie(p: Promise<unknown>): void {
  zombieOutstanding += 1;
  const done = (): void => {
    zombieOutstanding = Math.max(0, zombieOutstanding - 1);
  };
  p.then(done, done);
}

/** Terminate the current worker and warm a fresh one, silently. The
 * queue is reset so nothing stale can run on the new worker. */
function recycleWorkerNow(): void {
  const stale = workerPromise;
  workerPromise = null;
  queue = Promise.resolve();
  consecutiveFailures = 0;
  consecutiveTimeouts = 0;
  if (stale) {
    void stale
      .then((w) => w.terminate?.())
      .catch(() => undefined)
      .finally(() => {
        void ensureOcrWorker().catch(() => undefined);
      });
  } else {
    void ensureOcrWorker().catch(() => undefined);
  }
}

/**
 * Begin a new scan attempt's OCR generation: reads tagged with older
 * generations are dropped when they reach the queue front, and a
 * worker still executing a previous attempt's abandoned job is
 * recycled before this attempt's first read can queue behind it.
 * Returns the new generation to tag this attempt's reads with.
 */
export function beginScanAttempt(): number {
  ocrGeneration += 1;
  if (zombieOutstanding > 0) {
    zombieOutstanding = 0;
    zombieRecycles += 1;
    recycleWorkerNow();
  }
  return ocrGeneration;
}

export function getZombieRecycles(): number {
  return zombieRecycles;
}

function setStatus(next: OcrStatus, error = ""): void {
  status = next;
  statusError = error;
  for (const fn of listeners) fn(next);
}

function emitEvent(msg: string): void {
  for (const fn of eventListeners) fn(msg);
}

export function getOcrStatus(): OcrStatus {
  return status;
}

export function getOcrError(): string {
  return statusError;
}

export function onOcrStatus(fn: (s: OcrStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** One-shot scanner events for the status line ("Scanner restarted", …). */
export function onScannerEvent(fn: (msg: string) => void): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

function loadScript(): Promise<void> {
  if (window.Tesseract) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = TESSERACT_CDN;
    el.async = true;
    el.onload = () => (window.Tesseract ? resolve() : reject(new Error("Tesseract.js loaded but exposed no global")));
    el.onerror = () => reject(new Error("Tesseract.js could not be loaded from the CDN"));
    document.head.appendChild(el);
  });
  return scriptPromise;
}

/**
 * Create (once) and return the shared worker. Safe to call repeatedly and
 * concurrently — every caller gets the same promise/worker.
 */
export function ensureOcrWorker(): Promise<TesseractWorkerLike> {
  if (workerPromise) return workerPromise;
  setStatus("loading");
  workerPromise = (async () => {
    await loadScript();
    const tess = window.Tesseract;
    if (!tess) throw new Error("Tesseract.js unavailable");
    const worker = await tess.createWorker("eng");
    setStatus("ready");
    return worker;
  })().catch((err: unknown) => {
    workerPromise = null;
    setStatus("error", err instanceof Error ? err.message : String(err));
    throw err;
  });
  return workerPromise;
}

/** Warm the worker in the background (Scan tab mount). Never throws. */
export function warmUpOcr(): void {
  void ensureOcrWorker().catch(() => undefined);
}

/**
 * Terminate the current worker (if any) and forget it; the next read
 * recreates a fresh one. Used after timeouts/errors and by the app's
 * watchdog. The read queue is reset so a wedged recognize can never block
 * later scans.
 */
export function restartOcrWorker(reason = "Scanner restarted"): void {
  const stale = workerPromise;
  workerPromise = null;
  queue = Promise.resolve();
  consecutiveFailures = 0;
  consecutiveTimeouts = 0;
  setStatus("loading");
  if (stale) {
    void stale
      .then((w) => w.terminate?.())
      .catch(() => undefined)
      .finally(() => {
        // Recreate eagerly so the restart cost is paid now, not mid-scan.
        void ensureOcrWorker().catch(() => undefined);
      });
  } else {
    void ensureOcrWorker().catch(() => undefined);
  }
  emitEvent(reason);
}

function restartOrStruggle(reason: string): void {
  consecutiveFailures = 0;
  consecutiveTimeouts = 0;
  if (autoRestartsUsed >= MAX_AUTO_RESTARTS_PER_SESSION) {
    // The one restart is spent — never loop restarts. Tell the user
    // plainly and keep reusing the worker for the next attempt.
    emitEvent("Scanner is struggling with this card — try Rapid or Take Photo");
    return;
  }
  autoRestartsUsed += 1;
  restartOcrWorker(reason);
}

function noteReadFailure(kind: "timeout" | "error"): void {
  // A single timeout does NOT restart the worker: the attempt is
  // discarded, the worker is reused, and only a SECOND consecutive
  // timeout (the signature of a truly wedged worker) pays the re-warm —
  // and even that only once per session (see restartOrStruggle).
  if (kind === "timeout") {
    consecutiveTimeouts += 1;
    consecutiveFailures = 0;
    if (consecutiveTimeouts >= 2) {
      restartOrStruggle("Scanner restarted (repeated read timeouts)");
    }
    return;
  }
  consecutiveTimeouts = 0;
  consecutiveFailures += 1;
  if (consecutiveFailures >= 2) {
    restartOrStruggle("Scanner restarted (repeated read errors)");
  }
}

function noteReadSuccess(): void {
  consecutiveFailures = 0;
  consecutiveTimeouts = 0;
}

class OcrTimeoutError extends Error {
  constructor(ms: number) {
    super(`OCR read timed out after ${ms}ms`);
    this.name = "OcrTimeoutError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new OcrTimeoutError(ms)), ms);
    p.then(
      (v) => { window.clearTimeout(timer); resolve(v); },
      (e: unknown) => { window.clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

export type TitleTreatment = "contrast" | "threshold" | "adaptive" | "bottomline";

/** A title-band window, as fractions of the CARD crop (not the guide). */
export interface BandSpec {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  treatment: TitleTreatment;
  /** Which window this is ("standard" / "offset+4" / "offset+8" /
   * "tall") — reported in the scan diagnostics so a rescued scan
   * names the read that found the name. */
  label?: string;
  /** Deskew: rotate the BUILT band image by this many degrees
   * (canvas sense: positive = clockwise) before OCR. A card seated a
   * few degrees off square keeps its title inside the standard band
   * (detection IoU stays ≥0.945 at ±5°) but the glyphs lean, and the
   * reader garbles leaning text far sooner than the matcher can
   * repair. Rotating the thin band strip back to horizontal is the
   * cheapest possible correction: no re-detection, no new geometry —
   * the strip grows just tall enough to hold the rotated line. */
  rotate?: number;
  /** Auto Light (Pass 17): software exposure lift — every pixel of the
   * drawn band is multiplied by this gain (clamped at 255) BEFORE the
   * treatment runs. Set ONLY from the band's own metering (see
   * autolight.ts: gain from p90, capped at ×4) and only when the band
   * measured DIM, so bright bands never carry a lift and the
   * good-light path is byte-for-byte unchanged. */
  lift?: number;
  /** Aim this window at its text row MEASURED in the crop's own
   * pixels instead of trusting the fixed fraction. Bottom strips
   * (Pass 18, aimBottomSpec): a few % of crop slack pushed the whole
   * printed block above the fixed window on the user's FRA-frame
   * card, and the strip read tray + border while the exact
   * (set, number) sat unread a centimetre higher. The standard title
   * window (Pass 26, aimTitleSpec): the same slack in hand-held
   * captures put the window on bright background above the card
   * while the title sat a few % lower, unread. */
  aim?: boolean;
}

/**
 * The pooled band variants, best first. x spans 1%–83% of card width
 * (Pass 9: padded ~3% on both sides of the old 4%–80% window — the
 * tight left edge clipped title first letters inconsistently, which is
 * how 'Divergent Equation' came back as 'Divergent ae' on one attempt
 * and 'iverson tquation' on the next; 83% still stops short of the
 * mana-cost corner at ~85%+, which is pure OCR debris). The second
 * variant shifts the window ~2% further LEFT (x0 = 0): when detection
 * sits a hair right of the card's true edge, the title's first letter
 * is inside this window even when the standard window clips it.
 * Variants are tried in order and the caller stops at the first
 * confident local match, so the later variants cost nothing on a clean
 * card. The last variant sits LOWER (y 8–17%): when the bottom of the
 * card is occluded or the shot is at an angle, the detected rectangle
 * is shorter than the true card and the title lands below the standard
 * windows — exactly what the user's Kemba photo showed.
 */
export const BAND_VARIANTS: BandSpec[] = [
  { x0: 0.01, x1: 0.83, y0: 0.025, y1: 0.11, treatment: "contrast", label: "standard", aim: true },
  { x0: 0.0, x1: 0.81, y0: 0.025, y1: 0.11, treatment: "contrast", label: "left-shift" },
  { x0: 0.01, x1: 0.83, y0: 0.04, y1: 0.125, treatment: "contrast", label: "standard-low" },
  { x0: 0.01, x1: 0.83, y0: 0.025, y1: 0.11, treatment: "adaptive", label: "adaptive" },
  { x0: 0.01, x1: 0.83, y0: 0.08, y1: 0.17, treatment: "contrast", label: "low" },
];

/**
 * RESCUE title bands (Pass 8) — the search window that makes the name
 * easier to find when the standard band missed it. Hand-held shots
 * (tilt, a dark card border on dark cloth) shift the true title row
 * DOWN relative to the computed band: in the user's Snooping Page
 * shot the standard band landed entirely ABOVE the title (a black
 * strip), and in his Elemental Mascot shot the title sat at the
 * standard band's very bottom edge under the frame's black slab. The
 * rescue reads the standard window shifted +4% and +8% of card height
 * downward, plus one TALL band (y 2%–16%) read multi-line (PSM 6) —
 * the name is SOME line inside it and the pooled matcher picks the
 * name line out. Tried only after the standard burst reads and the
 * collector-number rescue both come up empty.
 */
export const TITLE_OFFSET_BAND_4: BandSpec = { x0: 0.01, x1: 0.83, y0: 0.065, y1: 0.15, treatment: "contrast", label: "offset+4" };
export const TITLE_OFFSET_BAND_8: BandSpec = { x0: 0.01, x1: 0.83, y0: 0.105, y1: 0.19, treatment: "contrast", label: "offset+8" };
export const TITLE_TALL_BAND: BandSpec = { x0: 0.01, x1: 0.83, y0: 0.02, y1: 0.16, treatment: "contrast", label: "tall" };
/** The standard window shifted ~1% further left (x0 = 0) — the same
 * window BAND_VARIANTS carries for the Precise path. Appended LAST in
 * the rescue order (triage pass) so every existing rescue win keeps
 * its exact read order: the measured gap it closes is the user's
 * Pyroblast photo, whose detected crop reads as glyph soup in the
 * standard window ('ara a TR AAO Bt A...') while this window — 1%
 * further left, off the frame's left-edge bevel — returns the exact
 * title ('- Pyroblast 3', pooled 0.914). On textured light-on-dark
 * frames the reader's binarisation is marginal enough that the
 * window's exact pixel phase decides legibility; one more phase is
 * the cheapest rescue there is. */
export const TITLE_LEFT_BAND: BandSpec = { x0: 0.0, x1: 0.81, y0: 0.025, y1: 0.11, treatment: "contrast", label: "left-shift" };
export const TITLE_RESCUE_BANDS: BandSpec[] = [TITLE_OFFSET_BAND_4, TITLE_OFFSET_BAND_8, TITLE_TALL_BAND, TITLE_LEFT_BAND];

/**
 * DESKEW rescue bands (triage pass): the standard window, read with
 * the band image rotated ±5° / ±2.5°. Tried ONLY after every straight
 * read has failed (burst pool, collector-number rescue, offset/tall
 * rescue bands), so a straight-on card never pays for them. The
 * measured failure they answer: synthetic cards rotated ±5°/−2° are
 * detected with IoU ≥0.945 and the title centroid inside the standard
 * band, yet the pooled title reads come back as glyph soup
 * ('ers SR - TY . - - rece Se LN I a L') — a geometry-perfect read of
 * leaning text. One of the four rotations is within ~0.5° of the true
 * deskew for any tilt in ±5°, and the per-read match check (≥0.82)
 * keeps a wrong-angle read from ever winning.
 */
export const TITLE_DESKEW_BANDS: BandSpec[] = [5, -5, 2.5, -2.5].map((deg) => ({
  x0: 0.01, x1: 0.83, y0: 0.025, y1: 0.11, treatment: "contrast" as TitleTreatment,
  rotate: deg, label: `deskew${deg > 0 ? "+" : ""}${deg}`,
}));

/** The legacy guide-era band (kept for the probe/test handle). */
export const LEGACY_BAND: BandSpec = { x0: 0.03, x1: 0.97, y0: 0.03, y1: 0.115, treatment: "contrast" };

/**
 * The bottom info strip: collector number + set code live at the very
 * bottom-left of the frame (left ~60% of width — the right side is
 * copyright text). The y window starts at 91.5%, NOT the 93.5% first
 * shipped: card crops carry a few % of slack (detection padding), which
 * pushed the number line — printed at ≈92.5% of the true card — clean
 * out of the 93.5% window, so only the set-code line below it was read.
 * Verified on the user's five failing cards (harness, Pass 5). The
 * "bottomline" treatment polarity-normalises (the line is usually light
 * type on the dark frame border) and hard-thresholds, tuned for
 * digits/letters.
 */
export const BOTTOM_BAND: BandSpec = { x0: 0.02, x1: 0.62, y0: 0.915, y1: 0.995, treatment: "bottomline", aim: true };

/** Same window, plain contrast treatment — the VERIFICATION read for a
 * candidate (set, number) pair. The two treatments fail differently
 * (thresholding merged a 7 into a 2 on Dawnhart Mentor: "129" vs the
 * contrast read's correct "179"), so a pair is only trusted when BOTH
 * treatments parse to the same pair. */
export const BOTTOM_BAND_CONTRAST: BandSpec = { ...BOTTOM_BAND, treatment: "contrast" };

/** PASS 27 — the bottom window for the TALL retry crop: the frame
 * re-cropped with the rect extended ~12% downward (App.tsx
 * extendedBottomPin), built for the case no aiming can fix — the
 * printed collector line fell BELOW the standard crop entirely
 * (Andrew's FRA full-art Swamp panel, 2026-11-10 10:12: the line sat
 * under the crop; the standard strip read white). On the tall crop
 * the true card occupies the top 1/1.12 ≈ 0.893, so a line printed
 * at true-card 0.93–1.02 sits at tall-crop ≈0.83–0.91; this window
 * (0.83–0.96, aim on) centres on it, and the aim's probes widen the
 * searched span to roughly true-card 0.85–1.10. The x-range matches
 * BOTTOM_BAND. */
export const BOTTOM_BAND_TALL: BandSpec = { x0: 0.02, x1: 0.62, y0: 0.83, y1: 0.96, treatment: "bottomline", aim: true };

// ---------------------------------------------------------------------------
// Bottom-strip AIMING (Pass 18). The fixed window above is where the
// info line sits on an ACCURATE crop of a slash-era frame. Two measured
// shifts break it: modern frames (FRA) print the number line ~2% of
// card height higher than slash-era frames, and crop slack (aspect-
// correction growth + the 1.5% expansion + detection jitter) moves the
// block a further 2-6% of crop height. On the user's three Rapid
// attempts the block sat at crop 0.857-0.933 / 0.877-0.953 /
// 0.821-0.898 against the fixed 0.915-0.995 window — the strip read
// the artist line's tail, or nothing, and the collector-number rescue
// never had a candidate. The aim measures where the strip's own text
// sits inside the window (ink-row profile, scanflow.ts assessStripInk)
// and re-centres the SAME 8%-tall window on it — a pure function of
// the canvas, so primary, verification and lifted reads of one crop
// all land on the same rows and the verified-pair semantics are
// untouched. A window whose text already straddles its middle
// (accurate crops) is returned unchanged.
// ---------------------------------------------------------------------------

/** Per-canvas cache of the aimed y0 for the bottom-window family:
 * primary, verification and lifted reads of one crop MUST land on
 * the same rows (the verified-pair rule compares their parses), and
 * the probing below is a few ms of pixel work per window tried. */
const aimWindowCache = new WeakMap<HTMLCanvasElement, number>();

/** Ink profile of ONE candidate strip window (raw pixels, the
 * strip's own x range): per-row fraction of pixels deviating from
 * the row's median — polarity-free, the same measure the harness
 * prep uses to locate printed lines. */
function stripInkProfile(cardCanvas: HTMLCanvasElement, spec: BandSpec, y0: number): StripInkAssessment {
  try {
    const w = cardCanvas.width;
    const h = cardCanvas.height;
    const sx = Math.floor(w * spec.x0);
    const sw = Math.max(24, Math.floor(w * (spec.x1 - spec.x0)));
    const sy = Math.floor(h * y0);
    const sh = Math.max(16, Math.floor(h * (spec.y1 - spec.y0)));
    const tmp = document.createElement("canvas");
    tmp.width = sw;
    tmp.height = sh;
    const tctx = tmp.getContext("2d");
    if (!tctx) return { mass: 0, centroid: null };
    tctx.drawImage(cardCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    const img = tctx.getImageData(0, 0, sw, sh);
    const d = img.data;
    const fractions = new Array<number>(sh);
    const rowSamples: number[] = [];
    for (let y = 0; y < sh; y++) {
      rowSamples.length = 0;
      for (let x = 0; x < sw; x += 3) {
        const i = (y * sw + x) * 4;
        rowSamples.push(0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0));
      }
      const sorted = [...rowSamples].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
      let ink = 0;
      let sampled = 0;
      for (let x = 0; x < sw; x += 2) {
        const i = (y * sw + x) * 4;
        const lum = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
        if (Math.abs(lum - med) > 36) ink += 1;
        sampled += 1;
      }
      fractions[y] = sampled > 0 ? ink / sampled : 0;
    }
    return assessStripInk(fractions);
  } catch {
    return { mass: 0, centroid: null };
  }
}

/**
 * The bottom spec as it will actually be read. Decision procedure
 * (all measurements on the crop's own pixels, deterministic per
 * canvas — see the Pass 18 note above BOTTOM_BAND):
 *  1. The fixed window carries centred text → unchanged (the
 *     accurate-crop path is byte-for-byte what it was).
 *  2. It carries text crowded to one edge → ONE re-aim: shift the
 *     window by the ink centroid's offset, re-measure, keep the
 *     shift only if the new window carries at least as much ink.
 *  3. It carries no text (block fully outside) → probe neighbouring
 *     windows (±0.03, ±0.06, −0.09, +0.09 — upward first, the
 *     measured failure direction), centre the first that carries
 *     text as in (2); if none does, the fixed window stands and the
 *     existing noise pre-check skips the read honestly.
 */
export function aimBottomSpec(cardCanvas: HTMLCanvasElement, spec: BandSpec): BandSpec {
  if (!spec.aim) return spec;
  const height = spec.y1 - spec.y0;
  const clampY0 = (y0: number): number => Math.max(0.82, Math.min(0.92, y0));
  const cached = aimWindowCache.get(cardCanvas);
  if (cached !== undefined) {
    return cached === spec.y0 ? spec : { ...spec, y0: cached, y1: cached + height };
  }
  let chosenY0 = spec.y0;
  const base = stripInkProfile(cardCanvas, spec, spec.y0);
  if (stripWindowCentred(base)) {
    chosenY0 = spec.y0;
  } else if (base.mass >= STRIP_INK_FLOOR) {
    const shift = stripAimShift(base, height);
    const y0 = clampY0(spec.y0 + shift);
    const re = stripInkProfile(cardCanvas, spec, y0);
    if (re.mass >= base.mass * 0.8) chosenY0 = y0;
  } else {
    for (const dy of [-0.03, 0.03, -0.06, 0.06, -0.09, 0.09]) {
      const y0 = clampY0(spec.y0 + dy);
      if (y0 === spec.y0) continue;
      const probe = stripInkProfile(cardCanvas, spec, y0);
      if (probe.mass < STRIP_INK_FLOOR) continue;
      const shift = stripAimShift(probe, height);
      const centredY0 = clampY0(y0 + shift);
      const re = centredY0 === y0 ? probe : stripInkProfile(cardCanvas, spec, centredY0);
      chosenY0 = re.mass >= probe.mass * 0.8 ? centredY0 : y0;
      break;
    }
  }
  aimWindowCache.set(cardCanvas, chosenY0);
  return chosenY0 === spec.y0 ? spec : { ...spec, y0: chosenY0, y1: chosenY0 + height };
}

// ---------------------------------------------------------------------------
// Title-band AIMING (Pass 26) — the Pass 18 bottom aim's sibling,
// closing the asymmetry the 2026-11-10 hand-held panels exposed.
//
// The bottom strip has MEASURED its text block and re-centred on it
// since Pass 18; the title band never got the same treatment — it
// reads one fixed window (y 2.5%–11%) in the burst loop, while the
// IMAGE channel fingerprints a whole SET of rect hypotheses
// (insets/shifts) and survives rect error the band cannot. The
// measured failure (hand-held Swamp, 2026-11-10 11:56 EST): the
// texture-slab detector under-measures a basic land's height (its
// lower ~35% is a near-uniform text-box/symbol area), the aspect
// growth anchors 70% of the correction to the top, and the read
// rect lands displaced UP — the standard window sits on bright
// background above the card (both published band thumbnails pure
// uniform white, the title's 2.1s read returning 'R') while the
// dewarp — a resample of the same crop — still shows a clean,
// legible card and the image channel matches at d=50. Reproduced
// in the harness (probe-p26-pipeline): on a hand-held composite the
// detected rect puts the title centroid at crop y=0.120, just below
// the standard window's 0.110 bottom edge — every single-line read
// returns "" and only the Snap-only TALL rescue window reads the
// name. A few % of rect error is NORMAL for hand-held captures;
// the band must hunt for its text row the way the bottom strip
// already does.
//
// aimTitleSpec is aimBottomSpec's procedure verbatim (ink profile →
// centred? → centroid shift → probe ±0.03/0.06/0.09), with title
// clamps (y0 ∈ [0, 0.22]) and its own per-canvas cache. Applied ONLY
// to the standard window, inside ocrTitleBandCapped (the burst
// path's reader) — the rescue/deskew/lifted alternate windows keep
// their fixed fractions, exactly as the bottom's verification and
// lifted reads share the ONE aimed window. On an accurate crop the
// ink is centred and the spec is returned byte-identical.
// ---------------------------------------------------------------------------

/** Per-canvas cache of the aimed title y0 (mirrors the bottom aim's
 * cache): every read of one crop must use the same window. */
const titleAimCache = new WeakMap<HTMLCanvasElement, number>();

/** The standard title spec as it will actually be read: aimed at
 * the title row measured in the crop's own pixels. Specs without
 * `aim` (rescue/deskew/alternate windows) pass through untouched. */
export function aimTitleSpec(cardCanvas: HTMLCanvasElement, spec: BandSpec): BandSpec {
  if (!spec.aim) return spec;
  const height = spec.y1 - spec.y0;
  const clampY0 = (y0: number): number => Math.max(0, Math.min(0.22, y0));
  const cached = titleAimCache.get(cardCanvas);
  if (cached !== undefined) {
    return cached === spec.y0 ? spec : { ...spec, y0: cached, y1: cached + height };
  }
  let chosenY0 = spec.y0;
  const base = stripInkProfile(cardCanvas, spec, spec.y0);
  if (stripWindowCentred(base)) {
    chosenY0 = spec.y0;
  } else if (base.mass >= STRIP_INK_FLOOR) {
    const shift = stripAimShift(base, height);
    const y0 = clampY0(spec.y0 + shift);
    const re = stripInkProfile(cardCanvas, spec, y0);
    if (re.mass >= base.mass * 0.8) chosenY0 = y0;
  } else {
    for (const dy of [-0.03, 0.03, -0.06, 0.06, -0.09, 0.09]) {
      const y0 = clampY0(spec.y0 + dy);
      if (y0 === spec.y0) continue;
      const probe = stripInkProfile(cardCanvas, spec, y0);
      if (probe.mass < STRIP_INK_FLOOR) continue;
      const shift = stripAimShift(probe, height);
      const centredY0 = clampY0(y0 + shift);
      const re = centredY0 === y0 ? probe : stripInkProfile(cardCanvas, spec, centredY0);
      chosenY0 = re.mass >= probe.mass * 0.8 ? centredY0 : y0;
      break;
    }
  }
  titleAimCache.set(cardCanvas, chosenY0);
  return chosenY0 === spec.y0 ? spec : { ...spec, y0: chosenY0, y1: chosenY0 + height };
}

/**
 * Build one title-band image from a CARD crop: the band window upscaled to
 * ~1200px wide with the requested treatment.
 * - "contrast": grayscale + contrast (the clean-image winner).
 * - "threshold": hard black & white at a fixed level.
 * - "adaptive": local-mean threshold (integral image) — rescues real phone
 *   photos where uneven light defeats a global threshold; polarity is
 *   normalised so light-text-on-dark frames (etched/black frames) also end
 *   up as black text on white.
 */
export function buildBandCanvas(cardCanvas: HTMLCanvasElement, spec: BandSpec): HTMLCanvasElement {
  const w = cardCanvas.width;
  const h = cardCanvas.height;
  const sx = Math.round(w * spec.x0);
  const sw = Math.max(24, Math.round(w * (spec.x1 - spec.x0)));
  const sy = Math.round(h * spec.y0);
  const sh = Math.max(10, Math.round(h * (spec.y1 - spec.y0)));
  const targetW = 1200;
  const scale = targetW / sw;
  const out = document.createElement("canvas");
  out.width = targetW;
  // Every band is upscaled to at least ~64px tall (high-quality drawImage
  // resampling): hand-held cards at arm's length produce small glyphs,
  // and the reader's line segmentation degrades sharply on very short
  // strips. (A full-card crop's standard band already lands ~190px; the
  // floor guarantees it for partial crops and the shorter windows.)
  out.height = Math.max(64, Math.round(sh * scale));
  const ctx = out.getContext("2d");
  if (!ctx) return out;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  const filterFor = spec.treatment === "contrast" ? "grayscale(1) contrast(1.7) brightness(1.08)" : "grayscale(1) contrast(1.4)";
  if (spec.lift && spec.lift > 1.01) {
    // Auto Light lift (Pass 17): a true EXPOSURE lift — the RAW band
    // pixels are multiplied by the metering gain FIRST, and the
    // treatment filter runs on the lifted range. Order is load-
    // bearing: the contrast treatment pivots at mid-grey, so a dim
    // band (p90 ≈ 45) is crushed to a treated mean of ≈0 by the
    // filter alone (measured, Pass 17 baseline) — multiplying after
    // the filter would multiply zero. Lift first, and the same
    // filter sees a normally lit band.
    const tmp = document.createElement("canvas");
    tmp.width = out.width;
    tmp.height = out.height;
    const tctx0 = tmp.getContext("2d");
    if (tctx0) {
      tctx0.fillStyle = "#ffffff";
      tctx0.fillRect(0, 0, tmp.width, tmp.height);
      tctx0.drawImage(cardCanvas, sx, sy, sw, sh, 0, 0, tmp.width, tmp.height);
      try {
        const img = tctx0.getImageData(0, 0, tmp.width, tmp.height);
        const d = img.data;
        const g = spec.lift;
        for (let i = 0; i < d.length; i += 4) {
          d[i] = Math.min(255, (d[i] ?? 0) * g);
          d[i + 1] = Math.min(255, (d[i + 1] ?? 0) * g);
          d[i + 2] = Math.min(255, (d[i + 2] ?? 0) * g);
        }
        tctx0.putImageData(img, 0, 0);
      } catch { /* fall through with the unlifted temp */ }
      try { ctx.filter = filterFor; } catch { /* filter unsupported */ }
      ctx.drawImage(tmp, 0, 0);
      try { ctx.filter = "none"; } catch { /* ignore */ }
    } else {
      try { ctx.filter = filterFor; } catch { /* ignore */ }
      ctx.drawImage(cardCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
      try { ctx.filter = "none"; } catch { /* ignore */ }
    }
  } else {
    try { ctx.filter = filterFor; } catch { /* filter unsupported — raw draw still works */ }
    ctx.drawImage(cardCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    try { ctx.filter = "none"; } catch { /* ignore */ }
  }
  // Deskew (spec.rotate): rotate the built strip back to horizontal.
  // The output grows by w·tan(|θ|) so the rotated line's ends stay in
  // frame; the surround is the same white the band already pads with.
  let target = out;
  let tctx = ctx;
  if (spec.rotate) {
    const rotated = rotateBandImage(out, spec.rotate);
    if (rotated) {
      target = rotated;
      tctx = rotated.getContext("2d") ?? ctx;
    }
  }
  if (spec.treatment === "threshold") {
    try {
      const img = tctx.getImageData(0, 0, target.width, target.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
        const v = lum > 135 ? 255 : 0;
        d[i] = v; d[i + 1] = v; d[i + 2] = v;
      }
      tctx.putImageData(img, 0, 0);
    } catch { /* keep the contrast version */ }
  } else if (spec.treatment === "adaptive") {
    try {
      applyAdaptiveThreshold(tctx, target.width, target.height);
    } catch { /* keep the contrast version */ }
  } else if (spec.treatment === "bottomline") {
    try {
      applyBottomLineTreatment(tctx, target.width, target.height);
    } catch { /* keep the contrast version */ }
  }
  return target;
}

/** Rotate a built band strip by `degrees` (canvas sense) around its
 * centre into a white canvas tall enough to hold the rotated line. */
function rotateBandImage(src: HTMLCanvasElement, degrees: number): HTMLCanvasElement | null {
  const rad = (degrees * Math.PI) / 180;
  const extra = Math.ceil(src.width * Math.abs(Math.tan(rad))) + 8;
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height + extra;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return out;
}

/**
 * Bottom-line treatment: the collector line is small light type on the
 * card's dark lower border (white-on-black). Normalise polarity — sample
 * the strip's mean luminance; a dark strip is inverted — then hard
 * threshold, so Tesseract always sees black digits on white.
 */
function applyBottomLineTreatment(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 16) {
    sum += 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
    n += 1;
  }
  const invert = n > 0 && sum / n < 118;
  for (let i = 0; i < d.length; i += 4) {
    let lum = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
    if (invert) lum = 255 - lum;
    const v = lum > 148 ? 255 : 0;
    d[i] = v; d[i + 1] = v; d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

/** The bottom info strip canvas of a card crop (collector number zone). */
export function buildBottomBandCanvas(cardCanvas: HTMLCanvasElement): HTMLCanvasElement {
  return buildBandCanvas(cardCanvas, BOTTOM_BAND);
}

/** Local-mean adaptive threshold via an integral image, polarity-normalised. */
function applyAdaptiveThreshold(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const lum = new Float32Array(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    lum[j] = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
  }
  // Integral image for O(1) window means.
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += lum[y * w + x] ?? 0;
      integral[(y + 1) * (w + 1) + (x + 1)] = (integral[y * (w + 1) + (x + 1)] ?? 0) + rowSum;
    }
  }
  const winMean = (cx: number, cy: number, r: number): number => {
    const x0 = Math.max(0, cx - r);
    const x1 = Math.min(w - 1, cx + r);
    const y0 = Math.max(0, cy - r);
    const y1 = Math.min(h - 1, cy + r);
    const a = integral[y0 * (w + 1) + x0] ?? 0;
    const b = integral[y0 * (w + 1) + (x1 + 1)] ?? 0;
    const c = integral[(y1 + 1) * (w + 1) + x0] ?? 0;
    const dd = integral[(y1 + 1) * (w + 1) + (x1 + 1)] ?? 0;
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    return (dd - b - c + a) / Math.max(1, area);
  };
  // Polarity: sample the band's own border rows/cols — that's frame, not
  // text. Dark surround ⇒ the title is light text on dark ⇒ invert so the
  // output is always dark text on white.
  let borderSum = 0;
  let borderN = 0;
  for (let x = 0; x < w; x += 7) {
    borderSum += lum[x] ?? 0;
    borderSum += lum[(h - 1) * w + x] ?? 0;
    borderN += 2;
  }
  for (let y = 0; y < h; y += 7) {
    borderSum += lum[y * w] ?? 0;
    borderSum += lum[y * w + (w - 1)] ?? 0;
    borderN += 2;
  }
  const invert = borderN > 0 && borderSum / borderN < 110;
  const r = Math.max(10, Math.round(w / 48));
  const bias = 11;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = y * w + x;
      let v = (lum[j] ?? 0) > winMean(x, y, r) - bias ? 255 : 0;
      if (invert) v = 255 - v;
      const i = j * 4;
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Back-compat wrapper: the title band of a card/guide crop, legacy window. */
export function buildTitleBandCanvas(
  cardCanvas: HTMLCanvasElement,
  treatment: TitleTreatment,
): HTMLCanvasElement {
  return buildBandCanvas(cardCanvas, { ...LEGACY_BAND, treatment });
}

// ---------------------------------------------------------------------------
// BLOWN-BAND GUARD (Pass 23, Item C) — classify a BUILT band canvas
// (exactly the image OCR would receive) with scanflow's pure
// classifyBandBleach. Bleached bands (uniform near-white, or a flat
// grey / smooth gradient with no ink structure) are NO-TEXT
// evidence: the readers below return an empty read at 0ms WITHOUT
// touching the OCR worker, so they stop burning 1–2s per attempt
// and stop injecting garbage tokens into the fusion pool. The
// caller records the skip with BLEACHED_BAND_REASON so the panel
// states "band bleached — no text" instead of a fake read.
// ---------------------------------------------------------------------------

/** Bleach-classify an already-built band canvas. Unreadable canvas
 * (no 2d context / tainted) classifies as NOT bleached — the read
 * proceeds and OCR decides, exactly as before the guard existed. */
export function bleachOfBandCanvas(band: HTMLCanvasElement): BandBleachAnalysis {
  const ctx = band.getContext("2d");
  if (!ctx) return { bleached: false, kind: "", mean: 0, stdev: 0, inkShare: 1, reason: "" };
  try {
    const img = ctx.getImageData(0, 0, band.width, band.height);
    const d = img.data;
    const lum = new Float32Array(band.width * band.height);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      lum[j] = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
    }
    return classifyBandBleach(lum, band.width, band.height);
  } catch {
    return { bleached: false, kind: "", mean: 0, stdev: 0, inkShare: 1, reason: "" };
  }
}

/** Build the band for `spec` from a card crop and bleach-classify
 * it — the pre-OCR check the App/harness can also call directly
 * for diagnostics. */
export function analyzeBandBleach(cardCanvas: HTMLCanvasElement, spec: BandSpec): BandBleachAnalysis {
  return bleachOfBandCanvas(buildBandCanvas(cardCanvas, spec));
}

/** True when a read is empty or letter-free — worthless for name matching. */
export function isGarbageRead(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length < 3;
}

/**
 * True when a read is token soup — many tiny fragments instead of a name.
 * Busy frame textures above the title bar can make PSM 7 hallucinate a line
 * of debris while the real name sits unread; a PSM 6 pass usually recovers
 * the name as its own line.
 */
export function isFragmentedRead(text: string): boolean {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length > 9) return true;
  const singles = tokens.filter((t) => t.replace(/[^A-Za-z]/g, "").length <= 1).length;
  return singles >= 5;
}

export interface TitleRead {
  text: string;
  ms: number;
  psm: string;
}

/** A read too thin to be a full card name — worth a pooled PSM 6 pass. */
function isThinRead(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, "").length;
  const tokens = text.split(/\s+/).filter(Boolean).length;
  return letters < 8 || (tokens <= 1 && letters < 10);
}

/** Run one recognize job on the shared worker: serialized, hard-capped
 * at `timeoutMs` (default OCR_TIMEOUT_MS), with the restart bookkeeping
 * from the header. The cap covers EVERYTHING the job waits on —
 * including worker creation: after a silent worker swap, a read that
 * awaited the fresh worker's multi-second warm-up OUTSIDE any timeout
 * was one of the ways a Snap could hang past the watchdog with good
 * evidence already in hand (Pass 9). */
async function recognizeQueued<T extends { text: string; psm: string }>(
  job: (worker: TesseractWorkerLike) => Promise<T>,
  timeoutMs: number = OCR_TIMEOUT_MS,
  generation?: number,
): Promise<T & { ms: number }> {
  const run = async (): Promise<T & { ms: number }> => {
    const t0 = performance.now();
    // STALE-JOB DROP (Pass 15): this job was enqueued by an earlier
    // attempt and only reaches the queue front now. Its result would
    // be discarded by the attempt token regardless — return an empty
    // read immediately WITHOUT spending worker time on it.
    if (generation !== undefined && generation !== ocrGeneration) {
      return { text: "", psm: "stale", ms: 0 } as T & { ms: number };
    }
    const inner = (async () => {
      const worker = await ensureOcrWorker();
      return job(worker);
    })();
    try {
      const read = await withTimeout(inner, timeoutMs);
      noteReadSuccess();
      return { ...read, ms: performance.now() - t0 };
    } catch (err) {
      if (err instanceof OcrTimeoutError) {
        // The cap fired, but the worker job itself may still be
        // executing — it is a zombie until `inner` actually settles,
        // and the next attempt's beginScanAttempt recycles the worker
        // if it is still alive by then (Pass 15).
        trackZombie(inner);
      }
      noteReadFailure(err instanceof OcrTimeoutError ? "timeout" : "error");
      throw err;
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

/**
 * One on-device band read with a hard 4s cap. PSM 7 (single line) first; if
 * that comes back empty/garbage, fragmented token soup, or suspiciously
 * thin, PSM 6 (uniform block) runs too and its lines are pooled with the
 * first read — the local matcher picks the plausible name line out of the
 * pool. With `fast: true` the PSM 6 pool is skipped (burst scans pool
 * across FRAMES instead of across PSM modes). Timeouts follow the
 * two-strike restart policy (see header) and rethrow, so callers settle.
 */
export async function ocrBand(
  cardCanvas: HTMLCanvasElement,
  spec: BandSpec,
  opts: { fast?: boolean; capMs?: number; gen?: number } = {},
): Promise<TitleRead> {
  const band = buildBandCanvas(cardCanvas, spec);
  // BLOWN-BAND GUARD (Pass 23): a bleached band is no-text evidence
  // — return at 0ms without queueing an OCR job (psm "bleached"
  // lets capped callers record the skip reason).
  if (bleachOfBandCanvas(band).bleached) return { text: "", ms: 0, psm: "bleached" };
  return recognizeQueued(async (worker) => {
    // The whitelist is set explicitly on EVERY read: parameters persist
    // on the shared worker, so a title read must not inherit the bottom
    // line's digits-only alphabet (and vice versa).
    await worker.setParameters({ tessedit_pageseg_mode: "7", tessedit_char_whitelist: TITLE_LINE_WHITELIST });
    let res = await worker.recognize(band);
    let psm = "7";
    let text = (res.data.text ?? "").trim();
    if (!opts.fast && (isGarbageRead(text) || isFragmentedRead(text) || isThinRead(text))) {
      await worker.setParameters({ tessedit_pageseg_mode: "6" });
      res = await worker.recognize(band);
      psm = "7+6";
      const alt = (res.data.text ?? "").trim();
      if (!isGarbageRead(alt)) {
        text = text.length > 0 ? `${text}\n${alt}` : alt;
      } else if (alt.length > text.length) {
        text = alt;
      }
    }
    return { text, psm };
  }, opts.capMs ?? OCR_TIMEOUT_MS, opts.gen);
}

/**
 * One multi-line (PSM 6) read of a band — for the TALL rescue band,
 * where the name is one line among several (frame slab above it, art
 * texture below) and single-line segmentation (PSM 7) locks onto the
 * wrong row. Returns every line; the caller's pooled matcher picks
 * the name line out of the pool. Same queue/timeout discipline.
 */
export async function ocrBandMultiLine(
  cardCanvas: HTMLCanvasElement,
  spec: BandSpec,
  opts: { capMs?: number; gen?: number } = {},
): Promise<TitleRead> {
  const band = buildBandCanvas(cardCanvas, spec);
  if (bleachOfBandCanvas(band).bleached) return { text: "", ms: 0, psm: "bleached" };
  return recognizeQueued(async (worker) => {
    await worker.setParameters({ tessedit_pageseg_mode: "6", tessedit_char_whitelist: TITLE_LINE_WHITELIST });
    const res = await worker.recognize(band);
    return { text: (res.data.text ?? "").trim(), psm: "6" };
  }, opts.capMs ?? OCR_TIMEOUT_MS, opts.gen);
}

/** Characters the bottom line can contain — digits, set-code letters,
 * slash, the ★/• separators and language codes. Tuning the whitelist to
 * this alphabet is what makes the tiny collector line readable at all. */
export const BOTTOM_LINE_WHITELIST = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ/•·★.- ";

/** Characters a card NAME can contain — letters (the printed alphabet),
 * digits for the rare numbered name, and name punctuation. */
export const TITLE_LINE_WHITELIST = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',.&- ";

/**
 * Read the card's BOTTOM info strip (collector number / set code zone)
 * with PSM 6 (the strip carries two short lines) and the tuned whitelist.
 * Returns the raw text; parseBottomLine (bottomline.ts) extracts the
 * (set, number) pair. Same queue/timeout/restart discipline as ocrBand.
 */
export async function ocrBottomBandWith(cardCanvas: HTMLCanvasElement, spec: BandSpec, gen?: number): Promise<TitleRead> {
  const band = buildBandCanvas(cardCanvas, spec);
  return recognizeQueued(async (worker) => {
    await worker.setParameters({
      tessedit_pageseg_mode: "6",
      tessedit_char_whitelist: BOTTOM_LINE_WHITELIST,
    });
    const res = await worker.recognize(band);
    return { text: (res.data.text ?? "").trim(), psm: "6" };
  }, OCR_TIMEOUT_MS, gen);
}

export async function ocrBottomBand(cardCanvas: HTMLCanvasElement): Promise<TitleRead> {
  return ocrBottomBandWith(cardCanvas, BOTTOM_BAND);
}

// ---------------------------------------------------------------------------
// Bottom-read isolation (scanflow rule B). The bottom strip is
// OPPORTUNISTIC evidence in the fast path: it gets its own hard cap of
// ~1.2s, a noise pre-check that skips OCR entirely on bands with no
// text row (the pure-speckle strip in the user's Cheerful Osteomancer
// screenshot — the kind of image that makes the OCR engine spin), and
// a poisoned-worker swap when it overruns, so a spinning bottom read
// can never block, delay, or outlive the title match — nor hold the
// shared worker hostage for the NEXT scan.
// ---------------------------------------------------------------------------

/** Hard cap for one bottom-strip read in the fast scan path. */
export const BOTTOM_READ_CAP_MS = 1200;

/**
 * Silently abandon the current worker and warm a fresh one in the
 * background. Used when a capped read overruns: the spinning recognize
 * belongs to an attempt that has already moved on, so its worker must
 * not queue-block the next scan. Respects the session's
 * max-1-auto-restart budget (beyond it, the worker is left alone and
 * reads simply queue behind the 4s per-read cap as before). Emits NO
 * scanner event and no user-visible state change — a swap after a
 * success is invisible by design.
 */
export function abandonBusyWorkerSilent(): boolean {
  if (autoRestartsUsed >= MAX_AUTO_RESTARTS_PER_SESSION) return false;
  autoRestartsUsed += 1;
  recycleWorkerNow();
  // The terminated worker takes its zombies with it: any abandoned
  // job still counted outstanding was executing on THAT worker, so
  // the between-attempt recycle must not fire again for it. (Jobs
  // abandoned afterwards, on the fresh worker, re-increment.)
  zombieOutstanding = 0;
  return true;
}

/** Noise analysis of the bottom band exactly as OCR would see it. */
export function analyzeBottomBandCanvas(cardCanvas: HTMLCanvasElement, spec: BandSpec = BOTTOM_BAND): BottomBandAnalysis {
  const band = buildBandCanvas(cardCanvas, spec);
  const ctx = band.getContext("2d");
  if (!ctx) {
    // Can't measure — don't skip; let the capped read decide.
    return { darkFraction: 0.2, maxRun: 99, textRows: 99, concentration: 1, hasTextRow: true, skip: false, reason: "" };
  }
  try {
    const img = ctx.getImageData(0, 0, band.width, band.height);
    const d = img.data;
    const lum = new Float32Array(band.width * band.height);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      lum[j] = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
    }
    return analyzeBottomBand(lum, band.width, band.height);
  } catch {
    return { darkFraction: 0.2, maxRun: 99, textRows: 99, concentration: 1, hasTextRow: true, skip: false, reason: "" };
  }
}

export interface BottomReadOutcome {
  text: string;
  ms: number;
  /** The noise pre-check skipped OCR entirely (no text row in band). */
  skipped: boolean;
  /** The read overran its cap and was abandoned as "no evidence". */
  timedOut: boolean;
  /** Skip/timeout reason ("" on a normal read). */
  reason: string;
}

/**
 * The fast path's ONLY bottom-strip read: pre-check → capped OCR.
 * - Speckle / blank / solid bands never reach the OCR engine; the
 *   outcome says why, so the stage line can record the skip honestly.
 * - A read that overruns BOTTOM_READ_CAP_MS is abandoned: the outcome
 *   is "no evidence", the pipeline proceeds with title-only evidence,
 *   and the busy worker is swapped silently in the background.
 * This function itself NEVER hangs longer than the cap (plus the
 * synchronous band build) and never throws.
 */
export async function ocrBottomBandCapped(
  cardCanvas: HTMLCanvasElement,
  spec: BandSpec = BOTTOM_BAND,
  capMs: number = BOTTOM_READ_CAP_MS,
  gen?: number,
): Promise<BottomReadOutcome> {
  // Pass 18: aim the strip at the measured info-line block first —
  // the pre-check and the read both run on the AIMED window, so a
  // strip the fixed fraction would have wasted on tray/border is
  // re-aimed at the printed line before any OCR runs (and a strip
  // with no block anywhere still skips honestly via the pre-check).
  const effSpec = aimBottomSpec(cardCanvas, spec);
  // BLOWN-BAND GUARD (Pass 23): a bleached bottom strip (the user's
  // pure-white P-c strip) is no-text evidence with its OWN reason —
  // checked before the speckle analysis so the stage line names
  // the bleach, not a generic near-blank.
  if (analyzeBandBleach(cardCanvas, effSpec).bleached) {
    return { text: "", ms: 0, skipped: true, timedOut: false, reason: BLEACHED_BAND_REASON };
  }
  const analysis = analyzeBottomBandCanvas(cardCanvas, effSpec);
  if (analysis.skip) {
    return { text: "", ms: 0, skipped: true, timedOut: false, reason: analysis.reason };
  }
  const underlying = ocrBottomBandWith(cardCanvas, effSpec, gen);
  // A late rejection after abandonment must never surface unhandled.
  underlying.catch(() => undefined);
  const raced = await raceWithCap(underlying, Math.max(1, capMs));
  if (raced.status === "timeout") {
    // The abandoned job may still be executing inside the worker —
    // track it as a zombie so the NEXT attempt recycles the worker
    // instead of queueing behind it (Pass 15, Evidence B).
    trackZombie(underlying);
    abandonBusyWorkerSilent();
    return { text: "", ms: capMs, skipped: false, timedOut: true, reason: "timeout" };
  }
  return { text: raced.value.text, ms: raced.value.ms, skipped: false, timedOut: false, reason: "" };
}

// ---------------------------------------------------------------------------
// Title-read isolation (Pass 9) — the burst path's title reads get the
// same treatment the bottom read got in Pass 7. The failure this fixes
// (the user's Divergent Equation attempts 1–2): title and match stages
// COMPLETED with usable evidence ('Divergent ae', a perfect bottom
// line), yet the attempt hung "during: title" until the 8s watchdog —
// one pooled variant job spinning on the single shared worker (or a
// read awaiting a swapped worker's warm-up) blocked every later await,
// so the attempt never reached its own settlement code. Now EVERY
// title read is raced at ~900ms; a spun read is abandoned as
// "no evidence", the busy worker is swapped silently in the
// background, and the pipeline settles by its deadline with whatever
// the other reads produced.
// ---------------------------------------------------------------------------

/** Hard cap for one title-band read in the burst pipeline. Healthy
 * reads on the user's phone measure 150–350ms; 900ms is generous —
 * anything past it is a wedged job, not a slow card. */
export const TITLE_READ_CAP_MS = 900;

export interface TitleReadOutcome {
  text: string;
  ms: number;
  /** The read overran its cap and was abandoned as "no evidence". */
  timedOut: boolean;
  /** Pass 23: the band was classified BLEACHED pre-OCR (no-text
   * evidence) and skipped at 0ms — the caller records the stage
   * note "band bleached — no text" instead of a fake read. */
  bleached?: boolean;
}

/**
 * The burst path's title read: ocrBand / ocrBandMultiLine raced at
 * TITLE_READ_CAP_MS (or the caller's tighter cap). Never throws and
 * never hangs past the cap (+ the synchronous band build): a timeout
 * abandons the read, swaps the busy worker silently (budget-limited,
 * exactly like the bottom read), and reports no evidence — the
 * attempt-level deadline in the caller then settles with the pooled
 * evidence from the reads that DID return.
 */
export async function ocrTitleBandCapped(
  cardCanvas: HTMLCanvasElement,
  spec: BandSpec,
  opts: { fast?: boolean; multiLine?: boolean; capMs?: number; gen?: number } = {},
): Promise<TitleReadOutcome> {
  const capMs = Math.max(1, opts.capMs ?? TITLE_READ_CAP_MS);
  // PASS 26: the standard window is AIMED at the measured title row
  // before the band is built (mirrors ocrBottomBandCapped's aim) —
  // the bleach pre-check and the read both run on the aimed window,
  // so a displaced rect's empty fixed window no longer classifies
  // as "no text" while the title sits a few % away. Specs without
  // `aim` pass through byte-identical.
  const effSpec = aimTitleSpec(cardCanvas, spec);
  const underlying = (opts.multiLine
    ? ocrBandMultiLine(cardCanvas, effSpec, { gen: opts.gen })
    : ocrBand(cardCanvas, effSpec, { fast: opts.fast, gen: opts.gen })
  ).catch(() => null);
  const raced = await raceWithCap(underlying, capMs);
  if (raced.status === "timeout") {
    // Zombie tracking (Pass 15): the abandoned job keeps executing
    // inside the shared worker until it settles; if it is still
    // alive when the next attempt begins, that attempt recycles the
    // worker instead of starving behind it (Evidence B — the
    // sequence test reproduced attempts N+1/N+2 settling empty
    // behind attempt N's abandoned speckle reads).
    trackZombie(underlying);
    abandonBusyWorkerSilent();
    return { text: "", ms: capMs, timedOut: true };
  }
  if (!raced.value) return { text: "", ms: raced.ms, timedOut: false };
  return {
    text: raced.value.text,
    ms: raced.value.ms,
    timedOut: false,
    ...(raced.value.psm === "bleached" ? { bleached: true } : {}),
  };
}

/** Back-compat: read the legacy band window with a treatment. */
export async function ocrTitleBand(
  cardCanvas: HTMLCanvasElement,
  treatment: TitleTreatment,
): Promise<TitleRead> {
  return ocrBand(cardCanvas, { ...LEGACY_BAND, treatment });
}
