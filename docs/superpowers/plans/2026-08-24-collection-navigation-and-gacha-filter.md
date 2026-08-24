# Collection Type-Only Navigation and Gacha Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve legacy `Type=gacha` provenance, hide those Collections without deleting them, and replace the mixed Collection view with remembered game/manga/movie navigation.

**Architecture:** The existing `book_migration` Module owns parsing and backfilling `legacy_kind`; the `collection` query Module applies the user-visible gacha exclusion once for every caller. React keeps Collection views concretely typed and stores the last selected type in the existing `UiPreferences` Module.

**Tech Stack:** Rust 2021, rusqlite/SQLite migrations, Tauri 2, TypeScript 7, React 19, Vitest 4.

## Global Constraints

- Collection types remain exactly `game | manga | movie`; `gacha` is legacy provenance, not a fourth type.
- `legacy_kind = gacha` rows and all related assets, artwork, volumes, and external bindings remain stored.
- Missing, unreadable, unsafe, or unrecognized source metadata leaves the Collection visible.
- The existing `collection_source_root` is the root for legacy `source_path`; never resolve it relative to the Lakomics library root.
- Existing `legacy_kind` values are never overwritten by automatic backfill.
- No new dependency, provider abstraction, hidden-items setting, or gacha recovery UI.
- Preserve unrelated working-tree changes; stage only files listed by the current task.
- Follow `DESIGN.md`, `docs/agents/implementation.md`, and `docs/agents/lakomics-works-handoff-v2.md` for touched UI.

---

## File Structure

- `app/src-tauri/migrations/0021_collection_legacy_kind.sql` — adds the nullable, constrained provenance column and advances the schema version.
- `app/src-tauri/src/library/db.rs` — registers migration 21 and proves an existing version-20 Collection survives it.
- `app/src-tauri/src/library/book_migration.rs` — defines the legacy-kind value, parses it once, persists it during import, and idempotently backfills existing imported Collections.
- `app/src-tauri/src/library/mod.rs` — invokes the best-effort provenance backfill after the Library is constructed.
- `app/src-tauri/src/library/collection.rs` — excludes proven gacha rows only from the user-visible list interface.
- `app/src/library/types.ts` — mirrors `legacyKind` in book-import previews and makes Collection list views non-nullable.
- `app/src/preferences/uiPreferences.ts` — validates and persists the last Collection type with a manga fallback.
- `app/src/preferences/uiPreferences.test.ts` — covers missing, valid, and invalid stored Collection types.
- `app/src/collections/CollectionBrowser.tsx` — removes the mixed option and accepts only a concrete Collection type.
- `app/src/collections/CollectionBrowser.test.tsx` — proves the three type buttons, filtering, and type-preserving showcase transitions.
- `app/src/classification/ClassificationSidebar.tsx` — opens Collection with the remembered type.
- `app/src/classification/ClassificationSidebar.test.tsx` — verifies the remembered-type navigation payload.
- `app/src/app/App.tsx` — records type changes and returns from detail to the Collection's type or the stored fallback.
- `app/src/app/App.test.tsx` — covers persisted entry and detail-exit navigation.

---

### Task 1: Persist Legacy Kind During Schema Upgrade and Import

**Files:**
- Create: `app/src-tauri/migrations/0021_collection_legacy_kind.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/book_migration.rs`
- Modify: `app/src/library/types.ts`

**Interfaces:**
- Produces Rust `LegacyCollectionKind::{Game, Manga, Movie, Gacha}` with snake-case serde values.
- Produces `BookImportEntry.legacy_kind: Option<LegacyCollectionKind>` and TypeScript `legacyKind: "game" | "manga" | "movie" | "gacha" | null`.
- Produces SQLite `collections.legacy_kind TEXT NULL CHECK (legacy_kind IN ('game', 'manga', 'movie', 'gacha') OR legacy_kind IS NULL)`.
- Preserves the existing mapping from legacy `gacha` to current `CollectionType::Game`.

- [ ] **Step 1: Write the failing version-20 upgrade test**

Add a `db.rs` test that builds the schema through migration 20, inserts an existing game Collection, runs `migrate_to_latest(&mut connection, 20)`, and checks both preservation and the new version:

```rust
#[test]
fn migrates_v20_collection_legacy_kind_without_losing_collections() {
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
        COLLECTION_EXTERNAL_BINDINGS_SCHEMA,
        COLLECTION_WORK_ARTWORKS_SCHEMA,
        COLLECTION_VOLUMES_SCHEMA,
        ALADIN_VOLUME_SOURCES_SCHEMA,
        ALADIN_RELEASE_WATCH_SCHEMA,
        ONLINE_CATALOG_SCHEMA,
        ONLINE_CATALOG_BOOKMARKS_SCHEMA,
        LEGACY_PACKAGE_IMPORTS_SCHEMA,
    ] {
        connection.execute_batch(schema).unwrap();
    }
    connection.execute(
        "INSERT INTO collections (id, name, type, created_at, updated_at)
         VALUES ('game-1', 'Normal Game', 'game', 't', 't')",
        [],
    ).unwrap();

    migrate_to_latest(&mut connection, 20).unwrap();

    assert_eq!(connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(), 21);
    assert_eq!(connection.query_row(
        "SELECT legacy_kind FROM collections WHERE id = 'game-1'",
        [],
        |row| row.get::<_, Option<String>>(0),
    ).unwrap(), None);
}
```

- [ ] **Step 2: Run the migration test and confirm the red state**

Run from `C:\chatgpt`:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml library::db::tests::migrates_v20_collection_legacy_kind_without_losing_collections -- --exact
```

Expected: compilation or assertion failure because schema version 21 and `legacy_kind` do not exist.

- [ ] **Step 3: Add migration 21**

Create `0021_collection_legacy_kind.sql`:

```sql
ALTER TABLE collections ADD COLUMN legacy_kind TEXT
    CHECK (legacy_kind IN ('game', 'manga', 'movie', 'gacha') OR legacy_kind IS NULL);

PRAGMA user_version = 21;
```

In `db.rs`, include the migration, set `SCHEMA_VERSION` to `21`, accept versions `0..=20`, and apply the migration for `version <= 20`:

```rust
const COLLECTION_LEGACY_KIND_SCHEMA: &str =
    include_str!("../../migrations/0021_collection_legacy_kind.sql");

if version <= 20 {
    transaction.execute_batch(COLLECTION_LEGACY_KIND_SCHEMA)?;
}
```

- [ ] **Step 4: Write failing parser/import assertions for gacha provenance**

Extend the closest `book_migration.rs` parser test with a `Type=gacha` fixture and assert both meanings:

```rust
let parsed = parse_info_txt(&folder).unwrap().unwrap();
assert_eq!(parsed.collection_type, CollectionType::Game);
assert_eq!(parsed.legacy_kind, Some(LegacyCollectionKind::Gacha));
```

Also extend the existing normal-game and missing-Type tests to assert `Some(LegacyCollectionKind::Game)` and `None`, respectively. This proves a normal game is distinguishable and unknown provenance is never guessed.

Extend the import persistence test to query:

```rust
let stored: Option<String> = library.connection().unwrap().query_row(
    "SELECT legacy_kind FROM collections WHERE name = 'Gacha Work'",
    [],
    |row| row.get(0),
).unwrap();
assert_eq!(stored.as_deref(), Some("gacha"));
```

- [ ] **Step 5: Run the book-migration tests and confirm the red state**

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml library::book_migration::tests
```

Expected: compilation failure because `LegacyCollectionKind` and `legacy_kind` are not defined.

- [ ] **Step 6: Parse and persist the normalized original Type**

Add the serde enum and field:

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LegacyCollectionKind {
    Game,
    Manga,
    Movie,
    Gacha,
}

pub struct BookImportEntry {
    // existing fields
    pub legacy_kind: Option<LegacyCollectionKind>,
}
```

Parse the raw Type once into `(CollectionType, Option<LegacyCollectionKind>)`. Missing or unrecognized values remain current-type manga with `legacy_kind = None`; recognized `gacha` maps to `(Game, Some(Gacha))`.

Add `legacy_kind` to the Collection INSERT and bind it through a helper with one match:

```rust
fn legacy_kind_str(kind: LegacyCollectionKind) -> &'static str {
    match kind {
        LegacyCollectionKind::Game => "game",
        LegacyCollectionKind::Manga => "manga",
        LegacyCollectionKind::Movie => "movie",
        LegacyCollectionKind::Gacha => "gacha",
    }
}
```

Mirror the serialized field in TypeScript:

```ts
export type LegacyCollectionKind = "game" | "manga" | "movie" | "gacha";

export type BookImportEntry = {
  // existing fields
  legacyKind: LegacyCollectionKind | null;
};
```

- [ ] **Step 7: Run migration and import tests in the green state**

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml library::db::tests::migrates_v20_collection_legacy_kind_without_losing_collections -- --exact
cargo test --manifest-path app/src-tauri/Cargo.toml library::book_migration::tests
```

Expected: both commands exit 0 with all selected tests passing.

- [ ] **Step 8: Commit the schema and import provenance**

```powershell
git add -- app/src-tauri/migrations/0021_collection_legacy_kind.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/book_migration.rs app/src/library/types.ts
git commit -m "feat: preserve legacy collection kinds"
```

---

### Task 2: Backfill Provenance and Hide Proven Gacha Collections

**Files:**
- Modify: `app/src-tauri/src/library/book_migration.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/collection.rs`

**Interfaces:**
- Consumes `LegacyCollectionKind` and `legacy_kind_str` from Task 1.
- Consumes `collection_source::collection_source_root(&Connection) -> Result<Option<String>, LibraryError>`.
- Produces `Library::backfill_legacy_collection_kinds(&self) -> Result<u64, LibraryError>`; the count is updated rows, while per-row filesystem/parsing failures are skipped.
- Keeps `Library::get_collection(id)` unchanged and applies exclusion only to `Library::list_collections()`.

- [ ] **Step 1: Write failing backfill safety tests**

In `book_migration.rs`, create a temp source root with `gacha/info.txt`, configure it using `set_collection_source_root`, and insert rows with `source_path` and null `legacy_kind`. Cover these assertions in focused tests:

```rust
assert_eq!(library.backfill_legacy_collection_kinds().unwrap(), 1);
assert_eq!(stored_legacy_kind(&library, "gacha-1").as_deref(), Some("gacha"));
assert_eq!(library.backfill_legacy_collection_kinds().unwrap(), 0); // idempotent
```

Add separate rows for a missing folder and for an existing non-null `legacy_kind`; assert that both values remain unchanged and the method returns successfully.

Add an unsafe `source_path = '../outside'` whose target contains `Type=gacha`; assert that it remains null.

- [ ] **Step 2: Run the backfill test and confirm the red state**

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml library::book_migration::tests::backfills_safe_legacy_kinds_without_overwriting_or_guessing -- --exact
```

Expected: compilation failure because `backfill_legacy_collection_kinds` does not exist.

- [ ] **Step 3: Implement the idempotent best-effort backfill**

Implement the method in `book_migration.rs` with this data flow:

```rust
pub(crate) fn backfill_legacy_collection_kinds(&self) -> Result<u64, LibraryError> {
    let connection = self.connection()?;
    let Some(root) = collection_source_root(&connection)? else { return Ok(0) };
    let Ok(canonical_root) = fs::canonicalize(&root) else { return Ok(0) };
    let rows = pending_legacy_sources(&connection)?;
    let mut updated = 0;
    for (id, source_path) in rows {
        let Ok(folder) = fs::canonicalize(canonical_root.join(source_path)) else { continue };
        if !folder.starts_with(&canonical_root) { continue; }
        let Ok(Some(parsed)) = parse_info_txt(&folder) else { continue };
        let Some(kind) = parsed.legacy_kind else { continue };
        updated += connection.execute(
            "UPDATE collections SET legacy_kind = ?1 WHERE id = ?2 AND legacy_kind IS NULL",
            params![legacy_kind_str(kind), id],
        )? as u64;
    }
    Ok(updated)
}
```

`pending_legacy_sources` must select only `source_path IS NOT NULL AND legacy_kind IS NULL`. Do not log file names or turn per-row read/parse failures into startup failures.

Call the method immediately after constructing `Library` in `Library::open`:

```rust
library.backfill_legacy_collection_kinds()?;
```

Database failures still fail `Library::open`; absent or invalid legacy source files do not.

- [ ] **Step 4: Run the backfill tests in the green state**

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml library::book_migration::tests::backfills_safe_legacy_kinds_without_overwriting_or_guessing -- --exact
```

Expected: exit 0 and the selected test passes.

- [ ] **Step 5: Write the failing Collection-list exclusion test**

In `collection.rs`, create two game Collections, mark only one as gacha through SQL, and prove direct access remains possible while the user list excludes it:

```rust
library.connection().unwrap().execute(
    "UPDATE collections SET legacy_kind = 'gacha' WHERE id = ?1",
    [&gacha.id],
).unwrap();

assert_eq!(library.get_collection(&gacha.id).unwrap().id, gacha.id);
assert_eq!(library.list_collections().unwrap().iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), vec![game.id.as_str()]);
```

- [ ] **Step 6: Run the Collection-list test and confirm the red state**

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml library::collection::tests::list_collections_hides_only_proven_legacy_gacha -- --exact
```

Expected: assertion failure because the list still contains both Collections.

- [ ] **Step 7: Filter gacha at the list query seam**

Change only `list_collections` to append the predicate before its ordering:

```rust
let sql = format!(
    "{COLLECTION_SUMMARY_SQL}
     WHERE collection.legacy_kind IS NULL OR collection.legacy_kind <> 'gacha'
     ORDER BY collection.updated_at DESC, collection.id DESC"
);
```

Do not add the predicate to `collection_by_id`, membership, deletion, artwork, volume, or external-binding queries.

- [ ] **Step 8: Run the backend behavior tests in the green state**

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml library::collection::tests::list_collections_hides_only_proven_legacy_gacha -- --exact
cargo test --manifest-path app/src-tauri/Cargo.toml library::book_migration::tests
```

Expected: both commands exit 0 with all selected tests passing.

- [ ] **Step 9: Commit backfill and query policy**

```powershell
git add -- app/src-tauri/src/library/book_migration.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/library/collection.rs
git commit -m "feat: hide legacy gacha collections"
```

---

### Task 3: Remember a Concrete Collection Type

**Files:**
- Modify: `app/src/preferences/uiPreferences.ts`
- Modify: `app/src/preferences/uiPreferences.test.ts`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/collections/CollectionBrowser.tsx`
- Modify: `app/src/collections/CollectionBrowser.test.tsx`
- Modify: `app/src/classification/ClassificationSidebar.tsx`
- Modify: `app/src/classification/ClassificationSidebar.test.tsx`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/app/App.test.tsx`

**Interfaces:**
- Produces `UiPreferences.collectionType: CollectionType`, defaulting to `"manga"` and validated by `isCollectionType`.
- Changes `AssetView` Collection-list variant to `{ kind: "collections"; typeFilter: CollectionType; showcase: boolean }`.
- Changes `CollectionBrowserProps.typeFilter` and `TypeSegment.current/onChange` to non-null `CollectionType`.
- Adds `ClassificationSidebar` prop `collectionType: CollectionType`.
- `LibraryWorkspace.navigateView` persists every Collection-list type before navigation.

- [ ] **Step 1: Write failing UI-preference tests**

Update complete `UiPreferences` fixtures with `collectionType`. Add validation assertions:

```ts
it("restores a valid collection type and replaces an invalid one with manga", () => {
  const localStorage = storage();
  localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ collectionType: "movie" }));
  expect(loadUiPreferences(localStorage).collectionType).toBe("movie");

  localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ collectionType: "gacha" }));
  expect(loadUiPreferences(localStorage).collectionType).toBe("manga");
});
```

- [ ] **Step 2: Run the preference test and confirm the red state**

```powershell
npm test -- src/preferences/uiPreferences.test.ts
```

Run from `C:\chatgpt\app`. Expected: assertions fail because `collectionType` is absent.

- [ ] **Step 3: Add the validated Collection type preference**

Import `CollectionType`, add the field/default, and validate it without changing the storage key:

```ts
export type UiPreferences = {
  // existing fields
  collectionType: CollectionType;
};

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  // existing defaults
  collectionType: "manga",
};

function isCollectionType(value: unknown): value is CollectionType {
  return value === "game" || value === "manga" || value === "movie";
}
```

`loadUiPreferences` must return `value.collectionType` only when the validator accepts it; otherwise return `DEFAULT_UI_PREFERENCES.collectionType`.

- [ ] **Step 4: Run the preference test in the green state**

```powershell
npm test -- src/preferences/uiPreferences.test.ts
```

Expected: exit 0 and the selected file passes.

- [ ] **Step 5: Write failing Collection-browser tests without the mixed option**

Replace nullable fixtures with concrete types and add these assertions:

```ts
renderBrowser({ collections: [game, manga], typeFilter: "game", showcase: false });
expect(screen.queryByRole("button", { name: "전체" })).not.toBeInTheDocument();
expect(screen.getByRole("button", { name: "게임" })).toHaveAttribute("aria-pressed", "true");
expect(screen.queryByText(manga.name)).not.toBeInTheDocument();
```

For showcase, click `쇼케이스` and assert:

```ts
expect(onViewChange).toHaveBeenCalledWith({
  kind: "collections",
  typeFilter: "game",
  showcase: true,
});
```

- [ ] **Step 6: Run the Collection-browser tests and confirm the red state**

```powershell
npm test -- src/collections/CollectionBrowser.test.tsx
```

Expected: the `전체` assertion fails and nullable test fixtures remain accepted.

- [ ] **Step 7: Remove the nullable Collection view and mixed segment**

Change the shared view type:

```ts
| { kind: "collections"; typeFilter: CollectionType; showcase: boolean }
```

Change `CollectionBrowser` and `TypeSegment` to concrete `CollectionType`. Use exactly these options:

```ts
const options: Array<[CollectionType, string]> = [
  ["game", "게임"],
  ["manga", "만화"],
  ["movie", "영화"],
];
```

Always filter with `collection.type !== typeFilter`, and always derive the heading from `TYPE_LABEL[typeFilter]`.

- [ ] **Step 8: Run the Collection-browser tests in the green state**

```powershell
npm test -- src/collections/CollectionBrowser.test.tsx
```

Expected: exit 0 and the selected file passes.

- [ ] **Step 9: Write failing remembered-entry and detail-exit tests**

Update the sidebar render helper and every direct `<ClassificationSidebar>` test render to pass a concrete `collectionType`; use `"movie"` in the Collection quick-view case. Change its navigation assertion to:

```ts
expect(onViewChange).toHaveBeenCalledWith({
  kind: "collections",
  typeFilter: "movie",
  showcase: false,
});
```

In `App.test.tsx`, start with stored `collectionType: "game"`, click the Collection quick view, and assert that the game heading is rendered. Then open a manga Collection, click `컬렉션 표지 보기 닫기`, and assert that the manga Collection heading is rendered. Add a missing-Collection case and assert fallback to the stored game type.

- [ ] **Step 10: Run the navigation tests and confirm the red state**

```powershell
npm test -- src/classification/ClassificationSidebar.test.tsx src/app/App.test.tsx
```

Expected: type errors or payload assertion failures because the sidebar does not accept the remembered type and detail exit still uses null.

- [ ] **Step 11: Wire remembered navigation through the existing preferences Module**

Pass the preference into the sidebar:

```tsx
<ClassificationSidebar
  collectionType={preferences.collectionType}
  // existing props
/>
```

Use it for the quick view:

```tsx
onClick={() => onViewChange({
  kind: "collections",
  typeFilter: collectionType,
  showcase: false,
})}
```

Persist any Collection-list navigation in `navigateView`:

```ts
function navigateView(next: AssetView) {
  if (next.kind === "settings" && view.kind !== "settings") settingsReturnViewRef.current = view;
  if (next.kind === "collections") updatePreferences({ collectionType: next.typeFilter });
  setView(next);
}
```

Return from Collection detail using the loaded Collection type, then the stored preference:

```ts
const detailCollection = view.kind === "collection"
  ? collections.find((item) => item.id === view.collectionId)
  : undefined;

onExit={() => setView({
  kind: "collections",
  typeFilter: detailCollection?.type ?? preferences.collectionType,
  showcase: false,
})}
```

- [ ] **Step 12: Run the related React tests and TypeScript production compile**

Run from `C:\chatgpt\app`:

```powershell
npm test -- src/preferences/uiPreferences.test.ts src/collections/CollectionBrowser.test.tsx src/classification/ClassificationSidebar.test.tsx src/app/App.test.tsx
npm run build
```

Expected: both commands exit 0; all selected Vitest files pass and TypeScript/Vite build completes.

- [ ] **Step 13: Run the final targeted backend verification**

Run from `C:\chatgpt`:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml library::db::tests::migrates_v20_collection_legacy_kind_without_losing_collections -- --exact
cargo test --manifest-path app/src-tauri/Cargo.toml library::book_migration::tests
cargo test --manifest-path app/src-tauri/Cargo.toml library::collection::tests::list_collections_hides_only_proven_legacy_gacha -- --exact
```

Expected: all three commands exit 0. Expand verification only if these checks expose a cross-Module regression.

- [ ] **Step 14: Commit concrete Collection navigation**

```powershell
git add -- app/src/preferences/uiPreferences.ts app/src/preferences/uiPreferences.test.ts app/src/library/types.ts app/src/collections/CollectionBrowser.tsx app/src/collections/CollectionBrowser.test.tsx app/src/classification/ClassificationSidebar.tsx app/src/classification/ClassificationSidebar.test.tsx app/src/app/App.tsx app/src/app/App.test.tsx
git commit -m "feat: simplify collection type navigation"
```

---

## Completion Evidence

Before reporting completion, run `git status --short` and identify the three feature commits separately from the user's pre-existing changes. Report the exact test/build commands and their exit status. Do not push unless the user requests it.
