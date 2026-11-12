// Pass 33 — THE SHARPNESS FLOOR MUST NEVER VETO IDENTIFICATION.
// Run: bun tests/pass33.test.ts
//
// REGRESSION EVIDENCE (Andrew 2026-11-10 ~20:14/20:15 EST, Pass 32
// build): two Snaps refused outright by the Pass 32 floor gate —
// NO title, NO bottom, NO match, and NO IMAGE-MATCH LINE AT ALL
// (the artwork channel never ran):
//  P2 Stingerquill Annex: bursts 11.3 · 11.5 · 11.5 → 11.6 · 9.4 ·
//     9.4, stages "capture 1.1s · detect 25ms" ONLY. The card is
//     human-legible in the panel image and was AUTO-ADDED BY
//     ARTWORK (d=26) in Rapid ~25 minutes earlier on the Pass 31
//     build — the gate vetoed a channel it was never calibrated
//     for (the floor was measured against OCR legibility only).
//  P1 Retrieve the Esper (FIN #88): bursts 2.4 · 2.3 · 4.6 →
//     4.7 · 4.7 · 4.7, stages "capture 342ms · detect 21ms" ONLY.
//     A brand-new card was never offered to any channel.
//  P1's panel image was also a partial crop (top two-thirds, text
//     box missing) from a tracked-fallback rect — with nothing on
//     the panel saying the crop could clip the card.
//
// THE CONTRACT PINNED HERE (production functions, focus.ts +
// detect.ts):
//  1. softAttemptPlan NEVER refuses: for every labelled real
//     vector (P1, P2, W1, W2), every ladder vector, unmeasured and
//     sharp vectors, proceed === true. Identification always runs.
//  2. All-soft on Snap escalates (escalateStill) — capture-quality
//     escalation replaces refusal; Rapid never escalates to stills
//     (cadence) but still proceeds.
//  3. "Out of focus" survives only as ADVICE text (softFocusAdvice
//     via the plan), present exactly when the burst metered soft,
//     carrying the measured numbers.
//  4. The ladder data itself convicts the old gate: fixtures in
//     the 10.8–12.5 dim+soft band — BELOW/AROUND the old floor —
//     include usable reads the gate would have refused.
//  5. rectClipFinding: a read rect materially shorter than a
//     card's shape for its width produces the printed clip
//     finding; card-shaped rects (detected/calibration normal
//     case) produce none; describePrepRect appends it without
//     disturbing the established line prefixes.
import { readFileSync } from "node:fs";
import { installGlobals, ShimCanvas } from "./harness/canvas";
import {
  burstFocusVerdict,
  SHARPNESS_FLOOR,
  softAttemptPlan,
  softFocusAdvice,
} from "../client/src/focus";
import type { CardRect, PreparedCard } from "../client/src/detect";

installGlobals();

const { describePrepRect, rectClipFinding } = await import("../client/src/detect");

let failures = 0;
let checks = 0;
function check(label: string, cond: boolean, extra = ""): void {
  checks += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures += 1;
}

// ---------------------------------------------------------------------------
// 1. THE LABELLED REAL VECTORS — the panels' own numbers.
// ---------------------------------------------------------------------------
const P2_FIRST = [11.3, 11.5, 11.5];
const P2_RECAP = [11.6, 9.4, 9.4];
const P1_FIRST = [2.4, 2.3, 4.6];
const P1_RECAP = [4.7, 4.7, 4.7];
const W1 = [9.5, 5.9, 9.6];
const W2 = [10.2, 10.1, 10.3];
const DIM_SHARP = [13.4, 15.2, 14.1];
const SHARP = [71.9, 68.0, 70.2];
const UNMEASURED = [0, 0, 0];

for (const [label, v] of [
  ["P2 first burst", P2_FIRST],
  ["P2 re-capture", P2_RECAP],
  ["P1 first burst", P1_FIRST],
  ["P1 re-capture", P1_RECAP],
  ["W1", W1],
  ["W2", W2],
] as const) {
  check(`${label}: verdict all-soft (escalation owed)`, burstFocusVerdict(v) === "all-soft");
  const snap = softAttemptPlan(v, { snap: true });
  check(`${label}: Snap plan PROCEEDS (no refusal)`, snap.proceed === true);
  check(`${label}: Snap plan escalates to still`, snap.escalateStill === true);
  check(`${label}: Snap plan carries focus advice`, snap.soft === true && snap.advice.length > 0);
  const rapid = softAttemptPlan(v, { snap: false });
  check(`${label}: Rapid plan PROCEEDS, no still escalation`, rapid.proceed === true && rapid.escalateStill === false);
  check(`${label}: Rapid plan carries focus advice`, rapid.advice.length > 0);
}

// The murkiest labelled vector of all — even IT proceeds: with the
// artwork channel available it may settle there; with every
// channel failing it must produce a full-pipeline honest no-read,
// never a capture+detect-only refusal.
{
  const plan = softAttemptPlan(P1_RECAP, { snap: true });
  check("murkiest vector (4.7): still proceeds", plan.proceed === true);
}

// ---------------------------------------------------------------------------
// 2. NON-SOFT VECTORS — no escalation, no advice, still proceed.
// ---------------------------------------------------------------------------
for (const [label, v] of [
  ["dim-sharp (ladder controls)", DIM_SHARP],
  ["sharp bench", SHARP],
  ["unmeasured", UNMEASURED],
] as const) {
  const plan = softAttemptPlan(v, { snap: true });
  check(`${label}: proceeds`, plan.proceed === true);
  check(`${label}: not soft, no still escalation, no advice`, plan.soft === false && plan.escalateStill === false && plan.advice === "");
}
check("unmeasured never triggers the verdict", burstFocusVerdict(UNMEASURED) === "unmeasured");

// A mixed burst (one readable frame) is not soft — the trigger is
// EVERY measured frame below the floor, as it was in Pass 32.
check("mixed burst [4.7, 12.0, 3.0] is not all-soft", burstFocusVerdict([4.7, SHARPNESS_FLOOR, 3.0]) === "ok");

// ---------------------------------------------------------------------------
// 3. THE ADVICE — attached to failures only, numbers printed, honest
// about the metric (lab reference, real frames score lower).
// ---------------------------------------------------------------------------
{
  const advice = softFocusAdvice(P2_RECAP);
  check("advice prints the measured numbers", advice.includes("11.6") && advice.includes("9.4"));
  check("advice names the lab reference + Take Photo route", advice.includes(String(SHARPNESS_FLOOR)) && advice.includes("Take Photo"));
  check("advice admits real dim frames score lower", advice.includes("real dim frames score lower"));
  check("plan advice === softFocusAdvice(scores)", softAttemptPlan(P2_RECAP, { snap: true }).advice === advice);
}

// ---------------------------------------------------------------------------
// 4. THE LADDER CONVICTS THE OLD GATE: fixtures at/below the floor
// band still read usable — a refusal at 12 threw away real reads.
// (Recorded production reads: tests/harness/results/p32-floor.json,
// probe-p32-floor.ts — production metric + production band + index.)
// ---------------------------------------------------------------------------
{
  const floorData = JSON.parse(readFileSync(new URL("./harness/results/p32-floor.json", import.meta.url), "utf8")) as {
    records: { id: string; sharpness: number; usable: boolean }[];
  };
  const band = floorData.records.filter((r) => r.sharpness >= 10 && r.sharpness < 13);
  check("ladder has dim+soft fixtures in the 10–13 band", band.length >= 4, `${band.length} fixtures`);
  check("some sub-floor-band fixtures READ USABLE (the old gate refused them)", band.some((r) => r.usable),
    band.map((r) => `${r.id}:${r.sharpness}:${r.usable ? "usable" : "fail"}`).join(" "));
  // …and for every one of those fixtures' sharpness, today's plan proceeds.
  for (const r of band) {
    check(`plan proceeds at ladder sharpness ${r.sharpness} (${r.id})`, softAttemptPlan([r.sharpness], { snap: true }).proceed === true);
  }
}

// ---------------------------------------------------------------------------
// 5. CLIP FINDING — the P1 panel-image defect as a printed finding.
// Frame 200×280 (fa ≈ 0.714): a card 0.69 wide needs height ≈ 0.69
// of frame height. A tracked rect materially shorter than that is
// read as-is by the box fallback branches (never aspect-corrected
// at crop time) and clips the card.
// ---------------------------------------------------------------------------
function frame(w = 200, h = 280): HTMLCanvasElement {
  const c = new ShimCanvas();
  c.width = w;
  c.height = h;
  return c as unknown as HTMLCanvasElement;
}
function prep(rect: CardRect | null, origin: PreparedCard["rectOrigin"], f: HTMLCanvasElement): PreparedCard {
  return { card: f, frame: f, source: rect ? "detected" : "guide", rect, rectOrigin: origin, detectMs: 5, detectedRect: null };
}
{
  const f = frame();
  // Card-shaped rect (the rectauthority fixture): no finding.
  const good = prep({ x0: 0.02, y0: 0.06, x1: 0.78, y1: 0.83 }, "frame", f);
  check("card-shaped rect: no clip finding", rectClipFinding(good) === "");
  check("card-shaped rect: describe line unchanged", describePrepRect(good).startsWith("detected (0.02,0.06)-(0.78,0.83)"));
  // Short tracked-fallback rect, headroom above (growth lands
  // mostly on top per correctCardAspect's 70/30 rule).
  const shortTop = prep({ x0: 0.09, y0: 0.20, x1: 0.78, y1: 0.80 }, "tracked-fallback", f);
  const findTop = rectClipFinding(shortTop);
  check("short tracked rect: clip finding fires", findTop.length > 0, findTop);
  check("short tracked rect: finding names the clipped edge", findTop.includes("clip the card's top") || findTop.includes("clip the card's bottom"));
  check("describe appends the finding, prefix intact",
    describePrepRect(shortTop).startsWith("tracked (auto) (0.09,0.20)-(0.78,0.80) · detection missed this frame") && describePrepRect(shortTop).includes("crop may clip"));
  // Short rect hard against the frame top: correction shifts the
  // growth to the BOTTOM edge — the P1 shape (text box cut).
  const shortBottom = prep({ x0: 0.09, y0: 0.02, x1: 0.78, y1: 0.62 }, "tracked-fallback", f);
  const findBottom = rectClipFinding(shortBottom);
  check("top-anchored short rect: finding names the BOTTOM", findBottom.includes("clip the card's bottom"), findBottom);
  // Honest negatives.
  check("no rect: no finding", rectClipFinding(prep(null, "guide", f)) === "");
  check("no prep: no finding", rectClipFinding(null) === "" && rectClipFinding(undefined) === "");
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
