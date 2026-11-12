// Pass 26 — reproduction probe for the two 2026-11-10 hand-held panels.
// Runs the PRODUCTION prepare + band + OCR + burst pipeline over the
// prep_p26.py composites and prints, per fixture:
//   - the detected/aspect-corrected rect vs the true card bbox;
//   - where the title centroid and the collector line land in CROP
//     fractions of the rect actually read;
//   - the bleach classification + ink share of the standard title
//     band and the aimed bottom band (the Defect 1 assertion inputs);
//   - per-treatment title reads (PSM 7 only / PSM 7+6 pooled / PSM 6
//     multi-line / standard-low / tall) — the Defect 2 pooling trace;
//   - the full Rapid burst outcome.
//
//   bun tests/harness/probe-p26-pipeline.ts [swamp|eye|all]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installGlobals, ShimCanvas } from "./canvas";

installGlobals();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, ".cache", "p26");

const { prepareCardFromFrame, cropToRect } = await import("../../client/src/detect");
const { buildBandCanvas, bleachOfBandCanvas, aimBottomSpec, ocrBand, ocrBandMultiLine, BAND_VARIANTS, BOTTOM_BAND, TITLE_TALL_BAND, TITLE_OFFSET_BAND_4, TITLE_OFFSET_BAND_8, analyzeBandBleach, ensureOcrWorker } = await import("../../client/src/ocr");
const { buildNameIndex } = await import("../../client/src/lib");
const { identifyBurstHarness } = await import("./pipeline");
const { fetchCardNames } = await import("./scryfall");

interface FxMeta {
  id: string;
  expected: { name: string; set?: string; number?: string };
  trueRect: { x0: number; y0: number; x1: number; y1: number };
  titleCentroidCard: number;
  panelRect?: { x0: number; y0: number; x1: number; y1: number };
}

function loadCanvas(name: string): ShimCanvas {
  const meta = JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8")) as { width: number; height: number };
  const bytes = readFileSync(path.join(DIR, `${name}.rgba`));
  return ShimCanvas.fromRGBA(meta.width, meta.height, new Uint8Array(bytes));
}

/** Raw ink share of a band window on the UNTREATED crop: fraction of
 * pixels deviating >36 from their row median (prep.py's ink measure)
 * — the ground-truth "does this window contain printed glyphs". */
function bandInkShare(card: ShimCanvas, spec: { x0: number; x1: number; y0: number; y1: number }): number {
  const band = buildBandCanvas(card as never, { ...spec, treatment: "contrast" } as never) as unknown as ShimCanvas;
  void band;
  // Measure on the crop directly (no treatment): sample the window.
  const w = card.width;
  const h = card.height;
  const ctx = card.getContext("2d")!;
  const sx = Math.floor(w * spec.x0);
  const sw = Math.floor(w * (spec.x1 - spec.x0));
  const sy = Math.floor(h * spec.y0);
  const sh = Math.floor(h * (spec.y1 - spec.y0));
  const img = ctx.getImageData(sx, sy, sw, sh);
  const d = img.data;
  let ink = 0;
  let n = 0;
  for (let y = 0; y < sh; y++) {
    const row: number[] = [];
    for (let x = 0; x < sw; x += 3) {
      const i = (y * sw + x) * 4;
      row.push(0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0));
    }
    const med = [...row].sort((a, b) => a - b)[Math.floor(row.length / 2)] ?? 0;
    for (let x = 0; x < sw; x += 2) {
      const i = (y * sw + x) * 4;
      const lum = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
      if (Math.abs(lum - med) > 36) ink += 1;
      n += 1;
    }
  }
  return n > 0 ? ink / n : 0;
}

const which = process.argv[2] ?? "all";
const manifest = JSON.parse(readFileSync(path.join(DIR, "manifest.json"), "utf8")) as FxMeta[];
console.log("Loading card-names index…");
const names = await fetchCardNames();
const index = buildNameIndex(names);
console.log(`Index: ${index.length} entries`);
console.log("Warming OCR worker…");
await ensureOcrWorker();

for (const fx of manifest) {
  if (which !== "all" && !fx.id.includes(which)) continue;
  const frame = loadCanvas(fx.id);
  console.log(`\n================ ${fx.id} — expected ${fx.expected.name} (${fx.expected.set} ${fx.expected.number})`);
  console.log(`trueRect (bbox): (${fx.trueRect.x0.toFixed(2)},${fx.trueRect.y0.toFixed(2)})-(${fx.trueRect.x1.toFixed(2)},${fx.trueRect.y1.toFixed(2)})`);
  const prep = prepareCardFromFrame(frame as never, { boxMode: false, calibration: null });
  const r = prep.rect;
  console.log(`prep: source=${prep.source} origin=${prep.rectOrigin} rect=${r ? `(${r.x0.toFixed(2)},${r.y0.toFixed(2)})-(${r.x1.toFixed(2)},${r.y1.toFixed(2)})` : "null"} card=${prep.card.width}x${prep.card.height}`);
  if (r) {
    const titleFrameY = fx.trueRect.y0 + fx.titleCentroidCard * (fx.trueRect.y1 - fx.trueRect.y0);
    const titleCropFrac = (titleFrameY - r.y0) / (r.y1 - r.y0);
    const bottomFrameY = fx.trueRect.y0 + 0.965 * (fx.trueRect.y1 - fx.trueRect.y0);
    const bottomCropFrac = (bottomFrameY - r.y0) / (r.y1 - r.y0);
    console.log(`title centroid lands at crop y=${titleCropFrac.toFixed(3)} (standard band 0.025-0.110)`);
    console.log(`collector line (~0.965 of card) lands at crop y=${bottomCropFrac.toFixed(3)} (bottom window 0.915-0.995, aim range y0 0.82-0.92)`);
  }
  const card = prep.card as unknown as ShimCanvas;
  const stdSpec = BAND_VARIANTS[0]!;
  const titleBand = buildBandCanvas(card as never, stdSpec as never) as unknown as ShimCanvas;
  const tb = bleachOfBandCanvas(titleBand as never);
  console.log(`TITLE band: inkShare(untreated)=${bandInkShare(card, stdSpec).toFixed(4)} bleach={bleached:${tb.bleached} kind:${tb.kind || "-"} mean:${tb.mean.toFixed(0)} stdev:${tb.stdev.toFixed(1)} ink:${tb.inkShare.toFixed(4)}}`);
  const aimed = aimBottomSpec(card as never, BOTTOM_BAND as never);
  const botBand = buildBandCanvas(card as never, aimed as never) as unknown as ShimCanvas;
  const bb = bleachOfBandCanvas(botBand as never);
  console.log(`BOTTOM band (aimed y0=${(aimed as { y0: number }).y0.toFixed(3)}): inkShare(untreated)=${bandInkShare(card, aimed as never).toFixed(4)} bleach={bleached:${bb.bleached} kind:${bb.kind || "-"} mean:${bb.mean.toFixed(0)} stdev:${bb.stdev.toFixed(1)} ink:${bb.inkShare.toFixed(4)}}`);

  // Per-treatment title reads (Defect 2 trace; cheap enough to run
  // for both fixtures).
  const t7 = await ocrBand(card as never, stdSpec as never, { fast: true });
  console.log(`  read PSM7-only (fast): ${JSON.stringify(t7.text)} [${t7.ms.toFixed(0)}ms psm=${t7.psm}]`);
  const t76 = await ocrBand(card as never, stdSpec as never, {});
  console.log(`  read PSM7+6 pooled:    ${JSON.stringify(t76.text)} [${t76.ms.toFixed(0)}ms psm=${t76.psm}]`);
  const t6 = await ocrBandMultiLine(card as never, stdSpec as never, {});
  console.log(`  read PSM6 multi-line:  ${JSON.stringify(t6.text)} [${t6.ms.toFixed(0)}ms psm=${t6.psm}]`);
  const lowSpec = BAND_VARIANTS[2]!;
  const tLow = await ocrBand(card as never, lowSpec as never, { fast: true });
  console.log(`  read standard-low PSM7: ${JSON.stringify(tLow.text)} [${tLow.ms.toFixed(0)}ms]`);
  const tTall = await ocrBandMultiLine(card as never, TITLE_TALL_BAND as never, {});
  console.log(`  read tall PSM6:         ${JSON.stringify(tTall.text)} [${tTall.ms.toFixed(0)}ms]`);

  const outcome = await identifyBurstHarness([{ card: prep.card }], { rapid: true, index });
  console.log(`BURST (rapid): kind=${outcome.kind} name=${outcome.name ?? "-"} evidence=${outcome.evidence ?? "-"}`);
  console.log(`  titleReads=${JSON.stringify(outcome.titleReads)}`);
  console.log(`  bottomTexts=${JSON.stringify(outcome.bottomTexts)}`);
  console.log(`  matches=${JSON.stringify(outcome.matches)}`);
  console.log(`  stages=${JSON.stringify(outcome.stagesMs)}`);

  // PANEL-RECT RUN — the band stage fed the crop the DEVICE actually
  // read (the rect printed on the panel), over this frame whose true
  // card position is known. This isolates the band pipeline's
  // response to the measured rect displacement, whatever detection
  // did on the synthetic composite.
  if (fx.panelRect) {
    const pr = fx.panelRect;
    const pcard = cropToRect(frame as never, pr) as unknown as ShimCanvas;
    console.log(`\n-- PANEL-RECT crop (${pr.x0.toFixed(2)},${pr.y0.toFixed(2)})-(${pr.x1.toFixed(2)},${pr.y1.toFixed(2)}) card=${pcard.width}x${pcard.height}`);
    const titleFrameY = fx.trueRect.y0 + fx.titleCentroidCard * (fx.trueRect.y1 - fx.trueRect.y0);
    console.log(`   title centroid at crop y=${((titleFrameY - pr.y0) / (pr.y1 - pr.y0)).toFixed(3)}; collector line at crop y=${((fx.trueRect.y0 + 0.965 * (fx.trueRect.y1 - fx.trueRect.y0) - pr.y0) / (pr.y1 - pr.y0)).toFixed(3)}`);
    for (const [label, spec] of [["standard", BAND_VARIANTS[0]!], ["standard-low", BAND_VARIANTS[2]!], ["offset+4", TITLE_OFFSET_BAND_4], ["offset+8", TITLE_OFFSET_BAND_8], ["tall", TITLE_TALL_BAND]] as const) {
      const bl = analyzeBandBleach(pcard as never, spec as never);
      console.log(`   band ${label.padEnd(12)} ink(untreated)=${bandInkShare(pcard, spec as never).toFixed(4)} bleached=${bl.bleached} kind=${bl.kind || "-"}`);
    }
    const paimed = aimBottomSpec(pcard as never, BOTTOM_BAND as never);
    const bbl = analyzeBandBleach(pcard as never, paimed as never);
    console.log(`   band bottom(aimed y0=${(paimed as { y0: number }).y0.toFixed(3)}) ink(untreated)=${bandInkShare(pcard, paimed as never).toFixed(4)} bleached=${bbl.bleached} kind=${bbl.kind || "-"}`);
    const pOutcome = await identifyBurstHarness([{ card: pcard }], { rapid: true, index });
    console.log(`   BURST (rapid, panel-rect crop): kind=${pOutcome.kind} name=${pOutcome.name ?? "-"} evidence=${pOutcome.evidence ?? "-"}`);
    console.log(`     titleReads=${JSON.stringify(pOutcome.titleReads)}`);
    console.log(`     bottomTexts=${JSON.stringify(pOutcome.bottomTexts)}`);
    console.log(`     matches=${JSON.stringify(pOutcome.matches)}`);
    console.log(`     stages=${JSON.stringify(pOutcome.stagesMs)}`);
  }
}
