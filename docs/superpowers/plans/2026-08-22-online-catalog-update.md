# Online Manga Catalog Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Incrementally update the imported catalog manually and every hour without blocking search or corrupting committed catalog pages.

**Architecture:** The shared `CatalogTransport` supplies the Chromium request context K-Hentai requires; this plan adds only the search-page adapter and Rust updater. The updater parses responses and commits one page per transaction, a single process mutex rejects overlapping runs, and the React app owns the due-check timer.

**Tech Stack:** Rust, rusqlite WAL, Tauri 2 WebviewWindow `eval_with_callback`, React hooks, Vitest fake timers

**Spec:** `docs/superpowers/specs/2026-08-22-online-manga-catalog-design.md`

## Global Constraints

- Complete `2026-08-22-online-catalog-foundation.md` first.
- Complete `2026-08-22-shared-catalog-transport.md` first; do not create another WebView in this plan.
- Retry at most three times with exponential delays; never run real network requests in tests.
- Commit complete pages only and keep search usable between page commits.
- Default automatic interval is exactly 3600 seconds and minimum accepted interval is 60 seconds.

---

### Task 1: Remote update page parser and writer

**Files:**
- Create: `app/src-tauri/src/library/catalog_update.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Test: `app/src-tauri/src/library/catalog_update.rs`

**Interfaces:**
- Produces `RemoteCatalogPage { works, lowest_id, is_last_page }` and `CatalogPageSource::fetch(cursor)` internal seam.
- Produces `update_with(source, now) -> CatalogUpdateResult` for fixture tests.

```rust
pub struct CatalogUpdateResult {
    pub added: u64,
    pub pages: u32,
    pub reason: CatalogUpdateStopReason,
    pub last_success_at: Option<String>,
}
pub enum CatalogUpdateStopReason { Completed, UpToDate, PageLimit, RateLimited, AlreadyRunning }
```

- [x] Write failing fixture tests for JSON parsing, highest-ID watermark, page transaction upsert/tag replacement, duplicate prevention, and a source failure after one committed page.
- [x] Run: `cargo test catalog_update::tests --manifest-path app/src-tauri/Cargo.toml`; expect FAIL.
- [x] Implement response normalization and a page writer; accept only numeric IDs and bounded strings, preserve `RawJson`, and stop at the first page whose `lowest_id <= known_max_id`.

```rust
pub(crate) trait CatalogPageSource {
    fn fetch(&mut self, cursor: Option<u64>) -> Result<RemoteCatalogPage, LibraryError>;
}
while pages < 40 {
    let page = source.fetch(cursor)?;
    let fresh = page.works.into_iter().filter(|work| work.id > known_max_id).collect::<Vec<_>>();
    write_catalog_page(&mut connection, &fresh)?;
    if page.lowest_id.is_none_or(|id| id <= known_max_id) || page.is_last_page { break; }
    cursor = page.lowest_id;
}
```
- [x] Run the same command; expect PASS and assert duplicate pages add no duplicate rows.

### Task 2: Chromium-backed catalog page adapter

**Files:**
- Modify: `app/src-tauri/src/library/catalog_update.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Test: `app/src-tauri/src/library/catalog_update.rs`

**Interfaces:**
- Consumes `CatalogTransport::fetch_text(app, path)` and `search_page_path(cursor)` from the shared transport plan.
- Produces an async update command that feeds decoded response text into the Task 1 page parser.

- [x] Write a failing adapter test that supplies two transport response strings and asserts cursor progression `None -> lowest_id` without constructing a WebView.
- [x] Run: `cargo test --lib catalog_update::tests --manifest-path app/src-tauri/Cargo.toml`; expect FAIL because the adapter is absent.
- [x] In the async command loop, call the shared transport once per page and pass each returned string to `RemoteCatalogPage::parse`. Keep all SQLite writes in Task 1 helpers and never hold a library connection while awaiting the transport.

```rust
let body = transport
    .fetch_text(&app, &search_page_path(cursor))
    .await?;
let page = RemoteCatalogPage::parse(&body)?;
```
- [x] Run adapter tests and `cargo check --manifest-path app/src-tauri/Cargo.toml`; expect PASS.

### Task 3: Update command, mutex, and settings

**Files:**
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Test: `app/src/library/client.test.ts`
- Test: `app/src-tauri/src/library/catalog_update.rs`

**Interfaces:**
- Produces `updateOnlineCatalog(): Promise<CatalogUpdateResult>`.
- Produces `setOnlineCatalogUpdateSettings(enabled, intervalSeconds): Promise<CatalogStatus>`.
- Produces `runDueOnlineCatalogUpdate(): Promise<CatalogUpdateResult | null>`.

- [x] Add failing tests proving a held update guard returns `already_running`, due checks skip fresh/disabled catalogs, and gateway invoke payloads match.
- [x] Run targeted Rust and client tests; expect FAIL.
- [x] Add `CatalogUpdateState` to Tauri managed state, async commands using the hidden transport, and status writes for attempt/success/error. Do not hold the main `Library` connection while network work runs.
- [x] Run targeted tests; expect PASS.

### Task 4: Manual and automatic update UI

**Files:**
- Modify: `app/src/manga/OnlineCatalogBrowser.tsx`
- Modify: `app/src/manga/OnlineCatalogBrowser.test.tsx`
- Create: `app/src/app/useOnlineCatalogUpdate.ts`
- Create: `app/src/app/useOnlineCatalogUpdate.test.ts`
- Modify: `app/src/app/App.tsx`
- Modify: `app/src/settings/SettingsView.tsx`
- Modify: `app/src/settings/SettingsView.test.tsx`

**Interfaces:**
- Consumes Task 3 gateway methods.

- [x] Write failing tests for `지금 갱신`, added/error copy, default-enabled hourly due call, no overlap, toggle, and interval selection.
- [x] Run targeted online catalog, update hook, settings, and client tests; expect FAIL.
- [x] Implement one manual action in the online toolbar and one `useEffect` timer that calls `runDueOnlineCatalogUpdate` immediately after library open and every 3600 seconds. Settings choices are `1시간`, `6시간`, `24시간` only.
- [x] Run the same tests; expect PASS.
- [x] Run focused catalog update tests and frontend tests; defer the production build to final cross-feature verification.
