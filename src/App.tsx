import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertCircle, ArrowDownToLine, ArrowLeftRight, Camera, Check, ChevronDown,
  CircleDollarSign, Database, Download, FileImage, FolderPlus, ImagePlus, Layers3,
  LoaderCircle, PackagePlus, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles,
  Square, StopCircle, Sun, Trash2, Upload, Video, X
} from 'lucide-react';
import {
  autocomplete, buildArchidektCsv, buildManaBoxCsv, buildMoxfieldTxt,
  buildNameIndex, buildMoxfieldTxt as exportMoxfield, buildArchidektCsv as exportArchidekt,
  buildManaBoxCsv as exportManaBox, categoriseCard, cleanNameVerdict, fitsIdentity, isCommanderEligible, formatMoney,
  matchNamesPooled, ocrCandidates, parseManaBoxCsvDetailed, priceMovement,
  type ExportRow, type NameEntry, type PrintingLike
} from './core/lib.js';
import { prepareCardFromFrame, detectInCanvas, cropToRect, correctCardAspect, expandRect, type CardRect } from './core/detect.js';
import { focusPlan, measureTitleSharpness, softAttemptPlan } from './core/focus.js';
import { BOTTOM_BAND, BOTTOM_BAND_CONTRAST, BAND_VARIANTS, TITLE_RESCUE_BANDS, ensureOcrWorker, warmUpOcr, onOcrStatus, ocrTitleBandCapped, ocrBottomBandCapped, type OcrStatus } from './core/ocr.js';
import { parseBottomLine, parseBottomLineCandidates } from './core/bottomline.js';
import { matchPrintingByBottom } from './core/lib.js';
import { selectReferencePrintings } from './core/printingselect.js';
import { fingerprintCanvas, rankVisualReferences, decisiveVisualPrinting } from './core/visual.js';

type Tab = 'scan' | 'search' | 'collections' | 'decks' | 'settings';
type ScryfallCard = {
  id: string; name: string; set: string; set_name: string; collector_number: string; rarity: string;
  mana_cost?: string; cmc?: number; type_line?: string; oracle_text?: string; colors?: string[];
  color_identity?: string[]; image_uris?: { small?: string; normal?: string; large?: string };
  card_faces?: Array<{ image_uris?: { small?: string; normal?: string; large?: string }; name?: string; oracle_text?: string }>;
  prices?: { usd?: string | null; usd_foil?: string | null; usd_etched?: string | null };
  artist?: string; released_at?: string; finishes?: string[]; full_art?: boolean; border_color?: string;
  prints_search_uri?: string; scryfall_uri?: string; legalities?: Record<string, string>;
};
type ScanItem = { id: string; card: ScryfallCard; foil: boolean; printingConfirmed: boolean; confidence: number; rawTitle: string; rawBottom: string; addedAt: string };
type Collection = { id: string; name: string; createdAt: string };
type CollectionItem = { id: string; collectionId: string; card: ScryfallCard; foil: boolean; quantity: number; condition: string; language: string; priceAtAdd: number | null; addedAt: string; lastPrice: number | null; lastCheckedAt: string | null };
type Deck = { id: string; name: string; commander?: ScryfallCard | null; createdAt: string; updatedAt: string };
type DeckItem = { id: string; deckId: string; card: ScryfallCard; quantity: number; commander: boolean; foil: boolean };
type PriceSnapshot = { id: string; itemId: string; price: number; foil: boolean; checkedAt: string };

const STORE = 'aetherforge-mtg-v3-store';
const CATALOG_CACHE = 'aetherforge-mtg-v3-catalog';
const money = (n: number | null | undefined) => n == null || !Number.isFinite(n) ? '—' : `$${n.toFixed(2)}`;
const unitPrice = (card: ScryfallCard, foil: boolean) => {
  const p = foil ? (card.prices?.usd_foil ?? card.prices?.usd_etched) : card.prices?.usd;
  return p == null ? null : Number(p);
};
const cardImage = (card: ScryfallCard) => card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || card.image_uris?.small || '';
const uniqueId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type LocalStore = { collections: Collection[]; items: CollectionItem[]; decks: Deck[]; deckItems: DeckItem[]; scans: ScanItem[]; priceHistory: PriceSnapshot[] };
function createEmptyStore(): LocalStore {
  const main = { id: 'main', name: 'Main Collection', createdAt: new Date().toISOString() };
  return { collections: [main], items: [], decks: [], deckItems: [], scans: [], priceHistory: [] };
}
function openLocalDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB is not available')); return; }
    const request = indexedDB.open('AetherForgeMTG', 1);
    request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains('app')) db.createObjectStore('app'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local database'));
  });
}
async function loadStore(): Promise<LocalStore> {
  try {
    const db = await openLocalDb();
    const value = await new Promise<LocalStore | undefined>((resolve, reject) => {
      const tx = db.transaction('app', 'readonly'); const req = tx.objectStore('app').get('store');
      req.onsuccess = () => resolve(req.result as LocalStore | undefined); req.onerror = () => reject(req.error);
    });
    db.close(); if (value?.collections && value?.items && value?.decks && value?.scans) return { ...createEmptyStore(), ...value, priceHistory: value.priceHistory || [] };
  } catch { /* fallback below */ }
  try { const raw = localStorage.getItem(STORE); if (raw) return { ...createEmptyStore(), ...JSON.parse(raw), priceHistory: JSON.parse(raw).priceHistory || [] } as LocalStore; } catch { /* start clean */ }
  return createEmptyStore();
}
async function saveStore(s: LocalStore): Promise<void> {
  try {
    const db = await openLocalDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('app', 'readwrite'); tx.objectStore('app').put(s, 'store');
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    db.close();
  } catch {
    try { localStorage.setItem(STORE, JSON.stringify(s)); }
    catch { throw new Error('Browser storage is full or unavailable. Export a backup before removing saved data.'); }
  }
}
async function scryfall<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { Accept: 'application/json', ...(init?.headers || {}) } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).details || `Scryfall request failed (${res.status}).`);
  }
  return res.json() as Promise<T>;
}
async function fetchNamed(name: string): Promise<ScryfallCard> {
  const exact = await scryfall<ScryfallCard>(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`).catch(() => null);
  if (exact) return exact;
  return scryfall<ScryfallCard>(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`);
}
function centerCardCrop(source: HTMLCanvasElement): HTMLCanvasElement {
  const targetRatio = 63 / 88;
  const ratio = source.width / source.height;
  let sw = source.width, sh = source.height;
  if (ratio > targetRatio) sw = Math.round(source.height * targetRatio);
  else sh = Math.round(source.width / targetRatio);
  const sx = Math.max(0, Math.round((source.width - sw) / 2));
  const sy = Math.max(0, Math.round((source.height - sh) / 2));
  const out = document.createElement('canvas'); out.width = Math.min(1100, sw); out.height = Math.round(out.width / targetRatio);
  const ctx = out.getContext('2d'); if (!ctx) return source;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height); return out;
}
function canvasFromVideo(video: HTMLVideoElement): HTMLCanvasElement {
  const max = 1500; const scale = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(video.videoWidth * scale)); c.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = c.getContext('2d'); if (!ctx) throw new Error('Could not capture camera frame.');
  ctx.drawImage(video, 0, 0, c.width, c.height); return c;
}
function fileToCanvas(file: File): Promise<HTMLCanvasElement> {
  return createImageBitmap(file).then(bitmap => {
    const max = 1800, scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const c = document.createElement('canvas'); c.width = Math.round(bitmap.width * scale); c.height = Math.round(bitmap.height * scale);
    const ctx = c.getContext('2d'); if (!ctx) throw new Error('Could not open the selected image.');
    ctx.drawImage(bitmap, 0, 0, c.width, c.height); bitmap.close(); return c;
  });
}
function makeExportRow(item: CollectionItem | DeckItem): ExportRow {
  const c = item.card;
  const collection = 'collectionId' in item ? item : null;
  return { quantity: item.quantity, name: c.name, setCode: c.set || '', setName: c.set_name || '', collectorNumber: c.collector_number || '', foil: item.foil, condition: collection?.condition || 'Near Mint', language: collection?.language || 'English', scryfallId: c.id, purchasePrice: collection?.priceAtAdd ?? unitPrice(c, item.foil), isCommander: 'commander' in item ? item.commander : false, addedAt: collection?.addedAt || new Date().toISOString() };
}

export default function App() {
  const [tab, setTab] = useState<Tab>('scan');
  const [store, setStore] = useState<LocalStore>(createEmptyStore);
  const [hydrated, setHydrated] = useState(false);
  const [catalog, setCatalog] = useState<NameEntry[]>([]);
  const [catalogDate, setCatalogDate] = useState('');
  const [catalogState, setCatalogState] = useState('Card-name database not loaded');
  const [ocrState, setOcrState] = useState<OcrStatus>('idle');
  const [status, setStatus] = useState('Ready');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [torch, setTorch] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [rapid, setRapid] = useState(false);
  const [rapidAutoAdd, setRapidAutoAdd] = useState(true);
  const [cameraFacing, setCameraFacing] = useState<'environment' | 'user'>('environment');
  const [cameraError, setCameraError] = useState('');
  const [pending, setPending] = useState<ScanItem | null>(null);
  const [printingOptions, setPrintingOptions] = useState<ScryfallCard[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [selectedCollection, setSelectedCollection] = useState('main');
  const [newCollectionName, setNewCollectionName] = useState('');
  const [newDeckName, setNewDeckName] = useState('');
  const [selectedDeckId, setSelectedDeck] = useState('');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ScryfallCard[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchMessage, setSearchMessage] = useState('');
  const [deckSuggestions, setDeckSuggestions] = useState<ScryfallCard[]>([]);
  const [suggestionBusy, setSuggestionBusy] = useState(false);
  const [foil, setFoil] = useState(false);
  const [lastScan, setLastScan] = useState('');
  const [importMessage, setImportMessage] = useState('');
  const [expandedHistoryId, setExpandedHistoryId] = useState('');
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [expandedCollection, setExpandedCollection] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rapidTimer = useRef<number | null>(null);
  const rapidLastSig = useRef<number[] | null>(null);
  const rapidStable = useRef(0);
  const rapidScannedSig = useRef<number[] | null>(null);
  const scanLock = useRef(false);

  const commit = useCallback((next: typeof store | ((old: typeof store) => typeof store)) => {
    setStore(old => {
      const value = typeof next === 'function' ? next(old) : next;
      void saveStore(value).catch(e => setError(e instanceof Error ? e.message : String(e))); return value;
    });
  }, []);

  useEffect(() => {
    void loadStore().then(cached => { setStore(cached); setHydrated(true); }).catch(() => setHydrated(true));
    const cachedCatalog = (() => { try { return JSON.parse(localStorage.getItem(CATALOG_CACHE) || 'null'); } catch { return null; } })();
    if (cachedCatalog?.names?.length) {
      setCatalog(buildNameIndex(cachedCatalog.names)); setCatalogDate(cachedCatalog.date || '');
      setCatalogState(`${cachedCatalog.names.length.toLocaleString()} names cached on this device`);
    }
    warmUpOcr();
    const off = onOcrStatus(s => setOcrState(s));
    return () => { off(); stopCamera(); };
  }, []);

  useEffect(() => { if (hydrated) void saveStore(store).catch(e => setError(e instanceof Error ? e.message : String(e))); }, [store, hydrated]);
  const stopCamera = useCallback(() => {
    if (rapidTimer.current != null) window.clearInterval(rapidTimer.current);
    rapidTimer.current = null; setRapid(false);
    streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null;
    setStreaming(false); setTorch(false);
  }, []);

  const loadCatalog = useCallback(async (force = false) => {
    if (catalog.length && !force) return;
    setCatalogState('Downloading Scryfall card-name catalog…'); setError('');
    try {
      let names: string[] = [];
      if (!force) {
        try { const c = JSON.parse(localStorage.getItem(CATALOG_CACHE) || 'null'); if (c?.names?.length) names = c.names; } catch { /* ignore */ }
      }
      if (!names.length || force) {
        const data = await scryfall<{ data: string[] }>('https://api.scryfall.com/catalog/card-names');
        names = data.data;
        const payload = { names, date: new Date().toISOString() };
        try { localStorage.setItem(CATALOG_CACHE, JSON.stringify(payload)); } catch { /* matching still works for this session */ }
        setCatalogDate(payload.date);
      }
      setCatalog(buildNameIndex(names)); setCatalogState(`${names.length.toLocaleString()} names ready on this device`);
    } catch (e) { setCatalogState('Catalog unavailable — manual search still works'); setError(e instanceof Error ? e.message : String(e)); }
  }, [catalog.length]);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);

  const startCamera = useCallback(async () => {
    setCameraError(''); setError('');
    if (!navigator.mediaDevices?.getUserMedia) { setCameraError('Camera access requires HTTPS or localhost. Open this app on the PC or use the HTTPS phone address.'); return; }
    stopCamera();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: cameraFacing }, width: { ideal: 1920 }, height: { ideal: 1080 }, focusMode: 'continuous' as any } as MediaTrackConstraints });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      const track = stream.getVideoTracks()[0];
      const caps = (track?.getCapabilities?.() || {}) as MediaTrackCapabilities & { torch?: boolean; focusMode?: string[]; exposureMode?: string[] };
      setTorchAvailable(Boolean(caps.torch));
      const plan = focusPlan({ focusMode: caps.focusMode, exposureMode: caps.exposureMode }, false);
      if (plan.advanced.length) await track.applyConstraints({ advanced: plan.advanced as any }).catch(() => undefined);
      setStreaming(true); setStatus('Camera ready — hold one card inside the guide');
    } catch (e) { setCameraError(e instanceof Error ? e.message : 'Camera could not be started.'); }
  }, [cameraFacing, stopCamera]);

  const setTorchMode = useCallback(async (enabled: boolean) => {
    const track = streamRef.current?.getVideoTracks()[0]; if (!track) return;
    try { await track.applyConstraints({ advanced: [{ torch: enabled } as any] }); setTorch(enabled); }
    catch { setTorchAvailable(false); setError('This camera/browser does not expose a working flashlight control.'); }
  }, []);

  const resolveCard = useCallback(async (name: string) => fetchNamed(name), []);

  const identifyCanvas = useCallback(async (frame: HTMLCanvasElement, sourceLabel = 'Camera') => {
    if (scanLock.current) return;
    scanLock.current = true; setBusy(true); setError(''); setPrintingOptions([]); setStatus('Finding card…');
    const started = performance.now();
    try {
      const prepared = prepareCardFromFrame(frame, { boxMode: false, calibration: null });
      let cardCanvas = prepared.card;
      // If the detector cannot find a card in a portrait camera frame, use a
      // centered 5:7 fallback. No sharpness score is ever allowed to veto OCR.
      if (prepared.source === 'guide' && (frame.width / frame.height < 0.58 || frame.width / frame.height > 1.05)) cardCanvas = centerCardCrop(frame);
      const sharpness = measureTitleSharpness(cardCanvas);
      const focusPlanResult = softAttemptPlan([sharpness], { snap: true });
      const titleReads: string[] = [];
      const readSpecs = [...BAND_VARIANTS.slice(0, 3), ...TITLE_RESCUE_BANDS.slice(0, 2)];
      for (const spec of readSpecs) {
        const read = await ocrTitleBandCapped(cardCanvas, spec, { fast: true, capMs: 1400 });
        if (read.text.trim()) titleReads.push(read.text.trim());
        const candidates = ocrCandidates(titleReads);
        const matches = catalog.length ? matchNamesPooled(candidates, catalog, 4, { budgetMs: 650 }) : [];
        if (matches.length && (cleanNameVerdict(matches, titleReads, catalog) || matches[0]!.score >= 0.92)) break;
      }
      const rawTitle = titleReads.join('\n');
      const candidates = ocrCandidates(titleReads);
      const matches = catalog.length ? matchNamesPooled(candidates, catalog, 5, { budgetMs: 900 }) : [];
      let bestName = matches[0]?.entry.full || '';
      let confidence = matches[0]?.score || 0;
      if (matches.length) {
        const top = matches[0]!; const gap = top.score - (matches[1]?.score || 0);
        const decisive = cleanNameVerdict(matches, titleReads, catalog) || (top.score >= 0.92 && gap >= 0.08);
        if (!decisive) { setSuggestions([...new Set(matches.slice(0, 5).map(m => m.entry.full))]); throw new Error('The title read is ambiguous. Choose the correct card from the suggestions instead of saving a guess.'); }
      }
      if (!bestName && candidates.length) {
        const first = candidates.sort((a, b) => b.length - a.length)[0];
        if (first && first.length >= 4) {
          const fuzzy = await scryfall<{ name: string }>(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(first)}`).catch(() => null);
          bestName = fuzzy?.name || ''; confidence = fuzzy ? 0.58 : 0;
        }
      }
      if (!bestName) throw new Error(`No card name could be identified. OCR read: ${rawTitle || 'no readable title'}. Try a closer, sharper photo or use Search.`);
      setStatus(`Matched name: ${bestName} — checking printing…`);
      const card = await resolveCard(bestName);
      const bottomReads: string[] = [];
      for (const spec of [BOTTOM_BAND, BOTTOM_BAND_CONTRAST]) {
        const read = await ocrBottomBandCapped(cardCanvas, spec, 1200);
        if (read.text.trim()) bottomReads.push(read.text.trim());
      }
      const rawBottom = bottomReads.join('\n');
      const bottomCandidates = parseBottomLineCandidates(rawBottom);
      const strictBottom = parseBottomLine(rawBottom);
      let chosen = card; let printingConfirmed = false; let printingReason = 'Name matched; printing not yet confirmed';
      if (strictBottom?.setCode && strictBottom.collectorNumber) {
        const exact = await scryfall<ScryfallCard>(`https://api.scryfall.com/cards/${encodeURIComponent(strictBottom.setCode.toLowerCase())}/${encodeURIComponent(strictBottom.collectorNumber)}`).catch(() => null);
        if (exact && exact.name.toLowerCase() === card.name.toLowerCase()) {
          chosen = exact; printingConfirmed = true; printingReason = `Printing matched from bottom line: ${exact.set.toUpperCase()} #${exact.collector_number}`;
        }
      }
      let prints: ScryfallCard[] = [];
      if (card.prints_search_uri) {
        const p = await scryfall<{ data: ScryfallCard[] }>(card.prints_search_uri).catch(() => null);
        prints = p?.data || [];
        setPrintingOptions(prints.slice(0, 60));
        const asPrintings = prints.map(p => ({ scryfallId: p.id, setCode: p.set, setName: p.set_name, collectorNumber: p.collector_number, artist: p.artist || '', releasedAt: p.released_at || '', rarity: p.rarity, finishes: p.finishes || [], fullArt: p.full_art, borderColor: p.border_color }));
        if (!printingConfirmed) {
          const bottom = strictBottom ? { collectorNumber: strictBottom.collectorNumber, setCode: strictBottom.setCode, separator: strictBottom.separator, artist: null, lines: bottomReads } : null;
          const bottomMatch = bottom ? matchPrintingByBottom(bottom, asPrintings as PrintingLike[]) : null;
          if (bottomMatch) {
            const p = prints.find(x => x.id === bottomMatch.printing.scryfallId);
            if (p) { chosen = p; printingConfirmed = true; printingReason = `Printing matched by ${bottomMatch.why}`; }
          }
        }
        if (!printingConfirmed && prints.length) {
          const referencePrintings = selectReferencePrintings(asPrintings, { baseId: card.id, candidates: bottomCandidates.map(x => ({ setCode: x.setCode || '', collectorNumber: x.collectorNumber })) });
          const queryFingerprint = fingerprintCanvas(cardCanvas);
          const refs = referencePrintings.map(p => { const found = prints.find(x => x.id === p.scryfallId); return found ? { id: found.id, imageUrl: cardImage(found) } : null; }).filter((x): x is { id: string; imageUrl: string } => Boolean(x?.imageUrl));
          if (refs.length > 1) {
            const ranked = await rankVisualReferences(queryFingerprint, refs);
            const visualWin = decisiveVisualPrinting(ranked);
            if (visualWin) {
              const p = prints.find(x => x.id === visualWin.id);
              if (p) { chosen = p; printingConfirmed = true; printingReason = `Printing matched by artwork (distance ${visualWin.distance})`; }
            } else if (ranked.length) printingReason = `Artwork compared; not enough separation to confirm (${ranked[0]!.distance} best distance)`;
          }
        }
      }
      const detectedFoil = strictBottom?.separator === 'star';
      const item: ScanItem = { id: uniqueId(), card: chosen, foil: detectedFoil, printingConfirmed, confidence, rawTitle, rawBottom, addedAt: new Date().toISOString() };
      setSuggestions([]); setPending(item); setFoil(detectedFoil); setLastScan(`${((performance.now() - started) / 1000).toFixed(1)}s`);
      setStatus(`${chosen.name} — ${printingReason}`);
      if (rapidAutoAdd) {
        commit(old => { const existing = old.scans.find(x => x.card.id === item.card.id && x.foil === item.foil);
          if (existing) return { ...old, scans: old.scans.map(x => x.id === existing.id ? { ...x, confidence: Math.max(x.confidence, item.confidence) } : x) };
          return { ...old, scans: [item, ...old.scans] }; });
        setPending(null);
      } else if (sourceLabel === 'Rapid Fire') {
        // Pause after one result when auto-add is off so a later frame
        // cannot overwrite the card awaiting user confirmation.
        if (rapidTimer.current != null) window.clearInterval(rapidTimer.current);
        rapidTimer.current = null; setRapid(false);
      }
      return item;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e); setError(msg); setStatus('Scan did not identify a card');
      return null;
    } finally { scanLock.current = false; setBusy(false); }
  }, [catalog, rapidAutoAdd, resolveCard, commit]);

  const addScanItem = useCallback((item: ScanItem) => {
    commit(old => {
      const existing = old.scans.find(x => x.card.id === item.card.id && x.foil === item.foil);
      if (existing) return { ...old, scans: old.scans.map(x => x.id === existing.id ? { ...x, confidence: Math.max(x.confidence, item.confidence) } : x) };
      return { ...old, scans: [item, ...old.scans] };
    });
    setPending(null); setStatus(`Added ${item.card.name} to the temporary scan list`);
  }, [commit]);

  const capture = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) { setError('Start the camera before scanning.'); return; }
    const frame = canvasFromVideo(video); await identifyCanvas(frame, 'Camera');
  }, [identifyCanvas]);

  const onUpload = useCallback(async (file?: File) => {
    if (!file) return;
    try { const frame = await fileToCanvas(file); await identifyCanvas(frame, 'Photo'); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [identifyCanvas]);

  const startRapid = useCallback(() => {
    if (!streamRef.current) { setError('Start the camera before enabling Rapid Fire.'); return; }
    setRapid(true); rapidLastSig.current = null; rapidScannedSig.current = null; rapidStable.current = 0; setStatus('Rapid Fire active — show one card at a time');
    rapidTimer.current = window.setInterval(() => {
      const video = videoRef.current; if (!video?.videoWidth || scanLock.current) return;
      try {
        const frame = canvasFromVideo(video); const sigCanvas = document.createElement('canvas'); sigCanvas.width = 24; sigCanvas.height = 34;
        const ctx = sigCanvas.getContext('2d'); if (!ctx) return;
        ctx.drawImage(frame, 0, 0, 24, 34); const px = ctx.getImageData(0, 0, 24, 34).data;
        const sig: number[] = []; for (let i = 0; i < px.length; i += 4) sig.push(Math.round((0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!) / 16));
        const diff = rapidLastSig.current ? sig.reduce((sum, v, i) => sum + Math.abs(v - (rapidLastSig.current?.[i] || 0)), 0) / sig.length : 999;
        if (diff > 4) { rapidStable.current = 1; rapidLastSig.current = sig; }
        else { rapidStable.current++; }
        const scannedDiff = rapidScannedSig.current ? sig.reduce((sum, v, i) => sum + Math.abs(v - (rapidScannedSig.current?.[i] || 0)), 0) / sig.length : 999;
        if (rapidStable.current >= 2 && diff <= 4 && scannedDiff > 4) { rapidStable.current = 0; rapidScannedSig.current = sig; void identifyCanvas(frame, 'Rapid Fire'); }
        rapidLastSig.current = sig;
      } catch { /* a missed camera tick is not a scan failure */ }
    }, 650);
  }, [identifyCanvas]);

  const stopRapid = useCallback(() => { if (rapidTimer.current != null) window.clearInterval(rapidTimer.current); rapidTimer.current = null; setRapid(false); setStatus('Rapid Fire stopped'); }, []);

  const searchCards = useCallback(async (q = query) => {
    if (!q.trim()) return;
    setSearchBusy(true); setSearchMessage('Searching Scryfall…'); setError('');
    try {
      const data = await scryfall<{ data: ScryfallCard[]; total_cards: number }>(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q.trim())}&order=name&unique=cards`);
      setSearchResults(data.data); setSearchMessage(`${data.total_cards.toLocaleString()} results — showing first ${data.data.length}`);
    } catch (e) { setSearchResults([]); setSearchMessage(e instanceof Error ? e.message : 'Search failed.'); }
    finally { setSearchBusy(false); }
  }, [query]);

  const addManualCard = useCallback(async (card: ScryfallCard) => {
    const item: ScanItem = { id: uniqueId(), card, foil: false, printingConfirmed: true, confidence: 1, rawTitle: 'Manual search', rawBottom: '', addedAt: new Date().toISOString() };
    addScanItem(item); setTab('scan');
  }, [addScanItem]);

  const chooseSuggestion = useCallback(async (name: string) => {
    setBusy(true); setError('');
    try {
      const card = await resolveCard(name);
      setPending({ id: uniqueId(), card, foil: false, printingConfirmed: false, confidence: 0.7, rawTitle: 'User selected from OCR suggestions', rawBottom: '', addedAt: new Date().toISOString() });
      setFoil(false); setSuggestions([]); setPrintingOptions([]); setStatus(`Selected ${card.name}; printing still needs confirmation`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [resolveCard]);

  const addScansToCollection = useCallback((collectionId: string) => {
    if (!store.scans.length) return;
    commit(old => {
      const items = [...old.items];
      for (const scan of old.scans) {
        const found = items.find(x => x.collectionId === collectionId && x.card.id === scan.card.id && x.foil === scan.foil && x.condition === 'Near Mint');
        if (found) found.quantity += 1;
        else items.push({ id: uniqueId(), collectionId, card: scan.card, foil: scan.foil, quantity: 1, condition: 'Near Mint', language: 'English', priceAtAdd: unitPrice(scan.card, scan.foil), addedAt: new Date().toISOString(), lastPrice: unitPrice(scan.card, scan.foil), lastCheckedAt: null });
      }
      return { ...old, items, scans: [] };
    });
    setStatus(`Moved temporary scans into ${store.collections.find(c => c.id === collectionId)?.name || 'collection'}`);
  }, [commit, store.scans.length, store.collections]);

  const createCollection = useCallback(() => {
    const name = newCollectionName.trim(); if (!name) return;
    const c = { id: uniqueId(), name, createdAt: new Date().toISOString() };
    commit(old => ({ ...old, collections: [...old.collections, c] })); setSelectedCollection(c.id); setNewCollectionName('');
  }, [commit, newCollectionName]);

  const createDeck = useCallback(() => {
    const name = newDeckName.trim(); if (!name) return;
    const deck: Deck = { id: uniqueId(), name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    commit(old => {
      const deckItems = [...old.deckItems];
      for (const scan of old.scans) {
        deckItems.push({ id: uniqueId(), deckId: deck.id, card: scan.card, quantity: 1, commander: false, foil: scan.foil });
      }
      const items = [...old.items];
      for (const scan of old.scans) {
        const found = items.find(x => x.collectionId === selectedCollection && x.card.id === scan.card.id && x.foil === scan.foil && x.condition === 'Near Mint');
        if (found) found.quantity += 1;
        else items.push({ id: uniqueId(), collectionId: selectedCollection, card: scan.card, foil: scan.foil, quantity: 1, condition: 'Near Mint', language: 'English', priceAtAdd: unitPrice(scan.card, scan.foil), addedAt: new Date().toISOString(), lastPrice: unitPrice(scan.card, scan.foil), lastCheckedAt: null });
      }
      return { ...old, decks: [deck, ...old.decks], deckItems, items, scans: [] };
    });
    setNewDeckName(''); setSelectedDeck(deck.id); setTab('decks');
  }, [commit, newDeckName, selectedCollection]);

  const createDeckEmpty = useCallback(() => {
    const name = newDeckName.trim(); if (!name) return;
    const deck: Deck = { id: uniqueId(), name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    commit(old => ({ ...old, decks: [deck, ...old.decks] })); setNewDeckName(''); setSelectedDeck(deck.id);
  }, [commit, newDeckName]);

  const addCardToDeck = useCallback((deckId: string, card: ScryfallCard) => {
    commit(old => {
      const found = old.deckItems.find(x => x.deckId === deckId && x.card.id === card.id && !x.commander);
      const deckItems = found ? old.deckItems.map(x => x.id === found.id ? { ...x, quantity: x.quantity + 1 } : x) : [...old.deckItems, { id: uniqueId(), deckId, card, quantity: 1, commander: false, foil: false }];
      return { ...old, deckItems, decks: old.decks.map(d => d.id === deckId ? { ...d, updatedAt: new Date().toISOString() } : d) };
    });
  }, [commit]);

  const setCommander = useCallback((deckId: string, card: ScryfallCard) => {
    commit(old => {
      const deckItems = old.deckItems.filter(x => !(x.deckId === deckId && x.commander)).concat({ id: uniqueId(), deckId, card, quantity: 1, commander: true, foil: false });
      return { ...old, deckItems, decks: old.decks.map(d => d.id === deckId ? { ...d, commander: card, updatedAt: new Date().toISOString() } : d) };
    });
  }, [commit]);

  const removeScan = useCallback((id: string) => commit(old => ({ ...old, scans: old.scans.filter(x => x.id !== id) })), [commit]);
  const removeCollectionItem = useCallback((id: string) => commit(old => ({ ...old, items: old.items.filter(x => x.id !== id), priceHistory: (old.priceHistory || []).filter(x => x.itemId !== id) })), [commit]);
  const removeDeckItem = useCallback((id: string) => commit(old => ({ ...old, deckItems: old.deckItems.filter(x => x.id !== id) })), [commit]);

  const refreshPrices = useCallback(async () => {
    const ids = [...new Set(store.items.map(i => i.card.id))]; if (!ids.length) return;
    setRefreshingPrices(true); setError('');
    try {
      const updates = new Map<string, ScryfallCard>();
      for (let i = 0; i < ids.length; i += 75) {
        const batch = ids.slice(i, i + 75);
        const response = await scryfall<{ data: ScryfallCard[] }>('https://api.scryfall.com/cards/collection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiers: batch.map(id => ({ id })) }) });
        response.data.forEach(c => updates.set(c.id, c)); await sleep(110);
      }
      const checkedAt = new Date().toISOString();
      commit(old => {
        const priceHistory = [...(old.priceHistory || [])];
        const items = old.items.map(item => {
          const fresh = updates.get(item.card.id); if (!fresh) return item;
          const price = unitPrice(fresh, item.foil);
          if (price != null && !priceHistory.some(h => h.itemId === item.id && h.checkedAt.slice(0,10) === checkedAt.slice(0,10))) {
            priceHistory.push({ id: uniqueId(), itemId: item.id, price, foil: item.foil, checkedAt });
          }
          return { ...item, card: { ...item.card, prices: fresh.prices }, lastPrice: price, lastCheckedAt: checkedAt };
        });
        return { ...old, items, priceHistory };
      });
      setStatus(`Prices refreshed for ${updates.size} unique cards`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Price refresh failed.'); }
    finally { setRefreshingPrices(false); }
  }, [commit, store.items]);

  const exportCollection = useCallback((format: 'manabox' | 'moxfield' | 'archidekt') => {
    const items = store.items.filter(i => i.collectionId === selectedCollection);
    const rows = items.map(makeExportRow);
    const content = format === 'manabox' ? exportManaBox(rows, store.collections.find(c => c.id === selectedCollection)?.name || 'Collection') : format === 'moxfield' ? exportMoxfield(rows) : exportArchidekt(rows);
    const blob = new Blob([content], { type: format === 'moxfield' ? 'text/plain' : 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `aetherforge-${format}-${Date.now()}.${format === 'moxfield' ? 'txt' : 'csv'}`; a.click(); URL.revokeObjectURL(url);
  }, [store, selectedCollection]);

  const exportBackup = useCallback(() => {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `aetherforge-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); URL.revokeObjectURL(url);
  }, [store]);

  const importCsv = useCallback(async (file?: File) => {
    if (!file) return; setImportMessage('Reading CSV…');
    try {
      const parsed = parseManaBoxCsvDetailed(await file.text());
      if (!parsed.rows.length) throw new Error(parsed.errors[0] || 'No valid card rows were found.');
      const resolved: CollectionItem[] = [];
      for (const row of parsed.rows) {
        let card: ScryfallCard | null = null;
        if (row.scryfallId) card = await scryfall<ScryfallCard>(`https://api.scryfall.com/cards/${row.scryfallId}`).catch(() => null);
        if (!card) card = await fetchNamed(row.name).catch(() => null);
        if (!card) { parsed.errors.push(`${row.name}: Scryfall could not resolve this card.`); continue; }
        if (row.setCode && row.collectorNumber) {
          const exact = await scryfall<ScryfallCard>(`https://api.scryfall.com/cards/${row.setCode.toLowerCase()}/${encodeURIComponent(row.collectorNumber)}`).catch(() => null);
          if (exact && exact.name.toLowerCase() === card.name.toLowerCase()) card = exact;
        }
        resolved.push({ id: uniqueId(), collectionId: selectedCollection, card, foil: row.foil, quantity: row.quantity, condition: row.condition || 'Near Mint', language: row.language || 'English', priceAtAdd: unitPrice(card, row.foil), addedAt: new Date().toISOString(), lastPrice: unitPrice(card, row.foil), lastCheckedAt: null });
        await sleep(110);
      }
      commit(old => {
        const items = [...old.items];
        for (const incoming of resolved) {
          const existing = items.find(x => x.collectionId === incoming.collectionId && x.card.id === incoming.card.id && x.foil === incoming.foil && x.condition === incoming.condition && x.language === incoming.language);
          if (existing) existing.quantity += incoming.quantity; else items.push(incoming);
        }
        return { ...old, items };
      });
      setImportMessage(`Imported ${resolved.length} rows. ${parsed.errors.length ? parsed.errors.length + ' rows need attention.' : 'No row errors.'}`);
    } catch (e) { setImportMessage(e instanceof Error ? e.message : 'CSV import failed.'); }
  }, [commit, selectedCollection]);

  const collectionItems = useMemo(() => store.items.filter(i => i.collectionId === selectedCollection), [store.items, selectedCollection]);
  const collectionValue = useMemo(() => collectionItems.reduce((sum, i) => sum + (unitPrice(i.card, i.foil) ?? 0) * i.quantity, 0), [collectionItems]);
  const selectedDeckItems = useMemo(() => store.deckItems.filter(i => i.deckId === selectedDeckId), [store.deckItems, selectedDeckId]);
  const activeDeck = store.decks.find(d => d.id === selectedDeckId) || null;
  const deckValue = selectedDeckItems.reduce((sum, i) => sum + (unitPrice(i.card, i.foil) ?? 0) * i.quantity, 0);
  const deckCardCount = selectedDeckItems.reduce((sum, i) => sum + i.quantity, 0);
  const deckIdentityIssues = activeDeck?.commander ? selectedDeckItems.filter(i => !fitsIdentity(i.card.color_identity || [], activeDeck.commander?.color_identity || [])) : [];
  const deckDuplicateIssues = selectedDeckItems.filter(i => i.quantity > 1 && !/basic land/i.test(i.card.type_line || ''));
  const getDeckSuggestions = async () => {
    if (!activeDeck?.commander) { setError('Set a commander before requesting deck suggestions.'); return; }
    setSuggestionBusy(true); setDeckSuggestions([]);
    try { const identity = activeDeck.commander.color_identity?.join('') || 'c'; const q = `id<=${identity} legal:commander -is:commander`;
      const data = await scryfall<{data:ScryfallCard[]}>(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=edhrec&dir=asc`);
      const inDeck = new Set(selectedDeckItems.map(i => i.card.id)); setDeckSuggestions(data.data.filter(c => !inDeck.has(c.id)).slice(0,12));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load deck suggestions.'); }
    finally { setSuggestionBusy(false); }
  };
  const totalCollectionValue = store.collections.reduce((sum, c) => sum + store.items.filter(i => i.collectionId === c.id).reduce((s, i) => s + (unitPrice(i.card, i.foil) ?? 0) * i.quantity, 0), 0);

  const searchAutocomplete = useMemo(() => catalog.length && query.trim() ? autocomplete(catalog, query, 6).map(x => x.full) : [], [catalog, query]);

  if (!hydrated) return <div className="app-shell loading-shell"><div className="loading-card"><div className="brand-mark"><Layers3 size={22}/></div><h2>AETHERFORGE MTG</h2><LoaderCircle className="spin" size={22}/><span>Opening your local card library…</span></div></div>;

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><Layers3 size={22}/></div><div><div className="brand-name">AETHERFORGE <span>MTG</span></div><div className="brand-sub">CARD SCANNER & COLLECTION MANAGER</div></div></div>
      <div className="top-status"><span className="status-dot"/><span>{status}</span></div>
      <div className="top-actions"><button className="icon-btn" title="Export backup" onClick={exportBackup}><ArrowDownToLine size={17}/></button><div className="version">V3.0 LOCAL</div></div>
    </header>
    <nav className="tabs">
      {([['scan','Scan',Camera],['search','Search',Search],['collections','Collections',Layers3],['decks','Decks',PackagePlus],['settings','Settings',Settings2]] as const).map(([id,label,Icon]) => <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}><Icon size={17}/><span>{label}</span>{id === 'scan' && store.scans.length > 0 && <b>{store.scans.length}</b>}</button>)}
    </nav>

    {error && <div className="alert error"><AlertCircle size={17}/><span>{error}</span><button onClick={() => setError('')}><X size={16}/></button></div>}

    {tab === 'scan' && <main className="scan-layout">
      <section className="scanner-column">
        <div className="section-head"><div><div className="eyebrow">LIVE IDENTIFICATION</div><h1>Card Scanner</h1><p>On-device OCR with collector-number and artwork printing verification.</p></div><div className="scan-state"><span className={`pill ${ocrState === 'ready' ? 'good' : ''}`}>{ocrState === 'ready' ? 'OCR READY' : ocrState.toUpperCase()}</span><span className="pill neutral">{catalog.length ? `${Math.round(catalog.length / 1000)}K NAMES` : 'CATALOG LOADING'}</span></div></div>
        <div className="viewfinder">
          <video ref={videoRef} playsInline muted className={streaming ? 'video-live' : 'video-hidden'} />
          {!streaming && <div className="camera-placeholder"><div className="camera-placeholder-icon"><Camera size={34}/></div><h3>Camera is off</h3><p>Start your camera or upload a card photo to scan.</p><button className="primary" onClick={startCamera}><Camera size={17}/> Start camera</button></div>}
          {streaming && <div className="guide-frame"><span className="corner tl"/><span className="corner tr"/><span className="corner bl"/><span className="corner br"/><div className="guide-label">ALIGN ONE CARD</div></div>}
          {busy && <div className="scan-overlay"><LoaderCircle className="spin" size={28}/><strong>Identifying card</strong><span>Reading title and bottom line</span></div>}
          <div className="viewfinder-tools">{streaming && <button className={`round-tool ${torch ? 'selected' : ''}`} title={torchAvailable ? 'Toggle flashlight' : 'Flashlight unavailable'} disabled={!torchAvailable} onClick={() => void setTorchMode(!torch)}><Sun size={17}/></button>}<button className="round-tool" title="Switch camera" onClick={() => { stopCamera(); setCameraFacing(v => v === 'environment' ? 'user' : 'environment'); setStatus('Camera switched — press Start camera to reconnect'); }}><ArrowLeftRight size={17}/></button></div>
        </div>
        {cameraError && <div className="inline-error">{cameraError}</div>}
        <div className="scanner-controls">
          {!streaming ? <button className="primary" onClick={startCamera}><Camera size={17}/> Start camera</button> : <button className="primary capture" disabled={busy} onClick={() => void capture()}><Camera size={18}/> {busy ? 'Scanning…' : 'Snap card'}</button>}
          <button className="secondary" onClick={() => fileRef.current?.click()}><ImagePlus size={17}/> Upload photo</button>
          <input ref={fileRef} hidden type="file" accept="image/*" capture="environment" onChange={e => { void onUpload(e.target.files?.[0]); e.currentTarget.value = ''; }}/>
          {streaming && !rapid && <button className="secondary" onClick={startRapid}><Activity size={17}/> Rapid Fire</button>}
          {rapid && <button className="danger" onClick={stopRapid}><StopCircle size={17}/> Stop Rapid</button>}
          {streaming && <button className="quiet" onClick={stopCamera}><Square size={15}/> Stop camera</button>}
        </div>
        <div className="scanner-options"><label className="checkline"><input type="checkbox" checked={rapidAutoAdd} onChange={e => setRapidAutoAdd(e.target.checked)}/> Auto-add Rapid matches to temporary list</label><span>Last scan: {lastScan || '—'}</span></div>
        <div className="scan-explain"><ShieldCheck size={17}/><span>Soft focus is advisory only. A blurry frame never blocks identification; the scanner still attempts OCR and number matching.</span></div>
      </section>

      <aside className="scan-side">
        {suggestions.length > 0 && <div className="panel suggestion-panel"><div className="panel-head"><div><div className="eyebrow">OCR NEEDS CONFIRMATION</div><h2>Which card is it?</h2></div><button className="icon-btn" onClick={() => setSuggestions([])}><X size={16}/></button></div><div className="suggestion-list">{suggestions.map(name => <button key={name} onClick={() => void chooseSuggestion(name)}>{name}<span>Use this card</span></button>)}</div></div>}
        {pending && <div className="panel result-panel"><div className="panel-head"><div><div className="eyebrow">LATEST RESULT</div><h2>Card identified</h2></div><button className="icon-btn" onClick={() => setPending(null)}><X size={16}/></button></div><CardTile card={pending.card} foil={foil} setFoil={setFoil}/><div className="result-meta"><span className={`pill ${pending.printingConfirmed ? 'good' : 'warning'}`}>{pending.printingConfirmed ? 'PRINTING CONFIRMED' : 'PRINTING UNCONFIRMED'}</span><span className="confidence">Name score {Math.round(pending.confidence * 100)}%</span></div><div className="evidence"><div><b>Title OCR</b><span>{pending.rawTitle || '—'}</span></div><div><b>Bottom OCR</b><span>{pending.rawBottom || '—'}</span></div></div>{printingOptions.length > 1 && <label className="printing-select"><span>CHOOSE PRINTING / VERSION</span><select value={pending.card.id} onChange={e => { const selected = printingOptions.find(p => p.id === e.target.value); if (selected) { setPending({ ...pending, card: selected, printingConfirmed: true }); setStatus(`Printing manually selected: ${selected.set.toUpperCase()} #${selected.collector_number}`); } }}>{printingOptions.map(p => <option key={p.id} value={p.id}>{p.set.toUpperCase()} #{p.collector_number} · {p.set_name} · {p.released_at || 'date unknown'}</option>)}</select></label>}<button className="primary full" onClick={() => addScanItem({ ...pending, foil })}><Plus size={17}/> Add to temporary list</button></div>}
        <div className="panel scan-list-panel"><div className="panel-head"><div><div className="eyebrow">TEMPORARY SCAN LIST</div><h2>{store.scans.length} cards</h2></div><span className="value-chip">{money(store.scans.reduce((s,x) => s + (unitPrice(x.card,x.foil) || 0),0))}</span></div>
          {store.scans.length === 0 ? <div className="empty-small"><Layers3 size={25}/><span>Scanned cards wait here until you review and save them.</span></div> : <div className="mini-list">{store.scans.slice(0, 8).map(item => <div className="mini-row" key={item.id}><img src={cardImage(item.card)} alt=""/><div className="mini-copy"><b>{item.card.name}</b><span>{item.card.set.toUpperCase()} · #{item.card.collector_number} · {item.foil ? 'Foil' : 'Normal'} · {item.printingConfirmed ? 'printing confirmed' : 'printing unconfirmed'}</span></div><button className="icon-btn small" onClick={() => removeScan(item.id)}><Trash2 size={15}/></button></div>)}{store.scans.length > 8 && <div className="more-note">+ {store.scans.length - 8} more cards</div>}</div>}
          <div className="save-scan-row"><select value={selectedCollection} onChange={e => setSelectedCollection(e.target.value)}>{store.collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><button className="primary" disabled={!store.scans.length} onClick={() => addScansToCollection(selectedCollection)}>Save to collection</button></div>
          <div className="create-deck-row"><input value={newDeckName} onChange={e => setNewDeckName(e.target.value)} placeholder="New deck name"/><button className="secondary" disabled={!store.scans.length || !newDeckName.trim()} onClick={createDeck}><PackagePlus size={16}/> Make deck</button></div>
        </div>
        <div className="panel quick-stats"><div className="stat"><span>COLLECTIONS</span><b>{store.collections.length}</b></div><div className="stat"><span>UNIQUE CARDS</span><b>{store.items.length}</b></div><div className="stat"><span>TOTAL VALUE</span><b>{money(totalCollectionValue)}</b></div></div>
      </aside>
    </main>}

    {tab === 'search' && <main className="page"><div className="section-head"><div><div className="eyebrow">SCRYFALL SEARCH</div><h1>Find a card</h1><p>Search by name, rules text, set, color, type, or Commander legality.</p></div></div><div className="search-bar"><Search size={19}/><input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && void searchCards()} placeholder='Try: name:"Sol Ring" or c:blue t:creature'/><button className="primary" disabled={searchBusy} onClick={() => void searchCards()}>{searchBusy ? <LoaderCircle className="spin" size={16}/> : 'Search'}</button></div>{searchAutocomplete.length > 0 && <div className="autocomplete">{searchAutocomplete.map(n => <button key={n} onClick={() => { setQuery(`name:"${n}"`); void searchCards(`name:"${n}"`); }}>{n}</button>)}</div>}<div className="subtle-line">{searchMessage}</div><div className="card-grid">{searchResults.map(card => <div className="search-card" key={card.id}><img src={cardImage(card)} alt={card.name}/><div className="search-card-info"><b>{card.name}</b><span>{card.set.toUpperCase()} · #{card.collector_number} · {card.rarity}</span><span>{money(Number(card.prices?.usd))}</span><button className="secondary full" onClick={() => void addManualCard(card)}><Plus size={15}/> Add to scan list</button></div></div>)}</div></main>}

    {tab === 'collections' && <main className="page"><div className="section-head"><div><div className="eyebrow">YOUR CARD LIBRARY</div><h1>Collections</h1><p>Multiple binders, foil-aware values, price refresh, and ManaBox-compatible exports.</p></div><div className="head-actions"><button className="secondary" onClick={() => importRef.current?.click()}><Upload size={16}/> Import CSV</button><input ref={importRef} hidden type="file" accept=".csv,text/csv" onChange={e => { void importCsv(e.target.files?.[0]); e.currentTarget.value = ''; }}/><button className="secondary" onClick={() => void refreshPrices()} disabled={refreshingPrices || !store.items.length}>{refreshingPrices ? <LoaderCircle className="spin" size={16}/> : <RefreshCw size={16}/>} Refresh prices</button></div></div><div className="collection-overview">{store.collections.map(c => { const rows = store.items.filter(i => i.collectionId === c.id); const value = rows.reduce((sum,i) => sum + (unitPrice(i.card,i.foil) || 0) * i.quantity,0); return <button key={c.id} className={selectedCollection === c.id ? 'active' : ''} onClick={() => setSelectedCollection(c.id)}><span>{c.name}</span><b>{money(value)}</b><small>{rows.reduce((sum,i)=>sum+i.quantity,0)} cards · {rows.length} unique</small></button>; })}</div>
      {importMessage && <div className="alert info">{importMessage}</div>}
      <div className="collection-toolbar"><div className="collection-select"><label>ACTIVE COLLECTION</label><select value={selectedCollection} onChange={e => setSelectedCollection(e.target.value)}>{store.collections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div><div className="collection-value"><span>ESTIMATED MARKET VALUE</span><b>{money(collectionValue)}</b></div><div className="export-buttons"><button onClick={() => exportCollection('manabox')}>ManaBox CSV</button><button onClick={() => exportCollection('moxfield')}>Moxfield TXT</button><button onClick={() => exportCollection('archidekt')}>Archidekt CSV</button></div></div>
      <div className="new-collection"><input value={newCollectionName} onChange={e => setNewCollectionName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createCollection()} placeholder="Create a collection / binder"/><button className="primary" onClick={createCollection} disabled={!newCollectionName.trim()}><FolderPlus size={16}/> Create collection</button></div>
      <div className="table-wrap"><table><thead><tr><th>Card</th><th>Printing</th><th>Finish</th><th>Qty</th><th>Condition</th><th>Unit value</th><th>Added at</th><th></th></tr></thead><tbody>{collectionItems.map(item => { const movement = item.priceAtAdd == null || unitPrice(item.card,item.foil) == null ? null : priceMovement(unitPrice(item.card,item.foil)!, item.priceAtAdd); return <><tr key={item.id}><td><div className="table-card"><img src={cardImage(item.card)} alt=""/><div><b>{item.card.name}</b><small>{item.card.type_line}</small>{store.deckItems.filter(d => d.card.id === item.card.id).length > 0 && <small className="deck-badge">In: {[...new Set(store.deckItems.filter(d => d.card.id === item.card.id).map(d => store.decks.find(x => x.id === d.deckId)?.name).filter(Boolean))].join(', ')}</small>}</div></div></td><td>{item.card.set.toUpperCase()} #{item.card.collector_number}<small>{item.card.set_name}</small></td><td><button className={`finish-toggle ${item.foil ? 'is-foil' : ''}`} onClick={() => commit(old => ({ ...old, items: old.items.map(x => x.id === item.id ? { ...x, foil: !x.foil, priceAtAdd: unitPrice(x.card, !x.foil), lastPrice: unitPrice(x.card, !x.foil), lastCheckedAt: null } : x), priceHistory: (old.priceHistory || []).filter(h => h.itemId !== item.id) }))}>{item.foil ? 'Foil' : 'Normal'}</button></td><td><div className="qty-control"><button onClick={() => commit(old => ({ ...old, items: old.items.map(x => x.id === item.id ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x) }))}>−</button><b>{item.quantity}</b><button onClick={() => commit(old => ({ ...old, items: old.items.map(x => x.id === item.id ? { ...x, quantity: x.quantity + 1 } : x) }))}>+</button></div></td><td><select value={item.condition} onChange={e => commit(old => ({ ...old, items: old.items.map(x => x.id === item.id ? { ...x, condition: e.target.value } : x) }))}>{['Near Mint','Lightly Played','Moderately Played','Heavily Played','Damaged'].map(c => <option key={c}>{c}</option>)}</select></td><td><b>{money(unitPrice(item.card,item.foil))}</b><small>Added at {money(item.priceAtAdd)}</small>{movement && <small className={movement.kind === 'up' ? 'positive' : movement.kind === 'down' ? 'negative' : ''}>{movement.kind === 'none' ? '—' : `${movement.kind === 'up' ? '+' : movement.kind === 'down' ? '−' : ''}$${Math.abs(movement.diff).toFixed(2)}${movement.pct == null ? '' : ` (${movement.pct.toFixed(1)}%)`}`}</small>}</td><td>{new Date(item.addedAt).toLocaleDateString()}</td><td><div className="row-actions"><button className="icon-btn small" title="Price history" onClick={() => setExpandedHistoryId(v => v === item.id ? '' : item.id)}><Activity size={14}/></button><button className="icon-btn small" onClick={() => removeCollectionItem(item.id)}><Trash2 size={15}/></button></div></td></tr>{expandedHistoryId === item.id && <tr key={`${item.id}-history`}><td colSpan={8}><div className="history-strip"><b>Price history</b>{(store.priceHistory || []).filter(h => h.itemId === item.id).sort((a,b) => a.checkedAt.localeCompare(b.checkedAt)).map(h => <span key={h.id}>{new Date(h.checkedAt).toLocaleString()} · {money(h.price)} · {h.foil ? 'Foil' : 'Normal'}</span>)}{!(store.priceHistory || []).some(h => h.itemId === item.id) && <span>No price checks recorded yet. Refresh prices to start tracking.</span>}</div></td></tr>}</>; })}</tbody></table>{collectionItems.length === 0 && <div className="empty-state"><Layers3 size={32}/><h3>This collection is empty</h3><p>Scan cards or import a ManaBox CSV to get started.</p></div>}</div>
    </main>}

    {tab === 'decks' && <main className="page"><div className="section-head"><div><div className="eyebrow">DECK WORKSHOP</div><h1>Decks</h1><p>Build a deck from your temporary scan list or start with an empty list.</p></div></div><div className="deck-create"><input value={newDeckName} onChange={e => setNewDeckName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createDeckEmpty()} placeholder="Deck name"/><button className="primary" disabled={!newDeckName.trim()} onClick={createDeckEmpty}><Plus size={16}/> Create empty deck</button><button className="secondary" disabled={!store.scans.length || !newDeckName.trim()} onClick={createDeck}><Layers3 size={16}/> Create from scan list</button></div><div className="deck-layout"><aside className="deck-sidebar">{store.decks.map(d => <button key={d.id} className={selectedDeckId === d.id ? 'selected' : ''} onClick={() => setSelectedDeck(d.id)}><div><b>{d.name}</b><small>{store.deckItems.filter(x => x.deckId === d.id).reduce((s,x) => s+x.quantity,0)} cards</small></div><ChevronDown size={16}/></button>)}{!store.decks.length && <div className="empty-small">No decks yet.</div>}</aside>{activeDeck ? <section className="deck-detail"><div className="deck-title"><div><div className="eyebrow">ACTIVE DECK</div><h2>{activeDeck.name}</h2><span>{selectedDeckItems.reduce((s,x)=>s+x.quantity,0)} cards · {money(deckValue)}</span></div><button className="icon-btn" onClick={() => { if (confirm(`Delete ${activeDeck.name}?`)) commit(old => ({ ...old, decks: old.decks.filter(d => d.id !== activeDeck.id), deckItems: old.deckItems.filter(x => x.deckId !== activeDeck.id) })); setSelectedDeck(''); }}><Trash2 size={16}/></button></div><div className="deck-commander"><span>COMMANDER</span>{activeDeck.commander ? <div className="commander-current"><img src={cardImage(activeDeck.commander)} alt=""/><b>{activeDeck.commander.name}</b></div> : <span className="muted">No commander selected. Search for a legendary creature or eligible planeswalker.</span>}</div><div className="deck-suggestion-action"><button className="secondary" disabled={!activeDeck.commander || suggestionBusy} onClick={() => void getDeckSuggestions()}>{suggestionBusy ? <LoaderCircle className="spin" size={15}/> : <Sparkles size={15}/>} Find Commander suggestions</button><span>Ranked by Scryfall EDHREC order and filtered to commander color identity.</span></div>{deckSuggestions.length > 0 && <div className="deck-suggestions">{deckSuggestions.map(c => <div key={c.id}><img src={cardImage(c)} alt=""/><span>{c.name}</span><small>{c.set.toUpperCase()}</small><button onClick={() => addCardToDeck(activeDeck.id,c)}>Add</button></div>)}</div>}<div className="deck-validation"><b>{deckCardCount} / 100 cards</b><span>{activeDeck.commander && !isCommanderEligible(activeDeck.commander.type_line || '', activeDeck.commander.oracle_text || '') ? 'Commander eligibility needs review.' : activeDeck.commander ? `Commander identity: ${(activeDeck.commander.color_identity || []).join('').toUpperCase() || 'Colorless'}` : 'Choose a commander to enable identity checks.'}</span>{deckIdentityIssues.length > 0 && <span className="negative">{deckIdentityIssues.length} card(s) exceed the commander color identity.</span>}{deckDuplicateIssues.length > 0 && <span className="negative">{deckDuplicateIssues.length} non-basic card(s) have duplicate quantities.</span>}</div><div className="deck-add"><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search cards to add" onKeyDown={e => e.key === 'Enter' && void searchCards()}/><button className="secondary" onClick={() => void searchCards()}><Search size={16}/> Search</button></div>{searchResults.length > 0 && <div className="deck-search-results">{searchResults.slice(0,5).map(c => <div key={c.id}><span>{c.name}</span><button onClick={() => addCardToDeck(activeDeck.id,c)}>Add</button><button disabled={!isCommanderEligible(c.type_line || '',c.oracle_text || '')} onClick={() => setCommander(activeDeck.id,c)}>Set commander</button></div>)}</div>}<div className="deck-card-list">{selectedDeckItems.map(i => <div className="deck-row" key={i.id}><img src={cardImage(i.card)} alt=""/><div><b>{i.card.name}</b><small>{i.card.type_line}</small></div><span>×{i.quantity}</span><button className="icon-btn small" onClick={() => removeDeckItem(i.id)}><Trash2 size={15}/></button></div>)}{!selectedDeckItems.length && <div className="empty-state"><PackagePlus size={30}/><h3>No cards in this deck</h3><p>Search for cards above or create a deck from your scan list.</p></div>}</div><div className="deck-footer"><button className="secondary" onClick={() => { const rows = selectedDeckItems.map(makeExportRow); const text = exportMoxfield(rows); const blob = new Blob([text],{type:'text/plain'}); const url=URL.createObjectURL(blob); const a=document.createElement('a');a.href=url;a.download=`${activeDeck.name.replace(/[^a-z0-9]+/gi,'-')}.txt`;a.click();URL.revokeObjectURL(url); }}><Download size={16}/> Export deck list</button></div></section> : <div className="empty-state deck-empty"><PackagePlus size={34}/><h3>Select or create a deck</h3><p>Your deck cards will appear here.</p></div>}</div></main>}

    {tab === 'settings' && <main className="page"><div className="section-head"><div><div className="eyebrow">LOCAL APP CONFIGURATION</div><h1>Settings & data</h1><p>Your collection, decks, and scan list are stored in this browser on this device.</p></div></div><div className="settings-grid"><div className="panel setting-card"><Database size={22}/><h3>Card-name catalog</h3><p>{catalogState}</p><small>{catalogDate ? `Last downloaded ${new Date(catalogDate).toLocaleString()}` : 'The name index downloads from Scryfall.'}</small><button className="secondary full" onClick={() => void loadCatalog(true)}><RefreshCw size={16}/> Refresh name catalog</button></div><div className="panel setting-card"><Sparkles size={22}/><h3>On-device OCR</h3><p>{ocrState === 'ready' ? 'Tesseract.js worker is ready.' : `OCR state: ${ocrState}`}</p><small>OCR reads card title and bottom information locally in your browser after the OCR engine is loaded.</small><button className="secondary full" onClick={() => void ensureOcrWorker().then(() => setStatus('OCR engine ready')).catch(e => setError(String(e)))}><Activity size={16}/> Warm OCR engine</button></div><div className="panel setting-card"><ShieldCheck size={22}/><h3>Local data backup</h3><p>Export a complete JSON backup before clearing browser data or changing devices.</p><button className="primary full" onClick={exportBackup}><Download size={16}/> Export full backup</button></div><div className="panel setting-card"><Upload size={22}/><h3>Restore backup</h3><p>Restore a previously exported AetherForge JSON backup. This replaces the current local data.</p><input type="file" accept="application/json" onChange={async e => { const f=e.target.files?.[0]; if(!f)return; try { const parsed=JSON.parse(await f.text()); if(!parsed.collections || !parsed.items || !parsed.decks || !parsed.scans) throw new Error('This file is not an AetherForge backup.'); void saveStore({ ...createEmptyStore(), ...parsed, priceHistory: parsed.priceHistory || [] }).then(() => { setStore({ ...createEmptyStore(), ...parsed, priceHistory: parsed.priceHistory || [] }); setStatus('Backup restored'); }).catch(err => setError(err instanceof Error ? err.message : String(err))); } catch(err){setError(err instanceof Error?err.message:'Backup restore failed.');} e.currentTarget.value=''; }}/></div></div><div className="data-note"><AlertCircle size={17}/><span>Camera access on a phone requires HTTPS. On the same PC, localhost is treated as secure. Scryfall card details and images require an internet connection; the saved collection remains local.</span></div></main>}

    <footer className="footer"><span>AETHERFORGE MTG V3.0</span><span>Local-first · Scryfall card data · Browser camera</span><span>Collection value is an estimate, not a sale quote.</span></footer>
  </div>;
}

function CardTile({ card, foil, setFoil }: { card: ScryfallCard; foil: boolean; setFoil: (v: boolean) => void }) {
  return <div className="result-card"><img className="result-image" src={cardImage(card)} alt={card.name}/><div className="result-card-copy"><h3>{card.name}</h3><p>{card.type_line}</p><div className="result-line">{card.set.toUpperCase()} · #{card.collector_number}</div><div className="result-line">{card.set_name} · {card.rarity}</div><div className="result-price">{money(unitPrice(card, foil))} <span>{foil ? 'foil price' : 'nonfoil price'}</span></div><label className="foil-toggle"><input type="checkbox" checked={foil} onChange={e => setFoil(e.target.checked)}/> Foil / etched</label></div></div>;
}
