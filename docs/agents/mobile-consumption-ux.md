# Lakomics Mobile consumption UX

Status: approved design direction; native preview implemented 2026-09-07, device acceptance pending

The new `app/mobile-client` / `android` preview implements the core consumption path. See `android/README.md` for its exact scope and current limitations. Browser fixture/static/offline checks do not complete the Galaxy Tab device gate below. The living backlog retains MOBILE-004 as PARTIAL.

This document defines the consumption-oriented UI and loading behavior for the
Galaxy Tab Lakomics client. It refines the product direction in `mobile.md`;
current code and contracts remain authoritative for implemented behavior.
Concrete implementation work belongs in `docs/roadmap/lakomics-backlog.md` when
it is scheduled.

## Experience priority

Mobile should optimize for these activities in order:

1. inspect recently saved media immediately;
2. choose a classification or creator and browse it deliberately;
3. rediscover older media without a specific destination.

The primary device is Galaxy Tab S11. Portrait is the primary consumption
layout, while landscape remains a supported first-class layout. This design
does not expand the product into desktop-style library management.

## Scope

This design covers:

- the Mobile home hierarchy;
- classification-based library browsing;
- aspect-ratio-preserving grids and density control;
- image and video viewer sizing;
- progressive thumbnail-to-original loading;
- bounded adjacent-image preloading;
- loading, error, and state-restoration behavior.

This design does not cover:

- Collections or Showcase implementation;
- Online Manga Catalog browsing, catalog bookmarks, or reading-progress sync;
- Android `DocumentsProvider` or the native application shell;
- a new cloud `display.webp` representation;
- classification editing, bulk organization, or other desktop management work.

Collections may return as a primary Mobile destination when their consumption
experience is implemented. The Online Manga Catalog should be designed
separately after its PC experience and data contracts are updated.

## Information architecture

The initial bottom navigation contains two destinations:

- **Home** — inspect recent additions and enter lightweight revisit
  or discovery experiences;
- **Library** — browse the existing classification hierarchy and its assets.

Connection status and settings move to the top-right overflow menu. They must
remain accessible without occupying a persistent consumption tab. Empty future
destinations are not shown merely to reserve space.

## Home

Home starts directly with the Recent toolbar and gallery. The introductory
heading and Continue section were removed at user request on 2026-09-07.

The vertical order is:

1. **Recent additions** — the dominant, full-width gallery. It uses the same
   canonical Recent query as the Library (`{type: "recent"}`), not a fabricated
   classification ID.
2. **Revisit and discovery** — secondary modules below Recent. They should be
   concise and must not delay the first useful Recent paint.

Recent, Revisit, and discovery maintain separate viewer sequences. Opening an
item in one section must not leak navigation into another section.

## Aspect-ratio-preserving gallery

The gallery uses a justified-row layout:

- every image is shown at its complete intrinsic aspect ratio;
- rows share a target height while tile widths vary by media aspect ratio;
- the final row may remain ragged rather than crop or distort its items;
- video posters follow the same geometry and retain a clear video marker;
- tile order remains the query order from left to right, then top to bottom.

Layout calculations use stored media dimensions. A missing or invalid aspect
ratio uses a neutral fallback ratio until valid metadata is available. Loading
an image must not change the geometry of already laid-out rows.

### Density control

A control in the gallery toolbar cycles through three target row heights:

1. **Large** — fewer, larger items;
2. **Balanced** — the default portrait density;
3. **Compact** — more, smaller items.

The control changes target row height, not a fixed column count. Its accessible
name includes the active density. The last selection is stored on the device
and reused for Home and Library galleries. A density change reflows the current
gallery while preserving the current visual anchor where practical.

## Navigation and state continuity

- The previous grid remains visible until a replacement view has a committed
  first page; navigation must not flash an empty gallery.
- Responses from superseded queries or selections are ignored.
- Returning from the viewer restores the gallery, density, selected view, and
  scroll position.
- Portrait opens the classification hierarchy as a drawer or sheet. Landscape
  may keep the persistent classification sidebar defined in `mobile.md`.
- Cursor requests remain bounded, while continuous scrolling appends subsequent
  batches. Virtualized rows keep the full library out of the DOM. The next batch
  is prefetched as metadata only; visible thumbnails never block a list commit.

## Media viewer

The viewer opens immediately and prioritizes the media surface.

### Initial fit

- At the default zoom, the complete image or video fits inside the usable
  Galaxy Tab viewport, including safe areas and any visible viewer controls.
- Initial viewing never requires vertical page scrolling or dragging to find an
  edge of the media.
- Images and videos preserve their intrinsic aspect ratio and use contain-style
  sizing. Letterboxing is preferable to cropping or distortion.
- Switching to another item resets the viewer to the fitted state.

### Image zoom

- Pinch zoom is available for images only.
- Panning becomes active only after the image is enlarged beyond the fitted
  scale.
- At fitted scale, horizontal gestures belong to previous/next navigation
  rather than image panning.
- An original request started for zoom is cancelled or ignored if the active
  asset changes before it completes.

### Video

- Video always starts contained within the usable viewport.
- Normal native playback controls remain operable and must not be interpreted
  as gallery swipe gestures.
- The poster remains visible until the video can present a frame.
- Metadata remains available on demand rather than permanently reducing the
  media area.

## Progressive media loading

The first implementation reuses the existing cloud `thumbnail` and `original`
variants. It does not add a third representation.

### Image open sequence

1. Reuse the already displayed thumbnail and open the viewer without a blank
   intermediate frame.
2. Fit that thumbnail to the viewer using the asset's intrinsic aspect ratio.
3. Request the original in the background.
4. Decode the original before replacing the thumbnail in place.
5. Keep the thumbnail visible if the original request or decode fails, and
   offer a non-destructive retry.

The replacement must not alter zoom, viewport geometry, or the active viewer
sequence. A late result for an inactive asset is ignored.

### Adjacent-image preload

- After the active item is known, preload at most the immediately previous and
  next image originals.
- Preloading is deduplicated by asset ID and variant.
- A change of viewer sequence or active view cancels or invalidates irrelevant
  work.
- Preload failures are silent; they do not interrupt the current item.
- Videos are not preloaded as adjacent originals in this first pass.

### Video open sequence

1. Reuse the server thumbnail as an immediate fitted poster.
2. Request only the selected video's original media ticket.
3. Prepare metadata and playback without removing the poster prematurely.
4. Let range-capable media delivery and the native video element own buffering
   and seeking behavior.

The viewer must not download neighboring videos speculatively.

## Why thumbnails do not replace viewer media

Current Lakomics image thumbnails are bounded to 360 px and encoded as lossy
WebP at quality 85. They are appropriate for an immediate placeholder and grid
display, but too small to be the settled full-screen image on a Galaxy Tab.

The initial optimization is therefore `thumbnail -> original`, not
`thumbnail -> display.webp -> original`. A viewer-sized representation may be
considered later only if device measurements show that bounded preloading and
progressive replacement still leave unacceptable original-load or decode
latency. Originals must not be destructively replaced as part of that decision.

## Loading and failure behavior

- Recent content paints before slower Revisit or discovery requests finish.
- An already useful grid or viewer thumbnail is never replaced by a global
  loading message.
- A spinner is used only when no visual placeholder is available.
- Original-image failure leaves the thumbnail visible with a retry action.
- Video failure leaves the poster visible with a retry action and a concise
  error state.
- Signed-ticket, fetch, and decode failures are distinguishable in diagnostics
  without exposing tokens or signed URLs.
- Refresh invalidates expired media tickets without discarding unrelated view
  and scroll state.

## Verification

Automated coverage should verify:

- justified-row calculations preserve order and complete aspect ratios;
- all three density modes reflow predictably and the selected mode persists;
- an already rendered thumbnail remains visible until the decoded original
  replaces it;
- stale original and preload responses cannot replace the active asset;
- adjacent preloading is bounded to one item on each side and deduplicated;
- switching assets resets fitted image state and cancels obsolete zoom work;
- video-control interaction is not treated as a swipe;
- view changes retain the old grid until the new first page commits.

The Galaxy Tab S11 device gate should cover portrait first and then landscape:

1. Home opens with useful Recent media before secondary modules finish.
2. Every gallery tile shows the complete media aspect ratio without cropping or
   layout shifts.
3. Density cycles Large -> Balanced -> Compact and survives reload.
4. Tapping a loaded tile produces no blank or black intermediate viewer frame.
5. A preloaded previous or next image appears without a loading spinner.
6. Large portrait and landscape images initially fit without page scrolling or
   dragging; panning begins only after pinch zoom.
7. Videos initially fit the viewport, keep their poster until ready, and retain
   usable native controls.

Record cold and warm timings for tap-to-first-visual, tap-to-original-replace,
adjacent navigation, and video first-frame presentation. Measurements decide
whether a future viewer-sized derivative is warranted; its need is not assumed
by this design.

## 2026-09-07 Home and transfer update (0.2.0)

The latest direction replaces the introductory/Continue blocks with a compact Recent entry and varied real-library exploration. Home presents recent 12, up to six visited classifications, four daily classification covers chosen across top-level branches before filling remaining slots, and date/creator Revisit image groups. Classifications use saved IDs/counts/breadcrumbs, with no fixed personal folders. Recent is usable before up to four cover metadata requests finish (concurrency two). Classification collages may crop their previews; Library/gallery and viewer preserve complete media aspect ratios.

Leaving the viewer cancels native original requests. Gallery thumbnails pause beneath the viewer and adjacent original preload is reduced to one known-size image no larger than 8 MiB. Viewed image originals up to 32 MiB share the native 1 GiB media cache; videos use direct signed streaming URLs. A delayed video offers retry with a renewed URL and preserved playback position. The device timing gates above remain required; build/browser checks do not establish a measured speedup.
