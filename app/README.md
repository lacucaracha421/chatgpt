# Lakomics

Lakomics is a local-first Windows media library for JPEG, PNG, GIF, and WebP images.

## Run and verify

Node.js, npm, Rust, and Windows WebView2 are required.

When a test app has no library registered, use
`C:\Users\namwoojun\Desktop\test` as the temporary library.

```powershell
npm install
npm run tauri dev
npm test
npm run build
Set-Location src-tauri
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

## Current daily-use behavior

- Lakomics always starts in **All assets**. The sidebar also provides Unsorted, Recent, Favorites, classifications, Trash, and Library safety.
- Choose newest, oldest, favorites, or random sort. Change the justified-row height with the preview-size slider and toggle thumbnail metadata independently.
- Click to select one asset, Ctrl-click to toggle, Shift-click for a loaded range, and Ctrl+A to select only currently loaded assets. Escape clears selection; arrow keys move focus; Delete moves the selection to Trash.
- Double-click or press Enter to open the full-screen viewer. Left and Right move through the currently loaded order, and Escape closes the viewer.
- The information panel opens on the first non-empty selection. Closing it manually keeps it closed while the selection changes; clearing the selection resets that choice. It shows one-asset metadata or a multi-selection summary and delegates classification changes to the same batch operation as the toolbar.
- Drop files anywhere in an ordinary asset view. A concrete classification view adds that classification; All assets, Unsorted, Recent, and Favorites ingest into Unsorted. Incoming files are copied, and user source files are never moved or deleted.
- Drag assets onto a classification to add it, or drag classifications to reorganize the tree. Dragging selected assets out of Lakomics starts a Windows copy operation with their original names; duplicate names receive a Windows-style numeric suffix.
- The work tray reports ingestion and drag-out progress for the current app session only. It is not a persistent background-job history.

Collections, similar-image review, browser-extension integration, video playback, comic reading, folder-recursive ingestion, and AVIF/HEIC are deferred.

## Eagle compact UI acceptance

Verified on 2026-08-09 with the temporary library at
`C:\Users\namwoojun\Desktop\test`:

```powershell
cd C:\chatgpt\.worktrees\daily-use-ui\app
npm.cmd run tauri dev
npm.cmd run check
```

- All 176 frontend tests passed and the TypeScript/Vite production build completed successfully.
- `.acceptance\eagle-compact-normal.png` records the normal desktop layout.
- `.acceptance\eagle-compact-narrow.png` records the 960×650 layout with the inspector open.
- `.acceptance\eagle-compact-drop.png` records the native Explorer drop indicator.
- Single and multi-file incoming drops were exercised over the gallery, sidebar, and inspector. Exact duplicates did not create a new asset.
- Dragging an asset to `.acceptance\output\run-eagle-compact-20260809-123822` produced a byte-identical copy while the managed original remained in the library.

## Windows drag-out acceptance

Verified on 2026-08-09 with the library at
`C:\Users\namwoojun\Desktop\test` and Windows File Explorer:

- Single output: `.acceptance\output\run-fix-20260809-0046\HPMhSEIbkAAc_sg.jpg`.
- Multi-output: `.acceptance\output\run-multi-20260809-0047` contains two selected files with their original names.
- Duplicate names: `.acceptance\output\run-duplicate-all-20260809-0054` contains both `HPMhSEIbkAAc_sg.jpg` and `HPMhSEIbkAAc_sg (2).jpg`.
- Cancel output: `.acceptance\output\run-cancel-20260809-0055` remained empty and `.drag-out` had no staged child.
- All four managed asset files remained present and matched their recorded SHA-256 hashes after successful drops.
- Restart removed the deliberately created `.drag-out\stale-acceptance` directory.

## Library safety and backups

- Only one Lakomics process may use a library at a time.
- Moving an asset to the trash changes its library state. Its media file remains under `assets/` until the trash is purged.
- Automatic trash purge defaults to 30 days. It can be set from 1 to 3,650 days or disabled.
- Lakomics retains the seven most recent daily metadata backups.
- Restoring a metadata backup restores library management data, not missing or changed original media files.
- For a full media backup, close Lakomics and copy the entire library folder to another location.
- When using the library on multiple PCs, close Lakomics and wait for synchronization to finish before opening it on the next PC.
