/** Shared candidate and gate contract used by the Pass 19–34 fusion engine.
 * The browser app uses visual.ts for local candidate verification. */
export const CANONICAL_W = 250;
export const CANONICAL_H = 350;
export const IMAGE_GATE_DIST = 40;
export const IMAGE_GATE_MARGIN = 8;
export const IMAGE_RAPID_SOLO_DIST = 30;
export const IMAGE_RAPID_SOLO_MARGIN = 12;
export const IMAGE_BAND_DIST = 56;
export const IMAGE_BAND_MARGIN = 4;
export const IMAGE_DEGRADED_MARGIN = 12;
export function consensusRank(ranked) {
    const best = new Map();
    for (const item of ranked) {
        const prev = best.get(item.name);
        if (!prev || item.dist.combined < prev.dist.combined)
            best.set(item.name, item);
    }
    return [...best.values()].sort((a, b) => a.dist.combined - b.dist.combined);
}
export function fullArtPinBlocked(input) {
    return Boolean((input.fullArt || input.borderColor === 'borderless') && (input.distance ?? 999) > IMAGE_GATE_DIST && (input.margin ?? 0) < IMAGE_GATE_MARGIN);
}
export function rectHypotheses(rect) {
    const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
    const clamp = (v) => Math.max(0, Math.min(1, v));
    return [
        rect,
        { x0: clamp(rect.x0 + w * .05), y0: clamp(rect.y0 + h * .05), x1: clamp(rect.x1 - w * .05), y1: clamp(rect.y1 - h * .05) },
        { x0: clamp(rect.x0 + w * .10), y0: clamp(rect.y0 + h * .10), x1: clamp(rect.x1 - w * .10), y1: clamp(rect.y1 - h * .10) },
        { x0: rect.x0, y0: clamp(rect.y0 - h * .05), x1: rect.x1, y1: clamp(rect.y1 - h * .05) },
        { x0: clamp(rect.x0 + w * .02), y0: clamp(rect.y0 - h * .05), x1: clamp(rect.x1 - w * .02), y1: clamp(rect.y1 - h * .05) },
    ];
}
export function rankReferences(query, refs) {
    const ham = (a, b) => a.reduce((s, v, i) => s + (v !== b[i] ? 1 : 0), Math.abs(a.length - b.length));
    return refs.map(r => { const whole = ham(query.whole, r.fingerprint.whole), art = ham(query.art, r.fingerprint.art); return { name: r.name, dist: { card: whole, art, combined: Math.round(whole * .35 + art * .65) } }; }).sort((a, b) => a.dist.combined - b.dist.combined);
}
