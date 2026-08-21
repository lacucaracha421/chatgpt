# Collection Volume Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class manga Volume/Edition slots, lazily preserve existing local covers, and resumably download supported Japanese MangaDex covers after the Work detail opens.

**Architecture:** A new `collection_volume` Library module owns the flattened `(volume_number, edition_index)` model, provider snapshot materialization, local legacy adaptation, and sequential cover sync behind two commands. Manga volume UI consumes stable Volume IDs and WorkArtwork URLs; the existing filename-based cover path remains only for non-manga Collections until their later type-specific UI pass.

**Tech Stack:** Rust 2021, rusqlite/SQLite migrations, Tauri 2 commands, React 19, TypeScript 5.8, Vitest/Testing Library.

## Global Constraints

- Accept only positive integer MangaDex volume labels and exact suffixes `.1`, `.2`, `.3`; preserve all other provider values only in the raw ExternalBinding snapshot.
- Treat rows sharing `collection_id` and `volume_number` as one domain Volume; `edition_index` 0–3 is its flattened display slot.
- Drawer 1 maps to edition 0, drawer 2 to `.1`, drawer 3 to `.2`, and drawer 4 to `.3`; default to drawer 1 and sort by numeric volume number.
- Existing local cover files win over provider artwork and must never be moved, changed, or deleted.
- Work detail must render its stored representative artwork before remaining MangaDex downloads finish.
- Download missing covers sequentially, persist each success immediately, continue after per-item failures, and retry only missing items on reopen/refresh.
- Reuse WorkArtwork; do not create Asset Library assets, a persistent worker, queue, scheduler, generic provider-volume interface, or independent Edition table.
- Preserve the existing filename cover path for game/movie Collections; P3 changes only the manga detail data source.
- Follow `DESIGN.md` and `docs/prototypes/lakomics-works-v6-reference.html`; this pass keeps the dense viewer/grid/drawer composition and does not add P7 collectible motion.
- Verification defaults to one relevant targeted check per task. Do not run the full Rust/frontend suite or a production build. The UI task may additionally run TypeScript checking because the changed `LibraryGateway` interface is a concrete cross-module compile risk.
- The existing unrelated `app/src-tauri/Cargo.toml` worktree state must not be staged or modified.

---

## File Map

### Backend persistence and domain

- Create `app/src-tauri/migrations/0015_collection_volumes.sql` — Volume/Edition slot persistence and constraints.
- Create `app/src-tauri/src/library/collection_volume.rs` — label parsing, provider materialization, legacy adaptation, ordered listing, and sequential sync.
- Modify `app/src-tauri/src/library/db.rs` — register schema v15 and its focused migration test.
- Modify `app/src-tauri/src/library/models.rs` — serialized `CollectionVolume` and `MangaDexVolumeSyncResult` contracts.
- Modify `app/src-tauri/src/library/mod.rs` — register the new module.

### Backend integration

- Modify `app/src-tauri/src/library/mangadex.rs` — extract valid cover candidates from the stored snapshot without exposing provider JSON.
- Modify `app/src-tauri/src/library/mangadex_flow.rs` — materialize Volume rows during apply and link the selected representative artwork.
- Modify `app/src-tauri/src/library/work_artwork.rs` — return persisted artwork identity and insert non-selected `volume_cover` artwork without duplicating provider images.
- Modify `app/src-tauri/src/library/collection_source.rs` — expose stable, validated legacy cover candidates to the Volume module while retaining the old public cover listing.
- Modify `app/src-tauri/src/commands.rs` — blocking-safe list/sync commands.
- Modify `app/src-tauri/src/lib.rs` — register the two commands.

### Frontend gateway and UI

- Modify `app/src/library/types.ts` — Volume and sync-result types plus gateway methods.
- Modify `app/src/library/client.ts` — Tauri command bindings.
- Create `app/src/collections/CollectionVolumeGrid.tsx` — four edition drawers, numeric Volume tiles, and missing-cover placeholders.
- Modify `app/src/collections/CollectionOverlay.tsx` — manga-only Volume load/sync state with immediate representative-artwork fallback.
- Modify `app/src/collections/CollectionVolumePanel.tsx` — read-only selected label and count; remove the false editor.
- Modify `app/src/collections/CollectionOverlay.test.tsx` — focused manga Volume behavior/regression coverage.
- Modify `app/src/styles/global.css` — remove obsolete input styling and add restrained placeholder state using existing tokens.

---

### Task 1: Persist Volume/Edition slots

**Files:**
- Create: `app/src-tauri/migrations/0015_collection_volumes.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/models.rs`

**Interfaces:**
- Produces: `CollectionVolume { id, volume_number, edition_index, display_label, cover_artwork_id }`
- Produces: `MangaDexVolumeSyncResult { completed, skipped, failed }`
- Produces: schema v15 table keyed by `(collection_id, volume_number, edition_index)`

- [ ] **Step 1: Add the failing v14-to-v15 migration test**

In `db.rs`, build a v14 in-memory database by applying schemas through `COLLECTION_WORK_ARTWORKS_SCHEMA`, insert one manga Collection and WorkArtwork, run `migrate_to_latest(&mut connection, 14)`, and assert:

```rust
connection.execute(
    "INSERT INTO collection_volumes (
        id, collection_id, volume_number, edition_index, sort_order,
        cover_artwork_id, source_provider, source_cover_id, source_file_name,
        created_at, updated_at
     ) VALUES (
        'volume-1', 'work-1', 1, 0, 10,
        'art-1', 'mangadex', 'cover-1', 'cover.jpg',
        '2026-08-21T00:00:00Z', '2026-08-21T00:00:00Z'
     )",
    [],
).unwrap();

assert!(connection.execute(
    "INSERT INTO collection_volumes (
        id, collection_id, volume_number, edition_index, sort_order,
        created_at, updated_at
     ) VALUES ('duplicate', 'work-1', 1, 0, 10, 't', 't')",
    [],
).is_err());

connection.execute("DELETE FROM collection_work_artworks WHERE id = 'art-1'", []).unwrap();
let cover_id: Option<String> = connection.query_row(
    "SELECT cover_artwork_id FROM collection_volumes WHERE id = 'volume-1'",
    [],
    |row| row.get(0),
).unwrap();
assert_eq!(cover_id, None);
assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 15);
```

Also assert that `volume_number = 0` and `edition_index = 4` are rejected. This test is necessary because existing coverage cannot detect a broken migration, uniqueness rule, or `ON DELETE SET NULL` behavior.

- [ ] **Step 2: Run the single migration test and confirm the expected failure**

Run from `app/src-tauri`:

```powershell
cargo test library::db::tests::migrates_v14_to_v15_collection_volumes --lib
```

Expected: FAIL because schema v15 and `collection_volumes` do not exist.

- [ ] **Step 3: Add the v15 migration and register it**

Create `0015_collection_volumes.sql`:

```sql
CREATE TABLE collection_volumes (
    id TEXT PRIMARY KEY,
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    volume_number INTEGER NOT NULL CHECK (volume_number > 0),
    edition_index INTEGER NOT NULL CHECK (edition_index BETWEEN 0 AND 3),
    sort_order INTEGER NOT NULL,
    cover_artwork_id TEXT REFERENCES collection_work_artworks(id) ON DELETE SET NULL,
    source_provider TEXT,
    source_cover_id TEXT,
    source_file_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (collection_id, volume_number, edition_index)
);

CREATE INDEX collection_volumes_order
ON collection_volumes(collection_id, edition_index, sort_order, volume_number);

PRAGMA user_version = 15;
```

In `db.rs`, set `SCHEMA_VERSION` to 15, include the migration as `COLLECTION_VOLUMES_SCHEMA`, accept migration sources through 14, and execute it when `version <= 14`.

- [ ] **Step 4: Add the serialized models**

In `models.rs` add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionVolume {
    pub id: String,
    pub volume_number: i64,
    pub edition_index: u8,
    pub display_label: String,
    pub cover_artwork_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MangaDexVolumeSyncResult {
    pub completed: u64,
    pub skipped: u64,
    pub failed: u64,
}
```

Do not expose source paths, provider JSON, or `sort_order` to React.

- [ ] **Step 5: Run the migration test once and confirm it passes**

Run:

```powershell
cargo test library::db::tests::migrates_v14_to_v15_collection_volumes --lib
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```powershell
git add app/src-tauri/migrations/0015_collection_volumes.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/models.rs
git commit -m "feat: persist collection volumes"
```

---

### Task 2: Materialize supported MangaDex slots during apply

**Files:**
- Create: `app/src-tauri/src/library/collection_volume.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/mangadex.rs`
- Modify: `app/src-tauri/src/library/mangadex_flow.rs`
- Modify: `app/src-tauri/src/library/work_artwork.rs`

**Interfaces:**
- Consumes: `MangaDexCoverCandidate`, schema v15, existing `PreparedWorkArtwork`
- Produces: `parse_volume_slot(&str) -> Option<(i64, u8)>`
- Produces: `materialize_mangadex_volumes(&Transaction, collection_id, covers, representative) -> Result<(), LibraryError>`
- Produces: `mangadex::parse_snapshot_covers(snapshot_json, manga_id) -> Result<Vec<MangaDexCoverCandidate>, LibraryError>`
- Changes: `select_work_artwork_in_transaction(...) -> Result<String, LibraryError>` returns the persisted artwork ID

- [ ] **Step 1: Add focused failing module tests**

Register `mod collection_volume;` in `library/mod.rs`, create the module, and add tests that express the realistic regressions not covered today:

```rust
#[test]
fn parses_only_supported_volume_slots() {
    assert_eq!(parse_volume_slot("1"), Some((1, 0)));
    assert_eq!(parse_volume_slot("12.1"), Some((12, 1)));
    assert_eq!(parse_volume_slot("12.2"), Some((12, 2)));
    assert_eq!(parse_volume_slot("12.3"), Some((12, 3)));
    assert_eq!(parse_volume_slot("01"), Some((1, 0)));
    for value in ["0", "1.01", "1.4", "1.5", ".1", "special", " 1 "] {
        assert_eq!(parse_volume_slot(value), None, "{value}");
    }
}

#[test]
fn materialization_keeps_first_japanese_cover_per_slot_in_numeric_order() {
    let covers = vec![
        candidate("cover-10", "ten.jpg", "10", "ja"),
        candidate("cover-2", "two.jpg", "2", "ja"),
        candidate("cover-2-later", "two-later.jpg", "2", "ja"),
        candidate("cover-1-2", "one-small.jpg", "1.2", "ja"),
        candidate("cover-ko", "ko.jpg", "1", "ko"),
        candidate("cover-unsupported", "half.jpg", "1.5", "ja"),
    ];
    materialize_mangadex_volumes(&transaction, WORK_ID, &covers, None).unwrap();
    assert_eq!(stored_slots(&transaction), vec![
        (1, 2, "cover-1-2".into()),
        (2, 0, "cover-2".into()),
        (10, 0, "cover-10".into()),
    ]);
}
```

Add a `mangadex_flow` regression test proving `apply_fetched_mangadex` creates supported Volume rows and links the selected Japanese volume-1 WorkArtwork ID to slot `(1, 0)` in the same transaction.

- [ ] **Step 2: Run the new Collection Volume module tests and confirm failure**

Run:

```powershell
cargo test library::collection_volume::tests --lib
```

Expected: FAIL because parsing and materialization are not implemented.

- [ ] **Step 3: Implement strict label parsing and deterministic provider materialization**

In `collection_volume.rs`:

```rust
pub(crate) fn parse_volume_slot(value: &str) -> Option<(i64, u8)> {
    let (number, edition) = match value.split_once('.') {
        None => (value, 0),
        Some((number, "1")) => (number, 1),
        Some((number, "2")) => (number, 2),
        Some((number, "3")) => (number, 3),
        Some(_) => return None,
    };
    if number.is_empty() { return None; }
    let number = number.parse::<i64>().ok()?;
    (number > 0).then_some((number, edition))
}

fn display_label(volume_number: i64, edition_index: u8) -> String {
    if edition_index == 0 {
        volume_number.to_string()
    } else {
        format!("{volume_number}.{edition_index}")
    }
}
```

Filter `language == Some("ja")`, use a `BTreeMap<(i64, u8), &MangaDexCoverCandidate>` with `entry(...).or_insert(...)` so the first item wins, and upsert rows ordered by the numeric pair. Use `sort_order = volume_number * 10 + edition_index as i64`. On conflict, update provider identity only while the row has no local source and no attached artwork.

- [ ] **Step 4: Make stored cover snapshots reusable without leaking JSON parsing**

In `mangadex.rs`, add:

```rust
pub(crate) fn parse_snapshot_covers(
    snapshot_json: &str,
    manga_id: &str,
) -> Result<Vec<MangaDexCoverCandidate>, LibraryError> {
    let snapshot: serde_json::Value = serde_json::from_str(snapshot_json)
        .map_err(|_| LibraryError::InvalidMangaDexResponse)?;
    let covers: CollectionEnvelope<CoverData> = serde_json::from_value(
        snapshot.get("covers").cloned().ok_or(LibraryError::InvalidMangaDexResponse)?,
    ).map_err(|_| LibraryError::InvalidMangaDexResponse)?;
    if covers.result != "ok" { return Err(LibraryError::InvalidMangaDexResponse); }

    Ok(covers.data.into_iter().filter_map(|cover| {
        let belongs_to_manga = cover.relationships.iter().any(|relationship| {
            relationship.relationship_type == "manga" && relationship.id == manga_id
        });
        if !belongs_to_manga
            || validate_cover_identity(manga_id, &cover.attributes.file_name).is_err()
            || uuid::Uuid::parse_str(&cover.id).is_err()
        {
            return None;
        }
        Some(MangaDexCoverCandidate {
            cover_id: cover.id,
            file_name: cover.attributes.file_name,
            volume: cover.attributes.volume,
            language: cover.attributes.locale,
        })
    }).collect())
}
```

The Volume module calls this helper when it later materializes an existing binding. It never traverses raw provider JSON itself. A malformed individual cover is skipped so valid siblings still materialize; a malformed snapshot envelope remains a command-level error.

- [ ] **Step 5: Return the actual selected artwork ID and link it during apply**

Change `select_work_artwork_in_transaction` to query and return the persisted row ID after its upsert:

```rust
let artwork_id = transaction.query_row(
    "SELECT id FROM collection_work_artworks
     WHERE collection_id = ?1 AND provider = ?2 AND provider_image_id = ?3",
    params![collection_id, provider, provider_image_id],
    |row| row.get::<_, String>(0),
)?;
Ok(artwork_id)
```

In `apply_fetched_mangadex`, retain the preview covers until the transaction completes, insert/select the representative artwork, pass `(representative_cover_id, persisted_artwork_id)` to `materialize_mangadex_volumes`, then store the snapshot and commit. When there is no Japanese cover, still materialize all supported Japanese placeholders and commit the Work normally.

- [ ] **Step 6: Run the affected MangaDex flow test module**

The later integration edits can invalidate the apply transaction even after pure parsing passes, so run the affected module once:

```powershell
cargo test library::mangadex_flow::tests --lib
```

Expected: PASS, including the new apply-to-Volume regression.

- [ ] **Step 7: Commit Task 2**

```powershell
git add app/src-tauri/src/library/collection_volume.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/mangadex.rs app/src-tauri/src/library/mangadex_flow.rs app/src-tauri/src/library/work_artwork.rs
git commit -m "feat: materialize MangaDex volume slots"
```

---

### Task 3: Lazily adapt local covers and list ordered Volumes

**Files:**
- Modify: `app/src-tauri/src/library/collection_source.rs`
- Modify: `app/src-tauri/src/library/collection_volume.rs`
- Modify: `app/src-tauri/src/library/work_artwork.rs`

**Interfaces:**
- Produces: `Library::list_collection_volumes(&self, collection_id: &str) -> Result<Vec<CollectionVolume>, LibraryError>`
- Produces: `legacy_collection_cover_files(...) -> Result<Vec<LegacyCollectionCoverFile>, LibraryError>` for crate-internal reuse
- Produces: non-selected WorkArtwork insertion that returns the existing or newly persisted artwork ID

- [ ] **Step 1: Add failing local-first and idempotency tests**

Use a temporary Library and source root with these files in one Collection's `covers/` directory:

```text
vol_1_local.png
vol_1_second.png
vol_2.3_local.png
vol_3.5_unsupported.png
```

Seed a valid MangaDex ExternalBinding snapshot containing the provider candidate for `(1, 0)` plus one malformed sibling, call `list_collection_volumes`, and assert both that the valid snapshot candidate creates its supported row and that the overlapping local cover takes ownership:

```rust
assert_eq!(volumes.iter().map(|v| (v.display_label.clone(), v.cover_artwork_id.is_some())).collect::<Vec<_>>(), vec![
    ("1".to_string(), true),
    ("2.3".to_string(), true),
]);
assert_eq!(source_for_slot(&library, WORK_ID, 1, 0), (Some("local"), Some("vol_1_local.png")));
assert!(covers_dir.join("vol_1_local.png").is_file());
assert!(covers_dir.join("vol_1_second.png").is_file());
assert!(covers_dir.join("vol_3.5_unsupported.png").is_file());
```

Call `list_collection_volumes` again and assert that the row count and WorkArtwork count are unchanged. The test protects the realistic regression of duplicating managed files every time a Work opens.

- [ ] **Step 2: Run the Collection Volume module tests and confirm failure**

Run:

```powershell
cargo test library::collection_volume::tests --lib
```

Expected: FAIL because lazy local adaptation and listing do not exist.

- [ ] **Step 3: Expose stable legacy candidates without changing the old API**

In `collection_source.rs`, factor the existing validated `covers/` scan into a crate-private helper returning filename and absolute path in natural filename order:

```rust
pub(crate) struct LegacyCollectionCoverFile {
    pub file_name: String,
    pub absolute_path: PathBuf,
}

pub(crate) fn legacy_collection_cover_files(
    connection: &Connection,
    collection_id: &str,
) -> Result<Vec<LegacyCollectionCoverFile>, LibraryError>
```

If the Collection exists but has no configured source root, source path, or covers directory, return an empty vector for Volume adaptation. Keep `Library::list_collection_covers` and the collection-cover media protocol behavior unchanged for non-manga callers.

- [ ] **Step 4: Add a non-selected WorkArtwork insertion helper**

In `work_artwork.rs`, add a transaction helper that inserts `kind = 'volume_cover'`, `selected = 0`, and returns the persisted ID:

```rust
pub(crate) fn insert_volume_work_artwork_in_transaction(
    transaction: &Transaction<'_>,
    collection_id: &str,
    provider: &str,
    provider_image_id: &str,
    language: Option<&str>,
    prepared: &PreparedWorkArtwork,
) -> Result<String, LibraryError>
```

For local imports use provider `local` and the stable original filename as `provider_image_id`. Before preparing a file, query for an existing `(collection_id, 'local', file_name)` artwork so a repeated load never writes a temporary duplicate. Do not overwrite an existing artwork row's relative path; callers reuse it before preparing bytes, while a rare uniqueness race fails that item safely and leaves it retryable.

- [ ] **Step 5: Implement prepare-and-list semantics**

`Library::list_collection_volumes` performs only local work:

1. Require an existing manga Collection.
2. Read the MangaDex binding snapshot if present, extract valid candidates with `parse_snapshot_covers`, and materialize supported provider placeholders.
3. Get legacy candidates, parse supported labels, and keep the first candidate per slot in stable order.
4. For each candidate not already recorded as the local source, read bytes, call `prepare_work_artwork`, and commit one small transaction that inserts/reuses WorkArtwork and updates the Volume row to `source_provider = 'local'`, `source_file_name = file_name`, `source_cover_id = NULL`, and the local `cover_artwork_id`.
5. Commit the managed file only after its database transaction succeeds.
6. Query and return serialized Volume rows ordered by `edition_index`, `sort_order`, then `volume_number`.

Local adaptation is allowed to replace a provider-linked Volume reference because local wins; it must never replace a row already sourced from the first local file for that slot.

- [ ] **Step 6: Run the Collection Volume module tests once after these edits**

Run:

```powershell
cargo test library::collection_volume::tests --lib
```

Expected: PASS for parsing, provider ordering, local precedence, unchanged originals, and repeated-load idempotency.

- [ ] **Step 7: Commit Task 3**

```powershell
git add app/src-tauri/src/library/collection_source.rs app/src-tauri/src/library/collection_volume.rs app/src-tauri/src/library/work_artwork.rs
git commit -m "feat: adapt local manga volume covers"
```

---

### Task 4: Add resumable sequential MangaDex cover sync and commands

**Files:**
- Modify: `app/src-tauri/src/library/collection_volume.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`

**Interfaces:**
- Consumes: missing provider-backed Volume rows and `mangadex::download_cover`
- Produces: `Library::sync_mangadex_volume_covers(&self, collection_id: &str) -> Result<MangaDexVolumeSyncResult, LibraryError>`
- Produces: Tauri `list_collection_volumes` and `sync_mangadex_volume_covers`
- Produces: frontend `listCollectionVolumes` and `syncMangaDexVolumeCovers`

- [ ] **Step 1: Add failing resume/continue tests with a narrow downloader seam**

Implement tests against a crate-private helper whose closure is the only test seam:

```rust
fn sync_mangadex_volume_covers_with<F>(
    &self,
    collection_id: &str,
    mut download: F,
) -> Result<MangaDexVolumeSyncResult, LibraryError>
where
    F: FnMut(&str, &str) -> Result<Vec<u8>, LibraryError>,
```

Seed three provider-backed rows, pre-attach artwork to volume 1, return an error for volume 2, and valid image bytes for volume 3. Assert the downloader sees `two.jpg` then `three.jpg`, volume 1 is skipped, volume 3 persists despite volume 2 failing, and the result is:

```rust
MangaDexVolumeSyncResult { completed: 1, skipped: 1, failed: 1 }
```

On a second call, return valid bytes for volume 2 and assert only `two.jpg` is requested. This is necessary regression coverage for interruption/resume and per-item failure isolation.

- [ ] **Step 2: Run the single Volume module target and confirm failure**

Run:

```powershell
cargo test library::collection_volume::tests --lib
```

Expected: FAIL because sync is not implemented.

- [ ] **Step 3: Implement one sequential sync attempt**

The public method delegates directly to the helper:

```rust
pub fn sync_mangadex_volume_covers(
    &self,
    collection_id: &str,
) -> Result<MangaDexVolumeSyncResult, LibraryError> {
    self.sync_mangadex_volume_covers_with(collection_id, |manga_id, file_name| {
        mangadex::download_cover(manga_id, file_name)
    })
}
```

The helper:

1. Requires a MangaDex binding and reads its manga ID.
2. Queries rows in numeric slot order.
3. Counts rows already attached or local-sourced as skipped without downloading.
4. For each missing MangaDex row, first reuses an existing WorkArtwork with the same provider image ID.
5. Otherwise downloads and validates one original image, prepares it, and commits a transaction that inserts non-selected WorkArtwork and attaches it only if the Volume is still missing.
6. Commits the managed file after the database transaction.
7. Converts a per-row download/image/database error into `failed += 1` and continues; errors that prevent loading the Collection/binding/row set still return `Err`.

Do not spawn internal tasks or add retries, parallelism, sleeps, queues, or status tables.

- [ ] **Step 4: Run the Volume module target once and confirm resume behavior passes**

Run:

```powershell
cargo test library::collection_volume::tests --lib
```

Expected: PASS.

- [ ] **Step 5: Expose blocking-safe Tauri commands**

Add to `commands.rs`:

```rust
#[tauri::command]
pub async fn list_collection_volumes(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CollectionVolume>, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.list_collection_volumes(&collection_id))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub async fn sync_mangadex_volume_covers(
    collection_id: String,
    state: State<'_, AppState>,
) -> Result<MangaDexVolumeSyncResult, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.sync_mangadex_volume_covers(&collection_id))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}
```

Import the models and register both commands in `lib.rs`. Keep `list_collection_covers` registered for non-manga Collections.

- [ ] **Step 6: Add the TypeScript gateway contract**

In `types.ts`:

```ts
export type CollectionVolume = {
  id: string;
  volumeNumber: number;
  editionIndex: number;
  displayLabel: string;
  coverArtworkId: string | null;
};

export type MangaDexVolumeSyncResult = {
  completed: number;
  skipped: number;
  failed: number;
};
```

Add to `LibraryGateway` and `client.ts`:

```ts
listCollectionVolumes(collectionId: string): Promise<CollectionVolume[]>;
syncMangaDexVolumeCovers(collectionId: string): Promise<MangaDexVolumeSyncResult>;

listCollectionVolumes: (collectionId) =>
  invoke<CollectionVolume[]>("list_collection_volumes", { collectionId }),
syncMangaDexVolumeCovers: (collectionId) =>
  invoke<MangaDexVolumeSyncResult>("sync_mangadex_volume_covers", { collectionId }),
```

- [ ] **Step 7: Commit Task 4**

```powershell
git add app/src-tauri/src/library/collection_volume.rs app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src/library/types.ts app/src/library/client.ts
git commit -m "feat: sync MangaDex volume covers"
```

---

### Task 5: Connect the manga viewer to Volume records

**Files:**
- Create: `app/src/collections/CollectionVolumeGrid.tsx`
- Modify: `app/src/collections/CollectionOverlay.tsx`
- Modify: `app/src/collections/CollectionVolumePanel.tsx`
- Modify: `app/src/collections/CollectionOverlay.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: `CollectionVolume`, `listCollectionVolumes`, `syncMangaDexVolumeCovers`, `workArtworkUrl`
- Produces: manga-only four-drawer Volume grid with immediate local artwork and background refresh
- Preserves: existing `CollectionCoverGrid` and `listCollectionCovers` behavior for game/movie Collections

- [ ] **Step 1: Replace the manga overlay fixture with a failing Volume behavior test**

Give `renderOverlay` safe defaults for both new methods:

```ts
listCollectionVolumes: vi.fn().mockResolvedValue([]),
syncMangaDexVolumeCovers: vi.fn().mockResolvedValue({ completed: 0, skipped: 0, failed: 0 }),
```

Add one focused test with out-of-order input spanning base and `.1` editions:

```ts
it("shows ordered manga Volume drawers, syncs missing covers, and has no fake editor", async () => {
  const listCollectionVolumes = vi.fn()
    .mockResolvedValueOnce([
      { id: "v10", volumeNumber: 10, editionIndex: 0, displayLabel: "10", coverArtworkId: null },
      { id: "v2", volumeNumber: 2, editionIndex: 0, displayLabel: "2", coverArtworkId: "art-2" },
      { id: "v1-1", volumeNumber: 1, editionIndex: 1, displayLabel: "1.1", coverArtworkId: "art-1-1" },
    ])
    .mockResolvedValueOnce([
      { id: "v2", volumeNumber: 2, editionIndex: 0, displayLabel: "2", coverArtworkId: "art-2" },
      { id: "v10", volumeNumber: 10, editionIndex: 0, displayLabel: "10", coverArtworkId: "art-10" },
      { id: "v1-1", volumeNumber: 1, editionIndex: 1, displayLabel: "1.1", coverArtworkId: "art-1-1" },
    ]);
  const syncMangaDexVolumeCovers = vi.fn().mockResolvedValue({ completed: 1, skipped: 2, failed: 0 });
  const user = userEvent.setup();
  renderOverlay({ listCollectionVolumes, syncMangaDexVolumeCovers });

  expect(await screen.findByRole("button", { name: "2권 표지" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "10권 표지 불러오는 중" })).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "권 번호" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "서랍 2" }));
  expect(screen.getByRole("button", { name: "1.1권 표지" })).toBeInTheDocument();
  await waitFor(() => expect(syncMangaDexVolumeCovers).toHaveBeenCalledWith("collection-1"));
  await waitFor(() => expect(listCollectionVolumes).toHaveBeenCalledTimes(2));
});
```

Update the existing representative-artwork regression to use a Volume `coverArtworkId` for manga instead of a collection-cover filename. Keep the connection and refresh tests.

- [ ] **Step 2: Run the affected UI test file and confirm failure**

Run from `app`:

```powershell
npm test -- src/collections/CollectionOverlay.test.tsx
```

Expected: FAIL because the overlay still uses filename covers and the editable input.

- [ ] **Step 3: Build the Volume grid with the existing visual language**

Create `CollectionVolumeGrid.tsx` with props:

```ts
type CollectionVolumeGridProps = {
  volumes: CollectionVolume[];
  selectedVolumeId: string | null;
  editionIndex: number;
  onEditionIndexChange: (next: number) => void;
  onSelect: (volumeId: string) => void;
};
```

Use drawer definitions `[{ drawer: 1, edition: 0 }, ... { drawer: 4, edition: 3 }]`, filter by the selected edition, and sort a copied array with `(a, b) => a.volumeNumber - b.volumeNumber`. Render `workArtworkUrl(volume.coverArtworkId)` when present; otherwise render a quiet fixed-aspect placeholder without an `<img>` request. Drawer buttons remain compact square controls with `aria-pressed`, and clicking the selected drawer does not switch to an all-covers mode.

- [ ] **Step 4: Make manga load immediately and sync after first render**

In `CollectionOverlay.tsx`, keep the existing cover state/effect for non-manga Collections. For manga:

```ts
const [volumes, setVolumes] = useState<CollectionVolume[] | null>(null);
const [selectedVolumeId, setSelectedVolumeId] = useState<string | null>(null);
const [editionIndex, setEditionIndex] = useState(0);
```

The manga effect awaits `listCollectionVolumes`, sets the first base-edition selection, renders, then starts `syncMangaDexVolumeCovers` without blocking the initial state. After the attempt resolves, call `listCollectionVolumes` once more and preserve the selected Volume ID when it still exists. If `failed > 0`, show `표지 {failed}개를 가져오지 못했습니다. 다시 열면 재시도합니다.` in the existing Toast. A command-level failure uses `commandErrorMessage` and keeps the already rendered volumes/artwork.

While the first Volume list is still loading, render `collection.selectedWorkArtworkId` in the manga hero immediately. Show the hero skeleton only when neither stored representative artwork nor a loaded Volume cover is available.

For manga hero selection:

```ts
const selectedVolume = volumes?.find((volume) => volume.id === selectedVolumeId) ?? null;
const heroUrl = selectedVolume?.coverArtworkId
  ? workArtworkUrl(selectedVolume.coverArtworkId)
  : collection?.selectedWorkArtworkId
    ? workArtworkUrl(collection.selectedWorkArtworkId)
    : null;
```

Changing drawers selects the first Volume in that drawer when the current selection is outside it. Continue using `CollectionCoverGrid` and collection-cover URLs only for non-manga Collections.

- [ ] **Step 5: Remove the false volume editor and tune only required styles**

Change `CollectionVolumePanel` to:

```tsx
type CollectionVolumePanelProps = {
  coverCount: number;
  volumeLabel: string | null;
};

<div className="collection-overlay__volume-row">
  <span className="collection-overlay__volume-label">권 번호</span>
  <span className="collection-overlay__volume-value">{volumeLabel ?? "—"}</span>
</div>
```

Delete `.collection-overlay__volume-input` rules. Reuse the current grid spacing, 0–2 px media radius, separators, typography, and token colors. Add only a neutral placeholder surface and subdued label; do not add gradients, shadows, large radii, hover scale, new cards, or animation.

Render `CollectionVolumePanel` only for manga Collections. Do not invent Volume labels or edition controls for the preserved game/movie filename-cover path.

- [ ] **Step 6: Run the affected UI test file once after implementation**

Run:

```powershell
npm test -- src/collections/CollectionOverlay.test.tsx
```

Expected: PASS for immediate artwork fallback, drawer mapping, placeholder behavior, sync refresh, connection/refresh handling, and removal of the fake editor.

- [ ] **Step 7: Run one TypeScript interface check for the identified gateway risk**

The new required `LibraryGateway` methods affect mocks outside the rendered test file, so run:

```powershell
npx tsc --noEmit
```

Expected: PASS. Do not run `npm run build` or the full frontend suite.

- [ ] **Step 8: Commit Task 5**

```powershell
git add app/src/collections/CollectionVolumeGrid.tsx app/src/collections/CollectionOverlay.tsx app/src/collections/CollectionVolumePanel.tsx app/src/collections/CollectionOverlay.test.tsx app/src/styles/global.css
git commit -m "feat: show first-class manga volumes"
```

---

## Completion Evidence

Use the successful checks already run after the last relevant edits. Do not repeat them merely for completion:

- Rust migration evidence: `library::db::tests::migrates_v14_to_v15_collection_volumes`
- Rust behavior evidence: `library::collection_volume::tests`
- MangaDex transaction evidence: `library::mangadex_flow::tests`
- UI behavior evidence: `src/collections/CollectionOverlay.test.tsx`
- Type interface evidence: `npx tsc --noEmit`

Inspect `git status --short` and confirm only the pre-existing `app/src-tauri/Cargo.toml` state remains outside committed work. Do not stage it. Push the feature branch only when the user requests or confirms the completed implementation.
