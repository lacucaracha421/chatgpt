# Online Manga Library UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a thumbnail-first online manga catalog with library-portable bookmarks, exact bookmarked filtering, a metadata/tag detail dialog, and an explicit read/resume transition.

**Architecture:** Keep the imported VCK database replaceable and store user bookmarks in `library.sqlite`. Query the two databases together inside the catalog repository so bookmark filtering and pagination remain exact; return only validated thumbnail URLs. React consumes narrow catalog summary/detail interfaces, keeps list state in `OnlineCatalogBrowser`, and resolves signed page URLs only after the user activates the detail dialog's read action.

**Tech Stack:** Rust 2021, rusqlite, Tauri 2 commands, React 19, TypeScript 7, Radix Dialog through the shared `Dialog`, Vitest/Testing Library, CSS design tokens.

**Spec:** `docs/superpowers/specs/2026-08-22-online-manga-library-ux-design.md`

## Global Constraints

- Preserve the imported VCK catalog as replaceable provider data; never write bookmarks into `catalogs/kdata.db`.
- Bookmark identity is `provider + work_id`; the first provider value is exactly `kHentai`.
- Accept thumbnail URLs only when they use HTTPS, contain no credentials, and have host `ehgt.org` or a host ending in `.ehgt.org`.
- Do not resolve gallery manifests to render catalog thumbnails.
- Card click opens detail; only the detail dialog's read action resolves and opens the page viewer.
- Use existing shared controls, dialogs, tokens, and the existing 4 px spacing language.
- No new dependency, gradient, glass surface, large radius, card shadow, hover scaling, or decorative motion.
- Keep the second toolbar row local to the Manga online-catalog view.
- Default to the targeted checks listed per task. Expand only when a targeted failure identifies broader risk.
- The worktree already contains overlapping uncommitted work. At commit steps, inspect the diff and use `git add -p` for tracked files so unrelated hunks are not staged.

---

### Task 1: Library-owned bookmark persistence

**Files:**
- Create: `app/src-tauri/migrations/0019_online_catalog_bookmarks.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/online_catalog.rs`

**Interfaces:**
- Consumes: `Library::connection()` and the fixed provider name `kHentai`.
- Produces: `Library::set_online_catalog_bookmark(work_id: u64, bookmarked: bool) -> Result<(), LibraryError>` and `online_catalog_bookmarks(provider, work_id, created_at)`.

- [ ] **Step 1: Write the failing schema migration test**

Add a `migrates_v18_to_online_catalog_bookmarks` test beside `migrates_v17_to_online_catalog` in `db.rs`. Build an in-memory database through schema 18, call `migrate_to_latest(&mut connection, 18)`, insert a row, and assert its composite identity:

```rust
#[test]
fn migrates_v18_to_online_catalog_bookmarks() {
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
    ] {
        connection.execute_batch(schema).unwrap();
    }

    migrate_to_latest(&mut connection, 18).unwrap();
    connection.execute(
        "INSERT INTO online_catalog_bookmarks (provider, work_id, created_at) VALUES ('kHentai', '42', '2026-08-22T00:00:00Z')",
        [],
    ).unwrap();

    assert_eq!(
        connection.query_row(
            "SELECT provider || ':' || work_id FROM online_catalog_bookmarks",
            [],
            |row| row.get::<_, String>(0),
        ).unwrap(),
        "kHentai:42",
    );
}
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `cargo test migrates_v18_to_online_catalog_bookmarks --lib`

Expected: FAIL because schema version 19 and `online_catalog_bookmarks` do not exist.

- [ ] **Step 3: Add migration 0019 and register it**

Create the migration:

```sql
CREATE TABLE online_catalog_bookmarks (
    provider TEXT NOT NULL,
    work_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (provider, work_id)
) WITHOUT ROWID;

PRAGMA user_version = 19;
```

In `db.rs`, set `SCHEMA_VERSION` to `19`, include the migration as `ONLINE_CATALOG_BOOKMARKS_SCHEMA`, accept versions `0..=18`, and execute it when `version <= 18`.

- [ ] **Step 4: Write the failing bookmark idempotency test**

In `online_catalog.rs`, build a catalog that can be imported twice and add:

```rust
#[test]
fn bookmarks_are_idempotent_and_survive_catalog_reimport() {
    let library_root = tempfile::tempdir().unwrap();
    let vck_root = tempfile::tempdir().unwrap();
    write_vck_fixture(vck_root.path(), 3, r#"{"character:teitoku":"제독"}"#);
    let library = Library::open(library_root.path()).unwrap();
    library.import_vck_catalog(vck_root.path()).unwrap();

    library.set_online_catalog_bookmark(3, true).unwrap();
    library.set_online_catalog_bookmark(3, true).unwrap();
    library.import_vck_catalog(vck_root.path()).unwrap();
    assert_eq!(
        library.connection().unwrap().query_row(
            "SELECT COUNT(*) FROM online_catalog_bookmarks WHERE provider = 'kHentai' AND work_id = '3'",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(),
        1,
    );

    library.set_online_catalog_bookmark(3, false).unwrap();
    assert_eq!(
        library.connection().unwrap().query_row(
            "SELECT COUNT(*) FROM online_catalog_bookmarks WHERE provider = 'kHentai' AND work_id = '3'",
            [],
            |row| row.get::<_, i64>(0),
        ).unwrap(),
        0,
    );
}
```

- [ ] **Step 5: Run the bookmark test and verify RED**

Run: `cargo test bookmarks_are_idempotent_and_survive_catalog_reimport --lib`

Expected: FAIL because `set_online_catalog_bookmark` is missing.

- [ ] **Step 6: Implement the minimal bookmark mutation**

Add to `impl Library` in `online_catalog.rs`:

```rust
pub fn set_online_catalog_bookmark(
    &self,
    work_id: u64,
    bookmarked: bool,
) -> Result<(), LibraryError> {
    let connection = self.connection()?;
    if bookmarked {
        connection.execute(
            "INSERT INTO online_catalog_bookmarks (provider, work_id, created_at)
             VALUES ('kHentai', ?1, ?2)
             ON CONFLICT(provider, work_id) DO NOTHING",
            rusqlite::params![work_id.to_string(), chrono::Utc::now().to_rfc3339()],
        )?;
    } else {
        connection.execute(
            "DELETE FROM online_catalog_bookmarks WHERE provider = 'kHentai' AND work_id = ?1",
            [work_id.to_string()],
        )?;
    }
    Ok(())
}
```

- [ ] **Step 7: Verify Task 1 GREEN**

Run: `cargo test migrates_v18_to_online_catalog_bookmarks --lib`

Then run: `cargo test bookmarks_are_idempotent_and_survive_catalog_reimport --lib`

Expected: both commands PASS.

- [ ] **Step 8: Commit only Task 1 hunks**

```powershell
git diff -- app/src-tauri/migrations/0019_online_catalog_bookmarks.sql app/src-tauri/src/library/db.rs app/src-tauri/src/library/online_catalog.rs
git add app/src-tauri/migrations/0019_online_catalog_bookmarks.sql
git add -p app/src-tauri/src/library/db.rs app/src-tauri/src/library/online_catalog.rs
git commit -m "feat: persist online manga bookmarks"
```

### Task 2: Exact catalog summaries, thumbnail validation, and detail lookup

**Files:**
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/online_catalog.rs`
- Modify: `app/src-tauri/src/library/error.rs`

**Interfaces:**
- Consumes: `online_catalog_bookmarks` from Task 1 and imported `catalog.Works` / `catalog.Tags`.
- Produces: `CatalogScope`, extended `CatalogSearchQuery`, extended `CatalogWork`, `CatalogTagGroup`, `CatalogWorkDetail`, `Library::online_catalog_work_detail(work_id)`.

- [ ] **Step 1: Extend the fixture schema before writing behavior tests**

Make the test-only `Works` schema match the fields consumed by production queries:

```sql
CREATE TABLE Works (
    Id INTEGER PRIMARY KEY,
    Title TEXT NOT NULL DEFAULT '',
    TitleJpn TEXT,
    Category INTEGER,
    Uploader TEXT,
    Posted INTEGER,
    Updated INTEGER,
    FileCount INTEGER NOT NULL DEFAULT 0,
    FileSize INTEGER,
    Rating INTEGER,
    Views INTEGER NOT NULL DEFAULT 0,
    Thumb TEXT,
    Expunged INTEGER NOT NULL DEFAULT 0
);
```

Set work 3 to thumbnail `https://ehgt.org/w/00/003/work.webp`, uploader `tester`, size `12345`, rating `4`, and insert both `character:teitoku` and `language:korean` tags.

- [ ] **Step 2: Write failing tests for exact filtering and thumbnail validation**

Add these assertions to focused tests:

```rust
#[test]
fn search_filters_bookmarks_before_counting_and_paging() {
    let (_root, library) = searchable_library();
    library.set_online_catalog_bookmark(3, true).unwrap();

    let page = library.search_online_catalog(CatalogSearchQuery {
        text: String::new(),
        sort: CatalogSort::Latest,
        scope: CatalogScope::Bookmarked,
        page: 0,
        page_size: 1,
    }).unwrap();

    assert_eq!(page.total_count, 1);
    assert_eq!(page.works[0].id, 3);
    assert!(page.works[0].bookmarked);
    assert_eq!(page.works[0].thumbnail_url.as_deref(), Some("https://ehgt.org/w/00/003/work.webp"));
}

#[test]
fn thumbnail_validation_rejects_untrusted_urls() {
    assert_eq!(validated_thumbnail_url(Some("http://ehgt.org/a.webp".into())), None);
    assert_eq!(validated_thumbnail_url(Some("https://user@ehgt.org/a.webp".into())), None);
    assert_eq!(validated_thumbnail_url(Some("https://evil.example/a.webp".into())), None);
    assert_eq!(
        validated_thumbnail_url(Some("https://a.ehgt.org/a.webp".into())),
        Some("https://a.ehgt.org/a.webp".into()),
    );
}
```

- [ ] **Step 3: Run the summary tests and verify RED**

Run: `cargo test search_filters_bookmarks_before_counting_and_paging --lib`

Then run: `cargo test thumbnail_validation_rejects_untrusted_urls --lib`

Expected: both commands FAIL because scope, summary bookmark/thumbnail fields, and URL validation are missing.

- [ ] **Step 4: Add the summary models and validate URLs in Rust**

Add:

```rust
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CatalogScope { All, Bookmarked }

// Add to CatalogSearchQuery:
pub scope: CatalogScope,

// Add to CatalogWork:
pub thumbnail_url: Option<String>,
pub bookmarked: bool,
```

Update the test `query(...)` helper and every direct `CatalogSearchQuery` construction to use
`scope: CatalogScope::All` unless the test explicitly exercises bookmarked scope.

Implement:

```rust
fn validated_thumbnail_url(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let url = url::Url::parse(&raw).ok()?;
    let host = url.host_str()?;
    (url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && (host == "ehgt.org" || host.ends_with(".ehgt.org")))
        .then_some(raw)
}
```

Use the main library connection and attach `catalogs/kdata.db` as `catalog` for each search. Prefix provider tables as `catalog.Works` and `catalog.Tags`, including the existing `tags_for` helper. For bookmarked scope add this clause before total count, ordering, limit, and offset:

```sql
EXISTS (
  SELECT 1 FROM online_catalog_bookmarks AS bookmark
  WHERE bookmark.provider = 'kHentai'
    AND bookmark.work_id = CAST(catalog.Works.Id AS TEXT)
)
```

Select `Thumb` and the same expression as `bookmarked`, ensuring filtering occurs before `COUNT(*)` and paging.

- [ ] **Step 5: Write the failing detail grouping test**

```rust
#[test]
fn detail_returns_optional_metadata_and_grouped_tags() {
    let (_root, library) = searchable_library();
    library.set_online_catalog_bookmark(3, true).unwrap();

    let detail = library.online_catalog_work_detail(3).unwrap();

    assert_eq!(detail.id, 3);
    assert_eq!(detail.uploader.as_deref(), Some("tester"));
    assert_eq!(detail.file_size, Some(12_345));
    assert!(detail.bookmarked);
    assert_eq!(
        detail.tag_groups.iter().map(|group| (group.namespace.clone(), group.values.clone())).collect::<Vec<_>>(),
        vec![
            ("character".into(), vec!["teitoku".into()]),
            ("language".into(), vec!["korean".into()]),
        ],
    );
}
```

- [ ] **Step 6: Run the detail test and verify RED**

Run: `cargo test detail_returns_optional_metadata_and_grouped_tags --lib`

Expected: FAIL because `CatalogWorkDetail` and the lookup method do not exist.

- [ ] **Step 7: Implement detail models and lookup**

Add serializable models and a concrete not-found error:

```rust
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogTagGroup {
    pub namespace: String,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogWorkDetail {
    pub id: u64,
    pub title: String,
    pub title_jpn: Option<String>,
    pub thumbnail_url: Option<String>,
    pub uploader: Option<String>,
    pub category: Option<i64>,
    pub posted: Option<i64>,
    pub updated: Option<i64>,
    pub file_count: u32,
    pub file_size: Option<u64>,
    pub rating: Option<i64>,
    pub views: u64,
    pub bookmarked: bool,
    pub tag_groups: Vec<CatalogTagGroup>,
}

// LibraryError:
#[error("온라인 카탈로그 작품을 찾을 수 없습니다")]
OnlineCatalogWorkNotFound,
```

`online_catalog_work_detail` attaches the catalog, selects one non-expunged work plus bookmark state, reads tags ordered by `Namespace, Value`, and folds adjacent namespaces into `CatalogTagGroup`. Return `LibraryError::OnlineCatalogWorkNotFound` when the work ID is absent; do not resolve gallery pages.

- [ ] **Step 8: Verify Task 2 GREEN**

Run: `cargo test online_catalog --lib`

Expected: all online catalog tests PASS.

- [ ] **Step 9: Commit only Task 2 hunks**

```powershell
git diff -- app/src-tauri/src/library/models.rs app/src-tauri/src/library/online_catalog.rs app/src-tauri/src/library/error.rs
git add -p app/src-tauri/src/library/models.rs app/src-tauri/src/library/online_catalog.rs app/src-tauri/src/library/error.rs
git commit -m "feat: query online manga summaries and details"
```

### Task 3: Tauri and TypeScript catalog contracts

**Files:**
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/library/client.test.ts`

**Interfaces:**
- Consumes: repository methods and Rust models from Tasks 1-2.
- Produces: `getOnlineCatalogWorkDetail(workId)`, `setOnlineCatalogBookmark(workId, bookmarked)`, and TypeScript summary/detail types used by the UI.

- [ ] **Step 1: Write the failing gateway contract test**

Extend the online catalog contract test:

```ts
await libraryGateway.getOnlineCatalogWorkDetail(3);
await libraryGateway.setOnlineCatalogBookmark(3, true);

expect(invoke).toHaveBeenCalledWith("get_online_catalog_work_detail", { workId: 3 });
expect(invoke).toHaveBeenCalledWith("set_online_catalog_bookmark", { workId: 3, bookmarked: true });
```

Also add `scope: "all"` to every `CatalogSearchQuery` fixture.

- [ ] **Step 2: Run the gateway test and verify RED**

Run: `npm.cmd test -- src/library/client.test.ts`

Expected: FAIL because the gateway methods and query scope are absent.

- [ ] **Step 3: Add matching Rust commands and register them**

```rust
#[tauri::command]
pub async fn get_online_catalog_work_detail(
    work_id: u64,
    state: State<'_, AppState>,
) -> Result<CatalogWorkDetail, CommandError> {
    let library = current_required(state)?;
    tauri::async_runtime::spawn_blocking(move || library.online_catalog_work_detail(work_id))
        .await
        .map_err(|_| background_task_error())?
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn set_online_catalog_bookmark(
    work_id: u64,
    bookmarked: bool,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    current_required(state)?
        .set_online_catalog_bookmark(work_id, bookmarked)
        .map_err(CommandError::from)
}
```

Import `CatalogWorkDetail` and register both commands in `lib.rs`.
Map `LibraryError::OnlineCatalogWorkNotFound` to command code
`online_catalog_work_not_found` in `CommandError::from`.

- [ ] **Step 4: Add exact TypeScript contracts and gateway calls**

```ts
export type CatalogScope = "all" | "bookmarked";

export type CatalogTagGroup = { namespace: string; values: string[] };

export type CatalogWorkDetail = {
  id: number;
  title: string;
  titleJpn: string | null;
  thumbnailUrl: string | null;
  uploader: string | null;
  category: number | null;
  posted: number | null;
  updated: number | null;
  fileCount: number;
  fileSize: number | null;
  rating: number | null;
  views: number;
  bookmarked: boolean;
  tagGroups: CatalogTagGroup[];
};
```

Add `scope` to `CatalogSearchQuery`, `thumbnailUrl` and `bookmarked` to `CatalogWork`, and these gateway methods:

```ts
getOnlineCatalogWorkDetail(workId: number): Promise<CatalogWorkDetail>;
setOnlineCatalogBookmark(workId: number, bookmarked: boolean): Promise<void>;
```

Map them in `client.ts` with the command names asserted by the test.

- [ ] **Step 5: Verify Task 3 GREEN**

Run: `npm.cmd test -- src/library/client.test.ts`

Expected: PASS.

- [ ] **Step 6: Run compile checks for the cross-language contract**

Run: `npm.cmd run build`

Then run: `cargo test online_catalog --lib`

Expected: both exit 0. Update all existing query fixtures and gateway test doubles that the compiler identifies; use `scope: "all"` and complete summary/detail shapes rather than casts that hide missing fields.

- [ ] **Step 7: Commit only Task 3 hunks**

```powershell
git diff -- app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src/library/types.ts app/src/library/client.ts app/src/library/client.test.ts
git add -p app/src-tauri/src/commands.rs app/src-tauri/src/lib.rs app/src/library/types.ts app/src/library/client.ts app/src/library/client.test.ts
git commit -m "feat: expose online manga detail and bookmark commands"
```

### Task 4: Thumbnail grid, bookmark filter, and pagination

**Files:**
- Create: `app/src/manga/CatalogThumbnail.tsx`
- Create: `app/src/manga/OnlineCatalogCard.tsx`
- Modify: `app/src/manga/OnlineCatalogBrowser.tsx`
- Modify: `app/src/manga/OnlineCatalogBrowser.test.tsx`
- Modify: `app/src/styles/global.css`
- Modify: `app/src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: extended `CatalogWork`, scoped search, bookmark mutation from Task 3.
- Produces: stable thumbnail fallback, card/body versus star behavior, two-row Manga toolbar, exact range footer.

- [ ] **Step 1: Write failing browser tests for thumbnail, star isolation, filter, and paging**

Use at least three works and a result with `totalCount: 97`, `pageSize: 48`. Assert consumer-visible behavior:

```ts
expect(await screen.findByRole("img", { name: "오래된 제독 표지" }))
  .toHaveAttribute("src", "https://ehgt.org/w/00/003/work.webp");

await userEvent.click(screen.getByRole("button", { name: "오래된 제독 북마크" }));
expect(gateway.setOnlineCatalogBookmark).toHaveBeenCalledWith(3, true);
expect(gateway.getOnlineCatalogWorkDetail).not.toHaveBeenCalled();

await userEvent.click(screen.getByRole("button", { name: "북마크만 보기" }));
expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
  expect.objectContaining({ scope: "bookmarked", page: 0 }),
);

await userEvent.click(screen.getByRole("button", { name: "다음 결과" }));
expect(gateway.searchOnlineCatalog).toHaveBeenLastCalledWith(
  expect.objectContaining({ page: 1, pageSize: 48 }),
);
```

Fire an image error and assert the card still exposes `24페이지` in the media fallback.

- [ ] **Step 2: Run the browser test and verify RED**

Run: `npm.cmd test -- src/manga/OnlineCatalogBrowser.test.tsx`

Expected: FAIL because thumbnails, bookmark controls, scope, and paging controls are missing.

- [ ] **Step 3: Implement the reusable thumbnail media state**

`CatalogThumbnail` accepts `{ src, title, pageCount, className }`, keeps one local failed flag, and renders either:

```tsx
<img src={src} alt={`${title} 표지`} referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(true)} />
```

or a stable fallback containing `{pageCount}페이지`. Reset the failed flag when `src` changes.

- [ ] **Step 4: Implement card semantics without nested buttons**

Use a focusable card container or separate sibling hit targets so HTML never nests a button inside another button. The card body opens detail through `onOpen(work.id)`. The star is a real button with `aria-pressed`, label `${title} 북마크` or `${title} 북마크 해제`, and calls only `onBookmark(work.id, !work.bookmarked)`.

- [ ] **Step 5: Implement scoped list state and two-row toolbar**

In `OnlineCatalogBrowser`, add `scope` and page state. `search(text, nextSort, nextScope, nextPage)` sends all five query fields. Search text, sort, and scope changes reset page to 0. Add a Manga-local second row below `ViewToolbar` for scope, sort, update, and refresh; leave `WindowControls` in the existing first row.

The footer range is:

```ts
const firstResult = results.totalCount === 0 ? 0 : results.page * results.pageSize + 1;
const lastResult = Math.min(results.totalCount, (results.page + 1) * results.pageSize);
```

Disable previous when page 0 and next when `lastResult >= totalCount`.

- [ ] **Step 6: Add restrained grid CSS and CSP host**

Replace the horizontal card layout with `repeat(auto-fill, minmax(9rem, 1fr))`, a portrait media area, two-line title clamp, one-line artist metadata, and token-based gaps/borders. Add no shadow or transform. Add `https://ehgt.org https://*.ehgt.org` to `img-src` in `tauri.conf.json` while retaining existing sources.

- [ ] **Step 7: Verify Task 4 GREEN**

Run: `npm.cmd test -- src/manga/OnlineCatalogBrowser.test.tsx`

Expected: PASS, including image fallback and star isolation.

- [ ] **Step 8: Run the frontend production build**

Run: `npm.cmd run build`

Expected: exit 0. The existing bundle-size advisory may remain; new TypeScript or CSS errors may not.

- [ ] **Step 9: Commit only Task 4 hunks**

```powershell
git diff -- app/src/manga/CatalogThumbnail.tsx app/src/manga/OnlineCatalogCard.tsx app/src/manga/OnlineCatalogBrowser.tsx app/src/manga/OnlineCatalogBrowser.test.tsx app/src/styles/global.css app/src-tauri/tauri.conf.json
git add app/src/manga/CatalogThumbnail.tsx app/src/manga/OnlineCatalogCard.tsx
git add -p app/src/manga/OnlineCatalogBrowser.tsx app/src/manga/OnlineCatalogBrowser.test.tsx app/src/styles/global.css app/src-tauri/tauri.conf.json
git commit -m "feat: add online manga cover grid"
```

### Task 5: Metadata/tag detail dialog and explicit read transition

**Files:**
- Create: `app/src/manga/OnlineCatalogDetailDialog.tsx`
- Create: `app/src/manga/OnlineCatalogDetailDialog.test.tsx`
- Modify: `app/src/manga/OnlineCatalogBrowser.tsx`
- Modify: `app/src/manga/OnlineCatalogBrowser.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: `CatalogWorkDetail`, bookmark mutation, reading progress, gallery resolution, `CatalogThumbnail`, and `PageViewer`.
- Produces: detail-first card flow, tag search callback, read/resume callback.

- [ ] **Step 1: Write failing component tests for presentation and actions**

Render a complete detail and assert:

```ts
expect(screen.getByText("오래된 제독")).toBeVisible();
expect(screen.getByText("tester")).toBeVisible();
expect(screen.getByRole("button", { name: "character:teitoku 검색" })).toBeVisible();
expect(screen.getByRole("button", { name: "이어 읽기" })).toBeVisible();

await userEvent.click(screen.getByRole("button", { name: "character:teitoku 검색" }));
expect(onTagSearch).toHaveBeenCalledWith("character:teitoku");

await userEvent.click(screen.getByRole("button", { name: "이어 읽기" }));
expect(onRead).toHaveBeenCalledOnce();
```

Also assert absent optional fields do not produce empty property rows.

- [ ] **Step 2: Run the dialog test and verify RED**

Run: `npm.cmd test -- src/manga/OnlineCatalogDetailDialog.test.tsx`

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement the shared medium detail dialog**

Build `OnlineCatalogDetailDialog` on `Dialog variant="medium"`. Accept:

```ts
type Props = {
  detail: CatalogWorkDetail;
  progress: RemoteReadingProgress | null;
  bookmarkPending: boolean;
  reading: boolean;
  onBookmark: (bookmarked: boolean) => void;
  onTagSearch: (query: string) => void;
  onRead: () => void;
  onClose: () => void;
};
```

Use `CatalogThumbnail` on the left, a compact definition list on the right, and namespace sections below. Format bytes with the existing formatting utility if available; otherwise add one local pure formatter rather than a dependency. Determine resume copy only when `progress?.pageCount === detail.fileCount`.

Format provider values deliberately: `rating / 100` with two decimal places, Unix-second dates
with `Intl.DateTimeFormat`, and category codes as `1 동인지`, `2 만화`, `3 아티스트 CG`,
`4 게임 CG`, `5 서양`, `6 이미지 세트`, `7 비성인`, `8 코스프레`,
`9 아시아 포르노`, `10 기타`, `11 비공개`. Unknown category codes are omitted rather than
shown as unexplained integers.

- [ ] **Step 4: Write the failing integration test that proves card click no longer reads immediately**

In `OnlineCatalogBrowser.test.tsx`:

```ts
await userEvent.click(await screen.findByRole("button", { name: /오래된 제독 상세 보기/ }));
expect(gateway.getOnlineCatalogWorkDetail).toHaveBeenCalledWith(3);
expect(gateway.getRemoteReadingProgress).toHaveBeenCalledWith("kHentai", "3");
expect(gateway.resolveOnlineCatalogWork).not.toHaveBeenCalled();

await userEvent.click(await screen.findByRole("button", { name: "이어 읽기" }));
expect(gateway.resolveOnlineCatalogWork).toHaveBeenCalledWith(3);
expect(await screen.findByText("2 / 3")).toBeVisible();
```

Add a tag click assertion that closes detail and sends `text: "character:teitoku", page: 0` to search.

- [ ] **Step 5: Run the integration test and verify RED**

Run: `npm.cmd test -- src/manga/OnlineCatalogBrowser.test.tsx`

Expected: FAIL because card click still resolves the gallery directly.

- [ ] **Step 6: Rework browser orchestration around detail state**

On card open, load detail and progress with `Promise.all`; do not call `resolveOnlineCatalogWork`. Preserve the current grid and scroll. On read, set only the reading action pending, resolve gallery, close detail only after success, and open `PageViewer` with the matching saved page or page 1. On failure, retain detail and re-enable read.

Bookmark success updates both the detail object and matching summary in `results.works`. A bookmark removed while scope is `bookmarked` removes that work from the visible page and triggers a scoped refresh so totals stay authoritative.

Tag selection closes detail, writes the literal `namespace:value` to the search field, and searches page 0.

If detail or progress loading fails, clear only the detail-loading state and show the existing
toast while retaining the result grid. If bookmark mutation fails, keep the previous bookmark
state and re-enable only that bookmark control. If gallery resolution fails, keep the dialog open,
retain progress, show the command error toast, and re-enable the read action.

- [ ] **Step 7: Add compact detail CSS**

Use a two-column upper layout, fixed media column, compact property rows, and an internally scrolling tag region. Tag buttons are small rectangular quiet controls, not pills. At narrow desktop width, stack the upper region without horizontal clipping. Use only existing tokens and shared dialog surface/shadow.

- [ ] **Step 8: Verify Task 5 GREEN**

Run: `npm.cmd test -- src/manga/OnlineCatalogDetailDialog.test.tsx src/manga/OnlineCatalogBrowser.test.tsx`

Expected: both files PASS.

- [ ] **Step 9: Run frontend production build**

Run: `npm.cmd run build`

Expected: exit 0.

- [ ] **Step 10: Commit only Task 5 hunks**

```powershell
git diff -- app/src/manga/OnlineCatalogDetailDialog.tsx app/src/manga/OnlineCatalogDetailDialog.test.tsx app/src/manga/OnlineCatalogBrowser.tsx app/src/manga/OnlineCatalogBrowser.test.tsx app/src/styles/global.css
git add app/src/manga/OnlineCatalogDetailDialog.tsx app/src/manga/OnlineCatalogDetailDialog.test.tsx
git add -p app/src/manga/OnlineCatalogBrowser.tsx app/src/manga/OnlineCatalogBrowser.test.tsx app/src/styles/global.css
git commit -m "feat: add online manga detail flow"
```

### Task 6: Focused integration verification and debug build

**Files:**
- Modify only if a verification failure identifies a concrete defect in the files from Tasks 1-5.

**Interfaces:**
- Consumes: the complete online manga library flow.
- Produces: verified debug executable and installer bundles.

- [ ] **Step 1: Verify Rust formatting and focused backend behavior**

Run: `cargo fmt --all --check`

Run: `cargo test online_catalog --lib`

Run: `cargo test migrates_v18_to_online_catalog_bookmarks --lib`

Expected: all exit 0.

- [ ] **Step 2: Verify focused frontend behavior**

Run: `npm.cmd test -- src/library/client.test.ts src/manga/OnlineCatalogBrowser.test.tsx src/manga/OnlineCatalogDetailDialog.test.tsx src/manga/PageViewer.test.tsx`

Expected: all listed test files PASS.

- [ ] **Step 3: Verify the frontend production build**

Run: `npm.cmd run build`

Expected: exit 0. The known chunk-size advisory is informational.

- [ ] **Step 4: Ensure Lakomics is not holding the debug executable**

Run:

```powershell
Get-Process -Name lakomics -ErrorAction SilentlyContinue | Select-Object Id,Path
```

Expected: no process. If the exact workspace debug executable is still running, stop only that process before rebuilding.

- [ ] **Step 5: Build and verify the debug application**

From `app` run the Tauri command directly so its process exit code is authoritative:

```powershell
npm.cmd run tauri -- build --debug
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Get-Item .\src-tauri\target\debug\lakomics.exe | Select-Object FullName,Length,LastWriteTime
```

Expected: build output includes `Finished 2 bundles`, exit code 0, and a freshly written `lakomics.exe`.

- [ ] **Step 6: Review the final scoped diff**

Run:

```powershell
git diff --check
git status --short
```

Confirm no unrelated tracked changes were staged by the task commits. Do not clean or reset pre-existing worktree changes.
