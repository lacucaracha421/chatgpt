# Lakomics Backlog

Living source of truth for **active** Lakomics work only. Completed and superseded records live in [lakomics-completed.md](lakomics-completed.md).

Amended 2026-10-22 at `2e8db984`: current member-run/favourite-character/picker source scope reconciled; three commit-backed DONE entries transferred with old anchors retained. The 2026-10-18 reconciliation below remains dated evidence. No new runtime/device/deployment check.

Reconciled 2026-10-18 against `main` at `9bb8e8ad`, using commit bodies since 2026-10-13, current source and the controller's dated delivery/acceptance record; no new network, runtime, device or production access. Finished slices are in the [2026-10-18 checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-18--home-cards-tablet-structure-and-performance). Unmentioned later device/native checks count as passed under the user's 2026-10-12 rule; this is recorded acceptance, not a new observation. Older unresolved audit claims keep their dated unverified labels; external references were not revalidated online.

## Current priority

Updated 2026-10-18 against `main` at `9bb8e8ad`. PC remains canonical for design; tablet follows in the same round. Earlier orders are superseded; finished work is in the [2026-10-18 checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-18--home-cards-tablet-structure-and-performance).

1. **`PERF-20261018`** — only item 1 remains: measure PC/tablet pack opening, reveal and album performance before optimizing (see [section](#perf-20261018)).
2. **`PERF-ALL-001`** — startup character DB holds reported resolved by the user (2026-10-18); retain other measured performance scenarios. Manga catalog UI freeze fixes are delivered (see [section](#perf-all-001--whole-app-benchmark-and-optimization-pass)).
3. **`CHAR-CLAUDE-001`** — member runs and refined policy are delivered (`d6c5f752`, `0d955f1b`, `10d383a1`, `57e1eb1a`); tablet review/feed retirement remains low priority. See the [current scope](#char-claude-001) and [source checkpoint](lakomics-completed.md#source-checkpoint--2026-10-22).
4. **`COLLECTOR-MENU-SCOPE-001`** — retain unconfirmed site-by-site menu gaps and the later save-X-post/link/page idea; selection chip and broader menu support shipped in 3.5.41.
5. **`CLOUD-POST-001` step 3 with `SEC-TOKEN-001`** — keep the calendar/wishlist fallback; AV pick retirement is source-complete.
6. **`COLLECTOR-IMGTEXT-001`** — other hotlink-protected hosts; pixiv is delivered.
7. **`UI-REVIEW-20261011`** — user decisions only: P14c copy rewrites and catalog detail layout.
8. **Small residual debt** — `TABLET-PARITY-001` retained parity/diagnostic limits and `HOME-OPT-001` test reliability.

`LINUX-DESKTOP-001` stays (the user still uses Linux); other low-priority and held items keep their recorded order.

## Waiting on the user (device/native checks)

User rule (2026-10-12): a device/native check the user does not mention afterwards counts as passed. The checks listed here on 2026-10-12 (AV interactions, 더보기/휴지통, tablet Collections header and live Kakao, tablet similarity apply, Windows natural-language search, tablet content search after nightly captioning, character candidate-group output) are therefore treated as accepted; reopen one only when the user reports a problem.

- **Laptop update:** update Lakomics before resuming Collection sync. Older builds reject the new `deletedPeople` feed entity after 17 director-only people were deleted on the server (`9bb8e8ad`; controller record 2026-10-18). Laptop update/sync is not confirmed.

<a id="fav-char-001"></a>
## FAV-CHAR-001 — Favourite characters in Collections (2026-10-22)

Status: `PARTIAL` — user request 2026-10-22; user picked card A + detail A. Server module deployed 2026-10-22 (uncommitted at deploy); PC release build opens the view and the add picker (271 characters listed); grid/detail feedback round 1 (quiet whole-grid fade, no profile scrollbar, no count on the 캐릭터 button) applied; tablet 0.9.139 installed 2026-10-22 (work covers now load; works row wraps instead of scrolling), device check pending. A curated "캐릭터" view in Collections (beside 쇼케이스) that references existing asset characters; it is not a new Collection type and does not duplicate character records.

- Grid of user-chosen representative images in a user-set order; opening one shows a profile (birthday, height, appearing works and similar basics), links to the related Collection works, and the character's assets gathered automatically from the asset character folders.
- The initial Asset-character-only scope is superseded by shipped FAV-CHAR-002 manual entries/covers (`c8a8dc63`, `d6d40389`). Keep this item PARTIAL for the explicitly pending favourite-character feedback; source delivery does not clear that check.
- **FAV-CHAR-002 (source delivered 2026-10-22; feedback remains under FAV-CHAR-001):** add characters that are not in 에셋 by name (manual entries). They show a name card until the user drops or pastes an image on the PC, which is imported as a cover-only image (excluded from Asset lists/counts/search/Home; manual covers imported before this are marked on favourite reads) and becomes the cover; 에셋 캐릭터와 연결 later turns the entry into a normal one. Server deployed 2026-10-22; PC build with hero open and Ctrl+V paste running; tablet 0.9.140 installed (name cards, 이름으로 추가, link, hero). Cover-only exclusion (2026-10-22): PC build running and server deployed; a pasted image that already exists as an asset stays a normal asset.
- PC first, tablet in the same round. HTML mockup first (`docs/prototypes/fav-characters-20261022/`).


<a id="perf-20261018"></a>
## PERF-20261018 — Card gacha performance measurement (2026-10-18)

Status: `PARTIAL` — original item 1 is the only remainder. No PC/tablet pack-opening, reveal or album frame-time/long-task measurement is recorded. Measure those scenarios before optimizing; earlier server pack-query timing is not this measurement. Items 2–5 are in the [2026-10-18 checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-18--home-cards-tablet-structure-and-performance); tablet smoothness has no later reported problem and counts as accepted under the user's rule.

1. Card gacha (pack opening, reveal, album) performance on PC and tablet — measure frame times and long tasks first.


<a id="char-claude-001"></a>
## CHAR-CLAUDE-001 — Series member identification and tablet review retirement (2026-10-12)

Status: `PARTIAL` — slices 1 and 1b are committed in `310b37b4`, slice 2 in `38a3ff8d` (live since 2026-10-13); delivered decisions and experiment evidence are in the [2026-10-13 checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-13--claude-character-decisions-arca-picker-tablet-batches-and-motion). PC automatic judgments use Haiku yes → accept, otherwise Sonnet no → reject / yes with confidence ≥ 0.9 → accept; the rest stays for the user. Automatic judgments are never learning examples or user judgments, and manual decisions take precedence. References are prompt-cached and the character's own references are skipped. Below 12% image height an accept stays for the user; full images are retained because the crop trial worsened errors.

- **Slice 3 — delivered member runs:** `d6c5f752`, refined by `0d955f1b`, `10d383a1`, `57e1eb1a`. Eligible series images include unassigned images and those with exactly one accepted member when other members remain undecided; pending tagger/Claude review is excluded and manual decisions win. S36 references are prepared on demand. For 2–5 members, Sonnet can auto-accept at ≥0.9 and recommends below; 6+ uses Haiku alone for recommendations. “None” is not a reliable auto-filing result. Backlog runs show counts/estimate and an editable spending cap (initially $45); the initial ongoing mode expires after 2026-10-26, with a separate monthly-budget mode available afterwards. The recorded 2,244-image run finished at $12.39 with 207 automatic acceptances and recommendations on 696 images (`57e1eb1a`); the earlier 2,831-image estimate is not the current queue.
- **Related cleanup (low):** retire the tablet 캐릭터 확인 screen and review-feed publication when the tablet is next touched; character recognition remains PC-only. A server deployment is required for retirement.


<a id="collector-menu-scope-001"></a>
## COLLECTOR-MENU-SCOPE-001 — Remaining site menu coverage (2026-10-13)

Status: `PARTIAL` — 3.5.41 (`a36403e9`) added capture-phase handling, a per-site switch and the tablet selection 번역 chip. Restricted pages such as Chrome's PDF viewer have documented fallbacks; that restriction is not an unimplemented ordinary-page menu. Earlier frame/media/hold support and the delivered chip are in the [2026-10-18 checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-18--home-cards-tablet-structure-and-performance).
- **Coverage:** the [2026-10-16 code-level inventory](../../extension-list/options/context-menu-coverage.md) records blocker causes, protected native menus, frame limitations and the PDF fallback. A live site-by-site inventory was not recorded; investigate remaining reported sites without overriding intentionally native menus.
- **Later idea (user 2026-10-13):** save an X post (text + media as one item), a link or a whole page into Lakomics from the same menu. Current-frame saving still needs an image-byte upload API; existing capture accepts remote HTTPS URLs.

## UI-REVIEW-20261011 — Automated UI sweep findings

Status: `PARTIAL` — 2026-10-11 sweep of PC (release, 960×640 and maximized) and Galaxy Tab S11 (portrait and landscape) main screens with a DOM lint, reviewed by the design reviewer. Report with screenshots: https://claude.ai/artifact/GUva3DvrULedEUzmeafeCx (local copy `.tmp/ui-review/`). Sweep tool: session temp `ui-sweep/sweep.mjs` (CDP + lint + adb screencap), not in the repo.
- **Fixed and capture-verified:** tablet 0.9.66 (`d37da69f`, landscape device captures; user confirmed the work detail scrolls to the end), 0.9.67 (`0fada402`), 0.9.68 (`b9b0fb3f`), PC dev build + tablet 0.9.69 (`f17f6cf0`), PC + tablet 0.9.71 (`a73082f3`): landscape column counts, 작품 관리 and 컬렉션 편집 dialog layout, one bottom-nav marker, 44 px touch targets and 24 px tablet margin, real asset totals and formatted counts, calendar line breaks, release-card layout, notes list clear of the 새 메모 button, square catalog-detail tags, P1/P3/P5/P6/P9–P11/P13–P19 (PC rail, Home release titles, collection shelf, find input/chip, 지금 하는 중 strip, 전송 help, settings rows, focus ring, empty labels, notes cards, folder chevrons, 망가 refresh menu, Home column cap) and tablet P12/P19. Home NEW now follows the server notice read state on every device and no longer recurs daily. T15 (memo search twice, sync label) is resolved by the 0.9.73 top-bar rule (`31a9c281`: memo search moved to Find, sync status in the PC/tablet menu).
- **Tablet findings closed:** T10/T12/T13/T17/T18/T19 (`dd843b09`, `6114dad6`); T8/T11/T14 already fixed by the shared top bar (`593494ca`, `31a9c281`). Closure details are in the [2026-10-13 checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-13--claude-character-decisions-arca-picker-tablet-batches-and-motion).
- **Open — user decisions only:** P14c copy rewrites for the sync/trash status lines (user decision); catalog detail description visibility and the landscape two-column layout (design decision).

## Status legend

- `IN_PROGRESS` — active implementation lane.
- `PARTIAL` — useful implementation exists; a material current-product gap remains.
- `TODO` — executable work not yet implemented.
- `VERIFY` — implementation exists; only targeted acceptance remains.
- `MERGE CANDIDATE` — fold into another active item rather than build separately.
- `HOLD` — intentionally deferred or gated.

`DONE`, `APPLIED`, and `OBSOLETE` items are archived in [lakomics-completed.md](lakomics-completed.md) and should not be selected from this file.

## Repository-wide execution rules

- Preserve existing user data and provider bindings; prefer additive/reversible changes.
- Do not rerun the completed full Cloud Library backfill unless a separately approved recovery operation requires it.
- Do not replace `kdata.db` wholesale for catalog work.
- Keep count/pagination correctness in Rust/SQLite rather than frontend-only filtering.
- Native Android is the production mobile architecture; do not revive the browser-extension prototype as the client architecture.
- Reuse the existing Collection presentation renderer rather than creating parallel renderers.
- Before each implementation batch, re-check Git status/diff and concurrent ownership.
- Production data writes, deployments, device installation, and Git writes still require their own explicit authorization.

# Current implementation and performance

<a id="perf-all-001--whole-app-benchmark-and-optimization-pass"></a>
<a id="mobile-perf-002--first-view-thumbnail-latency"></a>
<a id="perf-20261002--optimisation-phase-measurements-and-candidates"></a>
## PERF-ALL-001 — Measured performance pass

Status: `PARTIAL` — single performance lane, including `PERF-20261002`, `MOBILE-PERF-002`, `PC-POLISH-20261002` item 5 and `HOME-OPT-001` measurements. Follow [Performance work](../agents/implementation.md#performance-work); measure the real platform before changing it.

Delivered folder/idle/startup/thumbnail-priority changes and their dated measurements are in the [archive](lakomics-completed.md#closure-checkpoint--2026-10-10--backlog-reconciliation). 0.9.30 removed the five reissued startup reads, so those cancellations are not an open task.
- **Open startup UI stalls (controller record, 2026-10-18):** long library-connection holds in `character_shadow_review.rs` / `character_incremental.rs` can still reach 4.25 s and may freeze the UI. Measure the remaining paths on current `main` before changing them; not resolved by the Home first-load or catalog fixes below, and not newly reproduced here.
- **Delivered 2026-10-18:** Home first load (`2b12d7ee`, `b48ccfb5`) and manga catalog freeze fixes (`9bb8e8ad`: changed-row membership rebuild, async manga/catalog commands, memoised cards) are in the [checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-18--home-cards-tablet-structure-and-performance). Earlier startup convoy/Home-read measurements below are historical baselines, not proof those exact delays remain today.
- **PC Windows session kit (2026-10-11):** `scripts/perf/windows-session.mjs` attaches to a release app started with `LAKOMICS_PERF=1` and `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` (stalls, long animation frames, CPU profile, process CPU/memory, scripted scroll frames); new viewer/Works/warm-Collections timing lines. First run (release from the 2026-10-11 worktree): idle 0.24 % CPU, ~400 MB private, no stalls; scripted grid scroll with the display on 120 fps (p95 8.4 ms, 0 frames > 25 ms). The earlier ~4 fps run was taken with the monitor off (presentation throttled), not a defect.
- **PC whole-experience round (2026-10-11, release, real library, display on):** tab switches home/notes 0.05–0.06 s, assets 0.14 s, collections 0.23 s, manga 0.24–0.40 s; plain folder switch 0.10 s (rare 1.4 s outlier), series 0.11–0.64 s; viewer full-res visible 0.03 s; Works open 0.17 s (first 0.43 s). Startup: Home no longer waits for the server wishlist (wishlist/calendar sources cached locally, revalidated after first paint; `457fb896`): homeFullyShown ~1.56 s → 1.38–1.45 s, process-to-home ~1.83 s → 1.63–1.70 s. Historical remaining startup cost was a library-connection convoy (~35 callers at ~570 ms, db.wait p90 ~85 ms, first cold launch max 1.1 s); fewer/later background acquisitions or one connection per read command would be the wider fix (subsequent Home/startup work shipped 2026-10-18; remaining character holds are tracked above).
- **Remaining PC measurements:** new-PC idle residue (old ~1% candidates: 60-second catalog duplicate poll, AV link and a Tokio worker; current cost unverified 2026-10-10); background Home media re-read ~1.3–2.6 s after launch and first-install preview fetch; unexplained 1.07 s first Asset-tab outlier; warm Collections cover signal/cancelled probe and the retained WAL below. First-tab preload measured Collections 425 → ~150 ms, Manga 553 → ~225 ms, Notes 358 → ~65 ms (4 launches); PC Home ~2.7–2.9 s → ~1.29 s after page start (3 launches, `2a0de337`). Series-list/S36 recomputation bottlenecks were addressed (`db50cba9`, `4d837829`); remeasure before optimizing today's review recommendation (~0.56 s old probe) or manga data (~0.15 s).
- **Tablet whole-experience round (2026-10-10/11, Galaxy Tab S11, charging, real library; tablet 0.9.57 → 0.9.65):**
  - Measured: startup → Home ready 0.82–0.92 s, viewport images 1.03–1.10 s, splash end 1.27–1.34 s; tab first visit assets 0.14–0.18 s, collections 0.28–0.31 s, notes 0.07 s, catalog 0.69–0.81 s before the 0.9.65 fix (now 0.025 s); repeat visits ≤ 0.12 s; Collection work open 0.30 s → 0.11–0.13 s after conditional detail reads; release calendar 0.28–0.32 s; uncached original tap→displayed 1.07–1.14 s (download-bound; cached 0.12 s, prefetched neighbour ~0.01 s); scroll jank 0–0.4 %; idle draws 0 frames.
  - Fixed and device-verified: measurement kit refresh (screen/tab timings, session HTTP counters, route names, `LakomicsPerf` DEBUG-only WebView remote debugging); renderer main thread blocked by synchronous bridge work (`prepareThumbnail` + `CONNECTION_LOCK`, 31 long tasks / 5.6 s per 20 flings → 0) and a per-render `perfEnabled()` bridge call; blank viewport during extreme momentum; conditional reads for work/person detail (server deployed 2026-10-11, rollback `/home/linuxuser/lakomics-cond-20261010/rollback`) and `home.upcoming` (6 → 1 request); catalog first-12-cover prewarm.
  - Tablet 0.9.63 (server deployed, rollback `/home/linuxuser/lakomics-avnames-20261011/rollback`): the 12.5 MB per session was the Collections authority baseline read by `personNameCache` only to resolve non-Hangul AV names; the server now carries `avPeopleNames` in list/detail items and the baseline read is gone (session JSON ~1.1 MB); the provider-binding baseline read moved to the 작품 관리 menu with a per-cursor cache; route bucket split, placeholder tile aspect and More sheet timing fixed. Tablet 0.9.65 (`14ce4b17`): Android WebView never granted a plain `requestIdleCallback` on a still page, so the area/catalog prewarm never ran; both now pass `{timeout: 1000}` and Home placeholders without an expected cover no longer block it (device: catalog tab ready 0.63–0.76 s → 0.025 s over 3 cold starts, prewarm ~6.6 s after launch).
- **Tablet uncached first launch:** Collections paging remains after small Home reads; cold/new-image, request/byte and battery measurements below stay open. Replication completion counting is fixed (`22810e58`); upload preflight was closed in `8032e7d4` (`USER-REQ-20260924`).
- **PC release timings (2026-10-06, Windows main PC, real library, release build 13:28, opt-in timing log, 3 launches):** launch → Home fully shown 2.9 / 3.0 s warm, 4.8 s first launch; Home data ready ~1.6 s (3.5 s first launch); splash leaves ~2.4 s. Folder switch: plain median 91 ms (p90 146), character 91 ms, series 163 ms (p90 262). Tab switch: Home 72 ms, 에셋 132 ms, 컬렉션 425 ms, 만화 553 ms, 메모 358 ms, 전송 354 ms, 관리 371 ms. Collections first open 0.47–0.52 s; query 0.24–1.29 s (cold first). Backend `perf_probe` on a checkpointed copy: grid pages 8–42 ms, series browse 21–38 ms (`needs_review` 113 ms), series open from a plain folder ~245–270 ms cold (prefetched ~199 ms), 태거 검토 `review_page_series_recommended` 563 ms; its 4.2 s library open is a copy artifact. Tool: `LAKOMICS_PERF=1` timing log + `scripts/perf/pc-timing-summary.mjs`. Gaps: warm Collections reopen sometimes never reaches its cover signal and is logged as cancelled; the app leaves a ~54 MB `library.sqlite-wal` after a normal close, so `perf_probe` refuses the live library and needs a checkpointed copy.
- **Tablet original open (2026-10-04):** 0.9.13 measured ticket 231 ms + download 120 ms because original-ticket warming was off (battery 37 % unplugged; native gate needs charging or ≥50 % without power saving, `MainActivity.java:80`). Warming exists (`originalTicketWarm.ts`); next step is only URL-free warm hit/miss diagnostics. 0.9.14 re-measure deferred by the user.
- **Tablet cold thumbnails:** measure first visits, cleared-cache/new-image cases, startup UI work, request counts/bytes and battery. `d8996552` / `4023d37a` implement immutable thumbnail keys; `0fb4afe0`, `15b33c62`, `8ba96f04`, `af8321ea`, `e85df550` implement cache, warming and catalog-entry improvements. Whole-migration completion and new cold-device timings are (unverified 2026-10-10).
- **PC-POLISH-20261002 item 5 / Home:** measure screen/type/section entry, long-list scrolling, viewer open/close, first useful Home paint, section requests and idle CPU on PC dev/release and tablet cold/warm. Recheck lightweight-mode gates (`05b18b6`, `bf40389b`, `f0e7153a`) and background battery cost against new features.
- **Remaining state cleanup:** move Collection release sync, personal-edit receipts and binding sync out of `notes_state` at a future planned migration (committed `collection_release_sync.rs` still uses `notes_state`; the shipped migration 0098 is not that migration).
- **Measurement gap:** restore a native Notes scenario with a disposable Secret Service in the kit's private D-Bus; hidden-idle kit coverage remains unavailable. Use [native kit](../../_tools/app/scripts/native-check/README.md), [PC counters](../../_tools/app/scripts/perf/README.md), [tablet kit](../../android/tools/PERFORMANCE.md), [local API kit](../../server/lakomics-api/tools/PERFORMANCE.md).
- **Immutable-thumbnail cleanup:** the full run `thumb-full` finished 2026-10-03 ~02:30 KST (8,960 committed, 0 errors; controller record). Wait at least 14 days (from ~2026-10-17) and obtain separate approval before deleting only journaled old `library/{id}/thumbnail` objects; never delete prefixes containing originals. ID-only-cover revisions and DocumentsUI/Picker follow-ups remain optional (`server/lakomics-api/ASSET_SEARCH.md` and thumbnail contract source).

# Cloud / Mobile authority

<a id="cloud-post-001--서버-원천화-이후-클라이언트-구조-정리"></a>
## CLOUD-POST-001 — Remaining publication and client cleanup

Status: `PARTIAL` — Collections ownership is settled and activated (2026-10-06, `8d368991`); its legacy publication is retired (`59461c1c`). Read-only inventory 2026-10-10 (12 native publication lanes in `cloud/auto_publication.rs`; `useMobilePublications` only forwards the character navigation order) and user decisions the same day: **character data stays PC-owned** (structure, references and inference on the PC; the server keeps the read projection plus the tablet exclusion/review intent logs) — closed; keep PC-made lanes for characters, auto tags, similarity candidates, catalog duplicates, catalog visibility and the captions; artists intent application deferred; Saved-X media keys stay PC-published (server derivation unverified). Remaining cleanup order: (2) closed 2026-10-13 — the user keeps the `upcoming` lane's local calendar/wishlist PUT fallback (`home_publications.rs:241`) because it still serves a library with the server calendar off or not yet migrated; (3) with `SEC-TOKEN-001` — retire the dormant `releases`/`bindings` lanes, legacy collection/classification/album snapshot publishers and their fenced server routes, after amending the 1C runbook sentence in `docs/research/collection-authority-1b-plan-20261006.md` that relies on legacy paths; move release/binding/personal-edit state out of `notes_state` in a planned migration. AV pick computation/publication and server routes were removed in `dfdc4e06` (deployment not confirmed by that commit); see the [checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-18--home-cards-tablet-structure-and-performance). The tablet still sends personal edits through the compatibility route `/v1/collections/personal-edits` — keep it.
Preserve SQLite replica, workstation compute/filesystem state, durable intent and per-domain cursors/preferences. Completed authority cutovers and the user-closed `CLOUD-WORK-001`, `MOBILE-WRITE-002`, `MOBILE-003` are not new work.

<a id="user-req-20260924--user-requests-2026-09-24-evening"></a>
## USER-REQ-20260924 — Retained Collections authority decisions

Slices 1A/1B/1C, production activation and tablet create/edit are recorded in [plan §7](../research/collection-authority-1b-plan-20261006.md#7-1c-activation-runbook-and-rollback) and the [archive](lakomics-completed.md#closure-checkpoint--2026-10-10--backlog-reconciliation). Residual upload preflight and legacy diagnostic are committed in `8032e7d4`: preparation/counts skip server-born captures, and a snapshot-changed 409 reports a retry rather than an object-key collision. No executable remainder under this item; performance stays in `PERF-ALL-001`.
- **Retained decisions:** no type change under authority; provider-candidate covers on tablet; unsupported operations stay fenced until replacements ship ([design §8](../research/collection-authority-design-20260924.md#8-user-decisions-2026-10-04-before-slice-1b)). TMDB/IGDB and AV replacements shipped; book import was retired (`69805f82`). LaunchBox, legacy package migration and cover-focus recomputation remain fenced; no new implementation priority is inferred.

<a id="user-req-20260926b--user-requests-2026-09-26-second-batch"></a>
## USER-REQ-20260926B — Tablet Collection creation

Delivered tablet Collection creation is in the [2026-10-10 checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-10--backlog-reconciliation). Character creation stays PC-only by the user's 2026-09-27 decision.

<a id="tablet-parity-001--bring-the-tablet-app-up-to-the-2026-09-27-pc-features"></a>
## TABLET-PARITY-001 — Remaining tablet parity

Status: `PARTIAL` — the user-selected parity round of 2026-10-10 is delivered (see the [2026-10-12 checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-12--character-folders-video-and-worker-tooling); unmentioned later device checks count as passed): album management, multi-select actions, folder subtree scope and create/rename, 좋아요순/랜덤 sort, content search (now user-paused, `NL-SEARCH-001`) and the per-volume manga back. Artist rename/hide/pin and 숨긴 작가 shipped earlier (`02656706`, `ebb5f59b`); see the [archive](lakomics-completed.md#closure-checkpoint--2026-10-10--backlog-reconciliation). Merge/detach stay PC-only unless the user asks. Server ownership of artist-intent application remains in `SERVER-INDEP-001`. True batch album membership, folder/classification assignment and multi-select like changes are delivered in `a5ee2111` (up to 100 commands per request; older servers fall back to single routes). This closes the former Remaining bullet; subtree cursor/cache identity and direct `asset_count` semantics stay unchanged.
- **Decisions:** folder move/delete stay PC-only (the character-series move rule needs PC-only data). Not wanted (user 2026-10-10): tablet volume-range editing, manga reader layout options, notes backup on the tablet, single-asset character assignment, asset artist/creator editing, trash emptying/retention on the tablet. Deep character classification remains PC-only; viewer single-asset editors remain, multi-select character assignment stays dropped (user 2026-09-29).
- Next IGDB refetch, one-off TMDB 400 and leftover diagnostics are (unverified 2026-10-10). TMDB/IGDB authority lookup returned (`00c4fddc`, `28b0b494`, `905e7de5`); release-calendar ownership moved to the server (`6c366ff5`, `d7d16d48`; `SERVER-INDEP-001`).

## TRANSFER-001 — LocalSend-style direct transfer first, server as fallback

Status: `PARTIAL` — S1–S6 shipped 2026-10-16 (server `27b5b245` deployed, PC `fc553dbb`/`60df76f8`/`edbca7a2`, tablet `41b174b5`/`793fe6d8`/`6e57dea7`, tablet 0.9.101); the user confirmed PC→tablet and tablet→PC both show 직접 on the same Wi-Fi. Remaining: S7 (optional multicast, LAN vs Tailscale throughput), a Tailscale-only check away from home, the 방화벽 열기 UAC path on a Private network (the PC Ethernet is Public today), and a direct-only size limit above 2 GiB. Original request: user 2026-10-03: add a LocalSend-style transfer path to 전송 (PC ↔ tablet file exchange) as the primary route, with today's server path (R2 exchange via the Cloud API, `ExchangeService` / `ExchangeView`) as the fallback. Supersedes the 2026-10-02 `EXTERNAL-REFS` note that had LocalSend only as a fallback. No LocalSend code exists in the repository (checked 2026-10-12).
- **Direct path:** discover the other device on the same network (LocalSend-style multicast announce + HTTP(S) registration; Tailscale address as a second candidate), pair once with the existing device identity, then send over an encrypted local HTTPS connection with resumable chunks. Keep the current hash/dedupe/trust checks, receive-folder rules and crash-safe receive on both ends.
- **Fallback:** when no direct peer answers within a short timeout (or the user is away from home), use the existing server exchange unchanged; the user sees one 전송 screen, not two features.
- **Clarified (user 2026-10-05):** on the same Wi-Fi, transfer goes directly with relaxed size limits — speed is the goal; on a different network, the existing server path. Mainly Galaxy Tab ↔ PC, both send and receive.
- **Decided (user 2026-10-15):** build it with LocalSend as the reference design (discovery, prepare-upload/upload flow, resumable chunks); between the user's own paired devices a send goes through immediately with no accept prompt. On Home, dropping onto the 전송 tool sends at once and details live in a separate 전송 상세 screen. Recommended default, not yet confirmed: the tablet receives only while the app is open.
- **Research (Claude subagent, 2026-10-15; sources github.com/localsend/protocol, localsend.org/changelog, Android local-network-permission docs):** LocalSend v2 has no resume and no mutual authentication; its favourite auto-accept trusts a self-asserted fingerprint, which anyone on the LAN can spoof. Recommendation: a private LocalSend-shaped protocol (`/api/lakomics/lan/v1/{info,prepare-upload,upload,cancel}`, own port) with mutual TLS, each device's long-lived self-signed certificate pinned through the existing exchange device list (same principal, not revoked), our own resume (`offset`/`HEAD`), sha256 check and the existing receipt journal. Route order: LAN IP → Tailscale IP → R2 inbox. PC: needs new crates (`rcgen`, direct `rustls`, a TLS server such as hyper + tokio-rustls or axum) and a firewall helper (elevated `netsh` rule, Private profile) since builds are not installed via MSI. Tablet: plain Java/d8 build, so `SSLServerSocket` or vendored NanoHTTPD, MulticastLock, listener only in the foreground, NetworkPolicy allowlist; Android 17 targetSdk 37 will need ACCESS_LOCAL_NETWORK (not today at targetSdk 35). Server: new device columns (cert fingerprint, port, last LAN/Tailscale addresses) and a deploy. Slices S1 identity → S2 PC receiver → S3 PC sender + fallback → S4 tablet receiver → S5 tablet sender → S6 UI (route badge, firewall helper) → S7 optional multicast + LAN vs Tailscale throughput measurement.
- **Approved (user 2026-10-15):** the private mutually authenticated protocol above, adding the needed PC crates (`rcgen`, `rustls`, TLS server), the server device-column change with its deployment, and the elevated Windows firewall-rule button. Scheduled after the 2026-10-15 Home/card, 확인 and 분류함 work.
- **Open questions before building:** Android background/foreground limits for a listening socket (the app is foreground-only today), Windows/Linux firewall prompts on the PC, whether to reuse LocalSend's protocol (interop with the LocalSend app) or a private one, and battery cost of discovery. Design first; PC first, tablet in the same round.

<a id="transfer-text-001--on-demand-text-and-url-device-transfer"></a>
## TRANSFER-TEXT-001 — Send text and URLs between PC and tablet (2026-10-08)

Status: `IDEA` — user liked this as a practical addition to the **daily-used** 전송 workflow; not authorized for implementation and not in the priority queue. Extend the file-centered exchange to small user-initiated messages rather than build automatic clipboard synchronization.
- **MVP:** from PC or tablet explicitly choose **텍스트/링크 보내기**, paste/type a short message or URL, select the paired device, and send through the **existing** 전송 screen. On receipt, show a text preview with **복사** or a URL preview with **열기** (only after user taps); preserve device/batch/status/retry conventions. Messages need not become downloaded files.
- **Safety/scope:** do not monitor/forward the clipboard, open received links automatically, or silently overwrite the clipboard. Bound payload sizes and message lifetime; treat URLs and rich text as untrusted (plain text / safe links only). Resolve whether the file-exchange server protocol can carry typed short messages without disturbing file or Downloads semantics, and how this interacts with `TRANSFER-001`.
- **Acceptance to define before coding:** both directions PC ↔ Galaxy Tab work without a temporary text file; the receiver can copy text or deliberately open a URL; existing file transfer is unchanged.

<a id="sec-token-001--shared-token-routes"></a>
## SEC-TOKEN-001 — Retire the shared cloud token from publication and admin routes

Status: `PARTIAL` — the 2026-10-06 audit is a route-retirement request, not proof that every listed route still accepts the shared token. Current `api_auth.py::publisher_guard` rejects it; Collections authority/staging and wired Collection/Character publishers use distinct publisher auth. `app.py::require_auth` and `require_upload_client` still accept `LAKOMICS_API_TOKEN`, including compatibility/upload/admin paths. Re-audit the original classifications, saved-X, album snapshot, Collection/Character legacy handshake, artwork prepare, extension pairing/revoke and capture acknowledge/imported surfaces individually before retirement; do not remove recovery compatibility by assumption. Android NetworkPolicy restrictions do not retire the bearer credential. Deployed auth behavior and credential-store contents are (unverified 2026-10-10).

- **Original audit inventory:** `PUT /v1/classifications`, `PUT /v1/saved-x-media`, `PUT /v1/library/album-snapshot`, legacy `PUT /v1/collections/replica` and `/v1/library/characters/replica`, `POST /v1/collections/artworks/prepare`, `POST /v1/extension/pairings`, `/v1/extension/clients/{id}/revoke`, `/v1/captures/{id}/acknowledge|imported`, and `require_admin_or_extension`; these preserve the requested review scope, not a claim that every route is exposed. PC `Lakomics/CloudApi` and tablet `SecureSettings` remain the recorded credential locations (unverified 2026-10-10).
- **Order:** (1) PC sends `CloudPublisher` on its publication/admin calls; (2) server moves those routes to `publisher_guard`, and tablet-used reads plus notes to `client_guard` (list-generation, captures pending/download, library classifications/assets/contains, revisit, collections reads and artwork tickets, notes GET/PUT); (3) tablet setup accepts a provisioned `client` token (today its validation probe is a shared-only route); (4) rotate the shared token after both clients moved. Keep older-server compatibility in mind (`cloud/characters.rs:824`). `/v1/mobile-catalog/refresh` is already `client_guard`.

## SERVER-INDEP-001 — Move server-solvable PC work to the server

Status: `PARTIAL` — user 2026-10-03: anything the server can own should stop waiting for the PC. Collections authority, AV lookup, release-calendar/wishlist ownership and Kakao/MangaDex binding execution have moved; unmigrated PC-published data and intent application still depend on PC uptime. The recorded VPS is 1 vCPU / 1.6 GB, so model inference stays on PC (current capacity unverified 2026-10-10).
- **Delivered:** the 2026-10-09 calendar → wishlist slice 2 → tablet Kakao binds slice 2 → MangaDex sequence is complete (wishlist handover/activation, Kakao/MangaDex server executors, binding-fence resolution, user-confirmed live links; [evening checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-10-evening--server-ownership-of-wishlist-kakao-and-mangadex-binds)); do not restart those slices. Provider watch passed: Kakao checks ran on all 29 bound works since 2026-10-09 20:44 KST with zero failures; wishlist checks ran 2026-10-10 14:44 KST without failures.
- **Real calendar refresh — passed 2026-10-11 (controller, read-only):** the server refreshed on its own at **2026-10-10 23:18 KST** (igdb 54 / tmdb 58 / tmdb_tv 25 entries, 125 requests, 0 failures, `changed:true`, `home_upcoming_state` revision 84); `CLOUD-POST-001` cleanup step (2) is unblocked. Steps 1–2 (`6c366ff5`, `d7d16d48`) are deployed with `LAKOMICS_RELEASE_CALENDAR=1`. Contract: [calendar](../research/server-release-calendar-20261009.md). Only continued monitoring remains.
- **Similarity:** immediate server keep/discard (`4fb87df5`) is ON since 2026-10-10 ~21:30 KST (`similarity-apply.conf` drop-in; DB backup `/home/linuxuser/lakomics-simapply-202610101227/rollback/`; roll back = delete the drop-in and restart); the unmentioned later device check counts as passed under the user's rule.
- **Other retained scope:** server-owned artist-intent application (deferred by the user 2026-10-10; tablet intents keep applying when the PC runs); catalog visibility and duplicate-edition confirmation ownership stay PC-made (the server decides only the confident duplicate candidates it found itself, `5cf2ab64`). Tablet character assignment was dropped (user 2026-10-10, character data stays PC-owned). The Home AV pick computation, publication lane and server routes are retired in source (`dfdc4e06`); no new migration is planned, and live route removal was not rechecked. AV product-code lookup is delivered (`5c3ea3d9`); unmentioned native apply checks count as passed. Aladin is retired (`c474aa77`, `04acc96e`, user: service ending).
- **Ops limitation:** stage full suite exceeds ten minutes; use detached execution. Repeated Windows WSL `Wsl/Service/E_UNEXPECTED` full-run crashes while the app/character scan were running are recorded, not resolved (unverified 2026-10-10).
- **Stays on the PC:** tagger/rating inference, character detection and S36, similarity features, artist-style analysis, FFmpeg video work, original files.

## TABLET-FEEDBACK-20260928 — Residual tablet requests

Status: `PARTIAL` — separate memo feedback kind and tablet favourite-performer/Home parity are (unverified 2026-10-10). The Home release-thumbnail mismatch was closed without a repro on 2026-10-13; see the [latest checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-13--pc-feedback-jobs-reference-editor-and-resize). Catalog request optimisation is consolidated in PERF; its committed fixes are archived.
- **Catalog ownership (decided 2026-09-28):** PC should import server refresh additions while retaining its own catalog/publisher/updater; no committed PC import was found (unverified 2026-10-10).

<a id="user-feedback-20260928b--second-feedback-batch-2026-09-28-night"></a>
## USER-FEEDBACK-20260928B — Remaining cross-client requests

Status: `PARTIAL` — implemented redesigns, manga cleanup UI, automatic edition merging and motion are archived; retain only the following gaps.
- **Safe undo:** authority-revision-conditional folder restore, consumed tagger candidate restoration and an explicit compensation decision; a simple restore can overwrite another device. Still unbuilt (unverified 2026-10-10).
- **Home AV:** favourite performers should open the performer route rather than AV Collections; AV new releases need a feed; tablet favourite-performer data parity remains (unverified 2026-10-10). Keep no-resume policy (user 2026-09-30): local manga starts at page 1, library video at 0:00; unused 0114 progress tables do not reopen resume.
- **Catalog review:** server automatic-decision origin labels, decision-log restart replay and PC decision reporting completeness need recheck (unverified 2026-10-10); `includesServerWorks=false` deliberately preserves server-only candidates, not unfinished behaviour.
- **Vanished manga folders:** UI is implemented (`4542a6b9`, `af2fd1a4`); production deletion still needs separate approval. Preserve user choice of selected records only with verified automatic backup (decided 2026-09-28).

<a id="home-opt-001--home-optimisation-and-debugging-pass-pc-and-tablet"></a>
## HOME-OPT-001 — Residual test reliability

Status: `PARTIAL` — 2026-10-10 (`431e7721`): shuffled-order vitest failures traced to missing global Testing Library cleanup (now in `src/test/setup.ts`) and state leaks in `App.test.tsx`, `library/client.test.ts` and `shared/motion/viewSwap.test.ts`; 3 shuffled + 1 default full runs green (3071 tests). Async-util/test timeouts were raised to bound load-related hangs (5 s / 20 s). The thumbnail sandbox failure is attributed to `ReplaceFileW` ACL merging (now `REPLACEFILE_IGNORE_ACL_ERRORS`; sandbox rerun not done). Still open: the server stale-PC test has no confirmed cause (wait for a stage failure log); make two parallel-run `src/app/App.test.tsx` cases deterministic or measure worker-count effects; intermittent Albums, assetFilterUi, AssetGallery and library-root-switch failures from the user's 2026-10-01 report (unverified 2026-10-10). Passing reruns do not establish the scheduling cause.
- Server `test_server_added_work_can_be_refreshed_and_survive_stale_pc` was intermittent on the VPS stage (2/3 failures, 2026-10-01); `198357b7` addresses a catalog refresh-count race, but equivalence to this failure is (unverified 2026-10-10). Home findings 1–8 are source-fixed; their acceptance was closed 2026-10-05; performance is in `PERF-ALL-001`.
- Rust `thumbnail_maintenance::tests::apply_limit_is_resumable_and_skips_completed_files` failed repeatedly inside the Codex sandbox but passes in a normal shell (2026-10-05); find the sandbox-sensitive dependency (filesystem/timing) before trusting either result.


## VAULT-ENC-001 — Residual audit claims

Status: `TODO` — low priority; kept when the vault's acceptance line was closed 2026-10-05 (ADR-0039). Original scan-error title/thumbnail preservation, full-image cache headers and per-tile-probe audit survivors are (unverified 2026-10-10); recheck the rewritten path only.

<a id="ai-jev-002--jev-for-text-candidate-decisions-idea"></a>
## AI-JEV-002 — Text candidate decisions

Status: `IDEA` — user 2026-09-26, not started. Candidate order: Collection provider matching → edition ambiguity → owned-volume mapping → saved-post folder suggestions → ledger categories. Recheck API/pricing, obtain metadata-send consent and compare shadow mode with a deterministic baseline before adopting; [prior direction](../research/character-autonomy-and-jev-direction-20260921.md).

<a id="transfer-review-001--deferred-findings-of-the-2026-09-26-transfer-path-review"></a>
## TRANSFER-REVIEW-001 — Residual transfer design edges

Status: `TODO` — low priority. Scope catalog duplicate decisions by library identity as well as server address; resolve similarity-review withdrawal arriving after the PC log read but before feed PUT, leaving the asset in Trash (unverified 2026-10-10). Live R2 signed Content-Length refusal is not established by fixtures (storage enforcement unverified); transfer recovery acceptance was closed 2026-10-05; implemented bounds/paging/reclaim are archived.

<a id="server-review-20260924--remaining-judgment-calls-of-the-cloud-api-review"></a>
## SERVER-REVIEW-20260924 — Residual server judgment calls

Status: `TODO` — low priority; [review](../research/server-review-2026-09-24.md). Personal-edit/noop, character/similarity decision histories and observation-ledger retention still need review (unverified 2026-10-10); refresh-job pruning is implemented (`5c1b80d7`) and is not the same history. Items 5 (legacy long memo conflict) and 9 (auth before body validation) are fixed (`67e0cd97`). Shared-token trash/restore matches the retained design; the similarity-kept Trash refusal acceptance was closed 2026-10-05.

# Works / Collections

<a id="collection-name-001--explain-names-reserved-by-trashed-collections-2026-10-18"></a>
<a id="collection-name-001"></a>
Completed record: [COLLECTION-NAME-001](lakomics-completed.md#collection-name-001).

<a id="manga-spine-size-001--manga-bookshelf-spine-size-2026-10-18"></a>
<a id="manga-spine-size-001"></a>
Completed record: [MANGA-SPINE-SIZE-001](lakomics-completed.md#manga-spine-size-001).

<a id="long-001--av-metadatacover-acquisition-and-candidate-selection"></a>
## LONG-001 — AV lookup rollout

Former rollout and source decisions are in the [archive](lakomics-completed.md#closure-checkpoint--2026-10-10--backlog-reconciliation); server lookup (`5c3ea3d9`) is delivered and its unmentioned migration/apply checks count as passed. No executable rollout remainder; arbitrary tablet portrait crop stays under `AV-AUTHORITY-001`, and the laptop update is in [Waiting on the user](#waiting-on-the-user-devicenative-checks).

# Catalog / optional providers

## COLLECTION-READ-001 — Readable manga files inside Collections (2026-10-11)

Status: `IDEA` — user 2026-10-11: put readable manga volume files into Collections so each owned volume can be read on PC and tablet. Not designed yet; design first, then decide.
- **Size estimate (2026-10-11, read-only):** 149 manga works with 2,562 registered volumes (only 116 marked owned). At ~80 MB per volume: owned only ≈ 9 GB, half of the registered volumes ≈ 100 GB, all ≈ 205 GB. Re-encoding pages to WebP at reading quality usually brings a volume to 20–30 MB (all volumes ≈ 60–80 GB).
- **Storage direction to evaluate:** originals stay on the PC library disk; a lighter reading copy goes to object storage (Cloudflare R2, ~$0.015/GB-month, no egress fee; ~$3/month for 200 GB) because the new VPS disk (80 GB) cannot hold it; the tablet streams pages on demand and keeps only recently read volumes cached, like the catalog reader.
- **Open questions:** import flow (attach files to a volume, folder/zip/cbz), which volumes count (owned only?), reading position sync between PC and tablet, privacy mode and NSFW masking in the reader, and whether the catalog reader component is reused.

<a id="img-cover-001--paper-colour-translation-covers-overlap-2026-10-21"></a>
Completed record: [IMG-COVER-001](lakomics-completed.md#img-cover-001).

<a id="somi-001--in-app-kone-somisoft-board-browsing-and-reading"></a>
## SOMI-001 — In-app kone.gg 소미소프트 board browsing and reading (2026-10-21)

Status: `IDEA` (user, 2026-10-21) — inspired by the third-party VCK 0.8.0 launcher (Electron, based on project-violet's violet-web; reviewed read-only from the user's desktop copy, not run). Use it as a reference for behavior only; do not copy its code (license not checked) or its K-Hentai/hitomi catalog.

- **Decided:** log in to kone.gg inside the Lakomics PC app (the user types credentials into kone's own page; Lakomics never sees the password); list the 소미소프트 board like a catalog with search and sort; open a work and read it in the Lakomics viewer directly from kone without importing first, with an explicit save into the library when the user wants it. PC first; tablet later (synced saved works only until then).
- **Behavior to match from VCK:** a view is counted only when a work is opened, recommend/comment only on the user's explicit action, nothing visible while logged out, one request at a time, low rate.
- **Technical risk (spike first):** kone sits behind Cloudflare and answers only a logged-in browser session (httpOnly login cookie, `cf_clearance`), and its API uses a custom request encoding and a `QUERY` method. VCK sends every API call through the Chromium session of its kone window. Tauri needs an equivalent: a dedicated kone webview with its own data directory and a narrow, allow-listed bridge for page-context requests, without granting the remote origin general Tauri IPC. Confirm feasibility on Windows WebView2 before UI work.
- **Open:** board list fields and title parsing (tags, original work, artist), caching of the list, viewer streaming/prefetch and the no-flash rule, save-to-library mapping to the manga catalog, logout behavior.

<a id="catalog-archive-001--retain-removed-unbookmarked-catalog-metadata"></a>
## CATALOG-ARCHIVE-001 — Keep searchable records of works removed from source catalogs (2026-10-08)

Status: `IDEA` — **user's actual pain point**: a Korean-language adult doujinshi gallery once visible in the catalog can vanish from search later, **even though the user never bookmarked it**. Distinct from `CATALOG-KEEP-001` (retaining full **pages of bookmarked** works). Do not narrow this to favorites, bookmarks, reading-progress entries, or an automatic image-download requirement. No implementation approved.
- **Goal:** before catalog refresh/replacement, retain enough **metadata for every previously cataloged work** (provider-qualified ID, title variants, artist/group, tags/language, page count, cover reference or durable thumbnail where feasible, first-seen/last-seen timestamps and original source URL) to find it again after upstream removal. Preserve catalog history across refreshes instead of using the latest `catalogs/kdata.db` as the only source of search truth; store it in a separately managed, versioned, migration-safe table/store. Avoid unbounded duplicate snapshots; do not replace the canonical `kdata.db` wholesale.
- **UI:** normal catalog search can opt into **사라진 작품 포함**; results distinguish `현재 확인됨`, `소스에 없음/열람 불가`, and `확인되지 않음` rather than equating missing search data with a verified deletion. Show old metadata and last-seen date when available. If the source later restores an item, reconnect to the same provider-qualified identity without losing history/bookmark/progress.
- **Sources/fallback:** once another catalog provider is supported, offer **동일 작품의 다른 출처 찾기** as a suggestion (compare provider IDs/tokens, title variants, creator, tags, page count and, if legally/technically available, cover similarity; no blind title-only merging). A metadata-only record **cannot restore deleted image pages**, and pre-existing vanished works cannot be recovered without an older snapshot, another source, or valid historical evidence.
- **Implementation gates:** read-only audit of PC `kdata.db` refresh/import and server/tablet publication/switch paths; define presence vs deletion semantics, snapshot retention, storage cost, indexes, update reconciliation and offline/device parity. Preserve the language/tag/visibility/privacy policies, source provenance, catalog bookmark identities and reading progress. Benchmark catalog counts/paging and search before accepting a historical-results join. Do not crawl additional sites or download third-party media automatically without separate approval.

<a id="catalog-series-001--sequential-doujinshi-work-series"></a>
## CATALOG-SERIES-001 — Group sequential adult doujinshi works (1, 2, 3…) (2026-10-08)

Status: `IDEA` — user means **parts 1/2/3 of one creator's continuing series**, not the shared `parody`/fandom tag and not the existing `catalog_group*` **same-work editions** (Korean/Japanese/revisions). The goal is to stop searching separately for each next part; implementation not approved.
- **Data model:** distinct levels **series → separate numbered works → same-work editions / source variants**. Series membership and order are user-editable, separate from the provider's catalog entries and edition-group identity. Include optional prequel/sequel, afterword, extra/side story when a part number is not straightforward; never infer continuity solely from a shared parody/tag/character.
- **MVP:** a manually confirmed series groups the catalog cards under one entry; the detail view lists parts in order with prior/next jumps and keeps each work's Korean/Japanese editions. Propose neighbors from normalized title stems, creator identity, numbered or Japanese part markers (`Part 2`, `II`, `前編/後編`, `上/下`, `総集編`) but keep low-confidence matches as suggestions; a collection/omnibus may contain earlier parts and must not silently collapse them.
- **Provider compatibility:** use source-qualified work identities so later providers can fill missing parts; link cross-provider representations conservatively with human correction; preserve each user's bookmark/reading state and source provenance. The existing same-work edition merge is not replaced.
- **Acceptance to design later:** the user finds part 1 and reaches parts 2/3 in one series detail; wrong candidates can be rejected or detached without affecting existing catalog work data.

## CATALOG-KEEP-001 — Keep bookmarked works when the source deletes them

Status: `TODO` — user 2026-10-06, not scheduled. On 2026-10-05 the bookmarked kHentai work 2583385 still listed and opened its detail from the published catalog, but its reader returned 404 because k-hentai no longer serves the gallery (`app.py` "work not found on k-hentai"); the tablet message now says so. The user chose to keep copies of bookmarked works rather than look the work up on another source (that alternative stays with `CATALOG-002B`).
- **Direction:** store the pages of bookmarked works (server or PC) so the reader falls back to the kept copy when the source is gone; reuse the planned local-manga-on-the-server path (`MANGA-CATALOG-FEEDBACK-20261004`) and the existing catalog reader.
- **Open questions before building:** where copies live (VPS had ~23 GB free on 2026-10-04 and ~291 bookmarks), when to copy (on bookmark vs a background pass), image format/size limits, removal when a bookmark is cleared, and whether the PC reader needs the same fallback. Measure the bookmarks' total size first.

## CATALOG-002B — Optional Heliotrope coexistence

Status: `TODO` — low priority. VCK/kHentai stays default; isolate optional provider cache and verify page resolution separately from metadata. Disable/cache-clear preserves bookmarks/progress.
- **2026-10-08 user need / investigation:** source diversity is wanted **primarily to locate works that disappeared from search without having been bookmarked**, not to enlarge a duplicate gallery list. Test whether Heliotrope/Hitomi metadata can find *additional Korean-language works* and give stable alternate reader links; API/service availability, overlap with kHentai, permission/terms, Korean filtering, full-page resolution and long-term reliability are **unverified**. First compare source-qualified IDs plus human-verified samples of absent works and duplicate editions, then decide. `CATALOG-ARCHIVE-001` stays a separate metadata-history requirement: a new source cannot guarantee recovery of a missing gallery.

# New standalone product areas — ideas only (2026-10-08)

These two user-selected candidates are **new top-level Lakomics capabilities**, not extra panes of Library, Collections, Manga, Transfer or Revisit. Neither is an implementation request; both remain `IDEA`. The user considers both more promising than the other unrelated-area brainstorms. Tentative build order **File Workshop → Web Radar** is a recommendation only, **not** a change to the Current priority queue.


<a id="file-workshop-001--standalone-file-processing-workbench"></a>
## FILE-WORKSHOP-001 — File Workshop: process arbitrary files without importing (파일 작업실)

Status: `IDEA` — user 2026-10-08 selected as a promising **independent utility area**; not approved to build. Purpose: **perform a useful one-off operation now**, not catalog/classify/keep the input as an Asset. The PC user drops or selects any supported external file/folder; no Library or Collection membership is created by choosing files.
- **Proposed MVP:** a compact PC workspace with drag/drop and file picker; inspect file type/size and choose one explicit operation: image conversion (`PNG/JPEG/WebP`), bulk image resize/compression, or video-to-`MP4` compatibility conversion via the available FFmpeg capability where feasible. Preview the planned output filenames and destination, run a bounded/cancellable job with progress and per-file failures, then **open/reveal output**. Never silently overwrite, delete, relabel or import originals; avoid filename collisions; allow a user-selected output location. The first small tool set must match *actual* frequent user tasks, not a generic editor.
- **Presets are the feature:** e.g. `웹 업로드용` (size/dimensions/conversion settings) and `영상 호환 변환` (predictable MP4 format), with settings and last-used preference visible. Inspect whether an image has animation, multiple pages or alpha and explain loss before converting.
- **Later, only if repeated use shows demand:** archive/ZIP/CBZ inspection/extraction/repack, batch format-specific operations, drag/drop out, explicit **전송으로 보내기**, explicit save/import to the Lakomics Library, or passing output to the shipped Arca Live picker (COLLECTOR-PICKER-001; a future Workshop handoff is still only an integration option). These are **integration options**, not prerequisites or automatic side effects.
- **Technical and safety boundaries:** reuse existing media/FFmpeg code cautiously without coupling to managed asset lifecycle; constrain archive extraction paths/size against zip-slip and decompression bombs; bound memory/parallelism and huge-video jobs, sanitize filenames, treat input as untrusted, support cancellation. Native PC first; tablet equivalence is not implied. Benchmark video/audio codecs against the bundled FFmpeg before promising a preset.
- **Acceptance target:** the user processes external files, obtains independently saved output, and continues elsewhere **without adding the inputs or outputs to Lakomics**.

<a id="web-radar-001--site-project-and-creator-update-monitor"></a>
## WEB-RADAR-001 — Web Radar: follow changes to chosen public sites and creators (웹 레이더)

Status: `IDEA` — user 2026-10-08 selected as a promising **new top-level information-monitoring area**; not approved to build. Goal: when selected sites, creators, software projects or topics change, reveal **what is new and where to go** instead of making the user visit each source. This is **not** a new image-revisit feed, automatic library import, or the rejected `COLLECTOR-RADAR-001`/source-loss detection idea.
- **Proposed MVP:** the user explicitly subscribes to stable, supported sources such as RSS/Atom feeds and GitHub Releases; refresh manually/on a modest schedule and show a unified **new since last checked** inbox: source, title, date, short preview, link, read/unread and last-success/error indicator. Deduplicate by stable origin IDs/URLs; keep read state through feed reorder/refresh; easy pause/unsubscribe per watch. Open in the browser for full content; no scraping or automatic media download.
- **Next source adapters, gated by feasibility:** creator/artist update feeds or official public profile APIs, supported software changelogs, selected search queries. Only after proven useful, investigate URL-scoped webpage change detection with explicit target area/filters, friendly polling and backoff; a generic `watch any website` promise is **out of scope**. Login, paywall and dynamic-JS sites need bespoke adapters and must not be presented as supported.
- **Optional later links:** explicit **collector로 열기/저장**, software release references, user-controlled notifications/badges, related Collections; do **not** change Collector capture semantics or add results to the Library automatically. Surface only discoverable, useful updates, not a social-network client.
- **Operational/privacy boundaries:** obey service APIs/rate limits/robots and terms; persist only the watch list and bounded entry metadata under user control; do not ingest private browsing history, arbitrary cookies, third-party credentials or page contents without separate consent. Decide PC-only (while running/tray) vs server monitoring **after** designing ownership, reliability, notification delivery and resource limits; no guaranteed monitoring while the app/PC is offline.
- **Acceptance target:** after adding two supported sources, the user can tell what newly appeared, open the original page, mark items read, and see when a source could not be checked.

# Desktop UI follow-ups


<a id="char-detector-001"></a>
## CHAR-DETECTOR-001 — Better separation of overlapping persons (2026-10-13)

Status: `HOLD` (user 2026-10-13: later). The person detector sometimes merges or poorly separates overlapping characters. Current detector: `ksasao/anime-character-detector` YOLOX-s ONNX (`character-runtime/baseline.json`, detector_score 0.30, nms 0.45; the HF repo is no longer public, no published metrics). Research (Claude subagent, 2026-10-13): no drop-in model is clearly better; most promising is adding deepghs `anime_head_detection` v2.0 YOLO11 s/m (F1 0.92–0.93, MIT, ONNX) to split/add crops by heads; drop-in alternative deepghs `anime_person_detection` v1.1_m (F1 0.87); `AnimeInstanceSegmentation` (RTMDet-Ins, no ONNX) only as an experiment; SAM 3 / Grounding DINO not recommended. A cheaper first try: NMS 0.45 → ~0.6 and score 0.30 → ~0.25 (revives a suppressed second person, cannot split an already merged box). Any detector or setting change alters the extraction fingerprint: one full feature re-extraction (~40 min on DirectML) and threshold re-validation. When resumed: offline A/B on 30–50 mis-split + 30 normal multi-person images (current / tuned / person v1.1_m / + head crops) on a cache copy; metrics boxes vs persons, merged boxes, final recommendation right/wrong.


## AV-AUTHORITY-001 — AV acceptance and remaining profile polish

Status: `PARTIAL` — authority command work in steps 1–6 is implemented; unmentioned later native/device checks count as passed. Arbitrary tablet portrait crop remains unconfirmed below. The laptop update for `deletedPeople` is in [Waiting on the user](#waiting-on-the-user-devicenative-checks). The accepted performer redesign and retired book import are in the [archive](lakomics-completed.md#closure-checkpoint--2026-10-10--backlog-reconciliation).

1. Front/spine/back authority artwork: `5036ed28`.
2. AV details/cast: server + PC `5f7ef78d` (deployed 2026-10-07), tablet `47c4fab8` / 0.9.42; field CAS, creditName and shared limits.
3. People memo/favourite/portrait: PC/server `a182f38e`, tablet memo/favourite `cc1c35c7`; tablet StashDB photo/clear `c74deb8a`. The originally requested arbitrary tablet portrait crop is not established by that image-only route (unverified 2026-10-10); keep it as residual scope.
4. StashDB server relay/profile/photo: `170de2cc`, PC `a3c7f844`, preview `2b77c8a5`, tablet `c74deb8a`; deployed/key configured per [handoff](../archive/operations/handoff-2026-10-09-linux-laptop.md). Profiles belong to people, not work bindings.
5. Server inbox: `5c3ea3d9` deployed; PC `278c1e57`, tablet `dcb7e0c4` / 0.9.48. Durable apply and one-time migration exist; do not describe lookup as local. Contract: [AV inbox](../research/av-inbox-server-20261009.md).
6. Manual profiles/names: server `ce23a0a3` deployed, PC/tablet `a9d68042` / 0.9.49; compact editor/copy controls `41c4366f`, `595de29b`. Contract: [profile editing](../research/av-person-profile-edit-20261009.md).

Retained user decisions: PC first/tablet in the same round; one-time people reconciliation was approved with server backup first and no null overwrite across clients. Inbox refuses an existing work with a different non-empty product code; migration closes already-applied/dismissed local entries. Tablet uses the default split only, per-surface 후보 사용/유지/비우기, 찾는 중/후보 있음/보내는 중 and 뒤표지; director credits/people were retired in `c7bc5a07`/`9bb8e8ad`; performer links remain and StashDB search prefills Japanese names. Profiles edit birth date, height, B/W/H, cup, breast type, career years, links and Korean/Japanese names; manual fields survive StashDB refresh, untouched fields follow it, names never follow it. Cm input snaps to stored inches; B/W/H and career endpoints reset as groups; links are one field; 직접 입력 hides without a StashDB link; 보형 → 인공; tablet ⋯ 배우 관리. Name order: Hangul name → StashDB romanized → stored name, Japanese subtitle always; original names are the reset baseline.

AV jacket preference, cover review, wrap/spine fallbacks and director retirement are recorded in the [2026-10-18 checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-18--home-cards-tablet-structure-and-performance). Remaining polish: none open; the committed link-label cleanup (`a3797fff`) and recorded inbox dismissal are in the [latest checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-13--pc-feedback-jobs-reference-editor-and-resize). Arbitrary tablet portrait crop remains the residual scope in item 3.


## USER-REQ-20261007 — Tablet 더보기 and one combined 휴지통

Status: `PARTIAL` — delivered sections are accepted under the unmentioned-check rule; encrypted-vault placement is still unresolved. PC `1d2ff4bd`, tablet `90d7b557` / 0.9.41 implement Home 더보기 matching supported PC destinations, one asset/Collection/Notes 휴지통 and removal of scattered Library/Collection/rail entries. Those delivered checks are closed; see the [2026-10-18 checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-18--home-cards-tablet-structure-and-performance). Preserve asset restore/empty/retention on PC, tablet restore-only and authority restoreWork.
Encrypted-vault trash placement/unlock was requested for confirmation during design; the current shared trash tabs contain only assets/Collections/Notes (`trashSections.ts`). That part is not verified as implemented or explicitly dropped (unverified 2026-10-10); retain the placement decision.

## USER-FEEDBACK-20261005 — Requests of 2026-10-05

Status: `TODO` — remaining user requests and decisions of 2026-10-05; each bullet carries its own status. Requests delivered the same day are in the [2026-10-05](lakomics-completed.md#closure-checkpoint--2026-10-05--tablet-catch-up-ui-unification-phase-1-and-pc-speed) and [2026-10-05 (night)](lakomics-completed.md#closure-checkpoint--2026-10-05-night--ui-unification-phases-23-folder-move-motion-bookmarks-speed-and-acceptance-closure) checkpoints.
- **Tag translations (`TODO`, later batch):** manga catalog tags are often long-winded paraphrases or untranslated, and some asset tags are untranslated; the user will collect examples first.
- **Current-model polish only:** the realistic-case upgrade was dropped by the user 2026-10-17 (see the [checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-18--home-cards-tablet-structure-and-performance)). Keep existing manga/game models free of gaps or see-through closed edges; manga side-angle and shelf-shadow fixes shipped in `44874f99`/`abb8cb78`. Reopen a concrete defect if reported; no new effects are planned.
- **Decided, not planned:** Notes media attachments — option (b) chosen 2026-10-05: dropping files inserts their paths (`19ef652e`); real encrypted attachments (outside ADR-0035's scope) only if the user asks. Series folder 미분류/전체 stays an inline control above the gallery, not in 보기, by design; revisit only if the user asks.

## WIN-FEEDBACK-20261004 — First Windows release-run findings

Status: `PARTIAL` — reported by the user 2026-10-04 on the first Windows release build (`e8b3d774`, WebView2). The source-fixed bullets were closed by the user on 2026-10-05 (night checkpoint); the bullets below remain.
- **Abandoned thumbnail requests — source fix 2026-10-06:** media-protocol requests made after a view change (`media_view_changed`, sent on area and gallery scope changes) are served before older queued ones, FIFO within a view; old ones still finish. Native release timing during rapid switching is unmeasured; targeted measurement remains in `PERF-ALL-001`.
- **No popping in (user 2026-10-04):** progressed — menus, dialogs, popovers, toasts, selection bar and tablet sheets ease in and out (`2748f0db`); first-screen tiles and late images appear together (`2eef344c`, `288ae552`); the launch mark covers the first Home load (`3dd73981`). Keep sweeping instant panels and late blocks found in use (≈150–250 ms ease-in, reduced motion respected; never fade from a blank frame where the no-flash rule applies).

## MANGA-CATALOG-FEEDBACK-20261004 — Manga catalog requests

Status: `PARTIAL` — PC local import shipped (`90ae5664`); author destinations and tablet/server upload remain. Archive-original trash is committed (`a3797fff`); native OS-trash acceptance remains unverified.
- **Import local works:** PC drop/import and archive-original trash are delivered (`90ae5664`, `a3797fff`); see the [latest checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-13--pc-feedback-jobs-reference-editor-and-resize) for behavior and native acceptance limits. Remaining: author-folder destinations (the manga root is flat today) and the tablet/server upload below.
- **Local manga on the tablet via the server (user 2026-10-04):** the user wants local manga readable on the tablet; NSFW content on the server is already accepted. Direction: the PC uploads local works to the server and the tablet gets a 로컬 source in the catalog, read with the existing catalog reader, available while the PC is off. Measured 2026-10-04 (read-only): VPS `/` 52 GB with 23 GB free; local manga root `C:\laku\2군` is 197 MB. Decided (user 2026-10-04): every local work uploads automatically; import MOVES the source into the manga root (not copy); destination is automatic — read the artist from the name (e.g. `[작가명] 제목`) into that artist folder, ask only when no artist can be read, and show a preview of where each item moves and confirm before moving (moves are hard to undo). Scheduled after the Home fill round.
- **Idea — real-time artist tweets via Web Push (user 2026-10-04, not scheduled):** https://github.com/sh1ma/Angelic-Angel (Rust, MIT, 206★, last push 2026-03-05) emulates a Firefox Web Push client on Mozilla AutoPush to receive X notifications for followed accounts with tweet notifications on, decrypts them and posts to a webhook; X API only at registration, no scraping. Possible use: new artist tweets flow straight into the Lakomics capture inbox (today the `extension-list` collector's job). Concerns: it needs the X session cookies `auth_token`/`ct0` (account-equivalent secrets; must use the app credential store), unofficial-client ToS/account risk, and only notification-enabled accounts are covered (no backfill).
- **Idea — auto series grouping in 북마크 (user 2026-10-04):** group bookmarked works of the same series (volumes/parts of one title) automatically in the 북마크 view. Not scheduled; decide how a series is recognised (catalog series/parody tags, title stem, same artist) before design.

<a id="pc-polish-20261002--remaining-polish-and-acceptance"></a>
## PC-POLISH-20261002 — Remaining notification feature

Status: `TODO` — native ledger notifications; current reminders are in-app only (no notification plugin in `src-tauri`, checked 2026-10-12). Item 5 is in PERF; all implementation slices are archived and their acceptance was closed 2026-10-05. PC full-range month TOC remains absent, a limitation without approved new scope; memo conflicts retain copies, not per-item merging.

## AUDIT-20261003 — read-only audits of 2026-10-03 (left after the fix rounds)

Status: `TODO` — from four read-only audits at `d318e534` (commit review, Android native, PC idle CPU, server round 2). Fixed findings are recorded in their commits; these were deliberately left for later. Remaining claims are the auditors' and are (unverified 2026-10-10) unless a newer correction is stated; measure on the device/PC before optimising.

- **Android native (measure first):** startup does Notes DB setup, the first Picker JSON read (up to 96 MiB) on the UI thread (`MainActivity` onCreate/onResume, `PickerLibrary`) — ANR risk with big data; pause stops exchange/replica timers but not queued uploads/ZIPs, running downloads or replica page walks (`ExchangeService`, `AlbumReplicaService`); `LibraryDocumentsProvider` holds the global `CONNECTION_LOCK` during HTTP and page-cache writes, blocking the 4 media workers; exchange `outgoing` / `announced` history and the single executor queue grow for the session; Notes status decrypts and returns every body each sync; a full 3 GiB thumbnail cache re-sorts every file on each miss; `signal.cancel()` disconnects sockets on the UI thread in onPause/onStop.
- **Server:** ticket executor threads are joined without a deadline at shutdown (a hung HEAD/DNS outlives the 6 s bound); thumbnail temp objects/sessions and CAS-lost final objects are never collected (manual CLI only); search suggestions normalise the whole vocabulary per keystroke and catalog fallback pages build the matching set twice; personal-edit/noop history and refresh receipts have no retention; `library_thumbnails.py` scans all keys at every start. The 14-day deletion of old `library/{id}/thumbnail` objects is not implemented yet (see PERF-ALL-001).
- Resolved slices are archived: thumbnail-cache restoration off the UI thread (`06f00160`), PC idle findings (2026-10-03).

<a id="external-refs-20261002--external-projects-worth-borrowing-from-reference-list"></a>
## EXTERNAL-REFS-20261002 — Optional external references

Status: `IDEA` — user-shared survey 2026-10-02, not adoption. Later candidates: Actual recurring-date/history semantics and remaining-spend display; Playnite per-field provider preview/preservation; FiftyOne failure analysis; LocalSend transport is its own item (`TRANSFER-001`).
Reader gesture/loading references: Mihon (no resume/following features); writing/search/revisit: usememos, fml, meguri; optional PySceneDetect, damaged-file checks, gallery-dl/Stash ideas-only, nowinandroid metadata flow, Tink AEAD review, restic backups, tus only for demonstrated retry pain. No installs implied.
`fast_image_resize` is not adopted (resize 13.6%, below 25% measurement bar); static-WebP decode optimisation is done (`59c95ff0`). sqlite-vec, imgutils clustering and mismatched CSD weights are not new trials; TanStack Virtual already exists; larger taggers require same-sample comparisons.

<a id="stats-001--personal-statistics"></a>
## STATS-001 — Metric definitions

Status: `PARTIAL` — clarify any remaining inventory/recorded-era metric definitions (unverified 2026-10-10); never infer activity from file timestamps. Source exists; native acceptance was closed 2026-10-05.

# Browser collector — `extension-list/` ("Lakomics Companion" 3.5.64)

Since 2026-10-12 the collector is named **Lakomics Companion** (current source manifest 3.5.64; checked 2026-10-22). Delivered work is recorded in the archive: X translation port, stuck fix and speed; YouTube subtitles with a server cache; custom right-click menu; image-text and page-body translation. The separate standalone extension `V:\yt-subs` ("자막다듬이" 1.0.2, its own git repo) stays independent; the collector hides its own YouTube button when the standalone one is on the page. Source rules: `extension-list/AGENTS.md`; behavior: [extension-list/README.md](../../extension-list/README.md).

<a id="collector-translate-001--context-aware-web-page-translation"></a>
## COLLECTOR-TRANSLATE-001 — Context-aware web page translation in the collector (2026-10-12)

Status: `PARTIAL` — user 2026-10-12: translate foreign (mainly Japanese) text into natural Korean, better than the browser's built-in translation. Delivered in the collector (see the archive): shared translation core with Korean rules and user dictionary, X posts, right-click selection translation, image-text translation and page-body translation. 3.5.28–3.5.29 (`1ef5f0e5`) added in-place whole-page translation, viewport-first and later-content handling, original text on hover/long-press, a shared cache and usage by feature (today/month/total and recent jobs). Remaining:
- **Constraint (user 2026-10-12):** text in images only for images the user explicitly picks — never automatic for every image on a page.
- **Cost:** the user found Claude Haiku already reads image text well; the estimate ~0.02–0.05 ¢ per image on Haiku 5.5 is unmeasured — measure on real images before promising costs. The 3.5.28 soft cap of 800 blocks with "계속 번역" partly bounds long-page work; it is not a monetary spending cap. Per-feature usage and the page-run cost are visible in 3.5.29 (`1ef5f0e5`).
- **Open:** broader per-site caching beyond the shipped shared text cache and per-tab image cache; further coexistence checks for later page changes and capture UI under `extension-list/AGENTS.md`. Real-browser behavior was confirmed by the user on 2026-10-12. Hotlink-protected images: `COLLECTOR-IMGTEXT-001`.

<a id="collector-imgtext-001--hotlink-protected-image-text-translation"></a>
## COLLECTOR-IMGTEXT-001 — Image-text translation for hotlink-protected images (2026-10-12)

Status: `PARTIAL` — image-text translation (`08f9cf62`) has the service worker fetch the image (https, no cookies, 8 MB, `image/*`, no SVG) with a canvas fallback for blocked fetches. Pixiv is delivered in 3.5.16 (`6de9c6f2`) by adding the pixiv Referer to the extension's own image requests; other hotlink-protected hosts remain open. Proposed: capture the visible image region with `tabs.captureVisibleTab` and crop it instead of fetching; the user must still pick the image explicitly. Open: scroll/viewport handling for images larger than the screen, device-pixel-ratio crop accuracy, the `activeTab`/permission impact, and whether the crop is sent only after the user's click.


## LOCAL-ASR-001 — Local Japanese speech recognition (Kotoba-whisper) beyond YouTube (2026-10-13)

Status: `IDEA` (user, 2026-10-13). Background: Kotoba-whisper v2.0 (faster-whisper, float16) runs on the main PC's RTX 5070 Ti at about 4 GB VRAM and a real-time factor of 0.02–0.03 (a 14-minute video in about 28 s); on the user's sample videos it was clearly better than YouTube's Japanese auto-captions. Trial environment in `C:\laku\asr`; the PC-only YouTube caption source shipped in `b6bd9b03` (extension 3.5.34, `_tools/asr/`): Kotoba transcription, audio-based speaker colours, retranslation and per-video source choice; server speaker storage is `98f913ce`. Ideas to add after that has been used in practice:
1. **Library video subtitles** — Japanese subtitles plus Korean translation for collected videos (e.g. X clips), shown in the video viewer.
2. **Search by speech** — keep transcripts so videos can be found by what is said in them.
3. **Other video sites** — let the collector send audio from non-YouTube players to the same PC server.
3. **Tablet** — the PC transcribes videos watched on the tablet and the tablet receives the result through the server's saved subtitles.
Model note: v2.2 (punctuation and speaker diarization) has no CTranslate2 build; try it only if sentence splitting turns out to be a problem. `kotoba-whisper-bilingual` was ruled out (its direct translation is only Japanese↔English; no published Japanese accuracy gain).


<a id="collector-radar-001--image-based-already-have-and-taste-match-marks-on-x"></a>
## COLLECTOR-RADAR-001 — Image-based "already have" and taste-match marks on X

Status: `IDEA` — user 2026-10-03 liked this one among the brainstormed tools; not approved for implementation, do not start until the user explicitly asks.
While browsing X, the collector marks each image as already in the library by image content, not only by URL, so reposts from other accounts are caught; it may also show a taste-match score based on the library. Today's saved marks are URL-based only (`extension-list/src/x-gallery.js` `savedMedia`). Reuse the PC similarity and artist-style data through the existing collector ↔ PC connection; the score's definition and privacy of what is sent stay open.
Not chosen 2026-10-03 (judged impractical): source-loss monitoring, reverse-search quality upgrade, bookstore barcode check, yearly recap, tablet photo-frame mode.

# Platform and batch work

## LINUX-DESKTOP-001 — Deeper CachyOS / KDE Plasma integration

Status: `TODO` — user 2026-10-04 asked for deeper integration with the Linux PC (CachyOS, KDE Plasma 6 on Wayland). The dated record says dev-only, with no installed package/launcher; current machine state is (unverified 2026-10-10). Existing integration: close-to-tray, KDE Wallet via Secret Service, and the build-cache cleanup timer. All items are Linux-only additions; Windows behaviour must not change. Suggested order: 1 → 2 → 7 → 5, others as wanted. Note 2026-10-12: the main PC has been Windows since 2026-10-04 (see `docs/operations/windows-desktop.md`); this item concerns the Linux machine only.
- **Tier 1 — basics:**
  1. Arch package (PKGBUILD wrapping the release build): launcher/taskbar icon, `.desktop` entry, updates through `pacman`. Groundwork for the rest; release builds stay on request.
  2. Start at login minimised to the tray (XDG autostart), so receiving for 전송 is ready without opening the app.
  3. Native notifications in the Plasma notification centre (receive done, sync done, errors); overlaps the native-notification item in `PC-POLISH-20261002`.
  4. Inhibit screen blanking/sleep while the viewer or a video is open (portal Inhibit).
- **Tier 2 — KDE-native:**
  5. KRunner search (D-Bus runner): Alt+Space, type a title, open that work in Lakomics.
  6. Dolphin service menu: "Lakomics로 가져오기" on folders/archives; optional "Lakomics로 열기" for cbz/zip.
  7. `lakomics://` deep links plus single-instance, so links, KRunner and Dolphin route to the running window instead of opening a second one. Needed by 5 and 6.
  8. Global shortcut (portal GlobalShortcuts) to show/hide the window, rebindable in Plasma settings.
- **Not recommended:** a Plasma "continue reading" widget (the user rarely resumes reading) and KDE Connect integration (overlaps 전송 / `TRANSFER-001`).
- **Open questions before building:** design the D-Bus/deep-link surface once for 5–7; check portal support under the current Plasma version; keep runtime library resolution (no production path in the package or service files).

## GPU-BATCH-001 — Main-PC one-off heavy backfills

Status: `PARTIAL` — user 2026-10-04: use the new main PC (RTX 5070 Ti 16 GB, 12 threads, 23 GB) for heavy one-off work over the whole library (~9,073 images, 459 videos) that would be slow on the laptop; afterwards the laptop only keeps up with new items. Gate everything on the machine-local `performance.profile = "main"`; laptop behaviour unchanged. Library counts are from the restored DB on 2026-10-04. Completed PixAI/canary/Kaloscope and B36 runs are in the [archive](lakomics-completed.md#closure-checkpoint--2026-10-10--backlog-reconciliation); do not rerun them to reconcile this document.
- **S36 prerequisite:** the 2026-10-07 record establishes incomplete S36 coverage and approval to top up. Current coverage is (unverified 2026-10-10); do not infer it from the completed B36 run.
- **Suggested order: 2 → 3.**
  2. **Video similarity fingerprints — status 2026-10-07 (read-only check): needs implementation (no backfill command found in `video_similarity/` on 2026-10-12).** 0 of 472 normal videos have fingerprints (`video_similarity_fingerprints` = 0, no scans yet). Fingerprints are only computed on demand inside a review scan (`video_similarity/scan.rs`: 2–100 IDs, one 600 s deadline per scan, 60 s per video, serialized by `video_lock`). Smallest next step: a main-profile-only backfill command looping `fingerprint_video_source` over unfingerprinted videos (N=2 bounded gate, resumable 600 s windows, `-threads 1`, test `-filter_threads 1`), started from a button beside the performance selector, no auto-run. NVDEC not adopted (no identity proof); the fingerprint cache is keyed by the FFmpeg binary hash, so laptop and main PC do not share fingerprints; the contract (frame size, 12 samples/video) must stay identical.
  3. **Unknown-character grouping — status 2026-10-07: tool exists (`character-runtime/candidate_groups.py`, top-k kNN + Chinese Whispers, ~10 s on CPU, writes a JSON/HTML report under `.cache/characters/candidate-groups/`); no completed run on this library is documented (unverified 2026-10-10).** S36 features covered 8,684 of 9,227 images; the user approved (2026-10-07) topping them up with `s36_library_cache.py` and running the grouping. Showing groups in the app would be new work. Original idea: pairwise CCIP comparison over the whole library with Chinese Whispers (chosen in [OSS trial](../research/oss-trial-sqlitevec-ccip-20260926.md)); GPU for the N×N similarity.
- **Optional larger features:** text-to-image library search is now `NL-SEARCH-001`; upscaling for low-resolution manga pages. **Also possible later:** NVENC for Linux video proxies (`libx264` today) and CUDA for live CCIP inference — both need equivalence/feature-identity decisions first.
- **Live character scan on GPU (DirectML) — `DONE` 2026-10-12 (committed `653bd05e`):** user approved; Windows main profile passes `--gpu` (lightweight/restricted and Linux stay CPU; Linux has an AMD iGPU, CPU by decision). DirectML sessions live in `character-runtime/gpu_providers.py`, outside the hashed extraction code, so CPU feature identities are unchanged. `feature_equivalence.py --gpu` accepts float rounding only (identical boxes, max diff ≤ 2e-3, cosine ≥ 0.99999); on 200+200 samples max diff 1.35e-3 B36 / 1.05e-5 S36, and the receipt was written to the machine-local `cache-compatibility.json` / `s36-compatibility.json` (backups in the 2026-10-12 session scratchpad). The app's `character-runtime.json` now points at `C:\laku\character-venv-gpu`. Release build checked: the worker runs with `--gpu`, ~1.3 reconsideration jobs/s versus ~0.3/s on CPU. Open: GPU utilisation stays low (the worker is not GPU-bound), pytest is missing so `test_feature_equivalence.py` was not run. Earlier measurement:  the Windows scanner runs CPU-only (`character-venv` has CPU onnxruntime 1.29.0; every session hard-codes `CPUExecutionProvider`). Experiment on 200 random library images (separate venv `C:\laku\character-venv-gpu`, onnxruntime-directml 1.24.4; no library writes; a concurrent CPU scan made CPU numbers pessimistic): end-to-end extraction median 1428 ms CPU → 178 ms DirectML (~8×; 200 images 397 s → 48 s; whole-PC CPU ~78 % → ~24 %). Results: identical box counts on all 200, box IoU ≥ 0.999997, B36/S36 cosine 1.0 (max coordinate diff 7.4e-4 / 1.1e-5), 0 flipped decisions over 19,900 image pairs, 63,233 crop pairs and 200 real `Runtime.compare` checks at the production threshold; S36 membership flips not testable (no universal threshold). Implementation questions: main-profile-only provider choice; DirectML caps onnxruntime at 1.24.x, and the feature-cache fingerprint includes the onnxruntime version and `runtime.py` source, so switching re-extracts the library once unless the fingerprint is decoupled; a Linux main PC would need CUDA instead. Report and scripts were in the 2026-10-09 session scratchpad (not kept); these claims are (unverified 2026-10-10), not a committed benchmark or approval to switch.

<a id="nl-search-001--korean-natural-language-image-search"></a>
## NL-SEARCH-001 — Korean natural-language image search (main PC)

Status: `PAUSED` — paused by the user on 2026-10-17 because natural-language search is rarely used. Code, schema, captions, embeddings and publication checkpoints are retained. Earlier PC/tablet delivery and acceptance remain historical; no further analysis or rollout is requested.
- **Single pause switch:** `_tools/app/nl-search-runtime/enabled.json` is `false`. The desktop and tablet consume the same file at build time; Python jobs read it at startup. Set it to `true`, rebuild/restart the desktop and rebuild/install the tablet frontend to re-enable; subsequent scheduled Python runs resume from the retained state. Keep the flag and runtime resources together when packaging.
- **Paused behaviour:** standalone `nl_caption.py`, `nl_index.py` and `nl_query_worker.py` exit successfully before importing model dependencies or opening library/state files; the PC skips NL inbox imports and caption publication/verification/pending indicators, and rejects query-worker startup through the native commands. Both find sheets hide scene/content results and the PC scene shortcut; normal name/tag/folder search remains. There was no dedicated user-facing NL enable toggle/settings row; precise mode is machine runtime configuration only. Feature-on UI tests explicitly mock the switch; core ranking/import/publication fixture tests remain runnable.
- **Operations update (controller record, 2026-10-18):** Task Scheduler "Lakomics NL index" and "Lakomics HDD backup" now launch through `C:\laku\scripts\run-hidden.vbs` without console windows. Machine setup only; not rechecked here and does not resume paused NL analysis.
- **Machine job audit (read-only, 2026-10-17; the wrapper update above supersedes its launch-visibility uncertainty):** `C:\laku\scripts\nl-index-nightly.ps1` points at this checkout's runtime, runs captions then indexing, and also runs `tagger-nightly.ps1`. Do not disable the whole scheduled task: that would stop automatic tags too. Python entry-point guards pause only NL analysis. Task registration and Python command lines could not be inspected (Task Scheduler/WMI access denied); already-running NL processes and other machine copies were not confirmed or stopped. The script's recorded comment lists 14:00, 17:00 and 22:00; actual registration is unverified. The scheduled wrapper may still write its normal log and run auto tags.
- **Server audit:** `server/lakomics-api/library_description.py` registers publisher `PUT /v1/library/captions` and client `GET /v1/library/search/description`; it stores PC-produced captions/names and ranks them synchronously on request (no model). No autonomous caption/embedding job was found in the inspected server registration/module or repository scripts. Server code and deployment are unchanged; retained endpoints remain available to older clients. No server deploy is needed to stop the inspected analysis pipeline. If endpoint suspension is desired as well, propose guards in `library_description.register` that return a paused response without deleting tables, then deploy separately. Live server processes/schedules were not inspected.

- **Decided (user, 2026-10-04):**
  - **v1 search:** names from the library's character targets (with their series folder names) go to auto-tag scores. Every other query is translated with opus-mt-ko-en and embedded with SigLIP2 so400m on CPU, then ranked by cosine against precomputed image vectors (P@10 0.68 on 32 Korean queries).
  - **Precise mode:** Qwen3-VL-Embedding-8B image vectors are built too. Precise search (GPU at query time, about 4.8 GiB) is an optional setting (P@10 0.72).
  - **Platforms:** main PC only for now. Laptop and video come later.
  - **Tablet (decided 2026-10-05, option A):** server-side text search with no model at query time. Names go through the same character-name dictionary to the already published auto tags. Everything else runs over the Korean captions published to the server (Hangul-pair BM25), so the PC can be off. Measured P@10 0.55 against 0.68 on the PC; weak on mood and expression queries. The PC publishes captions (about 3 MB for 9k images); new images need captions from the main-PC nightly job. The tablet UI follows the PC option A, with a preview strip in the find sheet and a result state. Later options, not chosen: an int8 SigLIP text model on the VPS (1.6 GB RAM; needs measurement), or relaying to the main PC while it is on.
  - **UI:** option A from the mockup. The 찾기 palette gets an "이미지 내용" group with a strip of the top 7 results. The strip updates after a typing pause of about 0.4 s and after Hangul composition ends, never per keystroke, and keeps the old strip until the next one is ready. Enter opens a "내용 검색" result state in 에셋 with 검색 해제. Mockup: [prototype README](../prototypes/nl-search-20261004/README.md).
- **Architecture:** same as artist style. A machine-local GPU job (`_tools/app/nl-search-runtime/nl_index.py`) writes `nl-search-latest.sqlite` into the auto-tag inbox. The app imports it into `<library>/.cache/nl-search/` (disposable, PC-only, never published). Rust ranks the results. A Python query worker (`nl_query_worker.py`, newline-delimited JSON) starts when the palette opens and stops after 30 idle minutes.
- **Recorded machine setup:** inbox `C:\laku\lakomics-inbox`, daily 14:00 task "Lakomics NL index" (moved from 17:00 by the user 2026-10-11), `C:\laku\scripts\nl-index-nightly.ps1`, state `C:\laku\nlsearch-state`, new images only. Actual current schedule and caption completion are (unverified 2026-10-10), not established from this repository.
- **Caption lane (implemented 2026-10-10, `6e8e6adf`; real captioning, live PUT and tablet display unverified):** `nl-search-runtime/nl_caption.py` (Qwen3-VL-8B NF4; bounded per night: `--limit 2000 --max-seconds 3600`; seeded from the 9,103 trial captions in `captions.jsonl`; dry run found 258 images missing) runs before `nl_index.py` in `nl-index-nightly.ps1` (failure does not block indexing); the export gains a `captions` table; the PC imports it and `library/caption_publication.rs` (migration 0126) publishes on the autoTags lane in digest-acknowledged batches of ~1,000 rows, ≤4 requests per tick, explicit deletions, 6 h re-verification. Server route `GET /v1/library/search/description?q=` (Hangul-pair BM25, character-name dictionary, 60 % vocabulary gate with a force flag) and the tablet find-sheet strip/result state ("그래도 가장 비슷한 그림 보기") are in `d1ac6a17`; until captions are published the tablet shows "아직 준비 중".
- **Later:** inspector description and image-type filter from the captions; precise-mode setting in Settings; laptop query side, needing a smaller text model (the query worker holds about 4.1 GB RAM because the SigLIP text tower is fp32; new images need the main PC to index them); video.

## Removed as done (2026-10-18)

Moved to the [2026-10-18 checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-18--home-cards-tablet-structure-and-performance): `HOME-CAL-001`, `HOME-REDESIGN-001`, `TABLET-STRUCT-001`, `FOLDER-NAV-001`, `SIM-ORIGINAL-001`, `CARD-GACHA-001` delivery, `CHAR-CONTAINER-001`, `COLLECTOR-TABLET-001`, `USER-FEEDBACK-20261009`, PERF-20261018 items 2–5 and related AV/catalog/reference fixes. Card performance measurement, conditional spine sharpness and other documented residuals remain active.

## Removed as done (2026-10-13)

Moved to the [latest 2026-10-13 checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-13--pc-feedback-jobs-reference-editor-and-resize) and the [earlier checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-13--claude-character-decisions-arca-picker-tablet-batches-and-motion); the earlier removal details are preserved in the [2026-10-12 checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-12--character-folders-video-and-worker-tooling).

- **Characters:** `CHAR-REF-OTHER-001`, `CHAR-FOLDER-PERF-001`.
- **Tablet:** `TABLET-TAB-BOUNCE-001`, `TABLET-CASE-LIFT-001`.
- **PC motion:** `PC-SERIES-SWITCH-BLANK-001`, `PC-REDUCED-MOTION-001`; manga selection flash is also closed.
- **Collector / viewer:** `YT-MOBILE-001`, `YT-SUB-TIMING-001`, `COLLECTOR-IMAGETEXT-001`, `VIEW-FILTER-001`, `COLLECTOR-PICKER-001`.
- **Review:** `PC-REVIEW-001`; the user closed both remaining findings.
- **Today's PC feedback:** `USER-FEEDBACK-20261013` items 1–13, `PC-RESIZE-FREEZE-001`, picker display publication, AV link labels and Windows test debt. Refresh-arrival motion and manga archive trash are source-complete; their native acceptance limits remain in the archive.
