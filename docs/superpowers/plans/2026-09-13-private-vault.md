# Private Vault (`비밀`) Implementation Plan

> **Execution:** Implement inline in the current session. Repository rules prohibit subagents. Do not perform Git writes unless separately authorized.

**Goal:** Add a desktop-only portable external media vault that appears as `비밀` below `메모` only while its registered unlocked filesystem is available.

**Architecture:** Keep vault media out of the main `assets` table. Store portable vault identity, index, thumbnails, and video derivatives under `<vault>/.lakomics/`; store only registration hints in the main library settings. Reuse existing gallery/viewer/player URLs by falling back from the normal ID-resolved media routes to the currently available vault only when the main library has no matching asset UUID.

**Tech Stack:** Tauri 2, Rust, rusqlite, React/TypeScript, Vitest, existing FFmpeg/FFprobe integration.

**Spec:** `docs/superpowers/specs/2026-09-13-private-vault-design.md`

## Global Constraints

- Current working tree contains unrelated mobile/server work; preserve it exactly.
- Current database schema version is 76; use migration `0077_private_vault.sql`, and re-check before editing if another concurrent migration appears.
- Support Windows and Linux path behavior.
- Do not invoke VeraCrypt, inspect `.hc` containers, or store encryption passwords.
- Never copy, move, rename, or delete user vault media.
- Vault media must never enter normal cloud sync/backfill or normal revisit activity.
- Automated tests use temporary directories only; do not write to the active library or the user's VeraCrypt volume.
- Do not run write-mode `cargo fmt`; use direct `rustfmt` only on changed Rust files if formatting is needed.

---
### Task 1: Registration persistence and domain contract

**Files:**
- Create: `_tools/app/src-tauri/migrations/0077_private_vault.sql`
- Create: `_tools/app/src-tauri/src/library/external_vault.rs`
- Modify: `_tools/app/src-tauri/src/library/db.rs`
- Modify: `_tools/app/src-tauri/src/library/mod.rs`
- Modify: `_tools/app/src-tauri/src/library/models.rs`
- Test: `_tools/app/src-tauri/src/library/external_vault.rs`

**Interfaces:**
- `PrivateVaultStatus { registered, available, vault_id, root, asset_count, read_only }`
- `Library::private_vault_status() -> Result<PrivateVaultStatus, LibraryError>`
- `Library::register_private_vault(root: &Path) -> Result<PrivateVaultStatus, LibraryError>`
- `Library::unregister_private_vault() -> Result<(), LibraryError>`

- [ ] Write migration tests proving `private_vault_id` and `private_vault_last_root` survive reopen and default to `NULL`.
- [ ] Add migration 0077 with those two nullable `library_settings` columns and wire it into `db.rs` after re-checking the live schema number.
- [ ] Write failing tests for registration creating `.lakomics/vault.json` with a UUID, re-registering the same root preserving the UUID, and unregistering only clearing main-library registration.
- [ ] Implement strict root validation, provider-independent `vault.json`, and status loading. Registration may create `.lakomics/`; it must not touch other vault content.
- [ ] Run targeted Rust tests for migration and registration from `_tools/app/src-tauri/`.

Expected command shape:
```bash
cargo test private_vault --lib
```
### Task 2: Mounted-volume discovery and reconnect

**Files:**
- Create: `_tools/app/src-tauri/src/library/private_vault/discovery.rs`
- Modify: `_tools/app/src-tauri/src/library/external_vault.rs`
- Test: `_tools/app/src-tauri/src/library/private_vault/discovery.rs`

**Interfaces:**
- `discover_registered_vault(vault_id: &str, last_root: Option<&Path>) -> Option<PathBuf>`
- Linux candidate roots come from parsed mount information; Windows candidates come from mounted drive roots.

- [ ] Write parser/unit tests for Linux mount entries, Windows-style drive candidates, last-known-path preference, and rejecting a candidate whose `vault.json` has another UUID.
- [ ] Implement discovery so it checks the remembered path first and then only mounted root candidates, never recursively scanning arbitrary disks.
- [ ] Update `private_vault_status()` to rediscover the same `vault_id` and persist a changed root when found.
- [ ] Add a test that simulates the same temporary vault moving to a new mount-style path and verifies identity survives.
- [ ] Run only the private-vault discovery/registration tests.

### Task 3: Portable index and incremental scanner

**Files:**
- Create: `_tools/app/src-tauri/src/library/private_vault/index.rs`
- Create: `_tools/app/src-tauri/src/library/private_vault/scan.rs`
- Modify: `_tools/app/src-tauri/src/library/external_vault.rs`
- Modify: `_tools/app/src-tauri/src/library/video_media.rs`
- Test: new module-local tests in `index.rs` and `scan.rs`

**Interfaces:**
- `PrivateVaultAssetSummary` and `PrivateVaultAssetPage`
- `PrivateVaultQuery { media_kind: Option<String>, offset: u64, limit: u32 }`
- `Library::scan_private_vault() -> Result<PrivateVaultScanReport, LibraryError>`
- `Library::list_private_vault_assets(query: PrivateVaultQuery) -> Result<PrivateVaultAssetPage, LibraryError>`
- [ ] Write failing scanner tests for recursive image/video discovery, `.lakomics/` exclusion, unchanged-file reuse by path+size+mtime, removal of missing rows, and isolation of one unreadable file.
- [ ] Initialize `.lakomics/index.sqlite` with a small vault-local schema containing UUID, relative path, media kind, original name, size, mtime, dimensions, video metadata, derivative paths, and scan error state.
- [ ] Implement recursive scanning for the existing image formats and MP4/WebM/MOV. Preserve user folder structure and never mutate source files.
- [ ] Expose a reusable video helper from `video_media.rs` that probes and prepares poster/scrub/proxy files into a caller-provided derivative directory without touching the main library DB or cloud queue.
- [ ] Generate image thumbnails under `.lakomics/thumbnails/` and video derivatives under `.lakomics/media/<asset-id>/`; skip regeneration when the source fingerprint tuple is unchanged.
- [ ] Run scanner tests, then the existing focused `video_media` tests to prove the helper did not change normal-library playback preparation.

### Task 4: Safe vault media fallback

**Files:**
- Modify: `_tools/app/src-tauri/src/library/mod.rs`
- Modify: `_tools/app/src-tauri/src/library/external_vault.rs`
- Modify: `_tools/app/src-tauri/src/media_protocol.rs`
- Test: `_tools/app/src-tauri/src/media_protocol.rs`

**Interfaces:**
- Existing `/asset/<asset-id>`, `/thumbnail/<asset-id>`, and `/playback/<asset-id>` routes first resolve normal library rows and then fall back to the currently available registered vault for otherwise unknown UUIDs.

- [ ] Write failing protocol tests for vault image/thumbnail access, bounded video Range responses, and unsafe indexed paths.
- [ ] Resolve vault bytes only through `.lakomics/index.sqlite`, validate relative components, and reuse the existing canonical external-root containment boundary.
- [ ] Route vault playback through the existing bounded `playback_response` path rather than reading the entire video into memory.
- [ ] Keep normal-library route behavior unchanged and avoid new provider-specific URL builders.
- [ ] Run focused Rust media-protocol tests.

### Task 5: Reuse the existing viewer safely

**Files:**
- Modify: `_tools/app/src/assets/AssetViewer.tsx`
- Test: `_tools/app/src/assets/AssetViewer.test.tsx`

- [ ] Add a failing test showing management actions disappear when their handlers are absent.
- [ ] Render favorite/trash controls only when their callbacks exist so the vault viewer remains read-only.
- [ ] Reuse the existing `AssetGallery`, `AssetViewer`, and `VideoPlayer` URLs unchanged through the native media fallback.
- [ ] Use zero scrub-frame count for vault video in the first UI while retaining normal playback.
- [ ] Run the focused viewer and vault-browser tests.

### Task 6: Native commands and frontend gateway

**Files:**
- Modify: `_tools/app/src-tauri/src/commands.rs`
- Modify: `_tools/app/src-tauri/src/lib.rs`
- Modify: `_tools/app/src/library/types.ts`
- Modify: `_tools/app/src/library/client.ts`
- Test: `_tools/app/src/library/client.test.ts`
**Interfaces:**
- `getPrivateVaultStatus()`
- `registerPrivateVault(root)`
- `unregisterPrivateVault()`
- `scanPrivateVault()`
- `listPrivateVaultAssets(query)`

- [ ] Add failing client contract tests for the exact Tauri command names and payload shapes.
- [ ] Add thin Tauri commands that move blocking scan/list work onto `spawn_blocking` and expose the Rust types with camelCase serialization.
- [ ] Register commands in the current invoke handler without disturbing concurrent command additions.
- [ ] Add matching gateway types/methods in TypeScript and make existing test gateway fixtures compile with explicit private-vault defaults where required.
- [ ] Run `src/library/client.test.ts` and `cargo check` only after the focused Rust tests are green.

### Task 7: `비밀` browser, navigation, and settings

**Files:**
- Create: `_tools/app/src/external-vault/ExternalVaultBrowser.tsx`
- Create: `_tools/app/src/external-vault/externalVault.css`
- Create: `_tools/app/src/external-vault/ExternalVaultBrowser.test.tsx`
- Create: `_tools/app/src/external-vault/useExternalVaultAvailability.ts`
- Create: `_tools/app/src/external-vault/useExternalVaultAvailability.test.tsx`
- Modify: `_tools/app/src/library/types.ts`
- Modify: `_tools/app/src/layout/WorkspaceNavigation.tsx`
- Modify: `_tools/app/src/app/App.tsx`
- Modify: `_tools/app/src/settings/SettingsView.tsx`
- Test: relevant `App`, navigation, and settings tests

- [ ] Add `AssetView` variant `{ kind: "private_vault" }` and failing navigation tests proving `비밀` is absent when unavailable and appears directly below `메모` when available.
- [ ] Build `ExternalVaultBrowser` around `AssetGallery` and `AssetViewer`, adapting `PrivateVaultAssetSummary.modifiedAt` into the gallery date field while reusing the normal media URLs.
- [ ] Provide only media-kind filtering, masonry browsing, viewer opening, and manual refresh in the first version; do not expose classification, favorite, trash, similarity, or character actions.
- [ ] Add Settings > Data controls for selecting a mounted root, registering/reconnecting it, and unregistering it. Reuse the existing Tauri directory picker.
- [ ] Wire the app shell so vault availability controls the rail item and `view.kind === "private_vault"` renders the new browser.
- [ ] Run focused ExternalVaultBrowser, WorkspaceNavigation/App, and SettingsView tests.
### Task 8: Availability refresh, disconnect behavior, and final verification

**Files:**
- Modify: `_tools/app/src/app/App.tsx`
- Modify: `_tools/app/src/external-vault/useExternalVaultAvailability.ts`
- Test: `_tools/app/src/app/App.test.tsx`
- Test: external-vault Rust tests

- [ ] Add a failing app test for an available vault disappearing while `private_vault` is active: the app returns to `{ kind: "classification", classificationId: null }` and the navigation entry disappears.
- [ ] Refresh vault status at startup and on window/app focus with a bounded event-driven check; do not add a tight polling loop.
- [ ] Treat media-not-found during a disconnect as an unavailable vault state rather than surfacing repeated blocking dialogs.
- [ ] Verify vault browsing never calls `recordAssetOpened` or `recordAssetsExposed`, and scan/register paths never insert main `assets` or `cloud_sync_queue` rows.
- [ ] Run the focused frontend and Rust suites affected by this feature, then `npm run build` and `cargo check` from their owning directories.
- [ ] If the dev app is already running from `_tools/app/`, verify it rebuilt/reloaded before any native acceptance claim. Use temporary test vault content for acceptance unless the user separately authorizes writes to the real mounted vault.
- [ ] Inspect `git status --short`, `git diff --stat`, and diffs for every touched file to confirm unrelated worktree changes were preserved.

## Expected Verification Set

```bash
# from /home/laku/chatgpt/_tools/app
npm test -- --run src/external-vault/ExternalVaultBrowser.test.tsx src/external-vault/useExternalVaultAvailability.test.tsx src/layout/WorkspaceNavigation.test.tsx src/assets/AssetViewer.test.tsx src/library/client.test.ts src/app/App.test.tsx src/settings/SettingsView.test.tsx
npm run build

# from /home/laku/chatgpt/_tools/app/src-tauri
cargo test external_vault --lib
cargo test media_protocol --lib
cargo test video_media --lib
cargo check
```

Broaden tests only if these checks reveal a regression outside the focused paths.
