# Asset Media and Aspect Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-backed media-kind and approximate-aspect filters to every Asset Library browsing toolbar while excluding Works and other non-Asset-Library views.

**Architecture:** `AssetBrowser` owns session-local UI filter state and places nullable filter values in the existing `AssetQuery` Interface. Rust applies the predicates before sorting, pagination, and date aggregation, while `AssetToolbar` reuses the shared compact `Select` control.

**Tech Stack:** React 19, TypeScript 7, Vitest, Rust, rusqlite, Tauri 2

## Global Constraints

- Show filters in Library root, Recent, Favorites, Unsorted, Classification folders, and Albums only.
- Do not show or apply them in Works collection views, Manga, Trash, or Similarity Review.
- Media options are All, Images (including GIF), and Videos.
- Aspect options are All, Square-like (`0.8 <= width / height <= 1.25`), Landscape (`> 1.25`), and Portrait (`< 0.8`).
- Combine media and aspect filters with AND semantics.
- Place controls immediately after Sort and before Direct only.
- Reuse existing Modules and dependencies; do not add a filter Module, Adapter, or package.
- Preserve unrelated user changes and generated files.
- Do not create a commit unless the user explicitly requests one.

---

### Task 1: Complete the Rust query Interface and predicates

**Files:**
- Modify: `app/src-tauri/src/library/models.rs`
- Modify: `app/src-tauri/src/library/query.rs`
- Test: `app/src-tauri/src/library/query.rs`

**Interfaces:**
- Consumes: existing `AssetQuery`, `Library::list_assets`, and `Library::list_asset_date_buckets`
- Produces: `MediaKindFilter::{Images, Videos}` and `AspectRatioFilter::{Square, Landscape, Portrait}` carried by nullable `AssetQuery.media_kind` and `AssetQuery.aspect_ratio`

- [ ] **Step 1: Replace the interrupted enum shape and add a failing query test**

Use this Rust model shape:

```rust
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaKindFilter {
    Images,
    Videos,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AspectRatioFilter {
    Square,
    Landscape,
    Portrait,
}
```

Add one focused query test with `image`, `gif`, and `video` rows below, on, inside, and above both ratio thresholds. The helper that inserts a `video` asset must also insert a matching `video_assets` row. Assert:

```rust
assert_eq!(ids(images), vec!["image-square", "gif-portrait"]);
assert_eq!(ids(videos), vec!["video-landscape"]);
assert_eq!(ids(square), vec!["ratio-4x5", "ratio-1x1", "ratio-5x4"]);
assert_eq!(ids(landscape), vec!["ratio-wide"]);
assert_eq!(ids(portrait), vec!["ratio-tall"]);
```

- [ ] **Step 2: Run the focused test and verify it fails**

```powershell
cargo test library::query::tests::media_and_aspect_filters_apply_before_pagination -- --exact
```

Expected: FAIL because Images/GIF grouping and approximate ratio thresholds are not implemented, or because the interrupted SQL has an invalid parameter count.

- [ ] **Step 3: Implement explicit filter values and correct every SQL shape**

Use query-local conversion functions rather than formatting `Debug` output:

```rust
fn media_filter_value(filter: Option<MediaKindFilter>) -> Option<&'static str> {
    filter.map(|value| match value {
        MediaKindFilter::Images => "images",
        MediaKindFilter::Videos => "videos",
    })
}

fn aspect_filter_value(filter: Option<AspectRatioFilter>) -> Option<&'static str> {
    filter.map(|value| match value {
        AspectRatioFilter::Square => "square",
        AspectRatioFilter::Landscape => "landscape",
        AspectRatioFilter::Portrait => "portrait",
    })
}
```

Use these predicates in every asset-page SQL constant and in date buckets:

```sql
AND (
  (?N IS NULL)
  OR (?N = 'images' AND asset.media_kind IN ('image', 'gif'))
  OR (?N = 'videos' AND asset.media_kind = 'video')
)
AND (
  (?M IS NULL)
  OR (?M = 'square' AND asset.width * 5 >= asset.height * 4 AND asset.width * 4 <= asset.height * 5)
  OR (?M = 'landscape' AND asset.width * 4 > asset.height * 5)
  OR (?M = 'portrait' AND asset.width * 5 < asset.height * 4)
)
```

Use the next actual indexes and pass exactly the matching number of values:

- chronological and favorites: media `?11`, aspect `?12`, 12 values
- random: media `?12`, aspect `?13`, 13 values
- date buckets: media `?7`, aspect `?8`, 8 values

- [ ] **Step 4: Verify the focused test and prior regression failures**

```powershell
cargo test library::query::tests::media_and_aspect_filters_apply_before_pagination -- --exact
cargo test library::query::tests --lib
cargo test library::favorite --lib
cargo test library::legacy_migration::tests --lib
cargo test library::ingestion::tests::unrelated_image_is_added_normally -- --exact
```

Expected: every command exits 0 and `InvalidParameterCount(12, 13)` is absent.

---

### Task 2: Add TypeScript query types and toolbar controls

**Files:**
- Modify: `app/src/library/types.ts`
- Modify: `app/src/assets/AssetToolbar.tsx`
- Modify: `app/src/assets/AssetToolbar.test.tsx`

**Interfaces:**
- Consumes: shared `Select`, `AssetView`, and existing toolbar ordering
- Produces: `AssetMediaFilter`, `AssetAspectFilter`, nullable `AssetQuery.mediaKind` and `AssetQuery.aspectRatio`, plus controlled filter props on `AssetToolbar`

- [ ] **Step 1: Write failing toolbar tests**

Extend `baseProps` with controlled values and callbacks, then assert:

```tsx
expect(screen.getByRole("combobox", { name: "미디어" })).toHaveValue("all");
expect(screen.getByRole("combobox", { name: "비율" })).toHaveValue("all");
expect(screen.getAllByRole("combobox").map((element) => element.getAttribute("aria-label")))
  .toEqual(["정렬", "미디어", "비율"]);
```

Change both selects and assert the callbacks receive `images` and `portrait`. Rerender with a collection view and assert neither filter combobox exists.

- [ ] **Step 2: Run the toolbar test and verify it fails**

```powershell
npx vitest run src/assets/AssetToolbar.test.tsx
```

Expected: FAIL because the filter controls and props do not exist.

- [ ] **Step 3: Add the minimal types and controls**

Add these exported types and query fields:

```ts
export type AssetMediaFilter = "all" | "images" | "videos";
export type AssetAspectFilter = "all" | "square" | "landscape" | "portrait";

export type AssetQuery = {
  mediaKind: Exclude<AssetMediaFilter, "all"> | null;
  aspectRatio: Exclude<AssetAspectFilter, "all"> | null;
  // existing fields remain unchanged
};
```

Add controlled props to `AssetToolbar` and render the two shared `Select` controls after Sort. Render them only when:

```ts
const filterable = view.kind === "classification"
  || view.kind === "recent"
  || view.kind === "favorites"
  || view.kind === "unsorted"
  || view.kind === "album";
```

Use exactly `전체/이미지/영상` for media values `all/images/videos`, and `전체/정사각형/가로형/세로형` for aspect values `all/square/landscape/portrait`.

- [ ] **Step 4: Run the toolbar test**

```powershell
npx vitest run src/assets/AssetToolbar.test.tsx
```

Expected: all toolbar tests pass.

---

### Task 3: Wire filter state through AssetBrowser and verify the feature

**Files:**
- Modify: `app/src/assets/AssetBrowser.tsx`
- Modify: `app/src/assets/AssetBrowser.test.tsx`

**Interfaces:**
- Consumes: `AssetMediaFilter`, `AssetAspectFilter`, and controlled `AssetToolbar` props
- Produces: nullable `mediaKind` and `aspectRatio` on filterable requests and null values on collection requests

- [ ] **Step 1: Write failing browser behavior tests**

Change both toolbar selects and verify:

```tsx
await user.selectOptions(screen.getByRole("combobox", { name: "미디어" }), "images");
await user.selectOptions(screen.getByRole("combobox", { name: "비율" }), "portrait");
await waitFor(() => expect(gateway.listAssets).toHaveBeenLastCalledWith(
  expect.objectContaining({ mediaKind: "images", aspectRatio: "portrait", after: null, aroundDate: null }),
));
expect(gateway.listAssetDateBuckets).toHaveBeenLastCalledWith(
  expect.objectContaining({ mediaKind: "images", aspectRatio: "portrait" }),
);
```

Also assert selection clears after a filter change, filter values survive navigation to Favorites, and collection requests contain `mediaKind: null` and `aspectRatio: null`.

- [ ] **Step 2: Run the browser test and verify it fails**

```powershell
npx vitest run src/assets/AssetBrowser.test.tsx
```

Expected: FAIL because `AssetBrowser` does not own or forward filter state.

- [ ] **Step 3: Implement session-local state and reset behavior**

Add state:

```ts
const [mediaFilter, setMediaFilter] = useState<AssetMediaFilter>("all");
const [aspectFilter, setAspectFilter] = useState<AssetAspectFilter>("all");
const filterable = view.kind !== "collection";
```

Add to `queryBase` and its dependency list:

```ts
mediaKind: filterable && mediaFilter !== "all" ? mediaFilter : null,
aspectRatio: filterable && aspectFilter !== "all" ? aspectFilter : null,
```

Both change handlers clear `anchor`, `anchorViewKey`, `jumpTarget`, and selection before updating their value. Pass controlled values and handlers to `AssetToolbar`. Preserve filter state while the mounted browser changes Asset Library views, but send nulls for collection views.

- [ ] **Step 4: Run targeted frontend tests**

```powershell
npx vitest run src/assets/AssetToolbar.test.tsx src/assets/AssetBrowser.test.tsx
```

Expected: both test files pass.

- [ ] **Step 5: Run full verification**

```powershell
npm test
cargo test
```

Expected: frontend and Rust report 0 failed tests. Existing unrelated Rust warnings may remain, but `InvalidParameterCount` must not appear.

- [ ] **Step 6: Review the final diff**

```powershell
git diff --check
git diff -- app/src/library/types.ts app/src/assets/AssetToolbar.tsx app/src/assets/AssetToolbar.test.tsx app/src/assets/AssetBrowser.tsx app/src/assets/AssetBrowser.test.tsx app/src-tauri/src/library/models.rs app/src-tauri/src/library/query.rs
```

Expected: no whitespace errors and no unrelated code changes.
