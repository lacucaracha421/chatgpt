# Works v2 P2 MangaDex Flow Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Add the first complete MangaDex provider flow: search, preview, create or connect a manga Work, persist one chosen provider cover outside Assets, and refresh provider metadata without overwriting user-owned values.

**Architecture:** Keep remote protocol details in a concrete `mangadex` Module, artwork rows/files in `work_artwork`, and cross-Module transactions in `mangadex_flow`. React uses narrow Tauri commands through `LibraryGateway`; provider previews and persistent artwork are served through Lakomics media URLs.

**Tech Stack:** Rust, rusqlite, ureq, image, Tauri commands/protocol, TypeScript, React, Radix UI, Vitest/Testing Library.

**Design reference:** `docs/superpowers/specs/2026-08-20-works-v2-p2-mangadex-flow-design.md`

**Verification rule:** Run only the targeted check named in each task. Do not run a production build or either full suite unless a targeted failure identifies broader risk. Do not repeat a successful check unless later edits could invalidate it.

---

## Task 1: Add schema v14 and project selected WorkArtwork

**Files:**

- Create: `app/src-tauri/migrations/0014_collection_work_artworks.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/collection.rs`

**Step 1: Write focused failing tests**

Add a v13-to-v14 migration test in `db.rs` that checks the table, foreign key, provider identity uniqueness, and partial selected-cover index. Add one `collection.rs` test proving only the selected `cover` row produces:

```rust
pub selected_work_artwork_id: Option<String>,
```

Run only those two tests. Expected: fail because schema v14 and the summary field do not exist.

**Step 2: Implement schema v14**

Create `collection_work_artworks` with the columns and constraints in the design: collection cascade FK, unique relative path, unique `(collection_id, provider, provider_image_id)`, positive dimensions, boolean `selected`, and a partial unique index on selected `(collection_id, kind)`. Set `SCHEMA_VERSION` to 14, accept old versions through 13, and execute migration 0014 after 0013.

**Step 3: Extend the summary query**

Add `selected_work_artwork_id` to the Rust model. Extend `COLLECTION_SUMMARY_SQL` with a correlated subquery restricted to `kind = 'cover' AND selected = 1`, then map it in `collection_from_row`. Update existing Rust fixtures with `None` only where compilation requires it.

**Step 4: Verify and commit**

```powershell
cargo test library::db::tests::migrates_v13_to_v14 --manifest-path app/src-tauri/Cargo.toml
cargo test library::collection::tests::summary_projects_selected_work_artwork --manifest-path app/src-tauri/Cargo.toml
git add app/src-tauri/migrations/0014_collection_work_artworks.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/collection.rs
git commit -m "Add WorkArtwork schema and collection projection"
```

## Task 2: Own WorkArtwork rows, files, and local media

**Files:**

- Create: `app/src-tauri/src/library/work_artwork.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/media_protocol.rs`

**Step 1: Write focused failing tests**

In `work_artwork.rs`, cover invalid/oversized images, decoded dimensions, generated storage paths, switching the selected cover, resolution by opaque ID, file removal after transaction failure, and library-open orphan cleanup. Add one protocol parser test for `work-artwork/<artwork-id>`.

```powershell
cargo test library::work_artwork::tests --manifest-path app/src-tauri/Cargo.toml
cargo test media_protocol::tests::parses_work_artwork_route --manifest-path app/src-tauri/Cargo.toml
```

Expected: fail because the Module and route do not exist.

**Step 2: Implement the deep Interface**

```rust
pub(crate) struct PreparedWorkArtwork {
    pub id: String,
    pub relative_path: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
}

impl Library {
    pub(crate) fn prepare_work_artwork(
        &self,
        collection_id: &str,
        bytes: &[u8],
    ) -> Result<PreparedWorkArtwork, LibraryError>;

    pub(crate) fn select_work_artwork_in_transaction(
        transaction: &rusqlite::Transaction<'_>,
        collection_id: &str,
        provider: &str,
        provider_image_id: &str,
        language: Option<&str>,
        prepared: &PreparedWorkArtwork,
    ) -> Result<(), LibraryError>;

    pub fn resolve_work_artwork(&self, artwork_id: &str) -> Result<MediaResponse, LibraryError>;
}
```

The Module owns the 32 MiB limit, image decoding, MIME/extension mapping, generated IDs, file lifecycle, selection update, and open-time orphan cleanup. Paths are always `work-artwork/<collection>/<artwork>.<validated-extension>`; do not introduce a provider-generic Adapter.

**Step 3: Add local media resolution**

Parse only `work-artwork/<opaque-id>`, look the ID up in SQLite, and reuse the canonical library-root containment check. Never accept a relative filesystem path from the URL.

**Step 4: Re-run the same checks and commit**

```powershell
git add app/src-tauri/src/library/work_artwork.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/error.rs app/src-tauri/src/media_protocol.rs
git commit -m "Add managed WorkArtwork storage"
```

## Task 3: Implement the concrete MangaDex client and preview proxy

**Files:**

- Create: `app/src-tauri/src/library/mangadex.rs`
- Create: `app/src-tauri/src/library/fixtures/mangadex_search.json`
- Create: `app/src-tauri/src/library/fixtures/mangadex_detail.json`
- Create: `app/src-tauri/src/library/fixtures/mangadex_covers.json`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/media_protocol.rs`

**Step 1: Add fixtures and focused failing tests**

Use trimmed real-shape fixtures containing localized titles, author/artist relationships, description, year, status, tags, primary cover, and several cover records. Test:

- title priority `ko -> en -> ja-ro -> ja` and alternate-title de-duplication;
- metadata and cover mapping;
- trimmed minimum-two-scalar queries;
- UUID and conservative filename validation;
- fixed origins and percent-encoded queries;
- stable 429, timeout/transport, not-found, and invalid-response errors;
- parsing `mangadex-cover-preview/<manga-id>/<provider-file-name>`.

```powershell
cargo test library::mangadex::tests --manifest-path app/src-tauri/Cargo.toml
cargo test media_protocol::tests::parses_mangadex_cover_preview_route --manifest-path app/src-tauri/Cargo.toml
```

Expected: fail before implementation. Tests must not call live MangaDex.

**Step 2: Implement app-owned provider values**

```rust
pub struct MangaDexSearchResult {
    pub manga_id: String,
    pub title: String,
    pub alternate_titles: Vec<String>,
    pub author: Option<String>,
    pub year: Option<i64>,
    pub status: Option<String>,
    pub primary_cover_file_name: Option<String>,
}

pub struct MangaDexWorkPreview {
    pub manga_id: String,
    pub proposed_title: String,
    pub alternate_titles: Vec<String>,
    pub author: Option<String>,
    pub year: Option<i64>,
    pub status: Option<String>,
    pub genres: Option<String>,
    pub overview: Option<String>,
    pub covers: Vec<MangaDexCoverCandidate>,
}
```

Keep MangaDex envelopes and exact snapshot handling internal. Define the fixed API/uploads origins plus limits of 20 search results, 100 covers, 4 MiB JSON, 8 MiB preview, 32 MiB persistent download, and 30 seconds here. Reuse `ureq`; add no dependency or provider trait.

**Step 3: Implement bounded requests and preview media**

Search is explicit and includes `cover_art`, `author`, and `artist`. Detail fetches the current manga and cover list. Construct uploads URLs only from validated IDs/filenames. The protocol preview branch returns bounded image bytes without writing WorkArtwork or widening CSP.

**Step 4: Re-run the same checks and commit**

```powershell
git add app/src-tauri/src/library/mangadex.rs app/src-tauri/src/library/fixtures app/src-tauri/src/library/mod.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/error.rs app/src-tauri/src/media_protocol.rs
git commit -m "Add bounded MangaDex provider client"
```

## Task 4: Implement transactional apply and refresh

**Files:**

- Create: `app/src-tauri/src/library/mangadex_flow.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/collection.rs`
- Modify: `app/src-tauri/src/library/external_binding.rs`
- Modify: `app/src-tauri/src/library/error.rs`

**Step 1: Write focused failing flow tests**

Using parsed provider values plus a temporary real database/filesystem, prove new creation, edited local title, exact snapshot/sync time, existing blank-field fill, preservation of nonblank values, duplicate ownership rejection, selected-cover membership validation, prepared-file cleanup on DB failure, and refresh preservation of title/nonblank fields/artwork.

```powershell
cargo test library::mangadex_flow::tests --manifest-path app/src-tauri/Cargo.toml
```

Expected: fail because orchestration does not exist.

**Step 2: Add tagged contracts**

```rust
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum MangaDexApplyTarget {
    New { name: String },
    Existing { collection_id: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MangaDexApplyRequest {
    pub target: MangaDexApplyTarget,
    pub manga_id: String,
    pub cover_id: String,
}
```

Add `MangaDexConnection { manga_id, last_synced_at }`. Expose only `search_mangadex`, `preview_mangadex`, `apply_mangadex`, `refresh_mangadex`, and `get_mangadex_connection`.

**Step 3: Implement apply ordering**

Fetch current detail, validate cover membership, download/validate/write the cover, then start one SQLite transaction. Create or blank-fill the Collection, reject another owner of the MangaDex ID, upsert ExternalBinding, select WorkArtwork, and commit once. Remove the prepared file on every database failure.

**Step 4: Implement refresh**

Resolve the existing binding and fetch before opening a transaction. Update only the exact snapshot, `last_synced_at`, and still-blank author/year/genres/overview. Never alter title, nonblank fields, or artwork.

**Step 5: Re-run the same test and commit**

```powershell
git add app/src-tauri/src/library/mangadex_flow.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/collection.rs app/src-tauri/src/library/external_binding.rs app/src-tauri/src/library/error.rs
git commit -m "Add MangaDex apply and refresh flow"
```

## Task 5: Publish narrow Tauri and TypeScript Interfaces

**Files:**

- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/assets/mediaUrl.ts`
- Modify: only affected TypeScript fixtures constructing `CollectionSummary` or `LibraryGateway`

**Step 1: Add focused failing contracts**

Add Rust tests for both tagged apply targets and stable error codes. Add a small media URL test for encoded preview and opaque WorkArtwork URLs. Do not add a broad mock layer.

```powershell
cargo test library::models::tests::serializes_mangadex_apply_targets --manifest-path app/src-tauri/Cargo.toml
cargo test commands::tests::maps_mangadex_errors --manifest-path app/src-tauri/Cargo.toml
npm test -- --run app/src/assets/mediaUrl.test.ts
```

**Step 2: Register five commands**

Register `search_mangadex`, `preview_mangadex`, `apply_mangadex`, `refresh_mangadex`, and `get_mangadex_connection`. Map invalid query/identity, unavailable/timeout, rate limit, not found, invalid response, duplicate binding, invalid artwork, and artwork-write failures to stable codes without exposing payloads or paths.

**Step 3: Mirror exact TypeScript shapes**

Add `selectedWorkArtworkId: string | null` to `CollectionSummary`, provider result/preview/cover/connection types, and:

```ts
export type MangaDexApplyTarget =
  | { kind: "new"; name: string }
  | { kind: "existing"; collectionId: string };

export type MangaDexApplyRequest = {
  target: MangaDexApplyTarget;
  mangaId: string;
  coverId: string;
};
```

Extend `LibraryGateway` and `libraryGateway` with only the five operations. Add `mangadexCoverPreviewUrl` and `workArtworkUrl` beside the existing media helpers. Mechanically add `selectedWorkArtworkId: null` to existing fixtures.

**Step 4: Verify public-shape integration and commit**

Re-run the focused checks, then run `npm run typecheck` once because these public interfaces invalidate all TypeScript consumers.

```powershell
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src-tauri/src/library app/src/library app/src/assets/mediaUrl.ts
git diff --cached --name-only
git commit -m "Expose MangaDex flow to the app"
```

Unstage anything unrelated before committing.

## Task 6: Build the shared import dialog and new-Work entry

**Files:**

- Create: `app/src/collections/MangaDexImportDialog.tsx`
- Create: `app/src/collections/MangaDexImportDialog.test.tsx`
- Modify: `app/src/collections/CollectionBrowser.tsx`
- Modify: `app/src/collections/CollectionBrowser.test.tsx`
- Modify: `app/src/shared/ui/Dialog.tsx`
- Modify: `app/src/styles/global.css`

**Step 1: Write one focused dialog test file**

Cover explicit search and retained query on error, result/detail selection, editable proposed title for new targets, fixed collection ID for existing targets, required cover selection, retained state after preview/apply errors, and one `onApplied` on success. Add one browser assertion that the plus menu orders `MangaDex에서 만화 추가` before `직접 입력`.

```powershell
npm test -- --run app/src/collections/MangaDexImportDialog.test.tsx app/src/collections/CollectionBrowser.test.tsx
```

Expected: fail before the UI exists.

**Step 2: Add a restrained common Dialog variant**

Extend the union to `"default" | "wide" | "fullscreen"` and emit `ui-dialog--wide`. Add only the width/layout rules needed for a dense result/detail workspace. Reuse tokens and existing controls; no gradients, card shadows, hover scaling, large headings, decorative motion, or radius over 8px.

**Step 3: Implement one dialog state owner**

```ts
type MangaDexImportTarget =
  | { kind: "new" }
  | { kind: "existing"; collection: CollectionSummary };

type Props = {
  open: boolean;
  target: MangaDexImportTarget;
  onClose: () => void;
  onApplied: (collection: CollectionSummary) => Promise<void> | void;
};
```

Use existing `Dialog`, `TextField`, `Button`, `Skeleton`, and Toast/message patterns. Keep search, result, detail, cover, edited title, apply, and retained errors local. Render only Lakomics preview URLs; React must not call or parse MangaDex.

**Step 4: Add the new-Work menu**

Replace the plus button's direct create action with shared `Menu`. MangaDex is first; manual input still opens the unchanged edit dialog. After apply, close, await `onChanged`, and display the refreshed collection.

**Step 5: Re-run the same component tests and commit**

Do not run a production build for this UI change.

```powershell
git add app/src/collections/MangaDexImportDialog.tsx app/src/collections/MangaDexImportDialog.test.tsx app/src/collections/CollectionBrowser.tsx app/src/collections/CollectionBrowser.test.tsx app/src/shared/ui/Dialog.tsx app/src/styles/global.css
git commit -m "Add MangaDex Work import dialog"
```

## Task 7: Add existing-Work connect/refresh and offline artwork display

**Files:**

- Modify: `app/src/collections/CollectionOverlay.tsx`
- Create or modify: `app/src/collections/CollectionOverlay.test.tsx`
- Modify: `app/src/collections/CollectionBrowser.tsx`
- Modify: `app/src/collections/CollectionBrowser.test.tsx`
- Modify: `app/src/collections/MangaDexImportDialog.tsx`
- Modify: `app/src/styles/global.css`

**Step 1: Add focused failing tests**

Test overlay connect when unbound, reuse of the existing-target dialog, refresh when bound, retained hero/error on refresh failure, local source cover precedence, and WorkArtwork fallback. Extend the browser test for card precedence: WorkArtwork, Cover Asset, source preview, empty.

```powershell
npm test -- --run app/src/collections/CollectionOverlay.test.tsx app/src/collections/CollectionBrowser.test.tsx
```

**Step 2: Implement overlay actions**

Restore `onChanged` in props destructuring. Load `getMangaDexConnection(collectionId)` with cancellation handling. For manga only, show one quiet toolbar action: connect when absent, refresh when present. Refresh owns a pending state, awaits `onChanged`, and preserves the current display on failure. Reuse the import dialog; do not move provider state into `App.tsx`.

**Step 3: Apply image precedence**

```ts
collection.selectedWorkArtworkId
  ? workArtworkUrl(collection.selectedWorkArtworkId)
  : collection.coverAssetId
    ? thumbnailUrl(collection.coverAssetId)
    : collection.sourcePath
      ? collectionSourcePreviewUrl(collection.id)
      : null
```

The overlay continues to prefer its first ordered local `CollectionCover`; use WorkArtwork only after that list loads empty.

**Step 4: Re-run the same tests and commit**

```powershell
git add app/src/collections/CollectionOverlay.tsx app/src/collections/CollectionOverlay.test.tsx app/src/collections/CollectionBrowser.tsx app/src/collections/CollectionBrowser.test.tsx app/src/collections/MangaDexImportDialog.tsx app/src/styles/global.css
git commit -m "Connect and refresh MangaDex Works"
```

## Task 8: Perform one proportional integration check and hand off

**Step 1: Inspect ownership and scope**

```powershell
git status --short
rg -n "api\.mangadex\.org|uploads\.mangadex\.org|provider_data_json|selectedWorkArtworkId|selected_work_artwork_id" app/src app/src-tauri/src
```

Confirm provider hosts/parsing remain Rust-only, WorkArtwork paths are not exposed to TypeScript, and no Volume, Aladin, scheduler, or provider-trait code entered P2.

**Step 2: Run the smallest final cross-boundary checks**

Later integration can invalidate the flow compile and final components, so run:

```powershell
cargo test library::mangadex_flow::tests --manifest-path app/src-tauri/Cargo.toml
npm run typecheck
npm test -- --run app/src/collections/MangaDexImportDialog.test.tsx app/src/collections/CollectionOverlay.test.tsx
```

Do not rerun already-successful lower-level checks unless later edits touched them. Do not run a full suite or production build unless these reveal a concrete broader risk.

**Step 3: Review acceptance criteria**

Check every criterion in the design spec, inspect `git status --short` and `git log --oneline -8`, and make no verification-only commit. If a concrete defect is fixed, rerun only the invalidated check and commit that fix. Report implemented flows, exact evidence, known limits, and whether the branch is ready to push.
