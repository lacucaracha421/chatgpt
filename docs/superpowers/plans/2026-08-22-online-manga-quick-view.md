# Online Manga Quick View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open online catalog works in the Lakomics viewer with Hitomi-first/K-Hentai fallback resolution, cached remote media, and restored reading progress.

**Architecture:** `remote_gallery` hides provider resolution behind one interface, the shared `CatalogTransport` supplies K-Hentai HTML, and the media protocol hides remote headers and cache paths from React. Extract the existing viewer only now that local and remote adapters both use it.

**Tech Stack:** Rust, ureq, Tauri media protocol, React, TypeScript, Vitest/Testing Library

**Spec:** `docs/superpowers/specs/2026-08-22-online-manga-catalog-design.md`

## Execution Status (2026-08-22)

- Completed the K-Hentai internal viewer path, closed media protocol, page cache, reading progress, shared `PageViewer`, and confirmed cache clearing.
- Removed the temporary visible website-reader window after the internal viewer became available.
- Deferred Hitomi resolution because its current dynamic image-URL script would require a separate JavaScript execution layer; K-Hentai is the only closed provider in this increment.
- Deferred grid thumbnails so opening a catalog page does not resolve dozens of remote galleries up front. Cards keep the lightweight page-count placeholder.
- Deferred showing the imported catalog path and re-import shortcut in Settings; re-import remains available from the empty online-catalog state in this increment.
- Targeted Rust and frontend tests plus both production frontend and debug Rust builds are the completion gate for this increment.

## Global Constraints

- Complete the online-catalog foundation and shared transport plans first. The update UI may follow independently.
- Do not create another K-Hentai WebView; consume `CatalogTransport::fetch_text(app, gallery_path(work_id))`.
- Hitomi is attempted first; K-Hentai is attempted only after Hitomi fails.
- Frontend code never receives or requests an external image URL directly.
- Cache is clearable but has no configurable size limit in this version.
- Preserve local viewer keyboard, mouse-edge, spread, preload, Escape, and mouse-button-4 behavior.
- No real network calls in automated tests.

---

### Task 1: Provider-independent gallery resolution

**Files:**
- Create: `app/src-tauri/src/library/remote_gallery.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/error.rs`
- Test: `app/src-tauri/src/library/remote_gallery.rs`

**Interfaces:**
- Produces `ResolvedGallery { provider: RemoteProvider, work_id: String, page_count: u32 }` and an internal `RemoteGalleryManifest` written under the remote cache.
- Produces `Library::resolve_remote_gallery(work_id, resolver) -> Result<ResolvedGallery, LibraryError>`.

- [ ] Write failing tests with fake Hitomi and K-Hentai resolvers: Hitomi success does not call fallback, Hitomi failure calls fallback once, and both failures return `RemoteGalleryUnavailable` carrying both diagnostic causes.
- [ ] Run: `cargo test remote_gallery::tests --manifest-path app/src-tauri/Cargo.toml`; expect FAIL.
- [ ] Implement the closed `RemoteProvider` enum and the two-attempt coordinator. Port only the minimal Hitomi metadata/hash algorithm required to produce page descriptors; parse K-Hentai gallery HTML returned by the shared transport for fallback.

```rust
pub enum RemoteProvider { Hitomi, KHentai }
struct RemotePageDescriptor { url: String, referer: Option<String>, expires_at: Option<i64> }
struct RemoteGalleryManifest { provider: RemoteProvider, work_id: String, pages: Vec<RemotePageDescriptor> }

let resolved = match hitomi.resolve(work_id) {
    Ok(pages) => (RemoteProvider::Hitomi, pages),
    Err(hitomi_error) => match khentai.resolve(work_id) {
        Ok(pages) => (RemoteProvider::KHentai, pages),
        Err(khentai_error) => return Err(LibraryError::RemoteGalleryUnavailable {
            hitomi: hitomi_error.to_string(), khentai: khentai_error.to_string(),
        }),
    },
};
```

The async command obtains K-Hentai HTML only when fallback is needed:

```rust
let html = transport
    .fetch_text(&app, &gallery_path(work_id))
    .await?;
let pages = parse_khentai_gallery(&html)?;
```

Write the manifest atomically to `cache/remote-manga/manifests/{provider}-{workId}.json`; return only provider, work ID, and page count to React.
- [ ] Run fixture tests; expect PASS.

### Task 2: Remote thumbnail/page media protocol and cache

**Files:**
- Create: `app/src-tauri/src/library/remote_media.rs`
- Modify: `app/src-tauri/src/media_protocol.rs`
- Modify: `app/src/assets/mediaUrl.ts`
- Test: `app/src-tauri/src/media_protocol.rs`

**Interfaces:**
- Produces `/remote-manga-thumbnail/{workId}` and `/remote-manga-page/{provider}/{workId}/{pageIndex}`.
- Produces `remoteMangaThumbnailUrl(workId)` and `remoteMangaPageUrl(provider, workId, page)`.

- [ ] Write failing protocol tests for strict path parsing, missing library, cache hit without fetch, cache miss with provider headers, non-image rejection, atomic cache write, and upstream failure.
- [ ] Run: `cargo test remote_manga --manifest-path app/src-tauri/Cargo.toml`; expect FAIL.
- [ ] Implement cache paths under `cache/remote-manga`, write `.partial` then rename, and return bytes only after an image MIME/content validation. Route lookup reads the manifest from Task 1; URLs never appear in protocol paths.

```rust
let manifest = read_manifest(library.root(), provider, work_id)?;
let descriptor = manifest.pages.get(page_index.checked_sub(1).ok_or(LibraryError::MediaNotFound)? as usize)
    .ok_or(LibraryError::MediaNotFound)?;
let bytes = fetch_remote_image(descriptor)?;
write_atomic(&cache_path, &bytes)?;
```
- [ ] Run protocol tests; expect PASS.

### Task 3: Shared PageViewer extraction

**Files:**
- Create: `app/src/manga/PageViewer.tsx`
- Create: `app/src/manga/PageViewer.test.tsx`
- Modify: `app/src/manga/MangaViewer.tsx`
- Modify: `app/src/manga/MangaViewer.test.tsx`

**Interfaces:**
- Produces `PageViewer({ title, pageUrls, initialPage, sourceLabel, onPageChange, onClose })`.
- Keeps `MangaViewer` public props unchanged as a local URL adapter.

- [ ] Move existing viewer behavior tests to `PageViewer.test.tsx` and add initial-page, source-label, and failed-current-image cases. Run both viewer suites and verify the new test fails before extraction.
- [ ] Extract only display/navigation state; keep local `mangaPageUrl` creation in `MangaViewer`.
- [ ] Run: `npm test -- --run src/manga/PageViewer.test.tsx src/manga/MangaViewer.test.tsx`; expect PASS.

### Task 4: Reading progress gateway

**Files:**
- Create: `app/src-tauri/src/library/remote_progress.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src-tauri/src/lib.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Test: `app/src-tauri/src/library/remote_progress.rs`
- Test: `app/src/library/client.test.ts`

**Interfaces:**
- Produces `getRemoteReadingProgress(provider, workId): Promise<RemoteReadingProgress | null>`.
- Produces `saveRemoteReadingProgress(progress): Promise<void>`.

- [ ] Write failing tests for upsert, provider/work isolation, page validation, stale page reset, and invoke payloads.
- [ ] Implement parameterized upsert with UTC `last_read_at`; reject page/pageCount zero and page greater than pageCount.
- [ ] Run targeted Rust and client tests; expect PASS.

### Task 5: Online card thumbnails and quick viewer

**Files:**
- Modify: `app/src/manga/OnlineCatalogBrowser.tsx`
- Modify: `app/src/manga/OnlineCatalogBrowser.test.tsx`
- Modify: `app/src/manga/MangaBrowser.tsx`
- Modify: `app/src/styles/global.css`

**Interfaces:**
- Consumes Tasks 1-4.

- [ ] Write failing UI tests: thumbnail protocol URL, card click loading state, resolved viewer, Hitomi/K-Hentai source label, restored initial page, 250ms debounced progress save, and two-provider failure toast.
- [ ] Run: `npm test -- --run src/manga/OnlineCatalogBrowser.test.tsx src/manga/PageViewer.test.tsx`; expect FAIL.
- [ ] On card click, fetch progress and gallery in parallel, create protocol page URLs for `1..pageCount`, then open `PageViewer`. Keep the grid mounted behind the fullscreen dialog. Use an ordinary broken-image placeholder for thumbnail errors.
- [ ] Run UI tests; expect PASS.

### Task 6: Cache controls and final regression

**Files:**
- Modify: `app/src-tauri/src/library/remote_media.rs`
- Modify: `app/src-tauri/src/commands.rs`
- Modify: `app/src/library/types.ts`
- Modify: `app/src/library/client.ts`
- Modify: `app/src/settings/SettingsView.tsx`
- Modify: `app/src/settings/SettingsView.test.tsx`

**Interfaces:**
- Produces `clearRemoteMangaCache(): Promise<void>`.

- [ ] Write a failing settings test asserting confirmation precedes cache deletion and success/failure toast text.
- [ ] Implement deletion of the exact canonical `<library>/cache/remote-manga` directory followed by recreation; reject any resolved path outside the library root.
- [ ] Run: `npm test -- --run src/settings/SettingsView.test.tsx src/manga/MangaBrowser.test.tsx src/manga/MangaViewer.test.tsx src/manga/PageViewer.test.tsx src/manga/OnlineCatalogBrowser.test.tsx`; expect PASS.
- [ ] Run: `cargo test remote_ --manifest-path app/src-tauri/Cargo.toml`; expect PASS.
- [ ] Run: `npm run build --prefix app`; expect PASS, allowing only the existing bundle-size warning.
