import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertCircle, ArrowDownToLine, ArrowLeftRight, Camera, ChevronDown, Database, Download, FolderPlus, ImagePlus, Layers3, LoaderCircle, PackagePlus, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, Square, StopCircle, Sun, Trash2, Upload, X } from 'lucide-react';
import { autocomplete, buildNameIndex, buildMoxfieldTxt as exportMoxfield, buildArchidektCsv as exportArchidekt, buildManaBoxCsv as exportManaBox, cleanNameVerdict, fitsIdentity, isCommanderEligible, matchNamesPooled, ocrCandidates, parseManaBoxCsvDetailed, priceMovement } from './core/lib.js';
import { prepareCardFromFrame } from './core/detect.js';
import { focusPlan, measureTitleSharpness, softAttemptPlan } from './core/focus.js';
import { BOTTOM_BAND, BOTTOM_BAND_CONTRAST, BAND_VARIANTS, TITLE_RESCUE_BANDS, ensureOcrWorker, warmUpOcr, onOcrStatus, ocrTitleBandCapped, ocrBottomBandCapped } from './core/ocr.js';
import { parseBottomLine, parseBottomLineCandidates } from './core/bottomline.js';
import { matchPrintingByBottom } from './core/lib.js';
import { selectReferencePrintings } from './core/printingselect.js';
import { fingerprintCanvas, rankVisualReferences, decisiveVisualPrinting } from './core/visual.js';
const STORE = 'aetherforge-mtg-v3-store';
const CATALOG_CACHE = 'aetherforge-mtg-v3-catalog';
const money = (n) => n == null || !Number.isFinite(n) ? '—' : `$${n.toFixed(2)}`;
const unitPrice = (card, foil) => {
    const p = foil ? (card.prices?.usd_foil ?? card.prices?.usd_etched) : card.prices?.usd;
    return p == null ? null : Number(p);
};
const cardImage = (card) => card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || card.image_uris?.small || '';
const uniqueId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function createEmptyStore() {
    const main = { id: 'main', name: 'Main Collection', createdAt: new Date().toISOString() };
    return { collections: [main], items: [], decks: [], deckItems: [], scans: [], priceHistory: [] };
}
function openLocalDb() {
    return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
            reject(new Error('IndexedDB is not available'));
            return;
        }
        const request = indexedDB.open('AetherForgeMTG', 1);
        request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains('app'))
            db.createObjectStore('app'); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Could not open local database'));
    });
}
async function loadStore() {
    try {
        const db = await openLocalDb();
        const value = await new Promise((resolve, reject) => {
            const tx = db.transaction('app', 'readonly');
            const req = tx.objectStore('app').get('store');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        db.close();
        if (value?.collections && value?.items && value?.decks && value?.scans)
            return { ...createEmptyStore(), ...value, priceHistory: value.priceHistory || [] };
    }
    catch { /* fallback below */ }
    try {
        const raw = localStorage.getItem(STORE);
        if (raw)
            return { ...createEmptyStore(), ...JSON.parse(raw), priceHistory: JSON.parse(raw).priceHistory || [] };
    }
    catch { /* start clean */ }
    return createEmptyStore();
}
async function saveStore(s) {
    try {
        const db = await openLocalDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction('app', 'readwrite');
            tx.objectStore('app').put(s, 'store');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
        db.close();
    }
    catch {
        try {
            localStorage.setItem(STORE, JSON.stringify(s));
        }
        catch {
            throw new Error('Browser storage is full or unavailable. Export a backup before removing saved data.');
        }
    }
}
async function scryfall(url, init) {
    const res = await fetch(url, { ...init, headers: { Accept: 'application/json', ...(init?.headers || {}) } });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.details || `Scryfall request failed (${res.status}).`);
    }
    return res.json();
}
async function fetchNamed(name) {
    const exact = await scryfall(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`).catch(() => null);
    if (exact)
        return exact;
    return scryfall(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`);
}
function centerCardCrop(source) {
    const targetRatio = 63 / 88;
    const ratio = source.width / source.height;
    let sw = source.width, sh = source.height;
    if (ratio > targetRatio)
        sw = Math.round(source.height * targetRatio);
    else
        sh = Math.round(source.width / targetRatio);
    const sx = Math.max(0, Math.round((source.width - sw) / 2));
    const sy = Math.max(0, Math.round((source.height - sh) / 2));
    const out = document.createElement('canvas');
    out.width = Math.min(1100, sw);
    out.height = Math.round(out.width / targetRatio);
    const ctx = out.getContext('2d');
    if (!ctx)
        return source;
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height);
    return out;
}
function canvasFromVideo(video) {
    const max = 1500;
    const scale = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(video.videoWidth * scale));
    c.height = Math.max(1, Math.round(video.videoHeight * scale));
    const ctx = c.getContext('2d');
    if (!ctx)
        throw new Error('Could not capture camera frame.');
    ctx.drawImage(video, 0, 0, c.width, c.height);
    return c;
}
function fileToCanvas(file) {
    return createImageBitmap(file).then(bitmap => {
        const max = 1800, scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
        const c = document.createElement('canvas');
        c.width = Math.round(bitmap.width * scale);
        c.height = Math.round(bitmap.height * scale);
        const ctx = c.getContext('2d');
        if (!ctx)
            throw new Error('Could not open the selected image.');
        ctx.drawImage(bitmap, 0, 0, c.width, c.height);
        bitmap.close();
        return c;
    });
}
function makeExportRow(item) {
    const c = item.card;
    const collection = 'collectionId' in item ? item : null;
    return { quantity: item.quantity, name: c.name, setCode: c.set || '', setName: c.set_name || '', collectorNumber: c.collector_number || '', foil: item.foil, condition: collection?.condition || 'Near Mint', language: collection?.language || 'English', scryfallId: c.id, purchasePrice: collection?.priceAtAdd ?? unitPrice(c, item.foil), isCommander: 'commander' in item ? item.commander : false, addedAt: collection?.addedAt || new Date().toISOString() };
}
export default function App() {
    const [tab, setTab] = useState('scan');
    const [store, setStore] = useState(createEmptyStore);
    const [hydrated, setHydrated] = useState(false);
    const [catalog, setCatalog] = useState([]);
    const [catalogDate, setCatalogDate] = useState('');
    const [catalogState, setCatalogState] = useState('Card-name database not loaded');
    const [ocrState, setOcrState] = useState('idle');
    const [status, setStatus] = useState('Ready');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [streaming, setStreaming] = useState(false);
    const [torch, setTorch] = useState(false);
    const [torchAvailable, setTorchAvailable] = useState(false);
    const [rapid, setRapid] = useState(false);
    const [rapidAutoAdd, setRapidAutoAdd] = useState(true);
    const [cameraFacing, setCameraFacing] = useState('environment');
    const [cameraError, setCameraError] = useState('');
    const [pending, setPending] = useState(null);
    const [printingOptions, setPrintingOptions] = useState([]);
    const [suggestions, setSuggestions] = useState([]);
    const [selectedCollection, setSelectedCollection] = useState('main');
    const [newCollectionName, setNewCollectionName] = useState('');
    const [newDeckName, setNewDeckName] = useState('');
    const [selectedDeckId, setSelectedDeck] = useState('');
    const [query, setQuery] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [searchBusy, setSearchBusy] = useState(false);
    const [searchMessage, setSearchMessage] = useState('');
    const [deckSuggestions, setDeckSuggestions] = useState([]);
    const [suggestionBusy, setSuggestionBusy] = useState(false);
    const [foil, setFoil] = useState(false);
    const [lastScan, setLastScan] = useState('');
    const [importMessage, setImportMessage] = useState('');
    const [expandedHistoryId, setExpandedHistoryId] = useState('');
    const [refreshingPrices, setRefreshingPrices] = useState(false);
    const [expandedCollection, setExpandedCollection] = useState(true);
    const videoRef = useRef(null);
    const fileRef = useRef(null);
    const importRef = useRef(null);
    const streamRef = useRef(null);
    const rapidTimer = useRef(null);
    const rapidLastSig = useRef(null);
    const rapidStable = useRef(0);
    const rapidScannedSig = useRef(null);
    const scanLock = useRef(false);
    const commit = useCallback((next) => {
        setStore(old => {
            const value = typeof next === 'function' ? next(old) : next;
            void saveStore(value).catch(e => setError(e instanceof Error ? e.message : String(e)));
            return value;
        });
    }, []);
    useEffect(() => {
        void loadStore().then(cached => { setStore(cached); setHydrated(true); }).catch(() => setHydrated(true));
        const cachedCatalog = (() => { try {
            return JSON.parse(localStorage.getItem(CATALOG_CACHE) || 'null');
        }
        catch {
            return null;
        } })();
        if (cachedCatalog?.names?.length) {
            setCatalog(buildNameIndex(cachedCatalog.names));
            setCatalogDate(cachedCatalog.date || '');
            setCatalogState(`${cachedCatalog.names.length.toLocaleString()} names cached on this device`);
        }
        warmUpOcr();
        const off = onOcrStatus(s => setOcrState(s));
        return () => { off(); stopCamera(); };
    }, []);
    useEffect(() => { if (hydrated)
        void saveStore(store).catch(e => setError(e instanceof Error ? e.message : String(e))); }, [store, hydrated]);
    const stopCamera = useCallback(() => {
        if (rapidTimer.current != null)
            window.clearInterval(rapidTimer.current);
        rapidTimer.current = null;
        setRapid(false);
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        setStreaming(false);
        setTorch(false);
    }, []);
    const loadCatalog = useCallback(async (force = false) => {
        if (catalog.length && !force)
            return;
        setCatalogState('Downloading Scryfall card-name catalog…');
        setError('');
        try {
            let names = [];
            if (!force) {
                try {
                    const c = JSON.parse(localStorage.getItem(CATALOG_CACHE) || 'null');
                    if (c?.names?.length)
                        names = c.names;
                }
                catch { /* ignore */ }
            }
            if (!names.length || force) {
                const data = await scryfall('https://api.scryfall.com/catalog/card-names');
                names = data.data;
                const payload = { names, date: new Date().toISOString() };
                try {
                    localStorage.setItem(CATALOG_CACHE, JSON.stringify(payload));
                }
                catch { /* matching still works for this session */ }
                setCatalogDate(payload.date);
            }
            setCatalog(buildNameIndex(names));
            setCatalogState(`${names.length.toLocaleString()} names ready on this device`);
        }
        catch (e) {
            setCatalogState('Catalog unavailable — manual search still works');
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [catalog.length]);
    useEffect(() => { void loadCatalog(); }, [loadCatalog]);
    const startCamera = useCallback(async () => {
        setCameraError('');
        setError('');
        if (!navigator.mediaDevices?.getUserMedia) {
            setCameraError('Camera access requires HTTPS or localhost. Open this app on the PC or use the HTTPS phone address.');
            return;
        }
        stopCamera();
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: cameraFacing }, width: { ideal: 1920 }, height: { ideal: 1080 }, focusMode: 'continuous' } });
            streamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
            }
            const track = stream.getVideoTracks()[0];
            const caps = (track?.getCapabilities?.() || {});
            setTorchAvailable(Boolean(caps.torch));
            const plan = focusPlan({ focusMode: caps.focusMode, exposureMode: caps.exposureMode }, false);
            if (plan.advanced.length)
                await track.applyConstraints({ advanced: plan.advanced }).catch(() => undefined);
            setStreaming(true);
            setStatus('Camera ready — hold one card inside the guide');
        }
        catch (e) {
            setCameraError(e instanceof Error ? e.message : 'Camera could not be started.');
        }
    }, [cameraFacing, stopCamera]);
    const setTorchMode = useCallback(async (enabled) => {
        const track = streamRef.current?.getVideoTracks()[0];
        if (!track)
            return;
        try {
            await track.applyConstraints({ advanced: [{ torch: enabled }] });
            setTorch(enabled);
        }
        catch {
            setTorchAvailable(false);
            setError('This camera/browser does not expose a working flashlight control.');
        }
    }, []);
    const resolveCard = useCallback(async (name) => fetchNamed(name), []);
    const identifyCanvas = useCallback(async (frame, sourceLabel = 'Camera') => {
        if (scanLock.current)
            return;
        scanLock.current = true;
        setBusy(true);
        setError('');
        setPrintingOptions([]);
        setStatus('Finding card…');
        const started = performance.now();
        try {
            const prepared = prepareCardFromFrame(frame, { boxMode: false, calibration: null });
            let cardCanvas = prepared.card;
            // If the detector cannot find a card in a portrait camera frame, use a
            // centered 5:7 fallback. No sharpness score is ever allowed to veto OCR.
            if (prepared.source === 'guide' && (frame.width / frame.height < 0.58 || frame.width / frame.height > 1.05))
                cardCanvas = centerCardCrop(frame);
            const sharpness = measureTitleSharpness(cardCanvas);
            const focusPlanResult = softAttemptPlan([sharpness], { snap: true });
            const titleReads = [];
            const readSpecs = [...BAND_VARIANTS.slice(0, 3), ...TITLE_RESCUE_BANDS.slice(0, 2)];
            for (const spec of readSpecs) {
                const read = await ocrTitleBandCapped(cardCanvas, spec, { fast: true, capMs: 1400 });
                if (read.text.trim())
                    titleReads.push(read.text.trim());
                const candidates = ocrCandidates(titleReads);
                const matches = catalog.length ? matchNamesPooled(candidates, catalog, 4, { budgetMs: 650 }) : [];
                if (matches.length && (cleanNameVerdict(matches, titleReads, catalog) || matches[0].score >= 0.92))
                    break;
            }
            const rawTitle = titleReads.join('\n');
            const candidates = ocrCandidates(titleReads);
            const matches = catalog.length ? matchNamesPooled(candidates, catalog, 5, { budgetMs: 900 }) : [];
            let bestName = matches[0]?.entry.full || '';
            let confidence = matches[0]?.score || 0;
            if (matches.length) {
                const top = matches[0];
                const gap = top.score - (matches[1]?.score || 0);
                const decisive = cleanNameVerdict(matches, titleReads, catalog) || (top.score >= 0.92 && gap >= 0.08);
                if (!decisive) {
                    setSuggestions([...new Set(matches.slice(0, 5).map(m => m.entry.full))]);
                    throw new Error('The title read is ambiguous. Choose the correct card from the suggestions instead of saving a guess.');
                }
            }
            if (!bestName && candidates.length) {
                const first = candidates.sort((a, b) => b.length - a.length)[0];
                if (first && first.length >= 4) {
                    const fuzzy = await scryfall(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(first)}`).catch(() => null);
                    bestName = fuzzy?.name || '';
                    confidence = fuzzy ? 0.58 : 0;
                }
            }
            if (!bestName)
                throw new Error(`No card name could be identified. OCR read: ${rawTitle || 'no readable title'}. Try a closer, sharper photo or use Search.`);
            setStatus(`Matched name: ${bestName} — checking printing…`);
            const card = await resolveCard(bestName);
            const bottomReads = [];
            for (const spec of [BOTTOM_BAND, BOTTOM_BAND_CONTRAST]) {
                const read = await ocrBottomBandCapped(cardCanvas, spec, 1200);
                if (read.text.trim())
                    bottomReads.push(read.text.trim());
            }
            const rawBottom = bottomReads.join('\n');
            const bottomCandidates = parseBottomLineCandidates(rawBottom);
            const strictBottom = parseBottomLine(rawBottom);
            let chosen = card;
            let printingConfirmed = false;
            let printingReason = 'Name matched; printing not yet confirmed';
            if (strictBottom?.setCode && strictBottom.collectorNumber) {
                const exact = await scryfall(`https://api.scryfall.com/cards/${encodeURIComponent(strictBottom.setCode.toLowerCase())}/${encodeURIComponent(strictBottom.collectorNumber)}`).catch(() => null);
                if (exact && exact.name.toLowerCase() === card.name.toLowerCase()) {
                    chosen = exact;
                    printingConfirmed = true;
                    printingReason = `Printing matched from bottom line: ${exact.set.toUpperCase()} #${exact.collector_number}`;
                }
            }
            let prints = [];
            if (card.prints_search_uri) {
                const p = await scryfall(card.prints_search_uri).catch(() => null);
                prints = p?.data || [];
                setPrintingOptions(prints.slice(0, 60));
                const asPrintings = prints.map(p => ({ scryfallId: p.id, setCode: p.set, setName: p.set_name, collectorNumber: p.collector_number, artist: p.artist || '', releasedAt: p.released_at || '', rarity: p.rarity, finishes: p.finishes || [], fullArt: p.full_art, borderColor: p.border_color }));
                if (!printingConfirmed) {
                    const bottom = strictBottom ? { collectorNumber: strictBottom.collectorNumber, setCode: strictBottom.setCode, separator: strictBottom.separator, artist: null, lines: bottomReads } : null;
                    const bottomMatch = bottom ? matchPrintingByBottom(bottom, asPrintings) : null;
                    if (bottomMatch) {
                        const p = prints.find(x => x.id === bottomMatch.printing.scryfallId);
                        if (p) {
                            chosen = p;
                            printingConfirmed = true;
                            printingReason = `Printing matched by ${bottomMatch.why}`;
                        }
                    }
                }
                if (!printingConfirmed && prints.length) {
                    const referencePrintings = selectReferencePrintings(asPrintings, { baseId: card.id, candidates: bottomCandidates.map(x => ({ setCode: x.setCode || '', collectorNumber: x.collectorNumber })) });
                    const queryFingerprint = fingerprintCanvas(cardCanvas);
                    const refs = referencePrintings.map(p => { const found = prints.find(x => x.id === p.scryfallId); return found ? { id: found.id, imageUrl: cardImage(found) } : null; }).filter((x) => Boolean(x?.imageUrl));
                    if (refs.length > 1) {
                        const ranked = await rankVisualReferences(queryFingerprint, refs);
                        const visualWin = decisiveVisualPrinting(ranked);
                        if (visualWin) {
                            const p = prints.find(x => x.id === visualWin.id);
                            if (p) {
                                chosen = p;
                                printingConfirmed = true;
                                printingReason = `Printing matched by artwork (distance ${visualWin.distance})`;
                            }
                        }
                        else if (ranked.length)
                            printingReason = `Artwork compared; not enough separation to confirm (${ranked[0].distance} best distance)`;
                    }
                }
            }
            const detectedFoil = strictBottom?.separator === 'star';
            const item = { id: uniqueId(), card: chosen, foil: detectedFoil, printingConfirmed, confidence, rawTitle, rawBottom, addedAt: new Date().toISOString() };
            setSuggestions([]);
            setPending(item);
            setFoil(detectedFoil);
            setLastScan(`${((performance.now() - started) / 1000).toFixed(1)}s`);
            setStatus(`${chosen.name} — ${printingReason}`);
            if (rapidAutoAdd) {
                commit(old => {
                    const existing = old.scans.find(x => x.card.id === item.card.id && x.foil === item.foil);
                    if (existing)
                        return { ...old, scans: old.scans.map(x => x.id === existing.id ? { ...x, confidence: Math.max(x.confidence, item.confidence) } : x) };
                    return { ...old, scans: [item, ...old.scans] };
                });
                setPending(null);
            }
            else if (sourceLabel === 'Rapid Fire') {
                // Pause after one result when auto-add is off so a later frame
                // cannot overwrite the card awaiting user confirmation.
                if (rapidTimer.current != null)
                    window.clearInterval(rapidTimer.current);
                rapidTimer.current = null;
                setRapid(false);
            }
            return item;
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setError(msg);
            setStatus('Scan did not identify a card');
            return null;
        }
        finally {
            scanLock.current = false;
            setBusy(false);
        }
    }, [catalog, rapidAutoAdd, resolveCard, commit]);
    const addScanItem = useCallback((item) => {
        commit(old => {
            const existing = old.scans.find(x => x.card.id === item.card.id && x.foil === item.foil);
            if (existing)
                return { ...old, scans: old.scans.map(x => x.id === existing.id ? { ...x, confidence: Math.max(x.confidence, item.confidence) } : x) };
            return { ...old, scans: [item, ...old.scans] };
        });
        setPending(null);
        setStatus(`Added ${item.card.name} to the temporary scan list`);
    }, [commit]);
    const capture = useCallback(async () => {
        const video = videoRef.current;
        if (!video || !video.videoWidth) {
            setError('Start the camera before scanning.');
            return;
        }
        const frame = canvasFromVideo(video);
        await identifyCanvas(frame, 'Camera');
    }, [identifyCanvas]);
    const onUpload = useCallback(async (file) => {
        if (!file)
            return;
        try {
            const frame = await fileToCanvas(file);
            await identifyCanvas(frame, 'Photo');
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, [identifyCanvas]);
    const startRapid = useCallback(() => {
        if (!streamRef.current) {
            setError('Start the camera before enabling Rapid Fire.');
            return;
        }
        setRapid(true);
        rapidLastSig.current = null;
        rapidScannedSig.current = null;
        rapidStable.current = 0;
        setStatus('Rapid Fire active — show one card at a time');
        rapidTimer.current = window.setInterval(() => {
            const video = videoRef.current;
            if (!video?.videoWidth || scanLock.current)
                return;
            try {
                const frame = canvasFromVideo(video);
                const sigCanvas = document.createElement('canvas');
                sigCanvas.width = 24;
                sigCanvas.height = 34;
                const ctx = sigCanvas.getContext('2d');
                if (!ctx)
                    return;
                ctx.drawImage(frame, 0, 0, 24, 34);
                const px = ctx.getImageData(0, 0, 24, 34).data;
                const sig = [];
                for (let i = 0; i < px.length; i += 4)
                    sig.push(Math.round((0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 16));
                const diff = rapidLastSig.current ? sig.reduce((sum, v, i) => sum + Math.abs(v - (rapidLastSig.current?.[i] || 0)), 0) / sig.length : 999;
                if (diff > 4) {
                    rapidStable.current = 1;
                    rapidLastSig.current = sig;
                }
                else {
                    rapidStable.current++;
                }
                const scannedDiff = rapidScannedSig.current ? sig.reduce((sum, v, i) => sum + Math.abs(v - (rapidScannedSig.current?.[i] || 0)), 0) / sig.length : 999;
                if (rapidStable.current >= 2 && diff <= 4 && scannedDiff > 4) {
                    rapidStable.current = 0;
                    rapidScannedSig.current = sig;
                    void identifyCanvas(frame, 'Rapid Fire');
                }
                rapidLastSig.current = sig;
            }
            catch { /* a missed camera tick is not a scan failure */ }
        }, 650);
    }, [identifyCanvas]);
    const stopRapid = useCallback(() => { if (rapidTimer.current != null)
        window.clearInterval(rapidTimer.current); rapidTimer.current = null; setRapid(false); setStatus('Rapid Fire stopped'); }, []);
    const searchCards = useCallback(async (q = query) => {
        if (!q.trim())
            return;
        setSearchBusy(true);
        setSearchMessage('Searching Scryfall…');
        setError('');
        try {
            const data = await scryfall(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q.trim())}&order=name&unique=cards`);
            setSearchResults(data.data);
            setSearchMessage(`${data.total_cards.toLocaleString()} results — showing first ${data.data.length}`);
        }
        catch (e) {
            setSearchResults([]);
            setSearchMessage(e instanceof Error ? e.message : 'Search failed.');
        }
        finally {
            setSearchBusy(false);
        }
    }, [query]);
    const addManualCard = useCallback(async (card) => {
        const item = { id: uniqueId(), card, foil: false, printingConfirmed: true, confidence: 1, rawTitle: 'Manual search', rawBottom: '', addedAt: new Date().toISOString() };
        addScanItem(item);
        setTab('scan');
    }, [addScanItem]);
    const chooseSuggestion = useCallback(async (name) => {
        setBusy(true);
        setError('');
        try {
            const card = await resolveCard(name);
            setPending({ id: uniqueId(), card, foil: false, printingConfirmed: false, confidence: 0.7, rawTitle: 'User selected from OCR suggestions', rawBottom: '', addedAt: new Date().toISOString() });
            setFoil(false);
            setSuggestions([]);
            setPrintingOptions([]);
            setStatus(`Selected ${card.name}; printing still needs confirmation`);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
        finally {
            setBusy(false);
        }
    }, [resolveCard]);
    const addScansToCollection = useCallback((collectionId) => {
        if (!store.scans.length)
            return;
        commit(old => {
            const items = [...old.items];
            for (const scan of old.scans) {
                const found = items.find(x => x.collectionId === collectionId && x.card.id === scan.card.id && x.foil === scan.foil && x.condition === 'Near Mint');
                if (found)
                    found.quantity += 1;
                else
                    items.push({ id: uniqueId(), collectionId, card: scan.card, foil: scan.foil, quantity: 1, condition: 'Near Mint', language: 'English', priceAtAdd: unitPrice(scan.card, scan.foil), addedAt: new Date().toISOString(), lastPrice: unitPrice(scan.card, scan.foil), lastCheckedAt: null });
            }
            return { ...old, items, scans: [] };
        });
        setStatus(`Moved temporary scans into ${store.collections.find(c => c.id === collectionId)?.name || 'collection'}`);
    }, [commit, store.scans.length, store.collections]);
    const createCollection = useCallback(() => {
        const name = newCollectionName.trim();
        if (!name)
            return;
        const c = { id: uniqueId(), name, createdAt: new Date().toISOString() };
        commit(old => ({ ...old, collections: [...old.collections, c] }));
        setSelectedCollection(c.id);
        setNewCollectionName('');
    }, [commit, newCollectionName]);
    const createDeck = useCallback(() => {
        const name = newDeckName.trim();
        if (!name)
            return;
        const deck = { id: uniqueId(), name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        commit(old => {
            const deckItems = [...old.deckItems];
            for (const scan of old.scans) {
                deckItems.push({ id: uniqueId(), deckId: deck.id, card: scan.card, quantity: 1, commander: false, foil: scan.foil });
            }
            const items = [...old.items];
            for (const scan of old.scans) {
                const found = items.find(x => x.collectionId === selectedCollection && x.card.id === scan.card.id && x.foil === scan.foil && x.condition === 'Near Mint');
                if (found)
                    found.quantity += 1;
                else
                    items.push({ id: uniqueId(), collectionId: selectedCollection, card: scan.card, foil: scan.foil, quantity: 1, condition: 'Near Mint', language: 'English', priceAtAdd: unitPrice(scan.card, scan.foil), addedAt: new Date().toISOString(), lastPrice: unitPrice(scan.card, scan.foil), lastCheckedAt: null });
            }
            return { ...old, decks: [deck, ...old.decks], deckItems, items, scans: [] };
        });
        setNewDeckName('');
        setSelectedDeck(deck.id);
        setTab('decks');
    }, [commit, newDeckName, selectedCollection]);
    const createDeckEmpty = useCallback(() => {
        const name = newDeckName.trim();
        if (!name)
            return;
        const deck = { id: uniqueId(), name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        commit(old => ({ ...old, decks: [deck, ...old.decks] }));
        setNewDeckName('');
        setSelectedDeck(deck.id);
    }, [commit, newDeckName]);
    const addCardToDeck = useCallback((deckId, card) => {
        commit(old => {
            const found = old.deckItems.find(x => x.deckId === deckId && x.card.id === card.id && !x.commander);
            const deckItems = found ? old.deckItems.map(x => x.id === found.id ? { ...x, quantity: x.quantity + 1 } : x) : [...old.deckItems, { id: uniqueId(), deckId, card, quantity: 1, commander: false, foil: false }];
            return { ...old, deckItems, decks: old.decks.map(d => d.id === deckId ? { ...d, updatedAt: new Date().toISOString() } : d) };
        });
    }, [commit]);
    const setCommander = useCallback((deckId, card) => {
        commit(old => {
            const deckItems = old.deckItems.filter(x => !(x.deckId === deckId && x.commander)).concat({ id: uniqueId(), deckId, card, quantity: 1, commander: true, foil: false });
            return { ...old, deckItems, decks: old.decks.map(d => d.id === deckId ? { ...d, commander: card, updatedAt: new Date().toISOString() } : d) };
        });
    }, [commit]);
    const removeScan = useCallback((id) => commit(old => ({ ...old, scans: old.scans.filter(x => x.id !== id) })), [commit]);
    const removeCollectionItem = useCallback((id) => commit(old => ({ ...old, items: old.items.filter(x => x.id !== id), priceHistory: (old.priceHistory || []).filter(x => x.itemId !== id) })), [commit]);
    const removeDeckItem = useCallback((id) => commit(old => ({ ...old, deckItems: old.deckItems.filter(x => x.id !== id) })), [commit]);
    const refreshPrices = useCallback(async () => {
        const ids = [...new Set(store.items.map(i => i.card.id))];
        if (!ids.length)
            return;
        setRefreshingPrices(true);
        setError('');
        try {
            const updates = new Map();
            for (let i = 0; i < ids.length; i += 75) {
                const batch = ids.slice(i, i + 75);
                const response = await scryfall('https://api.scryfall.com/cards/collection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiers: batch.map(id => ({ id })) }) });
                response.data.forEach(c => updates.set(c.id, c));
                await sleep(110);
            }
            const checkedAt = new Date().toISOString();
            commit(old => {
                const priceHistory = [...(old.priceHistory || [])];
                const items = old.items.map(item => {
                    const fresh = updates.get(item.card.id);
                    if (!fresh)
                        return item;
                    const price = unitPrice(fresh, item.foil);
                    if (price != null && !priceHistory.some(h => h.itemId === item.id && h.checkedAt.slice(0, 10) === checkedAt.slice(0, 10))) {
                        priceHistory.push({ id: uniqueId(), itemId: item.id, price, foil: item.foil, checkedAt });
                    }
                    return { ...item, card: { ...item.card, prices: fresh.prices }, lastPrice: price, lastCheckedAt: checkedAt };
                });
                return { ...old, items, priceHistory };
            });
            setStatus(`Prices refreshed for ${updates.size} unique cards`);
        }
        catch (e) {
            setError(e instanceof Error ? e.message : 'Price refresh failed.');
        }
        finally {
            setRefreshingPrices(false);
        }
    }, [commit, store.items]);
    const exportCollection = useCallback((format) => {
        const items = store.items.filter(i => i.collectionId === selectedCollection);
        const rows = items.map(makeExportRow);
        const content = format === 'manabox' ? exportManaBox(rows, store.collections.find(c => c.id === selectedCollection)?.name || 'Collection') : format === 'moxfield' ? exportMoxfield(rows) : exportArchidekt(rows);
        const blob = new Blob([content], { type: format === 'moxfield' ? 'text/plain' : 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `aetherforge-${format}-${Date.now()}.${format === 'moxfield' ? 'txt' : 'csv'}`;
        a.click();
        URL.revokeObjectURL(url);
    }, [store, selectedCollection]);
    const exportBackup = useCallback(() => {
        const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `aetherforge-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }, [store]);
    const importCsv = useCallback(async (file) => {
        if (!file)
            return;
        setImportMessage('Reading CSV…');
        try {
            const parsed = parseManaBoxCsvDetailed(await file.text());
            if (!parsed.rows.length)
                throw new Error(parsed.errors[0] || 'No valid card rows were found.');
            const resolved = [];
            for (const row of parsed.rows) {
                let card = null;
                if (row.scryfallId)
                    card = await scryfall(`https://api.scryfall.com/cards/${row.scryfallId}`).catch(() => null);
                if (!card)
                    card = await fetchNamed(row.name).catch(() => null);
                if (!card) {
                    parsed.errors.push(`${row.name}: Scryfall could not resolve this card.`);
                    continue;
                }
                if (row.setCode && row.collectorNumber) {
                    const exact = await scryfall(`https://api.scryfall.com/cards/${row.setCode.toLowerCase()}/${encodeURIComponent(row.collectorNumber)}`).catch(() => null);
                    if (exact && exact.name.toLowerCase() === card.name.toLowerCase())
                        card = exact;
                }
                resolved.push({ id: uniqueId(), collectionId: selectedCollection, card, foil: row.foil, quantity: row.quantity, condition: row.condition || 'Near Mint', language: row.language || 'English', priceAtAdd: unitPrice(card, row.foil), addedAt: new Date().toISOString(), lastPrice: unitPrice(card, row.foil), lastCheckedAt: null });
                await sleep(110);
            }
            commit(old => {
                const items = [...old.items];
                for (const incoming of resolved) {
                    const existing = items.find(x => x.collectionId === incoming.collectionId && x.card.id === incoming.card.id && x.foil === incoming.foil && x.condition === incoming.condition && x.language === incoming.language);
                    if (existing)
                        existing.quantity += incoming.quantity;
                    else
                        items.push(incoming);
                }
                return { ...old, items };
            });
            setImportMessage(`Imported ${resolved.length} rows. ${parsed.errors.length ? parsed.errors.length + ' rows need attention.' : 'No row errors.'}`);
        }
        catch (e) {
            setImportMessage(e instanceof Error ? e.message : 'CSV import failed.');
        }
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
        if (!activeDeck?.commander) {
            setError('Set a commander before requesting deck suggestions.');
            return;
        }
        setSuggestionBusy(true);
        setDeckSuggestions([]);
        try {
            const identity = activeDeck.commander.color_identity?.join('') || 'c';
            const q = `id<=${identity} legal:commander -is:commander`;
            const data = await scryfall(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=edhrec&dir=asc`);
            const inDeck = new Set(selectedDeckItems.map(i => i.card.id));
            setDeckSuggestions(data.data.filter(c => !inDeck.has(c.id)).slice(0, 12));
        }
        catch (e) {
            setError(e instanceof Error ? e.message : 'Could not load deck suggestions.');
        }
        finally {
            setSuggestionBusy(false);
        }
    };
    const totalCollectionValue = store.collections.reduce((sum, c) => sum + store.items.filter(i => i.collectionId === c.id).reduce((s, i) => s + (unitPrice(i.card, i.foil) ?? 0) * i.quantity, 0), 0);
    const searchAutocomplete = useMemo(() => catalog.length && query.trim() ? autocomplete(catalog, query, 6).map(x => x.full) : [], [catalog, query]);
    if (!hydrated)
        return _jsx("div", { className: "app-shell loading-shell", children: _jsxs("div", { className: "loading-card", children: [_jsx("div", { className: "brand-mark", children: _jsx(Layers3, { size: 22 }) }), _jsx("h2", { children: "AETHERFORGE MTG" }), _jsx(LoaderCircle, { className: "spin", size: 22 }), _jsx("span", { children: "Opening your local card library\u2026" })] }) });
    return _jsxs("div", { className: "app-shell", children: [_jsxs("header", { className: "topbar", children: [_jsxs("div", { className: "brand", children: [_jsx("div", { className: "brand-mark", children: _jsx(Layers3, { size: 22 }) }), _jsxs("div", { children: [_jsxs("div", { className: "brand-name", children: ["AETHERFORGE ", _jsx("span", { children: "MTG" })] }), _jsx("div", { className: "brand-sub", children: "CARD SCANNER & COLLECTION MANAGER" })] })] }), _jsxs("div", { className: "top-status", children: [_jsx("span", { className: "status-dot" }), _jsx("span", { children: status })] }), _jsxs("div", { className: "top-actions", children: [_jsx("button", { className: "icon-btn", title: "Export backup", onClick: exportBackup, children: _jsx(ArrowDownToLine, { size: 17 }) }), _jsx("div", { className: "version", children: "V3.0 LOCAL" })] })] }), _jsx("nav", { className: "tabs", children: [['scan', 'Scan', Camera], ['search', 'Search', Search], ['collections', 'Collections', Layers3], ['decks', 'Decks', PackagePlus], ['settings', 'Settings', Settings2]].map(([id, label, Icon]) => _jsxs("button", { className: `tab ${tab === id ? 'active' : ''}`, onClick: () => setTab(id), children: [_jsx(Icon, { size: 17 }), _jsx("span", { children: label }), id === 'scan' && store.scans.length > 0 && _jsx("b", { children: store.scans.length })] }, id)) }), error && _jsxs("div", { className: "alert error", children: [_jsx(AlertCircle, { size: 17 }), _jsx("span", { children: error }), _jsx("button", { onClick: () => setError(''), children: _jsx(X, { size: 16 }) })] }), tab === 'scan' && _jsxs("main", { className: "scan-layout", children: [_jsxs("section", { className: "scanner-column", children: [_jsxs("div", { className: "section-head", children: [_jsxs("div", { children: [_jsx("div", { className: "eyebrow", children: "LIVE IDENTIFICATION" }), _jsx("h1", { children: "Card Scanner" }), _jsx("p", { children: "On-device OCR with collector-number and artwork printing verification." })] }), _jsxs("div", { className: "scan-state", children: [_jsx("span", { className: `pill ${ocrState === 'ready' ? 'good' : ''}`, children: ocrState === 'ready' ? 'OCR READY' : ocrState.toUpperCase() }), _jsx("span", { className: "pill neutral", children: catalog.length ? `${Math.round(catalog.length / 1000)}K NAMES` : 'CATALOG LOADING' })] })] }), _jsxs("div", { className: "viewfinder", children: [_jsx("video", { ref: videoRef, playsInline: true, muted: true, className: streaming ? 'video-live' : 'video-hidden' }), !streaming && _jsxs("div", { className: "camera-placeholder", children: [_jsx("div", { className: "camera-placeholder-icon", children: _jsx(Camera, { size: 34 }) }), _jsx("h3", { children: "Camera is off" }), _jsx("p", { children: "Start your camera or upload a card photo to scan." }), _jsxs("button", { className: "primary", onClick: startCamera, children: [_jsx(Camera, { size: 17 }), " Start camera"] })] }), streaming && _jsxs("div", { className: "guide-frame", children: [_jsx("span", { className: "corner tl" }), _jsx("span", { className: "corner tr" }), _jsx("span", { className: "corner bl" }), _jsx("span", { className: "corner br" }), _jsx("div", { className: "guide-label", children: "ALIGN ONE CARD" })] }), busy && _jsxs("div", { className: "scan-overlay", children: [_jsx(LoaderCircle, { className: "spin", size: 28 }), _jsx("strong", { children: "Identifying card" }), _jsx("span", { children: "Reading title and bottom line" })] }), _jsxs("div", { className: "viewfinder-tools", children: [streaming && _jsx("button", { className: `round-tool ${torch ? 'selected' : ''}`, title: torchAvailable ? 'Toggle flashlight' : 'Flashlight unavailable', disabled: !torchAvailable, onClick: () => void setTorchMode(!torch), children: _jsx(Sun, { size: 17 }) }), _jsx("button", { className: "round-tool", title: "Switch camera", onClick: () => { stopCamera(); setCameraFacing(v => v === 'environment' ? 'user' : 'environment'); setStatus('Camera switched — press Start camera to reconnect'); }, children: _jsx(ArrowLeftRight, { size: 17 }) })] })] }), cameraError && _jsx("div", { className: "inline-error", children: cameraError }), _jsxs("div", { className: "scanner-controls", children: [!streaming ? _jsxs("button", { className: "primary", onClick: startCamera, children: [_jsx(Camera, { size: 17 }), " Start camera"] }) : _jsxs("button", { className: "primary capture", disabled: busy, onClick: () => void capture(), children: [_jsx(Camera, { size: 18 }), " ", busy ? 'Scanning…' : 'Snap card'] }), _jsxs("button", { className: "secondary", onClick: () => fileRef.current?.click(), children: [_jsx(ImagePlus, { size: 17 }), " Upload photo"] }), _jsx("input", { ref: fileRef, hidden: true, type: "file", accept: "image/*", capture: "environment", onChange: e => { void onUpload(e.target.files?.[0]); e.currentTarget.value = ''; } }), streaming && !rapid && _jsxs("button", { className: "secondary", onClick: startRapid, children: [_jsx(Activity, { size: 17 }), " Rapid Fire"] }), rapid && _jsxs("button", { className: "danger", onClick: stopRapid, children: [_jsx(StopCircle, { size: 17 }), " Stop Rapid"] }), streaming && _jsxs("button", { className: "quiet", onClick: stopCamera, children: [_jsx(Square, { size: 15 }), " Stop camera"] })] }), _jsxs("div", { className: "scanner-options", children: [_jsxs("label", { className: "checkline", children: [_jsx("input", { type: "checkbox", checked: rapidAutoAdd, onChange: e => setRapidAutoAdd(e.target.checked) }), " Auto-add Rapid matches to temporary list"] }), _jsxs("span", { children: ["Last scan: ", lastScan || '—'] })] }), _jsxs("div", { className: "scan-explain", children: [_jsx(ShieldCheck, { size: 17 }), _jsx("span", { children: "Soft focus is advisory only. A blurry frame never blocks identification; the scanner still attempts OCR and number matching." })] })] }), _jsxs("aside", { className: "scan-side", children: [suggestions.length > 0 && _jsxs("div", { className: "panel suggestion-panel", children: [_jsxs("div", { className: "panel-head", children: [_jsxs("div", { children: [_jsx("div", { className: "eyebrow", children: "OCR NEEDS CONFIRMATION" }), _jsx("h2", { children: "Which card is it?" })] }), _jsx("button", { className: "icon-btn", onClick: () => setSuggestions([]), children: _jsx(X, { size: 16 }) })] }), _jsx("div", { className: "suggestion-list", children: suggestions.map(name => _jsxs("button", { onClick: () => void chooseSuggestion(name), children: [name, _jsx("span", { children: "Use this card" })] }, name)) })] }), pending && _jsxs("div", { className: "panel result-panel", children: [_jsxs("div", { className: "panel-head", children: [_jsxs("div", { children: [_jsx("div", { className: "eyebrow", children: "LATEST RESULT" }), _jsx("h2", { children: "Card identified" })] }), _jsx("button", { className: "icon-btn", onClick: () => setPending(null), children: _jsx(X, { size: 16 }) })] }), _jsx(CardTile, { card: pending.card, foil: foil, setFoil: setFoil }), _jsxs("div", { className: "result-meta", children: [_jsx("span", { className: `pill ${pending.printingConfirmed ? 'good' : 'warning'}`, children: pending.printingConfirmed ? 'PRINTING CONFIRMED' : 'PRINTING UNCONFIRMED' }), _jsxs("span", { className: "confidence", children: ["Name score ", Math.round(pending.confidence * 100), "%"] })] }), _jsxs("div", { className: "evidence", children: [_jsxs("div", { children: [_jsx("b", { children: "Title OCR" }), _jsx("span", { children: pending.rawTitle || '—' })] }), _jsxs("div", { children: [_jsx("b", { children: "Bottom OCR" }), _jsx("span", { children: pending.rawBottom || '—' })] })] }), printingOptions.length > 1 && _jsxs("label", { className: "printing-select", children: [_jsx("span", { children: "CHOOSE PRINTING / VERSION" }), _jsx("select", { value: pending.card.id, onChange: e => { const selected = printingOptions.find(p => p.id === e.target.value); if (selected) {
                                                    setPending({ ...pending, card: selected, printingConfirmed: true });
                                                    setStatus(`Printing manually selected: ${selected.set.toUpperCase()} #${selected.collector_number}`);
                                                } }, children: printingOptions.map(p => _jsxs("option", { value: p.id, children: [p.set.toUpperCase(), " #", p.collector_number, " \u00B7 ", p.set_name, " \u00B7 ", p.released_at || 'date unknown'] }, p.id)) })] }), _jsxs("button", { className: "primary full", onClick: () => addScanItem({ ...pending, foil }), children: [_jsx(Plus, { size: 17 }), " Add to temporary list"] })] }), _jsxs("div", { className: "panel scan-list-panel", children: [_jsxs("div", { className: "panel-head", children: [_jsxs("div", { children: [_jsx("div", { className: "eyebrow", children: "TEMPORARY SCAN LIST" }), _jsxs("h2", { children: [store.scans.length, " cards"] })] }), _jsx("span", { className: "value-chip", children: money(store.scans.reduce((s, x) => s + (unitPrice(x.card, x.foil) || 0), 0)) })] }), store.scans.length === 0 ? _jsxs("div", { className: "empty-small", children: [_jsx(Layers3, { size: 25 }), _jsx("span", { children: "Scanned cards wait here until you review and save them." })] }) : _jsxs("div", { className: "mini-list", children: [store.scans.slice(0, 8).map(item => _jsxs("div", { className: "mini-row", children: [_jsx("img", { src: cardImage(item.card), alt: "" }), _jsxs("div", { className: "mini-copy", children: [_jsx("b", { children: item.card.name }), _jsxs("span", { children: [item.card.set.toUpperCase(), " \u00B7 #", item.card.collector_number, " \u00B7 ", item.foil ? 'Foil' : 'Normal', " \u00B7 ", item.printingConfirmed ? 'printing confirmed' : 'printing unconfirmed'] })] }), _jsx("button", { className: "icon-btn small", onClick: () => removeScan(item.id), children: _jsx(Trash2, { size: 15 }) })] }, item.id)), store.scans.length > 8 && _jsxs("div", { className: "more-note", children: ["+ ", store.scans.length - 8, " more cards"] })] }), _jsxs("div", { className: "save-scan-row", children: [_jsx("select", { value: selectedCollection, onChange: e => setSelectedCollection(e.target.value), children: store.collections.map(c => _jsx("option", { value: c.id, children: c.name }, c.id)) }), _jsx("button", { className: "primary", disabled: !store.scans.length, onClick: () => addScansToCollection(selectedCollection), children: "Save to collection" })] }), _jsxs("div", { className: "create-deck-row", children: [_jsx("input", { value: newDeckName, onChange: e => setNewDeckName(e.target.value), placeholder: "New deck name" }), _jsxs("button", { className: "secondary", disabled: !store.scans.length || !newDeckName.trim(), onClick: createDeck, children: [_jsx(PackagePlus, { size: 16 }), " Make deck"] })] })] }), _jsxs("div", { className: "panel quick-stats", children: [_jsxs("div", { className: "stat", children: [_jsx("span", { children: "COLLECTIONS" }), _jsx("b", { children: store.collections.length })] }), _jsxs("div", { className: "stat", children: [_jsx("span", { children: "UNIQUE CARDS" }), _jsx("b", { children: store.items.length })] }), _jsxs("div", { className: "stat", children: [_jsx("span", { children: "TOTAL VALUE" }), _jsx("b", { children: money(totalCollectionValue) })] })] })] })] }), tab === 'search' && _jsxs("main", { className: "page", children: [_jsx("div", { className: "section-head", children: _jsxs("div", { children: [_jsx("div", { className: "eyebrow", children: "SCRYFALL SEARCH" }), _jsx("h1", { children: "Find a card" }), _jsx("p", { children: "Search by name, rules text, set, color, type, or Commander legality." })] }) }), _jsxs("div", { className: "search-bar", children: [_jsx(Search, { size: 19 }), _jsx("input", { value: query, onChange: e => setQuery(e.target.value), onKeyDown: e => e.key === 'Enter' && void searchCards(), placeholder: 'Try: name:"Sol Ring" or c:blue t:creature' }), _jsx("button", { className: "primary", disabled: searchBusy, onClick: () => void searchCards(), children: searchBusy ? _jsx(LoaderCircle, { className: "spin", size: 16 }) : 'Search' })] }), searchAutocomplete.length > 0 && _jsx("div", { className: "autocomplete", children: searchAutocomplete.map(n => _jsx("button", { onClick: () => { setQuery(`name:"${n}"`); void searchCards(`name:"${n}"`); }, children: n }, n)) }), _jsx("div", { className: "subtle-line", children: searchMessage }), _jsx("div", { className: "card-grid", children: searchResults.map(card => _jsxs("div", { className: "search-card", children: [_jsx("img", { src: cardImage(card), alt: card.name }), _jsxs("div", { className: "search-card-info", children: [_jsx("b", { children: card.name }), _jsxs("span", { children: [card.set.toUpperCase(), " \u00B7 #", card.collector_number, " \u00B7 ", card.rarity] }), _jsx("span", { children: money(Number(card.prices?.usd)) }), _jsxs("button", { className: "secondary full", onClick: () => void addManualCard(card), children: [_jsx(Plus, { size: 15 }), " Add to scan list"] })] })] }, card.id)) })] }), tab === 'collections' && _jsxs("main", { className: "page", children: [_jsxs("div", { className: "section-head", children: [_jsxs("div", { children: [_jsx("div", { className: "eyebrow", children: "YOUR CARD LIBRARY" }), _jsx("h1", { children: "Collections" }), _jsx("p", { children: "Multiple binders, foil-aware values, price refresh, and ManaBox-compatible exports." })] }), _jsxs("div", { className: "head-actions", children: [_jsxs("button", { className: "secondary", onClick: () => importRef.current?.click(), children: [_jsx(Upload, { size: 16 }), " Import CSV"] }), _jsx("input", { ref: importRef, hidden: true, type: "file", accept: ".csv,text/csv", onChange: e => { void importCsv(e.target.files?.[0]); e.currentTarget.value = ''; } }), _jsxs("button", { className: "secondary", onClick: () => void refreshPrices(), disabled: refreshingPrices || !store.items.length, children: [refreshingPrices ? _jsx(LoaderCircle, { className: "spin", size: 16 }) : _jsx(RefreshCw, { size: 16 }), " Refresh prices"] })] })] }), _jsx("div", { className: "collection-overview", children: store.collections.map(c => { const rows = store.items.filter(i => i.collectionId === c.id); const value = rows.reduce((sum, i) => sum + (unitPrice(i.card, i.foil) || 0) * i.quantity, 0); return _jsxs("button", { className: selectedCollection === c.id ? 'active' : '', onClick: () => setSelectedCollection(c.id), children: [_jsx("span", { children: c.name }), _jsx("b", { children: money(value) }), _jsxs("small", { children: [rows.reduce((sum, i) => sum + i.quantity, 0), " cards \u00B7 ", rows.length, " unique"] })] }, c.id); }) }), importMessage && _jsx("div", { className: "alert info", children: importMessage }), _jsxs("div", { className: "collection-toolbar", children: [_jsxs("div", { className: "collection-select", children: [_jsx("label", { children: "ACTIVE COLLECTION" }), _jsx("select", { value: selectedCollection, onChange: e => setSelectedCollection(e.target.value), children: store.collections.map(c => _jsx("option", { value: c.id, children: c.name }, c.id)) })] }), _jsxs("div", { className: "collection-value", children: [_jsx("span", { children: "ESTIMATED MARKET VALUE" }), _jsx("b", { children: money(collectionValue) })] }), _jsxs("div", { className: "export-buttons", children: [_jsx("button", { onClick: () => exportCollection('manabox'), children: "ManaBox CSV" }), _jsx("button", { onClick: () => exportCollection('moxfield'), children: "Moxfield TXT" }), _jsx("button", { onClick: () => exportCollection('archidekt'), children: "Archidekt CSV" })] })] }), _jsxs("div", { className: "new-collection", children: [_jsx("input", { value: newCollectionName, onChange: e => setNewCollectionName(e.target.value), onKeyDown: e => e.key === 'Enter' && createCollection(), placeholder: "Create a collection / binder" }), _jsxs("button", { className: "primary", onClick: createCollection, disabled: !newCollectionName.trim(), children: [_jsx(FolderPlus, { size: 16 }), " Create collection"] })] }), _jsxs("div", { className: "table-wrap", children: [_jsxs("table", { children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Card" }), _jsx("th", { children: "Printing" }), _jsx("th", { children: "Finish" }), _jsx("th", { children: "Qty" }), _jsx("th", { children: "Condition" }), _jsx("th", { children: "Unit value" }), _jsx("th", { children: "Added at" }), _jsx("th", {})] }) }), _jsx("tbody", { children: collectionItems.map(item => { const movement = item.priceAtAdd == null || unitPrice(item.card, item.foil) == null ? null : priceMovement(unitPrice(item.card, item.foil), item.priceAtAdd); return _jsxs(_Fragment, { children: [_jsxs("tr", { children: [_jsx("td", { children: _jsxs("div", { className: "table-card", children: [_jsx("img", { src: cardImage(item.card), alt: "" }), _jsxs("div", { children: [_jsx("b", { children: item.card.name }), _jsx("small", { children: item.card.type_line }), store.deckItems.filter(d => d.card.id === item.card.id).length > 0 && _jsxs("small", { className: "deck-badge", children: ["In: ", [...new Set(store.deckItems.filter(d => d.card.id === item.card.id).map(d => store.decks.find(x => x.id === d.deckId)?.name).filter(Boolean))].join(', ')] })] })] }) }), _jsxs("td", { children: [item.card.set.toUpperCase(), " #", item.card.collector_number, _jsx("small", { children: item.card.set_name })] }), _jsx("td", { children: _jsx("button", { className: `finish-toggle ${item.foil ? 'is-foil' : ''}`, onClick: () => commit(old => ({ ...old, items: old.items.map(x => x.id === item.id ? { ...x, foil: !x.foil, priceAtAdd: unitPrice(x.card, !x.foil), lastPrice: unitPrice(x.card, !x.foil), lastCheckedAt: null } : x), priceHistory: (old.priceHistory || []).filter(h => h.itemId !== item.id) })), children: item.foil ? 'Foil' : 'Normal' }) }), _jsx("td", { children: _jsxs("div", { className: "qty-control", children: [_jsx("button", { onClick: () => commit(old => ({ ...old, items: old.items.map(x => x.id === item.id ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x) })), children: "\u2212" }), _jsx("b", { children: item.quantity }), _jsx("button", { onClick: () => commit(old => ({ ...old, items: old.items.map(x => x.id === item.id ? { ...x, quantity: x.quantity + 1 } : x) })), children: "+" })] }) }), _jsx("td", { children: _jsx("select", { value: item.condition, onChange: e => commit(old => ({ ...old, items: old.items.map(x => x.id === item.id ? { ...x, condition: e.target.value } : x) })), children: ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'].map(c => _jsx("option", { children: c }, c)) }) }), _jsxs("td", { children: [_jsx("b", { children: money(unitPrice(item.card, item.foil)) }), _jsxs("small", { children: ["Added at ", money(item.priceAtAdd)] }), movement && _jsx("small", { className: movement.kind === 'up' ? 'positive' : movement.kind === 'down' ? 'negative' : '', children: movement.kind === 'none' ? '—' : `${movement.kind === 'up' ? '+' : movement.kind === 'down' ? '−' : ''}$${Math.abs(movement.diff).toFixed(2)}${movement.pct == null ? '' : ` (${movement.pct.toFixed(1)}%)`}` })] }), _jsx("td", { children: new Date(item.addedAt).toLocaleDateString() }), _jsx("td", { children: _jsxs("div", { className: "row-actions", children: [_jsx("button", { className: "icon-btn small", title: "Price history", onClick: () => setExpandedHistoryId(v => v === item.id ? '' : item.id), children: _jsx(Activity, { size: 14 }) }), _jsx("button", { className: "icon-btn small", onClick: () => removeCollectionItem(item.id), children: _jsx(Trash2, { size: 15 }) })] }) })] }, item.id), expandedHistoryId === item.id && _jsx("tr", { children: _jsx("td", { colSpan: 8, children: _jsxs("div", { className: "history-strip", children: [_jsx("b", { children: "Price history" }), (store.priceHistory || []).filter(h => h.itemId === item.id).sort((a, b) => a.checkedAt.localeCompare(b.checkedAt)).map(h => _jsxs("span", { children: [new Date(h.checkedAt).toLocaleString(), " \u00B7 ", money(h.price), " \u00B7 ", h.foil ? 'Foil' : 'Normal'] }, h.id)), !(store.priceHistory || []).some(h => h.itemId === item.id) && _jsx("span", { children: "No price checks recorded yet. Refresh prices to start tracking." })] }) }) }, `${item.id}-history`)] }); }) })] }), collectionItems.length === 0 && _jsxs("div", { className: "empty-state", children: [_jsx(Layers3, { size: 32 }), _jsx("h3", { children: "This collection is empty" }), _jsx("p", { children: "Scan cards or import a ManaBox CSV to get started." })] })] })] }), tab === 'decks' && _jsxs("main", { className: "page", children: [_jsx("div", { className: "section-head", children: _jsxs("div", { children: [_jsx("div", { className: "eyebrow", children: "DECK WORKSHOP" }), _jsx("h1", { children: "Decks" }), _jsx("p", { children: "Build a deck from your temporary scan list or start with an empty list." })] }) }), _jsxs("div", { className: "deck-create", children: [_jsx("input", { value: newDeckName, onChange: e => setNewDeckName(e.target.value), onKeyDown: e => e.key === 'Enter' && createDeckEmpty(), placeholder: "Deck name" }), _jsxs("button", { className: "primary", disabled: !newDeckName.trim(), onClick: createDeckEmpty, children: [_jsx(Plus, { size: 16 }), " Create empty deck"] }), _jsxs("button", { className: "secondary", disabled: !store.scans.length || !newDeckName.trim(), onClick: createDeck, children: [_jsx(Layers3, { size: 16 }), " Create from scan list"] })] }), _jsxs("div", { className: "deck-layout", children: [_jsxs("aside", { className: "deck-sidebar", children: [store.decks.map(d => _jsxs("button", { className: selectedDeckId === d.id ? 'selected' : '', onClick: () => setSelectedDeck(d.id), children: [_jsxs("div", { children: [_jsx("b", { children: d.name }), _jsxs("small", { children: [store.deckItems.filter(x => x.deckId === d.id).reduce((s, x) => s + x.quantity, 0), " cards"] })] }), _jsx(ChevronDown, { size: 16 })] }, d.id)), !store.decks.length && _jsx("div", { className: "empty-small", children: "No decks yet." })] }), activeDeck ? _jsxs("section", { className: "deck-detail", children: [_jsxs("div", { className: "deck-title", children: [_jsxs("div", { children: [_jsx("div", { className: "eyebrow", children: "ACTIVE DECK" }), _jsx("h2", { children: activeDeck.name }), _jsxs("span", { children: [selectedDeckItems.reduce((s, x) => s + x.quantity, 0), " cards \u00B7 ", money(deckValue)] })] }), _jsx("button", { className: "icon-btn", onClick: () => { if (confirm(`Delete ${activeDeck.name}?`))
                                                    commit(old => ({ ...old, decks: old.decks.filter(d => d.id !== activeDeck.id), deckItems: old.deckItems.filter(x => x.deckId !== activeDeck.id) })); setSelectedDeck(''); }, children: _jsx(Trash2, { size: 16 }) })] }), _jsxs("div", { className: "deck-commander", children: [_jsx("span", { children: "COMMANDER" }), activeDeck.commander ? _jsxs("div", { className: "commander-current", children: [_jsx("img", { src: cardImage(activeDeck.commander), alt: "" }), _jsx("b", { children: activeDeck.commander.name })] }) : _jsx("span", { className: "muted", children: "No commander selected. Search for a legendary creature or eligible planeswalker." })] }), _jsxs("div", { className: "deck-suggestion-action", children: [_jsxs("button", { className: "secondary", disabled: !activeDeck.commander || suggestionBusy, onClick: () => void getDeckSuggestions(), children: [suggestionBusy ? _jsx(LoaderCircle, { className: "spin", size: 15 }) : _jsx(Sparkles, { size: 15 }), " Find Commander suggestions"] }), _jsx("span", { children: "Ranked by Scryfall EDHREC order and filtered to commander color identity." })] }), deckSuggestions.length > 0 && _jsx("div", { className: "deck-suggestions", children: deckSuggestions.map(c => _jsxs("div", { children: [_jsx("img", { src: cardImage(c), alt: "" }), _jsx("span", { children: c.name }), _jsx("small", { children: c.set.toUpperCase() }), _jsx("button", { onClick: () => addCardToDeck(activeDeck.id, c), children: "Add" })] }, c.id)) }), _jsxs("div", { className: "deck-validation", children: [_jsxs("b", { children: [deckCardCount, " / 100 cards"] }), _jsx("span", { children: activeDeck.commander && !isCommanderEligible(activeDeck.commander.type_line || '', activeDeck.commander.oracle_text || '') ? 'Commander eligibility needs review.' : activeDeck.commander ? `Commander identity: ${(activeDeck.commander.color_identity || []).join('').toUpperCase() || 'Colorless'}` : 'Choose a commander to enable identity checks.' }), deckIdentityIssues.length > 0 && _jsxs("span", { className: "negative", children: [deckIdentityIssues.length, " card(s) exceed the commander color identity."] }), deckDuplicateIssues.length > 0 && _jsxs("span", { className: "negative", children: [deckDuplicateIssues.length, " non-basic card(s) have duplicate quantities."] })] }), _jsxs("div", { className: "deck-add", children: [_jsx("input", { value: query, onChange: e => setQuery(e.target.value), placeholder: "Search cards to add", onKeyDown: e => e.key === 'Enter' && void searchCards() }), _jsxs("button", { className: "secondary", onClick: () => void searchCards(), children: [_jsx(Search, { size: 16 }), " Search"] })] }), searchResults.length > 0 && _jsx("div", { className: "deck-search-results", children: searchResults.slice(0, 5).map(c => _jsxs("div", { children: [_jsx("span", { children: c.name }), _jsx("button", { onClick: () => addCardToDeck(activeDeck.id, c), children: "Add" }), _jsx("button", { disabled: !isCommanderEligible(c.type_line || '', c.oracle_text || ''), onClick: () => setCommander(activeDeck.id, c), children: "Set commander" })] }, c.id)) }), _jsxs("div", { className: "deck-card-list", children: [selectedDeckItems.map(i => _jsxs("div", { className: "deck-row", children: [_jsx("img", { src: cardImage(i.card), alt: "" }), _jsxs("div", { children: [_jsx("b", { children: i.card.name }), _jsx("small", { children: i.card.type_line })] }), _jsxs("span", { children: ["\u00D7", i.quantity] }), _jsx("button", { className: "icon-btn small", onClick: () => removeDeckItem(i.id), children: _jsx(Trash2, { size: 15 }) })] }, i.id)), !selectedDeckItems.length && _jsxs("div", { className: "empty-state", children: [_jsx(PackagePlus, { size: 30 }), _jsx("h3", { children: "No cards in this deck" }), _jsx("p", { children: "Search for cards above or create a deck from your scan list." })] })] }), _jsx("div", { className: "deck-footer", children: _jsxs("button", { className: "secondary", onClick: () => { const rows = selectedDeckItems.map(makeExportRow); const text = exportMoxfield(rows); const blob = new Blob([text], { type: 'text/plain' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `${activeDeck.name.replace(/[^a-z0-9]+/gi, '-')}.txt`; a.click(); URL.revokeObjectURL(url); }, children: [_jsx(Download, { size: 16 }), " Export deck list"] }) })] }) : _jsxs("div", { className: "empty-state deck-empty", children: [_jsx(PackagePlus, { size: 34 }), _jsx("h3", { children: "Select or create a deck" }), _jsx("p", { children: "Your deck cards will appear here." })] })] })] }), tab === 'settings' && _jsxs("main", { className: "page", children: [_jsx("div", { className: "section-head", children: _jsxs("div", { children: [_jsx("div", { className: "eyebrow", children: "LOCAL APP CONFIGURATION" }), _jsx("h1", { children: "Settings & data" }), _jsx("p", { children: "Your collection, decks, and scan list are stored in this browser on this device." })] }) }), _jsxs("div", { className: "settings-grid", children: [_jsxs("div", { className: "panel setting-card", children: [_jsx(Database, { size: 22 }), _jsx("h3", { children: "Card-name catalog" }), _jsx("p", { children: catalogState }), _jsx("small", { children: catalogDate ? `Last downloaded ${new Date(catalogDate).toLocaleString()}` : 'The name index downloads from Scryfall.' }), _jsxs("button", { className: "secondary full", onClick: () => void loadCatalog(true), children: [_jsx(RefreshCw, { size: 16 }), " Refresh name catalog"] })] }), _jsxs("div", { className: "panel setting-card", children: [_jsx(Sparkles, { size: 22 }), _jsx("h3", { children: "On-device OCR" }), _jsx("p", { children: ocrState === 'ready' ? 'Tesseract.js worker is ready.' : `OCR state: ${ocrState}` }), _jsx("small", { children: "OCR reads card title and bottom information locally in your browser after the OCR engine is loaded." }), _jsxs("button", { className: "secondary full", onClick: () => void ensureOcrWorker().then(() => setStatus('OCR engine ready')).catch(e => setError(String(e))), children: [_jsx(Activity, { size: 16 }), " Warm OCR engine"] })] }), _jsxs("div", { className: "panel setting-card", children: [_jsx(ShieldCheck, { size: 22 }), _jsx("h3", { children: "Local data backup" }), _jsx("p", { children: "Export a complete JSON backup before clearing browser data or changing devices." }), _jsxs("button", { className: "primary full", onClick: exportBackup, children: [_jsx(Download, { size: 16 }), " Export full backup"] })] }), _jsxs("div", { className: "panel setting-card", children: [_jsx(Upload, { size: 22 }), _jsx("h3", { children: "Restore backup" }), _jsx("p", { children: "Restore a previously exported AetherForge JSON backup. This replaces the current local data." }), _jsx("input", { type: "file", accept: "application/json", onChange: async (e) => { const f = e.target.files?.[0]; if (!f)
                                            return; try {
                                            const parsed = JSON.parse(await f.text());
                                            if (!parsed.collections || !parsed.items || !parsed.decks || !parsed.scans)
                                                throw new Error('This file is not an AetherForge backup.');
                                            void saveStore({ ...createEmptyStore(), ...parsed, priceHistory: parsed.priceHistory || [] }).then(() => { setStore({ ...createEmptyStore(), ...parsed, priceHistory: parsed.priceHistory || [] }); setStatus('Backup restored'); }).catch(err => setError(err instanceof Error ? err.message : String(err)));
                                        }
                                        catch (err) {
                                            setError(err instanceof Error ? err.message : 'Backup restore failed.');
                                        } e.currentTarget.value = ''; } })] })] }), _jsxs("div", { className: "data-note", children: [_jsx(AlertCircle, { size: 17 }), _jsx("span", { children: "Camera access on a phone requires HTTPS. On the same PC, localhost is treated as secure. Scryfall card details and images require an internet connection; the saved collection remains local." })] })] }), _jsxs("footer", { className: "footer", children: [_jsx("span", { children: "AETHERFORGE MTG V3.0" }), _jsx("span", { children: "Local-first \u00B7 Scryfall card data \u00B7 Browser camera" }), _jsx("span", { children: "Collection value is an estimate, not a sale quote." })] })] });
}
function CardTile({ card, foil, setFoil }) {
    return _jsxs("div", { className: "result-card", children: [_jsx("img", { className: "result-image", src: cardImage(card), alt: card.name }), _jsxs("div", { className: "result-card-copy", children: [_jsx("h3", { children: card.name }), _jsx("p", { children: card.type_line }), _jsxs("div", { className: "result-line", children: [card.set.toUpperCase(), " \u00B7 #", card.collector_number] }), _jsxs("div", { className: "result-line", children: [card.set_name, " \u00B7 ", card.rarity] }), _jsxs("div", { className: "result-price", children: [money(unitPrice(card, foil)), " ", _jsx("span", { children: foil ? 'foil price' : 'nonfoil price' })] }), _jsxs("label", { className: "foil-toggle", children: [_jsx("input", { type: "checkbox", checked: foil, onChange: e => setFoil(e.target.checked) }), " Foil / etched"] })] })] });
}
