import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const collections = sqliteTable("collections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const collectionItems = sqliteTable("collection_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  collectionId: integer("collection_id").notNull().default(1),
  scryfallId: text("scryfall_id").notNull(),
  name: text("name").notNull(),
  setCode: text("set_code").notNull().default(""),
  setName: text("set_name").notNull().default(""),
  collectorNumber: text("collector_number").notNull().default(""),
  rarity: text("rarity").notNull().default(""),
  foil: integer("foil").notNull().default(0),
  quantity: integer("quantity").notNull().default(1),
  condition: text("condition").notNull().default("Near Mint"),
  language: text("language").notNull().default("English"),
  manaCost: text("mana_cost").notNull().default(""),
  cmc: real("cmc").notNull().default(0),
  typeLine: text("type_line").notNull().default(""),
  oracleText: text("oracle_text").notNull().default(""),
  colors: text("colors").notNull().default("[]"),
  colorIdentity: text("color_identity").notNull().default("[]"),
  imageSmall: text("image_small").notNull().default(""),
  imageNormal: text("image_normal").notNull().default(""),
  priceUsd: real("price_usd"),
  priceUsdFoil: real("price_usd_foil"),
  priceAtAdd: real("price_at_add"),
  baselineNote: text("baseline_note").notNull().default(""),
  lastPrice: real("last_price"),
  lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
  edhrecRank: integer("edhrec_rank"),
  scryfallUri: text("scryfall_uri").notNull().default(""),
  addedAt: integer("added_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const scanListItems = sqliteTable("scan_list_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scryfallId: text("scryfall_id").notNull(),
  name: text("name").notNull(),
  setCode: text("set_code").notNull().default(""),
  setName: text("set_name").notNull().default(""),
  collectorNumber: text("collector_number").notNull().default(""),
  rarity: text("rarity").notNull().default(""),
  foil: integer("foil").notNull().default(0),
  quantity: integer("quantity").notNull().default(1),
  condition: text("condition").notNull().default("Near Mint"),
  language: text("language").notNull().default("English"),
  manaCost: text("mana_cost").notNull().default(""),
  cmc: real("cmc").notNull().default(0),
  typeLine: text("type_line").notNull().default(""),
  oracleText: text("oracle_text").notNull().default(""),
  colors: text("colors").notNull().default("[]"),
  colorIdentity: text("color_identity").notNull().default("[]"),
  imageSmall: text("image_small").notNull().default(""),
  imageNormal: text("image_normal").notNull().default(""),
  priceUsd: real("price_usd"),
  priceUsdFoil: real("price_usd_foil"),
  edhrecRank: integer("edhrec_rank"),
  scryfallUri: text("scryfall_uri").notNull().default(""),
  printsSearchUri: text("prints_search_uri").notNull().default(""),
  artist: text("artist").notNull().default(""),
  releasedAt: text("released_at").notNull().default(""),
  finishes: text("finishes").notNull().default("[]"),
  /** Blob key of the compressed card photo captured at scan time ('' = none).
   * Lets "Detect version" re-read the bottom line later without rescanning. */
  cardImageBlobKey: text("card_image_blob_key").notNull().default(""),
  /** Pass 25: 1 when the recorded printing was PINNED by evidence
   * (collector number, art match with margin, bottom-line salvage,
   * Detect version, or the user's own version pick); 0 when the scan
   * settled the NAME only and the printing shown is Scryfall's
   * default for that name — the list badges those rows "printing
   * unconfirmed" instead of letting a default pass as a detection.
   * Legacy rows default to 1 (their pinning state is unknowable
   * retroactively); every new scan add passes the flag explicitly. */
  printingConfirmed: integer("printing_confirmed").notNull().default(1),
  addedAt: integer("added_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const decks = sqliteTable("decks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  commanderName: text("commander_name"),
  commanderScryfallId: text("commander_scryfall_id"),
  commanderImage: text("commander_image"),
  commanderColorIdentity: text("commander_color_identity"),
  commanderTypeLine: text("commander_type_line"),
  commanderOracleText: text("commander_oracle_text"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const deckCards = sqliteTable("deck_cards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deckId: integer("deck_id").notNull(),
  scryfallId: text("scryfall_id").notNull(),
  name: text("name").notNull(),
  quantity: integer("quantity").notNull().default(1),
  isCommander: integer("is_commander").notNull().default(0),
  manaCost: text("mana_cost").notNull().default(""),
  cmc: real("cmc").notNull().default(0),
  typeLine: text("type_line").notNull().default(""),
  oracleText: text("oracle_text").notNull().default(""),
  colors: text("colors").notNull().default("[]"),
  colorIdentity: text("color_identity").notNull().default("[]"),
  imageSmall: text("image_small").notNull().default(""),
  rarity: text("rarity").notNull().default(""),
  edhrecRank: integer("edhrec_rank"),
  collectionItemId: integer("collection_item_id"),
  foil: integer("foil").notNull().default(0),
  setCode: text("set_code").notNull().default(""),
  setName: text("set_name").notNull().default(""),
  collectorNumber: text("collector_number").notNull().default(""),
  condition: text("condition").notNull().default("Near Mint"),
  language: text("language").notNull().default("English"),
  priceUsd: real("price_usd"),
  priceUsdFoil: real("price_usd_foil"),
  addedAt: integer("added_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const priceHistory = sqliteTable("price_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  itemId: integer("item_id").notNull(),
  price: real("price").notNull(),
  foil: integer("foil").notNull().default(0),
  checkedAt: integer("checked_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
