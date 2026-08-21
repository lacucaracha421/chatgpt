# Aladin Korean Volume Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user securely connect an existing manga Collection to a text-only Aladin series candidate and manually synchronize Korean publication data into the existing Volume shelf without changing MangaDex/local artwork or user metadata.

**Architecture:** A Rust-only credential boundary reads the TTB key from Windows Credential Manager. A typed Aladin client parses provider items, while a separate Aladin flow groups series candidates and transactionally stores provider-owned release rows plus an `aladin` ExternalBinding. React receives only credential status, typed candidates, connection summaries, sync counts, and projected release fields.

**Tech Stack:** Rust 2021, `windows-sys`, `ureq`, `serde`, `serde_json`, `regex`, `rusqlite`, Tauri 2, React 19, TypeScript, Vitest, Testing Library, SQLite migrations.

## Global Constraints

- MangaDex owns Work identity/general manga metadata/Japanese cover artwork; Aladin owns Korean commercial volume identity and release data.
- Aladin search results are text-only and make no cover-image requests.
- Store the TTB key in Windows Credential Manager, never SQLite, metadata backups, provider JSON, logs, or a frontend-readable status response.
- Use explicit search/connect/refresh actions only; add no search-on-keystroke, startup sweep, timer, background polling, or notifications.
- Use HTTPS, a bounded timeout, at most 50 search results, `QueryType=Title`, `SearchTarget=Book`, `output=js`, and `Version=20131101`.
- Accept only unambiguous integer Volume numbers from 1 through 999; reject bundles, boxes, guides, art books, novels, calendars, decimal identities, and unparsed products.
- Never change Collection user metadata, MangaDex bindings/snapshots, WorkArtwork, cover source fields, `cover_artwork_id`, or alternate edition drawers during Aladin sync.
- Provider omissions are non-destructive: refresh does not delete previously synchronized release rows.
- Use existing shared UI components and design tokens; no cover thumbnails, decorative cards, gradients, large radii, hover scale, or unrelated Works redesign.
- Follow `AGENTS.md` verification policy: run one most relevant targeted check, expand only after failure or identified cross-module risk, and do not rerun successful checks unless later edits invalidate them.

---

## File structure

### Rust backend

- Create `app/src-tauri/migrations/0016_aladin_volume_sources.sql` — provider configuration and Korean volume-source storage.
- Create `app/src-tauri/src/library/aladin.rs` — HTTPS request construction, typed response parsing, product filtering, and integer Volume parsing.
- Create `app/src-tauri/src/library/aladin_flow.rs` — grouping, connection identity, refresh re-identification, and transactional reconciliation.
- Create `app/src-tauri/src/library/credential.rs` — Windows Credential Manager boundary for the TTB key.
- Create `app/src-tauri/src/library/fixtures/aladin_search.json` — sanitized provider response fixture with two series groups, ignored products, and missing optional fields.
- Modify `app/src-tauri/src/library/db.rs` — schema version 16 wiring and migration coverage.
- Modify `app/src-tauri/src/library/models.rs` — typed Aladin requests/results and projected release fields.
- Modify `app/src-tauri/src/library/external_binding.rs` — read/write `provider_config_json` without changing MangaDex behavior.
- Modify `app/src-tauri/src/library/collection_volume.rs` — join Aladin release projection into `CollectionVolume`.
- Modify `app/src-tauri/src/library/error.rs` — stable Aladin/credential errors.
- Modify `app/src-tauri/src/library/mod.rs` — register focused modules.
- Modify `app/src-tauri/src/commands.rs` — credential and Aladin commands with stable error codes.
- Modify `app/src-tauri/src/lib.rs` — Tauri command registration.
- Modify `app/src-tauri/Cargo.toml` — add only required `windows-sys` Credential Manager feature.

### React frontend

- Create `app/src/collections/AladinConnectDialog.tsx` — text-only search, candidate preview, and connection confirmation.
- Create `app/src/collections/AladinConnectDialog.test.tsx` — dialog interaction coverage.
- Modify `app/src/library/types.ts` — Aladin DTOs, release projection, and gateway methods.
- Modify `app/src/library/client.ts` — Tauri invocation mapping.
- Modify `app/src/settings/SettingsView.tsx` — compact external-services credential UI.
- Modify `app/src/settings/SettingsView.test.tsx` — masked credential status/replace/remove coverage.
- Modify `app/src/collections/CollectionOverlay.tsx` — Aladin connect/refresh orchestration.
- Modify `app/src/collections/CollectionOverlay.test.tsx` — provider coexistence and shelf reload coverage.
- Modify `app/src/collections/CollectionVolumePanel.tsx` — selected Volume Korean release fields.
- Modify `app/src/styles/global.css` — dense dialog/settings/result-row styling using existing tokens.
- Modify existing gateway mocks found by `rg -l "syncMangaDexVolumeCovers" app/src --glob "*.test.tsx"` — add deterministic Aladin method stubs.

---

### Task 1: Persist provider configuration and Korean volume sources

**Files:**
- Create: `app/src-tauri/migrations/0016_aladin_volume_sources.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/external_binding.rs`
- Modify: `app/src-tauri/src/library/collection_volume.rs`
- Test: `app/src-tauri/src/library/db.rs`
- Test: `app/src-tauri/src/library/collection_volume.rs`

**Interfaces:**
- Produces migration columns/table: `collection_external_bindings.provider_config_json` and `collection_volume_sources`.
- Produces `CollectionVolume.local_release_date: Option<String>`, `isbn13: Option<String>`, and `release_status: Option<String>` for later frontend tasks.
- Preserves every existing ExternalBinding call by adding `provider_config_json: Option<String>` to Rust input/output models and setting it to `None` at existing MangaDex call sites.

- [ ] **Step 1: Write the failing v15→v16 migration test**

Add a focused test in `db.rs` that builds schema 15 in memory with the existing schema constants, inserts one MangaDex binding and Volume cover, migrates it, and asserts the new column/table while preserving both existing rows:

```rust
#[test]
fn migrates_v15_to_aladin_volume_sources() {
    let mut connection = Connection::open_in_memory().unwrap();
    for schema in [
        INITIAL_SCHEMA, VAULT_SAFETY_SCHEMA, SIMILARITY_REVIEW_SCHEMA,
        VIDEO_MEDIA_SCHEMA, MANGA_SCHEMA, MANGA_MODIFIED_SCHEMA,
        CLASSIFICATION_APPEARANCE_SCHEMA, ASSET_ALBUMS_SCHEMA,
        ASSET_SOURCE_PROVENANCE_SCHEMA, COLLECTIONS_SCHEMA,
        COLLECTIONS_TYPED_SCHEMA, COLLECTION_SOURCE_SCHEMA,
        COLLECTION_EXTERNAL_BINDINGS_SCHEMA, COLLECTION_WORK_ARTWORKS_SCHEMA,
        COLLECTION_VOLUMES_SCHEMA,
    ] {
        connection.execute_batch(schema).unwrap();
    }
    connection.execute_batch(r#"
        INSERT INTO collections (
          id, name, description, type, cover_asset_id, year, author, director,
          external_score, my_score, genres, overview, showcase,
          created_at, updated_at, source_path
        ) VALUES (
          'work-1', 'Work One', NULL, 'manga', NULL, NULL, NULL, NULL,
          NULL, NULL, NULL, NULL, 0, 't', 't', NULL
        );
        INSERT INTO collection_external_bindings (
          collection_id, provider, external_id, provider_data_json,
          last_synced_at, created_at, updated_at
        ) VALUES ('work-1', 'mangadex', 'md-1', '{}', 't', 't', 't');
        INSERT INTO collection_work_artworks (
          id, collection_id, provider, provider_image_id, kind, relative_path,
          mime_type, width, height, language, selected, created_at, updated_at
        ) VALUES (
          'art-1', 'work-1', 'mangadex', 'cover-1', 'cover',
          'work-artwork/work-1/art-1.jpg', 'image/jpeg', 100, 150,
          'ja', 1, 't', 't'
        );
        INSERT INTO collection_volumes (
          id, collection_id, volume_number, edition_index, sort_order,
          cover_artwork_id, source_provider, source_cover_id, source_file_name,
          created_at, updated_at
        ) VALUES (
          'volume-1', 'work-1', 1, 0, 1, 'art-1',
          'mangadex', 'cover-1', 'cover.jpg', 't', 't'
        );
    "#).unwrap();
    migrate_to_latest(&mut connection, 15).unwrap();
    assert_eq!(SCHEMA_VERSION, 16);
    let config: Option<String> = connection.query_row(
        "SELECT provider_config_json FROM collection_external_bindings
         WHERE collection_id = 'work-1' AND provider = 'mangadex'",
        [],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(config, None);
    connection.execute(
        "INSERT INTO collection_volume_sources (
           collection_id, volume_number, provider, provider_item_id,
           title, author, publisher, isbn13, publication_date, item_url,
           provider_data_json, created_at, updated_at
         ) VALUES ('work-1', 1, 'aladin', 'item-1', '던전밥 1',
           '쿠이 료코', '소미미디어', '9780000000001', '2026-09-01',
           'https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=1', '{}', 't', 't')",
        [],
    ).unwrap();
}
```

- [ ] **Step 2: Run the migration test to verify it fails**

Run from `app/src-tauri`:

```powershell
$env:CARGO_TARGET_DIR='C:\chatgpt\app\src-tauri\target'
cargo test library::db::tests::migrates_v15_to_aladin_volume_sources --lib
```

Expected: FAIL because schema version 16 and `collection_volume_sources` do not exist.

- [ ] **Step 3: Add migration 0016 and wire it**

Use this schema:

```sql
ALTER TABLE collection_external_bindings ADD COLUMN provider_config_json TEXT;

CREATE TABLE collection_volume_sources (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    volume_number INTEGER NOT NULL CHECK (volume_number BETWEEN 1 AND 999),
    provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
    provider_item_id TEXT NOT NULL CHECK (length(trim(provider_item_id)) > 0),
    title TEXT NOT NULL,
    author TEXT,
    publisher TEXT,
    isbn13 TEXT,
    publication_date TEXT,
    item_url TEXT,
    provider_data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (collection_id, volume_number, provider)
);

CREATE UNIQUE INDEX collection_volume_sources_by_provider_item
ON collection_volume_sources(provider, provider_item_id);

PRAGMA user_version = 16;
```

Set `SCHEMA_VERSION` to 16, include the migration, apply it when `version <= 15`, and extend migration fixtures/helpers without rewriting older migration files.

- [ ] **Step 4: Run the migration test to verify it passes**

Run the same focused command. Expected: PASS.

- [ ] **Step 5: Write the failing Volume projection test**

In `collection_volume.rs`, insert an Aladin source for base Volume 2 and assert:

```rust
let volumes = library.list_collection_volumes(&work.id).unwrap();
let base = volumes.iter().find(|volume| {
    volume.volume_number == 2 && volume.edition_index == 0
}).unwrap();
assert_eq!(base.local_release_date.as_deref(), Some("2026-09-01"));
assert_eq!(base.isbn13.as_deref(), Some("9780000000002"));
assert_eq!(base.release_status.as_deref(), Some("upcoming"));
assert_eq!(alternate.cover_artwork_id.as_deref(), Some("art-alt"));
```

Build the test date as `(chrono::Utc::now().date_naive() + chrono::Days::new(1)).to_string()` and assert `upcoming`; derive `release_status` in Rust as `upcoming` or `released` rather than persisting it.

- [ ] **Step 6: Run the Volume projection test to verify it fails**

```powershell
cargo test library::collection_volume::tests::projects_aladin_release_without_changing_cover_editions --lib
```

Expected: FAIL because the fields/join do not exist.

- [ ] **Step 7: Implement the projection and ExternalBinding configuration field**

Add nullable fields to `CollectionVolume`, select the `aladin` source through a left join keyed by Collection and Volume number, and update `ExternalBindingInput`/`ExternalBinding` SQL:

```rust
pub struct CollectionVolume {
    pub id: String,
    pub volume_number: i64,
    pub edition_index: u8,
    pub display_label: String,
    pub cover_artwork_id: Option<String>,
    pub local_release_date: Option<String>,
    pub isbn13: Option<String>,
    pub release_status: Option<String>,
}
```

All existing MangaDex `ExternalBindingInput` constructors must explicitly use `provider_config_json: None`.

- [ ] **Step 8: Run the focused Volume test to verify it passes**

Run the Step 6 command. Expected: PASS.

- [ ] **Step 9: Commit Task 1**

```powershell
git add app/src-tauri/migrations/0016_aladin_volume_sources.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/external_binding.rs app/src-tauri/src/library/collection_volume.rs
git commit -m "feat: persist Aladin volume sources"
```

---

### Task 2: Parse and filter typed Aladin search results

**Files:**
- Create: `app/src-tauri/src/library/aladin.rs`
- Create: `app/src-tauri/src/library/fixtures/aladin_search.json`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Test: `app/src-tauri/src/library/aladin.rs`

**Interfaces:**
- Produces internal `AladinItem` and `search(ttb_key: &str, query: &str) -> Result<Vec<AladinItem>, LibraryError>`.
- Produces pure `parse_search(json: &str) -> Result<Vec<AladinItem>, LibraryError>` and `parse_volume_product(title: &str) -> Option<ParsedVolumeProduct>` for Task 4.
- Does not expose provider JSON maps outside this module.

- [ ] **Step 1: Add parser tests before implementation**

Cover exact accepted and rejected examples:

```rust
#[test]
fn parses_integer_volume_suffixes() {
    assert_eq!(parse_volume_product("던전밥 12권").unwrap().volume_number, 12);
    assert_eq!(parse_volume_product("던전밥 Vol. 12").unwrap().volume_number, 12);
    assert_eq!(parse_volume_product("던전밥 제12권").unwrap().volume_number, 12);
}

#[test]
fn rejects_special_products_and_fractional_volumes() {
    for title in ["던전밥 박스 세트", "던전밥 공식 가이드북", "던전밥 10.5권", "던전밥 화집"] {
        assert_eq!(parse_volume_product(title), None, "{title}");
    }
}
```

Add fixture parsing assertions for item ID, title, author, publisher, ISBN13, publication date, item URL, and sanitized raw snapshot.

- [ ] **Step 2: Run parser tests to verify they fail**

```powershell
cargo test library::aladin::tests --lib
```

Expected: FAIL because `aladin` and its parser do not exist.

- [ ] **Step 3: Implement minimal typed response parsing and filtering**

Define:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AladinItem {
    pub item_id: String,
    pub title: String,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub isbn13: Option<String>,
    pub publication_date: Option<String>,
    pub item_url: Option<String>,
    pub volume_number: i64,
    pub base_title: String,
    pub snapshot_json: String,
}
```

Use ordered regular expressions and explicit reject terms. Validate provider error envelopes before reading `item`; treat missing `item` as an empty result and non-array `item` as `InvalidAladinResponse`. Never retain the `ttbkey` in snapshots.

- [ ] **Step 4: Add request/error mapping tests through an injected fetch closure**

Use a private helper:

```rust
fn search_with<F>(ttb_key: &str, query: &str, fetch: F) -> Result<Vec<AladinItem>, LibraryError>
where
    F: FnOnce(&str, &[(&str, &str)]) -> Result<String, AladinTransportError>
```

Define the internal transport error explicitly:

```rust
enum AladinTransportError {
    Timeout,
    HttpStatus(u16),
    Unavailable,
}
```

Assert short query, timeout, HTTP 429, invalid-key provider envelope, malformed JSON, and empty items map to distinct errors without including the key in `Display` output.

- [ ] **Step 5: Implement HTTPS request construction**

Use `https://www.aladin.co.kr/ttb/api/ItemSearch.aspx`, a bounded timeout, and parameters owned in this module. Do not log the URL or propagate an underlying error string containing it.

- [ ] **Step 6: Run the Aladin module tests to verify they pass**

Run the Step 2 command. Expected: all `library::aladin::tests` PASS.

- [ ] **Step 7: Commit Task 2**

```powershell
git add app/src-tauri/src/library/aladin.rs app/src-tauri/src/library/fixtures/aladin_search.json app/src-tauri/src/library/mod.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/error.rs
git commit -m "feat: parse Aladin volume searches"
```

---

### Task 3: Store the TTB key in Windows Credential Manager

**Files:**
- Create: `app/src-tauri/src/library/credential.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/Cargo.toml`
- Test: `app/src-tauri/src/library/credential.rs`

**Interfaces:**
- Produces `aladin_key_status() -> Result<bool, LibraryError>`.
- Produces `set_aladin_key(value: &str) -> Result<(), LibraryError>`.
- Produces `delete_aladin_key() -> Result<(), LibraryError>`.
- Produces crate-private `read_aladin_key() -> Result<String, LibraryError>` for commands only; no Tauri command returns it.

- [ ] **Step 1: Write failing credential-facade tests with a fake backend**

Define tests around a private backend interface:

```rust
trait CredentialBackend {
    fn read(&self, target: &str) -> Result<Option<Vec<u8>>, CredentialError>;
    fn write(&self, target: &str, value: &[u8]) -> Result<(), CredentialError>;
    fn delete(&self, target: &str) -> Result<(), CredentialError>;
}

#[derive(Debug)]
enum CredentialError {
    System(u32),
}
```

Assert trimming, empty-key rejection, configured status without returning the value, replacement, deletion, missing-key behavior, and error messages that contain neither the key nor credential bytes.

- [ ] **Step 2: Run the credential tests to verify they fail**

```powershell
cargo test library::credential::tests --lib
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the facade and Windows backend**

Use one stable target name, `Lakomics/AladinTTB`, generic credentials, and local-machine persistence. Add only `Win32_Security_Credentials` to the existing Windows `windows-sys` feature list. Wrap `CredReadW`, `CredWriteW`, `CredDeleteW`, and `CredFree` in the module; convert every raw allocation to an owned byte vector before freeing it.

On non-Windows targets, compile a backend that returns `CredentialStoreUnavailable` without changing the portable library schema.

- [ ] **Step 4: Run credential tests to verify they pass**

Run the Step 2 command. Expected: PASS without writing a real credential because tests use the fake backend.

- [ ] **Step 5: Commit Task 3**

```powershell
git add app/src-tauri/src/library/credential.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/error.rs app/src-tauri/Cargo.toml app/src-tauri/Cargo.lock
git commit -m "feat: secure the Aladin credential"
```

---

### Task 4: Group candidates and transactionally synchronize releases

**Files:**
- Create: `app/src-tauri/src/library/aladin_flow.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Test: `app/src-tauri/src/library/aladin_flow.rs`

**Interfaces:**
- Consumes `aladin::AladinItem`, `aladin::search`, schema from Task 1, and existing ExternalBinding operations.
- Produces public Library methods:

```rust
pub fn search_aladin(&self, ttb_key: &str, query: &str) -> Result<Vec<AladinSeriesCandidate>, LibraryError>;
pub fn apply_aladin(&self, ttb_key: &str, request: AladinApplyRequest) -> Result<AladinSyncResult, LibraryError>;
pub fn refresh_aladin(&self, ttb_key: &str, collection_id: &str) -> Result<AladinSyncResult, LibraryError>;
pub fn get_aladin_connection(&self, collection_id: &str) -> Result<Option<AladinConnection>, LibraryError>;
```

- Produces serialized DTOs:

```rust
pub struct AladinVolumeCandidate {
    pub volume_number: i64,
    pub provider_item_id: String,
    pub title: String,
    pub publication_date: Option<String>,
    pub isbn13: Option<String>,
}

pub struct AladinSeriesCandidate {
    pub anchor_item_id: String,
    pub group_fingerprint: String,
    pub title: String,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub volumes: Vec<AladinVolumeCandidate>,
    pub ignored_count: u64,
}

pub struct AladinApplyRequest {
    pub collection_id: String,
    pub query: String,
    pub anchor_item_id: String,
    pub group_fingerprint: String,
}

pub struct AladinConnection {
    pub anchor_item_id: String,
    pub query: String,
    pub last_synced_at: Option<String>,
}

pub struct AladinSyncResult {
    pub added: u64,
    pub updated: u64,
    pub unchanged: u64,
    pub ignored: u64,
}
```

- [ ] **Step 1: Write failing deterministic grouping tests**

Construct items for two same-title/different-publisher groups. Assert numeric sorting, duplicate-volume resolution, stable fingerprinting, ignored counts, and no fuzzy merge.

For duplicate items with the same group and Volume number, select deterministically by: non-empty ISBN13, then newest publication date, then lexicographically smallest provider item ID.

- [ ] **Step 2: Run grouping tests to verify they fail**

```powershell
cargo test library::aladin_flow::tests::groups_series_without_fuzzy_merging --lib
```

Expected: FAIL because the flow module does not exist.

- [ ] **Step 3: Implement pure grouping and configuration serialization**

Store versioned provider configuration:

```json
{
  "version": 1,
  "query": "던전밥",
  "groupFingerprint": "<sha256>",
  "knownItemIds": ["item-1", "item-2"]
}
```

The fingerprint input is normalized base title, author, and publisher separated by NUL bytes. Use the existing `sha2` dependency.

- [ ] **Step 4: Write the failing transactional apply test**

Seed one Collection with a MangaDex binding, selected hero artwork, base Volume 1, and alternate Volume 1.1 cover. Apply Aladin items for Volumes 1 and 2. Assert:

- the Aladin binding coexists with MangaDex;
- Volume 2 base row is created with no cover;
- Volume 1 and 1.1 cover IDs/source fields are unchanged;
- Collection title/author/overview/selected artwork are unchanged;
- source rows contain normalized fields and snapshots;
- second identical apply reports unchanged records;
- a forced transaction error leaves no partial Aladin binding/source/base Volume.

- [ ] **Step 5: Run the apply test to verify it fails**

```powershell
cargo test library::aladin_flow::tests::applies_releases_without_overwriting_work_or_covers --lib
```

Expected: FAIL because reconciliation is missing.

- [ ] **Step 6: Implement transactional reconciliation**

Within one transaction, compare normalized stored fields to classify `added`, `updated`, and `unchanged`; insert missing edition-0 Volume rows with `sort_order = volume_number`; upsert source records; then upsert the binding/config/snapshot and sync time. Never delete source rows absent from the new response.

- [ ] **Step 7: Write and implement refresh identity tests**

Assert refresh accepts the prior anchor or a group with both the exact fingerprint and at least one known item ID. Assert `AmbiguousAladinBinding` when neither rule identifies exactly one group. Assert an omitted previously stored Volume remains in `collection_volume_sources`.

- [ ] **Step 8: Run the Aladin flow module tests**

```powershell
cargo test library::aladin_flow::tests --lib
```

Expected: all flow tests PASS.

- [ ] **Step 9: Commit Task 4**

```powershell
git add app/src-tauri/src/library/aladin_flow.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/error.rs
git commit -m "feat: synchronize Aladin volume releases"
```

---

### Task 5: Expose narrow Tauri commands and frontend gateway types

**Files:**
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: test gateway mocks returned by `rg -l "syncMangaDexVolumeCovers" app/src --glob "*.test.tsx"`
- Test: `app/src-tauri/src/commands.rs`
- Test: `app/src/library/LibraryContext.test.tsx`

**Interfaces:**
- Produces commands `get_aladin_credential_status`, `set_aladin_ttb_key`, `delete_aladin_ttb_key`, `search_aladin`, `apply_aladin`, `refresh_aladin`, and `get_aladin_connection`.
- Produces matching `LibraryGateway` methods. No method returns a TTB key.

```ts
getAladinCredentialStatus(): Promise<AladinCredentialStatus>;
setAladinTtbKey(ttbKey: string): Promise<AladinCredentialStatus>;
deleteAladinTtbKey(): Promise<AladinCredentialStatus>;
searchAladin(query: string): Promise<AladinSeriesCandidate[]>;
applyAladin(request: AladinApplyRequest): Promise<AladinSyncResult>;
refreshAladin(collectionId: string): Promise<AladinSyncResult>;
getAladinConnection(collectionId: string): Promise<AladinConnection | null>;
```

- [ ] **Step 1: Write failing command error-code tests**

Assert stable codes for missing credential, invalid key, invalid query, timeout, rate limit, invalid response, ambiguous binding, duplicate provider item, and unavailable credential store.

- [ ] **Step 2: Run the focused command test to verify it fails**

```powershell
cargo test commands::tests::aladin_errors_have_stable_codes --lib
```

Expected: FAIL because codes/commands are absent.

- [ ] **Step 3: Implement commands and register them**

Credential commands call `credential` directly. Provider commands obtain the key inside Rust, then call Library methods through `spawn_blocking`:

```rust
#[tauri::command]
pub async fn search_aladin(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<AladinSeriesCandidate>, CommandError> {
    let library = state.require_library()?;
    tauri::async_runtime::spawn_blocking(move || {
        let key = credential::read_aladin_key()?;
        library.search_aladin(&key, &query)
    }).await.map_err(|_| background_task_error())?.map_err(CommandError::from)
}
```

Do not include the key in any command argument for search/apply/refresh and do not define a read-key command.

- [ ] **Step 4: Add exact TypeScript DTOs and gateway methods**

Mirror Rust camelCase fields and extend `CollectionVolume`:

```ts
export type AladinCredentialStatus = { configured: boolean };
export type AladinConnection = { anchorItemId: string; query: string; lastSyncedAt: string | null };
export type AladinSyncResult = { added: number; updated: number; unchanged: number; ignored: number };

export type AladinVolumeCandidate = {
  volumeNumber: number;
  providerItemId: string;
  title: string;
  publicationDate: string | null;
  isbn13: string | null;
};

export type AladinSeriesCandidate = {
  anchorItemId: string;
  groupFingerprint: string;
  title: string;
  author: string | null;
  publisher: string | null;
  volumes: AladinVolumeCandidate[];
  ignoredCount: number;
};

export type AladinApplyRequest = {
  collectionId: string;
  query: string;
  anchorItemId: string;
  groupFingerprint: string;
};

export type CollectionVolume = {
  id: string;
  volumeNumber: number;
  editionIndex: number;
  displayLabel: string;
  coverArtworkId: string | null;
  localReleaseDate: string | null;
  isbn13: string | null;
  releaseStatus: "upcoming" | "released" | null;
};
```

Return credential status from commands through a write-only DTO:

```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AladinCredentialStatus {
    pub configured: bool,
}
```

Add deterministic no-op defaults to every existing full `LibraryGateway` test mock identified by the `rg` command in Files.

- [ ] **Step 5: Run the command test and one frontend interface check**

```powershell
cargo test commands::tests::aladin_errors_have_stable_codes --lib
cd C:\chatgpt\app
npm run build
```

Expected: command test PASS; TypeScript/Vite build exits 0. This is the one shared-interface build justified by broad gateway changes; do not repeat it later unless shared types change again.

- [ ] **Step 6: Commit Task 5**

```powershell
git add app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src/library/types.ts app/src/library/client.ts
rg -l "syncMangaDexVolumeCovers" app/src --glob "*.test.tsx" | ForEach-Object { git add -- $_ }
git commit -m "feat: expose Aladin provider commands"
```

Before committing, use `git diff --cached --name-only` to ensure `git add app/src` captured only intended gateway mock changes and no unrelated user files.

---

### Task 6: Add masked Aladin credential settings

**Files:**
- Modify: `app/src/settings/SettingsView.tsx`
- Modify: `app/src/settings/SettingsView.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes `getAladinCredentialStatus`, `setAladinTtbKey`, and `deleteAladinTtbKey` from Task 5.
- Produces no key-reading interface; the input clears after a successful save.

- [ ] **Step 1: Write the failing Settings interaction test**

Test this flow:

```ts
await user.click(screen.getByRole("button", { name: "외부 서비스" }));
expect(await screen.findByText("설정되지 않음")).toBeInTheDocument();
await user.type(screen.getByLabelText("알라딘 TTB 키"), "new-secret");
await user.click(screen.getByRole("button", { name: "저장" }));
expect(gateway.setAladinTtbKey).toHaveBeenCalledWith("new-secret");
expect(screen.getByLabelText("알라딘 TTB 키")).toHaveValue("");
expect(screen.getByText("설정됨")).toBeInTheDocument();
expect(screen.queryByDisplayValue("new-secret")).not.toBeInTheDocument();
```

Add remove confirmation coverage and assert the status call returns only `{ configured: true }`.

- [ ] **Step 2: Run the Settings test to verify it fails**

```powershell
npm test -- src/settings/SettingsView.test.tsx
```

Expected: FAIL because the section/actions are missing.

- [ ] **Step 3: Implement the compact external-services section**

Extend the section union with `external_services`. Use a native password input or the existing field interface if it supports `type="password"`, a quiet configured-status row, one standard save button, and a separate destructive remove confirmation. Never prefill the input.

Use existing settings property rows/separators and tokens; add only selectors needed for the inline credential row and status text.

- [ ] **Step 4: Run the Settings test to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```powershell
git add app/src/settings/SettingsView.tsx app/src/settings/SettingsView.test.tsx app/src/styles/global.css
git commit -m "feat: configure the Aladin credential"
```

---

### Task 7: Build the text-only Aladin connection dialog

**Files:**
- Create: `app/src/collections/AladinConnectDialog.tsx`
- Create: `app/src/collections/AladinConnectDialog.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes `searchAladin(query)` and `applyAladin(request)` from Task 5.
- Props:

```ts
type AladinConnectDialogProps = {
  open: boolean;
  collectionId: string;
  initialQuery: string;
  onClose: () => void;
  onApplied: (result: AladinSyncResult) => Promise<void> | void;
};
```

- [ ] **Step 1: Write failing dialog tests**

Cover:

- initial title is present but no request occurs until submit;
- one-character trimmed query is rejected locally;
- search returns grouped rows with title/author/publisher/volume range/count and no `img` elements;
- candidate selection reveals sorted parsed Volume summaries and ignored count;
- connect sends exactly `collectionId`, submitted query, anchor item ID, and fingerprint;
- success calls `onApplied`, then closes;
- empty, search error, apply error, and busy-disabled states remain in the dialog;
- Escape closes only when no request is pending and focus returns through the shared Dialog behavior.

- [ ] **Step 2: Run the dialog test to verify it fails**

```powershell
npm test -- src/collections/AladinConnectDialog.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the minimal dialog**

Reuse `Dialog`, `TextField`, `Button`, `Skeleton`, and existing error mapping. Render candidates as dense selectable rows and parsed Volumes as text rows. Do not add artwork URLs, image placeholders, or provider requests on mount/input change.

- [ ] **Step 4: Run the dialog test to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit Task 7**

```powershell
git add app/src/collections/AladinConnectDialog.tsx app/src/collections/AladinConnectDialog.test.tsx app/src/styles/global.css
git commit -m "feat: connect manga works to Aladin"
```

---

### Task 8: Integrate Aladin refresh and Korean release fields into the manga detail

**Files:**
- Modify: `app/src/collections/CollectionOverlay.tsx`
- Modify: `app/src/collections/CollectionOverlay.test.tsx`
- Modify: `app/src/collections/CollectionVolumePanel.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes `AladinConnectDialog`, `getAladinConnection`, `refreshAladin`, and projected `CollectionVolume` fields.
- Keeps MangaDex connection/refresh and cover synchronization unchanged.

- [ ] **Step 1: Write the failing overlay integration test**

Start with both provider connection methods. Assert:

```ts
expect(await screen.findByRole("button", { name: "MangaDex 새로고침" })).toBeInTheDocument();
await user.click(screen.getByRole("button", { name: "Aladin 연결" }));
expect(screen.getByRole("heading", { name: "Aladin 연결" })).toBeInTheDocument();
```

Then simulate an existing Aladin connection, click `Aladin 새로고침`, and assert:

- `refreshAladin(collection.id)` is called once;
- Volumes reload once after success;
- the selected Volume shows Korean publication date, ISBN13, and `출간 예정`/`출간됨`;
- existing thumbnail and original cover URLs are unchanged;
- a failed refresh leaves the shelf visible and reports a Toast;
- opening/closing the Aladin dialog does not trigger Collection-overlay Escape exit.

- [ ] **Step 2: Run the overlay test to verify it fails**

```powershell
npm test -- src/collections/CollectionOverlay.test.tsx
```

Expected: FAIL because Aladin controls and release fields are absent.

- [ ] **Step 3: Implement provider coexistence in `CollectionOverlay`**

Use separate states:

```ts
const [mangaDexConnection, setMangaDexConnection] = useState<MangaDexConnection | null | undefined>(undefined);
const [aladinConnection, setAladinConnection] = useState<AladinConnection | null | undefined>(undefined);
const [aladinOpen, setAladinOpen] = useState(false);
const [aladinRefreshing, setAladinRefreshing] = useState(false);
```

Keep the actions separate. On connect/refresh success, reload `listCollectionVolumes`, preserve the selected Volume ID when it still exists, update connection state, and show the returned counts in one compact message.

Guard the Collection-level Escape handler while either provider dialog or the cover viewer is open.

- [ ] **Step 4: Extend `CollectionVolumePanel` without adding a card**

Add nullable props for date, ISBN13, and release status and render them as existing property rows only when present. Format the ISO date deterministically for Korean UI without interpreting it as a UTC timestamp.

- [ ] **Step 5: Run the overlay test to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 6: Run one focused backend preservation check if Task 8 changed no Rust**

Do not rerun Rust tests: Task 8 changes only React/CSS, and the relevant Rust preservation test already passed in Task 4. Run `git diff --check` instead.

- [ ] **Step 7: Commit Task 8**

```powershell
git add app/src/collections/CollectionOverlay.tsx app/src/collections/CollectionOverlay.test.tsx app/src/collections/CollectionVolumePanel.tsx app/src/styles/global.css
git commit -m "feat: show Aladin releases in manga details"
```

---

## Completion review

- [ ] Compare `git diff main...HEAD` line by line with `docs/superpowers/specs/2026-08-21-aladin-volume-sync-design.md`.
- [ ] Confirm no TTB key, credential-bearing URL, old Flutter secret, or real provider response containing personal data is tracked: `git grep -n -i "ttbkey=" -- ':!docs/superpowers/plans/2026-08-21-aladin-volume-sync.md'` must return no credential values.
- [ ] Confirm search/dialog code contains no image URL field or `<img>` rendering.
- [ ] Confirm successful targeted evidence exists for migration, parser, credential facade, transactional sync, command codes, Settings, dialog, and Collection overlay.
- [ ] Do not run the full Rust/frontend suites or rebuild solely for completion; expand only if a targeted failure or cross-module mismatch identifies broader risk.
- [ ] Perform one manual smoke check only after the user configures a TTB key: save status, text-only search, connect one known manga, inspect Volume metadata, refresh, restart offline, and confirm cached release fields remain visible.
