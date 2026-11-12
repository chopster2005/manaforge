// Pass 24c Step 3 probe — FRA full-art basic lands.
//
// (a) BAND AIM: for Andrew's exact printings (foil full-art Plains
//     FRA #384, Swamp FRA #390) composited at box geometry, measure
//     where the production title bands sit vs where the title row
//     actually is: prepared-rect edge deltas vs the true rect, every
//     BAND_VARIANTS read, and a fine y-sweep of band windows over the
//     prepared crop recording which windows return the full name.
// (b) CYCLE DISTANCES: fingerprint the five FRA full-art basics
//     (his finish variant) as references; query each from its box-40
//     composite through the production hypothesis path and print the
//     ranked distances — do the five mutually sit inside the
//     corroboration band (≤56) of each other?
//
//   bun tests/harness/probe-fra.ts
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installGlobals, ShimCanvas } from "./canvas";
import type { BandSpec } from "../../client/src/ocr";

installGlobals();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRA = path.join(HERE, ".cache", "fra");

const { prepareCardFromFrame, cropToRect } = await import("../../client/src/detect");
const { BAND_VARIANTS, TITLE_TALL_BAND, ensureOcrWorker, ocrTitleBandCapped } = await import("../../client/src/ocr");
const { buildNameIndex, matchNamesPooled, ocrCandidates } = await import("../../client/src/lib");
const finder = await import("../../client/src/finder");
const { fetchCardNames } = await import("./scryfall");
const { identifyBurstHarness } = await import("./pipeline");

type Rect = { x0: number; y0: number; x1: number; y1: number };
interface FraFixture {
  id: string;
  expected: { name: string };
  trueRect: Rect;
  titleCentroidCard: number;
  mode: { type: string; rapid?: boolean; boxMode?: boolean; calibration?: Rect };
}

const manifest = JSON.parse(readFileSync(path.join(FRA, "manifest.json"), "utf8")) as FraFixture[];

function loadCanvas(dir: string, name: string): ShimCanvas {
  const meta = JSON.parse(readFileSync(path.join(dir, `${name}.json`), "utf8")) as { width: number; height: number };
  const bytes = readFileSync(path.join(dir, `${name}.rgba`));
  return ShimCanvas.fromRGBA(meta.width, meta.height, new Uint8Array(bytes));
}

function loadJpg(name: string): ShimCanvas {
  const bin = path.join(FRA, `${name}.jpg`);
  const prefix = path.join(FRA, `${name}-dec`);
  if (!existsSync(`${prefix}.rgba`)) {
    const out = spawnSync("python3", [path.join(HERE, "decode.py"), bin, prefix], { encoding: "utf8" });
    if (out.status !== 0) throw new Error(`decode failed for ${name}: ${out.stderr}`);
  }
  const meta = JSON.parse(readFileSync(`${prefix}.json`, "utf8")) as { width: number; height: number };
  return ShimCanvas.fromRGBA(meta.width, meta.height, new Uint8Array(readFileSync(`${prefix}.rgba`)));
}

function resizeTo(src: ShimCanvas, w: number, h: number): ShimCanvas {
  const out = new ShimCanvas();
  out.width = w; out.height = h;
  out.getContext("2d")!.drawImage(src as never, 0, 0, w, h);
  return out;
}
function fpOf(canvas: ShimCanvas): { art: string; card: string } {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return finder.fingerprintFromPixels(img.data, canvas.width, canvas.height);
}

console.log("Warming OCR worker…");
await ensureOcrWorker();
const names = await fetchCardNames();
const nameIndex = buildNameIndex(names);
console.log(`name index: ${nameIndex.length} entries\n`);

// ------------------------------------------------------------------
// (a) Band aim
// ------------------------------------------------------------------
for (const fx of manifest) {
  if (!fx.id.endsWith("box40") && !fx.id.endsWith("calib")) continue;
  if (!fx.id.startsWith("fra-plains") && !fx.id.startsWith("fra-swamp")) continue;
  const frame = loadCanvas(FRA, fx.id);
  const boxMode = !!fx.mode.boxMode;
  const prep = prepareCardFromFrame(frame as never, {
    boxMode,
    calibration: (fx.mode.calibration ?? null) as never,
  }) as unknown as { card: ShimCanvas; rect: Rect | null; source: string };
  const t = fx.trueRect;
  const th = t.y1 - t.y0;
  const edge = prep.rect
    ? `top ${(((prep.rect.y0 - t.y0) / th) * 100).toFixed(1)}% · bottom ${(((prep.rect.y1 - t.y1) / th) * 100).toFixed(1)}% · left ${(((prep.rect.x0 - t.x0) / (t.x1 - t.x0)) * 100).toFixed(1)}% · right ${(((prep.rect.x1 - t.x1) / (t.x1 - t.x0)) * 100).toFixed(1)}% (of card size; + = prepared rect extends past the true edge)`
    : "no rect";
  console.log(`=== ${fx.id} — expected ${fx.expected.name}, title centroid (pristine) ${(fx.titleCentroidCard * 100).toFixed(1)}%`);
  console.log(`  prep source=${prep.source} · rect deltas vs truth: ${edge}`);

  const card = prep.card as never;
  for (const spec of [...BAND_VARIANTS, TITLE_TALL_BAND]) {
    const read = await ocrTitleBandCapped(card, spec, {});
    const text = (read?.text ?? "").replace(/\s+/g, " ").trim();
    console.log(`  band ${spec.label} y ${(spec.y0 * 100).toFixed(1)}–${(spec.y1 * 100).toFixed(1)}%: "${text.slice(0, 60)}"`);
  }
  // Fine sweep: fixed standard height (8.5%), y0 from 0% to 7%.
  const hits: string[] = [];
  for (let y0 = 0; y0 <= 0.0701; y0 += 0.005) {
    const spec: BandSpec = { x0: 0.01, x1: 0.83, y0, y1: y0 + 0.085, treatment: "contrast", label: `sweep${y0.toFixed(3)}` };
    const read = await ocrTitleBandCapped(card, spec, {});
    const text = (read?.text ?? "").replace(/\s+/g, " ").trim();
    const m = matchNamesPooled(ocrCandidates([text]), nameIndex, 1);
    const top = m[0];
    const full = top && top.entry.full === fx.expected.name && top.score >= 0.82;
    console.log(`  sweep y0 ${(y0 * 100).toFixed(1)}%: "${text.slice(0, 48)}" → ${top ? `${top.entry.full} ${top.score.toFixed(2)}` : "—"}${full ? "  ★ FULL NAME" : ""}`);
    if (full) hits.push(`${(y0 * 100).toFixed(1)}`);
  }
  console.log(`  sweep windows returning the full name at ≥0.82: ${hits.length ? hits.join(", ") + " (y0 %)" : "NONE"}`);

  const outcome = await identifyBurstHarness([prep as never], { rapid: !!fx.mode.rapid, index: nameIndex });
  console.log(`  pipeline: kind=${outcome.kind} name=${outcome.name ?? "—"} evidence=${outcome.evidence ?? "—"}`);
  console.log("");
}

// ------------------------------------------------------------------
// (b) Cycle distance matrix
// ------------------------------------------------------------------
const CYCLE = [
  { slug: "fra-plains-384", name: "Plains" },
  { slug: "fra-island-387", name: "Island" },
  { slug: "fra-swamp-390", name: "Swamp" },
  { slug: "fra-mountain-393", name: "Mountain" },
  { slug: "fra-forest-396", name: "Forest" },
];
const refs: finder.ReferenceEntry[] = CYCLE.map((c) => {
  const pristine = loadJpg(c.slug);
  const canonical = resizeTo(pristine, finder.CANONICAL_W, finder.CANONICAL_H);
  return {
    name: c.name,
    setCode: "fra",
    collectorNumber: c.slug.split("-")[2] ?? "",
    scryfallId: c.slug,
    fp: fpOf(canonical),
  };
});
console.log("=== FRA full-art cycle — box-40 queries vs the 5 references ===");
for (const c of CYCLE) {
  const fx = manifest.find((f) => f.id === `${c.slug}-box40`)!;
  const frame = loadCanvas(FRA, fx.id);
  const prep = prepareCardFromFrame(frame as never, { boxMode: false, calibration: null }) as unknown as { card: ShimCanvas; rect: Rect | null; source: string };
  const fps: { art: string; card: string }[] = [];
  if (!prep.rect) {
    fps.push(fpOf(resizeTo(frame, finder.CANONICAL_W, finder.CANONICAL_H)));
  } else {
    for (const hyp of finder.rectHypotheses(prep.rect)) {
      fps.push(fpOf(resizeTo(cropToRect(frame as never, hyp) as unknown as ShimCanvas, finder.CANONICAL_W, finder.CANONICAL_H)));
    }
  }
  const ranked = finder.rankReferences(fps, refs);
  const line = ranked.map((r) => `${r.name} d=${r.dist.combined} (art ${r.dist.art} + card ${r.dist.card})`).join(" · ");
  console.log(`  query ${c.name}: ${line}`);
}
console.log("\n=== pristine-vs-pristine (identity geometry, canonical resize) ===");
for (const c of CYCLE) {
  const pristine = loadJpg(c.slug);
  const canonical = resizeTo(pristine, finder.CANONICAL_W, finder.CANONICAL_H);
  const ranked = finder.rankReferences([fpOf(canonical)], refs);
  const line = ranked.map((r) => `${r.name} d=${r.dist.combined}`).join(" · ");
  console.log(`  query ${c.name}: ${line}`);
}
