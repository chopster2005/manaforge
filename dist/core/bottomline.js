// Bottom info-line parsing — the collector-number path.
//
// On modern MTG cards the bottom-left of the frame prints, in tiny type:
//   177/184 U        ← collector number / set size, rarity letter
//   AER • EN ~ James Paick
// That line is EXACT: (set code, collector number) identifies one precise
// printing on Scryfall via GET /cards/{set}/{number}. In a fixed scanner
// rig the line sits in the same place in every frame, so this signal is
// far more reliable than fuzzy-matching a photographed title. This module
// extracts the pair from noisy OCR text of the bottom strip. Pure and
// unit-tested (tests/matcher.test.ts).
/** Tokens that look like set codes but aren't. */
const NOT_SET_CODES = new Set([
    "EN", "JP", "DE", "FR", "IT", "ES", "PT", "RU", "KO", "ZHS", "ZHT", // languages
    "TM", "WOTC", "WOC", "LLC", "INC", "THE", "AND", "FOR", "ART", "ILLUS",
]);
function digitsOnly(s) {
    return s.replace(/[^0-9]/g, "");
}
/**
 * True when two set codes are within one letter substitution of each
 * other — the classic OCR confusions on 3-letter codes (R→Q, I→L,
 * O→Q…). Used by the number-path verification: two treatments that
 * agree on the collector NUMBER and nearly agree on the code are
 * reading the same printed line; treatments that disagree on the
 * NUMBER (179 vs 129) are not, and stay blocked.
 */
export function setCodesNear(a, b) {
    if (a === b)
        return true;
    if (a.length !== b.length)
        return false;
    let diffs = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            diffs += 1;
        if (diffs > 1)
            return false;
    }
    return diffs <= 1;
}
/**
 * Parse OCR text from the bottom strip. Accepts pooled multi-line text.
 * Returns null when no plausible collector number is present.
 */
export function parseBottomLine(rawText) {
    if (!rawText)
        return null;
    const text = rawText.toUpperCase();
    const separator = text.includes("★")
        ? "star"
        : text.includes("•") || text.includes("·")
            ? "bullet"
            : "unknown";
    // Normalise OCR digit confusions ONLY inside number-ish runs: an "O"
    // or "I" wedged between digits/slashes is a 0/1, never a letter.
    const numText = text.replace(/[0-9OILSZGB][0-9OILSZGB\s/]*[0-9OILSZGB]/g, (run) => run.replace(/O/g, "0").replace(/I/g, "1").replace(/L/g, "1").replace(/S/g, "5").replace(/Z/g, "2").replace(/G/g, "6").replace(/B/g, "8"));
    // 1. The slash format: 177/184, 102/277, 240/318 …
    let number = null;
    let numberRaw = "";
    let anchorEnd = -1; // char index just after the number pattern (set-code proximity)
    const slash = /(\d{1,4})\s*\/\s*(\d{1,4})/.exec(numText);
    if (slash) {
        const n = Number.parseInt(slash[1] ?? "", 10);
        const denom = Number.parseInt(slash[2] ?? "", 10);
        if (Number.isFinite(n) && n >= 1 && n <= 2500 && Number.isFinite(denom) && denom >= 20 && denom <= 4500) {
            numberRaw = slash[1] ?? "";
            number = digitsOnly(numberRaw).replace(/^0+(?=\d)/, "");
            anchorEnd = (slash.index ?? 0) + (slash[0]?.length ?? 0);
        }
    }
    const toks = [];
    const tokRe = /\b([A-Z]{3,5})\b/g;
    let m;
    while ((m = tokRe.exec(text)) !== null) {
        const code = m[1] ?? "";
        if (NOT_SET_CODES.has(code))
            continue;
        toks.push({ code, index: m.index });
    }
    // Last-resort pool: 2-letter tokens, consulted ONLY when no 3–5
    // letter token exists at all. Pre-24b the strict parse could pair a
    // mangled number with such a token (the Q0/280 Griffin read → 280 +
    // "LN") and the salvage stage downstream owns those reads; keeping
    // the fallback preserves that behaviour without ever letting a
    // 2-letter token outrank a real code (the E5 failure shape, where
    // FRA is present and "CN" must never be picked).
    const toks2 = [];
    const tok2Re = /\b([A-Z]{2})\b/g;
    while ((m = tok2Re.exec(text)) !== null) {
        const code = m[1] ?? "";
        if (NOT_SET_CODES.has(code))
            continue;
        toks2.push({ code, index: m.index });
    }
    // Prefer 3-letter codes (the overwhelming majority of MTG sets), then
    // the token closest to the collector number — the code is printed on
    // the line directly under it.
    const pickSetCode = () => {
        const all = toks.length > 0 ? toks : toks2;
        if (all.length === 0)
            return null;
        const threes = all.filter((t) => t.code.length === 3);
        const pool = threes.length > 0 ? threes : all;
        if (anchorEnd < 0)
            return pool[0]?.code ?? null;
        let best = null;
        let bestDist = Infinity;
        for (const t of pool) {
            const d = Math.abs(t.index - anchorEnd);
            if (d < bestDist) {
                bestDist = d;
                best = t;
            }
        }
        return best?.code ?? null;
    };
    if (number) {
        return { collectorNumber: number, collectorNumberRaw: numberRaw, setCode: pickSetCode(), separator };
    }
    // 2. Modern no-slash formats: "0543 CMR ★ EN", "1234 SLD", promos.
    // A 3–4 digit run immediately followed by a set-code token. Matched on
    // the ORIGINAL text — the confusion normaliser above can mangle codes
    // containing S/L/I (e.g. SLD), and real digits need no normalising.
    const noSlash = /(\d{3,4})\s+([A-Z]{3,5})\b/.exec(text);
    if (noSlash) {
        const n = Number.parseInt(noSlash[1] ?? "", 10);
        const code = noSlash[2] ?? "";
        if (Number.isFinite(n) && n >= 1 && n <= 2500 && !NOT_SET_CODES.has(code)) {
            return {
                collectorNumber: digitsOnly(noSlash[1] ?? "").replace(/^0+(?=\d)/, ""),
                collectorNumberRaw: noSlash[1] ?? "",
                setCode: code,
                separator,
            };
        }
    }
    // 3. Bare number with a set code somewhere on the line (partial reads).
    // Original text again, so normalised letter-runs can't invent numbers.
    const bareNum = /(\d{2,4})/.exec(text);
    const code = pickSetCode();
    if (bareNum && code) {
        const n = Number.parseInt(bareNum[1] ?? "", 10);
        if (Number.isFinite(n) && n >= 1 && n <= 2500) {
            return {
                collectorNumber: digitsOnly(bareNum[1] ?? "").replace(/^0+(?=\d)/, ""),
                collectorNumberRaw: bareNum[1] ?? "",
                setCode: code,
                separator,
            };
        }
    }
    return null;
}
// ---------------------------------------------------------------------------
// Pass 8 — candidate enumeration + corroboration (the number RESCUE).
//
// parseBottomLine returns ONE best hit. The rescue needs EVERY plausible
// (set, number) pair in the read, because modern frames print the line
// in a shape the original denominator-era parser only half-covers:
//
//   U 0227            ← rarity letter + BARE number, no "/NNN"
//   SOS • EN          ← set code on the line BELOW the number
//   A C 0185 SOS …    ← stray junk single-letter tokens in front
//
// The user's Snooping Page read "U 0227 SOS EN ALEXANR HONORE" and his
// Elemental Mascot "A C 0185 SOS EN JUTYNA DURA" — both carry an exact,
// unique (set, number) that identifies the printing outright
// (GET /cards/sos/227 → Snooping Page; /cards/sos/185 → Elemental
// Mascot, verified live against the Scryfall API). A bare number with
// NO adjacent set code still yields nothing — far too ambiguous.
// ---------------------------------------------------------------------------
/**
 * A token that can be a set code: 3–5 plain letters, or the M20-style
 * letter+digits form (M20, M21…). Language codes and corporate debris
 * are excluded via NOT_SET_CODES. (Pass 24b: the plain-letter minimum
 * rose 2 → 3 — Scryfall's /sets catalogue contains NO 2-letter codes
 * at all (1,067 codes: 452×3, 587×4, 22×5, 6×6 letters), so a 2-letter
 * token is always language/debris — the user's Plains read carried
 * exactly such a token, "CN", between the number and the true code.)
 */
export function isSetCodeToken(tok) {
    if (NOT_SET_CODES.has(tok))
        return false;
    if (/^[A-Z]{3,5}$/.test(tok))
        return true;
    if (/^[A-Z]\d[A-Z0-9]?$/.test(tok))
        return true; // M20-style
    return false;
}
/**
 * A token that reads as a collector number: all digit-ish characters
 * (the usual OCR confusions allowed) containing at least one REAL
 * digit — a pure-letter token like SOS must never normalise into "505".
 * Returns the confusion-normalised digits, or null.
 */
function numberTokenDigits(tok) {
    if (!/^[0-9OILSZGBQ]{1,4}$/.test(tok))
        return null;
    if (!/[0-9]/.test(tok))
        return null;
    return tok
        .replace(/O/g, "0")
        .replace(/Q/g, "0")
        .replace(/I/g, "1")
        .replace(/L/g, "1")
        .replace(/S/g, "5")
        .replace(/Z/g, "2")
        .replace(/G/g, "6")
        .replace(/B/g, "8");
}
/**
 * Every plausible (set code, collector number) pair in a bottom-strip
 * read, best first: the strict parse's hit, then pairs found by a
 * token scan that understands the modern layout — a 1–4 digit number
 * (optionally with a rarity letter attached, "U0227", or directly
 * before it) with a set-code token within ±3 tokens on EITHER side
 * (the code is printed under the number, but pooled multi-line reads
 * scramble the order), tolerating stray junk single-letter tokens.
 * Slash tokens contribute their NUMERATOR (the denominator is the set
 * size, never a collector number). Candidates always carry a set code.
 */
export function parseBottomLineCandidates(rawText) {
    const out = [];
    const seen = new Set();
    const push = (h) => {
        if (!h || !h.setCode)
            return;
        const key = `${h.setCode}/${h.collectorNumber}`;
        if (seen.has(key))
            return;
        seen.add(key);
        out.push(h);
    };
    if (!rawText)
        return out;
    const text = rawText.toUpperCase();
    const separator = text.includes("★")
        ? "star"
        : text.includes("•") || text.includes("·")
            ? "bullet"
            : "unknown";
    const toks = text.split(/[\s•·★~©®™,;:~[\]{}"'“”|]+/).filter(Boolean);
    const pairs = [];
    let tokenMarker = false;
    for (let i = 0; i < toks.length; i++) {
        const tok = toks[i] ?? "";
        let digits = null;
        if (tok.includes("/")) {
            // Slash pair: the numerator is the collector number.
            digits = numberTokenDigits((tok.split("/")[0] ?? "").replace(/[^0-9A-Z]/g, ""));
        }
        else {
            const attached = /^([CURMST])(\d{1,4})$/.exec(tok);
            if (attached && attached[1] === "T")
                tokenMarker = true;
            digits = attached ? (attached[2] ?? null) : numberTokenDigits(tok);
        }
        if (!digits)
            continue;
        const value = Number.parseInt(digits, 10);
        if (!Number.isFinite(value) || value < 1 || value > 2500)
            continue;
        if ((toks[i - 1] ?? "") === "T")
            tokenMarker = true;
        // EVERY set-code token within ±3 tokens, nearest first — rarity
        // letters, language codes and other numbers are skipped over,
        // and junk single letters ("A C 0185") don't break the search.
        const sets = [];
        for (let d = 1; d <= 3; d++) {
            for (const j of [i + d, i - d]) {
                const cand = j >= 0 && j < toks.length ? (toks[j] ?? "") : "";
                if (cand && !cand.includes("/") && isSetCodeToken(cand) && !sets.includes(cand)) {
                    sets.push(cand);
                }
            }
        }
        if (sets.length === 0)
            continue;
        pairs.push({ digits, sets });
    }
    const hit = (digits, setCode) => ({
        collectorNumber: digits.replace(/^0+(?=\d)/, ""),
        collectorNumberRaw: digits,
        setCode,
        separator,
    });
    const tokenVariant = (digits, setCode) => setCode.length === 3 && !setCode.startsWith("T") ? hit(digits, `T${setCode}`) : null;
    // Token marker seen: the token-set pair is the line's own claim —
    // it leads, ahead of even the strict parse (which can only see the
    // printed parent code and would name the parent set's card).
    if (tokenMarker && pairs[0]) {
        const first = pairs[0];
        const v = first ? tokenVariant(first.digits, first.sets[0] ?? "") : null;
        if (v)
            push(v);
    }
    push(parseBottomLine(rawText));
    for (const pair of pairs) {
        pair.sets.forEach((setCode, si) => {
            push(hit(pair.digits, setCode));
            // The token-set variant rides with the CLOSEST set code only —
            // a token belongs to exactly one set, and extra variants for
            // farther codes would spend the rescue's bounded lookups.
            if (si === 0) {
                const v = tokenVariant(pair.digits, setCode);
                if (v)
                    push(v);
            }
        });
    }
    return out;
}
/**
 * Pool the (set, number) candidates from every bottom read of a burst
 * (primary reads + second-treatment verification reads) into one
 * priority list: corroborated pairs first, then by sightings, then by
 * first appearance. The rescue tries them in this order; the pair a
 * single treatment hallucinated (a merged digit naming a DIFFERENT
 * real card) ranks below any pair two reads agreed on, and a 404 from
 * the exact lookup discards a candidate outright.
 */
export function buildNumberCandidates(sources) {
    const byKey = new Map();
    let order = 0;
    for (const src of sources) {
        const seenHere = new Set();
        for (const hit of parseBottomLineCandidates(src.text)) {
            if (!hit.setCode)
                continue;
            const key = `${hit.setCode}/${hit.collectorNumber}`;
            if (seenHere.has(key))
                continue;
            seenHere.add(key);
            const acc = byKey.get(key);
            if (acc) {
                acc.sightings += 1;
                if (src.verify)
                    acc.verify = true;
                else
                    acc.primary = true;
            }
            else {
                byKey.set(key, {
                    hit,
                    sightings: 1,
                    primary: !src.verify,
                    verify: !!src.verify,
                    order: order++,
                });
            }
        }
    }
    const accs = [...byKey.values()];
    const isVerified = (a) => {
        if (a.sightings >= 2)
            return true;
        if (a.primary && a.verify)
            return true;
        // Cross-treatment: same NUMBER, codes within one letter.
        return accs.some((b) => b !== a &&
            ((a.primary && b.verify) || (a.verify && b.primary)) &&
            b.hit.collectorNumber === a.hit.collectorNumber &&
            !!a.hit.setCode &&
            !!b.hit.setCode &&
            setCodesNear(a.hit.setCode, b.hit.setCode));
    };
    return accs
        .map((a) => ({ hit: a.hit, verified: isVerified(a), sightings: a.sightings, order: a.order }))
        .sort((x, y) => Number(y.verified) - Number(x.verified) || y.sightings - x.sightings || x.order - y.order)
        .map(({ hit, verified, sightings }) => ({ hit, verified, sightings }));
}
