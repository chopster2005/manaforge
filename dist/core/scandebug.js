// Incremental, per-attempt scan diagnostics ("What the scanner read").
//
// The bug this fixes: the burst pipeline used to publish its debug block
// (band thumbnails, pooled raw read, stage timings) ONLY when it finished.
// If a manual Snap read HUNG — the exact failure the 8s watchdog exists
// for — the failure panel read whatever setScanDebug had last been given:
// the PREVIOUS scan's debug block, or nothing. The panel must always show
// the scan that actually timed out.
//
// So diagnostics are published INCREMENTALLY, keyed to a scan-attempt
// token:
//  - beginAttempt() runs at the START of every scan attempt (Rapid and
//    Snap) and resets the state — a previous scan's debug can never leak
//    into a new attempt.
//  - publish()/recordStage() apply only while their token is the current
//    attempt and the attempt hasn't been invalidated, so a late-finishing
//    stale attempt can never overwrite a newer attempt's debug.
//  - timeoutSnapshot() is what the watchdog/failure path renders: ONLY
//    the current attempt's (possibly partial) data — bands produced so
//    far, stages completed so far with their ms, and an explicit
//    "hung during: <stage>" marker for the stage that never completed.
//    If no band exists yet it says so plainly instead of showing older
//    data.
const STAGE_ORDER = ["capture", "detect", "title", "bottom", "match"];
/** The exact plain statement the failure panel shows when a read timed
 * out before producing any band image. */
export const NO_BANDS_TIMEOUT_NOTE = "Timed out before any band was read — stage: capture/detect.";
export function formatStageMs(ms) {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}
function emptyDebug(capture, evidence, rect = "") {
    return {
        pooledRead: "",
        evidence,
        capture,
        rect,
        sharpness: "",
        autoLight: "",
        image: "",
        dewarpedUrl: "",
        frameUrl: "",
        titleBandUrl: "",
        bottomBandUrl: "",
        stages: "",
        note: "",
    };
}
export class ScanDebugTracker {
    attemptCounter = 0;
    currentAttempt = 0;
    invalidated = false;
    data = emptyDebug("", "");
    stageMs = {};
    stageNotes = {};
    activeStage = null;
    /** Start a new scan attempt: resets ALL debug state (nothing from a
     * previous scan survives) and returns the attempt token every later
     * publish for this attempt must carry. */
    beginAttempt(init) {
        this.currentAttempt = ++this.attemptCounter;
        this.invalidated = false;
        this.stageMs = {};
        this.stageNotes = {};
        this.activeStage = null;
        this.data = emptyDebug(init.capture, init.evidence, init.rect ?? "");
        return this.currentAttempt;
    }
    /** True while `token` names the live attempt and the watchdog has not
     * invalidated it. Every publish path checks this first. */
    isCurrent(token) {
        return token !== 0 && token === this.currentAttempt && !this.invalidated;
    }
    /** The live attempt's token (0 before the first attempt). */
    get attempt() {
        return this.currentAttempt;
    }
    /** Merge a partial update (band thumbnails, pooled raw read, winning
     * evidence…) into the current attempt and return the snapshot to
     * render — or null when the token is stale/invalidated, in which case
     * the caller must render nothing. */
    publish(token, patch) {
        if (!this.isCurrent(token))
            return null;
        Object.assign(this.data, patch);
        this.data.stages = this.composeStages(null);
        return this.snapshot();
    }
    /** Mark a stage as in progress — this is the stage a timeout snapshot
     * will name in its "hung during:" marker if it never completes. */
    beginStage(token, stage) {
        if (!this.isCurrent(token))
            return null;
        this.activeStage = stage;
        return this.snapshot();
    }
    /** Record a stage's (cumulative) milliseconds as it completes and
     * return the snapshot to render, or null for a stale token. */
    recordStage(token, stage, ms) {
        if (!this.isCurrent(token))
            return null;
        this.stageMs[stage] = ms;
        if (this.activeStage === stage)
            this.activeStage = null;
        this.data.stages = this.composeStages(null);
        return this.snapshot();
    }
    /** Record a stage NOTE instead of milliseconds — e.g. the bottom
     * read was skipped by the noise pre-check, so the stage line reads
     * "bottom skipped (no text row)" instead of the misleading
     * "bottom 0ms" a skipped read used to produce. The note counts as
     * the stage having completed (it is never the hung stage). */
    recordStageNote(token, stage, note) {
        if (!this.isCurrent(token))
            return null;
        this.stageNotes[stage] = note;
        if (this.activeStage === stage)
            this.activeStage = null;
        this.data.stages = this.composeStages(null);
        return this.snapshot();
    }
    /** A copy of the current attempt's debug exactly as published so far. */
    snapshot() {
        return { ...this.data };
    }
    /** Permanently block further publishes from the current attempt (the
     * watchdog calls this after taking its timeout snapshot, so a hung
     * pipeline that eventually finishes cannot overwrite the panel). */
    invalidate() {
        this.invalidated = true;
    }
    /**
     * The failure-panel snapshot for a timed-out read: ONLY the current
     * attempt's data, partial as it may be. Stages completed so far keep
     * their ms; the stage that never completed is named with an explicit
     * "hung during: <stage>" marker. When no band image exists yet, the
     * note states that plainly (with the capture/detect stage named)
     * rather than borrowing an older scan's bands.
     */
    timeoutSnapshot() {
        const hung = this.activeStage ?? STAGE_ORDER.find((s) => this.stageMs[s] === undefined && this.stageNotes[s] === undefined) ?? null;
        const snap = { ...this.data, stages: this.composeStages(hung) };
        if (!snap.titleBandUrl && !snap.bottomBandUrl) {
            snap.note = NO_BANDS_TIMEOUT_NOTE;
        }
        return snap;
    }
    composeStages(hungStage) {
        const parts = [];
        for (const s of STAGE_ORDER) {
            const note = this.stageNotes[s];
            if (note !== undefined) {
                parts.push(note);
            }
            else if (this.stageMs[s] !== undefined) {
                parts.push(`${s} ${formatStageMs(this.stageMs[s])}`);
            }
        }
        if (hungStage)
            parts.push(`hung during: ${hungStage}`);
        return parts.join(" · ");
    }
}
