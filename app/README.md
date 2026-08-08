# Lakomics

Lakomics is a desktop media library for images.

## Run and verify

Node.js, npm, Rust, and Windows WebView2 are required.

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

## Current controls

- Navigate classifications from the sidebar; use each row menu to rename, move, or delete a classification.
- Choose newest, oldest, favorites, or random sort. Use direct-only filtering for a classification view.
- Toggle asset metadata from the toolbar.
- Select an asset with one click and open its details with a double click.
- Drop image files only while a concrete classification is selected.

## Library safety and backups

- Only one Lakomics process may use a library at a time.
- Moving an asset to the trash changes its library state. Its media file remains under `assets/` until the trash is purged.
- Automatic trash purge defaults to 30 days. It can be set from 1 to 3,650 days or disabled.
- Lakomics retains the seven most recent daily metadata backups.
- Restoring a metadata backup restores library management data, not missing or changed original media files.
- For a full media backup, close Lakomics and copy the entire library folder to another location.
- When using the library on multiple PCs, close Lakomics and wait for synchronization to finish before opening it on the next PC.
