import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";
import {
autocomplete,
buildArchidektCsv,
buildManaBoxCsv,
buildMoxfieldTxt,
buildNameIndex,
categoriseCard,
CATEGORIES,
COLOR_NAMES,
fitsIdentity,
formatMoney,
formatSignedMoney,
friendlyError,
cleanNameVerdict,
isCommanderEligible,
isNoRead,
LANGUAGES,
loadNamesCache,
bottomSetCodeHint,
matchNames,
matchNamesPooled,
matchPrintingByBottom,
ocrCandidates,
parseManaBoxCsvDetailed,
priceMovement,
printingLine,
printingSummary,
salvagePrintingFromBottom,
saveNamesCache,
yearOf,
type ExportRow,
type BottomBandRead,
type Category,
type MatchResult,
type NameEntry,
type NamesCache,
type VersionInfo,
} from "./lib";
import {
BAND_VARIANTS,
BOTTOM_BAND,
BOTTOM_BAND_CONTRAST,
BOTTOM_BAND_TALL,
BOTTOM_READ_CAP_MS,
TITLE_DESKEW_BANDS,
TITLE_READ_CAP_MS,
TITLE_RESCUE_BANDS,
TITLE_TALL_BAND,
aimBottomSpec,
aimTitleSpec,
buildBandCanvas,
beginScanAttempt,
ensureOcrWorker,
isGarbageRead,
ocrBand,
ocrBottomBand,
ocrBottomBandCapped,
ocrTitleBandCapped,
onOcrStatus,
onScannerEvent,
resetOcrSession,
warmUpOcr,
type OcrStatus,
} from "./ocr";
import { parseBottomLine, buildNumberCandidates, setCodesNear, type BottomLineHit } from "./bottomline";
import { selectReferencePrintings } from "./printingselect";
import { cssRectToSource, GUIDE_NAME_ZONE } from "./geometry";
import {
applyRectAuthority,
correctCardAspect,
cropToRect,
describePrepRect,
detectInCanvas,
expandRect,
freshTrackedRect,
meanLuminance,
observeTrackedRect,
prepareCardFromFrame,
presentationComplete,
rectPlausibleVsSeat,
seedTrackedRect,
type CardRect,
type RectOrigin,
type TrackedRectState,
} from "./detect";
import { RapidMachine, decideRapidMatch, retainedFrameMatchesScene, signatureDiff } from "./rapid";
import { burstFocusVerdict, describeAfState, FOCUS_SETTLE_MS, focusPlan, measureTitleSharpness, retainedSharpnessGate, SHARPNESS_FLOOR, sharpestIndex, sharpnessOrder, softAttemptPlan } from "./focus";
import { ScanDebugTracker, type ScanDebugData } from "./scandebug";
import {
AttemptClock,
AttemptGuard,
ATTEMPT_DEADLINE_MS,
BLEACHED_BAND_REASON,
bottomSkipStageNote,
cappedRead,
debugStorageKey,
fusionWaitBudgetMs,
IMAGE_SETTLE_GRACE_MS,
IMAGE_VISION_CAP_MS,
RESCUE_AFTER_WAIT_BUDGET_MS,
raceWithCap,
rescueByCollectorNumber,
numberPinDecision,
type NumberPinDecision,
resolveDebugOpen,
settleWithFeedbackFirst,
WATCHDOG_BASE_MS,
watchdogAction,
watchdogClockDeferral,
watchdogImageDeferral,
watchdogRecoveryPlan,
watchdogShieldDeferral,
type DebugContext,
} from "./scanflow";
import { applyTorchDetailed, torchCapabilityValue, torchSupport, type TorchSupport, type TorchTrackLike } from "./torch";
import {
BOTTOM_ZONE,
LIGHT_ENGAGE_P90,
MANUAL_GAIN_MAX,
MANUAL_GAIN_MIN,
MANUAL_PRESETS,
MAX_LIFT_GAIN,
TITLE_ZONE,
TOO_DARK_RAPID_HINT,
beginAttemptLight,
clampManualGain,
createLightLatch,
endAttemptLight,
lightChipText,
lightVerdictLine,
liftCanvasCopy,
liftForMode,
liftSpecWithGain,
manualExposureValue,
meterBand,
nextLightMode,
noteExternalLightApplication,
parseLightMode,
parseManualGain,
scanFailureMessage,
stepLightLatch,
type BandMeter,
type LightAction,
type LightLatchState,
type LightMode,
} from "./autolight";
import {
CANONICAL_H,
CANONICAL_W,
consensusRank,
fingerprintCanvas,
fullArtPinBlocked,
rankReferences,
rectHypotheses,
type Fingerprint,
type RankedCandidate,
type ReferenceEntry,
} from "./finder";
import { conflictEvidenceLine, corroborationFor, describeImageChannel, describeImageChannelOutcome, ensureImageLine, IMAGE_NOT_RUN_LINE, fuseChannels, imageGateState, imageSuggestionScore, numberHitInterlock, type FusionOutcome, type ImageChannelStatus } from "./fusion";

type CardT = NonNullable<ApiResponse<typeof api, "getCardByName">["card"]>;
type CollectionItem = ApiResponse<
  typeof api,
  "listCollection"
>["items"][number];
type Deck = ApiResponse<typeof api, "listDecks">["decks"][number];
type DeckCard = ApiResponse<typeof api, "listDeckCards">["cards"][number];
type ScanItem = ApiResponse<typeof api, "listScanList">["items"][number];
type CollectionInfo = ApiResponse<typeof api, "listCollections">["collections"][number];

type Tab = "scan" | "search" | "collection" | "decks";

const CONDITIONS = ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"];

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

function ManaDots({ identity, size = 18 }: { identity: string[]; size?: number }) {
  const bg: Record<string, string> = {
    W: "#f8f3d8",
    U: "#5b8fd6",
    B: "#4a4453",
    R: "#e0684e",
    G: "#5fa463",
  };
  if (identity.length === 0) {
    return (
      <span
        className="inline-flex items-center justify-center rounded-full text-[10px] font-bold"
        style={{ width: size, height: size, background: "#8a8a8a", color: "#101114" }}
        aria-label="Colourless"
      >
        C
      </span>
    );
  }
  return (
    <span className="inline-flex gap-1" aria-label={`Colours: ${identity.map((c) => COLOR_NAMES[c] ?? c).join(", ")}`}>
      {identity.map((c) => (
        <span
          key={c}
          className="inline-flex items-center justify-center rounded-full text-[10px] font-bold"
          style={{ width: size, height: size, background: bg[c] ?? "#888", color: c === "W" ? "#101114" : "#fff" }}
        >
          {c}
        </span>
      ))}
    </span>
  );
}

function QtyStepper({
  value,
  onChange,
  label,
  small = false,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  small?: boolean;
}) {
  const btn = small ? "w-8 h-8 text-base" : "w-11 h-11 text-xl";
  return (
    <div className="inline-flex items-center gap-2">
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        className={`${btn} rounded-full bg-[var(--surface2)] border border-[var(--border)] text-[var(--text)] active:scale-95`}
        onClick={() => onChange(Math.max(0, value - 1))}
      >
        −
      </button>
      <span className="min-w-7 text-center font-semibold" aria-label={`${label}: ${value}`}>
        {value}
      </span>
      <button
        type="button"
        aria-label={`Increase ${label}`}
        className={`${btn} rounded-full bg-[var(--surface2)] border border-[var(--border)] text-[var(--text)] active:scale-95`}
        onClick={() => onChange(Math.min(999, value + 1))}
      >
        +
      </button>
    </div>
  );
}

function FoilToggle({
  foil,
  onChange,
  priceUsd,
  priceUsdFoil,
}: {
  foil: boolean;
  onChange: (v: boolean) => void;
  priceUsd: number | null;
  priceUsdFoil: number | null;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={foil}
      aria-label="Foil"
      onClick={() => onChange(!foil)}
      className={`w-full flex items-center justify-between rounded-2xl border-2 px-4 py-3 transition-colors ${
        foil ? "border-[var(--foil)] bg-[#1d2735]" : "border-[var(--border)] bg-[var(--surface2)]"
      }`}
    >
      <span className="flex items-center gap-3">
        <span
          className={`w-12 h-7 rounded-full p-1 flex ${foil ? "bg-[var(--foil)] justify-end" : "bg-[#55565f] justify-start"}`}
        >
          <span className="w-5 h-5 rounded-full bg-white block" />
        </span>
        <span className={`text-lg font-bold ${foil ? "foil-shimmer" : "text-[var(--text)]"}`}>
          FOIL
        </span>
      </span>
      <span className="text-sm text-[var(--dim)]">
        {foil ? `Counts as ${formatMoney(priceUsdFoil)}` : `Non-foil ${formatMoney(priceUsd)} · foil ${formatMoney(priceUsdFoil)}`}
      </span>
    </button>
  );
}

/** Card image with a holographic foil treatment when foil is on. */
function FoilImage({
  src,
  alt,
  foil,
  className = "",
  imgClassName = "",
}: {
  src: string;
  alt: string;
  foil: boolean;
  className?: string;
  imgClassName?: string;
}) {
  if (!foil) {
    // className carries the caller's sizing (w-14/w-24/w-28, shrink-0); it
    // must win over imgClassName — discarding it made images render w-full
    // and crush sibling text (the invisible deck-name bug).
    return <img src={src} alt={alt} className={className || imgClassName} loading="lazy" />;
  }
  return (
    <span className={`foil-wrap inline-block rounded-[inherit] ${className}`} style={{ borderRadius: undefined }}>
      <img src={src} alt={alt} className={`block ${imgClassName}`} loading="lazy" />
      <span className="foil-overlay" aria-hidden="true" />
      <span className="foil-sheen" aria-hidden="true" />
      <span className="foil-badge" aria-label="Foil">★ FOIL</span>
    </span>
  );
}

/** The current best-known foil-aware unit price for a collection item. */
function currentUnitPrice(item: CollectionItem): number | null {
  if (item.lastPrice != null) return item.lastPrice;
  return item.foil ? item.priceUsdFoil ?? item.priceUsd : item.priceUsd;
}

/** ▲/▼ movement chip: current price vs the price when the card was added. */
function PriceMove({ item }: { item: CollectionItem }) {
  const mv = priceMovement(currentUnitPrice(item), item.priceAtAdd);
  if (mv.kind === "none") {
    return <span className="text-xs text-[var(--dim)]">— price not checked yet</span>;
  }
  if (mv.kind === "flat") {
    return <span className="text-xs text-[var(--dim)]">— no change since added</span>;
  }
  const up = mv.kind === "up";
  const pctLabel = mv.pct != null ? ` (${mv.pct > 0 ? "+" : "−"}${Math.abs(mv.pct).toFixed(0)}%)` : "";
  return (
    <span className={`text-xs font-bold ${up ? "text-[var(--good)]" : "text-[var(--danger)]"}`} aria-label={`${up ? "Up" : "Down"} ${formatSignedMoney(mv.diff)} since added`}>
      {up ? "▲" : "▼"} {formatSignedMoney(mv.diff)}{pctLabel}
    </span>
  );
}

/** ManaBox-style grid of every printing; tapping one picks it. */
function PrintingGrid({
  printings,
  currentId,
  foil,
  onPick,
}: {
  printings: CardT[];
  currentId: string;
  foil: boolean;
  onPick: (card: CardT) => void;
}) {
  // Pass 25: the picker now lists EVERY printing (full pagination),
  // which for a basic land is ~930 entries — unusable unfiltered.
  // Long lists get a filter (set name / code / number / artist) and
  // a render cap with an honest count; short lists render exactly
  // as before.
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const filtered = q
    ? printings.filter((p) =>
        p.setName.toLowerCase().includes(q) ||
        p.setCode.toLowerCase().includes(q) ||
        p.collectorNumber.toLowerCase().includes(q) ||
        p.artist.toLowerCase().includes(q))
    : printings;
  const RENDER_CAP = 180;
  const shown = filtered.slice(0, RENDER_CAP);
  return (
    <div className="mt-2">
      {printings.length > 30 ? (
        <div className="mb-2">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${printings.length} versions — set, code, number or artist…`}
            aria-label="Filter the list of versions by set, code, collector number or artist"
            className="w-full h-10 rounded-xl bg-[var(--surface2)] border border-[var(--border)] px-3 text-sm placeholder:text-[var(--dim)]"
          />
          <p className="text-[11px] text-[var(--dim)] mt-1" role="status">
            {filtered.length} of {printings.length} versions{filtered.length > RENDER_CAP ? ` — showing the first ${RENDER_CAP}; keep typing to narrow it down` : ""}
          </p>
        </div>
      ) : null}
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-96 overflow-auto pr-1" role="list" aria-label="All versions of this card">
      {shown.map((p) => (
        <button
          key={p.scryfallId}
          type="button"
          role="listitem"
          onClick={() => onPick(p)}
          aria-label={`Use version ${p.setName} number ${p.collectorNumber}`}
          className={`text-left rounded-xl border-2 p-2 bg-[var(--surface2)] active:scale-[0.98] ${
            p.scryfallId === currentId ? "border-[var(--accent)]" : "border-[var(--border)]"
          }`}
        >
          {p.imageSmall ? (
            <FoilImage src={p.imageSmall} alt="" foil={foil} imgClassName="w-full rounded-md" />
          ) : null}
          <span className="block text-xs font-semibold mt-1 leading-tight">
            {p.setName} ({p.setCode.toUpperCase()}) #{p.collectorNumber}
          </span>
          <span className="block text-[11px] text-[var(--dim)] capitalize">
            {yearOf(p.releasedAt)} · {p.rarity}
            {p.finishes.length ? ` · ${p.finishes.join("/")}` : ""}
          </span>
          <span className="block text-[11px] text-[var(--accent)]">
            {formatMoney(p.priceUsd)} · foil {formatMoney(p.priceUsdFoil)}
          </span>
          {p.scryfallId === currentId ? (
            <span className="block text-[11px] font-bold text-[var(--accent)]">Current version</span>
          ) : null}
        </button>
      ))}
      {filtered.length === 0 ? (
        <p className="text-sm text-[var(--dim)] col-span-full">{printings.length === 0 ? "No printings returned." : "No versions match that filter."}</p>
      ) : null}
    </div>
    </div>
  );
}

/** Full identified-card panel: image, details, foil toggle, qty, add button, printing picker. */
function CardResultPanel({
  card,
  matchNote,
  versionInfo,
  initialPrintings,
  onSwapPrinting,
  onAdd,
  onViewCollection,
  addLabel,
  busy,
}: {
  card: CardT;
  matchNote?: string;
  versionInfo?: VersionInfo | null;
  initialPrintings?: CardT[] | null;
  onSwapPrinting: (card: CardT) => void;
  onAdd: (card: CardT, foil: boolean, qty: number, condition: string) => Promise<boolean>;
  onViewCollection?: () => void;
  addLabel: string;
  busy?: boolean;
}) {
  const [foil, setFoil] = useState(false);
  const [qty, setQty] = useState(1);
  const [condition, setCondition] = useState("Near Mint");
  const [printings, setPrintings] = useState<CardT[] | null>(null);
  const [loadingPrintings, setLoadingPrintings] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    // A ★ separator read from the card's bottom line means foil/etched —
    // pre-tick Foil and say why (the version note below explains it).
    setFoil(versionInfo?.foilDetected === true);
    setQty(1);
    setPrintings(initialPrintings ?? null);
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.scryfallId]);

  const shownPrice = foil ? card.priceUsdFoil : card.priceUsd;

  const loadPrintings = async () => {
    if (printings) { setPrintings(null); return; }
    if (initialPrintings) { setPrintings(initialPrintings); return; }
    if (!card.printsSearchUri) return;
    setLoadingPrintings(true);
    try {
      const res = await api.getPrintings({ printsSearchUri: card.printsSearchUri, full: true });
      setPrintings(res.printings);
    } finally {
      setLoadingPrintings(false);
    }
  };

  return (
    <section aria-label={`Identified card ${card.name}`} className="rounded-3xl bg-[var(--surface)] border border-[var(--border)] p-4 space-y-4">
      <div className="flex gap-4">
        {card.imageNormal ? (
          <FoilImage src={card.imageNormal} alt={card.name} foil={foil} className="w-28 shrink-0 self-start rounded-xl" imgClassName="w-full rounded-xl" />
        ) : null}
        <div className="min-w-0">
          <h3 className="font-display text-xl leading-tight">{card.name}</h3>
          <p className="text-sm text-[var(--dim)] mt-1">
            {card.setName} ({card.setCode.toUpperCase()}) #{card.collectorNumber} · {card.rarity}
          </p>
          <p className="text-sm mt-1">{card.typeLine}</p>
          <p className="text-sm text-[var(--dim)]">
            {card.manaCost ? `Mana cost ${card.manaCost} · ` : ""}CMC {card.cmc}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <ManaDots identity={card.colorIdentity} />
            <span className="text-lg font-bold text-[var(--accent)]">{formatMoney(shownPrice)}</span>
            <span className="text-xs text-[var(--dim)]">{foil ? "foil price" : "price"}</span>
          </div>
          <p className="text-xs text-[var(--dim)] mt-1">
            USD {formatMoney(card.priceUsd)} · USD foil {formatMoney(card.priceUsdFoil)}
          </p>
        </div>
      </div>

      {versionInfo ? (
        <p
          className={`text-sm rounded-xl px-3 py-2 border ${
            versionInfo.status === "detected"
              ? "border-[var(--good)] bg-[#1d2b1d]"
              : versionInfo.status === "guess"
                ? "border-[#e8b34b] bg-[#2b2417]"
                : "border-[var(--border)] bg-[var(--surface2)] text-[var(--dim)]"
          }`}
          role="status"
        >
          {versionInfo.status === "detected" ? "🎯 " : versionInfo.status === "guess" ? "🔎 " : ""}
          {versionInfo.message}
          {versionInfo.foilDetected === true
            ? " The ★ printed by the set code means this copy is foil/etched, so Foil was ticked on for you."
            : versionInfo.foilDetected === false
              ? " The • printed by the set code means this copy is non-foil."
              : ""}
        </p>
      ) : null}

      {matchNote ? <p className="text-xs text-[var(--dim)]">{matchNote}</p> : null}

      <FoilToggle foil={foil} onChange={setFoil} priceUsd={card.priceUsd} priceUsdFoil={card.priceUsdFoil} />

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <span className="block text-xs text-[var(--dim)] mb-1">Quantity</span>
          <QtyStepper value={qty} onChange={(v) => setQty(Math.max(1, v))} label="quantity" />
        </div>
        <label className="flex-1 min-w-36">
          <span className="block text-xs text-[var(--dim)] mb-1">Condition</span>
          <select
            aria-label="Condition"
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            className="w-full h-11 rounded-xl bg-[var(--surface2)] border border-[var(--border)] px-3 text-[var(--text)]"
          >
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void (async () => {
            const ok = await onAdd(card, foil, qty, condition);
            if (ok) setSaved(true);
          })();
        }}
        className={`w-full h-14 rounded-2xl text-lg font-bold active:scale-[0.99] disabled:opacity-50 ${
          saved ? "bg-[#2e7d32] text-white" : "bg-[var(--accent)] text-[var(--accent-text)]"
        }`}
      >
        {busy ? "Adding…" : saved ? "✓ Saved to collection — add another copy" : addLabel}
      </button>
      {saved && onViewCollection ? (
        <button
          type="button"
          onClick={onViewCollection}
          className="w-full h-11 rounded-xl bg-[var(--surface2)] border border-[var(--good)] text-sm font-bold"
          aria-label="View this card in your collection"
        >
          View in Collection →
        </button>
      ) : null}

      {card.printsSearchUri || initialPrintings ? (
        <div>
          <button
            type="button"
            onClick={() => void loadPrintings()}
            className="text-sm underline text-[var(--foil)]"
            aria-label="Change version or see all versions of this card"
          >
            {loadingPrintings ? "Loading versions…" : printings ? "Hide versions" : "Change version / See all versions"}
          </button>
          {printings ? (
            <PrintingGrid
              printings={printings}
              currentId={card.scryfallId}
              foil={foil}
              onPick={(p) => { onSwapPrinting(p); setSaved(false); }}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Autocomplete field backed by the local name index. */
function NameSearchField({
  index,
  label,
  placeholder,
  onPickName,
}: {
  index: NameEntry[] | null;
  label: string;
  placeholder: string;
  onPickName: (fullName: string) => void;
}) {
  const [query, setQuery] = useState("");
  const suggestions = useMemo(
    () => (index ? autocomplete(index, query, 8) : []),
    [index, query],
  );
  return (
    <div>
      <label className="block">
        <span className="block text-xs text-[var(--dim)] mb-1">{label}</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label={label}
          className="w-full h-12 rounded-xl bg-[var(--surface2)] border border-[var(--border)] px-3 text-[var(--text)] placeholder:text-[var(--dim)]"
        />
      </label>
      {query.trim().length >= 2 ? (
        <ul className="mt-1 rounded-xl bg-[var(--surface2)] border border-[var(--border)] divide-y divide-[var(--border)] overflow-hidden" aria-label="Name suggestions">
          {suggestions.map((s) => (
            <li key={s.full + s.face}>
              <button
                type="button"
                className="w-full text-left px-3 py-3 active:bg-[var(--surface)]"
                onClick={() => { onPickName(s.full); setQuery(""); }}
              >
                {s.face}
                {s.face !== s.full ? <span className="text-[var(--dim)] text-sm"> — from {s.full}</span> : null}
              </button>
            </li>
          ))}
          {suggestions.length === 0 ? (
            <li className="px-3 py-3 text-sm text-[var(--dim)]">
              {index ? "No local match — try the full name." : "Card database still downloading…"}
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function DatabaseStatus({
  cache,
  refreshing,
  onRefresh,
}: {
  cache: NamesCache | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const dateLabel = cache
    ? new Date(cache.date).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
    : null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl bg-[var(--surface)] border border-[var(--border)] px-4 py-3">
      <p className="text-sm" role="status">
        {cache ? (
          <>
            Card database: <strong>{cache.names.length.toLocaleString()} names</strong> downloaded locally
            {dateLabel ? <> on {dateLabel}</> : null}
          </>
        ) : refreshing ? (
          "Downloading the Scryfall card-name index…"
        ) : (
          "Card database not downloaded yet"
        )}
      </p>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="shrink-0 h-10 px-4 rounded-full bg-[var(--surface2)] border border-[var(--border)] text-sm font-semibold disabled:opacity-50"
        aria-label="Refresh card database"
      >
        {refreshing ? "…" : "Refresh"}
      </button>
    </div>
  );
}

/** Save text content as a downloaded file. */
function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function fileStem(name: string): string {
  return name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "cards";
}

/** The three labelled exports (Moxfield .txt / Archidekt CSV / ManaBox
 * CSV) for any list of exportable rows — collections, decks, scan list. */
function ExportButtons({
  rows,
  baseName,
  disabled,
}: {
  rows: (ExportRow & { rarity?: string })[];
  baseName: string;
  disabled?: boolean;
}) {
  const stem = fileStem(baseName);
  const off = disabled || rows.length === 0;
  const cls =
    "flex-1 h-11 px-2 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-[13px] font-semibold disabled:opacity-40 leading-tight";
  return (
    <div className="flex gap-2" role="group" aria-label={`Export ${baseName}`}>
      <button
        type="button"
        disabled={off}
        className={cls}
        aria-label={`Export ${baseName} for Moxfield as a text file`}
        onClick={() => downloadTextFile(`${stem}-moxfield.txt`, buildMoxfieldTxt(rows), "text/plain")}
      >
        Export — Moxfield (.txt)
      </button>
      <button
        type="button"
        disabled={off}
        className={cls}
        aria-label={`Export ${baseName} for Archidekt as CSV`}
        onClick={() => downloadTextFile(`${stem}-archidekt.csv`, buildArchidektCsv(rows), "text/csv")}
      >
        Export — Archidekt
      </button>
      <button
        type="button"
        disabled={off}
        className={cls}
        aria-label={`Export ${baseName} in ManaBox format as CSV`}
        onClick={() => downloadTextFile(`${stem}-manabox.csv`, buildManaBoxCsv(rows, baseName), "text/csv")}
      >
        Export — ManaBox (.csv)
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scanner image pipeline — guide-mapped crop + title band only
// ---------------------------------------------------------------------------

/**
 * Build the SINGLE read-frame image for one card: the title band in two
 * pooled treatments (top) plus the bottom info strip (bottom), long edge
 * capped at 900px, JPEG. One vision call reads both regions — this replaced
 * the old sequential title-band and bottom-band calls that made scans slow.
 */
function buildReadFrame(cardCanvas: HTMLCanvasElement): string {
  const w = cardCanvas.width;
  const h = cardCanvas.height;
  const sx = Math.round(w * 0.03);
  const sw = Math.round(w * 0.94);
  const sy = Math.round(h * 0.03);
  const sh = Math.round(h * 0.085);
  const by = Math.round(h * 0.925);
  const bh = h - by;
  const targetW = Math.min(900, Math.max(320, sw));
  const tScale = targetW / sw;
  const titleH = Math.round(sh * tScale);
  const bScale = targetW / w;
  const botH = Math.round(bh * bScale);
  const gap = 10;
  const out = document.createElement("canvas");
  out.width = targetW;
  out.height = titleH * 2 + gap + botH;
  const octx = out.getContext("2d");
  if (!octx) return "";
  octx.fillStyle = "#888888";
  octx.fillRect(0, 0, out.width, out.height);
  // Title treatment A: grayscale + contrast.
  try { octx.filter = "grayscale(1) contrast(1.7) brightness(1.08)"; } catch { /* ignore */ }
  octx.drawImage(cardCanvas, sx, sy, sw, sh, 0, 0, targetW, titleH);
  try { octx.filter = "none"; } catch { /* ignore */ }
  // Title treatment B: thresholded black & white.
  const tmp = document.createElement("canvas");
  tmp.width = targetW;
  tmp.height = titleH;
  const tctx = tmp.getContext("2d");
  if (tctx) {
    try { tctx.filter = "grayscale(1) contrast(1.4)"; } catch { /* ignore */ }
    tctx.drawImage(cardCanvas, sx, sy, sw, sh, 0, 0, targetW, titleH);
    try {
      const img = tctx.getImageData(0, 0, targetW, titleH);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);
        const v = lum > 135 ? 255 : 0;
        d[i] = v; d[i + 1] = v; d[i + 2] = v;
      }
      tctx.putImageData(img, 0, 0);
    } catch { /* ignore */ }
    octx.drawImage(tmp, 0, titleH);
  }
  // Bottom info strip.
  try { octx.filter = "contrast(1.5) brightness(1.1)"; } catch { /* ignore */ }
  octx.drawImage(cardCanvas, 0, by, w, bh, 0, titleH * 2 + gap, targetW, botH);
  try { octx.filter = "none"; } catch { /* ignore */ }
  return out.toDataURL("image/jpeg", 0.82).replace(/^data:image\/jpeg;base64,/, "");
}

/** Full card image as JPEG base64, capped at ~700px wide for the vision pick. */
function buildFullCardJpeg(cardCanvas: HTMLCanvasElement): string {
  const maxW = 700;
  const scale = Math.min(1, maxW / cardCanvas.width);
  const out = document.createElement("canvas");
  out.width = Math.round(cardCanvas.width * scale);
  out.height = Math.round(cardCanvas.height * scale);
  const ctx = out.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(cardCanvas, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.82).replace(/^data:image\/jpeg;base64,/, "");
}

/** Small grayscale signature of a canvas, for rapid-scan scene comparison. */
function canvasSignature(source: HTMLCanvasElement): number[] {
  return canvasRegionSignature(source, 0, 1);
}

/** Grayscale signature of a horizontal band of the canvas (fractions of height). */
function canvasRegionSignature(source: HTMLCanvasElement, y0: number, y1: number): number[] {
  const W = 24;
  const H = 34;
  const tmp = document.createElement("canvas");
  tmp.width = W;
  tmp.height = H;
  const ctx = tmp.getContext("2d");
  if (!ctx) return [];
  const sh = Math.max(1, Math.round(source.height * (y1 - y0)));
  ctx.drawImage(source, 0, Math.round(source.height * y0), source.width, sh, 0, 0, W, H);
  try {
    const data = ctx.getImageData(0, 0, W, H).data;
    const sig: number[] = [];
    for (let i = 0; i < data.length; i += 4) {
      sig.push(0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0));
    }
    return sig;
  } catch {
    return [];
  }
}

/** Title-band signature (top 16% of the card) — scanner-box stability signal. */
function canvasTitleSignature(source: HTMLCanvasElement): number[] {
  return canvasRegionSignature(source, 0, 0.16);
}

/** Downscale a canvas so its long edge is at most maxLongEdge (returns
 * the source unchanged when already small enough). Used on the CARD
 * CROP of a full-resolution still — never on the whole frame — so a
 * small card keeps every pixel the sensor gave it until the crop is
 * made, and only the crop is reduced to reading size. */
function downscaleCanvas(src: HTMLCanvasElement, maxLongEdge: number): HTMLCanvasElement {
  const longEdge = Math.max(src.width, src.height);
  if (longEdge <= maxLongEdge || longEdge === 0) return src;
  const scale = maxLongEdge / longEdge;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(src.width * scale));
  out.height = Math.max(1, Math.round(src.height * scale));
  const ctx = out.getContext("2d");
  if (ctx) ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

/** Compressed full-card photo (~900px) stored with the scan-list item so its
 * exact printing can be detected later without rescanning. */
function buildStoredCardJpeg(cardCanvas: HTMLCanvasElement): string {
  const maxW = 900;
  const scale = Math.min(1, maxW / Math.max(1, cardCanvas.width));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(cardCanvas.width * scale));
  out.height = Math.max(1, Math.round(cardCanvas.height * scale));
  const ctx = out.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(cardCanvas, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.8).replace(/^data:image\/jpeg;base64,/, "");
}

/** The image channel's result for one attempt (rework Stage 2/3). */
interface ImageChannelResult {
  /** Name-level ranked candidates with measured pHash distances;
   * empty when verification was impossible (e.g. reference images
   * could not be read back — non-CORS canvas). */
  ranked: RankedCandidate[];
  /** Names the visual index proposed (Scryfall-verified server-side)
   * before distance verification — kept for diagnostics honesty when
   * no distance could be measured. */
  proposed: string[];
  /** How the proposal stage ended (Pass 20) — the panel prints this
   * stage outcome distinctly instead of Pass 19's single collapsed
   * "nothing usable" line for every failure mode. */
  status: ImageChannelStatus;
  /** Milliseconds the identifyByImage call itself took (or the cap
   * it hit) — printed in the timeout diagnostic. */
  visionMs: number;
  /** The dewarped canonical card as a JPEG data URL (diagnostics). */
  dewarpedUrl: string;
  ms: number;
}

/** Dewarp a prepared card crop to the canonical upright card. The
 * prepared crop already IS the detected rect cut from the frame, so
 * the perspective dewarp is the canonical resample of that crop
 * (fromRect cost noted in finder.ts: a keystoned card keeps some
 * lean the hash absorbs — measured in the Stage 1 rotation classes). */
function dewarpPreparedCard(cardCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = CANONICAL_W;
  out.height = CANONICAL_H;
  const ctx = out.getContext("2d");
  if (ctx) ctx.drawImage(cardCanvas, 0, 0, CANONICAL_W, CANONICAL_H);
  return out;
}

function canvasToJpegBase64(canvas: HTMLCanvasElement): string {
  try {
    return canvas.toDataURL("image/jpeg", 0.82).replace(/^data:image\/jpeg;base64,/, "");
  } catch {
    return "";
  }
}

/** Load a Scryfall reference image for fingerprinting. CORS-readable
 * (crossOrigin anonymous) or the fingerprint read fails and the
 * candidate stays unverified — it can then never settle by image. */
function loadReferenceImage(url: string): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => resolve(null), 2500);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d");
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0);
        resolve(c);
      } catch { resolve(null); }
    };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = url;
  });
}

function beep() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.12;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.13);
    osc.onended = () => void ctx.close().catch(() => undefined);
  } catch { /* audio is best-effort */ }
}

/** A captured frame with the card located and cropped out of it. */
interface PreparedScan {
  /** The card crop — OCR bands and the stored photo come from this. */
  card: HTMLCanvasElement;
  /** The original frame the card was found in. */
  frame: HTMLCanvasElement;
  /** How the card was located: live detection, stored box calibration, or
   * the honest fallback (whole frame / guide area). */
  source: "detected" | "calibration" | "guide";
  /** Card rectangle as fractions of `frame` (null for the fallback).
   * Always the ASPECT-CORRECTED rect (see correctCardAspect) — the same
   * rect the "CARD FOUND" overlay draws and all bands derive from. */
  rect: CardRect | null;
  /** Provenance of `rect` (see RectOrigin in detect.ts) — printed in
   * the scan diagnostics so a failure names where its rect came from. */
  rectOrigin: RectOrigin;
  /** Milliseconds spent locating the card in this frame (stage timing). */
  detectMs: number;
  /** Box mode: the stored calibration disagreed with where the card
   * actually is in this frame, so the detected rect was used instead
   * (see prepareCardFromFrame in detect.ts). */
  calibrationStale?: boolean;
  /** This frame's own detection (Pass 24a), whatever rect was read —
   * the continuous tracker is fed from it. Mirrors PreparedCard. */
  detectedRect: CardRect | null;
  /** PASS 31 — title-zone sharpness of this frame's card crop
   * (focus.ts gradient energy; 0/absent = unmeasured). Set by the
   * prepareCardCanvas wrapper for live captures; drives sharpest-
   * first read order for the completing + rescue treatments and
   * the retained-frame sharpness gate. */
  titleSharpness?: number;
}

/** Show-your-work diagnostics for the CURRENT scan attempt — rendered
 * in the Did-you-mean and result sheets so ANY future failure is
 * diagnosable from a single screenshot: what was read, which evidence
 * won, the actual band images that were OCR'd, and the capture
 * resolution. Published incrementally per attempt by ScanDebugTracker
 * (client/src/scandebug.ts) so a hung read's failure panel shows that
 * attempt's own partial data, never a previous scan's. */
type ScanDebug = ScanDebugData;

interface ImageCaptureLike {
  grabFrame: () => Promise<ImageBitmap>;
}

/** ImageCapture (Chrome/Android) grabs full-sensor-resolution stills —
 * far sharper than a possibly-downscaled live video stream. Returns
 * null where the API doesn't exist (in-app webviews, iOS Safari). */
function getImageCapture(track: MediaStreamTrack): ImageCaptureLike | null {
  try {
    const Ctor = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => ImageCaptureLike }).ImageCapture;
    return Ctor ? new Ctor(track) : null;
  } catch {
    return null;
  }
}

/** "What the scanner read" — the show-your-work block rendered in the
 * Did-you-mean and result sheets: pooled raw read, winning evidence,
 * capture resolution, and thumbnails of the ACTUAL band images that
 * were OCR'd (title band, and the bottom strip when it was read).
 * COLLAPSIBLE (user's explicit ask): a tappable header row with a
 * ▸/▾ chevron. Default CLOSED on success results (name/price is what
 * matters), OPEN on failure/timeout and Did-you-mean panels (that's
 * when it's needed); the user's manual toggle is remembered per
 * context in localStorage (scanflow.ts resolveDebugOpen). */
function ScanDebugBlock({ debug, context }: { debug: ScanDebug; context: DebugContext }) {
  const storageKey = debugStorageKey(context);
  const [open, setOpen] = useState<boolean>(() => {
    try { return resolveDebugOpen(context, localStorage.getItem(storageKey)); } catch { return resolveDebugOpen(context, null); }
  });
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };
  const panelId = `scan-debug-${context}`;
  return (
    <div className="mt-3 rounded-xl bg-[var(--surface2)] border border-[var(--border)] px-3 py-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Hide what the scanner read" : "Show what the scanner read"}
        className="w-full flex items-center justify-between gap-2 py-0.5 text-left"
      >
        <span className="text-[11px] font-bold tracking-wide">WHAT THE SCANNER READ</span>
        <span aria-hidden="true" className="text-sm text-[var(--dim)]">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div id={panelId}>
          <p className="text-xs text-[var(--dim)] mt-1 break-words">
            Evidence: <span className="text-[var(--text)]">{debug.evidence}</span>
            {debug.capture ? <> · Capture: <span className="text-[var(--text)]">{debug.capture}</span></> : null}
          </p>
          {debug.rect ? <p className="text-xs text-[var(--dim)] mt-0.5 break-words">Rect: <span className="text-[var(--text)]">{debug.rect}</span></p> : null}
          {debug.autoLight ? <p className="text-xs text-[var(--dim)] mt-0.5 break-words">Light: <span className="text-[var(--text)]">{debug.autoLight}</span></p> : null}
          {debug.sharpness ? <p className="text-xs text-[var(--dim)] mt-0.5 break-words">Focus: <span className="text-[var(--text)]">{debug.sharpness}</span></p> : null}
          {debug.image ? <p className="text-xs text-[var(--dim)] mt-0.5 break-words">Image match: <span className="text-[var(--text)]">{debug.image}</span></p> : null}
          {debug.pooledRead ? <p className="text-xs text-[var(--dim)] mt-0.5 break-words">Raw read: {debug.pooledRead}</p> : null}
          {debug.stages ? <p className="text-xs text-[var(--dim)] mt-0.5 break-words">Stages: <span className="text-[var(--text)]">{debug.stages}</span></p> : null}
          {debug.note ? <p className="text-xs font-semibold text-[#e8b34b] mt-0.5">{debug.note}</p> : null}
          <div className="mt-2 space-y-2">
            {debug.dewarpedUrl ? (
              <figure>
                <img src={debug.dewarpedUrl} alt="The straightened card image the image-recognition channel matched against" className="w-full max-w-52 rounded-md border border-[var(--border)]" />
                <figcaption className="text-[10px] text-[var(--dim)] mt-0.5">Straightened card the image channel matched</figcaption>
              </figure>
            ) : null}
            {debug.frameUrl ? (
              <figure>
                <img src={debug.frameUrl} alt="The full frame the camera captured, with the read area outlined" className="w-full max-w-52 rounded-md border border-[var(--border)]" />
                <figcaption className="text-[10px] text-[var(--dim)] mt-0.5">Full frame as captured — the gold outline is the area that was read</figcaption>
              </figure>
            ) : null}
            {debug.titleBandUrl ? (
              <figure>
                <img src={debug.titleBandUrl} alt="The title band image the scanner read the card name from" className="w-full max-w-105 rounded-md border border-[var(--border)]" />
                <figcaption className="text-[10px] text-[var(--dim)] mt-0.5">Title band that was read</figcaption>
              </figure>
            ) : null}
            {debug.bottomBandUrl ? (
              <figure>
                <img src={debug.bottomBandUrl} alt="The bottom strip image the scanner read the collector number from" className="w-full max-w-105 rounded-md border border-[var(--border)]" />
                <figcaption className="text-[10px] text-[var(--dim)] mt-0.5">Bottom strip that was read (collector number zone)</figcaption>
              </figure>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Downscaled JPEG thumbnail of a band canvas for the debug block. */
function bandThumb(canvas: HTMLCanvasElement): string {
  try {
    const maxW = 520;
    const scale = Math.min(1, maxW / Math.max(1, canvas.width));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(canvas.width * scale));
    out.height = Math.max(1, Math.round(canvas.height * scale));
    const ctx = out.getContext("2d");
    if (!ctx) return "";
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return out.toDataURL("image/jpeg", 0.72);
  } catch {
    return "";
  }
}

function ScanTab({
  index,
  namesReady,
}: {
  index: NameEntry[] | null;
  namesReady: boolean;
}) {
  const queryClient = useQueryClient();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const guideRef = useRef<HTMLDivElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const generationRef = useRef(0);
  const takePhotoRef = useRef<HTMLInputElement | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);

  const scanListQ = useQuery({ queryKey: ["scanList"], queryFn: () => api.listScanList({}) });
  const collectionsQ = useQuery({ queryKey: ["collections"], queryFn: () => api.listCollections({}) });
  const scanItems: ScanItem[] = scanListQ.data?.items ?? [];
  const collections: CollectionInfo[] = collectionsQ.data?.collections ?? [];
  const listCount = scanItems.reduce((s, i) => s + i.quantity, 0);
  const listValue = scanItems.reduce((s, i) => s + ((i.foil ? i.priceUsdFoil ?? i.priceUsd : i.priceUsd) ?? 0) * i.quantity, 0);
  // Pass 24c: rows holding more than one copy (the server merges a
  // repeat scan of the same printing + foil into quantity) — the
  // doubles Andrew asked to be able to SEE. Badged in the list.
  const dupKinds = scanItems.filter((i) => i.quantity > 1).length;

  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [rawRead, setRawRead] = useState<string>("");
  const [candidates, setCandidates] = useState<MatchResult[] | null>(null);
  /** Pass 24b (Item E): the image candidate a Did-you-mean sheet is
   * presenting (band tier or degraded-guard demotion), when any —
   * drives the "Use this artwork match anyway" button, which settles
   * the exact printing the artwork pinned instead of the name. */
  const [candidatesImage, setCandidatesImage] = useState<RankedCandidate | null>(null);
  const [resultItemId, setResultItemId] = useState<number | null>(null);
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [resultPrintings, setResultPrintings] = useState<CardT[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<{ sec: string; path: "device" | "slow" } | null>(null);
  const [pendingMatch, setPendingMatch] = useState<string | null>(null);
  const [showList, setShowList] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const toastTimer = useRef<number | null>(null);
  // On-device scanner (Tesseract) warm-up status
  const [ocrStatus, setOcrStatus] = useState<OcrStatus>("idle");
  // Camera light (Pass 17): a 3-state mode — "auto" (default:
  // metering-driven torch/exposure + software lift), "on" (torch
  // forced on), "off" (no light help at all). The legacy binary
  // torch preference migrates: a stored "on" starts in On mode.
  const [lightMode, setLightMode] = useState<LightMode>(() => {
    try {
      const m = localStorage.getItem("manabox-light-mode");
      if (m) return parseLightMode(m);
      return localStorage.getItem("manabox-torch-on") === "1" ? "on" : "auto";
    } catch { return "auto"; }
  });
  const lightModeRef = useRef(lightMode);
  lightModeRef.current = lightMode;
  // MANUAL LIGHT (Pass 22 levels; Pass 30 SLIDER): the user's own
  // exposure gain — a continuous ×1.0–×4.0 value with preset stops —
  // persisted like the mode. The Pass 22 level index migrates to its
  // gain on first read (parseManualGain). Applies only in Manual
  // mode; Auto stays the first-run default. identifyBurst samples
  // the ref ONCE per attempt, so slider changes land between
  // attempts, never mid-read.
  const [manualGain, setManualGainState] = useState<number>(() => {
    try {
      return parseManualGain(
        localStorage.getItem("manabox-light-manual-gain"),
        localStorage.getItem("manabox-light-manual-level"),
      );
    } catch { return 2; }
  });
  const manualGainRef = useRef(manualGain);
  manualGainRef.current = manualGain;
  // A manual hardware re-apply requested mid-attempt (slider drag)
  // waits for the attempt to end — hardware light never changes
  // under an in-flight read (the latch invariant, manual side).
  const pendingManualHwRef = useRef(false);
  // Whether the physical torch is lit right now (chip ✓ marker).
  const [torchActive, setTorchActive] = useState(false);
  const torchActiveRef = useRef(false);
  // Auto Light hardware bookkeeping (Pass 17): what the AUTO layer
  // itself engaged, so it can restore exactly that — never the user's
  // manual On. autoExposure holds the applied compensation value.
  const autoTorchRef = useRef(false);
  const autoExposureRef = useRef<number | null>(null);
  const autoLightHwRef = useRef("");
  // Rapid's too-dark warning fires once per dark streak (Pass 17).
  const rapidDarkWarnedRef = useRef(false);
  // Rapid's out-of-focus warning fires once per soft streak (Pass 32).
  const rapidFocusWarnedRef = useRef(false);
  // PASS 32 (Item 3a): the scene meters dark while Light is Off —
  // the live view says so plainly (two consecutive retest batches
  // ran their "retests" with the light off, so the condition under
  // test never existed). Set by the preview/watcher metering ticks
  // from the SAME title-zone p90 the Auto layer engages on; cleared
  // by the next tick that meters bright or a non-Off mode.
  const [darkOffHint, setDarkOffHint] = useState(false);
  // Rapid watcher metering throttle (~every 3rd tick).
  const rapidLightTickRef = useRef(0);
  const [torchSup, setTorchSup] = useState<TorchSupport>("no-track");
  // Scanner-box mode (fixed rig: locked focus/exposure, title-band stability)
  const [boxMode, setBoxMode] = useState<boolean>(() => {
    try { return localStorage.getItem("manabox-box-mode") === "1"; } catch { return false; }
  });
  const boxModeRef = useRef(boxMode);
  boxModeRef.current = boxMode;
  // Box calibration: the card rect (fractions of the guide crop) captured
  // once in the fixed rig and reused for every scan — no per-scan search.
  const [boxCalib, setBoxCalib] = useState<CardRect | null>(() => {
    try {
      const raw = localStorage.getItem("manabox-box-calibration");
      if (!raw) return null;
      const p = JSON.parse(raw) as CardRect;
      return typeof p.x0 === "number" && typeof p.y0 === "number" && typeof p.x1 === "number" && typeof p.y1 === "number" ? p : null;
    } catch { return null; }
  });
  const boxCalibRef = useRef(boxCalib);
  boxCalibRef.current = boxCalib;
  // Last detected card outline (fractions of the guide / photo frame) —
  // drawn back to the user so they can SEE what the app thinks the card is.
  const [detectOverlay, setDetectOverlay] = useState<{ rect: CardRect; source: "detected" | "calibration" } | null>(null);
  // Live card-presence for the placement hint under the viewfinder
  // (Pass 9): true = a card is detected right now ("fine at this
  // distance"), false = none found, null = not checked yet. Updated by
  // the lightweight live-detection interval in manual mode and by
  // every burst capture; Rapid has its own watcher and needs no hint.
  const [cardPresent, setCardPresent] = useState<boolean | null>(null);
  // For photos (no live viewfinder): the frame with the outline drawn on it.
  const [scanPreview, setScanPreview] = useState<string | null>(null);
  // Transient scanner status notes (watchdog resets, outline fallback,
  // dark-frame retries, scanner restarts).
  const [scanNote, setScanNote] = useState<string | null>(null);
  // The "card outline not found — using the guide area" note, kept as
  // its OWN state (Pass 16): it used to be a scanNote string set by a
  // capture and never cleared, so it sat on screen next to a live
  // "✓ Card found" hint — two contradictory detection states at once.
  // Now it is set only by a capture whose head really read the guide,
  // cleared by the next successful live detection, and RENDERED only
  // while cardPresent (the same state that drives the hint) is not
  // true — the contradiction is impossible by construction.
  const [guideFallbackNote, setGuideFallbackNote] = useState(false);
  // Torch diagnostics: what getCapabilities() reported + last apply error.
  const [torchDiag, setTorchDiag] = useState<{ capability: string; lastError: string | null }>({ capability: "unknown", lastError: null });
  // A scan that couldn't be identified — offers the manual slow read.
  const [failedScan, setFailedScan] = useState<{ canvas: HTMLCanvasElement } | null>(null);
  const [slowReading, setSlowReading] = useState(false);
  // Scan generation: bumped by the watchdog to invalidate in-flight reads.
  const scanGenRef = useRef(0);
  // Scan behaviour
  const [speed, setSpeed] = useState<"fast" | "precise">("fast");
  const speedRef = useRef<"fast" | "precise">("fast");
  const [rapidOn, setRapidOn] = useState(false);
  // PASS 32 (Item 3b): the batch-foil preference PERSISTS — it is a
  // batch-scoped setting like the light mode and box mode beside
  // it, but it alone was plain useState, so any page reload (the
  // user's "refresh the screen" recovery habit included) silently
  // reset it to off and the batch's adds recorded non-foil against
  // the user's standing choice. The flag's threading was audited
  // end-to-end in Pass 32 (chip → batchFoil → foilDetected ??
  // batchFoil at every settle path → addToScanList → row → sheet)
  // and is sound; this was the one drop point.
  const [batchFoil, setBatchFoil] = useState<boolean>(() => {
    try { return localStorage.getItem("manabox-batch-foil") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("manabox-batch-foil", batchFoil ? "1" : "0"); } catch { /* ignore */ }
  }, [batchFoil]);
  const [batchAutoAdd, setBatchAutoAdd] = useState(true);
  const [rapidPaused, setRapidPaused] = useState(false);
  const [rapidHint, setRapidHint] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ name: string; image: string; foil: boolean; itemId?: number; value?: number; note?: string } | null>(null);
  // Show-your-work diagnostics + the actual capture resolution of the
  // last scan (a tiny webview stream must be VISIBLE, not guessed at).
  // The tracker owns the data: every scan attempt begins a fresh token
  // and publishes incrementally, so the watchdog's failure panel can
  // only ever show the attempt that actually timed out.
  const [scanDebug, setScanDebug] = useState<ScanDebug | null>(null);
  const debugTrackerRef = useRef<ScanDebugTracker | null>(null);
  if (!debugTrackerRef.current) debugTrackerRef.current = new ScanDebugTracker();
  /** Render a tracker snapshot (null = stale/invalidated token: the
   * publish was dropped and the visible debug stays as it is). */
  const pubDebug = (snap: ScanDebug | null) => { if (snap) setScanDebug(snap); };
  // Attempt lifecycle guard (scanflow.ts): the CONTROL-FLOW twin of the
  // debug tracker. An attempt that has produced a result is SETTLED —
  // the pipeline checks the guard after every await and aborts
  // silently, and the watchdog takes no action at all for a settled
  // attempt (success is final: no banner, no panel, no reset).
  const attemptGuardRef = useRef<AttemptGuard | null>(null);
  if (!attemptGuardRef.current) attemptGuardRef.current = new AttemptGuard();
  // The CURRENT attempt's captured bottom-line evidence, mirrored by
  // identifyBurst as each bottom read lands. The watchdog's rescue
  // (scanflow rule E2) runs the collector-number rescue on THIS —
  // already-captured text, no new OCR — before it may show a timeout
  // panel, so a hung attempt whose bottom line was perfect (the
  // Divergent Equation attempt-1 case: 'U 0043 SOS EN INKOGNIT') is
  // identified from its own evidence instead of failing.
  const attemptEvidenceRef = useRef<{ attempt: number; sources: { text: string; verify?: boolean }[]; bottomText: string }>({
    attempt: 0,
    sources: [],
    bottomText: "",
  });
  // PASS 20 — the sanctioned image wait: while identifyBurst is
  // inside its fusion wait for the image channel (OCR uncertain, so
  // the attempt must not settle before the primary channel reports),
  // it registers {attempt, untilEpochMs} here. The 8s watchdog
  // consults watchdogImageDeferral and re-arms past the wait instead
  // of tearing the attempt down mid-wait; the registration is
  // cleared the moment the wait ends.
  const imageWaitRef = useRef<{ attempt: number; untilEpochMs: number } | null>(null);
  // PASS 21 (Item C) — watchdog shields beyond the pending wait.
  // The Pass 20 deferral above covers an attempt only WHILE its
  // image wait is still pending; the user's Chandra panel showed
  // the hole: the image result had ALREADY landed (fusion had even
  // published its abstention) and the attempt was inside its
  // bounded post-image settlement (clock-capped rescue reads) when
  // the 8s watchdog fired and reset it with "hung during: title".
  // Two shields close the composition:
  //  - imageCompletedRef records WHEN the channel reported for an
  //    attempt; the completion itself buys the attempt a bounded
  //    settlement grace (IMAGE_SETTLE_GRACE_MS) of shield.
  //  - imageShieldRef is registered explicitly by identifyBurst at
  //    the fusion consult, covering the attempt's remaining clock
  //    envelope (plus settlement slack) whether the channel was
  //    still pending at that point or had already reported.
  // The watchdog defers while ANY shield for the attempt is live
  // (watchdogShieldDeferral, scanflow.ts); an attempt holding a
  // completed image result can therefore never afterwards die by
  // watchdog inside its sanctioned settlement.
  const imageShieldRef = useRef<{ attempt: number; untilEpochMs: number } | null>(null);
  const imageCompletedRef = useRef<{ attempt: number; atEpochMs: number } | null>(null);
  // PASS 32 (Item 1) — the attempt's OWN AttemptClock, published by
  // identifyBurst at creation. The watchdog derives its deadline
  // from this clock's CURRENT budget on every firing
  // (watchdogClockDeferral, scanflow.ts), so every sanctioned
  // extension of the read envelope — the fusion wait's extendTo,
  // Rescue-2's extendByFromNow, and any future one — extends the
  // watchdog's patience BY CONSTRUCTION. Before Pass 32 each
  // extension needed its own hand-registered shield, and Rescue-2
  // (Pass 31) didn't have one: the watchdog killed W1/W2 mid-rescue
  // with every stage time printed as completed. The clock object is
  // published, not a snapshot: `budget` is read live at fire time.
  const attemptClockRef = useRef<{ attempt: number; epochStartMs: number; clock: AttemptClock } | null>(null);
  // PASS 32 (Item 2b): the focus mode the app last REQUESTED of the
  // track (applyCameraLocks records its plan's choice), for the
  // diagnostics AF-state line beside the track's own report.
  const focusRequestedRef = useRef<string | null>(null);
  // FRAME-AT-DETECTION retention (Pass 15, Evidence C): the most recent
  // guide frame the LIVE detection approved — the exact pixels behind
  // the on-screen CARD FOUND outline and the "fine at this distance"
  // hint — together with its prepared card crop. Before this, the
  // preview interval computed detection from one frame, threw the
  // frame away, and a Snap grabbed a FRESH frame after the tap: the
  // user's "it says card found, but the capture doesn't show the card
  // in what the scanner read" — post-tap jolt / a different buffer
  // entirely. A Snap (or a Rapid trigger, whose watcher approved its
  // own sample frame) now uses the retained frame as burst frame 1:
  // what you see is what gets read, by construction. ONE entry,
  // overwritten per detection tick (memory bounded), consumed on use,
  // and honoured only while fresh (< 2.5s).
  const retainedFrameRef = useRef<{ prep: PreparedScan; at: number } | null>(null);
  // PASS 31: set by capturePreparedBurst when the retained frame was
  // dropped for SOFTNESS (scene matched, focus didn't) — published
  // on the attempt's diagnostics sharpness line by identifyBurst.
  const retainedSharpnessDropRef = useRef<string>("");
  // PASS 32 (Item 2a): set by captureBurstWithFocusGate when a burst
  // measured all-soft and was re-captured after an autofocus
  // re-trigger — published on the attempt's sharpness line so the
  // panel shows the escalation fired, with both bursts' numbers.
  // PASS 33: the still-escalation appends its measurement here too.
  const focusGateNoteRef = useRef<string>("");
  // PASS 33: the focus ADVICE for the Rapid attempt currently in
  // flight (set by the capture call sites from softAttemptPlan when
  // the burst metered all-soft; "" otherwise). runRapidScan's fail
  // branch attaches it to the retry hint once per soft streak —
  // advice on a failed attempt, never a refusal to attempt.
  const rapidSoftAdviceRef = useRef<string>("");
  // The scanner's most recent successful DETECTION (rect + when),
  // updated by every detection that lands — the preview interval,
  // every prepared burst frame, calibration. It is the read-rect
  // authority of last resort (Pass 16, applyRectAuthority): the
  // retained FRAME above expires after 2.5s and is consumed by any
  // capture, and the preview interval is suspended while an attempt
  // runs (~4s), so back-to-back scans routinely had NO retained frame
  // even though the viewfinder had just shown a perfect outline — and
  // the attempt then silently re-derived (or failed to derive) the
  // rect from post-tap frames and read the guide area instead. The
  // DETECTION outlives the frame: a burst whose own frames all fail
  // to detect is re-cropped with this rect rather than the guide.
  const lastDetectionRef = useRef<{ rect: CardRect; at: number } | null>(null);
  // Pass 18: the last few read rects of the current scene, for rect
  // stabilisation (prepareCardFromFrame's recentRects). Preview,
  // watcher, tap and capture heads all feed it through noteDetection;
  // entries older than 3s are pruned when read, and the list clears
  // with the camera — a stabiliser must never reach across scenes.
  const recentDetectionsRef = useRef<{ rect: CardRect; at: number }[]>([]);
  // CONTINUOUS TRACKING (Pass 24a, Item A): the box-mode card tracker.
  // Fed every live frame's own detection (prep.detectedRect) through
  // the single prepareCardCanvas wrapper; seeded from the stored
  // calibration whenever box mode is on with one. Its fresh rect is
  // offered to every box prepare as the working position — the user
  // no longer maintains a calibration by hand; 🎯 Calibrate remains
  // as an override that re-seeds the tracker.
  const trackedRectRef = useRef<TrackedRectState | null>(null);
  // Viewfinder mirror of the tracked rect (drawn as the outline in
  // box mode once the tracker holds a lock).
  const [trackedOverlay, setTrackedOverlay] = useState<CardRect | null>(null);
  // STEADY LIGHT (Pass 24a, Item B): the Auto hardware light latch.
  // All Auto torch/exposure applications go through it — hysteresis
  // + dwell between attempts, one latched decision per attempt.
  const lightLatchRef = useRef<LightLatchState>(createLightLatch());
  // Mirror of the batch-foil toggle for the watchdog's rescue path.
  const batchFoilRef = useRef(false);
  // Mirrors for the watchdog (which runs in a timer, not render scope):
  // whether a success result sheet is open, and whether the camera is on.
  const resultItemIdRef = useRef<number | null>(null);
  const cameraOnRef = useRef(false);
  const [captureRes, setCaptureRes] = useState<string>("");
  const captureResRef = useRef<string>("");
  // Stage timing for the last capture (ms the burst/photo capture took) —
  // identifyBurst folds it into the debug "Stages" line.
  const captureMsRef = useRef(0);
  // True while a MANUAL (Snap / Take Photo) identification is in flight —
  // the watchdog uses it to surface a visible failure panel for manual
  // reads it has to invalidate, instead of a bare note.
  const manualReadingRef = useRef(false);
  // Mirror of rapidOn for the watchdog (which must not alter Rapid's
  // behaviour when it fires during a rapid read).
  const rapidOnRef = useRef(false);
  const imageCaptureRef = useRef<{ track: MediaStreamTrack; ic: ImageCaptureLike } | null>(null);
  const [summary, setSummary] = useState<{ count: number; value: number } | null>(null);
  const rapidBusyRef = useRef(false);
  const rapidPausedRef = useRef(false);
  /** PASS 29 — consecutive fire deferrals for an incomplete
   * presentation (mid-slide hold); capped so a misjudged seat can
   * never wedge Rapid — after the cap the scan fires anyway. */
  const rapidDeferRef = useRef(0);
  const rapidStatsRef = useRef({ count: 0, value: 0 });
  const machineRef = useRef<RapidMachine | null>(null);
  if (!machineRef.current) machineRef.current = new RapidMachine();
  const baselinePendingRef = useRef(false);
  const baselinePrevRef = useRef<number[]>([]);
  const rapidCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const lastCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingBottomRef = useRef<BottomBandRead | null>(null);
  const flashTimer = useRef<number | null>(null);
  // Version detection (on demand, per scan-list item)
  const [detectingId, setDetectingId] = useState<number | null>(null);
  const [detectMsg, setDetectMsg] = useState<Record<number, string>>({});
  // Scan-list sheet forms
  const [moveTarget, setMoveTarget] = useState<string>("new");
  const [newCollName, setNewCollName] = useState("");
  const [deckName, setDeckName] = useState("");
  const [deckCommander, setDeckCommander] = useState<string>("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitMsg, setCommitMsg] = useState<string | null>(null);
  const [versionOpenId, setVersionOpenId] = useState<number | null>(null);
  const [versionGrid, setVersionGrid] = useState<CardT[] | null>(null);

  const resultItem = scanItems.find((i) => i.id === resultItemId) ?? null;

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4200);
  };

  const showFlash = (name: string, image: string, foil: boolean, silent = false, undo?: { itemId: number; value: number; note?: string }) => {
    if (!silent) beep();
    try { navigator.vibrate?.(60); } catch { /* best-effort */ }
    setFlash({ name, image, foil, itemId: undo?.itemId, value: undo?.value, note: undo?.note });
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    // An undoable banner stays up long enough to actually tap Undo.
    flashTimer.current = window.setTimeout(() => setFlash(null), undo ? 5000 : 1200);
  };

  /** Undo a rapid auto-add from its banner: removes the scan-list item
   * and unwinds the session stats. The card still sits in the guide and
   * the rapid machine already counts it as handled, so it won't be
   * re-added behind the user's back. */
  const undoFlashAdd = () => {
    const f = flash;
    if (!f?.itemId) return;
    const id = f.itemId;
    rapidStatsRef.current.count = Math.max(0, rapidStatsRef.current.count - 1);
    rapidStatsRef.current.value = Math.max(0, rapidStatsRef.current.value - (f.value ?? 0));
    setFlash(null);
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
    void api.updateScanListItem({ id, quantity: 0 })
      .then(() => queryClient.invalidateQueries({ queryKey: ["scanList"] }))
      .catch(() => setRapidHint("Undo failed — the card is still in your scan list; remove it there."));
  };

  const stopCamera = () => {
    generationRef.current += 1;
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
    retainedFrameRef.current = null;
    lastDetectionRef.current = null;
    recentDetectionsRef.current = [];
    // The card tracker clears with the camera too (Pass 24a): a lock
    // must never reach across camera sessions; it re-seeds from the
    // stored calibration on the next box prepare.
    trackedRectRef.current = null;
    setTrackedOverlay(null);
    // Camera off = the physical torch dies with its track. The light
    // MODE is a standing preference and persists (re-applied when the
    // camera restarts); the Auto layer's bookkeeping resets with it.
    setTorchSup("no-track");
    setTorchActive(false);
    torchActiveRef.current = false;
    autoTorchRef.current = false;
    autoExposureRef.current = null;
    autoLightHwRef.current = "";
  };

  /** Focus/exposure behaviour for the live track — best-effort, never throws.
   * PASS 31 (focus audit): the plan is focus.ts focusPlan — continuous
   * autofocus wherever the track exposes it (both modes), single-shot
   * (an AF trigger) next, and NEVER "manual" without a focusDistance:
   * the pre-Pass-31 box branch requested exactly that, parking the
   * lens at an unmeasured default while claiming a fixed-rig lock.
   * Exposure is deliberately NOT locked in the box: a locked exposure
   * turned the user's box frames near-black (their screenshot), while
   * auto exposure adapts to the tray lighting. Re-asserted after
   * track restarts AND after exposure-changing constraint writes
   * (the dark-frame retry), because sibling advanced constraints can
   * reset when one is applied on some Android stacks. */
  const applyCameraLocks = async (track: MediaStreamTrack): Promise<void> => {
    try {
      const caps = track.getCapabilities() as unknown as { focusMode?: string[]; exposureMode?: string[] };
      const plan = focusPlan(caps, boxModeRef.current);
      // PASS 32: remember what was REQUESTED — the diagnostics
      // AF-state line prints it next to what the track reports.
      focusRequestedRef.current = plan.focus === "none" ? null : plan.focus;
      if (plan.advanced.length > 0) {
        await track.applyConstraints({ advanced: plan.advanced as unknown as MediaTrackConstraintSet[] });
      }
    } catch { /* locks are best-effort */ }
  };

  /** PASS 32 (Item 2b): the AF-state line for the diagnostics —
   * the live track's reported focus capabilities, the mode the app
   * requested, and the mode the track reports applied, formatted by
   * focus.ts describeAfState. Best-effort: a track that exposes
   * nothing produces the "not exposed" line, which is itself the
   * diagnostic. */
  const currentAfStateLine = (): string => {
    const track = streamRef.current?.getVideoTracks()[0];
    // No live track (a photo-file read): there is no camera focus
    // state to report, and claiming "not exposed" would be wrong.
    if (!track) return "";
    let modes: string[] | null = null;
    let applied: string | null = null;
    if (track) {
      try {
        const caps = track.getCapabilities() as unknown as { focusMode?: string[] };
        modes = Array.isArray(caps.focusMode) ? caps.focusMode : null;
      } catch { /* not exposed */ }
      try {
        const settings = track.getSettings() as unknown as { focusMode?: string };
        applied = typeof settings.focusMode === "string" ? settings.focusMode : null;
      } catch { /* not reported */ }
    }
    return describeAfState({ supportedModes: modes, requested: focusRequestedRef.current, applied });
  };

  /** PASS 32 (Item 2a): force a FRESH autofocus cycle on the live
   * track. Applying "single-shot" IS the trigger where that mode is
   * exposed; on a continuous-AF track the toggle (single-shot, then
   * the plan re-asserted) is the only lever that restarts a cycle
   * that may have settled on the wrong plane. Capability-absent
   * tracks get the plain re-assert — there is nothing else to pull.
   * Best-effort throughout; never throws. */
  const retriggerAutofocus = async (): Promise<void> => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      const caps = track.getCapabilities() as unknown as { focusMode?: string[] };
      const plan = focusPlan(caps, boxModeRef.current);
      if (plan.focus === "continuous" && (caps.focusMode ?? []).includes("single-shot")) {
        try {
          await track.applyConstraints({ advanced: [{ focusMode: "single-shot" } as unknown as MediaTrackConstraintSet] });
        } catch { /* fall through to the re-assert */ }
      }
    } catch { /* best-effort */ }
    await applyCameraLocks(track);
  };

  /** After any track (re)start: apply locks, record torch support +
   * diagnostics, and re-apply the light preference to the NEW track
   * (On mode lights it; Auto mode lets the preview metering decide). */
  const setupTrack = async (track: MediaStreamTrack): Promise<void> => {
    await applyCameraLocks(track);
    const like = track as unknown as TorchTrackLike;
    const sup = torchSupport(like);
    setTorchSup(sup);
    setTorchDiag((d) => ({ ...d, capability: torchCapabilityValue(like) }));
    autoTorchRef.current = false;
    autoExposureRef.current = null;
    autoLightHwRef.current = "";
    // Pass 24a: the latch describes the OLD track's applied state —
    // a fresh track starts unlit with default exposure, so the latch
    // restarts too (otherwise it could believe a light is engaged
    // that no longer exists and never re-apply it).
    lightLatchRef.current = createLightLatch();
    if (lightModeRef.current === "on" || lightModeRef.current === "manual") {
      // Pass 30: a fresh track starts unlit at default exposure, so
      // the forced modes re-apply BOTH halves of their response —
      // the torch (when the gain asks for boost and the track
      // exposes one) and the gain-scaled exposure compensation.
      const gain = lightModeRef.current === "on" ? MAX_LIFT_GAIN : manualGainRef.current;
      if (sup === "supported" && gain > 1.01) {
        const res = await applyTorchDetailed(like, true);
        if (res.result === "applied") {
          setTorchActive(true);
          torchActiveRef.current = true;
        }
        if (res.errorName) setTorchDiag((d) => ({ ...d, lastError: res.errorName }));
      }
      const maxEc = exposureMaxOf(track);
      if (maxEc !== null) {
        const value = manualExposureValue(maxEc, gain);
        if (await setExposureComp(track, value)) autoExposureRef.current = value > 0 ? value : null;
      }
    }
  };

  /** Switch the physical torch, keeping state + diagnostics honest.
   * Best-effort: an unsupported/error apply leaves the torch marked
   * off rather than pretending. */
  const setPhysicalTorch = async (on: boolean): Promise<void> => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) {
      setTorchActive(false);
      torchActiveRef.current = false;
      return;
    }
    const like = track as unknown as TorchTrackLike;
    setTorchDiag((d) => ({ ...d, capability: torchCapabilityValue(like) }));
    const res = await applyTorchDetailed(like, on);
    if (res.result === "unsupported") setTorchSup("unsupported");
    setTorchDiag((d) => ({ ...d, lastError: res.errorName }));
    const lit = on && res.result === "applied";
    setTorchActive(lit);
    torchActiveRef.current = lit;
  };

  /** exposureCompensation capability: the max value, or null when the
   * track doesn't expose it. Guarded — never throws. */
  const exposureMaxOf = (track: MediaStreamTrack): number | null => {
    try {
      const caps = track.getCapabilities() as unknown as { exposureCompensation?: { max?: number } };
      const max = caps.exposureCompensation?.max;
      return typeof max === "number" && max > 0 ? max : null;
    } catch {
      return null;
    }
  };

  const setExposureComp = async (track: MediaStreamTrack, value: number): Promise<boolean> => {
    try {
      await track.applyConstraints({ advanced: [{ exposureCompensation: value } as unknown as MediaTrackConstraintSet] });
      return true;
    } catch {
      return false;
    }
  };

  /**
   * AUTO LIGHT — hardware layer (Pass 17 mechanism, Pass 24a control).
   * The engage/release work itself is unchanged: engage = torch on
   * (when the track exposes one) + exposureCompensation raised toward
   * max (when supported); release restores exactly what Auto engaged.
   * In browsers with neither capability (the Muse in-app webview:
   * torch absent) this is a silent no-op and the software lift carries
   * the attempt. Best-effort throughout — it never throws and never
   * blocks a scan. WHAT changed in Pass 24a is WHO calls this: only
   * the light latch (autolight.ts) decides, so applications happen at
   * most once per attempt (at its start) and never pulse between
   * attempts (hysteresis + dwell) — the pre-24a code applied this
   * directly from every metering tick against a single threshold on
   * a self-referential measurement, which oscillated on/off like a
   * heartbeat.
   */
  const applyLightAction = (action: LightAction): void => {
    if (!action) return;
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    void (async () => {
      try {
        const like = track as unknown as TorchTrackLike;
        if (action === "engage") {
          if (torchSupport(like) === "supported" && !torchActiveRef.current) {
            const res = await applyTorchDetailed(like, true);
            if (res.result === "applied") {
              autoTorchRef.current = true;
              setTorchActive(true);
              torchActiveRef.current = true;
            }
          }
          const maxEc = exposureMaxOf(track);
          if (maxEc !== null && autoExposureRef.current === null) {
            if (await setExposureComp(track, maxEc)) autoExposureRef.current = maxEc;
          }
          const hw: string[] = [];
          if (autoTorchRef.current) hw.push("torch on");
          if (autoExposureRef.current !== null) hw.push(`exposure +${autoExposureRef.current}`);
          autoLightHwRef.current = hw.join(" · ");
        } else {
          if (autoTorchRef.current) {
            await applyTorchDetailed(like, false);
            autoTorchRef.current = false;
            setTorchActive(false);
            torchActiveRef.current = false;
          }
          if (autoExposureRef.current !== null) {
            await setExposureComp(track, 0);
            autoExposureRef.current = null;
          }
          autoLightHwRef.current = "";
        }
      } catch { /* best-effort — auto light must never break a scan */ }
    })();
  };

  /** Preview metering step for the Auto hardware layer (Pass 24a):
   * the latch decides whether this metering may change the applied
   * light at all — hysteresis + dwell between attempts, and a strict
   * no-op while an attempt holds the latch. */
  const driveAutoLight = (p90: number): void => {
    if (lightModeRef.current !== "auto") return;
    const step = stepLightLatch(lightLatchRef.current, p90, performance.now());
    lightLatchRef.current = step.state;
    applyLightAction(step.action);
  };

  /** PASS 32 (Item 3a): feed the dark-scene / Light-Off hint from
   * the preview metering ticks (manual + Rapid watcher). The hint
   * shows exactly when the Auto layer WOULD engage (title-zone
   * p90 below LIGHT_ENGAGE_P90) but the user's Light mode is Off —
   * for two consecutive batches, retests of the light fixes ran
   * with the light off, so the condition under test never existed.
   * Non-blocking and never changes the setting: it clears on the
   * next tick that meters bright, loses the card, or sees any
   * non-Off mode. */
  const updateDarkOffHint = (p90: number | null): void => {
    setDarkOffHint(p90 !== null && lightModeRef.current === "off" && p90 < LIGHT_ENGAGE_P90);
  };

  /** FORCED LIGHT hardware (Pass 22 Manual; Pass 30 On + slider):
   * the user is asking for light — torch on where the browser
   * exposes one (only when the gain asks for any boost at all), and
   * exposure compensation scaled by the gain where supported
   * (manualExposureValue: ×1.0 → 0, ×4 → max). Mode On passes the
   * cap gain, i.e. torch + EC at max for the whole attempt. In
   * browsers where the torch reports absent (the Muse in-app
   * browser) the torch half is a silent no-op and the SOFTWARE lift
   * carries the reads — the UI says exactly that under the control. */
  const applyForcedLightHardware = async (gain: number): Promise<void> => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    autoTorchRef.current = false;
    autoLightHwRef.current = "";
    await setPhysicalTorch(gain > 1.01);
    const maxEc = exposureMaxOf(track);
    if (maxEc !== null) {
      const value = manualExposureValue(maxEc, gain);
      if (await setExposureComp(track, value)) autoExposureRef.current = value > 0 ? value : null;
    }
  };

  /** Set the manual gain (Pass 30 slider + presets): persisted, and
   * the software lift picks it up on the very next attempt — the
   * in-flight attempt, if any, keeps the gain it started with.
   * Hardware follows immediately BETWEEN attempts; a change made
   * mid-attempt defers its hardware half until the attempt ends
   * (pendingManualHwRef, drained when `reading` clears). */
  const setManualGain = (gain: number, opts: { hardware?: boolean } = {}): void => {
    const g = clampManualGain(gain);
    // Touching the manual control IS choosing Manual mode (Pass 30:
    // dragging the slider selects Manual) — the panel only renders
    // in Manual today, and this keeps the invariant true by
    // construction wherever the control is reached from.
    if (lightModeRef.current !== "manual") {
      setLightMode("manual");
      lightModeRef.current = "manual";
      try { localStorage.setItem("manabox-light-mode", "manual"); } catch { /* ignore */ }
    }
    setManualGainState(g);
    manualGainRef.current = g;
    try { localStorage.setItem("manabox-light-manual-gain", String(g)); } catch { /* ignore */ }
    if (opts.hardware && lightModeRef.current === "manual") {
      if (manualReadingRef.current || rapidBusyRef.current) {
        pendingManualHwRef.current = true;
      } else {
        void applyForcedLightHardware(g);
      }
    }
  };

  // Drain a deferred manual-hardware application when the in-flight
  // attempt ends (Pass 30: slider drags never move the hardware
  // light under a running read).
  useEffect(() => {
    if (!reading && pendingManualHwRef.current) {
      pendingManualHwRef.current = false;
      if (lightModeRef.current === "manual") void applyForcedLightHardware(manualGainRef.current);
    }
  }, [reading]);

  /** The Light chip cycles Auto → On → Manual → Off (Pass 17 cycle,
   * Pass 22 adds Manual). On and Manual force the torch; Off restores
   * anything Auto/Manual engaged and darkens the torch; Auto hands
   * control to the metering (a torch lit by hand stays Auto-owned so
   * adequate light can restore it). */
  const cycleLightMode = async (): Promise<void> => {
    const next = nextLightMode(lightModeRef.current);
    setLightMode(next);
    lightModeRef.current = next;
    try { localStorage.setItem("manabox-light-mode", next); } catch { /* ignore */ }
    const track = streamRef.current?.getVideoTracks()[0];
    if (next === "on") {
      // Pass 30: On forces the MAXIMUM response — torch AND exposure
      // compensation at max (the cap end of the manual scale), not
      // just the torch as before.
      await applyForcedLightHardware(MAX_LIFT_GAIN);
    } else if (next === "manual") {
      await applyForcedLightHardware(manualGainRef.current);
    } else if (next === "off") {
      if (track && autoExposureRef.current !== null) {
        await setExposureComp(track, 0);
      }
      autoExposureRef.current = null;
      autoTorchRef.current = false;
      autoLightHwRef.current = "";
      if (track) await setPhysicalTorch(false);
      else {
        setTorchActive(false);
        torchActiveRef.current = false;
      }
    } else {
      autoTorchRef.current = torchActiveRef.current;
      autoLightHwRef.current = "";
    }
  };

  const toggleBoxMode = async (): Promise<void> => {
    const next = !boxMode;
    setBoxMode(next);
    boxModeRef.current = next;
    try { localStorage.setItem("manabox-box-mode", next ? "1" : "0"); } catch { /* ignore */ }
    machineRef.current?.setBoxMode(next);
    // Pass 24a: entering box mode seeds the tracker from the stored
    // calibration (it takes over from there); leaving clears it — a
    // hand-held card must never be "tracked" from rig state.
    if (next) {
      trackedRectRef.current = boxCalibRef.current ? seedTrackedRect(boxCalibRef.current, performance.now()) : null;
      setTrackedOverlay(boxCalibRef.current);
    } else {
      trackedRectRef.current = null;
      setTrackedOverlay(null);
    }
    const track = streamRef.current?.getVideoTracks()[0];
    if (track) await applyCameraLocks(track);
  };

  const startCamera = async () => {
    setCameraError(null);
    if (!window.isSecureContext) {
      setCameraError("Browsers block the camera on non-HTTPS pages. This app is hosted on HTTPS — open it from its secure address, or use Take Photo, which always works.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("This browser doesn't expose a camera API. Use Take Photo instead.");
      return;
    }
    const myGen = ++generationRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // PASS 31: request continuous autofocus from the very start
        // (an ideal — browsers that don't expose focusMode ignore
        // it); setupTrack's applyCameraLocks then asserts the
        // capability-checked plan on the live track.
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          advanced: [{ focusMode: "continuous" } as unknown as MediaTrackConstraintSet],
        },
        audio: false,
      });
      if (generationRef.current !== myGen) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => undefined);
        const track = stream.getVideoTracks()[0];
        if (track) await setupTrack(track);
      }
      setCameraOn(true);
    } catch (err) {
      if (generationRef.current !== myGen) return;
      const e = err as { name?: string; message?: string };
      setCameraError(`The live camera couldn't start (${e.name ?? "Error"}: ${e.message ?? String(err)}). Take Photo runs the same identification on a photo.`);
    }
  };

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) track.stop();
      }
    };
  }, []);

  // Warm the on-device OCR worker in the background as soon as the Scan tab
  // opens, so the first real scan doesn't pay the load cost. Also sync the
  // rapid machine with the persisted scanner-box preference.
  useEffect(() => {
    machineRef.current?.setBoxMode(boxModeRef.current);
    // A fresh Scan-tab session gets a fresh one-restart budget (ocr.ts).
    resetOcrSession();
    warmUpOcr();
    const off = onOcrStatus((s) => setOcrStatus(s));
    const offEvent = onScannerEvent((msg) => setScanNote(msg));
    return () => { off(); offEvent(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the watchdog's mirrors current.
  useEffect(() => { resultItemIdRef.current = resultItemId; }, [resultItemId]);
  useEffect(() => { cameraOnRef.current = cameraOn; }, [cameraOn]);
  useEffect(() => { batchFoilRef.current = batchFoil; }, [batchFoil]);

  /**
   * Exact (set, collector number) lookup against Scryfall, raced at
   * 1.2s and never throwing: a stalled network call must not hold a
   * scan attempt (or the watchdog's rescue) open — a timeout is just
   * a miss. Shared by the burst pipeline's verified-pair path, the
   * number rescue, and the watchdog rescue.
   */
  const lookupSetNumber = async (set: string, number: string): Promise<CardT | null> => {
    const raced = await raceWithCap(
      api.getCardBySetNumber({ set, number }).then((r) => r.card).catch(() => null),
      1200,
    );
    return raced.status === "ok" ? raced.value : null;
  };

  /** Recovery step "verify-camera": if the live stream died (track
   * ended, video stalled), reattach/restart it so the view returns to
   * a working camera. Best-effort and quiet on success. */
  const ensureCameraLive = async (): Promise<void> => {
    if (!cameraOnRef.current) return;
    const track = streamRef.current?.getVideoTracks()[0];
    const video = videoRef.current;
    const live = !!track && track.readyState === "live" && !!video && video.readyState >= 2 && !video.paused;
    if (live) return;
    streamRef.current = null;
    await startCamera();
  };

  // Watchdog: "Reading card…" must NEVER persist. If any read is still in
  // flight after 8s, something underneath hung (stalled request, dead
  // promise) — invalidate the in-flight read, clear every busy flag, and
  // hand Rapid back to watching. The OCR worker itself is NOT restarted
  // here: ocr.ts restarts it only after two consecutive read timeouts,
  // because a restart's re-warm was the 6.6s stall in the user's shots.
  //
  // SUCCESS IS FINAL (scanflow rule A): if the attempt already settled
  // (a result was produced — the Cost of Brilliance / Cheerful
  // Osteomancer case, where the card was in the list yet a lingering
  // read's timeout stacked a red banner over the success sheet and
  // wedged the scanner), the watchdog does NOTHING but clear the busy
  // flag: no banner, no panel, no reset, no state change. A genuine
  // timeout FIRST gets the collector-number rescue on its captured
  // bottom evidence (scanflow rule E2 — the Divergent Equation
  // attempt-1 case, where the bottom line was perfect and the attempt
  // hung elsewhere); only when the rescue also fails does it run the
  // recovery plan (scanflow rule C): busy flags cleared, Rapid reset
  // to watching, camera verified/reattached, status back to ready —
  // a page refresh is never required.
  useEffect(() => {
    if (!reading) return;
    // PASS 20: the timer can re-arm ONCE past a sanctioned image
    // wait (see the deferral check inside) — `timer` is therefore a
    // mutable binding the fire callback reassigns, and the cleanup
    // clears whichever arming is current.
    let timer = 0;
    const fire = () => {
      void (async () => {
      const tracker = debugTrackerRef.current;
      const guard = attemptGuardRef.current;
      const attempt = tracker?.attempt ?? 0;
      const plan = watchdogRecoveryPlan({
        settled: guard?.isSettled(attempt) ?? false,
        hasOpenResult: resultItemIdRef.current !== null,
      });
      if (watchdogAction({ settled: guard?.isSettled(attempt) ?? false, hasOpenResult: resultItemIdRef.current !== null }) === "ignore") {
        // Completed attempt: its lingering timeout is not an event.
        rapidBusyRef.current = false;
        manualReadingRef.current = false;
        setReading(false);
        setPendingMatch(null);
        return;
      }
      // IMAGE-WAIT DEFERRAL (Pass 20): the attempt is inside its
      // bounded fusion wait for the image channel (registered in
      // imageWaitRef by identifyBurst; the wait exists because the
      // OCR pool was uncertain and the image channel is primary).
      // Tearing it down here would kill the very verdict the attempt
      // is sanctioned to wait for — re-arm just past the wait's end
      // instead; if the attempt STILL hasn't settled then, the
      // normal rescue/recovery below runs unchanged.
      //
      // PASS 21 (Item C): the deferral now consults ALL of the
      // attempt's shields (watchdogShieldDeferral): the pending
      // wait, the fusion-consult shield, and the grace a COMPLETED
      // image result buys the attempt. Pass 20 armed the deferral
      // only while the wait was pending — the user's Chandra
      // attempt, whose image result had already landed and been
      // published, held no shield at all when the watchdog fired
      // during its bounded post-image rescue pass, and was reset
      // with "hung during: title". An attempt that has received a
      // completed image-channel result must never afterwards die
      // by watchdog inside its sanctioned settlement.
      const completed = imageCompletedRef.current;
      const shieldDeferral = watchdogShieldDeferral({
        settled: guard?.isSettled(attempt) ?? false,
        shields: [
          imageWaitRef.current,
          imageShieldRef.current,
          completed && completed.attempt === attempt
            ? { attempt, untilEpochMs: completed.atEpochMs + IMAGE_SETTLE_GRACE_MS }
            : null,
        ],
        attempt,
        nowMs: Date.now(),
      });
      const waitDeferral = watchdogImageDeferral({
        settled: guard?.isSettled(attempt) ?? false,
        wait: imageWaitRef.current,
        attempt,
        nowMs: Date.now(),
      });
      // PASS 32 (Item 1) — THE CLOCK DEFERRAL: the watchdog's
      // deadline is derived from the attempt's OWN AttemptClock
      // (published by identifyBurst; its budget is read LIVE here,
      // so the fusion wait's extendTo and Rescue-2's
      // extendByFromNow — and any future sanctioned extension —
      // widen the watchdog's patience automatically). W1/W2 died
      // because Rescue-2's grant had no shield: the fusion shield
      // expired ~15s into attempts whose sanctioned reads ran to
      // ~17s. The shields above remain for the post-clock tails
      // (completion grace); the watchdog now defers to the LATEST
      // of every live source, and fires only when NO sanctioned
      // work remains outstanding — a genuinely hung attempt still
      // trips it, at its own (extended) deadline.
      const published = attemptClockRef.current;
      const clockDeferral = watchdogClockDeferral({
        settled: guard?.isSettled(attempt) ?? false,
        clock: published
          ? { attempt: published.attempt, epochStartMs: published.epochStartMs, budgetMs: published.clock.budget }
          : null,
        attempt,
        nowMs: Date.now(),
      });
      const rearmCandidates = [shieldDeferral, waitDeferral, clockDeferral].filter((d) => d.defer);
      if (rearmCandidates.length > 0) {
        timer = window.setTimeout(fire, Math.max(...rearmCandidates.map((d) => d.rearmMs)));
        return;
      }
      // RESCUE BEFORE FAILURE (Pass 9, scanflow rule E2): a timeout
      // may only DISPLAY after the collector-number rescue has been
      // tried on the attempt's ALREADY-CAPTURED bottom evidence — no
      // new OCR. The user's Divergent Equation attempt 1 hung with a
      // PERFECT bottom line captured ('U 0043 SOS EN INKOGNIT' →
      // SOS #43, this exact card) and the old watchdog showed a
      // timeout panel over an answer it was already holding.
      const ev = attemptEvidenceRef.current;
      if (ev.attempt === attempt && ev.sources.length > 0) {
        const rescued = await raceWithCap(
          rescueByCollectorNumber(ev.sources, lookupSetNumber, { artistText: ev.bottomText }),
          3000,
        ).catch(() => null);
        const chosen = rescued && rescued.status === "ok" ? rescued.value.chosen : null;
        if (chosen && guard && !guard.isSettled(attempt)) {
          // Identified from captured evidence: settle the attempt and
          // present the card exactly like a normal success.
          guard.settle(attempt);
          tracker?.invalidate();
          rapidBusyRef.current = false;
          manualReadingRef.current = false;
          setReading(false);
          setPendingMatch(null);
          setReadError(null);
          setFailedScan(null);
          const foilDetected: boolean | null = chosen.hit.separator === "star" ? true : chosen.hit.separator === "bullet" ? false : null;
          const foil = foilDetected ?? batchFoilRef.current;
          const numLabel = `${chosen.hit.setCode?.toUpperCase() ?? ""} ${chosen.hit.collectorNumber}`;
          try {
            if (rapidOnRef.current) {
              // PASS 22 (Item 2): this rescue IS a settle — feedback
              // fires before the save, exactly like a normal Rapid
              // settle, instead of after the awaited save.
              machineRef.current?.notifyResult("success", performance.now());
              const saved = settleWithFeedbackFirst(
                () => showFlash(chosen.card.name, chosen.card.imageSmall, foil),
                () => addToList(chosen.card, foil, lastCanvasRef.current, true),
              );
              machineRef.current?.reset(rapidCanvasRef.current ? canvasSignature(rapidCanvasRef.current) : []);
              await saved.then(({ item, merged }) => showFlash(item.name, item.imageSmall, foil, true, {
                itemId: item.id,
                value: (foil ? item.priceUsdFoil ?? item.priceUsd : item.priceUsd) ?? 0, note: settleNote(item, merged),
              }));
            } else {
              const { item } = await addToList(chosen.card, foil, lastCanvasRef.current, true);
              setResultItemId(item.id);
              setVersionInfo({
                status: "detected",
                message: `Matched by collector number ${numLabel} — the exact printing printed on the card (${chosen.card.setName} #${chosen.card.collectorNumber}). Recovered from the bottom line this scan had already read after the read stalled.`,
                foilDetected,
              });
            }
            setScanNote(`That read stalled, but its bottom line had already been captured — identified by collector number ${numLabel}, no refresh needed.`);
          } catch {
            setScanNote(`Identified by collector number ${numLabel} from the stalled read's captured bottom line, but saving to the scan list failed — check your connection.`);
          }
          return;
        }
      }
      void plan; // the steps below ARE the plan, in order
      const wasManual = manualReadingRef.current;
      scanGenRef.current += 1;
      // Snapshot the CURRENT attempt's incremental debug BEFORE
      // invalidating it: the failure panel shows exactly what THIS scan
      // had produced when it hung (bands so far, stages so far, and a
      // "hung during: <stage>" marker) — never a previous scan's block.
      // Invalidating also guarantees the hung pipeline, if it ever
      // finishes, cannot overwrite this panel with its late result.
      const timeoutSnap = tracker ? tracker.timeoutSnapshot() : null;
      // Pass 21: EVERY panel carries an image line — a timed-out
      // attempt whose channel never reported says so explicitly
      // instead of omitting the line (the Cadet panel's silence).
      if (timeoutSnap && !timeoutSnap.image.trim()) timeoutSnap.image = IMAGE_NOT_RUN_LINE;
      tracker?.invalidate();
      guard?.settle(attempt);
      // clear-busy + reset-rapid
      rapidBusyRef.current = false;
      machineRef.current?.forceReset();
      manualReadingRef.current = false;
      setReading(false);
      setPendingMatch(null);
      // verify-camera + status-ready: return to a live scanning state.
      void ensureCameraLive();
      if (wasManual && !rapidOnRef.current) {
        // A MANUAL Snap/Photo read was invalidated: it must settle into a
        // VISIBLE failure — this attempt's own diagnostic snapshot plus
        // the manual slow-read offer — never just a bare restart note.
        if (timeoutSnap) {
          setScanDebug(timeoutSnap);
          setRawRead(timeoutSnap.pooledRead);
        }
        setReadError("That read timed out — the scanner was reset and is ready again below. The panel below shows what this scan itself had read when it stopped; try Rapid, Take Photo, or the slow read.");
        if (lastCanvasRef.current) setFailedScan({ canvas: lastCanvasRef.current });
      } else {
        setScanNote("That read timed out and was reset — the scanner is ready and watching again, no refresh needed.");
      }
      })();
    };
    timer = window.setTimeout(fire, WATCHDOG_BASE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reading]);

  // Latest-ref for the probe handle below: the handle is defined
  // before identifyBurst in this component, so it reaches the real
  // burst pipeline through this ref (assigned right after
  // identifyBurst's definition).
  const identifyBurstRef = useRef<((preps: PreparedScan[], opts: { rapid: boolean; attempt?: number; onOptimisticName?: (name: string) => void; timings?: { captureMs: number; detectMs: number } }) => Promise<IdentifyOutcome>) | null>(null);

  // Probe/test handle: runs the REAL burst pipeline pieces (card
  // detection → fast title band + bottom-line read → collector-number
  // parse → pooled token-aware matcher) against any FRAME canvas, so
  // scan accuracy and timing can be measured without a camera —
  // including the scanner-box geometry where the card is small in frame.
  useEffect(() => {
    const w = window as unknown as { __manaboxTest?: unknown };
    w.__manaboxTest = {
      ocrReady: () => ensureOcrWorker().then(() => true).catch(() => false),
      indexSize: () => index?.length ?? 0,
      recognize: async (canvas: HTMLCanvasElement) => {
        const det = detectInCanvas(canvas);
        const card = det ? cropToRect(canvas, expandRect(correctCardAspect(det.rect, canvas.width / Math.max(1, canvas.height), det.shoulders), 0.015)) : canvas;
        const t0 = performance.now();
        let titleText = "";
        let bottomText = "";
        try {
          const r = await ocrBand(card, BAND_VARIANTS[0] ?? { x0: 0.01, x1: 0.83, y0: 0.025, y1: 0.11, treatment: "contrast" });
          titleText = r.text;
        } catch { /* reported below */ }
        try {
          const b = await ocrBottomBand(card);
          bottomText = b.text;
        } catch { /* reported below */ }
        const hit = parseBottomLine(bottomText);
        const lines = titleText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const matches: MatchResult[] = index && index.length > 0 ? matchNamesPooled(ocrCandidates(lines), index, 3) : [];
        return {
          rect: det?.rect ?? null,
          confidence: det ? Math.round(det.confidence * 1000) / 1000 : 0,
          text: titleText,
          bottomText,
          bottomHit: hit ? { number: hit.collectorNumber, set: hit.setCode, separator: hit.separator } : null,
          decision: decideRapidMatch(matches),
          ms: Math.round(performance.now() - t0),
          matches: matches.map((m) => ({ name: m.entry.full, face: m.entry.face, score: Math.round(m.score * 1000) / 1000 })),
        };
      },
      /** FULL pipeline probe: the real identifyBurst (burst reads,
       * verified number path, Pass 8 number rescue + title-band
       * rescue) over one prepared frame, with the winning evidence
       * and stage timings from the attempt's own debug snapshot —
       * this is what the band-misalignment fixtures run: composite a
       * real card image so the title sits at/below the standard
       * band's edge and the outcome must still identify it, naming
       * the read that won (standard / offset+4 / offset+8 / tall /
       * collector number). */
      recognizeFull: async (canvas: HTMLCanvasElement) => {
        const fn = identifyBurstRef.current;
        if (!fn) return null;
        const det = detectInCanvas(canvas);
        const rect = det && det.confidence >= 0.4
          ? expandRect(correctCardAspect(det.rect, canvas.width / Math.max(1, canvas.height), det.shoulders), 0.015)
          : null;
        const prep: PreparedScan = rect
          ? { card: cropToRect(canvas, rect), frame: canvas, source: "detected", rect, rectOrigin: "frame", detectMs: 0, detectedRect: rect }
          : { card: canvas, frame: canvas, source: "guide", rect: null, rectOrigin: "guide", detectMs: 0, detectedRect: null };
        const t0 = performance.now();
        const outcome = await fn([prep], { rapid: false });
        const snap = debugTrackerRef.current?.snapshot();
        return {
          kind: outcome.kind,
          name: outcome.kind === "confident" ? outcome.card.name : null,
          setCode: outcome.kind === "confident" ? outcome.card.setCode : null,
          collectorNumber: outcome.kind === "confident" ? outcome.card.collectorNumber : null,
          evidence: snap?.evidence ?? "",
          stages: snap?.stages ?? "",
          pooledRead: snap?.pooledRead ?? "",
          ms: Math.round(performance.now() - t0),
          matches: outcome.kind === "uncertain"
            ? outcome.matches.map((m) => ({ name: m.entry.full, score: Math.round(m.score * 1000) / 1000 }))
            : [],
        };
      },
    };
    return () => {
      delete (window as unknown as { __manaboxTest?: unknown }).__manaboxTest;
    };
  }, [index]);

  type ScanPath = "device" | "slow";
  type IdentifyOutcome =
    | { kind: "confident"; card: CardT; info: VersionInfo; path: ScanPath; evidence?: "number" | "title" | "slow" }
    | { kind: "uncertain"; matches: MatchResult[]; path: ScanPath; imageCandidate?: RankedCandidate | null }
    | { kind: "none"; path: ScanPath; noRead?: boolean; tooDark?: boolean }
    /** The attempt was settled/superseded while the pipeline was
     * awaiting something (success-is-final, scanflow rule A): callers
     * must drop this outcome silently — no UI, no state change. */
    | { kind: "aborted"; path: ScanPath };

  /** Version detection from the bottom info already read in the single frame call. */
  const resolveVersion = async (
    cardCanvas: HTMLCanvasElement,
    baseCard: CardT,
    bottom: BottomBandRead | null,
  ): Promise<{ card: CardT; info: VersionInfo; printings: CardT[] }> => {
    let printings: CardT[] = [baseCard];
    try {
      if (baseCard.printsSearchUri) {
        // Pass 25: Detect version scores the bottom line against
        // EVERY printing — with the 60-newest cap, an older printing
        // (a basic land's, above all) could never be pinned here.
        const res = await api.getPrintings({ printsSearchUri: baseCard.printsSearchUri, full: true });
        if (res.printings.length > 0) printings = res.printings;
      }
    } catch { /* keep the default printing */ }
    const foilDetected: boolean | null =
      bottom?.separator === "star" ? true : bottom?.separator === "bullet" ? false : null;
    const rawBottomText = (bottom?.lines ?? []).join(" ");
    const setHint = bottom ? bottomSetCodeHint(rawBottomText, printings, baseCard.setCode) : null;
    const unconfirmed: VersionInfo = {
      status: "unconfirmed",
      message: setHint
        ? `Version not confirmed — showing ${baseCard.setName} (${baseCard.setCode.toUpperCase()}) #${baseCard.collectorNumber}. Your card's bottom line reads ${setHint} — tap “Change version” if that's not ${baseCard.setCode.toUpperCase()}.`
        : `Version not confirmed — showing ${baseCard.setName} (${baseCard.setCode.toUpperCase()}) #${baseCard.collectorNumber}. If your copy is a different printing, change the version from the scan list.`,
      foilDetected,
    };
    if (printings.length <= 1) {
      return { card: baseCard, info: { status: "detected", message: `Only one printing of this card exists: ${baseCard.setName} #${baseCard.collectorNumber}.`, foilDetected }, printings };
    }
    if (bottom) {
      const hit = matchPrintingByBottom(bottom, printings);
      if (hit) {
        const p = hit.printing;
        return {
          card: p,
          info: {
            status: "detected",
            message: `Version detected: ${p.setName} #${p.collectorNumber} — matched the ${bottom.collectorNumber ?? ""}${bottom.setCode ? ` / ${bottom.setCode.toUpperCase()}` : ""} printed on the card${hit.why.includes("artist") && bottom.artist ? `, confirmed by the artist line (${bottom.artist})` : ""}.`,
            foilDetected,
          },
          printings,
        };
      }
      // SALVAGE: the strict parse failed, but the raw bottom text may
      // still carry a mangled-but-readable set code / number / artist
      // (the "Q0/280 … M20 … MOELLER" case). Score it against this
      // card's printings before giving up to the visual pick.
      const salvaged = salvagePrintingFromBottom(rawBottomText, printings);
      if (salvaged) {
        const p = salvaged.printing;
        return {
          card: p,
          info: {
            status: "detected",
            message: `Version matched from the bottom line: ${p.setName} #${p.collectorNumber} — the bottom strip's set code, number and artist agree with this printing even though the number line itself was partly garbled.`,
            foilDetected,
          },
          printings,
        };
      }
    }
    // Precise mode only: visual pick for odd frames. Fast mode stops here.
    if (speedRef.current === "precise" && printings.length <= 30) {
      try {
        const full = buildFullCardJpeg(cardCanvas);
        if (full) {
          const pick = await api.pickPrintingByImage({
            imageBase64: full,
            candidates: printings.map((p) => ({ scryfallId: p.scryfallId, summary: printingSummary(p) })),
          });
          const chosen = printings.find((p) => p.scryfallId === pick.scryfallId);
          if (chosen) {
            return {
              card: chosen,
              info: {
                status: "guess",
                message: `Best guess — check the version: this looks like ${chosen.setName} (${chosen.setCode.toUpperCase()}) #${chosen.collectorNumber}${pick.reason ? ` (${pick.reason})` : ""}.`,
                foilDetected,
              },
              printings,
            };
          }
        }
      } catch { /* fall through to unconfirmed */ }
    }
    return { card: baseCard, info: unconfirmed, printings };
  };

  const NAME_ONLY_INFO: VersionInfo = {
    status: "unconfirmed",
    message: "Matched by name on this device — the exact printing hasn't been checked. “Detect version” (below, or in the scan list) reads the bottom line from your saved photo to pin it down.",
    foilDetected: null,
  };

  const slowInfo = (bottom: BottomBandRead): VersionInfo => ({
    status: "unconfirmed",
    message: "That one needed the slower server read — version not checked. “Detect version” (below, or in the scan list) can pin the exact printing from your photo.",
    foilDetected: bottom.separator === "star" ? true : bottom.separator === "bullet" ? false : null,
  });

  /**
   * Core identification. The caller hands us the CARD crop (produced by
   * prepareCardCanvas from the detected/calibrated card rectangle — never
   * a guide-relative crop).
   * PRIMARY PATH (on-device, ZERO server reads): OCR the title band with
   * the warmed Tesseract worker as a POOL of card-relative variants
   * (BAND_VARIANTS), fuzzy-matching locally after each; the pool stops at
   * the first confident match, so a clean card costs one read. On a
   * confident match the name is reported via onOptimisticName immediately
   * — Scryfall details and the scan-list save follow behind it.
   * FALLBACK ("slow read"): the combined server vision read, only when
   * `allowSlow` — which is NEVER true in Rapid mode (resolveRapidMode);
   * there it becomes a manual button on the unrecognised card instead.
   * `slowOnly` skips the device path entirely (that manual button).
   * Version/printing detection does not happen here — it is the per-item
   * "Detect version" action, run on demand against the stored photo.
   */
  const identifyCore = async (
    cardCanvas: HTMLCanvasElement,
    opts: { onOptimisticName?: (name: string) => void; allowSlow?: boolean; slowOnly?: boolean } = {},
  ): Promise<IdentifyOutcome> => {
    const { onOptimisticName, allowSlow = true, slowOnly = false } = opts;
    pendingBottomRef.current = null;

    /** Match read lines locally; on a confident hit, resolve the card. The
     * read text is split into lines first — block-mode OCR returns the name
     * as one line among debris lines, and each line is a match candidate. */
    const matchLocally = async (lines: string[], path: ScanPath): Promise<IdentifyOutcome | null> => {
      if (!index || index.length === 0) return null;
      const rawLines = lines.flatMap((l) => l.split(/\r?\n/)).map((s) => s.trim()).filter(Boolean);
      const cands = ocrCandidates(rawLines);
      if (cands.length === 0) return null;
      const matches = matchNames(cands, index, 3);
      const best = matches[0];
      if (best && best.score >= 0.82) {
        onOptimisticName?.(best.entry.full);
        const got = await api.getCardByName({ name: best.entry.full });
        if (got.card) {
          return {
            kind: "confident",
            card: got.card,
            info: path === "device" ? NAME_ONLY_INFO : slowInfo(pendingBottomRef.current ?? { collectorNumber: null, setCode: null, separator: "unknown", artist: null, lines: [] }),
            path,
          };
        }
        return { kind: "none", path };
      }
      if (best && best.score >= 0.5) return { kind: "uncertain", matches, path };
      return null;
    };

    // --- Primary: on-device OCR + local match (pooled band variants) ---
    if (!slowOnly && index && index.length > 0) {
      let bestUncertain: IdentifyOutcome | null = null;
      let bestUncertainScore = 0;
      try {
        await ensureOcrWorker();
        for (const spec of BAND_VARIANTS) {
          let read: Awaited<ReturnType<typeof ocrBand>>;
          try {
            read = await ocrBand(cardCanvas, spec);
          } catch {
            // Timed out / errored — ocr.ts has already restarted (or is
            // restarting) the worker; further variants would hit it cold.
            break;
          }
          const hit = await matchLocally([read.text], "device");
          if (hit?.kind === "confident") {
            setRawRead(read.text);
            return hit;
          }
          if (hit?.kind === "uncertain") {
            const s = hit.matches[0]?.score ?? 0;
            if (s > bestUncertainScore) {
              bestUncertain = hit;
              bestUncertainScore = s;
              setRawRead(read.text);
            }
          } else if (!isGarbageRead(read.text)) {
            setRawRead(read.text);
          }
        }
      } catch {
        // Worker unavailable (CDN blocked etc.) — fall through.
      }
      if (bestUncertain) return bestUncertain;
      if (!allowSlow) return { kind: "none", path: "device" };
    } else if (!allowSlow) {
      return { kind: "none", path: "device" };
    }

    // --- Fallback: server vision read (existing readCardFrame semantics) ---
    const frame = buildReadFrame(cardCanvas);
    if (!frame) return { kind: "none", path: "slow" };
    const res = await api.readCardFrame({ imageBase64: frame });
    const lines = res.titleLines;
    setRawRead(lines.join(" · "));
    const bottom: BottomBandRead = {
      collectorNumber: res.collectorNumber,
      setCode: res.setCode,
      separator: res.separator,
      artist: res.artist,
      lines: res.bottomLines,
    };
    pendingBottomRef.current = bottom;
    const hit = await matchLocally(lines, "slow");
    if (hit) return hit;
    const cands = ocrCandidates(lines);
    const guess = cands[0];
    if (guess) {
      const fuzzy = await api.getCardFuzzy({ name: guess });
      if (fuzzy.card) {
        return { kind: "confident", card: fuzzy.card, info: slowInfo(bottom), path: "slow" };
      }
    }
    if (index && cands.length > 0) {
      const weak = matchNames(cands, index, 3);
      if (weak.length > 0) return { kind: "uncertain", matches: weak, path: "slow" };
    }
    return { kind: "none", path: "slow" };
  };

  /**
   * BURST identification — the primary scan path for both Rapid and Snap.
   * The caller hands us up to 3 prepared frames (~120ms apart). Per frame,
   * FAST reads only: the title band (one variant, PSM 7) and the bottom
   * info strip (PSM 6, digits/letters whitelist). Evidence pools across
   * frames:
   *  1. COLLECTOR NUMBER WINS. A parsed (set, number) — VERIFIED by a
   *     second bottom-strip treatment agreeing on the number (and on
   *     the code exactly or within one letter), so a single treatment's
   *     digit merge (179→129, a real different card) can never
   *     auto-accept the wrong card — is looked up EXACTLY on Scryfall:
   *     a hit is a certain identification of the exact printing,
   *     accepted immediately in both modes (cross-checked against
   *     pooled title evidence; a strong disagreement is flagged in the
   *     message, never silently overridden).
   *  2. TITLE POOL. Candidates from all frames' title reads are matched
   *     together with the token-aware pooled matcher. In Rapid, a
   *     decisive top match auto-accepts (decideRapidMatch); a plausible
   *     but thin-margin top pauses for Did-you-mean. Manual Snap keeps
   *     the ≥0.82 confident bar and — SNAP PARITY — runs this exact same
   *     burst pipeline at the exact same cost; only with Precise
   *     explicitly selected does Snap continue into the legacy variant
   *     pool + slow read in identifyCore. On a title win, the pooled
   *     bottom text gets a SALVAGE pass against the card's printings
   *     (lib.ts salvagePrintingFromBottom) so a garbled-but-readable
   *     bottom line still selects the right printing.
   *  3. NO-READS (<4 alphanumerics across every title read, no bottom
   *     evidence) return kind "none" with noRead — they NEVER produce
   *     suggestions or pause Rapid.
   *  4. RESCUE (Pass 8) — when the pool still ends below confident,
   *     BEFORE any failure surfaces: (a) the NUMBER RESCUE tries
   *     every plausible (set, number) candidate from every bottom
   *     read (buildNumberCandidates — corroborated pairs first, 404s
   *     discarded, artist line breaks ties), because hand-held shots
   *     kept failing the per-frame two-treatment verification gate
   *     while their primary bottom read was essentially perfect, and
   *     modern frames print rarity + bare number with no denominator
   *     ("U 0227 SOS" → Snooping Page, "C 0185 SOS" → Elemental
   *     Mascot, both verified live on Scryfall); (b) Snap only, the
   *     TITLE-BAND RESCUE reads the +4%/+8% downward offsets and the
   *     TALL band (PSM 6 line pick) on the later burst frames, then
   *     the first — hand-held aim puts the title at or below the
   *     standard band's bottom edge, and one silent retry beats a
   *     failure panel. Rapid inherits (a) only; its happy path and
   *     the watcher retry are unchanged.
   *  5. DEADLINE SETTLEMENT (Pass 9) — every read above runs under an
   *     AttemptClock (scanflow.ts): title reads are individually
   *     capped at ~900ms (ocrTitleBandCapped), bottom reads at ~1.2s,
   *     and the whole reads phase settles by ATTEMPT_DEADLINE_MS
   *     (2.5s; ATTEMPT_RESCUE_DEADLINE_MS including rescue bands)
   *     with the best evidence available at that moment — pooled
   *     title fragments first, then the number rescue, then
   *     Did-you-mean, then failure. The Divergent Equation attempts
   *     hung "during: title" with title AND match already complete:
   *     one pooled variant job spinning on the shared worker blocked
   *     every later await. A hung variant can no longer block
   *     settlement, and "hung during: X" is unreachable whenever any
   *     variant of X returned usable text. The same number rescue
   *     also runs in the watchdog branch on captured evidence, so
   *     even a pathological hang outside this pipeline settles.
   * Show-your-work diagnostics (band thumbnails, pooled raw read,
   * winning evidence, capture resolution) are published INCREMENTALLY
   * through the scan-attempt tracker (scandebug.ts): bands the moment
   * they are cropped, raw reads as each OCR returns, stage timings as
   * each stage completes — so if this read ever hangs, the watchdog's
   * failure panel shows THIS attempt's partial data, not a previous
   * scan's finished block.
   */
  /**
   * IMAGE CHANNEL (rework Stage 2/3) — the ManaBox-style primary
   * identification path, run CONCURRENTLY with the burst's OCR
   * reads so its latency hides inside the existing deadline
   * envelope:
   *   1. Dewarp the prepared card to the canonical upright image
   *      and fingerprint it under the multi-hypothesis rect set
   *      (finder.ts — the measured #77 fix).
   *   2. The server visual index (identifyByImage) proposes
   *      candidate names BY ARTWORK; every proposal is already
   *      Scryfall-verified server-side.
   *   3. Each candidate's real printings are fingerprinted from
   *      their Scryfall reference images and rankReferences
   *      measures the true pHash distances. Only a measured
   *      distance inside the fusion gate can settle (fusion.ts).
   * Never throws: any failure returns empty candidates and the
   * OCR/number floor proceeds exactly as before the rework.
   *
   * PASS 20: the result carries HOW the proposal stage ended
   * (status + visionMs). Pass 19 raced the proposal call at 3.5s —
   * below its measured 5.5–8.0s round trip — so the call timed out
   * on 100% of production attempts and every failure printed as
   * "no candidates (channel produced nothing usable)". The cap is
   * now IMAGE_VISION_CAP_MS (scanflow.ts), the reference phase is
   * parallel, and each failure mode prints its own diagnostic.
   */
  const runImageChannel = async (
    prepsIn: PreparedScan[],
    getEvidence?: () => { sources: { text: string; verify?: boolean }[]; bottomText: string },
  ): Promise<ImageChannelResult> => {
    const prep = prepsIn[0]!;
    const t0 = performance.now();
    const done = (
      ranked: RankedCandidate[],
      proposed: string[],
      dewarpedUrl: string,
      status: ImageChannelStatus,
      visionMs: number,
    ): ImageChannelResult => ({
      ranked, proposed, dewarpedUrl, status, visionMs, ms: performance.now() - t0,
    });
    const dewarped = dewarpPreparedCard(prep.card);
    let dewarpedUrl = "";
    try { dewarpedUrl = dewarped.toDataURL("image/jpeg", 0.7); } catch { /* diagnostics only */ }
    // MULTI-FRAME CONSENSUS (Pass 23 Item D): query fingerprints are
    // computed PER BURST FRAME (up to 3 frames × the multi-hypothesis
    // rect set each). Single-frame distance is noisy — the same card
    // measured d=50/42/40 across attempts — so each frame is ranked
    // separately after the reference phase and consensusRank carries
    // the BEST distance per candidate into the gate, with the median
    // kept as the instability check. Frame 1 still drives the
    // proposal call (one server round trip per attempt, unchanged).
    const queryFpsFor = (p: PreparedScan): Fingerprint[] => {
      const fps: Fingerprint[] = [];
      const crops: HTMLCanvasElement[] = [];
      if (p.rect) {
        for (const hyp of rectHypotheses(p.rect)) {
          try {
            crops.push(dewarpPreparedCard(cropToRect(p.frame, hyp)));
          } catch { /* one bad hypothesis must not sink the set */ }
        }
      }
      if (crops.length === 0) {
        try { crops.push(dewarpPreparedCard(p.card)); } catch { /* ignore */ }
      }
      for (const c of crops) {
        const fp = fingerprintCanvas(c);
        if (fp) fps.push(fp);
      }
      // PASS 23 (Item B fix): exposure-normalised query variants.
      // References are normally lit; a DIM dewarp fingerprinted raw
      // spends its hash distance on the exposure difference, and
      // the distance × clarity matrix convicted the result: 11 of
      // 12 image wrong-settles sat in dim cells (colour-twin
      // impostors inside the decisive gate), ZERO in bright cells.
      // When the card meters dim, pool a gain-lifted copy of every
      // crop alongside the raw set — the same Auto Light lift the
      // OCR windows already get (Pass 17) — so ranking compares
      // like-lit images. Bright captures are untouched (meter gain
      // 1 → no extra variants).
      const meter = meterBand(p.card, { x0: 0, y0: 0, x1: 1, y1: 1 });
      if (meter && meter.cls === "dim" && meter.gain > 1.01) {
        for (const c of crops) {
          const lifted = liftCanvasCopy(c, meter.gain);
          if (!lifted) continue;
          const fp = fingerprintCanvas(lifted);
          if (fp) fps.push(fp);
        }
      }
      return fps;
    };
    const perFrameFps: Fingerprint[][] = prepsIn.slice(0, 3).map(queryFpsFor);
    const queryFps: Fingerprint[] = perFrameFps[0] ?? [];
    const b64 = canvasToJpegBase64(dewarped);
    if (!b64) return done([], [], dewarpedUrl, "encode-failed", 0);
    // PASS 20 — the proposal race. The measured identifyByImage
    // round trip is 5.5–8.0s (vision inference 5.0–6.8s + Scryfall
    // verification); Pass 19 capped it at 3.5s, so the race resolved
    // as a timeout on EVERY attempt and the result was mapped to
    // "no candidates" — the channel never produced a single
    // production candidate. The cap is now IMAGE_VISION_CAP_MS, and
    // the three ways the call can end are kept DISTINCT (timeout vs
    // action error vs an honest empty proposal list) because each
    // prints its own diagnostic line. The .catch(() => null) stays
    // OUTSIDE the race on purpose: raceWithCap maps rejections to
    // "timeout", so catching first is what lets an action error
    // surface as value=null under status "ok" = call-failed.
    const vision = await raceWithCap(
      api.identifyByImage({ imageBase64: b64 }).catch(() => null),
      IMAGE_VISION_CAP_MS,
    );
    if (vision.status !== "ok") return done([], [], dewarpedUrl, "call-timeout", vision.ms);
    if (!vision.value) return done([], [], dewarpedUrl, "call-failed", vision.ms);
    const proposed = vision.value.candidates.map((c) => c.name);
    if (proposed.length === 0) return done([], proposed, dewarpedUrl, "no-proposals", vision.ms);
    if (queryFps.length === 0) return done([], proposed, dewarpedUrl, "no-references", vision.ms);
    // Reference phase — PARALLEL (Pass 20). Pass 19 fetched each
    // name's printings and then loaded up to 8 reference images
    // strictly sequentially per name, so even a successful proposal
    // could not finish inside any sane settlement envelope. The
    // per-call caps are unchanged; only the concurrency changed.
    //
    // PASS 25 (Item 2a) — WHICH printings get fingerprinted is now
    // chosen by the attempt's BOTTOM-LINE EVIDENCE, not by list
    // position. The old rule (the first 8 of the released-desc
    // list = the 8 newest) structurally excluded the true printing
    // for high-count names: all six real Swamp #274 printings sit
    // at ranks 61..176+ of 930, outside even the 60-printing list.
    // The evidence arrives via getEvidence (the attempt's captured
    // bottom reads — by the time the ~5–8s vision call returns, the
    // frame loop has long finished pooling them): exact candidate
    // pairs are resolved by lookup (server-cached; the Settlement-2
    // rescue reuses the same cache) and same-name hits join the set
    // even when they live outside the list; list printings matching
    // the read set/number/artist fill the remaining evidence slots
    // (printingselect.ts). No evidence → the selection is the old
    // set plus the default printing.
    const perName = await Promise.all(
      proposed.slice(0, 3).map(async (name): Promise<CardT[]> => {
        const baseRes = await raceWithCap(
          api.getCardByName({ name }).then((r) => r.card).catch(() => null),
          1500,
        );
        const base = baseRes.status === "ok" ? baseRes.value : null;
        if (!base) return [];
        let printings: CardT[] = [base];
        if (base.printsSearchUri) {
          const pr = await raceWithCap(
            api.getPrintings({ printsSearchUri: base.printsSearchUri }).then((r) => r.printings).catch(() => [] as CardT[]),
            1500,
          );
          if (pr.status === "ok" && pr.value.length > 0) printings = pr.value;
        }
        const ev = getEvidence?.() ?? { sources: [], bottomText: "" };
        const candPairs = buildNumberCandidates(ev.sources)
          .map((c) => ({ setCode: c.hit.setCode ?? "", collectorNumber: c.hit.collectorNumber }))
          .filter((c) => c.setCode.length > 0);
        const exactPrintings: CardT[] = [];
        if (candPairs.length > 0) {
          for (const pair of candPairs.slice(0, 5)) {
            const hitRes = await raceWithCap(
              api.getCardBySetNumber({ set: pair.setCode, number: pair.collectorNumber }).then((r) => r.card).catch(() => null),
              1200,
            );
            const hitCard = hitRes.status === "ok" ? hitRes.value : null;
            // Only THIS name's printings join its candidate set — a
            // pair resolving to a different card is foreign evidence
            // (the rescue + interlock adjudicate it, not the
            // fingerprint set).
            if (hitCard && hitCard.name === name) exactPrintings.push(hitCard);
          }
        }
        return selectReferencePrintings(printings, {
          baseId: base.scryfallId,
          exactPrintings,
          candidates: candPairs,
          bottomText: ev.bottomText,
        });
      }),
    );
    const allPrintings = perName.flat();
    const loaded = await Promise.all(
      allPrintings.map(async (p): Promise<ReferenceEntry | null> => {
        if (!p.imageSmall) return null;
        const refCanvas = await loadReferenceImage(p.imageSmall);
        if (!refCanvas) return null;
        const fp = fingerprintCanvas(refCanvas);
        if (!fp) return null;
        return { name: p.name, setCode: p.setCode, collectorNumber: p.collectorNumber, scryfallId: p.scryfallId, fp, fullArt: p.fullArt, borderColor: p.borderColor };
      }),
    );
    const refs = loaded.filter((r): r is ReferenceEntry => r !== null);
    if (refs.length === 0) return done([], proposed, dewarpedUrl, "no-references", vision.ms);
    // Per-frame ranking → consensus (Pass 23 Item D). With a single
    // usable frame this is exactly the pre-Pass-23 ranking.
    const perFrameRanked = perFrameFps
      .filter((fps) => fps.length > 0)
      .map((fps) => rankReferences(fps, refs));
    const ranked = consensusRank(perFrameRanked);
    return done(ranked, proposed, dewarpedUrl, "ok", vision.ms);
  };

  const identifyBurst = async (
    preps: PreparedScan[],
    opts: { rapid: boolean; attempt?: number; onOptimisticName?: (name: string) => void; timings?: { captureMs: number; detectMs: number } },
  ): Promise<IdentifyOutcome> => {
    const { rapid, onOptimisticName } = opts;
    pendingBottomRef.current = null;
    const firstCard = preps[0]?.card;
    if (!firstCard) return { kind: "none", path: "device", noRead: true };
    // Per-stage timing accumulators — surfaced in the debug block so a
    // slow Snap shows WHERE its time went (capture · detect · title ·
    // bottom · match) instead of a bare "timed out".
    let titleMs = 0;
    let bottomMs = 0;
    let matchMs = 0;
    // The scan attempt this burst belongs to. Callers (Snap / Rapid)
    // begin the attempt before capturing so the debug state resets at
    // the very start of the attempt; fall back to beginning it here.
    const tracker = debugTrackerRef.current!;
    const attempt = opts.attempt ?? tracker.beginAttempt({
      capture: captureResRef.current || "unknown",
      evidence: rapid ? "title (rapid burst)" : "title (burst)",
      rect: describePrepRect(preps[0]),
    });
    const guard = attemptGuardRef.current!;
    guard.start(attempt);
    // OCR GENERATION (Pass 15): this attempt's reads are tagged with a
    // fresh generation — reads a PREVIOUS attempt left queued are
    // dropped at the queue front instead of consuming worker time,
    // and a worker still executing a previous attempt's abandoned
    // (zombie) job is recycled before this attempt's first read.
    const ocrGen = beginScanAttempt();
    // DEADLINE (Pass 9): the reads phase of this attempt settles by
    // ATTEMPT_DEADLINE_MS with the best evidence available — see the
    // doc comment above. The clock starts NOW (capture/detect already
    // happened in the caller and are accounted as their own stages).
    const clock = new AttemptClock(ATTEMPT_DEADLINE_MS, () => performance.now());
    // PASS 32 (Item 1): publish this attempt's clock for the
    // watchdog — its deadline is DERIVED from the clock's live
    // budget at every firing, so every sanctioned extension below
    // (the fusion wait, Rescue-2, and any future one) extends the
    // watchdog's patience by construction (see attemptClockRef).
    attemptClockRef.current = { attempt, epochStartMs: Date.now(), clock };
    // This attempt's captured-evidence mirror starts empty; the
    // watchdog rescue reads it if this attempt ever hangs elsewhere.
    attemptEvidenceRef.current = { attempt, sources: [], bottomText: "" };
    /** SUCCESS IS FINAL: once the attempt is settled (a result was
     * produced, or the watchdog/user superseded it), every in-flight
     * continuation — bottom reads, extra frames, verification reads,
     * lookups — is abandoned silently. Checked after EVERY await. */
    const aborted = (): boolean => !guard.isActive(attempt);
    const abortOutcome: IdentifyOutcome = { kind: "aborted", path: "device" };
    let evidence = rapid ? "title (rapid burst)" : "title (burst)";
    let pooledRead = "";
    // Bands are published the moment they are cropped — before any OCR
    // runs — so even a read that hangs in its first OCR has its own
    // band images on the failure panel.
    pubDebug(tracker.publish(attempt, {
      // Pass 26: the published title thumbnail is the AIMED window —
      // the band the burst will actually read (mirrors the bottom
      // thumbnail's Pass 18 honesty rule).
      titleBandUrl: bandThumb(buildBandCanvas(firstCard, aimTitleSpec(firstCard, BAND_VARIANTS[0] ?? { x0: 0.01, x1: 0.83, y0: 0.025, y1: 0.11, treatment: "contrast" }))),
      // Pass 18: the published bottom thumbnail is the AIMED strip —
      // the window the bottom read will actually OCR (see
      // aimBottomSpec in ocr.ts), so the panel shows the line the
      // scanner aimed at, not the fixed-fraction window it replaced.
      bottomBandUrl: bandThumb(buildBandCanvas(firstCard, aimBottomSpec(firstCard, BOTTOM_BAND))),
    }));
    pubDebug(tracker.recordStage(attempt, "capture", opts.timings?.captureMs ?? 0));
    pubDebug(tracker.recordStage(attempt, "detect", opts.timings?.detectMs ?? 0));
    // PASS 31: publish the burst's per-frame title-zone sharpness —
    // the focus audit's trace on every panel, so a soft capture is
    // diagnosable from the screenshot (and the retained frame's
    // sharpness stands next to its burst-mates').
    {
      const scores = preps.map((p) => p.titleSharpness ?? 0);
      const dropNote = retainedSharpnessDropRef.current;
      // PASS 32: the focus gate's re-capture note (when it fired)
      // and the AF-state line ride the same field — every panel
      // states what the camera reported about focus, or that the
      // browser exposes nothing (Item 2b).
      const gateNote = focusGateNoteRef.current;
      const afLine = currentAfStateLine();
      if (scores.some((s) => s > 0) || dropNote || gateNote) {
        const si = sharpestIndex(scores);
        const line = scores.some((s) => s > 0)
          ? `frame sharpness: ${scores.map((s) => s.toFixed(1)).join(" · ")} (sharpest #${si + 1}${preps[0]?.rectOrigin === "retained-frame" ? "; frame 1 is the retained viewfinder frame" : ""})`
          : "";
        pubDebug(tracker.publish(attempt, { sharpness: [line, dropNote, gateNote, afLine].filter(Boolean).join(" · ") }));
      } else if (afLine) {
        pubDebug(tracker.publish(attempt, { sharpness: afLine }));
      }
    }
    // IMAGE CHANNEL (rework) — starts NOW and runs concurrently with
    // the OCR reads below; consulted at settlement by the fusion
    // engine. Its dewarped thumbnail is published as soon as it
    // exists so even a hung attempt shows what the engine saw.
    let imageResult: ImageChannelResult | null = null;
    let imageDone = false;
    let imagePresentCandidate: RankedCandidate | null = null;
    let fusionConsulted = false;
    let numberNoiseNote = "";
    const imagePromise: Promise<ImageChannelResult | null> = (async () => {
      try {
        // PASS 25: the channel reads the attempt's captured bottom
        // evidence LAZILY (at its reference phase, seconds in — the
        // frame loop has pooled the bottom reads by then) to select
        // which printings get fingerprinted (see runImageChannel).
        return await runImageChannel(preps, () => {
          const ev = attemptEvidenceRef.current;
          return ev && ev.attempt === attempt
            ? { sources: ev.sources, bottomText: ev.bottomText }
            : { sources: [], bottomText: "" };
        });
      } catch { return null; }
    })();
    // PASS 21 (P4): the straightened thumbnail is published
    // SYNCHRONOUSLY, from the same local dewarp the channel will
    // use — it must not depend on the channel ever reporting. The
    // Cadet panel carried no thumbnail and no image line because
    // both were published only inside the channel's completion
    // handler, which a settled attempt discards.
    try {
      pubDebug(tracker.publish(attempt, { dewarpedUrl: dewarpPreparedCard(firstCard).toDataURL("image/jpeg", 0.7) }));
    } catch { /* diagnostics only */ }
    // PASS 33: the FULL captured frame, with the read rect outlined,
    // rides every attempt — the dewarp above is only the crop of
    // whatever rect was used, and a fallback rect that clips the
    // card made a past panel show a partial card as if it were the
    // whole capture (P1). The frame shows the card as captured and
    // exactly which part of it was read.
    try {
      const frameUrl = buildScanPreview(preps[0]!);
      if (frameUrl) pubDebug(tracker.publish(attempt, { frameUrl }));
    } catch { /* diagnostics only */ }
    void imagePromise.then((r) => {
      imageResult = r;
      imageDone = true;
      if (r) {
        // PASS 21 (Item C): a completed channel result is recorded
        // for the watchdog (keyed by attempt) and buys the attempt
        // its settlement grace shield — from this moment the
        // attempt must never afterwards die by watchdog while its
        // bounded settlement completes.
        imageCompletedRef.current = { attempt, atEpochMs: Date.now() };
        const graceUntil = Date.now() + IMAGE_SETTLE_GRACE_MS;
        if (!imageShieldRef.current || imageShieldRef.current.attempt !== attempt || imageShieldRef.current.untilEpochMs < graceUntil) {
          imageShieldRef.current = { attempt, untilEpochMs: graceUntil };
        }
      }
      if (r && guard.isActive(attempt)) {
        pubDebug(tracker.publish(attempt, {
          dewarpedUrl: r.dewarpedUrl,
          // Pass 20: the channel's actual stage outcome — never the
          // collapsed "nothing usable" line.
          image: describeImageChannelOutcome(r, r.ranked, null),
        }));
      }
    });
    // Set when the bottom read was skipped by the noise pre-check (or
    // abandoned after an earlier timeout): the stage line then shows
    // the note instead of a misleading millisecond figure.
    let bottomNote = "";
    // AUTO LIGHT (Pass 17) — meter the first frame's title zone and
    // bottom strip on the actual crop (see autolight.ts). DIM bands
    // get exposure-lifted variants pooled as additional reads under
    // the same caps; a CRUSHED title zone skips every title read
    // (bottom evidence still runs) and settles as tooDark; BRIGHT
    // bands change nothing at all. Off mode disables the whole layer.
    // PASS 22 — the mode resolves the lift per band (liftForMode):
    // Auto keeps the Pass 17 metering gate (bright → NO lift, the
    // good-light path unchanged; dim → the metered gain; crushed →
    // no lift + the too-dark floor); Manual applies the user's chosen
    // gain deterministically, whatever the meter says, and overrides
    // the crush skip (the user explicitly asked for light — the
    // lifted reads run and the matcher judges what they produce);
    // Off disables the layer. PASS 30 — On is an override like
    // Manual, at the cap: lift ×4 on every band, crush skip
    // overridden, torch + exposure compensation forced at max
    // (before Pass 30, On only forced the torch and metered its
    // lift exactly like Auto — in the first real-dark session it
    // changed nothing in the read path). Metering still runs in
    // every non-Off mode — in box/calibration mode too, on the crop
    // actually read — because the panel line must state the verdict
    // either way.
    const lightModeNow = lightModeRef.current;
    const manualGain = manualGainRef.current;
    const autoOn = lightModeNow !== "off";
    const titleMeter: BandMeter | null = autoOn ? meterBand(firstCard, TITLE_ZONE) : null;
    const bottomMeter: BandMeter | null = autoOn ? meterBand(firstCard, BOTTOM_ZONE) : null;
    // PASS 23 (Item B): the degraded-capture flag for fusion — the
    // FULL card's metering class (the image channel's population),
    // computed regardless of Light mode: it describes the photo,
    // not the treatment. A dim/crushed capture is where the matrix
    // found decisive-tier impostors (dim × blur); fusion applies
    // the degraded guard only there.
    const cardMeter: BandMeter | null = meterBand(firstCard, { x0: 0, y0: 0, x1: 1, y1: 1 });
    const captureDim = cardMeter != null && cardMeter.cls !== "bright";
    // Pass 30: On joins Manual in overriding the crush skip — both
    // are the user explicitly demanding light; the lifted reads run
    // and the matcher judges what they produce.
    const titleCrushed = lightModeNow !== "manual" && lightModeNow !== "on" && titleMeter?.cls === "crushed";
    const stdBandSpec: (typeof BAND_VARIANTS)[number] = BAND_VARIANTS[0] ?? { x0: 0.01, x1: 0.83, y0: 0.025, y1: 0.11, treatment: "contrast" };
    const titleLift = liftForMode(lightModeNow, titleMeter, manualGain);
    const bottomLift = liftForMode(lightModeNow, bottomMeter, manualGain);
    const titleLiftSpec = liftSpecWithGain(stdBandSpec, titleLift, "lifted");
    const bottomLiftSpec = liftSpecWithGain(BOTTOM_BAND, bottomLift, "bottom+lift");
    let liftedTitleReads = 0;
    let liftedBottomReads = 0;
    {
      const parts: string[] = [];
      // The verdict line (Pass 22, Item 3d): every attempt that
      // metered states its light decision — "light good — no lift",
      // "zone dark — lifted ×N", "manual light ×N", or the crushed
      // floor — so a screenshot shows the decision, not just a gain.
      const verdict = lightVerdictLine(lightModeNow, titleMeter, titleLift);
      if (verdict) parts.push(verdict);
      if (!titleCrushed && autoLightHwRef.current) parts.push(autoLightHwRef.current);
      if (parts.length > 0) pubDebug(tracker.publish(attempt, { autoLight: parts.join(" · ") }));
      if (titleCrushed) pubDebug(tracker.recordStageNote(attempt, "title", "title skipped (too dark)"));
      // STEADY LIGHT (Pass 24a): the attempt's hardware-light
      // decision is made ONCE, here, from this attempt's metering of
      // the pre-capture frames, and LATCHED until finish() — preview
      // metering steps are no-ops while the latch is held, so the
      // light cannot change mid-attempt (the pre-24a heartbeat: this
      // call plus the ~800ms preview ticks toggled torch/exposure
      // against a single threshold on a self-referential meter).
      // At most one application happens, at this point.
      if (titleMeter && lightModeNow === "auto") {
        const step = beginAttemptLight(lightLatchRef.current, titleMeter.stats.p90, performance.now());
        lightLatchRef.current = step.state;
        applyLightAction(step.action);
      }
    }
    // BLOWN-BAND GUARD (Pass 23 Item C): set when a title band was
    // classified bleached pre-OCR. If the attempt ends with NO title
    // text at all, the title stage line names the bleach ("title
    // skipped (band bleached — no text)") instead of a fake read
    // time — the same honesty the bottom stage note already has.
    let titleBleachedSeen = false;
    const finish = (o: IdentifyOutcome): IdentifyOutcome => {
      // The attempt is COMPLETE the moment its outcome exists — settle
      // it BEFORE anything else can await, so a timeout belonging to
      // this attempt can never fire afterwards (scanflow rule A).
      guard.settle(attempt);
      // Pass 24a: release the light latch with the attempt (the
      // abortOutcome paths that bypass finish are covered by the
      // callers' finally blocks; ending twice is a no-op).
      lightLatchRef.current = endAttemptLight(lightLatchRef.current);
      if (titleBleachedSeen && titleReads.length === 0) {
        pubDebug(tracker.recordStageNote(attempt, "title", `title skipped (${BLEACHED_BAND_REASON})`));
      } else {
        pubDebug(tracker.recordStage(attempt, "title", titleMs));
      }
      if (!bottomNote) pubDebug(tracker.recordStage(attempt, "bottom", bottomMs));
      pubDebug(tracker.recordStage(attempt, "match", matchMs));
      // PASS 21 (P4): the panel's image line must exist on EVERY
      // outcome — if the channel never reported before settlement,
      // the line says exactly that instead of vanishing.
      const snap = tracker.publish(attempt, { evidence, pooledRead, image: ensureImageLine(tracker.snapshot().image) });
      if (snap) {
        setScanDebug(snap);
        setRawRead(snap.pooledRead);
      }
      return o;
    };

    const titleReads: string[] = [];
    const bottomTexts: string[] = [];
    /** Every bottom read of the burst, tagged by treatment — the raw
     * material for the Pass 8 number rescue's candidate pool. */
    const bottomSources: { text: string; verify: boolean }[] = [];
    /** Set when the rescue built at least one (set, number) candidate
     * — gates the printings salvage on rescue-band title wins. */
    let numberCandidatesSeen = false;
    /** Memo for pooledMatches (see its comment). */
    let pooledMemo: { sig: string; matches: MatchResult[] } | null = null;
    const triedNumbers = new Set<string>();
    /** Mirror the captured bottom evidence into the watchdog-visible
     * ref as it lands (Pass 9): if this attempt hangs anywhere, the
     * watchdog rescue runs on exactly this text — no new OCR. */
    const publishEvidence = (): void => {
      attemptEvidenceRef.current = {
        attempt,
        sources: [...bottomSources],
        bottomText: bottomTexts.join(" "),
      };
    };
    let anyBottomHit = false;
    let lastBottomHit: BottomLineHit | null = null;
    // Once a bottom read overruns its cap in this attempt, no further
    // bottom reads are attempted in it (scanflow rule B): the pipeline
    // proceeds title-only instead of stacking capped reads per frame.
    let bottomAbandoned = false;
    // A (set, number) pair is only ever LOOKED UP after VERIFICATION by
    // a second treatment of the same bottom strip: the two parses must
    // agree on the collector NUMBER, and on the set code exactly or
    // within one letter (R→Q-class confusions). They must never merely
    // "look plausible": thresholding once merged Dawnhart Mentor's 179
    // into 129 — a REAL different card on Scryfall — while the contrast
    // read had 179 right; number disagreement blocks the pair outright.

    const pooledMatches = (): MatchResult[] => {
      if (!index || index.length === 0) return [];
      const lines = titleReads.flatMap((t) => t.split(/\r?\n/)).map((s) => s.trim()).filter(Boolean);
      if (lines.length === 0) return [];
      // Memoised on the pooled-read signature: the pipeline asks for
      // the pool after every frame AND again when judging the
      // exhausted pool, and a full-index fuzzy pass over garbage
      // candidates is the single most expensive thing the matcher
      // does (the user's Elemental Mascot scan showed match 7.3s,
      // most of it re-scoring an unchanged pool). An unchanged pool
      // is answered from the memo at ~0ms; only NEW reads re-score.
      const sig = lines.join("\n");
      if (pooledMemo && pooledMemo.sig === sig) return pooledMemo.matches;
      tracker.beginStage(attempt, "match");
      const t0 = performance.now();
      // MATCH UNDER THE DEADLINE (Pass 15): the fuzzy pass is budgeted
      // by the attempt clock's remaining time and returns best-so-far
      // (the exact-containment fast path inside runs first and is not
      // subject to the budget — an exact-name read can never be
      // timed out). Before this, the match stage was the one stage
      // NOT under the deadline: the user's Bolrac-Clan Basher attempt
      // showed "match 8.1s · hung during: match" and died by watchdog
      // while its raw read contained the exact card name.
      const out = matchNamesPooled(ocrCandidates(lines), index, 3, { budgetMs: Math.max(0, clock.remaining()) });
      matchMs += performance.now() - t0;
      pubDebug(tracker.recordStage(attempt, "match", matchMs));
      pooledMemo = { sig, matches: out };
      return out;
    };

    /**
     * Bottom-evidence SALVAGE for a title-matched card: the strict
     * (set, number) verification may have failed on a bottom line that
     * was still READ (the Griffin case: "Q0/280 C M20 LN CHRISTOPHER
     * MOELLER" — set code, artist and a one-digit-off number all point
     * at M20 #20 while the default printing is DMU #18). Score the
     * pooled bottom text against the card's printings; a clear win
     * SELECTS that printing, an ambiguous-but-contradicting set code
     * becomes a visible hint, and anything weaker keeps the honest
     * name-only note. Costs one cached printings fetch, only on a
     * title win.
     */
    const applySalvage = async (base: CardT): Promise<{ card: CardT; info: VersionInfo; salvaged: boolean }> => {
      tracker.beginStage(attempt, "match");
      const foilDetected: boolean | null =
        lastBottomHit?.separator === "star" ? true : lastBottomHit?.separator === "bullet" ? false : null;
      const rawBottom = bottomTexts.join(" ");
      if (!rawBottom.trim() || !base.printsSearchUri) {
        return { card: base, info: NAME_ONLY_INFO, salvaged: false };
      }
      let printings: CardT[] = [];
      try {
        // Raced: a stalled printings fetch must not hold settlement
        // open past the attempt's deadline discipline (Pass 9) — a
        // timeout just keeps the default printing.
        const raced = await raceWithCap(api.getPrintings({ printsSearchUri: base.printsSearchUri }), 1500);
        if (raced.status === "ok") printings = raced.value.printings;
      } catch { /* keep the default printing */ }
      if (printings.length <= 1) return { card: base, info: NAME_ONLY_INFO, salvaged: false };
      const win = salvagePrintingFromBottom(rawBottom, printings);
      if (win) {
        const p = win.printing;
        return {
          card: p,
          info: {
            status: "detected",
            message: `Version matched from the bottom line: ${p.setName} #${p.collectorNumber} — the bottom strip's set code, number and artist agree with this printing even though the number line itself was partly garbled.`,
            foilDetected,
          },
          salvaged: true,
        };
      }
      const hint = bottomSetCodeHint(rawBottom, printings, base.setCode);
      if (hint) {
        return {
          card: base,
          info: {
            status: "unconfirmed",
            message: `Matched by name — showing ${base.setName} (${base.setCode.toUpperCase()}) #${base.collectorNumber}. Your card's bottom line reads ${hint} — tap “Change version” if that's not ${base.setCode.toUpperCase()}.`,
            foilDetected,
          },
          salvaged: false,
        };
      }
      return { card: base, info: NAME_ONLY_INFO, salvaged: false };
    };

    const resolveByName = async (full: string): Promise<CardT | null> => {
      tracker.beginStage(attempt, "match");
      // Raced like every other step of settlement (Pass 9): a stalled
      // name lookup degrades to "not resolved" instead of holding the
      // attempt open.
      const raced = await raceWithCap(
        api.getCardByName({ name: full }).then((r) => r.card).catch(() => null),
        1500,
      );
      return raced.status === "ok" ? raced.value : null;
    };

    /**
     * PASS 25 (Item 2b) — the exact collector number's say on a
     * NAME-LEVEL settle. Runs the shared rescue over the attempt's
     * captured bottom sources (fresh tried-set: lookups are
     * server-cached, and Settlement 2's own adjudication must keep
     * its untried view for the fallthrough path) and classifies the
     * result with numberPinDecision:
     *  - "pin": a hit naming the settled card — record ITS printing.
     *  - "fallthrough": a VERIFIED hit naming a different card —
     *    the caller abandons its early settle; Settlement 2 + the
     *    interlock/conflict machinery adjudicate (Pass 23/24c).
     *  - "ignore": no hit, or unverified foreign noise.
     * Costs nothing when the attempt captured no bottom text.
     */
    const pinByNumber = async (
      settledName: string,
    ): Promise<{ decision: NumberPinDecision; card: CardT | null; foilDetected: boolean | null }> => {
      if (bottomSources.length === 0) return { decision: "ignore", card: null, foilDetected: null };
      tracker.beginStage(attempt, "match");
      const t0 = performance.now();
      const rescue = await rescueByCollectorNumber(bottomSources, lookupSetNumber, {
        maxCandidates: 4,
        artistText: bottomTexts.join(" "),
      });
      matchMs += performance.now() - t0;
      pubDebug(tracker.recordStage(attempt, "match", matchMs));
      if (rescue.candidatesSeen > 0) numberCandidatesSeen = true;
      const chosen = rescue.chosen;
      const decision = numberPinDecision(
        chosen ? { cardName: chosen.card.name, verified: chosen.verified } : null,
        settledName,
      );
      if (decision !== "pin" || !chosen) return { decision, card: null, foilDetected: null };
      const foilDetected: boolean | null =
        chosen.hit.separator === "star" ? true : chosen.hit.separator === "bullet" ? false : null;
      return { decision, card: chosen.card, foilDetected };
    };

    /**
     * PASS 27 (Item 2a) — the TALL-CROP bottom retry. When a settle
     * is about to record a printing WITHOUT number evidence and the
     * card is a basic land or a full-art/borderless printing, the
     * collector line may sit BELOW the standard crop entirely
     * (rect under-measurement pushes it out; Andrew's FRA Swamp
     * panel showed the line under the crop, unreadable by any
     * aiming of the standard window). One retry read runs on a
     * re-crop of the SAME frame with the rect extended 12%
     * downward — no aspect re-correction, so the true card fills
     * the top ~89% — through the tall window (BOTTOM_BAND_TALL).
     * Any text it captures joins the attempt's bottom sources and
     * pinByNumber judges again: a captured (set, number) pins the
     * printing exactly, ending the full-art ambiguity with printed
     * evidence instead of hash distance. Bounded by the attempt
     * clock like every other read; costs nothing when the card
     * doesn't qualify, the frame/rect is unavailable, or the
     * standard reads already pinned.
     */
    const extendedBottomPin = async (
      settledName: string,
      base: CardT,
    ): Promise<{ decision: NumberPinDecision; card: CardT | null; foilDetected: boolean | null }> => {
      const ignore: { decision: NumberPinDecision; card: CardT | null; foilDetected: boolean | null } = {
        decision: "ignore",
        card: null,
        foilDetected: null,
      };
      const qualifies = base.fullArt === true || base.borderColor === "borderless" || base.typeLine.includes("Basic");
      const prep0 = preps[0];
      if (!qualifies || !prep0?.rect || !prep0.frame) return ignore;
      if (clock.remaining() <= 400) return ignore;
      const rect = prep0.rect;
      const tallRect: CardRect = {
        x0: rect.x0,
        y0: rect.y0,
        x1: rect.x1,
        y1: Math.min(1, rect.y1 + (rect.y1 - rect.y0) * 0.12),
      };
      if (tallRect.y1 - rect.y1 < 0.01) return ignore; // already at the frame's bottom edge
      let tallCanvas: HTMLCanvasElement;
      try {
        tallCanvas = cropToRect(prep0.frame, tallRect);
      } catch {
        return ignore;
      }
      tracker.beginStage(attempt, "bottom");
      const br = await ocrBottomBandCapped(
        tallCanvas,
        BOTTOM_BAND_TALL,
        Math.min(BOTTOM_READ_CAP_MS, clock.remaining()),
        ocrGen,
      );
      if (aborted()) return ignore;
      if (!br.skipped && !br.timedOut) bottomMs += br.ms;
      const text = br.skipped || br.timedOut ? "" : br.text.replace(/\s+/g, " ").trim();
      if (!text) return ignore;
      bottomTexts.push(text);
      bottomSources.push({ text, verify: false });
      publishEvidence();
      pubDebug(tracker.recordStage(attempt, "bottom", bottomMs));
      return pinByNumber(settledName);
    };

    /**
     * Settle the attempt on a DECISIVE pooled title match: resolve the
     * card, give the pooled bottom line its salvage say, and finish.
     * Returns the finished outcome, the abort outcome when the attempt
     * was superseded mid-flight, or null when the name didn't resolve
     * (the caller then falls through to the number rescue / judgement).
     * Shared by the per-frame check and deadline settlement, which run
     * the exact same decision.
     */
    const finishTitleWin = async (top: MatchResult, evidenceLabel: string): Promise<IdentifyOutcome | null> => {
      // CONFLICT INTERLOCK (rework): if the image channel has ALREADY
      // landed decisively on a DIFFERENT card, this title win must
      // not settle — fall through to settlement, where the fusion
      // engine surfaces both names instead of auto-adding either.
      if (imageDone && imageResult && imageResult.ranked.length > 0) {
        const gate = imageGateState(imageResult.ranked);
        if (gate.decisive && gate.top && gate.top.name !== top.entry.full) return null;
      }
      onOptimisticName?.(top.entry.full);
      const base = await resolveByName(top.entry.full);
      if (aborted()) return abortOutcome;
      if (!base) return null;
      // PASS 25 (Item 2b): before the fuzzy salvage gets its say,
      // the EXACT collector number — the one channel that pins a
      // printing with certainty — is consulted on the bottom
      // evidence this attempt already captured. It never ran on
      // this path before: a title win settled first, so a readable
      // (set, number) that failed the frame loop's two-treatment
      // verification recorded the default printing instead of the
      // printed one (the Swamp MDD-296 mechanism).
      let pin = await pinByNumber(top.entry.full);
      if (aborted()) return abortOutcome;
      // PASS 27 (Item 2a): no number evidence and the card is a
      // basic / full-art printing — one tall-crop retry read before
      // the name-only settle records an unpinned printing.
      if (pin.decision === "ignore") {
        pin = await extendedBottomPin(top.entry.full, base);
        if (aborted()) return abortOutcome;
      }
      if (pin.decision === "fallthrough") return null;
      if (pin.decision === "pin" && pin.card) {
        evidence = "title + collector number (printing pinned)";
        return finish({
          kind: "confident",
          card: pin.card,
          info: {
            status: "detected",
            message: `Matched by name, and the collector number printed on the card pins the exact printing: ${pin.card.setName} #${pin.card.collectorNumber}.`,
            foilDetected: pin.foilDetected,
          },
          path: "device",
          evidence: "title",
        });
      }
      const salv = await applySalvage(base);
      if (aborted()) return abortOutcome;
      evidence = salv.salvaged ? "bottom line (salvage)" : evidenceLabel;
      return finish({ kind: "confident", card: salv.card, info: salv.info, path: "device", evidence: "title" });
    };

    // Pass 26: the frame loop's last pooled-decisiveness verdict,
    // hoisted so the completing treatment below can reuse it instead
    // of re-scoring the whole index (a full pooledMatches() call is
    // the most expensive step in the attempt; re-running it just to
    // ask "decisive yet?" ate the read's clock on loaded machines).
    let poolDecisive = false;

    for (let i = 0; i < preps.length; i++) {
      const cardCanvas = preps[i]?.card;
      if (!cardCanvas) continue;
      // --- title read: ONE band variant, with ocrBand's standard
      // PSM 7 → PSM 6 rescue pool. The rescue is not optional garnish:
      // PSM 7 alone returns "Tr"/"" on bands PSM 6 reads perfectly
      // (Dawnhart Mentor, Spider Spawning — the black frame edge inside
      // the band breaks single-line segmentation), so a "fast" PSM 7-only
      // read was measured WORSE, not faster, on the failing cards. ---
      // CRUSHED title zone (Pass 17 honest floor): no title read is
      // attempted at all — at that level the lifted reads manufacture
      // confident garbage (measured, probe-lift.ts), so the attempt
      // runs on bottom evidence alone and settles tooDark if that
      // fails too. The stage note was already recorded at metering.
      if (!titleCrushed) {
        tracker.beginStage(attempt, "title");
        // DEADLINE-CAPPED (Pass 9): the read is raced at ~900ms AND at
        // the attempt clock's remaining time. A variant job spinning on
        // the shared worker is abandoned as no-evidence (its worker is
        // swapped silently by ocrTitleBandCapped); once the clock is
        // exhausted the read is SKIPPED and the loop breaks straight to
        // settlement with the evidence already pooled — a hung variant
        // can never again hold the attempt open past its deadline.
        const trw = await cappedRead(clock, TITLE_READ_CAP_MS, () =>
          ocrTitleBandCapped(cardCanvas, stdBandSpec, { gen: ocrGen }),
        );
        if (aborted()) return abortOutcome;
        if (trw.skipped) break;
        titleMs += trw.ms;
        if (trw.value?.bleached) titleBleachedSeen = true;
        if (trw.value && trw.value.text) {
          titleReads.push(trw.value.text);
          // The raw read is published the moment this OCR returns.
          pooledRead = [titleReads.join(" · "), bottomTexts.length ? `bottom: ${bottomTexts[bottomTexts.length - 1]}` : ""].filter(Boolean).join("  |  ");
          pubDebug(tracker.publish(attempt, { pooledRead }));
        }
        // DIM title zone (Pass 17): pool the exposure-lifted standard
        // band from the first frame as an additional read under the
        // same cap — the raw read above stays in the pool untouched.
        // PASS 22 (Item 3): a SECOND lifted window joins it — the
        // standard-low band (y 4–12.5%). Pass 18's forensics showed
        // title fragmentation is window-sensitive (the variants read
        // the full name on crops where the standard window returned
        // fragments), yet the lift was applied to the standard window
        // only, so a dark attempt whose title sat low in the window
        // got a brighter version of the wrong slice. Both lifted
        // windows pool from frame 1 under the same caps; bright
        // attempts generate neither (titleLiftSpec is null there).
        if (i === 0 && titleLiftSpec) {
          const lowSpec = BAND_VARIANTS[2];
          const liftSpecs = lowSpec && titleLift !== null
            ? [titleLiftSpec, liftSpecWithGain(lowSpec, titleLift, "lifted-low")].filter((s) => s !== null)
            : [titleLiftSpec];
          for (const spec of liftSpecs) {
            const lw = await cappedRead(clock, TITLE_READ_CAP_MS, () =>
              ocrTitleBandCapped(cardCanvas, spec, { gen: ocrGen }),
            );
            if (aborted()) return abortOutcome;
            if (lw.skipped) break;
            titleMs += lw.ms;
            liftedTitleReads += 1;
            if (lw.value?.bleached) titleBleachedSeen = true;
            if (lw.value && lw.value.text) {
              titleReads.push(lw.value.text);
              pooledRead = [titleReads.join(" · "), bottomTexts.length ? `bottom: ${bottomTexts[bottomTexts.length - 1]}` : ""].filter(Boolean).join("  |  ");
              pubDebug(tracker.publish(attempt, { pooledRead }));
            }
          }
        }
        pubDebug(tracker.recordStage(attempt, "title", titleMs));
      }
      // --- bottom-line read + verification → candidate (set, number)s ---
      // The bottom read is ISOLATED (scanflow rule B): noise pre-check
      // first (speckle/blank bands never reach OCR), then a ~1.2s hard
      // cap after which it is abandoned as "no evidence" and the
      // pipeline proceeds with title-only evidence. It can never
      // block, delay (beyond the cap), or outlive the match.
      let numberCard: { card: CardT; hit: BottomLineHit } | null = null;
      tracker.beginStage(attempt, "bottom");
      if (bottomAbandoned) {
        bottomNote = bottomSkipStageNote("abandoned after timeout");
        pubDebug(tracker.recordStageNote(attempt, "bottom", bottomNote));
      }
      try {
        const br = bottomAbandoned
          ? { text: "", ms: 0, skipped: true, timedOut: false, reason: "abandoned after timeout" }
          : clock.remaining() <= 50
            // The attempt deadline is spent: no bottom read this frame
            // (the pooled title check below still runs on the title
            // read that just landed, and settlement judges the pool).
            ? { text: "", ms: 0, skipped: true, timedOut: false, reason: "deadline" }
            : await ocrBottomBandCapped(cardCanvas, BOTTOM_BAND, Math.min(BOTTOM_READ_CAP_MS, clock.remaining()), ocrGen);
        if (aborted()) return abortOutcome;
        if (br.skipped && br.reason !== "deadline") {
          bottomNote = bottomSkipStageNote(br.reason);
          pubDebug(tracker.recordStageNote(attempt, "bottom", bottomNote));
        } else if (br.timedOut) {
          bottomAbandoned = true;
          bottomMs += br.ms;
        }
        const brText = br.skipped || br.timedOut ? "" : br.text;
        bottomMs += br.skipped || br.timedOut ? 0 : br.ms;
        if (brText.trim()) bottomTexts.push(brText.replace(/\s+/g, " ").trim());
        if (brText.trim()) bottomSources.push({ text: brText, verify: false });
        if (brText.trim()) publishEvidence();
        const hit = brText ? parseBottomLine(brText) : null;
        if (hit) lastBottomHit = hit;
        if (brText.trim()) {
          pooledRead = [titleReads.join(" · "), `bottom: ${brText.replace(/\s+/g, " ").trim()}`].filter(Boolean).join("  |  ");
          pubDebug(tracker.publish(attempt, { pooledRead }));
        }
        if (hit) {
          anyBottomHit = true;
          if (hit.setCode) {
            const candidates: BottomLineHit[] = [];
            try {
              const vr = clock.remaining() <= 100
                ? { text: "", ms: 0, skipped: true, timedOut: false, reason: "deadline" }
                : await ocrBottomBandCapped(cardCanvas, BOTTOM_BAND_CONTRAST, Math.min(BOTTOM_READ_CAP_MS, clock.remaining()), ocrGen);
              if (aborted()) return abortOutcome;
              if (vr.timedOut) bottomAbandoned = true;
              if (!vr.skipped && !vr.timedOut) {
                bottomMs += vr.ms;
                if (vr.text.trim()) bottomSources.push({ text: vr.text, verify: true });
                if (vr.text.trim()) publishEvidence();
                const vhit = parseBottomLine(vr.text);
                if (vhit?.setCode) {
                  if (vhit.setCode === hit.setCode && vhit.collectorNumber === hit.collectorNumber) {
                    candidates.push(hit);
                  } else if (vhit.collectorNumber === hit.collectorNumber && setCodesNear(vhit.setCode, hit.setCode)) {
                    // Same number, code within one letter — try both codes.
                    candidates.push(hit, vhit);
                  }
                }
              }
            } catch { /* unverified — title pool decides */ }
            // --- 1. collector number: exact lookup, certain ID ---
            tracker.beginStage(attempt, "match");
            for (const cand of candidates) {
              if (!cand.setCode) continue;
              const key = `${cand.setCode}/${cand.collectorNumber}`;
              if (triedNumbers.has(key)) continue;
              triedNumbers.add(key);
              let card: CardT | null = await lookupSetNumber(cand.setCode, cand.collectorNumber);
              if (!card && cand.collectorNumberRaw !== cand.collectorNumber) {
                // Zero-padded printings (e.g. "0543") — try as printed.
                card = await lookupSetNumber(cand.setCode, cand.collectorNumberRaw);
              }
              if (card) {
                numberCard = { card, hit: cand };
                break;
              }
            }
          }
        }
      } catch { /* same */ }
      if (aborted()) return abortOutcome;
      // DIM bottom strip (Pass 17): pool an exposure-lifted bottom
      // read from the first frame into the rescue sources — the
      // standard read above keeps its verified-pair path; the lifted
      // text joins the candidate pool the settlement rescue scores.
      if (i === 0 && bottomLiftSpec && !bottomAbandoned && clock.remaining() > 50) {
        try {
          const lb = await ocrBottomBandCapped(cardCanvas, bottomLiftSpec, Math.min(BOTTOM_READ_CAP_MS, clock.remaining()), ocrGen);
          if (aborted()) return abortOutcome;
          if (!lb.skipped && !lb.timedOut) {
            bottomMs += lb.ms;
            liftedBottomReads += 1;
            if (lb.text.trim()) {
              bottomTexts.push(lb.text.replace(/\s+/g, " ").trim());
              bottomSources.push({ text: lb.text, verify: false });
              publishEvidence();
            }
          }
        } catch { /* bottom evidence is opportunistic */ }
      }
      pubDebug(tracker.recordStage(attempt, "bottom", bottomMs));
      if (!pooledRead) {
        pooledRead = titleReads.join(" · ");
        if (pooledRead) pubDebug(tracker.publish(attempt, { pooledRead }));
      }
      if (numberCard) {
        const { card, hit } = numberCard;
        const titleTop = pooledMatches()[0];
        const disagrees = titleTop && titleTop.score >= 0.8 && titleTop.entry.full !== card.name
          ? titleTop.entry.full
          : null;
        evidence = `collector number ${hit.setCode} ${hit.collectorNumber}`;
        onOptimisticName?.(card.name);
        const foilDetected: boolean | null = hit.separator === "star" ? true : hit.separator === "bullet" ? false : null;
        return finish({
          kind: "confident",
          card,
          info: {
            status: "detected",
            message: `Matched by collector number ${hit.setCode?.toUpperCase() ?? ""} ${hit.collectorNumber} — the exact printing printed on the card (${card.setName} #${card.collectorNumber}).${disagrees ? ` Note: the name strip read more like “${disagrees}”; the printed number wins, but double-check the card.` : ""}`,
            foilDetected,
          },
          path: "device",
          evidence: "number",
        });
      }

      // --- 2. pooled title evidence ---
      const matches = pooledMatches();
      const top = matches[0];
      if (top) {
        const decisive = rapid
          ? decideRapidMatch(matches) === "auto"
          : top.score >= 0.82;
        poolDecisive = decisive;
        if (decisive) {
          const done = await finishTitleWin(top, "title (pooled across frames)");
          if (done) return done;
        }
      }
      // Frames remain and nothing decisive yet → keep pooling.
    }

    // COMPLETING TREATMENT (Pass 26): the frame loop pooled only the
    // standard window's first treatment mix. When that pool is still
    // sub-decisive AND the clock has time left, the title stage has
    // not actually finished: run ONE more treatment of the title
    // zone — the TALL window read multi-line (PSM 6 line-pick), the
    // window Pass 8 built for exactly the reads the standard window
    // garbles — on the LAST burst frame, and pool it before anything
    // settles. The user's Eye of Jace panel is the shape: one sub-bar
    // read ('1 Eye ol lace To', 123ms of title stage) settled the
    // attempt while the clock still held seconds; a clean line from
    // the tall window enters the pool as its own read, where exact
    // containment (Pass 15) lets it win undiluted. The empty-read
    // shape counts too (the hand-held Swamp composite: every
    // single-line read of the displaced window returns "", the tall
    // window reads the name). Rapid pays this only on sub-bar pools;
    // a decisive pool never reaches here, an exhausted clock skips
    // it, and a bleached tall band returns at 0ms.
    if (!titleCrushed && index && index.length > 0) {
      if (!poolDecisive && clock.remaining() > 50) {
        // PASS 31: the completing read runs on the SHARPEST burst
        // frame, not blindly the last — on a focus-settling burst
        // (retained frame approved pre-settle, later frames still
        // converging) the last frame is not necessarily the clearest,
        // and this one read is the pool's best second chance.
        const sharpIdx = sharpestIndex(preps.map((p) => p.titleSharpness ?? 0));
        const lastCard = (sharpIdx >= 0 ? preps[sharpIdx]?.card : undefined) ?? preps[preps.length - 1]?.card;
        if (lastCard) {
          tracker.beginStage(attempt, "title");
          const cw = await cappedRead(clock, TITLE_READ_CAP_MS, () =>
            ocrTitleBandCapped(lastCard, TITLE_TALL_BAND, { multiLine: true, gen: ocrGen }),
          );
          if (aborted()) return abortOutcome;
          if (!cw.skipped && cw.value) {
            titleMs += cw.ms;
            if (cw.value.bleached) titleBleachedSeen = true;
            if (cw.value.text) {
              titleReads.push(cw.value.text);
              pooledRead = [titleReads.join(" · "), bottomTexts.length ? `bottom: ${bottomTexts[bottomTexts.length - 1]}` : ""].filter(Boolean).join("  |  ");
              pubDebug(tracker.publish(attempt, { pooledRead }));
            }
          }
          pubDebug(tracker.recordStage(attempt, "title", titleMs));
        }
      }
    }

    // --- SETTLEMENT (Pass 9): the frame loop ended — decisively,
    // out of frames, or because the reads deadline expired mid-loop.
    // The pool is judged with the BEST EVIDENCE AVAILABLE NOW, in the
    // deadline order: (1) a decisive pooled title match, (2) the
    // collector-number rescue, (3) Snap's rescue-band reads (only
    // while the widened clock still has time), (4) the exhausted-pool
    // judgement below. ---

    // SETTLEMENT 1 — pooled title, decisive check. The per-frame check
    // already ran this after every completed frame; it matters again
    // here for the deadline break, where the loop exited right after
    // a good title read landed but before its check could run.
    {
      const m = pooledMatches();
      const t = m[0];
      if (t && (rapid ? decideRapidMatch(m) === "auto" : t.score >= 0.82)) {
        const done = await finishTitleWin(t, "title (pooled across frames)");
        if (done) return done;
      }
    }

    // SETTLEMENT 2 / RESCUE 1 — collector number, ALL plausible
    // candidates (Pass 8, now the shared scanflow helper — the same
    // code the watchdog rescue runs on captured evidence). The
    // per-frame path only looks up pairs a second treatment VERIFIED,
    // and hand-held shots kept failing that gate (the contrast read
    // of a white-on-black strip in dim light garbles or noise-skips)
    // while the primary read was essentially perfect — and modern
    // frames print rarity + BARE number ("U 0227 SOS", "C 0185 SOS",
    // no "/NNN"), which the denominator-era flow discarded. Every
    // candidate from every bottom read is tried in corroboration
    // order; a 404 discards the candidate and the next is tried. Runs
    // BEFORE the printings salvage and the band rescue, so a number
    // hit short-circuits the match stage instead of ballooning it
    // (the Mascot scan's match stage hit 7.3s of salvage/printings
    // work while SOS 185 sat unused in its bottom read).
    // PASS 23 (Item B fix): a number hit whose title pool is NOT
    // itself decisive is HELD here instead of settling immediately,
    // and resolved after the image wait below through the
    // numberHitInterlock (fusion.ts): the matrix convicted bottom
    // lines at small/blurry sizes garbling into real foreign
    // (set, number) pairs and settling wrong while the image
    // channel held a decisive verdict for the true card. A
    // decisive title pool keeps the historical behaviour — the
    // printed number wins on the spot, with the disagreement note.
    let pendingNumberHit: { card: CardT; hit: BottomLineHit; foilDetected: boolean | null; verified: boolean } | null = null;
    {
      tracker.beginStage(attempt, "match");
      const lookupT0 = performance.now();
      const rescue = await rescueByCollectorNumber(bottomSources, lookupSetNumber, {
        tried: triedNumbers,
        artistText: bottomTexts.join(" "),
      });
      matchMs += performance.now() - lookupT0;
      pubDebug(tracker.recordStage(attempt, "match", matchMs));
      if (rescue.candidatesSeen > 0) numberCandidatesSeen = true;
      if (aborted()) return abortOutcome;
      const chosen = rescue.chosen;
      if (chosen) {
        const { card, hit } = chosen;
        const titleTop = pooledMatches()[0];
        const foilDetected: boolean | null = hit.separator === "star" ? true : hit.separator === "bullet" ? false : null;
        if (titleTop && titleTop.score >= 0.8) {
          const disagrees = titleTop.entry.full !== card.name ? titleTop.entry.full : null;
          evidence = `collector number ${hit.setCode} ${hit.collectorNumber}`;
          onOptimisticName?.(card.name);
          return finish({
            kind: "confident",
            card,
            info: {
              status: "detected",
              message: `Matched by collector number ${hit.setCode?.toUpperCase() ?? ""} ${hit.collectorNumber} — the exact printing printed on the card (${card.setName} #${card.collectorNumber}).${disagrees ? ` Note: the name strip read more like “${disagrees}”; the printed number wins, but double-check the card.` : ""}`,
              foilDetected,
            },
            path: "device",
            evidence: "number",
          });
        }
        pendingNumberHit = { card, hit, foilDetected, verified: chosen.verified };
      }
    }

    // IMAGE FUSION (rework Stage 2) — the primary channel's verdict,
    // consulted once the exact-number rescue has had its say (a
    // printed collector number is never overridden by image or
    // title). The channel has been running concurrently since the
    // attempt began.
    //
    // PASS 34 — the fusion consult, factored into a closure so it
    // can also run LATE (the second call sits just before the
    // pool-exhausted judgement). It judges the image channel's
    // ranked verdicts against the pooled OCR evidence and returns
    // a finished outcome when it settles the attempt; null means
    // “judged, nothing settled — carry on” (a present-tier candidate
    // is left in imagePresentCandidate for the judgement below).
    // Runs at most once per attempt: fusionConsulted is set on
    // entry, and the late call fires only when this one never ran
    // because the channel had not landed within its wait.
    const consultFusion = async (img: ImageChannelResult): Promise<IdentifyOutcome | null> => {
      fusionConsulted = true;
      const m = pooledMatches();
      const topM = m[0];
      // PASS 21 Item B source (iii): bottom-line consistency —
      // computed ONLY when the cheaper sources (title tokens,
      // matcher-top) haven't already corroborated the image
      // top-1: score the pooled bottom text against the
      // candidate's own printings with the existing salvage rule
      // (set + number + artist). A salvage win means the printed
      // line independently fits THIS card.
      let bottomConsistent = false;
      const imgTop = img.ranked[0];
      if (imgTop && bottomTexts.join(" ").trim()) {
        const pre = corroborationFor(imgTop.name, {
          pooledTexts: titleReads,
          ocrTopName: topM?.entry.full ?? null,
        });
        if (!pre.corroborated) {
          const baseForBottom = await resolveByName(imgTop.name);
          if (aborted()) return abortOutcome;
          if (baseForBottom?.printsSearchUri) {
            const pr = await raceWithCap(
              api.getPrintings({ printsSearchUri: baseForBottom.printsSearchUri }).then((r) => r.printings).catch(() => [] as CardT[]),
              1500,
            );
            if (aborted()) return abortOutcome;
            if (pr.status === "ok" && pr.value.length > 0) {
              bottomConsistent = salvagePrintingFromBottom(bottomTexts.join(" "), pr.value) != null;
            }
          }
        }
      }
      const outcome: FusionOutcome = fuseChannels({
        image: { ranked: img.ranked },
        ocr: {
          topName: topM?.entry.full ?? null,
          topScore: topM?.score ?? 0,
          decisive: topM ? (rapid ? decideRapidMatch(m) === "auto" : topM.score >= 0.82) : false,
          // PASS 24c: the title verdict's CLEAN-evidence state —
          // only a clean verdict may conflict with a decisive
          // image verdict; a fuzzy crown from garbage tokens is
          // noise (see lib.ts cleanNameVerdict).
          cleanDecisive: topM && index ? cleanNameVerdict(m, titleReads, index) : false,
          pooledTexts: titleReads,
          bottomConsistent,
        },
        rapid,
        captureDim,
      });
      pubDebug(tracker.publish(attempt, { image: describeImageChannel(img.ranked, outcome, { rapid, captureDim }) + (numberNoiseNote ? ` · ${numberNoiseNote}` : "") }));
      if (outcome.kind === "settle-image") {
        const cand = outcome.candidate;
        const base = await resolveByName(cand.name);
        if (aborted()) return abortOutcome;
        if (base) {
          onOptimisticName?.(cand.name);
          // PASS 25 (Item 2b): a same-name collector-number hit
          // from THIS attempt pins the printing over both the art
          // winner and the default — the artwork chose the NAME,
          // the printed number is exact printing evidence.
          // (Different-name hits were already adjudicated by
          // Settlement 2 + the interlock before fusion ran; only
          // the same-name pin is taken here.)
          let pin = await pinByNumber(cand.name);
          if (aborted()) return abortOutcome;
          // PASS 27 (Item 2a): same tall-crop retry on the image
          // settle — an artwork-chosen name for a basic/full-art
          // card gets its one lower read before any art pin or
          // default is recorded.
          if (pin.decision === "ignore") {
            pin = await extendedBottomPin(cand.name, base);
            if (aborted()) return abortOutcome;
          }
          if (pin.decision === "pin" && pin.card) {
            evidence = "image (art match) + collector number (printing pinned)";
            return finish({
              kind: "confident",
              card: pin.card,
              info: {
                status: "detected",
                message: `Matched by artwork (image distance ${cand.dist.combined}), and the collector number printed on the card pins the exact printing: ${pin.card.setName} #${pin.card.collectorNumber}.`,
                foilDetected: pin.foilDetected,
              },
              path: "device",
              evidence: "title",
            });
          }
          // PRINTING (rework rule d): the winning printing pins
          // the version by art when it clears its own margin over
          // the name's other printings; shared-art printings fall
          // back to the bottom-line salvage / default printing,
          // and the message says which happened.
          let settledCard: CardT = base;
          let settledInfo: VersionInfo = NAME_ONLY_INFO;
          let evLabel = `image (art match d=${cand.dist.combined}${outcome.corroborated ? " + title corroboration" : ""})`;
          // PASS 27 (Item 2c, honest demotion): a full-art winner
          // whose nearest full-art rival sits within the pin gap
          // must NOT pin — the fingerprint cannot tell the two
          // treatments apart at that distance (measured: true
          // winners lead by ≥10; the ambiguous pairs sit at 0–6).
          // The settle falls through to the number/salvage paths
          // and, failing those, records the name UNCONFIRMED with
          // both printings named — never a confident wrong set.
          const artPinBlocked = fullArtPinBlocked(cand);
          if (!artPinBlocked && cand.scryfallId && cand.scryfallId !== base.scryfallId && cand.printingMargin >= 4) {
            const byArt = await lookupSetNumber(cand.setCode, cand.collectorNumber);
            if (aborted()) return abortOutcome;
            if (byArt) {
              settledCard = byArt;
              settledInfo = {
                status: "detected",
                message: `Matched by artwork (image distance ${cand.dist.combined}) — the exact printing pinned by the art match: ${byArt.setName} #${byArt.collectorNumber}.`,
                foilDetected: null,
              };
              evLabel = "image (art match — printing pinned by art)";
            }
          }
          if (settledCard === base) {
            const salv = await applySalvage(base);
            if (aborted()) return abortOutcome;
            settledCard = salv.card;
            settledInfo = salv.salvaged
              ? salv.info
              : artPinBlocked && cand.fullArtRival
                ? {
                    status: "unconfirmed",
                    message: `Matched by artwork (image distance ${cand.dist.combined}) — but the full-art printings are too close to call: ${cand.setCode.toUpperCase()} #${cand.collectorNumber} (distance ${cand.dist.combined}) vs ${cand.fullArtRival.setCode.toUpperCase()} #${cand.fullArtRival.collectorNumber} (distance ${cand.fullArtRival.dist}). The version is recorded UNCONFIRMED rather than guessed — “Change version” or a readable bottom line pins it exactly.`,
                    foilDetected: null,
                  }
                : {
                    status: "unconfirmed",
                    message: `Matched by artwork (image distance ${cand.dist.combined}) — version not pinned: this card's printings share the same art, so the version shown is the default. The bottom line or “Change version” can pin it exactly.`,
                    foilDetected: null,
                  };
            if (salv.salvaged) evLabel = "image (art match) + bottom line (salvage)";
            else if (artPinBlocked) evLabel = "image (art match — full-art rival too close, printing unconfirmed)";
          }
          evidence = evLabel;
          return finish({ kind: "confident", card: settledCard, info: settledInfo, path: "device", evidence: "title" });
        }
      }
      if (outcome.kind === "conflict") {
        // Both channels decisive (and the title verdict CLEAN —
        // Pass 24c), different cards: NO auto-add in either
        // mode — the user picks, with the conflict named.
        evidence = conflictEvidenceLine(outcome.channel);
        const imgEntry = index?.find((e) => e.full === outcome.imageCandidate.name && e.faceIndex === 0)
          ?? index?.find((e) => e.full === outcome.imageCandidate.name);
        const merged: MatchResult[] = [];
        // Pass 23 display honesty: the image side of a conflict is
        // a DECISIVE candidate, so imageSuggestionScore gives it
        // the 0.90 the auto-add class carries — the user is being
        // asked to choose between two decisive claims, and the
        // number says exactly that.
        if (imgEntry) merged.push({ entry: imgEntry, score: imageSuggestionScore(outcome.imageCandidate) });
        for (const mm of m) {
          if (mm.entry.full !== outcome.imageCandidate.name) merged.push(mm);
        }
        return finish({ kind: "uncertain", matches: merged.slice(0, 5), path: "device" });
      }
      if (outcome.kind === "present-image") {
        // Not settleable (Rapid uncorroborated / margin short):
        // carried into the pool-exhausted judgement below as the
        // top suggestion.
        imagePresentCandidate = outcome.candidate;
      }
      // settle-ocr: the pooled title already won above (Settlement
      // 1) or wins in the judgement below — nothing to do here.
      // abstain: the image channel had nothing gated — the OCR
      // floor proceeds untouched.
      return null;
    };

    // PASS 20 WAIT — Pass 19 awaited the channel only with whatever
    // of the 4s rescue envelope remained (~1.5s by this point), while
    // the channel's own measured round trip is 5.5–8.0s: the wait
    // expired first on every attempt and fusion never saw a result.
    // Now the wait budget follows the OCR evidence (fusionWaitDeadlineMs):
    // a DECISIVE pool keeps the rescue envelope — the image channel
    // can only veto via the conflict interlock, and the happy path's
    // timing is unchanged — while an UNCERTAIN pool waits for the
    // primary channel up to IMAGE_WAIT_DEADLINE_MS. The wait is
    // registered in imageWaitRef so the 8s watchdog defers (once,
    // bounded) instead of tearing down a sanctioned wait.
    {
      if (!imageDone) {
        const mPre = pooledMatches();
        const topPre = mPre[0];
        const ocrDecisive = topPre
          ? (rapid ? decideRapidMatch(mPre) === "auto" : topPre.score >= 0.82)
          : false;
        clock.extendTo(fusionWaitBudgetMs(ocrDecisive, pendingNumberHit != null));
        if (!ocrDecisive) {
          imageWaitRef.current = {
            attempt,
            untilEpochMs: Date.now() + Math.max(0, clock.remaining()),
          };
        }
        const wait = await raceWithCap(imagePromise, Math.max(0, clock.remaining()));
        if (imageWaitRef.current?.attempt === attempt) imageWaitRef.current = null;
        if (wait.status === "ok") imageResult = wait.value;
        imageDone = true;
        if (wait.status !== "ok") {
          // PASS 21 (P4): the sanctioned wait expired with the
          // channel still silent — SAY SO on the panel now. If the
          // result still lands while the attempt is active, the
          // completion handler above replaces this line with the
          // real outcome; if it lands after settlement, finish()
          // keeps this line rather than none.
          pubDebug(tracker.publish(attempt, {
            image: `timed out — the image service gave no answer within the ${(fusionWaitBudgetMs(ocrDecisive, pendingNumberHit != null) / 1000).toFixed(0)}s wait; the title/number reads carried this scan`,
          }));
        }
      }
      // PASS 21 (Item C): shield the rest of this attempt's
      // envelope — fusion settlement plus the bounded rescue pass —
      // whether the channel was still pending above or had already
      // reported during the frame loop. The watchdog defers while
      // the shield is live, so a completed image result can never
      // be followed by a watchdog reset (the Chandra defect).
      imageShieldRef.current = {
        attempt,
        untilEpochMs: Date.now() + Math.max(0, clock.remaining()) + 2500,
      };
      if (aborted()) return abortOutcome;
      const img = imageResult;
      if (img && img.ranked.length === 0) {
        // The channel reported but produced nothing measurable:
        // publish its TRUE stage outcome (timeout / call failed /
        // 0 proposals / 0 verified) — the line Pass 19 collapsed.
        pubDebug(tracker.publish(attempt, { image: describeImageChannelOutcome(img, [], null) }));
      }
      // PASS 23 (Item B fix): resolve a HELD collector-number hit
      // now the image channel has had its bounded say. A decisive
      // image verdict naming a DIFFERENT card vetoes the hit into
      // a conflict (the garbled-foreign-pair class); anything else
      // — image absent, abstaining, band-tier, or agreeing — and
      // the printed number settles the exact printing, as before.
      //
      // PASS 24c: the veto is a VERDICT-level act, so it requires a
      // VERIFIED hit (second-treatment / multi-source confirmed —
      // rescueByCollectorNumber now reports it). The Massacre Girl
      // panel's hit was built from ONE garbled fragment ('J 021.
      // FRA' → FRA/21, a real but foreign pair): unverified, it is
      // NOISE — logged in diagnostics, dropped, and the decisive
      // image verdict settles through fusion below. An unverified
      // hit with NO decisive contradiction keeps settling exactly
      // as before (the rescue's floor behaviour is unchanged).
      if (pendingNumberHit) {
        const nh = pendingNumberHit;
        const imgRanked = img?.ranked ?? [];
        const interlockConflict = imgRanked.length > 0 && numberHitInterlock(nh.card.name, imgRanked) === "conflict";
        if (interlockConflict && nh.verified) {
          const imgTop = imgRanked[0]!;
          evidence = conflictEvidenceLine("number");
          const merged: MatchResult[] = [];
          const imgEntry = index?.find((e) => e.full === imgTop.name && e.faceIndex === 0)
            ?? index?.find((e) => e.full === imgTop.name);
          if (imgEntry) merged.push({ entry: imgEntry, score: imageSuggestionScore(imgTop) });
          const numEntry = index?.find((e) => e.full === nh.card.name && e.faceIndex === 0)
            ?? index?.find((e) => e.full === nh.card.name);
          if (numEntry) merged.push({ entry: numEntry, score: 0.9 });
          for (const mm of pooledMatches()) {
            if (mm.entry.full !== imgTop.name && mm.entry.full !== nh.card.name) merged.push(mm);
          }
          pubDebug(tracker.publish(attempt, {
            image: describeImageChannel(imgRanked, { kind: "conflict", imageCandidate: imgTop, ocrName: nh.card.name, channel: "number" }, { rapid }),
          }));
          return finish({ kind: "uncertain", matches: merged.slice(0, 5), path: "device" });
        }
        if (interlockConflict) {
          numberNoiseNote = `ignored unverified number fragment ${nh.hit.setCode ?? ""} ${nh.hit.collectorNumber} (would name “${nh.card.name}”) — one unconfirmed bottom read, not a verdict; the decisive artwork match stands`;
        } else {
          evidence = `collector number ${nh.hit.setCode} ${nh.hit.collectorNumber}`;
          onOptimisticName?.(nh.card.name);
          return finish({
            kind: "confident",
            card: nh.card,
            info: {
              status: "detected",
              message: `Matched by collector number ${nh.hit.setCode?.toUpperCase() ?? ""} ${nh.hit.collectorNumber} — the exact printing printed on the card (${nh.card.setName} #${nh.card.collectorNumber}).`,
              foilDetected: nh.foilDetected,
            },
            path: "device",
            evidence: "number",
          });
        }
      }
      if (img && img.ranked.length > 0) {
        const fo = await consultFusion(img);
        if (fo) return fo;
      }
    }

    // RESCUE 2 — title-band search window (Snap / Take Photo only;
    // Rapid keeps its exact behaviour and retries via the watcher).
    // A crushed title zone skips the whole title rescue (Pass 17):
    // there is no title signal to search for, and the pool judgement
    // below settles the attempt as tooDark on bottom evidence alone.
    // AUTO-RETRY: one silent rescue attempt with the offset and tall
    // bands before the failure panel can appear. The later burst
    // frames go first — they are the "next frames" a re-snap would
    // have used — then the first frame. Each read is matched on its
    // own first (so the winning band is known and named in the
    // diagnostics), then pooled with everything before. Bounded by
    // the attempt clock (Pass 9): the envelope widens to
    // ATTEMPT_RESCUE_DEADLINE_MS and every read is capped like the
    // frame loop's — once the clock is gone, the rescue stops and
    // the pool is judged as it stands, well under the watchdog.
    if (!rapid && index && index.length > 0 && !titleCrushed) {
      // PASS 31 — the rescue's budget is granted FRESH from now
      // (extendByFromNow), not widened to the absolute
      // ATTEMPT_RESCUE_DEADLINE_MS: this pass runs AFTER the image
      // fusion wait above, which legitimately consumed the whole
      // attempt clock on a timed-out channel (12s), so the old
      // extendTo left remaining ≈ 0 and every read below returned
      // "skipped" without starting — the exact starvation behind
      // the 211–339ms title stages of 2026-11-10 (Eye of Jace ×2,
      // Stingerquill Annex). The pass keeps its ~3.5s bound; it
      // just actually receives it.
      clock.extendByFromNow(RESCUE_AFTER_WAIT_BUDGET_MS);
      // PASS 31: rescue reads go SHARPEST frame first (was: later
      // frames, then frame 1) — a decisive read stops the pass, so
      // the clearest frame's treatments run before any soft frame
      // can spend the budget.
      const frameOrder = sharpnessOrder(preps.map((p) => p.titleSharpness ?? 0))
        .map((i) => preps[i])
        .filter((p): p is PreparedScan => p != null);
      let bandWin: { name: string; label: string } | null = null;
      rescueBands: for (const prep of frameOrder) {
        const card = prep?.card;
        if (!card) continue;
        for (const spec of TITLE_RESCUE_BANDS) {
          if (aborted()) return abortOutcome;
          tracker.beginStage(attempt, "title");
          const rw = await cappedRead(clock, TITLE_READ_CAP_MS, () =>
            ocrTitleBandCapped(card, spec, { multiLine: spec.label === "tall", gen: ocrGen }),
          );
          if (aborted()) return abortOutcome;
          if (rw.skipped) break rescueBands;
          titleMs += rw.ms;
          const read = rw.value;
          if (read && read.text.trim()) {
            titleReads.push(read.text);
            pooledRead = [titleReads.join(" · "), bottomTexts.length ? `bottom: ${bottomTexts[bottomTexts.length - 1]}` : ""].filter(Boolean).join("  |  ");
            pubDebug(tracker.publish(attempt, { pooledRead }));
            const readLines = read.text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
            const single = matchNamesPooled(ocrCandidates(readLines), index, 3, { budgetMs: Math.max(0, clock.remaining()) });
            const stop = single[0];
            if (stop && stop.score >= 0.82) {
              bandWin = { name: stop.entry.full, label: spec.label ?? "rescue" };
              break rescueBands;
            }
          }
          pubDebug(tracker.recordStage(attempt, "title", titleMs));
        }
      }
      // DESKEW pass — the standard window read at ±5°/±2.5° band
      // rotations, only when every straight rescue band failed (see
      // TITLE_DESKEW_BANDS in ocr.ts). Same caps, same clock, same
      // 0.82 single-read bar as the rescue bands above; a tilted card
      // whose title leans inside the band is the only thing these
      // reads can win, and straight-on scans never reach them.
      if (!bandWin) {
        deskewBands: for (const prep of frameOrder) {
          const card = prep?.card;
          if (!card) continue;
          for (const spec of TITLE_DESKEW_BANDS) {
            if (aborted()) return abortOutcome;
            tracker.beginStage(attempt, "title");
            const rw = await cappedRead(clock, TITLE_READ_CAP_MS, () =>
              ocrTitleBandCapped(card, spec, { gen: ocrGen }),
            );
            if (aborted()) return abortOutcome;
            if (rw.skipped) break deskewBands;
            titleMs += rw.ms;
            const read = rw.value;
            if (read && read.text.trim()) {
              titleReads.push(read.text);
              pooledRead = [titleReads.join(" · "), bottomTexts.length ? `bottom: ${bottomTexts[bottomTexts.length - 1]}` : ""].filter(Boolean).join("  |  ");
              pubDebug(tracker.publish(attempt, { pooledRead }));
              const readLines = read.text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
              const single = matchNamesPooled(ocrCandidates(readLines), index, 3, { budgetMs: Math.max(0, clock.remaining()) });
              const stop = single[0];
              if (stop && stop.score >= 0.82) {
                bandWin = { name: stop.entry.full, label: spec.label ?? "deskew" };
                break deskewBands;
              }
            }
            pubDebug(tracker.recordStage(attempt, "title", titleMs));
          }
        }
      }
      // LIFTED rescue (Pass 17) — only when the title zone measured
      // DIM: the standard and tall windows re-read with the metering
      // gain, after every straight/deskew read failed. Same caps,
      // same clock, same 0.82 single-read bar.
      if (!bandWin && titleLiftSpec) {
        const tallLift = liftSpecWithGain(TITLE_TALL_BAND, titleLift, "tall+lift");
        const liftSpecs = [titleLiftSpec, ...(tallLift ? [tallLift] : [])];
        liftBands: for (const prep of frameOrder) {
          const card = prep?.card;
          if (!card) continue;
          for (const spec of liftSpecs) {
            if (aborted()) return abortOutcome;
            tracker.beginStage(attempt, "title");
            const rw = await cappedRead(clock, TITLE_READ_CAP_MS, () =>
              ocrTitleBandCapped(card, spec, { multiLine: spec.label === "tall+lift", gen: ocrGen }),
            );
            if (aborted()) return abortOutcome;
            if (rw.skipped) break liftBands;
            titleMs += rw.ms;
            liftedTitleReads += 1;
            const read = rw.value;
            if (read && read.text.trim()) {
              titleReads.push(read.text);
              pooledRead = [titleReads.join(" · "), bottomTexts.length ? `bottom: ${bottomTexts[bottomTexts.length - 1]}` : ""].filter(Boolean).join("  |  ");
              pubDebug(tracker.publish(attempt, { pooledRead }));
              const readLines = read.text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
              const single = matchNamesPooled(ocrCandidates(readLines), index, 3, { budgetMs: Math.max(0, clock.remaining()) });
              const stop = single[0];
              if (stop && stop.score >= 0.82) {
                bandWin = { name: stop.entry.full, label: spec.label ?? "lifted" };
                break liftBands;
              }
            }
            pubDebug(tracker.recordStage(attempt, "title", titleMs));
          }
        }
      }
      const pooledTop = bandWin ? null : pooledMatches()[0];
      const winnerName = bandWin?.name ?? (pooledTop && pooledTop.score >= 0.82 ? pooledTop.entry.full : null);
      if (winnerName) {
        onOptimisticName?.(winnerName);
        const base = await resolveByName(winnerName);
        if (aborted()) return abortOutcome;
        if (base) {
          const winLabel = bandWin ? `title (${bandWin.label} band)` : "title (pooled rescue bands)";
          if (numberCandidatesSeen) {
            // Number candidates existed and none produced a hit: the
            // title evidence that brought us here was garbage, so the
            // printings salvage — which re-scores the bottom line —
            // must not run; the name alone decides and the version
            // stays honestly unconfirmed.
            evidence = winLabel;
            return finish({ kind: "confident", card: base, info: NAME_ONLY_INFO, path: "device", evidence: "title" });
          }
          const salv = await applySalvage(base);
          if (aborted()) return abortOutcome;
          evidence = salv.salvaged ? "bottom line (salvage)" : winLabel;
          return finish({ kind: "confident", card: salv.card, info: salv.info, path: "device", evidence: "title" });
        }
      }
    }

    // PASS 34 — LATE CONSULT: the consult above is single-shot,
    // gated on the image channel having landed within its
    // sanctioned wait. When the wait expired, the channel kept
    // running and its completion handler published the verdict
    // line — but nothing ever JUDGED it: Rescue 2 ran, the pool
    // judgement below saw imagePresentCandidate === null, and a
    // DECISIVE artwork verdict settled as “No plausible name”
    // (Retrieve the Esper, d=44 margin ∞, 2026-11-10 20:51). If
    // the channel has landed by now and the consult never ran,
    // run it now, on the full pool (OCR absence is not a
    // contradiction of an artwork verdict). Shielded like the
    // first pass: the consult's own awaits are sanctioned work.
    if (!fusionConsulted && imageResult && imageResult.ranked.length > 0) {
      imageShieldRef.current = { attempt, untilEpochMs: Date.now() + 8000 };
      const fo = await consultFusion(imageResult);
      if (fo) return fo;
    }

    // --- pool exhausted: judge what's left ---
    const matches = pooledMatches();
    const top = matches[0];
    const noRead = !anyBottomHit && titleReads.every((t) => isNoRead(t));
    // An image candidate the gate would only PRESENT (rework) joins
    // the suggestions as the top entry — including on a no-read,
    // where the title band carried nothing (the pure-art band
    // shape: the band has no text, but the CARD does, and the image
    // channel read the card).
    const withImageSuggestion = (): MatchResult[] | null => {
      if (!imagePresentCandidate || !index) return null;
      const entry = index.find((e) => e.full === imagePresentCandidate!.name && e.faceIndex === 0)
        ?? index.find((e) => e.full === imagePresentCandidate!.name);
      if (!entry) return null;
      const rest = matches.filter((mm) => mm.entry.full !== entry.full);
      // Pass 23 display honesty: a PRESENTED image candidate is by
      // construction NOT in the auto-add class (decisive verdicts
      // settle; only band/margin-short candidates reach this list),
      // so it must not wear the 0.90 "match" the panels used to
      // hardcode — imageSuggestionScore maps its gate tier to the
      // displayed score (band → 0.72–0.86).
      return [{ entry, score: imageSuggestionScore(imagePresentCandidate, { degradedBlocked: captureDim }) }, ...rest].slice(0, 5);
    };
    if (noRead) {
      const merged = withImageSuggestion();
      if (merged) {
        evidence = "image (uncertain — not auto-added)";
        return finish({ kind: "uncertain", matches: merged, path: "device", imageCandidate: imagePresentCandidate });
      }
      evidence = "no readable text";
      return finish({ kind: "none", path: "device", noRead: true, ...(titleCrushed ? { tooDark: true } : {}) });
    }
    if (top && top.score >= 0.55) {
      evidence = "title (uncertain — thin margin)";
      const merged = withImageSuggestion();
      return finish({ kind: "uncertain", matches: merged ?? matches, path: "device", imageCandidate: imagePresentCandidate });
    }
    {
      const merged = withImageSuggestion();
      if (merged) {
        evidence = "image (uncertain — not auto-added)";
        return finish({ kind: "uncertain", matches: merged, path: "device", imageCandidate: imagePresentCandidate });
      }
    }
    if (!rapid && speedRef.current === "precise") {
      // Manual Snap with Precise EXPLICITLY selected only: extra band
      // treatments, then the slow read. With Fast (the default) Snap
      // runs the exact same burst pipeline as Rapid and stops here —
      // the old unconditional fallback was the timeout loop: up to 8
      // more capped reads plus a server read stacked past the 8s
      // watchdog, which killed the read and left only a restart note
      // even though the card had been found.
      tracker.beginStage(attempt, "title");
      const legacy = await identifyCore(firstCard, { onOptimisticName, allowSlow: true });
      if (aborted()) return abortOutcome;
      if (legacy.kind === "confident") {
        evidence = legacy.path === "slow" ? "slow server read" : "title (extra treatments)";
        return finish({ kind: "confident", card: legacy.card, info: legacy.info, path: legacy.path, evidence: legacy.path === "slow" ? "slow" : "title" });
      }
      if (legacy.kind === "uncertain") {
        evidence = "title (uncertain)";
        return finish(legacy);
      }
      return finish({ kind: "none", path: legacy.path, noRead, ...(titleCrushed ? { tooDark: true } : {}) });
    }
    return finish({ kind: "none", path: "device", noRead, ...(titleCrushed ? { tooDark: true } : {}) });
  };
  identifyBurstRef.current = identifyBurst;

  /** Add an identified card to the scan list; returns the saved item
   * plus whether the add MERGED into an existing row (same printing +
   * foil already listed — Pass 24c: Rapid's settle banner notes
   * 'already in list ×N' for a repeat scan, informational only). The
   * captured card photo is stored with the item for later version detection.
   * PASS 25: `confirmed` records whether the settle PINNED this
   * printing by evidence (collector number / art / salvage / user
   * pick); a name-only settle passes false and the scan list badges
   * the row "printing unconfirmed" instead of letting Scryfall's
   * default printing pass as a detection. */
  const addToList = async (card: CardT, foil: boolean, cardCanvas?: HTMLCanvasElement | null, confirmed = true): Promise<{ item: ScanItem; merged: boolean }> => {
    const image = cardCanvas ? buildStoredCardJpeg(cardCanvas) : "";
    const res = await api.addToScanList({
      card,
      foil,
      quantity: 1,
      condition: "Near Mint",
      language: "English",
      printingConfirmed: confirmed,
      ...(image ? { cardImageBase64: image } : {}),
    });
    rapidStatsRef.current.count += 1;
    rapidStatsRef.current.value += (foil ? card.priceUsdFoil ?? card.priceUsd : card.priceUsd) ?? 0;
    void queryClient.invalidateQueries({ queryKey: ["scanList"] });
    return { item: res.item, merged: res.merged };
  };

  /** The post-save banner note for a Rapid settle (Pass 24c's
   * 'already in list ×N', Pass 25's printing honesty): a name-only
   * settle whose printing is Scryfall's default says so ON the
   * banner — Rapid never interrupts the flow to ask, but it never
   * silently records a default printing either; the scan list
   * carries the same flag as a badge with the version picker one
   * tap away. */
  const settleNote = (item: ScanItem, merged: boolean): string | undefined => {
    const bits: string[] = [];
    if (merged && item.quantity > 1) bits.push(`already in list ×${item.quantity}`);
    if (!item.printingConfirmed) bits.push("printing unconfirmed — pick the version in the list");
    return bits.length > 0 ? bits.join(" · ") : undefined;
  };

  /** Manual presentation wrapper around identifyBurst (Snap / Take
   * Photo). Takes PREPARED frames (card already located + cropped);
   * photos contribute a single frame, live captures a 3-frame burst.
   * `focusAdvice` (Pass 33) is the soft-burst advice for THIS
   * attempt: appended to the failure message when identification
   * finds nothing — it never changes the outcome, and a successful
   * or Did-you-mean outcome doesn't show it. */
  const identifyFromCardCanvas = async (preps: PreparedScan[], extraNote = "", focusAdvice = "") => {
    const cardCanvas = preps[0]?.card;
    if (!cardCanvas) {
      setReadError("The camera isn't ready yet — wait for the picture, then snap.");
      return;
    }
    lastCanvasRef.current = cardCanvas;
    const gen = ++scanGenRef.current;
    const t0 = performance.now();
    manualReadingRef.current = true;
    setReading(true);
    setReadError(null);
    setCandidates(null);
    setCandidatesImage(null);
    setResultItemId(null);
    setVersionInfo(null);
    setResultPrintings(null);
    setPendingMatch(null);
    setFailedScan(null);
    // A new scan attempt starts NOW: the debug state resets to empty so
    // nothing from a previous scan can appear in this scan's panels.
    const tracker = debugTrackerRef.current!;
    const attempt = tracker.beginAttempt({ capture: captureResRef.current || "unknown", evidence: "title (burst)", rect: describePrepRect(preps[0]) });
    setScanDebug(tracker.snapshot());
    setRawRead("");
    try {
      const outcome = await identifyBurst(preps, {
        rapid: false,
        attempt,
        onOptimisticName: (name) => setPendingMatch(name),
        timings: { captureMs: captureMsRef.current, detectMs: preps[0]?.detectMs ?? 0 },
      });
      if (gen !== scanGenRef.current) return; // watchdog invalidated this read (it already surfaced the failure panel)
      if (outcome.kind === "aborted") return; // settled/superseded mid-flight — drop silently (success is final)
      setLastScan({ sec: ((performance.now() - t0) / 1000).toFixed(1), path: outcome.path });
      if (outcome.kind === "confident") {
        setFailedScan(null);
        const foil = outcome.info.foilDetected ?? batchFoil;
        const { item } = await addToList(outcome.card, foil, cardCanvas, outcome.info.status === "detected");
        setResultItemId(item.id);
        setVersionInfo(outcome.info);
        if (extraNote) showToast(extraNote);
      } else if (outcome.kind === "uncertain") {
        setCandidates(outcome.matches);
        setCandidatesImage(outcome.imageCandidate ?? null);
      } else {
        // A Snap ALWAYS settles visibly: this failure panel carries the
        // "What the scanner read" block (bands + raw reads + stage
        // timings, set by identifyBurst) and the slow-read offer.
        // PASS 33: a soft burst's focus advice attaches HERE — to a
        // real, full-pipeline failure — never as the outcome itself.
        setFailedScan({ canvas: cardCanvas });
        setReadError(scanFailureMessage(outcome.kind === "none" && outcome.tooDark === true) + (focusAdvice ? ` ${focusAdvice}` : ""));
      }
    } catch (err) {
      if (gen !== scanGenRef.current) return;
      setFailedScan({ canvas: cardCanvas });
      setReadError(`Reading failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      manualReadingRef.current = false;
      setReading(false);
      setPendingMatch(null);
      // Pass 24a: the light latch releases with the attempt, however
      // it ended (identifyBurst's finish already ended it on settle
      // paths; abort/timeout paths end it here).
      lightLatchRef.current = endAttemptLight(lightLatchRef.current);
    }
  };

  /**
   * The manual "Try slow read" button: the ONLY way the server vision read
   * runs for a Rapid-mode card. Runs the fallback alone against the failed
   * card's crop and presents the outcome like a normal scan.
   */
  const trySlowRead = async () => {
    const target = failedScan;
    if (!target || slowReading) return;
    setSlowReading(true);
    setReading(true);
    const gen = ++scanGenRef.current;
    const t0 = performance.now();
    try {
      const outcome = await identifyCore(target.canvas, { slowOnly: true });
      if (gen !== scanGenRef.current) return;
      setLastScan({ sec: ((performance.now() - t0) / 1000).toFixed(1), path: "slow" });
      if (outcome.kind === "confident") {
        setFailedScan(null);
        setRapidHint(null);
        const foil = outcome.info.foilDetected ?? batchFoil;
        if (rapidOn) {
          // PASS 22 (Item 2): feedback at settle, save after — same
          // contract as the other Rapid settle paths.
          const saved = settleWithFeedbackFirst(
            () => showFlash(outcome.card.name, outcome.card.imageSmall, foil),
            () => addToList(outcome.card, foil, target.canvas, outcome.info.status === "detected"),
          );
          machineRef.current?.reset(rapidCanvasRef.current ? canvasSignature(rapidCanvasRef.current) : []);
          void saved
            .then(({ item, merged }) => showFlash(item.name, item.imageSmall, foil, true, {
              itemId: item.id,
              value: (foil ? item.priceUsdFoil ?? item.priceUsd : item.priceUsd) ?? 0, note: settleNote(item, merged),
            }))
            .catch(() => setRapidHint("That card was identified but couldn't be saved to the scan list — check your connection."));
        } else {
          const { item } = await addToList(outcome.card, foil, target.canvas, outcome.info.status === "detected");
          setResultItemId(item.id);
          setVersionInfo(outcome.info);
        }
      } else if (outcome.kind === "uncertain") {
        setFailedScan(null);
        setCandidates(outcome.matches);
        setCandidatesImage(outcome.imageCandidate ?? null);
        if (rapidOn) {
          machineRef.current?.notifyResult("uncertain", performance.now());
          rapidPausedRef.current = true;
          setRapidPaused(true);
        }
      } else {
        setRapidHint("The slow read couldn't identify that one either — add it via Search, or re-scan with more light.");
      }
    } catch (err) {
      if (gen === scanGenRef.current) {
        setReadError(`Slow read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      setSlowReading(false);
      setReading(false);
    }
  };

  const resumeRapid = () => {
    rapidPausedRef.current = false;
    setRapidPaused(false);
    rapidDeferRef.current = 0;
    // The card the user just picked or skipped counts as handled: the
    // watcher won't re-scan it until it leaves the guide. PASS 29:
    // resumeFromPause — if the watcher observed that card depart
    // during the pause (a swap under the sheet), the machine stays
    // re-armed so the new card scans instead of being mistaken for
    // the picked one.
    const canvas = rapidCanvasRef.current ?? lastCanvasRef.current;
    machineRef.current?.resumeFromPause(canvas ? canvasSignature(canvas) : []);
  };

  const selectMatch = async (match: MatchResult) => {
    setCandidates(null);
    setCandidatesImage(null);
    setReading(true);
    const t0 = performance.now();
    try {
      const res = await api.getCardByName({ name: match.entry.full });
      if (!res.card) {
        setReadError(`“${match.entry.full}” was matched locally but Scryfall returned no card. Try again.`);
        if (rapidOn) resumeRapid();
        return;
      }
      const bottom = pendingBottomRef.current;
      setLastScan({ sec: ((performance.now() - t0) / 1000).toFixed(1), path: bottom ? "slow" : "device" });
      const foil = (bottom?.separator === "star" ? true : bottom?.separator === "bullet" ? false : null) ?? batchFoil;
      const canvas = lastCanvasRef.current;
      const info: VersionInfo = bottom
        ? slowInfo(bottom)
        : { status: "unconfirmed", message: NAME_ONLY_INFO.message, foilDetected: null };
      if (rapidOn && batchAutoAdd) {
        // PASS 22 (Item 2): the user's tap IS the settle — feedback
        // fires before the save starts, and Rapid re-arms immediately
        // instead of waiting out the save round-trip.
        const picked = res.card;
        const saved = settleWithFeedbackFirst(
          () => showFlash(picked.name, picked.imageSmall, foil),
          () => addToList(picked, foil, canvas, false),
        );
        resumeRapid();
        void saved
          .then(({ item, merged }) => showFlash(item.name, item.imageSmall, foil, true, {
            itemId: item.id,
            value: (foil ? item.priceUsdFoil ?? item.priceUsd : item.priceUsd) ?? 0, note: settleNote(item, merged),
          }))
          .catch(() => setRapidHint("That card was identified but couldn't be saved to the scan list — check your connection."));
        return;
      }
      const { item } = await addToList(res.card, foil, canvas, false);
      setResultItemId(item.id);
      setVersionInfo(info);
      setResultPrintings(null);
      if (rapidOn) resumeRapid();
    } catch (err) {
      setReadError(`Lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      if (rapidOn) resumeRapid();
    } finally {
      setReading(false);
    }
  };

  /**
   * PASS 24b (Item E) — "Use this artwork match anyway". The
   * Did-you-mean sheet's top entry is sometimes an IMAGE candidate
   * the fusion gate would only PRESENT: a band-tier match, or a
   * DECISIVE verdict demoted by the degraded-capture guard (dim
   * capture with margin < 12 or unstable frames). Measured in the
   * Pass 23 distance × clarity matrix: 44 of 1,019 decisive-correct
   * image matches (4.3%) were demoted this way — ALL of them in dim
   * cells, which are the scanner box's normal state — and the
   * user's Borg Queen hit exactly this shape on-device (decisive
   * d=40, presented, not added). Tapping the name entry resolves by
   * NAME (default printing, version unconfirmed); this button
   * settles the exact printing the artwork pinned, the way a
   * settle-image outcome would have. It renders only while that
   * candidate tops the sheet.
   */
  const useImageMatchAnyway = async (cand: RankedCandidate) => {
    setCandidates(null);
    setCandidatesImage(null);
    setReading(true);
    const t0 = performance.now();
    try {
      const byArt = await api.getCardBySetNumber({ set: cand.setCode, number: cand.collectorNumber }).then((r) => r.card).catch(() => null);
      const card = byArt ?? (await api.getCardByName({ name: cand.name }).then((r) => r.card).catch(() => null));
      if (!card) {
        setReadError(`“${cand.name}” was matched by artwork but Scryfall returned no card. Try again.`);
        if (rapidOn) resumeRapid();
        return;
      }
      const bottom = pendingBottomRef.current;
      const foil = (bottom?.separator === "star" ? true : bottom?.separator === "bullet" ? false : null) ?? batchFoil;
      const canvas = lastCanvasRef.current;
      setLastScan({ sec: ((performance.now() - t0) / 1000).toFixed(1), path: "device" });
      const info: VersionInfo = {
        status: "detected",
        message: `Matched by artwork (image distance ${cand.dist.combined}) — you confirmed this match, so the exact printing the artwork pinned was added: ${card.setName} #${card.collectorNumber}.`,
        foilDetected: null,
      };
      if (rapidOn && batchAutoAdd) {
        const saved = settleWithFeedbackFirst(
          () => showFlash(card.name, card.imageSmall, foil),
          () => addToList(card, foil, canvas, true),
        );
        resumeRapid();
        void saved
          .then(({ item, merged }) => showFlash(item.name, item.imageSmall, foil, true, {
            itemId: item.id,
            value: (foil ? item.priceUsdFoil ?? item.priceUsd : item.priceUsd) ?? 0, note: settleNote(item, merged),
          }))
          .catch(() => setRapidHint("That card was identified but couldn't be saved to the scan list — check your connection."));
        return;
      }
      const { item } = await addToList(card, foil, canvas, true);
      setResultItemId(item.id);
      setVersionInfo(info);
      setResultPrintings(null);
      if (rapidOn) resumeRapid();
    } catch (err) {
      setReadError(`Lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      if (rapidOn) resumeRapid();
    } finally {
      setReading(false);
    }
  };

  /**
   * Crop the on-screen guide box out of ANY capture source (live video
   * element or an ImageCapture still bitmap). ALL coordinate conversion
   * goes through geometry.ts cssRectToSource — the same cover math the
   * overlays and detection use — so the crop can never silently diverge
   * from what the user sees framed.
   */
  const drawGuideFromSource = (source: CanvasImageSource, srcW: number, srcH: number): HTMLCanvasElement | null => {
    const container = containerRef.current;
    const guide = guideRef.current;
    if (!container || !guide || srcW === 0 || srcH === 0) return null;
    const cRect = container.getBoundingClientRect();
    const gRect = guide.getBoundingClientRect();
    const { sx, sy, sw, sh } = cssRectToSource(
      { left: gRect.left - cRect.left, top: gRect.top - cRect.top, width: gRect.width, height: gRect.height },
      srcW,
      srcH,
      cRect.width,
      cRect.height,
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(50, Math.round(sw));
    canvas.height = Math.max(50, Math.round(sh));
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return null;
    ctx2d.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas;
  };

  /** Map the on-screen guide box into a card-crop canvas (object-cover aware). */
  const captureGuideCanvas = (): HTMLCanvasElement | null => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;
    return drawGuideFromSource(video, video.videoWidth, video.videoHeight);
  };

  /**
   * Capture ONE guide frame, preferring a full-resolution ImageCapture
   * still when the live stream is low-res (videoWidth < 1000 on the wide
   * side — exactly the tiny-webview-stream failure mode; the still is
   * dramatically sharper for the tiny bottom line). Returns the guide
   * canvas plus a human-readable capture-resolution label, which the UI
   * displays so a bad stream is visible instead of guessed at.
   */
  const captureOneFrame = async (): Promise<{ guide: HTMLCanvasElement; res: string } | null> => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;
    const track = streamRef.current?.getVideoTracks()[0];
    if (track && video.videoWidth < 1000) {
      let ic: ImageCaptureLike | null = null;
      if (imageCaptureRef.current?.track === track) {
        ic = imageCaptureRef.current.ic;
      } else {
        ic = getImageCapture(track);
        imageCaptureRef.current = ic ? { track, ic } : null;
      }
      if (ic) {
        try {
          const bmp = await ic.grabFrame();
          // Downscale oversized stills BEFORE anything reads them: a
          // full-sensor 4000px+ still makes every band build and OCR
          // pass pay for pixels nobody needs (Snap cost divergence).
          let source: CanvasImageSource = bmp;
          let sw = bmp.width;
          let sh = bmp.height;
          if (Math.max(bmp.width, bmp.height) > 1600) {
            const scale = 1600 / Math.max(bmp.width, bmp.height);
            const c0 = document.createElement("canvas");
            c0.width = Math.max(50, Math.round(bmp.width * scale));
            c0.height = Math.max(50, Math.round(bmp.height * scale));
            const cx = c0.getContext("2d");
            if (cx) {
              cx.drawImage(bmp, 0, 0, c0.width, c0.height);
              source = c0;
              sw = c0.width;
              sh = c0.height;
            }
          }
          const c = drawGuideFromSource(source, sw, sh);
          bmp.close();
          if (c) return { guide: c, res: `${bmp.width}×${bmp.height} still` };
        } catch { /* fall back to the video frame */ }
      }
    }
    const c = captureGuideCanvas();
    return c ? { guide: c, res: `${video.videoWidth}×${video.videoHeight} video` } : null;
  };

  /**
   * Capture ONE guide frame from a full-resolution ImageCapture still,
   * WITHOUT the 1600px whole-frame downscale captureOneFrame applies:
   * the guide is mapped straight out of the full-sensor bitmap, so a
   * card that is SMALL in the frame keeps every sensor pixel it has
   * (Pass 9 — distance robustness: "shouldn't matter how far or
   * close"). The caller downscales the resulting CARD CROP, never the
   * frame, to reading size. Returns null where ImageCapture doesn't
   * exist (in-app webviews, iOS Safari) — the video frames are then
   * the best available and are used as-is.
   */
  const captureStillGuideCanvas = async (): Promise<{ guide: HTMLCanvasElement; res: string } | null> => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return null;
    let ic: ImageCaptureLike | null = null;
    if (imageCaptureRef.current?.track === track) {
      ic = imageCaptureRef.current.ic;
    } else {
      ic = getImageCapture(track);
      imageCaptureRef.current = ic ? { track, ic } : null;
    }
    if (!ic) return null;
    try {
      const bmp = await ic.grabFrame();
      try {
        const c = drawGuideFromSource(bmp, bmp.width, bmp.height);
        return c ? { guide: c, res: `${bmp.width}×${bmp.height} still` } : null;
      } finally {
        bmp.close();
      }
    } catch {
      return null;
    }
  };

  /**
   * Locate the card in a captured frame and crop to IT. Order of trust:
   * stored box calibration (fixed rig) → live detection → the frame itself
   * (labelled "guide" — the old behaviour, kept as an honest fallback).
   */
  const prepareCardCanvas = (frame: HTMLCanvasElement, opts?: { ignoreCalibration?: boolean }): PreparedScan => {
    // The rect-selection logic itself lives in detect.ts
    // (prepareCardFromFrame) so the regression harness in
    // tests/harness/ exercises the exact code the phone runs.
    //
    // CONTINUOUS TRACKING (Pass 24a): in box mode this wrapper is the
    // tracker's single feeding point — every live frame prepared
    // here (preview ticks, watcher ticks, taps, burst frames) folds
    // its OWN detection into the tracker, and the tracker's fresh
    // rect is offered to the prepare as the working position. Photo
    // files (ignoreCalibration) never feed it: a hand-held photo is
    // a different scene from the rig.
    const box = boxModeRef.current;
    const live = box && !opts?.ignoreCalibration;
    const now0 = performance.now();
    if (live && !trackedRectRef.current && boxCalibRef.current) {
      trackedRectRef.current = seedTrackedRect(boxCalibRef.current, now0);
    }
    const prep = prepareCardFromFrame(frame, {
      boxMode: box,
      calibration: boxCalibRef.current,
      ignoreCalibration: opts?.ignoreCalibration,
      recentRects: (() => {
        const now = performance.now();
        return recentDetectionsRef.current.filter((e) => now - e.at <= 3000).map((e) => e.rect);
      })(),
      trackedRect: live ? freshTrackedRect(trackedRectRef.current, now0) : null,
    });
    if (live && prep.detectedRect) {
      // Pass 30: the stored calibration rides along as the seat —
      // a detection implausible as the card at that seat (a lit
      // sub-region in the dark) is refused by the tracker outright.
      const next = observeTrackedRect(trackedRectRef.current, prep.detectedRect, performance.now(), boxCalibRef.current);
      trackedRectRef.current = next;
      // Mirror the lock for the viewfinder outline, but only when it
      // actually moved — the state update re-renders, and preview
      // ticks arrive several times a second.
      setTrackedOverlay((prev) => {
        if (prev && Math.max(Math.abs(prev.x0 - next.rect.x0), Math.abs(prev.y0 - next.rect.y0), Math.abs(prev.x1 - next.rect.x1), Math.abs(prev.y1 - next.rect.y1)) < 0.004) return prev;
        return next.rect;
      });
    }
    // PASS 31: measure this crop's title-zone sharpness once, here —
    // every burst frame, retained frame and photo carries it, and
    // the read-order / retained-gate decisions read it off the prep.
    return { ...prep, titleSharpness: measureTitleSharpness(prep.card) };
  };

  /** Record a successful read rect: feeds Pass 16's last-detection
   * rescue AND Pass 18's stabilisation history in one place, so every
   * site that learns a rect updates both. */
  const noteDetection = (rect: CardRect): void => {
    const now = performance.now();
    lastDetectionRef.current = { rect, at: now };
    const list = recentDetectionsRef.current;
    list.push({ rect, at: now });
    while (list.length > 8) list.shift();
  };

  /** Small preview of a photo frame with the detected outline drawn on it. */
  const buildScanPreview = (prep: PreparedScan): string => {
    try {
      const maxW = 360;
      const scale = Math.min(1, maxW / Math.max(1, prep.frame.width));
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(prep.frame.width * scale));
      out.height = Math.max(1, Math.round(prep.frame.height * scale));
      const ctx = out.getContext("2d");
      if (!ctx) return "";
      ctx.drawImage(prep.frame, 0, 0, out.width, out.height);
      if (prep.rect) {
        ctx.strokeStyle = "#c9a86a";
        ctx.lineWidth = 4;
        ctx.strokeRect(
          prep.rect.x0 * out.width,
          prep.rect.y0 * out.height,
          (prep.rect.x1 - prep.rect.x0) * out.width,
          (prep.rect.y1 - prep.rect.y0) * out.height,
        );
      }
      return out.toDataURL("image/jpeg", 0.8);
    } catch {
      return "";
    }
  };

  /** Consume the retained frame-at-detection (Pass 15), if fresh.
   * Consuming clears it either way: a stale approval is never used
   * twice and never lingers into a later, unrelated capture. */
  const takeRetainedFrame = (): PreparedScan | null => {
    const r = retainedFrameRef.current;
    retainedFrameRef.current = null;
    if (!r) return null;
    return performance.now() - r.at <= 2500 ? r.prep : null;
  };

  /**
   * PASS 32 (Item 2a) — THE SHARPNESS ESCALATION around a burst
   * capture (named "gate" in Pass 32; Pass 33 demotes it — see
   * below). When EVERY measured frame of a burst is below the
   * readability floor (focus.ts SHARPNESS_FLOOR), re-trigger
   * autofocus, wait one settle beat (FOCUS_SETTLE_MS), and
   * re-capture ONCE (bounded — never a loop). Returns the burst to
   * read (the re-capture, when the escalation fired) and whether
   * the FINAL burst still meters all-soft.
   *
   * PASS 33 — `stillSoft` IS ADVISORY ONLY. In Pass 32 the callers
   * treated it as a veto: Snap settled with an out-of-focus panel
   * and NO identification at all (the artwork channel never ran),
   * Rapid handed the card back unread. On-device that refused
   * legible, artwork-identifiable cards (Stingerquill at 11.6) and
   * a brand-new card outright — the regression this pass removes.
   * Now: every caller ALWAYS proceeds to identification with the
   * returned burst (softAttemptPlan in focus.ts pins the contract:
   * proceed is unconditionally true). Snap additionally escalates
   * to the hi-res still path when stillSoft (see
   * escalateSoftBurstToStill); the soft verdict otherwise only
   * attaches focus ADVICE to a failed attempt's outcome.
   * Bursts with any frame at/above the floor, and unmeasured
   * bursts (every score 0 — the metric couldn't run), pass through
   * untouched: the trigger never fires on missing data, and it is
   * a FOCUS trigger, never a light gate (dim-sharp bursts measure
   * 13.4–15.2 on the ladder and pass).
   */
  const captureBurstWithFocusGate = async (
    count = 3,
    opts: { hiResSmallCard?: boolean; useRetainedFirst?: boolean } = {},
  ): Promise<{ preps: PreparedScan[] | null; stillSoft: boolean }> => {
    focusGateNoteRef.current = "";
    const first = await capturePreparedBurst(count, opts);
    if (!first) return { preps: null, stillSoft: false };
    const firstScores = first.map((p) => p.titleSharpness ?? 0);
    if (burstFocusVerdict(firstScores) !== "all-soft") return { preps: first, stillSoft: false };
    await retriggerAutofocus();
    await new Promise((r) => window.setTimeout(r, FOCUS_SETTLE_MS));
    const second = await capturePreparedBurst(count, { ...opts, useRetainedFirst: false });
    if (!second) return { preps: first, stillSoft: true };
    const secondScores = second.map((p) => p.titleSharpness ?? 0);
    focusGateNoteRef.current =
      `first burst out of focus (sharpness ${firstScores.map((s) => s.toFixed(1)).join(" · ")} — below the readability floor ${SHARPNESS_FLOOR}) — autofocus re-triggered and the burst re-captured once; new sharpness ${secondScores.map((s) => s.toFixed(1)).join(" · ")}`;
    return { preps: second, stillSoft: burstFocusVerdict(secondScores) === "all-soft" };
  };

  /**
   * PASS 33 (Item b) — STILL-CAPTURE ESCALATION. When both video
   * bursts metered all-soft, Snap escalates ONCE to the hi-res
   * ImageCapture still path (the capture class the small-card
   * retry has used since Pass 9: full-sensor pixels, per-shot
   * focus behaviour) instead of giving up on the soft video
   * frames. The still is prepared like any frame (its own
   * detection/rect/sharpness), its sharpness is measured on the
   * SAME metric and appended to the panel's focus note — the
   * first real data on whether stills break the softness pattern
   * in Andrew's rig — and the still LEADS the burst when it is
   * sharper than every video frame (the pipeline already reads
   * sharpest-first within its passes; leading also makes it the
   * panel's head frame), otherwise it joins as an extra frame.
   * Where ImageCapture doesn't exist (in-app webviews), the note
   * says so and the video burst proceeds as-is. Identification
   * ALWAYS runs on the returned burst either way.
   */
  const escalateSoftBurstToStill = async (videoPreps: PreparedScan[]): Promise<PreparedScan[]> => {
    const still = await captureStillGuideCanvas();
    if (!still) {
      focusGateNoteRef.current += " · hi-res still escalation unavailable — this browser exposes no ImageCapture stills";
      return videoPreps;
    }
    captureResRef.current = still.res;
    setCaptureRes(still.res);
    const prep = prepareCardCanvas(still.guide);
    const stillPrep: PreparedScan = { ...prep, card: downscaleCanvas(prep.card, 1600) };
    const stillScore = prep.titleSharpness ?? 0;
    const videoBest = Math.max(0, ...videoPreps.map((p) => p.titleSharpness ?? 0));
    focusGateNoteRef.current +=
      ` · hi-res still escalation: still sharpness ${stillScore.toFixed(1)} vs video best ${videoBest.toFixed(1)}${stillScore > videoBest ? " — still leads the read" : ""}`;
    return stillScore > videoBest ? [stillPrep, ...videoPreps] : [...videoPreps, stillPrep];
  };

  /**
   * Capture a BURST of prepared frames from the live camera (~120ms
   * apart): single-frame luck — one soft frame, one glare frame — was
   * behind a string of garbage reads, so identification pools evidence
   * across the burst. A very dark first frame (the near-black box shot)
   * gets ONE retry of the whole burst with exposure compensation raised
   * before OCR ever sees it.
   *
   * With `useRetainedFirst`, burst frame 1 is the retained
   * frame-at-detection — the exact frame the on-screen outline/hint
   * approved (Pass 15, Evidence C) — and only the remaining frames are
   * fresh grabs (each still detected per-frame as before). The
   * "What the scanner read" thumbnails are cut from preps[0], i.e.
   * from this same frame when it is used: what you see is what was
   * read, in the diagnostics as well as the pipeline.
   */
  const capturePreparedBurst = async (count = 3, opts: { hiResSmallCard?: boolean; useRetainedFirst?: boolean } = {}): Promise<PreparedScan[] | null> => {
    retainedSharpnessDropRef.current = "";
    // PASS 31: re-assert the focus plan at every burst — constraints
    // can reset across track restarts and sibling constraint writes,
    // and where the track exposes only single-shot AF, re-applying
    // it here is the trigger that runs a fresh focus cycle on the
    // card that just settled in.
    const focusTrack = streamRef.current?.getVideoTracks()[0];
    if (focusTrack) await applyCameraLocks(focusTrack);
    const captureT0 = performance.now();
    const grab = async (n: number): Promise<PreparedScan[] | null> => {
      const preps: PreparedScan[] = [];
      for (let i = 0; i < n; i++) {
        if (i > 0) await new Promise((r) => window.setTimeout(r, 120));
        const f = await captureOneFrame();
        if (!f) break;
        captureResRef.current = f.res;
        preps.push(prepareCardCanvas(f.guide));
      }
      return preps.length > 0 ? preps : null;
    };
    let preps: PreparedScan[] | null;
    const retained = opts.useRetainedFirst ? takeRetainedFrame() : null;
    if (retained) {
      // PASS 28 — validate the retained frame against the LIVE
      // scene before it leads the burst (see retainedFrameMatchesScene
      // in rapid.ts): retention survives a fast card swap whenever
      // the preview ticks missed the change, and a burst led by a
      // stale frame reads the previous card's pixels. One probe
      // grab settles it — on a match the probe becomes burst frame
      // 2 (no capture wasted); on a mismatch the retention is
      // dropped and the probe leads a normal fresh burst. Only a
      // failed probe grab (camera not ready) keeps the old
      // unconditional behaviour.
      const probe = await captureOneFrame();
      if (probe) {
        captureResRef.current = probe.res;
        const probePrep = prepareCardCanvas(probe.guide);
        // PASS 31 — sharpness gate: scene identity (Pass 28) proves
        // the retained frame shows THIS card; it says nothing about
        // FOCUS. The retained frame was captured at viewfinder-
        // approval time, plausibly before autofocus settled on the
        // newly presented card — if it measures dramatically softer
        // than the live probe beside it, it must not lead (and its
        // reads must not be the pool's early evidence): drop it to
        // the same fresh burst a scene mismatch gets.
        const sharpEnough = retainedSharpnessGate(retained.titleSharpness ?? 0, probePrep.titleSharpness ?? 0);
        if (!sharpEnough) {
          retainedSharpnessDropRef.current =
            `retained frame dropped — much softer than the live frame (sharpness ${(retained.titleSharpness ?? 0).toFixed(1)} vs ${(probePrep.titleSharpness ?? 0).toFixed(1)}); it was likely captured before autofocus settled`;
        }
        if (sharpEnough && retainedFrameMatchesScene(canvasSignature(retained.frame), canvasSignature(probe.guide))) {
          const rest = count > 2 ? await grab(count - 2) : [];
          // The retained prep leads the burst AS the frame-at-detection:
          // label its rect provenance so the diagnostics can say so.
          const lead: PreparedScan = retained.rect ? { ...retained, rectOrigin: "retained-frame" } : retained;
          preps = [lead, probePrep, ...(rest ?? [])];
        } else {
          const rest = count > 1 ? await grab(count - 1) : [];
          preps = [probePrep, ...(rest ?? [])];
        }
      } else {
        const rest = count > 1 ? await grab(count - 1) : [];
        const lead: PreparedScan = retained.rect ? { ...retained, rectOrigin: "retained-frame" } : retained;
        preps = [lead, ...(rest ?? [])];
      }
    } else {
      preps = await grab(count);
    }
    if (!preps) return null;
    const first = preps[0];
    if (first && meanLuminance(first.card) < 55) {
      const track = streamRef.current?.getVideoTracks()[0];
      let raised = false;
      if (track) {
        try {
          const caps = track.getCapabilities() as unknown as { exposureCompensation?: { max?: number } };
          const max = caps.exposureCompensation?.max;
          if (typeof max === "number" && max > 0) {
            await track.applyConstraints({ advanced: [{ exposureCompensation: max } as unknown as MediaTrackConstraintSet] });
            raised = true;
            // Pass 24a: REGISTER the retry's raise with the light
            // bookkeeping — before this it was applied anonymously
            // and never restored, so one dark capture left exposure
            // maxed for the rest of the session (and Auto's restore
            // logic fought it blindly). Now the latch knows the
            // light state includes this raise: the attempt-start
            // decision that follows cannot immediately undo it
            // (dwell), and a later release restores it properly.
            if (lightModeRef.current === "auto") {
              autoExposureRef.current = max;
              lightLatchRef.current = noteExternalLightApplication(lightLatchRef.current, true, performance.now());
            }
          }
        } catch { /* best-effort */ }
      }
      if (raised) {
        await new Promise((r) => window.setTimeout(r, 450));
        const retry = await grab(count);
        if (retry) {
          preps = retry;
          setScanNote("That frame was very dark — exposure was raised and the card re-captured.");
        }
        // PASS 31: the exposure write above is an advanced-constraint
        // application — re-assert the focus plan so a stack that
        // resets sibling constraints can't silently drop autofocus.
        if (track) await applyCameraLocks(track);
      }
    }
    // SMALL-CARD HI-RES RETRY (Pass 9, Snap only — Rapid's happy path
    // is untouched): the user holds cards at whatever distance; when
    // the detected card is small in the frame (<45% of frame height),
    // the video frame may not carry enough glyph pixels for the tiny
    // title/bottom type. Retake the burst from full-resolution
    // ImageCapture stills and keep whichever burst gives the card
    // MORE pixels. Only the still's CARD CROP is downscaled (to
    // 1600px) — downscaling the whole still first would throw away
    // exactly the resolution this retry exists to use.
    if (opts.hiResSmallCard) {
      const head0 = preps[0];
      const rectH = head0?.rect ? head0.rect.y1 - head0.rect.y0 : 1;
      if (head0 && head0.source === "detected" && rectH < 0.45) {
        const stillPreps: PreparedScan[] = [];
        for (let i = 0; i < count; i++) {
          if (i > 0) await new Promise((r) => window.setTimeout(r, 120));
          const f = await captureStillGuideCanvas();
          if (!f) break;
          captureResRef.current = f.res;
          const prep = prepareCardCanvas(f.guide);
          stillPreps.push({ ...prep, card: downscaleCanvas(prep.card, 1600) });
        }
        const sHead = stillPreps[0];
        if (sHead && sHead.source === "detected" && sHead.card.height > head0.card.height) {
          preps = stillPreps;
          setScanNote("Card is small in the frame — used a full-resolution photo so the name and number stay readable at this distance.");
        }
      }
    }
    // RECT AUTHORITY (Pass 16): whatever the burst's own per-frame
    // detection managed, an attempt must never read the guide area
    // while a fresh successful detection exists. Frames that fell
    // back to the guide are re-cropped from their own pixels with a
    // sibling frame's rect, or — when no frame detected — with the
    // scanner's most recent detection (the one the viewfinder is
    // still showing the user). Runs LAST, after the dark/hi-res
    // retries replaced frames, so it judges the frames actually read.
    preps = applyRectAuthority(preps, lastDetectionRef.current, performance.now());
    const authorityHead = preps.find((p) => p.rect);
    if (authorityHead?.rect) {
      noteDetection(authorityHead.rect);
    }
    const head = preps[0];
    if (head && !head.rect) {
      // This attempt read the guide: no detection existed anywhere
      // for it. Any stabilisation history is from an older scene —
      // drop it so it cannot steer a later attempt's rect.
      recentDetectionsRef.current = [];
    }
    setCardPresent(head?.rect != null);
    if (head?.rect) {
      setDetectOverlay({ rect: head.rect, source: head.source === "calibration" ? "calibration" : "detected" });
    }
    // The guide-fallback note is attempt-scoped state (Pass 16): set
    // only when THIS capture's head really read the guide (post-
    // authority — i.e. no detection existed anywhere to read from),
    // and rendered only while the live hint agrees there is no card.
    setGuideFallbackNote(head?.source === "guide");
    if (head?.calibrationStale) {
      setScanNote("The card isn't sitting at the saved box position — read it where it actually is. The tracker re-locks onto the new position on its own.");
    }
    setCaptureRes(captureResRef.current);
    captureMsRef.current = performance.now() - captureT0;
    return preps;
  };

  /** Box calibration: detect the card once, store its rect for the rig. */
  const calibrateBox = async () => {
    const frame = captureGuideCanvas();
    if (!frame) {
      setScanNote("Start the camera first, slide a card fully into the box, then tap Calibrate box.");
      return;
    }
    const det = detectInCanvas(frame);
    if (!det || det.confidence < 0.4) {
      setScanNote("Couldn't find the card outline for calibration — slide a card fully in, keep it still, and try again.");
      return;
    }
    const rect = expandRect(correctCardAspect(det.rect, frame.width / Math.max(1, frame.height), det.shoulders), 0.015);
    setBoxCalib(rect);
    boxCalibRef.current = rect;
    try { localStorage.setItem("manabox-box-calibration", JSON.stringify(rect)); } catch { /* ignore */ }
    // Pass 24a: a manual (re)calibration RE-SEEDS the tracker — the
    // override the user asked to keep. From here the tracker takes
    // over again and keeps the position current on its own.
    trackedRectRef.current = seedTrackedRect(rect, performance.now());
    setTrackedOverlay(rect);
    setDetectOverlay({ rect, source: "calibration" });
    setScanNote("Box calibrated ✓ — that's the tracker's starting position; it now keeps tracking the card from there on its own. Re-calibrate only if you move the phone in the rig.");
    beep();
  };

  const captureFromCamera = async () => {
    // Snap gets the small-card hi-res retry (Pass 9): distance should
    // not matter, so a card small in the frame is re-captured from a
    // full-resolution still before anything reads it. It also leads
    // with the retained frame-at-detection (Pass 15): the frame the
    // CARD FOUND hint approved is burst frame 1.
    // PASS 32 (Item 2a): the sharpness escalation wraps the capture —
    // an all-soft burst is re-focused and re-captured once before
    // anything reads it.
    // PASS 33: stillSoft NO LONGER settles the attempt (the Pass 32
    // out-of-focus refusal is deleted — it vetoed the artwork
    // channel on legible cards). A still-soft Snap escalates ONCE
    // to the hi-res still path, then identification ALWAYS runs:
    // the artwork channel starts concurrently inside identifyBurst
    // and the OCR reads run sharpest-first, exactly as for any
    // other burst. If the attempt then fails, the focus advice
    // rides the failure message — advice, never a refusal.
    const gated = await captureBurstWithFocusGate(3, { hiResSmallCard: true, useRetainedFirst: true });
    if (!gated.preps) {
      setReadError("The camera isn't ready yet — wait for the picture, then snap.");
      return;
    }
    let preps = gated.preps;
    if (gated.stillSoft) {
      preps = await escalateSoftBurstToStill(preps);
    }
    // The plan is computed on the FINAL burst (post-escalation): a
    // sharp still clears the soft verdict and its advice with it.
    const plan = softAttemptPlan(preps.map((p) => p.titleSharpness ?? 0), { snap: true });
    await identifyFromCardCanvas(preps, "", plan.advice);
  };

  const handlePhotoFile = async (file: File) => {
    setReadError(null);
    try {
      // Decode WITH the photo's EXIF orientation applied. Phone cameras
      // store pixels sideways (EXIF 6/8) and rely on the viewer to
      // rotate; the regression harness's EXIF fixtures prove the
      // pipeline reads oriented pixels perfectly and stored-sideways
      // pixels not at all. <img> decode bakes orientation in modern
      // browsers, but a WebView that doesn't hands over a sideways
      // card and every band misses. createImageBitmap with
      // imageOrientation:"from-image" makes the rotation explicit —
      // and where the platform already bakes it, the result is
      // identical, so this can only repair the broken case. Any decode
      // failure (e.g. HEIC in Chrome) falls back to the <img> path.
      let bmp: ImageBitmap | null = null;
      try {
        bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch {
        bmp = null;
      }
      const url = URL.createObjectURL(file);
      const img = new Image();
      if (!bmp) {
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("That image couldn't be read."));
          img.src = url;
        });
      }
      const srcW = bmp ? bmp.width : img.naturalWidth;
      const srcH = bmp ? bmp.height : img.naturalHeight;
      // Downscale big phone photos to ≤1600px long edge before any
      // detection/OCR — same rule as ImageCapture stills (Snap parity).
      const photoScale = Math.min(1, 1600 / Math.max(1, Math.max(srcW, srcH)));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(50, Math.round(srcW * photoScale));
      canvas.height = Math.max(50, Math.round(srcH * photoScale));
      const ctx2d = canvas.getContext("2d");
      if (!ctx2d) { if (bmp) bmp.close(); return; }
      ctx2d.drawImage(bmp ?? img, 0, 0, canvas.width, canvas.height);
      if (bmp) bmp.close();
      URL.revokeObjectURL(url);
      captureMsRef.current = 0;
      // A photo file is NOT in the scanner box — never let the rig's
      // stored calibration crop it (that leak read a hand-held photo
      // through the box rect and OCR'd desk/finger bands).
      const prep = prepareCardCanvas(canvas, { ignoreCalibration: true });
      const preview = buildScanPreview(prep);
      if (preview) setScanPreview(preview);
      captureResRef.current = `${srcW}×${srcH} photo`;
      setCaptureRes(captureResRef.current);
      if (prep.source === "guide") {
        setScanNote("Card outline not found in that photo — reading the whole photo. A photo that's mostly just the card works best.");
      }
      const aspect = srcH / Math.max(1, srcW);
      const aspectNote =
        aspect < 1.22 || aspect > 1.62
          ? "That photo isn't card-shaped, so the read may be rough — a photo that is mostly just the card works best."
          : "";
      await identifyFromCardCanvas([prep], aspectNote);
    } catch (err) {
      setReadError(err instanceof Error ? err.message : String(err));
    }
  };

  // -------------------------------------------------------------------------
  // Rapid auto-scan. The scene/stability/retry decisions live in the pure
  // RapidMachine (client/src/rapid.ts, unit-tested): a new card stable for
  // ~500ms triggers a scan; a recognised card is never re-added while it
  // sits UNMOVED, but a presentation event (change / brief absence /
  // movement + stable re-presentation) re-arms it for the next card —
  // including the SAME card deliberately re-presented (Pass 22); a FAILED
  // read unlocks after 1.5s and retries the same card (max 4 attempts,
  // then it asks for a tap); the empty scene captured when rapid starts
  // is the baseline and never scans at all.
  // -------------------------------------------------------------------------

  /** Run one recognition for a rapid-triggered (or tapped) capture.
   * Rapid NEVER uses the slow server read (resolveRapidMode) — local
   * attempts only. The single-flight guard (rapidBusyRef) and the reading
   * indicator reset in a FINALLY block on every path — success, no-match,
   * error, timeout — so the watcher can never wedge the way it used to
   * (the "refresh the page to make it work" bug). */
  const runRapidScan = async (preps: PreparedScan[]): Promise<void> => {
    const machine = machineRef.current;
    const canvas = preps[0]?.card;
    if (!canvas) {
      rapidBusyRef.current = false;
      machine?.notifyResult("fail", performance.now());
      return;
    }
    const gen = ++scanGenRef.current;
    rapidBusyRef.current = true;
    setReading(true);
    // PASS 33: this attempt's soft-burst focus advice (armed by the
    // capture call site when the burst metered all-soft) — consumed
    // here so a later attempt can never inherit it.
    const softAdvice = rapidSoftAdviceRef.current;
    rapidSoftAdviceRef.current = "";
    // A new scan beginning auto-dismisses any previous error panel.
    setReadError(null);
    const t0 = performance.now();
    // A new scan attempt starts NOW: debug state resets (per-attempt
    // token) before the burst publishes anything.
    const tracker = debugTrackerRef.current!;
    const attempt = tracker.beginAttempt({ capture: captureResRef.current || "unknown", evidence: "title (rapid burst)", rect: describePrepRect(preps[0]) });
    setScanDebug(tracker.snapshot());
    let notified = false;
    const notify = (outcome: "success" | "fail" | "uncertain") => {
      if (notified || !machine) return;
      notified = true;
      machine.notifyResult(outcome, performance.now());
    };
    try {
      // Rapid identification is the burst pipeline: pooled fast reads,
      // collector number first, NEVER the slow server read.
      const outcome = await identifyBurst(preps, {
        rapid: true,
        attempt,
        timings: { captureMs: captureMsRef.current, detectMs: preps[0]?.detectMs ?? 0 },
        onOptimisticName: (name) => {
          // Optimistic: flash the matched name the moment it matches
          // locally, before Scryfall details and the save come back.
          showFlash(name, "", batchFoil, true);
        },
      });
      if (gen !== scanGenRef.current) return; // watchdog reset mid-read
      if (outcome.kind === "aborted") return; // settled/superseded mid-flight — drop silently (success is final)
      setLastScan({ sec: ((performance.now() - t0) / 1000).toFixed(1), path: outcome.path });
      if (!machine) return;
      if (outcome.kind === "confident") {
        notify("success");
        rapidDarkWarnedRef.current = false;
        rapidFocusWarnedRef.current = false;
        setFailedScan(null);
        const foil = outcome.info.foilDetected ?? batchFoil;
        if (batchAutoAdd) {
          // PASS 22 (Item 2) — FEEDBACK AT SETTLE: the beep + banner
          // fire NOW, synchronously with settlement, before the save
          // is even started (settleWithFeedbackFirst). Before this,
          // the flash was chained off addToList's promise, so the
          // sound waited on the scan-list server round-trip — the
          // user's "notifications are not as fast as the card scans".
          // The save's completion only upgrades the already-showing
          // banner with its Undo target, silently (no second beep).
          void settleWithFeedbackFirst(
            () => showFlash(outcome.card.name, outcome.card.imageSmall, foil),
            () => addToList(outcome.card, foil, canvas, outcome.info.status === "detected"),
          )
            .then(({ item, merged }) => showFlash(item.name, item.imageSmall, foil, true, {
              itemId: item.id,
              value: (foil ? item.priceUsdFoil ?? item.priceUsd : item.priceUsd) ?? 0, note: settleNote(item, merged),
            }))
            .catch(() => setRapidHint("That card was identified but couldn't be saved to the scan list — check your connection."));
        } else {
          const { item } = await addToList(outcome.card, foil, canvas, outcome.info.status === "detected");
          setResultItemId(item.id);
          setVersionInfo(outcome.info);
        }
      } else if (outcome.kind === "uncertain") {
        notify("uncertain");
        rapidDarkWarnedRef.current = false;
        rapidPausedRef.current = true;
        setRapidPaused(true);
        setCandidates(outcome.matches);
        setCandidatesImage(outcome.imageCandidate ?? null);
      } else {
        notify("fail");
        setFailedScan({ canvas });
        if (outcome.kind === "none" && outcome.tooDark) {
          // Pass 17: a crushed-dark card gets ONE status-line warning
          // per dark streak instead of the generic retry hint cycling
          // silently on every attempt.
          if (!rapidDarkWarnedRef.current) {
            rapidDarkWarnedRef.current = true;
            setRapidHint(TOO_DARK_RAPID_HINT);
          }
        } else if (softAdvice && !rapidFocusWarnedRef.current) {
          // PASS 33: the burst metered all-soft AND identification
          // found nothing — the focus advice attaches to this failed
          // attempt (once per soft streak, the Pass 32 no-spam rule;
          // a success resets the streak). The hand-back is now only
          // this: a failed identification retries on the machine's
          // normal cadence, exactly like any other no-read.
          rapidFocusWarnedRef.current = true;
          rapidDarkWarnedRef.current = false;
          setRapidHint(`That one wasn't recognised — it will retry while it sits in the guide. ${softAdvice}`);
        } else {
          rapidDarkWarnedRef.current = false;
          if (machine.phase === "exhausted") {
            setRapidHint("Couldn't read that one after a few tries — tap the card view to scan it now, swap cards, or use the slow read button below.");
          } else {
            setRapidHint("That one wasn't recognised — it will retry while it sits in the guide.");
          }
        }
      }
    } catch {
      if (gen === scanGenRef.current) {
        notify("fail");
        setFailedScan({ canvas });
      }
    } finally {
      rapidBusyRef.current = false;
      setReading(false);
      // Pass 24a: the light latch releases with the attempt.
      lightLatchRef.current = endAttemptLight(lightLatchRef.current);
    }
  };

  /** Tap on the viewfinder inside rapid mode = scan whatever is there now. */
  const handleViewfinderTap = () => {
    if (!rapidOn || !cameraOn || rapidBusyRef.current || rapidPausedRef.current) return;
    const frame = captureGuideCanvas();
    if (!frame) return;
    const machine = machineRef.current;
    if (!machine || !machine.forceScan(canvasSignature(frame))) return;
    setRapidHint(null);
    rapidBusyRef.current = true; // capture below is async — hold the flight slot
    // The tapped frame itself leads the burst (Pass 15 frame-at-detection).
    const tapPrep = prepareCardCanvas(frame);
    retainedFrameRef.current = { prep: tapPrep, at: performance.now() };
    if (tapPrep.rect) noteDetection(tapPrep.rect);
    void (async () => {
      // PASS 32 (Item 2a): the sharpness escalation — re-focus + one
      // re-capture on an all-soft burst.
      // PASS 33: a still-soft burst is NO LONGER handed back unread
      // (the Pass 32 veto): the scan ALWAYS runs — the artwork
      // channel inside identifyBurst tolerates softness and can
      // settle the card on its own. The soft verdict only arms the
      // focus advice for the fail branch (rapidSoftAdviceRef).
      const gated = await captureBurstWithFocusGate(3, { useRetainedFirst: true });
      const preps = gated.preps;
      const head = preps?.[0];
      if (!preps || !head) {
        rapidBusyRef.current = false;
        machine.notifyResult("fail", performance.now());
        return;
      }
      rapidSoftAdviceRef.current = softAttemptPlan(preps.map((p) => p.titleSharpness ?? 0), { snap: false }).advice;
      rapidCanvasRef.current = head.frame; // guide frame — machine signatures are guide-based
      lastCanvasRef.current = head.card;
      await runRapidScan(preps);
    })();
  };

  const toggleRapid = () => {
    if (rapidOn) {
      rapidOnRef.current = false;
      setRapidOn(false);
      rapidPausedRef.current = false;
      setRapidPaused(false);
      setFailedScan(null);
      if (rapidStatsRef.current.count > 0) {
        setSummary({ count: rapidStatsRef.current.count, value: rapidStatsRef.current.value });
      }
    } else {
      rapidStatsRef.current = { count: 0, value: 0 };
      setSummary(null);
      setRapidHint(null);
      setFailedScan(null);
      machineRef.current?.reset();
      rapidDeferRef.current = 0;
      baselinePendingRef.current = true;
      baselinePrevRef.current = [];
      rapidPausedRef.current = false;
      setRapidPaused(false);
      // Rapid forces Fast (resolveRapidMode) — Precise is greyed out while
      // Rapid is on so version detection can never creep back into scans.
      setSpeed("fast");
      speedRef.current = "fast";
      rapidOnRef.current = true;
      setRapidOn(true);
      if (!cameraOn) void startCamera();
    }
  };

  useEffect(() => {
    if (!rapidOn || !cameraOn) return;
    const machine = machineRef.current;
    if (!machine) return;
    const timer = window.setInterval(() => {
      if (rapidBusyRef.current) return;
      const canvas = captureGuideCanvas();
      if (!canvas) return;
      const sig = canvasSignature(canvas);
      if (sig.length === 0) return;
      // PASS 29 — while the Did-you-mean sheet is up, keep feeding
      // the machine SUPPRESSED samples: it watches the scene (a card
      // swap performed during the pause is observed as a departure)
      // but can never fire. Without this the swap was invisible —
      // at resume the machine compared only endpoints, and a new
      // card within the same-card threshold of the picked one was
      // never attempted.
      if (rapidPausedRef.current) {
        machine.sample(sig, canvasTitleSignature(canvas), performance.now(), { suppressed: true });
        return;
      }
      // Baseline adoption: the first stable scene after rapid starts is the
      // empty scene (scanner-box interior / table) — it never scans.
      if (baselinePendingRef.current) {
        const prev = baselinePrevRef.current;
        baselinePrevRef.current = sig;
        if (prev.length > 0 && signatureDiff(sig, prev) < 9) {
          machine.adoptBaseline(sig);
          baselinePendingRef.current = false;
        }
        return;
      }
      // AUTO LIGHT preview metering (Pass 17, throttled to ~900ms):
      // locate the card on the watcher frame and meter its title
      // zone for the hardware layer in Auto mode.
      rapidLightTickRef.current = (rapidLightTickRef.current + 1) % 3;
      if (rapidLightTickRef.current === 0) {
        const lightPrep = prepareCardCanvas(canvas);
        const pm = lightPrep.card ? meterBand(lightPrep.card, TITLE_ZONE) : null;
        if (pm) driveAutoLight(pm.stats.p90);
        updateDarkOffHint(pm ? pm.stats.p90 : null);
      }
      const decision = machine.sample(sig, canvasTitleSignature(canvas), performance.now());
      if (decision.action !== "scan") return;
      // The watcher canvas was only for signatures — the actual read uses
      // a 3-frame burst with the card located + cropped in each. Pass 15:
      // the watcher's OWN sample frame (the scene the machine just
      // approved as stable) is retained and leads the burst, so the
      // first frame read is the frame that triggered the scan.
      const watchPrep = prepareCardCanvas(canvas);
      // PASS 29 — stability is not completeness: a card HELD
      // mid-slide is perfectly still, and firing burns the attempt
      // on the outgoing card (the image channel can even settle it
      // from the partial view — the reported slide-in duplicate).
      // In box mode the rig's seat is a physical fact: if this
      // frame's own detection is measurably displaced from the
      // seat — or there is NO detection, which is what a partial
      // slab touching the frame edge produces (probeup measurement)
      // while a seated box card is detected reliably — hand the
      // fire back and let the card finish its slide. Capped
      // deferrals: a seat the test misjudges must never wedge
      // Rapid, so past the cap the scan fires anyway.
      if (machine.isBoxMode) {
        const seat = boxCalibRef.current ?? freshTrackedRect(trackedRectRef.current, performance.now());
        const incomplete = seat !== null && (watchPrep.detectedRect === null || !presentationComplete(watchPrep.detectedRect, seat));
        if (incomplete && rapidDeferRef.current < 8) {
          rapidDeferRef.current += 1;
          if (machine.deferScan()) return;
        }
      }
      rapidDeferRef.current = 0;
      retainedFrameRef.current = { prep: watchPrep, at: performance.now() };
      if (watchPrep.rect) noteDetection(watchPrep.rect);
      rapidBusyRef.current = true; // hold the flight slot across the async capture
      void (async () => {
        // PASS 32 (Item 2a): the sharpness escalation, same as the
        // tap path — re-focus + one re-capture on an all-soft burst.
        // PASS 33: still-soft no longer skips the reader — the scan
        // ALWAYS runs (the artwork channel carries soft bursts in
        // Rapid; no stills at this cadence), and the soft verdict
        // only arms the focus advice for the fail branch.
        const gated = await captureBurstWithFocusGate(3, { useRetainedFirst: true });
        const preps = gated.preps;
        const head = preps?.[0];
        if (!preps || !head) {
          rapidBusyRef.current = false;
          machine.notifyResult("fail", performance.now());
          return;
        }
        rapidSoftAdviceRef.current = softAttemptPlan(preps.map((p) => p.titleSharpness ?? 0), { snap: false }).advice;
        rapidCanvasRef.current = head.frame; // guide frame — machine signatures are guide-based
        lastCanvasRef.current = head.card;
        await runRapidScan(preps);
      })();
    }, 250);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rapidOn, cameraOn, batchFoil, batchAutoAdd, index]);

  // Live card detection for the placement hint (Pass 9, manual mode
  // only — Rapid runs its own watcher): every ~800ms the guide frame
  // is searched for a card, so the "CARD FOUND" outline and the
  // distance hint stay LIVE while the user aims, instead of only
  // updating after a Snap. Detection runs on the ~480px downscale
  // inside detectInCanvas, so the cost is a few tens of ms. Two
  // consecutive misses are required before the hint flips to "no
  // card", so a single soft frame doesn't flicker it.
  useEffect(() => {
    if (!cameraOn || rapidOn) return;
    let misses = 0;
    const timer = window.setInterval(() => {
      if (reading) return;
      const frame = captureGuideCanvas();
      if (!frame) return;
      const det = detectInCanvas(frame);
      // PASS 30 — in box mode a "detection" that cannot be the card
      // at the calibrated seat is not a found card: in darkness the
      // detector returns the lit text box alone at FULL confidence,
      // and the old code raised "✓ Card found — fine at this
      // distance" over that quadrant (Andrew's P1 panel) and
      // retained its frame for the next Snap. An implausible rect
      // counts as a miss here, exactly as it now does inside
      // prepareCardFromFrame and the tracker.
      const detRect = det && det.confidence >= 0.4
        ? expandRect(correctCardAspect(det.rect, frame.width / Math.max(1, frame.height), det.shoulders), 0.015)
        : null;
      const detPlausible = detRect !== null
        && (!boxModeRef.current || !boxCalibRef.current || rectPlausibleVsSeat(detRect, boxCalibRef.current));
      if (detRect && detPlausible) {
        misses = 0;
        setCardPresent(true);
        const rect = detRect;
        setDetectOverlay({ rect, source: "detected" });
        // Retain THIS approved frame for the next Snap (Pass 15):
        // the frame behind the outline the user is looking at right
        // now becomes burst frame 1, so the capture reads the card
        // the hint approved — not a fresh post-tap grab.
        const prep = prepareCardCanvas(frame);
        retainedFrameRef.current = { prep, at: performance.now() };
        // AUTO LIGHT preview metering (Pass 17; latched Pass 24a):
        // the prep's title zone feeds the light latch — dark scenes
        // get torch/exposure engaged BEFORE the user even taps Snap,
        // and the latch's hysteresis/dwell keeps that state steady
        // instead of pulsing with each metering tick.
        const pm = meterBand(prep.card, TITLE_ZONE);
        if (pm) driveAutoLight(pm.stats.p90);
        updateDarkOffHint(pm ? pm.stats.p90 : null);
        // The same success feeds the rect authority (Pass 16): the
        // DETECTION is recorded even though the retained frame will
        // be consumed/expire, and any stale guide-fallback note from
        // an earlier attempt is cleared — one detection state drives
        // the hint, the message, and the read rect.
        if (prep.rect) noteDetection(prep.rect);
        setGuideFallbackNote(false);
      } else {
        misses += 1;
        updateDarkOffHint(null);
        if (misses >= 2) {
          setCardPresent(false);
          retainedFrameRef.current = null;
        }
      }
    }, 800);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn, rapidOn, reading]);

  // ----- scan list sheet helpers -----
  const updateItem = async (id: number, patch: { quantity?: number; foil?: boolean }) => {
    await api.updateScanListItem({ id, ...patch });
    void queryClient.invalidateQueries({ queryKey: ["scanList"] });
  };

  const openItemVersions = async (item: ScanItem) => {
    if (versionOpenId === item.id) { setVersionOpenId(null); setVersionGrid(null); return; }
    setVersionOpenId(item.id);
    setVersionGrid(null);
    if (item.printsSearchUri) {
      // Pass 25: the picker loads EVERY printing (full pagination) —
      // with the 60-newest cap, older printings (all six Swamp #274s
      // included) were unpickable, so a mis-recorded printing could
      // not be corrected to the user's actual card.
      const res = await api.getPrintings({ printsSearchUri: item.printsSearchUri, full: true });
      setVersionGrid(res.printings);
    }
  };

  const openResultVersions = async () => {
    if (!resultItem) return;
    if (resultPrintings) { setResultPrintings(null); return; }
    if (resultItem.printsSearchUri) {
      const res = await api.getPrintings({ printsSearchUri: resultItem.printsSearchUri, full: true });
      setResultPrintings(res.printings);
    }
  };

  const scanItemToCard = (item: ScanItem): CardT => ({
    scryfallId: item.scryfallId,
    name: item.name,
    setCode: item.setCode,
    setName: item.setName,
    collectorNumber: item.collectorNumber,
    rarity: item.rarity,
    manaCost: item.manaCost,
    cmc: item.cmc,
    typeLine: item.typeLine,
    oracleText: item.oracleText,
    colors: item.colors,
    colorIdentity: item.colorIdentity,
    imageSmall: item.imageSmall,
    imageNormal: item.imageNormal,
    priceUsd: item.priceUsd,
    priceUsdFoil: item.priceUsdFoil,
    edhrecRank: item.edhrecRank,
    scryfallUri: item.scryfallUri,
    printsSearchUri: item.printsSearchUri,
    artist: item.artist,
    releasedAt: item.releasedAt,
    finishes: item.finishes,
    // Pass 27: treatment flags aren't persisted on scan rows; the
    // version flows that need them re-fetch printings from Scryfall.
    fullArt: false,
    borderColor: "",
  });

  /**
   * On-demand version detection for ONE scan-list item: fetch the photo that
   * was stored with the item at scan time, run the combined vision read on
   * it, and apply the printing (and ★/• foil signal) it pins down. This is
   * the only place the bottom line is read now — scanning itself is name-only
   * and on-device, so it stays fast.
   */
  const detectVersion = async (item: ScanItem) => {
    if (detectingId !== null) return;
    setDetectingId(item.id);
    setDetectMsg((m) => ({ ...m, [item.id]: "Reading the bottom line from your saved photo…" }));
    try {
      const urlRes = await api.getScanItemImageUrl({ id: item.id });
      if (!urlRes.url) {
        setDetectMsg((m) => ({ ...m, [item.id]: "No saved photo for this card — rescan it and Detect version will work from that scan's photo." }));
        return;
      }
      const blob = await (await fetch(urlRes.url)).blob();
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const c2d = canvas.getContext("2d");
      if (!c2d) throw new Error("Canvas unavailable");
      c2d.drawImage(bmp, 0, 0);
      bmp.close();
      const frame = buildReadFrame(canvas);
      const res = await api.readCardFrame({ imageBase64: frame });
      const bottom: BottomBandRead = {
        collectorNumber: res.collectorNumber,
        setCode: res.setCode,
        separator: res.separator,
        artist: res.artist,
        lines: res.bottomLines,
      };
      const v = await resolveVersion(canvas, scanItemToCard(item), bottom);
      if (v.card.scryfallId !== item.scryfallId) {
        await api.swapScanListPrinting({ id: item.id, card: v.card });
      }
      if (v.info.foilDetected !== null && v.info.foilDetected !== item.foil) {
        await api.updateScanListItem({ id: item.id, foil: v.info.foilDetected });
      }
      void queryClient.invalidateQueries({ queryKey: ["scanList"] });
      setDetectMsg((m) => ({ ...m, [item.id]: v.info.message }));
      if (resultItemId === item.id) {
        setVersionInfo(v.info);
        setResultPrintings(v.printings);
      }
    } catch (err) {
      setDetectMsg((m) => ({ ...m, [item.id]: `Version check didn't finish: ${friendlyError(err, "something went wrong reading the photo — try again.")}` }));
    } finally {
      setDetectingId(null);
    }
  };

  const doMoveToCollection = async () => {
    setCommitting(true);
    setCommitMsg(null);
    try {
      const res = moveTarget === "new"
        ? await api.moveScanListToCollection({ newCollectionName: newCollName.trim() || "New Collection" })
        : await api.moveScanListToCollection({ collectionId: Number(moveTarget) });
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      void queryClient.invalidateQueries({ queryKey: ["scanList"] });
      setCommitMsg(`✓ Moved ${res.moved} card entr${res.moved === 1 ? "y" : "ies"} into “${res.collectionName}”. The scan list is empty — keep scanning to start a new one.`);
      setNewCollName("");
    } catch (err) {
      setCommitMsg(`Move didn't finish: ${friendlyError(err, "something went wrong — your scan list is unchanged, try again.")}`);
    } finally {
      setCommitting(false);
    }
  };

  const doMakeDeck = async () => {
    const name = deckName.trim();
    if (!name) { setCommitMsg("Give the deck a name first."); return; }
    setCommitting(true);
    setCommitMsg(null);
    try {
      const res = await api.makeDeckFromScanList({
        deckName: name,
        commanderScryfallId: deckCommander || undefined,
      });
      void queryClient.invalidateQueries({ queryKey: ["decks"] });
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      void queryClient.invalidateQueries({ queryKey: ["scanList"] });
      void queryClient.invalidateQueries({ queryKey: ["deckMembership"] });
      setCommitMsg(`✓ Deck “${name}” created with ${res.moved} cards, also saved to the collection “${res.collectionName}” — the cards now show “In: ${name}” in that collection. Find it in the Decks tab.`);
      setDeckName("");
      setDeckCommander("");
    } catch (err) {
      setCommitMsg(`Make deck didn't finish: ${friendlyError(err, "something went wrong — your scan list is unchanged, try again.")}`);
    } finally {
      setCommitting(false);
    }
  };

  const doClearList = async () => {
    await api.clearScanList({});
    setConfirmClear(false);
    void queryClient.invalidateQueries({ queryKey: ["scanList"] });
    setCommitMsg("Scan list cleared — nothing was saved.");
  };

  const chipCls = (active: boolean) =>
    `h-8 px-2.5 rounded-full border text-[11px] font-bold backdrop-blur-sm active:scale-95 whitespace-nowrap ${
      active ? "bg-[var(--accent)] text-[var(--accent-text)] border-[var(--accent)]" : "bg-black/70 text-white border-white/30"
    }`;

  // The outline drawn on the viewfinder: in box mode, the TRACKED
  // rect once the tracker holds a lock (Pass 24a — it is the position
  // the next capture will actually read); before any lock, the
  // stored box calibration (the seed the user can align the rig
  // against); otherwise the last live detection.
  const viewOverlay: { rect: CardRect; source: "detected" | "calibration" | "tracked" } | null =
    boxMode && trackedOverlay ? { rect: trackedOverlay, source: "tracked" }
    : boxMode && boxCalib ? { rect: boxCalib, source: "calibration" }
    : detectOverlay;

  // PASS 30 — the tracked outline must not present a sub-rect as the
  // card: when the lock is implausible against the stored
  // calibration (a state the ingestion gate now prevents, but which
  // a session can still carry from before it), the outline is
  // flagged in amber as suspect instead of the confident green
  // "TRACKING CARD (AUTO)".
  const trackedSuspect = !!(
    boxMode && boxCalib && trackedOverlay && viewOverlay?.source === "tracked"
    && !rectPlausibleVsSeat(trackedOverlay, boxCalib)
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-2 overflow-hidden">
      {/* Viewfinder — fills the screen; everything else overlays it */}
      <div ref={containerRef} className="relative flex-1 min-h-0 w-full overflow-hidden rounded-3xl bg-black border border-[var(--border)]">
        <video ref={videoRef} playsInline muted autoPlay onClick={() => handleViewfinderTap()} className="absolute inset-0 w-full h-full object-cover" aria-label="Camera viewfinder — tap to scan now while rapid scan is on" />
        {!cameraOn ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-[var(--dim)] text-sm max-w-72">
              Line the card up inside the gold guide — its name is read right on this device and matched instantly against the downloaded card names. No server round-trip for most cards.
            </p>
            <button type="button" onClick={() => void startCamera()} className="px-6 py-3 rounded-full bg-[var(--accent)] text-[var(--accent-text)] font-bold" aria-label="Start live camera">
              Start live camera
            </button>
            {!namesReady ? <p className="text-xs text-[#e8b34b]">Card database still downloading — matching works once it's ready.</p> : null}
          </div>
        ) : null}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div ref={guideRef} className="relative rounded-lg border-[3px] border-[var(--accent)] shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" style={{ height: "86%", aspectRatio: "5 / 7" }} aria-hidden="true">
            {/* The NAME ZONE (Pass 9, the user's explicit ask): a tall,
                bright, labelled target band — the user lines the card's
                title up inside it. Deliberately much bigger than the
                title itself (18% of the guide height) so hand-held aim
                lands the name inside with room to spare. Placement aid
                only: reading stays detection-based. */}
            <div
              className="mt-[2.5%] mx-[2.5%] border-2 border-[var(--accent)] bg-[var(--accent)]/25 rounded-md flex items-center justify-center"
              style={{ height: `${GUIDE_NAME_ZONE.heightFrac * 100}%` }}
            >
              <span className="text-[13px] font-bold tracking-[0.22em] text-white" style={{ textShadow: "0 1px 5px rgba(0,0,0,0.9)" }}>
                {GUIDE_NAME_ZONE.label}
              </span>
            </div>
            {viewOverlay ? (
              <div
                className="absolute rounded-md"
                style={{
                  left: `${viewOverlay.rect.x0 * 100}%`,
                  top: `${viewOverlay.rect.y0 * 100}%`,
                  width: `${(viewOverlay.rect.x1 - viewOverlay.rect.x0) * 100}%`,
                  height: `${(viewOverlay.rect.y1 - viewOverlay.rect.y0) * 100}%`,
                  border: `2px solid ${trackedSuspect ? "#e8b34b" : viewOverlay.source === "detected" ? "#9fc3e8" : "#7bc47f"}`,
                  boxShadow: "0 0 0 1px rgba(0,0,0,0.55)",
                }}
              >
                <span className="absolute left-0 -top-5 px-1.5 py-0.5 rounded bg-black/75 text-[9px] font-bold text-white whitespace-nowrap">
                  {viewOverlay.source === "calibration" ? "CALIBRATED CARD AREA" : viewOverlay.source === "tracked" ? (trackedSuspect ? "TRACKING — OUTLINE TOO SMALL, CHECK LIGHT" : "TRACKING CARD (AUTO)") : "CARD FOUND"}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        {/* Top chip row — all batch/rapid/speed/light/box controls live here.
            Single scrollable row so it never wraps over the guide. */}
        <div className="absolute inset-x-2 top-2 flex flex-nowrap gap-1.5 overflow-x-auto [&>*]:shrink-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button type="button" role="switch" aria-checked={rapidOn} aria-label="Rapid scan" onClick={toggleRapid} className={chipCls(rapidOn)}>
            ⚡ Rapid{rapidOn ? " ✓" : ""}
          </button>
          <button type="button" role="switch" aria-checked={batchFoil} aria-label="Foil for the whole batch" onClick={() => setBatchFoil(!batchFoil)} className={chipCls(batchFoil)}>
            ★ Foil{batchFoil ? " ✓" : ""}
          </button>
          <button type="button" role="switch" aria-checked={batchAutoAdd} aria-label="Auto-add matches to scan list" onClick={() => setBatchAutoAdd(!batchAutoAdd)} className={chipCls(batchAutoAdd)}>
            Auto-add{batchAutoAdd ? " ✓" : ""}
          </button>
          <button
            type="button"
            aria-label={rapidOn ? "Speed mode — Rapid always uses Fast" : `Speed mode ${speed} — tap to change`}
            disabled={rapidOn}
            onClick={() => { const next = speed === "fast" ? "precise" : "fast"; setSpeed(next); speedRef.current = next; }}
            className={`${chipCls(speed === "precise" && !rapidOn)} disabled:opacity-45`}
          >
            {rapidOn ? "⚡ Fast (Rapid)" : speed === "fast" ? "⚡ Fast" : "🎯 Precise"}
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={lightMode !== "off"}
            aria-label={`Light mode ${lightMode} — tap to cycle Auto, On, Manual, Off${cameraOn && torchSup === "unsupported" ? ". No torch in this browser; the light still brightens dark reads in software" : ""}`}
            onClick={() => void cycleLightMode()}
            className={chipCls(lightMode !== "off")}
          >
            {lightChipText(lightMode, { unsupported: cameraOn && torchSup === "unsupported", torchActive })}
          </button>
          <button type="button" role="switch" aria-checked={boxMode} aria-label="Scanner box mode — fixed scanning rig with continuous autofocus" onClick={() => void toggleBoxMode()} className={chipCls(boxMode)}>
            📦 Box{boxMode ? " ✓" : ""}
          </button>
          {boxMode ? (
            <button type="button" onClick={() => void calibrateBox()} aria-label={boxCalib ? "Re-calibrate the scanner box card position" : "Calibrate the scanner box — capture the card position once"} className={chipCls(!!boxCalib)}>
              🎯 {boxCalib ? "Calibrated ✓" : "Calibrate box"}
            </button>
          ) : null}
          <button type="button" aria-label="How scanning works" onClick={() => setShowHelp(true)} className={chipCls(false)}>
            ?
          </button>
        </div>

        {reading ? (
          <div className="absolute inset-x-0 bottom-3 flex justify-center pointer-events-none">
            <span className="px-4 py-2 rounded-full bg-black/75 text-sm">{pendingMatch ? `✓ ${pendingMatch} — fetching details…` : "Reading card…"}</span>
          </div>
        ) : null}
        {flash ? (
          <div className="absolute inset-x-0 top-14 flex justify-center pointer-events-none" role="status">
            <span className="flex items-center gap-2 px-4 py-2 rounded-full bg-[#1d2b1d]/95 border border-[var(--good)] text-sm font-bold shadow-lg">
              {flash.image ? <img src={flash.image} alt="" className="w-7 rounded" /> : null}
              ✓ Added {flash.name}{flash.foil ? " ★ foil" : ""}
              {flash.note ? <span className="font-semibold text-[var(--foil)]">· {flash.note}</span> : null}
              {flash.itemId ? (
                <button
                  type="button"
                  onClick={undoFlashAdd}
                  className="pointer-events-auto underline font-bold text-[var(--foil)] ml-1"
                  aria-label={`Undo adding ${flash.name} to the scan list`}
                >
                  Undo
                </button>
              ) : null}
            </span>
          </div>
        ) : null}
        {rapidOn && cameraOn && !flash ? (
          <div className="absolute inset-x-0 top-14 flex justify-center pointer-events-none">
            <span className="px-3 py-1.5 rounded-full bg-black/70 text-[11px] font-semibold text-center">
              {rapidPaused ? "⏸ Rapid paused — pick a match or Skip" : "⚡ Rapid watching… slide a card in, or tap the view to scan now"}
            </span>
          </div>
        ) : null}
        {summary && !rapidOn ? (
          <div className="absolute inset-x-2 bottom-3 flex justify-center">
            <span className="px-4 py-2 rounded-2xl bg-[#1d2b1d]/95 border border-[var(--good)] text-xs font-semibold text-center">
              Session done: {summary.count} card{summary.count === 1 ? "" : "s"} added to your scan list, worth about {formatMoney(summary.value)}.
              <button type="button" className="underline font-bold ml-1 pointer-events-auto" aria-label="Open scan list after session" onClick={() => setShowList(true)}>Review list →</button>
            </span>
          </div>
        ) : null}
      </div>

      {/* Live placement hint (Pass 9): driven by the live detection
          above — a found card is fine at ANY distance (bands crop from
          the detected card, and Snap re-captures small cards from a
          full-resolution still), so the hint says so instead of asking
          the user to move closer. Rapid shows its own watcher pill and
          needs no hint here. */}
      {cameraOn && !rapidOn ? (
        <p className={`text-[11px] font-semibold ${trackedSuspect ? "text-[#e8b34b]" : cardPresent ? "text-[var(--good)]" : "text-[var(--dim)]"}`} role="status">
          {trackedSuspect
            ? "⚠ The tracked outline looks too small for the card — too dark to see the whole card. Add light or use the Light control, then Snap"
            : cardPresent
              ? "✓ Card found — fine at this distance, tap Snap"
              : "Place the card inside the outline, with its name in the top band"}
        </p>
      ) : null}
      {cameraError ? (
        <div className="rounded-xl border border-[var(--danger)] bg-[#2a1a1a] px-3 py-2" role="alert">
          <p className="text-xs">{cameraError}</p>
        </div>
      ) : null}
      {readError && !resultItem && !candidates ? (
        <div className="rounded-xl border border-[var(--danger)] bg-[#2a1a1a] px-3 py-2" role="alert">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs flex-1">{readError}</p>
            <button
              type="button"
              onClick={() => { setReadError(null); setFailedScan(null); }}
              className="h-7 px-2.5 shrink-0 rounded-full bg-[var(--surface)] border border-[var(--border)] text-[11px] font-semibold"
              aria-label="Dismiss scan error and return to the camera"
            >
              Dismiss ✕
            </button>
          </div>
          {rawRead ? <p className="text-[11px] text-[var(--dim)] mt-1">Read as: {rawRead}</p> : null}
          {scanPreview ? <img src={scanPreview} alt="Your photo with the detected card outline drawn on it" className="mt-2 w-44 rounded-lg border border-[var(--border)]" /> : null}
          {scanDebug ? <ScanDebugBlock debug={scanDebug} context="failure" /> : null}
          {failedScan && !rapidOn ? (
            <button
              type="button"
              disabled={slowReading || reading}
              onClick={() => void trySlowRead()}
              className="mt-2 h-9 px-4 rounded-full bg-[var(--surface)] border border-[var(--foil)]/70 text-xs font-bold disabled:opacity-50"
              aria-label="Try the slower server read on the card that could not be identified"
            >
              {slowReading ? "Slow read running…" : "🐢 Try slow read for that card"}
            </button>
          ) : null}
        </div>
      ) : null}
      {toast ? (
        <div className="rounded-xl bg-[#1d2b1d] border border-[var(--good)] px-3 py-2 text-xs" role="status">✓ {toast}</div>
      ) : null}
      {rapidHint && rapidOn ? <p className="text-[11px] text-[#e8b34b]" role="status">{rapidHint}</p> : null}
      {/* Guide-fallback note (Pass 16): driven by the SAME cardPresent
          state as the placement hint above, so it can never appear
          next to "✓ Card found" — it shows only while the scanner
          agrees no card is currently detected, and the next live
          detection clears it. */}
      {guideFallbackNote && !cardPresent ? (
        <p className="text-[11px] text-[var(--foil)]" role="status">
          Card outline not found — using the guide area. Filling the guide with the card reads better.
        </p>
      ) : null}
      {scanNote ? <p className="text-[11px] text-[var(--foil)]" role="status">{scanNote}</p> : null}
      {/* PASS 32 (Item 3a): the scene meters dark (the Auto layer
          would engage here) but Light is Off — say so where the
          user can act on it. Non-blocking; never auto-switches. */}
      {darkOffHint && cameraOn ? (
        <p className="text-[11px] font-bold text-[#e8b34b]" role="status">
          🌒 Scene is dark and Light is Off — tap the light chip for Auto so the scanner can brighten the card.
        </p>
      ) : null}
      {rapidOn && failedScan ? (
        <button
          type="button"
          disabled={slowReading || reading}
          onClick={() => void trySlowRead()}
          className="self-start h-9 px-4 rounded-full bg-[var(--surface)] border border-[var(--foil)]/70 text-xs font-bold disabled:opacity-50"
          aria-label="Try the slower server read on the card that could not be identified"
        >
          {slowReading ? "Slow read running…" : "🐢 Try slow read for that card"}
        </button>
      ) : null}
      {/* MANUAL LIGHT control (Pass 22 levels; Pass 30 SLIDER):
          shown while the Light chip is in Manual mode. The slider
          sets the exposure boost continuously (×1.0–×4.0); the
          preset buttons are its named stops (Off/Low/Med/High/Max)
          and stay in sync both ways. The value drives the same
          exposure-lift pipeline Auto uses, deterministically — see
          autolight.ts liftForMode — and scales the torch/exposure
          hardware where the browser exposes it. Changes land
          between attempts, never mid-read. */}
      {lightMode === "manual" ? (
        <div className="rounded-xl bg-[var(--surface)] border border-[var(--border)] px-3 py-2" role="group" aria-label="Manual light">
          <p className="text-[11px] font-bold">💡 Manual light — exposure boost ×{manualGain.toFixed(1)}</p>
          <input
            type="range"
            min={MANUAL_GAIN_MIN}
            max={MANUAL_GAIN_MAX}
            step={0.1}
            value={manualGain}
            aria-label={`Manual light boost slider, currently times ${manualGain.toFixed(1)}`}
            onChange={(e) => setManualGain(Number(e.target.value))}
            onPointerUp={() => setManualGain(manualGainRef.current, { hardware: true })}
            onKeyUp={() => setManualGain(manualGainRef.current, { hardware: true })}
            className="w-full h-11 accent-[var(--accent)] cursor-pointer"
          />
          <div className="flex gap-1.5">
            {MANUAL_PRESETS.map((lv) => (
              <button
                key={lv.label}
                type="button"
                aria-pressed={Math.abs(manualGain - lv.gain) < 0.05}
                aria-label={`Manual light ${lv.label}, exposure boost times ${lv.gain}`}
                onClick={() => setManualGain(lv.gain, { hardware: true })}
                className={`flex-1 h-9 rounded-full border text-xs font-bold ${Math.abs(manualGain - lv.gain) < 0.05 ? "bg-[var(--accent)] text-[var(--accent-text)] border-[var(--accent)]" : "bg-[var(--surface2)] text-[var(--text)] border-[var(--border)]"}`}
              >
                {lv.label}
              </button>
            ))}
          </div>
          {cameraOn && torchSup === "unsupported" ? (
            <p className="text-[10px] text-[var(--dim)] mt-1.5" role="status">
              Flashlight unavailable in this browser — exposure boost only; open in Chrome for the torch.
            </p>
          ) : (
            <p className="text-[10px] text-[var(--dim)] mt-1.5">
              Applies this boost to every read, whatever the light meter says. The flashlight is forced on where this browser allows it.
            </p>
          )}
        </div>
      ) : null}
      {cameraOn && torchSup === "unsupported" ? (
        <p className="text-[10px] text-[var(--dim)]" role="status">
          Light unavailable: this browser reports torch = {torchDiag.capability}
          {torchDiag.lastError ? `; last light error: ${torchDiag.lastError}` : ""}.
          If you're viewing this page inside another app, open it in Chrome — in-app browsers often hide the torch.
        </p>
      ) : null}

      {/* Bottom action bar — always on screen */}
      <div className="flex gap-2">
        <button type="button" disabled={!cameraOn || reading} onClick={() => void captureFromCamera()} className="flex-1 h-13 py-3 rounded-2xl bg-[var(--accent)] text-[var(--accent-text)] text-base font-bold disabled:opacity-40" aria-label="Snap and identify card">
          📸 Snap
        </button>
        <button type="button" onClick={() => takePhotoRef.current?.click()} className="flex-1 h-13 py-3 rounded-2xl bg-[var(--surface)] border border-[var(--border)] text-sm font-semibold" aria-label="Take a photo of a card">
          Take Photo
        </button>
        <button type="button" onClick={() => { setShowList(true); setCommitMsg(null); }} className="relative flex-1 h-13 py-3 rounded-2xl bg-[var(--surface)] border border-[var(--accent)]/60 text-sm font-bold" aria-label={`Open scan list, ${listCount} cards`}>
          📋 List
          {listCount > 0 ? <span className="absolute -top-1.5 -right-1.5 min-w-6 h-6 px-1 rounded-full bg-[var(--accent)] text-[var(--accent-text)] text-xs font-bold flex items-center justify-center">{listCount}</span> : null}
        </button>
        {cameraOn ? (
          <button type="button" onClick={() => { if (rapidOn) toggleRapid(); stopCamera(); }} className="h-13 px-4 py-3 rounded-2xl bg-[var(--surface)] border border-[var(--border)] text-sm font-semibold" aria-label="Stop camera">
            Stop
          </button>
        ) : (
          <button type="button" onClick={() => uploadRef.current?.click()} className="h-13 px-4 py-3 rounded-2xl bg-[var(--surface)] border border-[var(--border)] text-sm font-semibold" aria-label="Upload a photo of a card">
            Upload
          </button>
        )}
      </div>
      <div className="text-[11px] text-[var(--dim)]" role="status">
        <p>{listCount > 0 ? `Scan list: ${listCount} card${listCount === 1 ? "" : "s"} · ${formatMoney(listValue)}` : "Scan list is empty — scanned cards land here first"}</p>
        <p className="text-[10px] flex flex-wrap gap-x-1.5 mt-0.5">
          <span className="whitespace-nowrap">{ocrStatus === "ready" ? "Scanner ready (on-device)" : ocrStatus === "error" ? "On-device scanner unavailable — scans use the slow read" : "Scanner warming up…"}</span>
          {lastScan ? <span className="whitespace-nowrap">· Last scan: {lastScan.sec}s ({lastScan.path === "device" ? "on-device" : "slow read"})</span> : null}
          {captureRes ? <span className="whitespace-nowrap">· Capture: {captureRes}</span> : null}
        </p>
      </div>
      <input ref={takePhotoRef} type="file" accept="image/*" capture="environment" className="hidden" aria-label="Take photo input" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handlePhotoFile(f); e.target.value = ""; }} />
      <input ref={uploadRef} type="file" accept="image/*" className="hidden" aria-label="Upload photo input" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handlePhotoFile(f); e.target.value = ""; }} />

      {/* Did-you-mean bottom sheet */}
      {candidates ? (
        <div className="absolute inset-x-0 bottom-0 z-20 max-h-[85%] overflow-y-auto rounded-t-3xl bg-[var(--surface)] border-t-2 border-[var(--accent)] p-4 shadow-2xl" role="dialog" aria-label="Possible matches">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-lg">Did you mean?</h3>
            <button type="button" onClick={() => { setCandidates(null); setCandidatesImage(null); if (rapidOn) resumeRapid(); }} className="h-9 px-3 rounded-full bg-[var(--surface2)] border border-[var(--border)] text-xs font-semibold" aria-label="Close match choices">
              {rapidOn ? "Skip this card" : "Close"}
            </button>
          </div>
          {candidatesImage && candidates[0]?.entry.full === candidatesImage.name ? (
            <button type="button" disabled={reading} onClick={() => void useImageMatchAnyway(candidatesImage)} className="mt-3 w-full text-left px-4 py-3 rounded-xl bg-[var(--surface2)] border-2 border-[var(--accent)] active:scale-[0.99] disabled:opacity-50" aria-label={`Use the artwork match anyway and add the exact printing ${candidatesImage.setCode.toUpperCase()} number ${candidatesImage.collectorNumber}`}>
              <span className="font-semibold">Use this artwork match anyway</span>
              <span className="block text-xs text-[var(--dim)] mt-0.5">The scanner held this back out of caution (a dim or unsteady capture). This adds the exact printing the artwork matched — {candidatesImage.setCode.toUpperCase()} #{candidatesImage.collectorNumber} — not just the card name.</span>
            </button>
          ) : null}
          {rawRead ? <p className="text-xs text-[var(--dim)] mt-1">Read as: {rawRead}</p> : null}
          {scanPreview ? <img src={scanPreview} alt="Your photo with the detected card outline drawn on it" className="mt-2 w-44 rounded-lg border border-[var(--border)]" /> : null}
          {scanDebug ? <ScanDebugBlock debug={scanDebug} context="didyoumean" /> : null}
          <div className="mt-3 space-y-2">
            {candidates.map((m) => (
              <button key={m.entry.full} type="button" disabled={reading} onClick={() => void selectMatch(m)} className="w-full text-left px-4 py-3 rounded-xl bg-[var(--surface2)] border border-[var(--border)] active:scale-[0.99]" aria-label={`Use match ${m.entry.face}`}>
                <span className="font-semibold">{m.entry.face}</span>
                <span className="text-[var(--dim)] text-sm"> · {Math.round(m.score * 100)}% match</span>
                {m.entry.face !== m.entry.full ? <span className="block text-xs text-[var(--dim)]">Face of {m.entry.full}</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Result bottom sheet — the just-scanned card, already in the scan list */}
      {resultItem && !candidates ? (
        <div className="absolute inset-x-0 bottom-0 z-20 max-h-[88%] overflow-y-auto rounded-t-3xl bg-[var(--surface)] border-t-2 border-[var(--good)] p-4 shadow-2xl" role="dialog" aria-label={`Scanned card ${resultItem.name}`}>
          <div className="flex gap-3">
            {resultItem.imageNormal ? (
              <FoilImage src={resultItem.imageNormal} alt={resultItem.name} foil={resultItem.foil} className="w-24 shrink-0 self-start rounded-xl" imgClassName="w-full rounded-xl" />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold text-[var(--good)]">✓ IN YOUR SCAN LIST</p>
              <h3 className="font-display text-lg leading-tight">{resultItem.name}</h3>
              <p className="text-xs text-[var(--dim)] mt-0.5">{resultItem.setName} ({resultItem.setCode.toUpperCase()}) #{resultItem.collectorNumber} · {resultItem.rarity}</p>
              {!resultItem.printingConfirmed ? (
                <span className="inline-block mt-1 px-2 py-0.5 rounded-full border border-[var(--accent)] text-[var(--accent)] text-[11px] font-bold">Printing unconfirmed — the name matched; pick the version below if this isn't your printing</span>
              ) : null}
              <p className="text-xs mt-0.5">{resultItem.typeLine}</p>
              <p className="text-base font-bold text-[var(--accent)] mt-1">{formatMoney(resultItem.foil ? resultItem.priceUsdFoil ?? resultItem.priceUsd : resultItem.priceUsd)} <span className="text-[11px] text-[var(--dim)] font-normal">{resultItem.foil ? "foil price" : "price"}</span></p>
            </div>
            <button type="button" onClick={() => { setResultItemId(null); setVersionInfo(null); setResultPrintings(null); }} className="h-9 px-3 shrink-0 rounded-full bg-[var(--surface2)] border border-[var(--border)] text-xs font-semibold" aria-label="Close scanned card panel">
              Done
            </button>
          </div>
          {versionInfo ? (
            <p className={`text-xs rounded-xl px-3 py-2 border mt-3 ${versionInfo.status === "detected" ? "border-[var(--good)] bg-[#1d2b1d]" : versionInfo.status === "guess" ? "border-[#e8b34b] bg-[#2b2417]" : "border-[var(--border)] bg-[var(--surface2)] text-[var(--dim)]"}`} role="status">
              {versionInfo.message}
              {versionInfo.foilDetected === true ? " The ★ by the set code means foil/etched, so Foil was ticked on." : versionInfo.foilDetected === false ? " The • by the set code means non-foil." : ""}
            </p>
          ) : null}
          {scanDebug ? <ScanDebugBlock debug={scanDebug} context="success" /> : null}
          {resultItem.hasCardImage ? (
            <div className="mt-3 flex items-center gap-3 flex-wrap">
              <button type="button" disabled={detectingId !== null} onClick={() => void detectVersion(resultItem)} className="h-10 px-4 rounded-full bg-[var(--surface2)] border border-[var(--foil)]/70 text-sm font-bold disabled:opacity-50" aria-label="Detect the exact version of this scanned card from its saved photo">
                {detectingId === resultItem.id ? "Detecting version…" : "🔍 Detect version"}
              </button>
              {detectMsg[resultItem.id] ? <span className="text-xs text-[var(--dim)]" role="status">{detectMsg[resultItem.id]}</span> : null}
            </div>
          ) : null}
          <div className="flex items-center gap-3 mt-3 flex-wrap">
            <button type="button" role="switch" aria-checked={resultItem.foil} aria-label="Foil for this scanned card" onClick={() => void updateItem(resultItem.id, { foil: !resultItem.foil })} className={`h-10 px-4 rounded-full border-2 text-sm font-bold ${resultItem.foil ? "border-[var(--foil)] bg-[#1d2735]" : "border-[var(--border)] bg-[var(--surface2)]"}`}>
              ★ Foil: {resultItem.foil ? "on" : "off"}
            </button>
            <QtyStepper small value={resultItem.quantity} label={`quantity of ${resultItem.name} in scan list`} onChange={(v) => void updateItem(resultItem.id, { quantity: v })} />
            {resultItem.printsSearchUri ? (
              <button type="button" onClick={() => void openResultVersions()} className="text-sm underline text-[var(--foil)]" aria-label="See all versions of the scanned card and pick a different printing">
                {resultPrintings ? "Hide versions" : "All versions"}
              </button>
            ) : null}
            <button type="button" onClick={() => { void updateItem(resultItem.id, { quantity: 0 }); setResultItemId(null); }} className="text-sm underline text-[var(--danger)]" aria-label="Remove scanned card from scan list">
              Remove from list
            </button>
          </div>
          {resultPrintings ? (
            <PrintingGrid printings={resultPrintings} currentId={resultItem.scryfallId} foil={resultItem.foil} onPick={(p) => { void (async () => { await api.swapScanListPrinting({ id: resultItem.id, card: p }); void queryClient.invalidateQueries({ queryKey: ["scanList"] }); setVersionInfo({ status: "detected", message: `Version chosen by you: ${p.setName} (${p.setCode.toUpperCase()}) #${p.collectorNumber}.`, foilDetected: versionInfo?.foilDetected ?? null }); })(); }} />
          ) : null}
          <button type="button" onClick={() => setShowList(true)} className="mt-3 w-full h-11 rounded-xl bg-[var(--surface2)] border border-[var(--accent)]/60 text-sm font-bold" aria-label="Open the scan list">
            Review scan list ({listCount}) →
          </button>
        </div>
      ) : null}

      {/* Help sheet */}
      {showHelp ? (
        <div className="absolute inset-x-0 bottom-0 z-20 max-h-[85%] overflow-y-auto rounded-t-3xl bg-[var(--surface)] border-t-2 border-[var(--accent)] p-4 shadow-2xl" role="dialog" aria-label="How scanning works">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-lg">How scanning works</h3>
            <button type="button" onClick={() => setShowHelp(false)} className="h-9 px-3 rounded-full bg-[var(--surface2)] border border-[var(--border)] text-xs font-semibold" aria-label="Close help">Close</button>
          </div>
          <div className="text-sm text-[var(--dim)] space-y-2 mt-2">
            <p>The app <strong className="text-[var(--text)]">finds the card first, then reads it</strong>: every capture is searched for the card's outline (the rectangle drawn on the viewfinder), and the bands are cropped from the card itself — so a card sitting small in a scanner box reads just as well as one filling the guide. <strong className="text-[var(--text)]">Distance doesn't matter</strong>: line the card's name up in the bright <strong className="text-[var(--text)]">CARD NAME HERE</strong> band at the top of the guide, near or far — when a card is small in the frame, Snap automatically re-captures it from a full-resolution photo so the type stays readable. Each scan captures a <strong className="text-[var(--text)]">burst of 3 frames</strong> and pools the evidence, and every read runs against a hard deadline: a scan always settles within a few seconds with the best evidence it has (name fragments pooled, then the collector number), never hanging on one stuck read. The strongest evidence is the <strong className="text-[var(--text)]">collector number + set code</strong> printed at the bottom of the card (e.g. “177/184 AER”): that pair identifies the exact printing outright. Otherwise the name band is read <strong className="text-[var(--text)]">right on this device</strong> and matched against the 35,000+ names downloaded to your phone — <strong className="text-[var(--text)]">tokens included</strong>: Scryfall's main name catalog leaves token printings out, so the download also merges the token names from Scryfall's token sets, and a token's bottom line (which prints its parent set, e.g. “T 0001 FRA”) is looked up in the token set too (TFRA #1). Basic lands scan the same way — a full-art land's bottom line (“L 0384 FRA”) pins its exact printing. When a scan matches only the name (the bottom line couldn't be read), nothing pretends otherwise: the scan list badges the card <strong className="text-[var(--text)]">“Printing unconfirmed”</strong> and the printing shown is the default for that name — tap the printing line or <strong className="text-[var(--text)]">All versions</strong> on its row to pick your exact printing. The version list covers <strong className="text-[var(--text)]">every</strong> printing of the card, not just recent ones (a basic land has hundreds), with a filter box to find yours. Every result shows a <strong className="text-[var(--text)]">“What the scanner read”</strong> section — tap its header to open or close it. Inside: the raw text, which evidence won, the capture resolution (also under the buttons), and pictures of the exact bands that were read — so any miss can be diagnosed from one screenshot. It starts closed on successful scans and open when a scan fails. A card that has been identified is final: nothing still reading in the background can pop an error over its result, and if a read ever does time out the scanner resets itself back to ready — no page refresh needed. Snap runs the same on-device burst as Rapid; only in 🎯 Precise mode does a card the device can't read fall back automatically to a slower server read (labelled “slow read”) — otherwise the slow read is a button on the failure panel. If the bottom line was read but garbled (a digit misread), the app scores it against the card's printings and can still pin the version — the result then says “Version matched from the bottom line”.</p>
            <p><strong className="text-[var(--text)]">📦 Box mode + 🎯 Calibrate box:</strong> slide any card fully into your rig and tap Calibrate box once — that gives the tracker its starting position (green outline). From then on the scanner keeps tracking the card continuously: every scan checks the tracked position against the card in front of the camera right now, and when a new card slides in the tracker re-locks onto it by itself — no recalibrating between cards. Calibrate again only if you move the phone in the rig. The camera autofocuses continuously where the browser exposes it (in Box mode too — the rig distance is fixed, but autofocus holds it exactly), exposure stays automatic so frames don't go black, and a very dark capture is retaken once with exposure raised. Each scan's panel also reports the burst frames' sharpness, so a soft capture is visible in the diagnostics.</p>
            <p><strong className="text-[var(--text)]">Version detection is on demand:</strong> each scan saves a photo of the card with its scan-list entry. Tap <strong className="text-[var(--text)]">Detect version</strong> on any listed card and the app reads the tiny print at the bottom of that photo (collector number, set code, ★ = foil / • = non-foil, artist) to pin the exact printing. <strong className="text-[var(--text)]">Precise</strong> mode also lets Detect version make a visual best-guess for odd frames (old borders, Secret Lair layouts); <strong className="text-[var(--text)]">Fast</strong> sticks to the bottom-line evidence.</p>
            <p>Every scanned card lands in the <strong className="text-[var(--text)]">scan list</strong> first — remove extras, fix foil/quantities/versions there, then move the whole list into a collection or turn it into a deck.</p>
            <p>Rapid scan fires automatically once a new card sits still (~600ms) and <strong className="text-[var(--text)]">only ever reads on-device</strong> — it never waits on the slow server read, and it forces Fast mode while it's on. A card that fails is retried while it stays in the guide, tapping the camera view scans immediately, and an unrecognised card gets a manual <strong className="text-[var(--text)]">“Try slow read”</strong> button instead. If any read ever hangs, a watchdog resets the scanner after 8 seconds — no page refresh needed. The live camera needs HTTPS, which is how this app is hosted.</p>
            <p><strong className="text-[var(--text)]">Light diagnostics:</strong> this camera reports torch capability = <strong className="text-[var(--text)]">{torchDiag.capability}</strong>; last light error = <strong className="text-[var(--text)]">{torchDiag.lastError ?? "none"}</strong>. If the capability is false or absent and you're viewing this page inside another app's built-in browser, open the page in Chrome instead — in-app webviews commonly hide the torch from web pages.</p>
          </div>
        </div>
      ) : null}

      {/* Scan list sheet — full-screen overlay */}
      {showList ? (
        <div className="absolute inset-0 z-30 flex flex-col bg-[var(--bg)]" role="dialog" aria-label="Scan list">
          <div className="flex items-center justify-between gap-2 py-2">
            <h3 className="font-display text-lg">Scan list · {listCount} card{listCount === 1 ? "" : "s"}</h3>
            <span className="text-sm font-bold text-[var(--accent)]">{formatMoney(listValue)}</span>
            <button type="button" onClick={() => setShowList(false)} className="h-10 px-4 rounded-full bg-[var(--surface)] border border-[var(--border)] text-sm font-semibold" aria-label="Close scan list, keep scanning">
              Keep scanning
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-0.5">
            {scanItems.length === 0 ? (
              <div className="rounded-3xl bg-[var(--surface)] border border-dashed border-[var(--border)] p-6 text-center">
                <p className="font-display text-lg">Nothing scanned yet</p>
                <p className="text-sm text-[var(--dim)] mt-1">Snap or rapid-scan cards and they'll wait here until you move them into a collection or a deck.</p>
              </div>
            ) : null}
            {scanItems.length > 0 ? (
              <p className="text-xs font-bold text-[var(--dim)] pt-1">
                Scanned cards — every scan is listed here. Remove extras or fix quantities before you move the list.{dupKinds > 0 ? ` ${dupKinds} card${dupKinds === 1 ? "" : "s"} scanned more than once (badged ×N).` : ""}
              </p>
            ) : null}
            {scanItems.map((item) => (
              <div key={item.id} className={`rounded-2xl bg-[var(--surface)] border p-3 ${item.quantity > 1 ? "border-[var(--accent)]/70" : "border-[var(--border)]"}`}>
                <div className="flex gap-3">
                  {item.imageSmall ? <FoilImage src={item.imageSmall} alt={item.name} foil={item.foil} className="w-12 shrink-0 self-start rounded-lg" imgClassName="w-full rounded-lg" /> : null}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold leading-tight truncate">
                      {item.name}
                      {item.quantity > 1 ? (
                        <span className="ml-2 align-middle px-2 py-0.5 rounded-full bg-[var(--accent)] text-[var(--accent-text)] text-[11px] font-bold" aria-label={`${item.quantity} copies in the scan list — scanned more than once`}>
                          ×{item.quantity} in list
                        </span>
                      ) : null}
                    </p>
                    {/* Pass 25 (Item 3): the recorded printing is a
                        first-class line of its own — set code +
                        collector number in full-weight text plus the
                        set name — not fused into the dim meta line
                        where the user could not find it. Tapping it
                        opens the version picker. */}
                    {item.printsSearchUri ? (
                      <button type="button" onClick={() => void openItemVersions(item)} className="mt-0.5 block max-w-full text-left" aria-label={`Recorded printing of ${item.name}: ${item.setName}, ${printingLine(item)}. Tap to see all versions and pick a different printing`}>
                        <span className="text-sm font-bold">{printingLine(item) || item.setCode.toUpperCase()}</span>
                        <span className="text-xs text-[var(--dim)]"> · {item.setName}</span>
                      </button>
                    ) : (
                      <p className="mt-0.5">
                        <span className="text-sm font-bold">{printingLine(item) || item.setCode.toUpperCase()}</span>
                        <span className="text-xs text-[var(--dim)]"> · {item.setName}</span>
                      </p>
                    )}
                    {!item.printingConfirmed ? (
                      <button type="button" onClick={() => void openItemVersions(item)} className="mt-1 px-2 py-0.5 rounded-full border border-[var(--accent)] text-[var(--accent)] text-[11px] font-bold" aria-label={`Printing unconfirmed for ${item.name}: the scan matched the name only and this is the default printing. Tap to pick the exact version`}>
                        Printing unconfirmed — tap to pick the version
                      </button>
                    ) : null}
                    <p className="text-xs text-[var(--dim)] mt-0.5">{item.rarity} · {formatMoney(item.foil ? item.priceUsdFoil ?? item.priceUsd : item.priceUsd)}{item.foil ? " · FOIL ★" : ""}</p>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <QtyStepper small value={item.quantity} label={`quantity of ${item.name} in scan list`} onChange={(v) => void updateItem(item.id, { quantity: v })} />
                      <button type="button" onClick={() => void updateItem(item.id, { foil: !item.foil })} className="h-8 px-3 rounded-full bg-[var(--surface2)] border border-[var(--border)] text-xs font-semibold" aria-label={`Toggle foil for ${item.name} in scan list`}>
                        {item.foil ? "Make non-foil" : "Make foil"}
                      </button>
                      {item.printsSearchUri ? (
                        <button type="button" onClick={() => void openItemVersions(item)} className="h-8 px-3 rounded-full bg-[var(--surface2)] border border-[var(--border)] text-xs font-semibold" aria-label={`See all versions of ${item.name} and pick a different printing`}>
                          All versions
                        </button>
                      ) : null}
                      {item.hasCardImage ? (
                        <button type="button" disabled={detectingId !== null} onClick={() => void detectVersion(item)} className="h-8 px-3 rounded-full bg-[var(--surface2)] border border-[var(--foil)]/70 text-xs font-semibold disabled:opacity-50" aria-label={`Detect exact version of ${item.name} from its saved photo`}>
                          {detectingId === item.id ? "Detecting…" : "🔍 Detect version"}
                        </button>
                      ) : null}
                      <button type="button" onClick={() => void updateItem(item.id, { quantity: 0 })} className="h-8 px-3 rounded-full border border-[var(--danger)] text-[var(--danger)] text-xs font-semibold" aria-label={`Remove ${item.name} from scan list`}>
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
                {detectMsg[item.id] ? <p className="text-xs text-[var(--dim)] mt-2" role="status">{detectMsg[item.id]}</p> : null}
                {versionOpenId === item.id ? (
                  versionGrid ? (
                    <PrintingGrid printings={versionGrid} currentId={item.scryfallId} foil={item.foil} onPick={(p) => { void (async () => { await api.swapScanListPrinting({ id: item.id, card: p }); setVersionOpenId(null); setVersionGrid(null); void queryClient.invalidateQueries({ queryKey: ["scanList"] }); })(); }} />
                  ) : <p className="text-xs text-[var(--dim)] mt-2" role="status">Loading versions…</p>
                ) : null}
              </div>
            ))}
          {/* Pass 24c: the export / move / deck / clear block lives
              INSIDE the scroll area, below the items — as a fixed
              sibling it ate most of the sheet's height on a phone
              and squeezed the item list into a ~50px slit (Andrew's
              screenshot: one clipped row, then controls), which is
              why the list read as "not there". The header (count,
              total, Keep scanning) stays pinned; everything else
              scrolls as one column with the items first. */}
          {scanItems.length > 0 ? (
            <div className="space-y-3 pt-1">
              <ExportButtons
                baseName="Scan list"
                rows={scanItems.map((i) => ({
                  quantity: i.quantity,
                  name: i.name,
                  setCode: i.setCode,
                  setName: i.setName,
                  collectorNumber: i.collectorNumber,
                  foil: i.foil,
                  condition: i.condition,
                  language: i.language,
                  scryfallId: i.scryfallId,
                  rarity: i.rarity,
                  purchasePrice: i.foil ? i.priceUsdFoil ?? i.priceUsd : i.priceUsd,
                  addedAt: i.addedAt,
                }))}
              />
              <div className="rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-3 space-y-2">
                <p className="text-sm font-bold">Move whole list to a collection</p>
                <div className="flex gap-2">
                  <select value={moveTarget} onChange={(e) => setMoveTarget(e.target.value)} aria-label="Move scan list to collection" className="flex-1 h-11 rounded-xl bg-[var(--surface2)] border border-[var(--border)] px-2 text-sm min-w-0">
                    <option value="new">＋ New collection…</option>
                    {collections.map((c) => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
                  </select>
                  {moveTarget === "new" ? (
                    <input type="text" value={newCollName} onChange={(e) => setNewCollName(e.target.value)} placeholder="New collection name" aria-label="New collection name for scan list move" className="flex-1 h-11 rounded-xl bg-[var(--surface2)] border border-[var(--border)] px-3 text-sm min-w-0 placeholder:text-[var(--dim)]" />
                  ) : null}
                </div>
                <button type="button" disabled={committing} onClick={() => void doMoveToCollection()} className="w-full h-12 rounded-xl bg-[var(--accent)] text-[var(--accent-text)] font-bold disabled:opacity-50" aria-label="Move scan list to collection">
                  {committing ? "Moving…" : `Move ${listCount} card${listCount === 1 ? "" : "s"} to collection`}
                </button>
              </div>
              <div className="rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-3 space-y-2">
                <p className="text-sm font-bold">Make a deck from this list</p>
                <div className="flex gap-2">
                  <input type="text" value={deckName} onChange={(e) => setDeckName(e.target.value)} placeholder="Deck name (e.g. Angel Deck)" aria-label="New deck name from scan list" className="flex-1 h-11 rounded-xl bg-[var(--surface2)] border border-[var(--border)] px-3 text-sm min-w-0 placeholder:text-[var(--dim)]" />
                  <select value={deckCommander} onChange={(e) => setDeckCommander(e.target.value)} aria-label="Commander from scan list" className="flex-1 h-11 rounded-xl bg-[var(--surface2)] border border-[var(--border)] px-2 text-sm min-w-0">
                    <option value="">Commander: none yet</option>
                    {scanItems.map((i) => <option key={i.id} value={i.scryfallId}>{i.name}</option>)}
                  </select>
                </div>
                <p className="text-[11px] text-[var(--dim)]">The cards are also saved into a new collection named after the deck, so they show “In: {deckName || "…"}" there.</p>
                <button type="button" disabled={committing || !deckName.trim()} onClick={() => void doMakeDeck()} className="w-full h-12 rounded-xl bg-[var(--surface2)] border-2 border-[var(--accent)] font-bold disabled:opacity-50" aria-label="Make deck from scan list">
                  {committing ? "Creating…" : "Make deck from list"}
                </button>
              </div>
              {commitMsg ? <p className="text-sm text-[var(--good)]" role="status">{commitMsg}</p> : null}
              {confirmClear ? (
                <div className="flex gap-2">
                  <button type="button" onClick={() => void doClearList()} className="flex-1 h-11 rounded-xl bg-[var(--danger)] text-white font-bold text-sm" aria-label="Confirm clear scan list">
                    Yes, clear the list
                  </button>
                  <button type="button" onClick={() => setConfirmClear(false)} className="flex-1 h-11 rounded-xl bg-[var(--surface)] border border-[var(--border)] font-semibold text-sm" aria-label="Cancel clear scan list">
                    Keep the list
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setConfirmClear(true)} className="w-full h-10 rounded-xl border border-[var(--danger)] text-[var(--danger)] text-sm font-semibold" aria-label="Clear scan list">
                  Clear list (saves nothing)
                </button>
              )}
            </div>
          ) : null}
          {scanItems.length === 0 && commitMsg ? <p className="text-sm text-[var(--good)]" role="status">{commitMsg}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Search tab — manual add via the same local index
// ---------------------------------------------------------------------------

function SearchTab({ index, onViewCollection }: { index: NameEntry[] | null; onViewCollection: () => void }) {
  const queryClient = useQueryClient();
  const [card, setCard] = useState<CardT | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const collectionsQ = useQuery({ queryKey: ["collections"], queryFn: () => api.listCollections({}) });

  const pick = async (fullName: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getCardByName({ name: fullName });
      if (res.card) setCard(res.card);
      else setError(`Scryfall has no card named “${fullName}”.`);
    } catch (err) {
      setError(friendlyError(err, "Couldn't load that card — check your connection and try again."));
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async (c: CardT, foil: boolean, qty: number, condition: string): Promise<boolean> => {
    setAdding(true);
    try {
      await api.addToCollection({ card: c, foil, quantity: qty, condition, language: "English", collectionId: collectionsQ.data?.collections[0]?.id });
      setToast(`Added ${c.name}${foil ? " (foil)" : ""} to your collection`);
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
      return true;
    } catch (err) {
      setError(friendlyError(err, "Couldn't add that card — try again."));
      return false;
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--dim)]">
        Search runs against the name index stored on this device, so it autocompletes instantly — even offline.
        Details and prices load from Scryfall once you pick a card.
      </p>
      <NameSearchField
        index={index}
        label="Card name"
        placeholder="Start typing a card name…"
        onPickName={(name) => void pick(name)}
      />
      {loading ? <p role="status" className="text-sm text-[var(--dim)]">Loading card from Scryfall…</p> : null}
      {error ? (
        <div className="rounded-2xl border border-[var(--danger)] bg-[#2a1a1a] p-4 text-sm" role="alert">{error}</div>
      ) : null}
      {toast ? (
        <div className="rounded-2xl bg-[#1d2b1d] border border-[var(--good)] px-4 py-3 text-sm" role="status">✓ {toast}</div>
      ) : null}
      {card ? (
        <CardResultPanel
          card={card}
          onSwapPrinting={setCard}
          onAdd={(c, f, q, cond) => handleAdd(c, f, q, cond)}
          onViewCollection={onViewCollection}
          addLabel="Add to Collection"
          busy={adding}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collection tab
// ---------------------------------------------------------------------------

function collectionToCard(item: CollectionItem): CardT {
  return {
    scryfallId: item.scryfallId,
    name: item.name,
    setCode: item.setCode,
    setName: item.setName,
    collectorNumber: item.collectorNumber,
    rarity: item.rarity,
    manaCost: item.manaCost,
    cmc: item.cmc,
    typeLine: item.typeLine,
    oracleText: item.oracleText,
    colors: item.colors,
    colorIdentity: item.colorIdentity,
    imageSmall: item.imageSmall,
    imageNormal: item.imageNormal,
    priceUsd: item.priceUsd,
    priceUsdFoil: item.priceUsdFoil,
    edhrecRank: item.edhrecRank,
    scryfallUri: item.scryfallUri,
    printsSearchUri: "",
    artist: "",
    releasedAt: "",
    finishes: [],
    fullArt: false,
    borderColor: "",
  };
}

function CollectionTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [colorFilter, setColorFilter] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState("");
  const [setFilter, setSetFilter] = useState("");
  const [rarityFilter, setRarityFilter] = useState("");
  const [foilOnly, setFoilOnly] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const importRef = useRef<HTMLInputElement | null>(null);
  const [versionFor, setVersionFor] = useState<CollectionItem | null>(null);
  const [versionPrintings, setVersionPrintings] = useState<CardT[] | null>(null);
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [versionMsg, setVersionMsg] = useState<string | null>(null);
  // Collections management
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newCollName, setNewCollName] = useState("");
  const [showNewColl, setShowNewColl] = useState(false);
  const [renameText, setRenameText] = useState("");
  const [showRename, setShowRename] = useState(false);
  const [confirmDeleteColl, setConfirmDeleteColl] = useState(false);
  const [collMsg, setCollMsg] = useState<string | null>(null);
  // Price tracking
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<number | null>(null);
  const [historyByItem, setHistoryByItem] = useState<Record<number, { date: string; price: number; foil: boolean }[]>>({});
  const [loadingHistory, setLoadingHistory] = useState(false);

  const collectionsQ = useQuery({ queryKey: ["collections"], queryFn: () => api.listCollections({}) });
  const collections: CollectionInfo[] = collectionsQ.data?.collections ?? [];
  const selId = selectedId ?? collections[0]?.id ?? null;
  const selectedColl = collections.find((c) => c.id === selId) ?? null;

  const collection = useQuery({ queryKey: ["collection"], queryFn: () => api.listCollection({}) });
  const allItems: CollectionItem[] = collection.data?.items ?? [];
  const items = allItems.filter((i) => i.collectionId === selId);

  const membershipQ = useQuery({ queryKey: ["deckMembership"], queryFn: () => api.listDeckMembership({}) });
  const decksByCard = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const link of membershipQ.data?.links ?? []) {
      const arr = map.get(link.scryfallId) ?? [];
      if (!arr.includes(link.deckName)) arr.push(link.deckName);
      map.set(link.scryfallId, arr);
    }
    return map;
  }, [membershipQ.data]);

  const totalsByCollection = useMemo(() => {
    const map = new Map<number, { cards: number; value: number }>();
    for (const i of allItems) {
      const cur = map.get(i.collectionId) ?? { cards: 0, value: 0 };
      cur.cards += i.quantity;
      cur.value += (currentUnitPrice(i) ?? 0) * i.quantity;
      map.set(i.collectionId, cur);
    }
    return map;
  }, [allItems]);

  const openVersions = async (item: CollectionItem) => {
    setVersionFor(item);
    setVersionPrintings(null);
    setVersionMsg(null);
    setLoadingVersions(true);
    try {
      const res = await api.getPrintingsByScryfallId({ scryfallId: item.scryfallId });
      setVersionPrintings(res.printings);
    } finally {
      setLoadingVersions(false);
    }
  };

  const swapVersion = async (item: CollectionItem, printing: CardT) => {
    await api.swapCollectionPrinting({ id: item.id, card: printing });
    setVersionFor(null);
    setVersionPrintings(null);
    setVersionMsg(`✓ ${item.name} is now the ${printing.setName} (${printing.setCode.toUpperCase()}) #${printing.collectorNumber} version.`);
    void queryClient.invalidateQueries({ queryKey: ["collection"] });
  };

  const sets = useMemo(() => [...new Set(items.map((i) => i.setCode.toUpperCase()))].sort(), [items]);
  const rarities = useMemo(() => [...new Set(items.map((i) => i.rarity))].sort(), [items]);

  const filtered = items.filter((i) => {
    if (search && !i.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (colorFilter && !i.colorIdentity.includes(colorFilter) && !i.colors.includes(colorFilter)) return false;
    if (typeFilter && !i.typeLine.toLowerCase().includes(typeFilter.toLowerCase())) return false;
    if (setFilter && i.setCode.toUpperCase() !== setFilter) return false;
    if (rarityFilter && i.rarity !== rarityFilter) return false;
    if (foilOnly && !i.foil) return false;
    return true;
  });

  const totalCards = items.reduce((s, i) => s + i.quantity, 0);
  const totalValue = items.reduce((s, i) => s + (currentUnitPrice(i) ?? 0) * i.quantity, 0);
  const totalMove = items.reduce((s, i) => {
    const mv = priceMovement(currentUnitPrice(i), i.priceAtAdd);
    return mv.kind === "up" || mv.kind === "down" ? s + mv.diff * i.quantity : s;
  }, 0);
  const latestCheck = items.reduce<string | null>((acc, i) => {
    if (!i.lastCheckedAt) return acc;
    return acc == null || i.lastCheckedAt > acc ? i.lastCheckedAt : acc;
  }, null);
  const checkAgeDays = latestCheck
    ? Math.floor((Date.now() - new Date(latestCheck).getTime()) / 86_400_000)
    : null;

  const refreshPrices = async () => {
    if (!selId || refreshing) return;
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const res = await api.refreshCollectionPrices({ collectionId: selId });
      const when = new Date(res.checkedAt).toLocaleTimeString();
      if (res.failedChunks > 0) {
        setRefreshMsg(
          `Updated ${res.updated} of ${res.total} cards — Scryfall didn't answer for the rest, so those kept their previous prices. Prices as of ${when}. Tap Refresh again to retry the rest.`,
        );
      } else if (res.missing > 0) {
        setRefreshMsg(
          `✓ Updated ${res.updated} of ${res.total} cards (${res.missing} had no price listed on Scryfall). Prices as of ${when}.`,
        );
      } else {
        setRefreshMsg(`✓ Updated ${res.updated} of ${res.total} cards. Prices as of ${when}.`);
      }
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
    } catch (err) {
      setRefreshMsg(
        `Prices couldn't be refreshed: ${friendlyError(err, "something went wrong — your saved prices are unchanged, please try again.")}`,
      );
    } finally {
      setRefreshing(false);
    }
  };

  const toggleHistory = async (item: CollectionItem) => {
    if (historyFor === item.id) {
      setHistoryFor(null);
      return;
    }
    setHistoryFor(item.id);
    if (!historyByItem[item.id]) {
      setLoadingHistory(true);
      try {
        const res = await api.getPriceHistory({ itemId: item.id });
        setHistoryByItem((prev) => ({ ...prev, [item.id]: res.snapshots }));
      } finally {
        setLoadingHistory(false);
      }
    }
  };

  const update = async (id: number, patch: { quantity?: number; foil?: boolean; condition?: string; language?: string }) => {
    await api.updateCollectionItem({ id, ...patch });
    void queryClient.invalidateQueries({ queryKey: ["collection"] });
  };

  // Backup / restore
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const restoreRef = useRef<HTMLInputElement | null>(null);

  const exportBackup = async () => {
    setBackupMsg(null);
    try {
      const data = await api.exportBackup({});
      downloadTextFile(
        `manabox-backup-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(data, null, 2),
        "application/json",
      );
      const itemCount = data.collections.reduce((s, c) => s + c.items.length, 0);
      setBackupMsg(
        `✓ Backup saved: ${data.collections.length} collections (${itemCount} card entries) and ${data.decks.length} decks. Keep the file somewhere safe.`,
      );
    } catch (err) {
      setBackupMsg(`Backup didn't finish: ${friendlyError(err, "something went wrong — try again.")}`);
    }
  };

  const handleRestoreFile = async (file: File) => {
    setRestoring(true);
    setBackupMsg(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as {
        version?: number;
        collections?: unknown;
        decks?: unknown;
      };
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray(parsed.collections) ||
        !Array.isArray(parsed.decks)
      ) {
        setBackupMsg("That file doesn't look like a backup from this app — it needs collections and decks lists.");
        return;
      }
      const res = await api.restoreBackup({
        backup: parsed as Parameters<typeof api.restoreBackup>[0]["backup"],
      });
      setBackupMsg(
        `✓ Restored ${res.collections} collections (${res.items} card entries) and ${res.decks} decks (${res.deckCards} cards). Restored copies sit alongside your existing ones — a name that already existed was restored as “(restored)” rather than overwriting anything.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
      void queryClient.invalidateQueries({ queryKey: ["decks"] });
      void queryClient.invalidateQueries({ queryKey: ["deckMembership"] });
    } catch (err) {
      setBackupMsg(
        `Restore didn't finish: ${err instanceof SyntaxError ? "the file isn't valid backup data (it may be damaged)." : friendlyError(err, "something went wrong — nothing was changed, try again.")}`,
      );
    } finally {
      setRestoring(false);
    }
  };

  const createColl = async () => {
    const name = newCollName.trim();
    if (!name) return;
    const res = await api.createCollection({ name });
    setNewCollName("");
    setShowNewColl(false);
    setSelectedId(res.id);
    setCollMsg(`✓ Collection “${name}” created.`);
    void queryClient.invalidateQueries({ queryKey: ["collections"] });
  };

  const renameColl = async () => {
    if (!selId || !renameText.trim()) return;
    await api.renameCollection({ id: selId, name: renameText.trim() });
    setShowRename(false);
    setCollMsg("✓ Collection renamed.");
    void queryClient.invalidateQueries({ queryKey: ["collections"] });
    void queryClient.invalidateQueries({ queryKey: ["deckMembership"] });
  };

  const deleteColl = async () => {
    if (!selId) return;
    await api.deleteCollection({ id: selId });
    setConfirmDeleteColl(false);
    setSelectedId(null);
    setCollMsg("Collection deleted, along with its cards.");
    void queryClient.invalidateQueries({ queryKey: ["collections"] });
    void queryClient.invalidateQueries({ queryKey: ["collection"] });
  };

  const exportRows: (ExportRow & { rarity?: string })[] = items.map((i) => ({
    quantity: i.quantity,
    name: i.name,
    setCode: i.setCode,
    setName: i.setName,
    collectorNumber: i.collectorNumber,
    foil: i.foil,
    condition: i.condition,
    language: i.language,
    scryfallId: i.scryfallId,
    rarity: i.rarity,
    purchasePrice: i.priceAtAdd,
    addedAt: i.addedAt,
  }));

  const handleImportFile = async (file: File) => {
    if (!selId) return;
    setImporting(true);
    setImportMsg(null);
    try {
      const text = await file.text();
      const { rows, errors } = parseManaBoxCsvDetailed(text);
      if (rows.length === 0) {
        setImportMsg(
          errors.length > 0
            ? `Nothing could be imported. ${errors.slice(0, 3).join(" ")}`
            : "No rows found — the CSV needs a header row with a Name column (ManaBox export format).",
        );
        return;
      }
      let imported = 0;
      let mergedCount = 0;
      const skipped: string[] = [];
      for (let start = 0; start < rows.length; start += 100) {
        const chunk = rows.slice(start, start + 100);
        const res = await api.importCollectionRows({
          collectionId: selId,
          rows: chunk.map((r) => ({
            name: r.name,
            foil: r.foil,
            quantity: r.quantity,
            scryfallId: r.scryfallId,
            setCode: r.setCode,
            collectorNumber: r.collectorNumber,
            condition: r.condition,
            language: r.language,
          })),
        });
        imported += res.imported;
        mergedCount += res.merged;
        skipped.push(...res.skipped);
      }
      const parts = [
        `Import into “${selectedColl?.name}” done: ${imported} new, ${mergedCount} merged into existing stacks.`,
      ];
      if (skipped.length > 0) {
        parts.push(`Not found on Scryfall, skipped: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ""}.`);
      }
      if (errors.length > 0) {
        parts.push(`File problems: ${errors.slice(0, 3).join(" ")}${errors.length > 3 ? ` …and ${errors.length - 3} more problem rows.` : ""}`);
      }
      setImportMsg(parts.join(" "));
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
    } catch (err) {
      setImportMsg(`Import didn't finish: ${friendlyError(err, "something went wrong — check the file and try again.")}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Collection selector — ManaBox-style named collections */}
      <div className="space-y-2">
        <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Your collections">
          {collections.map((c) => {
            const t = totalsByCollection.get(c.id) ?? { cards: 0, value: 0 };
            const active = c.id === selId;
            return (
              <button key={c.id} type="button" role="tab" aria-selected={active} aria-label={`Collection ${c.name}, ${t.cards} cards, worth ${formatMoney(t.value)}`} onClick={() => { setSelectedId(c.id); setConfirmDeleteColl(false); setShowRename(false); }} className={`shrink-0 rounded-2xl border-2 px-3 py-2 text-left ${active ? "border-[var(--accent)] bg-[var(--surface)]" : "border-[var(--border)] bg-[var(--surface)] opacity-70"}`}>
                <span className="block text-sm font-bold leading-tight">{c.name}</span>
                <span className="block text-[11px] text-[var(--dim)]">{t.cards} cards · {formatMoney(t.value)}</span>
              </button>
            );
          })}
          <button type="button" onClick={() => setShowNewColl(!showNewColl)} className="shrink-0 rounded-2xl border-2 border-dashed border-[var(--border)] px-3 py-2 text-sm font-semibold" aria-label="New collection">
            ＋ New
          </button>
        </div>
        {showNewColl ? (
          <div className="flex gap-2">
            <input type="text" value={newCollName} onChange={(e) => setNewCollName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void createColl(); }} placeholder="New collection name…" aria-label="New collection name" className="flex-1 h-11 rounded-xl bg-[var(--surface)] border border-[var(--border)] px-3 placeholder:text-[var(--dim)]" />
            <button type="button" onClick={() => void createColl()} disabled={!newCollName.trim()} className="h-11 px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-text)] font-bold disabled:opacity-40" aria-label="Create collection">Create</button>
          </div>
        ) : null}
        {selectedColl ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-[var(--dim)]">Managing <strong className="text-[var(--text)]">{selectedColl.name}</strong></span>
            <button type="button" onClick={() => { setRenameText(selectedColl.name); setShowRename(!showRename); }} className="h-8 px-3 rounded-full bg-[var(--surface)] border border-[var(--border)] text-xs font-semibold" aria-label={`Rename collection ${selectedColl.name}`}>Rename</button>
            {confirmDeleteColl ? (
              <>
                <span className="text-xs text-[var(--danger)]">Delete this collection AND all {totalCards} of its cards?</span>
                <button type="button" onClick={() => void deleteColl()} className="h-8 px-3 rounded-full bg-[var(--danger)] text-white text-xs font-bold" aria-label="Confirm delete collection and its cards">Yes, delete all</button>
                <button type="button" onClick={() => setConfirmDeleteColl(false)} className="h-8 px-3 rounded-full bg-[var(--surface)] border border-[var(--border)] text-xs font-semibold" aria-label="Cancel delete collection">Cancel</button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirmDeleteColl(true)} className="h-8 px-3 rounded-full border border-[var(--danger)] text-[var(--danger)] text-xs font-semibold" aria-label={`Delete collection ${selectedColl.name}`}>Delete collection</button>
            )}
          </div>
        ) : null}
        {showRename && selectedColl ? (
          <div className="flex gap-2">
            <input type="text" value={renameText} onChange={(e) => setRenameText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void renameColl(); }} aria-label="Rename collection to" className="flex-1 h-11 rounded-xl bg-[var(--surface)] border border-[var(--border)] px-3" />
            <button type="button" onClick={() => void renameColl()} disabled={!renameText.trim()} className="h-11 px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-text)] font-bold disabled:opacity-40" aria-label="Save collection name">Save</button>
          </div>
        ) : null}
        {collMsg ? <p className="text-sm text-[var(--good)]" role="status">{collMsg}</p> : null}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-4">
          <p className="text-xs text-[var(--dim)]">Total value of {selectedColl?.name ?? "collection"} (foil-aware)</p>
          <p className="text-2xl font-bold text-[var(--accent)]">{formatMoney(totalValue)}</p>
          {Math.abs(totalMove) >= 0.005 ? (
            <p className={`text-xs font-bold mt-1 ${totalMove > 0 ? "text-[var(--good)]" : "text-[var(--danger)]"}`}>
              {totalMove > 0 ? "▲" : "▼"} {formatSignedMoney(totalMove)} since cards were added
            </p>
          ) : (
            <p className="text-xs text-[var(--dim)] mt-1">— no change since cards were added</p>
          )}
        </div>
        <div className="rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-4">
          <p className="text-xs text-[var(--dim)]">Total cards</p>
          <p className="text-2xl font-bold">{totalCards.toLocaleString()}</p>
          <p className="text-xs text-[var(--dim)]">{items.length} unique entries</p>
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={() => void refreshPrices()} disabled={refreshing || !selId || items.length === 0} className="h-11 px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-text)] text-sm font-bold disabled:opacity-40" aria-label={`Refresh prices for ${selectedColl?.name ?? "this collection"}`}>
            {refreshing ? "Refreshing prices…" : "↻ Refresh prices"}
          </button>
          {latestCheck ? (
            <span className="text-xs text-[var(--dim)]">
              Prices as of {new Date(latestCheck).toLocaleString()}
              {checkAgeDays != null && checkAgeDays >= 2 ? ` · prices are ${checkAgeDays} days old` : ""}
            </span>
          ) : items.length > 0 ? (
            <span className="text-xs text-[var(--dim)]">Prices shown are from when each card was added — refresh to check for changes.</span>
          ) : null}
        </div>
        {refreshMsg ? <p className="text-sm text-[var(--dim)]" role="status">{refreshMsg}</p> : null}
      </div>

      <div className="space-y-2">
        <ExportButtons rows={exportRows} baseName={selectedColl?.name ?? "collection"} disabled={items.length === 0} />
        <div className="flex gap-2">
          <button type="button" onClick={() => importRef.current?.click()} disabled={importing || !selId} className="flex-1 h-11 rounded-xl bg-[var(--surface)] border border-[var(--border)] text-sm font-semibold disabled:opacity-40" aria-label="Import CSV into this collection">
            {importing ? "Importing…" : `Import CSV into ${selectedColl?.name ?? "…"}`}
          </button>
          <input ref={importRef} type="file" accept=".csv,text/csv" className="hidden" aria-label="Import CSV file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleImportFile(f); e.target.value = ""; }} />
        </div>
        {importMsg ? <p className="text-sm text-[var(--dim)]" role="status">{importMsg}</p> : null}
        <div className="rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-3 space-y-2">
          <p className="text-sm font-bold">Backup &amp; restore</p>
          <p className="text-xs text-[var(--dim)]">
            One backup file holds every collection (with conditions, languages and price baselines) and every deck.
            Restoring never overwrites: anything whose name already exists comes back as a separate “(restored)” copy.
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => void exportBackup()} className="flex-1 h-11 rounded-xl bg-[var(--surface2)] border border-[var(--border)] text-sm font-semibold" aria-label="Export a full backup of all collections and decks as JSON">
              Export backup (.json)
            </button>
            <button type="button" onClick={() => restoreRef.current?.click()} disabled={restoring} className="flex-1 h-11 rounded-xl bg-[var(--surface2)] border border-[var(--border)] text-sm font-semibold disabled:opacity-40" aria-label="Restore collections and decks from a backup file">
              {restoring ? "Restoring…" : "Restore backup"}
            </button>
            <input ref={restoreRef} type="file" accept=".json,application/json" className="hidden" aria-label="Restore backup file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleRestoreFile(f); e.target.value = ""; }} />
          </div>
          {backupMsg ? <p className="text-sm text-[var(--dim)]" role="status">{backupMsg}</p> : null}
        </div>
      </div>

      <div className="space-y-2">
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search this collection…" aria-label="Search collection by name" className="w-full h-12 rounded-xl bg-[var(--surface)] border border-[var(--border)] px-3 placeholder:text-[var(--dim)]" />
        <div className="flex gap-2 flex-wrap items-center">
          {["W", "U", "B", "R", "G"].map((c) => (
            <button key={c} type="button" aria-label={`Filter by ${COLOR_NAMES[c] ?? c}`} aria-pressed={colorFilter === c} onClick={() => setColorFilter(colorFilter === c ? null : c)} className={`px-3 h-9 rounded-full border text-sm font-semibold ${colorFilter === c ? "bg-[var(--accent)] text-[var(--accent-text)] border-[var(--accent)]" : "bg-[var(--surface)] border-[var(--border)]"}`}>
              {COLOR_NAMES[c]}
            </button>
          ))}
          <button type="button" aria-label="Foil only" aria-pressed={foilOnly} onClick={() => setFoilOnly(!foilOnly)} className={`px-3 h-9 rounded-full border text-sm font-semibold ${foilOnly ? "bg-[var(--foil)] text-[#101114] border-[var(--foil)]" : "bg-[var(--surface)] border-[var(--border)]"}`}>
            ✨ Foil only
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <input type="text" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} placeholder="Type (e.g. Creature)" aria-label="Filter by type" className="h-10 rounded-xl bg-[var(--surface)] border border-[var(--border)] px-2 text-sm placeholder:text-[var(--dim)]" />
          <select value={setFilter} onChange={(e) => setSetFilter(e.target.value)} aria-label="Filter by set" className="h-10 rounded-xl bg-[var(--surface)] border border-[var(--border)] px-2 text-sm">
            <option value="">All sets</option>
            {sets.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={rarityFilter} onChange={(e) => setRarityFilter(e.target.value)} aria-label="Filter by rarity" className="h-10 rounded-xl bg-[var(--surface)] border border-[var(--border)] px-2 text-sm capitalize">
            <option value="">All rarities</option>
            {rarities.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </div>

      {versionMsg ? <p className="text-sm text-[var(--good)]" role="status">{versionMsg}</p> : null}
      {versionFor ? (
        <section aria-label={`Versions of ${versionFor.name}`} className="rounded-3xl bg-[var(--surface)] border border-[var(--accent)]/60 p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-display text-base">Versions of {versionFor.name}</h3>
            <button type="button" onClick={() => { setVersionFor(null); setVersionPrintings(null); }} className="h-9 px-3 rounded-full bg-[var(--surface2)] border border-[var(--border)] text-xs font-semibold" aria-label="Close version picker">Close</button>
          </div>
          <p className="text-xs text-[var(--dim)] mt-1">Currently saved as {versionFor.setName} ({versionFor.setCode.toUpperCase()}) #{versionFor.collectorNumber}. Tap a version to swap this entry to that exact printing.</p>
          {loadingVersions ? <p className="text-sm text-[var(--dim)] mt-2" role="status">Loading versions from Scryfall…</p> : null}
          {versionPrintings ? <PrintingGrid printings={versionPrintings} currentId={versionFor.scryfallId} foil={versionFor.foil} onPick={(p) => void swapVersion(versionFor, p)} /> : null}
        </section>
      ) : null}

      {collection.isPending || collectionsQ.isPending ? <p role="status" className="text-[var(--dim)]">Loading collections…</p> : null}
      {collection.isError ? <p role="alert" className="text-sm text-[var(--danger)]">Collection failed to load. Pull to retry by switching tabs.</p> : null}
      {!collection.isPending && items.length === 0 ? (
        <div className="rounded-3xl bg-[var(--surface)] border border-dashed border-[var(--border)] p-6 text-center">
          <p className="font-display text-lg">{selectedColl ? `${selectedColl.name} is empty` : "Your collection is empty"}</p>
          <p className="text-sm text-[var(--dim)] mt-1">Scan cards into the scan list and move them here, add by name in Search, or import a ManaBox CSV above.</p>
        </div>
      ) : null}
      {!collection.isPending && items.length > 0 && filtered.length === 0 ? <p className="text-sm text-[var(--dim)]">No cards match those filters.</p> : null}

      <ul className="space-y-2" aria-label="Collection cards">
        {filtered.map((item) => {
          const price = currentUnitPrice(item);
          const inDecks = decksByCard.get(item.scryfallId) ?? [];
          const history = historyByItem[item.id];
          return (
            <li key={item.id} className="flex gap-3 rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-3">
              {item.imageSmall ? <FoilImage src={item.imageSmall} alt={item.name} foil={item.foil} className="w-14 shrink-0 self-start rounded-lg" imgClassName="w-full rounded-lg" /> : null}
              <div className="flex-1 min-w-0">
                <p className="font-semibold leading-tight truncate">{item.name}</p>
                <p className="text-xs text-[var(--dim)]">{item.setCode.toUpperCase()} #{item.collectorNumber} · {item.rarity} · {item.condition} · {item.language}</p>
                <p className="text-xs text-[var(--dim)] truncate">{item.typeLine}</p>
                {inDecks.length > 0 ? (
                  <p className="mt-1 flex flex-wrap gap-1">
                    {inDecks.map((dn) => (
                      <span key={dn} className="inline-block rounded-full bg-[#2b2417] border border-[#e8b34b]/60 text-[#e8b34b] px-2 py-0.5 text-[11px] font-semibold">In: {dn}</span>
                    ))}
                  </p>
                ) : null}
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <ManaDots identity={item.colorIdentity} size={14} />
                  <span className="text-sm font-semibold text-[var(--accent)]">{formatMoney(price)}</span>
                  <PriceMove item={item} />
                  {item.foil ? <span className="text-xs foil-shimmer font-bold">FOIL</span> : null}
                </div>
                <p className="text-[11px] text-[var(--dim)] mt-0.5">
                  Added {new Date(item.addedAt).toLocaleDateString()}
                  {item.priceAtAdd != null ? ` at ${formatMoney(item.priceAtAdd)}` : ""}
                  {item.baselineNote ? ` · ${item.baselineNote}` : ""}
                </p>
                {historyFor === item.id ? (
                  <div className="mt-2 rounded-xl bg-[var(--surface2)] border border-[var(--border)] p-2">
                    <p className="text-[11px] font-semibold text-[var(--dim)]">Price checks</p>
                    {loadingHistory && !history ? <p className="text-xs text-[var(--dim)]">Loading…</p> : null}
                    {history && history.length === 0 ? <p className="text-xs text-[var(--dim)]">No price checks recorded yet — tap Refresh prices.</p> : null}
                    {history && history.length > 0 ? (
                      <ul className="text-xs space-y-0.5 mt-1">
                        {history.map((s, idx) => (
                          <li key={idx} className="flex justify-between gap-3">
                            <span>{new Date(s.date).toLocaleDateString()}</span>
                            <span className="font-semibold">{formatMoney(s.price)}{s.foil ? " · foil" : ""}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                <div className="flex gap-2 mt-2 flex-wrap">
                  <label className="flex items-center gap-1">
                    <span className="text-[11px] text-[var(--dim)]">Condition</span>
                    <select
                      value={item.condition}
                      onChange={(e) => void update(item.id, { condition: e.target.value })}
                      aria-label={`Condition of ${item.name}`}
                      className="h-8 rounded-lg bg-[var(--surface2)] border border-[var(--border)] px-1 text-xs"
                    >
                      {CONDITIONS.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1">
                    <span className="text-[11px] text-[var(--dim)]">Language</span>
                    <select
                      value={item.language}
                      onChange={(e) => void update(item.id, { language: e.target.value })}
                      aria-label={`Language of ${item.name}`}
                      className="h-8 rounded-lg bg-[var(--surface2)] border border-[var(--border)] px-1 text-xs"
                    >
                      {LANGUAGES.map((l) => (
                        <option key={l} value={l}>{l}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="flex items-center justify-between mt-2 gap-2 flex-wrap">
                  <QtyStepper small value={item.quantity} label={`quantity of ${item.name}`} onChange={(v) => void update(item.id, { quantity: v })} />
                  <div className="flex gap-2 flex-wrap">
                    <button type="button" onClick={() => void update(item.id, { foil: !item.foil })} className="h-8 px-3 rounded-full bg-[var(--surface2)] border border-[var(--border)] text-xs font-semibold" aria-label={`Toggle foil for ${item.name}`}>
                      {item.foil ? "Make non-foil" : "Make foil"}
                    </button>
                    <button type="button" onClick={() => void openVersions(item)} className="h-8 px-3 rounded-full bg-[var(--surface2)] border border-[var(--border)] text-xs font-semibold" aria-label={`Change version of ${item.name}`}>
                      Change version
                    </button>
                    <button type="button" onClick={() => void toggleHistory(item)} aria-expanded={historyFor === item.id} className="h-8 px-3 rounded-full bg-[var(--surface2)] border border-[var(--border)] text-xs font-semibold" aria-label={`Price history for ${item.name}`}>
                      {historyFor === item.id ? "Hide history" : "History"}
                    </button>
                    <button type="button" onClick={() => void update(item.id, { quantity: 0 })} className="h-8 px-3 rounded-full border border-[var(--danger)] text-[var(--danger)] text-xs font-semibold" aria-label={`Delete ${item.name} from collection`}>
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Decks tab
// ---------------------------------------------------------------------------

function deckAdvice(counts: Record<Category, number>, total: number, avgCmc: number): string[] {
  const out: string[] = [];
  if (counts.Lands > 0 && counts.Lands < 35) {
    out.push(`Only ${counts.Lands} lands — most Commander decks run 35–38 lands so they don't miss land drops.`);
  }
  if (counts.Ramp < 10) {
    out.push(`Only ${counts.Ramp} ramp — Commander decks usually want 10–12 ramp pieces to cast their big spells on time.`);
  }
  if (counts["Card Draw"] < 8) {
    out.push(`Only ${counts["Card Draw"]} card draw — aim for around 10 sources so you don't run out of gas.`);
  }
  if (counts.Removal < 5) {
    out.push(`Only ${counts.Removal} removal — 5–8 targeted removal spells keep opposing threats in check.`);
  }
  if (counts["Board Wipes"] < 2) {
    out.push(`Only ${counts["Board Wipes"]} board wipe${counts["Board Wipes"] === 1 ? "" : "s"} — 2–3 wipes give you a reset button when the board gets out of hand.`);
  }
  if (avgCmc > 3.6 && total > 10) {
    out.push(`Your average mana value is ${avgCmc.toFixed(1)} — that's high. A few more cheap spells will smooth out your early game.`);
  }
  if (out.length === 0 && total >= 60) {
    out.push("This deck's mix looks healthy: lands, ramp, draw and interaction are all in the usual ranges.");
  }
  return out;
}

function DeckDetail({ deck, index }: { deck: Deck; index: NameEntry[] | null }) {
  const queryClient = useQueryClient();
  const [commanderWarn, setCommanderWarn] = useState<string | null>(null);
  const [pendingCard, setPendingCard] = useState<CardT | null>(null);
  const [deckMsg, setDeckMsg] = useState<string | null>(null);
  const [fetchingName, setFetchingName] = useState(false);

  const cardsQuery = useQuery({
    queryKey: ["deckCards", deck.id],
    queryFn: () => api.listDeckCards({ deckId: deck.id }),
  });
  const collectionQuery = useQuery({
    queryKey: ["collection"],
    queryFn: () => api.listCollection({}),
  });
  const cards: DeckCard[] = cardsQuery.data?.cards ?? [];
  const collectionItems: CollectionItem[] = collectionQuery.data?.items ?? [];

  const commanderIdentity = deck.commanderColorIdentity;
  const total = cards.reduce((s, c) => s + c.quantity, 0);
  const nonLand = cards.filter((c) => !c.typeLine.toLowerCase().includes("land"));
  const avgCmc = nonLand.length
    ? nonLand.reduce((s, c) => s + c.cmc * c.quantity, 0) / Math.max(1, nonLand.reduce((s, c) => s + c.quantity, 0))
    : 0;

  const counts = useMemo(() => {
    const init = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
    for (const c of cards) {
      if (c.isCommander) continue;
      init[categoriseCard(c.typeLine, c.oracleText)] += c.quantity;
    }
    return init;
  }, [cards]);

  const curve = useMemo(() => {
    const buckets = new Array<number>(8).fill(0);
    for (const c of cards) {
      if (c.isCommander || c.typeLine.toLowerCase().includes("land")) continue;
      const idx = Math.min(7, Math.floor(c.cmc));
      buckets[idx] = (buckets[idx] ?? 0) + c.quantity;
    }
    return buckets;
  }, [cards]);
  const curveMax = Math.max(1, ...curve);

  const inDeckNames = useMemo(() => new Set(cards.map((c) => c.name.toLowerCase())), [cards]);

  const ownedSuggestions = useMemo(() => {
    const byName = new Map<string, CollectionItem>();
    for (const item of collectionItems) {
      if (inDeckNames.has(item.name.toLowerCase())) continue;
      if (!fitsIdentity(item.colorIdentity, commanderIdentity)) continue;
      const prev = byName.get(item.name.toLowerCase());
      if (!prev) byName.set(item.name.toLowerCase(), item);
    }
    const list = [...byName.values()];
    list.sort((a, b) => (a.edhrecRank ?? 999999) - (b.edhrecRank ?? 999999));
    const grouped = new Map<Category, CollectionItem[]>();
    for (const item of list) {
      const cat = categoriseCard(item.typeLine, item.oracleText);
      const arr = grouped.get(cat) ?? [];
      arr.push(item);
      grouped.set(cat, arr);
    }
    return grouped;
  }, [collectionItems, inDeckNames, commanderIdentity]);

  const excludeForSearch = useMemo(() => {
    const names = new Set<string>(inDeckNames);
    for (const item of collectionItems) names.add(item.name.toLowerCase());
    return [...names].map((n) => {
      const found = cards.find((c) => c.name.toLowerCase() === n) ?? collectionItems.find((c) => c.name.toLowerCase() === n);
      return found ? found.name : n;
    }).slice(0, 500);
  }, [cards, collectionItems, inDeckNames]);

  const toGetQuery = useQuery({
    queryKey: ["cardsToGet", deck.id, commanderIdentity?.join("") ?? "none", excludeForSearch.length],
    queryFn: () =>
      api.searchCardsToGet({
        colorIdentity: commanderIdentity ?? [],
        excludeNames: excludeForSearch,
      }),
    enabled: commanderIdentity !== null,
  });

  const fetchByName = async (fullName: string): Promise<CardT | null> => {
    setFetchingName(true);
    try {
      const res = await api.getCardByName({ name: fullName });
      return res.card;
    } finally {
      setFetchingName(false);
    }
  };

  const pickCommander = async (fullName: string) => {
    const card = await fetchByName(fullName);
    if (!card) return;
    if (!isCommanderEligible(card.typeLine, card.oracleText)) {
      setCommanderWarn(
        `“${card.name}” isn't a legendary creature and doesn't say it can be your commander, so it may not be a legal commander — set anyway, but check your playgroup's rules.`,
      );
    } else {
      setCommanderWarn(null);
    }
    await api.setCommander({ deckId: deck.id, card });
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
    void queryClient.invalidateQueries({ queryKey: ["deckCards", deck.id] });
  };

  const addCard = async (card: CardT, foil = false) => {
    const res = await api.addDeckCard({ deckId: deck.id, card, quantity: 1, foil });
    setDeckMsg(`Added ${card.name} to ${deck.name}${res.addedToCollection ? ` — also saved to your collection “${res.collectionName}”` : ""}`);
    void queryClient.invalidateQueries({ queryKey: ["deckCards", deck.id] });
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
    void queryClient.invalidateQueries({ queryKey: ["collection"] });
    void queryClient.invalidateQueries({ queryKey: ["deckMembership"] });
  };

  const setQty = async (dc: DeckCard, qty: number) => {
    await api.updateDeckCard({ id: dc.id, quantity: qty });
    void queryClient.invalidateQueries({ queryKey: ["deckCards", deck.id] });
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  };

  const advice = deckAdvice(counts, total, avgCmc);
  const progressPct = Math.min(100, total);

  return (
    <div className="space-y-4">
      {/* Commander */}
      <section aria-label="Commander" className="rounded-3xl bg-[var(--surface)] border border-[var(--border)] p-4">
        {deck.commanderName ? (
          <div className="flex gap-4">
            {deck.commanderImage ? (
              <FoilImage src={deck.commanderImage} alt={deck.commanderName ?? ""} foil={false} className="w-24 shrink-0 self-start rounded-xl" imgClassName="w-full rounded-xl" />
            ) : null}
            <div className="min-w-0">
              <p className="text-xs text-[var(--dim)]">Commander</p>
              <h3 className="font-display text-xl leading-tight">{deck.commanderName}</h3>
              <p className="text-sm text-[var(--dim)]">{deck.commanderTypeLine}</p>
              <div className="mt-2">
                <ManaDots identity={commanderIdentity ?? []} />
                <span className="text-xs text-[var(--dim)] ml-2">
                  Colour identity: {(commanderIdentity ?? []).map((c) => COLOR_NAMES[c] ?? c).join(", ") || "Colourless"}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-[var(--dim)]">No commander yet — search for one below. It should be a legendary creature, or a card that says it can be your commander.</p>
        )}
        <div className="mt-3">
          <NameSearchField
            index={index}
            label={deck.commanderName ? "Change commander" : "Set commander"}
            placeholder="Search legendary creatures…"
            onPickName={(name) => void pickCommander(name)}
          />
        </div>
        {commanderWarn ? (
          <p className="mt-2 text-sm text-[#e8b34b]" role="alert">⚠️ {commanderWarn}</p>
        ) : null}
      </section>

      {/* Progress + curve + categories */}
      <section aria-label="Deck progress" className="rounded-3xl bg-[var(--surface)] border border-[var(--border)] p-4 space-y-4">
        <div>
          <div className="flex justify-between text-sm">
            <span className="font-semibold">{total} / 100 cards</span>
            <span className="text-[var(--dim)]">{total >= 100 ? "Complete!" : `${100 - total} to go`}</span>
          </div>
          <div className="mt-2 h-3 rounded-full bg-[var(--surface2)] overflow-hidden" role="progressbar" aria-valuenow={total} aria-valuemin={0} aria-valuemax={100} aria-label="Deck size progress">
            <div className="h-full bg-[var(--accent)]" style={{ width: `${progressPct}%` }} />
          </div>
          <p className="text-xs text-[var(--dim)] mt-1">Average mana value (non-lands): {avgCmc.toFixed(2)}</p>
          <p className="text-xs text-[var(--dim)] mt-1">Deck value from its linked printings: <span className="text-[var(--accent)] font-semibold">{formatMoney(deck.totalValue)}</span>. Removing a card here only unlinks it from the deck — it stays in your collection.</p>
        </div>
        <div>
          <h4 className="text-sm font-semibold mb-2">Mana curve</h4>
          <div className="flex items-end gap-1 h-24" aria-label="Mana curve chart">
            {curve.map((v, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <span className="text-[10px] text-[var(--dim)]">{v > 0 ? v : ""}</span>
                <div
                  className="w-full rounded-t bg-[var(--accent)]"
                  style={{ height: `${Math.max(4, (v / curveMax) * 64)}px` }}
                />
                <span className="text-[10px] text-[var(--dim)]">{i === 7 ? "7+" : i}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          {CATEGORIES.map((cat) => (
            <div key={cat} className="flex justify-between rounded-xl bg-[var(--surface2)] px-3 py-2">
              <span>{cat}</span>
              <strong>{counts[cat]}</strong>
            </div>
          ))}
        </div>
        {advice.length > 0 ? (
          <div className="space-y-1">
            {advice.map((a) => (
              <p key={a} className="text-sm text-[#e8b34b]">💡 {a}</p>
            ))}
          </div>
        ) : null}
      </section>

      {/* Deck list */}
      <section aria-label="Cards in deck" className="rounded-3xl bg-[var(--surface)] border border-[var(--border)] p-4">
        <h4 className="font-display text-base mb-2">Deck list</h4>
        {cardsQuery.isPending ? <p className="text-sm text-[var(--dim)]" role="status">Loading deck…</p> : null}
        {cards.length === 0 && !cardsQuery.isPending ? (
          <p className="text-sm text-[var(--dim)]">No cards yet. Add some from your collection or search below.</p>
        ) : null}
        <ul className="divide-y divide-[var(--border)]">
          {cards.map((dc) => {
            const legal = fitsIdentity(dc.colorIdentity, commanderIdentity);
            return (
              <li key={dc.id} className={`flex items-center gap-3 py-2 ${!legal && !dc.isCommander ? "bg-[#2a1a1a] -mx-2 px-2 rounded-lg border border-[var(--danger)]" : ""}`}>
                {dc.imageSmall ? <FoilImage src={dc.imageSmall} alt="" foil={false} className="w-9 shrink-0 rounded" imgClassName="w-full rounded" /> : null}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">
                    {dc.name}
                    {dc.isCommander ? <span className="text-[var(--accent)]"> ★ Commander</span> : null}
                  </p>
                  <p className="text-xs text-[var(--dim)] truncate">
                    {categoriseCard(dc.typeLine, dc.oracleText)} · {dc.typeLine} · CMC {dc.cmc}
                  </p>
                  {!legal && !dc.isCommander ? (
                    <p className="text-xs text-[var(--danger)]">Outside the commander's colour identity</p>
                  ) : null}
                </div>
                {dc.isCommander ? null : (
                  <QtyStepper small value={dc.quantity} label={`quantity of ${dc.name} in deck`} onChange={(v) => void setQty(dc, v)} />
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Export this deck */}
      <section aria-label="Export deck" className="rounded-3xl bg-[var(--surface)] border border-[var(--border)] p-4 space-y-2">
        <h4 className="font-display text-base">Export this deck</h4>
        <p className="text-xs text-[var(--dim)]">
          The commander is marked in each format (Moxfield *CMDR*, Archidekt “Commander” tag). Older decks whose
          cards were added before set details were stored export with names and quantities only.
        </p>
        <ExportButtons
          baseName={deck.name}
          disabled={cards.length === 0}
          rows={cards.map((dc) => ({
            quantity: dc.quantity,
            name: dc.name,
            setCode: dc.setCode,
            setName: dc.setName,
            collectorNumber: dc.collectorNumber,
            foil: dc.foil,
            condition: dc.condition,
            language: dc.language,
            scryfallId: dc.scryfallId,
            rarity: dc.rarity,
            purchasePrice: dc.foil ? dc.priceUsdFoil ?? dc.priceUsd : dc.priceUsd,
            isCommander: dc.isCommander,
          }))}
        />
      </section>

      {/* Add cards */}
      <section aria-label="Add cards to deck" className="rounded-3xl bg-[var(--surface)] border border-[var(--border)] p-4 space-y-3">
        <h4 className="font-display text-base">Add cards</h4>
        <NameSearchField
          index={index}
          label="Search any card"
          placeholder="Type a card name…"
          onPickName={(name) => void (async () => { const c = await fetchByName(name); if (c) setPendingCard(c); })()}
        />
        {fetchingName ? <p className="text-sm text-[var(--dim)]" role="status">Loading…</p> : null}
        {pendingCard ? (
          <div className="flex items-center gap-3 rounded-xl bg-[var(--surface2)] p-3">
            {pendingCard.imageSmall ? <FoilImage src={pendingCard.imageSmall} alt="" foil={false} className="w-11 shrink-0 rounded" imgClassName="w-full rounded" /> : null}
            <div className="flex-1 min-w-0">
              <p className="font-semibold truncate">{pendingCard.name}</p>
              <p className="text-xs text-[var(--dim)] truncate">{pendingCard.typeLine}</p>
              {!fitsIdentity(pendingCard.colorIdentity, commanderIdentity) ? (
                <p className="text-xs text-[var(--danger)]">Outside colour identity — you can add it, but it will be flagged.</p>
              ) : null}
            </div>
            <button
              type="button"
              className="h-10 px-4 rounded-full bg-[var(--accent)] text-[var(--accent-text)] font-bold text-sm"
              aria-label={`Add ${pendingCard.name} to deck`}
              onClick={() => { void addCard(pendingCard); setPendingCard(null); }}
            >
              Add
            </button>
          </div>
        ) : null}
        {deckMsg ? <p className="text-sm text-[var(--good)]" role="status">✓ {deckMsg}</p> : null}
      </section>

      {/* Suggestions */}
      <section aria-label="Commander suggestions" className="rounded-3xl bg-[var(--surface)] border border-[var(--accent)]/50 p-4 space-y-4">
        <h4 className="font-display text-lg">Commander suggestions</h4>
        {!commanderIdentity ? (
          <p className="text-sm text-[var(--dim)]">Set a commander first — suggestions are built around its colour identity.</p>
        ) : (
          <>
            <div>
              <h5 className="text-sm font-bold mb-2">From your collection</h5>
              {[...ownedSuggestions.entries()].length === 0 ? (
                <p className="text-sm text-[var(--dim)]">No spare owned cards fit this commander's colours yet — scan more of your collection!</p>
              ) : (
                [...ownedSuggestions.entries()].map(([cat, list]) => (
                  <div key={cat} className="mb-3">
                    <p className="text-xs uppercase tracking-wide text-[var(--dim)]">{cat}</p>
                    <ul className="mt-1 space-y-1">
                      {list.slice(0, 6).map((item) => (
                        <li key={item.id} className="flex items-center gap-2">
                          <span className="flex-1 text-sm truncate">
                            {item.name}
                            <span className="text-[var(--dim)]"> · own ×{item.quantity}{item.foil ? " (foil)" : ""}</span>
                          </span>
                          <button
                            type="button"
                            className="h-8 px-3 rounded-full bg-[var(--surface2)] border border-[var(--border)] text-xs font-bold"
                            aria-label={`Add ${item.name} from collection to deck`}
                            onClick={() => void addCard(collectionToCard(item), item.foil)}
                          >
                            + Add
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </div>
            <div>
              <h5 className="text-sm font-bold mb-2">Cards to get <span className="font-normal text-[var(--dim)]">(popular in these colours, by EDHREC rank)</span></h5>
              {toGetQuery.isPending ? <p className="text-sm text-[var(--dim)]" role="status">Asking Scryfall for staples…</p> : null}
              {toGetQuery.data && toGetQuery.data.cards.length === 0 ? (
                <p className="text-sm text-[var(--dim)]">No suggestions returned right now.</p>
              ) : null}
              <ul className="space-y-1">
                {(toGetQuery.data?.cards ?? []).slice(0, 12).map((c) => (
                  <li key={c.scryfallId} className="flex items-center gap-2">
                    <span className="flex-1 text-sm truncate">
                      {c.name} <span className="text-[var(--dim)]">· {categoriseCard(c.typeLine, c.oracleText)} · {formatMoney(c.priceUsd)}</span>
                    </span>
                    <button
                      type="button"
                      className="h-8 px-3 rounded-full bg-[var(--surface2)] border border-[var(--border)] text-xs font-bold"
                      aria-label={`Add ${c.name} to deck wishlist`}
                      onClick={() => void addCard(c)}
                    >
                      + Add
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function DecksTab({ index }: { index: NameEntry[] | null }) {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameText, setRenameText] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const decksQuery = useQuery({ queryKey: ["decks"], queryFn: () => api.listDecks({}) });
  const decks = decksQuery.data?.decks ?? [];
  const selected = decks.find((d) => d.id === selectedId) ?? null;

  const create = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const res = await api.createDeck({ name });
      setNewName("");
      setSelectedId(res.id);
      void queryClient.invalidateQueries({ queryKey: ["decks"] });
    } catch (err) {
      // Never fail silently — a rejected create used to look like the button
      // simply did nothing.
      setCreateError(`Couldn't create that deck: ${friendlyError(err, "something went wrong — try again.")}`);
    } finally {
      setCreating(false);
    }
  };

  const renameSelected = async () => {
    if (!selected || !renameText.trim()) return;
    try {
      await api.renameDeck({ id: selected.id, name: renameText.trim() });
      setRenaming(false);
      void queryClient.invalidateQueries({ queryKey: ["decks"] });
      void queryClient.invalidateQueries({ queryKey: ["deckMembership"] });
    } catch (err) {
      setCreateError(`Rename didn't finish: ${friendlyError(err, "something went wrong — try again.")}`);
    }
  };

  const remove = async (deck: Deck) => {
    await api.deleteDeck({ id: deck.id });
    if (selectedId === deck.id) setSelectedId(null);
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  };

  if (selected) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="h-10 px-4 rounded-full bg-[var(--surface)] border border-[var(--border)] text-sm font-semibold"
            aria-label="Back to deck list"
          >
            ← All decks
          </button>
          <h2 className="font-display text-xl truncate">{selected.name}</h2>
          <button
            type="button"
            onClick={() => { setRenameText(selected.name); setRenaming(!renaming); }}
            className="h-10 px-3 rounded-full bg-[var(--surface)] border border-[var(--border)] text-xs font-semibold shrink-0"
            aria-label={`Rename deck ${selected.name}`}
          >
            Rename
          </button>
        </div>
        {renaming ? (
          <div className="flex gap-2">
            <input
              type="text"
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void renameSelected(); }}
              aria-label="New name for this deck"
              className="flex-1 h-11 rounded-xl bg-[var(--surface)] border border-[var(--border)] px-3"
            />
            <button type="button" onClick={() => void renameSelected()} disabled={!renameText.trim()} className="h-11 px-4 rounded-xl bg-[var(--accent)] text-[var(--accent-text)] font-bold disabled:opacity-40" aria-label="Save deck name">
              Save
            </button>
          </div>
        ) : null}
        {createError ? <p className="text-sm text-[var(--danger)]" role="alert">{createError}</p> : null}
        <DeckDetail deck={selected} index={index} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void create(); }}
          placeholder="New deck name…"
          aria-label="New deck name"
          className="flex-1 h-12 rounded-xl bg-[var(--surface)] border border-[var(--border)] px-3 placeholder:text-[var(--dim)]"
        />
        <button
          type="button"
          onClick={() => void create()}
          disabled={!newName.trim() || creating}
          className="h-12 px-5 rounded-xl bg-[var(--accent)] text-[var(--accent-text)] font-bold disabled:opacity-40"
          aria-label="Create deck"
        >
          {creating ? "Creating…" : "Create"}
        </button>
      </div>
      {createError ? <p className="text-sm text-[var(--danger)]" role="alert">{createError}</p> : null}
      {decksQuery.isPending ? <p role="status" className="text-[var(--dim)]">Loading decks…</p> : null}
      {decksQuery.isError ? <p role="alert" className="text-sm text-[var(--danger)]">Decks failed to load — switch tabs and back to retry.</p> : null}
      {decks.length === 0 && !decksQuery.isPending ? (
        <div className="rounded-3xl bg-[var(--surface)] border border-dashed border-[var(--border)] p-6 text-center">
          <p className="font-display text-lg">No decks yet</p>
          <p className="text-sm text-[var(--dim)] mt-1">Create your first Commander deck above, set a commander, and get suggestions from your own collection.</p>
        </div>
      ) : null}
      <ul className="space-y-2" aria-label="Your decks">
        {decks.map((d) => (
          <li key={d.id} className="flex gap-3 rounded-2xl bg-[var(--surface)] border border-[var(--border)] p-3 items-center">
            {d.commanderImage ? (
              <FoilImage src={d.commanderImage} alt="" foil={false} className="w-14 shrink-0 rounded-lg" imgClassName="w-full rounded-lg" />
            ) : (
              <div className="w-14 h-20 rounded-lg bg-[var(--surface2)] shrink-0 flex items-center justify-center text-2xl" aria-hidden="true">🂠</div>
            )}
            <button
              type="button"
              className="flex-1 text-left min-w-0"
              onClick={() => setSelectedId(d.id)}
              aria-label={`Open deck ${d.name}`}
            >
              <p className="font-display text-lg truncate">{d.name}</p>
              <p className="text-sm text-[var(--dim)] truncate">
                {d.commanderName ? `Commander: ${d.commanderName}` : "No commander set"} · {d.cardCount}/100 cards · {formatMoney(d.totalValue)}
              </p>
              {d.commanderColorIdentity ? (
                <span className="mt-1 inline-block"><ManaDots identity={d.commanderColorIdentity} size={14} /></span>
              ) : null}
            </button>
            {deleteConfirmId === d.id ? (
              <span className="flex gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => { setDeleteConfirmId(null); void remove(d); }}
                  className="h-9 px-3 rounded-full bg-[var(--danger)] text-white text-xs font-bold"
                  aria-label={`Confirm delete deck ${d.name}`}
                >
                  Confirm?
                </button>
                <button
                  type="button"
                  onClick={() => setDeleteConfirmId(null)}
                  className="h-9 px-3 rounded-full bg-[var(--surface2)] border border-[var(--border)] text-xs font-semibold"
                  aria-label={`Cancel delete deck ${d.name}`}
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setDeleteConfirmId(d.id)}
                className="h-9 px-3 rounded-full border border-[var(--danger)] text-[var(--danger)] text-xs font-semibold shrink-0"
                aria-label={`Delete deck ${d.name}`}
              >
                Delete
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------

export function App() {
  const [tab, setTab] = useState<Tab>("scan");
  const [namesCache, setNamesCache] = useState<NamesCache | null>(() => loadNamesCache());
  const [refreshingNames, setRefreshingNames] = useState(false);
  const refreshStarted = useRef(false);

  const refreshNames = async () => {
    setRefreshingNames(true);
    try {
      const res = await api.getCardNames({});
      saveNamesCache(res.names, res.fetchedAt);
      setNamesCache({ names: res.names, date: res.fetchedAt });
    } catch {
      // Keep any existing cache; the status line keeps showing the old date.
    } finally {
      setRefreshingNames(false);
    }
  };

  useEffect(() => {
    if (!namesCache && !refreshStarted.current) {
      refreshStarted.current = true;
      void refreshNames();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const index = useMemo(
    () => (namesCache ? buildNameIndex(namesCache.names) : null),
    [namesCache],
  );

  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: "scan", label: "Scan", icon: "📷" },
    { id: "search", label: "Search", icon: "🔍" },
    { id: "collection", label: "Collection", icon: "🗃️" },
    { id: "decks", label: "Decks", icon: "🃏" },
  ];

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className={tab === "scan" ? "h-dvh overflow-hidden max-w-2xl mx-auto w-full px-2 pt-2 pb-[calc(76px+env(safe-area-inset-bottom))]" : "px-4 pt-3 pb-32 max-w-2xl mx-auto w-full"}>
        {tab !== "scan" ? (
          <div className="mb-4">
            <DatabaseStatus cache={namesCache} refreshing={refreshingNames} onRefresh={() => void refreshNames()} />
          </div>
        ) : null}
        {tab === "scan" ? <ScanTab index={index} namesReady={!!namesCache} /> : null}
        {tab === "search" ? <SearchTab index={index} onViewCollection={() => setTab("collection")} /> : null}
        {tab === "collection" ? <CollectionTab /> : null}
        {tab === "decks" ? <DecksTab index={index} /> : null}
      </main>
      <nav
        aria-label="Main"
        className="fixed bottom-0 inset-x-0 bg-[var(--surface)] border-t border-[var(--border)] pb-safe"
      >
        <div className="max-w-2xl mx-auto grid grid-cols-4">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-label={`${t.label} tab`}
              aria-current={tab === t.id ? "page" : undefined}
              className={`py-2 flex flex-col items-center gap-0.5 min-h-14 ${
                tab === t.id ? "text-[var(--accent)]" : "text-[var(--dim)]"
              }`}
            >
              <span className="text-xl" aria-hidden="true">{t.icon}</span>
              <span className={`text-xs ${tab === t.id ? "font-bold" : ""}`}>{t.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
