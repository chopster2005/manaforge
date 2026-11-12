// Pass 25 Item 1 probe — REPRODUCE the wrong-printing settle for a
// high-printing-count name (Swamp, 930 printings) at the fingerprint
// level, using the PRODUCTION reference-selection rule and the
// PRODUCTION finder functions.
//
// Production facts under test (client/src/App.tsx runImageChannel +
// server fetchPrintingsList):
//   - getPrintings returns printings ordered released DESC, capped
//     at 60; runImageChannel fingerprints printings.slice(0, 8) —
//     the 8 NEWEST printings — as the image channel's entire
//     candidate set for the name.
//   - A name-level settle records resolveByName(name) = Scryfall's
//     /cards/named default unless the art winner (a) differs from
//     that default AND (b) clears printingMargin >= 4, or the
//     bottom-line salvage wins.
//   - For "Swamp" the named default is MDD #296 — the exact printing
//     Andrew reported recorded for his #274 Swamp (transcribed
//     "MMD 296").
//
// This probe fingerprints the production candidate set (8 newest)
// and an evidence-enlarged set (production 8 + the six real #274
// printings), then queries each #274 printing at identity geometry
// (its own normal image resampled to the canonical card — the
// cleanest possible capture; a defect that fires here is structural,
// not a capture-quality artefact).
//
//   bun tests/harness/probe-printings.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installGlobals, ShimCanvas } from "./canvas";

installGlobals();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, ".cache", "printings");
mkdirSync(CACHE, { recursive: true });

const finder = await import("../../client/src/finder");

interface RawCard {
  id: string;
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  artist?: string;
  image_uris?: { small?: string; normal?: string };
}

async function fetchJson(url: string): Promise<unknown> {
  const key = Buffer.from(url).toString("base64url").slice(0, 60);
  const file = path.join(CACHE, `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const res = await fetch(url, { headers: { "User-Agent": "manabox-pass25-probe/1.0", Accept: "application/json" } });
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  const j = await res.json();
  writeFileSync(file, JSON.stringify(j));
  await new Promise((r) => setTimeout(r, 80));
  return j;
}

async function loadImageCanvas(url: string, tag: string): Promise<ShimCanvas> {
  const jpg = path.join(CACHE, `${tag}.jpg`);
  if (!existsSync(jpg)) {
    const res = await fetch(url, { headers: { "User-Agent": "manabox-pass25-probe/1.0" } });
    if (!res.ok) throw new Error(`image ${url} -> ${res.status}`);
    writeFileSync(jpg, Buffer.from(await res.arrayBuffer()));
    await new Promise((r) => setTimeout(r, 80));
  }
  const prefix = path.join(CACHE, `${tag}-dec`);
  if (!existsSync(`${prefix}.rgba`)) {
    const out = spawnSync("python3", [path.join(HERE, "decode.py"), jpg, prefix], { encoding: "utf8" });
    if (out.status !== 0) throw new Error(`decode failed for ${tag}: ${out.stderr}`);
  }
  const meta = JSON.parse(readFileSync(`${prefix}.json`, "utf8")) as { width: number; height: number };
  return ShimCanvas.fromRGBA(meta.width, meta.height, new Uint8Array(readFileSync(`${prefix}.rgba`)));
}

function resizeTo(src: ShimCanvas, w: number, h: number): ShimCanvas {
  const out = new ShimCanvas();
  out.width = w; out.height = h;
  out.getContext("2d")!.drawImage(src as never, 0, 0, w, h);
  return out;
}
function fpOf(canvas: ShimCanvas): { art: string; card: string } {
  const ctx = canvas.getContext("2d")!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return finder.fingerprintFromPixels(img.data, canvas.width, canvas.height);
}

// --- 1. The production printings list for Swamp (released desc) ---
const named = (await fetchJson("https://api.scryfall.com/cards/named?exact=Swamp")) as RawCard;
console.log(`named default for "Swamp": ${named.set} #${named.collector_number} (${named.set_name}) — the printing a name-level settle records when nothing pins another`);
const searchUrl = `https://api.scryfall.com/cards/search?order=released&dir=desc&q=oracleid%3A${(named as unknown as { oracle_id: string }).oracle_id}&unique=prints`;
const page1 = (await fetchJson(searchUrl)) as { total_cards: number; data: RawCard[] };
console.log(`total Swamp printings: ${page1.total_cards}`);
const productionSet = page1.data.slice(0, 8);
console.log(`production candidate set (8 newest): ${productionSet.map((c) => `${c.set} ${c.collector_number}`).join(" · ")}`);

// --- 2. The six real #274 printings (Andrew's candidate universe) ---
const S274 = ["dsk", "dft", "tdm", "mkm", "otj", "znr"];
const evidenceSet: RawCard[] = [];
for (const s of S274) {
  evidenceSet.push((await fetchJson(`https://api.scryfall.com/cards/${s}/274`)) as RawCard);
}
for (const c of evidenceSet) {
  const rank = page1.data.findIndex((p) => p.id === c.id) + 1;
  console.log(`  ${c.set} 274 (${c.set_name}, ${c.artist}) — released-desc rank ${rank === 0 ? ">175 (not on page 1)" : rank} of ${page1.total_cards}; in production 8? ${productionSet.some((p) => p.id === c.id)}; in getPrintings 60? ${rank > 0 && rank <= 60}`);
}

// --- 3. Fingerprint references exactly as production does (small) ---
async function refOf(c: RawCard): Promise<finder.ReferenceEntry> {
  const canvas = await loadImageCanvas(c.image_uris!.small!, `${c.set}-${c.collector_number}-small`);
  return { name: c.name, setCode: c.set, collectorNumber: c.collector_number, scryfallId: c.id, fp: fpOf(canvas) };
}
const prodRefs: finder.ReferenceEntry[] = [];
for (const c of productionSet) prodRefs.push(await refOf(c));
const enlargedRefs = [...prodRefs];
for (const c of evidenceSet) enlargedRefs.push(await refOf(c));

// --- 4. Query each #274 at identity geometry ---
console.log("\n=== identity-geometry queries (query = the printing's own normal image at canonical size) ===");
for (const c of evidenceSet) {
  const qCanvas = resizeTo(await loadImageCanvas(c.image_uris!.normal!, `${c.set}-${c.collector_number}-normal`), finder.CANONICAL_W, finder.CANONICAL_H);
  const q = fpOf(qCanvas);
  const prod = finder.rankReferences([q], prodRefs);
  const prodTop = prod[0]!;
  const enl = finder.rankReferences([q], enlargedRefs);
  const enlTop = enl[0]!;
  const wouldPin = prodTop.scryfallId !== named.id && prodTop.printingMargin >= 4;
  console.log(
    `query ${c.set} 274: PRODUCTION winner ${prodTop.setCode} ${prodTop.collectorNumber} d=${prodTop.dist.combined} printingMargin=${prodTop.printingMargin === Infinity ? "∞" : prodTop.printingMargin}` +
    ` -> settle records ${wouldPin ? `the art winner ${prodTop.setCode.toUpperCase()} ${prodTop.collectorNumber} (pinned by art)` : `the named default ${named.set.toUpperCase()} ${named.collector_number}`} — WRONG either way (true printing absent from the set)` +
    ` | ENLARGED winner ${enlTop.setCode} ${enlTop.collectorNumber} d=${enlTop.dist.combined} printingMargin=${enlTop.printingMargin === Infinity ? "∞" : enlTop.printingMargin} ${enlTop.scryfallId === c.id ? "✓ TRUE PRINTING" : "✗ still wrong"}`,
  );
}
// Control: the default printing's own query under the production set.
{
  const qCanvas = resizeTo(await loadImageCanvas(named.image_uris!.normal!, `${named.set}-${named.collector_number}-normal`), finder.CANONICAL_W, finder.CANONICAL_H);
  const prod = finder.rankReferences([fpOf(qCanvas)], prodRefs);
  const top = prod[0]!;
  console.log(`control query ${named.set} ${named.collector_number} (the default itself): production winner ${top.setCode} ${top.collectorNumber} d=${top.dist.combined} — the set can only ever crown one of its own 8`);
}
