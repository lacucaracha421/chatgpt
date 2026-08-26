# TMDB Movie Provider and Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete TMDB-assisted movie import, manual-movie connection, refresh, artwork selection, and backdrop-dominant movie detail flow without coupling Collection to the Online Catalog.

**Architecture:** Add a TMDB-specific client and `MovieImportFlow` beside the existing IGDB modules. Reuse OS credentials, `ExternalBinding`, `WorkArtwork`, Tauri commands, and the `LibraryGateway` seam; do not introduce a universal provider abstraction. Persist only selected poster/backdrop originals and keep ordinary Collection browsing local-first.

**Tech Stack:** Rust, rusqlite/SQLite migrations, ureq, serde, Windows Credential Manager, Tauri, React 19, TypeScript, Vitest/Testing Library, existing Lakomics CSS tokens.

## Global Constraints

- The provider scope is TMDB movie search only; include live-action and animated feature films, and exclude TV series, TV animation series, seasons, and episodes.
- Prefer Korean (`ko-KR`) metadata, then original-language data, then English (`en-US`).
- Store the API Read Access Token only in the OS-backed credential store and send it only as a Bearer header.
- Never expose the token, provider response bodies, or arbitrary remote URLs to React, SQLite snapshots, or logs.
- Keep Online Catalog completely independent from Collection.
- Use `WorkArtwork(kind='cover')` for the selected poster and `WorkArtwork(kind='backdrop')` for the selected backdrop.
- Download only explicitly selected poster/backdrop originals; neither image is mandatory.
- Refresh preserves user title, description, personal rating, explicit edits/clears, and selected artwork.
- Movie posters remain flat; do not reuse game package motion or manga cover inspection.
- Do not add dependencies unless the existing Rust/React stack cannot satisfy a demonstrated requirement.
- Preserve all pre-existing dirty files and stage only task-owned hunks, especially in `app/src-tauri/src/commands.rs`; do not edit the already-dirty `app/src/library/client.test.ts`.
- Verification defaults to one directly affected test or test group per task. Do not run a full suite without a failing targeted check or concrete cross-module risk.
- Do not rerun a successful check unless a later code edit invalidates its evidence. Run the production build once at the end.

---

### Task 1: Movie presentation fields and backdrop projection

**Files:**
- Create: `app/src-tauri/migrations/0024_movie_provider_detail.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/collection.rs`
- Modify: `app/src-tauri/src/library/work_artwork.rs`
- Modify: `app/src-tauri/src/library/igdb_flow.rs` (mechanical `UpdateCollection` field additions only)
- Modify: `app/src/library/types.ts`
- Modify: `app/src/collections/CollectionEditDialog.tsx` (preserve new fields in update payload; controls arrive in Task 6)
- Modify fixture fields only: `app/src/app/App.test.tsx`
- Modify fixture fields only: `app/src/assets/AssetBrowser.test.tsx`
- Modify fixture fields only: `app/src/assets/AssetInspector.test.tsx`
- Modify fixture fields only: `app/src/assets/AssetToolbar.test.tsx`
- Modify fixture fields only: `app/src/collections/CollectionBrowser.test.tsx`
- Modify fixture fields only: `app/src/collections/CollectionCard.test.tsx`
- Modify fixture fields only: `app/src/collections/CollectionEditDialog.test.tsx`
- Modify fixture fields only: `app/src/collections/collectionLibrary.test.ts`
- Modify fixture fields only: `app/src/collections/CollectionOverlay.test.tsx`
- Modify fixture fields only: `app/src/collections/GameCollectionDetail.test.tsx`

**Interfaces:**
- Consumes: the v23 Collection schema and selected-per-kind WorkArtwork constraint.
- Produces: `CollectionSummary.original_title: Option<String>`, `runtime_minutes: Option<i64>`, `selected_backdrop_artwork_id: Option<String>` and matching TypeScript `originalTitle`, `runtimeMinutes`, `selectedBackdropArtworkId` fields.
- Produces: `WorkArtworkKind::Backdrop` whose stored value is exactly `backdrop`.

- [ ] **Step 1: Write the v23-to-v24 migration test**

Add `db::tests::migrates_v23_to_v24_movie_provider_detail` that builds schema through v23, inserts one movie, migrates from version 23, and asserts:

```rust
let fields: (Option<String>, Option<i64>) = connection.query_row(
    "SELECT original_title, runtime_minutes FROM collections WHERE id = 'movie-1'",
    [],
    |row| Ok((row.get(0)?, row.get(1)?)),
).unwrap();
assert_eq!(fields, (None, None));
assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 24);
```

- [ ] **Step 2: Run the exact migration test and verify failure**

```powershell
cd app/src-tauri
cargo test library::db::tests::migrates_v23_to_v24_movie_provider_detail -- --exact
```

Expected: failure because schema v24 and the two columns do not exist.

- [ ] **Step 3: Add schema v24 and typed summary fields**

Create the migration with exact constraints:

```sql
ALTER TABLE collections ADD COLUMN original_title TEXT;
ALTER TABLE collections ADD COLUMN runtime_minutes INTEGER
    CHECK (runtime_minutes IS NULL OR runtime_minutes > 0);
PRAGMA user_version = 24;
```

Set `SCHEMA_VERSION` to 24, include `0024_movie_provider_detail.sql`, and execute it for `version <= 23`.

Extend `CollectionSummary` and `UpdateCollection` with the new movie fields. Extend `COLLECTION_SUMMARY_SQL` with a selected `backdrop` WorkArtwork subquery immediately after the selected hero projection, then update `collection_from_row` indices once. Update create/update SQL so manual edits can preserve or write `original_title` and `runtime_minutes`; reject a non-positive runtime as `InvalidMovieRuntime`.

Add the enum arm:

```rust
pub(crate) enum WorkArtworkKind { Cover, Hero, Backdrop }

Self::Backdrop => "backdrop",
```

Mirror the summary/update fields in `app/src/library/types.ts`:

```ts
originalTitle: string | null;
runtimeMinutes: number | null;
selectedBackdropArtworkId: string | null;
```

Add `originalTitle: null`, `runtimeMinutes: null`, and `selectedBackdropArtworkId: null` to existing typed Collection fixtures. Add `original_title: None` and `runtime_minutes: None` to every pre-existing Rust `UpdateCollection` literal in `collection.rs`, `models.rs`, and `igdb_flow.rs`; these are mechanical compile-preservation edits, not behavior changes.

Until Task 6 adds editable controls, make `CollectionEditDialog` submit `existing?.originalTitle ?? null` and `existing?.runtimeMinutes ?? null`. This prevents an unrelated edit from erasing provider values and keeps the required `UpdateCollection` contract compile-complete.

- [ ] **Step 4: Run only the exact migration test**

Run the Step 2 command again. Expected: PASS. Do not run the broader database or Collection test modules.

- [ ] **Step 5: Commit the data slice**

```powershell
git add app/src-tauri/migrations/0024_movie_provider_detail.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/collection.rs app/src-tauri/src/library/work_artwork.rs app/src-tauri/src/library/igdb_flow.rs app/src/library/types.ts app/src/collections/CollectionEditDialog.tsx app/src/app/App.test.tsx app/src/assets/AssetBrowser.test.tsx app/src/assets/AssetInspector.test.tsx app/src/assets/AssetToolbar.test.tsx app/src/collections/CollectionBrowser.test.tsx app/src/collections/CollectionCard.test.tsx app/src/collections/CollectionEditDialog.test.tsx app/src/collections/collectionLibrary.test.ts app/src/collections/CollectionOverlay.test.tsx app/src/collections/GameCollectionDetail.test.tsx
git diff --cached --check
git commit -m "feat: add movie presentation metadata"
```

### Task 2: TMDB credential storage and protocol client

**Files:**
- Create: `app/src-tauri/src/library/tmdb.rs`
- Modify: `app/src-tauri/src/library/credential.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/mod.rs`

**Interfaces:**
- Produces: `TmdbCredentialStatus { configured: bool }` and redacted `TmdbCredentials { read_access_token: String }`.
- Produces: `TmdbImageRef`, `TmdbRemoteMovie`, `TmdbSearchResult`, `TmdbMoviePreview`, `TmdbImageCandidate`, `TmdbConnection`, `TmdbApplyTarget`, `TmdbApplyRequest`, `TmdbArtworkDecision`, and `TmdbArtworkReplaceRequest`.
- Produces: `TmdbClient::search(&TmdbCredentials, &str)`, `movie(&TmdbCredentials, i64)`, `download_original(&str)`, and `image_url(&str, TmdbImageSize)`.

- [ ] **Step 1: Write one focused normalization/security test**

Add `tmdb::tests::normalizes_movie_score_and_redacts_token`. Feed the parser a fixed Korean detail response containing `vote_average: 8.73`, `vote_count: 120`, one director, two production companies, poster/backdrop paths, and runtime 81. Assert:

```rust
assert_eq!(movie.external_score, Some(87));
assert_eq!(movie.runtime_minutes, Some(81));
assert_eq!(movie.directors, vec!["곤 사토시"]);
assert_eq!(movie.production_companies, vec!["매드하우스", "Rex Entertainment"]);
assert!(!format!("{:?}", credentials).contains("secret-token"));
```

- [ ] **Step 2: Run the exact client test and verify failure**

```powershell
cd app/src-tauri
cargo test library::tmdb::tests::normalizes_movie_score_and_redacts_token -- --exact
```

Expected: failure because the TMDB module and DTOs do not exist.

- [ ] **Step 3: Add write-only TMDB credential functions**

Use the exact target `Lakomics/Tmdb`. Add OS and test-backend functions equivalent to the established IGDB credential lifecycle:

```rust
pub(crate) fn tmdb_credential_status() -> Result<TmdbCredentialStatus, LibraryError>;
pub(crate) fn set_tmdb_token_os(token: &str) -> Result<TmdbCredentialStatus, LibraryError>;
pub(crate) fn delete_tmdb_token_os() -> Result<TmdbCredentialStatus, LibraryError>;
pub(crate) fn read_tmdb_token_os() -> Result<TmdbCredentials, LibraryError>;
```

Trim before storing and after reading. Reject empty tokens as `InvalidTmdbCredentialValue`. Implement custom `Debug` for `TmdbCredentials` that prints `[redacted]` only.

- [ ] **Step 4: Implement the minimal TMDB client**

Use the existing `ureq` dependency with HTTPS-only requests, zero redirects, a 20-second global timeout, a 4 MiB JSON ceiling, and `MAX_WORK_ARTWORK_BYTES` for images.

Use only these endpoints:

```text
GET https://api.themoviedb.org/3/search/movie
GET https://api.themoviedb.org/3/movie/{movie_id}?append_to_response=credits,images
GET https://image.tmdb.org/t/p/{size}{validated_file_path}
```

Search with `language=ko-KR`, `include_adult=false`, and an encoded query. Fetch Korean detail first; make one English detail request only when localized title or overview is blank. Preserve `original_title` from TMDB. Pass `include_image_language=ko,null,en` for images.

Validate movie IDs as positive integers and image paths with a closed rule: one leading `/`, basename characters `[A-Za-z0-9_-]`, and extension `.jpg`, `.jpeg`, `.png`, or `.webp`; reject decoded separators, `..`, query strings, fragments, and schemes.

Map status/network failures to provider-specific variants:

```rust
TmdbCredentialNotConfigured
InvalidTmdbCredentialValue
TmdbUnauthorized
TmdbRateLimited
TmdbTimedOut
TmdbUnavailable
TmdbNotFound
TmdbInvalidResponse
TmdbInvalidImagePath
InvalidTmdbIdentity
```

Do not add a speculative rate scheduler. Honor HTTP 429 as `TmdbRateLimited`; add scheduling only if real use or official limits require it.

- [ ] **Step 5: Run only the focused TMDB client module**

```powershell
cd app/src-tauri
cargo test library::tmdb::tests -- --nocapture
```

Expected: the normalization, URL validation, timeout mapping, and credential redaction checks inside this new module pass. Do not run unrelated credential or IGDB tests.

- [ ] **Step 6: Commit the client slice**

```powershell
git add app/src-tauri/src/library/tmdb.rs app/src-tauri/src/library/credential.rs app/src-tauri/src/library/error.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/mod.rs
git diff --cached --check
git commit -m "feat: add TMDB credentials and client"
```

### Task 3: Atomic movie import, manual connection, refresh, and artwork replacement

**Files:**
- Create: `app/src-tauri/src/library/tmdb_flow.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/work_artwork.rs`
- Modify: `app/src-tauri/src/library/external_binding.rs`
- Modify: `app/src-tauri/src/library/collection.rs`

**Interfaces:**
- Consumes: `TmdbClient`, `WorkArtworkKind::{Cover, Backdrop}`, prepared-file guards, and provider `tmdb` external bindings.
- Produces: `Library::search_tmdb_movies`, `preview_tmdb_movie`, `apply_tmdb_movie`, `refresh_tmdb_movie`, `get_tmdb_connection`, and `replace_tmdb_movie_artwork`.
- Produces internal deterministic seams `apply_fetched_tmdb_movie`, `refresh_fetched_tmdb_movie`, and `replace_fetched_tmdb_movie_artwork` for non-live tests.

- [ ] **Step 1: Write one focused flow test group**

Create in-module tests using a temporary Library and generated image bytes. The group must cover these realistic mutation boundaries without creating separate integration fixtures:

```rust
assert_eq!(created.collection_type, CollectionType::Movie);
assert_eq!(created.original_title.as_deref(), Some("Perfect Blue"));
assert_eq!(created.director.as_deref(), Some("곤 사토시"));
assert_eq!(created.production_company.as_deref(), Some("매드하우스 · Rex Entertainment"));
assert_eq!(created.runtime_minutes, Some(81));
assert!(created.selected_work_artwork_id.is_some());
assert!(created.selected_backdrop_artwork_id.is_some());
assert_eq!(binding.movie_id, 10494);
```

Within the same module, add cases proving: both images optional; an image path outside the fresh preview is rejected before file preparation; duplicate TMDB identity is rejected; connecting an existing manual movie preserves title/description/personal rating while filling blank provider fields; refresh updates only fields still equal to the previous snapshot and preserves an explicit clear; refresh never writes artwork; clearing backdrop leaves poster selected; a failed transaction removes newly prepared files; post-commit cleanup failure does not turn success into an error.

- [ ] **Step 2: Run one representative exact test and verify failure**

```powershell
cd app/src-tauri
cargo test library::tmdb_flow::tests::imports_movie_binding_poster_and_backdrop_atomically -- --exact
```

Expected: failure because `MovieImportFlow` does not exist.

- [ ] **Step 3: Define request and preview DTOs exactly**

Use these shapes:

```rust
pub enum TmdbApplyTarget {
    New,
    Existing { collection_id: String },
}

pub struct TmdbApplyRequest {
    pub target: TmdbApplyTarget,
    pub movie_id: i64,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
}

pub enum TmdbArtworkDecision {
    Keep,
    Clear,
    Select { file_path: String },
}

pub struct TmdbArtworkReplaceRequest {
    pub collection_id: String,
    pub poster: TmdbArtworkDecision,
    pub backdrop: TmdbArtworkDecision,
}
```

Apply `#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]` to both enums and `#[serde(rename_all = "camelCase")]` to public request/response structs so their wire representation matches the TypeScript discriminated unions exactly.

Preview DTOs keep poster/backdrop arrays separate. The provider snapshot contains normalized metadata plus image identities required for later refresh/reselection, but no credentials or image bytes.

- [ ] **Step 4: Implement new import and existing-movie connection atomically**

For `New`, derive the Collection title from the normalized preview. For `Existing`, require `CollectionType::Movie`, no existing TMDB binding, and preserve explicit title, description, and personal rating. Fill only blank movie provider fields during the initial connection.

For both targets: validate identity and candidate membership, prepare selected files, open one transaction, write Collection fields, insert the `tmdb` binding, insert selected `cover`/`backdrop` WorkArtwork, commit, then disarm prepared-file guards. Use the TMDB file path itself as `provider_image_id`.

- [ ] **Step 5: Implement snapshot-aware refresh and independent artwork decisions**

Parse the prior normalized snapshot. A provider field may change only when the current value equals the prior provider value, or when both current and prior provider values are blank. Treat a current blank with a nonblank prior provider value as an explicit user clear and preserve it.

Refresh eligible fields are `original_title`, `director`, `production_company`, `release_date`, `runtime_minutes`, `genres`, `overview`, and `external_score`. Never update `name`, `description`, `my_score`, poster, or backdrop during refresh.

Artwork replacement refetches the movie, validates each `Select`, performs no write for `Keep`, clears only the selected kind for `Clear`, and commits both decisions together. Query the final summary before commit; obsolete-file deletion after commit is best-effort.

- [ ] **Step 6: Run only the focused flow module**

```powershell
cd app/src-tauri
cargo test library::tmdb_flow::tests -- --nocapture
```

Expected: all tests inside only `library::tmdb_flow::tests` pass. Do not run other library modules.

- [ ] **Step 7: Commit the orchestration slice**

```powershell
git add app/src-tauri/src/library/tmdb_flow.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/work_artwork.rs app/src-tauri/src/library/external_binding.rs app/src-tauri/src/library/collection.rs
git diff --cached --check
git commit -m "feat: add atomic TMDB movie flow"
```

### Task 4: Tauri commands, media preview, and frontend gateway

**Files:**
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/media_protocol.rs`
- Modify owned hunks only: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/assets/mediaUrl.ts`
- Modify gateway stubs only: `app/src/app/App.test.tsx`
- Modify gateway stubs only: `app/src/assets/AssetBrowser.test.tsx`
- Modify gateway stubs only: `app/src/assets/AssetInspector.test.tsx`
- Modify gateway stubs only: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify gateway stubs only: `app/src/collections/CollectionBrowser.test.tsx`
- Modify gateway stubs only: `app/src/library/LibraryContext.test.tsx`
- Modify gateway stubs only: `app/src/library/LibrarySetup.test.tsx`
- Modify gateway stubs only: `app/src/manga/MangaBrowser.test.tsx`
- Modify gateway stubs only: `app/src/manga/OnlineCatalogBrowser.test.tsx`
- Modify gateway stubs only: `app/src/safety/TrashBrowser.test.tsx`
- Modify gateway stubs only: `app/src/settings/SettingsView.test.tsx`
- Modify gateway stubs only: `app/src/similarity/SimilarityReviewBrowser.test.tsx`

**Interfaces:**
- Produces Tauri commands: `get_tmdb_credential_status`, `set_tmdb_token`, `delete_tmdb_token`, `search_tmdb_movies`, `preview_tmdb_movie`, `apply_tmdb_movie`, `refresh_tmdb_movie`, `get_tmdb_connection`, and `replace_tmdb_movie_artwork`.
- Produces matching required `LibraryGateway` methods.
- Produces `tmdbImagePreviewUrl(filePath, size)` for only `poster | backdrop`.

- [ ] **Step 1: Write one media-route/public-error test pair**

Extend the existing media protocol test with valid poster/backdrop routes and rejection of encoded traversal:

```rust
let (variant, path) = parse_media_path("/tmdb-image-preview/poster/%2Fabcd1234.jpg").unwrap();
assert!(matches!(variant, MediaVariant::TmdbImagePreviewPoster));
assert_eq!(path.as_deref(), Some("/abcd1234.jpg"));
assert!(parse_media_path("/tmdb-image-preview/backdrop/..%2Fsecret.jpg").is_err());
```

Extend the existing public-error mapping test table with every TMDB error code and assert messages contain neither `api.themoviedb.org` nor a token-shaped sentinel.

- [ ] **Step 2: Run only the two directly affected exact tests and verify failure**

```powershell
cd app/src-tauri
cargo test media_protocol::tests::parses_tmdb_image_preview_routes -- --exact
cargo test commands::tests::maps_tmdb_errors_without_secret_details -- --exact
```

Expected: both fail because variants and mappings are absent.

- [ ] **Step 3: Add the safe media-preview route**

Add `MediaVariant::TmdbImagePreviewPoster` and `TmdbImagePreviewBackdrop`. Decode exactly one file-path segment, validate it through `TmdbClient::image_url`, and proxy fixed sizes (`w500` poster and `w1280` backdrop) through the existing bounded response path. Never accept a full URL.

- [ ] **Step 4: Add narrow commands and TypeScript invokes**

Mirror Rust DTO casing into these TypeScript types:

```ts
export type TmdbApplyTarget = { kind: "new" } | { kind: "existing"; collectionId: string };
export type TmdbArtworkDecision =
  | { kind: "keep" }
  | { kind: "clear" }
  | { kind: "select"; filePath: string };
```

Add these required gateway signatures:

```ts
getTmdbCredentialStatus(): Promise<TmdbCredentialStatus>;
setTmdbToken(token: string): Promise<TmdbCredentialStatus>;
deleteTmdbToken(): Promise<TmdbCredentialStatus>;
searchTmdbMovies(query: string): Promise<TmdbSearchResult[]>;
previewTmdbMovie(movieId: number): Promise<TmdbMoviePreview>;
applyTmdbMovie(request: TmdbApplyRequest): Promise<CollectionSummary>;
refreshTmdbMovie(collectionId: string): Promise<CollectionSummary>;
getTmdbConnection(collectionId: string): Promise<TmdbConnection | null>;
replaceTmdbMovieArtwork(request: TmdbArtworkReplaceRequest): Promise<CollectionSummary>;
```

Register all commands in `lib.rs`. Keep blocking network/disk work inside `spawn_blocking`, matching the IGDB command pattern.

Because every gateway method is required, add nine no-op `vi.fn()` TMDB methods to each existing typed `LibraryGateway` test stub listed in this task. Do not refactor those tests or run them; `npx tsc --noEmit` is the single proof that every required mock remains structurally complete.

- [ ] **Step 5: Run the same two exact tests and one type check**

```powershell
cd app/src-tauri
cargo test media_protocol::tests::parses_tmdb_image_preview_routes -- --exact
cargo test commands::tests::maps_tmdb_errors_without_secret_details -- --exact
cd ..
npx tsc --noEmit
```

Expected: both Rust tests and TypeScript type checking pass. Do not add or run `client.test.ts` because it is pre-existing dirty work and compile checking proves the invoke contract.

- [ ] **Step 6: Stage only owned command hunks and commit**

```powershell
git add app/src-tauri/src/library/mod.rs app/src-tauri/src/media_protocol.rs app/src-tauri/src/lib.rs app/src/library/types.ts app/src/library/client.ts app/src/assets/mediaUrl.ts app/src/app/App.test.tsx app/src/assets/AssetBrowser.test.tsx app/src/assets/AssetInspector.test.tsx app/src/classification/ClassificationSidebar.test.tsx app/src/collections/CollectionBrowser.test.tsx app/src/library/LibraryContext.test.tsx app/src/library/LibrarySetup.test.tsx app/src/manga/MangaBrowser.test.tsx app/src/manga/OnlineCatalogBrowser.test.tsx app/src/safety/TrashBrowser.test.tsx app/src/settings/SettingsView.test.tsx app/src/similarity/SimilarityReviewBrowser.test.tsx
git add -p -- app/src-tauri/src/commands.rs
git diff --cached --check
git commit -m "feat: expose TMDB library commands"
```

At interactive staging, accept only TMDB imports, commands, public-error mappings, and their targeted test. Reject every unrelated pre-existing `commands.rs` hunk.

### Task 5: TMDB settings and two-stage movie dialog

**Files:**
- Create: `app/src/collections/TmdbMovieDialog.tsx`
- Create: `app/src/collections/TmdbMovieDialog.test.tsx`
- Modify: `app/src/settings/SettingsView.tsx`
- Modify: `app/src/settings/SettingsView.test.tsx`
- Modify: `app/src/collections/CollectionBrowser.tsx`
- Modify: `app/src/collections/CollectionBrowser.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: TMDB credential/search/preview/apply methods from Task 4.
- Produces: `TmdbMovieDialog({ open, target, onClose, onOpenSettings, onApplied })` where target is `{ kind: "new" } | { kind: "existing"; collectionId: string }`.
- Produces movie add choices `TMDB에서 영화 추가` and `직접 입력` without changing game or manga routes.

- [ ] **Step 1: Write the directly affected UI tests**

In Settings, assert configured status is boolean-only, the token input starts blank, save sends a trimmed token and clears the input, and delete requires confirmation.

In `TmdbMovieDialog.test.tsx`, cover one complete path: search, choose a localized result with a distinct original title, advance, explicitly choose one poster, choose no backdrop, and apply. Assert the request is exactly:

```ts
{
  target: { kind: "new" },
  movieId: 10494,
  posterPath: "/poster.jpg",
  backdropPath: null,
}
```

Also assert neither first candidate is preselected, missing poster/backdrop groups do not block apply, Back preserves search/results, retry ignores stale completion, and existing target uses `{ kind: "existing", collectionId }`.

In `CollectionBrowser.test.tsx`, assert movie add offers TMDB and manual entry and successful import opens/selects the created movie.

- [ ] **Step 2: Run only the three affected frontend files and verify failure**

```powershell
cd app
npm test -- --run src/settings/SettingsView.test.tsx src/collections/TmdbMovieDialog.test.tsx src/collections/CollectionBrowser.test.tsx
```

Expected: failure for missing credential controls, dialog, and movie add route.

- [ ] **Step 3: Add write-only token settings**

In `external_services`, add configured/unconfigured status, one `type="password"` API Read Access Token field, Save, and confirmed Delete. Never populate the stored token. Add a brief link label directing the user to TMDB API settings without embedding credentials.

- [ ] **Step 4: Implement the two-stage dialog as one discriminated state**

Use:

```ts
type TmdbMovieStep =
  | { kind: "search"; query: string; selectedMovieId: number | null }
  | {
      kind: "preview";
      preview: TmdbMoviePreview;
      posterPath: string | null;
      posterDecided: boolean;
      backdropPath: string | null;
      backdropDecided: boolean;
    };
```

Do not preselect images. Empty candidate arrays make that role implicitly decided. Explicit no-image controls set the path to null and the decision flag true. Close immediately after gateway mutation success; run `onApplied` afterward so callback failure cannot misreport a completed backend mutation. Use a generation counter or `AbortController`-equivalent state guard so stale retries cannot replace newer results.

- [ ] **Step 5: Route movie add and settings deep-link**

Open `TmdbMovieDialog` for `TMDB에서 영화 추가` and the existing edit dialog for `직접 입력`. Missing-credential errors expose an action that opens Settings `external_services`; never display backend response bodies.

- [ ] **Step 6: Run only the same frontend group**

Run the Step 2 command again. Expected: all three files pass. Do not run the full frontend suite.

- [ ] **Step 7: Commit the settings/import UI**

```powershell
git add app/src/collections/TmdbMovieDialog.tsx app/src/collections/TmdbMovieDialog.test.tsx app/src/settings/SettingsView.tsx app/src/settings/SettingsView.test.tsx app/src/collections/CollectionBrowser.tsx app/src/collections/CollectionBrowser.test.tsx app/src/styles/global.css
git diff --cached --check
git commit -m "feat: add TMDB movie import interface"
```

### Task 6: Backdrop-dominant movie detail and provider actions

**Files:**
- Create: `app/src/collections/MovieCollectionDetail.tsx`
- Create: `app/src/collections/MovieCollectionDetail.test.tsx`
- Modify: `app/src/collections/TmdbMovieDialog.tsx`
- Modify: `app/src/collections/TmdbMovieDialog.test.tsx`
- Modify: `app/src/collections/CollectionEditDialog.tsx`
- Modify: `app/src/collections/CollectionEditDialog.test.tsx`
- Modify: `app/src/collections/CollectionOverlay.tsx`
- Modify: `app/src/collections/CollectionOverlay.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: movie summary fields, local poster/backdrop URLs, TMDB connection, refresh, connection dialog, and artwork replacement.
- Produces: `MovieCollectionDetail({ collection, posterUrl, backdropUrl, providerConnected, providerBusy, providerError, onEdit, onToggleShowcase, onDelete, onConnectProvider, onRefreshProvider, onChangeArtwork })`.
- Extends `TmdbMovieDialog` target with `{ kind: "artwork"; collectionId: string }`; artwork mode loads the bound movie preview and submits `TmdbArtworkReplaceRequest` with independent `keep | clear | select` decisions.
- Keeps provider orchestration in `CollectionOverlay`; the presentation component has no TMDB protocol logic.

- [ ] **Step 1: Write movie semantics and overlay orchestration tests**

Assert `MovieCollectionDetail` renders one labelled dominant backdrop region, does not reuse `posterUrl` when `backdropUrl` is null, keeps the poster flat, and conditionally renders localized title, distinct original title, release date, formatted runtime (`81분`), director, production company, genres, TMDB score, personal rating, and overview.

Assert the visible `작품 관리` menu shows `TMDB에 연결` for an unconnected movie and disables refresh/artwork replacement. For a connected movie, assert refresh and artwork replacement are enabled and Connect is absent. Refresh failure must retain the existing poster, backdrop, and detail.

Add one edit-dialog assertion that a movie can edit `originalTitle` and a positive `runtimeMinutes`, while zero or negative runtime cannot be submitted.

Extend `TmdbMovieDialog.test.tsx` with one artwork-mode assertion: initial decisions are `keep`, selecting a new poster changes only poster to `select`, choosing no backdrop changes backdrop to `clear`, and the dialog calls `replaceTmdbMovieArtwork` without calling `applyTmdbMovie`.

- [ ] **Step 2: Run only the three affected detail files and verify failure**

```powershell
cd app
npm test -- --run src/collections/TmdbMovieDialog.test.tsx src/collections/MovieCollectionDetail.test.tsx src/collections/CollectionOverlay.test.tsx src/collections/CollectionEditDialog.test.tsx
```

Expected: failure because movie-specific detail and TMDB actions do not exist.

- [ ] **Step 3: Implement the approved layout A presentation**

Render a wide backdrop with one readability scrim. Anchor the poster and compact identity block near its lower edge; continue genres, scores, and overview in the body. Missing backdrop uses a neutral token surface with no poster-derived background. Missing poster uses a fixed-geometry placeholder. Do not add package frames, tilt, glare, glass cards, cast rails, trailer controls, or decorative statistics.

- [ ] **Step 4: Add movie edit fields and overlay orchestration**

Expose original title and runtime only in movie edit mode. Normalize blank original title to null and parse runtime to a positive integer or null.

In `CollectionOverlay`, render the local movie immediately, then load `getTmdbConnection` independently. Wire:

```text
unconnected → TmdbMovieDialog target existing
connected refresh → refreshTmdbMovie → onChanged
connected artwork change → TmdbMovieDialog target artwork
```

Extend the dialog target union exactly to:

```ts
type TmdbMovieDialogTarget =
  | { kind: "new" }
  | { kind: "existing"; collectionId: string }
  | { kind: "artwork"; collectionId: string };
```

Artwork mode skips search, loads `getTmdbConnection` and `previewTmdbMovie`, initializes poster/backdrop decisions to `keep`, and submits `replaceTmdbMovieArtwork`. Close the dialog immediately after mutation, then refresh connection/list state best-effort.

- [ ] **Step 5: Add restrained token-based styling**

Use existing surface, border, text, radius, and spacing tokens. Keep transitions within the established short motion range and disable nonessential backdrop transitions under `prefers-reduced-motion`. This is visual-only work; do not add a test solely for CSS declarations.

- [ ] **Step 6: Run only the same three-file frontend group**

Run the Step 2 command again. Expected: all three files pass. Do not run the full frontend suite or production build.

- [ ] **Step 7: Commit the movie detail slice**

```powershell
git add app/src/collections/MovieCollectionDetail.tsx app/src/collections/MovieCollectionDetail.test.tsx app/src/collections/TmdbMovieDialog.tsx app/src/collections/TmdbMovieDialog.test.tsx app/src/collections/CollectionEditDialog.tsx app/src/collections/CollectionEditDialog.test.tsx app/src/collections/CollectionOverlay.tsx app/src/collections/CollectionOverlay.test.tsx app/src/styles/global.css
git diff --cached --check
git commit -m "feat: add TMDB movie detail"
```

### Task 7: Final targeted verification and handoff

**Files:**
- Modify only files required to fix a failure from the commands below.
- Never stage or rewrite unrelated dirty paths.

**Interfaces:**
- Consumes: all six committed slices.
- Produces: a buildable, locally browsable TMDB movie vertical slice with explicit evidence and no live-provider claims unless a user token was actually exercised.

- [ ] **Step 1: Inspect commit and dirty-file boundaries**

```powershell
git log -8 --oneline
git status --short
git diff --check 17de109..HEAD
git diff -- app/src-tauri/src/commands.rs app/src/library/client.test.ts
```

Expected: six implementation commits follow `17de109`; only owned command hunks are committed; all recorded pre-existing dirty paths remain unstaged.

- [ ] **Step 2: Run one backend feature filter**

```powershell
cd app/src-tauri
cargo test library::tmdb_flow::tests -- --nocapture
```

Expected: import, manual connection, refresh preservation, artwork isolation, and cleanup cases pass. Do not rerun TMDB client/media exact tests unless later edits changed those modules.

- [ ] **Step 3: Run one frontend feature group**

```powershell
cd app
npm test -- --run src/collections/TmdbMovieDialog.test.tsx src/collections/MovieCollectionDetail.test.tsx src/collections/CollectionOverlay.test.tsx
```

Expected: two-stage import, connection/actions, local-first detail, and failure preservation pass. Do not run Settings/Browser/Edit tests again unless later edits changed those files.

- [ ] **Step 4: Run the production build once**

```powershell
cd app
npm run build
```

Expected: TypeScript and Vite production build complete successfully. Do not run another build unless a subsequent code edit invalidates it.

- [ ] **Step 5: Fix only invalidated evidence**

If a targeted check fails, change only the owning file, rerun only that failed check, stage only owned hunks, and create one scoped fix commit:

```powershell
git add -p -- app/src-tauri/src/library/tmdb.rs app/src-tauri/src/library/tmdb_flow.rs app/src-tauri/src/library/work_artwork.rs app/src-tauri/src/media_protocol.rs app/src-tauri/src/commands.rs app/src/library/types.ts app/src/library/client.ts app/src/collections/TmdbMovieDialog.tsx app/src/collections/MovieCollectionDetail.tsx app/src/collections/CollectionOverlay.tsx app/src/styles/global.css
git diff --cached --check
git commit -m "fix: stabilize TMDB movie flow"
```

Do not create an empty verification commit.

- [ ] **Step 6: Report the handoff**

Report implementation and fix commit hashes, exact targeted checks/build run, unchanged pre-existing dirty paths, and whether a live TMDB search/import/refresh was exercised with the user's configured token. If no token was exercised, state that live credential/provider success remains a manual verification item.
