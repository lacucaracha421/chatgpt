# Online Manga Library UX Design

**Date:** 2026-08-22  
**Status:** Approved design  
**Scope:** Online Catalog inside the Manga view

## Goal

Turn the online catalog from a text-heavy launch list into a useful, media-first manga browser.
The browser shows existing VCK thumbnails, supports library-portable bookmarks, opens a detail
dialog before reading, and keeps search, filtering, and pagination responsive with a large
catalog.

## Product decisions

- Use a dense portrait-cover grid rather than horizontal text cards.
- Clicking a card opens a detail dialog. It does not resolve or open the remote gallery.
- Reading begins only after the user chooses `읽기` or `이어 읽기` in the detail dialog.
- Bookmarks belong to the current Lakomics library and move with that library to another PC.
- A star button on each card toggles its bookmark without opening the detail dialog.
- The toolbar exposes `전체 / 북마크` filtering.
- The Manga view may use a second, screen-specific toolbar row without changing the global
  toolbar formula for unrelated views.
- Existing VCK `Works.Thumb` values are the thumbnail source. Do not resolve every gallery merely
  to obtain a thumbnail.

## Data ownership

The imported VCK catalog remains provider data and can be replaced during import or update.
User intent must not be stored inside that replaceable database.

Add a library-owned table conceptually equivalent to:

```text
online_catalog_bookmarks
- provider TEXT NOT NULL
- work_id TEXT NOT NULL
- created_at TEXT NOT NULL
- PRIMARY KEY (provider, work_id)
```

`provider + work_id` is the stable identity. The initial provider is `kHentai`, but the table
does not rely on a display title or mutable catalog metadata.

When a catalog entry disappears, preserve its bookmark row. The entry is omitted from current
results while absent and becomes bookmarked again if a later catalog update restores it.

## Catalog interfaces

### Search summary

Extend the existing catalog search summary with:

```text
thumbnailUrl: optional validated URL
bookmarked: boolean
```

Search accepts an `all` or `bookmarked` scope. Filtering, total count, sort, limit, and offset
must be applied by the repository query so bookmarked pagination remains exact.

### Detail lookup

Add a detail lookup by provider and work ID. It returns only catalog metadata and grouped tags;
it does not resolve image pages.

The detail includes, when available:

- title and Japanese title
- thumbnail URL
- artist, series, uploader, category, and language
- posted and updated timestamps
- page count, file size, views, and rating
- bookmark state
- tags grouped by their source namespace

Tag groups retain their namespace and values so selecting a tag can issue the existing
`namespace:value` catalog search.

### Bookmark mutation

Expose one idempotent mutation that sets the desired bookmark state. The UI changes only after
the library write succeeds. Both cards and the detail dialog use this same interface.

## Thumbnail trust boundary

The imported catalog is external input. Parse thumbnail strings in Rust and return a URL only
when all of the following hold:

- the URL is valid HTTPS;
- the host is exactly `ehgt.org` or ends with `.ehgt.org`;
- the URL does not contain credentials.

Invalid or missing values become `null`. The frontend never constructs or repairs provider URLs.
The Tauri CSP permits only the validated thumbnail host in addition to existing image sources.
Images use `referrerPolicy="no-referrer"`.

## Browser layout

### Manga-specific toolbar

The online Manga view uses two compact rows:

1. source tabs, result count, and title/tag search;
2. `전체 / 북마크`, sort, catalog update, and refresh controls.

The second row belongs to the Manga view and does not enlarge other application toolbars.
Controls use existing shared UI and design tokens. Update and refresh remain quiet secondary
actions.

### Cover grid

- Responsive dense grid, approximately five to eight columns at ordinary desktop widths.
- Portrait media area with the full thumbnail preserved against a neutral background.
- Two title lines, one artist line, then low-contrast page and view metadata.
- Star control in the upper-right corner, with pressed state and an accessible label.
- No card shadow, hover scaling, gradient, pill controls, or decorative entrance motion.
- Focus and hover use border/background state consistent with Lakomics.
- A thumbnail failure swaps only the media area to the existing page-count placeholder and causes
  no layout shift.

The content footer shows the current result range and previous/next page controls. Changing
search, sort, or scope resets to the first page. Moving between pages keeps the current query and
scope.

## Detail dialog

Use the shared medium dialog rather than a separate window implementation.

- Left: a larger cover image with the same safe fallback.
- Upper right: titles and primary creator/series identity.
- Middle right: uploader, dates, page count, file size, views, and rating when present.
- Actions: bookmark toggle and one emphasized `읽기` or `이어 읽기` button.
- Lower area: tags grouped by namespace in an internally scrolling region.

Selecting a tag closes the dialog and searches for its literal `namespace:value`. Closing the
dialog otherwise restores the unchanged grid and scroll position.

Opening the dialog loads catalog detail and existing reading progress in parallel. Progress with
a matching page count produces `이어 읽기`; absent or stale progress produces `읽기` from page 1.
Only activating that reading action resolves the signed gallery URLs and opens `PageViewer`.

## State and failure behavior

- Detail-load failure leaves the grid usable and reports a concise toast.
- Bookmark controls disable only while their own write is pending. A failed write preserves the
  prior visual state and reports an error.
- Thumbnail network failures use the media fallback and do not report one toast per image.
- Missing metadata and empty tag groups are omitted rather than replaced with noisy placeholder
  rows.
- Gallery-resolution failure keeps the detail dialog open and re-enables the reading action.
- Search and filter failure retain the last successful result page when one exists.

## Module seams

- The catalog repository owns VCK queries, detail assembly, exact bookmark joins, and thumbnail
  validation.
- The library database owns bookmark persistence.
- Tauri commands expose search, detail lookup, bookmark mutation, and the existing gallery
  resolver through narrow interfaces.
- `OnlineCatalogBrowser` owns query/sort/scope/page selection and coordinates the grid and dialog.
- A dedicated detail dialog module owns detail presentation and the transition to reading.
- `PageViewer` remains concerned only with displaying resolved pages and reading progress.

Do not move provider SQL or URL validation into React, and do not put new catalog behavior in
`App.tsx`.

## Verification

Use targeted regression coverage proportional to the change:

- migration creates the bookmark table and preserves rows across catalog replacement;
- bookmark set/unset is idempotent and library-local;
- all/bookmarked search reports correct totals and page boundaries;
- detail lookup returns grouped tags and optional metadata;
- invalid thumbnail hosts and schemes are rejected;
- a card body opens detail while its star only toggles bookmark;
- reading resolution starts only from the dialog action;
- matching progress displays and opens `이어 읽기` at the stored page;
- selecting a tag performs the exact namespace search;
- thumbnail failure renders the stable fallback;
- relevant frontend tests, production frontend build, targeted Rust tests, and debug Tauri build
  pass.

## Non-goals

- Download management, offline bulk download, and Hitomi provider integration.
- Editing provider metadata from the detail dialog.
- A second general-purpose bookmark system for Assets or Collections.
- Fetching full gallery manifests for every visible thumbnail.
- Redesigning unrelated application toolbars or the local-folder Manga browser.
