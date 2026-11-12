function sampleGray(source, sx = 0, sy = 0, sw = 1, sh = 1) {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx)
        throw new Error('Canvas is unavailable for image comparison.');
    ctx.fillStyle = '#777';
    ctx.fillRect(0, 0, 32, 32);
    ctx.drawImage(source, sx * source.width, sy * source.height, sw * source.width, sh * source.height, 0, 0, 32, 32);
    const pixels = ctx.getImageData(0, 0, 32, 32).data;
    const out = [];
    for (let i = 0; i < pixels.length; i += 4)
        out.push(0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]);
    return out;
}
function dctHash(gray) {
    const coeffs = [];
    for (let v = 0; v < 8; v++)
        for (let u = 0; u < 8; u++) {
            if (u === 0 && v === 0)
                continue;
            let sum = 0;
            for (let y = 0; y < 32; y++)
                for (let x = 0; x < 32; x++) {
                    sum += (gray[y * 32 + x] ?? 0) * Math.cos(((2 * x + 1) * u * Math.PI) / 64) * Math.cos(((2 * y + 1) * v * Math.PI) / 64);
                }
            coeffs.push(sum);
        }
    const sorted = [...coeffs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    return coeffs.map(v => v >= median ? 1 : 0);
}
export function fingerprintCanvas(canvas) {
    return {
        whole: dctHash(sampleGray(canvas)),
        // Art crop deliberately avoids the title and bottom information strip.
        art: dctHash(sampleGray(canvas, 0.055, 0.105, 0.89, 0.30)),
    };
}
export function hamming(a, b) {
    const n = Math.min(a.length, b.length);
    let d = Math.abs(a.length - b.length);
    for (let i = 0; i < n; i++)
        if (a[i] !== b[i])
            d++;
    return d;
}
export async function fingerprintImageUrl(url) {
    const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!response.ok)
        throw new Error(`Reference image returned HTTP ${response.status}`);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx)
            throw new Error('Canvas is unavailable.');
        ctx.drawImage(bitmap, 0, 0);
        return fingerprintCanvas(canvas);
    }
    finally {
        bitmap.close();
    }
}
export async function rankVisualReferences(query, refs) {
    const ranked = await Promise.all(refs.map(async (ref) => {
        try {
            const fp = await fingerprintImageUrl(ref.imageUrl);
            const wholeDistance = hamming(query.whole, fp.whole);
            const artDistance = hamming(query.art, fp.art);
            return { id: ref.id, wholeDistance, artDistance, distance: Math.round(wholeDistance * 0.35 + artDistance * 0.65) };
        }
        catch {
            return null;
        }
    }));
    return ranked.filter((x) => x !== null).sort((a, b) => a.distance - b.distance);
}
/** Conservative printing gate calibrated to the supplied roadmap. */
export function decisiveVisualPrinting(ranked) {
    const best = ranked[0];
    if (!best || best.distance > 40)
        return null;
    const second = ranked[1];
    if (second && second.distance - best.distance < 4)
        return null;
    return best;
}
