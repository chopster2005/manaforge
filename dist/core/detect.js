// Card rectangle detection — find the actual card in a captured frame
// BEFORE reading it.
//
// Why this exists: the old pipeline cropped the title band relative to the
// on-screen GUIDE, assuming the card fills the guide. In the user's scanner
// box the card sits small (~40% of the guide height) on a white tray, so the
// guide-relative band read white box interior and produced garbage. The fix
// is to locate the card itself and crop every band relative to IT.
//
// Method (pure, on a downscaled luminance grid — unit-testable without a
// DOM): a physical card is a sustained slab of TEXTURE (art, rules text,
// frame lines) while a tray/table/background is comparatively smooth. So:
//   1. per-pixel gradient magnitude → "textured" mask,
//   2. row texture-density projection → the card's vertical span (longest
//      sustained run, small gaps merged),
//   3. column projection inside that span → the horizontal span,
//   4. cross-check with luminance contrast against the surrounding
//      background, and report a confidence. Low confidence → caller falls
//      back to the guide crop and says so.
const GRAD_THRESHOLD = 34;
const MIN_SPAN_FRAC = 0.2;
/** Longest run of "on" rows/cols, merging gaps up to gapMax. Returns [start, end) or null. */
function longestRun(on, gapMax) {
    let best = null;
    let runStart = -1;
    let lastOn = -1;
    let gap = 0;
    const consider = () => {
        if (runStart >= 0 && (!best || lastOn + 1 - runStart > best[1] - best[0])) {
            best = [runStart, lastOn + 1];
        }
    };
    for (let i = 0; i < on.length; i++) {
        if (on[i]) {
            if (runStart < 0)
                runStart = i;
            lastOn = i;
            gap = 0;
        }
        else if (runStart >= 0) {
            gap += 1;
            if (gap > gapMax) {
                consider();
                runStart = -1;
                gap = 0;
            }
        }
    }
    consider();
    return best;
}
/** Longest span whose density stays ≥ thresh (gaps up to gapMax merged),
 * at least minLen long — or null. */
function spanFromDensity(dens, thresh, gapMax, minLen) {
    const run = longestRun(dens.map((d) => d >= thresh), gapMax);
    if (!run || run[1] - run[0] < minLen)
        return null;
    return run;
}
/**
 * SEAM-BAND TRIM (Pass 28). The gap-merging span finder above can
 * swallow the scanner box's recess seams into the card slab: a seam
 * is a THIN dense line (the recess edge's shadow) separated from the
 * card by a few % of smooth tray, and when seam + gap fit inside
 * the gap tolerance the span grows to the recess — the read crop
 * then contains the box interior with the card floating inside it,
 * the title band lands on tray/wall, and the attempt reads "no
 * readable text" on a perfectly legible card (the user's Guiding
 * Hydra / Chandra panels, 2026-11-10; reproduced on hard-seam rig
 * fixtures: Griffin Protector and Chandra, Chill of Compliance
 * merged to the recess corner, title centroid at 0.22–0.23 of the
 * crop — beyond every title window's reach).
 *
 * The trim recognises exactly that shape at a span edge: a dense
 * band no thicker than ~4% of the span, then a VOID (density below
 * 35% of the span's interior median) at least 3 samples long, then
 * the sustained mass (≥3 samples at ≥50% of the interior median).
 * A real card edge never has a void behind its border line — the
 * title/text mass is contiguous with it — so the trim only ever
 * removes a detached seam. Bounded to 22% of the span per edge, so
 * a misjudged profile can cost a little slack, never the card.
 * Pure; unit-tested in tests/pass28.test.ts.
 */
export function trimSeamBand(p, span) {
    let [s, e] = span;
    const len = e - s;
    if (len < 24 || p.length === 0)
        return span;
    const midStart = s + Math.floor(len * 0.25);
    const midEnd = Math.max(midStart + 1, s + Math.floor(len * 0.75));
    const ref = median(p.slice(midStart, midEnd));
    if (!(ref > 0))
        return span;
    const hi = ref * 0.5;
    const lo = ref * 0.35;
    // Band thickness is a property of the FRAME (a seam's shadow is
    // ~2–4% of the frame whatever the card's size), so the cap is
    // measured against the full axis, not the span: on the column
    // axis the same seam that is 7 samples of a 314-row span is ~13
    // filtered samples of a 226-column span.
    const thinMax = Math.max(4, Math.round(p.length * 0.055));
    // A deeper-seated card puts the seam further from the card:
    // the convicted rig fixtures trim 13–14% of the span; 22% leaves
    // headroom while staying far inside pickSpan's 55% discipline.
    const maxTrim = Math.floor(len * 0.22);
    // The void between a seam and the card must be SUSTAINED — a
    // card's own smooth-art rows dip below the void bar for a few
    // rows at a time (measured: 5-row dips inside Griffin Protector's
    // top art), so a void is at least this long, and brief dips are
    // bridged by judging a ±3 max-filtered profile instead of the raw
    // one (the recess seam itself is often a double line with a
    // 1-row dip, which the raw profile reads as two bands).
    const gapMin = Math.max(6, Math.round(len * 0.03));
    const q = new Array(p.length);
    for (let i = 0; i < p.length; i++) {
        let m = 0;
        for (let d = -3; d <= 3; d++) {
            const v = p[i + d] ?? 0;
            if (v > m)
                m = v;
        }
        q[i] = m;
    }
    // Start edge: [dense band][void][mass] → start at the mass.
    {
        let i = s;
        let band = 0;
        while (i < e && (q[i] ?? 0) >= hi) {
            band += 1;
            i += 1;
        }
        if (band >= 1 && band <= thinMax) {
            let j = i;
            let gap = 0;
            while (j < e && (q[j] ?? 0) < lo) {
                gap += 1;
                j += 1;
            }
            if (gap >= gapMin && j - s <= maxTrim) {
                let run = 0;
                let k = j;
                while (k < e && (q[k] ?? 0) >= hi) {
                    run += 1;
                    k += 1;
                }
                if (run >= 3)
                    s = j;
            }
        }
    }
    // End edge: mirror image.
    {
        let i = e - 1;
        let band = 0;
        while (i >= s && (q[i] ?? 0) >= hi) {
            band += 1;
            i -= 1;
        }
        if (band >= 1 && band <= thinMax) {
            let j = i;
            let gap = 0;
            while (j >= s && (q[j] ?? 0) < lo) {
                gap += 1;
                j -= 1;
            }
            if (gap >= gapMin && e - 1 - j <= maxTrim) {
                let run = 0;
                let k = j;
                while (k >= s && (q[k] ?? 0) >= hi) {
                    run += 1;
                    k -= 1;
                }
                if (run >= 3)
                    e = j + 1;
            }
        }
    }
    return [s, e];
}
function median(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
/**
 * Detect the card rectangle in a luminance grid (row-major, values 0..255).
 * The grid should be downscaled to roughly ≤480px on the long edge.
 * Returns null when no plausible card rectangle is present.
 */
export function detectCardRect(luma, w, h) {
    if (w < 40 || h < 40 || luma.length < w * h)
        return null;
    const at = (x, y) => luma[y * w + x] ?? 0;
    // 1. Textured mask from gradient magnitude.
    const tex = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const gx = Math.abs(at(x + 1, y) - at(x - 1, y));
            const gy = Math.abs(at(x, y + 1) - at(x, y - 1));
            if (gx + gy > GRAD_THRESHOLD)
                tex[y * w + x] = 1;
        }
    }
    // 2. Spans via RELATIVE density, in three passes. Pass 1 (absolute,
    // low threshold) seeds a rough span; passes 2–3 measure density
    // WITHIN the candidate span — relative to the card's own extent.
    // The old single absolute threshold collapsed whenever the card was
    // small in frame (scanner box): a smooth art row inside the card
    // holds texture on maybe 8% of the FRAME width, dipped under the
    // 10% bar, and split the run — detection flipped between found and
    // null on a 2px shift of the same card.
    const gapY = Math.max(2, Math.round(h * 0.08));
    const gapX = Math.max(2, Math.round(w * 0.08));
    const rowDensFull = [];
    for (let y = 0; y < h; y++) {
        let count = 0;
        for (let x = 0; x < w; x++)
            count += tex[y * w + x] ?? 0;
        rowDensFull.push(count / w);
    }
    const roughRows = spanFromDensity(rowDensFull, 0.045, gapY, h * 0.15);
    if (!roughRows)
        return null;
    const colDensRough = [];
    for (let x = 0; x < w; x++) {
        let count = 0;
        for (let y = roughRows[0]; y < roughRows[1]; y++)
            count += tex[y * w + x] ?? 0;
        colDensRough.push(count / Math.max(1, roughRows[1] - roughRows[0]));
    }
    const roughCols = spanFromDensity(colDensRough, 0.045, gapX, w * 0.15);
    if (!roughCols)
        return null;
    // Refine: density relative to the candidate card's own width/height.
    const rowDensRel = [];
    for (let y = 0; y < h; y++) {
        let count = 0;
        for (let x = roughCols[0]; x < roughCols[1]; x++)
            count += tex[y * w + x] ?? 0;
        rowDensRel.push(count / Math.max(1, roughCols[1] - roughCols[0]));
    }
    const refinedRowsRaw = spanFromDensity(rowDensRel, 0.22, gapY, h * MIN_SPAN_FRAC);
    // A refined span may TRIM the rough span (cut tray/background
    // overshoot) but never AMPUTATE it: a card with a smooth, painterly
    // art window (Treasure Keeper) has long row stretches under the
    // 0.22 relative bar, so the refined run collapses onto the dense
    // bottom slab (text box + info line) and the resulting "rect" is a
    // landscape strip that the aspect gate then rejects — detection
    // returned null for a card filling most of the frame (Pass 9
    // measurement: rough rows were exact, refined kept only 41%). When
    // a refined span keeps less than ~55% of its rough span, the rough
    // span — which the whole card sustained at the low absolute bar —
    // is the honest extent on that axis.
    const pickSpan = (refined, rough) => {
        if (!refined)
            return rough;
        const refLen = refined[1] - refined[0];
        const roughLen = rough[1] - rough[0];
        return roughLen > 0 && refLen < roughLen * 0.55 ? rough : refined;
    };
    // Pass 28: trim a detached recess-seam band off either span edge
    // before the spans are judged (see trimSeamBand) — the seam can be
    // merged into the rough span OR survive into the refined one.
    const refinedRows = trimSeamBand(rowDensRel, pickSpan(refinedRowsRaw, roughRows));
    const colDensRel = [];
    for (let x = 0; x < w; x++) {
        let count = 0;
        for (let y = refinedRows[0]; y < refinedRows[1]; y++)
            count += tex[y * w + x] ?? 0;
        colDensRel.push(count / Math.max(1, refinedRows[1] - refinedRows[0]));
    }
    const refinedCols = trimSeamBand(colDensRel, pickSpan(spanFromDensity(colDensRel, 0.22, gapX, w * MIN_SPAN_FRAC), roughCols));
    let [ry0, ry1] = refinedRows;
    let [rx0, rx1] = refinedCols;
    // A card is portrait ~1.4:1; allow generous perspective/slack, reject
    // strips and landscape slabs (tray ridges, table edges). If the
    // refined choice still fails acceptance, give the pure rough spans
    // one chance before declaring no card — the rough pass sustained
    // the full card at the low bar, and correctCardAspect downstream
    // normalises small overshoot anyway.
    const plausible = (rows, cols) => {
        const rw = cols[1] - cols[0];
        const rh = rows[1] - rows[0];
        if (rw <= 0 || rh <= 0)
            return false;
        const a = rh / rw;
        return a >= 0.85 && a <= 2.1 && rw * rh >= w * h * 0.05;
    };
    if (!plausible(refinedRows, refinedCols)) {
        if (!plausible(roughRows, roughCols))
            return null;
        [ry0, ry1] = trimSeamBand(rowDensFull, roughRows);
        [rx0, rx1] = trimSeamBand(colDensRough, roughCols);
    }
    // 4. Contrast cross-check: background = median luminance OUTSIDE the rect
    // (when there is enough outside to sample); fill = interior fraction that
    // differs from it. Texture density inside is the second signal — it saves
    // same-luminance cases (white card on a white tray).
    let insideTex = 0;
    let insideCount = 0;
    const outsideLuma = [];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const inside = x >= rx0 && x < rx1 && y >= ry0 && y < ry1;
            if (inside) {
                insideTex += tex[y * w + x] ?? 0;
                insideCount += 1;
            }
            else if ((x * 7 + y * 13) % 11 === 0) {
                outsideLuma.push(at(x, y));
            }
        }
    }
    const texDensity = insideCount > 0 ? insideTex / insideCount : 0;
    let fill = 0;
    if (outsideLuma.length >= 30) {
        const bg = median(outsideLuma);
        let differ = 0;
        for (let y = ry0; y < ry1; y++) {
            for (let x = rx0; x < rx1; x++) {
                if (Math.abs(at(x, y) - bg) > 24)
                    differ += 1;
            }
        }
        fill = insideCount > 0 ? differ / insideCount : 0;
    }
    const confidence = Math.min(1, fill * 0.55 + Math.min(1, texDensity / 0.3) * 0.45);
    if (confidence < 0.32)
        return null;
    return {
        rect: { x0: rx0 / w, y0: ry0 / h, x1: rx1 / w, y1: ry1 / h },
        confidence,
        fill,
        shoulders: edgeShouldersFromProfiles(rowDensRel, colDensRel, rx0, ry0, rx1, ry1, w, h),
    };
}
/**
 * Pass 34 — measure the texture shoulder just outside each edge of a
 * detected span, from the detector's own density profiles: the mean
 * density in a window ~12% of the frame beyond the edge, normalised by
 * the span's interior median density. An edge the detector placed
 * correctly has a VOID beyond it (tray, table — shoulder ~0); an edge
 * LOST to shadow has the card's faded continuation beyond it
 * (shoulder well above 0). An edge flush with the frame border has
 * no outside to measure and reports 1 (the card runs out of frame —
 * completion toward it is frame-clamped anyway).
 */
export function edgeShouldersFromProfiles(rowDens, colDens, x0, y0, x1, y1, gw, gh) {
    const interiorRows = [];
    for (let y = y0; y < y1; y++)
        interiorRows.push(rowDens[y] ?? 0);
    const rowMed = median(interiorRows);
    const interiorCols = [];
    for (let x = x0; x < x1; x++)
        interiorCols.push(colDens[x] ?? 0);
    const colMed = median(interiorCols);
    const mean = (arr, a, b) => {
        if (b <= a)
            return Number.NaN;
        let s = 0;
        for (let i = a; i < b; i++)
            s += arr[i] ?? 0;
        return s / (b - a);
    };
    const rel = (v, med) => {
        if (Number.isNaN(v))
            return 1;
        if (med <= 0.001)
            return 0;
        return Math.max(0, Math.min(1.5, v / med));
    };
    const winR = Math.max(2, Math.round(gh * 0.12));
    const winC = Math.max(2, Math.round(gw * 0.12));
    return {
        top: rel(mean(rowDens, Math.max(0, y0 - winR), y0), rowMed),
        bottom: rel(mean(rowDens, y1, Math.min(gh, y1 + winR)), rowMed),
        left: rel(mean(colDens, Math.max(0, x0 - winC), x0), colMed),
        right: rel(mean(colDens, x1, Math.min(gw, x1 + winC)), colMed),
    };
}
/** Canvas wrapper: downscale to ~480px, extract luminance, detect. */
export function detectInCanvas(source) {
    const scale = Math.min(1, 480 / Math.max(1, Math.max(source.width, source.height)));
    const w = Math.max(40, Math.round(source.width * scale));
    const h = Math.max(40, Math.round(source.height * scale));
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext("2d");
    if (!ctx)
        return null;
    ctx.drawImage(source, 0, 0, w, h);
    let data;
    try {
        data = ctx.getImageData(0, 0, w, h).data;
    }
    catch {
        return null;
    }
    const luma = new Float32Array(w * h);
    for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        luma[j] = 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
    }
    return detectCardRect(luma, w, h);
}
/** Crop a canvas to a fractional rect. */
export function cropToRect(source, r) {
    const sx = Math.round(r.x0 * source.width);
    const sy = Math.round(r.y0 * source.height);
    const sw = Math.max(20, Math.round((r.x1 - r.x0) * source.width));
    const sh = Math.max(20, Math.round((r.y1 - r.y0) * source.height));
    const out = document.createElement("canvas");
    out.width = sw;
    out.height = sh;
    const ctx = out.getContext("2d");
    if (ctx)
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
    return out;
}
/** Mean luminance of a canvas (sampled on a downscale). 0..255. */
export function meanLuminance(source) {
    const w = 48;
    const h = 48;
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext("2d");
    if (!ctx)
        return 128;
    ctx.drawImage(source, 0, 0, w, h);
    try {
        const data = ctx.getImageData(0, 0, w, h).data;
        let sum = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
            sum += 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0);
            n += 1;
        }
        return n > 0 ? sum / n : 128;
    }
    catch {
        return 128;
    }
}
/** A physical MTG card's aspect: 63×88mm → height / width ≈ 1.397. */
export const CARD_ASPECT = 88 / 63;
/**
 * Correct a detected rect to the true card aspect. Texture-slab
 * detection systematically UNDER-measures the height: the title band and
 * the bottom info strip are comparatively smooth, so the slab starts
 * below the title and ends above the bottom line — the user's
 * hand-held Witherbloom shot drew "CARD FOUND" with the title ABOVE the
 * outline and the outline's bottom cutting through the rules text, and
 * every band cropped from that rect read art instead of text.
 *
 * - Too short for its width → grow the height, ~70% of the growth to
 *   the TOP (titles get cut; bottoms rarely do) and 30% to the bottom
 *   — UNLESS the detection's shoulders (Pass 34) show one edge was
 *   lost and the other is exact, in which case all the growth goes
 *   to the lost edge (see completeCardAspect).
 * - Too tall for its width → grow the width symmetrically (same
 *   shoulder anchoring on the sides).
 * The rect is then SHIFTED back into the frame rather than shrunk
 * wherever possible; only a frame smaller than the corrected card
 * forces a clamp. A rect already within 2% of card aspect is returned
 * untouched, so good detections don't drift.
 *
 * COORDINATE WARNING: rect fractions are normalised per axis, so
 * fraction-space "aspect" equals pixel aspect only for square frames.
 * All math here runs in square-pixel space (x scaled by `frameAspect` =
 * frameWidthPx / frameHeightPx) — Pass 6's harness proved the naive
 * fraction-space version massively over-grows height on a portrait
 * phone frame.
 */
/** Pass 34: a shoulder at or above this (relative to the span's own
 * interior density) reads as "textured card material continues past
 * this edge" — the edge was lost, not found. At or below WEAK the
 * edge is confident: void beyond it. Between the two, the evidence
 * is ambiguous and the historical split applies. Thresholds sit in
 * the gaps measured by probe-p34-edges on the dim box fixtures:
 * lost top edges 0.23–0.62, correctly-placed tops 0.00–0.02, and the
 * confident opposite (bottom) edge 0.00–0.01 in every scene. The
 * anchor additionally requires the opposite edge to be weak, so a
 * textured surface beyond BOTH edges (a busy playmat) never fires
 * it — the historical split stays in charge there. */
export const SHOULDER_STRONG = 0.14;
export const SHOULDER_WEAK = 0.08;
/**
 * Correct a detected rect to the true card aspect, ANCHORING the
 * growth on confident edges when the detection's shoulders say which
 * edge was lost (Pass 34). Without shoulders — or with ambiguous
 * shoulders — the allocation is the historical one: a height deficit
 * grows ~70% up / 30% down (titles get cut; bottoms rarely do), a
 * width deficit grows symmetrically. With a strong shoulder on one
 * side of an axis and a weak one on the other, the WHOLE deficit
 * goes to the strong side: the weak edge was measured exactly and
 * must not move. (The Pass 34 fixtures convicted the split: with the
 * top lost to shadow and the bottom exact, 70/30 still left the top
 * +0.03…+0.06 of frame short — title at the crop's edge or outside
 * it — while pushing the exact bottom +0.06…+0.09 into the tray.)
 */
export function completeCardAspect(r, frameAspect, shoulders) {
    const fa = frameAspect > 0 && Number.isFinite(frameAspect) ? frameAspect : 1;
    let x0 = r.x0 * fa;
    let x1 = r.x1 * fa;
    let { y0, y1 } = r;
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0)
        return { rect: r, note: null };
    const targetH = w * CARD_ASPECT;
    let note = null;
    if (h < targetH * 0.98) {
        const grow = targetH - h;
        let topShare = 0.7;
        if (shoulders) {
            if (shoulders.top >= SHOULDER_STRONG && shoulders.bottom <= SHOULDER_WEAK)
                topShare = 1;
            else if (shoulders.bottom >= SHOULDER_STRONG && shoulders.top <= SHOULDER_WEAK)
                topShare = 0;
        }
        const up = grow * topShare;
        const down = grow * (1 - topShare);
        y0 -= up;
        y1 += down;
        if (y0 < 0) {
            y1 -= y0;
            y0 = 0;
        }
        if (y1 > 1) {
            y0 -= y1 - 1;
            y1 = 1;
        }
        if (y0 < 0)
            y0 = 0;
        if (topShare === 1 && up >= 0.02)
            note = `top extended ~${Math.round(up * 100)}%`;
        else if (topShare === 0 && down >= 0.02)
            note = `bottom extended ~${Math.round(down * 100)}%`;
    }
    else if (h > targetH * 1.02) {
        const grow = h / CARD_ASPECT - w;
        let leftShare = 0.5;
        if (shoulders) {
            if (shoulders.left >= SHOULDER_STRONG && shoulders.right <= SHOULDER_WEAK)
                leftShare = 1;
            else if (shoulders.right >= SHOULDER_STRONG && shoulders.left <= SHOULDER_WEAK)
                leftShare = 0;
        }
        const gl = grow * leftShare;
        const gr = grow * (1 - leftShare);
        x0 -= gl;
        x1 += gr;
        if (x0 < 0) {
            x1 -= x0;
            x0 = 0;
        }
        if (x1 > fa) {
            x0 -= x1 - fa;
            x1 = fa;
        }
        if (x0 < 0)
            x0 = 0;
        if (leftShare === 1 && gl / fa >= 0.02)
            note = `left extended ~${Math.round((gl / fa) * 100)}%`;
        else if (leftShare === 0 && gr / fa >= 0.02)
            note = `right extended ~${Math.round((gr / fa) * 100)}%`;
    }
    else {
        return { rect: r, note: null };
    }
    return { rect: { x0: x0 / fa, y0, x1: x1 / fa, y1 }, note };
}
export function correctCardAspect(r, frameAspect, shoulders) {
    return completeCardAspect(r, frameAspect, shoulders).rect;
}
/**
 * Does a fresh detection AGREE with the stored box calibration? The
 * calibration is trusted only while the card actually sits where it
 * was calibrated: the title band is ~8% of card height, so a top-edge
 * disagreement beyond ~4% of frame height already pushes the band off
 * the title. Edge tolerance is looser (6%) because the left/right/
 * bottom edges hurt less, and the height agreement is relative (6% of
 * the calibrated height) for the same reason. Measured against the
 * regression harness's box set: a card seated exactly at calibration
 * agrees (deltas ~0); +4% of frame height low already disagrees on the
 * top edge.
 */
export function checkCalibration(calibration, detected) {
    const topDelta = Math.abs(detected.y0 - calibration.y0);
    const maxEdgeDelta = Math.max(Math.abs(detected.x0 - calibration.x0), Math.abs(detected.x1 - calibration.x1), Math.abs(detected.y1 - calibration.y1));
    const calH = Math.max(0.01, calibration.y1 - calibration.y0);
    const heightDelta = Math.abs((detected.y1 - detected.y0) - calH) / calH;
    return topDelta <= 0.04 && maxEdgeDelta <= 0.06 && heightDelta <= 0.06;
}
/**
 * PASS 29 — is this frame's detection a COMPLETE presentation at
 * the rig's seat, or a card caught mid-slide? The Rapid sequence
 * simulation (tests/harness/rapidsequence.ts) showed the stability
 * gate firing on a card HELD halfway through its slide (the slide
 * pauses while the user reaches for the next card): stillness is
 * not completeness, and the attempt burned on the outgoing card.
 * A complete presentation's detected rect sits at the seat: centre
 * displacement within 10% of frame height on both axes (his
 * per-card seating variance is 3–6%, and a card seated measurably
 * low — the calibrationStale case — still lands inside this) and
 * height within 0.86–1.16 of the seat's (a merged two-card slab or
 * a clipped partial breaks it). A slide held at even ~15% of its
 * travel displaces the centre by ~0.11+ and the 45% holds in the
 * simulation by 0.34 — clear water on both sides of the bar.
 */
export function presentationComplete(detected, seat) {
    const dcx = (detected.x0 + detected.x1) / 2;
    const dcy = (detected.y0 + detected.y1) / 2;
    const scx = (seat.x0 + seat.x1) / 2;
    const scy = (seat.y0 + seat.y1) / 2;
    const seatH = Math.max(0.01, seat.y1 - seat.y0);
    const heightRatio = (detected.y1 - detected.y0) / seatH;
    return (Math.abs(dcy - scy) <= 0.1 &&
        Math.abs(dcx - scx) <= 0.1 &&
        heightRatio >= 0.86 &&
        heightRatio <= 1.16);
}
/**
 * RECT STABILISATION (Pass 18). Measured on a synthetic static in-box
 * scene (identical frame + sensor-level noise only): raw detections of
 * an UNMOVED card jitter by up to 0.077 of frame height on the top
 * edge (sd 0.034) — the vertical slab edges are the noise-sensitive
 * axis — and single jittered detections cross checkCalibration's
 * tolerances on roughly half of samples, so the read rect FLIPPED
 * between the stored calibration and a jittered detection from attempt
 * to attempt, dragging the title band and bottom strip with it (the
 * user's three Way of the Mind Sculptor attempts read three different
 * rects, tops 0.07/0.11/0.14, off one unmoved card). The median of the
 * last few rects is the stabiliser: per-edge median is robust to the
 * one-sided slab-edge outliers, and the spread gate keeps it honest —
 * when recent rects DISAGREE (the card actually moved mid-sequence),
 * the spread exceeds the gate and the single current detection stands,
 * so a genuinely displaced card is still read where it is (Pass 16).
 */
export function medianRect(rects) {
    const med = (vals) => {
        const s = [...vals].sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        if (s.length === 0)
            return 0;
        return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
    };
    return {
        x0: med(rects.map((r) => r.x0)),
        y0: med(rects.map((r) => r.y0)),
        x1: med(rects.map((r) => r.x1)),
        y1: med(rects.map((r) => r.y1)),
    };
}
/** Largest per-edge distance of any rect in the set from `centre`. */
export function rectSpread(rects, centre) {
    let max = 0;
    for (const r of rects) {
        max = Math.max(max, Math.abs(r.x0 - centre.x0), Math.abs(r.y0 - centre.y0), Math.abs(r.x1 - centre.x1), Math.abs(r.y1 - centre.y1));
    }
    return max;
}
/** Spread at or below which a set of recent rects counts as ONE static
 * scene (one physical card position) rather than a card in motion.
 * Measured static-scene jitter sits well inside it (per-edge sd
 * ~0.03 on the worst axis, median-of-5 pulls the working spread to
 * ~0.01-0.02); a real displacement is several times larger. */
export const RECT_STABLE_SPREAD = 0.03;
/** Detections kept in a lock's median window. */
export const TRACK_SAMPLE_COUNT = 5;
/** A tracked rect older than this is not offered to an attempt — the
 * same 10s reasoning as LAST_DETECTION_RESCUE_MS (covers a full
 * attempt cycle, during which the preview feed is suspended). */
export const TRACK_FRESH_MS = 10_000;
/** Any-edge distance beyond which a detection is a different seat,
 * not jitter. His per-card seating variance is 3–6% of frame, so a
 * genuinely new seat crosses this on its leading edges; a single
 * jitter sample can also reach it (the rig's worst-axis range is
 * ~0.077), which is why crossing it only ARMS a re-lock — the
 * confirming second sample is what moves the lock. */
export const TRACK_RELOCK_EDGE = 0.07;
/** Agreement tight enough that the tracked median is read instead
 * of this frame's own detection: the two are demonstrably the same
 * position, so the median (the lower-variance estimate) wins. A
 * larger gap means the lock is still swinging toward a moved card
 * — the current detection, an unbiased sample of the CURRENT seat,
 * is the better read for this frame. */
export const TRACK_AGREE_EDGE = 0.03;
/** Largest per-edge absolute distance between two rects. */
export function maxEdgeDelta(a, b) {
    return Math.max(Math.abs(a.x0 - b.x0), Math.abs(a.y0 - b.y0), Math.abs(a.x1 - b.x1), Math.abs(a.y1 - b.y1));
}
/** The tracker's initial state: the stored manual calibration as a
 * seed — the position reads use until the first live detection
 * confirms or replaces it. */
export function seedTrackedRect(calibration, now) {
    return { rect: calibration, samples: [], at: now, seeded: true, pendingFar: null };
}
/**
 * Fold one live detection into the tracker. Pure — the App and the
 * regression harness drive the same function. Detections passed here
 * are already aspect-corrected + expanded (prep.detectedRect), i.e.
 * the same normalisation read rects get.
 *
 * PASS 30 GATE: a detection that is implausible as the card at the
 * seat (see rectPlausibleVsSeat — in darkness the detector returns
 * the lit text box alone, a quadrant with the seat's confidence)
 * is NOT evidence: it is not folded, it does not arm a re-lock, it
 * does not refresh the lock's freshness, and it can never replace
 * the calibration seed. Before this gate the seed branch below
 * replaced the stored calibration with the quadrant on the FIRST
 * dark preview tick, and the re-lock branch adopted it two ticks
 * later — the tracker then served the quadrant to every read.
 * The reference is the caller's seat when the lock still plausibly
 * matches it, else the lock itself (a legitimately displaced lock
 * judges new detections against its own position).
 */
export function observeTrackedRect(state, detection, now, seat) {
    if (!state) {
        return { rect: detection, samples: [detection], at: now, seeded: false, pendingFar: null };
    }
    const reference = effectiveSeatRef(seat ?? null, state.rect);
    if (reference && !rectPlausibleVsSeat(detection, reference)) {
        return state;
    }
    if (state.seeded) {
        // The seed is a guess with no observations behind it: a first
        // detection that agrees confirms the seed into the median; one
        // that disagrees replaces it outright (no confirmation needed).
        if (checkCalibration(state.rect, detection)) {
            const samples = [state.rect, detection];
            return { rect: medianRect(samples), samples, at: now, seeded: false, pendingFar: null };
        }
        return { rect: detection, samples: [detection], at: now, seeded: false, pendingFar: null };
    }
    if (maxEdgeDelta(state.rect, detection) > TRACK_RELOCK_EDGE) {
        // A NEW PRESENTATION candidate. One far sample may be a glitch
        // (a foil flash latching the detector onto the tray edge); two
        // far samples that agree with EACH OTHER are a card that
        // actually moved — re-lock onto their median.
        if (state.pendingFar && checkCalibration(state.pendingFar, detection)) {
            const samples = [state.pendingFar, detection];
            return { rect: medianRect(samples), samples, at: now, seeded: false, pendingFar: null };
        }
        return { ...state, at: now, pendingFar: detection };
    }
    const samples = [...state.samples, detection].slice(-TRACK_SAMPLE_COUNT);
    return { rect: medianRect(samples), samples, at: now, seeded: false, pendingFar: null };
}
/** The rect an attempt may read from the tracker: the lock itself,
 * only while it is fresh. A stale lock is no knowledge at all — the
 * caller falls back to the calibration seed / live detection. */
export function freshTrackedRect(state, now) {
    if (!state)
        return null;
    return now - state.at <= TRACK_FRESH_MS ? state.rect : null;
}
/**
 * SEAT PLAUSIBILITY (Pass 30) — is `candidate` plausible as the SAME
 * physical card the rig's seat describes? Andrew's first real-dark
 * session (2026-11-10 18:32) convicted the absence of this check:
 * in darkness the detector found only the lit text box — a quadrant
 * at (0.39,0.40)-(0.81,0.81), area 0.42× the seat's, covering 40% of
 * the card — and every consumer believed it: the tracker adopted it
 * as the card's position, the live outline presented it as
 * "TRACKING CARD (AUTO)" with a "fine at this distance" hint, and
 * when the Snap frame's own detection missed, the attempt read the
 * quadrant as a tracked-fallback. The title was never inside the
 * read area; the attempt never had a chance.
 *
 * A card at the seat — even seated low (the calibrationStale class,
 * 8–12% of frame height down) or with per-card variance — keeps
 * most of the seat's AREA and covers most OF the seat. A lit
 * sub-region fails both by a wide margin (measured on the Pass 30
 * dark fixtures: quadrant area ratio 0.42, seat coverage 0.39;
 * legitimate displaced seats: ratio 0.86–1.15, coverage ≥ 0.82).
 * The bars sit in the empty middle. Aspect is deliberately NOT
 * tested here: read rects are aspect-corrected before this point,
 * so the discriminating evidence is size + overlap.
 */
export const SEAT_MIN_AREA_RATIO = 0.6;
export const SEAT_MAX_AREA_RATIO = 1.6;
export const SEAT_MIN_COVER = 0.55;
export function rectPlausibleVsSeat(candidate, seat) {
    const ca = (candidate.x1 - candidate.x0) * (candidate.y1 - candidate.y0);
    const sa = (seat.x1 - seat.x0) * (seat.y1 - seat.y0);
    if (!(ca > 0) || !(sa > 0))
        return false;
    const ratio = ca / sa;
    if (ratio < SEAT_MIN_AREA_RATIO || ratio > SEAT_MAX_AREA_RATIO)
        return false;
    const ix = Math.max(0, Math.min(candidate.x1, seat.x1) - Math.max(candidate.x0, seat.x0));
    const iy = Math.max(0, Math.min(candidate.y1, seat.y1) - Math.max(candidate.y0, seat.y0));
    return (ix * iy) / sa >= SEAT_MIN_COVER;
}
/**
 * The reference rect a candidate is judged against: the stored
 * calibration, UNLESS the tracker has legitimately re-locked away
 * from it (a card consistently seated somewhere else — the Pass 16
 * displaced case the tracker exists for), in which case the lock
 * itself is the seat. A lock that still plausibly matches the
 * calibration never outranks it: the calibration is the known-good
 * geometry the user recorded.
 */
export function effectiveSeatRef(calibration, tracked) {
    if (calibration && tracked && !rectPlausibleVsSeat(tracked, calibration))
        return tracked;
    return calibration ?? tracked;
}
/**
 * Locate the card in a captured frame and crop to IT — THE rect-selection
 * step every capture path (live Snap, Rapid, Take Photo, upload) shares.
 * Order of trust in box mode: the continuously-tracked rect (Pass 24a,
 * verified against each frame's detection) → this frame's detection →
 * the stored box calibration as seed/fallback → live detection → the
 * frame itself (labelled "guide" — the old behaviour, kept as an honest
 * fallback). Photo files pass ignoreCalibration: a hand-held photo is
 * not in the rig, so the rig's rect must never crop it.
 *
 * This lives in detect.ts (not in the App component) so the pixel-level
 * regression harness in tests/harness/ runs the app's REAL rect
 * selection — byte for byte the code the phone runs — instead of a
 * copy that can silently drift from it.
 */
export function prepareCardFromFrame(frame, opts) {
    if (opts.boxMode && !opts.ignoreCalibration && (opts.calibration || opts.trackedRect)) {
        // The calibration is a PRIOR, not gospel: verify it against this
        // frame's detection. When the card demonstrably sits somewhere
        // else (seated low in the tray, rig bumped), read it where it IS
        // and flag the calibration stale — reading the calibrated bands
        // off a displaced card reads desk/tray texture and cannot work,
        // which was the recurring box failure. When detection agrees (or
        // finds nothing to disagree with), the calibration is used exactly
        // as before: pixel-for-pixel the rig's known-good rect.
        const rect = opts.calibration;
        const tracked = opts.trackedRect ?? null;
        const t0 = performance.now();
        const det = detectInCanvas(frame);
        const detectMs = performance.now() - t0;
        // PASS 34: aspect completion is shoulder-anchored — a detection
        // whose top edge was lost to shadow is completed UP from its
        // exact bottom/side edges before anything reads or tracks it,
        // and the completion note rides along for the diagnostics.
        const completed = det && det.confidence >= 0.4
            ? completeCardAspect(det.rect, frame.width / Math.max(1, frame.height), det.shoulders)
            : null;
        const rawDetected = completed ? expandRect(completed.rect, 0.015) : null;
        const completionNote = completed?.note ?? undefined;
        // PASS 30 — a detection that cannot be the card at the seat is
        // not a detection of the card: in darkness the detector returns
        // the lit text box alone (a quadrant at full confidence), and
        // reading it — or folding it into the tracker via detectedRect —
        // dooms the attempt before it starts. Judged against the
        // effective seat (the calibration, or a lock that legitimately
        // re-locked away from it), an implausible detection is treated
        // exactly like a miss: the fallback chain below decides.
        const seatRef = effectiveSeatRef(rect, tracked);
        const detected = rawDetected && seatRef && !rectPlausibleVsSeat(rawDetected, seatRef) ? null : rawDetected;
        if (detected && tracked) {
            // CONTINUOUS TRACKING (Pass 24a): the tracked rect is the
            // median of the recent detections of THIS card — a far better
            // position estimate than either the static calibration or this
            // one jittered sample, WHEN it demonstrably matches this
            // frame's own measurement (TRACK_AGREE_EDGE): read the tracked
            // rect. A larger gap means the card moved (a new card slid
            // in) or the lock is still swinging toward it: read THIS
            // frame's detection, the card's position now; the caller folds
            // that same detection into the tracker, which re-locks onto
            // the new presentation. No calibrationStale either way —
            // displacement is the tracker's normal case now, not a user
            // maintenance failure.
            if (maxEdgeDelta(tracked, detected) <= TRACK_AGREE_EDGE) {
                return { card: cropToRect(frame, tracked), frame, source: "detected", rect: tracked, rectOrigin: "tracked", detectMs, detectedRect: detected, completion: completionNote };
            }
            return { card: cropToRect(frame, detected), frame, source: "detected", rect: detected, rectOrigin: "frame", detectMs, detectedRect: detected, completion: completionNote };
        }
        if (detected && rect) {
            // Pass 18 stabilisation: judge the MEDIAN of the recent rects +
            // this detection, not this one jittered sample. If the median
            // agrees with the calibration, the calibration wins (the static
            // scene reads the rig's known-good rect every time instead of
            // flipping per attempt). If the recent rects form a tight
            // cluster somewhere else, the card consistently sits THERE —
            // read the cluster's median where it is. If they disagree
            // (spread beyond the gate — the scene is changing), fall
            // through to the single-detection rule below, unchanged.
            const recent = (opts.recentRects ?? []).slice(-4);
            if (recent.length > 0) {
                const candidates = [...recent, detected];
                const median = medianRect(candidates);
                // Calibration branch: the MEDIAN agrees with the calibration
                // AND a strict majority of candidates agree individually.
                // The median alone is not enough — a bimodal history (a card
                // alternating between two seats) averages into a phantom
                // median that can sit inside the calibration tolerance while
                // the card currently sits elsewhere; a majority of the
                // recent rects must actually vouch for the calibration. A
                // genuinely static scene passes easily: its read rects
                // (calibration copies included) mostly agree, and the
                // one-sided slab-edge outliers stay a minority.
                const agreeCount = candidates.filter((c) => checkCalibration(rect, c)).length;
                if (checkCalibration(rect, median) && agreeCount * 2 > candidates.length) {
                    return { card: cropToRect(frame, rect), frame, source: "calibration", rect, rectOrigin: "calibration", detectMs, detectedRect: detected };
                }
                // Displaced branch: a TIGHT cluster (spread gate) somewhere
                // else entirely — the card consistently sits there; read the
                // cluster's median where it is.
                if (candidates.length >= 3 && rectSpread(candidates, median) <= RECT_STABLE_SPREAD) {
                    return { card: cropToRect(frame, median), frame, source: "detected", rect: median, rectOrigin: "frame", detectMs, calibrationStale: true, detectedRect: detected, completion: completionNote };
                }
            }
            if (!checkCalibration(rect, detected)) {
                return { card: cropToRect(frame, detected), frame, source: "detected", rect: detected, rectOrigin: "frame", detectMs, calibrationStale: true, detectedRect: detected, completion: completionNote };
            }
            return { card: cropToRect(frame, rect), frame, source: "calibration", rect, rectOrigin: "calibration", detectMs, detectedRect: detected };
        }
        if (detected) {
            // Box mode with a tracker history but no stored calibration
            // and no fresh tracked rect: this frame's own detection.
            return { card: cropToRect(frame, detected), frame, source: "detected", rect: detected, rectOrigin: "frame", detectMs, detectedRect: detected, completion: completionNote };
        }
        if (tracked && (!rect || rectPlausibleVsSeat(tracked, rect))) {
            // Detection missed this frame entirely (a foil flash, a soft
            // frame): the last tracked position is fresher knowledge than
            // the stored seed — read where the card was just tracked to be
            // instead of wherever the static calibration points.
            // PASS 30: only while the tracked rect is itself plausible as
            // the card at the calibrated seat — a lock that shrunk to a
            // lit sub-region (the pre-gate failure, or state carried from
            // before the gate) must never be read; the chain falls
            // through to the calibration seat instead.
            return { card: cropToRect(frame, tracked), frame, source: "detected", rect: tracked, rectOrigin: "tracked-fallback", detectMs, detectedRect: null };
        }
        if (rect) {
            return { card: cropToRect(frame, rect), frame, source: "calibration", rect, rectOrigin: "calibration", detectMs, detectedRect: null };
        }
        // Box mode with neither a calibration nor a tracked rect: fall
        // through to the generic detection path below.
    }
    const t0 = performance.now();
    const det = detectInCanvas(frame);
    const detectMs = performance.now() - t0;
    if (det && det.confidence >= 0.4) {
        // Correct to the true 5:7 card aspect BEFORE cropping: raw
        // texture-slab detection under-measures the height (title band
        // and bottom strip are smooth), which drew the outline shifted
        // down over the card and cropped the title clean off — the
        // hand-held Snap timeout failure. The corrected rect is also
        // what the overlay draws and what every band derives from.
        const completion = completeCardAspect(det.rect, frame.width / Math.max(1, frame.height), det.shoulders);
        const rect = expandRect(completion.rect, 0.015);
        return { card: cropToRect(frame, rect), frame, source: "detected", rect, rectOrigin: "frame", detectMs, detectedRect: rect, completion: completion.note ?? undefined };
    }
    return { card: frame, frame, source: "guide", rect: null, rectOrigin: "guide", detectMs, detectedRect: null };
}
/** Expand a rect by frac of its own size on each side, clamped to the frame. */
export function expandRect(r, frac) {
    const dw = (r.x1 - r.x0) * frac;
    const dh = (r.y1 - r.y0) * frac;
    return {
        x0: Math.max(0, r.x0 - dw),
        y0: Math.max(0, r.y0 - dh),
        x1: Math.min(1, r.x1 + dw),
        y1: Math.min(1, r.y1 + dh),
    };
}
/** How long the scanner's most recent successful detection may rescue
 * a burst whose own frames all failed to detect. A single scan attempt
 * runs ~4s on-device and the preview interval is suspended while it
 * runs, so the window must cover a full attempt cycle plus the user's
 * reaction time — the Pass 15 retained FRAME (2.5s) expires inside
 * exactly that gap, which is how an in-box Swamp attempt came to read
 * the guide area while the viewfinder still showed a perfect outline:
 * the retained frame was gone and nothing else carried the detection
 * into the attempt. The rescue only ever fires when the burst itself
 * produced NO detection at all — the alternative in that case is
 * reading the guide area, which is strictly worse — and an empty scene
 * still settles as no-card, because bands re-cropped from an empty
 * tray area read no text. */
export const LAST_DETECTION_RESCUE_MS = 10_000;
/**
 * RECT AUTHORITY (Pass 16): an attempt must never read the guide rect
 * when a fresh successful detection exists. Given a burst of prepared
 * frames, any frame that fell back to the guide is re-cropped from its
 * OWN pixels using, in order of authority:
 *   1. a sibling burst frame's rect (per-attempt evidence — freshest);
 *   2. the scanner's most recent successful detection, when it is no
 *      older than LAST_DETECTION_RESCUE_MS.
 * Frames that already carry a rect are returned untouched, and when no
 * authority exists the burst is returned unchanged — the genuine
 * no-detection case keeps the honest guide fallback. Pure: the App
 * calls this at capture time and the regression harness calls the same
 * function, so the tested code is the shipped code.
 */
export function applyRectAuthority(preps, lastDetection, now) {
    if (!preps.some((p) => !p.rect))
        return preps;
    const sibling = preps.find((p) => p.rect)?.rect ?? null;
    const lastFresh = !sibling && lastDetection && now - lastDetection.at <= LAST_DETECTION_RESCUE_MS
        ? lastDetection.rect
        : null;
    const authority = sibling ?? lastFresh;
    if (!authority)
        return preps;
    const origin = sibling ? "burst-sibling" : "last-detection";
    return preps.map((p) => {
        if (p.rect)
            return p;
        return {
            ...p,
            card: cropToRect(p.frame, authority),
            source: "detected",
            rect: authority,
            rectOrigin: origin,
        };
    });
}
/**
 * PASS 33 — CLIP FINDING for the diagnostics line. Box-mode
 * fallback rects (tracked / calibration) are the one rect class
 * NOT passed through correctCardAspect at crop time (every live
 * detection is), so a lock that drifted SHORTER than a card's
 * shape for its width is read exactly as it sits — and the crop
 * silently clips the card's top/bottom (Andrew's P1 panel,
 * 2026-11-10 ~20:15: the "What the scanner read" image showed
 * only the top two-thirds of Retrieve the Esper, text box gone,
 * from a tracked-fallback rect on a frame whose own detection
 * missed; nothing on the panel said the image was a partial
 * crop). This computes what the aspect correction WOULD have
 * covered beyond the used rect and states it as a finding when
 * the missing coverage is material (>3% of frame height on
 * either edge). Returns "" when the rect is card-shaped within
 * tolerance (the normal case, corrected rects included).
 */
export function rectClipFinding(p) {
    if (!p || !p.rect || !p.frame || p.frame.height <= 0)
        return "";
    const fa = p.frame.width / Math.max(1, p.frame.height);
    const corrected = correctCardAspect(p.rect, fa);
    const missTop = p.rect.y0 - corrected.y0;
    const missBottom = corrected.y1 - p.rect.y1;
    const miss = Math.max(missTop, missBottom);
    if (miss <= 0.03)
        return "";
    const side = missBottom >= missTop ? "bottom" : "top";
    return `read area is shorter than a card's shape for its width — the crop may clip the card's ${side} (aspect-corrected ${side} edge would sit at ${(side === "bottom" ? corrected.y1 : corrected.y0).toFixed(2)})`;
}
/** One-line description of the rect an attempt read from, for the
 * diagnostics block — the next failure screenshot must localise itself
 * ("rect: detected (0.02,0.06)-(0.78,0.83) · frame: retained" /
 * "rect: guide fallback · no detection available to this attempt"). */
export function describePrepRect(p) {
    if (!p)
        return "guide fallback · no frame was captured";
    if (!p.rect)
        return "guide fallback · no detection available to this attempt";
    const r = `(${p.rect.x0.toFixed(2)},${p.rect.y0.toFixed(2)})-(${p.rect.x1.toFixed(2)},${p.rect.y1.toFixed(2)})`;
    const clip = rectClipFinding(p);
    const done = p.completion ? ` · rect completed (${p.completion})` : "";
    const tail = `${done}${clip ? ` · ${clip}` : ""}`;
    switch (p.rectOrigin) {
        case "retained-frame":
            return `detected ${r} · frame: retained (the frame the viewfinder approved)${tail}`;
        case "burst-sibling":
            return `detected ${r} · rect from a sibling burst frame${tail}`;
        case "last-detection":
            return `detected ${r} · rect from the last preview detection${tail}`;
        case "tracked":
            return `tracked (auto) ${r}${tail}`;
        case "tracked-fallback":
            return `tracked (auto) ${r} · detection missed this frame — last tracked position${tail}`;
        case "calibration":
            return `calibration (seed) ${r}${tail}`;
        default:
            return `detected ${r} · frame: this burst${tail}`;
    }
}
