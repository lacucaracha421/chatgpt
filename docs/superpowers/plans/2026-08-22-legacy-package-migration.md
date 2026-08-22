# Legacy Lakomics Package Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the validated 7,420-item legacy object package and all 545 book collections into the current library with a read-only dry run, verified backup, idempotent merge, immutable source proof, and detailed report.

**Architecture:** A deep Rust module parses and validates the package, computes a deterministic source fingerprint, previews the target read-only, executes asset and collection merges through existing library interfaces, and audits the result. A small CLI adapter selects dry-run or execution and owns JSON output/report paths; SQLite schema v20 stores durable source-item-to-target-asset provenance.

**Tech Stack:** Rust 2021, rusqlite, serde/serde_json, sha2, chrono, existing Lakomics ingestion/classification/backup/book-import modules, PowerShell acceptance commands.

**Spec:** `docs/superpowers/specs/2026-08-22-legacy-package-migration-design.md`

## Global Constraints

- Never create, edit, rename, move, or delete anything below `C:\lakomics\Lakomics.library` or `C:\lakomics\book`.
- Reject a canonical manifest, payload, snapshot, or `info.txt` path that escapes its approved source root.
- Import all supported source media: 7,095 images and 325 videos in the confirmed inventory.
- Exact SHA-256 duplicates share one target asset; byte-distinct source items are all retained.
- Folder and favorite merges are additive; nonblank target title and source URL win conflicts while raw source values remain in the mapping row.
- The earliest valid collection date wins.
- Dry-run performs no schema migration, backup, lock, report, or target write.
- Execute creates a verified pre-migration backup before asset, folder, collection, or mapping writes.
- A successful run requires 7,420 mapped source items, 545 represented collection names, identical before/after source fingerprints, and zero audit mismatches.
- Do not add a dependency or application UI for this one-time workflow.

---

### Task 1: Persist durable legacy package provenance

**Files:**
- Create: `app/src-tauri/migrations/0020_legacy_package_imports.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Test: `app/src-tauri/src/library/db.rs`

**Interfaces:**
- Consumes: existing `assets(id, content_hash)` rows and schema v19.
- Produces: schema v20 table `legacy_package_asset_mappings(source_library_id, source_item_id, asset_id, source_sha256, raw_metadata_json, imported_at)`.

- [ ] **Step 1: Write the failing v19-to-v20 migration test**

Add a test that builds schema v19, inserts one asset, applies the latest migration, inserts two distinct source item IDs mapped to that asset, rejects a duplicate `(source_library_id, source_item_id)`, and verifies `PRAGMA foreign_key_check` is empty.

```rust
#[test]
fn migrates_v19_to_legacy_package_mappings() {
    let mut connection = Connection::open_in_memory().unwrap();
    apply_schemas_through(&mut connection, 19);
    insert_minimal_asset(&connection, "asset-1", "hash-1");
    migrate_to_latest(&mut connection, 19).unwrap();
    for item in ["item-1", "item-2"] {
        connection.execute(
            "INSERT INTO legacy_package_asset_mappings
             (source_library_id, source_item_id, asset_id, source_sha256,
              raw_metadata_json, imported_at)
             VALUES ('legacy-library', ?1, 'asset-1', 'hash-1', '{}', '2026-08-22T00:00:00Z')",
            [item],
        ).unwrap();
    }
    assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 20);
}
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cargo test migrates_v19_to_legacy_package_mappings --lib`

Expected: FAIL because schema version 20 and the mapping table do not exist.

- [ ] **Step 3: Add the minimal schema migration**

Use this schema shape:

```sql
CREATE TABLE legacy_package_asset_mappings (
    source_library_id TEXT NOT NULL,
    source_item_id TEXT NOT NULL,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
    raw_metadata_json TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (source_library_id, source_item_id)
);
CREATE INDEX idx_legacy_package_asset_mappings_asset
ON legacy_package_asset_mappings(asset_id);
PRAGMA user_version = 20;
```

Update `SCHEMA_VERSION`, include the migration, and apply it for versions `<= 19`.

- [ ] **Step 4: Run schema tests and verify GREEN**

Run: `cargo test library::db::tests --lib`

Expected: all database migration tests pass.

- [ ] **Step 5: Commit the schema task**

```powershell
git add app/src-tauri/migrations/0020_legacy_package_imports.sql app/src-tauri/src/library/db.rs
git commit -m "feat: persist legacy package provenance"
```

---

### Task 2: Parse and fingerprint the legacy object package

**Files:**
- Create: `app/src-tauri/src/library/legacy_package_migration.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Test: `app/src-tauri/src/library/legacy_package_migration.rs`

**Interfaces:**
- Consumes: `library.json`, item `manifest.json` files, payloads, and `storage_metadata_latest.json`.
- Produces: `inspect_legacy_package_source(&LegacyPackagePaths) -> Result<LegacyPackageSource, LibraryError>` and `source_fingerprint(&LegacyPackageSource) -> String`.

- [ ] **Step 1: Write fixture builders and failing parser tests**

Create a temporary package with a synthetic root, nested folders, one image,
one video, two metadata entries, and matching SHA-256 values. Assert exact
folder paths, media kinds, metadata, source counts, and deterministic
fingerprint.

```rust
let source = inspect_legacy_package_source(&fixture.paths()).unwrap();
assert_eq!(source.library_id, "legacy-library");
assert_eq!(source.items.len(), 2);
assert_eq!(source.image_count, 1);
assert_eq!(source.video_count, 1);
assert_eq!(source.folders.len(), 2); // synthetic root omitted
assert_eq!(source.items[0].classification_paths, vec![vec!["게임", "블아"]]);
assert_eq!(source.items[0].custom_title.as_deref(), Some("제목"));
assert!(source.items[0].favorite);
assert_eq!(source.fingerprint.len(), 64);
```

Add independent tests for a hash mismatch, byte-length mismatch, missing
snapshot item, duplicate item ID, missing folder ID, folder cycle, payload path
escape, symlink escape where supported, unsupported media kind, and a source
mutation that changes the fingerprint.

- [ ] **Step 2: Run parser tests and verify RED**

Run: `cargo test legacy_package_migration::tests --lib`

Expected: FAIL because the module and interfaces do not exist.

- [ ] **Step 3: Implement strict serde models and contained path resolution**

Define private wire models for only the fields consumed from the package and
snapshot. Canonicalize source roots once; canonicalize every payload and
manifest before accepting it. Read payloads through `sha2::Sha256` in bounded
chunks and compare lowercase hex with the manifest.

```rust
pub struct LegacyPackagePaths {
    pub library_root: PathBuf,
    pub package_root: PathBuf,
    pub metadata_snapshot: PathBuf,
    pub book_root: PathBuf,
}

pub struct LegacyPackageItem {
    pub source_item_id: String,
    pub source_path: PathBuf,
    pub source_sha256: String,
    pub media_kind: LegacyPackageMediaKind,
    pub classification_paths: Vec<Vec<String>>,
    pub custom_title: Option<String>,
    pub source_url: Option<String>,
    pub collected_at: String,
    pub favorite: bool,
    pub raw_metadata_json: String,
}
```

- [ ] **Step 4: Implement deterministic folder mapping and fingerprinting**

Omit the unique synthetic root, resolve every item folder ID to a path, sort
memberships, and hash sorted source facts with length-prefixed fields so
concatenation is unambiguous. Include the full `library.json` and snapshot file
hashes.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run: `cargo test legacy_package_migration::tests --lib`

Expected: all source parser and fingerprint tests pass.

- [ ] **Step 6: Commit source inspection**

```powershell
git add app/src-tauri/src/library/legacy_package_migration.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/error.rs
git commit -m "feat: inspect legacy object packages"
```

---

### Task 3: Make book collection inspection reusable and read-only

**Files:**
- Modify: `app/src-tauri/src/library/book_migration.rs`
- Test: `app/src-tauri/src/library/book_migration.rs`

**Interfaces:**
- Consumes: a book root with direct child directories and `info.txt` files.
- Produces: `scan_book_import(root: &Path) -> Result<BookImportPlan, LibraryError>` and `Library::apply_book_import_plan(&BookImportPlan) -> Result<BookMigrationReport, LibraryError>`; existing UI methods retain their behavior.

- [ ] **Step 1: Write failing tests for source-only scanning and safe existing-name skips**

Assert that source-only scanning parses entries without opening a `Library`,
that apply creates a missing name, that a case-insensitive existing name is
counted as skipped and remains byte-for-byte unchanged in its target row, and
that applying the same plan twice creates no second collection.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cargo test library::book_migration::tests --lib`

Expected: FAIL because the reusable scan/apply interfaces do not exist.

- [ ] **Step 3: Extract scanning and idempotent plan application**

Keep `parse_info_txt` as the single parser. `scan_book_import` performs no
target query. At execution, check `collections.name COLLATE NOCASE` immediately
before each insert. Never update an existing row. Keep
`import_book_collections` as scan followed by apply so the application UI does
not change.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `cargo test library::book_migration::tests --lib`

Expected: all book import tests pass.

- [ ] **Step 5: Commit reusable collection import**

```powershell
git add app/src-tauri/src/library/book_migration.rs
git commit -m "refactor: reuse safe book collection import"
```

---

### Task 4: Build the read-only target preview

**Files:**
- Modify: `app/src-tauri/src/library/legacy_package_migration.rs`
- Test: `app/src-tauri/src/library/legacy_package_migration.rs`

**Interfaces:**
- Consumes: `LegacyPackageSource`, `BookImportPlan`, and an existing target `library.sqlite` opened with `SQLITE_OPEN_READ_ONLY | SQLITE_OPEN_NO_MUTEX`.
- Produces: `inspect_legacy_package_migration(paths) -> Result<LegacyPackageMigrationPlan, LibraryError>` with source, target baseline, asset/folder/collection preview counts, and estimated copy bytes.

- [ ] **Step 1: Write a failing dry-run preview test**

Build a target fixture containing one exact content hash, one matching folder
path, and one case-insensitive matching collection. Assert one duplicate, one
new asset, reused/created folder counts, one existing/new collection, and that
database bytes, `user_version`, backup directory, and package bytes are
unchanged after inspection.

- [ ] **Step 2: Run the test and verify RED**

Run: `cargo test dry_run_preview_is_read_only --lib`

Expected: FAIL because the target preview does not exist.

- [ ] **Step 3: Implement read-only target queries**

Read assets by `content_hash`, classification path identity, existing mapping
rows when schema v20 is present, and collection names. Treat a v19 target as
having zero mapping rows without migrating it. Reject missing/unsupported
target schemas.

- [ ] **Step 4: Run preview and parser tests and verify GREEN**

Run: `cargo test legacy_package_migration::tests --lib`

Expected: all tests pass and the dry-run fixture has no writes.

- [ ] **Step 5: Commit preview support**

```powershell
git add app/src-tauri/src/library/legacy_package_migration.rs
git commit -m "feat: preview legacy package migration"
```

---

### Task 5: Execute idempotent asset and folder migration

**Files:**
- Modify: `app/src-tauri/src/library/legacy_package_migration.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Test: `app/src-tauri/src/library/legacy_package_migration.rs`

**Interfaces:**
- Consumes: a validated `LegacyPackageMigrationPlan` and open `Library` whose root equals the plan target.
- Produces: `Library::execute_legacy_package_migration(&plan, progress) -> Result<LegacyPackageMigrationReport, LibraryError>`.

- [ ] **Step 1: Write failing execution and merge tests**

Cover these observable behaviors with real temporary files and SQLite:

- new image and video become normal target assets;
- byte-distinct similar images both become normal via `KeepBoth`;
- two source IDs with one SHA-256 map to one target asset;
- exact duplicate retains existing memberships and adds source memberships;
- favorite is logical OR;
- blank title/URL are filled while nonblank values are preserved;
- earliest collection date wins;
- every source item obtains one durable mapping row;
- rerun adds no assets, folders, or mappings;
- a mapped row whose target hash disagrees is rejected;
- per-item failure is reported and retry completes it.

- [ ] **Step 2: Run execution tests and verify RED**

Run: `cargo test legacy_package_execution --lib`

Expected: FAIL because execution is not implemented.

- [ ] **Step 3: Implement shallowest-first folder create/reuse**

Reuse a sibling by case-insensitive name. Create synthetic-root children as
`ClassificationKind::Root` and descendants as `ClassificationKind::Tag`.
Keep a source folder ID to target classification ID map private to execution.

- [ ] **Step 4: Implement asset import and trusted-source keep-both resolution**

Before ingestion, query the target by source SHA-256. For an exact hash match,
skip copying and merge into that asset. Otherwise call existing
`ingest_media`. For `ReviewPending`, load the candidate asset ID, call
`decide_similarity_review` with `SimilarityDecision::KeepBoth`, and continue
with that candidate. Do not alter ordinary ingestion behavior.

- [ ] **Step 5: Merge metadata, memberships, and provenance transactionally**

For the chosen target asset, run one transaction that inserts all source
classification links, applies favorite OR, fills blank title/URL, selects the
earliest RFC3339 date, and inserts the source mapping. Store the canonical raw
metadata JSON unchanged in the mapping row.

- [ ] **Step 6: Implement execution audit and report counters**

Audit mapping count, target normal status, content hash, required membership,
favorite implication, title/URL visibility or raw conflict preservation, and
collection date. Expose per-item failures without source paths outside the
approved package root.

- [ ] **Step 7: Run focused and surrounding tests and verify GREEN**

Run:

```powershell
cargo test legacy_package --lib
cargo test library::ingestion::tests --lib
cargo test library::similarity::tests --lib
```

Expected: all tests pass.

- [ ] **Step 8: Commit execution support**

```powershell
git add app/src-tauri/src/library/legacy_package_migration.rs app/src-tauri/src/library/models.rs
git commit -m "feat: migrate legacy package assets"
```

---

### Task 6: Add the safe migration CLI and combined report

**Files:**
- Create: `app/src-tauri/src/bin/legacy_package_migrate.rs`
- Test: `app/src-tauri/src/bin/legacy_package_migrate.rs`

**Interfaces:**
- Consumes: Tasks 2–5 inspection/execution interfaces and `Library::create_pre_migration_backup("legacy-package")`.
- Produces: CLI flags `--library`, `--package-root`, `--metadata`, `--book-root`, and exactly one of `--dry-run`/`--execute`.

- [ ] **Step 1: Write failing argument, dry-run, execute, and partial-run tests**

Assert unknown/duplicate/missing flags fail; dry-run prints JSON and creates no
files; execute creates a verified pre-migration backup before the first mapping
and writes a report; partial failure writes a report and returns 2; a complete
fixture returns 0.

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `cargo test --bin legacy_package_migrate`

Expected: FAIL because the binary does not exist.

- [ ] **Step 3: Implement argument parsing without a dependency**

Canonicalize all four paths, reject modes used together, and keep dry-run on
the read-only inspection path. Print the plan as pretty JSON.

- [ ] **Step 4: Implement execution gates and report writing**

Open the library only after inspection. Create a verified backup, execute the
plan, apply the scanned book plan, recompute the source fingerprint, run final
audit, and write `backups/legacy-package-migration-<UTC>-<UUID>.json` with
create-new semantics.

- [ ] **Step 5: Run CLI tests and verify GREEN**

Run: `cargo test --bin legacy_package_migrate`

Expected: all CLI tests pass.

- [ ] **Step 6: Commit the CLI**

```powershell
git add app/src-tauri/src/bin/legacy_package_migrate.rs
git commit -m "feat: add safe legacy package migration command"
```

---

### Task 7: Verify the implementation and run the real dry run

**Files:**
- Verify: `app`
- Read only: `C:\lakomics\Lakomics.library`
- Read only: `C:\lakomics\book`
- Read only: `C:\Users\Laku.LAKU\AppData\Roaming\com.lakomics\Lakomics\storage_metadata_backups\storage_metadata_latest.json`
- Read only: `C:\Users\Laku.LAKU\Desktop\test_asset`

**Interfaces:**
- Consumes: completed migration implementation.
- Produces: green repository checks and a real-data dry-run JSON saved outside both source roots.

- [ ] **Step 1: Run formatting and all automated tests**

```powershell
Set-Location app\src-tauri
cargo fmt --all --check
cargo test --lib
cargo test --bin legacy_package_migrate
Set-Location ..
npm.cmd test
npm.cmd run build
```

Expected: zero failures; the existing two intentionally ignored Rust tests may remain ignored.

- [ ] **Step 2: Record read-only before inventories**

Record package fingerprint, package file count/bytes, book file count/bytes,
target baseline, and target database hash before dry-run.

- [ ] **Step 3: Run the real dry run**

```powershell
cargo run --bin legacy_package_migrate -- `
  --library 'C:\Users\Laku.LAKU\Desktop\test_asset' `
  --package-root 'C:\lakomics\Lakomics.library' `
  --metadata 'C:\Users\Laku.LAKU\AppData\Roaming\com.lakomics\Lakomics\storage_metadata_backups\storage_metadata_latest.json' `
  --book-root 'C:\lakomics\book' `
  --dry-run
```

Expected: 7,420 planned assets, 7,095 images, 325 videos, 545 collections,
zero source validation failures, and no source or target mutation.

- [ ] **Step 4: Compare after-dry-run inventories**

Assert source fingerprints and target database hash are unchanged and no new
target backup/report/mapping exists.

- [ ] **Step 5: Commit any verification-only corrections**

Commit only if the real dry run exposed a required code correction; rerun all
preceding checks after that correction.

---

### Task 8: Execute, audit, prove idempotency, build, and push

**Files:**
- Modify at runtime: `C:\Users\Laku.LAKU\Desktop\test_asset`
- Preserve read-only: both approved source roots and metadata snapshot
- Produce: verified backup and detailed migration report under target `backups`

**Interfaces:**
- Consumes: successful Task 7 dry run and closed Lakomics processes.
- Produces: completed target migration and remote repository integration.

- [ ] **Step 1: Verify both legacy and current Lakomics processes are closed**

Check process paths without terminating them. If either process is active, stop
before execute and request that it be closed.

- [ ] **Step 2: Run real execution once**

Use the Task 7 command with `--execute`. Preserve stdout/stderr and the report
path. Expected exit: 0.

- [ ] **Step 3: Audit the report and target directly**

Verify 7,420 mapping rows for the source library ID, every mapping targets a
normal asset with matching SHA-256, all source memberships are represented,
all eight source favorites imply target favorite, metadata conflict rules hold,
all 545 book names exist, duplicate target content-hash count is zero, the
backup opens and passes integrity check, and the source fingerprint is
unchanged.

- [ ] **Step 4: Run a second dry run and execution audit**

Expected: zero new assets, folders, mappings, or collection names. A second
`--execute` may create a new safety backup/report but must create no domain
rows or managed files.

- [ ] **Step 5: Run final repository verification and debug build**

```powershell
Set-Location app\src-tauri
cargo fmt --all --check
cargo test --lib
cargo test --bin legacy_package_migrate
Set-Location ..
npm.cmd test
npm.cmd run tauri -- build --debug
```

Expected: all checks pass and both installer bundles finish.

- [ ] **Step 6: Commit remaining implementation, verify clean status, and push main**

```powershell
git add -A
git commit -m "feat: migrate legacy Lakomics package"
git fetch origin
git push origin main
git status --short --branch
```

Expected: local and remote `main` point to the same commit and the worktree is clean.
