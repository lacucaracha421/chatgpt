# Asset media and aspect filters

## Goal

Add two compact filters to the existing Asset Library toolbar so users can browse assets by media kind and approximate aspect ratio without loading and filtering only the current page.

## Scope

The filters appear in Asset Library browsing views:

- Library root
- Recent
- Favorites
- Unsorted
- Classification folders
- Albums

They do not appear in Works, Manga, Trash, or Similarity Review.

## Toolbar behavior

Place two shared `Select` controls immediately after Sort and before Direct only:

`Location -> Sort -> Media -> Aspect ratio -> Direct only -> Preview size -> Metadata -> Privacy -> Window controls`

Media options:

- All
- Images, including GIF assets
- Videos

Aspect ratio options:

- All
- Square-like
- Landscape
- Portrait

The filters combine with AND semantics. For example, Images plus Portrait returns portrait still images and portrait GIF assets.

Changing either filter restarts the query from the first page and clears date-jump and selection state. Filter values remain active while navigating between Asset Library browsing views. They reset to All when the app restarts.

## Aspect classification

Let `ratio = width / height` conceptually. The implementation uses equivalent integer comparisons rather than floating-point division.

- Square-like: `0.8 <= ratio <= 1.25`
- Landscape: `ratio > 1.25`
- Portrait: `ratio < 0.8`

The boundary values belong to Square-like.

## Architecture and data flow

`AssetBrowser` owns the session-local filter state and includes it in the existing `AssetQuery` Interface. The request continues through the existing `LibraryGateway`, Tauri command, and Rust Library query path. No new Module, Adapter, or dependency is introduced.

The Rust query implementation applies both filters before sorting and pagination. The same predicates apply to date-bucket queries so date counts, date jumping, and gallery results remain consistent.

Media filtering maps Images to database media kinds `image` and `gif`, and Videos to `video`.

The interrupted Rust changes in `models.rs` and `query.rs` are retained only where they match this design. Incorrect SQL placeholder numbering is replaced with the correct parameters for each query shape rather than patched at callers.

## Error handling

Filter queries use the existing asset-loading error path and retry UI. No filter-specific error surface is added.

## Verification

Rust query tests cover:

- Images include `image` and `gif` but exclude `video`
- Videos include only `video`
- Square-like, landscape, and portrait ranges
- Exact `0.8` and `1.25` boundaries
- Filtering before sorting and pagination
- Date-bucket counts under active filters

React tests cover:

- Toolbar control order, labels, and options
- Availability only in Asset Library browsing views
- Combined filter values in `AssetQuery`
- Filter changes restart browsing and clear stale selection/date-jump state
- Filter state persists across Asset Library navigation

Final verification runs the full frontend and Rust test suites. Existing unrelated generated files and user changes remain untouched.
