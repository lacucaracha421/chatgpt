# Works v2 P1 Provider Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the active single-provider Collection contract with normalized multi-provider bindings while keeping local Work metadata authoritative and preserving legacy data.

**Architecture:** SQLite schema v13 adds `collection_external_bindings` keyed by `(collection_id, provider)`. A focused Library Module owns validation and persistence; Collection CRUD no longer reads or writes legacy provider columns, and the legacy book importer stores every discovered provider identity in the same transaction as its Collection.

**Tech Stack:** Rust, rusqlite/SQLite migrations, serde, Tauri command error mapping, TypeScript, Vitest

## Global Constraints

- Product language uses Work, while persistence and current code retain Collection naming.
- `collections` owns local user-visible metadata; provider refresh never mutates it implicitly.
- ExternalBinding owns provider identity, raw snapshot, and synchronization time.
- One Collection has at most one binding per provider and may have bindings for multiple providers.
- P1 adds no provider network call, provider Adapter Interface, Tauri binding command, React UI, WorkArtwork table, or artwork directory.
- Legacy single-provider columns remain physically present in schema v13 only to prevent silent loss of malformed legacy data; active code must not read or write them.
- Use no new dependency.
- Preserve unrelated untracked workspace files.

---

### Task 1: Add schema v13 and lossless legacy backfill

**Files:**
- Create: `app/src-tauri/migrations/0013_collection_external_bindings.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/backup.rs`

**Interfaces:**
- Consumes: v12 `collections.external_id`, `external_source`, `external_synced_at`, and `external_metadata_json`.
- Produces: schema v13 table `collection_external_bindings` with primary key `(collection_id, provider)` and lookup index `(provider, external_id)`.

- [ ] **Step 1: Write the failing v12-to-v13 migration test**

Add a `migrates_v12_external_identity_to_normalized_binding` test in `db.rs`. Build a v12 in-memory database from all schema constants through `COLLECTION_SOURCE_SCHEMA`, insert one complete legacy identity and one incomplete identity, then assert the complete row is normalized and the incomplete legacy value remains present.

```rust
#[test]
fn migrates_v12_external_identity_to_normalized_binding() {
    let mut connection = Connection::open_in_memory().unwrap();
    for schema in [
        INITIAL_SCHEMA,
        VAULT_SAFETY_SCHEMA,
        SIMILARITY_REVIEW_SCHEMA,
        VIDEO_MEDIA_SCHEMA,
        MANGA_SCHEMA,
        MANGA_MODIFIED_SCHEMA,
        CLASSIFICATION_APPEARANCE_SCHEMA,
        ASSET_ALBUMS_SCHEMA,
        ASSET_SOURCE_PROVENANCE_SCHEMA,
        COLLECTIONS_SCHEMA,
        COLLECTIONS_TYPED_SCHEMA,
        COLLECTION_SOURCE_SCHEMA,
    ] {
        connection.execute_batch(schema).unwrap();
    }
    connection.execute(
        "INSERT INTO collections (
            id, name, description, type, cover_asset_id, year, author, director,
            external_score, my_score, genres, overview, external_id,
            external_source, external_synced_at, showcase, external_metadata_json,
            created_at, updated_at, source_path
         ) VALUES (
            'work-1', 'Work One', NULL, 'manga', NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, ' md-1 ', ' MangaDex ',
            '2026-08-20T01:02:03Z', 0, '{\"title\":\"Provider title\"}',
            '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', NULL
         )",
        [],
    ).unwrap();
    connection.execute(
        "INSERT INTO collections (
            id, name, description, type, cover_asset_id, year, author, director,
            external_score, my_score, genres, overview, external_id,
            external_source, external_synced_at, showcase, external_metadata_json,
            created_at, updated_at, source_path
         ) VALUES (
            'work-2', 'Work Two', NULL, 'manga', NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, 'legacy-only', NULL, 0, 'raw-only',
            '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z', NULL
         )",
        [],
    ).unwrap();

    migrate_to_latest(&mut connection, 12).unwrap();

    let migrated: (String, String, Option<String>, Option<String>) = connection
        .query_row(
            "SELECT provider, external_id, provider_data_json, last_synced_at
             FROM collection_external_bindings WHERE collection_id = 'work-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(migrated.0, "mangadex");
    assert_eq!(migrated.1, "md-1");
    assert_eq!(migrated.2.as_deref(), Some("{\"title\":\"Provider title\"}"));
    assert_eq!(migrated.3.as_deref(), Some("2026-08-20T01:02:03Z"));
    assert_eq!(
        connection.query_row(
            "SELECT external_source FROM collections WHERE id = 'work-2'",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap(),
        "legacy-only"
    );
    assert_eq!(
        connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(),
        13
    );
}
```

- [ ] **Step 2: Run the migration test and verify it fails**

Run from `C:\chatgpt`:

```powershell
cargo test library::db::tests::migrates_v12_external_identity_to_normalized_binding --manifest-path app/src-tauri/Cargo.toml
```

Expected: FAIL because `collection_external_bindings` does not exist and schema version is still 12.

- [ ] **Step 3: Add the v13 SQL migration**

Create `0013_collection_external_bindings.sql` with the complete schema and guarded backfill:

```sql
CREATE TABLE collection_external_bindings (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
    external_id TEXT NOT NULL CHECK (length(trim(external_id)) > 0),
    provider_data_json TEXT,
    last_synced_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (collection_id, provider)
);

CREATE INDEX collection_external_bindings_by_identity
ON collection_external_bindings(provider, external_id);

INSERT INTO collection_external_bindings (
    collection_id, provider, external_id, provider_data_json,
    last_synced_at, created_at, updated_at
)
SELECT
    id,
    lower(trim(external_source)),
    trim(external_id),
    external_metadata_json,
    external_synced_at,
    created_at,
    updated_at
FROM collections
WHERE external_source IS NOT NULL
  AND external_id IS NOT NULL
  AND length(trim(external_source)) > 0
  AND length(trim(external_id)) > 0;

PRAGMA user_version = 13;
```

- [ ] **Step 4: Register schema v13 in the migration runner**

In `db.rs`, set `SCHEMA_VERSION` to 13, include the new SQL, accept versions through 12, and execute it when `version <= 12`.

```rust
pub(crate) const SCHEMA_VERSION: i64 = 13;
const COLLECTION_EXTERNAL_BINDINGS_SCHEMA: &str =
    include_str!("../../migrations/0013_collection_external_bindings.sql");

// open_database match arm
version @ 0..=12 => {
    if version > 0 {
        let root = path
            .parent()
            .expect("database paths have a parent directory");
        let snapshot = backup::pre_migration_snapshot_path(root, version);
        backup::create_verified_snapshot(&connection, &snapshot)?;
    }
    migrate_to_latest(&mut connection, version)?;
}

// final migrate_to_latest step
if version <= 12 {
    transaction.execute_batch(COLLECTION_EXTERNAL_BINDINGS_SCHEMA)?;
}
```

Replace existing migration test assertions that hard-code `12` with `SCHEMA_VERSION`. In `backup.rs`, make the unsupported future schema test derive the next version rather than hard-code the newly supported 13.

```rust
let unsupported = db::SCHEMA_VERSION + 1;
source
    .execute_batch(&format!("PRAGMA user_version = {unsupported};"))
    .unwrap();
```

- [ ] **Step 5: Run migration and backup tests**

```powershell
cargo test library::db::tests --manifest-path app/src-tauri/Cargo.toml
cargo test library::backup::tests::verified_snapshot_removes_an_unsupported_schema_version --manifest-path app/src-tauri/Cargo.toml
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit the schema change**

```powershell
git add app/src-tauri/migrations/0013_collection_external_bindings.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/backup.rs
git commit -m "Add normalized collection provider bindings schema"
```

---

### Task 2: Add the ExternalBinding persistence Module

**Files:**
- Create: `app/src-tauri/src/library/external_binding.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/library/collection.rs`
- Modify: `app/src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: `collection_external_bindings` from Task 1 and existing Collection existence validation.
- Produces: `Library::list_collection_external_bindings(&str) -> Result<Vec<ExternalBinding>, LibraryError>`, `Library::upsert_collection_external_binding(&str, ExternalBindingInput) -> Result<ExternalBinding, LibraryError>`, and a crate-private connection-level upsert used by Task 4.

- [ ] **Step 1: Define binding input/output models and the validation error**

Add these models in `models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBindingInput {
    pub provider: String,
    pub external_id: String,
    pub provider_data_json: Option<String>,
    pub last_synced_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalBinding {
    pub provider: String,
    pub external_id: String,
    pub provider_data_json: Option<String>,
    pub last_synced_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}
```

Add one validation error to `LibraryError` and its exhaustive Tauri code mapping:

```rust
#[error("외부 연결의 provider와 외부 ID는 비어 있을 수 없습니다")]
InvalidExternalBinding,
```

```rust
LibraryError::InvalidExternalBinding => "invalid_external_binding",
```

- [ ] **Step 2: Write failing tests through the Library Interface**

In the new `external_binding.rs`, add tests that create a Collection with the existing `CreateCollection` Interface and prove normalization, multiple providers, same-provider replacement, invalid input rejection, missing Collection rejection, and delete cascade.

```rust
#[test]
fn stores_multiple_normalized_bindings_and_replaces_one_provider() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let work = library.create_collection(CreateCollection {
        name: "Dungeon Meshi".into(),
        description: None,
        collection_type: CollectionType::Manga,
    }).unwrap();

    library.upsert_collection_external_binding(&work.id, ExternalBindingInput {
        provider: " MangaDex ".into(),
        external_id: " md-1 ".into(),
        provider_data_json: Some("{\"title\":\"Dungeon Meshi\"}".into()),
        last_synced_at: Some("2026-08-20T01:00:00Z".into()),
    }).unwrap();
    library.upsert_collection_external_binding(&work.id, ExternalBindingInput {
        provider: "aladin".into(),
        external_id: "item-1".into(),
        provider_data_json: None,
        last_synced_at: None,
    }).unwrap();
    library.upsert_collection_external_binding(&work.id, ExternalBindingInput {
        provider: "MANGADEX".into(),
        external_id: "md-2".into(),
        provider_data_json: Some("{\"title\":\"Delicious in Dungeon\"}".into()),
        last_synced_at: Some("2026-08-20T02:00:00Z".into()),
    }).unwrap();

    let bindings = library.list_collection_external_bindings(&work.id).unwrap();
    assert_eq!(bindings.len(), 2);
    assert_eq!(bindings[0].provider, "aladin");
    assert_eq!(bindings[1].provider, "mangadex");
    assert_eq!(bindings[1].external_id, "md-2");
}
```

Add separate assertions:

```rust
assert!(matches!(
    library.upsert_collection_external_binding(&work.id, ExternalBindingInput {
        provider: "  ".into(), external_id: "id".into(),
        provider_data_json: None, last_synced_at: None,
    }),
    Err(LibraryError::InvalidExternalBinding)
));
assert!(matches!(
    library.list_collection_external_bindings("missing"),
    Err(LibraryError::CollectionNotFound)
));

library.delete_collection(&work.id).unwrap();
let count: i64 = library.connection().unwrap().query_row(
    "SELECT COUNT(*) FROM collection_external_bindings WHERE collection_id = ?1",
    [&work.id],
    |row| row.get(0),
).unwrap();
assert_eq!(count, 0);
```

- [ ] **Step 3: Run the Module tests and verify they fail**

```powershell
cargo test library::external_binding::tests --manifest-path app/src-tauri/Cargo.toml
```

Expected: FAIL because the module and Library methods do not exist.

- [ ] **Step 4: Implement the focused persistence Module**

Register `mod external_binding;` in `library/mod.rs`. Make `collection::require_collection` crate-visible so both Collection and binding persistence use the same existence rule.

Implement a small public Library Interface plus a crate-private helper. The helper accepts an explicit timestamp so a surrounding book-import transaction can use one timestamp consistently.

```rust
pub(crate) fn upsert_external_binding(
    connection: &Connection,
    collection_id: &str,
    input: ExternalBindingInput,
    now: &str,
) -> Result<ExternalBinding, LibraryError> {
    super::collection::require_collection(connection, collection_id)?;
    let provider = input.provider.trim().to_ascii_lowercase();
    let external_id = input.external_id.trim().to_owned();
    if provider.is_empty() || external_id.is_empty() {
        return Err(LibraryError::InvalidExternalBinding);
    }
    connection.execute(
        "INSERT INTO collection_external_bindings (
            collection_id, provider, external_id, provider_data_json,
            last_synced_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(collection_id, provider) DO UPDATE SET
            external_id = excluded.external_id,
            provider_data_json = excluded.provider_data_json,
            last_synced_at = excluded.last_synced_at,
            updated_at = excluded.updated_at",
        params![collection_id, provider, external_id, input.provider_data_json,
                input.last_synced_at, now],
    )?;
    binding_by_provider(connection, collection_id, &provider)
}
```

`list_collection_external_bindings` first requires the Collection and returns rows ordered by normalized provider. The Library upsert wrapper obtains a connection and passes one RFC 3339 UTC timestamp.

```rust
impl Library {
    pub fn list_collection_external_bindings(
        &self,
        collection_id: &str,
    ) -> Result<Vec<ExternalBinding>, LibraryError> {
        let connection = self.connection()?;
        super::collection::require_collection(&connection, collection_id)?;
        let mut statement = connection.prepare(
            "SELECT provider, external_id, provider_data_json, last_synced_at,
                    created_at, updated_at
             FROM collection_external_bindings
             WHERE collection_id = ?1
             ORDER BY provider COLLATE NOCASE",
        )?;
        Ok(statement
            .query_map([collection_id], binding_from_row)?
            .collect::<Result<Vec<_>, _>>()?)
    }

    pub fn upsert_collection_external_binding(
        &self,
        collection_id: &str,
        input: ExternalBindingInput,
    ) -> Result<ExternalBinding, LibraryError> {
        let now = chrono::Utc::now().to_rfc3339();
        upsert_external_binding(&self.connection()?, collection_id, input, &now)
    }
}

fn binding_by_provider(
    connection: &Connection,
    collection_id: &str,
    provider: &str,
) -> Result<ExternalBinding, LibraryError> {
    Ok(connection.query_row(
        "SELECT provider, external_id, provider_data_json, last_synced_at,
                created_at, updated_at
         FROM collection_external_bindings
         WHERE collection_id = ?1 AND provider = ?2",
        params![collection_id, provider],
        binding_from_row,
    )?)
}

fn binding_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExternalBinding> {
    Ok(ExternalBinding {
        provider: row.get(0)?,
        external_id: row.get(1)?,
        provider_data_json: row.get(2)?,
        last_synced_at: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}
```

- [ ] **Step 5: Run the focused tests and Rust formatting**

```powershell
cargo test library::external_binding::tests --manifest-path app/src-tauri/Cargo.toml
cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check
```

Expected: tests PASS and formatting check exits 0. If formatting check fails, run `cargo fmt --manifest-path app/src-tauri/Cargo.toml`, then rerun both commands.

- [ ] **Step 6: Commit the Module**

```powershell
git add app/src-tauri/src/library/external_binding.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/error.rs app/src-tauri/src/library/collection.rs app/src-tauri/src/commands.rs
git commit -m "Add collection external binding repository"
```

---

### Task 3: Remove legacy provider identity from the active Collection contract

**Files:**
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/collection.rs`

**Interfaces:**
- Consumes: ExternalBinding Library Interface from Task 2.
- Produces: `CollectionSummary` containing only local Work fields; Collection create/edit SQL that never writes legacy provider columns.

- [ ] **Step 1: Rewrite the P0 regression test against ExternalBinding**

In `collection.rs`, change `ordinary_edit_preserves_imported_metadata_and_provider_identity` so it stores provider state through Task 2 rather than by updating legacy columns.

```rust
library.upsert_collection_external_binding(&created.id, ExternalBindingInput {
    provider: "mangadex".into(),
    external_id: "provider-42".into(),
    provider_data_json: Some("{\"title\":\"Provider title\"}".into()),
    last_synced_at: Some("2026-08-20T01:02:03Z".into()),
}).unwrap();

let before = library.list_collection_external_bindings(&created.id).unwrap();
let updated = library.update_collection(&created.id, UpdateCollection {
    name: "Renamed Work".into(),
    description: None,
    collection_type: CollectionType::Manga,
    year: Some(2024),
    author: Some("Imported Author".into()),
    director: None,
    external_score: None,
    my_score: Some(9),
}).unwrap();
let after = library.list_collection_external_bindings(&created.id).unwrap();

assert_eq!(updated.genres.as_deref(), Some("Fantasy"));
assert_eq!(updated.overview.as_deref(), Some("Imported overview"));
assert_eq!(after, before);
```

Add a model serialization test proving `externalId`, `externalSource`, and `externalSyncedAt` are absent from `CollectionSummary` JSON.

- [ ] **Step 2: Run the affected tests and verify the serialization test fails**

```powershell
cargo test ordinary_edit_preserves_imported_metadata_and_provider_identity --manifest-path app/src-tauri/Cargo.toml
cargo test collection_summary_omits_legacy_provider_identity --manifest-path app/src-tauri/Cargo.toml
```

Expected: the P0 test does not compile until imports are adjusted, and the serialization assertion FAILS while legacy fields remain.

- [ ] **Step 3: Remove legacy fields from CollectionSummary and its SQL mapper**

Delete these fields from the Rust `CollectionSummary`:

```rust
pub external_id: Option<String>,
pub external_source: Option<String>,
pub external_synced_at: Option<String>,
```

Remove the three columns from `COLLECTION_SUMMARY_SQL`. Reindex row mapping so `showcase`, `created_at`, `updated_at`, and `source_path` read indexes 13, 14, 15, and 16 respectively.

Change `create_collection` to omit all four legacy provider columns while leaving their physical nullable columns untouched:

```sql
INSERT INTO collections (
    id, name, description, type, cover_asset_id,
    year, author, director, external_score, my_score,
    genres, overview, showcase, created_at, updated_at
) VALUES (
    ?1, ?2, ?3, ?4, NULL,
    NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, 0, ?5, ?5
)
```

- [ ] **Step 4: Run the Collection and model tests**

```powershell
cargo test library::collection::tests --manifest-path app/src-tauri/Cargo.toml
cargo test library::models::tests --manifest-path app/src-tauri/Cargo.toml
```

Expected: all selected tests PASS.

- [ ] **Step 5: Commit the active contract cleanup**

```powershell
git add app/src-tauri/src/library/models.rs app/src-tauri/src/library/collection.rs
git commit -m "Move provider identity out of collection summaries"
```

---

### Task 4: Import every legacy provider identity atomically

**Files:**
- Modify: `app/src-tauri/src/library/book_migration.rs`

**Interfaces:**
- Consumes: crate-private `external_binding::upsert_external_binding` from Task 2.
- Produces: serialized `BookImportEntry.external_bindings` containing every parsed `{ provider, externalId }`; per-Collection import transaction that writes the Collection and all bindings together.

- [ ] **Step 1: Write failing parser and transaction tests**

Replace the single-ID parser assertion with a multi-binding assertion:

```rust
#[test]
fn parses_every_game_provider_identity() {
    let fields = parse_key_value(
        "Steam App ID: 1245620\nIGDB ID: 119133\nTitle: Elden Ring\nType: game\n"
    );
    assert_eq!(
        external_bindings(&fields),
        vec![
            BookExternalBinding { provider: "steam".into(), external_id: "1245620".into() },
            BookExternalBinding { provider: "igdb".into(), external_id: "119133".into() },
        ]
    );
}
```

Add a transaction test with one valid and one blank binding. Call the connection-level import helper and assert neither Collection nor binding remains.

```rust
let entry = BookImportEntry {
    folder: "Elden Ring".into(),
    relative_path: "Elden Ring".into(),
    collection_type: CollectionType::Game,
    name: "Elden Ring".into(),
    year: Some(2022),
    author: Some("FromSoftware".into()),
    director: None,
    my_score: None,
    genres: None,
    overview: None,
    external_bindings: vec![
        BookExternalBinding { provider: "steam".into(), external_id: "1245620".into() },
        BookExternalBinding { provider: "igdb".into(), external_id: "   ".into() },
    ],
};
assert!(upsert_collection(&connection, &entry).is_err());
assert_eq!(connection.query_row("SELECT COUNT(*) FROM collections", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
assert_eq!(connection.query_row("SELECT COUNT(*) FROM collection_external_bindings", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
```

- [ ] **Step 2: Run the focused tests and verify they fail**

```powershell
cargo test library::book_migration::tests::parses_every_game_provider_identity --manifest-path app/src-tauri/Cargo.toml
cargo test library::book_migration::tests::binding_failure_rolls_back_collection_import --manifest-path app/src-tauri/Cargo.toml
```

Expected: FAIL because `BookExternalBinding`, `external_bindings`, and transactional import do not exist.

- [ ] **Step 3: Replace the singular legacy identity model**

Define the serialized preview identity beside `BookImportEntry`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BookExternalBinding {
    pub provider: String,
    pub external_id: String,
}
```

Replace `external_id` and `external_source` in `BookImportEntry` and `ParsedInfo` with:

```rust
pub external_bindings: Vec<BookExternalBinding>,
```

Implement deterministic extraction of every nonblank known ID:

```rust
fn external_bindings(fields: &[(String, String)]) -> Vec<BookExternalBinding> {
    [
        ("TMDB ID", "tmdb"),
        ("Steam App ID", "steam"),
        ("IGDB ID", "igdb"),
        ("MangaDex ID", "mangadex"),
    ]
    .into_iter()
    .filter_map(|(key, provider)| {
        let external_id = first_value(fields, key)?.trim();
        (!external_id.is_empty()).then(|| BookExternalBinding {
            provider: provider.into(),
            external_id: external_id.into(),
        })
    })
    .collect()
}
```

- [ ] **Step 4: Make each imported Collection atomic**

Remove legacy provider columns from the Collection insert. Open an unchecked transaction inside `upsert_collection`, insert the local Collection, then write every binding using the Task 2 helper before commit.

```rust
let transaction = connection.unchecked_transaction().map_err(|error| error.to_string())?;
transaction.execute(
    "INSERT INTO collections (
        id, name, description, type, cover_asset_id,
        year, author, director, external_score, my_score,
        genres, overview, showcase, created_at, updated_at, source_path
     ) VALUES (
        ?1, ?2, NULL, ?3, NULL,
        ?4, ?5, ?6, NULL, ?7,
        ?8, ?9, 0, ?10, ?10, ?11
     )",
    params![id, name, type_str, entry.year, entry.author, entry.director,
            entry.my_score, entry.genres, entry.overview, now, entry.relative_path],
).map_err(|error| map_duplicate_name_err(error, &entry.name))?;

for identity in &entry.external_bindings {
    super::external_binding::upsert_external_binding(
        &transaction,
        &id,
        ExternalBindingInput {
            provider: identity.provider.clone(),
            external_id: identity.external_id.clone(),
            provider_data_json: None,
            last_synced_at: Some(now.clone()),
        },
        &now,
    ).map_err(|error| error.to_string())?;
}
transaction.commit().map_err(|error| error.to_string())?;
```

- [ ] **Step 5: Run all book migration tests**

```powershell
cargo test library::book_migration::tests --manifest-path app/src-tauri/Cargo.toml
```

Expected: all selected tests PASS, including both-provider parsing and rollback.

- [ ] **Step 6: Commit the importer change**

```powershell
git add app/src-tauri/src/library/book_migration.rs
git commit -m "Import all collection provider bindings"
```

---

### Task 5: Align frontend contracts and fixtures

**Files:**
- Modify: `app/src/library/types.ts`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/assets/AssetInspector.test.tsx`
- Modify: `app/src/assets/AssetToolbar.test.tsx`
- Modify: `app/src/collections/CollectionBrowser.test.tsx`
- Modify: `app/src/collections/CollectionEditDialog.test.tsx`

**Interfaces:**
- Consumes: Rust serde shapes from Tasks 3 and 4.
- Produces: TypeScript `CollectionSummary` without legacy provider fields and `BookImportEntry.externalBindings` matching Rust serialization.

- [ ] **Step 1: Change TypeScript contracts first and observe fixture failures**

Remove these properties from `CollectionSummary`:

```ts
externalId: string | null;
externalSource: string | null;
externalSyncedAt: string | null;
```

Add the book preview identity and replace the two singular fields:

```ts
export type BookExternalBinding = {
  provider: string;
  externalId: string;
};

export type BookImportEntry = {
  folder: string;
  collectionType: CollectionType;
  name: string;
  year: number | null;
  author: string | null;
  director: string | null;
  myScore: number | null;
  genres: string | null;
  overview: string | null;
  externalBindings: BookExternalBinding[];
};
```

Run:

```powershell
Set-Location C:\chatgpt\app
npx tsc --noEmit
```

Expected: FAIL where test fixtures still provide removed `CollectionSummary` properties.

- [ ] **Step 2: Update every typed fixture**

Delete only `externalId`, `externalSource`, and `externalSyncedAt` from CollectionSummary literals in the listed tests. In `CollectionEditDialog.test.tsx`, keep the imported `genres` and `overview` values because that regression still verifies ordinary edits preserve local metadata.

No production UI should read the removed properties. Confirm the remaining external ID occurrence belongs only to `BookExternalBinding`:

```powershell
rg -n "externalSource|externalSyncedAt" C:\chatgpt\app\src
```

Expected: no matches.

- [ ] **Step 3: Run type checking and affected frontend tests**

```powershell
Set-Location C:\chatgpt\app
npx tsc --noEmit
npx vitest run src/collections/CollectionEditDialog.test.tsx src/collections/CollectionBrowser.test.tsx src/assets/AssetBrowser.test.tsx src/assets/AssetInspector.test.tsx src/assets/AssetToolbar.test.tsx src/app/App.test.tsx
```

Expected: type checking exits 0 and all selected tests PASS.

- [ ] **Step 4: Commit the frontend contract alignment**

```powershell
Set-Location C:\chatgpt
git add app/src/library/types.ts app/src/app/App.test.tsx app/src/assets/AssetBrowser.test.tsx app/src/assets/AssetInspector.test.tsx app/src/assets/AssetToolbar.test.tsx app/src/collections/CollectionBrowser.test.tsx app/src/collections/CollectionEditDialog.test.tsx
git commit -m "Align collection contracts with provider bindings"
```

---

### Task 6: Verify P1 as an integrated change

**Files:**
- Verify only; no planned file changes.

**Interfaces:**
- Consumes: all deliverables from Tasks 1–5.
- Produces: evidence that schema migration, normalized binding ownership, legacy import, Rust contracts, and frontend contracts work together.

- [ ] **Step 1: Format and inspect active legacy references**

```powershell
Set-Location C:\chatgpt
cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check
rg -n "external_source|external_synced_at|external_metadata_json" app/src-tauri/src/library --glob "*.rs"
```

Expected: formatting exits 0. Remaining legacy-column references are confined to the v12-to-v13 migration test; active Collection and book-import SQL have none.

- [ ] **Step 2: Run the complete Rust suite**

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml
```

Expected: all Rust tests PASS. Existing ignored tests may remain ignored.

- [ ] **Step 3: Run complete frontend type and test suites**

```powershell
Set-Location C:\chatgpt\app
npx tsc --noEmit
npx vitest run
```

Expected: type checking exits 0 and all Vitest tests PASS. The known duplicate React key warning in `ClassificationSidebar.test.tsx` does not count as a P1 failure unless the warning becomes a test failure.

- [ ] **Step 4: Verify repository scope and commit history**

```powershell
Set-Location C:\chatgpt
git diff --check
git status --short --branch
git log -6 --oneline
```

Expected: `git diff --check` exits 0; only the pre-existing unrelated untracked files remain; the P1 implementation is represented by the focused commits from Tasks 1–5.
