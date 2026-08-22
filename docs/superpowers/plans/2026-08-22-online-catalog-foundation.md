# Online Manga Catalog Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import a user-owned VCK catalog into the active Lakomics library and provide a searchable online-catalog tab with Korean autocomplete and popularity sorts.

**Architecture:** Keep `catalogs/kdata.db` separate from `library.sqlite`; expose VCK schema details only through the Rust `online_catalog` module. React accesses a small Tauri command surface through the existing `LibraryGateway`.

**Tech Stack:** Rust, rusqlite backup, serde/serde_json, Tauri 2, React 19, TypeScript, Vitest/Testing Library

**Spec:** `docs/superpowers/specs/2026-08-22-online-manga-catalog-design.md`

## Global Constraints

- Do not copy or execute VCK/violet-web implementation code; parse only user-selected data files.
- Store the copied database at `<library>/catalogs/kdata.db`; never merge it into `library.sqlite`.
- Keep VCK source files read-only and replace an existing catalog only after full validation.
- Do not add Node.js, `better-sqlite3`, a local web server, or a new Rust crate.
- Use fixture databases only; no external network calls.
- Run only the targeted tests named below plus the production frontend build at the final checkpoint.

---

### Task 1: Catalog settings and reading-progress schema

**Files:**
- Create: `app/src-tauri/migrations/0018_online_catalog.sql`
- Modify: `app/src-tauri/src/library/db.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Test: `app/src-tauri/src/library/db.rs`

**Interfaces:**
- Produces: `CatalogStatus`, `CatalogSort`, `CatalogSearchQuery`, `CatalogWork`, `CatalogSearchPage`, and `CatalogSuggestion` in `library::models`.
- Produces: schema version 18 with `online_catalog_settings` and `remote_reading_progress`.

- [ ] **Step 1: Write a failing migration test** that migrates a version-17 fixture and asserts:

```rust
assert_eq!(
    connection.query_row("SELECT update_enabled FROM online_catalog_settings WHERE singleton = 1", [], |row| row.get::<_, i64>(0)).unwrap(),
    1,
);
assert!(connection.prepare("SELECT provider, work_id, last_page FROM remote_reading_progress").is_ok());
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cargo test migrates_v17_to_online_catalog --manifest-path app/src-tauri/Cargo.toml`
Expected: FAIL because migration 18 and its tables do not exist.

- [ ] **Step 3: Add the migration and models**

```sql
CREATE TABLE online_catalog_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  installed_at TEXT,
  update_enabled INTEGER NOT NULL DEFAULT 1 CHECK (update_enabled IN (0, 1)),
  update_interval_seconds INTEGER NOT NULL DEFAULT 3600 CHECK (update_interval_seconds >= 60),
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_added INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
INSERT INTO online_catalog_settings (singleton) VALUES (1);

CREATE TABLE remote_reading_progress (
  provider TEXT NOT NULL,
  work_id TEXT NOT NULL,
  last_page INTEGER NOT NULL CHECK (last_page >= 1),
  page_count INTEGER NOT NULL CHECK (page_count >= 1),
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (provider, work_id)
);
PRAGMA user_version = 18;
```

Add serde camelCase models. `CatalogSort` variants serialize as `latest`, `views`, `hotDay`, `hotWeek`, `hotMonth`. `CatalogSearchQuery` contains `text`, `sort`, `page`, and `page_size` with a maximum accepted size of 100.

```rust
pub struct CatalogStatus {
    pub installed: bool,
    pub work_count: u64,
    pub update_enabled: bool,
    pub update_interval_seconds: u64,
    pub last_attempt_at: Option<String>,
    pub last_success_at: Option<String>,
    pub last_added: u64,
    pub last_error: Option<String>,
}
pub struct CatalogSuggestion { pub value: String, pub label: String, pub count: u64 }
pub struct CatalogWork {
    pub id: u64, pub title: String, pub title_jpn: Option<String>,
    pub artists: Vec<String>, pub series: Vec<String>, pub file_count: u32,
    pub views: u64, pub posted: i64,
}
pub struct CatalogSearchPage { pub works: Vec<CatalogWork>, pub total_count: u64, pub page: u32, pub page_size: u32 }
```

- [ ] **Step 4: Run the migration test**

Run: `cargo test migrates_v17_to_online_catalog --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 5: Review checkpoint**

Verify only migration 18, the schema version, and shared catalog models changed.

### Task 2: Atomic VCK catalog import

**Files:**
- Create: `app/src-tauri/src/library/online_catalog.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Test: `app/src-tauri/src/library/online_catalog.rs`

**Interfaces:**
- Consumes: `CatalogStatus` from Task 1.
- Produces: `Library::import_vck_catalog(&self, vck_root: &Path) -> Result<CatalogStatus, LibraryError>`.
- Produces: `Library::catalog_status(&self) -> Result<CatalogStatus, LibraryError>`.

- [ ] **Step 1: Write failing tests** using a temp VCK root with `data/kdata.db`, `data/suggestion-cache.json`, and `resources/app/violet-web/packages/frontend/dist/assets/tag-ko-test.js`.

```rust
let status = library.import_vck_catalog(&vck_root).unwrap();
assert!(status.installed);
assert_eq!(status.work_count, 2);
assert!(library.root().join("catalogs/kdata.db").exists());
assert_eq!(std::fs::read(source_db).unwrap(), original_source_bytes);
```

Add rejection cases for failed `integrity_check`, a missing `Tags` table, zero works, and invalid tag JSON. Preinstall a valid destination and assert every rejection preserves its bytes.

- [ ] **Step 2: Run the importer tests and verify failure**

Run: `cargo test online_catalog::tests::import --manifest-path app/src-tauri/Cargo.toml`
Expected: FAIL because the module and methods do not exist.

- [ ] **Step 3: Implement the minimal importer**

Use `rusqlite::backup::Backup` to copy the source into `kdata.db.importing`, then run:

```rust
let integrity: String = imported.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
if integrity != "ok" { return Err(LibraryError::InvalidOnlineCatalog); }
for table in ["Works", "Tags", "CrawlState"] { require_table(&imported, table)?; }
let work_count: u64 = imported.query_row("SELECT COUNT(*) FROM Works", [], |row| row.get(0))?;
if work_count == 0 { return Err(LibraryError::InvalidOnlineCatalog); }
```

Extract the object between `const a=` and `;export` from the single `tag-ko-*.js`, deserialize it as `BTreeMap<String, String>`, and write pretty JSON. Validate suggestions as `Vec<CatalogSuggestion>`. Write both to `.importing` files and rename all three only after validation.

- [ ] **Step 4: Run importer tests**

Run: `cargo test online_catalog::tests::import --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 5: Review checkpoint**

Confirm the source folder is never opened writable and all replacement paths remain under `<library>/catalogs`.

### Task 3: Read-only search and Korean autocomplete

**Files:**
- Modify: `app/src-tauri/src/library/online_catalog.rs`
- Test: `app/src-tauri/src/library/online_catalog.rs`

**Interfaces:**
- Consumes: `CatalogSearchQuery`, `CatalogSort`, `CatalogSearchPage` from Task 1.
- Produces: `Library::search_online_catalog(query: CatalogSearchQuery) -> Result<CatalogSearchPage, LibraryError>`.
- Produces: `Library::suggest_online_catalog(text: &str, limit: u32) -> Result<Vec<CatalogSuggestion>, LibraryError>`.

- [ ] **Step 1: Write failing fixture tests** with fixed Posted timestamps and Views. Assert title substring matching, one selected tag filter, pagination, all five sorts, and Korean translation normalization:

```rust
let suggestions = library.suggest_online_catalog("제독", 10).unwrap();
assert_eq!(suggestions[0].value, "character:teitoku");
assert_eq!(library.search_online_catalog(query(CatalogSort::HotWeek)).unwrap().works[0].id, 3);
```

- [ ] **Step 2: Run and verify failure**

Run: `cargo test online_catalog::tests::search --manifest-path app/src-tauri/Cargo.toml`
Expected: FAIL because search methods are absent.

- [ ] **Step 3: Implement parameterized SQL only**

Open the catalog with `OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX`. Build the sort from the closed `CatalogSort` enum, never raw user text. Use `Posted >= now - window_seconds` for hot sorts and `ORDER BY Views DESC, Posted DESC, Id DESC`; use `Posted DESC, Id DESC` for latest.

Load `suggestions.json` and the reverse Korean translation map once per `Library` clone using an internal cache invalidated after import. Return at most 20 suggestions.

- [ ] **Step 4: Run search tests**

Run: `cargo test online_catalog::tests::search --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 5: Review checkpoint**

Confirm no SQL identifier or clause comes from user input and missing catalog returns `OnlineCatalogNotInstalled`.

### Task 4: Tauri gateway surface

**Files:**
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Test: `app/src/library/client.test.ts`

**Interfaces:**
- Produces gateway methods `importVckCatalog`, `getOnlineCatalogStatus`, `searchOnlineCatalog`, `suggestOnlineCatalog` with Task 1 model shapes.

- [ ] **Step 1: Add failing client mapping tests**

```ts
await libraryGateway.searchOnlineCatalog({ text: "던전", sort: "latest", page: 0, pageSize: 48 });
expect(invoke).toHaveBeenCalledWith("search_online_catalog", { query: expect.objectContaining({ text: "던전" }) });
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run src/library/client.test.ts`
Expected: FAIL because the gateway methods are missing.

- [ ] **Step 3: Add four commands and mappings**

Run import and search inside `spawn_blocking`. Register commands in `generate_handler!`. Map new `LibraryError` variants to stable codes: `online_catalog_not_installed`, `invalid_online_catalog`, `online_catalog_import_failed`.

- [ ] **Step 4: Run client and Rust command compilation checks**

Run: `npm test -- --run src/library/client.test.ts`
Expected: PASS.

Run: `cargo check --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS.

### Task 5: Local/online manga tabs and catalog browser

**Files:**
- Create: `app/src/manga/OnlineCatalogBrowser.tsx`
- Create: `app/src/manga/OnlineCatalogBrowser.test.tsx`
- Modify: `app/src/manga/MangaBrowser.tsx`
- Modify: `app/src/manga/MangaBrowser.test.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes: Task 4 gateway methods.
- Produces: online search UI; `onOpenWork?: (work: CatalogWork) => void` remains unused until the quick-view plan.

- [ ] **Step 1: Write failing UI tests** for local/online switching, missing-catalog import, search-on-submit, sort change, suggestion selection, count display, and card click callback.

```tsx
await user.click(screen.getByRole("button", { name: "온라인 카탈로그" }));
await user.type(screen.getByRole("searchbox", { name: "온라인 만화 검색" }), "제독");
await user.click(await screen.findByRole("option", { name: /character:teitoku/ }));
expect(gateway.searchOnlineCatalog).toHaveBeenCalledWith(expect.objectContaining({ text: "character:teitoku" }));
```

- [ ] **Step 2: Run and verify failure**

Run: `npm test -- --run src/manga/MangaBrowser.test.tsx src/manga/OnlineCatalogBrowser.test.tsx`
Expected: FAIL because the online browser does not exist.

- [ ] **Step 3: Implement the minimum UI**

Keep the existing top toolbar and place a two-button segment in it. `OnlineCatalogBrowser` owns query, sort, page, card width, status, and import dialog state. Use the existing `ViewToolbar`, `Button`, `EmptyState`, `Skeleton`, and `Toast`; do not introduce a component library.

Use a folder picker and pass the chosen VCK root to `importVckCatalog`. Render ordinary semantic buttons for result cards with remote thumbnail support deferred to the quick-view plan; show a placeholder until then.

- [ ] **Step 4: Run UI tests**

Run: `npm test -- --run src/manga/MangaBrowser.test.tsx src/manga/OnlineCatalogBrowser.test.tsx`
Expected: PASS.

- [ ] **Step 5: Final foundation verification**

Run: `cargo test online_catalog --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS.

Run: `npm test -- --run src/library/client.test.ts src/manga/MangaBrowser.test.tsx src/manga/OnlineCatalogBrowser.test.tsx`
Expected: PASS.

Run: `npm run build --prefix app`
Expected: PASS, allowing only the existing bundle-size warning.
