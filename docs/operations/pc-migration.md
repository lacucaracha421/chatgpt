# Lakomics PC migration and recovery

This is the operational procedure for moving Lakomics to another Windows PC or rebuilding a damaged local install.

## What is portable

- Git/source state: restore from the canonical repository and branch/commit.
- `library.sqlite`: use the app's **PC recovery point** server backup. It contains classifications, collections, bookmarks, manga metadata, reading state, and other DB-backed state.
- Managed Lakomics assets: originals and image thumbnails are reconstructed from the existing Cloud Library R2 replica after the DB snapshot is restored.
- Video derivatives: poster/scrub/proxy files are not copied as recovery payloads; Lakomics regenerates them from the restored video original.
- Extension settings: use the extension's server portability backup. It stores the portable extension state as an AES-GCM envelope on the VPS.

## What is not copied automatically

- External manga originals/folders are not uploaded by the PC recovery point. Copy or remount those folders separately, then set the manga root again.
- External collection source/book folders are not server recovery payloads. Reattach them only when those source files are still needed.
- Windows Credential Manager secrets are not copied. Re-enter the Cloud API token and any Aladin/IGDB/TMDB credentials on the new PC.
- Tailscale identity is machine-level state. Install/login to Tailscale on the new PC instead of copying its local state.
- The extension Collector/Cloud token is the bootstrap secret for extension backup encryption and must be entered on the new browser before restore. It is not stored inside its own encrypted payload.

## Before leaving the old PC

1. Make sure intentional source changes are committed and pushed.
2. In Lakomics Cloud Backfill, verify the library replica is complete (no failed/pending assets that must survive migration).
3. In Settings > External services > **PC recovery point**, choose **Create server recovery point**.
4. In the extension options > Backup / migration, create the server settings backup. The payload is encrypted with AES-GCM using a key derived from the Collector token.
5. Record the external manga root and any collection source folder that must be copied separately.
6. Keep the Cloud API token / Collector token available through your normal secret-management method; do not add them to Git or migration documents.

The server-side PC recovery point is latest-only: `backups/library-metadata.sqlite` is replaced by the newest successful snapshot.

## Prepare the new PC

The repository currently requires Windows, Node.js 24.19.0 LTS, npm 12.0.2, Rust 1.98.0, and WebView2. The repo pins Node/npm/Rust baselines.

```powershell
git clone https://github.com/lacucaracha421/chatgpt.git C:\chatgpt
cd C:\chatgpt\app
npm ci
cd ..
powershell -ExecutionPolicy Bypass -File scripts\fetch-ffmpeg-windows.ps1
powershell -ExecutionPolicy Bypass -File scripts\fetch-ffmpeg-windows.ps1 -VerifyOnly
```

Install/login to Tailscale before relying on the VPS or remote browser paths.

## Restore the Lakomics library

1. Start Lakomics and open/create the intended library root.
2. Configure the Cloud API base URL and Cloud API token manually on this PC.
3. Use **Connection check** first.
4. Settings > External services > **PC recovery point** > **Restore PC from server**.
5. Lakomics first creates a local pre-restore DB backup, restores the verified server `library.sqlite`, then reconstructs managed originals and image thumbnails from R2.
6. Existing correct local files are skipped. Missing or size-mismatched files are replaced through temporary files and atomic rename. Server-missing variants are counted in the restore report instead of aborting every other asset.
7. Restored videos are passed back through the normal video-preparation pipeline to rebuild poster/scrub/proxy data.
8. Copy/remount the external manga originals and set the manga root again when applicable.

Do not call the migration complete if the restore report still shows server-unavailable files that you expected to keep; verify those assets or re-run replication from a surviving source PC first.

## Restore the browser extension

1. Install/load the current Lakomics X Collector build.
2. Enter the Collector endpoint and Collector/Cloud token on the new browser first.
3. Use the extension's server restore action. The current token decrypts the AES-GCM portability snapshot.
4. Reload open X tabs after restore.
5. Confirm the radial editor shows the expected primary/secondary layout and pinned/hidden state rather than the six-item local fallback.

The extension portability snapshot includes connection preferences, radial layout/pins, secondary presentation state, local-tree fallback, and integrated X Translate settings. The app's Windows Credential Manager secrets remain separate.

## Post-migration health checklist

- App opens the expected library and classification count looks plausible.
- A representative image and video both open from local managed storage.
- Video preparation finishes after a fresh-PC restore.
- Extension **PC direct** connection succeeds and does not fall back to the six-item tree unexpectedly.
- Cloud Capture connection check succeeds; a small test capture reaches the expected classification.
- Collector/server connection succeeds through the intended Tailscale path.
- Online catalog transport can search/open one known work.
- Saved-X-media index is populated so already-saved badges are authoritative.
- Extension donut layout, hidden secondary tags, and pinned primaries match the old PC.
- External manga root opens/scans if local-only manga originals are part of the library.
- Re-enter and test any Aladin, IGDB, or TMDB credentials that are still used.

## Verification commands for a development machine

```powershell
cd C:\chatgpt\extension
npm test

cd C:\chatgpt\server\lakomics-api
py -m unittest tests.test_capture_api

cd C:\chatgpt\app
npm test -- --run
npm run build

cd C:\chatgpt\app\src-tauri
cargo test --lib
```

`cargo test` without `--lib` currently also builds auxiliary bin/integration targets and can fail on the local `app_lib` rlib target configuration; use the app-library suite for the normal regression gate until that separate build configuration is repaired.
