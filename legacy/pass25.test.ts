// Pass 25 — PRINTING-LEVEL identification checks.
//
// Provenance (Andrew, 2026-11-10 ~11:30 EST): a Swamp he identifies
// as collector number 274 settled as Scryfall's named-endpoint
// default printing (MDD #296 — live-verified this pass) and the scan
// list gave him no visible printing and no way to pick another one.
// Item 1 localisation (reproduced in tests/harness/probe-printings.ts
// on real Scryfall images): the image channel fingerprinted only the
// newest 8 of 930 Swamp printings; all six real #274 printings ranked
// 61–175+ by release date, so the true printing was never a
// candidate, and the name-level settle recorded the named default.
//
// These checks pin the fixes' pure cores:
//  (2a) selectReferencePrintings — bottom-line evidence selects the
//       fingerprint candidate set BEFORE comparing; exact-pair
//       printings enter even from outside the fetched page.
//  (2b) numberPinDecision — a same-name collector-number hit pins
//       the printing of a name-level settle; a VERIFIED foreign hit
//       falls through to conflict adjudication; unverified foreign
//       noise is ignored (Pass 24c standard).
//  (2d) artist evidence promotes same-set / same-number candidates.
//  (Item 1 mechanism, miniature) rankReferences over fabricated
//       fingerprints: evidence printing absent → wrong winner;
//       present → true winner (mirrors probe-printings on real art).
//  (Item 3 support) printingLine renders the recorded printing.
// Run: bun tests/pass25.test.ts   (from the artifact root)
import { fingerprintFromPixels, rankReferences, type Fingerprint, type ReferenceEntry } from "../client/src/finder";
import { printingLine } from "../client/src/lib";
import {
  HIGH_PRINTING_COUNT,
  isHighPrintingCount,
  sameCollectorNumber,
  selectReferencePrintings,
  type PrintingCandidate,
} from "../client/src/printingselect";
import { numberPinDecision } from "../client/src/scanflow";
import type { CardT } from "../client/src/lib";

let failures = 0;
function check(label: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures += 1;
}

function mkPrinting(id: string, setCode: string, number: string, artist: string, setName = `${setCode.toUpperCase()} Set`): CardT {
  return {
    scryfallId: id,
    name: "Swamp",
    setCode,
    setName,
    collectorNumber: number,
    rarity: "common",
    manaCost: "",
    cmc: 0,
    typeLine: "Basic Land — Swamp",
    oracleText: "",
    colors: [],
    colorIdentity: ["B"],
    imageSmall: "",
    imageNormal: "",
    priceUsd: 0.1,
    priceUsdFoil: null,
    edhrecRank: null,
    scryfallUri: "",
    printsSearchUri: "",
    artist,
    releasedAt: "",
    finishes: ["nonfoil"],
  };
}

// ------------------------------------------------------------------
// The released-desc 60-page of a 930-printing basic, modelled on the
// live Swamp facts: position 1 is the named-endpoint default
// (MDD #296); the FRA printings and every real #274 sit far below
// position 8.
function swampPage(): CardT[] {
  const page: CardT[] = [mkPrinting("mdd-296", "mdd", "296", "Maojin Lee")];
  for (let i = 2; i <= 60; i++) {
    page.push(mkPrinting(`p${i}`, `s${String(i).padStart(2, "0")}`, String(100 + i), `Artist ${i}`));
  }
  // Position 40: an FRA full-art Swamp (real cycle member).
  page[39] = mkPrinting("fra-390", "fra", "390", "Daniel Romanovsky", "Reality Fracture");
  // Position 50: a #274 in an unrelated set, artist Dan Mumford.
  page[49] = mkPrinting("num274-x", "xyz", "274", "Dan Mumford");
  return page;
}

const page = swampPage();
const ids = (sel: CardT[]) => new Set(sel.map((p) => p.scryfallId));

// ---- (2a) no evidence: the historical first-8, default included.
{
  const sel = selectReferencePrintings(page, { baseId: "mdd-296" });
  check("no evidence → first 8 of the page", sel.length === 8 && sel[0]!.scryfallId === "mdd-296" && ids(sel).has("p8") && !ids(sel).has("p9"));
}
{
  // Default printing beyond the window is still guaranteed a slot.
  const sel = selectReferencePrintings(page, { baseId: "p20" });
  check("no evidence + default at position 20 → default + first 8", sel.length === 9 && ids(sel).has("p20") && ids(sel).has("p8"));
}

// ---- (2a) exact pair OUTSIDE the page (the six real Swamp #274s).
const swamp274 = [
  { set: "dsk", artist: "Dan Mumford" },
  { set: "dft", artist: "Jonas De Ro" },
  { set: "tdm", artist: "Sergey Glushakov" },
  { set: "mkm", artist: "Mia Boas" },
  { set: "otj", artist: "Salvatorre Zee Yazzie" },
  { set: "znr", artist: "Adam Paquette" },
];
for (const { set, artist } of swamp274) {
  const exact = mkPrinting(`${set}-274`, set, "274", artist);
  const sel = selectReferencePrintings(page, {
    baseId: "mdd-296",
    exactPrintings: [exact],
    candidates: [{ setCode: set, collectorNumber: "274" }],
    bottomText: `L 0274 ${set.toUpperCase()} EN ${artist.toUpperCase()}`,
  });
  check(`#274 ${set.toUpperCase()} (${artist}) enters the candidate set via its exact pair`, ids(sel).has(`${set}-274`));
  check(`#274 ${set.toUpperCase()} selection stays within the 16 cap`, sel.length <= 16, `n=${sel.length}`);
}

// ---- (2a) exact pair matching a page member beyond position 8.
{
  const sel = selectReferencePrintings(page, {
    baseId: "mdd-296",
    candidates: [{ setCode: "fra", collectorNumber: "390" }],
    bottomText: "L 0390 FRA EN DANIEL ROMANOVSKY",
  });
  check("exact (fra, 390) promotes the position-40 printing", ids(sel).has("fra-390"));
}

// ---- (2d) garbled number, clean set+artist: set+artist promotion.
{
  const sel = selectReferencePrintings(page, {
    baseId: "mdd-296",
    candidates: [{ setCode: "fra", collectorNumber: "391" }], // digit misread; no fra/391 in the page
    bottomText: "L 0391 FRA EN DANIEL ROMANOVSKY",
  });
  check("garbled number + set+artist evidence promotes fra/390", ids(sel).has("fra-390"));
}

// ---- (2d) garbled set code, clean number+artist: number+artist.
{
  const sel = selectReferencePrintings(page, {
    baseId: "mdd-296",
    candidates: [{ setCode: "xyq", collectorNumber: "274" }], // set garbled; no xyq printing exists
    bottomText: "L 0274 XYQ EN DAN MUMFORD",
  });
  check("garbled set + number+artist evidence promotes the #274 printing", ids(sel).has("num274-x"));
}

// ---- (2d) set-only evidence promotes at most two, artist first.
{
  const sel = selectReferencePrintings(page, {
    baseId: "mdd-296",
    candidates: [{ setCode: "s30", collectorNumber: "999" }],
    bottomText: "",
  });
  const s30 = sel.filter((p) => p.setCode === "s30");
  check("set-only evidence promotes the set's printings (≤2)", s30.length >= 1 && s30.length <= 2, `n=${s30.length}`);
}

// ---- (2a) cap discipline under heavy exact evidence.
{
  const candidates: PrintingCandidate[] = [];
  for (let i = 9; i <= 28; i++) candidates.push({ setCode: `s${String(i).padStart(2, "0")}`, collectorNumber: String(100 + i) });
  const sel = selectReferencePrintings(page, { baseId: "mdd-296", candidates, bottomText: "" });
  check("20 exact candidates → selection capped at 16", sel.length === 16, `n=${sel.length}`);
  check("cap keeps exact matches ahead of the newest-8 fill", ids(sel).has("p9") && ids(sel).has("p20"));
  check("selection has no duplicate printings", new Set(sel.map((p) => p.scryfallId)).size === sel.length);
}

// ---- FRA basic cycle fixtures (real printings, verified live):
// each full-art basic must be selectable from its own bottom line.
const fraCycle = [
  { name: "Plains", number: "384", artist: "Alayna Danner" },
  { name: "Island", number: "387", artist: "Calder Moore" },
  { name: "Swamp", number: "390", artist: "Daniel Romanovsky" },
  { name: "Mountain", number: "393", artist: "Leon Tukker" },
  { name: "Forest", number: "396", artist: "Adam Paquette" },
];
for (const { name, number, artist } of fraCycle) {
  const list: CardT[] = [mkPrinting("named-default", "mdd", "296", "Maojin Lee")];
  for (let i = 2; i <= 60; i++) list.push(mkPrinting(`q${i}`, `t${String(i).padStart(2, "0")}`, String(200 + i), `Other ${i}`));
  const fra = { ...mkPrinting(`fra-${number}`, "fra", number, artist, "Reality Fracture"), name };
  list[44] = fra; // position 45 — far outside the newest-8 window
  const sel = selectReferencePrintings(list, {
    baseId: "named-default",
    candidates: [{ setCode: "fra", collectorNumber: number }],
    bottomText: `L 0${number} FRA EN ${artist.toUpperCase()}`,
  });
  check(`FRA ${name} #${number} (${artist}) selected from its bottom line`, ids(sel).has(`fra-${number}`));
}

// ---- helpers
check("sameCollectorNumber tolerates zero padding", sameCollectorNumber("0274", "274") && sameCollectorNumber("234", "0234"));
check("sameCollectorNumber rejects suffix variants", !sameCollectorNumber("274a", "274"));
check("isHighPrintingCount keys on count, not name", isHighPrintingCount(930) && isHighPrintingCount(HIGH_PRINTING_COUNT) && !isHighPrintingCount(11) && !isHighPrintingCount(1));

// ---- (2b) the pin decision matrix.
check("no number hit → ignore", numberPinDecision(null, "Swamp") === "ignore");
check("same-name hit, verified → pin", numberPinDecision({ cardName: "Swamp", verified: true }, "Swamp") === "pin");
check("same-name hit, unverified → pin (name agrees; printing is the prize)", numberPinDecision({ cardName: "Swamp", verified: false }, "Swamp") === "pin");
check("different-name VERIFIED hit → fallthrough (conflict machinery adjudicates)", numberPinDecision({ cardName: "Mabel, Valley Hero", verified: true }, "Swamp") === "fallthrough");
check("different-name unverified hit → ignore (Pass 24c debris rule)", numberPinDecision({ cardName: "Shatterwing Pegasus", verified: false }, "Massacre Girl, Most Wanted") === "ignore");
check("name compare is case-insensitive", numberPinDecision({ cardName: "swamp", verified: true }, "Swamp") === "pin");

// ---- Massacre Girl, Most Wanted — single printing (FRA 234,
// Cristi Balanescu, verified live): the pin path must land on it.
check("Massacre Girl pin decision", numberPinDecision({ cardName: "Massacre Girl, Most Wanted", verified: true }, "Massacre Girl, Most Wanted") === "pin");
{
  const mg = { ...mkPrinting("fra-234", "fra", "234", "Cristi Balanescu", "Reality Fracture"), name: "Massacre Girl, Most Wanted" };
  const sel = selectReferencePrintings([mg], { baseId: "fra-234", candidates: [{ setCode: "fra", collectorNumber: "0234" }], bottomText: "U 0234 FRA EN CRISTI BALANESCU" });
  check("Massacre Girl's only printing is its candidate set", sel.length === 1 && sel[0]!.scryfallId === "fra-234");
}

// ---- (Item 3 support) the recorded-printing line.
check("printingLine renders 'FRA · 234'", printingLine({ setCode: "fra", collectorNumber: "234" }) === "FRA · 234");
check("printingLine renders 'MDD · 296'", printingLine({ setCode: "mdd", collectorNumber: "296" }) === "MDD · 296");
check("printingLine is empty without a number", printingLine({ setCode: "fra", collectorNumber: "" }) === "");

// ---- Item 1 mechanism, miniature: fingerprint ranking with and
// without the evidence printing in the reference set. Fabricated
// structured patterns stand in for card art (the real-image version
// is probe-printings.ts: all six #274 queries recorded MDD 296
// before, and won their true printing at d=8–28 after).
function patternPixels(seed: number, w = 120, h = 168): Uint8ClampedArray {
  // Deterministic block pattern from an LCG — distinct seeds give
  // hash-distant fingerprints, like distinct card artworks.
  let s = seed * 2654435761 >>> 0;
  const blocks: number[] = [];
  for (let i = 0; i < 64; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    blocks.push((s >>> 8) % 256);
  }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bx = Math.min(7, (x / w * 8) | 0);
      const by = Math.min(7, (y / h * 8) | 0);
      const v = blocks[by * 8 + bx]!;
      const i = (y * w + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return data;
}
{
  const query: Fingerprint = fingerprintFromPixels(patternPixels(274), 120, 168);
  const newest8: ReferenceEntry[] = [];
  for (let i = 0; i < 8; i++) {
    newest8.push({
      scryfallId: i === 0 ? "mdd-296" : `new-${i}`,
      name: "Swamp",
      setCode: i === 0 ? "mdd" : `n${i}`,
      collectorNumber: i === 0 ? "296" : String(300 + i),
      fp: fingerprintFromPixels(patternPixels(1000 + i), 120, 168),
    });
  }
  const before = rankReferences([query], newest8);
  check("mechanism: evidence printing absent → winner is a wrong printing", before.length === 1 && before[0]!.scryfallId !== "dsk-274", `winner=${before[0]?.scryfallId}`);
  const withEvidence: ReferenceEntry[] = [
    ...newest8,
    { scryfallId: "dsk-274", name: "Swamp", setCode: "dsk", collectorNumber: "274", fp: fingerprintFromPixels(patternPixels(274), 120, 168) },
  ];
  const after = rankReferences([query], withEvidence);
  check("mechanism: evidence printing present → true printing wins at d=0", after.length === 1 && after[0]!.scryfallId === "dsk-274" && after[0]!.dist.combined === 0, `winner=${after[0]?.scryfallId} d=${after[0]?.dist.combined}`);
  check("mechanism: true winner carries a pinning printing margin", (after[0]?.printingMargin ?? 0) >= 4, `margin=${after[0]?.printingMargin}`);
}

console.log(failures === 0 ? "\nALL PASS 25 CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
