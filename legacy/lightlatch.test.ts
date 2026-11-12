// Pass 24a, Item B — STEADY LIGHT. The Auto hardware light is
// decided by a latch (autolight.ts), not by raw metering ticks:
//  - HYSTERESIS: metering oscillating around the old single
//    threshold (p90 = 150 — where engaging the light brightens the
//    metered zone and the old code flipped off again, the user's
//    "heartbeat") produces ZERO state changes inside the hysteresis
//    band;
//  - ONE APPLICATION PER ATTEMPT: an attempt's decision is made at
//    its start and latched — preview steps during the attempt can
//    never mutate its light state;
//  - DWELL: even full dark↔bright swings cannot flip the state
//    faster than one change per LIGHT_DWELL_MS;
//  - the capture retry's anonymous exposure raise is registered, so
//    a later release can restore it (and the dwell protects it).
// Run: bun tests/lightlatch.test.ts   (from the artifact root)

import type { LightLatchState } from "../client/src/autolight";

const {
  createLightLatch,
  stepLightLatch,
  beginAttemptLight,
  endAttemptLight,
  noteExternalLightApplication,
  lightEvidence,
  LIGHT_ENGAGE_P90,
  LIGHT_RELEASE_P90,
  LIGHT_DWELL_MS,
} = await import("../client/src/autolight");

let failures = 0;
function check(label: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures += 1;
}

/** Fold a series of preview steps, counting hardware applications. */
function runSteps(state: LightLatchState, p90s: number[], startMs: number, stepMs: number): { state: LightLatchState; applications: number } {
  let applications = 0;
  let s = state;
  p90s.forEach((p90, i) => {
    const step = stepLightLatch(s, p90, startMs + i * stepMs);
    s = step.state;
    if (step.action) applications += 1;
  });
  return { state: s, applications };
}

// Evidence bands: the hysteresis window straddles the old threshold.
{
  check("evidence: clearly dim engages", lightEvidence(LIGHT_ENGAGE_P90 - 1) === "dark");
  check("evidence: engage boundary is neutral", lightEvidence(LIGHT_ENGAGE_P90) === "neutral");
  check("evidence: the old 150 threshold is neutral", lightEvidence(150) === "neutral");
  check("evidence: release boundary is bright", lightEvidence(LIGHT_RELEASE_P90) === "bright");
  check("evidence: hysteresis band is wide", LIGHT_RELEASE_P90 - LIGHT_ENGAGE_P90 >= 30, `${LIGHT_ENGAGE_P90}..${LIGHT_RELEASE_P90}`);
}

// THE HEARTBEAT, reproduced and cured: metering oscillating around
// the old threshold every 500ms for a minute — the pre-latch code
// applied a change on nearly every crossing; the latch never fires.
{
  const osc: number[] = [];
  for (let i = 0; i < 120; i++) osc.push(i % 2 === 0 ? 138 : 166);
  const { state, applications } = runSteps(createLightLatch(), osc, 0, 500);
  check("oscillation around the old threshold: ZERO applications", applications === 0, `applications=${applications}`);
  check("oscillation: state never engaged", state.dark === false);
}
{
  // Same oscillation, but the latch starts ENGAGED (a dark scene lit
  // the torch; the torch's own light pushes metering to ~160): the
  // old code released at once and pulsed; the latch holds.
  const engaged = beginAttemptLight(createLightLatch(), 60, 0).state;
  const ended = endAttemptLight(engaged);
  const osc: number[] = [];
  for (let i = 0; i < 120; i++) osc.push(i % 2 === 0 ? 155 : 172);
  const { state, applications } = runSteps(ended, osc, 10_000, 500);
  check("engaged + self-lit metering oscillation: ZERO releases", applications === 0 && state.dark === true, `applications=${applications}`);
}

// Engage once, then steady dark: exactly one application.
{
  const { state, applications } = runSteps(createLightLatch(), [90, 80, 95, 70, 88], 0, 800);
  check("steady dark scene: engages exactly once", applications === 1 && state.dark === true, `applications=${applications}`);
}

// Dwell: a genuine bright swing 1s after engaging cannot release;
// after the dwell it releases exactly once.
{
  let s = stepLightLatch(createLightLatch(), 80, 0).state; // engaged at t=0
  const early = stepLightLatch(s, 230, 1000);
  check("dwell: bright swing inside the dwell is refused", early.action === null && early.state.dark === true);
  const late = stepLightLatch(s, 230, LIGHT_DWELL_MS + 500);
  check("dwell elapsed: releases exactly once", late.action === "release" && late.state.dark === false);
  const again = stepLightLatch(late.state, 230, LIGHT_DWELL_MS + 1000);
  check("steady bright after release: no repeat application", again.action === null);
}

// Full swings at 1Hz for 30s: flips are dwell-spaced, never a pulse.
{
  let s = createLightLatch();
  let applications = 0;
  let lastAt = -Infinity;
  let minGap = Infinity;
  for (let i = 0; i < 30; i++) {
    const step = stepLightLatch(s, i % 2 === 0 ? 70 : 240, i * 1000);
    s = step.state;
    if (step.action) {
      applications += 1;
      minGap = Math.min(minGap, i * 1000 - lastAt);
      lastAt = i * 1000;
    }
  }
  check("1Hz full swings: applications are dwell-spaced", applications >= 2 && applications <= 8 && minGap >= LIGHT_DWELL_MS, `applications=${applications} minGap=${minGap}`);
}

// ONE APPLICATION PER ATTEMPT: decision at attempt start; preview
// steps during the attempt are strict no-ops whatever they meter.
{
  let applications = 0;
  const begin = beginAttemptLight(createLightLatch(), 70, 0);
  if (begin.action) applications += 1;
  check("attempt start in the dark: engages once, latched dark", begin.action === "engage" && begin.dark === true && begin.state.attemptDark === true);
  let s = begin.state;
  for (let i = 0; i < 10; i++) {
    const step = stepLightLatch(s, 240, 500 + i * 300); // sun comes out mid-attempt
    s = step.state;
    if (step.action) applications += 1;
  }
  check("during the attempt: preview metering changes NOTHING", applications === 1 && s.dark === true, `applications=${applications}`);
  s = endAttemptLight(s);
  check("attempt end: latch released, state persists", s.attemptDark === null && s.dark === true);
  const after = stepLightLatch(s, 240, LIGHT_DWELL_MS + 1000);
  check("after the attempt (+dwell): the bright scene releases once", after.action === "release");
}

// Attempt start respects the dwell too: a flip 1s after the last
// application is refused — the attempt runs with the held state
// (its software lift, computed from its own metering, is separate).
{
  const engaged = stepLightLatch(createLightLatch(), 70, 0).state; // engaged at t=0
  const begin = beginAttemptLight(engaged, 240, 1000);
  check("attempt start inside dwell: no flip, attempt inherits the held state", begin.action === null && begin.dark === true);
  const beginLater = beginAttemptLight(endAttemptLight(begin.state), 240, LIGHT_DWELL_MS + 1);
  check("attempt start after dwell: decision applies", beginLater.action === "release" && beginLater.dark === false);
}

// Neutral evidence at attempt start holds the applied state.
{
  const begin = beginAttemptLight(createLightLatch(), 155, 0);
  check("attempt start with neutral metering: no application, holds current", begin.action === null && begin.dark === false && begin.state.attemptDark === false);
}

// The capture retry's raise is registered: it counts as the applied
// state (a later release restores it) and starts the dwell (the
// attempt-start decision cannot immediately undo it).
{
  let s = noteExternalLightApplication(createLightLatch(), true, 2000);
  check("external application registered as the applied state", s.dark === true && s.sinceMs === 2000);
  const begin = beginAttemptLight(s, 240, 2500);
  check("retry raise protected by dwell at attempt start", begin.action === null && begin.dark === true);
  const release = stepLightLatch(endAttemptLight(begin.state), 240, 2000 + LIGHT_DWELL_MS + 1);
  check("after dwell, a bright scene releases (restores) the retry's raise", release.action === "release");
}

// First decision always applies immediately (no dwell debt at birth).
{
  const step = stepLightLatch(createLightLatch(), 60, 123);
  check("first dark decision applies at once", step.action === "engage" && step.state.sinceMs === 123);
}

console.log(failures === 0 ? "\nALL LIGHTLATCH TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
