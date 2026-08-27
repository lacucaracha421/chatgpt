# Asset and Collection Grid Performance Design

## Goal

Reduce frame drops while scrolling the Asset gallery, dragging its date rail, and browsing Collection grids without changing the established visual design or using original Collection artwork in browsing surfaces.

## Confirmed Policy

- Asset and Collection browsing surfaces use bounded derived thumbnails.
- Original Collection cover files are allowed only when a cover is shown large in the Collection viewer.
- A thumbnail failure never falls back to an original file in a browsing grid.
- Existing spacing, layout, selection, and viewer interactions remain unchanged.

## Current Causes

### Asset gallery

The Asset gallery already uses 360x360 Asset thumbnails and `@tanstack/react-virtual`, but it performs extra work on the scroll and date-jump paths:

- The native scroll handler writes `scrollTop` into React state on every scroll event even though the virtualizer already tracks the scroll offset.
- Date-rail dragging can emit a new `listAssets({ aroundDate })` request every 160 milliseconds.
- Every accepted date-jump response replaces the current 100-item page, causing repeated row rebuilding, image mounting, and image decoding while the pointer is still moving.

### Collection grids

WorkArtwork-backed cards and Volume tiles already use 360x360 WebP thumbnails. Asset-backed covers use Asset thumbnails. Two legacy paths still serve originals directly:

- A Collection card using `sourcePath` can receive the selected source preview file without resizing.
- `CollectionCoverGrid` uses the original `collection-cover` route for every cover tile.

CSS `loading="lazy"` delays requests but does not reduce the decode and raster cost of visible originals.

## Considered Approaches

### 1. Lazy derived thumbnails with focused scroll changes — selected

Create a thumbnail only when its browsing URL is requested, store it in a deterministic library-managed cache, and reuse it. Commit an Asset date jump only when the pointer is released and remove the redundant Asset scroll state.

This reuses the existing WorkArtwork thumbnail pattern, avoids startup work, and addresses the identified causes with the smallest durable change.

### 2. Eagerly prebuild all Collection thumbnails

This gives predictable first-scroll behavior but adds startup or import work, progress reporting, bounded concurrency, failure recovery, and migration concerns. It is unnecessary while lazy caching can satisfy the requirement.

### 3. Frontend-only image hints

Adding `decoding="async"`, containment, or grid virtualization without changing the media routes is smaller, but visible originals would still be decoded. These hints are useful complements and not a root-cause fix.

## Asset Gallery Design

### Date rail

Dragging the rail is a preview interaction until pointer release:

1. `pointerdown` captures the pointer and records the nearest date bucket locally.
2. `pointermove` replaces that pending date and ratio without calling `onSelectDate`.
3. `pointerup` resolves the final pointer position and calls `onSelectDate(date, ratio)` exactly once.
4. `pointercancel` clears the pending jump without calling `onSelectDate`.
5. Direct activation of a rendered date tick remains a single immediate jump.

When no global date buckets are available, the existing rail fallback continues moving only within the already-loaded gallery and does not create an anchor request.

The 160-millisecond request throttle and its timer are removed because no network or database request occurs during drag.

### Scroll tracking

`AssetGallery` removes its duplicate `scrollTop` React state. Active-date calculations use the virtualizer's current scroll offset, which is updated by the same scroll observation that drives virtual rows. Programmatic jumps continue setting the scroll element position; the virtualizer's normal scroll notification updates the rendered range and active date.

The scroll handler retains only the quick-preview cancellation behavior.

### Image decoding

Asset grid images use `decoding="async"` in addition to the existing `loading="lazy"`. Video thumbnail images receive the same hint where they use a still thumbnail.

### Deferred work

Loaded-page eviction, a new page-window model, and a second virtualization layer are excluded. They are justified only if measurement after this change shows degradation during unusually long bidirectional browsing.

## Collection Thumbnail Design

### Media routes

Add two browsing-only routes:

- `/collection-source-thumbnail/{collectionId}` for the main Collection card fallback.
- `/collection-cover-thumbnail/{collectionId}/{fileName}` for cover-selection tiles.

Keep the existing original routes unchanged:

- `/collection-cover/{collectionId}/{fileName}` remains available to the large Collection viewer.
- Existing WorkArtwork original and thumbnail routes retain their current responsibilities.

### Cache layout and identity

Both new routes resolve a trusted source image through the existing Collection source boundary, then use one shared derived-thumbnail operation.

- Maximum bounding box: 360x360 pixels.
- Output format: WebP.
- Cache root: `collection-thumbnails/{collectionId}/` inside the managed library root.
- Cache key: lowercase SHA-256 of the normalized source-relative image path, source byte length, and source modification timestamp.
- Cache file: `collection-thumbnails/{collectionId}/{sourceIdentityHash}.webp`.

Including the resolved source-relative path prevents a changed source-preview selection from reusing the previous image. Including the source metadata gives a changed file a new immutable cache destination, avoiding platform-specific replacement behavior. A missing cache file is generated lazily; an unchanged source reuses the same path. Older derived files are harmless cache data and the Collection directory cleanup removes them when the Collection is deleted.

The derived cache is not domain state and adds no database column. Deleting a Collection removes its `collection-thumbnails/{collectionId}` directory along with the existing WorkArtwork cleanup.

### Safe generation

The route validates the collection and resolves the source file under the configured Collection source root before decoding. It writes to a uniquely named temporary file in the target cache directory and renames the completed WebP into place. A concurrent request may win the rename race; the loser accepts the completed destination and removes its temporary file.

An invalid ID, missing source, unsupported image, or failed thumbnail write returns the existing media error response. Browsing code does not retry through an original URL.

### Frontend URL ownership

Add explicit URL helpers for the two thumbnail routes. Their consumers are fixed:

- `CollectionBrowser` uses `collectionSourceThumbnailUrl` for `sourcePath` fallback cards.
- `CollectionCoverGrid` uses `collectionCoverThumbnailUrl` for every tile.
- `CollectionOverlay` keeps `collectionCoverUrl` for the selected large cover.
- WorkArtwork cards and Volume tiles keep `workArtworkThumbnailUrl`.

Collection and cover-grid thumbnail images add `decoding="async"` while retaining lazy loading.

## Error Handling

- Asset rail cancellation produces no date jump.
- Stale Asset requests keep the existing generation guard; the new interaction greatly reduces how often it is needed.
- Collection thumbnail errors use existing HTTP/media error mapping.
- Browsing images show their existing broken-image or placeholder behavior instead of requesting an original.
- Thumbnail creation never modifies the external Collection source files.

## Testing

### Frontend

- An Asset gallery interaction test proves multiple pointer moves emit no date jump before release and emit the final bucket exactly once on release.
- A cancellation test proves `pointercancel` emits no jump.
- Existing direct tick activation behavior remains covered.
- URL helper tests distinguish original and thumbnail Collection routes.
- `CollectionBrowser` proves source-backed cards use the source-thumbnail route.
- `CollectionCoverGrid` proves tiles use cover-thumbnail URLs.
- `CollectionOverlay` proves the large selected cover continues using the original route.

### Rust

- A Collection source test proves a generated thumbnail is WebP and fits within 360x360.
- A cache reuse test proves a second request reuses the existing file.
- A freshness test proves changed source metadata selects and generates a new cache entry.
- Route tests prove valid requests return WebP and missing or invalid paths are rejected.
- A deletion test proves the Collection thumbnail cache directory is removed with its Collection.

Verification follows the repository rule of running the most relevant targeted test during each TDD cycle and expanding only after a failure or identified cross-module risk.

## Acceptance Criteria

- Dragging the Asset date rail performs at most one anchor query per completed drag.
- Native Asset scrolling no longer performs a separate `scrollTop` state update.
- Asset and Collection browsing images request only thumbnail routes.
- Collection source fallback cards and cover-selection tiles never decode original source images.
- The large Collection viewer still displays the original selected cover.
- No new runtime dependency, database migration, visual ornament, or broad grid rewrite is introduced.

## Non-Goals

- Exact FPS guarantees across hardware.
- Replacing `@tanstack/react-virtual`.
- Virtualizing the Collection grid before thumbnail changes are measured.
- Eagerly rebuilding every existing thumbnail at startup.
- Changing Collection viewer layout, motion, or image quality.
