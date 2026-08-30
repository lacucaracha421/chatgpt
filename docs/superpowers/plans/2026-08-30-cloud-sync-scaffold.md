# Lakomics Cloud Sync Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Lakomics' authoritative local asset commit while recording durable, path-independent work for a future one-way cloud upload.

**Architecture:** Add a transactional outbox to the existing library SQLite database. The local ingestion transaction records a pending asset upsert without reading cloud configuration or contacting the network; a crate-internal cloud Module can then load one pending asset and prepare its stable R2 object key.

**Tech Stack:** Rust 2021, rusqlite, SQLite migrations, uuid, chrono, existing Lakomics `Library` Module

**Spec:** `docs/superpowers/specs/2026-08-30-cloud-sync-scaffold-design.md`

## Global Constraints

- The local Lakomics library remains authoritative.
- Cloud configuration absence and all future remote failures must leave local ingestion usable.
- Do not open or write `C:\New_lakomics_assets`; use only temporary test libraries.
- Do not add R2 credentials, HTTP upload behavior, a worker, retry scheduling, commands, or frontend UI.
- Do not add dependencies or modify the user's existing `app/package.json` and `app/src-tauri/Cargo.toml` changes.
- Do not commit or push.
- Object keys use stable asset UUIDs, never local paths, titles, or original filenames.

---

### Task 1: Schema 28 transactional outbox

**Files:**
- Create: `app/src-tauri/migrations/0028_cloud_sync_queue.sql`
- Modify: `app/src-tauri/src/library/db.rs`

**Interfaces:**
- Produces: `cloud_sync_queue` and the `library_settings.cloud_sync_enabled` / `cloud_api_base_url` columns.
- Produces: `CLOUD_SYNC_QUEUE_SCHEMA` registered as migration 28.

- [ ] **Step 1: Write the failing v27 migration test**

Add `migrates_v27_to_cloud_queue_with_disabled_defaults` to `library/db.rs`. Construct an in-memory v27 database by applying the existing schemas through `REVISIT_SCHEMA`, call `migrate_to_latest(&mut connection, 27)`, then assert literal outcomes:

```rust
assert_eq!(
    connection.query_row(
        "SELECT cloud_sync_enabled FROM library_settings WHERE singleton = 1",
        [],
        |row| row.get::<_, i64>(0),
    ).unwrap(),
    0,
);
assert_eq!(
    connection.query_row(
        "SELECT cloud_api_base_url FROM library_settings WHERE singleton = 1",
        [],
        |row| row.get::<_, Option<String>>(0),
    ).unwrap(),
    None,
);
assert_eq!(
    connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(),
    28,
);
```

Insert one valid pending row, then verify a duplicate `(entity_type, entity_id, operation, revision)` and an unsupported status are rejected. These mutations catch missing UNIQUE and CHECK constraints.

- [ ] **Step 2: Run the targeted test and verify RED**

Run:

```powershell
cargo test --lib library::db::tests::migrates_v27_to_cloud_queue_with_disabled_defaults -- --exact
```

Working directory: `app/src-tauri`  
Expected: FAIL because migration 28 and its columns/table do not exist.

- [ ] **Step 3: Add the minimal migration**

Create `0028_cloud_sync_queue.sql` with:

```sql
ALTER TABLE library_settings
ADD COLUMN cloud_sync_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (cloud_sync_enabled IN (0, 1));

ALTER TABLE library_settings ADD COLUMN cloud_api_base_url TEXT;

CREATE TABLE cloud_sync_queue (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    entity_type TEXT NOT NULL CHECK (entity_type = 'asset'),
    entity_id TEXT NOT NULL CHECK (length(trim(entity_id)) > 0),
    operation TEXT NOT NULL CHECK (operation = 'upsert'),
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'synced', 'failed')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    updated_at TEXT NOT NULL,
    synced_at TEXT,
    last_error TEXT,
    UNIQUE (entity_type, entity_id, operation, revision)
);

CREATE INDEX cloud_sync_queue_by_status
ON cloud_sync_queue(status, updated_at, id);

PRAGMA user_version = 28;
```

In `db.rs`, set `SCHEMA_VERSION` to 28, include the new SQL, accept versions through 27, and execute it when `version <= 27`.

- [ ] **Step 4: Run the targeted migration test and verify GREEN**

Run the Step 2 command. Expected: PASS.

---

### Task 2: Queue and one-asset preparation Module

**Files:**
- Create: `app/src-tauri/src/cloud/mod.rs`
- Create: `app/src-tauri/src/cloud/models.rs`
- Create: `app/src-tauri/src/cloud/queue.rs`
- Create: `app/src-tauri/src/cloud/sync.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/commands.rs`

**Interfaces:**
- Produces: `queue::enqueue_asset_upsert(&rusqlite::Transaction<'_>, &str, &str) -> Result<(), LibraryError>`.
- Produces: `Library::cloud_sync_config() -> Result<CloudSyncConfig, LibraryError>`.
- Produces: `Library::set_cloud_sync_config(CloudSyncConfig) -> Result<CloudSyncConfig, LibraryError>`.
- Produces: `Library::cloud_sync_queue_item(&str) -> Result<Option<CloudSyncQueueItem>, LibraryError>`.
- Produces: `Library::prepare_next_asset_upload() -> Result<Option<PreparedAssetUpload>, LibraryError>`.

- [ ] **Step 1: Write failing tests for default configuration and path-independent upload preparation**

In `cloud/mod.rs`, add crate-local tests using `tempfile::tempdir()` and `Library::open()`.

The first test asserts the exact default, stores `https://sync.example.test/v1`, and loads the same non-secret configuration:

```rust
assert_eq!(
    library.cloud_sync_config().unwrap(),
    CloudSyncConfig { enabled: false, api_base_url: None },
);
let configured = CloudSyncConfig {
    enabled: true,
    api_base_url: Some("https://sync.example.test/v1".into()),
};
assert_eq!(library.set_cloud_sync_config(configured.clone()).unwrap(), configured);
assert_eq!(library.cloud_sync_config().unwrap(), configured);
```

A separate safety test passes `https://user:secret@sync.example.test/v1` and asserts `LibraryError::InvalidCloudSyncConfig`; it then reloads the default to prove rejected input was not persisted.

A queue-loading test inserts one literal row with ID `queue-1`, calls `cloud_sync_queue_item("queue-1")`, and compares every suggested queue field to hand-written values. This catches incomplete row mapping independently of upload preparation.

The second test inserts a literal normal image asset and pending queue row through the temporary library connection, calls `prepare_next_asset_upload`, and asserts:

```rust
assert_eq!(prepared.queue.entity_id, asset_id);
assert_eq!(prepared.object_key, format!("images/{asset_id}/original"));
assert_eq!(prepared.source_path, library.root().join("assets/local-title.png"));
assert!(!prepared.object_key.contains("local-title"));
assert!(!prepared.object_key.contains(&library.root().to_string_lossy().to_string()));
```

Use a literal valid UUID for `asset_id`. This catches an implementation that derives an R2 key from mutable or machine-specific paths.

- [ ] **Step 2: Run the cloud tests and verify RED**

Run:

```powershell
cargo test --lib cloud::tests
```

Expected: FAIL because the cloud Module and interfaces do not exist.

- [ ] **Step 3: Implement minimal models and queue reads**

Define only these data types in `models.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CloudSyncConfig {
    pub enabled: bool,
    pub api_base_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CloudSyncQueueItem {
    pub id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub operation: String,
    pub status: String,
    pub revision: u64,
    pub retry_count: u32,
    pub updated_at: String,
    pub synced_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PreparedAssetUpload {
    pub queue: CloudSyncQueueItem,
    pub object_key: String,
    pub source_path: std::path::PathBuf,
}
```

In `queue.rs`, map rows in one private `queue_item` helper, load configuration from the singleton settings row, load a queue item by ID, and insert revision 1 using a generated queue UUID. `set_cloud_sync_config` trims and parses the URL with the existing `url` dependency, accepts only `http`/`https`, rejects embedded username/password and fragments, and requires a URL when enabled. Validation happens before the settings update. Keep all functions crate-private.

Add `LibraryError::InvalidCloudSyncConfig` in `library/error.rs` and the stable internal command mapping `invalid_cloud_sync_config` in `commands.rs`; no Tauri command exposes it yet.

In `sync.rs`, query the oldest pending `asset/upsert` joined to a normal asset. Parse the asset ID with `uuid::Uuid::parse_str` before formatting `images/{id}/original` for `image`/`gif` or `videos/{id}/original` for `video`. Resolve the local source as `library.root().join(relative_path)`; the path is never included in the object key.

Register `mod cloud;` in `lib.rs`. Do not add `client.rs`: no remote contract exists in this milestone.

- [ ] **Step 4: Run the cloud tests and verify GREEN**

Run the Step 2 command. Expected: both tests PASS.

---

### Task 3: Enqueue only after a durable normal asset commit is possible

**Files:**
- Modify: `app/src-tauri/src/library/ingestion.rs`

**Interfaces:**
- Consumes: `cloud::queue::enqueue_asset_upsert` from Task 2.
- Preserves: `Library::ingest_media(IngestMediaRequest) -> Result<IngestOutcome, LibraryError>`.

- [ ] **Step 1: Write the failing ingestion queue test**

Add `successful_asset_commit_creates_one_pending_cloud_upsert` beside existing ingestion tests. Use `IngestionFixture::ingest()`, extract the added asset ID, and load its queue row through `cloud_sync_queue_item`:

```rust
let outcome = fixture.ingest();
let IngestOutcome::Added { asset } = outcome else { panic!("expected added asset") };
let count = fixture.library.connection().unwrap().query_row(
    "SELECT COUNT(*) FROM cloud_sync_queue
     WHERE entity_type = 'asset' AND entity_id = ?1
       AND operation = 'upsert' AND status = 'pending' AND revision = 1",
    [&asset.id],
    |row| row.get::<_, i64>(0),
).unwrap();
assert_eq!(count, 1);
```

Call `fixture.ingest()` again and assert the count remains 1, proving exact duplicate ingestion does not create another revision.

- [ ] **Step 2: Run the targeted ingestion test and verify RED**

Run:

```powershell
cargo test --lib library::ingestion::tests::successful_asset_commit_creates_one_pending_cloud_upsert -- --exact
```

Expected: FAIL with count 0 because ingestion does not yet enqueue.

- [ ] **Step 3: Insert the outbox row inside existing asset transactions**

Import `crate::cloud::queue::enqueue_asset_upsert` in `ingestion.rs`.

In `register_asset`, call it immediately before `transaction.commit()` only when `registration` is `Registration::Normal`:

```rust
if matches!(registration, Registration::Normal) {
    enqueue_asset_upsert(&transaction, &asset.id, &asset.collected_at)?;
}
transaction.commit()?;
```

In `register_video_asset`, call it immediately before the existing transaction commit. Do not read configuration and do not start any async work.

- [ ] **Step 4: Run the targeted ingestion test and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Verify review-pending ingestion remains outside the queue**

Extend the closest existing similarity-review ingestion test with one query asserting zero queue rows for the candidate asset. Run only that exact test. This catches accidentally moving the enqueue call outside the `Registration::Normal` branch.

---

### Task 4: Focused verification and diff audit

**Files:**
- Verify all files above; do not edit unrelated files.

**Interfaces:**
- Verifies schema migration, queue persistence, stable key preparation, and unchanged local-first ingestion behavior.

- [ ] **Step 1: Run the changed Rust library surface once**

Run from `app/src-tauri`:

```powershell
cargo test --lib
```

Expected: PASS. Do not run frontend tests or a production build because no frontend or packaging behavior changed.

- [ ] **Step 2: Check formatting and working-tree scope**

Run:

```powershell
cargo fmt -- --check
git diff --check
git status --short
```

If formatting fails, run `cargo fmt`, then rerun only `cargo fmt -- --check`; formatting is mechanical and does not justify rerunning already-passing tests unless Rust source changed semantically afterward.

- [ ] **Step 3: Audit safety properties in the final diff**

Confirm the diff contains no Access Key ID, Secret Access Key, bucket credential, Windows absolute production-library path in runtime code, HTTP call, worker startup, command registration, or modification to the user's pre-existing package/Cargo changes. Confirm no commit or push was made.
