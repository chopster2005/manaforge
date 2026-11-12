// Scan-attempt lifecycle, bottom-band isolation and diagnostics-display
// rules — PURE logic, no DOM, unit-tested in tests/scanflow.test.ts
// (deadline settlement + the shared number rescue in
// tests/deadline.test.ts).
import { buildNumberCandidates, type BottomLineHit } from "./bottomline";
import { artistMatchesBottomText, bottomArtistClearlyContradicts } from "./lib";
//
// Why this module exists (the user's Cost of Brilliance / Cheerful
// Osteomancer screenshots, 2026-11-08): a scan's useful work finished in
// ~2.3s of stage time and the card WAS added to the scan list — yet
// "Last scan" hit 7.2s, a watchdog timeout fired, a red timeout banner
// stacked over the success sheet, and the scanner stayed wedged until a
// page refresh. Some read belonging to the attempt (the bottom-strip
// read on a pure-speckle band is the prime suspect — both success
// panels showed "bottom 0ms") kept running AFTER the match succeeded,
// the 8s watchdog then tore down scanner state indiscriminately.
//
// The rules encoded here, enforced by App.tsx / ocr.ts:
//  A. SUCCESS IS FINAL. An attempt that has produced a result is
//     SETTLED. Every pipeline await checks the AttemptGuard afterwards
//     and aborts silently when settled/superseded, and the watchdog
//     takes NO action at all for a settled attempt (no banner, no
//     panel, no reset, no state change).
//  B. THE BOTTOM READ IS OPPORTUNISTIC. It has its own ~1.2s cap
//     (raceWithCap), a noise pre-check that skips OCR entirely when the
//     band carries no text row (analyzeBottomBand), and a timed-out
//     bottom read poisons the shared OCR worker for a silent swap so it
//     cannot hold the NEXT scan hostage.
//  C. RECOVERY IS AUTOMATIC. A genuine (unsettled) timeout produces a
//     fixed recovery plan — clear busy flags, reset the rapid machine,
//     verify/reattach the camera, restart the watcher, status back to
//     ready — so a page refresh is never required.
//  D. DIAGNOSTICS ARE COLLAPSIBLE. "What the scanner read" defaults
//     CLOSED on success sheets and OPEN on failure / Did-you-mean
//     panels, with the user's manual toggle remembered per context.

// ---------------------------------------------------------------------------
// A. Attempt lifecycle
// ---------------------------------------------------------------------------

export class AttemptGuard {
  private current = 0;
  private settledAttempts = new Set<number>();

  /** Mark `attempt` as the live attempt (called when it begins). */
  start(attempt: number): void {
    this.current = attempt;
  }

  /** The attempt has produced its final outcome (success, suggestions,
   * or a settled failure). After this, nothing belonging to the attempt
   * may change UI or scanner state ever again. */
  settle(attempt: number): void {
    if (attempt > 0) this.settledAttempts.add(attempt);
  }

  isSettled(attempt: number): boolean {
    return this.settledAttempts.has(attempt);
  }

  /** True only while `attempt` is the live attempt AND unsettled —
   * the check every pipeline await must pass before continuing. */
  isActive(attempt: number): boolean {
    return attempt > 0 && attempt === this.current && !this.settledAttempts.has(attempt);
  }

  get currentAttempt(): number {
    return this.current;
  }
}

// ---------------------------------------------------------------------------
// A + C. Watchdog decisions
// ---------------------------------------------------------------------------

export type WatchdogAction = "ignore" | "show-failure";

/**
 * What the 8s watchdog may do when it fires. A settled attempt — or one
 * whose success sheet is already open — is COMPLETE: its timeout is
 * not an event at all. Only a genuinely unfinished attempt gets the
 * failure panel + recovery.
 */
export function watchdogAction(input: { settled: boolean; hasOpenResult: boolean }): WatchdogAction {
  if (input.settled || input.hasOpenResult) return "ignore";
  return "show-failure";
}

export type RecoveryStep =
  | "clear-busy"
  | "reset-rapid"
  | "verify-camera"
  | "restart-watcher"
  | "status-ready"
  | "show-failure-panel";

/**
 * The recovery plan for a genuine watchdog timeout. An ignored
 * (settled) timeout recovers NOTHING — it must not touch state at all.
 * A genuine timeout always ends back at a live, ready scanner.
 */
export function watchdogRecoveryPlan(input: { settled: boolean; hasOpenResult: boolean }): RecoveryStep[] {
  if (watchdogAction(input) === "ignore") return [];
  return ["clear-busy", "reset-rapid", "verify-camera", "restart-watcher", "status-ready", "show-failure-panel"];
}

// ---------------------------------------------------------------------------
// B. Bottom-band noise pre-check + read cap
// ---------------------------------------------------------------------------

export interface BottomBandAnalysis {
  /** Fraction of pixels that are dark (0..1). */
  darkFraction: number;
  /** Longest horizontal run of consecutive dark pixels anywhere. */
  maxRun: number;
  /** Rows containing a run of at least MIN_TEXT_RUN dark pixels. */
  textRows: number;
  /** Largest share of all dark pixels inside any 50%-of-height window. */
  concentration: number;
  /** True when the band shows a plausible printed-text structure. */
  hasTextRow: boolean;
  /** True when OCR must be skipped entirely for this band. */
  skip: boolean;
  /** Machine-stable skip reason ("near-blank" | "near-solid" | "no text row"). */
  reason: string;
}

const MIN_TEXT_RUN = 7;
const MIN_TEXT_ROWS = 3;
const MIN_CONCENTRATION = 0.58;

/**
 * Analyse a thresholded bottom-strip band (luminance per pixel, 0 =
 * black, 255 = white; dark = < 128) and decide whether OCR has any
 * chance. Printed collector lines have a very specific shape: strokes
 * several pixels wide (long horizontal runs) arranged in one or two
 * text lines (dark pixels concentrated in part of the strip's height,
 * spread over many rows). The failure band from the user's Cheerful
 * Osteomancer screenshot is the opposite: isolated speckle dashes
 * scattered uniformly over the whole strip — short runs, no
 * concentration — and feeding that image to the OCR engine is what
 * made it spin. Such bands are skipped BEFORE any OCR runs.
 */
export function analyzeBottomBand(lum: ArrayLike<number>, width: number, height: number): BottomBandAnalysis {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const total = w * h;
  if (total === 0 || lum.length < total) {
    return { darkFraction: 0, maxRun: 0, textRows: 0, concentration: 0, hasTextRow: false, skip: true, reason: "near-blank" };
  }
  let dark = 0;
  let maxRun = 0;
  let textRows = 0;
  const rowDark = new Array<number>(h).fill(0);
  for (let y = 0; y < h; y++) {
    let run = 0;
    let rowHasTextRun = false;
    for (let x = 0; x < w; x++) {
      const isDark = (lum[y * w + x] ?? 255) < 128;
      if (isDark) {
        dark += 1;
        rowDark[y] = (rowDark[y] ?? 0) + 1;
        run += 1;
        if (run > maxRun) maxRun = run;
        if (run >= MIN_TEXT_RUN) rowHasTextRun = true;
      } else {
        run = 0;
      }
    }
    if (rowHasTextRun) textRows += 1;
  }
  const darkFraction = dark / total;
  // Concentration: the largest share of dark pixels inside any window
  // half the strip's height (sliding by row-dark sums).
  let concentration = 0;
  if (dark > 0) {
    const win = Math.max(1, Math.round(h * 0.5));
    let sum = 0;
    for (let y = 0; y < win && y < h; y++) sum += rowDark[y] ?? 0;
    let best = sum;
    for (let y = win; y < h; y++) {
      sum += (rowDark[y] ?? 0) - (rowDark[y - win] ?? 0);
      if (sum > best) best = sum;
    }
    concentration = best / dark;
  }
  if (darkFraction < 0.015) {
    return { darkFraction, maxRun, textRows, concentration, hasTextRow: false, skip: true, reason: "near-blank" };
  }
  if (darkFraction > 0.7) {
    return { darkFraction, maxRun, textRows, concentration, hasTextRow: false, skip: true, reason: "near-solid" };
  }
  const hasTextRow = textRows >= MIN_TEXT_ROWS && concentration >= MIN_CONCENTRATION;
  return {
    darkFraction,
    maxRun,
    textRows,
    concentration,
    hasTextRow,
    skip: !hasTextRow,
    reason: hasTextRow ? "" : "no text row",
  };
}

/** The stage-line text recorded when a bottom read is skipped. */
export function bottomSkipStageNote(reason: string): string {
  return `bottom skipped (${reason})`;
}

// ---------------------------------------------------------------------------
// B3. BLOWN-BAND GUARD (Pass 23, Item C). The user's Kavu Scout
// panels (2026-11-09 ~21:39–21:43 EST) show title bands that are a
// uniform grey gradient (EMPTY — the band window sat on bleached
// tray/border) and, in the Light-On panel, a title band AND bottom
// strip that are PURE uniform white while the straightened card is
// clean and legible. Those bands still went to OCR: they burned
// 1–2s per attempt and came back as garbage tokens
// ('- . 7 RE GREE SRR EES a d APE B 3 -') that then sat in the
// fusion pool as pseudo-evidence ('title (uncertain — thin
// margin)') — the pool the corroboration rule reads. A band with
// no ink structure in it is NO-TEXT evidence and must be classified
// BEFORE OCR, the way analyzeBottomBand already gates speckle.
// ---------------------------------------------------------------------------

export interface BandBleachAnalysis {
  /** True when the band carries no readable ink structure at all. */
  bleached: boolean;
  /** "blown-white" (uniform near-white) | "uniform" (flat grey /
   * smooth gradient, no ink) | "" when the band carries structure. */
  kind: "blown-white" | "uniform" | "";
  /** Mean luminance 0–255. */
  mean: number;
  /** Population standard deviation of luminance. */
  stdev: number;
  /** Share of sampled pixels deviating from their ROW median by
   * more than 30 luminance points — the ink-structure measure.
   * Printed glyphs are local deviations; a bleached band (flat or
   * a smooth vertical gradient) has almost none, because each row
   * is internally uniform even when rows differ from each other. */
  inkShare: number;
  /** The diagnostics reason recorded for a bleached band. */
  reason: string;
}

/** The exact diagnostics wording for a bleached band (Pass 23). */
export const BLEACHED_BAND_REASON = "band bleached — no text";

/**
 * Classify one band's luminance buffer (the BUILT band image, i.e.
 * exactly what OCR would see) as bleached / carrying structure.
 * Rules (all must hold for "bleached", so a genuinely
 * low-contrast title — faint glyphs on a light frame — is never
 * classified away: its strokes are local deviations, so inkShare
 * clears the floor even when its global stdev is low):
 *  - inkShare < 0.4%: essentially no pixel deviates from its own
 *    row's median — no glyph strokes anywhere in the band;
 *  - stdev < 16: no strong global structure either (a band that is
 *    half black frame / half white paper has huge stdev and real
 *    edges — that is a mis-aimed band, not a bleached one, and OCR
 *    still gets its chance at it);
 *  - mean ≥ 60: bleach is a LIGHT-side phenomenon. A uniform
 *    near-BLACK band is the crushed/too-dark case, which Pass
 *    17's Auto Light floor already owns at the attempt level
 *    (titleCrushed skips the title reads and settles tooDark) —
 *    it is deliberately NOT classified here;
 *  - and then: mean ≥ 235 → "blown-white"; 60 ≤ mean < 235 →
 *    "uniform" (flat grey / smooth gradient).
 * Measured shapes: P-c's pure-white bands (mean 255, stdev 0,
 * inkShare 0) and P-a's uniform grey gradient (mean ≈129, rows
 * internally flat, inkShare ≈ 0) classify bleached; the Pass
 * 15/17 genuine low-contrast title fixtures carry inkShare well
 * above the floor.
 */
export function classifyBandBleach(lum: ArrayLike<number>, width: number, height: number): BandBleachAnalysis {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const total = w * h;
  if (total === 0 || lum.length < total) {
    return { bleached: false, kind: "", mean: 0, stdev: 0, inkShare: 1, reason: "" };
  }
  let sum = 0;
  for (let i = 0; i < total; i++) sum += lum[i] ?? 0;
  const mean = sum / total;
  let sq = 0;
  for (let i = 0; i < total; i++) {
    const d = (lum[i] ?? 0) - mean;
    sq += d * d;
  }
  const stdev = Math.sqrt(sq / total);
  // Ink share: per-row median deviation (sampled every 2nd pixel
  // for speed — the statistic is a share, stable under sampling).
  let ink = 0;
  let sampled = 0;
  const rowVals: number[] = [];
  for (let y = 0; y < h; y++) {
    rowVals.length = 0;
    for (let x = 0; x < w; x += 2) rowVals.push(lum[y * w + x] ?? 0);
    const sorted = [...rowVals].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
    for (const v of rowVals) {
      sampled += 1;
      if (Math.abs(v - med) > 30) ink += 1;
    }
  }
  const inkShare = sampled > 0 ? ink / sampled : 0;
  const bleached = inkShare < 0.004 && stdev < 16 && mean >= 60;
  if (!bleached) return { bleached: false, kind: "", mean, stdev, inkShare, reason: "" };
  const kind = mean >= 235 ? "blown-white" : "uniform";
  return { bleached: true, kind, mean, stdev, inkShare, reason: BLEACHED_BAND_REASON };
}

// ---------------------------------------------------------------------------
// B2. Bottom-strip AIMING (Pass 18). The fixed strip window (crop
// y 0.915-0.995) is tuned for slash-era frames whose number line sits
// at ~92.5% of the true card. Measured on the user's Way of the Mind
// Sculptor attempts (FRA frame: 'U 0224' prints at card 0.885-0.925,
// ~2% higher), a few % of crop slack (aspect-correction growth +
// expansion + rect jitter) pushed the whole info block ABOVE the
// window: A1's strip contained only card 0.948-1.0 + tray (read the
// FRA/artist line's lower half, zero number candidates), A3's block
// ended 1.7% of crop height above the window top (strip read "").
//
// The aim is WINDOW-RELATIVE, because a strip can contain perfectly
// good text (the artist line alone) and still miss the number — no
// whole-region statistic separates "the info block" from the rules
// text above it (measured: region clusters crown the text box). What
// the strip's own ink profile DOES show is WHERE its text sits: on a
// well-aimed strip the two printed lines straddle the window's
// middle; when the block has drifted out, the ink crowds the top
// edge, the bottom edge, or is absent entirely. The rules below turn
// that into one bounded re-aim (see aimBottomSpec in ocr.ts).
// ---------------------------------------------------------------------------

export interface StripInkAssessment {
  /** Total ink mass (sum of per-row ink fractions, capped rows only). */
  mass: number;
  /** Ink centroid as a fraction of the WINDOW height (0 = top). */
  centroid: number | null;
}

/** Minimum ink mass for a window to count as "carrying text". A
 * single printed line at device crop scale sums to ~2.5; a blank
 * border/tray window sums to ~0. */
export const STRIP_INK_FLOOR = 1.2;

/**
 * Assess one strip window's ink profile: `fractions[i]` is the
 * fraction of sampled pixels in row i deviating from that row's
 * median luminance. Rows above 0.62 are transition/texture rows (a
 * card edge sweeping the window, a slab) — they contribute nothing:
 * an edge is not text, and counting it would centre the window on
 * the card's bottom edge instead of its printed lines.
 */
export function assessStripInk(fractions: number[]): StripInkAssessment {
  let mass = 0;
  let wsum = 0;
  const n = fractions.length;
  for (let i = 0; i < n; i++) {
    const v = fractions[i] ?? 0;
    if (v > 0.62) continue;
    mass += v;
    wsum += v * (n > 1 ? i / (n - 1) : 0);
  }
  return { mass, centroid: mass > 0 ? wsum / mass : null };
}

/** A window is well-aimed when it carries text whose centroid sits
 * in the middle band of the window — the two info lines straddle
 * the centre instead of crowding an edge or missing entirely. */
export function stripWindowCentred(a: StripInkAssessment): boolean {
  return a.mass >= STRIP_INK_FLOOR && a.centroid != null && a.centroid >= 0.3 && a.centroid <= 0.7;
}

/**
 * The re-aim shift (in crop fractions) that would centre the ink of
 * a window of height `windowHeight`: text crowding the top (centroid
 * 0.1) moves the window UP by (0.5 - 0.1) x height; text crowding
 * the bottom moves it down symmetrically. Zero when the window is
 * already centred or carries no text to centre on.
 */
export function stripAimShift(a: StripInkAssessment, windowHeight: number): number {
  if (a.mass < STRIP_INK_FLOOR || a.centroid == null) return 0;
  if (a.centroid >= 0.3 && a.centroid <= 0.7) return 0;
  return (a.centroid - 0.5) * windowHeight;
}

/**
 * Race a promise against a hard cap. The underlying promise's late
 * settlement is always handled (never an unhandled rejection) and
 * simply discarded when the cap wins.
 */
export async function raceWithCap<T>(
  p: Promise<T>,
  capMs: number,
): Promise<{ status: "ok"; value: T; ms: number } | { status: "timeout"; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ status: "timeout", ms: capMs });
    }, capMs);
    p.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ status: "ok", value, ms: Date.now() - t0 });
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // An errored read races as a timeout-equivalent empty result:
        // callers of the capped bottom read treat both as "no evidence".
        resolve({ status: "timeout", ms: Date.now() - t0 });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// E. Deadline-based settlement + collector-number rescue (Pass 9)
//
// The user's Divergent Equation attempts 1–2 (2026-11-08): title and
// match stages COMPLETED (162–179ms, 446–683ms) with usable evidence
// in hand — a fragment title read ('Divergent ae') and a PERFECT
// bottom line ('U 0043 SOS EN INKOGNIT' → SOS #43) — yet the attempt
// "hung during: title" until the 8s watchdog. One pooled variant job
// spinning on the single shared OCR worker (whose jobs serialise)
// blocked the attempt's later awaits, so it never reached settlement;
// and the collector-number rescue only ran in the normal settle path
// the attempt never reached.
//
// The rules encoded here:
//  E1. EVERY read in an attempt is individually capped (title ~900ms,
//      bottom ~1.2s — the ocr.ts wrappers), and the attempt's READS
//      settle by a fixed overall deadline (ATTEMPT_DEADLINE_MS for
//      the frame loop, ATTEMPT_RESCUE_DEADLINE_MS including the
//      rescue-band reads) with the BEST EVIDENCE AVAILABLE AT THAT
//      MOMENT. A hung variant can never block settlement: cappedRead
//      returns "skipped" once the deadline is gone, and the pipeline
//      proceeds to judge the pooled evidence.
//  E2. The number rescue runs on EVERY exit path — normal settlement,
//      deadline settlement, and the watchdog branch itself — from the
//      attempt's ALREADY-CAPTURED bottom text, with no new OCR. A
//      watchdog timeout may only display after this rescue has been
//      tried on existing evidence.
// ---------------------------------------------------------------------------

/** Reads-phase budget for the fast path: frame-loop reads settle by
 * this deadline (from the start of identification) with whatever
 * evidence has landed. A healthy scan's reads take ~1–2.3s; 2.5s
 * leaves headroom while staying far under the 8s watchdog. */
export const ATTEMPT_DEADLINE_MS = 2500;

/** Total envelope when the title-band rescue reads run too (Snap
 * only): the frame loop plus one bounded rescue pass, still half the
 * watchdog's 8s. */
export const ATTEMPT_RESCUE_DEADLINE_MS = 4000;

/** PASS 31 — the FRESH budget granted to Snap's Rescue-2 title-band
 * pass at the moment it starts (AttemptClock.extendByFromNow). The
 * rescue runs after settlement's image wait on the same attempt
 * clock, which the wait has legitimately consumed; without a fresh
 * grant every rescue read was skipped at the deadline check and the
 * pass was dead code on exactly the attempts that needed it (the
 * 2026-11-10 Eye of Jace ×2 / Stingerquill Annex panels: title
 * 211/240/339ms — the frame loop's single-PSM reads only — while
 * the rescue's offset/tall/deskew/lifted treatments never ran).
 * 3.5s matches the rescue's own documented bound (~3.5s of extra
 * reads, Pass 8). */
export const RESCUE_AFTER_WAIT_BUDGET_MS = 3500;

// ---------------------------------------------------------------------------
// Pass 20 — the image channel's race budgets. MEASURED DEFECT (the
// Pass 19 production failure): the identifyByImage server round trip
// takes 4.2–6.8s of inference alone (4.8s, 5.5s and 8.0s end-to-end
// for three known cards, exercised against the real action), but the client
// raced the call at 3.5s and mapped the timeout to "no candidates" —
// the channel lost a race it could never win, on 100% of production
// attempts, and the diagnostics collapsed the loss into the same
// string as a genuine no-match. The budgets below are set from the
// measurements, not from the OCR deadline discipline: the image call
// starts at burst start (concurrent with OCR) and only an attempt
// whose OCR is NON-decisive ever waits on it.
// ---------------------------------------------------------------------------

/** Cap on the identifyByImage call itself. The measured server round
 * trip is 4.8–8.0s; 15s leaves ~2× headroom for a slow network leg
 * while still bounding a truly dead service. (Pass 19 shipped 3.5s —
 * below the fastest measured round trip, so every call was discarded.) */
export const IMAGE_VISION_CAP_MS = 15000;

/** Attempt-clock deadline for the fusion wait when the pooled OCR is
 * NOT decisive: settlement waits for the primary (image) channel up
 * to this point from burst start. Covers the measured 8.0s worst
 * server round trip plus the (parallelised) reference-fingerprint
 * phase, with headroom. An OCR-decisive attempt never pays it — it
 * keeps the rescue envelope above, so the pre-rework happy path and
 * its timing are untouched. */
export const IMAGE_WAIT_DEADLINE_MS = 12000;

/** The attempt-clock deadline the fusion consult waits to for the
 * image channel: OCR decisive → the ordinary rescue envelope (the
 * image channel may still veto via the conflict interlock if it has
 * already landed); OCR uncertain → the image wait deadline, because
 * the primary channel's verdict is the one the attempt is missing. */
export function fusionWaitDeadlineMs(ocrDecisive: boolean): number {
  return ocrDecisive ? ATTEMPT_RESCUE_DEADLINE_MS : IMAGE_WAIT_DEADLINE_MS;
}

/** Pass 23 (Item B fix): when a collector-number hit is being held
 * for the number interlock (fusion.ts numberHitInterlock), the
 * fusion wait is capped shorter than the full image wait — the
 * measured identifyByImage round trip lands by ~8s from capture,
 * and a scan already holding an exact-printing answer should not
 * sit out the whole 12s uncertain-pool wait for a contradiction
 * that is not coming. If no decisive contradiction has arrived by
 * the cap, the printed number settles as it always has. */
export const NUMBER_HIT_WAIT_CAP_MS = 8000;

export function fusionWaitBudgetMs(ocrDecisive: boolean, hasPendingNumberHit: boolean): number {
  const base = fusionWaitDeadlineMs(ocrDecisive);
  return hasPendingNumberHit ? Math.min(base, NUMBER_HIT_WAIT_CAP_MS) : base;
}

/** Watchdog deferral for a sanctioned image wait: while an attempt is
 * inside its fusion wait (registered in imageWaitRef), the 8s
 * watchdog must NOT tear it down — the wait is bounded by
 * IMAGE_WAIT_DEADLINE_MS, so the watchdog re-arms for just past the
 * wait's end and runs its normal path only if the attempt STILL has
 * not settled by then. A settled attempt never defers (the existing
 * success-is-final branch owns it), and neither does a wait belonging
 * to a different attempt or one whose deadline has passed. */
export function watchdogImageDeferral(input: {
  settled: boolean;
  wait: { attempt: number; untilEpochMs: number } | null;
  attempt: number;
  nowMs: number;
}): { defer: boolean; rearmMs: number } {
  if (input.settled || !input.wait) return { defer: false, rearmMs: 0 };
  if (input.wait.attempt !== input.attempt) return { defer: false, rearmMs: 0 };
  const left = input.wait.untilEpochMs - input.nowMs;
  if (left <= 0) return { defer: false, rearmMs: 0 };
  // Re-arm slightly past the wait's end so the pipeline's own
  // settlement (which lands at the deadline) wins the race.
  return { defer: true, rearmMs: left + 500 };
}

/** Pass 21 — the post-completion settlement grace. When the image
 * channel has REPORTED for an attempt (candidates + distances
 * computed), the attempt's remaining work is bounded settlement:
 * the fusion consult, at most one clock-bound rescue pass whose
 * reads are individually capped (a zombie OCR job is abandoned at
 * its cap by cappedRead and generation-cancelled via the Pass 15
 * OCR generation), and raced network lookups. None of it can
 * legitimately outlive this grace — but the fixed 8s watchdog CAN
 * fire inside it (the user's Chandra panel: the image result had
 * landed and fusion had already abstained, yet the watchdog reset
 * the attempt with "hung during: title" while the bounded rescue
 * pass was still running, because the Pass 20 deferral was only
 * ever armed while the image WAIT was still pending). */
export const IMAGE_SETTLE_GRACE_MS = 10000;

/** A bounded shield over one attempt: while `untilEpochMs` is in
 * the future, the attempt is inside a sanctioned, deadline-bound
 * phase (a fusion wait, or post-image-result settlement) and the
 * watchdog must defer instead of resetting it. Registered by
 * identifyBurst in a ref the watchdog reads; keyed by attempt so a
 * stale shield can never protect a newer attempt. */
export interface AttemptShield {
  attempt: number;
  untilEpochMs: number;
}

/**
 * The watchdog's deferral decision over ALL of an attempt's
 * shields (Pass 21 generalisation of watchdogImageDeferral, which
 * covered only the pending image wait). Rules:
 *  - a SETTLED attempt never defers (success-is-final owns it);
 *  - a shield belonging to a DIFFERENT attempt never defers;
 *  - an EXPIRED shield never defers (the sanctioned phase is over;
 *    a still-unsettled attempt then gets the normal watchdog path);
 *  - otherwise defer, re-arming just past the LATEST shield end so
 *    the pipeline's own settlement wins the race.
 * An attempt that has received a completed image-channel result
 * therefore cannot die by watchdog while its bounded settlement
 * is still inside the grace the result bought it.
 */
export function watchdogShieldDeferral(input: {
  settled: boolean;
  shields: (AttemptShield | null)[];
  attempt: number;
  nowMs: number;
}): { defer: boolean; rearmMs: number } {
  if (input.settled) return { defer: false, rearmMs: 0 };
  let latest = 0;
  for (const s of input.shields) {
    if (!s || s.attempt !== input.attempt) continue;
    if (s.untilEpochMs > latest) latest = s.untilEpochMs;
  }
  const left = latest - input.nowMs;
  if (left <= 0) return { defer: false, rearmMs: 0 };
  return { defer: true, rearmMs: left + 500 };
}

/** The watchdog's base patience: an attempt whose pipeline published
 * no clock (or whose clock deadline + margin is sooner) is judged
 * after this long. Historically a bare literal in App.tsx; it is a
 * named constant now so the base and the clock-derived deadline are
 * the only two numbers in the composition. */
export const WATCHDOG_BASE_MS = 8000;

/** Settlement slack after an attempt's sanctioned READ clock runs
 * out: between the last capped read landing and finish() settling
 * the guard, the pipeline still owes the pooled match (measured
 * ≤ ~1.8s on-device), a name resolution, and any race-capped
 * salvage lookups. Matches the fusion shield's +2500ms tail so both
 * layers grant the same settlement envelope. */
export const WATCHDOG_SETTLE_MARGIN_MS = 2500;

/**
 * PASS 32 — THE WATCHDOG READS THE ATTEMPT'S OWN CLOCK (the class
 * fix). Andrew's 2026-11-10 ~19:47/19:49 Stingerquill panels (W1/W2)
 * died "hung during: title" with EVERY stage time printed as
 * completed: the 12s image wait was deferred to (Pass 20/21 shields),
 * the fusion shield covered +2.5s past the wait, and then Pass 31's
 * Rescue-2 grant (extendByFromNow, +3.5s of sanctioned reads) ran
 * UNDER NO SHIELD AT ALL — the watchdog fired at ~15s while rescue
 * reads were legitimately running until ~17s. This was the THIRD
 * sanctioned wait the watchdog failed to defer to, because each
 * extension had to remember to register its own shield.
 *
 * The structural fix: identifyBurst PUBLISHES its AttemptClock, and
 * the watchdog derives its deadline from the clock's CURRENT budget
 * on every firing — deadline = clock start + budget + settle
 * margin. extendTo / extendByFromNow widen `budget`, so ANY future
 * sanctioned extension automatically extends the watchdog's
 * patience; an extension that forgets the watchdog is now
 * impossible by construction. The Pass 20/21 shields remain as a
 * second layer for the post-clock tails the clock does not model
 * (e.g. the completed-image settlement grace, which is anchored to
 * the channel's report time, not the read clock).
 *
 * The published budget is read LIVE at each firing (App passes the
 * clock's current `budget`), never snapshotted at arm time.
 */
export interface PublishedAttemptClock {
  attempt: number;
  /** Date.now() at the moment the AttemptClock was created. The
   * clock itself runs on performance.now(); the two timelines share
   * durations, and the ms-level epoch skew at creation is noise
   * against the 2500ms margin. */
  epochStartMs: number;
  /** The clock's CURRENT total budget (AttemptClock.budget) at the
   * moment of this check. */
  budgetMs: number;
}

/** The epoch before which the watchdog must not judge `attempt`:
 * its sanctioned reads may run until epochStart + budget, and its
 * settlement gets WATCHDOG_SETTLE_MARGIN_MS beyond that. Null when
 * no clock is published for the attempt (the caller then falls back
 * to the base patience + shields, exactly as before Pass 32). */
export function watchdogClockDeadlineMs(input: {
  settled: boolean;
  clock: PublishedAttemptClock | null;
  attempt: number;
}): number | null {
  if (input.settled || !input.clock) return null;
  if (input.clock.attempt !== input.attempt) return null;
  return input.clock.epochStartMs + input.clock.budgetMs + WATCHDOG_SETTLE_MARGIN_MS;
}

/**
 * The watchdog's deferral decision over the attempt's published
 * clock: while now is before the clock-derived deadline, defer and
 * re-arm just past it (so the pipeline's own settlement wins the
 * race). A SETTLED attempt never defers; an EXPIRED deadline never
 * defers — a pipeline that has outlived its own sanctioned budget
 * plus the settlement margin is precisely the genuine hang the
 * watchdog exists for, and it still trips (Pass 32's inverse test).
 */
export function watchdogClockDeferral(input: {
  settled: boolean;
  clock: PublishedAttemptClock | null;
  attempt: number;
  nowMs: number;
}): { defer: boolean; rearmMs: number } {
  const deadline = watchdogClockDeadlineMs(input);
  if (deadline === null) return { defer: false, rearmMs: 0 };
  const left = deadline - input.nowMs;
  if (left <= 0) return { defer: false, rearmMs: 0 };
  return { defer: true, rearmMs: left + 250 };
}

/** A monotonic attempt clock: elapsed/remaining against a budget that
 * can only ever be WIDENED (the rescue phase extends the envelope;
 * nothing may shrink it mid-attempt). `nowFn` is injectable for tests. */
export class AttemptClock {
  private readonly t0: number;
  private budgetMs: number;
  private readonly nowFn: () => number;

  constructor(budgetMs: number, nowFn: () => number = () => Date.now()) {
    this.t0 = nowFn();
    this.budgetMs = budgetMs;
    this.nowFn = nowFn;
  }

  elapsed(): number {
    return this.nowFn() - this.t0;
  }

  remaining(): number {
    return Math.max(0, this.budgetMs - this.elapsed());
  }

  expired(): boolean {
    return this.remaining() <= 0;
  }

  /** Widen the envelope to `budgetMs` (never shrinks it). */
  extendTo(budgetMs: number): void {
    if (budgetMs > this.budgetMs) this.budgetMs = budgetMs;
  }

  /**
   * PASS 31 — grant a FRESH budget measured from NOW: the envelope
   * becomes elapsed + `ms` (never shrinks). This exists because of
   * the Eye of Jace / Stingerquill Annex starvation: identifyBurst's
   * settlement order ran the image-channel wait (up to
   * IMAGE_WAIT_DEADLINE_MS, 12s) BEFORE Snap's Rescue-2 title-band
   * pass, on the SAME clock. extendTo could only widen to absolute
   * budgets, so by the time the wait expired the clock's remaining
   * was ~0 and every rescue cappedRead returned "skipped" without
   * starting — the rescue treatments existed, were scheduled, and
   * never ran (the panels' title stage stayed at the frame loop's
   * 211–339ms despite match stages of 1.8s proving reads landed).
   * A phase that must run AFTER a long sanctioned wait has to be
   * granted its budget from the moment it starts, not from the
   * attempt's birth.
   */
  extendByFromNow(ms: number): void {
    const target = this.elapsed() + Math.max(0, ms);
    if (target > this.budgetMs) this.budgetMs = target;
  }

  get budget(): number {
    return this.budgetMs;
  }
}

export interface CappedReadResult<T> {
  /** The read's value, or null when it timed out / was skipped. */
  value: T | null;
  /** The read overran its cap (or the remaining deadline) and was
   * abandoned; its late result is discarded. */
  timedOut: boolean;
  /** The attempt deadline was already exhausted — the read was never
   * even started. Settlement proceeds with the evidence in hand. */
  skipped: boolean;
  /** Milliseconds actually waited. */
  ms: number;
}

/**
 * Run ONE read under the attempt deadline: raced against the tighter
 * of the per-read cap and the time REMAINING on the clock. Once the
 * clock is exhausted the read is skipped outright (never started), so
 * a pipeline built from cappedReads ALWAYS reaches settlement by the
 * deadline (plus the settlement work itself) — no read, however
 * wedged, can hold the attempt open.
 */
export async function cappedRead<T>(
  clock: AttemptClock,
  capMs: number,
  run: () => Promise<T>,
): Promise<CappedReadResult<T>> {
  const remaining = clock.remaining();
  if (remaining <= 0) return { value: null, timedOut: false, skipped: true, ms: 0 };
  const cap = Math.max(1, Math.min(capMs, remaining));
  const raced = await raceWithCap((async () => run())(), cap);
  if (raced.status === "timeout") return { value: null, timedOut: true, skipped: false, ms: raced.ms };
  return { value: raced.value, timedOut: false, skipped: false, ms: raced.ms };
}

// ---------------------------------------------------------------------------
// E2. The collector-number rescue, shared by every exit path.
// ---------------------------------------------------------------------------

export interface NumberRescueResult<C> {
  /** The identified card + the (set, number) hit that produced it, or
   * null when no candidate resolved. `verified` is the winning
   * candidate's corroboration state (buildNumberCandidates: seen by
   * ≥2 sources, or by both a primary and a verification-treatment
   * read, or cross-treatment number agreement). PASS 24c: only a
   * VERIFIED hit is a number-channel VERDICT that may raise a
   * conflict against a decisive image verdict — an unverified hit
   * can come from a single garbled fragment ('J 021. FRA' → a real
   * foreign pair) and is noise for conflict purposes, though it
   * still settles the scan when nothing decisive contradicts it. */
  chosen: { card: C; hit: BottomLineHit; verified: boolean } | null;
  /** How many plausible (set, number) candidates the captured bottom
   * text produced (0 = the rescue had nothing to try). */
  candidatesSeen: number;
  /** "set/number" keys actually looked up by this call. */
  triedKeys: string[];
}

/**
 * Try every plausible (set, number) candidate from ALREADY-CAPTURED
 * bottom-strip reads against exact lookups — the Pass 8 rescue,
 * factored out so it runs identically in normal settlement, in
 * deadline settlement, and in the watchdog branch (where it is the
 * last chance to identify a hung attempt from its own captured
 * evidence, with NO new OCR). Candidates are tried in corroboration
 * order (buildNumberCandidates); a miss discards the candidate;
 * multiple hits break ties on the artist line (tie-break only, never
 * a requirement). `lookup` must never throw (callers race/catch
 * internally); `tried` shares the attempt's already-tried set so no
 * pair is ever looked up twice in one attempt.
 */
export async function rescueByCollectorNumber<C extends { artist?: string | null }>(
  sources: { text: string; verify?: boolean }[],
  lookup: (set: string, number: string) => Promise<C | null>,
  opts: { tried?: Set<string>; maxCandidates?: number; artistText?: string } = {},
): Promise<NumberRescueResult<C>> {
  const candidates = buildNumberCandidates(sources);
  const tried = opts.tried ?? new Set<string>();
  const triedKeys: string[] = [];
  const hits: { card: C; hit: BottomLineHit; verified: boolean }[] = [];
  for (const cand of candidates.slice(0, opts.maxCandidates ?? 5)) {
    const set = cand.hit.setCode;
    if (!set) continue;
    const key = `${set}/${cand.hit.collectorNumber}`;
    if (tried.has(key)) continue;
    tried.add(key);
    triedKeys.push(key);
    let card = await lookup(set, cand.hit.collectorNumber);
    if (!card && cand.hit.collectorNumberRaw !== cand.hit.collectorNumber) {
      // Zero-padded printings (e.g. "0543") — try as printed.
      card = await lookup(set, cand.hit.collectorNumberRaw);
    }
    // ARTIST CONTRADICTION GUARD (Pass 15): an UNVERIFIED candidate
    // (this rescue tries pairs no second treatment confirmed) whose
    // number was misread by a dropped digit can name a different real
    // card in the same set — MKM "012" for Bolrac-Clan Basher's 0112
    // is Delney, Streetwise Lookout. When the same bottom strip read
    // the artist line CLEANLY and it clearly contradicts the hit
    // card's artist, the hit is a number collision, not an
    // identification: discard it and try the next candidate. Cleanly
    // matching or unreadable artist lines never trigger this.
    if (card && opts.artistText && bottomArtistClearlyContradicts(opts.artistText, card.artist ?? "")) {
      card = null;
    }
    if (card) hits.push({ card, hit: cand.hit, verified: cand.verified });
  }
  if (hits.length === 0) return { chosen: null, candidatesSeen: candidates.length, triedKeys };
  const chosen = hits.length === 1
    ? hits[0]
    : (opts.artistText ? hits.find((h) => artistMatchesBottomText(opts.artistText ?? "", h.card.artist ?? "")) : undefined) ?? hits[0];
  return { chosen: chosen ?? null, candidatesSeen: candidates.length, triedKeys };
}

/**
 * PASS 25 (Item 2b) — how a name-level settle (title win, image win)
 * treats a collector-number rescue hit found in the SAME attempt.
 *
 * The defect: the exact-number rescue ran only in Settlement 2 —
 * AFTER the per-frame title checks — so a decisive title win settled
 * with only the fuzzy bottom salvage as printing input, and a
 * single-treatment (set, number) candidate that would have hit
 * EXACTLY was never looked up. The printed number is the only
 * channel that pins a printing with certainty, so on a name-level
 * settle it gets its say BEFORE the printing is recorded:
 *
 *  - "pin": the hit names the SAME card the settle won — record the
 *    hit's exact printing (name from the winning channel, printing
 *    from the number). Verified or not: the rescue's own artist
 *    guard and corroboration ordering already vetted the hit, and
 *    it only chooses among the settled name's own printings.
 *  - "fallthrough": the hit is VERIFIED and names a DIFFERENT card
 *    — a genuine verdict-level disagreement; the caller abandons
 *    its early settle and lets the settlement machinery (rescue +
 *    Pass 23 interlock + Pass 24c conflict rules) adjudicate.
 *  - "ignore": no hit, or an UNVERIFIED hit naming a different
 *    card — Pass 24c noise (a garbled fragment landing on a real
 *    foreign pair), never a veto.
 */
export type NumberPinDecision = "pin" | "fallthrough" | "ignore";

export function numberPinDecision(
  chosen: { cardName: string; verified: boolean } | null,
  settledName: string,
): NumberPinDecision {
  if (!chosen) return "ignore";
  if (chosen.cardName.trim().toLowerCase() === settledName.trim().toLowerCase()) return "pin";
  return chosen.verified ? "fallthrough" : "ignore";
}

// ---------------------------------------------------------------------------
// E3. SETTLE FEEDBACK FIRST (Pass 22, Item 2)
// ---------------------------------------------------------------------------

/**
 * Run a scan settlement's user feedback (sound + "✓ Added" banner +
 * vibration) at the FIRST synchronous moment of settlement, and only
 * then start the persistence work (scan-list save, JPEG encode, price
 * fields). Before Pass 22 the Rapid success beep was chained off the
 * save's promise (addToList().then(showFlash)) — the sound and banner
 * waited on a full server round-trip, so feedback lagged the scan it
 * belonged to by however slow the save was, exactly the user's "the
 * notifications are not as fast as the card scans".
 *
 * Contract: `feedback` is invoked synchronously, before `persist` is
 * even called; the returned promise is persist's own (callers attach
 * their silent post-save upgrade — e.g. adding the Undo target to the
 * already-showing banner — and their error handling to it). Feedback
 * therefore fires at settle-time by construction, and a slow or
 * failed save can never delay or swallow it.
 */
export function settleWithFeedbackFirst<T>(feedback: () => void, persist: () => Promise<T>): Promise<T> {
  feedback();
  return persist();
}

// ---------------------------------------------------------------------------
// D. Collapsible diagnostics
// ---------------------------------------------------------------------------

export type DebugContext = "success" | "failure" | "didyoumean";

/** localStorage key remembering the user's toggle choice per context. */
export function debugStorageKey(context: DebugContext): string {
  return `manabox-debug-open-${context}`;
}

/**
 * Whether "What the scanner read" starts open: the user's remembered
 * choice for this context wins; otherwise CLOSED on success (the card
 * name/price is what matters) and OPEN on failure / Did-you-mean
 * (that's when the diagnostics are needed).
 */
export function resolveDebugOpen(context: DebugContext, stored: string | null): boolean {
  if (stored === "1") return true;
  if (stored === "0") return false;
  return context !== "success";
}
