// AUTO LIGHT (Pass 17) — measurement-driven exposure help for the scanner.
//
// The user's scanner box puts the card's TITLE zone in shadow while the
// body stays lit (his 2026-11-09 16:31 panel: title band thumbnail pure
// black, title stage burned 3.9s, "no readable text") and his browser
// (the Muse in-app webview) reports torch = absent, so no hardware
// light exists there. Auto Light therefore has three layers, all driven
// by the SAME metering in this module:
//
//  1. METERING — luminance statistics of the detected card crop's title
//     zone (and, independently, its bottom strip): mean, p10/p50/p90
//     and the share of pixels crushed to near-black (< 8/255).
//  2. HARDWARE (App only, capability-guarded, best-effort) — in Auto
//     mode, when metering says dark: torch on if the track exposes one,
//     exposureCompensation raised if supported; both restored when the
//     light is adequate or the mode is Off. In browsers without those
//     capabilities this layer is a silent no-op and layer 3 carries it.
//  3. SOFTWARE (every browser) — when a band measures DIM, exposure-
//     lifted copies of that band are pooled as ADDITIONAL OCR variants
//     under the existing deadline machinery (see ocr.ts `lift` on
//     BandSpec and the identifyBurst wiring). The gain is computed from
//     the band's own p90 and capped at MAX_LIFT_GAIN. When the band
//     measures BRIGHT, no lifted variant is generated at all — the
//     good-light read path is byte-for-byte the pre-Pass-17 behaviour.
//     When the title zone measures CRUSHED there is essentially no
//     signal to lift: the attempt skips its title reads and settles
//     with a lighting-specific message (TOO_DARK_MESSAGE) instead of
//     the generic "no plausible name".
//
// The classification thresholds below were set by the Pass 17 baseline
// measurement (tests/harness/darkprobe.ts over tests/harness/prep_dark.py
// fixtures — shadow-gradient + uniform-dim composites at the user's box
// geometry, plus bright references from the persisted fixture set;
// numbers in tests/harness/results/p17-baseline.json and DATA-PLAN.md):
//   bright reference bands:  p90 = 163–228 (all identified)
//   dim-but-recoverable:     p90 = 32–92 — raw reads and/or the
//                            capped lift identify; the uniform-dim
//                            ×0.18 band (p90 35) reads as gibberish raw
//                            and EXACT under its p90-derived lift
//                            (tests/harness/probe-lift.ts)
//   crushed (his panel):     p90 ≤ 22 — raw reads return only
//                            fragments, and lifted reads are WORSE:
//                            they manufacture confident garbage (a
//                            wrong name at 0.922). No lift is
//                            attempted; the title stage is skipped.
//   The crush ceiling (26) sits in the measured gap between p90 22
//   (garbage) and p90 32 (readable).

/** Luminance statistics of one band zone, from a 256-bin histogram. */
export interface BandLightStats {
  mean: number;
  p10: number;
  p50: number;
  p90: number;
  /** Share of sampled pixels with luminance < 8 (crushed to black). */
  crushedShare: number;
  samples: number;
}

export type BandLightClass = "bright" | "dim" | "crushed";

/** p90 at/above this reads as a normally lit band — no lift, ever. */
export const BRIGHT_P90_MIN = 150;
/** p90 at/below this is crushed: no recoverable ink/paper separation. */
export const CRUSHED_P90_MAX = 26;
/** The gain maps the band's p90 toward this target luminance. */
export const LIFT_TARGET_P90 = 175;
/** Hard cap on the software exposure lift (×4). */
export const MAX_LIFT_GAIN = 4;

/** The title zone of a card crop (fractions of the CROP): the
 * standard band window plus a small margin. Deliberately NOT the
 * tall band's full extent — on a shadow-gradient scene the slice
 * below the title row catches the gradient's lit edge and inflates
 * p90 (measured Pass 17: zone to y 0.16 read p90 27–39 on bands
 * whose standard window reads p90 15–20, the crushed class). This
 * zone tracks the standard band's own p90 within ~2 points across
 * every measured level. */
export const TITLE_ZONE = { x0: 0.01, x1: 0.83, y0: 0.02, y1: 0.125 };
/** The bottom info strip zone of a card crop (fractions of the CROP). */
export const BOTTOM_ZONE = { x0: 0.02, x1: 0.62, y0: 0.9, y1: 0.995 };

/** Luminance stats from raw RGBA bytes (histogram percentiles). */
export function luminanceStatsFromData(data: Uint8ClampedArray): BandLightStats {
  const hist = new Float64Array(256);
  let n = 0;
  let sum = 0;
  let crushed = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const lum = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
    const bin = Math.max(0, Math.min(255, Math.round(lum)));
    hist[bin] = (hist[bin] ?? 0) + 1;
    sum += lum;
    if (lum < 8) crushed += 1;
    n += 1;
  }
  const pct = (q: number): number => {
    if (n === 0) return 0;
    const target = q * n;
    let acc = 0;
    for (let b = 0; b < 256; b++) {
      acc += hist[b] ?? 0;
      if (acc >= target) return b;
    }
    return 255;
  };
  return {
    mean: n > 0 ? sum / n : 0,
    p10: pct(0.1),
    p50: pct(0.5),
    p90: pct(0.9),
    crushedShare: n > 0 ? crushed / n : 0,
    samples: n,
  };
}

/** Luminance stats of a fractional zone of a canvas, sampled on a
 * stride so a full-resolution crop costs a few thousand samples.
 * Returns null when the canvas can't be read (no 2d context). */
export function zoneLightStats(
  canvas: HTMLCanvasElement,
  zone: { x0: number; x1: number; y0: number; y1: number },
): BandLightStats | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const sx = Math.max(0, Math.floor(canvas.width * zone.x0));
  const sy = Math.max(0, Math.floor(canvas.height * zone.y0));
  const sw = Math.max(1, Math.min(canvas.width - sx, Math.ceil(canvas.width * (zone.x1 - zone.x0))));
  const sh = Math.max(1, Math.min(canvas.height - sy, Math.ceil(canvas.height * (zone.y1 - zone.y0))));
  let img: ImageData;
  try {
    img = ctx.getImageData(sx, sy, sw, sh);
  } catch {
    return null;
  }
  // Sample every 2nd pixel in each axis (≈¼ of pixels) — percentiles
  // are stable at that density and the metering stays cheap enough to
  // run on the preview loop.
  const stride = 2;
  const sampled = new Uint8ClampedArray(Math.ceil((sw / stride) * (sh / stride)) * 4);
  let w = 0;
  for (let y = 0; y < sh; y += stride) {
    for (let x = 0; x < sw; x += stride) {
      const i = (y * sw + x) * 4;
      sampled[w] = img.data[i] ?? 0;
      sampled[w + 1] = img.data[i + 1] ?? 0;
      sampled[w + 2] = img.data[i + 2] ?? 0;
      sampled[w + 3] = 255;
      w += 4;
    }
  }
  return luminanceStatsFromData(w === sampled.length ? sampled : sampled.subarray(0, w));
}

/** Classify a band's light from its stats (Pass 17 baseline criteria). */
export function classifyBand(stats: BandLightStats): BandLightClass {
  if (stats.p90 <= CRUSHED_P90_MAX) return "crushed";
  if (stats.p90 < BRIGHT_P90_MIN) return "dim";
  return "bright";
}

/** Software exposure-lift gain for a band: scale so its p90 lands near
 * LIFT_TARGET_P90, capped at MAX_LIFT_GAIN, never below 1 (no lift). */
export function computeLiftGain(stats: BandLightStats): number {
  if (stats.p90 <= 0) return 1;
  const raw = LIFT_TARGET_P90 / stats.p90;
  return Math.max(1, Math.min(MAX_LIFT_GAIN, raw));
}

/** One band's metering verdict: class + the gain to lift it with
 * (gain is 1 unless the class is "dim"). */
export interface BandMeter {
  stats: BandLightStats;
  cls: BandLightClass;
  gain: number;
}

export function meterBand(canvas: HTMLCanvasElement, zone: { x0: number; x1: number; y0: number; y1: number }): BandMeter | null {
  const stats = zoneLightStats(canvas, zone);
  if (!stats || stats.samples === 0) return null;
  const cls = classifyBand(stats);
  return { stats, cls, gain: cls === "dim" ? computeLiftGain(stats) : 1 };
}

/** A lifted COPY of a whole canvas (Pass 23, Item B fix): the same
 * per-channel multiply the band lift applies (ocr.ts renderBand),
 * for consumers that need the whole card normalised — the image
 * channel's query fingerprints. Reference fingerprints come from
 * normally lit Scryfall art; a dim capture fingerprinted raw
 * measures its exposure difference as hash distance, and in dim +
 * blurred cells colour-twin impostors landed INSIDE the decisive
 * gate (matrix p23-matrix: 11 of 12 image wrong-settles were dim
 * cells; zero in bright cells). Metering the dewarp and pooling a
 * lifted copy's fingerprints alongside the raw ones normalises the
 * query the way the OCR windows already are. Returns null when no
 * lift applies or the canvas can't be read. */
export function liftCanvasCopy(canvas: HTMLCanvasElement, gain: number): HTMLCanvasElement | null {
  if (!(gain > 1.01)) return null;
  try {
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0);
    const img = ctx.getImageData(0, 0, out.width, out.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.min(255, (d[i] ?? 0) * gain);
      d[i + 1] = Math.min(255, (d[i + 1] ?? 0) * gain);
      d[i + 2] = Math.min(255, (d[i + 2] ?? 0) * gain);
    }
    ctx.putImageData(img, 0, 0);
    return out;
  } catch {
    return null;
  }
}

/** Attach an exposure lift to a band spec (structural — works for
 * ocr.ts BandSpec without importing it). Returns null when the meter
 * says no lift should happen (bright or crushed): the GATE that keeps
 * the good-light path byte-for-byte unchanged. */
export function liftedSpec<T extends object>(spec: T, meter: BandMeter | null, label: string): (T & { lift: number; label: string }) | null {
  if (!meter || meter.cls !== "dim" || meter.gain <= 1.01) return null;
  return { ...spec, lift: meter.gain, label };
}

// ---------------------------------------------------------------------------
// Light mode (the Light chip) + failure copy
// ---------------------------------------------------------------------------

/** Pass 22: a fourth mode, "manual" — the user picks the exposure
 * lift themselves (see MANUAL_LEVELS) and it applies deterministically,
 * regardless of metering. Auto remains the default on first run. */
export type LightMode = "auto" | "on" | "off" | "manual";

/** Chip tap cycle: Auto → On → Manual → Off → Auto. */
export function nextLightMode(mode: LightMode): LightMode {
  return mode === "auto" ? "on" : mode === "on" ? "manual" : mode === "manual" ? "off" : "auto";
}

/** Visible chip text for each mode/state. */
export function lightChipText(mode: LightMode, opts: { unsupported: boolean; torchActive: boolean }): string {
  const base = mode === "auto" ? "💡 Auto" : mode === "on" ? "💡 On" : mode === "manual" ? "💡 Manual" : "💡 Off";
  if (opts.unsupported) return `${base} ✗`;
  return opts.torchActive && mode !== "off" ? `${base} ✓` : base;
}

// ---------------------------------------------------------------------------
// MANUAL LIGHT (Pass 22, Item 4; Pass 30 slider below) — the user's
// own exposure control for when Auto isn't working well. Thumb-sized
// steps — a continuous slider since Pass 30 — driving the SAME
// lift pipeline Auto uses (BandSpec.lift in ocr.ts): the chosen gain is
// applied to the title and bottom reads deterministically — metering
// is still measured (and printed in the diagnostics), but it no longer
// gates whether a lift happens. The hardware side (App) forces the
// torch on where the browser exposes one and raises exposure
// compensation where supported; in browsers where the torch reports
// absent (the Muse in-app browser — established Pass 17) the control
// is a software exposure control only, and the UI says so plainly.
// ---------------------------------------------------------------------------

export interface ManualLevel {
  label: string;
  gain: number;
}

/** Manual steps: Low / Med / High / Max. Max equals Auto's hard cap. */
export const MANUAL_LEVELS: ManualLevel[] = [
  { label: "Low", gain: 1.5 },
  { label: "Med", gain: 2 },
  { label: "High", gain: 3 },
  { label: "Max", gain: 4 },
];

/** The gain for a manual level index, clamped to the known steps. */
export function manualGainForLevel(level: number): number {
  const idx = Math.max(0, Math.min(MANUAL_LEVELS.length - 1, Math.floor(level) || 0));
  return MANUAL_LEVELS[idx]?.gain ?? 1.5;
}

// ---------------------------------------------------------------------------
// MANUAL LIGHT SLIDER (Pass 30) — Andrew's explicit ask: "The manual
// from off low medium and high but have a slider so i can gradually
// increase it and decrease it." The discrete levels become PRESET
// STOPS on a continuous gain slider: Off = ×1.0 (no boost), Low =
// ×1.5, Med = ×2, High = ×3, and the slider runs smoothly up to the
// ×4 cap (Max). The slider value is a GAIN, persisted as a number;
// it drives exactly the same lift pipeline as the presets did
// (liftForMode "manual" already takes a gain, not a level), and it
// scales the hardware side too (manualExposureValue). Moving the
// slider or tapping a preset only ever changes the value the NEXT
// attempt samples — identifyBurst reads the gain once at attempt
// start, so a mid-attempt drag can never change an in-flight read
// (the Pass 24a latch invariant, extended to the manual control).
// ---------------------------------------------------------------------------

/** Slider range: ×1.0 (no boost) to the Auto cap ×4. */
export const MANUAL_GAIN_MIN = 1;
export const MANUAL_GAIN_MAX = MAX_LIFT_GAIN;

/** The quick settings as slider stops (Pass 30: Off joins the row —
 * Andrew named "off low medium and high" as the manual settings). */
export const MANUAL_PRESETS: ManualLevel[] = [
  { label: "Off", gain: 1 },
  { label: "Low", gain: 1.5 },
  { label: "Med", gain: 2 },
  { label: "High", gain: 3 },
  { label: "Max", gain: 4 },
];

/** Clamp any number to a usable manual gain (garbage → Med ×2). */
export function clampManualGain(gain: number): number {
  if (!Number.isFinite(gain)) return 2;
  return Math.max(MANUAL_GAIN_MIN, Math.min(MANUAL_GAIN_MAX, gain));
}

/**
 * Parse the persisted manual gain. The Pass 30 slider value
 * ("manabox-light-manual-gain") wins; a Pass 22 level index
 * ("manabox-light-manual-level") migrates to its gain; anything
 * else defaults to Med (×2), the old level default.
 */
export function parseManualGain(storedGain: string | null, legacyLevel: string | null): number {
  if (storedGain !== null && storedGain.trim() !== "") {
    const n = Number(storedGain);
    if (Number.isFinite(n)) return clampManualGain(n);
  }
  if (legacyLevel !== null && legacyLevel.trim() !== "") {
    return manualGainForLevel(parseManualLevel(legacyLevel));
  }
  return 2;
}

/**
 * The exposureCompensation value a manual gain maps to on a track
 * whose EC tops out at `maxEc`: linear from 0 at ×1.0 (no boost) to
 * maxEc at the ×4 cap — so the slider scales the hardware exposure
 * exactly the way it scales the software lift. Mode On is the cap
 * end of the same scale (gain = MAX_LIFT_GAIN → maxEc).
 */
export function manualExposureValue(maxEc: number, gain: number): number {
  if (!(maxEc > 0)) return 0;
  const f = (clampManualGain(gain) - MANUAL_GAIN_MIN) / (MANUAL_GAIN_MAX - MANUAL_GAIN_MIN);
  return Math.max(0, Math.min(maxEc, maxEc * f));
}

/** Parse a persisted light mode (unknown/garbage → Auto, the default). */
export function parseLightMode(stored: string | null): LightMode {
  return stored === "auto" || stored === "on" || stored === "off" || stored === "manual" ? stored : "auto";
}

/** Parse a persisted manual level index (unknown/garbage → Med). */
export function parseManualLevel(stored: string | null): number {
  if (stored === null || stored.trim() === "") return 1;
  const n = Number(stored);
  return Number.isFinite(n) ? Math.max(0, Math.min(MANUAL_LEVELS.length - 1, Math.floor(n))) : 1;
}

/**
 * The exposure lift a band gets under a light mode — THE decision the
 * pipeline makes per band, kept pure so it is unit-testable:
 * - "off":    never any lift (the whole layer is disabled);
 * - "manual": exactly the user's chosen gain, regardless of metering
 *             (even on a bright band, and even on a crushed one — the
 *             user explicitly asked for light help; determinism is
 *             the feature);
 * - "on":     the maximum response, always (Pass 30): the lift at
 *             the cap on every band, bright, dim or crushed, plus
 *             (App side) torch + exposure compensation at max for
 *             the whole attempt. Before Pass 30 "on" only forced the
 *             torch and otherwise behaved exactly like Auto — in
 *             Andrew's first real-dark session an On attempt still
 *             metered its lift (×2.5 at p90 71), skipped nothing and
 *             forced nothing in software, and read garbage: the mode
 *             he explicitly asked to "work" was indistinguishable
 *             from Auto in the read path. On is the user's override;
 *             like Manual it does not ask the meter's permission,
 *             and it does not skip a crushed title zone either —
 *             the lifted reads run and the matcher judges them.
 * - "auto":   the Pass 17 metering gate — a lift only for a DIM
 *             band, at its metered gain; bright bands get NO lift
 *             (the good-light path is byte-for-byte the pre-Pass-17
 *             behaviour) and crushed bands get none (the honest
 *             too-dark floor carries those attempts instead).
 * Returns null when no lifted variant should be generated.
 */
export function liftForMode(
  mode: LightMode,
  meter: BandMeter | null,
  manualGain: number,
): number | null {
  if (mode === "off") return null;
  if (mode === "manual") return manualGain > 1.01 ? manualGain : null;
  if (mode === "on") return MAX_LIFT_GAIN;
  if (!meter || meter.cls !== "dim" || meter.gain <= 1.01) return null;
  return meter.gain;
}

/** Attach a SPECIFIC gain as a lift to a band spec (the manual /
 * mode-resolved counterpart of liftedSpec's metering gate). */
export function liftSpecWithGain<T extends object>(spec: T, gain: number | null, label: string): (T & { lift: number; label: string }) | null {
  if (gain === null || gain <= 1.01) return null;
  return { ...spec, lift: gain, label };
}

/**
 * The diagnostics line's metering verdict (Pass 22, Item 3d): the
 * panel must state the DECISION, not just a gain — so the user's next
 * screenshot shows whether the scanner judged the light good or dark.
 * - bright: "light good — no lift (title zone p90 = N)"
 * - dim:    "zone dark — lifted ×G (title zone p90 = N)"
 * - manual: "manual light ×G (title zone p90 = N)" — metering is
 *           still reported, but the gain is the user's, not the meter's.
 * - off:    "" (the layer is off; no line).
 */
export function lightVerdictLine(mode: LightMode, meter: BandMeter | null, appliedGain: number | null): string {
  if (mode === "off" || !meter) return "";
  const p90 = meter.stats.p90;
  if (mode === "on") {
    return `light on — lifted ×${(appliedGain ?? MAX_LIFT_GAIN).toFixed(1)} (title zone p90 = ${p90})`;
  }
  if (mode === "manual") {
    return appliedGain !== null
      ? `manual light ×${appliedGain.toFixed(1)} (title zone p90 = ${p90})`
      : `manual light off (title zone p90 = ${p90})`;
  }
  if (meter.cls === "bright") return `light good — no lift (title zone p90 = ${p90})`;
  if (meter.cls === "crushed") return `couldn't recover the title area — too dark (band p90 = ${p90})`;
  return appliedGain !== null
    ? `zone dark — lifted ×${appliedGain.toFixed(1)} (title zone p90 = ${p90})`
    : `zone dark (title zone p90 = ${p90})`;
}

/** The lighting-specific settle message for a crushed title zone —
 * names darkness/shadow as the cause instead of the generic failure. */
export const TOO_DARK_MESSAGE =
  "Too dark to read — the card's name area is in shadow, and auto light couldn't recover it. Add light, or slide the card down into the light, then scan again.";

/** The generic Snap failure copy (pre-Pass-17 wording, unchanged). */
export const GENERIC_NO_NAME_MESSAGE =
  "No plausible name could be read from that card. The bands it read are below — try again with the card filling the guide, flat and well lit, use the slow read, or add it from Search.";

/** Failure-panel message selection: the too-dark message only when the
 * attempt measured a crushed title zone. */
export function scanFailureMessage(tooDark: boolean): string {
  return tooDark ? TOO_DARK_MESSAGE : GENERIC_NO_NAME_MESSAGE;
}

/** Rapid's one-line dark warning (status line, shown once per dark
 * streak — the caller owns the once-ness). */
export const TOO_DARK_RAPID_HINT =
  "Too dark to read — the card's name area is in shadow. Add light or slide the card into the light.";

// ---------------------------------------------------------------------------
// STEADY LIGHT (Pass 24a, Item B) — the latched light decision.
//
// The user's report: Auto light "flashes on and off like a heartbeat…
// when it takes the shot, it could be dark instead of the correct
// color of light." Localised cause: the hardware layer was driven
// directly by per-cycle metering (preview tick ~800ms, Rapid tick
// ~900ms, plus once per attempt) against a SINGLE threshold
// (p90 < 150 = dark) on a SELF-REFERENTIAL measurement — engaging
// the torch / raising exposureCompensation brightens the very zone
// being metered, so the next cycle read "bright" and restored, the
// next read "dark" and re-engaged: a textbook oscillation loop with
// zero hysteresis and zero dwell. The camera's own auto-exposure
// hunting against the changing constraints compounded it, and the
// capture dark-frame retry raised exposureCompensation mid-burst
// without ever registering it, so Auto's restore logic and the
// retry fought over the same constraint.
//
// The fix is a LATCH, and this module owns its decision logic pure:
//  - HYSTERESIS: dark evidence requires p90 < LIGHT_ENGAGE_P90
//    (clearly dim); bright evidence requires p90 >=
//    LIGHT_RELEASE_P90 (clearly lit — the BRIGHT_P90_MIN line plus
//    margin). Between them the evidence is NEUTRAL and the applied
//    state holds. Metering oscillating around the old single
//    threshold therefore produces no flips at all.
//  - DWELL: after any application, the opposite flip is refused for
//    LIGHT_DWELL_MS, so even full dark↔bright swings cannot pulse
//    faster than one change per dwell window.
//  - ATTEMPT LATCH: an attempt's decision is made ONCE at attempt
//    start (from the pre-capture frames' metering) and held for the
//    attempt's whole duration — stepLightLatch refuses to change
//    anything while an attempt is latched, so preview metering can
//    keep running for the NEXT attempt without ever mutating the
//    in-flight attempt's light state. The per-attempt software lift
//    is unaffected (it is computed from the attempt's own metering
//    as before); the latch governs the HARDWARE state only.
// ---------------------------------------------------------------------------

/** p90 below this is unambiguous dark evidence (engage). Sits below
 * the DIM band's working range measured in Pass 17/22 (recoverable
 * p90 27–149) — a zone must be clearly dim, not borderline. */
export const LIGHT_ENGAGE_P90 = 130;
/** p90 at/above this is unambiguous bright evidence (release): the
 * Pass 17 bright floor (150) plus a hysteresis margin, so a zone
 * hovering at the bright boundary cannot toggle the state. */
export const LIGHT_RELEASE_P90 = 175;
/** Minimum time an applied light state must hold before the
 * opposite state may replace it. */
export const LIGHT_DWELL_MS = 4000;

export interface LightLatchState {
  /** The hardware state currently applied: true = light engaged
   * (torch on / exposure raised), false = restored / never engaged. */
  dark: boolean;
  /** Caller-clock time of the last application; -Infinity before
   * the first, so the first decision always applies immediately. */
  sinceMs: number;
  /** The in-flight attempt's latched decision, or null between
   * attempts. While set, preview steps cannot change the state. */
  attemptDark: boolean | null;
}

export function createLightLatch(): LightLatchState {
  return { dark: false, sinceMs: Number.NEGATIVE_INFINITY, attemptDark: null };
}

export type LightEvidence = "dark" | "bright" | "neutral";

/** Classify a metered title-zone p90 into latch evidence. The wide
 * neutral band between ENGAGE and RELEASE is the hysteresis: the
 * Pass 17 bright/dim boundary (150) sits inside it, so metering
 * that straddles the classification threshold is neutral here. */
export function lightEvidence(p90: number): LightEvidence {
  if (p90 < LIGHT_ENGAGE_P90) return "dark";
  if (p90 >= LIGHT_RELEASE_P90) return "bright";
  return "neutral";
}

export type LightAction = "engage" | "release" | null;

export interface LightStep {
  state: LightLatchState;
  /** The ONE hardware application this step calls for, if any. */
  action: LightAction;
}

/** The desired state given evidence: neutral evidence holds the
 * current state; dark/bright evidence asks for that state. */
function desiredDark(state: LightLatchState, p90: number): boolean {
  const ev = lightEvidence(p90);
  return ev === "dark" ? true : ev === "bright" ? false : state.dark;
}

/**
 * A PREVIEW metering step (between attempts): may engage or release
 * the hardware light when the evidence is unambiguous AND the dwell
 * has elapsed. While an attempt is latched this is a strict no-op —
 * preview metering never mutates an in-flight attempt's light.
 */
export function stepLightLatch(state: LightLatchState, p90: number, nowMs: number): LightStep {
  if (state.attemptDark !== null) return { state, action: null };
  const want = desiredDark(state, p90);
  if (want === state.dark) return { state, action: null };
  if (nowMs - state.sinceMs < LIGHT_DWELL_MS) return { state, action: null };
  return {
    state: { dark: want, sinceMs: nowMs, attemptDark: null },
    action: want ? "engage" : "release",
  };
}

/**
 * ATTEMPT START: the attempt's light decision, made once from the
 * pre-capture frames' metering and latched until endAttemptLight.
 * The hardware flips only if the decision differs from the applied
 * state AND the dwell allows it — so across one attempt there is at
 * most ONE light-state application, at its start. The returned
 * `dark` is the attempt's latched hardware state.
 */
export function beginAttemptLight(
  state: LightLatchState,
  p90: number,
  nowMs: number,
): LightStep & { dark: boolean } {
  const want = desiredDark(state, p90);
  let { dark, sinceMs } = state;
  let action: LightAction = null;
  if (want !== dark && nowMs - sinceMs >= LIGHT_DWELL_MS) {
    dark = want;
    sinceMs = nowMs;
    action = want ? "engage" : "release";
  }
  return { state: { dark, sinceMs, attemptDark: dark }, action, dark };
}

/** ATTEMPT END: release the latch. The applied hardware state itself
 * persists (it is the between-attempts state) until a later preview
 * step or attempt start changes it under the same rules. */
export function endAttemptLight(state: LightLatchState): LightLatchState {
  return state.attemptDark === null ? state : { ...state, attemptDark: null };
}

/**
 * Register a hardware application made OUTSIDE the latch's own
 * steps — the capture dark-frame retry raises exposureCompensation
 * directly when a burst comes back near-black. Recording it here
 * (a) makes the latch's applied state truthful, so a later release
 * restores the retry's raise instead of leaving it maxed forever,
 * and (b) starts the dwell, so the attempt-start decision that
 * follows cannot immediately undo it mid-capture.
 */
export function noteExternalLightApplication(state: LightLatchState, dark: boolean, nowMs: number): LightLatchState {
  return { ...state, dark, sinceMs: nowMs };
}
