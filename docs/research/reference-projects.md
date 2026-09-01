# Lakomics Reference Project Research

Last reviewed: 2026-09-01

This document records external projects that are useful as behavioral or architectural references for Lakomics. It is research, not a second backlog. Concrete work remains tracked in `docs/roadmap/lakomics-backlog.md`.

## Reference set

- **VCK 0.1.0** — catalog/search/reader behavior. Local read-only copy: `C:\chatgpt\reference\VCK-0.1.0-win-x64`.
- **Lumina** (`Zakaru-Studio/lumina`) — Tauri/React/Rust large-library virtualization and windowed detail loading.
- **Meguri** (`zabuton-app/meguri`) — local image/video library, discovery/revisit, video scrubbing, incremental media handling.
- **Feral Media Library / FML** (`Feral-Strawberry/fml`) — unified chip search state, contextual facets, saved searches, content identity.
- **Omnio** (`TonyMontania/Omnio`) — cross-media collections, metadata providers, related works, data-health tooling.
- **Komga / Kavita** — mature manga-reader and library UX references.

## License / copying rule

- Lumina is GPL-3.0-only. Treat its implementation primarily as architecture/behavior research; do not copy implementation code into Lakomics without explicitly evaluating license implications.
- FML, Meguri, and Omnio are MIT-licensed at the time of this review. Significant copied code still needs appropriate license/attribution handling.
- Prefer reimplementing ideas in Lakomics' existing architecture rather than importing foreign code mechanically.
- VCK's bundled/minified frontend is behavioral reference material, not a source to paste into Lakomics.

## High-value ideas found before the code-level pass

### VCK

Useful features already identified: advanced query grammar, LTR/RTL reader direction, cover-aware two-page pairing, page overview/jump, fullscreen and scroll reading modes, crop bookmarks, read-state filtering, favorite/excluded tags, image caching, offline download queue, and activity statistics.

The current catalog tasks `CATALOG-004`, `UI-009`, and `BUG-005` already point to VCK where appropriate.

### Meguri

Most relevant to Lakomics' asset/revisit side: discovery decks for resurfacing forgotten media, hover/scene scrub for video, incremental scanning, and avoiding expensive full re-hashing when cheaper file signals are sufficient.

### Omnio

Most relevant to Collections: common detail structure across games/manga/anime/movies, multiple metadata providers, explicit cross-media related-work links/franchise timelines, and a data-health audit for missing covers/metadata/provider identities.

### Komga / Kavita

Use as reader UX references after the VCK-compatible basics are stable: continuous/webtoon reading, mature library/read-list behavior, and reader controls. They are not replacements for Lakomics' current VCK/k-hentai catalog identity.

## Lumina: virtualization and DB windowing

Verified code paths on `main`:

- `src/components/library/PhotoGrid.tsx`
- `src/hooks/useWindowedPhotos.ts`
- `src/hooks/usePhotoBrowser.ts`
- `src/lib/api.ts`
- `src-tauri/src/api/photos.rs`
- `src-tauri/src/database/photos.rs`

### Core model: full ID spine + sparse detail windows

Lumina deliberately separates **identity/order** from **heavy row details**.

1. `list_photo_ids` returns the complete ordered ID list for the current filter/sort.
2. The grid virtualizer uses that complete list to know the real logical length and scrollbar height.
3. `usePhotoWindow` receives the visible flat index range and translates it into fixed detail pages.
4. Each detail page is 300 items (`WINDOW_PAGE = 300`) and is cached independently by React Query.
5. `getPhoto(globalIndex)` returns loaded detail when its page exists, otherwise the cell renders a same-size skeleton.

This means the user can jump to an arbitrary position before the corresponding `Photo` objects have been loaded.

### Grid implementation details worth keeping

`PhotoGrid` virtualizes **rows**, not cells. Column count is derived from measured content width and the chosen target cell size; `rowCount = ceil(ids.length / columns)` is the virtualizer count. Overscan is six rows.

A resize can change row height without changing row count. Lumina explicitly calls `rowVirtualizer.measure()` from a layout effect when `rowSize` changes so cached row offsets are corrected before paint. This is a useful anti-flicker detail for `UI-004`-style work.

Visible virtual rows are converted back into global flat indices and reported through `onVisibleRangeChange`. The callback is deduplicated and requestAnimationFrame-throttled before it reaches the detail-window hook.

Selection performance is also intentionally scoped: the grid does not subscribe to the entire selected-ID Set. Individual cells determine whether their own ID is selected so one selection change does not re-render the complete grid.

### DB side

`list_photo_ids` and `list_photos` share the same filter builder and deterministic sort clause. The ID query is simply the ordered `SELECT id ...` without pagination. The detail query selects the full projection with `LIMIT ? OFFSET ?`.

Rust DB work is wrapped in a blocking boundary before being exposed as Tauri commands.

### Important limitation

Do **not** blindly replace Lakomics' cursor paging with Lumina's model. A complete string-ID list has memory and initial-query cost, and deep SQLite `OFFSET` can become expensive depending on the filter/sort/index plan. Benchmark against Lakomics' real 10k/100k+ data before adopting it.

### Mapping to current Lakomics

Lakomics already uses `@tanstack/react-virtual` in `AssetGallery.tsx`, and it already virtualizes justified rows. `AssetBrowser.tsx` currently owns cursor-based loaded pages with `headCursor` / `tailCursor`. The old date rail was removed because it duplicated the native scrollbar without representing a true global result position.

The current virtualizer's logical length is only the rows built from cursor-loaded `AssetSummary[]`. `AssetPage` has no total count or global start index. The date-bucket query counts all normal assets by local day, but does not accept the gallery's classification, album, collection, creator, media, aspect, favorite, date-range, or sort parameters; it therefore cannot map a filtered scrollbar percentage to an exact asset position. Chronological `aroundDate` can seek to a day boundary, but it cannot resolve an arbitrary global index, within-day rank, favorites order, or random order.

An accurate future fast scroller needs one lightweight positional contract shared with the detail query. The smallest candidates are (a) a filtered, deterministically ordered ID/index spine with sparse `AssetSummary` windows, or (b) sampled global-index-to-keyset-cursor anchors plus an exact filtered count and a keyset seek helper. Either approach must use the same filters and stable tie-break ordering as `list_assets`; deep `OFFSET` is not an acceptable shortcut. The ID spine is simpler for exact thumb geometry, while sampled anchors may bound memory better but need measured seek accuracy and placeholder geometry.

Therefore the useful Lumina lesson is **not** "add virtualization"; Lakomics already has it. The interesting experiment is whether to decouple a lightweight global position/index layer from the heavier loaded `AssetSummary[]` window.

Potential Lakomics hybrid:

- retain cursor/keyset queries for normal sequential loading;
- add a lightweight ordered/index representation only if arbitrary deep jumping/select-all requires it;
- preserve same-size unloaded placeholders so virtual geometry never depends on detail arrival;
- report visible global ranges separately from render details;
- re-measure virtual rows before paint when thumbnail size/layout metrics change;
- keep selection subscriptions cell-local where possible.

Before changing architecture, benchmark current cursor paging versus both positional candidates on 10k, 100k, and preferably 250k synthetic assets. Record filtered count/index query time, first meaningful paint, ID/anchor memory, cold and warm deep-jump latency, queries issued while scrubbing, and scroll/justified-row stability before and after detail windows arrive.

## FML: unified chips and contextual facets

Verified code paths on `main`:

- `src/feral/web/static/js/search.js`
- `src/feral/web/static/js/sidebar.js`
- `src/feral/web/static/js/api.js`
- `src/feral/web/filters.py`
- `src/feral/web/library.py`
- `src/feral/web/app.py`

### One canonical search state

FML's strongest design choice is that chips are **not a second search language**.

The persisted/source-of-truth value is a canonical expression string. JavaScript holds a parsed view of it as `{ expression, predicates, sort }`, but parsing and serialization happen only on the server through `/api/filter/parse` and `/api/filter/build`.

This avoids three versions of search semantics drifting apart: typed syntax, sidebar filters, and visual chips all round-trip through the same parser/serializer.

A predicate contains roughly:

- `kind`
- `negated`
- optional `field`
- `values[]` with exact/quoted information
- comparison `op` where applicable

Predicates are ANDed with each other. Multiple values inside the same compatible predicate are ORed, e.g. one model chip can represent `model: flux | krea`. Comparison and sort predicates replace rather than accumulate OR values.

The UI's `groupKey` is essentially `negation + kind + field`. Sidebar clicks therefore either create a new predicate, add another OR value to the matching chip, or remove an already-active value.

Plain search text also joins this same state. FML debounces live free-text filtering, then Enter converts the typed text into persistent predicates/chips instead of maintaining an unrelated search box filter.

### Contextual facet semantics

FML's sidebar counts are calculated in the context of the **other active filters**, while excluding the facet group's own predicate. This is the key to making same-group OR expansion usable.

Example: with `[Model: flux] [Rating >= 4]` active, model counts are evaluated with the rating constraint but without the active model constraint. That lets the sidebar honestly show how many `krea` results could be added as an OR value instead of forcing every other model to zero.

Zero-count facet values remain visible but dimmed rather than disappearing. This keeps the available vocabulary stable while still communicating that a value currently produces no matches.

The sidebar receives the canonical expression, sends it to `/api/models`, `/api/facets`, and `/api/ratings`, and marks active rows from the same parsed predicate state. Stale count responses are sequence-number guarded.

### Server-side facet optimization

For filtered facet requests FML removes each facet group's own predicates server-side, builds the effective filter, and materializes matching items into temporary hit tables.

The temp table stores a lightweight projection such as file hash, date, container, width, and height, adds a unique index on the hash, then runs `ANALYZE` so SQLite chooses a useful join order. Equivalent effective filters reuse the same temp table during the facet payload calculation.

The source comments record a 250k-item benchmark where repeatedly evaluating the inline filter for every facet was roughly 3.0 s for a LIKE-heavy case, while materializing the hit set once reduced the path to about 0.6 s. Treat those as project-local measurements, not guaranteed Lakomics numbers.

With no active filter, FML deliberately stays on its simpler unfiltered counting path instead of paying temp-table setup cost.

### What Lakomics should borrow from FML

The highest-value concept is a shared structured search state for the **main asset library**, not only the online catalog. A future Lakomics design could expose classification, creator, media type, favorite/rating, date, source, collection, and other filters as removable chips while retaining a typed advanced form.

Recommended invariants:

- one parser/query model owned by the backend or shared core;
- chips are a projection/editor of that model, never an independent filter implementation;
- same-facet values use explicit OR semantics; different facet groups normally AND;
- every query is parameterized;
- canonical serialization makes saved searches stable and debuggable;
- contextual counts exclude the facet currently being counted;
- stale facet requests cannot overwrite newer state;
- zero-count vocabulary can remain visible/dim rather than jumping in and out of the sidebar.

Do not copy FML's exact grammar blindly. Lakomics already has classification hierarchy, albums/collections, creator/source metadata, Revisit contexts, and a separate VCK-compatible online-catalog grammar target. Define whether asset search and `CATALOG-004` share an AST shape or merely share parser/compiler patterns before implementation.

## Recommended next experiments

1. Benchmark Lakomics' existing justified-row + cursor architecture before replacing any part of it.
2. Prototype a lightweight global asset-index/window layer only if deep arbitrary jumps or full-query selection justify it.
3. Design a Lakomics search predicate type and chip round-trip contract on paper before changing UI.
4. Prototype contextual counts for two cheap facets first (for example media type + classification) and measure query cost.
5. If contextual counts become expensive at large scale, test FML-style materialized hit sets against repeated parameterized WHERE queries using Lakomics' actual schema.

No external implementation has been copied into Lakomics as part of this research pass.

## Secondary references

### Hydrus Network

Use Hydrus mainly as a long-running reference for personal booru-style organization: deep tag vocabularies, tag relationships, powerful filtering, large-library workflows, and the idea that metadata can be more durable and expressive than folder layout. It is a conceptual/search-model reference rather than an architectural template for Lakomics.

Potential Lakomics lessons:

- keep tag/search semantics independent from physical file paths;
- support large vocabularies without forcing everything into a rigid category tree;
- consider relationships/aliases between tags only if Lakomics' simpler classification model eventually becomes limiting;
- preserve bulk-tagging and query ergonomics as the library grows.

### Allusion / Allusion Plus

Use Allusion as a visual asset-library UX reference rather than a backend model: browsing, lightweight tag editing, filtering, and reference-image organization are closer to Lakomics' asset side than its manga/catalog side.

Potential Lakomics lessons:

- keep gallery browsing visually calm even when metadata tools are available;
- make tagging/editing fast without turning every tile into a control panel;
- compare detail/sidebar density against Lakomics' current classification sidebar before adding more chrome.

These secondary references are lower priority than Lumina/FML/Meguri/Omnio because the current high-value Lakomics work already has closer architectural matches elsewhere.
