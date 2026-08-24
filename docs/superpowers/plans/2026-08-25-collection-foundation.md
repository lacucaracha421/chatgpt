# Collection Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe typed Collection credits, media dates, half-star personal ratings, and deterministic Showcase order without changing the current Collection browsing UI or connecting it to the Online Catalog.

**Architecture:** Extend the existing `collections` table and the current `CollectionSummary`/`UpdateCollection` path rather than introducing new metadata tables or provider abstractions. Preserve existing `year`, `author`, `director`, `showcase`, and `my_score` data; add only the missing typed fields and ordering state. Validate dates and ratings in the Rust library boundary, then expose the same fields through the existing Tauri gateway and edit dialog.

**Tech Stack:** Rust, rusqlite, chrono, Tauri commands, React, TypeScript, Vitest, Testing Library.

## Global Constraints

- The user-facing product name remains `컬렉션`; internal `Collection` naming remains unchanged.
- Online Catalog code, bookmarks, and reading state must not create, update, or import Collections.
- Collection types remain exactly `game`, `manga`, and `movie`; proven legacy `gacha` records remain excluded.
- Personal ratings are stored and transported as `0.0..5.0` values in exact `0.5` increments; null means unrated and existing integer ratings `0..5` are not rewritten.
- Keep existing `year` as the manual fallback. `release_date` stores only a real `YYYY-MM-DD` value and must not invent January 1 for year-only records.
- Do not relabel `author` or `director`: add `developer` for games and `production_company` for movies.
- Keep `showcase` for membership compatibility and add nullable `showcase_order`; current showcased items receive deterministic zero-based order within their type.
- Add no dependency, universal provider interface, new state library, or replacement table.
- Reuse the existing dialog, select, text-field, error, and gateway interfaces.
- Preserve all pre-existing dirty work. Before each commit inspect `git diff` and `git diff --cached`; for already-dirty `app/src-tauri/src/commands.rs` and `app/src/library/client.test.ts`, stage only this plan's hunks.
- Follow `AGENTS.md` verification guidance: run only the targeted test named in each task during iteration, then one TypeScript build in the final task because shared contract fields change broadly.

---

### Task 1: Schema version 22 and safe backfill

**Files:**
- Create: `app/src-tauri/migrations/0022_collection_foundation.sql`
- Modify: `app/src-tauri/src/library/db.rs:5-145`
- Test: `app/src-tauri/src/library/db.rs` (`db::tests`)

**Interfaces:**
- Consumes: schema version 21 and the existing `collections(type, year, author, director, my_score, showcase, created_at)` columns.
- Produces: nullable columns `developer TEXT`, `production_company TEXT`, `release_date TEXT`, and `showcase_order INTEGER`; `SCHEMA_VERSION = 22`.

- [ ] **Step 1: Write the failing v21 migration test**

Add this test to `db::tests`:

```rust
#[test]
fn migrates_v21_collection_foundation_without_rewriting_ratings() {
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
        COLLECTION_LEGACY_KIND_SCHEMA,
    ] {
        connection.execute_batch(schema).unwrap();
    }
    connection.execute_batch(
        "INSERT INTO collections
            (id, name, type, author, my_score, showcase, created_at, updated_at)
         VALUES
            ('game-a', 'Game A', 'game', 'Studio A', 5, 1, '2026-01-01', '2026-01-01'),
            ('game-b', 'Game B', 'game', 'Studio B', 4, 1, '2026-01-02', '2026-01-02'),
            ('movie-a', 'Movie A', 'movie', NULL, 3, 1, '2026-01-01', '2026-01-01');"
    ).unwrap();

    migrate_to_latest(&mut connection, 21).unwrap();

    assert_eq!(
        connection.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0)).unwrap(),
        22
    );
    let game: (Option<String>, Option<String>, Option<String>, Option<f64>, Option<i64>) =
        connection.query_row(
            "SELECT developer, production_company, release_date, my_score, showcase_order
             FROM collections WHERE id = 'game-a'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        ).unwrap();
    assert_eq!(game, (Some("Studio A".into()), None, None, Some(5.0), Some(0)));
    assert_eq!(
        connection.query_row(
            "SELECT showcase_order FROM collections WHERE id = 'game-b'",
            [],
            |row| row.get::<_, Option<i64>>(0),
        ).unwrap(),
        Some(1)
    );
    assert_eq!(
        connection.query_row(
            "SELECT showcase_order FROM collections WHERE id = 'movie-a'",
            [],
            |row| row.get::<_, Option<i64>>(0),
        ).unwrap(),
        Some(0)
    );
}
```

- [ ] **Step 2: Run the migration test to verify RED**

Run:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml --lib library::db::tests::migrates_v21_collection_foundation_without_rewriting_ratings
```

Expected: FAIL because schema version 22 and the new columns do not exist.

- [ ] **Step 3: Add migration 0022**

Create `app/src-tauri/migrations/0022_collection_foundation.sql`:

```sql
ALTER TABLE collections ADD COLUMN developer TEXT;
ALTER TABLE collections ADD COLUMN production_company TEXT;
ALTER TABLE collections ADD COLUMN release_date TEXT;
ALTER TABLE collections ADD COLUMN showcase_order INTEGER;

UPDATE collections
SET developer = author
WHERE type = 'game'
  AND author IS NOT NULL
  AND trim(author) <> '';

UPDATE collections AS current
SET showcase_order = (
    SELECT COUNT(*)
    FROM collections AS earlier
    WHERE earlier.showcase = 1
      AND earlier.type = current.type
      AND (
          earlier.created_at < current.created_at
          OR (earlier.created_at = current.created_at AND earlier.id < current.id)
      )
)
WHERE current.showcase = 1;

CREATE INDEX collections_by_type_release_date
ON collections(type, release_date);

CREATE INDEX collections_by_showcase_order
ON collections(type, showcase_order)
WHERE showcase = 1;

PRAGMA user_version = 22;
```

Do not populate `production_company` from `director`. Do not derive `release_date` from `year`. Do not update `my_score`.

- [ ] **Step 4: Register schema version 22**

In `db.rs`:

```rust
pub(crate) const SCHEMA_VERSION: i64 = 22;
const COLLECTION_FOUNDATION_SCHEMA: &str =
    include_str!("../../migrations/0022_collection_foundation.sql");
```

Expand the accepted old-version range to `0..=21` and append:

```rust
if version <= 21 {
    transaction.execute_batch(COLLECTION_FOUNDATION_SCHEMA)?;
}
```

- [ ] **Step 5: Run the migration test to verify GREEN**

Run the command from Step 2.

Expected: PASS; existing ratings remain numerically equal and Showcase order restarts at zero for each type.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- app/src-tauri/migrations/0022_collection_foundation.sql app/src-tauri/src/library/db.rs
git diff --cached --check
git commit -m "feat: add collection foundation schema"
```

---

### Task 2: Rust Collection contract, validation, and Showcase order

**Files:**
- Modify: `app/src-tauri/src/library/models.rs:360-620`
- Modify: `app/src-tauri/src/library/collection.rs:1-380`
- Modify: `app/src-tauri/src/library/error.rs:75-120`
- Modify: `app/src-tauri/src/commands.rs:45-210`
- Test: `app/src-tauri/src/library/collection.rs` (`collection::tests`)

**Interfaces:**
- Consumes: Task 1 columns.
- Produces: `CollectionSummary.developer`, `production_company`, `release_date`, `showcase_order`, `my_score: Option<f64>`; matching `UpdateCollection` fields; `InvalidCollectionReleaseDate` and `InvalidPersonalRating` public errors.

- [ ] **Step 1: Write failing repository tests**

Replace the invalid 9-point examples in existing Collection tests with valid five-star values, then add:

```rust
#[test]
fn update_collection_persists_typed_credits_date_and_half_star_rating() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let created = library.create_collection(CreateCollection {
        name: "Astral Chain".into(),
        description: None,
        collection_type: CollectionType::Game,
    }).unwrap();

    let updated = library.update_collection(&created.id, UpdateCollection {
        name: "Astral Chain".into(),
        description: None,
        collection_type: CollectionType::Game,
        year: Some(2019),
        author: None,
        director: None,
        developer: Some("  PlatinumGames  ".into()),
        production_company: None,
        release_date: Some("2019-08-30".into()),
        external_score: Some(87),
        my_score: Some(4.5),
    }).unwrap();

    assert_eq!(updated.developer.as_deref(), Some("PlatinumGames"));
    assert_eq!(updated.production_company, None);
    assert_eq!(updated.release_date.as_deref(), Some("2019-08-30"));
    assert_eq!(updated.my_score, Some(4.5));
}

#[test]
fn update_collection_rejects_invalid_date_and_personal_rating() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let created = create(&library, "Invalid metadata");
    let request = |release_date: Option<&str>, my_score: Option<f64>| UpdateCollection {
        name: "Invalid metadata".into(),
        description: None,
        collection_type: CollectionType::Manga,
        year: None,
        author: None,
        director: None,
        developer: None,
        production_company: None,
        release_date: release_date.map(str::to_owned),
        external_score: None,
        my_score,
    };

    assert!(matches!(
        library.update_collection(&created.id, request(Some("2026-02-30"), None)),
        Err(LibraryError::InvalidCollectionReleaseDate)
    ));
    for score in [-0.5, 0.25, 5.5, f64::INFINITY] {
        assert!(matches!(
            library.update_collection(&created.id, request(None, Some(score))),
            Err(LibraryError::InvalidPersonalRating)
        ));
    }
}

#[test]
fn showcase_membership_assigns_stable_order_per_type() {
    let temp = tempfile::tempdir().unwrap();
    let library = Library::open(temp.path()).unwrap();
    let first = create(&library, "First");
    let second = create(&library, "Second");

    assert_eq!(library.set_collection_showcase(&first.id, true).unwrap().showcase_order, Some(0));
    assert_eq!(library.set_collection_showcase(&second.id, true).unwrap().showcase_order, Some(1));
    assert_eq!(library.set_collection_showcase(&first.id, true).unwrap().showcase_order, Some(0));
    let removed = library.set_collection_showcase(&first.id, false).unwrap();
    assert!(!removed.showcase);
    assert_eq!(removed.showcase_order, None);
}
```

- [ ] **Step 2: Run the repository tests to verify RED**

Run:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml --lib library::collection::tests
```

Expected: compilation failures for the new fields and `Option<f64>`, followed by missing validation/order behavior.

- [ ] **Step 3: Extend Rust models**

Add these fields to both `CollectionSummary` and `UpdateCollection` in the same semantic order:

```rust
pub developer: Option<String>,
pub production_company: Option<String>,
pub release_date: Option<String>,
```

Change:

```rust
pub my_score: Option<f64>,
```

Add to `CollectionSummary` after `showcase`:

```rust
pub showcase_order: Option<i64>,
```

- [ ] **Step 4: Add validation errors and command codes**

Add to `LibraryError`:

```rust
#[error("출시·출간·개봉일은 YYYY-MM-DD 형식이어야 합니다")]
InvalidCollectionReleaseDate,
#[error("개인 별점은 0점에서 5점 사이의 0.5점 단위여야 합니다")]
InvalidPersonalRating,
```

Map them in `CommandError::from`:

```rust
LibraryError::InvalidCollectionReleaseDate => "invalid_collection_release_date",
LibraryError::InvalidPersonalRating => "invalid_personal_rating",
```

Because `commands.rs` already contains unrelated user changes, stage only these two match arms for this task and verify the cached diff before committing.

- [ ] **Step 5: Normalize and validate update input**

Add these helpers to `collection.rs`:

```rust
fn normalized_optional_text(value: Option<String>) -> Option<String> {
    value.map(|value| value.trim().to_owned()).filter(|value| !value.is_empty())
}

fn normalized_release_date(value: Option<String>) -> Result<Option<String>, LibraryError> {
    let value = normalized_optional_text(value);
    if value.as_ref().is_some_and(|value| {
        chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_err()
    }) {
        return Err(LibraryError::InvalidCollectionReleaseDate);
    }
    Ok(value)
}

pub(crate) fn validated_personal_rating(
    value: Option<f64>,
) -> Result<Option<f64>, LibraryError> {
    if value.is_some_and(|value| {
        !value.is_finite()
            || !(0.0..=5.0).contains(&value)
            || (value * 2.0).fract() != 0.0
    }) {
        return Err(LibraryError::InvalidPersonalRating);
    }
    Ok(value)
}
```

Call the helpers once before executing the update. Trim `author`, `director`, `developer`, and `production_company`; validate `release_date` and `my_score`.

- [ ] **Step 6: Extend Collection SQL projection and update**

Project the new fields after `director`, and project `showcase_order` immediately after `showcase`. Keep the final query order exactly:

```text
0 id, 1 name, 2 description, 3 type, 4 cover_asset_id,
5 selected_work_artwork_id, 6 asset_count, 7 year, 8 author, 9 director,
10 developer, 11 production_company, 12 release_date, 13 external_score,
14 my_score, 15 genres, 16 overview, 17 showcase, 18 showcase_order,
19 created_at, 20 updated_at, 21 unread_release_count, 22 source_path
```

Update `collection_from_row` to match those indices. Extend `create_collection` with null defaults for the four new columns.

Extend the update statement with:

```sql
developer = ?7,
production_company = ?8,
release_date = ?9,
external_score = ?10,
my_score = ?11,
showcase_order = CASE
    WHEN showcase = 1 AND type <> ?3 THEN (
        SELECT COALESCE(MAX(other.showcase_order) + 1, 0)
        FROM collections AS other
        WHERE other.type = ?3 AND other.id <> ?13
    )
    ELSE showcase_order
END,
updated_at = ?12
```

Use `id` as parameter `?13`. This moves a showcased Collection to the end of its new media type only when its type changes.

- [ ] **Step 7: Make Showcase membership assign deterministic order**

Replace the simple boolean update with one statement that preserves order on idempotent enable, appends newly enabled items within their media type, and clears order on disable:

```sql
UPDATE collections
SET showcase = ?1,
    showcase_order = CASE
        WHEN ?1 = 0 THEN NULL
        WHEN showcase = 1 AND showcase_order IS NOT NULL THEN showcase_order
        ELSE (
            SELECT COALESCE(MAX(other.showcase_order) + 1, 0)
            FROM collections AS other
            WHERE other.type = collections.type AND other.id <> collections.id
        )
    END,
    updated_at = ?2
WHERE id = ?3
```

- [ ] **Step 8: Run repository tests to verify GREEN**

Run the command from Step 2.

Expected: all Collection repository tests pass, including preservation of imported metadata and external bindings.

- [ ] **Step 9: Commit Task 2**

Stage the clean files normally. Stage only this task's two error-code hunks from `commands.rs`, then inspect the result:

```powershell
git add -- app/src-tauri/src/library/models.rs app/src-tauri/src/library/collection.rs app/src-tauri/src/library/error.rs
git add -p -- app/src-tauri/src/commands.rs
git diff --cached --check
git diff --cached
git commit -m "feat: add typed collection metadata"
```

---

### Task 3: Preserve typed metadata through legacy Collection import

**Files:**
- Modify: `app/src-tauri/src/library/book_migration.rs:40-430`
- Modify: `app/src-tauri/src/library/models.rs:590-610`
- Test: `app/src-tauri/src/library/book_migration.rs` (`book_migration::tests`)

**Interfaces:**
- Consumes: `validated_personal_rating`, `CollectionType`, and Task 1 columns.
- Produces: imported game developer values in `developer`; valid `Option<f64>` personal ratings; no fabricated release date or movie production company.

- [ ] **Step 1: Write the failing import test**

Add a test that imports one legacy game entry with `Authors: FromSoftware`, `Publication Year: 2022`, and `Rating: 4.5`, then assert:

```rust
let imported = library.list_collections().unwrap().pop().unwrap();
assert_eq!(imported.collection_type, CollectionType::Game);
assert_eq!(imported.author.as_deref(), Some("FromSoftware"));
assert_eq!(imported.developer.as_deref(), Some("FromSoftware"));
assert_eq!(imported.year, Some(2022));
assert_eq!(imported.release_date, None);
assert_eq!(imported.my_score, Some(4.5));
```

Also add a parser assertion that `Rating: 4.25` is rejected from the import plan with the same public personal-rating rule rather than silently rounded.

- [ ] **Step 2: Run the import tests to verify RED**

Run:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml --lib library::book_migration::tests
```

Expected: FAIL because ratings parse as `i64` and the developer column is not populated.

- [ ] **Step 3: Parse and validate five-star values**

Change the relevant import model field to:

```rust
pub my_score: Option<f64>,
```

Parse the legacy value as `f64`, preserve `Unknown` as null, and call:

```rust
let my_score = parsed_score
    .map(|score| validated_personal_rating(Some(score)))
    .transpose()
    .map_err(|error| error.to_string())?
    .flatten();
```

Import code must reject, not round or clamp, unsupported quarter-step and out-of-range values.

- [ ] **Step 4: Populate only the valid typed legacy credit**

Before the insert:

```rust
let developer = (entry.collection_type == CollectionType::Game)
    .then(|| entry.author.clone())
    .flatten();
```

Add `developer`, `production_company`, `release_date`, and `showcase_order` to the insert column list. Bind `developer`; bind null for the other new fields. Continue preserving `author` so the migration is lossless.

- [ ] **Step 5: Run import tests to verify GREEN**

Run the command from Step 2.

Expected: all book migration tests pass; proven `gacha` behavior remains unchanged.

- [ ] **Step 6: Commit Task 3**

```powershell
git add -- app/src-tauri/src/library/book_migration.rs app/src-tauri/src/library/models.rs
git diff --cached --check
git commit -m "fix: preserve typed metadata in collection import"
```

---

### Task 4: TypeScript contract and minimal edit support

**Files:**
- Modify: `app/src/library/types.ts:135-310`
- Modify: `app/src/library/client.test.ts:104-171`
- Modify: `app/src/collections/CollectionEditDialog.tsx`
- Modify: `app/src/collections/CollectionEditDialog.test.tsx`
- Modify fixture objects in:
  - `app/src/app/App.test.tsx`
  - `app/src/assets/AssetBrowser.test.tsx`
  - `app/src/assets/AssetInspector.test.tsx`
  - `app/src/assets/AssetToolbar.test.tsx`
  - `app/src/collections/CollectionBrowser.test.tsx`
  - `app/src/collections/CollectionOverlay.test.tsx`

**Interfaces:**
- Consumes: Task 2 serialized camelCase fields and existing shared `Select`/`TextField` controls.
- Produces: frontend `CollectionSummary` and `UpdateCollection` parity; editing game developer, movie production company, and 0.5-step personal rating for all media while preserving `releaseDate` until the later media-detail/provider plans expose precise-date editing.

- [ ] **Step 1: Write failing edit-dialog and gateway tests**

Update the gateway contract request to include:

```ts
developer: null,
productionCompany: null,
releaseDate: null,
myScore: 4.5,
```

Add edit-dialog tests that prove:

```ts
it("submits game developer and a half-star personal rating", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<CollectionEditDialog
    open
    mode={{ kind: "edit", collection: { ...sample, type: "game", developer: "PlatinumGames", myScore: 4.5 } }}
    onClose={vi.fn()}
    onSubmit={onSubmit}
  />);

  await user.selectOptions(screen.getByLabelText("내 별점"), "5");
  await user.click(screen.getByRole("button", { name: "저장" }));

  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    developer: "PlatinumGames",
    productionCompany: null,
    releaseDate: null,
    myScore: 5,
  }));
});

it("shows movie production company separately from director", () => {
  render(<CollectionEditDialog
    open
    mode={{ kind: "edit", collection: { ...sample, type: "movie", director: "Director", productionCompany: "Studio" } }}
    onClose={vi.fn()}
    onSubmit={vi.fn()}
  />);

  expect(screen.getByLabelText("제작사")).toHaveValue("Studio");
  expect(screen.getByLabelText("감독")).toHaveValue("Director");
});
```

- [ ] **Step 2: Run targeted frontend tests to verify RED**

Run:

```powershell
npm test --prefix app -- src/collections/CollectionEditDialog.test.tsx src/library/client.test.ts --run
```

Expected: type or assertion failures for missing fields and controls.

- [ ] **Step 3: Extend TypeScript types**

Add to `CollectionSummary` and `UpdateCollection`:

```ts
developer: string | null;
productionCompany: string | null;
releaseDate: string | null;
```

Keep `myScore: number | null`, and add to `CollectionSummary`:

```ts
showcaseOrder: number | null;
```

Update all listed test fixtures with null defaults. Replace fixture ratings outside `0..5` with their intended five-star value; for example, `95` becomes `5` only where it was synthetic test data rather than migrated user data.

- [ ] **Step 4: Extend the existing edit dialog without a new component**

Add local state initialized from the existing Collection:

```ts
const [developer, setDeveloper] = useState(existing?.developer ?? "");
const [productionCompany, setProductionCompany] = useState(existing?.productionCompany ?? "");
const [releaseDate, setReleaseDate] = useState(existing?.releaseDate ?? null);
```

Reset those values in the existing effect and include them in `UpdateCollection`:

```ts
developer: developer.trim() || null,
productionCompany: productionCompany.trim() || null,
releaseDate,
myScore,
```

For games, replace the overloaded `author` field labelled `제작사` with a `developer` field labelled `개발사`. For movies, show both `productionCompany` labelled `제작사` and the existing `director` field.

Use the existing `Select` for every media type:

```tsx
<Select
  label="내 별점"
  value={myScore?.toString() ?? ""}
  onChange={(event) => setMyScore(event.target.value === "" ? null : Number(event.target.value))}
>
  <option value="">미평가</option>
  {[5, 4.5, 4, 3.5, 3, 2.5, 2, 1.5, 1, 0.5, 0].map((rating) => (
    <option key={rating} value={rating}>{rating.toFixed(1)}</option>
  ))}
</Select>
```

Do not create a reusable rating component yet; the Library rating filter is the second real use and belongs to the next implementation plan.

- [ ] **Step 5: Update the gateway contract and all fixtures**

Make the expected `update_collection` payload exactly match the new `UpdateCollection` shape. In each fixture file listed above, add:

```ts
developer: null,
productionCompany: null,
releaseDate: null,
showcaseOrder: null,
```

Set non-null values only in tests that exercise typed credits or Showcase order.

- [ ] **Step 6: Run targeted frontend tests to verify GREEN**

Run the command from Step 2.

Expected: both files pass.

- [ ] **Step 7: Run one compile-level integration check**

Run:

```powershell
npm run build --prefix app
```

Expected: TypeScript and Vite build succeed. The existing chunk-size warning is non-blocking.

- [ ] **Step 8: Commit Task 4**

Stage normal files explicitly. Because `client.test.ts` already contains unrelated user changes, stage only this task's contract hunk there:

```powershell
git add -- app/src/library/types.ts app/src/collections/CollectionEditDialog.tsx app/src/collections/CollectionEditDialog.test.tsx app/src/app/App.test.tsx app/src/assets/AssetBrowser.test.tsx app/src/assets/AssetInspector.test.tsx app/src/assets/AssetToolbar.test.tsx app/src/collections/CollectionBrowser.test.tsx app/src/collections/CollectionOverlay.test.tsx
git add -p -- app/src/library/client.test.ts
git diff --cached --check
git diff --cached
git commit -m "feat: expose collection foundation metadata"
```

---

## Final verification for this plan

After all four task reviews are clean, run fresh checks once:

```powershell
cargo test --manifest-path app/src-tauri/Cargo.toml --lib library::db::tests
cargo test --manifest-path app/src-tauri/Cargo.toml --lib library::collection::tests
cargo test --manifest-path app/src-tauri/Cargo.toml --lib library::book_migration::tests
npm test --prefix app -- src/collections/CollectionEditDialog.test.tsx src/library/client.test.ts --run
npm run build --prefix app
```

Confirm with a read-only SQLite query against a migrated copy or temporary fixture that existing `my_score` values remain in `0..5`, game `author` values were copied to `developer`, movie `production_company` remains null unless explicitly set, and existing Showcase membership has deterministic per-type order.

Do not modify the user's live library as part of automated verification. The application will create its normal pre-migration snapshot when the user later opens the library with the new schema.
