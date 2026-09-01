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

Verification:
- Real X image and video flows have been verified end-to-end from the extension through VPS/R2 into the PC Lakomics library.
- Selected classification membership is preserved and imported assets appear in the running UI without requiring an app restart.
- CLOUD-002 inbound integration is complete.

### CLOUD-005 — PC-independent saved-X-media snapshot
Status: `DONE`

Resolution / verified behavior:
- The PC publishes a bounded saved-X-media snapshot to the Japanese VPS alongside the existing Cloud/Classification snapshot lifecycle (`PUT /v1/saved-x-media`), sharing the `<tweet_id>:<media_index>` identity instead of a second scheme.
- Android/Collector reads the VPS snapshot first, falls back to a matching-base-url cloud cache, and merges bounded `recentBrowserSaves` so a just-saved item is marked immediately; the desktop saved-media index stays local and VPS-independent.
- PC-off behavior was exercised for real: Android retained and used the cloud saved-X snapshot while the PC API was down, and captures saved during that window synced into the Lakomics library when the PC came back.
- A video imported through that flow was initially blocked only by the video preparation bug (BUG-004) and reached `ready` after that fix.

### BUG-001 — Collection view shows an error toast on entry
Status: `DONE`

Observed behavior:
- Collection view itself opens.
- An error toast appears immediately after entering the collection viewer.

Action:
- Reproduce and identify the failing collection/work detail path.
- Check DB/schema/migration state before changing UI behavior.

### BUG-002 — Manga tab reports `망가 목록을 불러오지 못했습니다`
Status: `DONE`

Resolution:
- Manga scanning no longer aborts when an unsupported AVIF thumbnail cannot be decoded.
- Thumbnail generation is best-effort/fallback-safe so one unsupported thumbnail does not fail the entire manga list scan.

### BUG-004 — Video preview preparation reliability
Status: `DONE`

Resolution:
- Fixed the development StrictMode lifecycle bug that left the video preparation worker permanently inactive and videos stuck in `pending`.
- Fixed the failed-video `다시 시도` button so pointer events no longer leak into tile drag/selection handling.
- Fixed poster generation for ultra-short clips by choosing a duration-safe poster seek instead of always seeking to 500 ms.
- Existing failed ultra-short videos were retried through the normal application UI and successfully prepared.
- Real stuck `pending` video transitioned to `ready`; no production DB surgery was required.

### BUG-005 — Manga collection viewer shows an unexpected error tooltip/toast on entry
Status: `TODO`

Observed behavior:
- Opening a manga Collection succeeds.
- Entering the manga viewer shows an unexpected error tooltip/toast.
- The viewer itself can still open, so the failing operation may be ancillary rather than a fatal viewer failure.

Investigation:
- Reproduce after the current BUG-001 MangaDex-binding guard fix and confirm whether this is the same failure path or a distinct viewer bug.
- Inspect viewer initialization, volume-cover loading, artwork lookup, and provider-binding-dependent calls.
- Preserve normal local Collection/viewer usability when optional provider work fails.
- Do not merely suppress the error presentation before identifying the failing operation.

### VERIFY-001 — X → VPS → PC end-to-end check
Status: `TODO`

Verification:
- Real image and video saves from X were verified through VPS/R2 into the PC library.
- Pending capture consumption, selected-classification preservation, and live UI refresh were confirmed in actual use.
- End-to-end Cloud inbound verification is complete.

## P1 — visible UX / usability

### UI-004 — Remove rapid flashing during view transitions and previews
Status: `TODO`

Recent progress:
- Classification/folder transitions no longer leak stale virtual rows from previously visited scopes.
- The giant blank virtual-space gap and cross-folder asset leakage found during the gallery transition work were fixed in `9c19606`, `c0f7f6c`, and `f7715ad`.
- Keep this item open for the remaining tab-switching and image-preview flicker.

Remaining direction:
- Keep the previous view visible until replacement content is ready.
- Avoid replacing the whole view with a blank/skeleton frame when stale content can remain visible.
- Decode/preload preview images before swapping them in.
- Avoid unnecessary React unmount/remount cycles.
- Keep layout dimensions stable during loading.
- If a transition is needed, use a very short subtle cross-fade rather than full fade-out/fade-in.

### UI-007 — Video viewer controls
Status: `DONE`

Resolution:
- Implemented in `8486552` (`fix: stabilize viewer transitions and navigation`): absolute overlay controls that do not reflow the video, a timeline that consumes the full control width, idle auto-hide (`CONTROLS_IDLE_MS`) while playing, immediate restore on pointer movement, and retained visibility while paused, scrubbing, interacting with volume, or focusing controls.
- Fullscreen and AssetViewer left/right navigation and shortcuts remain working.
- Focused VideoPlayer tests pass; behavior re-verified in real use on the running Tauri app.

### BUG-003 — X video drag-save shows blue selection highlight on PC
Status: `TODO`

Observed behavior:
- On PC, dragging the pointer over an X video to invoke the extension save interaction can produce a blue browser selection highlight.
- The video save itself succeeds; this is a visual/input-side artifact only.

Direction:
- Prevent native text/media selection only for the active drag/gesture surface used by the extension.
- Prefer scoped `user-select: none`, selection clearing, or pointer-event handling during the gesture rather than disabling browser selection globally.
- Do not change the working video save path.

### BUG-006 — Sidebar asset counts stay stale after drag-and-drop move
Status: `DONE`

Resolution:
- `App.tsx`'s `performInternalDrop` refreshed the gallery after a successful classification drop but did not refresh the sidebar membership/count state.
- Classification counts come from the authoritative `gateway.listClassifications()` response and count direct normal-asset membership rather than recursive descendants.
- Classification drag/drop is a move: existing classification memberships are replaced by the destination classification. Album drops remain add-only.
- Successful drops now call `refreshMembershipCounts()` once in addition to the existing gallery refresh, updating source/destination counts without manual counter patches or refresh storms.
- Commit: `cd6077a` (`fix: refresh sidebar counts after asset moves`).
- Verified in real use.

### BUG-007 — Asset/library mutations reset the current gallery scroll position
Status: `DONE`

Resolution:
- Same-scope asset mutations were already preserving gallery scroll because `refreshVersion` / `retryVersion` do not change the logical `queryKey` / `scopeKey`.
- The actual bug was `ClassificationSidebar.remove()`: deleting any sidebar folder unconditionally navigated to its parent even when the deleted folder was unrelated to the current view.
- That unintended navigation changed scope and therefore triggered the gallery's legitimate scope-reset behavior.
- Sidebar deletion now navigates only when the deleted classification is the active view (or active root); unrelated deletions keep the current view and viewport intact.
- Genuine scope changes and sort/filter changes still reset to the top as intended.
- Commit: `fe75db6` (`fix: preserve gallery position across asset mutations`).
- Verified in real use.

### NAV-001 — Unify back-navigation behavior
Status: `DONE`

Resolution:
- Architecture from `8486552` is in place and runtime-verified: `BackNavigationProvider` with priority-ordered handlers, shared `Dialog` redirecting Escape through `requestBack` at dialog priority (100), `useDesktopInteractions` routing Mouse Button 4 through the same path, and the App view history fallback.
- Priority holds: topmost overlay/Dialog closes first, then nested detail, then previous app view; root is a safe no-op.
- Remaining local Escape handlers (gallery selection clear, sidebar inline editor cancel, CollectionOverlay/Settings/SimilarityReview exits) are intentionally local to their surfaces and guard against overlapping layers; they do not bypass or conflict with the shared chain.
- Focused BackNavigation / useDesktopInteractions / App suites pass; behavior re-verified in real use on the running Tauri app.

### UX-009 — Loading, error, retry, and tooltip consistency
Status: `DONE`

Resolution:
- Audited the high-use surfaces (AssetBrowser/AssetViewer, collection views, manga/catalog views, settings/cloud surfaces) against the shared Button/Dialog/Toast/EmptyState/Skeleton/StableImage components.
- Already satisfied by accumulated work: blocking Skeleton only on initial load with no previous content; last-valid content preserved during same-scope refreshes and pagination; recoverable next/previous page failures show a Toast plus retry while keeping content; fatal failures show EmptyState with retry; catalog errors go through `commandErrorMessage` without exposing secrets.
- All icon-only buttons carry `aria-label`s; icon-only buttons without labels were audited and none remain in high-use surfaces.
- Request-scoped guards in the online catalog prevent stale responses and duplicate retries (buttons disabled while in-flight).
- No remaining inconsistencies found in the prioritized surfaces; focused and full suites pass, and behavior was re-verified in real use on the running Tauri app.

### UI-006 — Easier asset selection clearing
Status: `DONE`

Current behavior:
- Selection is mainly cleared through the bottom X control.

Improve with:
- Clicking empty gallery/sidebar space clears selection where it does not conflict with navigation.
- Consider right-click to clear selection only if it does not conflict with current/future context menus.
- Keep the explicit X button.

### UI-005 — Collection cover aspect ratio / crop handling
Status: `DONE`

Problem:
- User-selected collection covers are slightly cropped.

Direction:
- Reconsider fixed aspect ratios and unconditional `object-fit: cover`.
- Preserve book/manga covers and other source artwork more faithfully.
- Prefer `contain` or reduced crop where appropriate.
- Keep the original user-selected artwork untouched; change presentation only.
- Reuse consistent cover presentation rules across list/detail/showcase views.

### UI-001 — Move Similarity Review to the management section
Status: `DONE`

- Move `유사 검토` out of the main quick-view group.
- Place it in the lower management area near Trash/Settings.
- Preserve count and routing behavior.

### UI-003 — Use a standard scrollbar in the asset repository
Status: `DONE`

Observed behavior:
- The Asset Repository currently shows the legacy Codex-style/custom scrollbar and the native/default scrollbar at the same time.

Direction:
- Remove the special/custom scrollbar styling for the asset repository.
- Ensure the repository has one intended scroll owner rather than nested overflow surfaces producing duplicate scrollbars.
- Use a normal OS/browser-like scrollbar.
- Do not change virtualization or scroll behavior.

### BUG-008 — Blue page-edge highlight in catalog double-page viewer
Status: `TODO`

Observed behavior:
- In online catalog double-page mode, an intermittent bright blue vertical line appears near the center of the viewer.
- Screenshot evidence shows the line follows the right edge and lower rounded corner of the left rendered page rather than a fixed center divider.
- This resembles a native focus/outline/selection artifact more than intentional viewer styling.

Direction:
- Inspect page image/wrapper focus state, dialog focus management, edge navigation overlays, `:focus` / `:focus-visible`, outline, box-shadow, selection, and drag behavior.
- Compare against the read-only VCK reference at `C:\chatgpt\reference\VCK-0.1.0-win-x64`, whose double-page layout does not intentionally draw this blue edge.
- Fix only the affected viewer scope; do not remove keyboard focus indicators globally.

## P2 — architecture / larger feature work

### CATALOG-001 — Move fragile k-hentai transport behind the Japanese VPS
Status: `DONE`

Current issue:
- Online catalog transport depends on direct PC access to `k-hentai.org`, historically through a hidden WebView2 and gallery resolver paths that are unreliable on Korean networks.

Current Phase 1 direction:
- Keep the existing VCK/k-hentai catalog DB and work IDs intact.
- Route only the fragile k-hentai search-page and gallery HTML transport through a narrow authenticated API on the Japanese VPS.
- Keep search/detail/bookmarks/progress local where possible.
- Do not introduce a schema migration only for this transport change.
- Keep direct signed image/CDN page loading on the PC unless evidence shows it also needs proxying.

Current checkpoint:
- PC catalog update traffic now uses the authenticated Japanese VPS API instead of sending the upstream k-hentai `/ajax/search` path directly to the VPS.
- `/v1/catalog/search-page(?cursor=N)` is implemented on the VPS boundary and maps internally to the existing Korean k-hentai search query.
- Upstream HTTP/network failures are normalized so transport failures return meaningful 502 behavior instead of raw FastAPI 500/NameError failures.
- Server and Rust regression tests cover the VPS route contract, cursor behavior, network normalization, and retries.
- The corrected server implementation has already been deployed to the Japanese VPS; `/health` returned 200 and the catalog endpoint returned the expected 401 when called without authentication.
- The catalog implementation has now been integrated into main.

Verification:
- Real application use has been verified after integration; the Japanese VPS catalog transport is working in normal use.
- CATALOG-001 Phase 1 is complete.

Heliotrope:
- Do not force Heliotrope into Phase 1 because Hitomi IDs and VCK/k-hentai IDs are different.
- Treat Heliotrope as a later provider rather than a drop-in replacement.

### CATALOG-003 — Add Japanese-language works to the online catalog
Status: `TODO`

Prerequisite:
- CATALOG-001 is DONE; Japanese-language ingestion can build on the existing verified VPS transport boundary.

Goal:
- Extend the current Korean-only k-hentai/VCK catalog ingestion so Japanese-language originals can also be discovered and updated in Lakomics.

Direction:
- Preserve the current Korean query behavior while adding `language:japanese` as an additional supported catalog source/filter.
- Prefer an explicit language filter such as Korean / Japanese / both rather than silently changing the meaning of the existing Korean catalog view.
- Keep the same VPS transport boundary; the PC should request Lakomics VPS catalog endpoints, and the VPS should translate those requests to the appropriate k-hentai language query.
- Define how Korean translations and Japanese originals of the same underlying work are presented before adding any automatic grouping or deduplication.
- Do not require Heliotrope for this feature; implement it against the existing k-hentai/VCK path first if practical.

### CATALOG-004 — Advanced VCK-style catalog search syntax
Status: `TODO`

Goal:
- Upgrade the current simple title / single `namespace:value` catalog search into a composable query language based on useful VCK behavior.

Initial syntax target:
- quoted values such as `artist:"two words"`
- namespace filters and aliases such as `artist:`, `series:`, `character:`, `language:`
- explicit work lookup with `id:12345` and compatible bare-id lookup if useful
- page-count comparisons such as `page>20`, `page<=100`
- negation such as `-female:tag`
- grouping and boolean operators such as `(artist:a or artist:b) -female:c`
- implicit AND for adjacent terms

Direction:
- Parse into a small AST and compile to parameterized local SQLite queries; do not concatenate raw user input into SQL.
- Preserve the existing simple-search behavior as a valid subset.
- Use `reference/VCK-0.1.0-win-x64/resources/app/dist/search/query.js` and `dialects.js` as read-only behavioral references rather than copying bundled code blindly.
- Keep provider transport concerns separate from query parsing.
- Follow-up candidates after the core grammar is stable: favorite tags, always-excluded tags, and contextual autocomplete counts based on the current query.

### UI-009 — VCK-inspired manga viewer parity improvements
Status: `TODO`

Goal:
- Expand the current lightweight `PageViewer` using proven reader behaviors from VCK while keeping Lakomics' own React/Tauri architecture.

Candidate scope:
- left-to-right / right-to-left reading direction
- explicit cover pairing behavior for double-page mode
- thumbnail/page overview with direct page jump
- real fullscreen mode and convenient keyboard shortcuts
- paged versus scroll reading modes, with vertical/horizontal scroll where practical
- configurable viewer margins / page spacing
- remember reader preferences between sessions, with separate desktop/mobile profiles only if actually useful
- preserve current reading progress, preload behavior, privacy mode, and error handling

Reference / constraints:
- Treat `C:\chatgpt\reference\VCK-0.1.0-win-x64` as read-only reference material.
- Do not port Electron-specific hidden-window/network code into the viewer.
- Resolve BUG-005's blue page-edge artifact as part of or before this pass so new viewer controls are built on a clean base.

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
Status: `DONE`

Implemented in main:
- Settings expose a `연결 · 동기화 상태` surface: Cloud (credential/endpoint/last failure), PC direct (connection key/Remote/last failure), active classification source with count and explicit fallback reason, saved-media index source/key count, and the effective save mode.
- A six-item local fallback renders as `로컬 기본 분류 · PC/Cloud 분류를 불러오지 못함 · N개 … 폴백` with degraded styling instead of looking healthy.
- Collector/provider failure codes are surfaced concisely (`자격 증명 없음`, `마지막 실패 …`) without exposing tokens, URLs, or headers.
- Diagnostics state is backed by regression tests (`settings:get` classification/saved-media/last-collector-failure) and passed manual device E2E verification.

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

### CLOUD-006 — Full library cloud replication for mobile
Status: `TODO`

Goal:
- Make the full PC Lakomics asset library browsable from Lakomics Mobile while the PC is offline.
- Keep the PC library authoritative; the Japanese VPS/R2 copy is a read-oriented replica that can be rebuilt from the PC.
- The current library is only about 7–8 GB, so the first implementation may replicate originals directly instead of making a thumbnail-only architecture a prerequisite.

Initial scope:
- Backfill all existing local assets to R2 and register their server-side asset records.
- Reuse the existing outbound `cloud_sync_queue` and upload contracts where practical instead of creating a second independent uploader pipeline.
- Make the backfill idempotent: detect already-registered asset IDs/object keys and never upload the same asset again merely because a run was restarted.
- Persist enough mobile metadata to browse and inspect assets without the PC: stable asset ID, media kind/content type, size, collected/source timestamps, source/provenance fields that are already part of the library, and classification memberships.
- Publish asset ↔ classification relationships so selecting a real classification on mobile returns the matching full-library assets rather than only Cloud Capture inbox history.
- Make the initial backfill resumable after app restart, network interruption, or partial failure; expose queued/completed/failed counts and retry failed work without starting over.
- After backfill, enqueue new assets automatically and define narrow incremental updates for classification changes, metadata changes, and deletions.
- Add paginated/read-only mobile asset endpoints and short-lived media download tickets rather than exposing R2 credentials or the Cloud API token to the public mobile page.
- Reuse the current extension bridge/security boundary for the GitHub Pages mobile client until a dedicated mobile app/session model replaces it.

Consistency / deletion rules:
- PC state wins on conflicts in the first phase; mobile editing/write-back is out of scope.
- Define tombstone versus immediate R2 deletion before propagating local deletions, so a transient sync mistake cannot silently destroy the only remote copy.
- Capture Inbox rows are transport history, not the canonical mobile library. Once an item is part of the PC library, mobile browsing should use the replicated asset/library model.

Verification:
- Compare local and server asset counts after the initial backfill and spot-check representative image/video hashes or sizes.
- Confirm a backfill can be interrupted and resumed without duplicate DB rows or duplicate R2 objects.
- With the PC off, browse several classifications on the Galaxy Tab mobile view, open real images, and play at least one replicated video.
- Add one new PC asset and change one asset's classification, then verify both changes appear through incremental sync without another full backfill.

Follow-ups:
- Coordinate with `PERF-001` for thumbnail/preview generation, caching, WebP policy, and bandwidth optimization after correctness is established.
- Coordinate with `CLOUD-UI-001` so backfill progress, last success, failures, and retry state are visible from normal settings UI.

### EXT-001 — Reorganize extension settings
Status: `DONE`

Reorganized in main:
- `저장 방식` (Automatic/PC direct/Cloud/Download with concise explanation), `Cloud`, `PC 직접 연결` (Lakomics 연결 + Remote), `연결 · 동기화 상태` diagnostics, `X Translate`, `모바일 도넛`, `PC · 방사형 메뉴 배치`, and a collapsed `고급 · 복구 설정` block.
- Endpoint/key controls exist in exactly one section; legacy recovery tools (connection backup, offline donut JSON, download folder) stay under Advanced.
- Stored legacy values survive hiding/renaming: legacy stored `saveMode: "app"` migrates to `auto`; the new PC-direct-only mode is the explicit `pc` value, so old saves are never reinterpreted.
- Manual device E2E verification passed on the packaged test build.

### EXT-002 — Cloud-first extension save policy

Status: `DONE`

Implemented in main:
- User-facing modes: `자동` (default) / `PC 직접 연결만` (`pc`) / `Cloud만` (`cloud`) / `브라우저 Download만` (`download`).
- Automatic: real PC ingestion attempt first (with the existing 3-attempt tunnel-recovery backoff, no per-save 8s probe) → Cloud Capture on failure or when the app can't take the media type → browser/device download only when both fail.
- `pc` mode fails with an explicit direct error instead of silently using Cloud; `cloud` mode works with the PC off and keeps the existing device-download failure path.
- Legacy stored `saveMode: "app"` migrates to `auto`; regression tests cover mode routing, no duplicate saves, cloud-without-PC, and device fallback.
- Manual device E2E verification passed on the packaged test build.

### EXT-003 — Group media saved from the same X post
Status: `TODO`

Goal:
- When several images or media items are saved from one X post, preserve the fact that they belonged to the same post and make them easy to view together later.
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

1. UI-004 + PERF-002 remaining tab/preview flashing reduction and broader view-state preservation
2. BUG-005 manga collection-viewer entry toast investigation
3. BUG-003 X video drag-save blue native-selection artifact
4. BUG-008 + UI-009 catalog/manga viewer cleanup and VCK-inspired reader improvements
5. CLOUD-006 full-library cloud replication/backfill for Lakomics Mobile, then incremental metadata/classification sync
6. PERF-001 10,000+ asset cache/media optimization, including mobile thumbnail/preview optimization after CLOUD-006 correctness
7. EXT-003 same-X-post media grouping
8. EXT-004 adaptive/hidden secondary donut tags
9. OPS-001 backup/migration/settings portability
10. CLOUD-003 long-video async handling if real-world use requires it
11. CATALOG-003 Japanese-language catalog ingestion/filter on the verified CATALOG-001 transport
12. CATALOG-004 advanced VCK-style catalog search syntax
13. CATALOG-002 Heliotrope as a provider-namespaced second catalog source after the current catalog path is stable
14. NOTE-001 / STATS-001 / IDEA-001 / UI-008
15. Long-term collection presentation / shelf work

This order is a working execution preference, not a dependency graph. Reorder when a real regression or production verification failure becomes more urgent.
