# Lakomics Asset Albums Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not dispatch subagents; the user requested inline execution.

**Goal:** Give every asset at most one direct normal folder while adding nested manual albums that can contain the same asset without copying its managed file.

**Architecture:** Keep `asset_classifications` for normal-folder compatibility, but replace additive writes with one atomic `set_asset_classification` operation. Add independent `albums` and `asset_albums` tables behind a focused Rust album module, extend the existing paged asset query with an album scope, and expose explicit Tauri/TypeScript contracts. Reuse the current sidebar appearance catalog and tree interaction patterns; albums never enter the Edge extension classification response.

**Tech Stack:** Rust 2021, rusqlite/SQLite migrations, Tauri 2, React 19, TypeScript 5.8, Radix UI, Heroicons, Vitest, Testing Library, CSS custom properties, Python 3 standard library for the approved audited one-time data repair.

## Global Constraints

- A normal folder is a virtual classification, not a physical operating-system folder; an asset has zero or one direct normal-folder link.
- Ancestor folder visibility is a recursive query and must not create duplicate `asset_classifications` rows.
- Moving assets to a normal folder removes every prior direct normal-folder link in the same transaction; `null` means move to `미분류`.
- Albums are user-created, manually populated, nested lists. They have no rules, search conditions, or automatic folder linkage.
- An asset can belong to any number of albums, but its media file and `assets` row remain single.
- Opening a parent album always includes all descendant albums and de-duplicates assets; do not add a direct-only album toggle.
- An album with child albums cannot be deleted. Deleting a leaf album removes album links only.
- Trash hides assets from album views, restore reveals the preserved links, and permanent asset deletion cascades album links.
- Reuse the existing 24 icon keys and 12 color keys. Add no icon, color-picker, drag/drop, state-management, or database dependency.
- Keep albums out of the Edge extension donut and `/v1/classifications` response.
- Do not globally normalize old multi-folder data. Only new normal-folder writes enforce the one-direct-folder rule.
- The approved `만화`/`게임` cleanup is a separate audited one-time repair: back up first, require exactly one candidate library and exactly two overlapping assets, then remove only their direct `게임` links.
- Preserve user-owned `app/src-tauri/Cargo.toml`, `manual-skill-commands.txt`, shortcut files, and unrelated dirty worktree changes unless a fresh diff proves they are required for this feature.
- If execution reveals a materially safer approach, better UX, or new risk, pause before changing course and ask the user.
- Use TDD for every behavior change and commit each task independently.
- Run `cargo` commands from `C:\chatgpt\app\src-tauri`, `npm.cmd` commands from `C:\chatgpt\app`, Python repair tests from `C:\chatgpt`, and Git commands from `C:\chatgpt`.

---

### Task 1: Record the decision and add the album schema

**Files:**
- Create: `docs/adr/0030-single-folder-and-manual-albums.md`
- Create: `app/src-tauri/migrations/0008_asset_albums.sql`
- Modify: `CONTEXT.md`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/backup.rs`

**Interfaces:**
- Produces: schema version `8` with `albums` and `asset_albums`.
- Produces: `AlbumEntry` and `CreateAlbum` serialized with camelCase fields.
- Supersedes: the multi-folder membership parts of ADRs 0004 and 0029 without changing media-vault storage.

- [ ] **Step 1: Write the failing v7-to-v8 migration test**

Add this test beside the existing migration test in `db.rs`:

```rust
#[test]
fn migrates_v7_to_nested_albums_without_changing_classification_links() {
    let mut connection = Connection::open_in_memory().unwrap();
    for schema in [
        INITIAL_SCHEMA, VAULT_SAFETY_SCHEMA, SIMILARITY_REVIEW_SCHEMA,
        VIDEO_MEDIA_SCHEMA, MANGA_SCHEMA, MANGA_MODIFIED_SCHEMA,
        CLASSIFICATION_APPEARANCE_SCHEMA,
    ] {
        connection.execute_batch(schema).unwrap();
    }
    connection.execute(
        "INSERT INTO assets (id, content_hash, media_kind, original_name, relative_path,
         thumbnail_relative_path, byte_size, width, height, collected_at)
         VALUES ('asset-1', 'hash-1', 'image', 'one.png', 'assets/one.png',
         'thumbnails/one.webp', 1, 1, 1, '2026-08-12T00:00:00Z')",
        [],
    ).unwrap();

    migrate_to_latest(&mut connection, 7).unwrap();

    connection.execute(
        "INSERT INTO albums (id, name, parent_id, icon_key, color_key, created_at)
         VALUES ('album-1', '표지', NULL, NULL, NULL, '2026-08-12T00:00:00Z')",
        [],
    ).unwrap();
    connection.execute(
        "INSERT INTO asset_albums (asset_id, album_id) VALUES ('asset-1', 'album-1')",
        [],
    ).unwrap();
    assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 8);
}
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `cargo test library::db::tests::migrates_v7_to_nested_albums_without_changing_classification_links -- --exact`

Expected: FAIL because migration 0008 and schema version 8 do not exist.

- [ ] **Step 3: Create and register migration 0008**

Create `0008_asset_albums.sql`:

```sql
CREATE TABLE albums (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE NOCASE,
    parent_id TEXT REFERENCES albums(id) ON DELETE RESTRICT,
    icon_key TEXT,
    color_key TEXT,
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX album_unique_sibling_name
ON albums(COALESCE(parent_id, ''), name COLLATE NOCASE);

CREATE INDEX albums_by_parent
ON albums(parent_id, name COLLATE NOCASE, id);

CREATE TABLE asset_albums (
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    PRIMARY KEY (asset_id, album_id)
);

CREATE INDEX asset_albums_by_album
ON asset_albums(album_id, asset_id);

PRAGMA user_version = 8;
```

Set `SCHEMA_VERSION` to `8`, include `ALBUM_SCHEMA`, allow versions `0..=7`, and execute it for `version <= 7`. Change backup tests that intentionally use a future schema from `8` to `9`.

- [ ] **Step 4: Add the exact Rust transport models**

Add to `models.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AlbumEntry {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub icon_key: Option<String>,
    pub color_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAlbum {
    pub name: String,
    pub parent_id: Option<String>,
}
```

- [ ] **Step 5: Update the domain language and superseding ADR**

In `CONTEXT.md`, change `분류 폴더` to state “직접 소속은 최대 하나이며 상위 노출은 조회로 계산한다.” Add `앨범 (Album)` as a manually populated nested list that stores references only. Change `컬렉션` to the future rich game/manga/work presentation model with cover, description, representative image, and layout.

In ADR 0030 state explicitly:

```markdown
# 일반 폴더는 단일 직접 소속, 앨범은 다중 수동 묶음으로 사용한다

ADR 0004와 ADR 0029 중 자산의 다중 분류 폴더 소속 및 폴더 드롭의 추가 동작을 대체한다.
일반 폴더 드롭은 이동이며 직접 연결은 최대 하나다. 여러 수동 묶음이 필요한 경우 별도 앨범을 사용한다.
두 기능 모두 SQLite 참조만 바꾸며 미디어 금고의 파일을 복사하거나 이동하지 않는다.
```

- [ ] **Step 6: Verify Task 1 GREEN**

Run: `cargo test library::db`

Expected: both v6-to-v7 and v7-to-v8 migration tests PASS.

Run: `git diff --check`

Expected: exit 0.

- [ ] **Step 7: Commit Task 1**

```powershell
git add -- CONTEXT.md docs/adr/0030-single-folder-and-manual-albums.md app/src-tauri/migrations/0008_asset_albums.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/models.rs app/src-tauri/src/library/backup.rs
git diff --cached --name-only
git commit -m "feat: add asset album schema"
```

---

### Task 2: Implement the album aggregate in the Rust library

**Files:**
- Create: `app/src-tauri/src/library/album.rs`
- Create: `app/src-tauri/src/library/folder_appearance.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/classification.rs`
- Modify: `app/src-tauri/src/library/error.rs`

**Interfaces:**
- Produces: `Library::{list_albums, create_album, rename_album, move_album, update_album_appearance, delete_album}`.
- Produces: `folder_appearance::validate(icon_key, color_key)` shared by normal folders and albums.
- Produces stable errors: `AlbumNotFound`, `DuplicateAlbumName`, `AlbumCycle`, `AlbumHasChildren`, `InvalidAlbumAppearance`.

- [ ] **Step 1: Write failing album aggregate tests**

In the new `album.rs`, add a test fixture with this exact interface:

```rust
struct AlbumFixture {
    _temp: tempfile::TempDir,
    library: Library,
    root: AlbumEntry,
    child: AlbumEntry,
}
```

`AlbumFixture::new()` opens a temporary library, creates root `표지`, then child `게임 표지`. Add these tests and exact assertions:

- `creates_lists_and_renames_nested_albums`: rename the child with `"  대표 표지  "`; assert the returned list contains root `표지` with `parent_id == None` and child `대표 표지` with `parent_id == Some(root.id)`.
- `rejects_duplicate_sibling_names_case_insensitively`: create root `Covers`, then request root `covers`; assert `LibraryError::DuplicateAlbumName` and that the list still contains only the original root plus fixture rows.
- `moves_an_album_but_rejects_self_and_descendant_cycles`: create a second root, move the child under it, assert its new parent ID, then assert moving that root under the child returns `LibraryError::AlbumCycle` without changing either parent.
- `blocks_delete_with_children_and_deletes_a_leaf`: assert deleting the fixture root returns `LibraryError::AlbumHasChildren`; delete the child; assert the root remains and the child does not.
- `album_appearance_accepts_the_shared_catalog_and_rejects_unknown_keys`: save `photo`/`pink`, reload and assert both keys, then request `uploaded-svg`/`#ffffff`; assert `LibraryError::InvalidAlbumAppearance` and the stored keys remain `photo`/`pink`.

- [ ] **Step 2: Run the tests and verify RED**

Run: `cargo test library::album`

Expected: FAIL because the album module and methods do not exist.

- [ ] **Step 3: Extract the shared appearance allowlist**

Move the existing 24 `CLASSIFICATION_ICON_KEYS` and 12 `CLASSIFICATION_COLOR_KEYS` from `classification.rs` into `folder_appearance.rs`. Export only:

```rust
pub(super) fn validate(icon_key: Option<&str>, color_key: Option<&str>) -> bool {
    icon_key.is_none_or(|key| ICON_KEYS.contains(&key))
        && color_key.is_none_or(|key| COLOR_KEYS.contains(&key))
}
```

Make `update_classification_appearance` call this function. Do not add a configuration object or trait.

- [ ] **Step 4: Implement the focused album methods**

Normalize names with a local `normalized_album_name`, map SQLite sibling-index violations to `DuplicateAlbumName`, and use recursive CTE validation in `move_album`:

```sql
WITH RECURSIVE descendants(id) AS (
    SELECT id FROM albums WHERE id = ?1
    UNION ALL
    SELECT child.id FROM albums child JOIN descendants ON child.parent_id = descendants.id
)
SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)
```

`delete_album` must start a transaction, reject any row with `parent_id = id`, delete the leaf album, and rely on `asset_albums.album_id ON DELETE CASCADE` only for membership cleanup.

- [ ] **Step 5: Verify Task 2 GREEN**

Run: `cargo test library::album`

Run: `cargo test library::classification`

Expected: album tests and all existing normal-folder tests PASS.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- app/src-tauri/src/library/album.rs app/src-tauri/src/library/folder_appearance.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/classification.rs app/src-tauri/src/library/error.rs
git diff --cached --name-only
git commit -m "feat: manage nested asset albums"
```

---

### Task 3: Add atomic album membership and album-scoped asset queries

**Files:**
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/album.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Modify: `app/src-tauri/src/library/query.rs`
- Modify: `app/src-tauri/src/library/trash.rs`
- Modify: `app/src-tauri/src/library/favorite.rs`
- Modify: `app/src-tauri/src/library/ingestion.rs`
- Modify: `app/src-tauri/tests/foundation_flow.rs`

**Interfaces:**
- Produces: `AssetAlbumPatch { asset_ids, add_album_ids, remove_album_ids }`.
- Produces: `Library::patch_asset_albums` and `Library::get_asset_albums`.
- Extends: `AssetQuery` with `album_id: Option<String>`; classification and album scopes are mutually exclusive.
- Produces: `LibraryError::InvalidAssetScope` when both scope IDs are present and `AlbumNotFound` when the selected album ID does not exist.

- [ ] **Step 1: Write failing membership and lifecycle tests**

Add these tests with exact database outcomes:

- `one_asset_can_join_multiple_albums_without_new_asset_rows`: insert one asset, add it to two albums, assert `get_asset_albums` returns both IDs and `SELECT COUNT(*) FROM assets` remains `1`.
- `batch_album_patch_validates_every_asset_and_album_before_writing`: request two valid assets plus `missing`; assert `LibraryError::AssetNotFound` and `SELECT COUNT(*) FROM asset_albums` remains `0`. Repeat with a missing album and expect `LibraryError::AlbumNotFound` with the same count.
- `parent_album_query_includes_descendants_once_and_hides_trash`: connect one asset to two children of one root, query the root and assert exactly one result; trash the asset and assert zero results; restore it and assert one result again.
- `trash_and_restore_preserve_album_links_but_permanent_delete_cascades_them`: assert the link count is `1` before trash, `1` after trash, `1` after restore, and `0` after trash followed by successful purge.

Add a `query_for_album(album_id: &str) -> AssetQuery` test helper returning every field explicitly:

```rust
AssetQuery {
    classification_id: None,
    album_id: Some(album_id.to_owned()),
    direct_only: false,
    favorite_only: false,
    unclassified_only: false,
    sort: AssetSort::Newest,
    random_pivot: None,
    after: None,
    limit: 20,
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cargo test album_`

Expected: FAIL because membership APIs and `album_id` query scope do not exist.

- [ ] **Step 3: Add the patch type and atomic membership methods**

Add to `models.rs`:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetAlbumPatch {
    pub asset_ids: Vec<String>,
    pub add_album_ids: Vec<String>,
    pub remove_album_ids: Vec<String>,
}
```

In `patch_asset_albums`, begin one transaction, call `validated_asset_ids`, convert add/remove IDs to `BTreeSet`, verify every album exists, then delete removals and `INSERT OR IGNORE` additions. Commit once. `get_asset_albums` returns entries ordered by `name COLLATE NOCASE, id`.

- [ ] **Step 4: Extend the paged query without duplicating files or rows**

Add `album_id: Option<String>` to `AssetQuery`. Reject simultaneous non-null `classification_id` and `album_id` with `LibraryError::InvalidAssetScope`; validate the chosen ID before preparing SQL.

Add this CTE and predicate to each of `NEWEST_SQL`, `OLDEST_SQL`, `FAVORITES_SQL`, and `RANDOM_SQL`, shifting cursor parameter positions consistently:

```sql
album_descendants(id) AS (
    SELECT ?5 WHERE ?5 IS NOT NULL
    UNION ALL
    SELECT child.id FROM albums child
    JOIN album_descendants ON child.parent_id = album_descendants.id
)
```

```sql
AND (?5 IS NULL OR EXISTS (
    SELECT 1 FROM asset_albums album_link
    WHERE album_link.asset_id = asset.id
      AND album_link.album_id IN (SELECT id FROM album_descendants)
))
```

Keep `asset.status = 'normal'`; that alone hides trash and preserves links. Update every existing Rust `AssetQuery` literal with `album_id: None`.

- [ ] **Step 5: Verify membership, pagination, and lifecycle GREEN**

Run: `cargo test library::album`

Run: `cargo test library::query`

Run: `cargo test library::trash`

Expected: all album, query, cursor, and trash tests PASS.

Run: `cargo test --test foundation_flow`

Expected: foundation flow PASS with album-link cascade coverage.

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- app/src-tauri/src/library/models.rs app/src-tauri/src/library/album.rs app/src-tauri/src/library/error.rs app/src-tauri/src/library/query.rs app/src-tauri/src/library/trash.rs app/src-tauri/src/library/favorite.rs app/src-tauri/src/library/ingestion.rs app/src-tauri/tests/foundation_flow.rs
git diff --cached --name-only
git commit -m "feat: query album asset membership"
```

---

### Task 4: Enforce one direct normal folder and move exact duplicates

**Files:**
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/classification.rs`
- Modify: `app/src-tauri/src/library/ingestion.rs`
- Modify: `app/src-tauri/src/library/query.rs`
- Modify: `app/src-tauri/src/extension_api.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src-tauri/tests/foundation_flow.rs`

**Interfaces:**
- Replaces: additive `AssetClassificationPatch` writes with `SetAssetClassification { asset_ids, classification_id }`.
- Produces: `Library::set_asset_classification(request) -> Result<(), LibraryError>`.
- Extends: `IngestOutcome::ExactDuplicate { existing_asset_id, classification_changed }`.

- [ ] **Step 1: Rewrite normal-folder tests for move semantics and verify RED**

Replace the additive classification test with:

```rust
#[test]
fn setting_a_folder_replaces_all_direct_links_atomically() {
    let fixture = ClassificationFixture::new();
    insert_asset(&fixture.library, "asset-a");
    seed_legacy_links(&fixture.library, "asset-a", &[&fixture.root.id, &fixture.child_tag.id]);

    fixture.library.set_asset_classification(SetAssetClassification {
        asset_ids: vec!["asset-a".into()],
        classification_id: Some(fixture.parent_tag.id.clone()),
    }).unwrap();

    assert_eq!(fixture.library.get_asset_classifications("asset-a").unwrap(), vec![fixture.parent_tag.clone()]);
}
```

Add tests for `classification_id: None`, a missing asset in a batch leaving all links unchanged, and a missing target folder leaving all links unchanged.

Change exact-duplicate tests to assert the existing asset moves to the request destination, asset/file counts stay one, and `classification_changed` is `true` only when the direct destination changes.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cargo test setting_a_folder`

Run: `cargo test exact_duplicate`

Expected: FAIL because the explicit setter and changed flag do not exist and duplicates preserve old links.

- [ ] **Step 3: Implement the single normal-folder write boundary**

Add:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAssetClassification {
    pub asset_ids: Vec<String>,
    pub classification_id: Option<String>,
}
```

Within one transaction, validate all assets and the optional classification, then for every asset run:

```sql
DELETE FROM asset_classifications WHERE asset_id = ?1;
INSERT INTO asset_classifications (asset_id, classification_id) VALUES (?1, ?2);
```

Skip the insert when `classification_id` is null. Remove the public additive patch method and update classification/query/ingestion tests to call the setter. Replace the Tauri `patch_asset_classifications` command with `set_asset_classification(request: SetAssetClassification, state)` and register the new command in `lib.rs` in the same step so the Rust crate always compiles.

- [ ] **Step 4: Move exact duplicates inside the ingestion boundary**

Before returning an exact duplicate, compare its current direct IDs with the requested `classification_id`, call the setter if different, and return:

```rust
IngestOutcome::ExactDuplicate {
    existing_asset_id,
    classification_changed,
}
```

In `extension_api::finish_ingestion`, map `classification_changed` directly to `DuplicateTagged` or `DuplicateUnchanged`; remove its second additive classification write. Keep `/v1/classifications` reading only `classification_entries`.

- [ ] **Step 5: Verify Task 4 GREEN**

Run: `cargo test library::classification`

Run: `cargo test library::ingestion`

Run: `cargo test extension_api`

Expected: all normal-folder, duplicate, and extension tests PASS; extension duplicate tests assert one direct folder and one managed file.

Run: `cargo test --test foundation_flow`

Expected: foundation flow PASS under move semantics.

- [ ] **Step 6: Commit Task 4**

```powershell
git add -- app/src-tauri/src/library/models.rs app/src-tauri/src/library/classification.rs app/src-tauri/src/library/ingestion.rs app/src-tauri/src/library/query.rs app/src-tauri/src/extension_api.rs app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src-tauri/tests/foundation_flow.rs
git diff --cached --name-only
git commit -m "feat: enforce one direct asset folder"
```

---

### Task 5: Expose typed album and folder-move commands

**Files:**
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/library/client.test.ts`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/assets/AssetBrowser.tsx`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/library/LibrarySetup.test.tsx`
- Modify: `app/src/manga/MangaBrowser.test.tsx`
- Modify: `app/src/safety/TrashBrowser.test.tsx`
- Modify: `app/src/settings/SettingsView.test.tsx`
- Modify: `app/src/similarity/SimilarityReviewBrowser.test.tsx`

**Interfaces:**
- Produces Tauri album commands: `list_albums`, `create_album`, `rename_album`, `move_album`, `update_album_appearance`, `delete_album`, `get_asset_albums`, `patch_asset_albums`.
- Consumes the Task 4 Tauri command: `set_asset_classification`.
- Produces matching `LibraryGateway` methods and TypeScript types.
- Extends: `AssetView` with `{ kind: "album"; albumId: string }` and `AssetQuery.albumId`.

- [ ] **Step 1: Write failing command-payload tests**

In `client.test.ts`, assert these representative calls:

```ts
await libraryGateway.createAlbum({ name: "표지", parentId: null });
expect(invoke).toHaveBeenCalledWith("create_album", { request: { name: "표지", parentId: null } });

await libraryGateway.patchAssetAlbums({ assetIds: ["a"], addAlbumIds: ["album-1"], removeAlbumIds: [] });
expect(invoke).toHaveBeenCalledWith("patch_asset_albums", { patch: {
  assetIds: ["a"], addAlbumIds: ["album-1"], removeAlbumIds: [],
} });

await libraryGateway.setAssetClassification({ assetIds: ["a"], classificationId: "folder-1" });
expect(invoke).toHaveBeenCalledWith("set_asset_classification", { request: {
  assetIds: ["a"], classificationId: "folder-1",
} });
```

- [ ] **Step 2: Run the client test and verify RED**

Run: `npm.cmd test -- src/library/client.test.ts`

Expected: FAIL because the methods and types do not exist.

- [ ] **Step 3: Add Rust command wrappers and stable errors**

Map every new album error in `CommandError::from` to snake-case codes such as `album_not_found`, `duplicate_album_name`, `album_cycle`, `album_has_children`, and `invalid_album_appearance`; map `InvalidAssetScope` to `invalid_asset_scope`. Add thin command wrappers calling the library methods and register all eight album commands in `tauri::generate_handler!`; keep Task 4's registered folder setter.

- [ ] **Step 4: Add the exact frontend contracts**

Define:

```ts
export type AlbumEntry = {
  id: string;
  name: string;
  parentId: string | null;
  iconKey: string | null;
  colorKey: string | null;
};
export type CreateAlbum = { name: string; parentId: string | null };
export type AssetAlbumPatch = { assetIds: string[]; addAlbumIds: string[]; removeAlbumIds: string[] };
export type SetAssetClassification = { assetIds: string[]; classificationId: string | null };
```

Add all matching gateway methods, replace `patchAssetClassifications`, add `albumId: string | null` to `AssetQuery`, and add `classificationChanged: boolean` to the exact-duplicate outcome.

- [ ] **Step 5: Update typed gateway fixtures mechanically and verify GREEN**

Update only the test gateway fixtures named in the Files list with resolved `vi.fn()` methods, then run:

Run: `npm.cmd test -- src/library/client.test.ts`

Expected: client payload tests PASS.

Run: `npm.cmd run build`

Before this run, replace remaining real `patchAssetClassifications` call sites with the Task 4 setter without adding album UI behavior. Expected: TypeScript and Vite build PASS.

- [ ] **Step 6: Commit Task 5**

```powershell
git add -- app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src/library/types.ts app/src/library/client.ts app/src/library/client.test.ts app/src/app/App.tsx app/src/assets/AssetBrowser.tsx app/src/app/App.test.tsx app/src/assets/AssetBrowser.test.tsx app/src/classification/ClassificationSidebar.test.tsx app/src/library/LibrarySetup.test.tsx app/src/manga/MangaBrowser.test.tsx app/src/safety/TrashBrowser.test.tsx app/src/settings/SettingsView.test.tsx app/src/similarity/SimilarityReviewBrowser.test.tsx
git diff --cached --name-only
git commit -m "feat: expose asset album commands"
```

Before committing, remove any staged frontend file not required to satisfy the typed contract/build migration.

---

### Task 6: Add the nested album section to the sidebar

**Files:**
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/classification/ClassificationAppearanceDialog.tsx`
- Modify: `app/src/classification/classificationAppearance.tsx`
- Modify: `app/src/classification/buildTree.ts`
- Modify: `app/src/preferences/uiPreferences.ts`
- Modify: `app/src/preferences/uiPreferences.test.ts`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Extends `ClassificationSidebar` props with `albums`, `expandedAlbumIds`, `onExpandedAlbumIdsChange`, and `onAlbumsChanged` while retaining existing folder behavior.
- Produces two independently collapsible sections: `폴더 (N)` and `앨범 (N)`.
- Reuses the same recursive row renderer, context menu, inline editor, movement dialog, appearance picker, hierarchy lines, and keyboard navigation by passing a `treeKind: "classification" | "album"` discriminator.

- [ ] **Step 1: Write sidebar tests for album hierarchy and all context actions**

Add tests that render one root album and one child, then assert:

```ts
expect(screen.getByText("앨범 (1)")).toBeVisible();
await user.click(screen.getByRole("button", { name: "앨범 펼치기" }));
fireEvent.contextMenu(screen.getByRole("treeitem", { name: "표지" }));
expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
  "하위 앨범 만들기", "이름 변경", "아이콘 및 색상…", "앨범 이동", "삭제",
]);
```

Test create root, create child, rename, move, icon/color save, delete leaf, blocked delete with children, selection to `{ kind: "album", albumId }`, independent section collapse, and persistence of `expandedAlbumIds`.

- [ ] **Step 2: Run sidebar and preference tests and verify RED**

Run: `npm.cmd test -- src/classification/ClassificationSidebar.test.tsx src/preferences/uiPreferences.test.ts`

Expected: FAIL because album props, view, operations, and persisted expansion do not exist.

- [ ] **Step 3: Generalize only the existing tree coordinator**

Keep one recursive `TreeItem` implementation in `ClassificationSidebar.tsx`. Introduce a local normalized row type:

```ts
type SidebarTreeEntry = {
  treeKind: "classification" | "album";
  id: string;
  name: string;
  parentId: string | null;
  iconKey: string | null;
  colorKey: string | null;
};
```

Convert classification and album entries at the component boundary. Branch only mutation callbacks and Korean nouns by `treeKind`; do not copy the tree renderer or context-menu component.

- [ ] **Step 4: Reuse the appearance dialog and add album CRUD coordination**

Change the appearance dialog input to `{ id, name, iconKey, colorKey, scope: "classification" | "album" }` and dispatch to the corresponding gateway method. Add album create/rename/move/delete handlers with the same inline editor and shared `Dialog`/`ContextMenu` interfaces. When a selected album is deleted, navigate to `{ kind: "classification", classificationId: null }`.

- [ ] **Step 5: Persist album expansion and load albums in App**

Add `expandedAlbumIds: string[]` to `UiPreferences` with an empty-array default and validation matching `expandedClassificationIds`. In `App.tsx`, load `entries` and `albums` together with `Promise.all`, refresh the appropriate list after mutations, and pass the new props to the sidebar.

- [ ] **Step 6: Style the second section with existing tokens**

Reuse `.classification-sidebar__tree-*` row and hierarchy classes. Add only section-header/collapse affordance styles required for two independent sections. Do not duplicate colors, z-index values, row heights, menu styles, or connector geometry.

- [ ] **Step 7: Verify Task 6 GREEN**

Run: `npm.cmd test -- src/classification/ClassificationSidebar.test.tsx src/preferences/uiPreferences.test.ts src/app/App.test.tsx`

Expected: all sidebar, preferences, and app-loading tests PASS.

Run: `npm.cmd run build`

Expected: build PASS.

- [ ] **Step 8: Commit Task 6**

```powershell
git add -- app/src/app/App.tsx app/src/app/App.test.tsx app/src/classification/ClassificationSidebar.tsx app/src/classification/ClassificationSidebar.test.tsx app/src/classification/ClassificationAppearanceDialog.tsx app/src/classification/classificationAppearance.tsx app/src/classification/buildTree.ts app/src/preferences/uiPreferences.ts app/src/preferences/uiPreferences.test.ts app/src/styles/global.css
git diff --cached --name-only
git commit -m "feat: add album sidebar hierarchy"
```

---

### Task 7: Add album browsing, inspector membership, batch actions, and drag/drop

**Files:**
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`
- Modify: `app/src/assets/AssetBrowser.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`
- Modify: `app/src/assets/AssetInspector.tsx`
- Modify: `app/src/assets/AssetInspector.test.tsx`
- Modify: `app/src/assets/AssetToolbar.tsx`
- Modify: `app/src/assets/AssetToolbar.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/shared/interaction/pointerDrag.ts`
- Modify: `app/src/shared/interaction/pointerDrag.test.ts`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- `AssetBrowser` consumes both `classifications` and `albums`.
- `AssetInspector` produces `onMoveToFolder(classificationId | null)` and `onPatchAlbum(albumId, "add" | "remove")`.
- Internal drag targets discriminate `{ kind: "classification" | "album"; entryId; valid }`.

- [ ] **Step 1: Write failing asset-query, inspector, toolbar, and drop tests**

Cover these exact outcomes:

```ts
expect(gateway.listAssets).toHaveBeenCalledWith(expect.objectContaining({
  classificationId: null, albumId: "album-1", directOnly: false,
}));

await user.selectOptions(screen.getByLabelText("폴더"), "folder-2");
expect(onMoveToFolder).toHaveBeenCalledWith("folder-2");

await user.click(screen.getByRole("checkbox", { name: "표지 앨범" }));
expect(onPatchAlbum).toHaveBeenCalledWith("album-1", "add");
```

For multiple selected assets, test checked, unchecked, and indeterminate album membership. Test the toolbar's folder move and album add/remove actions. In `App.test.tsx`, assert dropping assets on a normal folder calls `setAssetClassification` and reports `폴더로 이동`, while dropping on an album calls `patchAssetAlbums` and reports `앨범에 추가` without calling the folder setter.

Also feed `handleIngested` an `{ status: "exact_duplicate", existingAssetId: "a", classificationChanged: true }` outcome and assert the asset query refreshes; repeat with `classificationChanged: false` and assert it does not cause an unnecessary refresh.

- [ ] **Step 2: Run focused frontend tests and verify RED**

Run: `npm.cmd test -- src/assets/AssetBrowser.test.tsx src/assets/AssetInspector.test.tsx src/assets/AssetToolbar.test.tsx src/app/App.test.tsx src/shared/interaction/pointerDrag.test.ts`

Expected: FAIL because album views/membership and discriminated drop targets do not exist.

- [ ] **Step 3: Map every `AssetView` to one explicit query scope**

In `AssetBrowser`, build query fields as:

```ts
classificationId: view.kind === "classification" ? view.classificationId : null,
albumId: view.kind === "album" ? view.albumId : null,
directOnly: view.kind === "classification" && directOnly,
```

Hide the `이 분류만` toggle for albums. Use the selected album name as the toolbar location. The album empty state must say `이 앨범에 자산이 없습니다.` and must not imply physical file copying.

In `App.handleIngested`, increment `assetRefresh` for `added` outcomes and for exact duplicates whose `classificationChanged` is true. Keep video preparation restricted to newly added videos.

- [ ] **Step 4: Replace classification checkboxes with one folder select plus album checks**

Load `getAssetClassifications` and `getAssetAlbums` together for all selected assets. Render:

```tsx
<select aria-label="폴더" value={commonFolderId ?? ""}>
  <option value="">미분류</option>
  {classifications.map((entry) => (
    <option key={entry.id} value={entry.id}>{entry.name}</option>
  ))}
</select>
```

Use `""` for `미분류`; for a mixed multi-selection render a disabled placeholder `여러 폴더`. Albums remain checkboxes with indeterminate state. After a successful mutation, increment the inspector membership reload token so displayed state matches the database.

- [ ] **Step 5: Add explicit batch actions**

Change `AssetToolbar` from additive classification operations to:

- `폴더로 이동` → `setAssetClassification({ assetIds, classificationId })`
- `앨범에 추가` → `patchAssetAlbums({ assetIds: selectedIds, addAlbumIds: [id], removeAlbumIds: [] })`
- `앨범에서 제거` → `patchAssetAlbums({ assetIds: selectedIds, addAlbumIds: [], removeAlbumIds: [id] })`

All actions continue through the existing `runBatch` pending/error boundary and refresh once after success.

- [ ] **Step 6: Discriminate drag targets and messages**

Add `data-album-id` to album rows. Replace `classificationTargetAt` with `sidebarTargetAt` that checks both row attributes. For asset payloads, both target kinds are valid. For folder/album tree payloads, only a target of the same kind is valid and cycle/sibling-name checks use the corresponding entry list.

On drop:

```ts
if (target.kind === "classification") {
  await gateway.setAssetClassification({ assetIds: payload.assetIds, classificationId: target.entryId });
  setMessage(`${payload.assetIds.length}개 자산을 폴더로 이동했습니다.`);
} else {
  await gateway.patchAssetAlbums({ assetIds: payload.assetIds, addAlbumIds: [target.entryId], removeAlbumIds: [] });
  setMessage(`${payload.assetIds.length}개 자산을 앨범에 추가했습니다.`);
}
```

Keep native drag-out unchanged.

- [ ] **Step 7: Verify Task 7 GREEN**

Run the focused command from Step 2 again.

Expected: all browser, inspector, toolbar, app, and pointer-drag tests PASS.

Run: `npm.cmd run build`

Expected: TypeScript and Vite build PASS.

- [ ] **Step 8: Commit Task 7**

```powershell
git add -- app/src/app/App.tsx app/src/app/App.test.tsx app/src/assets/AssetBrowser.tsx app/src/assets/AssetBrowser.test.tsx app/src/assets/AssetInspector.tsx app/src/assets/AssetInspector.test.tsx app/src/assets/AssetToolbar.tsx app/src/assets/AssetToolbar.test.tsx app/src/classification/ClassificationSidebar.tsx app/src/shared/interaction/pointerDrag.ts app/src/shared/interaction/pointerDrag.test.ts app/src/styles/global.css
git diff --cached --name-only
git commit -m "feat: manage assets in albums"
```

---

### Task 8: Run the approved two-link repair as an audited one-time tool

**Files:**
- Create: `tools/one_off/repair_comic_game_links.py`
- Create: `tools/one_off/test_repair_comic_game_links.py`
- Modify data only after tests and a verified backup: the single discovered user `library.sqlite` containing exactly two direct `만화` + `게임` overlaps.

**Interfaces:**
- Produces: `find_candidates(home: Path) -> list[Path]` using SQLite read-only mode.
- Produces: `repair(database: Path) -> Path` returning the verified backup path.
- Safety invariant: zero/multiple candidate databases or overlap count other than two raises without any write.

- [ ] **Step 1: Write failing temporary-database safety tests**

Use `unittest.TemporaryDirectory` and a helper `make_library(path: Path, overlap_count: int) -> None` that creates minimal `classification_entries`, `assets`, and `asset_classifications` tables with `만화`, `게임`, and `기타` IDs. Add these tests:

- `test_refuses_zero_one_or_three_overlaps_without_writing`: create three separate temporary roots, run `repair` against each count, assert `RepairRefused`, no backup file, and unchanged link counts.
- `test_refuses_multiple_candidate_databases`: create two databases each with two overlaps, run candidate selection on their common parent, assert `RepairRefused`, no backup file in either library, and four total game links remain.
- `test_two_overlaps_create_verified_backup_and_remove_only_game_links`: create one database with two overlaps, call `repair`, assert the returned backup exists, assert current `게임` overlap count is zero, current `만화` count is two, current `기타` count is two, and current asset count is two. Open the backup read-only, assert `PRAGMA integrity_check` returns `ok`, and assert its `게임`, `만화`, and `기타` counts are each two.

- [ ] **Step 2: Run the repair tests and verify RED**

Run: `python -m unittest tools.one_off.test_repair_comic_game_links -v`

Expected: FAIL because the repair module does not exist.

- [ ] **Step 3: Implement guarded discovery, backup, and one transaction**

The tool must:

1. recursively inspect `Path.home()` for files named `library.sqlite` using read-only URI connections;
2. resolve folder IDs by exact names only inside this historical tool;
3. select assets with direct links to both IDs;
4. require exactly one database with exactly two distinct asset IDs;
5. create `backups/pre-album-repair-<UTC timestamp>-<uuid>.sqlite` with `sqlite3.Connection.backup`;
6. verify the backup with `PRAGMA integrity_check` before mutation;
7. begin `IMMEDIATE`, re-run the same ID/count checks, delete only `(asset_id, game_id)` pairs, assert `rowcount == 2`, and commit;
8. roll back on every mismatch.

The script prints candidate path, two opaque asset IDs, backup path, and final removed count. It must not print media paths or source URLs.

- [ ] **Step 4: Verify the tool GREEN without user-data writes**

Run: `python -m unittest tools.one_off.test_repair_comic_game_links -v`

Expected: all three safety tests PASS.

Run: `python tools/one_off/repair_comic_game_links.py --dry-run`

Expected: either exactly one candidate with count 2, or a refusal message with no write. The earlier read-only scan found no target in the two Desktop libraries, so do not use either one unless the fresh dry run proves it is the approved candidate.

- [ ] **Step 5: Commit the audited tool and tests**

```powershell
git add -- tools/one_off/repair_comic_game_links.py tools/one_off/test_repair_comic_game_links.py
git diff --cached --name-only
git commit -m "tools: add guarded album link repair"
```

- [ ] **Step 6: Pause if discovery does not identify exactly one approved candidate**

If dry-run refuses, report the discovered database paths and counts to the user and ask them to open the Lakomics library containing `만화` and `게임`. Do not run `--apply`, do not guess a path, and continue only after the active library can be identified safely.

- [ ] **Step 7: Apply once and verify the result against backup**

Close the Lakomics development and release apps so no process is writing the database during the one-time repair. Re-run `--dry-run` after closing and proceed only if it still reports the same single database and two opaque asset IDs.

Run: `python tools/one_off/repair_comic_game_links.py --apply`

Expected: one verified backup path and `removed_count=2`.

Run immediately afterward: `python tools/one_off/repair_comic_game_links.py --dry-run`

Expected: refusal because overlap count is now zero; the tool performs no second write.

Report the backup path separately because the user library is not part of Git.

---

### Task 9: Full regression and real Tauri acceptance

**Files:**
- Verify all feature files; change only a concrete defect found by a failing check.

**Interfaces:**
- Consumes the schema, Rust modules, Tauri commands, frontend contracts, sidebar, asset UI, extension boundary, and repair evidence.
- Produces fresh automated and Windows Tauri runtime evidence.

- [ ] **Step 1: Run the full Rust suite**

Run: `cargo test`

Working directory: `app/src-tauri`

Expected: all non-ignored Rust tests PASS, including migration, album, classification, ingestion, extension, query, trash, and foundation flow.

- [ ] **Step 2: Run the full frontend check**

Run: `npm.cmd run check`

Working directory: `app`

Expected: every Vitest file PASS and `tsc && vite build` exits 0.

- [ ] **Step 3: Run the one-time tool tests again**

Run: `python -m unittest tools.one_off.test_repair_comic_game_links -v`

Working directory: repository root.

Expected: all repair safety tests PASS.

- [ ] **Step 4: Verify extension isolation**

Run: `cargo test extension_api`

Expected: `/v1/classifications` contains normal folders only, exact duplicate ingestion moves one direct folder, and no album ID/name appears in the response.

- [ ] **Step 5: Inspect scope and history**

Run:

```powershell
git diff --check
git status --short
git log -10 --oneline
```

Expected: no unstaged implementation files or whitespace errors; only the pre-existing user-owned changes remain dirty; each task has one focused commit.

- [ ] **Step 6: Verify the actual Windows Tauri app without touching existing assets**

Run `npm.cmd run tauri dev` from `app` if the development app is not already running. Create one disposable root album and child album, then verify:

1. `폴더 (N)` and `앨범 (N)` collapse independently and count top-level rows;
2. album right-click and `Shift+F10` expose create-child, rename, appearance, move, and delete;
3. a parent album with a child cannot be deleted and explains why;
4. icon/color changes and hierarchy lines persist after restart;
5. dragging one existing asset to a normal folder says `폴더로 이동` and leaves one direct normal folder;
6. dragging the same asset to two albums says `앨범에 추가`, shows it in both, and creates no file copy;
7. opening a parent album includes the child asset once;
8. inspector folder is single-select and album membership is multi-select;
9. batch folder move and batch album add/remove work;
10. the Edge extension donut still lists only normal folders.

Use only reversible album metadata for acceptance. Before deleting the disposable albums, confirm they contain no user assets; album deletion itself preserves assets.

- [ ] **Step 7: Clean disposable acceptance metadata and report evidence**

Delete the child album and then its empty parent through the app. Report:

- final commit IDs;
- Rust pass count;
- frontend pass count and build result;
- repair-test pass count;
- actual Tauri interactions verified;
- one-time repair backup path and removed count, or the explicit safe blocker if the approved library was not identifiable;
- all unrelated dirty files left untouched.
