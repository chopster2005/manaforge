// Printing-level candidate selection for the image channel
// (Pass 25, Item 2a) — PURE logic, unit-tested in
// tests/pass25.test.ts.
//
// THE DEFECT THIS REPLACES (Item 1, reproduced in
// tests/harness/probe-printings.ts): the image channel fingerprinted
// printings.slice(0, 8) of the released-desc list — the 8 NEWEST
// printings — as a name's entire candidate set. A basic land has
// hundreds of printings (Swamp: 930), so the true printing was
// essentially never among the candidates: all six real Swamp #274
// printings sit at released-desc ranks 61..176+, outside even the
// 60-printing list the slice is taken from. The art winner was then
// whichever of the wrong 8 happened to be nearest, and when no art
// pin fired the settle recorded Scryfall's named-endpoint default
// (for Swamp: MDD #296 — the exact printing Andrew reported).
//
// THE RULE: the candidate set is built from the attempt's own
// BOTTOM-LINE EVIDENCE. The printings the printed line points at —
// exact (set, number) pairs resolved by lookup, and list printings
// matching the read set code / number / artist — are guaranteed a
// place in the set, ahead of the generic newest-8 fill. With no
// bottom evidence the selection is exactly the old behaviour (the
// default printing + the first 8 of the list), so the happy path
// for ordinary cards is unchanged.
//
// Cost: at most REFERENCE_MAX_TOTAL printings per proposed name
// (vs 8 before), i.e. up to +8 reference-image loads per name on
// evidence-bearing attempts only — the loads are parallel and the
// phase already runs inside the fusion wait envelope.

import { artistMatchesBottomText } from "./lib";

export interface SelectablePrinting {
  scryfallId: string;
  setCode: string;
  collectorNumber: string;
  artist: string;
  /** Pass 27: treatment flags (Scryfall full_art / border_color),
   * optional so pre-Pass-27 callers and fixtures keep working.
   * Drive the full-art diversity fill below. */
  fullArt?: boolean;
  borderColor?: string;
}

export interface NumberCandidateLike {
  setCode: string;
  collectorNumber: string;
}

/** Printings fingerprinted per proposed name with NO bottom
 * evidence — the pre-Pass-25 behaviour, kept as the base fill. */
export const REFERENCE_BASE_COUNT = 8;
/** Hard cap on the enlarged candidate set per name. */
export const REFERENCE_MAX_TOTAL = 16;
/** A name with at least this many printings is "high-count" for
 * honesty purposes: a default printing recorded for it is a guess
 * among many, and the scan list says so (Pass 25 Item 2c). Most
 * ordinary cards sit far below it; the five basic lands sit at
 * 300–900+. */
export const HIGH_PRINTING_COUNT = 12;

/** PASS 27 — full-art diversity slots inside the reference cap.
 * The measurement (tests/harness/probe-p27-fullart.ts): with NO
 * bottom evidence, the shipped field for "Swamp" was the default
 * (MDD 296) + the newest 8 — a field containing TRK 314 but NOT
 * Andrew's FRA 390 (released-desc rank 10 of 887), so the
 * fingerprint honestly picked the nearest of the wrong field and
 * recorded a Star Trek printing for a Reality Fracture card. With
 * FRA 390 IN the field it wins every device degradation class by
 * ≥10 over any different-set full-art rival: the fingerprint was
 * never the problem — the field was. So for high-count names the
 * selection reserves up to this many slots for the newest
 * full-art/borderless printing of each DISTINCT set in the list,
 * so every recent full-art treatment is actually in the race when
 * the bottom line gives no evidence. Ordinary names (no full-art
 * printings in the list, or below the high-count bar) are
 * untouched. */
export const FULL_ART_DIVERSITY_SLOTS = 4;

export function isHighPrintingCount(printingCount: number): boolean {
  return printingCount >= HIGH_PRINTING_COUNT;
}

/** Collector-number equality tolerant of zero padding ("0274" vs
 * "274") and case; variant suffixes ("274a") must match exactly. */
export function sameCollectorNumber(a: string, b: string): boolean {
  const na = a.trim().toLowerCase();
  const nb = b.trim().toLowerCase();
  if (na === nb) return true;
  const digits = (s: string) => (/^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : null);
  const da = digits(na);
  const db = digits(nb);
  return da !== null && db !== null && da === db;
}

const sameSet = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Choose which printings of one name get fingerprinted this attempt.
 *
 * @param printings  The name's printings list (released-desc, the
 *                   ≤60 the getPrintings action returns).
 * @param opts.baseId  Scryfall id of the name's DEFAULT printing
 *                   (what a name-only settle would record) — always
 *                   included when present in the list.
 * @param opts.exactPrintings  Printings resolved by exact
 *                   (set, number) lookups against the bottom-line
 *                   candidates — these may live OUTSIDE the list
 *                   entirely (an older set's #274 is not in the 60
 *                   newest) and are the strongest evidence there is.
 * @param opts.candidates  The bottom line's plausible (set, number)
 *                   pairs, in corroboration order.
 * @param opts.bottomText  The pooled bottom text (artist source).
 *
 * Priority under the cap: exact-pair printings → the default →
 * the newest-8 base fill → (Pass 27) full-art diversity (newest
 * full-art printing per unrepresented set, high-count names, max
 * FULL_ART_DIVERSITY_SLOTS) → set+artist matches → number+artist
 * matches → set-only matches (max 2). The artist line breaks ties
 * throughout: among printings sharing a set or a number, the ones
 * whose artist the bottom line actually read go first (the general
 * rule for Item 2d — a basic's same-set printings are usually
 * different artists, and the printed artist is on the card).
 */
export function selectReferencePrintings<T extends SelectablePrinting>(
  printings: readonly T[],
  opts: {
    baseId?: string;
    exactPrintings?: readonly T[];
    candidates?: readonly NumberCandidateLike[];
    bottomText?: string;
    baseCount?: number;
    maxTotal?: number;
  } = {},
): T[] {
  const baseCount = opts.baseCount ?? REFERENCE_BASE_COUNT;
  const maxTotal = opts.maxTotal ?? REFERENCE_MAX_TOTAL;
  const candidates = opts.candidates ?? [];
  const bottomText = opts.bottomText ?? "";
  const out: T[] = [];
  const seen = new Set<string>();
  const push = (p: T | undefined): boolean => {
    if (!p || seen.has(p.scryfallId) || out.length >= maxTotal) return out.length >= maxTotal;
    seen.add(p.scryfallId);
    out.push(p);
    return out.length >= maxTotal;
  };
  const full = () => out.length >= maxTotal;

  const matchesPair = (p: SelectablePrinting, c: NumberCandidateLike) =>
    sameSet(p.setCode, c.setCode) && sameCollectorNumber(p.collectorNumber, c.collectorNumber);
  const artistOk = (p: SelectablePrinting) =>
    bottomText.trim().length > 0 && artistMatchesBottomText(bottomText, p.artist);

  // (1) Exact-pair printings: resolved lookups first (they may be
  // outside the list), then list members matching a candidate pair.
  for (const p of opts.exactPrintings ?? []) { if (push(p)) return out; }
  for (const c of candidates) {
    for (const p of printings) {
      if (matchesPair(p, c) && push(p)) return out;
    }
  }
  // (2) The default printing — the settle's fallback and a legit
  // candidate in its own right.
  if (opts.baseId) {
    if (push(printings.find((p) => p.scryfallId === opts.baseId))) return out;
  }
  // (3) The newest-N base fill (the pre-Pass-25 set).
  for (const p of printings.slice(0, baseCount)) { if (push(p)) return out; }
  if (full()) return out;
  // (3b) PASS 27 — full-art diversity (see FULL_ART_DIVERSITY_SLOTS):
  // high-count names only; the newest full-art/borderless printing
  // of each set not already represented in the selection, in list
  // (released-desc) order, up to the slot budget. Runs with or
  // without bottom evidence — it repairs the NO-evidence field,
  // and with evidence the exact/matching fills below still get
  // their say inside the remaining cap.
  if (isHighPrintingCount(printings.length)) {
    const represented = new Set(out.map((p) => p.setCode.toLowerCase()));
    let slots = FULL_ART_DIVERSITY_SLOTS;
    for (const p of printings) {
      if (slots <= 0) break;
      if (seen.has(p.scryfallId)) continue;
      if (!(p.fullArt === true || p.borderColor === "borderless")) continue;
      if (represented.has(p.setCode.toLowerCase())) continue;
      represented.add(p.setCode.toLowerCase());
      slots -= 1;
      if (push(p)) return out;
    }
  }
  if (full()) return out;
  // (4) Set code + artist agree (the number garbled but the set and
  // the artist line read clean — the FRA basic shape).
  const candSets = new Set(candidates.map((c) => c.setCode.toLowerCase()));
  if (candSets.size > 0 && bottomText.trim()) {
    for (const p of printings) {
      if (candSets.has(p.setCode.toLowerCase()) && artistOk(p) && push(p)) return out;
    }
  }
  // (5) Number + artist agree (the set code garbled instead).
  const candNumbers = new Set(candidates.map((c) => c.collectorNumber));
  if (candNumbers.size > 0 && bottomText.trim()) {
    for (const p of printings) {
      if ([...candNumbers].some((n) => sameCollectorNumber(p.collectorNumber, n)) && artistOk(p) && push(p)) return out;
    }
  }
  // (6) Set-only matches, artist-matching first, at most 2 — a
  // same-set printing of the right name is still better evidence
  // than a ninth unrelated recent printing.
  if (candSets.size > 0) {
    const inSet = printings.filter((p) => candSets.has(p.setCode.toLowerCase()) && !seen.has(p.scryfallId));
    inSet.sort((a, b) => Number(artistOk(b)) - Number(artistOk(a)));
    let added = 0;
    for (const p of inSet) {
      if (added >= 2) break;
      if (push(p)) return out;
      added += 1;
    }
  }
  return out;
}
