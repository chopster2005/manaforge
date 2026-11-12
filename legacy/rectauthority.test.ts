// Pass 16: rect authority — an attempt must never read the guide rect
// when a fresh successful detection exists. Covers applyRectAuthority
// (sibling rescue, last-detection rescue, expiry, no-op honesty) and
// describePrepRect (the diagnostics line a failure screenshot carries).
// Run: bun tests/rectauthority.test.ts   (from the artifact root)
import { installGlobals, ShimCanvas } from "./harness/canvas";
import type { CardRect, PreparedCard } from "../client/src/detect";

installGlobals();

const {
  applyRectAuthority,
  describePrepRect,
  LAST_DETECTION_RESCUE_MS,
} = await import("../client/src/detect");

let failures = 0;
function check(label: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures += 1;
}

const CARD_RECT: CardRect = { x0: 0.02, y0: 0.06, x1: 0.78, y1: 0.83 };
const SIBLING_RECT: CardRect = { x0: 0.03, y0: 0.07, x1: 0.79, y1: 0.84 };

function frame(): HTMLCanvasElement {
  const c = new ShimCanvas();
  c.width = 200;
  c.height = 280;
  return c as unknown as HTMLCanvasElement;
}
function guidePrep(f: HTMLCanvasElement): PreparedCard {
  return { card: f, frame: f, source: "guide", rect: null, rectOrigin: "guide", detectMs: 5 };
}
function detectedPrep(f: HTMLCanvasElement, rect: CardRect = SIBLING_RECT): PreparedCard {
  return { card: f, frame: f, source: "detected", rect, rectOrigin: "frame", detectMs: 5 };
}

// 1. Sibling rescue: a mixed burst [guide, detected, guide] — the
// guide frames are re-cropped from their OWN frames with the sibling's
// rect; the detected frame is untouched (same object).
{
  const f1 = frame(), f2 = frame(), f3 = frame();
  const det = detectedPrep(f2);
  const out = applyRectAuthority([guidePrep(f1), det, guidePrep(f3)], null, 10_000);
  check("sibling: detected frame untouched", out[1] === det);
  check("sibling: guide frames re-cropped as detected", out[0]?.source === "detected" && out[2]?.source === "detected");
  check("sibling: rect is the sibling rect", out[0]?.rect === SIBLING_RECT && out[2]?.rect === SIBLING_RECT);
  check("sibling: origin labelled burst-sibling", out[0]?.rectOrigin === "burst-sibling" && out[2]?.rectOrigin === "burst-sibling");
  check("sibling: re-crop comes from the frame's own pixels", out[0]?.card !== f1 && out[0]?.frame === f1);
}

// 2. Last-detection rescue (the convicted pattern): every burst frame
// fell back to the guide, but the scanner holds a fresh detection —
// all frames are re-cropped with it.
{
  const now = 50_000;
  const out = applyRectAuthority([guidePrep(frame()), guidePrep(frame()), guidePrep(frame())], { rect: CARD_RECT, at: now - 4_000 }, now);
  check("last-detection: all frames rescued", out.every((p) => p.source === "detected" && p.rect === CARD_RECT));
  check("last-detection: origin labelled", out.every((p) => p.rectOrigin === "last-detection"));
}

// 3. Expiry: a detection older than the rescue window does NOT rescue
// — the genuine no-detection case keeps the honest guide fallback
// (same array back, still guide).
{
  const now = 50_000;
  const preps = [guidePrep(frame()), guidePrep(frame())];
  const out = applyRectAuthority(preps, { rect: CARD_RECT, at: now - LAST_DETECTION_RESCUE_MS - 1 }, now);
  check("expiry: stale detection does not rescue", out === preps && out.every((p) => p.source === "guide"));
  const edge = applyRectAuthority([guidePrep(frame())], { rect: CARD_RECT, at: now - LAST_DETECTION_RESCUE_MS }, now);
  check("expiry: exactly at the window edge still rescues", edge[0]?.source === "detected");
}

// 4. No authority anywhere: null last detection + all-guide burst →
// unchanged (empty-tray honesty: the guide fallback still settles
// as no-card downstream).
{
  const preps = [guidePrep(frame())];
  const out = applyRectAuthority(preps, null, 1_000);
  check("no authority: burst unchanged", out === preps && out[0]?.source === "guide");
}

// 5. Sibling beats last-detection (per-attempt evidence is fresher),
// and a fully-detected burst is returned untouched.
{
  const now = 50_000;
  const out = applyRectAuthority([guidePrep(frame()), detectedPrep(frame())], { rect: CARD_RECT, at: now - 100 }, now);
  check("authority order: sibling rect wins over last detection", out[0]?.rect === SIBLING_RECT && out[0]?.rectOrigin === "burst-sibling");
  const all = [detectedPrep(frame()), detectedPrep(frame())];
  check("fully detected: returned as-is", applyRectAuthority(all, null, now) === all);
}

// 6. Diagnostics wording: every origin names itself + the rect coords;
// the guide fallback says plainly there was no detection.
{
  const base = detectedPrep(frame(), CARD_RECT);
  check("describe: frame", describePrepRect(base).startsWith("detected (0.02,0.06)-(0.78,0.83)"));
  check("describe: retained", describePrepRect({ ...base, rectOrigin: "retained-frame" }).includes("frame: retained"));
  check("describe: burst-sibling", describePrepRect({ ...base, rectOrigin: "burst-sibling" }).includes("sibling"));
  check("describe: last-detection", describePrepRect({ ...base, rectOrigin: "last-detection" }).includes("last preview detection"));
  // Pass 24a re-pin: a calibration read is now labelled as what it
  // is — the tracker SEED/fallback (the tracked rect is the working
  // position whenever a fresh one exists; see tests/tracking.test.ts).
  check("describe: calibration", describePrepRect({ ...base, source: "calibration", rectOrigin: "calibration" }).startsWith("calibration (seed) (0.02,0.06)"));
  check("describe: guide", describePrepRect(guidePrep(frame())).startsWith("guide fallback"));
  check("describe: no prep", describePrepRect(null).startsWith("guide fallback"));
  check("rescue window covers an attempt cycle (>=8s)", LAST_DETECTION_RESCUE_MS >= 8_000, `${LAST_DETECTION_RESCUE_MS}ms`);
}

console.log(failures === 0 ? "\nALL RECTAUTHORITY TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
