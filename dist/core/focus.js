// Camera focus + frame sharpness — Pass 31.
//
// WHY THIS MODULE EXISTS (Andrew, 2026-11-10 ~19:30 EST): "make sure
// the camera is in focus to make sure the images come out clear." No
// pass had ever audited focus. The audit found:
//
//  BEFORE (what the app asked for):
//   - getUserMedia: facingMode + resolution ideals ONLY — no focus
//     constraint at all, so the track started in whatever mode the
//     browser defaulted to.
//   - applyCameraLocks (track start / box toggle ONLY): freehand
//     asked for focusMode "continuous" when exposed; BOX mode asked
//     for focusMode "manual" — WITHOUT any focusDistance. Manual
//     focus with no distance is not "locked at the rig distance";
//     it is "wherever the lens happened to be", and on several
//     Android stacks it parks near a default that is NOT the tray
//     distance. The rig's cards could sit permanently slightly soft
//     with the app believing focus was "locked".
//   - Nothing re-asserted focus after the many later
//     applyConstraints calls (exposure raises, torch, the dark-frame
//     retry) — on stacks where an advanced-constraint application
//     resets sibling constraints, the focus mode silently reverted.
//   - ImageCapture stills and Take Photo inherit the live track /
//     the OS camera respectively; neither was focus-audited (the OS
//     camera autofocuses itself; the still path inherits the track).
//   - NO sharpness measurement existed anywhere: burst frames were
//     pooled with equal weight, and the retained viewfinder frame —
//     captured at preview-approval time, plausibly BEFORE autofocus
//     finished settling on a newly presented card — led the burst
//     and could be the pool's only early evidence.
//
// WHAT SHIPS (capability-guarded throughout, mirroring the torch
// pattern — a browser exposing no focus controls behaves exactly as
// before apart from never being parked in modeless manual):
//   1. focusPlan (pure, below): continuous autofocus wherever the
//      track exposes it, in BOTH modes; single-shot (which TRIGGERS
//      an AF cycle) next; "manual" is never requested without a
//      distance. getUserMedia also carries the continuous ideal so
//      the track starts focused before the first lock application,
//      and applyCameraLocks is re-asserted after exposure-changing
//      constraint applications.
//   2. Sharpness selection: every prepared frame's title zone is
//      measured (gradient energy — see gradientSharpness). The
//      completing read and the rescue-band pass read the SHARPEST
//      burst frame first instead of blindly the last/first; the
//      retained frame may only lead a burst when it is not
//      dramatically softer than the live probe frame beside it
//      (retainedSharpnessGate) — a pre-settle retained frame is
//      dropped to a fresh burst, exactly like a stale-scene one.
/**
 * Decide the focus/exposure constraints for a track, from its own
 * reported capabilities. Pure — unit-tested across the capability
 * matrix (tests/pass31.test.ts).
 *
 * Rules:
 *  - "continuous" wins wherever exposed, box or freehand: a rig's
 *    distance is fixed but card thickness, sleeve glare and tiny
 *    phone shifts are not, and continuous AF holds the tray plane
 *    without hunting far (it is already AT the distance).
 *  - Else "single-shot" where exposed: applying it runs one AF
 *    cycle and locks at the measured distance — the right box
 *    behaviour, re-triggered by re-assertion on each capture.
 *  - "manual" is NEVER selected: the app has no focusDistance to
 *    pair with it (the track doesn't report the tray distance), and
 *    modeless manual was the pre-Pass-31 box defect.
 *  - Exposure: freehand requests continuous AE where exposed; box
 *    mode requests nothing (Pass 4: a locked exposure turned box
 *    frames near-black).
 */
export function focusPlan(caps, boxMode) {
    const advanced = [];
    let focus = "none";
    const modes = caps.focusMode ?? [];
    if (modes.includes("continuous"))
        focus = "continuous";
    else if (modes.includes("single-shot"))
        focus = "single-shot";
    if (focus !== "none")
        advanced.push({ focusMode: focus });
    const exposureContinuous = !boxMode && (caps.exposureMode ?? []).includes("continuous");
    if (exposureContinuous)
        advanced.push({ exposureMode: "continuous" });
    return { advanced, focus, exposureContinuous };
}
/**
 * Sharpness of a luminance buffer: mean absolute gradient energy
 * (horizontal + vertical first differences). In-focus printed text
 * is high-frequency energy; defocus is a low-pass filter and removes
 * exactly that energy, so the measure separates a settled frame
 * from a pre-settle / defocused one on the same scene while being
 * indifferent to the scene's brightness (a dim sharp frame keeps
 * its edges; a bright blurry one loses them). Sampled every 2nd
 * pixel per axis for speed — the statistic is a mean, stable under
 * sampling. Returns 0 for degenerate buffers.
 */
export function gradientSharpness(lum, width, height) {
    const w = Math.max(0, Math.floor(width));
    const h = Math.max(0, Math.floor(height));
    if (w < 4 || h < 4 || lum.length < w * h)
        return 0;
    let sum = 0;
    let n = 0;
    for (let y = 0; y < h - 2; y += 2) {
        for (let x = 0; x < w - 2; x += 2) {
            const c = lum[y * w + x] ?? 0;
            sum += Math.abs((lum[y * w + x + 2] ?? 0) - c) + Math.abs((lum[(y + 2) * w + x] ?? 0) - c);
            n += 2;
        }
    }
    return n > 0 ? sum / n : 0;
}
/** Index of the sharpest score (first wins ties); -1 for no scores. */
export function sharpestIndex(scores) {
    let best = -1;
    let bestV = -Infinity;
    for (let i = 0; i < scores.length; i++) {
        const v = scores[i] ?? 0;
        if (v > bestV) {
            bestV = v;
            best = i;
        }
    }
    return best;
}
/**
 * Frame indices ordered sharpest-first (stable for ties) — the read
 * order for the completing treatment and the rescue-band pass, so
 * the frames likeliest to carry a readable title are read first and
 * a decisive read stops the pass before the soft frames are tried.
 */
export function sharpnessOrder(scores) {
    return scores
        .map((v, i) => ({ v: v ?? 0, i }))
        .sort((a, b) => b.v - a.v || a.i - b.i)
        .map((e) => e.i);
}
/** Minimum retained/live sharpness ratio for the retained frame to
 * lead a burst. A retained frame captured before autofocus settled
 * measures a fraction of its settled scene-mates; scene identity
 * (Pass 28) cannot see that — it matches signatures, not focus. */
export const RETAINED_SHARPNESS_MIN_RATIO = 0.6;
/**
 * May the retained frame lead the burst? Only when it is not
 * dramatically softer than the live probe frame captured beside it.
 * Unmeasurable scores (0 — capability/canvas failure) keep the
 * historical behaviour: the gate never drops a frame it couldn't
 * measure.
 */
export function retainedSharpnessGate(retained, live) {
    if (!(retained > 0) || !(live > 0))
        return true;
    return retained >= live * RETAINED_SHARPNESS_MIN_RATIO;
}
/**
 * PASS 32 — THE READABILITY FLOOR (as originally shipped).
 * Andrew's 2026-11-10 ~19:47/19:49 Stingerquill bursts metered
 * 5.9–10.3 on EVERY frame (W1/W2) — no frame was readable, yet the
 * attempts burned 3.1–3.3s of OCR on them and died by watchdog.
 * Measured with the defocus ladder (tests/harness/prep_p32.py +
 * probe-p32-floor.ts, results p32-floor.json: 4 real cards × 8
 * Gaussian radii + dim controls, production metric + production
 * standard-band read + full index):
 *
 *  - bright ladder: reads crown the true name down to sharpness
 *    18.5–22.3 (per card); every fixture ≤ 20.7 in its card's
 *    failing step is garbage or a wrong crown.
 *  - DIM controls (×0.45 brightness, NO blur): sharpness 13.4–15.2
 *    and ALL read usable, three of four decisively — on real cards
 *    the metric scales with luminance range, so a floor set from
 *    the bright ladder alone (e.g. 20) would gate every dim-but-
 *    readable burst: a light gate in disguise. Forbidden.
 *  - dim + mild blur (the realistic dark-room shape): 10.8–12.5,
 *    a coin flip (2 of 4 read nothing usable).
 *  - W1/W2 on-device bursts: 5.9–10.3, all unreadable.
 *
 * FLOOR = 12: the highest value that (a) never gates a measured
 * readable dim-sharp burst, (b) gates every frame of both W
 * bursts, (c) sits at the bottom edge of the dim-soft transition.
 *
 * PASS 33 — THE FLOOR'S ROLE IS DEMOTED; IT MUST NEVER VETO
 * IDENTIFICATION. Pass 32 shipped the floor as a GATE: an all-soft
 * burst that stayed soft after one re-capture was REFUSED — no
 * read attempted at all. On-device (2026-11-10 ~20:14/20:15) that
 * refused EVERYTHING, including the artwork/image channel, which
 * the floor was never calibrated for: Stingerquill Annex at
 * 11.3–11.6 — human-legible, and artwork-identified at d=26 by
 * this same app ~25 minutes earlier — got a capture+detect-only
 * panel, and a brand-new card (Retrieve the Esper, 2.3–4.7) was
 * never even offered to any channel. Three structural errors:
 * (1) a text-legibility metric vetoed channels it was never
 * validated for (artwork tolerates softness completely
 * differently); (2) "soft" was terminal — the only escalation was
 * a second IDENTICAL video burst, never the hi-res still path the
 * app already owns; (3) the lab scale doesn't match his room —
 * the bench's sharp is 71.9 while his real dim video frames run
 * 2.3–11.6 across whole sessions, so a floor fitted to synthetic
 * Gaussian blur on clean composites sits above his entire real
 * distribution in that room.
 *
 * RE-GROUNDED EVIDENCE (ladder + now-labelled REAL samples):
 *  - 11.3–11.6 (Stingerquill, real frames): artwork-identifiable
 *    AND human-legible; OCR unknown (never attempted post-gate).
 *  - 13.4–15.2 (dim bench controls): OCR usable.
 *  - 10.8–12.5 (dim+soft bench): OCR coin flip.
 *  - 5.9–10.3 (W bursts, real frames): OCR unreadable; artwork
 *    UNTESTED there (the image service timed out) — do not claim
 *    them identifiable.
 *  - 2.3–4.7 (Retrieve the Esper first burst, real frames):
 *    genuinely murky even to a human at panel scale.
 * What the metric CAN support: a RELATIVE softness warning and an
 * escalation trigger. What it CANNOT support: an absolute
 * refusal — no labelled real sample establishes a score below
 * which NO channel can identify a card, and the artwork channel's
 * tolerance was never measured against this metric at all.
 *
 * THE FLOOR'S ROLE FROM PASS 33 (SHARPNESS_FLOOR unchanged at 12,
 * semantics changed): it is a SOFT TRIGGER, never a veto —
 *  - all-soft → autofocus re-trigger + one re-capture (kept from
 *    Pass 32 — it demonstrably runs);
 *  - still soft on Snap → escalate ONCE to the hi-res still path
 *    before identifying (see softAttemptPlan / App);
 *  - identification ALWAYS runs — artwork channel (which starts
 *    concurrently with the reads) and sharpest-first OCR — and
 *    "out of focus" survives only as ADVICE attached to a failed
 *    attempt, never as an attempt's sole outcome;
 *  - NO OCR-spend skip is shipped: the labelled evidence shows
 *    real frames diverge from the ladder (11.6 was legible), so
 *    even the rescue-OCR spend is not gated on this metric. The
 *    watchdog's clock-derived deadline (Pass 32) is what bounds a
 *    long soft attempt now.
 * The panel keeps printing the raw numbers either way.
 */
export const SHARPNESS_FLOOR = 12;
/** Settle beat after an autofocus re-trigger before the re-capture:
 * Android AF cycles complete in ~300–600ms; 600ms is the top of the
 * range and matches the Pass 31 settling fixtures, where the
 * +600ms frame is the settled one. */
export const FOCUS_SETTLE_MS = 600;
/**
 * Judge a burst's per-frame title sharpness (0 = unmeasured):
 *  - "unmeasured": no frame could be measured — historical
 *    behaviour (proceed); the trigger never fires on missing data.
 *  - "all-soft": EVERY measured frame is below SHARPNESS_FLOOR —
 *    the burst meters soft; Pass 33: this triggers ESCALATION
 *    (AF re-capture, then a hi-res still on Snap) and focus ADVICE
 *    on failure — it never refuses the attempt (see the floor's
 *    Pass 33 note above; in Pass 32 this verdict was a veto, the
 *    regression Pass 33 removes).
 *  - "ok": at least one measured frame is at/above the floor.
 */
export function burstFocusVerdict(scores) {
    const measured = scores.filter((s) => s > 0);
    if (measured.length === 0)
        return "unmeasured";
    return measured.every((s) => s < SHARPNESS_FLOOR) ? "all-soft" : "ok";
}
export function softAttemptPlan(scores, opts) {
    const soft = burstFocusVerdict(scores) === "all-soft";
    return {
        proceed: true,
        soft,
        escalateStill: soft && opts.snap,
        advice: soft ? softFocusAdvice(scores) : "",
    };
}
/**
 * The focus advice attached to a FAILED attempt whose burst
 * metered all-soft (Pass 33: advice, never a refusal). Wording is
 * honest about the metric's limits: the floor is a lab reference,
 * and real dim frames score lower than the bench — the numbers
 * are printed so the user (and the next screenshot) can judge.
 */
export function softFocusAdvice(scores) {
    const list = scores.filter((s) => s > 0).map((s) => s.toFixed(1)).join(" · ");
    return `The frames were also out of focus (sharpness ${list || "unmeasured"}; the lab readability reference is ${SHARPNESS_FLOOR}+, though real dim frames score lower than the bench). Hold the card flat and still so the camera can lock on — or use Take Photo, which focuses with the camera app.`;
}
/**
 * The AF-state line for the diagnostics Focus line (Pass 32, Item
 * 2b): what the browser EXPOSES about focus, what the app
 * REQUESTED, and what the track reports APPLIED. When the browser
 * exposes no focus capability at all, the line SAYS so — printed
 * on the user's screenshots, that fact separates "the app didn't
 * ask" from "this browser gives the app no lever", which is the
 * core of the native-app case. Pure formatter; App gathers the
 * three inputs from the live track (best-effort, never throws).
 */
export function describeAfState(input) {
    const modes = input.supportedModes;
    if (!modes || modes.length === 0) {
        return "camera focus: not exposed by this browser (no focusMode capability) — autofocus can be neither requested nor verified here";
    }
    const req = input.requested ?? "none";
    const app = input.applied ?? "not reported";
    return `camera focus: requested ${req} · track reports ${app} · browser exposes ${modes.join("/")}`;
}
/**
 * Measure the title-zone sharpness of a CARD crop (the zone the
 * title reads actually consume: y 2%–16%, x 1%–85% of the crop),
 * downsampled to ≤120px wide so it costs ~1ms. Canvas-bound half of
 * the pure metric above; any failure (no context, tainted canvas)
 * returns 0 = "unmeasured", which every consumer treats as neutral.
 */
export function measureTitleSharpness(cardCanvas) {
    try {
        const w = cardCanvas.width;
        const h = cardCanvas.height;
        if (w < 24 || h < 24)
            return 0;
        const sx = Math.floor(w * 0.01);
        const sw = Math.max(24, Math.floor(w * 0.84));
        const sy = Math.floor(h * 0.02);
        const sh = Math.max(12, Math.floor(h * 0.14));
        const scale = Math.min(1, 120 / sw);
        const tw = Math.max(8, Math.round(sw * scale));
        const th = Math.max(4, Math.round(sh * scale));
        const tmp = document.createElement("canvas");
        tmp.width = tw;
        tmp.height = th;
        const ctx = tmp.getContext("2d");
        if (!ctx)
            return 0;
        ctx.drawImage(cardCanvas, sx, sy, sw, sh, 0, 0, tw, th);
        const img = ctx.getImageData(0, 0, tw, th);
        const d = img.data;
        const lum = new Float32Array(tw * th);
        for (let i = 0, j = 0; i < d.length; i += 4, j++) {
            lum[j] = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
        }
        return gradientSharpness(lum, tw, th);
    }
    catch {
        return 0;
    }
}
