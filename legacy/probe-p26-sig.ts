// Pass 26 Defect 3 — watcher-signature measurement for the duplicate
// guard. Andrew: "it scanned a couple cards twice by mistake" in
// Rapid. Pass 22's re-arm rule (c) fires on ANY consecutive-sample
// movement above the stability bound (9) while a settled card is
// handled — including events where the card never left its seat
// (hand shadow, nudge, light change). This probe measures, with the
// App's OWN signature function (24x34 guide signature, App.tsx
// canvasRegionSignature) over a real hand-held composite:
//   - still-seated jitter: consecutive diffs (must stay well under 9)
//   - blip events (hand shadow band, brightness step, small nudge):
//     consecutive diff AND peak scene diff vs the handled signature
//   - genuine departures (card slid 25%/50% out, card removed):
//     scene diff vs handled
// The guard statistic is the PEAK SCENE DIFF vs handled since the
// settle: a card that was never re-presented never departs; a card
// that left and returned departs substantially mid-transit.
//
//   bun tests/harness/probe-p26-sig.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installGlobals, ShimCanvas } from "./canvas";

installGlobals();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, ".cache", "p26");
const { signatureDiff } = await import("../../client/src/rapid");

function loadCanvas(name: string): ShimCanvas {
  const meta = JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8")) as { width: number; height: number };
  const bytes = readFileSync(path.join(DIR, `${name}.rgba`));
  return ShimCanvas.fromRGBA(meta.width, meta.height, new Uint8Array(bytes));
}

/** The App's canvasRegionSignature, mirrored byte-for-byte (24x34). */
function sig(source: ShimCanvas): number[] {
  const W = 24;
  const H = 34;
  const tmp = new ShimCanvas();
  tmp.width = W;
  tmp.height = H;
  const ctx = tmp.getContext("2d")!;
  ctx.drawImage(source, 0, 0, source.width, source.height, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;
  const out: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    out.push(0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0));
  }
  return out;
}

function clone(c: ShimCanvas): ShimCanvas {
  const out = new ShimCanvas();
  out.width = c.width;
  out.height = c.height;
  out.getContext("2d")!.drawImage(c, 0, 0);
  return out;
}

/** Deterministic pseudo-noise so runs are comparable. */
function prand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function addNoise(c: ShimCanvas, sigma: number, seed: number): ShimCanvas {
  const out = clone(c);
  const ctx = out.getContext("2d")!;
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  const rnd = prand(seed);
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() + rnd() + rnd() - 1.5) * 2 * sigma;
    d[i] = Math.max(0, Math.min(255, (d[i] ?? 0) + n));
    d[i + 1] = Math.max(0, Math.min(255, (d[i + 1] ?? 0) + n));
    d[i + 2] = Math.max(0, Math.min(255, (d[i + 2] ?? 0) + n));
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function scaleBrightness(c: ShimCanvas, f: number): ShimCanvas {
  const out = clone(c);
  const ctx = out.getContext("2d")!;
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = Math.min(255, (d[i] ?? 0) * f);
    d[i + 1] = Math.min(255, (d[i + 1] ?? 0) * f);
    d[i + 2] = Math.min(255, (d[i + 2] ?? 0) * f);
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function shiftFrame(c: ShimCanvas, dx: number, dy: number): ShimCanvas {
  const out = new ShimCanvas();
  out.width = c.width;
  out.height = c.height;
  const ctx = out.getContext("2d")!;
  ctx.drawImage(c, dx, dy);
  return out;
}

/** Multiply a horizontal band's luminance by f (a hand shadow). */
function shadowBand(c: ShimCanvas, y0f: number, y1f: number, f: number): ShimCanvas {
  const out = clone(c);
  const ctx = out.getContext("2d")!;
  const y0 = Math.floor(out.height * y0f);
  const y1 = Math.floor(out.height * y1f);
  const img = ctx.getImageData(0, y0, out.width, y1 - y0);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = (d[i] ?? 0) * f;
    d[i + 1] = (d[i + 1] ?? 0) * f;
    d[i + 2] = (d[i + 2] ?? 0) * f;
  }
  ctx.putImageData(img, 0, y0);
  return out;
}

/** Slide the card region vertically by dyPx within the frame (the
 * background stays put) — a transit / nudge of the card itself. The
 * vacated strip is filled with the frame's own top background rows. */
function slideCard(c: ShimCanvas, rect: { x0: number; y0: number; x1: number; y1: number }, dyPx: number): ShimCanvas {
  const out = clone(c);
  const ctx = out.getContext("2d")!;
  const sx = Math.floor(c.width * rect.x0);
  const sy = Math.floor(c.height * rect.y0);
  const sw = Math.floor(c.width * (rect.x1 - rect.x0));
  const sh = Math.floor(c.height * (rect.y1 - rect.y0));
  const card = new ShimCanvas();
  card.width = sw;
  card.height = sh;
  card.getContext("2d")!.drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
  // Fill the card's old seat with background sampled from above it.
  ctx.drawImage(c, sx, Math.max(0, sy - sh), sw, sh, sx, sy, sw, sh);
  ctx.drawImage(card, sx, sy + dyPx);
  return out;
}

function emptyBackground(w: number, h: number): ShimCanvas {
  // prep_p26.py's Defect-1 gradient: (240,236,228) -> (196,188,174).
  const out = new ShimCanvas();
  out.width = w;
  out.height = h;
  const ctx = out.getContext("2d")!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const t = y / h;
    const r = Math.round(240 + (196 - 240) * t);
    const g = Math.round(236 + (188 - 236) * t);
    const b = Math.round(228 + (174 - 228) * t);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

const base = loadCanvas("p26-swamp-hand");
const cardRect = { x0: 0.003, y0: 0.145, x1: 0.797, y1: 0.735 };
const handled = sig(base);
const cardHpx = Math.floor(base.height * (cardRect.y1 - cardRect.y0));

interface Row { label: string; consec: number; vsHandled: number }
const rows: Row[] = [];
const series = (label: string, frames: ShimCanvas[]): void => {
  let prev: number[] | null = null;
  let maxConsec = 0;
  let peakVs = 0;
  for (const f of frames) {
    const s = sig(f);
    if (prev) maxConsec = Math.max(maxConsec, signatureDiff(s, prev));
    peakVs = Math.max(peakVs, signatureDiff(s, handled));
    prev = s;
  }
  rows.push({ label, consec: Math.round(maxConsec * 10) / 10, vsHandled: Math.round(peakVs * 10) / 10 });
};

// STILL SEATED — the card never moves; only sensor/AE jitter.
series("still: noise sigma2 x6", Array.from({ length: 6 }, (_, i) => addNoise(base, 2, 100 + i)));
series("still: noise sigma4 x6", Array.from({ length: 6 }, (_, i) => addNoise(base, 4, 200 + i)));
series("still: brightness 1.03 / 0.97 alternating", [scaleBrightness(base, 1.03), scaleBrightness(base, 0.97), scaleBrightness(base, 1.03), base]);
series("still: 1px jitter", [shiftFrame(base, 1, 0), shiftFrame(base, 0, 1), shiftFrame(base, -1, 0), base]);
series("still: 2px jitter", [shiftFrame(base, 2, 1), shiftFrame(base, -2, -1), base]);

// BLIPS — the card stays seated; something crosses / the light steps.
series("blip: hand shadow band 0.75x one sample", [shadowBand(base, 0.3, 0.55, 0.75), base, base]);
series("blip: hand shadow band 0.6x one sample", [shadowBand(base, 0.3, 0.55, 0.6), base, base]);
series("blip: torch step +8% whole frame", [scaleBrightness(base, 1.08), scaleBrightness(base, 1.08), base]);
series("blip: card nudged 6px down, stays", [slideCard(base, cardRect, 6), slideCard(base, cardRect, 6), slideCard(base, cardRect, 6)]);
series("blip: card nudged 14px down, stays", [slideCard(base, cardRect, 14), slideCard(base, cardRect, 14)]);

// GENUINE DEPARTURES — the card leaves (transit samples) and returns.
series("depart: card slid 25% out then back", [slideCard(base, cardRect, Math.round(cardHpx * 0.25)), slideCard(base, cardRect, Math.round(cardHpx * 0.25)), base]);
series("depart: card slid 50% out then back", [slideCard(base, cardRect, Math.round(cardHpx * 0.5)), base]);
series("depart: card fully out one sample", [emptyBackground(base.width, base.height), base]);
series("depart: card slid 25% UP then back", [slideCard(base, cardRect, -Math.round(cardHpx * 0.25)), base]);

console.log("\nwatcher signature diffs (24x34 guide signature; same-card threshold 14 hand / 20 box; movement re-arm 9):");
for (const r of rows) {
  console.log(`  ${r.label.padEnd(46)} maxConsec=${String(r.consec).padStart(6)}  peakVsHandled=${String(r.vsHandled).padStart(6)}`);
}
