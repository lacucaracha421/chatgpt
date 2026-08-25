# IGDB Game Provider and Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complete IGDB-assisted game import, refresh, artwork-selection, and hero-dominant game detail flow without coupling Collection to the Online Catalog or Asset Library.

**Architecture:** A narrow `IgdbClient` owns Twitch token reuse and IGDB protocol details, while `GameImportFlow` owns normalization, selected-image preparation, and one atomic Collection transaction. The existing Collection, ExternalBinding, WorkArtwork, media protocol, credential store, and `LibraryGateway` remain the public seams; React receives normalized DTOs and never constructs provider requests or image URLs.

**Tech Stack:** Rust, Tauri, SQLite/rusqlite, ureq, serde/serde_json, React, TypeScript, Vitest, Testing Library, CSS design tokens.

## Global Constraints

- Read `DESIGN.md`, `docs/agents/lakomics-works-handoff-v2.md`, and `docs/prototypes/lakomics-works-v6-reference.html` before implementation; reproduce the visual intent through existing React structure and tokens rather than copying prototype code.
- Treat `docs/superpowers/specs/2026-08-25-game-provider-detail-design.md` as the approved product contract.
- IGDB is the only game provider in this pass; do not add a universal provider abstraction, SteamGridDB, RAWG, background refresh, launcher integration, or a gallery.
- Store Twitch Client ID and Client Secret only in the OS-backed credential store; never write them or the access token to SQLite, snapshots, logs, public errors, or frontend state returned by a read operation.
- Keep the access token in memory and refresh it when absent or expired; send IGDB requests sequentially within the documented four-requests-per-second ceiling.
- Display all IGDB platforms and use the earliest official release date.
- Require explicit cover selection when cover candidates exist; never preselect cover or hero. Allow import without cover and allow `hero 없이 가져오기` in all cases.
- Offer artworks as hero candidates; offer screenshots only when the artwork list is empty.
- Persist only selected cover/hero originals as WorkArtwork; never create Asset Library Assets for provider artwork and never retain unselected originals.
- Represent selected cover and selected hero solely through `collection_work_artworks(kind, selected)`; do not add duplicate artwork-selection foreign keys to `collections`.
- Manual refresh may update the binding snapshot and fill blank provider fields, but must preserve user-owned values, `my_score`, selected cover, and selected hero.
- Keep the stable top toolbar limited to navigation/close; expose provider and item actions in the visible `작품 관리` menu.
- Preserve all pre-existing dirty work. In particular, stage only owned IGDB hunks from `app/src-tauri/src/commands.rs`; do not stage unrelated changes in that file or `app/src/library/client.test.ts`.
- Use no new dependency unless the existing standard library, ureq, serde, SQLite, and CSS cannot implement a required behavior.
- During iteration run only the directly affected test or smallest Rust filter. Run `npm run build` once after the last code change and broaden verification only if a targeted failure proves a cross-module risk.

## File Structure

### New files

- `app/src-tauri/migrations/0023_game_provider_detail.sql`: adds nullable game metadata columns only.
- `app/src-tauri/src/library/igdb.rs`: credential DTO decoding, token cache, Apicalypse requests, provider response parsing, image identity validation, and normalized remote records.
- `app/src-tauri/src/library/igdb_flow.rs`: game search/preview/apply/refresh/reselection orchestration and transaction/file cleanup.
- `app/src/collections/IgdbImportDialog.tsx`: the three-stage search, cover, and hero flow for new and existing games.
- `app/src/collections/IgdbImportDialog.test.tsx`: focused progressive-flow and explicit-selection coverage.
- `app/src/collections/GameCollectionDetail.tsx`: hero/package/metadata presentation and its local lift/tilt interaction.
- `app/src/collections/GameCollectionDetail.test.tsx`: focused semantic, keyboard, and management-menu coverage.

### Modified files

- `app/src-tauri/src/library/db.rs`: migration registration and schema-version compatibility test.
- `app/src-tauri/src/library/models.rs`: game summary, IGDB request/result, connection, and artwork-kind DTOs.
- `app/src-tauri/src/library/collection.rs`: publisher/platform persistence and selected-hero projection.
- `app/src-tauri/src/library/work_artwork.rs`: kind-aware selected WorkArtwork operation shared by cover and hero.
- `app/src-tauri/src/library/credential.rs`: target-aware credential service plus IGDB JSON secret storage.
- `app/src-tauri/src/library/error.rs`: stable IGDB-facing library errors.
- `app/src-tauri/src/library/mod.rs`: IGDB modules, in-memory token cache, and preview media variant.
- `app/src-tauri/src/media_protocol.rs`: validated IGDB CDN preview routing.
- `app/src-tauri/src/commands.rs`: narrow IGDB Tauri commands and public error mapping; stage owned hunks only.
- `app/src-tauri/src/lib.rs`: IGDB command registration.
- `app/src/library/types.ts`: frontend DTOs and `LibraryGateway` methods.
- `app/src/library/client.ts`: typed Tauri invokes; do not modify the already-dirty client test unless a real wiring regression requires it.
- `app/src/assets/mediaUrl.ts`: backend-owned IGDB preview media URL helper.
- `app/src/settings/SettingsView.tsx`: write-only Client ID/Secret settings controls.
- `app/src/settings/SettingsView.test.tsx`: credential status/save/delete behavior.
- `app/src/collections/CollectionBrowser.tsx`: game add-menu routing.
- `app/src/collections/CollectionBrowser.test.tsx`: IGDB/direct-input menu behavior.
- `app/src/collections/CollectionEditDialog.tsx`: editable publisher/platform/release-date fields without erasing provider data.
- `app/src/collections/CollectionEditDialog.test.tsx`: game metadata edit payload.
- `app/src/collections/CollectionOverlay.tsx`: game-specific detail orchestration, connection, refresh, and reselection.
- `app/src/collections/CollectionOverlay.test.tsx`: provider management action and failure-preservation coverage.
- `app/src/styles/global.css`: dialog candidate states, hero surface, neutral fallback, package treatment, and reduced-motion contract.

---

### Task 1: Game metadata schema and selected-hero projection

**Files:**
- Create: `app/src-tauri/migrations/0023_game_provider_detail.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/collection.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/collections/CollectionEditDialog.tsx`
- Test: `app/src-tauri/src/library/db.rs`
- Test: `app/src-tauri/src/library/collection.rs`
- Test: `app/src/collections/CollectionEditDialog.test.tsx`

**Interfaces:**
- Consumes: existing selected cover row defined by `collection_work_artworks(collection_id, kind='cover', selected=1)`.
- Produces: `CollectionSummary.selected_hero_artwork_id: Option<String>`, `publisher: Option<String>`, `platforms: Option<String>` and matching TypeScript properties `selectedHeroArtworkId`, `publisher`, `platforms`.
- Produces: required nullable `UpdateCollection.publisher: string | null` and `platforms: string | null`, matching the existing complete edit DTO; the edit dialog initializes them from the current Collection so opening and saving does not erase provider data.

- [ ] **Step 1: Write the migration and projection tests**

Add a v22 fixture migration test proving `publisher` and `platforms` are nullable and existing rows survive. Add a Collection query test inserting one selected `cover` and one selected `hero` WorkArtwork and asserting both projections independently:

```rust
assert_eq!(game.selected_work_artwork_id.as_deref(), Some("cover-art"));
assert_eq!(game.selected_hero_artwork_id.as_deref(), Some("hero-art"));
assert_eq!(game.publisher.as_deref(), Some("Sega"));
assert_eq!(game.platforms.as_deref(), Some("Dreamcast · Windows"));
```

Add one dialog assertion that editing a game sends provider-backed fields rather than converting them to blank defaults:

```ts
expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
  publisher: "Sega",
  platforms: "Dreamcast · Windows",
  releaseDate: "2000-05-25",
}));
```

- [ ] **Step 2: Run the focused tests and verify they fail for missing fields**

Run:

```powershell
cd app/src-tauri
cargo test library::db::tests::migrates_v22_to_v23_game_provider_detail -- --exact
cargo test library::collection::tests::projects_selected_cover_and_hero_independently -- --exact
cd ..
npm test -- --run src/collections/CollectionEditDialog.test.tsx
```

Expected: the Rust tests fail to compile or assert because schema/model fields are absent, and the dialog assertion fails because publisher/platforms are not submitted.

- [ ] **Step 3: Add the minimal migration and summary fields**

Create the migration with only:

```sql
ALTER TABLE collections ADD COLUMN publisher TEXT;
ALTER TABLE collections ADD COLUMN platforms TEXT;
```

Register it as schema version 23. Extend `COLLECTION_SUMMARY_SQL` with the two columns and this selected-hero projection, then update row indexes once:

```sql
(SELECT artwork.id
   FROM collection_work_artworks AS artwork
  WHERE artwork.collection_id = collection.id
    AND artwork.kind = 'hero'
    AND artwork.selected = 1
  LIMIT 1) AS selected_hero_artwork_id
```

Extend Rust/TypeScript DTOs and show publisher, platforms, and release date only for `type === "game"` in `CollectionEditDialog`. Preserve fields when an update payload omits them; do not make this task edit genres or overview.

- [ ] **Step 4: Run the same focused tests and verify they pass**

Expected: all three commands pass; do not run broader suites.

- [ ] **Step 5: Commit the schema slice**

```powershell
git add app/src-tauri/migrations/0023_game_provider_detail.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/collection.rs app/src/library/types.ts app/src/collections/CollectionEditDialog.tsx app/src/collections/CollectionEditDialog.test.tsx
git commit -m "feat: add game presentation metadata"
```

### Task 2: OS-backed IGDB credentials and protocol client

**Files:**
- Create: `app/src-tauri/src/library/igdb.rs`
- Modify: `app/src-tauri/src/library/credential.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Test: `app/src-tauri/src/library/credential.rs`
- Test: `app/src-tauri/src/library/igdb.rs`

**Interfaces:**
- Produces: `IgdbCredentials { client_id: String, client_secret: String }`, stored as JSON under target `Lakomics/Igdb`.
- Produces: `IgdbCredentialStatus { configured: bool }`; no read command returns either credential value.
- Produces: `IgdbTokenCache` holding `Option<CachedIgdbToken { access_token, expires_at }>` behind the existing `Library` synchronization pattern.
- Produces: `IgdbClient::search(&self, credentials: &IgdbCredentials, query: &str) -> Result<Vec<IgdbRemoteGame>, LibraryError>` and `IgdbClient::game(&self, credentials: &IgdbCredentials, game_id: i64) -> Result<IgdbRemoteGame, LibraryError>`.
- Produces: `IgdbImageRef { image_id: String, width: Option<u32>, height: Option<u32> }` and `IgdbClient::image_url(image_id: &str, size: IgdbImageSize) -> Result<String, LibraryError>`.

- [ ] **Step 1: Write credential and response-normalization tests**

Use the existing fake credential backend to assert target isolation, JSON round-trip, delete, and redaction:

```rust
let stored = set_igdb_credentials_with(&backend, "client-id", "client-secret").unwrap();
assert!(stored.configured);
assert_eq!(read_igdb_credentials_with(&backend).unwrap().client_id, "client-id");
assert!(!format!("{:?}", stored).contains("client-secret"));
```

In `igdb.rs`, feed static JSON into pure parsers and assert earliest date, every platform, company role separation, artwork priority data, and stable error classification. Include invalid image IDs such as `"../secret"` and malformed token JSON.

- [ ] **Step 2: Run the focused Rust tests and verify they fail**

```powershell
cd app/src-tauri
cargo test library::credential::tests::stores_igdb_credentials_without_exposing_values -- --exact
cargo test library::igdb::tests::normalizes_game_with_earliest_release_and_all_platforms -- --exact
```

Expected: failure because IGDB credential helpers and parser do not exist.

- [ ] **Step 3: Make the credential service target-aware**

Change the service constructor from an implicit Aladin target to an explicit target while retaining thin Aladin wrappers:

```rust
struct CredentialService<'a, B> {
    backend: &'a B,
    target: &'static str,
}

impl<'a, B: CredentialBackend> CredentialService<'a, B> {
    fn new(backend: &'a B, target: &'static str) -> Self {
        Self { backend, target }
    }
}
```

Store IGDB credentials as one serde JSON value under `Lakomics/Igdb`. Validate trimmed non-empty Client ID/Secret on write and deserialize only inside Rust.

- [ ] **Step 4: Implement the narrow IGDB client**

Add serde-only remote records and pure normalizers. Acquire tokens with Twitch client credentials, subtract a 60-second safety margin from expiry, and retry one IGDB request after clearing the cache on HTTP 401. Construct Apicalypse bodies with explicit field lists and escaped quoted search text; cap search results at 20.

Use these stable mappings:

```rust
match status {
    400 => LibraryError::IgdbInvalidRequest,
    401 | 403 => LibraryError::IgdbUnauthorized,
    404 => LibraryError::IgdbNotFound,
    429 => LibraryError::IgdbRateLimited,
    500..=599 => LibraryError::IgdbUnavailable,
    _ => LibraryError::IgdbInvalidResponse,
}
```

Validate image IDs against `^[A-Za-z0-9_-]+$` using a small byte predicate rather than adding a regex dependency. The CDN URL constructor owns the exact `t_cover_big` and `t_1080p` size names.

- [ ] **Step 5: Run the same focused tests and verify they pass**

Expected: both exact tests pass. Do not make live Twitch or IGDB calls in tests.

- [ ] **Step 6: Commit credentials and transport**

```powershell
git add app/src-tauri/src/library/igdb.rs app/src-tauri/src/library/credential.rs app/src-tauri/src/library/error.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/models.rs
git commit -m "feat: add IGDB credentials and client"
```

### Task 3: Atomic game import, refresh, and artwork reselection

**Files:**
- Create: `app/src-tauri/src/library/igdb_flow.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/work_artwork.rs`
- Modify: `app/src-tauri/src/library/external_binding.rs`
- Modify: `app/src-tauri/src/library/collection.rs`
- Test: `app/src-tauri/src/library/igdb_flow.rs`
- Test: `app/src-tauri/src/library/work_artwork.rs`

**Interfaces:**
- Produces: `IgdbSearchResult`, `IgdbImageCandidate`, `IgdbGamePreview`, `IgdbConnection`, `IgdbApplyRequest`, `IgdbArtworkDecision`, and `IgdbArtworkReplaceRequest` serialized with camelCase fields.
- Produces: `GameImportFlow::search`, `preview`, `apply_new`, `refresh`, and `replace_artwork` methods called only by Library commands.
- Produces: `WorkArtworkKind::{Cover, Hero}` and `select_work_artwork_kind_in_transaction(tx, collection_id, artwork_id, kind)`; the existing cover-only function remains a wrapper for compatibility.
- Consumes: `IgdbClient`, `prepare_work_artwork`, `ExternalBinding(provider="igdb")`, and selected WorkArtwork projection from Task 1.

Use these exact public request shapes so later command and UI tasks share one vocabulary:

```rust
pub struct IgdbApplyRequest {
    pub game_id: i64,
    pub cover_image_id: Option<String>,
    pub hero_image_id: Option<String>,
}

#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IgdbArtworkDecision {
    Keep,
    Clear,
    Select { image_id: String },
}

pub struct IgdbArtworkReplaceRequest {
    pub collection_id: String,
    pub cover: IgdbArtworkDecision,
    pub hero: IgdbArtworkDecision,
}
```

`Clear` is valid for hero and for a coverless game; `Keep` preserves that kind without downloading or changing selection; `Select` must name a candidate in the freshly fetched preview.

Use these exact normalized result fields:

```rust
pub struct IgdbSearchResult {
    pub game_id: i64,
    pub title: String,
    pub developer: Option<String>,
    pub release_date: Option<String>,
    pub cover: Option<IgdbImageCandidate>,
}

pub struct IgdbImageCandidate {
    pub image_id: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

pub struct IgdbGamePreview {
    pub game_id: i64,
    pub proposed_title: String,
    pub developer: Option<String>,
    pub publisher: Option<String>,
    pub release_date: Option<String>,
    pub platforms: Vec<String>,
    pub genres: Vec<String>,
    pub overview: Option<String>,
    pub covers: Vec<IgdbImageCandidate>,
    pub artworks: Vec<IgdbImageCandidate>,
    pub screenshots: Vec<IgdbImageCandidate>,
}

pub struct IgdbConnection {
    pub game_id: i64,
    pub last_synced_at: Option<String>,
}
```

Join `platforms` and `genres` with ` · ` only when persisting the Collection; keep arrays in preview DTOs so React can render and label candidates without reparsing display text.

- [ ] **Step 1: Write atomic-flow tests with a fake client and temporary library**

Cover these behaviors in focused unit tests:

```rust
assert_eq!(created.collection_type, CollectionType::Game);
assert_eq!(created.developer.as_deref(), Some("Smilebit"));
assert_eq!(created.publisher.as_deref(), Some("Sega"));
assert_eq!(created.platforms.as_deref(), Some("Dreamcast · Windows"));
assert!(created.selected_work_artwork_id.is_some());
assert!(created.selected_hero_artwork_id.is_some());
assert_eq!(binding.provider, "igdb");
```

Add separate exact tests proving: no-cover/no-hero import succeeds; an image ID not present in the fetched preview is rejected before file preparation; refresh fills blank publisher but preserves a nonblank title, rating, cover, and hero; failed commit removes prepared files; hero removal selects no hero without touching cover.

- [ ] **Step 2: Run one representative exact test and verify it fails**

```powershell
cd app/src-tauri
cargo test library::igdb_flow::tests::applies_game_binding_cover_and_hero_atomically -- --exact
```

Expected: failure because `GameImportFlow` and DTOs are absent.

- [ ] **Step 3: Generalize selected artwork by kind**

Introduce a closed enum and use it to parameterize selection SQL:

```rust
pub(crate) enum WorkArtworkKind { Cover, Hero }

impl WorkArtworkKind {
    fn as_str(self) -> &'static str {
        match self { Self::Cover => "cover", Self::Hero => "hero" }
    }
}
```

Within one transaction, clear `selected` only for the same collection and kind, verify the target artwork belongs to both, and select it. Preserve the existing cover call sites through a small wrapper.

- [ ] **Step 4: Implement normalized preview and atomic apply**

Use an internal prepared-file guard so every error before commit deletes only newly prepared files. Apply validation in this order: validate target game ID, refetch preview, validate selected candidate membership, prepare selected files, open transaction, insert Collection/binding/artworks, commit, disarm cleanup.

Persist a compact provider snapshot containing the normalized preview plus candidate identities required for later reselection; do not include credentials, token, or downloaded bytes.

- [ ] **Step 5: Implement refresh and reselection preservation rules**

Compute refresh eligibility against both the current Collection and the previous provider snapshot so an explicit user clear is distinguishable from a provider field that has always been absent:

```rust
fn may_fill_from_provider(current: Option<&str>, previous_provider: Option<&str>) -> bool {
    current.map_or(true, |value| value.trim().is_empty())
        && previous_provider.map_or(true, |value| value.trim().is_empty())
}
```

Pass those booleans into explicit `CASE WHEN ? THEN new_value ELSE existing_value END` assignments for developer, publisher, release date, platforms, genres, and overview. Never refresh title, personal rating, cover, or hero. Update the binding snapshot and `last_synced_at` in the same transaction. Do not prepare or replace artwork during refresh. Reselection validates new IDs against a freshly fetched preview and changes only kinds whose decision is `Clear` or `Select`; `Keep` performs no write for that kind.

- [ ] **Step 6: Run the focused module tests**

```powershell
cd app/src-tauri
cargo test library::igdb_flow::tests -- --nocapture
```

Expected: all tests inside only `library::igdb_flow::tests` pass, including cleanup and preservation cases.

- [ ] **Step 7: Commit the orchestration slice**

```powershell
git add app/src-tauri/src/library/igdb_flow.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/work_artwork.rs app/src-tauri/src/library/external_binding.rs app/src-tauri/src/library/collection.rs
git commit -m "feat: add atomic IGDB game import flow"
```

### Task 4: Tauri commands, frontend gateway, and provider image previews

**Files:**
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/media_protocol.rs`
- Modify: `app/src-tauri/src/commands.rs` (owned IGDB hunks only)
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/assets/mediaUrl.ts`
- Test: `app/src-tauri/src/media_protocol.rs`
- Test: `app/src-tauri/src/commands.rs`

**Interfaces:**
- Produces Tauri commands: `get_igdb_credential_status`, `set_igdb_credentials`, `delete_igdb_credentials`, `search_igdb_games`, `preview_igdb_game`, `apply_igdb_game`, `refresh_igdb_game`, `get_igdb_connection`, `replace_igdb_game_artwork`.
- Produces matching `LibraryGateway` methods using the exact camelCase DTOs from Task 3.
- Produces `igdbImagePreviewUrl(imageId, size)` where `size` is `"cover" | "hero"`; frontend never receives a Twitch token or raw CDN template.

- [ ] **Step 1: Write media-route and public-error tests**

Assert route parsing and traversal rejection:

```rust
let (variant, image_id) = parse_media_path("/igdb-image-preview/cover/co1abc").unwrap();
assert!(matches!(variant, MediaVariant::IgdbImagePreviewCover));
assert_eq!(image_id.as_deref(), Some("co1abc"));
assert!(parse_media_path("/igdb-image-preview/hero/..%2Fsecret").is_err());
```

Add a command mapping test proving unauthorized, rate-limited, timeout, unavailable, not-found, invalid-image, and malformed-response errors expose stable codes without error-body or secret contents.

- [ ] **Step 2: Run the two exact Rust tests and verify they fail**

```powershell
cd app/src-tauri
cargo test media_protocol::tests::parses_igdb_image_preview_routes -- --exact
cargo test commands::tests::maps_igdb_errors_without_secret_details -- --exact
```

Expected: failure because variants and mappings are absent.

- [ ] **Step 3: Add the media preview seam**

Add distinct cover/hero media variants, validate the image ID in Rust, construct the IGDB CDN URL through `IgdbClient::image_url`, and stream the response through the existing media protocol response limits. Never accept an arbitrary remote URL from React.

- [ ] **Step 4: Add narrow commands and TypeScript invokes**

Keep command signatures DTO-based, for example:

```rust
#[tauri::command]
pub fn apply_igdb_game(
    library: State<'_, Library>,
    request: IgdbApplyRequest,
) -> Result<CollectionSummary, CommandError> {
    library.apply_igdb_game(request).map_err(Into::into)
}
```

Use these frontend signatures:

```ts
getIgdbCredentialStatus(): Promise<IgdbCredentialStatus>;
setIgdbCredentials(input: { clientId: string; clientSecret: string }): Promise<IgdbCredentialStatus>;
searchIgdbGames(query: string): Promise<IgdbSearchResult[]>;
previewIgdbGame(gameId: number): Promise<IgdbGamePreview>;
applyIgdbGame(request: IgdbApplyRequest): Promise<CollectionSummary>;
refreshIgdbGame(collectionId: string): Promise<CollectionSummary>;
getIgdbConnection(collectionId: string): Promise<IgdbConnection | null>;
replaceIgdbGameArtwork(request: IgdbArtworkReplaceRequest): Promise<CollectionSummary>;
```

Register every command in `lib.rs`. Do not add tests to the already-dirty `client.test.ts` unless the TypeScript compiler reveals a real invoke mismatch.

- [ ] **Step 5: Run the focused Rust tests and TypeScript type check**

```powershell
cd app/src-tauri
cargo test media_protocol::tests::parses_igdb_image_preview_routes -- --exact
cargo test commands::tests::maps_igdb_errors_without_secret_details -- --exact
cd ..
npx tsc --noEmit
```

Expected: both Rust tests and the type check pass.

- [ ] **Step 6: Stage only owned command hunks and commit**

```powershell
git add app/src-tauri/src/library/mod.rs app/src-tauri/src/media_protocol.rs app/src-tauri/src/lib.rs app/src/library/types.ts app/src/library/client.ts app/src/assets/mediaUrl.ts
git add -p -- app/src-tauri/src/commands.rs
git diff --cached --check
git commit -m "feat: expose IGDB library commands"
```

At the interactive staging prompt, accept only hunks adding IGDB imports, functions, registrations/mappings, and their targeted test. Reject every pre-existing unrelated hunk. Confirm with `git diff --cached -- app/src-tauri/src/commands.rs` before committing.

### Task 5: IGDB credential settings and three-stage import dialog

**Files:**
- Create: `app/src/collections/IgdbImportDialog.tsx`
- Create: `app/src/collections/IgdbImportDialog.test.tsx`
- Modify: `app/src/settings/SettingsView.tsx`
- Modify: `app/src/settings/SettingsView.test.tsx`
- Modify: `app/src/collections/CollectionBrowser.tsx`
- Modify: `app/src/collections/CollectionBrowser.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: credential/search/preview/apply methods from Task 4.
- Produces: `IgdbImportDialog({ open, target, onClose, onApplied })`; `target` is `{ kind: "new" } | { kind: "existing"; collectionId: string }`.
- Produces: game add-menu choices `IGDB에서 게임 추가` and `직접 입력` without changing manga/movie routes.

- [ ] **Step 1: Write focused UI tests before components**

In Settings, assert status is boolean-only, password inputs start blank even when configured, save sends both fields, successful save clears both inputs, and delete requires confirmation.

In the import dialog, test one complete path:

```ts
expect(screen.getByRole("button", { name: "가져오기" })).toBeDisabled();
await user.click(screen.getByRole("button", { name: /Jet Set Radio/ }));
await user.click(screen.getByRole("button", { name: "다음" }));
expect(screen.getByRole("button", { name: "가져오기" })).toBeDisabled();
await user.click(screen.getByRole("radio", { name: /표지 2/ }));
await user.click(screen.getByRole("button", { name: "다음" }));
await user.click(screen.getByRole("radio", { name: /hero 없이 가져오기/ }));
await user.click(screen.getByRole("button", { name: "가져오기" }));
```

Also assert screenshots are absent when artworks exist, screenshots appear when artworks are empty, and no-cover preview advances without a cover selection.

- [ ] **Step 2: Run the three directly affected test files and verify failure**

```powershell
cd app
npm test -- --run src/settings/SettingsView.test.tsx src/collections/IgdbImportDialog.test.tsx src/collections/CollectionBrowser.test.tsx
```

Expected: failure for absent controls/dialog/menu route.

- [ ] **Step 3: Add write-only credential settings**

In the existing `external_services` section, add Client ID and Client Secret inputs with `type="password"`, configured/unconfigured text, save, and delete. Fetch status only; never populate saved values. On a missing-credential error from import, surface an action that selects the existing external-services settings section rather than echoing backend details.

- [ ] **Step 4: Implement the progressive dialog state machine**

Use a small discriminated state instead of parallel booleans:

```ts
type IgdbImportStep =
  | { kind: "search"; query: string; selectedGameId: number | null }
  | { kind: "cover"; preview: IgdbGamePreview; coverImageId: string | null; coverDecisionMade: boolean }
  | { kind: "hero"; preview: IgdbGamePreview; coverImageId: string | null; heroImageId: string | null; heroDecisionMade: boolean };
```

Do not initialize either selected image ID from the first candidate. A candidate click sets the ID and its decision flag. If `preview.covers.length === 0`, cover decision is implicitly complete. `hero 없이 가져오기` sets `heroImageId` to null and `heroDecisionMade` to true. Derive hero candidates as:

```ts
const heroCandidates = preview.artworks.length > 0
  ? preview.artworks
  : preview.screenshots;
```

Preserve query/results when preview fails and allow Back to the previous stage without closing.

- [ ] **Step 5: Route the game add menu**

Open `IgdbImportDialog` for `IGDB에서 게임 추가` and the existing `CollectionEditDialog` for `직접 입력`. After apply, close the dialog, refresh Collection data through the existing callback, and open/select the created game using the Browser's established route.

- [ ] **Step 6: Run the same focused frontend tests**

Expected: all three files pass. Do not run the full frontend suite.

- [ ] **Step 7: Commit the settings/import UI**

```powershell
git add app/src/collections/IgdbImportDialog.tsx app/src/collections/IgdbImportDialog.test.tsx app/src/settings/SettingsView.tsx app/src/settings/SettingsView.test.tsx app/src/collections/CollectionBrowser.tsx app/src/collections/CollectionBrowser.test.tsx app/src/styles/global.css
git commit -m "feat: add IGDB game import interface"
```

### Task 6: Hero-dominant game detail and package interaction

**Files:**
- Create: `app/src/collections/GameCollectionDetail.tsx`
- Create: `app/src/collections/GameCollectionDetail.test.tsx`
- Modify: `app/src/collections/CollectionOverlay.tsx`
- Modify: `app/src/collections/CollectionOverlay.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: `CollectionSummary.selectedHeroArtworkId`, `selectedWorkArtworkId`, metadata, connection, refresh, and artwork-replace operations.
- Produces: `GameCollectionDetail` presentation component with props `{ collection, coverUrl, heroUrl, providerConnected, providerBusy, providerError, onEdit, onToggleShowcase, onDelete, onRefreshProvider, onChangeArtwork }`.
- Produces no provider protocol logic; `CollectionOverlay` owns gateway calls and refreshes the local Collection list through `onChanged`.

- [ ] **Step 1: Write detail semantics and orchestration tests**

Assert the selected hero is rendered as the dominant labelled region; missing hero renders the neutral fallback and does not reuse the cover URL. Assert title, developer, publisher, earliest release date, all platforms, genres, personal rating, and overview appear only when present.

For package interaction, assert button semantics and keyboard activation:

```ts
const packageButton = screen.getByRole("button", { name: "게임 패키지 들어 올리기" });
await user.keyboard("{Enter}");
expect(packageButton).toHaveAttribute("aria-pressed", "true");
await user.keyboard(" ");
expect(packageButton).toHaveAttribute("aria-pressed", "false");
```

In `CollectionOverlay.test.tsx`, assert visible `작품 관리` opens edit, Showcase, delete, `IGDB 새로고침`, and `표지·hero 변경`; refresh failure keeps the detail and existing hero visible.

- [ ] **Step 2: Run only the two game-detail test files and verify failure**

```powershell
cd app
npm test -- --run src/collections/GameCollectionDetail.test.tsx src/collections/CollectionOverlay.test.tsx
```

Expected: failure because the game-specific detail and actions are absent.

- [ ] **Step 3: Implement the focused presentation component**

Render a single hero surface with a minimum readability scrim. When `heroUrl` is null, render a neutral token-based background and no cover-derived background image. Render no empty metadata cards.

Make the package a native button containing cover, shell, and spine elements. Toggle `data-lifted` on click/Enter/Space. Apply pointer tilt only while lifted, clamp Y rotation to a few degrees, clear inline transform on pointer leave, and keep card-package CSS untouched.

- [ ] **Step 4: Add game orchestration to CollectionOverlay**

Branch `collection.type === "game"` to `GameCollectionDetail`; keep manga and movie branches intact. Resolve cover/hero media URLs from the selected WorkArtwork IDs. Load the IGDB connection after the local Collection renders so provider failure cannot block offline detail.

Wire refresh to keep the existing view on error and call `onChanged` only after success. Open `IgdbImportDialog` with `{ kind: "existing", collectionId }` for artwork reselection. Keep close/back in the stable toolbar and all item/provider actions in `작품 관리`.

- [ ] **Step 5: Add restrained token-based styling and reduced motion**

Use existing surface, border, text, radius, and shadow tokens. The lifted state translates roughly 10–18 px and rotates only a few degrees. Add a stylesheet contract equivalent to:

```css
@media (prefers-reduced-motion: reduce) {
  .game-detail__package,
  .game-detail__package-shell {
    transition: none;
    transform: none;
  }
}
```

Do not add platform logos, fake back-cover art, glass cards, decorative gradients unrelated to legibility, gallery tabs, or count chips.

- [ ] **Step 6: Run the same two focused test files**

Expected: both test files pass. Do not run production build yet.

- [ ] **Step 7: Commit the game detail**

```powershell
git add app/src/collections/GameCollectionDetail.tsx app/src/collections/GameCollectionDetail.test.tsx app/src/collections/CollectionOverlay.tsx app/src/collections/CollectionOverlay.test.tsx app/src/styles/global.css
git commit -m "feat: build hero-first game collection detail"
```

### Task 7: Final targeted verification and clean handoff

**Files:**
- Modify only files required to fix a failure found by the commands below.
- Do not touch unrelated dirty files or add broad regression tests without evidence.

**Interfaces:**
- Consumes: all six committed slices.
- Produces: a buildable game provider/detail vertical slice and an evidence-backed handoff.

- [ ] **Step 1: Inspect owned changes and dirty-file boundaries**

```powershell
git log -8 --oneline
git status --short
git diff --check HEAD~6..HEAD
git diff -- app/src-tauri/src/commands.rs app/src/library/client.test.ts
```

Expected: six feature commits follow the two approved design commits; unrelated dirty files remain unstaged and unchanged by this work.

- [ ] **Step 2: Run one backend seam filter**

```powershell
cd app/src-tauri
cargo test library::igdb_flow::tests -- --nocapture
```

Expected: the atomic apply/refresh/reselection module tests pass. Do not rerun earlier exact credential/media tests unless this final code changed their modules after they passed.

- [ ] **Step 3: Run one frontend feature group**

```powershell
cd app
npm test -- --run src/collections/IgdbImportDialog.test.tsx src/collections/GameCollectionDetail.test.tsx src/collections/CollectionOverlay.test.tsx
```

Expected: import progression, game presentation, and overlay orchestration tests pass.

- [ ] **Step 4: Run the production build once**

```powershell
cd app
npm run build
```

Expected: TypeScript and Vite production build complete successfully. Do not run another build unless a subsequent code edit invalidates this result.

- [ ] **Step 5: Commit only if verification required a fix**

If no code changed, do not create an empty commit. If a failure required an owned fix, run only the test invalidated by that fix, stage only those owned files/hunks, and commit:

```powershell
git diff --check
git add -p -- app/src-tauri/src/library/igdb.rs app/src-tauri/src/library/igdb_flow.rs app/src-tauri/src/library/work_artwork.rs app/src-tauri/src/media_protocol.rs app/src-tauri/src/commands.rs app/src/library/types.ts app/src/library/client.ts app/src/collections/IgdbImportDialog.tsx app/src/collections/GameCollectionDetail.tsx app/src/collections/CollectionOverlay.tsx app/src/styles/global.css
git diff --cached --check
git commit -m "fix: stabilize IGDB game collection flow"
```

- [ ] **Step 6: Report the handoff**

Report: commit hashes, exact tests/build run, whether any live IGDB call remains for manual verification, and the unchanged pre-existing dirty paths. Do not claim live credential or provider success unless it was actually exercised with the user's configured Twitch application.
