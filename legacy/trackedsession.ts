// Pass 24a, Item A — BOX SESSION: continuous tracking vs the static
// calibration, on synthetic rig frames.
//
// A box session of 6 cards. Card 1 sits at the seat the user
// calibrated on (once, at session start — the only manual
// calibration in either arm). Cards 2–6 seat with the user's
// measured per-card variance (±3–6% of frame height). Each card gets
// 2 preview frames + a 3-frame burst; the attempt reads the burst
// head, as the app does. Frames carry the rig's signature defects:
// a long box-shadow gradient over the card top (raw detection y0
// sd ~0.02, range ~0.07 — the class tests/harness/probe-jitter.ts
// measured on the user's real rig at sd 0.034 / range 0.077),
// sensor noise, and ±4% exposure swings.
//
//  - BASELINE arm: the pre-24a call shape — static calibration +
//    Pass 18 recentRects stabilisation, fed exactly as the old App
//    fed it (read rects via noteDetection semantics).
//  - TRACKED arm: the Pass 24a call shape — the tracker seeded from
//    the same calibration, fed every frame's own detection, its
//    fresh rect offered to every prepare.
//
// Per attempt: read origin, centre error vs the card's TRUE rect,
// and whether the title row lands inside the read crop's title
// window. Degraded = title outside the window OR centre error > 5%.
// Results persist to results/p24a-tracked-session.json.
// Run: bun tests/harness/trackedsession.ts
import { writeFileSync } from "node:fs";
import { installGlobals, ShimCanvas } from "./canvas";
import type { CardRect, TrackedRectState } from "../../client/src/detect";

installGlobals();

const {
  prepareCardFromFrame,
  detectInCanvas,
  correctCardAspect,
  expandRect,
  seedTrackedRect,
  observeTrackedRect,
  freshTrackedRect,
} = await import("../../client/src/detect");

// ---- synthetic rig frames (the tracking suite's scene) ----------------------
const W = 350;
const H = 490;
const CARD = { x0: 95, x1: 255, h: 196 };
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function frame(cardY: number, bright: number, seed: number): HTMLCanvasElement {
  const rand = rng(seed);
  const softTop = 6 + (seed % 8) * 14;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 232;
      if (x >= CARD.x0 && x < CARD.x1 && y >= cardY && y < cardY + CARD.h) {
        const inTitle = y < cardY + CARD.h * 0.12;
        const block = ((x >> 2) + (y >> 2)) % 2 === 0 ? 34 : -34;
        const glyph = inTitle && x % 3 === 0 ? 70 : 0;
        v = Math.max(0, Math.min(255, 90 + block + glyph));
        if (x === CARD.x0 || x === CARD.x1 - 1 || y === cardY + CARD.h - 1) v = 25;
        const depth = y - cardY;
        if (depth < softTop) v = 232 + (v - 232) * (depth / softTop);
      }
      v += (rand() + rand() - 1) * 12;
      const i = (y * W + x) * 4;
      const b = Math.max(0, Math.min(255, Math.round(v * bright)));
      rgba[i] = b; rgba[i + 1] = b; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
  }
  return ShimCanvas.fromRGBA(W, H, rgba) as unknown as HTMLCanvasElement;
}

const truthRect = (seatY: number): CardRect => ({
  x0: CARD.x0 / W, y0: seatY / H, x1: CARD.x1 / W, y1: (seatY + CARD.h) / H,
});
const centreErr = (a: CardRect, b: CardRect): number =>
  Math.hypot((a.x0 + a.x1) / 2 - (b.x0 + b.x1) / 2, (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
/** Where the card's title-row centre lands inside the read crop
 * (fractions of the crop). The standard band spans 0.025–0.11; the
 * rescue windows reach ~0.19. Contained = inside [0.005, 0.13]. */
const titleCropFrac = (seatY: number, rect: CardRect): number => {
  const titleFrac = (seatY + CARD.h * 0.07) / H;
  return (titleFrac - rect.y0) / Math.max(0.01, rect.y1 - rect.y0);
};

// The calibration the user records once, from a typical rig frame
// of card 1 (exactly what calibrateBox stores: detection → aspect →
// expand). A typical frame carries the same shadow bias as every
// other detection in the box — which is precisely why the static
// calibration can "agree" with biased detections at the old seat
// while a displaced card goes unread.
const CAL_SEAT = 150;
const calDet = detectInCanvas(frame(CAL_SEAT, 1, 11) as never);
if (!calDet) throw new Error("calibration frame must detect");
const calibration: CardRect = expandRect(correctCardAspect(calDet.rect, W / H), 0.015);

/** ORACLE per seat: the read a crisp, shadow-free frame of that
 * seat produces (boxMode off — pure detection). The synthetic
 * scene's aspect correction overshoots the shadowed top in BOTH
 * arms identically, so an attempt is judged against the oracle's
 * geometry, not the drawn card's: degraded = the attempt's title
 * position deviates from the oracle's by more than a band tolerance
 * (0.045 of crop height) OR its centre deviates by > 5% of frame. */
const oracleAt = (seatY: number): { rect: CardRect; titleFrac: number } => {
  const p = prepareCardFromFrame(frame(seatY, 1, 8), { boxMode: false, calibration: null });
  if (!p.rect) throw new Error("oracle frame must detect");
  return { rect: p.rect, titleFrac: titleCropFrac(seatY, p.rect) };
};

const SEATS = [150, 170, 134, 176, 128, 165]; // deltas: 0, +4.1%, −3.3%, +5.3%, −4.5%, +3.1%
const JIT = [0, 2, -2, 1, -1];
const BRT = [1, 0.98, 1.03, 0.97, 1.02];

interface AttemptRec {
  card: number;
  seatDeltaPct: number;
  origin: string;
  centreErr: number;
  /** Centre error vs the seat's ORACLE rect (the selection error). */
  oracleErr: number;
  titleCropFrac: number | null;
  titleDev: number | null;
  degraded: boolean;
  staleCalibrationRead: boolean;
}

function runSession(arm: "baseline" | "tracked"): AttemptRec[] {
  const recs: AttemptRec[] = [];
  let tracker: TrackedRectState | null = arm === "tracked" ? seedTrackedRect(calibration, 0) : null;
  const history: { rect: CardRect; at: number }[] = [];
  let now = 0;
  SEATS.forEach((seat, ci) => {
    let attempt: AttemptRec | null = null;
    for (let f = 0; f < 5; f++) {
      now += 250;
      const fr = frame(seat + (JIT[f] ?? 0), BRT[f] ?? 1, 1000 + ci * 37 + f * 3);
      const prep = arm === "tracked"
        ? prepareCardFromFrame(fr, { boxMode: true, calibration, trackedRect: freshTrackedRect(tracker, now) })
        : prepareCardFromFrame(fr, {
            boxMode: true,
            calibration,
            recentRects: history.filter((e) => now - e.at <= 3000).map((e) => e.rect),
          });
      if (arm === "tracked" && prep.detectedRect) tracker = observeTrackedRect(tracker, prep.detectedRect, now);
      if (arm === "baseline" && prep.rect) {
        history.push({ rect: prep.rect, at: now });
        while (history.length > 8) history.shift();
      }
      if (f === 2 && prep.rect) {
        // Burst head — the frame the app reads its bands from.
        const truth = truthRect(seat);
        const oracle = oracleAt(seat);
        const err = centreErr(prep.rect, truth);
        const oErr = centreErr(prep.rect, oracle.rect);
        const tf = titleCropFrac(seat, prep.rect);
        const tDev = Math.abs(tf - oracle.titleFrac);
        const deltaPct = Math.abs(seat - CAL_SEAT) / H;
        attempt = {
          card: ci + 1,
          seatDeltaPct: Math.round(deltaPct * 1000) / 10,
          origin: prep.rectOrigin,
          centreErr: Math.round(err * 1000) / 1000,
          oracleErr: Math.round(oErr * 1000) / 1000,
          titleCropFrac: Math.round(tf * 1000) / 1000,
          titleDev: Math.round(tDev * 1000) / 1000,
          degraded: tDev > 0.045 || oErr > 0.05,
          staleCalibrationRead: prep.rectOrigin === "calibration" && deltaPct >= 0.03,
        };
      }
    }
    if (attempt) recs.push(attempt);
  });
  return recs;
}

const baseline = runSession("baseline");
const tracked = runSession("tracked");
const summarise = (recs: AttemptRec[]) => ({
  attempts: recs.length,
  degraded: recs.filter((r) => r.degraded).length,
  staleCalibrationReads: recs.filter((r) => r.staleCalibrationRead).length,
  origins: recs.reduce<Record<string, number>>((m, r) => ({ ...m, [r.origin]: (m[r.origin] ?? 0) + 1 }), {}),
  meanCentreErrVsTruth: Math.round((recs.reduce((a, r) => a + r.centreErr, 0) / Math.max(1, recs.length)) * 1000) / 1000,
  meanOracleErr: Math.round((recs.reduce((a, r) => a + r.oracleErr, 0) / Math.max(1, recs.length)) * 1000) / 1000,
  worstOracleErr: Math.max(...recs.map((r) => r.oracleErr)),
});
const out = {
  scene: "synthetic rig frames (long box-shadow gradient; per-card seats ±3–6% of frame height; calibration recorded once on card 1)",
  calibration,
  baseline: { summary: summarise(baseline), attempts: baseline },
  tracked: { summary: summarise(tracked), attempts: tracked },
  manualRecalibrations: { baseline: 0, tracked: 0 },
};
writeFileSync(new URL("./results/p24a-tracked-session.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("BASELINE (static calibration):", JSON.stringify(out.baseline.summary));
for (const r of baseline) console.log(`  card ${r.card} seatΔ ${r.seatDeltaPct}% origin=${r.origin} oracleErr=${r.oracleErr} titleDev=${r.titleDev}${r.degraded ? " DEGRADED" : ""}${r.staleCalibrationRead ? " STALE-CALIB-READ" : ""}`);
console.log("TRACKED (continuous tracking):", JSON.stringify(out.tracked.summary));
for (const r of tracked) console.log(`  card ${r.card} seatΔ ${r.seatDeltaPct}% origin=${r.origin} oracleErr=${r.oracleErr} titleDev=${r.titleDev}${r.degraded ? " DEGRADED" : ""}${r.staleCalibrationRead ? " STALE-CALIB-READ" : ""}`);

const failures: string[] = [];
if (tracked.some((r) => r.degraded)) failures.push("tracked arm degraded on at least one card");
if (tracked.some((r) => r.staleCalibrationRead)) failures.push("tracked arm read the stale calibration for a displaced card");
if (!(baseline.some((r) => r.degraded || r.staleCalibrationRead) || out.baseline.summary.meanOracleErr > out.tracked.summary.meanOracleErr)) {
  failures.push("baseline arm showed NO pathology — the scene failed to reproduce the user's conditions");
}
console.log(failures.length === 0 ? "\nTRACKED SESSION: PASS" : `\nTRACKED SESSION: FAIL — ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
