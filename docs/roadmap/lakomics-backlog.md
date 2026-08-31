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

### CLOUD-005 — PC-independent saved-X-media snapshot
Status: `IN PROGRESS`

Goal:
- Let Android show already-saved X media badges without a live PC connection.
- Keep the PC library as the source of truth while publishing a bounded saved-media snapshot to the Japanese VPS.

Direction:
- Reuse the existing `<tweet_id>:<media_index>` saved-media identity; do not introduce a second identity scheme.
- Publish saved X media alongside the existing Cloud/Classification snapshot lifecycle rather than creating another tight polling loop.
- Android + Collector should read the VPS snapshot first, then a matching-base-url cloud cache, and merge bounded `recentBrowserSaves` so a just-saved item is marked immediately.
- Desktop must continue to prefer the direct/local PC saved-media index and must not become VPS-dependent.
- Keep PC and cloud saved-index caches separate so endpoints cannot contaminate each other.
- After this is verified PC-off on Android, reevaluate whether mobile still needs Connection Key / Remote Lakomics controls.

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

### CATALOG-001 — Move fragile k-hentai transport behind the Japanese VPS
Status: `IN PROGRESS`

Current issue:
- Online catalog transport depends on direct PC access to `k-hentai.org`, historically through a hidden WebView2 and gallery resolver paths that are unreliable on Korean networks.

Current Phase 1 direction:
- Keep the existing VCK/k-hentai catalog DB and work IDs intact.
- Route only the fragile k-hentai search-page and gallery HTML transport through a narrow authenticated API on the Japanese VPS.
- Keep search/detail/bookmarks/progress local where possible.
- Do not introduce a schema migration only for this transport change.
- Keep direct signed image/CDN page loading on the PC unless evidence shows it also needs proxying.

Current checkpoint:
- Feature work is isolated on the catalog worktree/branch and has focused server/Rust tests.
- Remaining work is VPS deployment, real catalog-update/gallery-open verification, then merge only after successful real use.

Heliotrope:
- Do not force Heliotrope into Phase 1 because Hitomi IDs and VCK/k-hentai IDs are different.
- Treat Heliotrope as a later provider rather than a drop-in replacement.

### CATALOG-003 — Add Japanese-language works to the online catalog
Status: `TODO`

Goal:
- Extend the current Korean-only k-hentai/VCK catalog ingestion so Japanese-language originals can also be discovered and updated in Lakomics.

Direction:
- Preserve the current Korean query behavior while adding `language:japanese` as an additional supported catalog source/filter.
- Prefer an explicit language filter such as Korean / Japanese / both rather than silently changing the meaning of the existing Korean catalog view.
- Keep the same VPS transport boundary; the PC should request Lakomics VPS catalog endpoints, and the VPS should translate those requests to the appropriate k-hentai language query.
- Define how Korean translations and Japanese originals of the same underlying work are presented before adding any automatic grouping or deduplication.
- Do not require Heliotrope for this feature; implement it against the existing k-hentai/VCK path first if practical.

### CATALOG-002 — Heliotrope/VCK coexistence and migration strategy
Status: `TODO`

- Do not discard existing imported VCK catalog data immediately.
- Reuse the current local catalog schema where practical.
- Add provider/source identity such as `legacy_vck` and `heliotrope`.
- Define duplicate identity and migration behavior.
- Keep bookmarks and reading progress in Lakomics-controlled storage.
- Separate catalog metadata provider from gallery/page resolver.
- Prefer provider-namespaced identity such as `(provider, provider_work_id)` if/when Heliotrope becomes a second provider.

### CLOUD-UI-001 — Cloud status, transport diagnostics, and problem surface
Status: `TODO`

Settings should expose at least:
- Cloud enabled/disabled state
- API connection state
- last inbound run
- last success
- last error
- processed summary
- manual `지금 동기화` action if useful
- active classification source (`app`, `remote`, `cloud`, cache, or local fallback)
- classification count and an explicit fallback reason when the extension is using the six-item local tree
- saved-media index source/count
- last classification/saved-media publish time where available
- whether required credentials are configured, without ever revealing credential values

Debugging goal:
- A missing Connection Key, stale Remote Lakomics endpoint, Collector failure, or local fallback should be visible from normal settings/status UI without opening DevTools.
- Do not silently make a six-item local fallback look like a healthy PC-linked classification tree.

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
After CLOUD-005 is verified, hide or remove mobile-only direct-PC controls that are no longer required while preserving desktop compatibility.

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

### OPS-001 — Backup, migration, and settings portability
Status: `TODO`

Goal:
- Make moving Lakomics to another PC predictable without rediscovering which state lives in Git, the library, browser storage, Credential Manager, or machine-level services.

Direction:
- Document and, where safe, automate source checkout/worktree restoration, library/assets transfer, manga originals, browser-extension settings export/import, and required toolchain setup.
- Keep secrets out of Git; provide explicit restoration checks for Cloud API credentials and Tailscale rather than copying raw secret stores blindly.
- Add a post-migration health checklist for PC API, classification count/source, Cloud Capture, Collector, catalog transport, and saved-media index.
- Prefer portable export/import for extension settings so reinstalling an unpacked extension does not silently fall back to the six-item local tree.

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
- `OPS-xxx`: backup/migration/operational portability
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

1. CLOUD-005 saved-X-media VPS snapshot and PC-off Android badge verification
2. CATALOG-001 Phase 1 Japanese-VPS deployment, real catalog update/gallery verification, then merge if clean
3. CLOUD-UI-001 connection/transport diagnostics so fallback, endpoint, count, and credential state are visible without DevTools
4. EXT-001 / EXT-002 extension settings cleanup and automatic Cloud/direct-PC save policy
5. UI-004 + PERF-002 flashing reduction and view-state preservation
6. PERF-001 10,000+ asset cache/media optimization
7. EXT-003 same-X-post media grouping
8. EXT-004 adaptive/hidden secondary donut tags
9. BUG-001 and remaining P1 usability work as reproduced/prioritized
10. OPS-001 backup/migration/settings portability
11. CLOUD-003 long-video async handling if real-world use requires it
12. CATALOG-003 Japanese-language catalog ingestion/filter after CATALOG-001 transport is stable
13. CATALOG-002 Heliotrope as a provider-namespaced second catalog source after Phase 1 is stable
14. NOTE-001 / STATS-001 / IDEA-001 / UI-008
15. Long-term collection presentation / shelf work

This order is a working execution preference, not a dependency graph. Reorder when a real regression or production verification failure becomes more urgent.