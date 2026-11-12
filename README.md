# AetherForge MTG v3.0

A local-first Magic: The Gathering scanner and collection manager built from the supplied AetherForge source and roadmap.

## What is included

- Live camera scanner and image upload fallback.
- On-device Tesseract.js OCR for the card title and bottom information strip.
- Local Scryfall card-name catalog and fuzzy matching.
- Soft-focus advisory that never blocks an identification attempt (Pass 33 contract).
- Collector-number + set-code printing verification.
- Conservative local artwork fingerprint comparison across candidate printings. It confirms only when the distance and margin pass the gate; otherwise the printing remains visibly unconfirmed.
- Temporary scan list with duplicate consolidation, foil flag, remove, and bulk save.
- Multiple named collections with per-collection estimated market value.
- Collection quantity and condition editing, price refresh, baseline movement, and price history.
- ManaBox CSV, Archidekt CSV, and Moxfield TXT export; ManaBox CSV import.
- Deck creation from the temporary scan list (the cards are also saved to the selected collection), empty deck creation, commander selection, color-identity checks, duplicate warnings, and Scryfall/EDHREC-ordered suggestions.
- IndexedDB persistence with a localStorage fallback, JSON backup/restore, and a basic app-shell service worker.
- Original supplied modules, roadmap, schema, actions, probes, and regression tests preserved in `legacy/`.

## Windows: run it (simple steps)

1. Extract the ZIP to a normal folder, for example `C:\AetherForge_MTG_3`.
2. Install Node.js LTS if it is not already installed: https://nodejs.org/
3. Double-click `RUN_WINDOWS.bat`.
4. Keep the black window open. Open this address in Chrome or Edge: `http://localhost:8765`.
5. Allow camera access when the browser asks. Click **Start camera**.
6. For the first scan, wait for the card-name catalog and OCR engine to finish loading. An internet connection is required for first-time downloads and Scryfall card data.

The included `dist/` folder is already built, so running the app does not require `npm install`.

## Rebuild after editing source

If you change TypeScript source files:

1. Open Command Prompt in this folder.
2. Run `npm install -g typescript` once if the `tsc` command is not available.
3. Run `BUILD_WINDOWS.bat`.
4. Run `RUN_WINDOWS.bat`.

Or use `npm run build` if TypeScript is available globally.

## Phone camera

Phone browsers require a trusted HTTPS origin for camera access. `http://localhost:8765` works on the Windows PC, but a phone opening the PC's LAN IP over plain HTTP will normally be blocked from using its camera. This build does not yet include a generated/trusted phone certificate installer. Use photo upload on the phone until a trusted HTTPS endpoint is configured.

## Data and privacy

- Collections, scan list, decks, and price snapshots are stored in the browser's IndexedDB on the device where the app is opened. They are not automatically synchronized between your PC and phone.
- Export a JSON backup from the download icon in the header or Settings before clearing browser data or moving devices.
- The Scryfall card-name catalog is cached locally. Scryfall API calls and card image requests require an internet connection.
- Tesseract.js is loaded from jsDelivr on first use. OCR itself runs in the browser after the engine has loaded.
- Card images and card data are supplied by Scryfall. AetherForge does not own those assets.

## Accuracy notes / honest limitations

- A card name is identified from the printed title using the supplied OCR and local fuzzy matcher. When the title is ambiguous, the app asks you to choose from suggestions rather than silently saving the top fuzzy result.
- A printing is confirmed by a readable set/collector-number match or a sufficiently separated local artwork fingerprint match among printings of the OCR-matched card. Shared artwork, unsupported image CORS, unusual frames, and weak visual margins remain unconfirmed instead of being presented as certain.
- This is not a full 110,000-printing offline visual index and does not contain a server-side vision model. The supplied `finder.ts` and platform API/server files were not present in the uploaded archives; `src/core/finder.ts` supplies the shared fusion contract and `src/core/visual.ts` provides a conservative client-side reference-image verifier.
- The new v3 app is a standalone browser application. The original 400 KB platform-specific `App.tsx`, `actions.ts`, schema, tests, probes, and data plan are preserved under `legacy/`; the original platform runtime/API adapter and several original modules were not included in the archives, so this build does not pretend to be a drop-in deployment of that platform app.
- Deck validation currently reports card count, color-identity violations, and duplicate non-basic quantities. It is not a complete rules judge for every Commander exception, partner/background mechanic, or special deck construction rule.

## Checks performed in this build

- TypeScript source check: passed.
- Static browser build: passed.
- JavaScript syntax checks for emitted application modules: passed.
- Seven local regression tests: passed, including the Pass 33 no-focus-veto contract, card-rect clipping warning, OCR name matching, bottom-line parsing, evidence-aware printing candidate selection, ManaBox CSV round-trip, and rapid signature stability.
- HTTP smoke check: the local server returned HTTP 200 for the app entry page, main bundle, scanner core modules, CSS, manifest, and service worker.
- A full interactive browser/camera test was not possible in this environment because browser navigation is blocked by the execution sandbox. Test the live camera on your Windows PC after starting the app.

## Folder guide

- `src/App.tsx` — standalone v3 interface and workflows.
- `src/core/` — preserved scanner engine modules plus the local visual-printing verifier.
- `dist/` — prebuilt browser app served by `RUN_WINDOWS.bat`.
- `legacy/` — original uploaded implementation, roadmap, schema, actions, probes, and original regression files.
- `tests/core-regression.cjs` — runnable regression checks for the v3 core.
