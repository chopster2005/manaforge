// Pass 26 — two panel defects + the duplicate-scan guard.
//
// Provenance (Andrew, 2026-11-10 11:56/11:58 EST, panels
// 1000044672_42_lu3n.jpg + 1000044674_43_7ml6.jpg, Pass 24c build):
//  D1 (Swamp): hand-held capture, straightened card clean, yet BOTH
//     band thumbnails pure uniform white — the burst's fixed title
//     window sat on bright background above the card (rect displaced
//     by texture-slab under-measurement + 70/30 aspect growth), the
//     bottom classified 'band bleached', the title's 2.1s read 'R'.
//     The image channel (multi-hypothesis fingerprints) matched the
//     same displaced rect at d=50. Fix = aimTitleSpec (Pass 18's
//     bottom aim, applied to the standard title window inside
//     ocrTitleBandCapped) — harness-side assertions live in
//     tests/harness/probe-p26-assert.ts; the matcher/guard cores are
//     pinned here.
//  D2 (Eye of Jace, FRA #170): pooled read '1 Eye ol lace To' →
//     top suggestion 'Eye to Eye'. Trace (probe-p26-eye.ts): the
//     fragment-UNION pass promoted Eye to Eye from its per-read best
//     0.755 to 0.980 — its tokens sit verbatim in the read as debris
//     — a margin that would make decideRapidMatch AUTO-ADD the
//     wrong card on an uncontended phone. Fix = union provenance:
//     promotion only when the entry's best token evidence spans ≥2
//     source reads (prefix truncations of one read are that read).
//     Plus the completing treatment (tall-window multi-line read
//     when the burst pool is sub-decisive) in App + harness mirror.
//  D3 (duplicates): "it scanned a couple cards twice by mistake".
//     Measurement (probe-p26-sig.ts): still-seated events (jitter
//     10.2, hand shadow 12.9, torch step 12.1 consecutive diff) cross
//     Pass 22's movement re-arm bound (9) while peaking ≤13.3 vs
//     handled; genuine departures peak ≥49.7, always crossing the
//     change rule. Fix = the movement re-arm path is retired.
//
// Run: bun tests/pass26.test.ts   (from the artifact root)
import { buildNameIndex, matchNamesPooled, ocrCandidates } from "../client/src/lib";
import { RapidMachine, decideRapidMatch, signatureDiff } from "../client/src/rapid";

let failures = 0;
function check(label: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures += 1;
}

// ---------------------------------------------------------------------------
// D2 — the union may not fabricate a score from one read's debris.
// ---------------------------------------------------------------------------
const eyeIndex = buildNameIndex([
  "Eye of Jace",
  "Eye to Eye",
  "Eye of the Storm",
  "Eyes of the Watcher",
  "Jace, the Mind Sculptor",
  "Jace Beleren",
  "Palace Siege",
  "Palace Jailer",
  "Treasure Keeper",
  "Pressure Point",
  "Peer Pressure",
  "Divergent Equation",
  "Divergent Strike",
]);

{
  // The panel pool, exactly as read on-device.
  const m = matchNamesPooled(ocrCandidates(["1 Eye ol lace To"]), eyeIndex, 5);
  const impostor = m.find((x) => x.entry.full === "Eye to Eye");
  const truth = m.find((x) => x.entry.full === "Eye of Jace");
  check("D2 panel pool: impostor keeps its single-read score (no union fabrication)",
    impostor != null && impostor.score <= 0.78,
    `Eye to Eye=${impostor?.score.toFixed(3)}`);
  check("D2 panel pool: Rapid would NOT auto-add the impostor (fabricated 0.98 margin is gone)",
    decideRapidMatch(m) !== "auto",
    `top=${m[0]?.entry.full} ${m[0]?.score.toFixed(3)} vs second=${m[1]?.score.toFixed(3)} decision=${decideRapidMatch(m)}`);
  check("D2 panel pool: the true name is still the runner-up suggestion",
    truth != null && m[1]?.entry.full === "Eye of Jace",
    `Eye of Jace=${truth?.score.toFixed(3)} rank=${m.findIndex((x) => x.entry.full === "Eye of Jace") + 1}`);

  // The completing treatment's clean read, pooled with the debris,
  // wins undiluted (Pass 15 containment, now reachable because the
  // treatment actually runs — see the App/pipeline completing step).
  const m2 = matchNamesPooled(ocrCandidates(["1 Eye ol lace To", "Eye of Jace"]), eyeIndex, 5);
  check("D2 pooled clean read wins at 1.0 over the debris pool",
    m2[0]?.entry.full === "Eye of Jace" && m2[0].score === 1,
    `top=${m2[0]?.entry.full} ${m2[0]?.score.toFixed(3)}`);

  // Eye to Eye's OWN corrupted read must still crown Eye to Eye —
  // the provenance gate discriminates sources, not names.
  const m3 = matchNamesPooled(ocrCandidates(["Eye lo Eye"]), eyeIndex, 5);
  check("D2 Eye to Eye's own read still ranks Eye to Eye first",
    m3[0]?.entry.full === "Eye to Eye",
    `top=${m3[0]?.entry.full} ${m3[0]?.score.toFixed(3)}`);

  // Genuine fragment pooling across two reads still promotes:
  // neither read alone contains both of the true name's tokens.
  const m4 = matchNamesPooled(ocrCandidates(["Divergent ae", "iverson tquation"]), eyeIndex, 5);
  check("D2 cross-read fragments still pool into the true name",
    m4[0]?.entry.full === "Divergent Equation" && m4[0].score >= 0.85,
    `top=${m4[0]?.entry.full} ${m4[0]?.score.toFixed(3)}`);

  // A single half-read still scores by its own evidence (the union
  // gate must not subtract below the per-read value): Treasure
  // Keeper's known-good fragments keep their Rapid auto-accept —
  // the score is the honest per-read 0.701 (the old 0.81 was the
  // union's own inflation of the same evidence), and the margin
  // over Peer Pressure still clears the auto bar.
  const m5 = matchNamesPooled(ocrCandidates(["ressure kecrer"]), eyeIndex, 5);
  check("D2 single-read fragments keep their per-read score + auto-accept",
    m5[0]?.entry.full === "Treasure Keeper" && decideRapidMatch(m5) === "auto",
    `top=${m5[0]?.entry.full} ${m5[0]?.score.toFixed(3)} decision=${decideRapidMatch(m5)}`);
}

// ---------------------------------------------------------------------------
// D3 — a still-seated card cannot re-arm the machine; a genuine
// departure still can. Signatures are uniform 16-cell grids (the
// pass22 sim convention): diff = |a-b| exactly.
// ---------------------------------------------------------------------------
const sig = (v: number) => new Array<number>(16).fill(v);
const EMPTY = sig(200);
const A = sig(100);
const TITLE = sig(120);
const TICK = 250;

function settledMachine(): { m: RapidMachine; tick: (s: number[]) => { action: string }; now: () => number } {
  const m = new RapidMachine();
  m.adoptBaseline(EMPTY);
  let now = 0;
  const tick = (s: number[]) => { now += TICK; return m.sample(s, TITLE, now); };
  // Present A until it scans, then settle it.
  for (let i = 0; i < 10; i++) {
    if (tick(A).action === "scan") break;
  }
  m.notifyResult("success", now);
  return { m, tick, now: () => now };
}

{
  // Blip class (measured peaks: jitter consec 10.2 / scene ≤8.2;
  // hand shadow consec 12.9 / scene 12.9; torch step 12.1): feed
  // oscillations whose CONSECUTIVE diffs exceed the old movement
  // bound (9) but whose scene never departs — no re-scan, ever.
  const { m, tick } = settledMachine();
  let scans = 0;
  for (let i = 0; i < 40; i++) {
    if (tick(sig(i % 2 === 0 ? 112 : 100)).action === "scan") scans += 1;
  }
  check("D3 hand-shadow/jitter blips (consec 12 > old bound 9, scene peak 12) never re-scan a seated card",
    scans === 0 && m.phase === "handled", `scans=${scans} phase=${m.phase}`);
}
{
  // A nudge that re-seats the same card nearby (measured peak 13.3):
  // the scene differs by less than the same-card threshold and the
  // card never left — still handled (a tap re-scans deliberately).
  const { m, tick } = settledMachine();
  let scans = 0;
  for (let i = 0; i < 12; i++) {
    if (tick(sig(113)).action === "scan") scans += 1;
  }
  check("D3 nudged-but-seated card (scene diff 13 < threshold) is not re-scanned",
    scans === 0 && m.phase === "handled", `scans=${scans} phase=${m.phase}`);
}
{
  // Genuine departure + return (Pass 22's movement sim, peak 55 —
  // the measured transit class): re-arms and re-scans promptly.
  const { m, tick, now } = settledMachine();
  const t0 = now();
  tick(sig(155));
  let lat = -1;
  for (let i = 0; i < 6 && lat < 0; i++) {
    if (tick(A).action === "scan") lat = now() - t0;
  }
  check("D3 genuine departure (peak 55) + re-presentation still re-scans ≤1000ms",
    lat >= 0 && lat <= 1000 && m.phase === "busy", `latency=${lat}ms`);
  void signatureDiff;
}

console.log(failures === 0 ? "\nALL PASS 26 TESTS PASSED" : `\n${failures} FAILURES`);
if (failures > 0) process.exit(1);
