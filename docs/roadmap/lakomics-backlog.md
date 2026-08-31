# Lakomics Backlog

Living backlog for Lakomics bugs, UX work, cloud follow-ups, extension work, and long-term ideas.

## Status legend

- `IN PROGRESS`: currently being implemented
- `TODO`: planned work
- `VERIFY`: implementation or behavior exists and still needs real-world verification
- `HOLD`: long-term or intentionally deferred
- `KEEP`: existing behavior is currently satisfactory
- `DONE`: implemented and verified in code; production rollout may still be tracked separately

## P0 — immediate

### CLOUD-001 — Cloud Capture batch drain
Status: `DONE`

- Drain multiple pending captures per poll instead of one successful capture per invocation.
- Sequential processing only.
- Safety cap: 25 attempted captures per invocation.
- Preserve per-capture failure isolation, idempotency, ACK retry, ExactDuplicate ACK, and ReviewPending no-ACK behavior.
- Return a batch summary instead of the old `Option<String>` result.

### CLOUD-004 — X videos fall back to local download instead of VPS Capture
Status: `DONE`

Resolution:
- The extension was short-circuiting to browser download whenever the active classification source was the local fallback tree.
- Collector-enabled supported media now tries VPS Capture before that local-download fallback, and fallback diagnostics preserve the failure code.

Observed behavior:
- Saving X video on PC succeeds only as a browser/local-folder download.
- The video is not being retained by the VPS Capture/R2 path.
- Image Capture behavior must be tested separately; do not assume the same failure.

Current code behavior to verify:
- The extension supports `video` as a Collector media type.
- If the Collector request fails, the extension can fall back to browser download, which matches the visible symptom.
- The VPS Capture path accepts only `video.twimg.com` HTTPS media URLs for video, requires `video/mp4`, downloads server-side, then uploads the temporary file to R2.

Investigation order:
1. Capture the exact media payload sent by the extension for a failing X video without logging secrets.
2. Confirm Collector settings/token/base URL are active on the failing browser profile.
3. Inspect the HTTP status/body returned by `POST /v1/captures` before fallback.
4. Inspect VPS logs for validation, X remote-fetch, timeout, size-limit, content-type, or R2 upload failures.
5. Confirm whether a capture row and R2 object are created at all.
6. Fix the root cause and preserve local download only as a genuine failure fallback.

Do not solve this by disabling fallback or extending timeouts blindly. Do not conflate this with CLOUD-003 long-video async handling unless evidence shows timeout duration is the actual cause.

### CLOUD-002 — Finish Cloud inbound app integration
Status: `VERIFY`

Implemented on the current integration branch:
- Settings exposes Cloud enablement, API base URL, Credential Manager-backed API token, connection test, and manual sync.
- `classification_id` is carried from Capture pending records into `IngestMediaRequest`; nonexistent local IDs safely fall back to unclassified.
- Inbound batch results distinguish new assets, video additions, classification-changing duplicates, and review-pending work so the frontend refreshes only what changed.
- New inbound videos trigger the normal video preparation path.
- Outbound `cloud_sync_queue` remains separate and unchanged.

Remaining verification:
- Deploy the pending-payload server change to the Japanese VPS.
- Verify real X image and video flows end-to-end from extension -> VPS/R2 -> PC library with classification preservation and immediate UI refresh.

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

After CLOUD-001/CLOUD-004/CLOUD-002 and DB issues are fixed:
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

### BUG-003 — X video drag-save shows blue selection highlight on PC
Status: `TODO`

Observed behavior:
- On PC, dragging the pointer over an X video to invoke the extension save interaction can produce a blue browser selection highlight.
- The video save itself succeeds; this is a visual/input-side artifact only.

Direction:
- Prevent native text/media selection only for the active drag/gesture surface used by the extension.
- Prefer scoped `user-select: none`, selection clearing, or pointer-event handling during the gesture rather than disabling browser selection globally.
- Do not change the working video save path.

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

### EXT-003 — Group media saved from the same X post
Status: `TODO`

Goal:
- When several images or media items are saved from one X post, preserve the fact that they belonged to the same post and make them easy to view together later.

Direction:
- Reuse the shared source post URL as the primary grouping identity where safe.
- Preserve per-asset records and normal classifications; grouping should not duplicate media.
- Provide an easy "same post" view or sibling strip from the asset viewer/inspector.
- Consider mixed image/video posts as the same group.
- Avoid coupling this to an X-only storage schema if a generic source-group concept can serve future importers.

### EXT-004 — Adaptive secondary donut ordering and hidden tags
Status: `TODO`

Goal:
- Make frequently collected tags faster to reach in the second donut while keeping low-use tags out of the way.

Direction:
- Rank secondary tags using actual collection/use frequency.
- Place high-frequency tags toward the visually central/easy-reach portion of the second donut.
- Push rarely used tags toward left/right outer positions rather than random reshuffling.
- Keep ordering stable enough that muscle memory is not destroyed by every save; use thresholds or periodic re-ranking rather than live reorder on each click.
- Add per-tag `숨기기` so hidden tags remain valid classifications but do not appear in the donut UI.
- Provide a settings/manage path to reveal hidden tags again.
- Hidden state and usage ranking should be presentation metadata only; do not alter the underlying classification tree or saved asset memberships.

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

1. CLOUD-002 production rollout / end-to-end verification
2. BUG-001 / BUG-002 DB and migration investigation
3. VERIFY-001 real X → VPS → PC verification
4. P1 UX pass: flashing, video controls, BUG-003 video drag selection artifact, navigation, loading/errors, selection clearing, cover crop, sidebar cleanup, scrollbar
5. CATALOG-001 / CATALOG-002 Heliotrope-based catalog work
6. CLOUD-UI-001 cloud status/problem surface
7. EXT-001 / EXT-002 extension settings and Cloud-first save behavior
8. EXT-003 / EXT-004 same-post grouping and adaptive/hidden donut tags
9. PERF-001 / PERF-002 cache optimization and view-state preservation
10. CLOUD-003 long-video async handling if real-world use requires it
11. NOTE-001 / STATS-001 / IDEA-001 / UI-008
12. Long-term collection presentation work
