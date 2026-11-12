// Rapid-scan scene/stability/retry state machine — PURE logic, no DOM.
// The Scan tab feeds it a grayscale signature of the guide region (plus a
// title-band signature in scanner-box mode) every ~300ms and acts on the
// decisions it returns. Kept separate from React so it can be unit-tested
// with synthetic signature sequences (see tests/rapid.test.ts).
/** Mean absolute difference between two signatures (0 = identical). */
export function signatureDiff(a, b) {
    if (a.length === 0 || b.length === 0 || a.length !== b.length)
        return 999;
    let sum = 0;
    for (let i = 0; i < a.length; i++)
        sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
    return sum / a.length;
}
/**
 * PASS 27 — gain-normalised signature difference: `b` is rescaled to
 * `a`'s mean luminance before the mean-abs diff, so a PURE
 * photometric change (the scene multiplied by a gain — the latched
 * light engaging/releasing, exposure compensation moving, camera
 * AE/AWB wander) contributes ~nothing, while a SPATIAL change (a
 * different card, the card gone) keeps its full distance.
 *
 * Why this exists: the handled phase's change test compared RAW
 * signatures against a signature frozen at scan-fire time. The
 * long-duration simulation (tests/harness/probe-p27-drift.ts, the
 * real machine + the real light latch at the app's 250ms cadence)
 * convicted the result: persistent light-state flips and slow AE
 * wander accumulate across the frozen reference until they cross
 * the same-card threshold (measured sceneDiff 29–76 on latch flips,
 * 20.8 on a ±20% AE wander) and the still-seated card re-scans on a
 * ~5–10s cycle — the user's duplicates. Pass 26's probe missed the
 * class because every event it modelled RETURNED to the handled
 * photometrics within 1–3 samples; a state flip or a ramp never
 * returns. Degenerate (near-black) signatures fall back to the raw
 * diff — there is no gain information to normalise by.
 */
export function signatureDiffNormalised(a, b) {
    if (a.length === 0 || b.length === 0 || a.length !== b.length)
        return 999;
    let ma = 0;
    let mb = 0;
    for (let i = 0; i < a.length; i++) {
        ma += a[i] ?? 0;
        mb += b[i] ?? 0;
    }
    ma /= a.length;
    mb /= b.length;
    if (ma <= 0.5 || mb <= 0.5)
        return signatureDiff(a, b);
    const k = ma / mb;
    let sum = 0;
    for (let i = 0; i < a.length; i++)
        sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0) * k);
    return sum / a.length;
}
/**
 * PASS 27 — a signature's spatial STRUCTURE: the mean relative
 * deviation of its cells from their own mean (0 = a perfectly
 * uniform field). Gain-invariant by construction (it is computed
 * on mean-normalised cells). The empty tray is nearly
 * structureless; a card — title bar, art, text box at 24×34 — is
 * not, at any light level. Used to decide "this scene is the empty
 * baseline" without brightness evidence: shape distance alone
 * scored a dim seated card within threshold of a smooth tray
 * gradient, and raw brightness alone fails the moment the light
 * state flips (probe-p27-drift scenario D, both directions).
 */
export function signatureStructure(sig) {
    if (sig.length === 0)
        return 0;
    let mean = 0;
    for (const v of sig)
        mean += v;
    mean /= sig.length;
    if (mean <= 0.5)
        return 0;
    let sum = 0;
    for (const v of sig)
        sum += Math.abs(v / mean - 1);
    return sum / sig.length;
}
/** PASS 27 — is `sig` plausibly the adopted empty baseline scene?
 * Requires ALL of: gain-normalised shape match to the baseline,
 * and baseline-class (near-absent) spatial structure. A real card
 * fails the structure test at any gain; the empty tray passes it
 * at any gain.
 *
 * Degenerate case: when BOTH signatures are (near-)structureless
 * there is no spatial information to normalise — the uniform-grid
 * fixtures are exactly this, and a hypothetical perfectly even
 * tray would be too — so the decision falls back to the raw diff,
 * the pre-Pass-27 rule, which is correct when brightness is the
 * only signal there is. The real tray carries measurable
 * structure (0.055) and real cards far more (≥0.2), so production
 * scenes always take the normalised path. */
export function matchesBaseline(sig, baseline, threshold) {
    if (sig.length === 0 || baseline.length === 0)
        return false;
    const sigStructure = signatureStructure(sig);
    const baseStructure = signatureStructure(baseline);
    if (sigStructure < 0.02 && baseStructure < 0.02)
        return signatureDiff(sig, baseline) <= threshold;
    if (signatureDiffNormalised(sig, baseline) >= threshold)
        return false;
    const ceiling = Math.max(0.12, 1.8 * baseStructure);
    return sigStructure <= ceiling;
}
/** PASS 27 — the distance the handled phase judges a scene by:
 * gain-normalised when either side carries spatial structure
 * (every real scene does), raw when both are structureless
 * uniform fields (there, level is the only difference there is —
 * the degenerate fixture case, and the pre-Pass-27 rule). Sharing
 * one definition keeps the change test and the absence rule's
 * closer-match comparison commensurate. */
export function sceneDistance(a, b) {
    if (signatureStructure(a) < 0.02 && signatureStructure(b) < 0.02)
        return signatureDiff(a, b);
    return signatureDiffNormalised(a, b);
}
/**
 * PASS 28 — retained-frame scene validation. The frame-at-detection
 * retained for Snap (Pass 15) is refreshed by preview ticks and
 * cleared after two consecutive detection misses, so a fast card
 * swap — or a tick landing mid-slide, on a hand or an empty tray —
 * can leave a fresh-TTL retention whose pixels no longer show the
 * scene in front of the camera. A burst led by such a frame cuts
 * its bands from the previous card's geometry (the user's
 * planeswalker panels: crops that excluded the title row entirely)
 * while the panel still reports "frame: retained". Before a
 * retained frame leads a burst it is compared against one live
 * probe grab with the same gain-normalised scene distance the
 * handled phase uses; a mismatch drops the retention. Missing
 * signatures keep the historical behaviour (no evidence, no veto).
 */
export const RETAINED_SCENE_MAX_DISTANCE = 14;
export function retainedFrameMatchesScene(retainedSig, liveSig) {
    if (retainedSig.length === 0 || liveSig.length === 0 || retainedSig.length !== liveSig.length)
        return true;
    return sceneDistance(retainedSig, liveSig) <= RETAINED_SCENE_MAX_DISTANCE;
}
export const DEFAULT_RAPID_CONFIG = {
    stableThreshold: 9,
    titleStableThreshold: 7,
    sameCardThreshold: 14,
    sameCardThresholdBox: 20,
    stableNeeded: 2,
    retryDelayMs: 1500,
    maxAttempts: 4,
    wiggleThreshold: 5,
    rearmMovementThreshold: 9,
    departureThreshold: 28,
};
/** Single source of truth for how the Rapid toggle constrains a scan. */
export function resolveRapidMode(rapidOn, speed) {
    return rapidOn
        ? { effectiveSpeed: "fast", allowSlowFallback: false }
        : { effectiveSpeed: speed, allowSlowFallback: true };
}
/**
 * What Rapid does with a pooled title match (token-aware scores from
 * lib.ts matchNamesPooled):
 * - "auto": top ≥ 0.62 AND leads #2 by ≥ 0.10 → add to the scan list
 *   WITHOUT pausing (banner offers undo). The user's Treasure Keeper sat
 *   at 60% as the clear top suggestion while Rapid waited for a tap —
 *   with token scoring that read is a decisive win, not a coin flip.
 * - "pause": top ≥ 0.55 but the margin is thin → Did-you-mean sheet.
 * - "none": nothing plausible → counts as a failed attempt; keep
 *   watching / retry. NO-READ evidence (<4 alphanumerics) never even
 *   reaches this function — it is filtered before matching.
 */
export function decideRapidMatch(matches) {
    const top = matches[0];
    if (!top)
        return "none";
    const second = matches[1]?.score ?? 0;
    if (top.score >= 0.62 && top.score - second >= 0.1)
        return "auto";
    if (top.score >= 0.55)
        return "pause";
    return "none";
}
export class RapidMachine {
    cfg;
    boxMode = false;
    phase = "watching";
    /** Recognition attempts made against the card currently in the guide. */
    attempts = 0;
    prevSig = [];
    prevTitleSig = [];
    stableCount = 0;
    /** Signature of the empty scene (box interior / table) captured when rapid
     * started. Scenes matching it NEVER scan — no wasted reads on nothing. */
    baselineSig = [];
    /** Signature of the card last scanned/handled — must change before re-scan. */
    handledSig = [];
    /** Signature of the card the current attempt series is aimed at. */
    targetSig = [];
    retryAt = 0;
    /** PASS 26 — the largest scene diff vs the handled card observed
     * since it settled (the departure evidence a movement re-arm now
     * requires; see departureThreshold). Reset whenever a card becomes
     * handled. */
    peakDeparture = 0;
    /** PASS 29 — the handled card was OBSERVED to depart (the handled
     * phase's change/absence rules fired) since it settled. While the
     * Did-you-mean sheet is up the watcher keeps feeding suppressed
     * samples, so a swap performed during the pause is seen as a
     * transition; this flag is what lets resumeFromPause keep the
     * re-armed watching state instead of re-anchoring to the picked
     * card (whose signature the new card may sit within the same-card
     * threshold of — measured 16.2 vs the box bar of 20 for the
     * Tome Blast → Rank Rat pair in dim box light, probe in
     * tests/harness/rapidsequence.ts --measure). */
    departed = false;
    constructor(cfg = {}) {
        this.cfg = { ...DEFAULT_RAPID_CONFIG, ...cfg };
    }
    setBoxMode(on) {
        this.boxMode = on;
    }
    get isBoxMode() {
        return this.boxMode;
    }
    /** Adopt the current (empty) scene as the baseline that never scans. The
     * app calls this once rapid has started and the guide scene is stable. */
    adoptBaseline(sig) {
        if (sig.length > 0)
            this.baselineSig = sig;
    }
    hasBaseline() {
        return this.baselineSig.length > 0;
    }
    sameCardThreshold() {
        return this.boxMode ? this.cfg.sameCardThresholdBox : this.cfg.sameCardThreshold;
    }
    /** Full reset — used when rapid starts, and when the user picks/skips a
     * Did-you-mean card (that card is considered handled by the caller, who
     * passes its signature so it isn't immediately re-scanned). */
    reset(handledSig = []) {
        this.phase = handledSig.length > 0 ? "handled" : "watching";
        this.handledSig = handledSig;
        this.targetSig = [];
        this.prevSig = [];
        this.prevTitleSig = [];
        this.stableCount = 0;
        this.attempts = 0;
        this.retryAt = 0;
        this.peakDeparture = 0;
        this.departed = false;
    }
    /**
     * PASS 29 — resume after the Did-you-mean pause closes (pick or
     * skip). If the watcher observed the handled card DEPART during
     * the pause (suppressed samples re-armed the machine to watching),
     * that state is kept: the scene now in the guide is a new
     * presentation and must be allowed to scan even when its signature
     * sits within the same-card threshold of the picked card — the
     * exact configuration the pause-duration swap produced (the new
     * card was never attempted at all). Without an observed
     * departure, this is exactly reset(attemptSig): the picked/skipped
     * card counts as handled and will not re-scan while it sits.
     */
    resumeFromPause(attemptSig) {
        if (this.phase === "watching" && this.departed)
            return;
        this.reset(attemptSig);
    }
    /**
     * Feed one watcher sample. `sig` is the full-guide signature; `titleSig`
     * is the title-band-only signature (used for stability in box mode, where
     * card edges may still be settling in the rig).
     *
     * PASS 29 — `suppressed` samples are fed while the Did-you-mean
     * sheet is up: the machine keeps WATCHING (handled-phase departure
     * rules and watching-phase stability all run), but a scan decision
     * is held — the stability count stays pinned at the fire point so
     * the first live sample after the sheet closes fires at once if
     * the scene is still the stable one the suppressed samples saw.
     * Without this, a card swap performed entirely during the pause
     * was invisible: the machine compared only the endpoints at
     * resume, and a new card within the same-card threshold of the
     * picked one (16.2 vs bar 20, measured) was never attempted.
     */
    sample(sig, titleSig, now, opts) {
        if (sig.length === 0)
            return { action: "none" };
        switch (this.phase) {
            case "busy":
                return { action: "none" };
            case "handled": {
                // PASS 22 RE-ARM RULE. A settled card stops blocking the next
                // scan when a PRESENTATION EVENT is observed — any of:
                //  (a) CHANGE: the scene now differs from the handled card by
                //      the same-card threshold (a different card, or the card
                //      removed — the pre-Pass-22 rule);
                //  (b) ABSENCE: the scene matches the empty baseline (the
                //      view is briefly empty — he slid the card out);
                //  (c) MOVEMENT (Pass 22) — RETIRED by Pass 26. Pass 22 let
                //      consecutive-sample movement alone re-arm, for the
                //      slide-out-and-back-in whose removal was never sampled.
                //      The Pass 26 measurement (probe-p26-sig, the App's own
                //      signature over a hand-held composite) shows every
                //      genuine transit crosses rule (a)'s threshold at its
                //      peak anyway (≥49.7 vs the 14/20 bar), while the
                //      movement rule's EXCLUSIVE coverage — events that move
                //      consecutive samples without the scene ever departing
                //      (peaks ≤13.3) — is precisely the still-seated blip
                //      class: camera jitter, hand shadows, light steps, the
                //      events behind "it scanned a couple cards twice by
                //      mistake". A re-presentation fast enough to fall
                //      entirely between two samples is invisible to EVERY
                //      rule (the scene is identical before and after), so
                //      nothing real is lost: re-arm = change or absence,
                //      and the viewfinder tap remains the deliberate
                //      re-scan of a card that never left.
                // After re-arming, the normal stability rule decides: the
                // re-presented card must hold still for stableNeeded samples
                // (≈1s at the watcher's cadence) before it scans — a stable
                // re-presentation counts as a new presentation, while a card
                // that NEVER moves fires none of (a)–(c) and is never
                // re-scanned (no duplicate-add loop). A deliberate tap
                // (forceScan) remains the instant re-scan of an unmoved card.
                // PASS 27: the handled-phase CHANGE comparison is GAIN-
                // NORMALISED. The handled signature was frozen at fire time
                // under whatever light/exposure state the camera was in;
                // the latched light's own engage/release and ordinary AE
                // wander change the scene's gain persistently, and the raw
                // diff reads that as a new card (probe-p27-drift: re-arms
                // at raw sceneDiff 29–76 on latch flips, 20.8 on AE wander,
                // ~5–10s after the settle — the user's duplicate scans).
                // Normalised, a pure gain change scores ~0 and only a
                // spatial change (different card / card gone) can re-arm.
                const sceneDiff = sceneDistance(sig, this.handledSig);
                // ABSENCE (Pass 27, hardened): the empty tray is nearly
                // structureless, so its normalised distance to a dim seated
                // card can fall under the threshold on shape alone (the
                // first normalised build re-armed still-seated cards
                // through THIS door — probe-p27-drift scenario D). Absence
                // therefore requires BOTH matchesBaseline (shape match AND
                // baseline-class structure — a seated card fails the
                // structure test at any gain) AND the baseline to be the
                // scene's closer match than the handled card by a margin.
                // A removed card satisfies both by a wide margin; a seated
                // card satisfies neither.
                const baseDiff = this.baselineSig.length > 0 ? sceneDistance(sig, this.baselineSig) : Number.POSITIVE_INFINITY;
                const emptySeen = matchesBaseline(sig, this.baselineSig, this.sameCardThreshold()) && baseDiff + 6 <= sceneDiff;
                this.prevSig = sig;
                this.prevTitleSig = titleSig;
                // PASS 26: the departure evidence is still tracked (it is
                // the class boundary the config records), but movement alone
                // no longer re-arms — see departureThreshold. A re-arm now
                // requires the change rule (the scene genuinely differs
                // from the handled card — every measured genuine transit
                // crosses it mid-slide at ≥49.7) or the absence rule.
                if (sceneDiff > this.peakDeparture)
                    this.peakDeparture = sceneDiff;
                if (sceneDiff < this.sameCardThreshold() && !emptySeen) {
                    return { action: "none" };
                }
                this.phase = "watching";
                this.handledSig = [];
                this.attempts = 0;
                this.stableCount = 0;
                this.departed = true;
                return { action: "none" };
            }
            case "retry-wait": {
                // Any slight movement = the user adjusted the card: fresh attempts.
                if (signatureDiff(sig, this.targetSig) > this.cfg.wiggleThreshold) {
                    this.phase = "watching";
                    this.attempts = 0;
                    this.stableCount = 0;
                    this.prevSig = sig;
                    this.prevTitleSig = titleSig;
                    return { action: "none" };
                }
                if (now < this.retryAt)
                    return { action: "none" };
                if (opts?.suppressed)
                    return { action: "none" };
                // Same card still sitting there — retry the read.
                this.phase = "busy";
                this.attempts += 1;
                this.prevSig = sig;
                this.prevTitleSig = titleSig;
                return { action: "scan" };
            }
            case "exhausted": {
                if (signatureDiff(sig, this.targetSig) > this.cfg.wiggleThreshold) {
                    this.phase = "watching";
                    this.attempts = 0;
                    this.stableCount = 0;
                    this.prevSig = sig;
                    this.prevTitleSig = titleSig;
                }
                return { action: "none" };
            }
            case "watching":
            default: {
                const stabilityDiff = this.boxMode
                    ? signatureDiff(titleSig, this.prevTitleSig)
                    : signatureDiff(sig, this.prevSig);
                const threshold = this.boxMode
                    ? this.cfg.titleStableThreshold
                    : this.cfg.stableThreshold;
                const still = this.prevSig.length > 0 && stabilityDiff < threshold;
                this.prevSig = sig;
                this.prevTitleSig = titleSig;
                if (!still) {
                    this.stableCount = 0;
                    return { action: "none" };
                }
                this.stableCount += 1;
                if (this.stableCount < this.cfg.stableNeeded)
                    return { action: "none" };
                this.stableCount = 0;
                // A stable scene that is just the empty baseline never scans.
                // PASS 27: matchesBaseline (gain-normalised shape +
                // baseline-class structure) replaces the raw diff. The raw
                // guard failed in the opposite direction from the handled
                // phase: mid-AE-ramp after a light flip, the empty tray
                // drifted ≥ threshold from its own adopted baseline and an
                // attempt fired on nothing (probe-p27-drift scenario D).
                // The structure requirement is what keeps this safe for
                // real cards: a card's normalised shape can sit within
                // threshold of a smooth tray, but its structure cannot.
                if (this.baselineSig.length > 0 &&
                    matchesBaseline(sig, this.baselineSig, this.sameCardThreshold())) {
                    return { action: "none" };
                }
                if (opts?.suppressed) {
                    // Hold at the fire point: the first live sample re-checks
                    // stillness against this very sample and fires at once.
                    this.stableCount = this.cfg.stableNeeded;
                    return { action: "none" };
                }
                this.targetSig = sig;
                this.attempts = 1;
                this.phase = "busy";
                this.departed = false;
                return { action: "scan" };
            }
        }
    }
    /**
     * Report the outcome of a scan this machine triggered.
     * - success / uncertain: the card is handled — it will not be re-scanned
     *   while it sits UNMOVED; a presentation event (scene change past
     *   the same-card threshold, or a briefly empty view) re-arms the
     *   machine for the next card — see the "handled" case in sample()
     *   (Pass 22, movement path retired by Pass 26's measurement). For uncertain, the caller
     *   pauses the watcher and calls reset(sig) when the user picks or skips.
     * - fail: the SAME card unlocks after retryDelayMs and is retried, up to
     *   maxAttempts total attempts; after that the machine is exhausted and
     *   only a wiggle, a card change, or a tap (forceScan) revives it.
     */
    notifyResult(outcome, now) {
        if (outcome === "success" || outcome === "uncertain") {
            this.phase = "handled";
            this.handledSig = this.targetSig;
            this.stableCount = 0;
            this.peakDeparture = 0;
            this.departed = false;
            return;
        }
        // fail
        if (this.attempts >= this.cfg.maxAttempts) {
            this.phase = "exhausted";
        }
        else {
            this.phase = "retry-wait";
            this.retryAt = now + this.cfg.retryDelayMs;
        }
        this.stableCount = 0;
    }
    /**
     * Watchdog reset: a recognition that never settled (hung OCR, dead
     * worker) must not wedge the machine in "busy" forever — the user's
     * "have to refresh the page" bug. Drops back to watching with a fresh
     * attempt budget; the baseline and any handled card are kept.
     */
    forceReset() {
        this.phase = "watching";
        this.attempts = 0;
        this.stableCount = 0;
        this.retryAt = 0;
        this.targetSig = [];
        this.prevSig = [];
        this.prevTitleSig = [];
        this.peakDeparture = 0;
        this.departed = false;
    }
    /**
     * PASS 29 — hand a fire decision back: the scene is stable but
     * the presentation is INCOMPLETE (box mode: the card is being
     * held mid-slide, its detected rect measurably displaced from
     * the rig's seat — the sequence simulation fires on such a scene
     * and burns the attempt on the outgoing card; on device, the
     * image channel can settle that outgoing card from the partial
     * view, which is the user's "reads it again… instead of another
     * card, when I slide it in"). The machine returns to watching
     * with the fire-point stability kept, so the first sample after
     * the card completes its slide fires immediately; the attempt
     * budget is untouched (a deferral is not a failed read). The
     * caller caps consecutive deferrals so a seat the test misjudges
     * can never wedge Rapid.
     */
    deferScan() {
        if (this.phase !== "busy")
            return false;
        this.phase = "watching";
        this.attempts = Math.max(0, this.attempts - 1);
        this.stableCount = this.cfg.stableNeeded;
        this.targetSig = [];
        return true;
    }
    /** Viewfinder tap inside rapid mode: scan whatever is in the guide now.
     * A deliberate tap restarts the attempt budget for this card. */
    forceScan(sig) {
        if (this.phase === "busy")
            return false;
        if (sig.length > 0)
            this.targetSig = sig;
        this.attempts = 1;
        this.phase = "busy";
        return true;
    }
}
