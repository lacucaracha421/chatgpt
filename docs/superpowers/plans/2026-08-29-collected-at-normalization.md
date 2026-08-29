# `collected_at` UTC Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store every asset collection timestamp as UTC milliseconds so SQLite text ordering, date buckets, and cursors follow actual chronological order.

**Architecture:** Normalize new values once at the `Library::ingest_media` boundary and reuse that value across image, video, and exact-duplicate paths. Upgrade existing v25 libraries with a transactional v26 SQL migration so the existing indexed text comparisons in `query.rs` remain valid and need no runtime date-function wrapper.

**Tech Stack:** Rust 2021, Chrono, rusqlite, SQLite migrations, built-in Rust tests

## Global Constraints

- Persist `assets.collected_at` as `YYYY-MM-DDTHH:MM:SS.sssZ`.
- Preserve `InvalidCollectedAt` for malformed requested timestamps.
- Do not change the frontend API shape or TypeScript types.
- Do not open, migrate, index, or otherwise write `C:\New_lakomics_assets`; use temporary test libraries only.
- Do not create a commit unless the user explicitly requests one.

---

### Task 1: Normalize existing v25 rows during schema migration

**Files:**
- Create: `app/src-tauri/migrations/0026_collected_at_utc.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Test: `app/src-tauri/src/library/db.rs`

**Interfaces:**
- Consumes: `migrate_to_latest(connection: &mut Connection, version: i64)` and the current v25 schema.
- Produces: schema version `26` with valid `assets.collected_at` values normalized in place.

- [x] **Step 1: Add a failing v25-to-v26 migration test**

Add `migrates_v25_collected_at_offsets_to_utc_milliseconds` to `db.rs`. Build an in-memory v25 database by executing schemas through `PDQ_SIMILARITY_SCHEMA`, insert these literal rows, run `migrate_to_latest(&mut connection, 25)`, and assert the exact stored values and ordering:

```rust
connection.execute_batch(
    "INSERT INTO assets (
        id, content_hash, media_kind, original_name, relative_path,
        thumbnail_relative_path, byte_size, width, height, collected_at
     ) VALUES
        ('later', 'hash-later', 'image', 'later.png', 'assets/later.png',
         'thumbnails/later.webp', 1, 1, 1, '2026-08-13T14:00:00+09:00'),
        ('earlier', 'hash-earlier', 'image', 'earlier.png', 'assets/earlier.png',
         'thumbnails/earlier.webp', 1, 1, 1, '2026-08-13T04:30:00Z'),
        ('invalid', 'hash-invalid', 'image', 'invalid.png', 'assets/invalid.png',
         'thumbnails/invalid.webp', 1, 1, 1, 'legacy-invalid');"
).unwrap();

migrate_to_latest(&mut connection, 25).unwrap();

let rows = connection.prepare(
    "SELECT id, collected_at FROM assets ORDER BY collected_at ASC"
).unwrap().query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
 .unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
assert_eq!(rows, vec![
    ("earlier".into(), "2026-08-13T04:30:00.000Z".into()),
    ("later".into(), "2026-08-13T05:00:00.000Z".into()),
    ("invalid".into(), "legacy-invalid".into()),
]);
assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 26);
```

- [x] **Step 2: Run the migration test and verify RED**

Run: `cargo test library::db::tests::migrates_v25_collected_at_offsets_to_utc_milliseconds --lib`

Expected: FAIL because schema version 26 and the v26 normalization migration do not exist.

- [x] **Step 3: Add the minimal v26 migration**

Create `0026_collected_at_utc.sql`:

```sql
UPDATE assets
SET collected_at = strftime('%Y-%m-%dT%H:%M:%fZ', collected_at)
WHERE strftime('%Y-%m-%dT%H:%M:%fZ', collected_at) IS NOT NULL;

PRAGMA user_version = 26;
```

In `db.rs`, set `SCHEMA_VERSION` to `26`, include the SQL as `COLLECTED_AT_UTC_SCHEMA`, accept versions `0..=25`, and execute it when `version <= 25`.

- [x] **Step 4: Run the migration test and verify GREEN**

Run: `cargo test library::db::tests::migrates_v25_collected_at_offsets_to_utc_milliseconds --lib`

Expected: PASS with the exact UTC millisecond strings, preserved invalid legacy value, and `user_version = 26`.

### Task 2: Normalize every new ingestion path once

**Files:**
- Modify: `app/src-tauri/src/library/ingestion.rs`
- Test: `app/src-tauri/src/library/ingestion.rs`

**Interfaces:**
- Consumes: `IngestMediaRequest.collected_at: Option<String>`.
- Produces: `normalize_collected_at(value: Option<&str>) -> Result<String, LibraryError>` and normalized values passed to image, video, and exact-duplicate metadata writes.

- [x] **Step 1: Change the existing ingestion test to require UTC milliseconds**

Rename `added_asset_preserves_requested_collection_time_and_rejects_invalid_time` to `added_asset_normalizes_requested_collection_time_and_rejects_invalid_time` and assert:

```rust
assert_eq!(asset.collected_at, "2026-08-13T04:44:55.000Z");
```

In `exact_duplicate_moves_the_existing_asset_to_the_requested_folder`, use `2026-08-13T13:44:55+09:00` as the duplicate request and require the stored value `2026-08-13T04:44:55.000Z`.

- [x] **Step 2: Run both ingestion tests and verify RED**

Run: `cargo test library::ingestion::tests::added_asset_normalizes_requested_collection_time_and_rejects_invalid_time --lib`

Run: `cargo test library::ingestion::tests::exact_duplicate_moves_the_existing_asset_to_the_requested_folder --lib`

Expected: FAIL because the current interrupted code does not define `collected_at`, and the duplicate path still stores the offset source text.

- [x] **Step 3: Implement one boundary normalizer**

Import `chrono::{DateTime, SecondsFormat, Utc}` and add:

```rust
fn normalize_collected_at(value: Option<&str>) -> Result<String, LibraryError> {
    let timestamp = match value {
        Some(value) => DateTime::parse_from_rfc3339(value)
            .map_err(|_| LibraryError::InvalidCollectedAt)?
            .with_timezone(&Utc),
        None => Utc::now(),
    };
    Ok(timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
}
```

At the beginning of `ingest_media`, compute the value before any file copy:

```rust
let collected_at = normalize_collected_at(request.collected_at.as_deref())?;
request.collected_at = Some(collected_at.clone());
```

Pass `collected_at: String` into both `ingest_image` and `ingest_video`, and assign it directly to each `AssetSummary`. Keeping the normalized value in `request.collected_at` makes `finish_exact_duplicate` reuse it without another parser or SQL expression.

- [x] **Step 4: Run the two ingestion tests and verify GREEN**

Run: `cargo test library::ingestion::tests::added_asset_normalizes_requested_collection_time_and_rejects_invalid_time --lib`

Run: `cargo test library::ingestion::tests::exact_duplicate_moves_the_existing_asset_to_the_requested_folder --lib`

Expected: PASS with UTC millisecond values and malformed input rejected.

### Task 3: Verify chronological query behavior and regressions

**Files:**
- Verify: `app/src-tauri/src/library/query.rs`

**Interfaces:**
- Consumes: normalized values produced by Tasks 1 and 2.
- Produces: evidence that the existing indexed chronological queries remain compatible with the normalized representation.

- [x] **Step 1: Run the narrow Rust module tests**

Run: `cargo test library::ingestion::tests --lib`

Run: `cargo test library::db::tests --lib`

Run: `cargo test library::query::tests --lib`

Expected: all three commands PASS. Task 1's literal `ORDER BY collected_at ASC` assertion proves offset rows become chronologically sortable, while the existing query suite proves cursor and bucket behavior remains intact.

- [x] **Step 2: Run formatting and full verification**

Run: `cargo fmt --check`

Run: `cargo test`

Run from `app`: `npm test`

Expected: formatting succeeds; Rust tests pass; frontend results are reported exactly. Existing unrelated failures are not silently attributed to this change.
