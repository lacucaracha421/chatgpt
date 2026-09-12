# Lakomics

Lakomics is a local-first media library with Windows and Linux desktop implementations, built with React/TypeScript, Vite, Tauri 2, and Rust. It manages assets, classifications, albums, typed Works/Collections, and an independent Online Catalog.

Documentation reconciled on 2026-09-09 against source commit `0c61206`. See the [repository overview](../../README.md), [document map](../../docs/README.md), and [living backlog](../../docs/roadmap/lakomics-backlog.md) for other clients and remaining acceptance gates.

## Run and verify

This package lives at `_tools/app/` relative to the repository root (path checked
2026-09-12). Root documentation is two levels up. Enter this directory before
running npm commands; historical `app/` paths below describe earlier checkouts.

The pinned baselines are Node.js 24.19.0, npm 12.0.2, and Rust 1.98.0.
Windows uses WebView2 and Windows build prerequisites. Linux uses GTK 3 and
WebKitGTK 4.1; follow the [Linux setup guide](../../docs/operations/linux-desktop.md)
for distribution packages, system FFmpeg/ffprobe, filesystem requirements, and
platform verification limits. The Windows FFmpeg commands below apply only to Windows.
The repository pins the Node.js baseline in `../../.node-version`, the npm baseline in
`package.json`, and the Rust toolchain in `rust-toolchain.toml`.

Fetch and verify the pinned Windows LGPL FFmpeg sidecars from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg-windows.ps1
powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg-windows.ps1 -VerifyOnly
```

Do not infer a test library from an old machine path. Use only a disposable fixture/library explicitly placed in task scope. The active production-library boundary and separate write approval are defined in `../../AGENTS.md`.

The commands below are a reference, not a per-change checklist. Follow `../../AGENTS.md` for risk-based verification and reuse of valid evidence. Dependency installation is a setup operation, not part of a documentation review. Run these app commands from `_tools/app/` (relative to the repository root).

```powershell
npm ci
npm run tauri -- dev
npm test
npm run build
npm run tauri build -- --debug
Set-Location src-tauri
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

## Current daily-use behavior

- Lakomics always starts in **All assets**. The sidebar also provides Unsorted, Recent, Favorites, classifications, Trash, and Library safety.
- Asset browsing defaults to date-grouped masonry/waterfall; justified rows remain an alternative. Choose newest, oldest, favorites, or random sort. Adjust preview size and toggle thumbnail metadata independently. See [the PC design reference](../../docs/agents/pc-design-reference.md) for current shell and navigation behavior.
- Click to select one asset, Ctrl-click to toggle, Shift-click for a loaded range, and Ctrl+A to select only currently loaded assets. Escape clears selection; arrow keys move focus; Delete moves the selection to Trash.
- Double-click or press Enter to open the full-screen viewer. Left and Right move through the currently loaded order, and Escape closes the viewer.
- The information panel opens on the first non-empty selection. Closing it manually keeps it closed while the selection changes; clearing the selection resets that choice. It shows one-asset metadata or a multi-selection summary and delegates classification changes to the same batch operation as the toolbar.
- Drop files anywhere in an ordinary asset view. A concrete classification view adds that classification; All assets, Unsorted, Recent, and Favorites ingest into Unsorted. Incoming files are copied, and user source files are never moved or deleted.
- A completed media drop reports added, exact duplicate, similar-image review, and failure counts. Exact duplicates can open the existing asset; similar images stay outside ordinary asset views until reviewed. Videos use exact-byte duplicate detection and never enter image-similarity review.
- MP4, WebM, and MOV videos are registered immediately, then prepared one at a time in the background. Lakomics creates a poster and up to 240 WebP scrub frames. Web-compatible H.264/AAC MP4/MOV and VP8/VP9/AV1 WebM files play from the managed original; incompatible media receives an H.264/AAC proxy capped at 1080p/30fps without upscaling.
- A ready video tile starts muted playback after a 200ms hover delay. Only one tile previews at a time; moving away releases its source. The tile progress strip shows discrete scrub frames and seeks after a short stable-pointer delay.
- Double-click or press Enter on a video to use the full viewer with play/pause, current and total time, seeking and timeline preview, mute/volume, fullscreen, and previous/next navigation. Space toggles playback unless a control owns keyboard focus.
- The Similar image review entry compares the existing and incoming images with public metadata. Choose Keep existing, Replace with new image, or Keep both. Existing-image replacement transfers its favorite and classifications while preserving the incoming image's source and collected date.
- Existing images are prepared for similarity checks in non-blocking batches. The status bar reports remaining work and any images whose perceptual hash could not be prepared.
- Drag assets onto a classification to move their single direct classification, or drag classifications to reorganize the tree. Dragging selected assets out uses native copy semantics and original names with collision suffixes. Windows uses OLE; Linux uses GTK file URIs and independent staging copies. Linux recipient acceptance remains pending; see the [platform guide](../../docs/operations/linux-desktop.md#linux-drag-out-follow-up-2026-09-09).
- The work tray reports ingestion and drag-out progress for the current app session only. It is not a persistent background-job history.

Release Watch is opt-in per Aladin-connected manga. On startup Lakomics checks subscriptions whose last successful check is at least 24 hours old, shows an unread `신간 N` badge for new or changed Korean releases, and marks those changes read when the Collection is opened. Lakomics does not check while the app is closed.

Folder-recursive ingestion and AVIF/HEIC are deferred.

## Edge X image collection

The bundled [Chromium collector](../../extension/README.md) supports image/video collection, radial or list destination menus, and X translation. Direct PC ingestion uses an authenticated loopback connection; optional Cloud Capture supports remote collection. See the [installation and operation guide](../../docs/edge-extension.md) for routing and supported sources.

## Historical acceptance records

The following 2026-08-09 records describe older revisions and temporary Windows
fixtures. Their paths, test counts, screenshots, and timings are historical evidence,
not current setup commands, current library locations, or verification of `0c61206`.
Current platform evidence is in the [Linux guide](../../docs/operations/linux-desktop.md)
and feature acceptance is tracked in the [backlog](../../docs/roadmap/lakomics-backlog.md).

### Similar image review acceptance

Verified on 2026-08-09 with the temporary library at
`C:\Users\namwoojun\Desktop\test`:

```powershell
cd C:\chatgpt\.worktrees\daily-use-ui\app
npm.cmd run check
cd src-tauri
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
cargo test candidate_search_scans_fifty_thousand_hashes --release -- --ignored --nocapture
cd ..
npm.cmd run tauri build -- --debug --no-bundle
```

- The four-file ingestion fixture produced two added images, one exact duplicate, one review-pending image, and no failures. The drop orchestration and result actions are covered by frontend integration tests; the same files were exercised through the real Windows library and review UI.
- All 189 frontend tests passed, the TypeScript/Vite production build completed, and the Rust suite passed 88 unit tests, 12 integration tests, and one compile-fail doctest (with the dedicated performance test ignored in the ordinary run).
- The sidebar queue count, 960×650 single-column layout, maximized two-column layout, all three decisions, and unresolved-review restart persistence were exercised in the Windows app.
- Keep existing removed only the managed candidate. Replace moved the existing asset to Trash and transferred its favorite and classification while retaining the candidate source and collected date. Keep both left both assets normal.
- Every external acceptance source remained present after ingestion and all three decisions.
- The 50,000-row candidate scan completed in 40.9844 ms in the release measurement.
- `.acceptance\similarity-result.png` records the four result counters and actions.
- `.acceptance\similarity-review-normal.png` records the maximized side-by-side comparison.
- `.acceptance\similarity-review-narrow.png` records the 960×650 stacked comparison without horizontal clipping.

### Eagle compact UI acceptance

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

### Windows drag-out acceptance

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
