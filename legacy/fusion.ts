// Gated fusion engine (full scanner rework, Stage 2) — PURE logic,
// unit-tested in tests/fusion.test.ts.
//
// The rework makes IMAGE recognition the primary channel, with the
// title-OCR pool and the self-aimed bottom collector-number read as
// fusion channels. The decision order per attempt (all inside the
// existing deadline machinery in App.tsx):
//
//   (a) The image channel produces ranked candidates + measured
//       pHash distances (finder.ts rankReferences + imageGateVerdict).
//   (b) DISTANCE GATE: a candidate is DECISIVE only under the
//       absolute gate AND the runner-up margin gate; otherwise the
//       image channel ABSTAINS (candidates remain evidence, never a
//       verdict). The Pass 18 failure — ungated fusion settling on
//       Way of the Thief at d=48 on a generic shared token — is
//       impossible here by construction: 48 > IMAGE_GATE_DIST, and
//       corroboration is only ever consulted AFTER the gate.
//   (c) FUSION matrix (fuseChannels):
//       - number hit (exact printing) → settles as today; the image
//         channel never overrides a printed number.
//       - image decisive + corroboration → settle, Rapid auto-add
//         eligible on the STANDARD bar (Pass 21 Item B — the
//         Saheeli defect: a decisive image match whose own channels
//         agreed with it was demoted to a tap because corroboration
//         was only ever read off the weakest channel).
//       - image decisive alone → settles in BOTH modes on the image
//         channel's own authority (Pass 23 Item A — the user's rule:
//         "90% should be accepted… if the image matches high 90%").
//         Pass 21 still demoted an UNCORROBORATED decisive verdict
//         in Rapid to a tap unless it cleared a stricter solo bar
//         (≤30 / margin ≥12); on the user's Kavu Scout the OCR
//         channel produced only garbage from empty/bleached bands,
//         so corroboration could never fire and three decisive
//         verdicts (d=50 band → d=42 → d=40) produced zero
//         auto-adds. The decisive rule itself (d ≤ 44 + margin ≥ 8)
//         is the rule that measured 145 true / 0 false settles on
//         the device-class calibration set, so it now carries
//         Rapid auto-add alone. Garbage/absent OCR no longer
//         vetoes; a DECISIVE OCR read naming a DIFFERENT card
//         still conflicts (the interlock below is unchanged).
//       - image in the CORROBORATION BAND (Pass 21 Item A: distances
//         between the decisive ceiling and the evidence ceiling —
//         where real device captures of the TRUE card land, and
//         where raw distance alone cannot separate them from
//         impostors) → settles ONLY with corroboration: a STRONG
//         source (the OCR matcher's own top pick is this card, or
//         the bottom line is consistent with a printing of it)
//         settles in both modes; a WEAK source (meaningful title
//         tokens) settles Snap only, Rapid presents.
//       - OCR decisive + image agrees (same name, any gate state)
//         → settle via OCR (the pre-rework happy path, unchanged).
//       - OCR decisive + image decisive for a DIFFERENT name →
//         CONFLICT: no auto-add in either mode; both names surface
//         in Did-you-mean with the conflict visible. This is the
//         anti-wrong-card interlock. A band-tier image match joins
//         the conflict ONLY on strong bottom-line corroboration —
//         band distance alone never vetoes a decisive title read.
//         PASS 24c: against a DECISIVE image verdict the OCR side
//         must additionally be CLEAN (cleanNameVerdict — the pooled
//         read actually spelled the winner's full name out); a
//         fuzzy suggestion manufactured from garbage tokens is
//         logged as noise and the image verdict settles solo.
//       - OCR decisive + image abstains/present-only → settle via
//         OCR (the floor: everything that passed before the rework
//         still passes — the image channel can only ADD wins and
//         BLOCK wrong auto-adds on a genuine gated disagreement).
//       - neither decisive, image in-gate or in-band → present the
//         image candidate as the top suggestion.
//       - neither → abstain (the caller's existing uncertain /
//         no-read judgement proceeds untouched).
//
//   CORROBORATION (Pass 21 Item B) — an image top-1 is corroborated
//   when another channel independently agrees on the SAME name:
//     (i)   title tokens: the pooled OCR fragments contain
//           MEANINGFUL token overlap with the candidate name — a
//           token of ≥4 letters, or ≥2 distinct name tokens. A
//           single short shared token ("way") is NOT meaningful:
//           it is exactly what let the Pass 18 prototype's ungated
//           fusion settle on Way of the Thief.
//     (ii)  matcher-top: the pooled OCR matcher's own top
//           suggestion IS the candidate (the system's channels
//           converged on one card by independent routes).
//     (iii) bottom: the collector-line evidence is consistent with
//           a printing of the candidate (the caller scores the
//           pooled bottom text against the candidate's printings).
//   Strength at the band tier: (iii) is STRONG alone (a printed
//   line is hard evidence); (ii) is STRONG only together with (i)
//   — a fragment pool can crown a wrong card top by itself (the
//   A3 shape), so the matcher's pick needs the pool to also carry
//   the name's distinctive fragments; (i) alone is WEAK. At the
//   decisive tier any single source corroborates.
//   (d) PRINTING selection lives with the caller: when the winning
//       name's best printing also clears its own margin inside the
//       candidate (finder RankedCandidate.printingMargin), the art
//       match pins the printing; shared-art printings fall back to
//       number > set evidence > default, and diagnostics say which.

import {
  IMAGE_BAND_DIST,
  IMAGE_BAND_MARGIN,
  IMAGE_DEGRADED_MARGIN,
  IMAGE_GATE_DIST,
  IMAGE_GATE_MARGIN,
  IMAGE_RAPID_SOLO_DIST,
  IMAGE_RAPID_SOLO_MARGIN,
  type RankedCandidate,
} from "./finder";
import { nameContainedInPooled, nameTokens, normalizeName } from "./lib";

export interface FusionImageInput {
  /** Name-level ranked image candidates (best first); empty when
   * the image channel produced nothing usable. */
  ranked: RankedCandidate[];
}

export interface FusionOcrInput {
  /** The pooled title matcher's top name, or null. */
  topName: string | null;
  /** The pooled top score (0–1), 0 when no pool exists. */
  topScore: number;
  /** Whether the mode's own bar calls the OCR pool decisive
   * (Rapid: decideRapidMatch auto; Snap: ≥ 0.82). */
  decisive: boolean;
  /** PASS 24c: whether that decisive verdict rests on CLEAN
   * evidence (lib.ts cleanNameVerdict — a complete verbatim
   * containment of the winner's full name in the pooled read, or
   * the ≥1.5×-margin + containment pooled shape). A decisive-but-
   * UNCLEAN verdict is a fuzzy suggestion the matcher manufactured
   * from debris: it still settles on the OCR floor when nothing
   * contradicts it, but it may NOT raise a conflict against a
   * decisive image verdict (the Massacre Girl defect — garbage
   * title tokens crowned 'Shatterwing Pegasus' and vetoed a
   * decisive d=30 artwork match). When absent, fuseChannels
   * derives the containment core from pooledTexts itself, so the
   * guarantee holds for every caller. */
  cleanDecisive?: boolean;
  /** Every pooled OCR candidate string — the raw material for the
   * corroboration token check. */
  pooledTexts: string[];
  /** Corroboration source (iii): the caller scored the pooled
   * bottom-line text against the image top-1's printings and found
   * it consistent with one of them (set/number/artist salvage win).
   * Computed by the caller because it needs the printings fetch;
   * false when the bottom line was absent, unreadable, or pointed
   * at a different card. */
  bottomConsistent?: boolean;
}

export type FusionOutcome =
  | { kind: "settle-image"; candidate: RankedCandidate; corroborated: boolean }
  | { kind: "settle-ocr"; name: string }
  | { kind: "conflict"; imageCandidate: RankedCandidate; ocrName: string; channel: "title" | "number" }
  | { kind: "present-image"; candidate: RankedCandidate }
  | { kind: "abstain" };

const STOPWORDS = new Set(["the", "of", "and", "a", "an", "to"]);

/**
 * Does the pooled OCR text corroborate a candidate name with
 * MEANINGFUL token overlap (Pass 21 Item B, source (i))? Pass 19's
 * rule — any single ≥3-letter non-stopword token — is what let the
 * Pass 18 prototype settle on Way of the Thief: the token "way" is
 * shared by dozens of names and evidences none of them. Meaningful
 * overlap is: a name token of ≥4 letters present in the pool
 * ("mind", "sculptor", "swamp" — distinctive fragments), OR ≥2
 * distinct name tokens present (two short fragments agreeing is
 * evidence; one is a coincidence). This is evidence OF the name in
 * the title read — never a score.
 */
export function ocrCorroborates(candidateName: string, pooledTexts: string[]): boolean {
  const pooled = new Set(
    pooledTexts.flatMap((t) => nameTokens(normalizeName(t))),
  );
  let shortHits = 0;
  for (const tok of nameTokens(normalizeName(candidateName))) {
    if (tok.length < 3 || STOPWORDS.has(tok) || !pooled.has(tok)) continue;
    if (tok.length >= 4) return true;
    shortHits += 1;
    if (shortHits >= 2) return true;
  }
  return false;
}

export type CorroborationSource = "token" | "matcher-top" | "bottom";

/** The corroboration verdict for one image top-1: which independent
 * channels agree on the SAME name, and whether the agreement is
 * STRONG enough to carry the corroboration BAND (where raw
 * distance cannot separate true matches from impostors):
 *  - bottom (iii) is strong alone: a printed collector line that
 *    fits this card's printings is hard, independent evidence.
 *  - matcher-top (ii) is strong only WITH token support (i): a
 *    fragment pool can crown a wrong card by itself — that is
 *    precisely the Pass 18 A3 shape (fragments of Way of the Mind
 *    Sculptor ranking Way of the Thief top) — so the matcher's
 *    top pick counts at band tier only when the pool ALSO carries
 *    the name's own distinctive fragments. At the DECISIVE tier
 *    any single source corroborates (the image evidence there is
 *    already strong; agreement is a bonus, not the separator).
 * Merely WEAK corroboration = token fragments alone. */
export interface Corroboration {
  corroborated: boolean;
  strong: boolean;
  sources: CorroborationSource[];
}

export function corroborationFor(
  candidateName: string,
  input: { pooledTexts: string[]; ocrTopName: string | null; bottomConsistent?: boolean },
): Corroboration {
  const sources: CorroborationSource[] = [];
  if (ocrCorroborates(candidateName, input.pooledTexts)) sources.push("token");
  if (input.ocrTopName != null && input.ocrTopName === candidateName) sources.push("matcher-top");
  if (input.bottomConsistent) sources.push("bottom");
  return {
    corroborated: sources.length > 0,
    strong:
      sources.includes("bottom") ||
      (sources.includes("matcher-top") && sources.includes("token")),
    sources,
  };
}

/** Gate tier of an image top-1 (Pass 21 Item A two-tier rule):
 * "decisive" inside the solo ceiling + margin; "band" inside the
 * corroboration band (settles only with Item B corroboration);
 * "none" beyond the evidence ceiling. */
export type ImageTier = "decisive" | "band" | "none";

/** Image-channel gate state for one ranked list. `soloStrict` is
 * retained as a DIAGNOSTIC only (the Pass 19 stricter bar): since
 * Pass 23 Item A it no longer gates anything — a decisive verdict
 * settles on its own authority in both modes. */
export function imageGateState(ranked: RankedCandidate[]): {
  top: RankedCandidate | null;
  margin: number;
  decisive: boolean;
  soloStrict: boolean;
  tier: ImageTier;
} {
  const top = ranked[0] ?? null;
  if (!top) return { top: null, margin: 0, decisive: false, soloStrict: false, tier: "none" };
  const second = ranked[1];
  const margin = second ? second.dist.combined - top.dist.combined : Number.POSITIVE_INFINITY;
  const decisive = top.dist.combined <= IMAGE_GATE_DIST && margin >= IMAGE_GATE_MARGIN;
  const soloStrict =
    top.dist.combined <= IMAGE_RAPID_SOLO_DIST && margin >= IMAGE_RAPID_SOLO_MARGIN;
  const tier: ImageTier = decisive
    ? "decisive"
    : top.dist.combined <= IMAGE_BAND_DIST && margin >= IMAGE_BAND_MARGIN
      ? "band"
      : "none";
  return { top, margin, decisive, soloStrict, tier };
}

/**
 * DISPLAY HONESTY (Pass 23 Item A): the score a PRESENTED image
 * candidate carries in the Did-you-mean list — i.e. the "% match"
 * the user reads. Before Pass 23 every presented image candidate
 * was hardcoded to 0.90, so the UI called a candidate "90% match"
 * in the same breath as refusing to auto-add it (the user's Kavu
 * Scout panels, verbatim). The mapping is now gate-aligned:
 *  - a DECISIVE candidate scores 0.90 — and decisive candidates
 *    settle/auto-add, so a 90% entry can only ever appear as the
 *    image side of a CONFLICT (where a decisive title read named
 *    a different card and the user genuinely must choose);
 *  - a BAND candidate (45–56, settles only with agreement) scores
 *    below the auto-add class, sliding 0.86 → 0.72 across the
 *    band — visibly a suggestion, never "high 90%";
 *  - anything beyond the evidence ceiling is not presented.
 */
export function imageSuggestionScore(candidate: RankedCandidate, opts?: { degradedBlocked?: boolean }): number {
  const gate = imageGateState([candidate]);
  // Pass 23 Item B: a decisive candidate on a DIM capture that the
  // degraded guard demoted to a presentation must not wear the
  // 0.90 auto-add class either — it scores at the top of the band
  // slide instead. (Conflicts pass no flag: there the 0.90 marks a
  // genuine two-claim choice.)
  if (gate.tier === "decisive") return opts?.degradedBlocked ? 0.86 : 0.9;
  if (gate.tier === "band") {
    const t = (candidate.dist.combined - IMAGE_GATE_DIST) / Math.max(1, IMAGE_BAND_DIST - IMAGE_GATE_DIST);
    return Math.round((0.86 - 0.14 * Math.min(1, Math.max(0, t))) * 100) / 100;
  }
  return 0.6;
}

/** PASS 23 (Item B fix) — the collector-number interlock. A printed
 * collector number is exact-printing evidence, but the matrix
 * convicted a wrong-settle class: at small/blurry sizes the bottom
 * line's digits garble into a REAL foreign (set, number) pair
 * (Lightning Bolt's line misread as a Midnight Hunt pair, Last
 * Gasp's as a TRC pair), and the number rescue short-circuited
 * BEFORE fusion — settling the wrong card in cells where the image
 * channel was simultaneously DECISIVE for the true card (d=22–26,
 * margins 14–18). Rule: when the image top-1 is decisive and names
 * a DIFFERENT card than the number hit, the hit does not settle —
 * the scan presents a conflict, exactly like a decisive title read
 * contradicting a decisive image verdict. In every other case
 * (image absent, abstaining, band-tier, or agreeing) the printed
 * number settles as before. */
export function numberHitInterlock(
  numberName: string,
  ranked: RankedCandidate[],
): "conflict" | "settle" {
  const top = ranked[0];
  if (!top) return "settle";
  if (top.name === numberName) return "settle";
  return imageGateState(ranked).tier === "decisive" ? "conflict" : "settle";
}

/** PASS 24c — ONE shared wording for a conflict, used by the panel's
 * evidence header AND implied by the image line's CONFLICT text, so
 * the two can never name different channels again (the Massacre
 * Girl panel's header blamed the collector number while its gate
 * line blamed the title read — both were describing the number
 * branch, mislabeled). The channel comes from the same conflict
 * object the fusion outcome carries. */
export function conflictEvidenceLine(channel: "title" | "number"): string {
  return channel === "number"
    ? "image + collector number disagree — pick the card"
    : "image + title disagree — pick the card";
}

/**
 * The fusion decision. `rapid` selects the Rapid etiquette — since
 * Pass 23 Item A the only etiquette difference left is the band
 * tier's weak-corroboration rule (Snap may settle on title
 * fragments alone; Rapid presents). A DECISIVE image verdict
 * settles in both modes on its own authority. Pure: the caller
 * resolves the winning NAME to a card afterwards (and applies the
 * printing rules); this function only decides WHICH channel's
 * verdict the attempt takes.
 */
export function fuseChannels(input: {
  image: FusionImageInput;
  ocr: FusionOcrInput;
  rapid: boolean;
  /** Pass 23 Item B: the capture metered DIM (or crushed) — the
   * degraded population the matrix convicted (dim × blur colour-
   * twin impostors inside the decisive gate at margins 8–10).
   * On a dim capture a decisive verdict must ALSO clear
   * IMAGE_DEGRADED_MARGIN and, when burst frames measured it, a
   * cross-frame median inside the decisive ceiling; otherwise the
   * candidate is presented, not settled. Absent/false = a clean
   * capture, where the Item A rule stands exactly as shipped. */
  captureDim?: boolean;
}): FusionOutcome {
  const gate = imageGateState(input.image.ranked);
  const ocr = input.ocr;
  const ocrName = ocr.topName;
  const corr = gate.top
    ? corroborationFor(gate.top.name, {
        pooledTexts: ocr.pooledTexts,
        ocrTopName: ocrName,
        bottomConsistent: ocr.bottomConsistent,
      })
    : { corroborated: false, strong: false, sources: [] as CorroborationSource[] };

  // OCR decisive + image for a DIFFERENT name → conflict interlock,
  // when the image disagreement is itself strong: decisive tier, or
  // band tier with bottom-line corroboration for the other card
  // (the printed line naming a different card outright is a genuine
  // disagreement; band distance alone is not). Same name is
  // agreement, handled below.
  //
  // PASS 24c — a conflict against a DECISIVE image verdict
  // additionally requires the title verdict to be CLEAN
  // (cleanNameVerdict, computed by the caller; derived here from
  // pooled-text containment when the caller didn't supply it). The
  // Massacre Girl panel: pooled title garbage crowned a fuzzy
  // suggestion ('Shatterwing Pegasus') that the old branch treated
  // as a decisive contradiction of a d=30 margin-∞ image verdict.
  // Debris-derived names are noise, never a conflict — the image
  // verdict then settles on its own authority below. The band +
  // bottom branch is unchanged: there the printed line's agreement
  // with the image candidate is itself the hard evidence, and the
  // interlock protects the OCR floor, not the image verdict.
  const ocrClean =
    ocr.cleanDecisive ??
    (ocrName ? nameContainedInPooled(ocrName, ocr.pooledTexts) : false);
  if (
    ocr.decisive && ocrName && gate.top && gate.top.name !== ocrName &&
    ((gate.decisive && ocrClean) || (gate.tier === "band" && corr.sources.includes("bottom")))
  ) {
    return { kind: "conflict", imageCandidate: gate.top, ocrName, channel: "title" };
  }

  // Image decisive.
  if (gate.decisive && gate.top) {
    // Pass 23 Item A — the user's rule: a DECISIVE image verdict
    // settles on the image channel's OWN authority in both modes.
    // Corroboration is still RECORDED (the panel names it when the
    // channels agreed) but it is no longer a requirement, and the
    // Pass 19 stricter solo bar (≤30 / margin ≥12) no longer gates
    // Rapid: that second bar is what left the user's Kavu Scout
    // un-auto-added at d=40/d=42 with a decisive gate verdict,
    // because its OCR channel yields only garbage from bleached
    // bands and corroboration could therefore never fire. The
    // decisive rule (d ≤ IMAGE_GATE_DIST + margin ≥
    // IMAGE_GATE_MARGIN) measured 145 true / 0 false settles on
    // the device-class set — it is the acceptance rule, alone.
    // What still blocks an auto-add: a DECISIVE OCR read naming a
    // different card (the conflict interlock above), and the
    // 45–56 band below, which keeps its agreement requirement.
    //
    // PASS 23 (Item B) — DEGRADED-CAPTURE GUARD: on a capture that
    // meters dim, the decisive population is contaminated (matrix:
    // every image wrong-settle was a dim cell; the impostors sat
    // at margins 8–10 and/or cross-frame medians 46–50). A dim
    // decisive must clear the higher margin AND be stable across
    // the burst (median inside the ceiling, when measured). This
    // is not a second acceptance bar of the Pass 19 kind — it does
    // not apply to clean captures at all, and the user's decisive
    // panels (bright box light, margin ∞) are untouched by it.
    if (input.captureDim) {
      const median = gate.top.medianDist;
      // PASS 34 — the stability leg arbitrates CONTESTED verdicts
      // only. Ranked lists are name-level, so a margin of ∞ means
      // the channel proposed exactly ONE name: there is no rival
      // candidate for cross-frame instability to be evidence FOR,
      // and an unstable median then says only "the frames were
      // soft" — which the panel already knows. Every matrix-
      // convicted dim impostor sat at a FINITE margin (8–10) with
      // the true card as its runner-up, while all three on-device
      // margin-∞ demotions were the TRUE card (Tome Blast d=36,
      // Last Gasp d=42, Retrieve the Esper d=44 — the last settled
      // as "no plausible name" in Snap after its verdict arrived
      // past the consult; see the App's late consult). The margin
      // leg is unchanged: a contested dim decisive still needs
      // margin ≥ IMAGE_DEGRADED_MARGIN, and a contested unstable
      // one still presents.
      const stable = median == null || median <= IMAGE_GATE_DIST || !Number.isFinite(gate.margin);
      if (!(gate.margin >= IMAGE_DEGRADED_MARGIN && stable)) {
        return { kind: "present-image", candidate: gate.top };
      }
    }
    return { kind: "settle-image", candidate: gate.top, corroborated: corr.corroborated };
  }

  // Image in the corroboration band (Pass 21 Item A): raw distance
  // in this range cannot separate the true card from impostors, so
  // the band settles ONLY on corroboration — STRONG agreement (see
  // corroborationFor) in both modes; a WEAK token source settles
  // Snap only and is presented in Rapid, never auto-added.
  if (gate.tier === "band" && gate.top) {
    if (corr.strong) return { kind: "settle-image", candidate: gate.top, corroborated: true };
    // WEAK corroboration = title fragments alone. (Matcher-top
    // alone is deliberately NOT weak-settleable either: unsupported
    // by the pool's own fragments, a matcher crown is the A3 trap,
    // not agreement — it falls through to present below.)
    if (!input.rapid && corr.sources.includes("token")) {
      return { kind: "settle-image", candidate: gate.top, corroborated: true };
    }
  }

  // OCR decisive and the image channel does not strongly disagree
  // (abstain / present-only / agrees) → the OCR floor.
  if (ocr.decisive && ocrName) {
    return { kind: "settle-ocr", name: ocrName };
  }

  // Nothing decisive: an in-gate or in-band image candidate is
  // still the best suggestion the attempt has.
  if (gate.top && gate.tier !== "none") {
    return { kind: "present-image", candidate: gate.top };
  }

  return { kind: "abstain" };
}

/** How the image channel's proposal stage ended (Pass 20). Pass 19
 * collapsed EVERY failure into "no candidates (channel produced
 * nothing usable)", which made a dead channel indistinguishable from
 * a genuine no-match on the user's screenshots. Each state below is
 * a different branch with a different remedy, and the panel prints
 * them distinctly (see describeImageChannelOutcome). */
export type ImageChannelStatus =
  /** Ranked candidates with measured distances exist. */
  | "ok"
  /** The identifyByImage action call itself failed (threw / errored). */
  | "call-failed"
  /** The call exceeded its budget with no answer (Pass 19's defect:
   * the 3.5s race cap sat below the measured 4.8–8.0s round trip, so
   * this fired on 100% of attempts while printing as "no candidates"). */
  | "call-timeout"
  /** The service answered with zero Scryfall-verified proposals. */
  | "no-proposals"
  /** Proposals arrived but no reference image could be fingerprinted,
   * so no distance could be measured and nothing may settle by image. */
  | "no-references"
  /** The dewarped card image could not even be encoded to send. */
  | "encode-failed";

/** The image channel's full result shape for diagnostics: the ranked
 * candidates (when any), the proposal-stage status, the names the
 * service proposed, and how long the proposal call took. */
export interface ImageChannelDiag {
  status: ImageChannelStatus;
  proposed: string[];
  visionMs: number;
}

/**
 * One-line diagnostics for the image channel, printed verbatim in
 * the "What the scanner read" panel. When candidates were measured,
 * this is the distance/gate/outcome line; otherwise it names the
 * exact stage that produced nothing — call failed, timed out (with
 * the seconds waited), 0 proposals, or proposals that could not be
 * verified against reference images — so one screenshot localises
 * the channel's health without guesswork.
 */
export function describeImageChannelOutcome(
  diag: ImageChannelDiag,
  ranked: RankedCandidate[],
  outcome: FusionOutcome | null,
  opts: { rapid?: boolean } = {},
): string {
  if (ranked.length > 0) return describeImageChannel(ranked, outcome, opts);
  switch (diag.status) {
    case "call-timeout":
      return `timed out — the image service gave no answer within ${(diag.visionMs / 1000).toFixed(1)}s; the title/number reads carried this scan`;
    case "call-failed":
      return "call failed — the image service returned an error; the title/number reads carried this scan";
    case "encode-failed":
      return "couldn't prepare the straightened card image to send; the title/number reads carried this scan";
    case "no-proposals":
      return "0 proposals — the artwork was not recognised";
    case "no-references":
      return `${diag.proposed.length} proposal${diag.proposed.length === 1 ? "" : "s"} (${diag.proposed.join(", ")}) — 0 verified: the reference images could not be read, so no distance could be measured`;
    case "ok":
      return "0 proposals — the artwork was not recognised";
  }
}

/** The image line for an attempt whose image channel never
 * reported before the attempt settled (Pass 21, the Cadet panel:
 * the panel carried NO image line and no straightened thumbnail at
 * all, so the screenshot could not distinguish "channel not
 * composed into this path" from "result arrived after settlement
 * and was discarded"). From Pass 21 the line exists on EVERY
 * panel: finish() and the watchdog snapshot substitute this text
 * whenever no channel outcome was ever published. */
export const IMAGE_NOT_RUN_LINE = "not run (attempt settled before the image channel reported)";

/** The image line an attempt must carry: its real published
 * outcome when the channel reported, otherwise the explicit
 * not-run line — never an empty string. */
export function ensureImageLine(published: string): string {
  return published.trim() ? published : IMAGE_NOT_RUN_LINE;
}

/** One-line diagnostics for the image channel, printed verbatim in
 * the "What the scanner read" panel: top candidate, its measured
 * distance split, the gate verdict, and the fusion outcome. Pass 23:
 * a Rapid settle BY IMAGE says "→ auto-added" (the user's rule —
 * the panel must name the acceptance it performed), and a
 * multi-frame consensus whose best and median distances disagree
 * wildly says so (frame instability is evidence about the capture,
 * not something to hide). */
export function describeImageChannel(
  ranked: RankedCandidate[],
  outcome: FusionOutcome | null,
  opts: { rapid?: boolean; captureDim?: boolean } = {},
): string {
  const top = ranked[0];
  if (!top) return "no candidates";
  const gate = imageGateState(ranked);
  const gateText = gate.decisive
    ? `gate: decisive (d=${top.dist.combined} ≤ ${IMAGE_GATE_DIST}, margin ${gate.margin === Number.POSITIVE_INFINITY ? "∞" : gate.margin} ≥ ${IMAGE_GATE_MARGIN})`
    : gate.tier === "band"
      ? `gate: corroboration band (d=${top.dist.combined} ≤ ${IMAGE_BAND_DIST}) — settles only with title/bottom agreement`
      : top.dist.combined <= IMAGE_BAND_DIST
        ? `gate: present only (margin ${gate.margin} < ${IMAGE_BAND_MARGIN})`
        : `gate: abstain (d=${top.dist.combined} > ${IMAGE_BAND_DIST})`;
  const second = ranked[1];
  const list = ranked
    .slice(0, 3)
    .map((c) => `${c.name} d=${c.dist.combined} (art ${c.dist.art} + card ${c.dist.card})`)
    .join(" · ");
  const instability =
    top.medianDist != null && top.frameSpread != null && top.medianDist - top.dist.combined >= 10
      ? ` · frames unstable (best d=${top.dist.combined}, median d=${top.medianDist} across ${top.framesSeen ?? "?"} frames)`
      : top.framesSeen != null && top.framesSeen > 1
        ? ` · best of ${top.framesSeen} frames`
        : "";
  const outcomeText = outcome
    ? outcome.kind === "settle-image"
      ? opts.rapid
        ? ` → auto-added${outcome.corroborated ? " (image + corroboration)" : " by image"}`
        : ` → settled by image${outcome.corroborated ? " + corroboration" : ""}`
      : outcome.kind === "conflict"
        ? ` → CONFLICT with ${outcome.channel === "number" ? "collector number" : "title read"} “${outcome.ocrName}” — not auto-added`
        : outcome.kind === "present-image"
          ? opts.captureDim && gate.decisive
            ? " → presented as top suggestion (not auto-added — dim capture: decisive needs margin ≥ 12 and stable frames)"
            : " → presented as top suggestion (not auto-added)"
          : outcome.kind === "settle-ocr"
            ? " → title read settled (image did not disagree)"
            : " → abstained"
    : "";
  return `${list}${second ? "" : ""} · ${gateText}${instability}${outcomeText}`;
}
