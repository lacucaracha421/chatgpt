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
