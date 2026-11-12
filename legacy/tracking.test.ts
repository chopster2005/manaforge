// Pass 24a, Item A — CONTINUOUS TRACKING (the user's model: the box
// scanner keeps calibrating itself; a new card sliding in re-locks
// the tracker; the stored calibration is only a seed/fallback).
//
//  - Pure tracker units: seed confirmation/replacement, median
//    stability under rig-class jitter, the two-sample re-lock (one
//    far glitch never moves the lock), freshness.
//  - prepareCardFromFrame integration on synthetic rig frames (the
//    stabilise suite's scene with a long box-shadow gradient — raw
//    detection y0 range ~0.07, the class probe-jitter measured on
//    the user's real rig): tracked reads, displaced-card reads from
//    the CURRENT detection, detection-miss fallback to the tracked
//    rect, and the legacy path intact when no tracker is offered.
// Run: bun tests/tracking.test.ts   (from the artifact root)
import { installGlobals, ShimCanvas } from "./harness/canvas";
import type { CardRect } from "../client/src/detect";

installGlobals();

const {
  prepareCardFromFrame,
  describePrepRect,
  seedTrackedRect,
  observeTrackedRect,
  freshTrackedRect,
  maxEdgeDelta,
  TRACK_FRESH_MS,
  TRACK_RELOCK_EDGE,
} = await import("../client/src/detect");

let failures = 0;
function check(label: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures += 1;
}

const SEAT_A: CardRect = { x0: 0.20, y0: 0.30, x1: 0.80, y1: 0.90 };
const SEAT_B: CardRect = { x0: 0.21, y0: 0.36, x1: 0.81, y1: 0.96 }; // ~6% lower — the next seat over
const SEAT_C: CardRect = { x0: 0.20, y0: 0.43, x1: 0.80, y1: 1.00 }; // 13% lower — unambiguously a new presentation
const jitter = (r: CardRect, dx: number, dy: number): CardRect => ({ x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy });

// ---- pure tracker ----------------------------------------------------------
{
  const seed = seedTrackedRect(SEAT_A, 1000);
  check("seed: holds the calibration, marked seeded", seed.seeded && seed.rect === SEAT_A);
  check("fresh: a fresh seed is offered", freshTrackedRect(seed, 1000) === SEAT_A);
  check("fresh: a stale lock is NOT offered", freshTrackedRect(seed, 1000 + TRACK_FRESH_MS + 1) === null);
  check("fresh: null state offers nothing", freshTrackedRect(null, 0) === null);
  check("relock edge constant sane", TRACK_RELOCK_EDGE > 0.05 && TRACK_RELOCK_EDGE < 0.15, `${TRACK_RELOCK_EDGE}`);

  const confirmed = observeTrackedRect(seed, jitter(SEAT_A, 0.005, 0.01), 1100);
  check("seed + agreeing detection: lock confirmed, unseeded", !confirmed.seeded && maxEdgeDelta(confirmed.rect, SEAT_A) < 0.01);

  const replaced = observeTrackedRect(seed, SEAT_B, 1100);
  check("seed + disagreeing detection: seed replaced outright", !replaced.seeded && replaced.rect === SEAT_B && replaced.samples.length === 1);

  const fromNull = observeTrackedRect(null, SEAT_A, 0);
  check("no state + detection: locks onto it", !fromNull.seeded && fromNull.rect === SEAT_A);
}

// Median stability: a jitter stream around one seat must not drag
// the lock around (the calibration-flipping disease, cured).
{
  let s = observeTrackedRect(null, SEAT_A, 0);
  const offs = [[0.01, 0.03], [-0.01, -0.03], [0.02, 0.05], [-0.02, -0.05], [0.01, 0.02], [-0.01, -0.02], [0, 0]];
  offs.forEach(([dx, dy], i) => { s = observeTrackedRect(s, jitter(SEAT_A, dx!, dy!), 100 * (i + 1)); });
  check("jitter stream: lock stays within 0.015 of the seat", maxEdgeDelta(s.rect, SEAT_A) <= 0.015, `rect=${JSON.stringify(s.rect)}`);
}

// Re-lock discipline: ONE far sample is a glitch suspect; TWO far
// samples that agree with each other are a presentation.
{
  let s = observeTrackedRect(null, SEAT_A, 0);
  s = observeTrackedRect(s, SEAT_A, 100);
  const lockBefore = s.rect;
  const glitch = observeTrackedRect(s, SEAT_C, 200);
  check("one far sample: lock does NOT move", maxEdgeDelta(glitch.rect, lockBefore) === 0 && glitch.pendingFar === SEAT_C);
  const backNear = observeTrackedRect(glitch, jitter(SEAT_A, 0.01, 0.01), 300);
  check("far sample then near sample: pending cleared, no re-lock", backNear.pendingFar === null && maxEdgeDelta(backNear.rect, SEAT_A) < 0.02);
  const first = observeTrackedRect(s, jitter(SEAT_C, -0.01, 0.01), 400);
  const second = observeTrackedRect(first, jitter(SEAT_C, 0.01, -0.01), 500);
  check("two agreeing far samples: re-locked onto the new seat", second.pendingFar === null && maxEdgeDelta(second.rect, SEAT_C) < 0.02, `rect=${JSON.stringify(second.rect)}`);
}

// ---- synthetic rig frames ---------------------------------------------------
const W = 350;
const H = 490;
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
/** The stabilise scene with a LONG box-shadow gradient over the card
 * top (softTop up to ~104px): raw detections jitter at rig class. */
function frame(cardY: number | null, bright: number, seed = 7): HTMLCanvasElement {
  const rand = rng(seed);
  const softTop = 6 + (seed % 8) * 14;
  const rgba = new Uint8Array(W * H * 4);
  const card = cardY === null ? null : { x0: 95, y0: cardY, x1: 255, y1: cardY + 196 };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 232;
      if (card && x >= card.x0 && x < card.x1 && y >= card.y0 && y < card.y1) {
        const inTitle = y < card.y0 + (card.y1 - card.y0) * 0.12;
        const block = ((x >> 2) + (y >> 2)) % 2 === 0 ? 34 : -34;
        const glyph = inTitle && x % 3 === 0 ? 70 : 0;
        v = Math.max(0, Math.min(255, 90 + block + glyph));
        if (x === card.x0 || x === card.x1 - 1 || y === card.y1 - 1) v = 25;
        const depth = y - card.y0;
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

const SEAT_A_Y = 150;
const SEAT_B_Y = 190; // +40px ≈ +8.2% of frame height — a new card seated clearly lower
const cleanRectAt = (y: number): CardRect => {
  const p = prepareCardFromFrame(frame(y, 1, 8), { boxMode: false, calibration: null });
  if (!p.rect) throw new Error("clean frame must detect");
  return p.rect;
};
const calibration = cleanRectAt(SEAT_A_Y);
const cleanB = cleanRectAt(SEAT_B_Y);

// A box session: seed from the calibration, preview frames feed the
// tracker exactly as the App's wrapper does, then attempts read.
{
  let tracker = seedTrackedRect(calibration, 0);
  let now = 0;
  let lastOffered: CardRect | null = null;
  const feed = (f: HTMLCanvasElement): ReturnType<typeof prepareCardFromFrame> => {
    now += 250;
    lastOffered = freshTrackedRect(tracker, now);
    const prep = prepareCardFromFrame(f, {
      boxMode: true,
      calibration,
      trackedRect: lastOffered,
    });
    if (prep.detectedRect) tracker = observeTrackedRect(tracker, prep.detectedRect, now);
    return prep;
  };
  // Preview ticks on card A (jittered samples).
  for (let i = 0; i < 4; i++) feed(frame(SEAT_A_Y + [0, 2, -2, 1][i]!, [1, 0.98, 1.03, 1][i]!, 20 + i));
  const attemptA = feed(frame(SEAT_A_Y, 1, 30));
  check("session: attempt on the tracked card reads the TRACKED rect", attemptA.rectOrigin === "tracked" && attemptA.rect === lastOffered, `origin=${attemptA.rectOrigin}`);
  check("session: tracked rect sits at the card's seat", maxEdgeDelta(tracker.rect, calibration) < 0.03, `delta=${maxEdgeDelta(tracker.rect, calibration).toFixed(3)}`);

  // Card B slides in ~5% lower. The FIRST frame at the new seat is
  // read from its own detection (the position NOW, tracker not yet
  // re-locked); after the confirming sample the tracker has moved.
  const firstB = feed(frame(SEAT_B_Y, 1, 40));
  check("session: first frame of a new card reads its own detection", firstB.rectOrigin === "frame" && firstB.rect !== null && maxEdgeDelta(firstB.rect, cleanB) < 0.04, `origin=${firstB.rectOrigin}`);
  // The slide settles over the next preview ticks (~1s of watcher /
  // preview samples): far samples that agree with each other confirm
  // the re-lock. (Two samples CAN be too jittered to confirm each
  // other — the lock then converges a tick later; attempts meanwhile
  // read the current detection, as firstB did.)
  feed(frame(SEAT_B_Y - 2, 0.99, 41));
  feed(frame(SEAT_B_Y + 2, 1.02, 43));
  feed(frame(SEAT_B_Y, 1, 44));
  const attemptB = feed(frame(SEAT_B_Y, 1, 42));
  check("session: tracker re-locked onto the new card — attempt reads tracked", attemptB.rectOrigin === "tracked" && maxEdgeDelta(attemptB.rect!, cleanB) < 0.035, `origin=${attemptB.rectOrigin} delta=${attemptB.rect ? maxEdgeDelta(attemptB.rect, cleanB).toFixed(3) : "null"}`);
  check("session: no calibrationStale nag under tracking", !attemptA.calibrationStale && !attemptB.calibrationStale);

  // A frame whose detection misses entirely (empty tray pixels in
  // the burst): the read falls back to the tracked position, NOT
  // the static calibration.
  now += 250;
  const miss = prepareCardFromFrame(frame(null, 1, 50), {
    boxMode: true,
    calibration,
    trackedRect: freshTrackedRect(tracker, now),
  });
  check("detection miss: falls back to the TRACKED rect, not the seed", miss.rectOrigin === "tracked-fallback" && miss.rect === tracker.rect, `origin=${miss.rectOrigin}`);

  // And with the tracker stale, the seed is the honest fallback.
  const stale = prepareCardFromFrame(frame(null, 1, 51), {
    boxMode: true,
    calibration,
    trackedRect: freshTrackedRect(tracker, now + TRACK_FRESH_MS + 1),
  });
  check("stale tracker + detection miss: seed fallback, labelled calibration", stale.rectOrigin === "calibration" && stale.rect === calibration, `origin=${stale.rectOrigin}`);
}

// Legacy path intact: no tracked rect offered → the pre-24a rule.
{
  const agree = prepareCardFromFrame(frame(SEAT_A_Y, 1, 8), { boxMode: true, calibration });
  check("no tracker offered: calibration still read when detection agrees", agree.rectOrigin === "calibration");
}

// Diagnostics honesty: every Pass 24a origin names itself.
{
  const base = prepareCardFromFrame(frame(SEAT_A_Y, 1, 8), { boxMode: false, calibration: null });
  const mk = (rectOrigin: never) => ({ ...base, rectOrigin });
  check("describe: tracked", describePrepRect(mk("tracked" as never)).startsWith("tracked (auto) ("));
  check("describe: tracked-fallback names the fallback", describePrepRect(mk("tracked-fallback" as never)).includes("last tracked position"));
  check("describe: calibration is the seed", describePrepRect(mk("calibration" as never)).startsWith("calibration (seed) ("));
}

console.log(failures === 0 ? "\nALL TRACKING TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
