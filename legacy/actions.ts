// ManaBox Program — server actions.
// Scryfall is the source of truth for card data. The lightweight card-names
// catalog is fetched here and cached on the client (localStorage) so OCR /
// search matching happens 100% locally and instantly. Full card details are
// fetched one card at a time, only after a name is matched.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { and, asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";

const cardSchema = z.object({
  scryfallId: z.string(),
  name: z.string(),
  setCode: z.string(),
  setName: z.string(),
  collectorNumber: z.string(),
  rarity: z.string(),
  manaCost: z.string(),
  cmc: z.number(),
  typeLine: z.string(),
  oracleText: z.string(),
  colors: z.array(z.string()),
  colorIdentity: z.array(z.string()),
  imageSmall: z.string(),
  imageNormal: z.string(),
  priceUsd: z.number().nullable(),
  priceUsdFoil: z.number().nullable(),
  edhrecRank: z.number().nullable(),
  scryfallUri: z.string(),
  printsSearchUri: z.string(),
  artist: z.string(),
  releasedAt: z.string(),
  finishes: z.array(z.string()),
  /** Pass 27: Scryfall's treatment flags for the printing — the
   * image channel carries them into its reference set so a full-art
   * / borderless winner with a too-close full-art rival can be
   * demoted to "printing unconfirmed" instead of recorded wrong. */
  fullArt: z.boolean(),
  borderColor: z.string(),
});

type Card = z.infer<typeof cardSchema>;

const collectionItemSchema = z.object({
  id: z.number(),
  collectionId: z.number(),
  scryfallId: z.string(),
  name: z.string(),
  setCode: z.string(),
  setName: z.string(),
  collectorNumber: z.string(),
  rarity: z.string(),
  foil: z.boolean(),
  quantity: z.number(),
  condition: z.string(),
  language: z.string(),
  manaCost: z.string(),
  cmc: z.number(),
  typeLine: z.string(),
  oracleText: z.string(),
  colors: z.array(z.string()),
  colorIdentity: z.array(z.string()),
  imageSmall: z.string(),
  imageNormal: z.string(),
  priceUsd: z.number().nullable(),
  priceUsdFoil: z.number().nullable(),
  priceAtAdd: z.number().nullable(),
  baselineNote: z.string(),
  lastPrice: z.number().nullable(),
  lastCheckedAt: z.string().nullable(),
  edhrecRank: z.number().nullable(),
  scryfallUri: z.string(),
  addedAt: z.string(),
});

const deckSchema = z.object({
  id: z.number(),
  name: z.string(),
  commanderName: z.string().nullable(),
  commanderScryfallId: z.string().nullable(),
  commanderImage: z.string().nullable(),
  commanderColorIdentity: z.array(z.string()).nullable(),
  commanderTypeLine: z.string().nullable(),
  commanderOracleText: z.string().nullable(),
  cardCount: z.number(),
  totalValue: z.number(),
  createdAt: z.string(),
});

const collectionInfoSchema = z.object({
  id: z.number(),
  name: z.string(),
  createdAt: z.string(),
});

const scanItemSchema = z.object({
  id: z.number(),
  scryfallId: z.string(),
  name: z.string(),
  setCode: z.string(),
  setName: z.string(),
  collectorNumber: z.string(),
  rarity: z.string(),
  foil: z.boolean(),
  quantity: z.number(),
  condition: z.string(),
  language: z.string(),
  manaCost: z.string(),
  cmc: z.number(),
  typeLine: z.string(),
  oracleText: z.string(),
  colors: z.array(z.string()),
  colorIdentity: z.array(z.string()),
  imageSmall: z.string(),
  imageNormal: z.string(),
  priceUsd: z.number().nullable(),
  priceUsdFoil: z.number().nullable(),
  edhrecRank: z.number().nullable(),
  scryfallUri: z.string(),
  printsSearchUri: z.string(),
  artist: z.string(),
  releasedAt: z.string(),
  finishes: z.array(z.string()),
  hasCardImage: z.boolean(),
  /** Pass 25: false when the scan settled the card's NAME only and
   * the printing shown is Scryfall's default for the name — the
   * scan list badges the row "printing unconfirmed". */
  printingConfirmed: z.boolean(),
  addedAt: z.string(),
});

const deckCardSchema = z.object({
  id: z.number(),
  deckId: z.number(),
  scryfallId: z.string(),
  name: z.string(),
  quantity: z.number(),
  isCommander: z.boolean(),
  manaCost: z.string(),
  cmc: z.number(),
  typeLine: z.string(),
  oracleText: z.string(),
  colors: z.array(z.string()),
  colorIdentity: z.array(z.string()),
  imageSmall: z.string(),
  rarity: z.string(),
  edhrecRank: z.number().nullable(),
  collectionItemId: z.number().nullable(),
  foil: z.boolean(),
  setCode: z.string(),
  setName: z.string(),
  collectorNumber: z.string(),
  condition: z.string(),
  language: z.string(),
  priceUsd: z.number().nullable(),
  priceUsdFoil: z.number().nullable(),
});

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scryfallFetch(url: string): Promise<Response> {
  const headers = {
    "User-Agent": "ManaBoxProgram/1.0 (Muse web artifact)",
    Accept: "application/json;q=0.9,*/*;q=0.8",
  };
  let res = await fetch(url, { headers });
  if (res.status === 429) {
    // One retry after a short backoff, per Scryfall etiquette.
    await sleep(1200);
    res = await fetch(url, { headers });
  }
  return res;
}

/** The foil-aware unit price: foil (or etched) price for foil items, else normal. */
function unitPriceOf(
  priceUsd: number | null | undefined,
  priceUsdFoil: number | null | undefined,
  foil: boolean,
): number | null {
  if (foil) return priceUsdFoil ?? priceUsd ?? null;
  return priceUsd ?? null;
}

function dateLabel(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface FreshPriceResult {
  prices: Map<string, { usd: number | null; usdFoil: number | null }>;
  /** Distinct printings requested. */
  requested: number;
  /** Chunks (≤75 identifiers each) that were sent. */
  chunks: number;
  /** Chunks that failed or stalled — their printings keep old prices. */
  failedChunks: number;
  /** Wall time of the fetch phase. */
  ms: number;
}

/**
 * Fresh prices for many printings via Scryfall's POST /cards/collection
 * endpoint (identifiers, batches of up to 75). Always a live fetch —
 * never the in-memory caches — so a price refresh is real.
 *
 * FAST + BOUNDED + PARTIAL (the old version fetched chunks SERIALLY
 * with a 30s timeout each and then did a per-item history SELECT, so
 * even a 4-card refresh could exceed the action's time budget and die
 * with "The operation timed out"): chunks now run in PARALLEL, each
 * capped at ~8s, and a failed/stalled chunk never fails the refresh —
 * every price that returns is applied.
 */
async function fetchFreshPrices(scryfallIds: string[]): Promise<FreshPriceResult> {
  const started = Date.now();
  const prices = new Map<string, { usd: number | null; usdFoil: number | null }>();
  const unique = [...new Set(scryfallIds)];
  const batches: string[][] = [];
  for (let start = 0; start < unique.length; start += 75) {
    batches.push(unique.slice(start, start + 75));
  }
  let failedChunks = 0;
  await Promise.all(
    batches.map(async (batch) => {
      const headers = {
        "User-Agent": "ManaBoxProgram/1.0 (Muse web artifact)",
        Accept: "application/json;q=0.9,*/*;q=0.8",
        "Content-Type": "application/json",
      };
      const body = JSON.stringify({ identifiers: batch.map((id) => ({ id })) });
      try {
        let res = await fetch("https://api.scryfall.com/cards/collection", {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(8_000),
        });
        if (res.status === 429) {
          await sleep(600);
          res = await fetch("https://api.scryfall.com/cards/collection", {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(8_000),
          });
        }
        if (!res.ok) {
          failedChunks += 1;
          return;
        }
        const parsed = (await res.json()) as { data?: ScryfallCardRaw[] };
        for (const raw of parsed.data ?? []) {
          if (!raw.id) continue;
          prices.set(raw.id, {
            usd: toPrice(raw.prices?.usd),
            usdFoil:
              toPrice(raw.prices?.usd_foil) ?? toPrice(raw.prices?.usd_etched),
          });
        }
      } catch {
        failedChunks += 1;
      }
    }),
  );
  return {
    prices,
    requested: unique.length,
    chunks: batches.length,
    failedChunks,
    ms: Date.now() - started,
  };
}

interface ScryfallCardRaw {
  id?: string;
  name?: string;
  set?: string;
  set_name?: string;
  collector_number?: string;
  rarity?: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  colors?: string[];
  color_identity?: string[];
  image_uris?: { small?: string; normal?: string; large?: string };
  card_faces?: Array<{
    name?: string;
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    colors?: string[];
    image_uris?: { small?: string; normal?: string; large?: string };
  }>;
  prices?: { usd?: string | null; usd_foil?: string | null; usd_etched?: string | null };
  edhrec_rank?: number;
  scryfall_uri?: string;
  prints_search_uri?: string;
  artist?: string;
  released_at?: string;
  finishes?: string[];
  full_art?: boolean;
  border_color?: string;
}

function toPrice(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCard(raw: ScryfallCardRaw): Card {
  const face = raw.card_faces?.[0];
  const images = raw.image_uris ?? face?.image_uris ?? {};
  const oracleParts: string[] = [];
  if (raw.oracle_text) oracleParts.push(raw.oracle_text);
  if (raw.card_faces) {
    for (const f of raw.card_faces) {
      if (f.oracle_text && !oracleParts.includes(f.oracle_text)) {
        oracleParts.push(f.oracle_text);
      }
    }
  }
  return {
    scryfallId: raw.id ?? "",
    name: raw.name ?? "",
    setCode: raw.set ?? "",
    setName: raw.set_name ?? "",
    collectorNumber: raw.collector_number ?? "",
    rarity: raw.rarity ?? "",
    manaCost: raw.mana_cost ?? face?.mana_cost ?? "",
    cmc: typeof raw.cmc === "number" ? raw.cmc : 0,
    typeLine: raw.type_line ?? face?.type_line ?? "",
    oracleText: oracleParts.join("\n//\n"),
    colors: raw.colors ?? face?.colors ?? [],
    colorIdentity: raw.color_identity ?? [],
    imageSmall: images.small ?? "",
    imageNormal: images.normal ?? images.large ?? "",
    priceUsd: toPrice(raw.prices?.usd),
    priceUsdFoil: toPrice(raw.prices?.usd_foil) ?? toPrice(raw.prices?.usd_etched),
    edhrecRank: typeof raw.edhrec_rank === "number" ? raw.edhrec_rank : null,
    scryfallUri: raw.scryfall_uri ?? "",
    printsSearchUri: raw.prints_search_uri ?? "",
    artist: raw.artist ?? "",
    releasedAt: raw.released_at ?? "",
    finishes: Array.isArray(raw.finishes) ? raw.finishes : [],
    fullArt: raw.full_art === true,
    borderColor: raw.border_color ?? "",
  };
}

// In-memory Scryfall caches: repeat cards and printings lists are common in
// a scanning session (same card scanned twice, version checks per scan), so
// they are fetched from Scryfall at most once per server lifetime.
const namedCache = new Map<string, Card | null>();
const printingsCache = new Map<string, Card[]>();

async function fetchPrintingsList(printsSearchUri: string, opts: { full?: boolean } = {}): Promise<Card[]> {
  const cacheKey = opts.full ? `${printsSearchUri}|full` : printsSearchUri;
  const cached = printingsCache.get(cacheKey);
  if (cached) return cached;
  const url = new URL(printsSearchUri);
  if (url.hostname !== "api.scryfall.com") return [];
  url.searchParams.set("unique", "prints");
  url.searchParams.set("order", "released");
  url.searchParams.set("dir", "desc");
  // Default (automatic paths — salvage, the image channel): the 60
  // newest printings, one request, latency-bounded.
  // FULL (deliberate picker actions only, Pass 25): follow the
  // search pagination so EVERY printing is listed. The 60 cap made
  // older printings literally unpickable — all six Swamp #274
  // printings sit at released-desc ranks 61..176+ of 930, outside
  // the capped list — so a user whose card was mis-recorded had no
  // way to correct it to their actual printing.
  const pageCap = opts.full ? 10 : 1;
  const all: Card[] = [];
  let next: string | null = url.toString();
  for (let page = 0; page < pageCap && next; page++) {
    const res = await scryfallFetch(next);
    if (!res.ok) break;
    const body = (await res.json()) as { data?: ScryfallCardRaw[]; has_more?: boolean; next_page?: string };
    for (const raw of body.data ?? []) all.push(normalizeCard(raw));
    if (!opts.full) break;
    next = body.has_more && body.next_page ? body.next_page : null;
  }
  const printings = opts.full ? all : all.slice(0, 60);
  printingsCache.set(cacheKey, printings);
  return printings;
}

const setNumberCache = new Map<string, Card | null>();

/** Exact printing lookup by (set code, collector number) — the printed
 * bottom line of the card. A hit is a CERTAIN identification including
 * the exact printing; a 404 means the pair doesn't exist. */
async function fetchBySetNumber(set: string, number: string): Promise<Card | null> {
  const cacheKey = `${set.toLowerCase()}/${number.toLowerCase()}`;
  const hit = setNumberCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const url = `https://api.scryfall.com/cards/${encodeURIComponent(set.toLowerCase())}/${encodeURIComponent(number.toLowerCase())}`;
  const res = await scryfallFetch(url);
  if (!res.ok) {
    setNumberCache.set(cacheKey, null);
    return null;
  }
  const raw = (await res.json()) as ScryfallCardRaw;
  if (!raw || typeof raw.name !== "string") {
    setNumberCache.set(cacheKey, null);
    return null;
  }
  const card = normalizeCard(raw);
  setNumberCache.set(cacheKey, card);
  return card;
}

async function fetchNamed(
  name: string,
  mode: "exact" | "fuzzy",
): Promise<Card | null> {
  const cacheKey = `${mode}:${name.toLowerCase()}`;
  const hit = namedCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const url = `https://api.scryfall.com/cards/named?${mode}=${encodeURIComponent(name)}`;
  const res = await scryfallFetch(url);
  if (!res.ok) {
    namedCache.set(cacheKey, null);
    return null;
  }
  const raw = (await res.json()) as ScryfallCardRaw;
  if (!raw || typeof raw.name !== "string") {
    namedCache.set(cacheKey, null);
    return null;
  }
  const card = normalizeCard(raw);
  namedCache.set(cacheKey, card);
  return card;
}

function collectionRowToOut(
  row: typeof schema.collectionItems.$inferSelect,
): z.infer<typeof collectionItemSchema> {
  return {
    id: row.id,
    collectionId: row.collectionId,
    scryfallId: row.scryfallId,
    name: row.name,
    setCode: row.setCode,
    setName: row.setName,
    collectorNumber: row.collectorNumber,
    rarity: row.rarity,
    foil: row.foil === 1,
    quantity: row.quantity,
    condition: row.condition,
    language: row.language,
    manaCost: row.manaCost,
    cmc: row.cmc,
    typeLine: row.typeLine,
    oracleText: row.oracleText,
    colors: parseJsonArray(row.colors),
    colorIdentity: parseJsonArray(row.colorIdentity),
    imageSmall: row.imageSmall,
    imageNormal: row.imageNormal,
    priceUsd: row.priceUsd,
    priceUsdFoil: row.priceUsdFoil,
    priceAtAdd: row.priceAtAdd,
    baselineNote: row.baselineNote,
    lastPrice: row.lastPrice,
    lastCheckedAt: row.lastCheckedAt ? row.lastCheckedAt.toISOString() : null,
    edhrecRank: row.edhrecRank,
    scryfallUri: row.scryfallUri,
    addedAt: row.addedAt.toISOString(),
  };
}

function deckCardRowToOut(
  row: typeof schema.deckCards.$inferSelect,
): z.infer<typeof deckCardSchema> {
  return {
    id: row.id,
    deckId: row.deckId,
    scryfallId: row.scryfallId,
    name: row.name,
    quantity: row.quantity,
    isCommander: row.isCommander === 1,
    manaCost: row.manaCost,
    cmc: row.cmc,
    typeLine: row.typeLine,
    oracleText: row.oracleText,
    colors: parseJsonArray(row.colors),
    colorIdentity: parseJsonArray(row.colorIdentity),
    imageSmall: row.imageSmall,
    rarity: row.rarity,
    edhrecRank: row.edhrecRank,
    collectionItemId: row.collectionItemId,
    foil: row.foil === 1,
    setCode: row.setCode,
    setName: row.setName,
    collectorNumber: row.collectorNumber,
    condition: row.condition,
    language: row.language,
    priceUsd: row.priceUsd,
    priceUsdFoil: row.priceUsdFoil,
  };
}

function scanRowToOut(
  row: typeof schema.scanListItems.$inferSelect,
): z.infer<typeof scanItemSchema> {
  return {
    id: row.id,
    scryfallId: row.scryfallId,
    name: row.name,
    setCode: row.setCode,
    setName: row.setName,
    collectorNumber: row.collectorNumber,
    rarity: row.rarity,
    foil: row.foil === 1,
    quantity: row.quantity,
    condition: row.condition,
    language: row.language,
    manaCost: row.manaCost,
    cmc: row.cmc,
    typeLine: row.typeLine,
    oracleText: row.oracleText,
    colors: parseJsonArray(row.colors),
    colorIdentity: parseJsonArray(row.colorIdentity),
    imageSmall: row.imageSmall,
    imageNormal: row.imageNormal,
    priceUsd: row.priceUsd,
    priceUsdFoil: row.priceUsdFoil,
    edhrecRank: row.edhrecRank,
    scryfallUri: row.scryfallUri,
    printsSearchUri: row.printsSearchUri,
    artist: row.artist,
    releasedAt: row.releasedAt,
    finishes: parseJsonArray(row.finishes),
    hasCardImage: row.cardImageBlobKey.length > 0,
    printingConfirmed: row.printingConfirmed === 1,
    addedAt: row.addedAt.toISOString(),
  };
}

type Db = ReturnType<Ctx["db"]>;

/** Store a scan-time card photo (base64 JPEG) as a blob; returns its key. */
async function storeScanImage(ctx: Ctx, base64: string): Promise<string> {
  const bytes = Buffer.from(base64, "base64");
  const key = `scan-list/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
  await ctx.blobs.put(key, bytes, { contentType: "image/jpeg" });
  return key;
}

/** Best-effort blob cleanup — a failed delete must never fail the action. */
async function deleteBlobQuiet(ctx: Ctx, key: string): Promise<void> {
  if (!key) return;
  try {
    await ctx.blobs.delete(key);
  } catch {
    /* orphaned blobs are harmless */
  }
}

/** Insert-or-merge a card into a collection; returns the row and whether it merged. */
async function insertCollectionItem(
  db: Db,
  collectionId: number,
  c: Card,
  foil: boolean,
  quantity: number,
  condition: string,
  language = "English",
): Promise<{ row: typeof schema.collectionItems.$inferSelect; merged: boolean }> {
  const existing = await db
    .select()
    .from(schema.collectionItems)
    .where(
      and(
        eq(schema.collectionItems.collectionId, collectionId),
        eq(schema.collectionItems.scryfallId, c.scryfallId),
        eq(schema.collectionItems.foil, foil ? 1 : 0),
        eq(schema.collectionItems.condition, condition),
        eq(schema.collectionItems.language, language),
      ),
    )
    .limit(1);
  const found = existing[0];
  if (found) {
    const newQty = Math.min(9999, found.quantity + quantity);
    await db
      .update(schema.collectionItems)
      .set({ quantity: newQty, updatedAt: new Date() })
      .where(eq(schema.collectionItems.id, found.id));
    return { row: { ...found, quantity: newQty }, merged: true };
  }
  const inserted = await db
    .insert(schema.collectionItems)
    .values({
      collectionId,
      scryfallId: c.scryfallId,
      name: c.name,
      setCode: c.setCode,
      setName: c.setName,
      collectorNumber: c.collectorNumber,
      rarity: c.rarity,
      foil: foil ? 1 : 0,
      quantity,
      condition,
      language,
      manaCost: c.manaCost,
      cmc: c.cmc,
      typeLine: c.typeLine,
      oracleText: c.oracleText,
      colors: JSON.stringify(c.colors),
      colorIdentity: JSON.stringify(c.colorIdentity),
      imageSmall: c.imageSmall,
      imageNormal: c.imageNormal,
      priceUsd: c.priceUsd,
      priceUsdFoil: c.priceUsdFoil,
      priceAtAdd: unitPriceOf(c.priceUsd, c.priceUsdFoil, foil),
      lastPrice: unitPriceOf(c.priceUsd, c.priceUsdFoil, foil),
      lastCheckedAt: new Date(),
      edhrecRank: c.edhrecRank,
      scryfallUri: c.scryfallUri,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("insertCollectionItem: insert returned no rows");
  return { row, merged: false };
}

/** The default (first) collection id, creating 'Main Collection' if none exists. */
async function firstCollectionId(
  db: Db,
): Promise<{ id: number; name: string }> {
  const rows = await db
    .select()
    .from(schema.collections)
    .orderBy(asc(schema.collections.id))
    .limit(1);
  const found = rows[0];
  if (found) return { id: found.id, name: found.name };
  const inserted = await db
    .insert(schema.collections)
    .values({ name: "Main Collection" })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("firstCollectionId: insert returned no rows");
  return { id: row.id, name: row.name };
}

function scanRowToCard(row: typeof schema.scanListItems.$inferSelect): Card {
  return {
    scryfallId: row.scryfallId,
    name: row.name,
    setCode: row.setCode,
    setName: row.setName,
    collectorNumber: row.collectorNumber,
    rarity: row.rarity,
    manaCost: row.manaCost,
    cmc: row.cmc,
    typeLine: row.typeLine,
    oracleText: row.oracleText,
    colors: parseJsonArray(row.colors),
    colorIdentity: parseJsonArray(row.colorIdentity),
    imageSmall: row.imageSmall,
    imageNormal: row.imageNormal,
    priceUsd: row.priceUsd,
    priceUsdFoil: row.priceUsdFoil,
    edhrecRank: row.edhrecRank,
    scryfallUri: row.scryfallUri,
    printsSearchUri: row.printsSearchUri,
    artist: row.artist,
    releasedAt: row.releasedAt,
    finishes: parseJsonArray(row.finishes),
    // Pass 27: treatment flags aren't persisted on scan rows; the
    // version flows that need them re-fetch printings from Scryfall.
    fullArt: false,
    borderColor: "",
  };
}

// ---------------------------------------------------------------------------
// Pass 24b — TOKEN NAMES. Scryfall's /catalog/card-names EXCLUDES token
// printings (layout=token / double_faced_token) entirely, so the local
// title matcher could never match a token's name ("Cadet" was not a
// failed match — it was a missing universe). Token names come from the
// search API instead: q=(layout:token or layout:double_faced_token),
// unique=cards — measured 2026-11-10: 1,019 cards, 677 distinct names
// over 6 pages. Obvious non-card ephemera sharing the token layout
// (World Championship bios/decklists/ads, checklists, minigame cards)
// is excluded by name pattern; everything else — including short
// marker names like "The Monarch" / "Morph" — stays, and the matcher's
// own evidence bars (plus the debris-pool regression suite) police
// false title matches. Cached in-memory for a day: the list changes
// only when a new set releases, and a failed token fetch must never
// fail the names download — it degrades to the catalog alone.
// ---------------------------------------------------------------------------
let tokenNamesCache: { names: string[]; at: number } | null = null;
const TOKEN_NAME_EXCLUDE = /(\bBio\b|Decklist|Checklist|World Championships Ad|\(minigame\))/;

async function fetchTokenNames(): Promise<string[]> {
  if (tokenNamesCache && Date.now() - tokenNamesCache.at < 24 * 3600_000) {
    return tokenNamesCache.names;
  }
  try {
    const names = new Set<string>();
    let url: string | null =
      "https://api.scryfall.com/cards/search?q=" +
      encodeURIComponent("(layout:token or layout:double_faced_token)") +
      "&unique=cards";
    for (let page = 0; page < 12 && url; page++) {
      const res = await scryfallFetch(url);
      if (!res.ok) break;
      const body = (await res.json()) as {
        data?: { name?: string }[];
        has_more?: boolean;
        next_page?: string;
      };
      for (const c of body.data ?? []) {
        if (typeof c.name === "string" && c.name) names.add(c.name);
      }
      url = body.has_more && body.next_page ? body.next_page : null;
    }
    const filtered = [...names].filter((n) => !TOKEN_NAME_EXCLUDE.test(n));
    if (filtered.length > 0) {
      tokenNamesCache = { names: filtered, at: Date.now() };
    }
    return filtered;
  } catch {
    return tokenNamesCache?.names ?? [];
  }
}

export const Actions = {
  getCardNames: defineAction({
    description:
      "Downloads Scryfall's lightweight card-names catalog PLUS the token names the catalog excludes (layout=token printings, from the search API), merged, so the client can cache the full index locally for instant OCR and search matching.",
    request: z.object({}),
    response: z.object({
      names: z.array(z.string()),
      total: z.number(),
      tokenTotal: z.number(),
      fetchedAt: z.string(),
    }),
    async handler() {
      const res = await scryfallFetch(
        "https://api.scryfall.com/catalog/card-names",
      );
      if (!res.ok) {
        throw new Error(`Scryfall card-names download failed (${res.status})`);
      }
      const body = (await res.json()) as {
        data?: string[];
        total_values?: number;
      };
      const catalog = Array.isArray(body.data) ? body.data : [];
      const tokenNames = await fetchTokenNames();
      const have = new Set(catalog.map((n) => n.toLowerCase()));
      const merged = [...catalog];
      let added = 0;
      for (const n of tokenNames) {
        if (!have.has(n.toLowerCase())) {
          merged.push(n);
          added += 1;
        }
      }
      return {
        names: merged,
        total: merged.length,
        tokenTotal: added,
        fetchedAt: new Date().toISOString(),
      };
    },
  }),

  getCardByName: defineAction({
    description:
      "Fetches one card's full details, image and prices from Scryfall by exact name.",
    request: z.object({ name: z.string().min(1).max(200) }),
    response: z.object({ card: cardSchema.nullable() }),
    async handler(_ctx, args) {
      const card = await fetchNamed(args.name, "exact");
      return { card };
    },
  }),

  getCardFuzzy: defineAction({
    description:
      "Backup lookup: asks Scryfall's fuzzy named endpoint to resolve an imperfect OCR read when local matching found nothing.",
    request: z.object({ name: z.string().min(1).max(200) }),
    response: z.object({ card: cardSchema.nullable() }),
    async handler(_ctx, args) {
      const card = await fetchNamed(args.name, "fuzzy");
      return { card };
    },
  }),

  getCardBySetNumber: defineAction({
    description:
      "Exact printing lookup by set code + collector number read from the card's printed bottom line (GET /cards/{set}/{number}); a hit is a certain identification of the exact printing.",
    request: z.object({
      set: z.string().min(2).max(6),
      number: z.string().min(1).max(12),
    }),
    response: z.object({ card: cardSchema.nullable() }),
    async handler(_ctx, args) {
      const card = await fetchBySetNumber(args.set, args.number);
      return { card };
    },
  }),

  getPrintings: defineAction({
    description:
      "Loads printings of a card from its Scryfall prints_search_uri so the user can pick their exact set and collector number. Default: the 60 newest (automatic paths). With full=true (version pickers): every printing, following the search pagination.",
    request: z.object({ printsSearchUri: z.string().url().max(2000), full: z.boolean().optional() }),
    response: z.object({ printings: z.array(cardSchema) }),
    async handler(_ctx, args) {
      const url = new URL(args.printsSearchUri);
      if (url.hostname !== "api.scryfall.com") {
        throw new Error("Printings must come from api.scryfall.com");
      }
      const printings = await fetchPrintingsList(args.printsSearchUri, { full: args.full === true });
      return { printings };
    },
  }),

  getPrintingsByScryfallId: defineAction({
    description:
      "Loads every printing of the card with the given Scryfall ID (used to change a saved collection entry's version).",
    request: z.object({ scryfallId: z.string().min(1).max(64) }),
    response: z.object({ printings: z.array(cardSchema) }),
    async handler(_ctx, args) {
      const res = await scryfallFetch(
        `https://api.scryfall.com/cards/${encodeURIComponent(args.scryfallId)}`,
      );
      if (!res.ok) return { printings: [] };
      const card = normalizeCard((await res.json()) as ScryfallCardRaw);
      if (!card.printsSearchUri) return { printings: [card] };
      const list = await fetchPrintingsList(card.printsSearchUri, { full: true });
      return { printings: list.length > 0 ? list : [card] };
    },
  }),

  searchCardsToGet: defineAction({
    description:
      "Searches Scryfall for popular cards inside a commander's colour identity, ordered by EDHREC rank, for the deck suggestions panel.",
    request: z.object({
      colorIdentity: z.array(z.string()).max(5),
      excludeNames: z.array(z.string()).max(500),
    }),
    response: z.object({ cards: z.array(cardSchema) }),
    async handler(_ctx, args) {
      const idPart =
        args.colorIdentity.length > 0
          ? args.colorIdentity.join("")
          : "c";
      const q = `id<=${idPart} legal:commander -is:land sort:edhrec`;
      const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=cards&order=edhrec`;
      const res = await scryfallFetch(url);
      if (!res.ok) return { cards: [] };
      const body = (await res.json()) as { data?: ScryfallCardRaw[] };
      const exclude = new Set(
        args.excludeNames.map((n) => n.toLowerCase()),
      );
      const cards = (body.data ?? [])
        .map(normalizeCard)
        .filter((c) => !exclude.has(c.name.toLowerCase()))
        .slice(0, 24);
      return { cards };
    },
  }),

  readTitleBand: defineAction({
    description:
      "Reads the card-name text from a cropped title-band scan image using the vision model, returning the raw text lines for local fuzzy matching.",
    request: z.object({
      imageBase64: z.string().min(100).max(4_000_000),
    }),
    response: z.object({ lines: z.array(z.string()) }),
    async handler(ctx, args) {
      const result = await ctx.inference.complete(
        "You are an OCR reader for Magic: The Gathering card title bands. The image shows only the top title strip of a card, possibly in two treatments side by side or stacked. Transcribe the card name text you can read. Return each distinct plausible reading of the card name as a separate line candidate, most confident first. Include only the card name text — no mana symbols, no set symbols, no extra words, no explanation.",
        {
          schema: z.object({ lines: z.array(z.string()) }),
          images: [
            {
              dataBase64: args.imageBase64,
              mimeType: "image/jpeg",
              caption:
                "Title band crop of a Magic: The Gathering card (upscaled, grayscale/contrast-enhanced treatments pooled).",
            },
          ],
        },
      );
      return { lines: result.lines.filter((l) => l.trim().length > 0) };
    },
  }),

  readBottomBand: defineAction({
    description:
      "Reads the bottom info strip of a scanned card (collector number, set code, foil star separator, artist) to detect the exact printing.",
    request: z.object({ imageBase64: z.string().min(100).max(4_000_000) }),
    response: z.object({
      collectorNumber: z.string().nullable(),
      setCode: z.string().nullable(),
      separator: z.enum(["star", "bullet", "none", "unknown"]),
      artist: z.string().nullable(),
      lines: z.array(z.string()),
    }),
    async handler(ctx, args) {
      const result = await ctx.inference.complete(
        "You are reading the bottom information strip of a Magic: The Gathering card. It typically shows, left side: a collector number (digits, sometimes like 240/318 — return only the part before any slash), underneath it a set code (2-4 capital letters like CMR, CMD, SLD) followed by a separator symbol (a star ★ means a foil/etched printing, a bullet • means non-foil) and a language code like EN, then the artist's name preceded by a small paintbrush icon. Right side may show copyright text and year. Extract exactly what you can read. Return collectorNumber as digits only (no slash part), setCode in uppercase, separator as star/bullet/none/unknown, artist as the person's name only, and lines as the raw text lines you read.",
        {
          schema: z.object({
            collectorNumber: z.string().nullable(),
            setCode: z.string().nullable(),
            separator: z.enum(["star", "bullet", "none", "unknown"]),
            artist: z.string().nullable(),
            lines: z.array(z.string()),
          }),
          images: [
            {
              dataBase64: args.imageBase64,
              mimeType: "image/jpeg",
              caption: "Bottom info strip crop of a Magic: The Gathering card, upscaled.",
            },
          ],
        },
      );
      return {
        collectorNumber: result.collectorNumber?.replace(/[^0-9]/g, "") || null,
        setCode: result.setCode?.toUpperCase().replace(/[^A-Z0-9]/g, "") || null,
        separator: result.separator,
        artist: result.artist?.trim() || null,
        lines: result.lines.filter((l) => l.trim().length > 0),
      };
    },
  }),

  readCardFrame: defineAction({
    description:
      "Single combined scan read: from one composite image (title band treatments on top, bottom info strip below) returns BOTH the card-name lines and the bottom-band printing info in one call.",
    request: z.object({ imageBase64: z.string().min(100).max(6_000_000) }),
    response: z.object({
      titleLines: z.array(z.string()),
      collectorNumber: z.string().nullable(),
      setCode: z.string().nullable(),
      separator: z.enum(["star", "bullet", "none", "unknown"]),
      artist: z.string().nullable(),
      bottomLines: z.array(z.string()),
    }),
    async handler(ctx, args) {
      const result = await ctx.inference.complete(
        "You are reading a composite scan image of a Magic: The Gathering card. The TOP part shows the card's title band (the name strip) in two contrast treatments. The BOTTOM part shows the card's bottom information strip. Do both reads: (1) titleLines — each distinct plausible reading of the card NAME from the top part, most confident first, name text only, no mana symbols or extra words. (2) From the bottom strip: collectorNumber (digits only, the part before any slash), setCode (2-4 capital letters like CMR or SLD), separator (star if a ★ follows the set code — that means foil/etched; bullet if a • follows — non-foil; none/unknown otherwise), artist (the person's name after the paintbrush icon, name only), and bottomLines (the raw text lines you read in the bottom strip).",
        {
          schema: z.object({
            titleLines: z.array(z.string()),
            collectorNumber: z.string().nullable(),
            setCode: z.string().nullable(),
            separator: z.enum(["star", "bullet", "none", "unknown"]),
            artist: z.string().nullable(),
            bottomLines: z.array(z.string()),
          }),
          images: [
            {
              dataBase64: args.imageBase64,
              mimeType: "image/jpeg",
              caption:
                "Composite: card title band treatments (top) and bottom info strip (bottom) of one Magic: The Gathering card.",
            },
          ],
        },
      );
      return {
        titleLines: result.titleLines.filter((l) => l.trim().length > 0),
        collectorNumber: result.collectorNumber?.replace(/[^0-9]/g, "") || null,
        setCode: result.setCode?.toUpperCase().replace(/[^A-Z0-9]/g, "") || null,
        separator: result.separator,
        artist: result.artist?.trim() || null,
        bottomLines: result.bottomLines.filter((l) => l.trim().length > 0),
      };
    },
  }),

  identifyByImage: defineAction({
    description:
      "Image-recognition channel (ManaBox-style): identifies a Magic card from a dewarped full-card image by its ARTWORK and frame — not by reading the title — returning up to 3 candidate names with confidences. Every candidate is verified against Scryfall before it is returned, so an invented name can never reach the client's fusion gate; the client then measures the real perceptual-hash distance to each candidate's reference images and only that measured distance can settle a scan.",
    request: z.object({ imageBase64: z.string().min(100).max(6_000_000) }),
    response: z.object({
      candidates: z.array(
        z.object({ name: z.string(), confidence: z.number() }),
      ),
    }),
    async handler(_ctx, args) {
      const result = await _ctx.inference.complete(
        "You are identifying a Magic: The Gathering card from a photo of the card itself, the way artwork-recognition scanners (like ManaBox) do: primarily by the ARTWORK — the illustration's subject, composition and colours — secondarily by the card frame, colour identity, type line and any visible text. The photo is a straightened (dewarped) crop of one card; the title may be shadowed, blurry or partly cut off, so do not depend on reading the name. Return up to 3 candidate card names, most likely first, each with a confidence from 0 to 1 reflecting how distinctive the artwork match is. Only name real Magic cards you genuinely recognise from the artwork; if the image shows no recognisable card, return an empty list.",
        {
          schema: z.object({
            candidates: z.array(
              z.object({ name: z.string(), confidence: z.number() }),
            ),
          }),
          images: [
            {
              dataBase64: args.imageBase64,
              mimeType: "image/jpeg",
              caption:
                "Dewarped full-card image of one Magic: The Gathering card, straightened upright.",
            },
          ],
        },
      );
      // VERIFY every proposal against Scryfall: an invented or
      // misremembered name is dropped here and can never settle a
      // scan downstream. Exact first, fuzzy as the spelling repair.
      const verified: { name: string; confidence: number }[] = [];
      const seen = new Set<string>();
      for (const cand of result.candidates.slice(0, 3)) {
        const rawName = cand.name.trim();
        if (!rawName) continue;
        let card = await fetchNamed(rawName, "exact");
        if (!card) card = await fetchNamed(rawName, "fuzzy");
        if (!card) continue;
        if (seen.has(card.name)) continue;
        seen.add(card.name);
        verified.push({
          name: card.name,
          confidence: Math.max(0, Math.min(1, cand.confidence)),
        });
      }
      return { candidates: verified };
    },
  }),

  pickPrintingByImage: defineAction({
    description:
      "Asks the vision model to choose the most likely printing of a card from a full-card photo and candidate printing summaries, for odd frames where the bottom info line cannot be read.",
    request: z.object({
      imageBase64: z.string().min(100).max(6_000_000),
      candidates: z
        .array(
          z.object({
            scryfallId: z.string(),
            summary: z.string().max(400),
          }),
        )
        .min(1)
        .max(30),
    }),
    response: z.object({
      scryfallId: z.string().nullable(),
      reason: z.string(),
    }),
    async handler(ctx, args) {
      const list = args.candidates
        .map((c, i) => `${i + 1}. id=${c.scryfallId} — ${c.summary}`)
        .join("\n");
      const result = await ctx.inference.complete(
        `You are identifying which exact printing of a Magic: The Gathering card is in the photo. Compare visual cues: the set symbol on the type line (right side of the middle bar), the card frame and border style (modern, retro, etched foil, showcase, borderless, Secret Lair style layouts), the artwork, any visible collector number or set code at the bottom, and the card's finish. Candidate printings:\n${list}\nReturn the id of the single most likely candidate, or null if you genuinely cannot distinguish them. In reason, briefly name the visual cues you used.`,
        {
          schema: z.object({
            scryfallId: z.string().nullable(),
            reason: z.string(),
          }),
          images: [
            {
              dataBase64: args.imageBase64,
              mimeType: "image/jpeg",
              caption: "Full photo of the scanned Magic: The Gathering card.",
            },
          ],
        },
      );
      const valid = args.candidates.some((c) => c.scryfallId === result.scryfallId);
      return { scryfallId: valid ? result.scryfallId : null, reason: result.reason };
    },
  }),

  listCollection: defineAction({
    description:
      "Lists cards in the user's saved collections; pass a collectionId to list just that one collection.",
    request: z.object({ collectionId: z.number().int().positive().optional() }),
    response: z.object({ items: z.array(collectionItemSchema) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const base = db.select().from(schema.collectionItems);
      const rows = args.collectionId
        ? await base
            .where(eq(schema.collectionItems.collectionId, args.collectionId))
            .orderBy(desc(schema.collectionItems.id))
        : await base.orderBy(desc(schema.collectionItems.id));
      return { items: rows.map(collectionRowToOut) };
    },
  }),

  listCollections: defineAction({
    description: "Lists the user's named collections.",
    request: z.object({}),
    response: z.object({ collections: z.array(collectionInfoSchema) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.collections)
        .orderBy(asc(schema.collections.id));
      return {
        collections: rows.map((r) => ({
          id: r.id,
          name: r.name,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  createCollection: defineAction({
    description: "Creates a new named collection.",
    request: z.object({ name: z.string().min(1).max(80) }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.collections)
        .values({ name: args.name })
        .returning({ id: schema.collections.id });
      const row = inserted[0];
      if (!row) throw new Error("createCollection: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  renameCollection: defineAction({
    description: "Renames a collection.",
    request: z.object({
      id: z.number().int().positive(),
      name: z.string().min(1).max(80),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.collections)
        .set({ name: args.name, updatedAt: new Date() })
        .where(eq(schema.collections.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteCollection: defineAction({
    description:
      "Deletes a collection AND every card in it (the client warns the user first).",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.collectionItems)
        .where(eq(schema.collectionItems.collectionId, args.id));
      await db
        .delete(schema.collections)
        .where(eq(schema.collections.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  addToCollection: defineAction({
    description:
      "Adds a card to the collection; if the same printing + foil + condition already exists, its quantity is increased instead.",
    request: z.object({
      card: cardSchema,
      foil: z.boolean(),
      quantity: z.number().int().min(1).max(999),
      condition: z.string().max(40).default("Near Mint"),
      language: z.string().max(40).default("English"),
      collectionId: z.number().int().positive().optional(),
    }),
    response: z.object({
      item: collectionItemSchema,
      merged: z.boolean(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const target = args.collectionId
        ? { id: args.collectionId, name: "" }
        : await firstCollectionId(db);
      const { row, merged } = await insertCollectionItem(
        db,
        target.id,
        args.card,
        args.foil,
        args.quantity,
        args.condition,
        args.language,
      );
      ctx.invalidateQueries();
      return { item: collectionRowToOut(row), merged };
    },
  }),

  updateCollectionItem: defineAction({
    description:
      "Updates a collection item's quantity, foil flag or condition; a quantity of zero removes it.",
    request: z.object({
      id: z.number().int().positive(),
      quantity: z.number().int().min(0).max(9999).optional(),
      foil: z.boolean().optional(),
      condition: z.string().max(40).optional(),
      language: z.string().max(40).optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      if (args.quantity === 0) {
        await db
          .delete(schema.collectionItems)
          .where(eq(schema.collectionItems.id, args.id));
      } else {
        const patch: Partial<typeof schema.collectionItems.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (args.quantity !== undefined) patch.quantity = args.quantity;
        if (args.condition !== undefined) patch.condition = args.condition;
        if (args.language !== undefined) patch.language = args.language;
        if (args.foil !== undefined) {
          patch.foil = args.foil ? 1 : 0;
          // Like-for-like: toggling foil changes which price applies, so the
          // baseline resets to the new configuration's current price.
          const rows = await db
            .select()
            .from(schema.collectionItems)
            .where(eq(schema.collectionItems.id, args.id))
            .limit(1);
          const current = rows[0];
          if (current && (current.foil === 1) !== args.foil) {
            const unit = unitPriceOf(current.priceUsd, current.priceUsdFoil, args.foil);
            patch.priceAtAdd = unit;
            patch.lastPrice = unit;
            patch.lastCheckedAt = new Date();
            patch.baselineNote = `Baseline reset ${dateLabel(new Date())} (foil changed)`;
          }
        }
        await db
          .update(schema.collectionItems)
          .set(patch)
          .where(eq(schema.collectionItems.id, args.id));
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteCollectionItem: defineAction({
    description: "Removes one item from the collection.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.collectionItems)
        .where(eq(schema.collectionItems.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  swapCollectionPrinting: defineAction({
    description:
      "Changes a collection entry to a different printing of the same card, updating its Scryfall ID, set, collector number, image and prices.",
    request: z.object({
      id: z.number().int().positive(),
      card: cardSchema,
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const c = args.card;
      const rows = await db
        .select()
        .from(schema.collectionItems)
        .where(eq(schema.collectionItems.id, args.id))
        .limit(1);
      const current = rows[0];
      // Like-for-like: a different printing has a different price, so the
      // baseline resets to the new printing's current price.
      const unit = unitPriceOf(c.priceUsd, c.priceUsdFoil, current?.foil === 1);
      await db
        .update(schema.collectionItems)
        .set({
          scryfallId: c.scryfallId,
          setCode: c.setCode,
          setName: c.setName,
          collectorNumber: c.collectorNumber,
          rarity: c.rarity,
          manaCost: c.manaCost,
          cmc: c.cmc,
          typeLine: c.typeLine,
          oracleText: c.oracleText,
          colors: JSON.stringify(c.colors),
          colorIdentity: JSON.stringify(c.colorIdentity),
          imageSmall: c.imageSmall,
          imageNormal: c.imageNormal,
          priceUsd: c.priceUsd,
          priceUsdFoil: c.priceUsdFoil,
          priceAtAdd: unit,
          lastPrice: unit,
          lastCheckedAt: new Date(),
          baselineNote: `Baseline reset ${dateLabel(new Date())} (version changed)`,
          edhrecRank: c.edhrecRank,
          scryfallUri: c.scryfallUri,
          updatedAt: new Date(),
        })
        .where(eq(schema.collectionItems.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  refreshCollectionPrices: defineAction({
    description:
      "Fetches fresh current prices from Scryfall for every distinct printing in one collection (parallel ≤75-id chunks, ~8s cap each), applying every price that returns — partial success when a chunk stalls — updating each item's last-checked price, backfilling a labelled baseline for older items, and recording at most one price-history snapshot per item per day.",
    request: z.object({ collectionId: z.number().int().positive() }),
    response: z.object({
      updated: z.number(),
      missing: z.number(),
      total: z.number(),
      failedChunks: z.number(),
      ms: z.number(),
      checkedAt: z.string(),
    }),
    async handler(ctx, args) {
      const started = Date.now();
      const db = ctx.db<typeof schema>();
      const now = new Date();
      const items = await db
        .select()
        .from(schema.collectionItems)
        .where(eq(schema.collectionItems.collectionId, args.collectionId));
      if (items.length === 0) {
        return {
          updated: 0,
          missing: 0,
          total: 0,
          failedChunks: 0,
          ms: Date.now() - started,
          checkedAt: now.toISOString(),
        };
      }
      const fresh = await fetchFreshPrices(items.map((i) => i.scryfallId));
      // ONE history query for the whole collection (the old code ran a
      // SELECT per item inside the loop — a big part of the timeout).
      const itemIds = new Set(items.map((i) => i.id));
      const historyRows = await db.select().from(schema.priceHistory);
      const snapshottedToday = new Set(
        historyRows
          .filter((s) => itemIds.has(s.itemId) && dateLabel(s.checkedAt) === dateLabel(now))
          .map((s) => s.itemId),
      );
      let updated = 0;
      let missing = 0;
      // Writes are collected as statements and flushed with db.batch()
      // (one transaction per ~150 statements). The previous Promise.all
      // of ~600 individual writes took ~10s on a 300-item collection —
      // batching brings the whole write phase to well under a second.
      const writes: unknown[] = [];
      const flushWrites = async () => {
        for (let start = 0; start < writes.length; start += 150) {
          await db.batch(writes.slice(start, start + 150) as never);
        }
        writes.length = 0;
      };
      for (const item of items) {
        const foil = item.foil === 1;
        const f = fresh.prices.get(item.scryfallId);
        const freshUnit = f ? unitPriceOf(f.usd, f.usdFoil, foil) : null;
        // Baseline backfill for items saved before price tracking existed:
        // their stored price is the best honest baseline — label it as set
        // today on this first price check, never invent an older one.
        // Baselines are otherwise NEVER touched by a refresh.
        let priceAtAdd = item.priceAtAdd;
        let baselineNote = item.baselineNote;
        if (priceAtAdd == null) {
          priceAtAdd = unitPriceOf(item.priceUsd, item.priceUsdFoil, foil);
          baselineNote = `Baseline set ${dateLabel(now)} (first price check)`;
        }
        const patch: Partial<typeof schema.collectionItems.$inferInsert> = {
          priceAtAdd,
          baselineNote,
          lastCheckedAt: now,
          updatedAt: now,
        };
        if (f) {
          patch.priceUsd = f.usd;
          patch.priceUsdFoil = f.usdFoil;
        }
        if (freshUnit != null) {
          patch.lastPrice = freshUnit;
          updated += 1;
          // At most one history snapshot per item per day.
          if (!snapshottedToday.has(item.id)) {
            writes.push(
              db.insert(schema.priceHistory).values({
                itemId: item.id,
                price: freshUnit,
                foil: item.foil,
                checkedAt: now,
              }),
            );
          }
        } else {
          missing += 1;
        }
        writes.push(
          db
            .update(schema.collectionItems)
            .set(patch)
            .where(eq(schema.collectionItems.id, item.id)),
        );
      }
      await flushWrites();
      ctx.invalidateQueries();
      return {
        updated,
        missing,
        total: items.length,
        failedChunks: fresh.failedChunks,
        ms: Date.now() - started,
        checkedAt: now.toISOString(),
      };
    },
  }),

  getPriceHistory: defineAction({
    description:
      "Returns the recent price-check snapshots for one collection item, newest first.",
    request: z.object({ itemId: z.number().int().positive() }),
    response: z.object({
      snapshots: z.array(
        z.object({ date: z.string(), price: z.number(), foil: z.boolean() }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.priceHistory)
        .where(eq(schema.priceHistory.itemId, args.itemId))
        .orderBy(desc(schema.priceHistory.checkedAt))
        .limit(30);
      return {
        snapshots: rows.map((r) => ({
          date: r.checkedAt.toISOString(),
          price: r.price,
          foil: r.foil === 1,
        })),
      };
    },
  }),

  importCollectionRows: defineAction({
    description:
      "Imports ManaBox-format CSV rows into the collection, resolving each card against Scryfall and merging duplicates.",
    request: z.object({
      collectionId: z.number().int().positive().optional(),
      rows: z
        .array(
          z.object({
            name: z.string().min(1).max(200),
            foil: z.boolean(),
            quantity: z.number().int().min(1).max(999),
            scryfallId: z.string().max(64).optional(),
            setCode: z.string().max(10).optional(),
            collectorNumber: z.string().max(12).optional(),
            condition: z.string().max(40).optional(),
            language: z.string().max(40).optional(),
          }),
        )
        .min(1)
        .max(100),
    }),
    response: z.object({
      imported: z.number(),
      merged: z.number(),
      skipped: z.array(z.string()),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const target = args.collectionId
        ? { id: args.collectionId, name: "" }
        : await firstCollectionId(db);
      let imported = 0;
      let merged = 0;
      const skipped: string[] = [];
      for (const row of args.rows) {
        let card: Card | null = null;
        if (row.scryfallId) {
          const res = await scryfallFetch(
            `https://api.scryfall.com/cards/${encodeURIComponent(row.scryfallId)}`,
          );
          if (res.ok) {
            card = normalizeCard((await res.json()) as ScryfallCardRaw);
          }
        }
        // Exact printing from the file's set code + collector number
        // beats a fuzzy name guess when both are present.
        if (!card && row.setCode && row.collectorNumber) {
          card = await fetchBySetNumber(row.setCode, row.collectorNumber);
        }
        if (!card) card = await fetchNamed(row.name, "fuzzy");
        if (!card) {
          skipped.push(row.name);
          continue;
        }
        const condition = row.condition ?? "Near Mint";
        const language = row.language ?? "English";
        const existing = await db
          .select()
          .from(schema.collectionItems)
          .where(
            and(
              eq(schema.collectionItems.collectionId, target.id),
              eq(schema.collectionItems.scryfallId, card.scryfallId),
              eq(schema.collectionItems.foil, row.foil ? 1 : 0),
              eq(schema.collectionItems.condition, condition),
              eq(schema.collectionItems.language, language),
            ),
          )
          .limit(1);
        const found = existing[0];
        if (found) {
          await db
            .update(schema.collectionItems)
            .set({
              quantity: Math.min(9999, found.quantity + row.quantity),
              updatedAt: new Date(),
            })
            .where(eq(schema.collectionItems.id, found.id));
          merged += 1;
        } else {
          await db.insert(schema.collectionItems).values({
            collectionId: target.id,
            scryfallId: card.scryfallId,
            name: card.name,
            setCode: card.setCode,
            setName: card.setName,
            collectorNumber: card.collectorNumber,
            rarity: card.rarity,
            foil: row.foil ? 1 : 0,
            quantity: row.quantity,
            condition,
            language,
            manaCost: card.manaCost,
            cmc: card.cmc,
            typeLine: card.typeLine,
            oracleText: card.oracleText,
            colors: JSON.stringify(card.colors),
            colorIdentity: JSON.stringify(card.colorIdentity),
            imageSmall: card.imageSmall,
            imageNormal: card.imageNormal,
            priceUsd: card.priceUsd,
            priceUsdFoil: card.priceUsdFoil,
            priceAtAdd: unitPriceOf(card.priceUsd, card.priceUsdFoil, row.foil),
            lastPrice: unitPriceOf(card.priceUsd, card.priceUsdFoil, row.foil),
            lastCheckedAt: new Date(),
            edhrecRank: card.edhrecRank,
            scryfallUri: card.scryfallUri,
          });
          imported += 1;
        }
        await sleep(60);
      }
      ctx.invalidateQueries();
      return { imported, merged, skipped };
    },
  }),

  listDecks: defineAction({
    description: "Lists the user's decks with their commander and card count.",
    request: z.object({}),
    response: z.object({ decks: z.array(deckSchema) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const deckRows = await db
        .select()
        .from(schema.decks)
        .orderBy(desc(schema.decks.updatedAt));
      const out: z.infer<typeof deckSchema>[] = [];
      for (const d of deckRows) {
        const cards = await db
          .select()
          .from(schema.deckCards)
          .where(eq(schema.deckCards.deckId, d.id));
        const count = cards.reduce((sum, c) => sum + c.quantity, 0);
        const totalValue = cards.reduce((sum, c) => {
          const price = c.foil === 1 ? c.priceUsdFoil ?? c.priceUsd : c.priceUsd;
          return sum + (price ?? 0) * c.quantity;
        }, 0);
        out.push({
          id: d.id,
          name: d.name,
          commanderName: d.commanderName,
          commanderScryfallId: d.commanderScryfallId,
          commanderImage: d.commanderImage,
          commanderColorIdentity: d.commanderColorIdentity
            ? parseJsonArray(d.commanderColorIdentity)
            : null,
          commanderTypeLine: d.commanderTypeLine,
          commanderOracleText: d.commanderOracleText,
          cardCount: count,
          totalValue,
          createdAt: d.createdAt.toISOString(),
        });
      }
      return { decks: out };
    },
  }),

  createDeck: defineAction({
    description: "Creates a new empty deck.",
    request: z.object({ name: z.string().min(1).max(80) }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.decks)
        .values({ name: args.name })
        .returning({ id: schema.decks.id });
      const row = inserted[0];
      if (!row) throw new Error("createDeck: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  renameDeck: defineAction({
    description: "Renames a deck.",
    request: z.object({
      id: z.number().int().positive(),
      name: z.string().min(1).max(80),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.decks)
        .set({ name: args.name, updatedAt: new Date() })
        .where(eq(schema.decks.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteDeck: defineAction({
    description: "Deletes a deck and all of its deck cards.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.deckCards)
        .where(eq(schema.deckCards.deckId, args.id));
      await db.delete(schema.decks).where(eq(schema.decks.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setCommander: defineAction({
    description:
      "Sets (or replaces) a deck's commander card, keeping exactly one commander entry in the deck list.",
    request: z.object({
      deckId: z.number().int().positive(),
      card: cardSchema,
      collectionId: z.number().int().positive().optional(),
      foil: z.boolean().optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const c = args.card;
      const foil = args.foil ?? false;
      // The commander is also a collection card: make sure a copy exists in
      // the target collection and link the deck card to it.
      const target = args.collectionId
        ? { id: args.collectionId, name: "" }
        : await firstCollectionId(db);
      const linked = await insertCollectionItem(db, target.id, c, foil, 1, "Near Mint");
      await db
        .delete(schema.deckCards)
        .where(
          and(
            eq(schema.deckCards.deckId, args.deckId),
            eq(schema.deckCards.isCommander, 1),
          ),
        );
      // If the same card already exists as a regular entry, drop it — the
      // commander slot now represents it.
      await db
        .delete(schema.deckCards)
        .where(
          and(
            eq(schema.deckCards.deckId, args.deckId),
            eq(schema.deckCards.scryfallId, c.scryfallId),
          ),
        );
      await db.insert(schema.deckCards).values({
        deckId: args.deckId,
        scryfallId: c.scryfallId,
        name: c.name,
        quantity: 1,
        isCommander: 1,
        manaCost: c.manaCost,
        cmc: c.cmc,
        typeLine: c.typeLine,
        oracleText: c.oracleText,
        colors: JSON.stringify(c.colors),
        colorIdentity: JSON.stringify(c.colorIdentity),
        imageSmall: c.imageSmall,
        rarity: c.rarity,
        edhrecRank: c.edhrecRank,
        collectionItemId: linked.row.id,
        foil: foil ? 1 : 0,
        setCode: c.setCode,
        setName: c.setName,
        collectorNumber: c.collectorNumber,
        priceUsd: c.priceUsd,
        priceUsdFoil: c.priceUsdFoil,
      });
      await db
        .update(schema.decks)
        .set({
          commanderName: c.name,
          commanderScryfallId: c.scryfallId,
          commanderImage: c.imageNormal || c.imageSmall,
          commanderColorIdentity: JSON.stringify(c.colorIdentity),
          commanderTypeLine: c.typeLine,
          commanderOracleText: c.oracleText,
          updatedAt: new Date(),
        })
        .where(eq(schema.decks.id, args.deckId));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listDeckCards: defineAction({
    description: "Lists all cards in one deck, commander first.",
    request: z.object({ deckId: z.number().int().positive() }),
    response: z.object({ cards: z.array(deckCardSchema) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.deckCards)
        .where(eq(schema.deckCards.deckId, args.deckId))
        .orderBy(desc(schema.deckCards.isCommander), asc(schema.deckCards.name));
      return { cards: rows.map(deckCardRowToOut) };
    },
  }),

  addDeckCard: defineAction({
    description:
      "Adds a card to a deck and links it to the user's collection copy, saving one to the target collection first if they don't own it there yet.",
    request: z.object({
      deckId: z.number().int().positive(),
      card: cardSchema,
      quantity: z.number().int().min(1).max(99).default(1),
      collectionId: z.number().int().positive().optional(),
      foil: z.boolean().optional(),
    }),
    response: z.object({
      ok: z.literal(true),
      collectionName: z.string(),
      addedToCollection: z.boolean(),
    }),
    async handler(
      ctx,
      args,
    ): Promise<{ ok: true; collectionName: string; addedToCollection: boolean }> {
      const db = ctx.db<typeof schema>();
      const c = args.card;
      const foil = args.foil ?? false;
      const target = args.collectionId
        ? await (async () => {
            const rows = await db
              .select()
              .from(schema.collections)
              .where(eq(schema.collections.id, args.collectionId ?? 0))
              .limit(1);
            const found = rows[0];
            return found
              ? { id: found.id, name: found.name }
              : await firstCollectionId(db);
          })()
        : await firstCollectionId(db);
      const before = await db
        .select()
        .from(schema.collectionItems)
        .where(
          and(
            eq(schema.collectionItems.collectionId, target.id),
            eq(schema.collectionItems.scryfallId, c.scryfallId),
            eq(schema.collectionItems.foil, foil ? 1 : 0),
          ),
        )
        .limit(1);
      const owned = before[0];
      const linked = owned
        ? { row: owned, merged: true }
        : await insertCollectionItem(db, target.id, c, foil, 1, "Near Mint");
      const addedToCollection = !owned;
      const existing = await db
        .select()
        .from(schema.deckCards)
        .where(
          and(
            eq(schema.deckCards.deckId, args.deckId),
            eq(schema.deckCards.scryfallId, c.scryfallId),
            eq(schema.deckCards.isCommander, 0),
          ),
        )
        .limit(1);
      const found = existing[0];
      if (found) {
        await db
          .update(schema.deckCards)
          .set({ quantity: Math.min(999, found.quantity + args.quantity) })
          .where(eq(schema.deckCards.id, found.id));
      } else {
        await db.insert(schema.deckCards).values({
          deckId: args.deckId,
          scryfallId: c.scryfallId,
          name: c.name,
          quantity: args.quantity,
          isCommander: 0,
          manaCost: c.manaCost,
          cmc: c.cmc,
          typeLine: c.typeLine,
          oracleText: c.oracleText,
          colors: JSON.stringify(c.colors),
          colorIdentity: JSON.stringify(c.colorIdentity),
          imageSmall: c.imageSmall,
          rarity: c.rarity,
          edhrecRank: c.edhrecRank,
          collectionItemId: linked.row.id,
          foil: foil ? 1 : 0,
          setCode: c.setCode,
          setName: c.setName,
          collectorNumber: c.collectorNumber,
          priceUsd: c.priceUsd,
          priceUsdFoil: c.priceUsdFoil,
        });
      }
      await db
        .update(schema.decks)
        .set({ updatedAt: new Date() })
        .where(eq(schema.decks.id, args.deckId));
      ctx.invalidateQueries();
      return { ok: true as const, collectionName: target.name, addedToCollection };
    },
  }),


  listScanList: defineAction({
    description: "Lists the temporary scan list (staging) the user is building from scans.",
    request: z.object({}),
    response: z.object({ items: z.array(scanItemSchema) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.scanListItems)
        .orderBy(asc(schema.scanListItems.id));
      return { items: rows.map(scanRowToOut) };
    },
  }),

  addToScanList: defineAction({
    description:
      "Adds an identified card to the temporary scan list; the same printing + foil merges quantity. Optionally stores the captured card photo so the exact printing can be detected later without rescanning.",
    request: z.object({
      card: cardSchema,
      foil: z.boolean(),
      quantity: z.number().int().min(1).max(999).default(1),
      condition: z.string().max(40).default("Near Mint"),
      language: z.string().max(40).default("English"),
      cardImageBase64: z.string().max(4_000_000).optional(),
      /** Pass 25: whether the settle PINNED this printing by
       * evidence. Omitted = true (non-scan callers / legacy). */
      printingConfirmed: z.boolean().optional(),
    }),
    response: z.object({ item: scanItemSchema, merged: z.boolean() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const c = args.card;
      const confirmed = args.printingConfirmed !== false;
      const existing = await db
        .select()
        .from(schema.scanListItems)
        .where(
          and(
            eq(schema.scanListItems.scryfallId, c.scryfallId),
            eq(schema.scanListItems.foil, args.foil ? 1 : 0),
          ),
        )
        .limit(1);
      const found = existing[0];
      if (found) {
        const newQty = Math.min(9999, found.quantity + args.quantity);
        let blobKey = found.cardImageBlobKey;
        if (!blobKey && args.cardImageBase64) {
          blobKey = await storeScanImage(ctx, args.cardImageBase64);
        }
        // A merge is the same printing + foil by construction, so a
        // pinned add also confirms an unconfirmed row (and never
        // un-confirms a pinned one).
        const mergedConfirmed = found.printingConfirmed === 1 || confirmed;
        await db
          .update(schema.scanListItems)
          .set({ quantity: newQty, cardImageBlobKey: blobKey, printingConfirmed: mergedConfirmed ? 1 : 0 })
          .where(eq(schema.scanListItems.id, found.id));
        ctx.invalidateQueries();
        return { item: scanRowToOut({ ...found, quantity: newQty, cardImageBlobKey: blobKey, printingConfirmed: mergedConfirmed ? 1 : 0 }), merged: true };
      }
      const blobKey = args.cardImageBase64
        ? await storeScanImage(ctx, args.cardImageBase64)
        : "";
      const inserted = await db
        .insert(schema.scanListItems)
        .values({
          scryfallId: c.scryfallId,
          name: c.name,
          setCode: c.setCode,
          setName: c.setName,
          collectorNumber: c.collectorNumber,
          rarity: c.rarity,
          foil: args.foil ? 1 : 0,
          quantity: args.quantity,
          condition: args.condition,
          language: args.language,
          manaCost: c.manaCost,
          cmc: c.cmc,
          typeLine: c.typeLine,
          oracleText: c.oracleText,
          colors: JSON.stringify(c.colors),
          colorIdentity: JSON.stringify(c.colorIdentity),
          imageSmall: c.imageSmall,
          imageNormal: c.imageNormal,
          priceUsd: c.priceUsd,
          priceUsdFoil: c.priceUsdFoil,
          edhrecRank: c.edhrecRank,
          scryfallUri: c.scryfallUri,
          printsSearchUri: c.printsSearchUri,
          artist: c.artist,
          releasedAt: c.releasedAt,
          finishes: JSON.stringify(c.finishes),
          cardImageBlobKey: blobKey,
          printingConfirmed: confirmed ? 1 : 0,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("addToScanList: insert returned no rows");
      ctx.invalidateQueries();
      return { item: scanRowToOut(row), merged: false };
    },
  }),

  getScanItemImageUrl: defineAction({
    description:
      "Returns a fetchable URL for the photo captured when a scan-list card was scanned, so the client can re-read its bottom info line for version detection without rescanning.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ url: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.scanListItems)
        .where(eq(schema.scanListItems.id, args.id))
        .limit(1);
      const row = rows[0];
      if (!row || !row.cardImageBlobKey) return { url: null };
      const url = await ctx.blobs.getUrl(row.cardImageBlobKey);
      return { url };
    },
  }),

  updateScanListItem: defineAction({
    description:
      "Updates a scan list item's quantity or foil flag; a quantity of zero removes it.",
    request: z.object({
      id: z.number().int().positive(),
      quantity: z.number().int().min(0).max(9999).optional(),
      foil: z.boolean().optional(),
      condition: z.string().max(40).optional(),
      language: z.string().max(40).optional(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      if (args.quantity === 0) {
        const rows = await db
          .select()
          .from(schema.scanListItems)
          .where(eq(schema.scanListItems.id, args.id))
          .limit(1);
        await db
          .delete(schema.scanListItems)
          .where(eq(schema.scanListItems.id, args.id));
        await deleteBlobQuiet(ctx, rows[0]?.cardImageBlobKey ?? "");
      } else {
        const patch: Partial<typeof schema.scanListItems.$inferInsert> = {};
        if (args.quantity !== undefined) patch.quantity = args.quantity;
        if (args.foil !== undefined) patch.foil = args.foil ? 1 : 0;
        if (args.condition !== undefined) patch.condition = args.condition;
        if (args.language !== undefined) patch.language = args.language;
        if (Object.keys(patch).length > 0) {
          await db
            .update(schema.scanListItems)
            .set(patch)
            .where(eq(schema.scanListItems.id, args.id));
        }
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  removeScanListItem: defineAction({
    description: "Removes one item from the temporary scan list.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.scanListItems)
        .where(eq(schema.scanListItems.id, args.id))
        .limit(1);
      await db
        .delete(schema.scanListItems)
        .where(eq(schema.scanListItems.id, args.id));
      await deleteBlobQuiet(ctx, rows[0]?.cardImageBlobKey ?? "");
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  clearScanList: defineAction({
    description: "Empties the temporary scan list without saving anything.",
    request: z.object({}),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.scanListItems);
      await db.delete(schema.scanListItems);
      for (const row of rows) await deleteBlobQuiet(ctx, row.cardImageBlobKey);
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  swapScanListPrinting: defineAction({
    description: "Changes a scan list item to a different printing of the same card. A user-picked (or Detect-version) printing is by definition confirmed, so the swap also clears the 'printing unconfirmed' flag.",
    request: z.object({ id: z.number().int().positive(), card: cardSchema }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const c = args.card;
      await db
        .update(schema.scanListItems)
        .set({
          printingConfirmed: 1,
          scryfallId: c.scryfallId,
          setCode: c.setCode,
          setName: c.setName,
          collectorNumber: c.collectorNumber,
          rarity: c.rarity,
          manaCost: c.manaCost,
          cmc: c.cmc,
          typeLine: c.typeLine,
          oracleText: c.oracleText,
          colors: JSON.stringify(c.colors),
          colorIdentity: JSON.stringify(c.colorIdentity),
          imageSmall: c.imageSmall,
          imageNormal: c.imageNormal,
          priceUsd: c.priceUsd,
          priceUsdFoil: c.priceUsdFoil,
          edhrecRank: c.edhrecRank,
          scryfallUri: c.scryfallUri,
          printsSearchUri: c.printsSearchUri,
          artist: c.artist,
          releasedAt: c.releasedAt,
          finishes: JSON.stringify(c.finishes),
        })
        .where(eq(schema.scanListItems.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  moveScanListToCollection: defineAction({
    description:
      "Moves the whole scan list into a chosen existing collection or a brand-new named one, then empties the list.",
    request: z.object({
      collectionId: z.number().int().positive().optional(),
      newCollectionName: z.string().min(1).max(80).optional(),
    }),
    response: z.object({
      collectionId: z.number(),
      collectionName: z.string(),
      moved: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      let target: { id: number; name: string };
      if (args.newCollectionName) {
        const inserted = await db
          .insert(schema.collections)
          .values({ name: args.newCollectionName })
          .returning();
        const row = inserted[0];
        if (!row) throw new Error("moveScanListToCollection: insert returned no rows");
        target = { id: row.id, name: row.name };
      } else if (args.collectionId) {
        const rows = await db
          .select()
          .from(schema.collections)
          .where(eq(schema.collections.id, args.collectionId))
          .limit(1);
        const found = rows[0];
        target = found ? { id: found.id, name: found.name } : await firstCollectionId(db);
      } else {
        target = await firstCollectionId(db);
      }
      const items = await db
        .select()
        .from(schema.scanListItems)
        .orderBy(asc(schema.scanListItems.id));
      let moved = 0;
      for (const item of items) {
        await insertCollectionItem(db, target.id, scanRowToCard(item), item.foil === 1, item.quantity, item.condition, item.language);
        moved += 1;
      }
      await db.delete(schema.scanListItems);
      for (const item of items) await deleteBlobQuiet(ctx, item.cardImageBlobKey);
      ctx.invalidateQueries();
      return { collectionId: target.id, collectionName: target.name, moved };
    },
  }),

  makeDeckFromScanList: defineAction({
    description:
      "Turns the scan list into a new deck (optionally with one listed card as commander) and saves the same cards into a collection — a new one named after the deck by default — linking deck cards to their collection copies. Empties the scan list.",
    request: z.object({
      deckName: z.string().min(1).max(80),
      commanderScryfallId: z.string().max(64).optional(),
      collectionId: z.number().int().positive().optional(),
      newCollectionName: z.string().min(1).max(80).optional(),
    }),
    response: z.object({
      deckId: z.number(),
      collectionId: z.number(),
      collectionName: z.string(),
      moved: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const items = await db
        .select()
        .from(schema.scanListItems)
        .orderBy(asc(schema.scanListItems.id));
      if (items.length === 0) throw new Error("The scan list is empty.");
      let target: { id: number; name: string };
      if (args.collectionId) {
        const rows = await db
          .select()
          .from(schema.collections)
          .where(eq(schema.collections.id, args.collectionId))
          .limit(1);
        const found = rows[0];
        target = found ? { id: found.id, name: found.name } : await firstCollectionId(db);
      } else {
        const inserted = await db
          .insert(schema.collections)
          .values({ name: args.newCollectionName ?? args.deckName })
          .returning();
        const row = inserted[0];
        if (!row) throw new Error("makeDeckFromScanList: collection insert returned no rows");
        target = { id: row.id, name: row.name };
      }
      const deckInserted = await db
        .insert(schema.decks)
        .values({ name: args.deckName })
        .returning({ id: schema.decks.id });
      const deckRow = deckInserted[0];
      if (!deckRow) throw new Error("makeDeckFromScanList: deck insert returned no rows");
      const commanderItem = args.commanderScryfallId
        ? items.find((i) => i.scryfallId === args.commanderScryfallId)
        : undefined;
      let moved = 0;
      for (const item of items) {
        const card = scanRowToCard(item);
        const linked = await insertCollectionItem(db, target.id, card, item.foil === 1, item.quantity, item.condition, item.language);
        const isCommander = commanderItem ? item.id === commanderItem.id : false;
        await db.insert(schema.deckCards).values({
          deckId: deckRow.id,
          scryfallId: item.scryfallId,
          name: item.name,
          quantity: isCommander ? 1 : item.quantity,
          isCommander: isCommander ? 1 : 0,
          manaCost: item.manaCost,
          cmc: item.cmc,
          typeLine: item.typeLine,
          oracleText: item.oracleText,
          colors: item.colors,
          colorIdentity: item.colorIdentity,
          imageSmall: item.imageSmall,
          rarity: item.rarity,
          edhrecRank: item.edhrecRank,
          collectionItemId: linked.row.id,
          foil: item.foil,
          setCode: item.setCode,
          setName: item.setName,
          collectorNumber: item.collectorNumber,
          condition: item.condition,
          language: item.language,
          priceUsd: item.priceUsd,
          priceUsdFoil: item.priceUsdFoil,
        });
        moved += 1;
      }
      if (commanderItem) {
        await db
          .update(schema.decks)
          .set({
            commanderName: commanderItem.name,
            commanderScryfallId: commanderItem.scryfallId,
            commanderImage: commanderItem.imageNormal || commanderItem.imageSmall,
            commanderColorIdentity: commanderItem.colorIdentity,
            commanderTypeLine: commanderItem.typeLine,
            commanderOracleText: commanderItem.oracleText,
            updatedAt: new Date(),
          })
          .where(eq(schema.decks.id, deckRow.id));
      }
      await db.delete(schema.scanListItems);
      for (const item of items) await deleteBlobQuiet(ctx, item.cardImageBlobKey);
      ctx.invalidateQueries();
      return { deckId: deckRow.id, collectionId: target.id, collectionName: target.name, moved };
    },
  }),

  listDeckMembership: defineAction({
    description:
      "Lists which decks contain each card (by Scryfall ID) so collection items can show 'In: <deck>' badges.",
    request: z.object({}),
    response: z.object({
      links: z.array(
        z.object({
          scryfallId: z.string(),
          deckId: z.number(),
          deckName: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const deckRows = await db.select().from(schema.decks);
      const nameById = new Map(deckRows.map((d) => [d.id, d.name]));
      const cards = await db.select().from(schema.deckCards);
      const seen = new Set<string>();
      const links: { scryfallId: string; deckId: number; deckName: string }[] = [];
      for (const c of cards) {
        const key = `${c.scryfallId}:${c.deckId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const deckName = nameById.get(c.deckId);
        if (deckName) links.push({ scryfallId: c.scryfallId, deckId: c.deckId, deckName });
      }
      return { links };
    },
  }),

  updateDeckCard: defineAction({
    description:
      "Changes a deck card's quantity; zero removes it (the commander cannot be removed this way).",
    request: z.object({
      id: z.number().int().positive(),
      quantity: z.number().int().min(0).max(999),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.deckCards)
        .where(eq(schema.deckCards.id, args.id))
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: true };
      if (row.isCommander === 1) return { ok: true };
      if (args.quantity === 0) {
        await db
          .delete(schema.deckCards)
          .where(eq(schema.deckCards.id, args.id));
      } else {
        await db
          .update(schema.deckCards)
          .set({ quantity: args.quantity })
          .where(eq(schema.deckCards.id, args.id));
      }
      await db
        .update(schema.decks)
        .set({ updatedAt: new Date() })
        .where(eq(schema.decks.id, row.deckId));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  exportBackup: defineAction({
    description:
      "Exports ONE backup object with every collection, its items (incl. condition, language and price baselines), every deck and its deck cards, for the client to save as a .json file.",
    request: z.object({}),
    response: z.object({
      version: z.literal(1),
      exportedAt: z.string(),
      collections: z.array(
        z.object({
          name: z.string(),
          items: z.array(
            collectionItemSchema.omit({ id: true, collectionId: true }),
          ),
        }),
      ),
      decks: z.array(
        z.object({
          name: z.string(),
          commanderName: z.string().nullable(),
          cards: z.array(deckCardSchema.omit({ id: true, deckId: true })),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const collRows = await db
        .select()
        .from(schema.collections)
        .orderBy(asc(schema.collections.id));
      const itemRows = await db.select().from(schema.collectionItems);
      const deckRows = await db
        .select()
        .from(schema.decks)
        .orderBy(asc(schema.decks.id));
      const deckCardRows = await db.select().from(schema.deckCards);
      return {
        version: 1 as const,
        exportedAt: new Date().toISOString(),
        collections: collRows.map((c) => ({
          name: c.name,
          items: itemRows
            .filter((i) => i.collectionId === c.id)
            .map((i) => {
              const out = collectionRowToOut(i);
              return {
                scryfallId: out.scryfallId,
                name: out.name,
                setCode: out.setCode,
                setName: out.setName,
                collectorNumber: out.collectorNumber,
                rarity: out.rarity,
                foil: out.foil,
                quantity: out.quantity,
                condition: out.condition,
                language: out.language,
                manaCost: out.manaCost,
                cmc: out.cmc,
                typeLine: out.typeLine,
                oracleText: out.oracleText,
                colors: out.colors,
                colorIdentity: out.colorIdentity,
                imageSmall: out.imageSmall,
                imageNormal: out.imageNormal,
                priceUsd: out.priceUsd,
                priceUsdFoil: out.priceUsdFoil,
                priceAtAdd: out.priceAtAdd,
                baselineNote: out.baselineNote,
                lastPrice: out.lastPrice,
                lastCheckedAt: out.lastCheckedAt,
                edhrecRank: out.edhrecRank,
                scryfallUri: out.scryfallUri,
                addedAt: out.addedAt,
              };
            }),
        })),
        decks: deckRows.map((d) => ({
          name: d.name,
          commanderName: d.commanderName,
          cards: deckCardRows
            .filter((c) => c.deckId === d.id)
            .map((c) => {
              const out = deckCardRowToOut(c);
              return {
                scryfallId: out.scryfallId,
                name: out.name,
                quantity: out.quantity,
                isCommander: out.isCommander,
                manaCost: out.manaCost,
                cmc: out.cmc,
                typeLine: out.typeLine,
                oracleText: out.oracleText,
                colors: out.colors,
                colorIdentity: out.colorIdentity,
                imageSmall: out.imageSmall,
                rarity: out.rarity,
                edhrecRank: out.edhrecRank,
                collectionItemId: out.collectionItemId,
                foil: out.foil,
                setCode: out.setCode,
                setName: out.setName,
                collectorNumber: out.collectorNumber,
                condition: out.condition,
                language: out.language,
                priceUsd: out.priceUsd,
                priceUsdFoil: out.priceUsdFoil,
              };
            }),
        })),
      };
    },
  }),

  restoreBackup: defineAction({
    description:
      "Restores a backup produced by exportBackup. Nothing is overwritten: a collection or deck whose name already exists is restored as a new copy named '<name> (restored)'. Deck cards are re-linked to the restored collection copies by Scryfall ID where possible.",
    request: z.object({
      backup: z.object({
        version: z.number(),
        collections: z
          .array(
            z.object({
              name: z.string().min(1).max(120),
              items: z
                .array(
                  z.object({
                    scryfallId: z.string().max(64),
                    name: z.string().max(300),
                    setCode: z.string().max(20),
                    setName: z.string().max(200),
                    collectorNumber: z.string().max(20),
                    rarity: z.string().max(40),
                    foil: z.boolean(),
                    quantity: z.number().int().min(1).max(9999),
                    condition: z.string().max(40),
                    language: z.string().max(40),
                    manaCost: z.string().max(200),
                    cmc: z.number(),
                    typeLine: z.string().max(300),
                    oracleText: z.string().max(8000),
                    colors: z.array(z.string()).max(10),
                    colorIdentity: z.array(z.string()).max(10),
                    imageSmall: z.string().max(2000),
                    imageNormal: z.string().max(2000),
                    priceUsd: z.number().nullable(),
                    priceUsdFoil: z.number().nullable(),
                    priceAtAdd: z.number().nullable(),
                    baselineNote: z.string().max(300),
                    lastPrice: z.number().nullable(),
                    lastCheckedAt: z.string().nullable(),
                    edhrecRank: z.number().nullable(),
                    scryfallUri: z.string().max(2000),
                    addedAt: z.string().max(40),
                  }),
                )
                .max(10000),
            }),
          )
          .max(200),
        decks: z
          .array(
            z.object({
              name: z.string().min(1).max(120),
              commanderName: z.string().max(300).nullable(),
              cards: z
                .array(
                  z.object({
                    scryfallId: z.string().max(64),
                    name: z.string().max(300),
                    quantity: z.number().int().min(1).max(999),
                    isCommander: z.boolean(),
                    manaCost: z.string().max(200),
                    cmc: z.number(),
                    typeLine: z.string().max(300),
                    oracleText: z.string().max(8000),
                    colors: z.array(z.string()).max(10),
                    colorIdentity: z.array(z.string()).max(10),
                    imageSmall: z.string().max(2000),
                    rarity: z.string().max(40),
                    edhrecRank: z.number().nullable(),
                    collectionItemId: z.number().nullable(),
                    foil: z.boolean(),
                    setCode: z.string().max(20),
                    setName: z.string().max(200),
                    collectorNumber: z.string().max(20),
                    condition: z.string().max(40),
                    language: z.string().max(40),
                    priceUsd: z.number().nullable(),
                    priceUsdFoil: z.number().nullable(),
                  }),
                )
                .max(2000),
            }),
          )
          .max(200),
      }),
    }),
    response: z.object({
      collections: z.number(),
      items: z.number(),
      decks: z.number(),
      deckCards: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existingColls = await db.select().from(schema.collections);
      const usedCollNames = new Set(existingColls.map((c) => c.name));
      const existingDecks = await db.select().from(schema.decks);
      const usedDeckNames = new Set(existingDecks.map((d) => d.name));
      const restoredName = (name: string, used: Set<string>): string => {
        if (!used.has(name)) {
          used.add(name);
          return name;
        }
        let candidate = `${name} (restored)`;
        let n = 2;
        while (used.has(candidate)) {
          candidate = `${name} (restored ${n})`;
          n += 1;
        }
        used.add(candidate);
        return candidate;
      };
      let collections = 0;
      let items = 0;
      let decks = 0;
      let deckCards = 0;
      // scryfallId -> restored collection item id (for deck re-linking).
      const restoredItemByScryfall = new Map<string, number>();
      for (const coll of args.backup.collections) {
        const name = restoredName(coll.name, usedCollNames);
        const inserted = await db
          .insert(schema.collections)
          .values({ name })
          .returning({ id: schema.collections.id });
        const collRow = inserted[0];
        if (!collRow) continue;
        collections += 1;
        for (const item of coll.items) {
          const rows = await db
            .insert(schema.collectionItems)
            .values({
              collectionId: collRow.id,
              scryfallId: item.scryfallId,
              name: item.name,
              setCode: item.setCode,
              setName: item.setName,
              collectorNumber: item.collectorNumber,
              rarity: item.rarity,
              foil: item.foil ? 1 : 0,
              quantity: item.quantity,
              condition: item.condition,
              language: item.language,
              manaCost: item.manaCost,
              cmc: item.cmc,
              typeLine: item.typeLine,
              oracleText: item.oracleText,
              colors: JSON.stringify(item.colors),
              colorIdentity: JSON.stringify(item.colorIdentity),
              imageSmall: item.imageSmall,
              imageNormal: item.imageNormal,
              priceUsd: item.priceUsd,
              priceUsdFoil: item.priceUsdFoil,
              priceAtAdd: item.priceAtAdd,
              baselineNote: item.baselineNote,
              lastPrice: item.lastPrice,
              lastCheckedAt: item.lastCheckedAt ? new Date(item.lastCheckedAt) : null,
              edhrecRank: item.edhrecRank,
              scryfallUri: item.scryfallUri,
            })
            .returning({ id: schema.collectionItems.id });
          const row = rows[0];
          if (row) {
            items += 1;
            if (!restoredItemByScryfall.has(item.scryfallId)) {
              restoredItemByScryfall.set(item.scryfallId, row.id);
            }
          }
        }
      }
      for (const deck of args.backup.decks) {
        const name = restoredName(deck.name, usedDeckNames);
        const commander = deck.cards.find((c) => c.isCommander);
        const inserted = await db
          .insert(schema.decks)
          .values({
            name,
            commanderName: commander?.name ?? deck.commanderName,
            commanderScryfallId: commander?.scryfallId ?? null,
            commanderImage: commander?.imageSmall ?? null,
            commanderColorIdentity: commander
              ? JSON.stringify(commander.colorIdentity)
              : null,
            commanderTypeLine: commander?.typeLine ?? null,
            commanderOracleText: commander?.oracleText ?? null,
          })
          .returning({ id: schema.decks.id });
        const deckRow = inserted[0];
        if (!deckRow) continue;
        decks += 1;
        for (const card of deck.cards) {
          await db.insert(schema.deckCards).values({
            deckId: deckRow.id,
            scryfallId: card.scryfallId,
            name: card.name,
            quantity: card.quantity,
            isCommander: card.isCommander ? 1 : 0,
            manaCost: card.manaCost,
            cmc: card.cmc,
            typeLine: card.typeLine,
            oracleText: card.oracleText,
            colors: JSON.stringify(card.colors),
            colorIdentity: JSON.stringify(card.colorIdentity),
            imageSmall: card.imageSmall,
            rarity: card.rarity,
            edhrecRank: card.edhrecRank,
            collectionItemId:
              restoredItemByScryfall.get(card.scryfallId) ?? null,
            foil: card.foil ? 1 : 0,
            setCode: card.setCode,
            setName: card.setName,
            collectorNumber: card.collectorNumber,
            condition: card.condition,
            language: card.language,
            priceUsd: card.priceUsd,
            priceUsdFoil: card.priceUsdFoil,
          });
          deckCards += 1;
        }
      }
      ctx.invalidateQueries();
      return { collections, items, decks, deckCards };
    },
  }),
} satisfies ActionsModule;
