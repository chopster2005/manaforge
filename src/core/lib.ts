// Local card-name index, fuzzy matching, deck auto-tagging and CSV helpers.
// The name index lives in localStorage; matching runs 100% locally.

export interface NamesCache {
  names: string[];
  date: string; // ISO date string
}

// Pass 24b: v2 — the downloaded index now MERGES token names
// (Scryfall's /catalog/card-names excludes layout=token printings
// entirely, so a v1 cache can never match a token's title). Bumping
// the key forces a one-time re-download that includes them.
const NAMES_KEY = "manabox-card-names-v2";

export function loadNamesCache(): NamesCache | null {
  try {
    const raw = localStorage.getItem(NAMES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NamesCache;
    if (!Array.isArray(parsed.names) || typeof parsed.date !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveNamesCache(names: string[], dateIso: string): void {
  try {
    localStorage.setItem(NAMES_KEY, JSON.stringify({ names, date: dateIso }));
  } catch {
    // Storage full/blocked — matching still works from memory this session.
  }
}

export interface NameEntry {
  /** The name shown to the user / fetched from Scryfall (full card name). */
  full: string;
  /** The matchable face name (== full for single-faced cards). */
  face: string;
  /** Normalised face name for scoring. */
  norm: string;
  /** 0 for the front (or only) face, 1+ for the back/other faces of a DFC. */
  faceIndex: number;
}

/** Split double-faced names on ' // ' and index each face separately. */
export function buildNameIndex(names: string[]): NameEntry[] {
  const out: NameEntry[] = [];
  for (const full of names) {
    const faces = full.split(" // ");
    faces.forEach((face, faceIndex) => {
      out.push({ full, face, norm: normalizeName(face), faceIndex });
    });
  }
  return out;
}

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "'")
    .replace(/[^a-z0-9' -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Trim OCR debris: trailing/leading symbols, mana pips, set icons, etc. */
export function cleanOcrText(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/^[^A-Za-z0-9"']+/, "");
  s = s.replace(/[\s|•·©®™*~^_=+<>[\]{}]+$/g, "");
  s = s.replace(/\s*[|•·©®™]\s*.*$/, "");
  return s.trim();
}

/** Generate match candidates from raw OCR lines. */
export function ocrCandidates(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (v: string) => {
    const c = cleanOcrText(v);
    if (c.length >= 2 && !seen.has(c.toLowerCase())) {
      seen.add(c.toLowerCase());
      out.push(c);
    }
  };
  for (const line of lines) {
    push(line);
    // First-line / first-phrase variants
    const comma = line.indexOf(",");
    if (comma > 3) push(line.slice(0, comma + 30));
    const words = cleanOcrText(line).split(" ");
    if (words.length > 3) push(words.slice(0, 4).join(" "));
    if (words.length > 2) push(words.slice(0, 3).join(" "));
  }
  return out;
}

function bigrams(s: string): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    map.set(bg, (map.get(bg) ?? 0) + 1);
  }
  return map;
}

/** Dice coefficient on character bigrams, 0..1. */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const aMap = bigrams(a);
  const bMap = bigrams(b);
  let overlap = 0;
  for (const [bg, count] of aMap) {
    const other = bMap.get(bg);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

export function nameScore(candidateNorm: string, entryNorm: string): number {
  if (candidateNorm === entryNorm) return 1;
  const dice = diceCoefficient(candidateNorm, entryNorm);
  const lev = levenshtein(candidateNorm, entryNorm);
  const maxLen = Math.max(candidateNorm.length, entryNorm.length);
  const levScore = maxLen > 0 ? 1 - lev / maxLen : 0;
  let score = dice * 0.65 + levScore * 0.35;
  // Prefix bonus — OCR usually gets the start of a name right.
  if (entryNorm.startsWith(candidateNorm.slice(0, Math.min(6, candidateNorm.length))) && candidateNorm.length >= 5) {
    score += 0.05;
  }
  return Math.min(1, score);
}

export interface MatchResult {
  entry: NameEntry;
  score: number;
}

/** Count of alphanumeric characters — the "did anything readable come
 * back at all" measure. */
export function alnumCount(s: string): number {
  return (s.match(/[A-Za-z0-9]/g) ?? []).length;
}

/**
 * A NO-READ: fewer than 4 alphanumeric characters ('LY', '- - - —- . Sh')
 * carries no name evidence whatsoever. No-reads must NEVER generate
 * Did-you-mean suggestions or pause Rapid — the user's Dawnhart Mentor
 * read 'LY' and got Fly/Lyna/Lynx. They count as a failed attempt and
 * the scanner silently keeps watching / retries.
 */
export function isNoRead(text: string): boolean {
  return alnumCount(text) < 4;
}

/** Normalised name → word tokens (split on spaces, hyphens, apostrophes). */
export function nameTokens(norm: string): string[] {
  return norm.split(/[\s'-]+/).filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// EXACT-CONTAINMENT FAST PATH (Pass 15 — the Bolrac-Clan Basher hang).
//
// The user's read 'mtn her PO RE RE EESCE Il Bolrac-Clan Basher 4 be
// J 3 1 2 EEE AR YVR' contains the EXACT card name as contiguous
// tokens — yet the fuzzy pass could not return it at all: the
// whole-string candidate (67 normalised chars) fails the length
// pre-filter against the 18-char name, and the truncated candidates
// ocrCandidates derives don't contain the name either. The match
// stage then churned (~800ms–9.4s per pass on the test VM; 8.1s
// on-device) and the attempt died by watchdog holding a perfect read.
//
// Before any fuzzy scoring, the pooled candidates are tokenised the
// same way the matcher tokenises names, and every contiguous token
// window is looked up in a token-sequence index of the name index.
// A full index name appearing as a contiguous, token-boundary-aligned
// token sequence in the read wins DECISIVELY (score 1.0) and the
// fuzzy pass never runs — the result is structurally bounded
// (hash lookups over ≤ ~10-token windows), not just fast on average.
//
// FALSE-POSITIVE GUARDS: the match must be the name's FULL token
// sequence (never a partial name, never a substring of a longer
// garbage token — tokens compare whole); a name qualifies only with
// ≥2 tokens, or a single token of ≥6 chars (short names are too easy
// to collide with debris). When several names are contained, the
// LONGEST token sequence wins (a read of 'Tribute to the World Tree'
// contains 'The World Tree' too — the longer, true name must win),
// then the longest character length. Validated against the whole
// debris corpus in tests/matchfast.test.ts: zero debris string fires.
// ---------------------------------------------------------------------------

interface TokenSeqIndex {
  byKey: Map<string, NameEntry>;
  maxTokens: number;
}

const tokenSeqCache = new WeakMap<NameEntry[], TokenSeqIndex>();

function tokenSeqIndex(index: NameEntry[]): TokenSeqIndex {
  const cached = tokenSeqCache.get(index);
  if (cached) return cached;
  const byKey = new Map<string, NameEntry>();
  let maxTokens = 1;
  const rank = (e: NameEntry): number => (e.faceIndex > 0 ? 2 : e.full.includes(" // ") ? 1 : 0);
  for (const entry of index) {
    const toks = nameTokens(entry.norm);
    if (toks.length === 0) continue;
    if (toks.length > maxTokens) maxTokens = toks.length;
    const key = toks.join(" ");
    const prev = byKey.get(key);
    if (!prev || rank(entry) < rank(prev)) byKey.set(key, entry);
  }
  const built = { byKey, maxTokens: Math.min(maxTokens, 10) };
  tokenSeqCache.set(index, built);
  return built;
}

/**
 * The exact-name containment check: does any candidate contain a full
 * index name as a contiguous token sequence? Returns the winning
 * entry at score 1.0, or null. Pure, synchronous, and fast (bounded
 * by candidate count × tokens × max name length hash lookups).
 */
export function exactContainedMatch(candidates: string[], index: NameEntry[]): MatchResult | null {
  if (index.length === 0) return null;
  const { byKey, maxTokens } = tokenSeqIndex(index);
  let best: { entry: NameEntry; seqLen: number; charLen: number } | null = null;
  for (const cand of candidates) {
    const toks = nameTokens(normalizeName(cand));
    for (let i = 0; i < toks.length; i++) {
      let key = "";
      const limit = Math.min(toks.length, i + maxTokens);
      for (let j = i; j < limit; j++) {
        key = j === i ? (toks[j] ?? "") : `${key} ${toks[j] ?? ""}`;
        const seqLen = j - i + 1;
        // Guards: full-name sequences only — ≥2 tokens, or a single
        // token of ≥6 chars. A 1-token window inside a longer name is
        // never looked up on its own unless it clears the length bar.
        if (seqLen < 2 && (toks[i] ?? "").length < 6) continue;
        const entry = byKey.get(key);
        if (!entry) continue;
        if (
          !best ||
          seqLen > best.seqLen ||
          (seqLen === best.seqLen && key.length > best.charLen)
        ) {
          best = { entry, seqLen, charLen: key.length };
        }
      }
    }
  }
  return best ? { entry: best.entry, score: 1 } : null;
}

/**
 * Is a name's FULL token sequence present, contiguously and
 * token-aligned, in the pooled title reads? The containment test for
 * one specific name (exactContainedMatch's per-name core, with the
 * same false-positive guards: ≥2 tokens, or a single token of
 * ≥6 chars — a short single-token name is too easy to collide with
 * debris to certify). The reads are joined before tokenising, so a
 * name split across two frames' reads still counts — pooling is the
 * burst's whole point.
 */
export function nameContainedInPooled(winnerName: string, pooledTexts: string[]): boolean {
  const winToks = nameTokens(normalizeName(winnerName));
  if (winToks.length === 0) return false;
  if (winToks.length === 1 && (winToks[0] ?? "").length < 6) return false;
  const pooled = nameTokens(normalizeName(pooledTexts.join("\t")));
  outer: for (let i = 0; i + winToks.length <= pooled.length; i++) {
    for (let j = 0; j < winToks.length; j++) {
      if (pooled[i + j] !== winToks[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * PASS 24c — is the pooled title matcher's top pick a verdict on
 * CLEAN evidence? The Massacre Girl defect: the box read pure
 * garbage ('RR RRR RRR …EEEEEERmMjmBEEREET ee oan - N'), the fuzzy
 * matcher still crowned SOME name ('Shatterwing Pegasus'), and that
 * manufactured suggestion was treated as a decisive OCR verdict —
 * it vetoed a decisive d=30 image match through the fusion conflict
 * path, the garbage veto Pass 23 removed from the front door
 * surviving through the back. A name verdict is CLEAN only when:
 *   (a) the winner's full name is EXACT-CONTAINED in the pooled
 *       read (the exactContainedMatch fast-path class — a complete
 *       verbatim sighting of the whole name), or
 *   (b) the pooled read carries ≥4 alphanumerics AND the winner
 *       leads the runner-up by ≥1.5× AND the winner's full token
 *       sequence is exact-contained in the pooled reads (the
 *       cross-frame shape (a)'s per-candidate check can miss: the
 *       name's tokens pooled across reads).
 * Fuzzy-only winners — sub-bar margins, debris-derived suggestions,
 * names the pool never actually spelled out — are NOT clean: they
 * may still settle on the OCR floor when nothing contradicts them,
 * but they can never raise a conflict against a decisive image
 * verdict. Title channel only, by construction (the caller passes
 * title reads).
 */
export function cleanNameVerdict(
  matches: MatchResult[],
  pooledTexts: string[],
  index: NameEntry[],
): boolean {
  const top = matches[0];
  if (!top || index.length === 0) return false;
  const lines = pooledTexts
    .flatMap((t) => t.split(/\r?\n/))
    .map((s) => s.trim())
    .filter(Boolean);
  const exact = exactContainedMatch([...lines, pooledTexts.join("\t")], index);
  if (exact && exact.entry.full === top.entry.full) return true;
  if (alnumCount(pooledTexts.join(" ")) < 4) return false;
  const second = matches[1]?.score ?? 0;
  if (top.score < 1.5 * second) return false;
  return nameContainedInPooled(top.entry.full, pooledTexts);
}

/** Levenshtein similarity ratio, 0..1. */
function levRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  return maxLen > 0 ? 1 - levenshtein(a, b) / maxLen : 0;
}

/**
 * Similarity of two single tokens: best of bigram Dice and Levenshtein,
 * PLUS fragment handling for the reads a tight band crop produces
 * (Pass 9 — the user's Divergent Equation attempts):
 * - CLIPPED tokens: title bands that start a hair too far right clip
 *   the name's first letters — 'Divergent' came back as 'iverson'
 *   (first letter gone, two glyphs garbled) and 'Equation' as
 *   'tquation'. Dropping 1–2 leading characters from either side and
 *   re-scoring (at a small discount) recognises the fragment for what
 *   it is: the SUFFIX of the true token.
 * - SHORT DEBRIS tokens (≤3 chars, e.g. the 'ae' left of 'Equation'):
 *   the fraction of its letters that appear in the other token is
 *   weak evidence, capped at 0.5 — enough to break a tie between
 *   'Divergent Equation' (both letters present) and 'Divergent
 *   Growth' (neither), never enough to "cover" a token on its own.
 */
function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  let best = Math.max(diceCoefficient(a, b), levRatio(a, b));
  if (a.length >= 4 && b.length >= 4) {
    const clipped: [string, string][] = [
      [a.slice(1), b],
      [a, b.slice(1)],
      [a.slice(2), b],
      [a, b.slice(2)],
      [a.slice(1), b.slice(1)],
    ];
    for (const [x, y] of clipped) {
      if (x.length < 3 || y.length < 3) continue;
      const s = Math.max(diceCoefficient(x, y), levRatio(x, y)) * 0.97;
      if (s > best) best = s;
    }
  }
  const short = a.length <= 3 ? a : b.length <= 3 ? b : null;
  if (short && short.length > 0) {
    const other = short === a ? b : a;
    let hits = 0;
    for (const ch of short) if (other.includes(ch)) hits += 1;
    best = Math.max(best, (hits / short.length) * 0.5);
  }
  return best;
}

/**
 * Token-level score: for every token of the TRUE name, how well is it
 * evidenced in the read? Averaged, then scaled by coverage (the fraction
 * of name tokens with a decent match). This is what separates real
 * near-misses from character-level lookalikes: on the read 'ressure
 * kecrer', Pressure Point matches ONE token strongly ('ressure' ⊂
 * 'pressure') and the other not at all, while Treasure Keeper matches
 * BOTH tokens moderately — token averaging ranks Keeper decisively
 * higher, where whole-string character scores nearly tie them.
 */
export function tokenScore(candidateNorm: string, entryNorm: string): number {
  return tokenScoreFromTokens(nameTokens(candidateNorm), nameTokens(entryNorm));
}

/** tokenScore over pre-split token lists — the pooled matcher feeds it
 * the UNION of every read's tokens (fragment pooling, below). */
function tokenScoreFromTokens(candToks: string[], entryToks: string[]): number {
  if (candToks.length === 0 || entryToks.length === 0) return 0;
  let sum = 0;
  let covered = 0;
  for (const et of entryToks) {
    let best = 0;
    let bestDice = 0;
    for (const ct of candToks) {
      const s = tokenSimilarity(ct, et);
      if (s > best) {
        best = s;
        bestDice = diceCoefficient(ct, et);
      }
    }
    sum += best;
    // COVERAGE needs EVIDENCE, not just similarity (triage pass): the
    // clipped-comparison branches of tokenSimilarity can push two
    // unrelated words past 0.55 on edit distance alone — 'peer' scored
    // 0.582 against the fragment 'kecrer' (shared bigrams: one, Dice
    // 0.25), which counted 'peer' as covered and let the unrelated
    // "Peer Pressure" outrank the true "Treasure Keeper" for the
    // known-good read 'ressure kecrer'. A token counts as covered only
    // when its best match ALSO shares real character evidence — Dice
    // ≥ 0.3, the same standard the fragment-union precision pass below
    // already uses to decide whether a token evidences an entry token.
    // Every genuine fragment match clears it ('iverson'→'divergent'
    // 0.43, 'tquation'→'equation' 0.86, 'ressure'→'treasure' 0.50,
    // 'kecrer'→'keeper' 0.40, 'ratt'→'raft' 0.33); the token's score
    // contribution (sum) is unchanged — only the coverage bonus is
    // gated.
    if (best >= 0.55 && bestDice >= 0.3) covered += 1;
  }
  const avg = sum / entryToks.length;
  const coverage = covered / entryToks.length;
  return avg * (0.7 + 0.3 * coverage);
}

/**
 * Token-aware name score: the existing character score blended with the
 * token score. Single-token names (where token evidence can't
 * discriminate) keep the pure character score.
 */
export function nameScoreV2(candidateNorm: string, entryNorm: string): number {
  const charScore = nameScore(candidateNorm, entryNorm);
  if (nameTokens(entryNorm).length < 2 || nameTokens(candidateNorm).length < 2) {
    return charScore;
  }
  const tok = tokenScore(candidateNorm, entryNorm);
  return Math.min(1, charScore * 0.45 + tok * 0.55);
}

/**
 * Pooled fuzzy match for BURST scans: candidates from every frame's read
 * are scored with the token-aware score and the best score per card name
 * wins (matchNames already keeps the per-name best across candidates —
 * pooling = passing all frames' candidates in one call). A frame that
 * read 'ressure kecrer' plus one that read 'Treasure Kee' therefore
 * combine into one confident Treasure Keeper.
 */
export function matchNamesPooled(
  candidates: string[],
  index: NameEntry[],
  topN = 3,
  opts: { budgetMs?: number } = {},
): MatchResult[] {
  // EXACT-CONTAINMENT FAST PATH (Pass 15): a full card name sitting
  // verbatim in the pooled read wins decisively and the fuzzy pass
  // never runs. This is also what makes the match stage structurally
  // unable to hang on the strongest possible evidence (see the
  // exactContainedMatch doc comment — the Bolrac-Clan Basher read,
  // whose exact name the fuzzy length pre-filter made unreachable).
  const exact = exactContainedMatch(candidates, index);
  if (exact) return [exact];
  // BEST-SO-FAR BUDGET (Pass 15): the fuzzy pass is the one unbounded
  // computation left in an attempt — a long garbage pool against the
  // full index measured 8.1s on-device. Callers pass the attempt
  // clock's remaining time as the budget; scoring stops at the budget
  // and returns the best matches found SO FAR, so the attempt always
  // settles by its deadline with the best available result. With no
  // budget (tests, one-off lookups) behaviour is exactly as before.
  const deadline = opts.budgetMs != null ? performance.now() + Math.max(0, opts.budgetMs) : Number.POSITIVE_INFINITY;
  const outOfTime = (): boolean => performance.now() > deadline;
  const bestByFull = new Map<string, MatchResult>();
  /** Entries that scored ≥0.35 against ANY single candidate — the only
   * ones the fragment-union pass below can plausibly promote. */
  const contenders = new Set<NameEntry>();
  let timedOut = false;
  for (const cand of candidates) {
    if (outOfTime()) { timedOut = true; break; }
    const norm = normalizeName(cand);
    if (norm.length < 2 || isNoRead(cand)) continue;
    let k = 0;
    for (const entry of index) {
      if ((k++ & 1023) === 0 && outOfTime()) { timedOut = true; break; }
      if (Math.abs(entry.norm.length - norm.length) > Math.max(6, norm.length * 0.6)) {
        continue;
      }
      const score = nameScoreV2(norm, entry.norm);
      if (score >= 0.35) contenders.add(entry);
      if (score < 0.4) continue;
      const prev = bestByFull.get(entry.full);
      if (!prev || score > prev.score) {
        bestByFull.set(entry.full, { entry, score });
      }
    }
    if (timedOut) break;
  }
  // FRAGMENT UNION (Pass 9): per-candidate scoring takes the best
  // SINGLE read per name, so two half-reads of the same title never
  // combine — the user's burst produced 'Divergent ae' on one frame
  // and 'iverson tquation' on another, each short of the bar alone.
  // Pooling every candidate's tokens into one evidence set lets each
  // of the true name's tokens find its best fragment across ALL the
  // reads: 'divergent' exact from one, 'tquation' ≈ 'equation' from
  // the other. Only contenders are re-scored (a full-index token pass
  // would be the match-stage balloon all over again), single-token
  // names are skipped (no token structure to pool), and the union
  // score is discounted slightly so one perfect single read still
  // outranks a pooled reconstruction.
  const unionToks = [...new Set(
    candidates.flatMap((c) => nameTokens(normalizeName(c))).filter((t) => t.length > 0),
  )];
  // PASS 26 — UNION PROVENANCE. The union pass below asks "is each of
  // the entry's tokens evidenced SOMEWHERE in the pool?" — but when
  // every best token match lives in ONE source read, the union is not
  // pooling anything: it re-scores that single read with order,
  // repetition and debris priced OUT, and can crown a name the read
  // itself scores only moderately. Measured on the user's Eye of
  // Jace panel pool ('1 Eye ol lace To'): the per-read best for
  // 'Eye to Eye' is 0.755, yet the union promoted it to 0.980 —
  // its tokens 'eye'/'to' sit verbatim in the read as debris while
  // the true name's tokens are the corrupted ones ('ol' for 'of',
  // 'lace' for 'jace'). Pooling may ADD evidence across reads; it
  // must never manufacture a score no read supports. So: for each
  // entry, find which SOURCE each token's best evidence comes from;
  // promotion applies only when the sources span ≥2 reads. Source
  // identity: ocrCandidates emits a read followed by its word-prefix
  // truncations — candidates whose token sequences are nested
  // prefixes of one another are ONE source (a truncation adds no
  // evidence its parent read lacks).
  const candToksList = candidates.map((c) => nameTokens(normalizeName(c)));
  const sourceOf = (i: number): number => {
    const mine = candToksList[i] ?? [];
    let best = i;
    let bestLen = mine.length;
    for (let j = 0; j < candToksList.length; j++) {
      const other = candToksList[j] ?? [];
      if (other.length <= bestLen) continue;
      let isPrefix = mine.length <= other.length;
      for (let k = 0; k < mine.length && isPrefix; k++) {
        if (mine[k] !== other[k]) isPrefix = false;
      }
      if (isPrefix) {
        best = j;
        bestLen = other.length;
      }
    }
    return best;
  };
  const candSources = candidates.map((_, i) => sourceOf(i));
  /** Does token `et` have real evidence (the precision pass's test)
   * in the candidate at index `ci`, and how strong is its best
   * similarity there? Returns -1 when unevidenced there. */
  const tokenEvidenceIn = (ci: number, et: string): number => {
    let best = -1;
    for (const t of candToksList[ci] ?? []) {
      if (diceCoefficient(et, t) >= 0.3) {
        const s = tokenSimilarity(et, t);
        if (s >= 0.55 && s > best) best = s;
      }
    }
    return best;
  };
  if (unionToks.length >= 2) {
    // EVIDENCE PRECISION (heavy-test pass): the union pass asks "are the
    // ENTRY's tokens evidenced somewhere in the reads?" — but a debris
    // read contains dozens of stray tokens, so SOME real card's tokens
    // almost always find clipped lookalikes in it ('ater' ⊂ fragments →
    // Dream Eater / Pirate Hat at Did-you-mean scores, one debris string
    // even reached Rapid's auto-accept bar). The missing question is the
    // reverse: how much of the EVIDENCE does this entry account for? A
    // true fragment pool accounts for nearly all of it (the fragments
    // ARE the title, misread); a junk contender accounts for a sliver.
    // Below 45% accounted, the union score is discounted in proportion.
    // Genuine pooled reads are untouched: 'ressure'+'kecrer' and the
    // Divergent fragments both account for ≥2/3 of their evidence.
    const evidenceToks = [...new Set(
      candidates.flatMap((c) => nameTokens(normalizeName(c))).filter((t) => t.length >= 3),
    )];
    for (const entry of contenders) {
      if (outOfTime()) break;
      const entryToks = nameTokens(entry.norm);
      if (entryToks.length < 2) continue;
      // PASS 26 provenance gate (see above): collect the sources of
      // this entry's BEST token evidence. All from one source read →
      // the union has nothing to add; the read's own per-candidate
      // score (already in bestByFull) is the honest value. Spanning
      // ≥2 reads → genuine fragment pooling, promotion proceeds.
      {
        const sources = new Set<number>();
        for (const et of entryToks) {
          let bestSim = -1;
          let bestSrc = -1;
          for (let ci = 0; ci < candidates.length; ci++) {
            const s = tokenEvidenceIn(ci, et);
            if (s > bestSim) {
              bestSim = s;
              bestSrc = candSources[ci] ?? ci;
            }
          }
          if (bestSrc >= 0) sources.add(bestSrc);
        }
        if (sources.size <= 1) continue;
      }
      let factor = 1;
      if (evidenceToks.length > 0) {
        let accounted = 0;
        for (const et of evidenceToks) {
          const hit = entryToks.some(
            (t) => diceCoefficient(et, t) >= 0.3 && tokenSimilarity(et, t) >= 0.55,
          );
          if (hit) accounted += 1;
        }
        const precision = accounted / evidenceToks.length;
        if (precision < 0.45) factor = precision / 0.45;
      }
      const s = tokenScoreFromTokens(unionToks, entryToks) * 0.98 * factor;
      if (s < 0.4) continue;
      const prev = bestByFull.get(entry.full);
      if (!prev || s > prev.score) {
        bestByFull.set(entry.full, { entry, score: s });
      }
    }
  }
  return [...bestByFull.values()]
    .sort((a, b) => {
      const d = b.score - a.score;
      // The face-rank preference below exists ONLY for near-ties on the
      // SAME face name (a standalone card vs a DFC face of the same
      // name — see matchNames). Between different names the higher
      // score must win outright: a 0.02 tie band let a subset name
      // ("The World Tree", 0.980) outrank the fully-read true name
      // ("Tribute to the World Tree", 0.988) purely on insertion
      // order, and every consumer trusts [0] as THE winner.
      if (Math.abs(d) > 0.02 || a.entry.face !== b.entry.face) return d;
      const rank = (e: NameEntry): number =>
        e.faceIndex > 0 ? 2 : e.full.includes(" // ") ? 1 : 0;
      return rank(a.entry) - rank(b.entry);
    })
    .slice(0, topN);
}

/** Fuzzy-match OCR candidates against the local index. Returns top matches. */
export function matchNames(
  candidates: string[],
  index: NameEntry[],
  topN = 3,
): MatchResult[] {
  const bestByFull = new Map<string, MatchResult>();
  for (const cand of candidates) {
    const norm = normalizeName(cand);
    if (norm.length < 2) continue;
    // Fast pre-filter: same first letter, or length within range, keeps the
    // 45k-entry scan quick on a phone.
    for (const entry of index) {
      if (Math.abs(entry.norm.length - norm.length) > Math.max(6, norm.length * 0.6)) {
        continue;
      }
      const score = nameScore(norm, entry.norm);
      if (score < 0.45) continue;
      const prev = bestByFull.get(entry.full);
      if (!prev || score > prev.score) {
        bestByFull.set(entry.full, { entry, score });
      }
    }
  }
  return [...bestByFull.values()]
    .sort((a, b) => {
      const d = b.score - a.score;
      // Near-tie on the same face name (e.g. a standalone "Lightning Bolt"
      // vs the back face of a DFC "... // Lightning Bolt"): the physical
      // card is overwhelmingly the standalone/front-face one, so rank
      // single-faced cards first, then DFC front faces, then back faces.
      // The rank applies ONLY when the face names are the same — between
      // different names a near-tie must still go to the higher score
      // (see matchNamesPooled: the subset-name outranking bug).
      if (Math.abs(d) > 0.02 || a.entry.face !== b.entry.face) return d;
      const rank = (e: NameEntry): number =>
        e.faceIndex > 0 ? 2 : e.full.includes(" // ") ? 1 : 0;
      return rank(a.entry) - rank(b.entry);
    })
    .slice(0, topN);
}

/** Instant autocomplete over the local index (prefix, then substring). */
export function autocomplete(index: NameEntry[], query: string, limit = 8): NameEntry[] {
  const q = normalizeName(query);
  if (q.length < 2) return [];
  const prefix: NameEntry[] = [];
  const substring: NameEntry[] = [];
  const seenFull = new Set<string>();
  for (const entry of index) {
    if (seenFull.has(entry.full)) continue;
    if (entry.norm.startsWith(q)) {
      prefix.push(entry);
      seenFull.add(entry.full);
    } else if (entry.norm.includes(q)) {
      substring.push(entry);
      seenFull.add(entry.full);
    }
    if (prefix.length >= limit) break;
  }
  return [...prefix, ...substring].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Deck auto-tagging from type line + oracle text
// ---------------------------------------------------------------------------

export type Category =
  | "Lands"
  | "Ramp"
  | "Card Draw"
  | "Removal"
  | "Board Wipes"
  | "Creatures"
  | "Other";

export const CATEGORIES: Category[] = [
  "Lands",
  "Ramp",
  "Card Draw",
  "Removal",
  "Board Wipes",
  "Creatures",
  "Other",
];

export function categoriseCard(typeLine: string, oracleText: string): Category {
  const type = typeLine.toLowerCase();
  const text = oracleText.toLowerCase();
  if (type.includes("land")) return "Lands";
  if (
    /destroy all|exile all|all creatures (get|lose)|wrath|damage to each creature|each creature.*destroy|return all .* to their owners/.test(text)
  ) {
    return "Board Wipes";
  }
  if (
    /search your library for a .*land|search your library for up to .* basic|add \{[wubrgcxs0-9]\}|add one mana|add two mana|add three mana|mana of any|treasure token|put .* land .* onto the battlefield/.test(text) ||
    (type.includes("artifact") && /add \{/.test(text))
  ) {
    return "Ramp";
  }
  if (/draw a card|draw cards|draw two|draw three|draw x|looting|connive/.test(text)) {
    return "Card Draw";
  }
  if (
    /destroy target|exile target|target creature .* damage|deals \d+ damage to (any target|target)|counter target|return target .* to (its|their) owner/.test(text)
  ) {
    return "Removal";
  }
  if (type.includes("creature")) return "Creatures";
  return "Other";
}

// ---------------------------------------------------------------------------
// ManaBox-compatible CSV
// ---------------------------------------------------------------------------

export interface CsvRow {
  name: string;
  foil: boolean;
  quantity: number;
  scryfallId?: string;
  setCode?: string;
  collectorNumber?: string;
  condition?: string;
  language?: string;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? "";
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export interface CsvParseResult {
  rows: CsvRow[];
  /** Human-readable per-row problems (1-based line numbers in the file). */
  errors: string[];
}

export function parseManaBoxCsvDetailed(text: string): CsvParseResult {
  const allLines = text.split(/\r?\n/);
  const lines: { text: string; lineNo: number }[] = [];
  allLines.forEach((l, i) => {
    if (l.trim().length > 0) lines.push({ text: l, lineNo: i + 1 });
  });
  if (lines.length < 2) return { rows: [], errors: [] };
  const header = parseCsvLine(lines[0]?.text ?? "").map((h) => h.toLowerCase());
  const nameIdx = header.findIndex((h) => h === "name");
  const foilIdx = header.findIndex((h) => h.includes("foil"));
  const qtyIdx = header.findIndex((h) => h.includes("quantity") || h === "qty" || h === "count");
  const idIdx = header.findIndex((h) => h.includes("scryfall"));
  const setIdx = header.findIndex((h) => h === "set code" || h === "set" || h === "edition code");
  const numIdx = header.findIndex((h) => h.includes("collector number") || h === "card number");
  const condIdx = header.findIndex((h) => h === "condition");
  const langIdx = header.findIndex((h) => h === "language" || h === "lang");
  if (nameIdx < 0) return { rows: [], errors: ["The file has no Name column in its header row."] };
  const rows: CsvRow[] = [];
  const errors: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const entry = lines[i];
    if (!entry) continue;
    const cols = parseCsvLine(entry.text);
    const name = cols[nameIdx] ?? "";
    if (!name) {
      errors.push(`Line ${entry.lineNo}: no card name — skipped.`);
      continue;
    }
    const foilRaw = (foilIdx >= 0 ? cols[foilIdx] : "") ?? "";
    const foil =
      foilRaw.toLowerCase() === "foil" ||
      foilRaw.toLowerCase() === "etched" ||
      foilRaw.toLowerCase() === "true" ||
      foilRaw.toLowerCase() === "yes" ||
      foilRaw === "1";
    const qtyRaw = qtyIdx >= 0 ? (cols[qtyIdx] ?? "1") : "1";
    const qty = Number.parseInt(qtyRaw, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push(`Line ${entry.lineNo} (${name}): quantity “${qtyRaw}” isn't a positive number — skipped.`);
      continue;
    }
    rows.push({
      name,
      foil,
      quantity: qty,
      scryfallId: idIdx >= 0 ? cols[idIdx] || undefined : undefined,
      setCode: setIdx >= 0 ? cols[setIdx] || undefined : undefined,
      collectorNumber: numIdx >= 0 ? cols[numIdx] || undefined : undefined,
      condition: condIdx >= 0 ? normaliseCondition(cols[condIdx]) : undefined,
      language: langIdx >= 0 ? normaliseLanguage(cols[langIdx]) : undefined,
    });
  }
  return { rows, errors };
}

export function parseManaBoxCsv(text: string): CsvRow[] {
  return parseManaBoxCsvDetailed(text).rows;
}

export function formatMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(2)}`;
}

export interface PriceMovement {
  kind: "up" | "down" | "flat" | "none";
  /** Signed dollar change per unit (current − baseline). */
  diff: number;
  /** Signed percent change, or null when the baseline is 0. */
  pct: number | null;
}

/**
 * Movement of a card's current unit price vs the price when it was added.
 * `current` should be the last checked price, falling back to the stored
 * price. Returns kind "none" when either side is unknown.
 */
export function priceMovement(
  current: number | null | undefined,
  baseline: number | null | undefined,
): PriceMovement {
  if (current == null || baseline == null || !Number.isFinite(current) || !Number.isFinite(baseline)) {
    return { kind: "none", diff: 0, pct: null };
  }
  const diff = current - baseline;
  const pct = baseline !== 0 ? (diff / baseline) * 100 : null;
  const kind = Math.abs(diff) < 0.005 ? "flat" : diff > 0 ? "up" : "down";
  return { kind, diff, pct };
}

/** "+$0.45" / "−$0.20" with a real minus sign. */
export function formatSignedMoney(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export const COLOR_NAMES: Record<string, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
};

export function fitsIdentity(
  cardIdentity: string[],
  commanderIdentity: string[] | null | undefined,
): boolean {
  if (!commanderIdentity) return true;
  const allowed = new Set(commanderIdentity);
  return cardIdentity.every((c) => allowed.has(c));
}

export function isCommanderEligible(typeLine: string, oracleText: string): boolean {
  const type = typeLine.toLowerCase();
  const text = oracleText.toLowerCase();
  if (text.includes("can be your commander")) return true;
  return type.includes("legendary") && type.includes("creature");
}

// ---------------------------------------------------------------------------
// Version / printing detection helpers
// ---------------------------------------------------------------------------

export interface PrintingLike {
  scryfallId: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  artist: string;
  releasedAt: string;
  rarity: string;
  finishes: string[];
}

export interface BottomBandRead {
  collectorNumber: string | null;
  setCode: string | null;
  separator: "star" | "bullet" | "none" | "unknown";
  artist: string | null;
  lines: string[];
}

export type VersionStatus = "detected" | "guess" | "unconfirmed";

export interface VersionInfo {
  status: VersionStatus;
  message: string;
  /** true = ★ seen (foil/etched), false = • seen (non-foil), null = unknown */
  foilDetected: boolean | null;
}

export function yearOf(releasedAt: string): string {
  return releasedAt ? releasedAt.slice(0, 4) : "";
}

/** The one-line printing label shown wherever a recorded printing
 * must be READABLE at a glance — scan-list rows above all (Pass 25
 * Item 3: the version was technically rendered before, as dim
 * 12px meta text fused with rarity and price, and the user could
 * not find it). Format: "FRA · 234". Empty when either half is
 * missing (nothing honest to show). */
export function printingLine(p: { setCode: string; collectorNumber: string }): string {
  const set = p.setCode.trim().toUpperCase();
  const num = p.collectorNumber.trim();
  if (!set || !num) return "";
  return `${set} · ${num}`;
}

export function printingSummary(p: PrintingLike): string {
  const bits = [
    `${p.setName} (${p.setCode.toUpperCase()})`,
    `#${p.collectorNumber}`,
    yearOf(p.releasedAt) ? `released ${yearOf(p.releasedAt)}` : "",
    p.artist ? `art by ${p.artist}` : "",
    p.rarity ? `rarity ${p.rarity}` : "",
    p.finishes.length ? `finishes: ${p.finishes.join(", ")}` : "",
  ].filter(Boolean);
  return bits.join(", ");
}

/** Exact / near-exact collector-number match (leading zeros / suffix letters tolerated). */
function collectorMatches(read: string, actual: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/^0+/, "");
  return norm(read) === norm(actual);
}

/**
 * Match a bottom-band read against the printings list.
 * Exact collector number + set code wins outright; artist is the cross-check
 * and tie-breaker. Returns the printing and why, or null.
 */
export function matchPrintingByBottom<T extends PrintingLike>(
  read: BottomBandRead,
  printings: T[],
): { printing: T; why: string } | null {
  if (printings.length === 0) return null;
  const artistScore = (p: T): number =>
    read.artist && p.artist
      ? nameScore(normalizeName(read.artist), normalizeName(p.artist))
      : 0;

  if (read.collectorNumber && read.setCode) {
    const exact = printings.filter(
      (p) =>
        p.setCode.toLowerCase() === (read.setCode ?? "").toLowerCase() &&
        collectorMatches(read.collectorNumber ?? "", p.collectorNumber),
    );
    if (exact.length === 1) {
      const only = exact[0];
      if (only) return { printing: only, why: "number/set" };
    }
    if (exact.length > 1) {
      const sorted = [...exact].sort((a, b) => artistScore(b) - artistScore(a));
      const top = sorted[0];
      if (top) return { printing: top, why: "number/set+artist" };
    }
  }
  if (read.collectorNumber) {
    const byNumber = printings.filter((p) =>
      collectorMatches(read.collectorNumber ?? "", p.collectorNumber),
    );
    if (byNumber.length === 1) {
      const only = byNumber[0];
      if (only) return { printing: only, why: "number" };
    }
    if (byNumber.length > 1 && read.artist) {
      const sorted = [...byNumber].sort((a, b) => artistScore(b) - artistScore(a));
      const top = sorted[0];
      const second = sorted[1];
      // Only let the artist break the tie when it actually discriminates —
      // reprints often share the same artist (e.g. both #240 Zedruus), and a
      // tied guess must fall through to the visual pick, not a coin flip.
      if (
        top &&
        artistScore(top) >= 0.85 &&
        (!second || artistScore(top) - artistScore(second) > 0.02)
      ) {
        return { printing: top, why: "number+artist" };
      }
    }
  }
  if (read.setCode && read.artist) {
    const inSet = printings.filter(
      (p) => p.setCode.toLowerCase() === (read.setCode ?? "").toLowerCase(),
    );
    if (inSet.length === 1) {
      const only = inSet[0];
      if (only && artistScore(only) >= 0.8) {
        return { printing: only, why: "set+artist" };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bottom-evidence SALVAGE — the Griffin Protector fix.
//
// The strict (set, number) parse can fail on a bottom line the scanner
// demonstrably READ: the user's M20 Griffin Protector came back as raw
// text "Q0/280 C M20 LN CHRISTOPHER MOELLER K" — OCR mangled 020 → Q0,
// the exact parse died, and the app silently showed a DIFFERENT printing
// (DMU #18). Salvage scores the matched card's OWN printings against the
// raw bottom text with OCR-confusion normalisation, so one mangled
// character can't throw away three agreeing signals (set code, number,
// artist). It only ever runs against the title-matched card's printings,
// and only a clear win (score ≥ 55, margin ≥ 15) may select a printing.
// ---------------------------------------------------------------------------

/** Per-character digit confusions OCR makes on the tiny bottom line. */
const DIGIT_CONFUSIONS: Record<string, string> = {
  O: "0", Q: "0", I: "1", L: "1", "|": "1", S: "5", B: "8", Z: "2", G: "6",
};

function normaliseDigitChars(token: string): string {
  return token.split("").map((c) => DIGIT_CONFUSIONS[c] ?? c).join("");
}

/** Levenshtein distance between two short digit strings. */
function digitEditDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur.push(Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      ));
    }
    prev = cur;
  }
  return prev[n] ?? 99;
}

export interface BottomEvidence {
  /** Candidate set-code tokens (raw + confusion-normalised forms). */
  setTokens: string[];
  /** Collector-number candidates with their /denominator, if any. */
  numbers: { digits: string; denominator: string | null }[];
  /** Alpha words (≥3 chars) — the artist line lives here. */
  words: string[];
}

/** Extract salvage evidence from raw bottom-strip OCR text. */
export function extractBottomEvidence(rawText: string): BottomEvidence {
  const text = (rawText ?? "").toUpperCase();
  const tokens = text.split(/[\s,;:~()[\]{}"'“”*]+/).filter(Boolean);
  const setTokens = new Set<string>();
  const numbers: BottomEvidence["numbers"] = [];
  const denominators = new Set<string>();
  for (const tok of tokens) {
    if (tok.includes("/")) {
      const [numPart = "", denPart = ""] = tok.split("/");
      const digits = normaliseDigitChars(numPart).replace(/[^0-9]/g, "");
      const den = denPart.replace(/[^0-9]/g, "");
      if (den) denominators.add(den.replace(/^0+/, "") || "0");
      // No value floor here: the Griffin case IS a floored value — OCR
      // mangled "020" to "Q0" → normalised "00", numerically 0 but one
      // edit away from the true "020". Slash-anchored candidates are
      // kept as-is; the scoring stage decides what they're worth.
      if (digits.length >= 1 && digits.length <= 4) {
        numbers.push({ digits, denominator: den || null });
      }
      continue;
    }
    if (/^[A-Z0-9]{2,4}$/.test(tok)) {
      setTokens.add(tok);
      const norm = normaliseDigitChars(tok);
      if (norm !== tok) setTokens.add(norm);
    }
    const digits = normaliseDigitChars(tok).replace(/[^0-9]/g, "");
    const isAllDigitish = normaliseDigitChars(tok).split("").every((c) => /[0-9]/.test(c));
    if (isAllDigitish && digits.length >= 1 && digits.length <= 4) {
      numbers.push({ digits, denominator: null });
    }
  }
  // A bare token equal to a seen denominator is the set size, not a
  // collector number — drop it as a candidate.
  const filtered = numbers.filter((cand) => {
    const bare = cand.digits.replace(/^0+/, "") || "0";
    return !(cand.denominator === null && denominators.has(bare));
  });
  const words = text.split(/[^A-Z]+/).filter((w) => w.length >= 3);
  return { setTokens: [...setTokens], numbers: filtered, words };
}

export interface SalvageWin<T> {
  printing: T;
  score: number;
  margin: number;
  why: string;
}

/**
 * Score the title-matched card's printings against raw bottom text.
 * Signals: set-code equality (45, strong), collector number exact after
 * confusion normalisation (45, strong) or one digit off (20, medium),
 * artist-name token overlap (20 full / 12 partial, medium). Returns the
 * winner only when it is CLEAR: score ≥ 55 and ≥ 15 ahead of the
 * runner-up — anything less keeps the default printing (the caller may
 * still show the set-code hint). A bottom line from a DIFFERENT card
 * scores ~0 against these printings and can never override.
 */
export function salvagePrintingFromBottom<T extends PrintingLike>(
  rawBottomText: string,
  printings: T[],
): SalvageWin<T> | null {
  if (!rawBottomText || !rawBottomText.trim() || printings.length === 0) return null;
  const ev = extractBottomEvidence(rawBottomText);
  const scored = printings.map((p) => {
    let score = 0;
    const why: string[] = [];
    const setUpper = p.setCode.toUpperCase();
    if (ev.setTokens.some((t) => t === setUpper)) {
      score += 45;
      why.push("set");
    }
    const pDigits = p.collectorNumber.replace(/[^0-9]/g, "");
    const pNum = pDigits.replace(/^0+/, "") || "0";
    let bestNum = 0;
    for (const cand of ev.numbers) {
      const cNum = cand.digits.replace(/^0+/, "") || "0";
      if (cNum === pNum) {
        bestNum = Math.max(bestNum, 45);
      } else if (
        digitEditDistance(cand.digits.padStart(3, "0"), pDigits.padStart(3, "0")) === 1
      ) {
        bestNum = Math.max(bestNum, 20);
      }
    }
    if (bestNum >= 45) { score += 45; why.push("number"); }
    else if (bestNum > 0) { score += bestNum; why.push("number~1digit"); }
    if (p.artist) {
      const aToks = p.artist.toUpperCase().split(/[^A-Z]+/).filter((t) => t.length >= 3);
      if (aToks.length > 0) {
        const present = aToks.filter((t) => ev.words.includes(t)).length;
        const frac = present / aToks.length;
        if (frac >= 1) { score += 20; why.push("artist"); }
        else if (frac >= 0.5) { score += 12; why.push("artist~"); }
      }
    }
    return { printing: p, score, why: why.join("+") };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top) return null;
  const second = scored[1]?.score ?? 0;
  if (top.score >= 55 && top.score - second >= 15) {
    return { printing: top.printing, score: top.score, margin: top.score - second, why: top.why };
  }
  return null;
}

/**
 * The set code the bottom line clearly names, when it belongs to one of
 * the card's printings but is NOT the set of the printing currently
 * shown — drives the "your card's bottom line reads M20" hint. Returns
 * the code (uppercase) or null.
 */
export function bottomSetCodeHint<T extends PrintingLike>(
  rawBottomText: string,
  printings: T[],
  currentSetCode: string,
): string | null {
  if (!rawBottomText || !rawBottomText.trim()) return null;
  const ev = extractBottomEvidence(rawBottomText);
  const current = currentSetCode.toUpperCase();
  for (const p of printings) {
    const code = p.setCode.toUpperCase();
    if (code !== current && ev.setTokens.some((t) => t === code)) return code;
  }
  return null;
}

/**
 * Artist consistency check for the collector-number rescue: does the
 * raw bottom text support the artist of a looked-up printing? OCR
 * drops letters from the tiny artist line ("ALEXANR" for ALEXANDRE,
 * "JUTYNA" for JUSTYNA — both from the user's real SOS scans), so
 * tokens match with an edit tolerance that grows with token length
 * (≤1 for 4–6 chars, ≤2 for 7+). Used ONLY to break ties when several
 * number candidates name real cards — never a requirement for a
 * single hit.
 */
// ---------------------------------------------------------------------------
// Languages, conditions, multi-format exports, friendly errors
// ---------------------------------------------------------------------------

/** Standard MTG printed languages (display names stored on items). */
export const LANGUAGES = [
  "English",
  "Spanish",
  "French",
  "German",
  "Italian",
  "Portuguese",
  "Japanese",
  "Korean",
  "Russian",
  "Simplified Chinese",
  "Traditional Chinese",
] as const;

/** Display name -> Archidekt 2-letter code (EN, DE, FR, IT, ES, PT, RU
 * standard ISO; JP/KR and CS/CT are Archidekt's own, per MtgCsvHelper's
 * site-behaviour notes). */
const LANGUAGE_TO_ARCHIDEKT: Record<string, string> = {
  English: "EN",
  Spanish: "ES",
  French: "FR",
  German: "DE",
  Italian: "IT",
  Portuguese: "PT",
  Japanese: "JP",
  Korean: "KR",
  Russian: "RU",
  "Simplified Chinese": "CS",
  "Traditional Chinese": "CT",
};

/** Display name -> ManaBox language code (en, zh_CN, zh_TW style). */
const LANGUAGE_TO_MANABOX: Record<string, string> = {
  English: "en",
  Spanish: "es",
  French: "fr",
  German: "de",
  Italian: "it",
  Portuguese: "pt",
  Japanese: "ja",
  Korean: "ko",
  Russian: "ru",
  "Simplified Chinese": "zh_CN",
  "Traditional Chinese": "zh_TW",
};

const LANGUAGE_ALIASES: Record<string, string> = {
  en: "English", english: "English",
  es: "Spanish", spanish: "Spanish",
  fr: "French", french: "French",
  de: "German", german: "German", deu: "German",
  it: "Italian", italian: "Italian",
  pt: "Portuguese", portuguese: "Portuguese",
  ja: "Japanese", japanese: "Japanese", jp: "Japanese",
  ko: "Korean", korean: "Korean", kr: "Korean",
  ru: "Russian", russian: "Russian",
  zhs: "Simplified Chinese", zh_cn: "Simplified Chinese", cs: "Simplified Chinese",
  "simplified chinese": "Simplified Chinese", "chinese simplified": "Simplified Chinese",
  zht: "Traditional Chinese", zh_tw: "Traditional Chinese", ct: "Traditional Chinese",
  "traditional chinese": "Traditional Chinese", "chinese traditional": "Traditional Chinese",
  ph: "English",
};

/** Any language spelling/code -> the stored display name (unknown -> English). */
export function normaliseLanguage(raw: string | null | undefined): string {
  if (!raw) return "English";
  const key = raw.trim().toLowerCase();
  if (!key) return "English";
  return LANGUAGE_ALIASES[key] ?? (LANGUAGES as readonly string[]).find((l) => l.toLowerCase() === key) ?? "English";
}

export function archidektLanguage(language: string): string {
  return LANGUAGE_TO_ARCHIDEKT[normaliseLanguage(language)] ?? "EN";
}

export function manaboxLanguage(language: string): string {
  return LANGUAGE_TO_MANABOX[normaliseLanguage(language)] ?? "en";
}

const CONDITION_ALIASES: Record<string, string> = {
  "near mint": "Near Mint", nm: "Near Mint", mint: "Near Mint", m: "Near Mint",
  "lightly played": "Lightly Played", lp: "Lightly Played", excellent: "Lightly Played", ex: "Lightly Played",
  "moderately played": "Moderately Played", mp: "Moderately Played", good: "Moderately Played", gd: "Moderately Played",
  "heavily played": "Heavily Played", hp: "Heavily Played", played: "Heavily Played",
  damaged: "Damaged", d: "Damaged", dmg: "Damaged", poor: "Damaged",
  near_mint: "Near Mint", light_played: "Lightly Played",
};

/** Any condition spelling/abbreviation -> the stored display name. */
export function normaliseCondition(raw: string | null | undefined): string {
  if (!raw) return "Near Mint";
  const key = raw.trim().toLowerCase();
  if (!key) return "Near Mint";
  return CONDITION_ALIASES[key] ?? "Near Mint";
}

/** Stored display name -> Archidekt's TCGPlayer-standard abbreviation. */
export function archidektCondition(condition: string): string {
  switch (normaliseCondition(condition)) {
    case "Lightly Played": return "LP";
    case "Moderately Played": return "MP";
    case "Heavily Played": return "HP";
    case "Damaged": return "D";
    default: return "NM";
  }
}

/** Stored display name -> ManaBox snake_case condition. */
export function manaboxCondition(condition: string): string {
  switch (normaliseCondition(condition)) {
    case "Lightly Played": return "light_played";
    case "Moderately Played": return "played";
    case "Heavily Played": return "played";
    case "Damaged": return "poor";
    default: return "near_mint";
  }
}

/** One row of anything exportable (collection item, deck card, scan item). */
export interface ExportRow {
  quantity: number;
  name: string;
  setCode: string;
  setName: string;
  collectorNumber: string;
  foil: boolean;
  condition: string;
  language: string;
  scryfallId: string;
  /** Foil-aware unit price when the card was added (ManaBox "Purchase price"). */
  purchasePrice?: number | null;
  isCommander?: boolean;
  /** ISO date the row was added (Archidekt "Date Added"). */
  addedAt?: string;
}

function csvCell(v: string | number): string {
  const s = String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function csvLine(cells: (string | number)[]): string {
  return cells.map(csvCell).join(",");
}

/**
 * MOXFIELD deck text (.txt) — Moxfield's text import format:
 * `<quantity> <name> (<SET>) <collector number>` per line, ` *F*` for
 * foil, ` *E*` for etched, ` *CMDR*` marking the commander. Set code is
 * uppercase in parentheses; the collector number follows it. (Verified
 * against Moxfield bulk-edit docs and decklist import references —
 * see DATA-PLAN.)
 */
export function buildMoxfieldTxt(rows: ExportRow[]): string {
  return rows
    .map((r) => {
      const set = r.setCode ? ` (${r.setCode.toUpperCase()})` : "";
      const num = r.collectorNumber ? ` ${r.collectorNumber}` : "";
      const foil = r.foil ? " *F*" : "";
      const cmdr = r.isCommander ? " *CMDR*" : "";
      return `${r.quantity} ${r.name}${set}${num}${foil}${cmdr}`;
    })
    .join("\n");
}

/**
 * ARCHIDEKT CSV — Archidekt's collection export schema (13 columns):
 * Quantity,Name,Finish,Condition,Date Added,Language,Purchase Price,
 * Tags,Edition Name,Edition Code,Multiverse Id,Scryfall ID,Collector
 * Number. Finish is Normal/Foil/Etched, Condition the TCGPlayer
 * abbreviations NM/LP/MP/HP/D, Language Archidekt's 2-letter codes,
 * Edition Code lowercase. A commander row carries the "Commander" tag.
 */
export function buildArchidektCsv(rows: ExportRow[]): string {
  const header =
    "Quantity,Name,Finish,Condition,Date Added,Language,Purchase Price,Tags,Edition Name,Edition Code,Multiverse Id,Scryfall ID,Collector Number";
  const lines = rows.map((r) =>
    csvLine([
      r.quantity,
      r.name,
      r.foil ? "Foil" : "Normal",
      archidektCondition(r.condition),
      r.addedAt ? r.addedAt.slice(0, 10) : "",
      archidektLanguage(r.language),
      "",
      r.isCommander ? "Commander" : "",
      r.setName,
      r.setCode.toLowerCase(),
      "",
      r.scryfallId,
      r.collectorNumber,
    ]),
  );
  return [header, ...lines].join("\n");
}

/**
 * MANABOX CSV — ManaBox's native collection export header (verified
 * against a real ManaBox_Collection export):
 * Binder Name,Binder Type,Name,Set code,Set name,Collector number,Foil,
 * Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,
 * Altered,Condition,Language,Purchase price currency,Added.
 * Foil is normal/foil/etched; Condition and Language use ManaBox's
 * snake_case / locale codes.
 */
export function buildManaBoxCsv(
  rows: (ExportRow & { rarity?: string })[],
  binderName: string,
): string {
  const header =
    "Binder Name,Binder Type,Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID,Purchase price,Misprint,Altered,Condition,Language,Purchase price currency,Added";
  const lines = rows.map((r) =>
    csvLine([
      binderName,
      "binder",
      r.name,
      r.setCode.toLowerCase(),
      r.setName,
      r.collectorNumber,
      r.foil ? "foil" : "normal",
      r.rarity ?? "",
      r.quantity,
      "",
      r.scryfallId,
      r.purchasePrice != null ? r.purchasePrice.toFixed(2) : "",
      "false",
      "false",
      manaboxCondition(r.condition),
      manaboxLanguage(r.language),
      "USD",
      r.addedAt ? r.addedAt.slice(0, 10) : "",
    ]),
  );
  return [header, ...lines].join("\n");
}

/**
 * Turn any thrown value into a plain-language message for the UI. The
 * action transport wraps failures as `action X failed: 500 {"error":…}`
 * — that raw plumbing must never reach the user.
 */
export function friendlyError(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (/timed out|timeout|deadline/i.test(raw)) {
    return "That took too long and was stopped — please try again. Nothing was lost.";
  }
  if (/network|fetch failed|failed to fetch|load failed/i.test(raw)) {
    return "Couldn't reach the server — check your connection and try again.";
  }
  // Transport wrapper: 'action refreshCollectionPrices failed: 500 {"error":"…"}'
  const inner = raw.match(/\{"error"\s*:\s*"([^"]+)"\}/);
  if (inner?.[1]) return friendlyError(new Error(inner[1]), fallback);
  if (/^action\s+\S+\s+failed/i.test(raw) || /^\d{3}\s/.test(raw)) return fallback;
  if (raw.length > 0 && raw.length <= 160 && !/[{}<>]/.test(raw)) return raw;
  return fallback;
}

export function artistMatchesBottomText(rawBottomText: string, artist: string): boolean {
  if (!rawBottomText || !artist) return false;
  const ev = extractBottomEvidence(rawBottomText);
  if (ev.words.length === 0) return false;
  const tokens = artist
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return false;
  return tokens.every((tok) => {
    const allowed = tok.length >= 7 ? 2 : tok.length >= 4 ? 1 : 0;
    return ev.words.some(
      (w) => w === tok || (allowed > 0 && digitEditDistance(w, tok) <= allowed),
    );
  });
}

/**
 * The reverse check (Pass 15 — the Bolrac-Clan Basher angle fixture):
 * does the bottom line contain a CLEANLY READ artist line that clearly
 * CONTRADICTS this card's artist? A dropped digit in the collector
 * number ("0112" read as "012") can name a DIFFERENT REAL card in the
 * same set (MKM 12 = Delney, Streetwise Lookout, artist Darren Tan),
 * and a bare (set, number) lookup cannot tell. But the same bottom
 * strip printed "WARREN MAHY" in full — two clean ≥4-letter words
 * that match NEITHER of the hit card's artist tokens even with the
 * tolerant edit distance. That is positive evidence the number was
 * misread, not merely missing evidence.
 *
 * Conservative by construction — returns true ONLY when (a) the
 * tolerant artist match FAILS, and (b) the text carries at least two
 * ≥4-letter words (a cleanly-read artist line's shape; the ©/TM words
 * of the copyright line don't count). Absent or garbled artist lines
 * ("WARLREN MANY", no artist words at all) never contradict, so
 * legitimate hits with unreadable artist lines are untouched.
 *
 * Pass 24b addition — (c) NO token of the artist's name may appear
 * VERBATIM in the bottom text. The Cadet token's line reads
 * "ELIZABETH PEARD" for artist Elizabeth Peiró: the surname is a
 * 2-edit garble (past the tolerant bar for a 5-char token), so the
 * tolerant match fails — yet the first name matches EXACTLY, which
 * is positive evidence FOR this artist, not a clean contradiction.
 * Without (c) the guard discarded the true TFRA/1 hit (and the
 * FRA/1 Emrakul hit too, leaving the rescue empty). The Bolrac
 * shape is unaffected: "WARREN" is not a verbatim token of
 * "Darren Tan", so the number collision still contradicts.
 */
export function bottomArtistClearlyContradicts(rawBottomText: string, artist: string): boolean {
  if (!rawBottomText || !artist) return false;
  if (artistMatchesBottomText(rawBottomText, artist)) return false;
  const ev = extractBottomEvidence(rawBottomText);
  const artistTokens = artist
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter((t) => t.length >= 3);
  const wordSet = new Set(ev.words);
  if (artistTokens.some((t) => wordSet.has(t))) return false;
  const NOT_ARTIST = new Set(["WIZARDS", "COAST"]);
  const cleanWords = ev.words.filter((w) => w.length >= 4 && !NOT_ARTIST.has(w));
  return cleanWords.length >= 2;
}
