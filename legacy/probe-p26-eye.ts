// Pass 26 Defect 2 — matcher trace for the Eye of Jace panel pool.
// The panel's pooled raw read was '1 Eye ol lace To'; the Did-you-mean
// top was 'Eye to Eye · 76%' while the band thumbnail plainly read
// 'Eye of Jace'. This probe runs the PRODUCTION matcher over the
// panel pool and over per-read variants, printing every score that
// decides the ranking, so the dilution point is named, not guessed.
import { buildNameIndex, exactContainedMatch, matchNamesPooled, nameScoreV2, normalizeName, ocrCandidates, tokenScore } from "../../client/src/lib";

const index = buildNameIndex([
  "Eye of Jace",
  "Eye to Eye",
  "Eye of the Storm",
  "Eyes of the Watcher",
  "Jace, the Mind Sculptor",
  "Jace Beleren",
  "Lace with Moonglove",
  "Palace Siege",
  "Palace Jailer",
  "Solace",
  "The Eldest Reborn",
  "Treasure Keeper",
  "Pressure Point",
]);

const pools: Record<string, string[]> = {
  "panel pool (exact)": ["1 Eye ol lace To"],
  "clean read alone": ["Eye of Jace"],
  "clean + panel pool": ["Eye of Jace", "1 Eye ol lace To"],
  "psm6-ish variant": ["Eye ol Jace"],
  "no-debris corrupt": ["Eye ol lace"],
};

for (const [label, reads] of Object.entries(pools)) {
  const cands = ocrCandidates(reads);
  const exact = exactContainedMatch(cands, index);
  const matches = matchNamesPooled(cands, index, 5);
  console.log(`\n== ${label}`);
  console.log(`   reads: ${JSON.stringify(reads)}`);
  console.log(`   candidates: ${JSON.stringify(cands)}`);
  console.log(`   exactContained: ${exact ? `${exact.entry.full} @ ${exact.score}` : "null"}`);
  for (const m of matches) console.log(`   match: ${m.entry.full} @ ${m.score.toFixed(3)}`);
}

// Per-candidate scores for the two rivals, so the trace names WHICH
// candidate crowns the impostor and by what margin.
console.log("\n== per-candidate nameScoreV2 / tokenScore");
for (const cand of ["1 eye ol lace to", "1 eye ol lace", "1 eye ol", "eye ol lace", "eye of jace"]) {
  for (const entry of ["eye of jace", "eye to eye"]) {
    console.log(
      `   ${JSON.stringify(cand)} vs ${entry}: V2=${nameScoreV2(cand, entry).toFixed(3)} token=${tokenScore(cand, entry).toFixed(3)}`,
    );
  }
}
console.log(`\nnormalize check: ${JSON.stringify(normalizeName("1 Eye ol lace To"))}`);
