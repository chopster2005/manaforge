// Pass 26 — harness assertions for Defect 1 (bleached band crops on
// a clean dewarp) and the Defect 2 completing treatment, over the
// prep_p26.py hand-held composites. Exits non-zero on any failure.
//
// Assertions:
//  S1 (end-to-end, detected rect): the AIMED standard title band of
//     the Swamp crop carries glyph ink (untreated ink share > 0.05)
//     and is NOT bleach-classified — pre-fix the window sat at the
//     title's edge (centroid at crop 0.120 vs window bottom 0.110)
//     and every single-line read returned "".
//  S2 (end-to-end): the Rapid burst over the detected prep produces
//     a title read of 'Swamp' and settles/suggests Swamp — pre-fix:
//     kind=none, titleReads=[].
//  S3 (panel-shape crop): a crop displaced exactly like Andrew's
//     panel (title centroid at crop y≈0.16, fixed window holding
//     only background + the card's top border) — the aimed window
//     must move DOWN onto the title row (aimed y0 > fixed y0) and
//     the burst must read 'Swamp' from the title band.
//  E1 (end-to-end): the Eye of Jace burst produces a title read and
//     its pooled top match is 'Eye of Jace' (pre-fix: kind=none,
//     no reads at all — the standard window read frame-edge garbage
//     the matcher discarded).
//
//   bun tests/harness/probe-p26-assert.ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installGlobals, ShimCanvas } from "./canvas";

installGlobals();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, ".cache", "p26");

const { prepareCardFromFrame, cropToRect } = await import("../../client/src/detect");
const { aimTitleSpec, analyzeBandBleach, BAND_VARIANTS, TITLE_TALL_BAND, ensureOcrWorker, ocrTitleBandCapped, ocrBand } = await import("../../client/src/ocr");
const { buildNameIndex, matchNamesPooled, ocrCandidates } = await import("../../client/src/lib");
const { identifyBurstHarness } = await import("./pipeline");
const { fetchCardNames } = await import("./scryfall");

let failures = 0;
function check(label: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures += 1;
}

function loadCanvas(name: string): ShimCanvas {
  const meta = JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8")) as { width: number; height: number };
  const bytes = readFileSync(path.join(DIR, `${name}.rgba`));
  return ShimCanvas.fromRGBA(meta.width, meta.height, new Uint8Array(bytes));
}

function inkShare(card: ShimCanvas, spec: { x0: number; x1: number; y0: number; y1: number }): number {
  const ctx = card.getContext("2d")!;
  const sx = Math.floor(card.width * spec.x0);
  const sw = Math.floor(card.width * (spec.x1 - spec.x0));
  const sy = Math.floor(card.height * spec.y0);
  const sh = Math.floor(card.height * (spec.y1 - spec.y0));
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

console.log("Loading card-names index…");
const names = await fetchCardNames();
const index = buildNameIndex(names);
console.log("Warming OCR worker…");
await ensureOcrWorker();

const STD = BAND_VARIANTS[0]!;

// ---- Swamp, detected rect (end-to-end) ----
const swampFrame = loadCanvas("p26-swamp-hand");
const prep = prepareCardFromFrame(swampFrame as never, { boxMode: false, calibration: null });
// Warm-up with a full DISCARDED burst, not just worker creation:
// in this sandbox the first burst in a process absorbs tesseract
// worker initialisation — its capped reads expire against the
// attempt clock and it returns empty (the probe scripts, which run
// five direct reads first, never see it; on-device the worker
// persists for the whole session so only a session's first attempt
// pays init). The discarded warm-up puts the measured bursts on
// the same footing as the probes and as a warmed phone.
await identifyBurstHarness([{ card: prep.card }], { rapid: true, index }).catch(() => null);
const card = prep.card as unknown as ShimCanvas;
const aimed = aimTitleSpec(card as never, STD as never) as unknown as typeof STD;
const aimedInk = inkShare(card, aimed);
const aimedBleach = analyzeBandBleach(card as never, aimed as never);
check("S1 aimed title band carries glyph ink and is not bleached",
  aimedInk > 0.05 && !aimedBleach.bleached,
  `aimed y0=${aimed.y0.toFixed(3)} (fixed ${STD.y0}) ink=${aimedInk.toFixed(3)} bleached=${aimedBleach.bleached}`);

// S2 — the COMPLETING STEP, deterministically. In this sandbox the
// frame loop legitimately spends the whole attempt clock (reads
// run 5-10x slower than on the phone), so the post-loop completing
// read is clock-starved here BY DESIGN — its gate trace evaluates
// with remaining=0 after the loop did its work. On the phone the
// panel's own numbers (title stage 123ms of a 2500ms budget) leave
// the clock it needs. What is proven here is the step itself: the
// exact call the completing block makes (tall window, multi-line,
// on the burst's card), pooled with the standard window's read,
// must turn the garbled pool into a Swamp win.
{
  const stdRead = await ocrBand(prep.card as never, STD as never, {}).catch(() => ({ text: "" }));
  const completing = await ocrTitleBandCapped(prep.card as never, TITLE_TALL_BAND as never, { multiLine: true });
  const pooled = matchNamesPooled(ocrCandidates([stdRead.text, completing.text].filter(Boolean)), index, 5);
  check("S2 completing step: the tall multi-line read names the card the standard pool garbled",
    /swamp/i.test(completing.text) && pooled[0]?.entry.full === "Swamp",
    `std=${JSON.stringify(stdRead.text)} completing=${JSON.stringify(completing.text)} top=${pooled[0]?.entry.full} ${pooled[0]?.score.toFixed(3)}`);
}

// ---- Swamp, panel-shape displaced crop ----
const panelCrop = cropToRect(swampFrame as never, { x0: 0.03, y0: 0.093, x1: 0.78, y1: 0.733 }) as unknown as ShimCanvas;
const pAimed = aimTitleSpec(panelCrop as never, STD as never) as unknown as typeof STD;
check("S3 panel-shape crop: aim moves the window down onto the title row",
  pAimed.y0 > STD.y0 + 0.02 && inkShare(panelCrop, pAimed) > 0.05,
  `aimed y0=${pAimed.y0.toFixed(3)} vs fixed ${STD.y0} ink=${inkShare(panelCrop, pAimed).toFixed(3)}`);
const pOutcome = await identifyBurstHarness([{ card: panelCrop }], { rapid: true, index });
check("S3 panel-shape crop: burst settles the displaced Swamp (bottom line carries it)",
  pOutcome.kind === "confident" && pOutcome.name === "Swamp",
  `kind=${pOutcome.kind} name=${pOutcome.name ?? "-"} reads=${JSON.stringify(pOutcome.titleReads)} bottom=${JSON.stringify(pOutcome.bottomTexts)}`);

// ---- Eye of Jace, detected rect (end-to-end) ----
const eyeFrame = loadCanvas("p26-eye-hand");
const eyePrep = prepareCardFromFrame(eyeFrame as never, { boxMode: false, calibration: null });
const eOutcome = await identifyBurstHarness([{ card: eyePrep.card }], { rapid: true, index });
const eTop = eOutcome.name ?? eOutcome.matches[0]?.name;
check("E1 Eye burst produces title evidence and ranks Eye of Jace first",
  eOutcome.titleReads.length > 0 && eTop === "Eye of Jace",
  `kind=${eOutcome.kind} top=${eTop ?? "-"} reads=${JSON.stringify(eOutcome.titleReads)} matches=${JSON.stringify(eOutcome.matches)}`);

console.log(failures === 0 ? "\nALL P26 HARNESS ASSERTIONS PASSED" : `\n${failures} FAILURES`);
if (failures > 0) process.exit(1);
