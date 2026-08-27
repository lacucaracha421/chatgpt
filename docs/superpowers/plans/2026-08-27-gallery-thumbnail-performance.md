# Gallery Thumbnail Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove repeated Asset date-jump work and prevent Collection browsing grids from decoding original cover files.

**Architecture:** Keep the existing Asset virtualizer and replace drag-time anchor queries with a single pointer-release commit. Add two Collection browsing routes backed by one library-managed 360x360 WebP cache, while preserving original media routes for the large viewer.

**Tech Stack:** React 19, TypeScript 7, Vitest, Testing Library, TanStack Virtual, Rust 2021, Tauri 2, `image`, `sha2`, SQLite.

## Global Constraints

- Asset and Collection browsing surfaces use bounded derived thumbnails.
- Original Collection cover files are allowed only when a cover is shown large in the Collection viewer.
- A thumbnail failure never falls back to an original file in a browsing grid.
- Existing spacing, layout, selection, and viewer interactions remain unchanged.
- Maximum generated Collection thumbnail size is 360x360 pixels in WebP format.
- Do not add a runtime dependency or database migration.
- Follow `DESIGN.md`, `docs/agents/implementation.md`, and `docs/agents/lakomics-works-handoff-v2.md`.
- During iteration, run only the most relevant targeted test and expand after a failure or identified cross-module risk.

---

### Task 1: Commit Asset Date Jumps Once and Remove Duplicate Scroll State

**Files:**
- Modify: `app/src/assets/AssetGallery.test.tsx:428-452`
- Modify: `app/src/assets/AssetGallery.tsx:47-290`
- Modify: `app/src/video/VideoTileMedia.test.tsx`
- Modify: `app/src/video/VideoTileMedia.tsx:50`

**Interfaces:**
- Consumes: `AssetGalleryProps.onSelectDate(date: string, ratio: number)` and the existing TanStack virtualizer instance.
- Produces: rail drag behavior that calls `onSelectDate` exactly once on `pointerup`; grid images with asynchronous decoding hints.

- [ ] **Step 1: Replace the throttle test with a failing pointer-release test**

Replace the existing throttle test with a test that renders two date buckets, performs `pointerdown` and several `pointermove` events, asserts `onSelectDate` has not fired, then performs `pointerup` and expects the final bucket exactly once:

```tsx
fireEvent.pointerDown(rail, { button: 0, pointerId: 1, clientY: 10 });
fireEvent.pointerMove(rail, { pointerId: 1, clientY: 300 });
fireEvent.pointerMove(rail, { pointerId: 1, clientY: 590 });
expect(onSelectDate).not.toHaveBeenCalled();
fireEvent.pointerUp(rail, { pointerId: 1, clientY: 590 });
expect(onSelectDate).toHaveBeenCalledOnce();
expect(onSelectDate.mock.calls[0]![0]).toBe("2026-08-01");
```

Stub `getBoundingClientRect`, `setPointerCapture`, `hasPointerCapture`, and `releasePointerCapture` on the rail exactly as the current throttle test stubs its geometry.

- [ ] **Step 2: Add a failing cancellation test**

```tsx
fireEvent.pointerDown(rail, { button: 0, pointerId: 1, clientY: 300 });
fireEvent.pointerCancel(rail, { pointerId: 1 });
expect(onSelectDate).not.toHaveBeenCalled();
```

- [ ] **Step 3: Run the Asset test and verify RED**

Run from `app`:

```powershell
npm.cmd test -- src/assets/AssetGallery.test.tsx
```

Expected: the release test fails because the current implementation emits during drag; cancellation is not implemented.

- [ ] **Step 4: Implement a pending jump ref and pointer-release commit**

Replace the timer/throttle refs and functions with:

```tsx
const pendingJumpRef = useRef<{ date: string; ratio: number } | null>(null);

const updatePendingDateJump = (clientY: number) => {
  if (!railInteractive || !railRef.current) return;
  if (dateBuckets.length === 0) {
    const element = scrollRef.current;
    const rect = element?.getBoundingClientRect();
    if (element && rect && rect.height > 0) {
      element.scrollTop = ((clientY - rect.top) / rect.height) * (element.scrollHeight - element.clientHeight);
    }
    return;
  }
  if (railExtent <= 0) return;
  const progress = railProgressFromEvent(railRef.current, clientY, railExtent);
  if (progress == null) return;
  const index = dateBuckets.length <= 1 ? 0 : Math.round(progress * (dateBuckets.length - 1));
  const date = dateBuckets[index]?.date;
  if (date) pendingJumpRef.current = { date, ratio: progress };
};

const commitPendingDateJump = () => {
  const jump = pendingJumpRef.current;
  pendingJumpRef.current = null;
  if (jump) onSelectDate?.(jump.date, jump.ratio);
};
```

Wire `pointerdown` to capture and update, `pointermove` to update only while captured, `pointerup` to update the final position and commit once, and `pointercancel` to clear the ref. Keep a rendered tick as one direct `onSelectDate(line.key, line.progress)` call. Delete `JUMP_EMIT_INTERVAL_MS`, the pending timer, the last-emission timestamp, and the timer cleanup effect.

The no-`dateBuckets` fallback continues scrolling the already-loaded gallery locally during pointer movement and never creates an anchor request.

- [ ] **Step 5: Remove duplicate scroll state**

Delete `const [scrollTop, setScrollTop] = useState(0)` and use:

```tsx
const scrollTop = rowVirtualizer.scrollOffset ?? 0;
```

Remove every `setScrollTop(...)` call and the layout effect that mirrors element scroll position into state. Keep programmatic `element.scrollTop = ...` assignments and reduce the native handler to `onScroll={cancelQuickPreview}`.

- [ ] **Step 6: Add failing asynchronous decode assertions**

In `AssetGallery.test.tsx`, assert the rendered Asset image has `decoding="async"`. In `VideoTileMedia.test.tsx`, assert the still thumbnail image has the same attribute. Run each targeted file and confirm the assertions fail because the attribute is absent.

- [ ] **Step 7: Add decode hints and verify GREEN**

Add `decoding="async"` to the Asset `<img>` in `AssetGallery.tsx` and the still/scrub `<img>` in `VideoTileMedia.tsx`.

```powershell
npm.cmd test -- src/assets/AssetGallery.test.tsx
npm.cmd test -- src/video/VideoTileMedia.test.tsx
```

Expected: both files pass, including existing direct tick and active-date behavior.

- [ ] **Step 8: Commit the Asset change**

```powershell
git add -- app/src/assets/AssetGallery.tsx app/src/assets/AssetGallery.test.tsx app/src/video/VideoTileMedia.tsx app/src/video/VideoTileMedia.test.tsx
git commit -m "perf: reduce asset gallery jump work"
```

---

### Task 2: Generate and Reuse Collection Source Thumbnails

**Files:**
- Modify: `app/src-tauri/src/library/error.rs:210-219`
- Modify: `app/src-tauri/src/library/collection_source.rs:1-329`
- Test: `app/src-tauri/src/library/collection_source.rs:331-469`

**Interfaces:**
- Consumes: the configured Collection source root and existing safe source-image resolution.
- Produces: `Library::collection_source_thumbnail_media(collection_id: &str)` and `Library::collection_cover_thumbnail_media(collection_id: &str, file_name: &str)`, both returning bounded WebP `MediaResponse` values.

- [ ] **Step 1: Write a real-image failing test for source thumbnails**

Write a 1200x800 PNG with `image::DynamicImage::new_rgb8(1200, 800).save(path)`, call `collection_source_thumbnail_media`, read the response, and assert:

```rust
assert_eq!(media.mime, "image/webp");
let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::WebP).unwrap();
assert!(decoded.width() <= 360);
assert!(decoded.height() <= 360);
```

Call the method a second time and assert the only cache file under `library.root().join("collection-thumbnails").join(COLLECTION_ID)` is unchanged and returns identical bytes.

- [ ] **Step 2: Write a failing cover isolation test**

Create two valid cover PNGs, request `collection_cover_thumbnail_media` for both filenames, and assert the cache directory contains two different WebP files. Assert `collection_cover_media` still returns original PNG bytes.

- [ ] **Step 3: Run the library tests and verify RED**

From `app/src-tauri`:

```powershell
cargo test --lib collection_thumbnail
```

Expected: compilation fails because the two thumbnail media methods do not exist.

- [ ] **Step 4: Add the thumbnail write error and cache-key helper**

Add:

```rust
#[error("컬렉션 썸네일 파일을 쓸 수 없습니다: {path}")]
WriteCollectionThumbnail {
    path: PathBuf,
    #[source]
    source: std::io::Error,
},
```

In `collection_source.rs`, add `COLLECTION_THUMBNAIL_BOUND: u32 = 360` and:

```rust
fn collection_thumbnail_relative_path(
    collection_id: &str,
    source_relative_path: &Path,
    source_length: u64,
    source_modified_nanos: u128,
) -> String {
    let normalized = source_relative_path.to_string_lossy().replace('\\', "/");
    let identity = format!("{normalized}\0{source_length}\0{source_modified_nanos}");
    let hash = format!("{:x}", Sha256::digest(identity.as_bytes()));
    format!("collection-thumbnails/{collection_id}/{hash}.webp")
}
```

Factor the existing Collection root/path lookup into a private method returning `(source_root, source_image_path)` for either a preview or named cover. Existing original methods continue passing the resolved path to `open_manga_media`.

- [ ] **Step 5: Implement lazy, atomic thumbnail generation**

Add one private operation used by both public thumbnail methods:

```rust
fn collection_thumbnail_media(
    &self,
    collection_id: &str,
    source_root: &Path,
    source_path: PathBuf,
) -> Result<MediaResponse, LibraryError>
```

It must call `open_manga_media` before deriving or writing, obtain the opened source's byte length and modification timestamp, hash those values with `source_path.strip_prefix(source_root)`, reuse an existing immutable cache path, decode only when that path is missing, resize with `.thumbnail(360, 360)`, write WebP to a UUID-suffixed temporary file, atomically rename it, tolerate another request winning the rename, and return `open_library_media`. It never returns source media as fallback.

- [ ] **Step 6: Add and pass a freshness test**

After the first request, rewrite the source with a different aspect ratio and set its modification time later using standard-library file timestamps. Request again and assert a new cache entry is selected and its decoded dimensions reflect the replacement source. Do not add a dependency.

```powershell
cargo test --lib collection_thumbnail
```

Expected: generation, reuse, isolation, original preservation, and freshness tests pass.

- [ ] **Step 7: Commit the library cache**

```powershell
git add -- app/src-tauri/src/library/error.rs app/src-tauri/src/library/collection_source.rs
git commit -m "feat: cache collection browsing thumbnails"
```

---

### Task 3: Expose Thumbnail Routes and Clean Cache on Deletion

**Files:**
- Modify: `app/src-tauri/src/library/mod.rs:59-75`
- Modify: `app/src-tauri/src/media_protocol.rs:74-130,371-412`
- Test: `app/src-tauri/src/media_protocol.rs:500-565`
- Modify: `app/src-tauri/src/library/collection.rs:205-213`
- Test: `app/src-tauri/src/library/collection.rs:650-686`

**Interfaces:**
- Consumes: the two Library thumbnail methods from Task 2.
- Produces: `/collection-source-thumbnail/{collectionId}` and `/collection-cover-thumbnail/{collectionId}/{fileName}`; Collection deletion removes `collection-thumbnails/{collectionId}`.

- [ ] **Step 1: Write failing protocol route tests**

Add valid PNG source files to the existing fixture and request both new paths through `media_response`:

```rust
let source = media_response(
    Some(&library),
    &Method::GET,
    &format!("/collection-source-thumbnail/{COLLECTION_ID}"),
);
assert_eq!(source.status(), StatusCode::OK);
assert_eq!(source.headers().get(CONTENT_TYPE).unwrap(), "image/webp");

let cover = media_response(
    Some(&library),
    &Method::GET,
    &format!("/collection-cover-thumbnail/{COLLECTION_ID}/vol_1_cover.png"),
);
assert_eq!(cover.status(), StatusCode::OK);
assert_eq!(cover.headers().get(CONTENT_TYPE).unwrap(), "image/webp");
```

Add malformed UUID, missing filename, and traversal filename cases expecting the parser/path boundary's `BAD_REQUEST` or `NOT_FOUND` response.

Name the valid-route test `collection_thumbnail_routes_serve_bounded_webp` so the targeted command below selects it.

- [ ] **Step 2: Run the protocol tests and verify RED**

```powershell
cargo test --lib collection_thumbnail_route
```

Expected: the new paths return `BAD_REQUEST` because `parse_path` has no matching variants.

- [ ] **Step 3: Add media variants, parsing, and dispatch**

Add `CollectionCoverThumbnail` and `CollectionSourceThumbnail` to `MediaVariant`. Extend `parse_path` with exact-segment parsing. Extend collection dispatch with:

```rust
MediaVariant::CollectionCoverThumbnail => Some(
    library.collection_cover_thumbnail_media(&asset_id, &file_name.unwrap_or_default())
),
MediaVariant::CollectionSourceThumbnail => {
    Some(library.collection_source_thumbnail_media(&asset_id))
}
```

Classify both variants with the special media variants in `Library::resolve_media`; protocol dispatch handles them first.

- [ ] **Step 4: Run protocol tests and verify GREEN**

```powershell
cargo test --lib collection_thumbnail_route
```

Expected: valid routes return WebP and invalid requests return the expected status.

- [ ] **Step 5: Write a failing deletion cleanup test**

In the existing Collection deletion test, create `library.root().join("collection-thumbnails").join(&collection.id).join("cached.webp")`, call `delete_collection`, and assert the Collection cache directory no longer exists.

Name the completed regression test `delete_collection_removes_work_artwork_and_collection_thumbnail_cache` so the targeted command below selects it.

```powershell
cargo test --lib delete_collection_removes
```

Expected: FAIL because deletion currently cleans only WorkArtwork files.

- [ ] **Step 6: Remove the thumbnail directory on deletion**

Add a private cleanup method that calls `fs::remove_dir_all` only on `self.root().join("collection-thumbnails").join(collection_id)`, ignores `NotFound`, maps other failures to `WriteCollectionThumbnail`, and runs after successful row deletion before `cleanup_unreferenced_work_artwork()`.

Run the deletion test again and expect PASS.

- [ ] **Step 7: Commit routes and cleanup**

```powershell
git add -- app/src-tauri/src/library/mod.rs app/src-tauri/src/media_protocol.rs app/src-tauri/src/library/collection.rs
git commit -m "feat: serve collection thumbnail routes"
```

---

### Task 4: Route Collection Browsing Images Through Thumbnails

**Files:**
- Modify: `app/src/assets/mediaUrl.test.ts:1-43`
- Modify: `app/src/assets/mediaUrl.ts:31-38`
- Modify: `app/src/collections/CollectionBrowser.test.tsx:110-130`
- Modify: `app/src/collections/CollectionBrowser.tsx:3,166-176`
- Create: `app/src/collections/CollectionCoverGrid.test.tsx`
- Modify: `app/src/collections/CollectionCoverGrid.tsx:1,52-56`
- Modify: `app/src/collections/CollectionCard.test.tsx`
- Modify: `app/src/collections/CollectionCard.tsx:33`
- Verify: `app/src/collections/CollectionOverlay.test.tsx`

**Interfaces:**
- Consumes: the two media protocol paths from Task 3.
- Produces: `collectionSourceThumbnailUrl(collectionId)` and `collectionCoverThumbnailUrl(collectionId, fileName)`; all Collection browsing images use them while the viewer retains originals.

- [ ] **Step 1: Write failing URL helper expectations**

```tsx
expect(collectionSourceThumbnailUrl("collection/one")).toBe(
  "http://lakomics.localhost/collection-source-thumbnail/collection%2Fone",
);
expect(collectionCoverThumbnailUrl("collection/one", "cover one.png")).toBe(
  "http://lakomics.localhost/collection-cover-thumbnail/collection%2Fone/cover%20one.png",
);
```

```powershell
npm.cmd test -- src/assets/mediaUrl.test.ts
```

Expected: compilation fails because both helpers are absent.

- [ ] **Step 2: Add the explicit URL helpers**

```tsx
export function collectionCoverThumbnailUrl(collectionId: string, fileName: string): string {
  return `${MEDIA_ORIGIN}/collection-cover-thumbnail/${encodeURIComponent(collectionId)}/${encodeURIComponent(fileName)}`;
}

export function collectionSourceThumbnailUrl(collectionId: string): string {
  return `${MEDIA_ORIGIN}/collection-source-thumbnail/${encodeURIComponent(collectionId)}`;
}
```

Keep `collectionCoverUrl` and `collectionSourcePreviewUrl` unchanged because they represent original media.

- [ ] **Step 3: Make the CollectionBrowser expectation fail**

Change the source-backed card expectation from `/collection-source-preview/c1` to `/collection-source-thumbnail/c1`.

```powershell
npm.cmd test -- src/collections/CollectionBrowser.test.tsx
```

Expected: FAIL because the browser still selects the preview URL.

- [ ] **Step 4: Switch the card fallback and decode hint**

Import `collectionSourceThumbnailUrl` and use it only for the `sourcePath` fallback, leaving WorkArtwork and Asset branches unchanged. In `CollectionCard.test.tsx`, add a separate failing assertion that the card image has `decoding="async"`, then add that attribute to `CollectionCard`.

Run `CollectionBrowser.test.tsx` and `CollectionCard.test.tsx`; expect PASS.

- [ ] **Step 5: Create a failing CollectionCoverGrid test**

Render one cover and assert:

```tsx
expect(screen.getByRole("img", { name: "vol.1" })).toHaveAttribute(
  "src",
  "http://lakomics.localhost/collection-cover-thumbnail/collection-1/vol_1_cover.png",
);
expect(screen.getByRole("img", { name: "vol.1" })).toHaveAttribute("decoding", "async");
```

```powershell
npm.cmd test -- src/collections/CollectionCoverGrid.test.tsx
```

Expected: FAIL because the component still uses the original cover route and lacks the hint.

- [ ] **Step 6: Switch cover tiles to thumbnails**

Use `collectionCoverThumbnailUrl` for tile `src` and add `decoding="async"`. Do not change `CollectionOverlay`'s `heroUrl`; it keeps `collectionCoverUrl` for the large image.

```powershell
npm.cmd test -- src/collections/CollectionCoverGrid.test.tsx
npm.cmd test -- src/collections/CollectionOverlay.test.tsx
```

Expected: the grid test passes and the overlay keeps original viewer behavior.

- [ ] **Step 7: Commit the frontend route migration**

```powershell
git add -- app/src/assets/mediaUrl.ts app/src/assets/mediaUrl.test.ts app/src/collections/CollectionBrowser.tsx app/src/collections/CollectionBrowser.test.tsx app/src/collections/CollectionCard.tsx app/src/collections/CollectionCard.test.tsx app/src/collections/CollectionCoverGrid.tsx app/src/collections/CollectionCoverGrid.test.tsx
git commit -m "perf: use thumbnails in collection grids"
```

---

### Task 5: Targeted Integration Verification

**Files:**
- Verify only; no planned production edits.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: evidence that both performance paths work together without changing original viewer media.

- [ ] **Step 1: Run the focused frontend set once**

From `app`:

```powershell
npm.cmd test -- src/assets/AssetGallery.test.tsx src/video/VideoTileMedia.test.tsx src/assets/mediaUrl.test.ts src/collections/CollectionBrowser.test.tsx src/collections/CollectionCard.test.tsx src/collections/CollectionCoverGrid.test.tsx src/collections/CollectionOverlay.test.tsx
```

Expected: all selected Vitest files pass without warnings.

- [ ] **Step 2: Run the focused Rust set once**

From `app/src-tauri`:

```powershell
cargo test --lib collection_thumbnail
cargo test --lib delete_collection_removes
```

Expected: all derived thumbnail, route, and deletion tests pass.

- [ ] **Step 3: Inspect the final diff and status**

```powershell
git diff --check HEAD~4..HEAD
git status --short --branch
```

Expected: no whitespace errors and no uncommitted implementation files.

- [ ] **Step 4: Keep deferred work deferred**

Do not add page-window eviction, Collection grid virtualization, cache prewarming, or profiling infrastructure unless targeted evidence or a reproducible manual trace shows a remaining bottleneck.
