// Pass 24b tests — Item C: tokens + basic lands must scan.
//
// Production evidence (2026-11-10 ~08:47–08:54 EST, six panels):
//   E4 Cadet TOKEN — "Cadet", Token Creature — Wizard Soldier, bottom
//      line printed "T 0001 FRA • EN", artist Elizabeth Peard/Peiró.
//      Scryfall catalogues the printing as TFRA #1 (the token set);
//      /catalog/card-names excludes tokens entirely, so the local
//      title index never contained "Cadet", and the printed pair
//      FRA/1 names a DIFFERENT real card (Emrakul, the Exigent Doom,
//      artist Cristi Balanescu).
//   E5 foil full-art Plains — image service timed out, title garbage,
//      but the bottom read was essentially perfect: "L 0384 CN FRA EN
//      ALAYNA D". The true printing is FRA #384 (Reality Fracture,
//      Alayna Danner — verified live). The old parser produced ONLY
//      CN/384: "CN" (a spurious 2-letter token between number and
//      code) qualified as a set code and the nearest-code scan
//      stopped there. Scryfall has NO 2-letter set codes (1,067 sets
//      checked live: minimum length 3).
//
// Run: bun tests/pass24b.test.ts   (from the artifact root)
import {
  buildNumberCandidates,
  isSetCodeToken,
  parseBottomLine,
  parseBottomLineCandidates,
} from "../client/src/bottomline";
import {
  buildArchidektCsv,
  buildManaBoxCsv,
  buildMoxfieldTxt,
  buildNameIndex,
  matchNames,
  matchNamesPooled,
  ocrCandidates,
  type ExportRow,
} from "../client/src/lib";
import { rescueByCollectorNumber } from "../client/src/scanflow";

let failures = 0;
function check(label: string, cond: boolean, extra = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures += 1;
}
const hkeys = (hits: { setCode: string | null; collectorNumber: string }[]) =>
  hits.map((h) => `${h.setCode}/${h.collectorNumber}`);

// ---------------------------------------------------------------------------
// 1. E5 — the Plains' exact raw string must resolve to FRA/384.
// ---------------------------------------------------------------------------
{
  const raw = "L 0384 CN FRA EN ALAYNA D";
  const strict = parseBottomLine(raw);
  check("E5 strict parse → FRA/384", strict?.setCode === "FRA" && strict?.collectorNumber === "384", JSON.stringify(strict));
  const cands = parseBottomLineCandidates(raw);
  check("E5 candidates lead with FRA/384", hkeys(cands)[0] === "FRA/384", hkeys(cands).join(", "));
  check("E5 candidates contain NO CN/384", !hkeys(cands).includes("CN/384"));
  const earlier = parseBottomLine("L 0384 FRA • EN ALAYNA DANNER");
  check("E5 earlier-panel string → FRA/384", earlier?.setCode === "FRA" && earlier?.collectorNumber === "384", JSON.stringify(earlier));
  check("set-code token: CN (2 letters) no longer qualifies", !isSetCodeToken("CN"));
  check("set-code token: FRA still qualifies", isSetCodeToken("FRA"));
  check("set-code token: TFRA (token set) qualifies", isSetCodeToken("TFRA"));
}

// ---------------------------------------------------------------------------
// 2. Basic lands generally — rarity L + bare 3-digit number + set +
//    artist, for the FRA full-art cycle (live Scryfall data:
//    Island 385 Calder Moore, Swamp 388 Daniel Romanovsky,
//    Mountain 391 Leon Tukker, Forest 394 Adam Paquette).
// ---------------------------------------------------------------------------
{
  const basics: [string, string][] = [
    ["L 0385 FRA EN CALDER MOORE", "FRA/385"],
    ["L 0388 FRA EN DANIEL ROMANOVSKY", "FRA/388"],
    ["L 0391 FRA EN LEON TUKKER", "FRA/391"],
    ["L 0394 FRA EN ADAM PAQUETTE", "FRA/394"],
    ["L 0384 CN FRA EN ALAYNA D", "FRA/384"], // with the CN debris token
  ];
  for (const [raw, want] of basics) {
    const cands = parseBottomLineCandidates(raw);
    check(`basic land "${raw}" → ${want} first`, hkeys(cands)[0] === want, hkeys(cands).join(", "));
  }
}

// ---------------------------------------------------------------------------
// 3. Cadet token — the T-number path. Printed pair FRA/1 is Emrakul;
//    the token-set variant TFRA/1 is the Cadet. The "T" marker leads.
// ---------------------------------------------------------------------------
{
  const raw = "T 0001 FRA EN ELIZABETH PEARD";
  const cands = parseBottomLineCandidates(raw);
  check("Cadet candidates lead with TFRA/1 (token marker)", hkeys(cands)[0] === "TFRA/1", hkeys(cands).join(", "));
  check("Cadet candidates still include the printed pair FRA/1", hkeys(cands).includes("FRA/1"));
  const pool = buildNumberCandidates([{ text: raw }]);
  check("Cadet rescue pool leads with TFRA/1", pool[0]?.hit.setCode === "TFRA" && pool[0]?.hit.collectorNumber === "1");
  const attached = parseBottomLineCandidates("T0001 FRA EN");
  check("attached form 'T0001 FRA' → TFRA/1 present", hkeys(attached).includes("TFRA/1"), hkeys(attached).join(", "));
  // No marker: the variant still rides with the closest set code.
  const angel = parseBottomLineCandidates("0002 LCI EN ZOLTAN BOROS"); // Angel, TLCI #2
  check("Angel (no T read) → LCI/2 present AND TLCI/2 variant present",
    hkeys(angel).includes("LCI/2") && hkeys(angel).includes("TLCI/2"), hkeys(angel).join(", "));
  const bird = parseBottomLineCandidates("0001 WOE EN KISUNG KOH"); // Bird, TWOE #1
  check("Bird → WOE/1 present AND TWOE/1 variant present",
    hkeys(bird).includes("WOE/1") && hkeys(bird).includes("TWOE/1"), hkeys(bird).join(", "));
  // A regular card's line must NOT grow a token variant ahead of it:
  // Snooping Page's pool still leads with the plain pair.
  const snoop = parseBottomLineCandidates("U 0227 SOS EN ALEXANR HONORE");
  check("regular card still leads with plain pair SOS/227", hkeys(snoop)[0] === "SOS/227", hkeys(snoop).join(", "));
}

// ---------------------------------------------------------------------------
// 4. Rescue integration — a mock lookup carrying the LIVE Scryfall
//    facts decides the card the way the production rescue would.
// ---------------------------------------------------------------------------
{
  interface FakeCard { name: string; artist: string }
  const FACTS = new Map<string, FakeCard>([
    ["FRA/384", { name: "Plains", artist: "Alayna Danner" }],
    ["FRA/1", { name: "Emrakul, the Exigent Doom", artist: "Cristi Balanescu" }],
    ["TFRA/1", { name: "Cadet", artist: "Elizabeth Peiró" }],
    ["TLCI/2", { name: "Angel", artist: "Zoltan Boros" }],
  ]);
  const lookup = async (set: string, number: string): Promise<FakeCard | null> =>
    FACTS.get(`${set.toUpperCase()}/${number.replace(/^0+(?=\d)/, "")}`) ?? null;

  const plains = await rescueByCollectorNumber(
    [{ text: "L 0384 CN FRA EN ALAYNA D" }],
    lookup,
    { artistText: "L 0384 CN FRA EN ALAYNA D" },
  );
  check("rescue: E5 raw string settles the FRA #384 Plains",
    plains.chosen?.card.name === "Plains" && plains.chosen?.hit.setCode === "FRA",
    JSON.stringify(plains.chosen?.hit ?? null));

  const cadet = await rescueByCollectorNumber(
    [{ text: "T 0001 FRA EN ELIZABETH PEARD" }],
    lookup,
    { artistText: "T 0001 FRA EN ELIZABETH PEARD" },
  );
  check("rescue: Cadet settles TFRA/1 (not Emrakul FRA/1)",
    cadet.chosen?.card.name === "Cadet" && cadet.chosen?.hit.setCode === "TFRA",
    JSON.stringify(cadet.triedKeys));

  const cadetNoArtist = await rescueByCollectorNumber(
    [{ text: "T 0001 FRA EN" }],
    lookup,
    {},
  );
  check("rescue: Cadet settles TFRA/1 even with NO artist line (marker ordering)",
    cadetNoArtist.chosen?.card.name === "Cadet",
    JSON.stringify(cadetNoArtist.triedKeys));

  const angel = await rescueByCollectorNumber(
    [{ text: "0002 LCI EN ZOLTAN BOROS" }],
    lookup,
    { artistText: "0002 LCI EN ZOLTAN BOROS" },
  );
  check("rescue: Angel token settles TLCI/2 via the variant",
    angel.chosen?.card.name === "Angel" && angel.chosen?.hit.setCode === "TLCI",
    JSON.stringify(angel.triedKeys));
}

// ---------------------------------------------------------------------------
// 5. Title path — the merged index (catalog names + token names)
//    matches tokens AND basics; the pre-24b index could not.
// ---------------------------------------------------------------------------
{
  const catalogOnly = buildNameIndex(["Plains", "Island", "Swamp", "Mountain", "Forest", "Kavu Scout", "Lightning Bolt"]);
  const merged = buildNameIndex([
    "Plains", "Island", "Swamp", "Mountain", "Forest", "Kavu Scout", "Lightning Bolt",
    // token names as merged by getCardNames (Pass 24b server merge)
    "Cadet", "Food", "Clue", "Angel", "Bird", "Beast", "Soldier", "Zombie", "Spirit", "Treasure", "The Monarch", "Morph",
  ]);
  check("pre-24b index: 'Cadet' title read matches NOTHING",
    matchNames(ocrCandidates(["Cadet"]), catalogOnly).length === 0);
  const cadetTitle = matchNamesPooled(ocrCandidates(["Cadet"]), merged);
  check("merged index: 'Cadet' title read → Cadet at 1.0",
    cadetTitle[0]?.entry.full === "Cadet" && cadetTitle[0]?.score === 1, JSON.stringify(cadetTitle[0]?.score));
  const plainsTitle = matchNamesPooled(ocrCandidates(["Plains"]), merged);
  check("merged index: 'Plains' title read → Plains at 1.0",
    plainsTitle[0]?.entry.full === "Plains" && plainsTitle[0]?.score === 1);
  const foodTitle = matchNamesPooled(ocrCandidates(["Food"]), merged);
  check("merged index: 'Food' title read → Food",
    foodTitle[0]?.entry.full === "Food", JSON.stringify(foodTitle[0]?.score));
}

// ---------------------------------------------------------------------------
// 6. Regression guard — token names in the index must not create NEW
//    suggestion pollution: run the debris corpus (tests/matchfast)
//    against the index with and without the token names; no debris
//    string may gain a TOKEN-ONLY name at Did-you-mean level (≥0.55)
//    or better that it did not already have.
// ---------------------------------------------------------------------------
{
  const baseNames = ["Plains", "Island", "Kavu Scout", "Lightning Bolt", "Treasure Keeper", "Pressure Point", "Food Chain", "Angel of Sanctions", "Birds of Paradise", "Beast Whisperer", "Soldier of the Pantheon", "Spirit of the Labyrinth", "Clue", "Morphling"];
  const tokenNames = ["Cadet", "Food", "Angel", "Bird", "Beast", "Soldier", "Zombie", "Spirit", "Treasure", "The Monarch", "Morph"];
  const base = buildNameIndex(baseNames);
  const withTokens = buildNameIndex([...baseNames, ...tokenNames]);
  const tokenOnly = new Set(tokenNames.filter((n) => !baseNames.includes(n)));
  const debris = [
    "Gg a ha a 7 repay g x gr 2 Br ATER fos 2 pon TF 6 r. 4 I 5 et we HRT 2 cao pie os ww TRI a a TPN a",
    "| c= aS ES, EET. w= Tvs CW - a se mew am Em, EE Tm. ww vas CW - a N a CL",
    "-- -- -- . Sh -- -- eit a - ctl ees ee",
    "LY",
    "mtn her PO RE RE EESCE Il",
    "A WY 4 1 4 A J SIA As x Ll 5 Na SA IN",
    "BE. AY 4",
    "ers SR - TY . - - rece Se LN I a L",
    "- . 7 RE GREE SRR EES a d APE B g 3 -",
    "N REL a a cE ae JE y",
    "a... hw a... hw",
    "yy",
    "Fy 00",
  ];
  let pollution = 0;
  for (const d of debris) {
    const before = new Set(matchNamesPooled(ocrCandidates([d]), base, 5).filter((m) => m.score >= 0.55).map((m) => m.entry.full));
    const after = matchNamesPooled(ocrCandidates([d]), withTokens, 5).filter((m) => m.score >= 0.55);
    for (const m of after) {
      if (tokenOnly.has(m.entry.full) && !before.has(m.entry.full)) {
        pollution += 1;
        console.log(`  pollution: debris "${d.slice(0, 24)}…" gained token suggestion ${m.entry.full} @ ${m.score.toFixed(2)}`);
      }
    }
  }
  check("debris corpus: ZERO new token-name suggestions from the merged index", pollution === 0, `${pollution} polluted`);
}

// ---------------------------------------------------------------------------
// 7. Exports accept token printings like any card (ManaBox / Moxfield /
//    Archidekt builders are layout-agnostic row formats).
// ---------------------------------------------------------------------------
{
  const row: ExportRow = {
    quantity: 1, name: "Cadet", setCode: "tfra", setName: "Reality Fracture Tokens",
    collectorNumber: "1", foil: false, condition: "Near Mint", language: "English",
    scryfallId: "00000000-0000-0000-0000-000000000001",
  };
  check("Moxfield export carries the token row", buildMoxfieldTxt([row]).includes("Cadet (TFRA) 1"), buildMoxfieldTxt([row]));
  check("ManaBox export carries the token row", buildManaBoxCsv([row], "Main").includes("Cadet") && buildManaBoxCsv([row], "Main").includes("tfra"));
  check("Archidekt export carries the token row", buildArchidektCsv([row]).includes("Cadet") && buildArchidektCsv([row]).includes("tfra"));
}

console.log(failures === 0 ? "\nALL PASS 24B TESTS PASSED" : `\n${failures} PASS 24B TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
