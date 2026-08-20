# Collection Source Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each migrated collection's legacy representative image in the collection grid when it has no media-vault cover asset.

**Architecture:** The collection source Module resolves one safe preview file behind `Library::collection_source_preview_media(collection_id)`. The media protocol exposes that result as `collection-source-preview/{collection_id}`, while React only chooses between the existing asset thumbnail URL and this fallback URL.

**Tech Stack:** Rust, rusqlite, Tauri custom media protocol, React, TypeScript, Vitest, Testing Library

## Global Constraints

- A normal `cover_asset_id` always wins over a source preview.
- Source previews are read-only legacy views and never become media-vault assets implicitly.
- Only relative `Cover:` values contained by the collection source folder are valid.
- Preview precedence is `Cover:` → `thumbnail.webp` → another `thumbnail.*` → first root image → first naturally sorted `covers/` image.
- Add no dependency and no schema migration.

---

### Task 1: Resolve and serve a safe collection source preview

**Files:**
- Modify: `app/src-tauri/src/library/collection_source.rs`
- Modify: `app/src-tauri/src/library/mod.rs`
- Modify: `app/src-tauri/src/media_protocol.rs`

**Interfaces:**
- Consumes: `Library::open_manga_media(root: &Path, file_path: PathBuf) -> Result<MediaResponse, LibraryError>` and collection `source_path`.
- Produces: `Library::collection_source_preview_media(&self, collection_id: &str) -> Result<MediaResponse, LibraryError>` and `GET /collection-source-preview/{collection_id}`.

- [ ] **Step 1: Write failing source-resolution tests**

Add tests in `collection_source.rs` that create a collection source folder and assert:

```rust
#[test]
fn source_preview_prefers_info_cover_then_thumbnail_then_cover_file() {
    // Build a source folder containing chosen.png, thumbnail.webp, and
    // covers/vol_1_cover.png. Assert Cover: chosen.png wins, then remove
    // info.txt and assert thumbnail.webp wins, then remove thumbnail.webp
    // and assert the naturally first covers image wins.
}

#[test]
fn source_preview_rejects_cover_outside_collection_folder() {
    // Write Cover: ../outside.png and assert the method does not return
    // outside.png; with no other image candidate it returns MediaNotFound.
}
```

Use a small helper that inserts a collection with a known UUID and `source_path`, sets `collection_source_root`, and writes valid PNG files with the existing test image pattern.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
Set-Location app/src-tauri
cargo test collection_source::tests::source_preview -- --nocapture
```

Expected: compilation failure because `collection_source_preview_media` does not exist.

- [ ] **Step 3: Implement the minimal resolver in the collection source Module**

Add private helpers with these responsibilities:

```rust
fn is_supported_image(path: &Path) -> bool;
fn first_naturally_sorted_image(directory: &Path) -> Result<Option<PathBuf>, LibraryError>;
fn info_cover(collection_dir: &Path) -> Result<Option<PathBuf>, LibraryError>;
fn source_preview_path(collection_dir: &Path) -> Result<PathBuf, LibraryError>;
```

`info_cover` reads `info.txt`, finds the first case-insensitive `Cover:` key, accepts only a non-empty relative path, canonicalizes an existing file, and returns it only when it remains under the canonical collection directory. `source_preview_path` applies the documented precedence and returns `LibraryError::MediaNotFound` when no supported image exists.

Expose only the deep Module interface:

```rust
pub fn collection_source_preview_media(
    &self,
    collection_id: &str,
) -> Result<MediaResponse, LibraryError>;
```

It resolves the configured root and collection `source_path`, calls `source_preview_path`, then delegates final containment and MIME handling to `open_manga_media` using the collection source root.

- [ ] **Step 4: Run the source tests and verify GREEN**

Run:

```powershell
Set-Location app/src-tauri
cargo test collection_source::tests -- --nocapture
```

Expected: all collection source tests pass.

- [ ] **Step 5: Write failing media protocol tests**

Add tests in `media_protocol.rs`:

```rust
#[test]
fn collection_source_preview_route_serves_the_resolved_image() {
    // Configure a collection source containing thumbnail.webp and assert
    // GET /collection-source-preview/{id} returns 200 and image/webp.
}

#[test]
fn collection_source_preview_route_returns_not_found_without_a_candidate() {
    // Configure an empty collection source and assert the same route returns 404.
}
```

- [ ] **Step 6: Run the protocol tests and verify RED**

Run:

```powershell
Set-Location app/src-tauri
cargo test media_protocol::tests::collection_source_preview -- --nocapture
```

Expected: 400 because the route is not parsed.

- [ ] **Step 7: Add the media variant and route**

Add `MediaVariant::CollectionSourcePreview`, parse only the exact two-segment route, and dispatch it before normal asset resolution:

```rust
"collection-source-preview" if segments.next().is_none() => {
    (MediaVariant::CollectionSourcePreview, None)
}
```

Map missing collection/source configuration, unsafe paths, and `MediaNotFound` to 404. Return the resolved image with its detected content type and length, using the existing static-media response pattern.

- [ ] **Step 8: Run backend tests**

Run:

```powershell
Set-Location app/src-tauri
cargo test
```

Expected: all backend tests pass.

- [ ] **Step 9: Commit the backend slice**

```powershell
git add app/src-tauri/src/library/collection_source.rs app/src-tauri/src/library/mod.rs app/src-tauri/src/media_protocol.rs
git commit -m "Add collection source preview media route"
```

---

### Task 2: Use the source preview as the collection grid fallback

**Files:**
- Modify: `app/src/assets/mediaUrl.ts`
- Modify: `app/src/collections/CollectionBrowser.tsx`
- Modify: `app/src/collections/CollectionBrowser.test.tsx`

**Interfaces:**
- Consumes: `CollectionSummary.coverAssetId`, `CollectionSummary.sourcePath`, and `GET /collection-source-preview/{collection_id}`.
- Produces: `collectionSourcePreviewUrl(collectionId: string): string`.

- [ ] **Step 1: Write failing frontend tests**

Add these cases to `CollectionBrowser.test.tsx`:

```tsx
it("uses the source preview when a collection has no cover asset", () => {
  renderBrowser({
    collections: [{ ...sample, sourcePath: "games/astral-chain" }],
    typeFilter: null,
    showcase: false,
  });
  expect(screen.getByRole("img", { name: "Astral Chain" })).toHaveAttribute(
    "src",
    "http://lakomics.localhost/collection-source-preview/c1",
  );
});

it("prefers the media-vault cover asset over the source preview", () => {
  renderBrowser({
    collections: [{ ...sample, coverAssetId: "asset-1", sourcePath: "games/astral-chain" }],
    typeFilter: null,
    showcase: false,
  });
  expect(screen.getByRole("img", { name: "Astral Chain" })).toHaveAttribute(
    "src",
    "http://lakomics.localhost/thumbnail/asset-1",
  );
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
Set-Location app
npx vitest run src/collections/CollectionBrowser.test.tsx --reporter=dot
```

Expected: the source-preview image assertion fails because the card still renders a placeholder.

- [ ] **Step 3: Add the URL helper and minimal browser fallback**

Add to `mediaUrl.ts`:

```typescript
export function collectionSourcePreviewUrl(collectionId: string): string {
  return `${MEDIA_ORIGIN}/collection-source-preview/${encodeURIComponent(collectionId)}`;
}
```

Import it in `CollectionBrowser.tsx` and compute the card URL without new state or per-card commands:

```tsx
coverUrl={
  collection.coverAssetId
    ? thumbnailUrl(collection.coverAssetId)
    : collection.sourcePath
      ? collectionSourcePreviewUrl(collection.id)
      : null
}
```

- [ ] **Step 4: Run frontend tests and typecheck**

Run:

```powershell
Set-Location app
npx vitest run src/collections/CollectionBrowser.test.tsx --reporter=dot
npx tsc --noEmit
npx vitest run --reporter=dot
```

Expected: targeted tests, typecheck, and all frontend tests pass.

- [ ] **Step 5: Commit the frontend slice**

```powershell
git add app/src/assets/mediaUrl.ts app/src/collections/CollectionBrowser.tsx app/src/collections/CollectionBrowser.test.tsx
git commit -m "Show source previews in collection grid"
```

---

### Task 3: Verify the integrated behavior

**Files:**
- No source changes expected.

**Interfaces:**
- Consumes: backend source preview route and frontend URL precedence.
- Produces: verification evidence for completion.

- [ ] **Step 1: Run repository verification**

```powershell
Set-Location app/src-tauri
cargo test
Set-Location ..
npx tsc --noEmit
npx vitest run --reporter=dot
```

Expected: all commands exit with code 0.

- [ ] **Step 2: Inspect the final diff**

```powershell
Set-Location C:\chatgpt
git diff HEAD~2 --check
git status --short
```

Expected: no whitespace errors; only pre-existing unrelated untracked files remain.
