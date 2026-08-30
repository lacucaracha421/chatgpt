# Lakomics Backlog

Living backlog for Lakomics bugs, UX work, cloud follow-ups, extension work, and long-term ideas.

## Status legend

- `IN PROGRESS`: currently being implemented
- `TODO`: planned work
- `VERIFY`: confirm existing behavior before changing
- `HOLD`: long-term or intentionally deferred
- `KEEP`: existing behavior is currently satisfactory

## P0 — immediate

### CLOUD-001 — Cloud Capture batch drain
Status: `IN PROGRESS`

- Drain multiple pending captures per poll instead of one successful capture per invocation.
- Sequential processing only.
- Safety cap: 25 attempted captures per invocation.
- Preserve per-capture failure isolation, idempotency, ACK retry, ExactDuplicate ACK, and ReviewPending no-ACK behavior.
- Return a batch summary instead of the old `Option<String>` result.

### CLOUD-002 — Finish Cloud inbound app integration
Status: `TODO`

- Provide a real app path for `cloud_sync_enabled`, API base URL, and Cloud API token configuration/status.
- Pass `classification_id` end-to-end from Capture API pending records into `IngestMediaRequest`.
- Refresh assets and sidebar/classification counts immediately after a successful inbound import.
- Trigger video preparation when an inbound video is added.
- Verify the current Japanese VPS Capture API works end-to-end from X extension to the PC library.
- Keep outbound `cloud_sync_queue` separate.

### BUG-001 — Collection view shows an error toast on entry
Status: `TODO`

Observed behavior:
- Collection view itself opens.
- An error toast appears immediately after entering the collection viewer.

Action:
- Reproduce and identify the failing collection/work detail path.
- Check DB/schema/migration state before changing UI behavior.

### BUG-002 — Manga tab reports `망가 목록을 불러오지 못했습니다`
Status: `TODO`

Observed behavior:
- Entering the local Manga tab produces `망가 목록을 불러오지 못했습니다`.

Likely paths to inspect:
- `getMangaRoot()`
- `listMangaSeries()`
- `scanManga()`
- local DB/schema/migration state

Note:
- This is independent from the online catalog provider and may only share a DB/migration root cause with BUG-001.

### VERIFY-001 — X → VPS → PC end-to-end check
Status: `TODO`

After CLOUD-001/CLOUD-002 and DB issues are fixed:
- Save a real image from X on the tablet.
- Confirm capture exists on VPS/R2.
- Confirm pending is consumed by the PC.
- Confirm selected classification is preserved.
- Confirm the item becomes visible in the currently running app without restart.
- Repeat with video.

## P1 — visible UX / usability

### UI-004 — Remove rapid flashing during view transitions and previews
Status: `TODO`

Problem:
- Tab switching and image previews cause rapid refresh/flicker that is uncomfortable to look at.

Direction:
- Keep the previous view visible until replacement content is ready.
- Avoid replacing the whole view with a blank/skeleton frame when stale content can remain visible.
- Decode/preload preview images before swapping them in.
- Avoid unnecessary React unmount/remount cycles.
- Keep layout dimensions stable during loading.
- If a transition is needed, use a very short subtle cross-fade rather than full fade-out/fade-in.

### UI-007 — Video viewer controls
Status: `TODO`

- Fix the progress bar being compressed toward the left.
- Let the timeline use the available width naturally.
- Auto-hide playback controls and cursor after roughly 1.5–2 seconds of no input while playing.
- Show controls immediately on pointer movement.
- Keep controls visible while paused, scrubbing, or changing volume.
- Controls must overlay the video rather than changing its layout.

### NAV-001 — Unify back-navigation behavior
Status: `TODO`

Define one navigation priority for:
- Mouse Button 4
- Escape
- overlay close
- detail → list
- nested Revisit views
- previous app view

Expected priority:
1. Close the topmost overlay/detail layer.
2. Return to the parent/list view.
3. Navigate back to the previous app view when applicable.

### UX-009 — Loading, error, retry, and tooltip consistency
Status: `TODO`

- Standardize loading and error presentation.
- Add retry actions where meaningful.
- Preserve the last valid content instead of clearing the entire view where possible.
- Add concise tooltips for ambiguous icon-only controls.
- Make connection/transport errors more diagnosable without exposing secrets.

### UI-006 — Easier asset selection clearing
Status: `TODO`

Current behavior:
- Selection is mainly cleared through the bottom X control.

Improve with:
- Clicking empty gallery/sidebar space clears selection where it does not conflict with navigation.
- Consider right-click to clear selection only if it does not conflict with current/future context menus.
- Keep the explicit X button.

### UI-005 — Collection cover aspect ratio / crop handling
Status: `TODO`

Problem:
- User-selected collection covers are slightly cropped.

Direction:
- Reconsider fixed aspect ratios and unconditional `object-fit: cover`.
- Preserve book/manga covers and other source artwork more faithfully.
- Prefer `contain` or reduced crop where appropriate.
- Keep the original user-selected artwork untouched; change presentation only.
- Reuse consistent cover presentation rules across list/detail/showcase views.

### UI-001 — Move Similarity Review to the management section
Status: `TODO`

- Move `유사 검토` out of the main quick-view group.
- Place it in the lower management area near Trash/Settings.
- Preserve count and routing behavior.

### UI-003 — Use a standard scrollbar in the asset repository
Status: `TODO`

- Remove the special/custom scrollbar styling for the asset repository.
- Use a normal OS/browser-like scrollbar.
- Do not change virtualization or scroll behavior.

## P2 — architecture / larger feature work

### CATALOG-001 — Replace direct k-hentai WebView dependency with Heliotrope-backed catalog
Status: `TODO`

Current issue:
- Online catalog transport currently depends on a hidden WebView2 loading `k-hentai.org` directly.
- Korean network access can be intermittent/restricted and may depend on local HTTPS/SNI workarounds.

Target direction:
- Use Heliotrope as the primary metadata/search source.
- Host catalog services on the Japanese VPS.
- Keep PC search independent from direct k-hentai connectivity.
- Preserve local catalog usability if the remote provider is unavailable.

Desired catalog capabilities:
- Korean and Japanese language filtering
- tags
- artist/group
- parody/series
- characters
- publish date
- latest ordering
- daily/weekly/monthly popularity where supported
- tag autocomplete

### CATALOG-002 — Heliotrope/VCK coexistence and migration strategy
Status: `TODO`

- Do not discard existing imported VCK catalog data immediately.
- Reuse the current local catalog schema where practical.
- Add provider/source identity such as `legacy_vck` and `heliotrope`.
- Define duplicate identity and migration behavior.
- Keep bookmarks and reading progress in Lakomics-controlled storage.
- Separate catalog metadata provider from gallery/page resolver.

### CLOUD-UI-001 — Cloud status and problem surface
Status: `TODO`

Settings should expose at least:
- Cloud enabled/disabled state
- API connection state
- last inbound run
- last success
- last error
- processed summary
- manual `지금 동기화` action if useful

Sidebar behavior:
- Do not create a permanent Cloud Inbox section.
- Show a dynamic `동기화 문제 N` item in the lower management area only when failed/review-pending work exists.

### EXT-001 — Reorganize extension settings
Status: `TODO`

Problem:
- Settings accumulated over time and are difficult to scan.

Reorganize by responsibility:
- save mode
- cloud
- direct PC connection
- donut/radial UI
- notifications
- advanced/debug/legacy

Move old or rarely used controls into an advanced section and remove true duplicates.

### EXT-002 — Cloud-first extension save policy
Status: `TODO`

Possible modes:
- Cloud first
- PC direct
- Automatic

Preferred automatic behavior:
- If the PC direct service is available, save locally immediately.
- Otherwise save through Cloud Capture.
- The user should not need to manually care which transport is currently available.

### PERF-001 — Cache and media optimization policy
Status: `TODO`

Review and define:
- thumbnail cache
- preview cache
- video preview/preparation cache
- stale cache cleanup
- WebP conversion
- image asset optimization
- video optimization

Design for 10,000+ assets without unnecessary stutter or uncontrolled disk growth.

### PERF-002 — Preserve view state across navigation
Status: `TODO`

Consider preserving per-view:
- scroll position
- filter
- sort
- selected classification/album/context

Coordinate this with UI-004 so state preservation also reduces flashing and reload churn.

### CLOUD-003 — Long-video asynchronous Capture handling
Status: `TODO`

Current request-response upload path can race against long client timeouts.

If real use shows this is a problem, consider:
- capture reservation/job creation
- VPS background fetch
- ready state
- expose only ready items as pending inbound work

Do not prioritize ahead of the core inbound usability fixes.

## P3 — new product features

### NOTE-001 — Server-synced everyday Notes section
Status: `TODO`

This is not asset metadata.

- Add `메모` as a dedicated sidebar destination.
- Intended for normal everyday notes, thoughts, reminders, and lightweight personal writing.
- Store/sync through the server so the same notes are available across PCs.
- Initial scope can stay simple: title, body, created/updated timestamps.
- Later candidates: search, pinning, tags.

### STATS-001 — Personal statistics
Status: `TODO`

Potential views:
- assets collected per month
- most collected creators
- most collected classifications
- most viewed collections
- long-unseen collections/items
- recent activity patterns

Reuse the data where useful for Revisit recommendations.

### IDEA-001 — More varied Revisit mixes
Status: `TODO`

Current mixes feel repetitive.

Candidate themes:
- long-unseen favorites
- creator/character combinations
- date/period nostalgia
- recently collected but rarely opened
- high-rated plus discovery mix
- cross-classification mixes

Prefer understandable recommendation rules over pure randomization and reduce repeated exposure.

### UI-008 — Rework the top bar for readability
Status: `TODO`

- Reconsider information hierarchy and grouping.
- Separate state indicators from actions.
- Make common actions more visually discoverable.
- Reduce ambiguous icon-only affordances.
- Prefer grouping/spacing/priority changes over simply making the bar taller.

## Long-term

### LONG-001 — AV actor and title collection
Status: `HOLD`

- Actor profiles and associated title library.
- Manage AV covers as collection media.
- Provide a stronger physical-media presentation rather than plain flat cards.
- DVD case presentation can include front/spine/back and interactive rotation.

### LONG-002 — Media-type-specific collection presentation presets
Status: `HOLD`

Replace the current uniformly flat collection presentation with reusable presets by collection type.

Examples:
- game: game box/package depth, lift, floor shadow, tilt
- manga: book thickness, spine/page cues, subtle 3D tilt
- movie: Blu-ray/DVD case or poster framing
- AV: realistic DVD-case presentation

Build this as `collectionType → presentation preset` rather than one-off CSS effects.

### LONG-004 — Display / shelf mode
Status: `HOLD`

Potential future views:
- bookshelf
- DVD shelf
- game package display
- showcase cabinet

Implement only after the reusable collection presentation system is mature enough.

## Existing features — do not duplicate

### Creator browsing
Status: `KEEP`

Already exists under:
- `다시보기 → 둘러보기 → 작가`

It already supports creator cards and sorting such as recommended, asset count, recent collection, unseen, and name.

### Multi-selection
Status: `KEEP`

Multi-selection and batch-selection infrastructure already exists. Improve selection clearing through UI-006 rather than rebuilding selection.

### Duplicate management
Status: `KEEP`

Current duplicate/similarity management is satisfactory. Only relocate Similarity Review through UI-001 unless new problems appear.

### Asset provenance / import history
Status: `KEEP`

Asset metadata already records useful provenance including source URL, creator, source publish time, collected time, and import source. Extend only when a concrete diagnostic need appears.

## Bug intake rules

New reports from Laku should be appended to this document rather than kept only in chat history.

Use these prefixes:
- `BUG-xxx`: broken behavior or errors
- `UI-xxx`: visual/layout/input usability
- `UX-xxx`: interaction/system-wide experience
- `NAV-xxx`: navigation/back behavior
- `CLOUD-xxx`: Cloud Capture/data-flow work
- `CLOUD-UI-xxx`: cloud visibility/status UX
- `CATALOG-xxx`: online catalog/provider work
- `EXT-xxx`: browser extension work
- `PERF-xxx`: performance/cache/state work
- `NOTE-xxx`: notes feature
- `STATS-xxx`: personal statistics
- `IDEA-xxx`: lower-priority product ideas
- `LONG-xxx`: long-term ideas

For each new bug, record:
- observed behavior
- reproducibility/conditions when known
- suspected area only when evidence exists
- status
- related task IDs if any

## Current intended implementation order

1. CLOUD-001 batch drain
2. CLOUD-002 inbound app integration
3. BUG-001 / BUG-002 DB and migration investigation
4. VERIFY-001 real X → VPS → PC verification
5. P1 UX pass: flashing, video controls, navigation, loading/errors, selection clearing, cover crop, sidebar cleanup, scrollbar
6. CATALOG-001 / CATALOG-002 Heliotrope-based catalog work
7. CLOUD-UI-001 cloud status/problem surface
8. EXT-001 / EXT-002 extension settings and Cloud-first save behavior
9. PERF-001 / PERF-002 cache optimization and view-state preservation
10. CLOUD-003 long-video async handling if real-world use requires it
11. NOTE-001 / STATS-001 / IDEA-001 / UI-008
12. Long-term collection presentation work
