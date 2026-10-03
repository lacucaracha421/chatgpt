# Lakomics Backlog

Living source of truth for **active** Lakomics work only. Completed and superseded records live in [lakomics-completed.md](lakomics-completed.md).

Reconciled 2026-10-03 against committed `main` at `adb00569`. Concurrent code edits are excluded. Source completion is separate from native/device acceptance and production rollout; uncertain claims are dated below. Removed records are indexed in the [reconciliation checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-03-backlog-reconciliation).

## Current priority

Updated 2026-10-03 at HEAD `adb00569`; order set by the user today. PC remains canonical; tablet follows in the same round.

1. **Finish the running round:** NSFW filtering on PC/server/tablet; catalog masking under both privacy mode and the NSFW filter; today's `AUDIT-20261003` fixes; server deployment. Concurrent implementation is outside this committed checkpoint.
2. **PERF-ALL-001:** measurements first — PC idle residue, PC Collections first open, tablet cold thumbnails/startup, and `PC-POLISH-20261002` item 5. `PERF-20261002`, `MOBILE-PERF-002` and Home measurements are consolidated here.
3. **USER-REQ-20260924 / USER-REQ-20260926B:** Collections authority slice 1, then tablet Collection creation. Only slice 0 exists (`c38a2bc`); design: [Collection authority](../research/collection-authority-design-20260924.md).
4. **TABLET-PARITY-001:** tablet Artist-tab rename/hide/edit with PC-equivalent behaviour.
5. **Remaining work, preserving the previous priority order:** Collections/manga acceptance → Home/artist/AV/calendar acceptance (`USER-REQ-20260927`, `HOME-DASH-001`) → release picker checks (`PC-RELEASE-FEEDBACK-20260929`) → remaining tablet parity → `ARTIST-SUGGEST-001` acceptance → `AUTO-TAG-001` approval → Windows gates (`PC-DECLUTTER-001`, `WIN-SYNC-001`, `VAULT-ENC-001`) → `PC-REVIEW-001` → `CLOUD-POST-001` → `PC-UI-001` / `ARTIST-001` acceptance → `HOME-OPT-001` test debt → `CHAR-AUTO-007`. Other low-priority and held requests retain their order below.

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

## RUNNING-ROUND-20261003 — NSFW filtering and rollout

Status: `IN_PROGRESS` — user priority 2026-10-03. Finish shared PC/server/tablet NSFW filtering and mask catalog covers/pages under either privacy mode or the NSFW filter; integrate today's audit fixes, then deploy the server under the running round's authorization.
Committed HEAD does not establish completion of the concurrent changes or deployment. Retain the PC-before-server upload compatibility order from `001b7bd8`.

<a id="perf-all-001--whole-app-benchmark-and-optimization-pass"></a>
<a id="mobile-perf-002--first-view-thumbnail-latency"></a>
<a id="perf-20261002--optimisation-phase-measurements-and-candidates"></a>
## PERF-ALL-001 — Measured performance pass

Status: `PARTIAL` — single performance lane, including `PERF-20261002`, `MOBILE-PERF-002`, `PC-POLISH-20261002` item 5 and `HOME-OPT-001` measurements. Follow [Performance work](../agents/implementation.md#performance-work); measure the real platform before changing it.

- **PC idle residue:** after `06b063ff`, `fcc1edac`, `c60dc0a6`, recorded quiet-release CPU fell 21% → 3.4% average; remaining 3–6% of a core is mostly the UI thread. Attribute window probes, idle pollers, hover frames and animation work; today's specific findings remain unchanged in `AUDIT-20261003`.
- **PC Collections first open:** `6d6c00e0` improved native test-library/debug first open 3.15 → 2.36 s, list-to-first-cover 1.94 → 1.32 s; warm reopen ~0.65 s. Measure the remaining cover/paint cost on the quiet target PC; do not reuse the pre-fix 1.7 s estimate as current.
- **Tablet cold thumbnails/startup:** measure first visits, cleared-cache/new-image cases, startup UI work, request counts/bytes and battery. `d8996552` / `4023d37a` implement immutable thumbnail keys; `0fb4afe0`, `15b33c62`, `8ba96f04`, `af8321ea`, `e85df550` implement cache, warming and catalog-entry improvements. Whole-migration completion and new cold-device timings are (unverified 2026-10-03).
- **PC-POLISH-20261002 item 5 / Home:** measure screen/type/section entry, long-list scrolling, viewer open/close, first useful Home paint, section requests and idle CPU on PC dev/release and tablet cold/warm. Recheck lightweight-mode gates (`05b18b6`, `bf40389b`, `f0e7153a`) and background battery cost against new features.
- **Remaining state cleanup:** move Collection release sync, personal-edit receipts and binding sync out of `notes_state` at a future planned migration; do not call the already-shipped migration 0098 a future migration. Committed `collection_release_sync.rs` still uses `notes_state`.
- **Measurement gap:** restore a native Notes scenario with a disposable Secret Service in the kit's private D-Bus; hidden-idle kit coverage remains unavailable. Use [native kit](../../_tools/app/scripts/native-check/README.md), [PC counters](../../_tools/app/scripts/perf/README.md), [tablet kit](../../android/tools/PERFORMANCE.md), [local API kit](../../server/lakomics-api/tools/PERFORMANCE.md).
- **Immutable-thumbnail cleanup:** after the recorded full-run start on 2026-10-02, wait at least 14 days and obtain separate approval before deleting only journaled old `library/{id}/thumbnail` objects; never delete prefixes containing originals. The full run `thumb-full` finished 2026-10-03 ~02:30 KST (8,960 committed, 0 errors; controller record), so deletion may be considered from ~2026-10-17; ID-only-cover revisions and DocumentsUI/Picker follow-ups remain optional (`server/lakomics-api/ASSET_SEARCH.md` and thumbnail contract source).

# Cloud / Mobile authority

<a id="cloud-post-001--서버-원천화-이후-클라이언트-구조-정리"></a>
## CLOUD-POST-001 — Remaining publication and client cleanup

Status: `PARTIAL` — decide Character/Collection ownership before replacing PC publication; retire manual controls, compatibility readers, staging or fences only after identifying a live replacement and recovery needs. `useMobilePublications` still serves unmigrated domains.
Preserve SQLite replica, workstation compute/filesystem state, durable intent and per-domain cursors/preferences. Completed authority cutovers and the user-closed `CLOUD-WORK-001`, `MOBILE-WRITE-002`, `MOBILE-003` are not new work.

## MOBILE-CACHE-001 — Android durable metadata replica

Status: `HOLD` — after change contracts stabilize, persist browse metadata, cursors and outgoing intents in a small local database; render committed local state before background updates. Keep the bounded binary media cache separate; derive Picker views from the replica and invalidate by server/library identity.

<a id="user-req-20260924--user-requests-2026-09-24-evening"></a>
## USER-REQ-20260924 — Collections authority slice 1

Status: `TODO` — only inactive server slice 0 (`c38a2bc`) exists. Implement slice 1 using [Collection authority design](../research/collection-authority-design-20260924.md); performance requests from this batch are consolidated in `PERF-ALL-001`.

<a id="user-req-20260926b--user-requests-2026-09-26-second-batch"></a>
## USER-REQ-20260926B — Tablet Collection creation

Status: `TODO` — implement tablet Collection creation after authority slice 1. Character creation stays PC-only by the user's 2026-09-27 decision; this item does not reopen it.

<a id="tablet-parity-001--bring-the-tablet-app-up-to-the-2026-09-27-pc-features"></a>
## TABLET-PARITY-001 — Remaining tablet parity

Status: `PARTIAL` — rename/hide/edit the Artist tab with PC-equivalent behaviour (priority 4, user 2026-10-03); committed `Artists.tsx` still directs these edits to PC.
- Add subtree folder listing, shelf thumbnail/count projection and true batch album/folder server operations; individual album commands and multi-selection classification already exist (`c60e57f9`, `f027836c`). Keep cursor/cache identity bound to subtree mode; do not repurpose direct `asset_count`. User 2026-09-29 approved server deployment for this scope.
- Next IGDB refetch, one-off TMDB 400 and leftover diagnostics are (unverified 2026-10-03). Keep release-calendar ownership on PC. Deep character classification remains PC-only; viewer single-asset editors remain, multi-select character assignment stays dropped (user 2026-09-29).

## SERVER-INDEP-001 — Move server-solvable PC work to the server

Status: `TODO` — user 2026-10-03: anything the server can own should stop waiting for the PC. Today the tablet sees PC-produced data only after the PC is on and publishes; tablet edits to PC-owned data wait as queued intents. The server is a 1-vCPU / 1.6 GB VPS, so model inference stays on the PC.
- **Already scheduled:** Collections authority slice 1 (`USER-REQ-20260924`, priority 3) and server-owned artist edits (`TABLET-PARITY-001`, priority 4).
- **Next, small:** apply tablet similarity keep/trash decisions on the server directly (Asset lifecycle is already server-owned, ADR-0038); apply tablet character assignment as a server classification move — first check how the PC learns from these decisions (S36 references, review receipts).
- **Then:** wishlist intents applied by the server (today `home_upcoming` waits for the PC to apply and republish); manga new-volume checks (Kakao/Aladin; the server already holds the Kakao key); MangaDex/Kakao binding requests and AV product-code lookups processed on the server; catalog visibility and duplicate-edition confirmation owned by the server.
- **Last:** release calendar provider fetch (IGDB/TMDB) on the server — needs server-side credentials set by the user. Home AV pick can move once Collections are server-owned.
- **Stays on the PC:** tagger/rating inference, character detection and S36, similarity features, artist-style analysis, FFmpeg video work, original files.

<a id="auto-tag-001--automatic-image-tags-and-tagger-character-signal"></a>
## AUTO-TAG-001 — Production import/apply gate

Status: `PARTIAL` — obtain explicit approval for production import/apply; preserve preview/apply and optional tagger review. Configured SQLite-inbox polling/import is implemented (`e88c21ff`, native workload hook), not a missing feature.
The machine-local nightly 03:00 pipeline runs only while awake/session-up, without missed-night catch-up (user 2026-09-27); whether its `.npz` output is automatically exported to the expected SQLite inbox is (unverified 2026-10-03). Keep quarterly model comparisons before switching; tablet tagger/registration remains dropped by the PC-only decision. [Research](../research/tagger-character-signal-20260927.md), `docs/prototypes/auto-tags-20260927/`.

<a id="tablet-feedback-20260928--tablet-real-use-feedback-2026-09-28-evening"></a>
## TABLET-FEEDBACK-20260928 — Residual tablet requests

Status: `PARTIAL` — compare Home's `마법소녀를 동경해서` thumbnail with the stable calendar path; separate memo `피드백` kind and tablet favourite-performer/Home parity are (unverified 2026-10-03). Catalog request optimisation is consolidated in PERF; its committed fixes are archived.
- **Catalog ownership (decided 2026-09-28):** PC should import server refresh additions while retaining its own catalog/publisher/updater; no committed PC import was found (unverified 2026-10-03).
- **Ledger import (`HOLD`, decided 2026-09-28):** resume with user-downloaded Naver Pay/card Excel/CSV, one parser per source and confirmation before saving; notification capture is optional later. No consumer API is assumed.

<a id="user-feedback-20260928b--second-feedback-batch-2026-09-28-night"></a>
## USER-FEEDBACK-20260928B — Remaining cross-client requests

Status: `PARTIAL` — implemented redesigns, manga cleanup UI, automatic edition merging and motion are archived; retain only the following gaps.
- **Safe undo:** authority-revision-conditional folder restore, consumed tagger candidate restoration and an explicit compensation decision; a simple restore can overwrite another device. Still unbuilt (unverified 2026-10-03).
- **Home AV:** favourite performers should open the performer route rather than AV Collections; AV new releases need a feed; tablet favourite-performer data parity remains (unverified 2026-10-03). Keep no-resume policy (user 2026-09-30): local manga starts at page 1, library video at 0:00; unused 0114 progress tables do not reopen resume.
- **Refresh motion:** new tiles arriving during refresh were requested to animate; the later accepted motion set only animates first load (`297891ea`, `97edc2c9`). Whether the earlier refresh-animation request was explicitly withdrawn is (unverified 2026-10-03); do not add it without reconciling the accepted rule.
- **Catalog review:** server automatic-decision origin labels, decision-log restart replay and PC decision reporting completeness need recheck (unverified 2026-10-03); `includesServerWorks=false` deliberately preserves server-only candidates, not unfinished behaviour.
- **Character panel (`HOLD`, user 2026-09-29):** after classification-flow cleanup, adjust regions on reference tiles with fixed panel order, one flagged-count line and stable controls (mockup F); [folder prototypes](../prototypes/pc-folders-20260929/).
- **Find / natural-language search:** keep the rail Find button and later improve convenience (decided 2026-09-28). Natural-language search stays `HOLD` because auto tags work; [SigLIP2 trial](../research/oss-trial-clip-20260927.md), tag translation first and model fallback only after a decision.
- **Light theme (`HOLD`, decided 2026-09-28):** Settings choice, dark default, token-only light palette; [foundation palettes](../prototypes/design-foundation-20260928/part4.html).
- **Vanished manga folders:** UI is implemented (`4542a6b9`, `af2fd1a4`); production deletion still needs separate approval. Preserve user choice of selected records only with verified automatic backup (decided 2026-09-28).

<a id="pc-release-feedback-20260929--release-build-use-feedback-2026-09-29-evening"></a>
## PC-RELEASE-FEEDBACK-20260929 — Deferred calendar-cover latency

Status: `HOLD` — user deferred late PC calendar covers; no fix selected. Picker items 4–5 are in the consolidated acceptance section.

<a id="home-opt-001--home-optimisation-and-debugging-pass-pc-and-tablet"></a>
## HOME-OPT-001 — Residual test reliability

Status: `TODO` — make two parallel-run `src/app/App.test.tsx` cases deterministic or measure worker-count effects; also retain intermittent Albums, assetFilterUi, AssetGallery and library-root-switch failures from the user's 2026-10-01 report (unverified 2026-10-03). Passing reruns do not establish the scheduling cause.
Server `test_server_added_work_can_be_refreshed_and_survive_stale_pc` was intermittent on the VPS stage (2/3 failures, 2026-10-01); `198357b7` addresses a catalog refresh-count race, but equivalence to this failure is (unverified 2026-10-03). Home findings 1–8 are source-fixed; performance and acceptance are consolidated elsewhere.

<a id="pc-review-001--fix-findings-of-the-2026-09-25-pc-app-review"></a>
## PC-REVIEW-001 — Residual 2026-09-25 review findings

Status: `PARTIAL` — [review report](../research/pc-app-review-2026-09-25.md); already-fixed follow-ups are archived. These remaining claims are (unverified 2026-10-03):
- Asset restore/error-recovery and relation re-baseline edges; repeated content-hash mismatches; dropped lifecycle-intent detail; remaining non-trash sync UI-thread work.
- `empty_trash`/purge lock scope, TrashBrowser retention reset and authority-path purge guard re-review; IGDB screenshot hero labeling; Aladin/Kakao renumbering retry; long HEVC/ProRes limits; S36 rollback after trashing an automatic acceptance.
In-flight artwork cleanup race is fixed (`af2fd1a4`); this does not prove every purge/recovery edge accepted.

<a id="oss-scan-20260926--open-source-projects-worth-using-idea"></a>
## OSS-SCAN-20260926 — Optional bounded trials

Status: `HOLD` — no adoption implied. For a concrete need only: sqlite-vec/usearch; imgutils CCIP; PixAI; vPDQ; in-process ONNX via ort; komf/Mihon metadata; Litestream; es-hangul/Lindera search; ThumbHash; jxl-oxide; ffmpeg-sidecar; rusqlite_migration; manga-ocr/comic-translate; Real-CUGAN/Real-ESRGAN; KGen/TIPO/tag dictionaries; restic/kopia/rclone.
Existing trial results remain in [research](../research/reference-projects.md) and the completed checkpoint. Immich/Stash/lap/PhotoSwipe/lightbox references are optional; GPL/AGPL code is ideas-only, never copy. No installs, dependencies or production operations are authorized by this list.

<a id="ai-jev-002--jev-for-text-candidate-decisions-idea"></a>
## AI-JEV-002 — Text candidate decisions

Status: `IDEA` — user 2026-09-26, not started. Candidate order: Collection provider matching → edition ambiguity → owned-volume mapping → saved-post folder suggestions → ledger categories. Recheck API/pricing, obtain metadata-send consent and compare shadow mode with a deterministic baseline before adopting; [prior direction](../research/character-autonomy-and-jev-direction-20260921.md).

<a id="transfer-review-001--deferred-findings-of-the-2026-09-26-transfer-path-review"></a>
## TRANSFER-REVIEW-001 — Residual transfer design edges

Status: `TODO` — low priority. Scope catalog duplicate decisions by library identity as well as server address; resolve similarity-review withdrawal arriving after the PC log read but before feed PUT, leaving the asset in Trash (unverified 2026-10-03).
Live R2 Content-Length enforcement and transfer recovery checks are in consolidated acceptance; implemented bounds/paging/reclaim are archived.

<a id="server-review-20260924--remaining-judgment-calls-of-the-cloud-api-review"></a>
## SERVER-REVIEW-20260924 — Residual server judgment calls

Status: `TODO` — low priority; [review](../research/server-review-2026-09-24.md). Personal-edit/noop, character/similarity decision histories and observation-ledger retention still need review (unverified 2026-10-03); refresh-job pruning is implemented (`5c1b80d7`) and is not the same history.
Items 5 (legacy long memo conflict) and 9 (auth before body validation) are fixed (`67e0cd97`). Shared-token trash/restore matches the retained design; broader refusal-path acceptance is consolidated below.

<a id="mobile-ux-001--portrait-real-use-follow-up"></a>
## MOBILE-UX-001 — Deferred portrait investigations

Status: `HOLD` — landscape two-pane Library stays parked (user 2026-09-28: need unclear); begin from actual wide-content/stand/split-screen use if resumed. Dimensions, sidebar, filters, copying and duplicate-review source work are archived; older unconfirmed device checks are consolidated below.
Keep classification-capacity research bounded and on hold: inference stays on PC, with isolated model-memory/latency measurement before any VPS migration (unverified 2026-10-03). Actual model-file viewing and three-column root cards were dropped; physical covers remain sufficient.

# Character classification

<a id="char-auto-007--evidence-based-accuracy-plan-2026-09-23-re-analysis"></a>
## CHAR-AUTO-007 — S36 enablement and case follow-up

Status: `IN_PROGRESS` — enable/watch the recorded S36 results on the user's 백합 series and spot-check acceptances; no new extraction is required. Evaluator, shadow scoring/review and per-series live switch are implemented (`9b72e87e`, `7f9d7bef`, `d8546dba`, `bc8770df`, `c9e13eb1`, `f87a67f1`).
Retain 안조 follow-up: choose anchor regions for `e60e44a1` (#1/#2) and `90394071` (#4), add four manual acceptances as supporting references (unverified 2026-10-03). Keep manual truth, same-series competition and strict automatic guards; production enablement/writes need their own approval.

<a id="char-auto-008--multi-form-characters-and-reference-quality-hints"></a>
## CHAR-AUTO-008 — Multi-form reference hints

Status: `TODO` — measure first with the chronological evaluator. Explore user-confirmable form/outfit clusters and same-form voting; use at least six references per form as the existing workaround. Flag isolated references rather than a whole minority form.
Recheck 수나 `aeffff69`, `5c2ca1c1`, `ec4e8499` and 모니에 `720276e7`, `f29f450c`; thresholds need evaluator evidence. Multi-person competition is a later concrete-case follow-up (user 2026-09-24), not a permanent reopened accuracy pass.

# Similarity / media identity

<a id="similarity-003--similar-video-fingerprinting-and-review"></a>
## SIMILARITY-003 — Representative video validation and optional vPDQ

Status: `HOLD` — validate the existing implementation when real re-encode/resolution/trim/crop/watermark samples appear; do not fabricate a new architecture requirement. Audio optional; [execution record](../research/video-similarity-execution-plan-20260908.md).
User 2026-09-26 chose vPDQ later as opt-in, not replacement; [trial](../research/oss-trial-vpdq-20260926.md). Representative-sample acceptance remains deferred, not claimed.

<a id="perf-similarity--metric-index--bk-tree-gate"></a>
## PERF-SIMILARITY — Metric index gate

Status: `HOLD` — linear PDQ stays default; reopen only if representative 100k+/250k+ measurements or historical discovery show a material bottleneck.

# Works / Collections

<a id="long-001--av-metadatacover-acquisition-and-candidate-selection"></a>
## LONG-001 — AV lookup rollout and candidate acceptance

Status: `PARTIAL` — collector → server inbox → PC LibreDMM/Wikidata chooser exists (`67e0cd97`, `b9c4f89a`, `b00f3bfe`). Confirm the recorded deployment/PC migration status before selecting rollout work (unverified 2026-10-03); native candidate-flow acceptance is below.
User 2026-09-27 chose LibreDMM; DMM/FANZA affiliate API dropped (Korean geo/address barrier), JavLibrary browsing only. Keep explicit front/spine/back selection and manual artwork preservation, acquisition separate from application, no Vault coupling or second lifecycle. [Design](../research/av-link-design-20260927.md), [sources](../research/av-sources-20260926.md), `docs/prototypes/av-link-20260927/`.

# Catalog / optional providers

## CATALOG-002B — Optional Heliotrope coexistence

Status: `TODO` — low priority. VCK/kHentai stays default; isolate optional provider cache and verify page resolution separately from metadata. Disable/cache-clear preserves bookmarks/progress.

# Desktop UI follow-ups

<a id="pc-polish-20261002--remaining-polish-and-acceptance"></a>
## PC-POLISH-20261002 — Remaining notification feature

Status: `TODO` — native ledger notifications; current reminders are in-app only. Item 5 is in PERF; all implementation/acceptance slices are archived or consolidated below. PC full-range month TOC remains absent, a limitation without approved new scope; memo conflicts retain copies, not per-item merging.

## AUDIT-20261003 — read-only audits of 2026-10-03 (left after the fix rounds)

Status: `TODO` — from four read-only audits at `d318e534` (commit review, Android native, PC idle CPU, server round 2).
Fixed findings are recorded in their commits; these were deliberately left for later. Claims are the auditors'
unless marked verified; measure on the device/PC before optimising.

- **Android native (measure first):** startup does Notes DB setup, the full thumbnail-cache scan/journal restore and
  the first Picker JSON read (up to 96 MiB) on the UI thread (`MainActivity` onCreate/onResume, `ThumbnailCache`,
  `PickerLibrary`) — ANR risk with big data; pause stops exchange/replica timers but not queued uploads/ZIPs, running
  downloads or replica page walks (`ExchangeService`, `AlbumReplicaService`); `LibraryDocumentsProvider` holds the
  global `CONNECTION_LOCK` during HTTP and page-cache writes, blocking the 4 media workers; exchange `outgoing` /
  `announced` history and the single executor queue grow for the session; Notes status decrypts and returns every body
  each sync; a full 3 GiB thumbnail cache re-sorts every file on each miss; `signal.cancel()` disconnects sockets on
  the UI thread in onPause/onStop.
- **PC idle residue (follow-up to PERF-20261002):** verified — `workload.rs` asks the window `is_focused`/`is_visible`
  every second (each a main-loop round trip); `character_incremental_status` polls every 5 s idle,
  `cloud_backfill_progress` and `similarity_review_inbound_status` every 10 s even unfocused. Unverified: video hover
  preview keeps swapping frames every 720 ms after Alt-Tab if the pointer stays on a tile; `CollectionReleases` sets a
  fresh status object every 5 s; 48 px blur layer on the work screen and a permanent `will-change` on the filmstrip.
- **Server:** ticket executor threads are joined without a deadline at shutdown (a hung HEAD/DNS outlives the 6 s
  bound); thumbnail temp objects/sessions and CAS-lost final objects are never collected (manual CLI only); search
  suggestions normalise the whole vocabulary per keystroke and catalog fallback pages build the matching set twice;
  personal-edit/noop history and refresh receipts have no retention; `library_thumbnails.py` scans all keys at every
  start. The 14-day deletion of old `library/{id}/thumbnail` objects is not implemented yet (see PERF-20261002).

<a id="external-refs-20261002--external-projects-worth-borrowing-from-reference-list"></a>
## EXTERNAL-REFS-20261002 — Optional external references

Status: `IDEA` — user-shared survey 2026-10-02, not adoption. Later candidates: Actual recurring-date/history semantics and remaining-spend display; Playnite per-field provider preview/preservation; FiftyOne failure analysis; LocalSend fallback transport with existing hash/dedupe/trust checks.
Reader gesture/loading references: Mihon (no resume/following features); writing/search/revisit: usememos, fml, meguri; optional PySceneDetect, damaged-file checks, gallery-dl/Stash ideas-only, nowinandroid metadata flow, Tink AEAD review, restic backups, tus only for demonstrated retry pain. No installs implied.
`fast_image_resize` is not adopted (resize 13.6%, below 25% measurement bar); static-WebP decode optimisation is done (`59c95ff0`). sqlite-vec, imgutils clustering and mismatched CSD weights are not new trials; TanStack Virtual already exists; larger taggers require same-sample comparisons.

<a id="asset-eagle-20261001--pc-asset-screen-candidates-from-the-eagle-comparison"></a>
## ASSET-EAGLE-20261001 — Held Asset candidates

Status: `HOLD` — user 2026-10-01 parked until manga/polish finish; PC mockup required, [unfinished draft](../prototypes/pc-assets-eagle-20261001/) unreviewed. Keep candidate panel pin option, editable folder/character/tag chips plus rating/memo, and sidebar triage counts; the current dock alone does not prove these options finished (unverified 2026-10-03).
Thumbnail-size slider is superseded by user-chosen shared row-count control (2026-09-30). Colour palette/search remains later; preserve date-group counts, no decorative gradients or accent-outline selection.

<a id="stats-001--personal-statistics"></a>
## STATS-001 — Metric definitions

Status: `PARTIAL` — clarify any remaining inventory/recorded-era metric definitions (unverified 2026-10-03); never infer activity from file timestamps. Source exists; native acceptance is consolidated below.

<a id="idea-002--asset-date-timeline-exploration"></a>
## IDEA-002 — Date timeline exploration

Status: `HOLD` — no implementation until a concrete need exceeds the current date-grouped Library/Revisit.

## ACCEPTANCE — native PC / tablet / Windows checks pending

Status: `VERIFY` — source exists. Each line is a retained check, not new implementation, installation or claimed acceptance. Recorded prior confirmation applies only to its recorded revision/scope.

<a id="vault-enc-001--lakomics-encrypted-private-vault-adr-0039"></a>
- **VAULT-ENC-001:** Windows compile/real USB, Credential Manager, unlock/removal, video and same-letter card swaps (`cc917f65`, `17c10b72`); Linux real-USB acceptance recorded 2026-09-24/26. Original scan-error title/thumbnail preservation, full-image cache headers and per-tile-probe audit survivors are (unverified 2026-10-03); recheck the rewritten path only. ADR-0039.
<a id="win-sync-001--update-the-windows-pc-after-the-2026-09-24-changes"></a>
- **WIN-SYNC-001:** when Windows PC is available, update from pushed source; verify Collection publication handshake, vault, WebView2 FAULT originals (`4e4163a0`, `17c10b72`). Recorded production library minimum v109 is a historical lower bound, not a verified current schema; preserve authority fencing/salvage and migration backup.
<a id="home-dash-001--information-dashboard-home-tablet-first"></a>
<a id="user-req-20260927--pc-redesigns-and-fixes-requested-2026-09-27-evening"></a>
- **HOME-DASH-001 / USER-REQ-20260927:** PC Home, artist/review, AV/portrait, calendar and Settings (`60d4e3a6`, `532b7cc0`, `21b5aea1`, `48c8d2c8`); calendar stays PC-sourced. [Settings](../prototypes/settings-remake-20260929/), [calendar](../prototypes/release-calendar-20260929/).
- **TABLET-PARITY-001 / TABLET-FEEDBACK-20260928:** published performer profiles/portraits, Home parity and density after process restart (`d997b208`, `ea8e72e0`, `c60e57f9`); 0.8.85 confirmation covered the Asset port only.
<a id="artist-suggest-001--닮은-작가-후보-artist-suggestions-from-art-style"></a>
- **ARTIST-SUGGEST-001:** grouped suggestions, inspector, reposter flag and explicit assignment/dismissal (`e88c21ff`); user 2026-09-28 chose A+C+D, never automatic assignment. [Mockups](../prototypes/artist-style-suggest-20260928/index.html).
- **USER-FEEDBACK-20260928B:** PC/tablet memo caret/undo/sync-on-finish and reported sync-button re-render (`60d1429d`, `86f1b2d7`); no acceptance inferred from tests.
- **USER-FEEDBACK-20260928B — manga:** current native reader/sidebar, folder counts and cross-device pins (`4962f9bf`, `bdbfbfd2`, `4542a6b9`, `02319ffd`); [accepted A–D](../prototypes/pc-manga-20260929/). Production cleanup approval remains separate.
- **PC-RELEASE-FEEDBACK-20260929:** release picker items 4–5, series-scoped choices and visible all-series/unclassified behaviour (`d44edc0c`); user accepted only items 1–3 and 6–13 in the earlier release. [Folder D](../prototypes/pc-folders-20260929/).
<a id="section-bar-20261001--section-bar-on-pc-and-tablet"></a>
- **SECTION-BAR-20261001:** PC scroll-away/150 ms hover-drop/300 ms close/title toggle, narrow manga toolbar; tablet shade pull/bounce/thickness (`cc85d8ab`, `513581fa`, `00a2e8b3`); user 2026-10-01 rejected scroll-direction auto-hide and merging the title/section bars. [Design](../prototypes/section-bar-20261001/).
<a id="collection-shortcuts-20261001--tablet-collections-shortcut-row-and-overlays"></a>
- **COLLECTION-SHORTCUTS-20261001:** current one-row action placement, overlay dismissal/Back stacking/list restoration (`cc85d8ab`, `97edc2c9`); user accepted one-row revision `297891ea`, superseding the second shortcut row. [Original overlay spec](../prototypes/collection-shortcuts-20261001/README.md).
<a id="tablet-feedback-20261001--tablet-scrubber-feedback"></a>
- **TABLET-FEEDBACK-20261001:** scrubber B touch thickening/labels and Collections full-list scale stability (`c4d1819e`, `cc85d8ab`); [mockup](../prototypes/tablet-scrubber-20261001/).
<a id="asset-toc-20261001--query-toc-and-stable-tablet-scrubber-seeks"></a>
- **ASSET-TOC-20261001:** artist/character phase-2 dated sorting, seeks and query-generation consistency (`73d22496`); phase 1 was device-accepted 2026-10-01. Revisit/trash/catalog expansion stays dropped (user 2026-10-02).
- **HOME-OPT-001:** reserved heights, failed/empty/offline/retry states, counts and midnight/privacy races (`8fa77090`, `c9bc474b`, `71855626`, `7f3144f6`).
<a id="pc-declutter-001--pc-app-declutter-concepts-abc-staged"></a>
- **PC-DECLUTTER-001:** Windows rail/chrome/status/Settings/Home acceptance (`57a4fa85`, `532b7cc0`, `60d4e3a6`); [concepts A+B+C](../prototypes/pc-declutter-20260924/).
- **PC-REVIEW-001:** actual Asset restore/re-baseline, skipped exclusions, UI-thread relief, Windows leftovers/credentials and live IGDB (`7326f48d`, `24058df6`); retain residual source uncertainties above.
- **TRANSFER-REVIEW-001:** live R2 signed Content-Length refusal and transfer cursor/recovery/ZIP bounds (`0c2b7118`, `8443890c`); fixtures do not establish storage enforcement.
- **SERVER-REVIEW-20260924:** native/production similarity-kept Trash refusal (`8bb55420`, `39d9ed02`); rollout does not prove every edge accepted.
- **MOBILE-UX-001:** older unrecorded tablet copy/Back/icons/framing/catalog dialog/filter/search/Album/Character/duration checks and fresh PC-off capture/poster-v2/scheduled-refresh evidence (`49e9f224`, `a0782486`, `1a8ede19`, `6c0fd5ce`). Dimensions/repair are source/rollout-recorded; repaired thumbnails were user-confirmed, exhaustive interactions were not.
<a id="collection-view-20261001--manga-layouts-and-shelf-case-proportions"></a>
- **COLLECTION-VIEW-20261001:** three manga layouts/default shelf, matte title spine/depth, ledger G, AV rotation and small-case proportions (`cc85d8ab`, `57a23b5e`, `c552ff7d`, `678cc422`); manga-spine 30 px vs 44 px touch-target gap remains (unverified 2026-10-03). [Layouts](../prototypes/pc-collection-cases-20260930/), [ledger/detail](../prototypes/pc-collections-20260929/).
- **LONG-001:** collector code → inbox → LibreDMM candidates, Korean names and explicit cover selection (`67e0cd97`, `b9c4f89a`, `b00f3bfe`); deployment/migration status remains unverified above.
- **PC-POLISH-20261002 items 1–2, 6–9:** scrubber, dock/reflow, shortcuts, manga hide/search, zoom/reset/backdrops and tablet pinch/scroll (`b29bd44e`, `62e90091`, `5b8b51c0`, `97edc2c9`).
- **PC-POLISH-20261002 items 4, 10–12:** Find/More, memo IME/sections/undo, ledger/reminders and attention-first Home (`628b6da3`, `86f1b2d7`, `8fc0bd1f`, `71855626`); native notifications remain TODO above.
- **PC-POLISH-20261002 item 13 / likes:** first auto-tag publication/live tablet tags/filters and designated likes album convergence (`a8d19545`, `116875b1`, `260bdc6b`); earlier delivery does not accept later fixes.
<a id="audit-20261002--acceptance-after-source-fixes"></a>
- **AUDIT-20261002:** Windows case-only manga renames, viewer/IME/refresh, Android privacy/Back/record convergence, controlled upload/Notes/library rollout (`001b7bd8`, `eccb2ac4`, `af2fd1a4`, `6902ac36`); PC release precedes server upload hardening.
<a id="audit-20261002b--acceptance-after-source-fixes"></a>
- **AUDIT-20261002B:** document grants/exhausted retries, collector pairing/settings across servers, privacy/secret sections, ledger edits, Home NEW failures, tile keys/local month, cleared creators/unclassified Home (`c523900b`, `57b9b6e7`, `9079611b`, `71855626`). Album-tree grants still refused pending membership support; this is a compatibility limit, not restored browsing.
<a id="pc-ui-001--pc-ui-consistency-pass"></a>
- **PC-UI-001:** native visual items 5–7, 9–11 and current GalleryTile preview selection (`3cd97057`, `87e87e93`, `6902ac36`); [design decisions](../research/pc-ui-design-decisions-20260923.md). Preview update itself is (unverified 2026-10-03).
- **STATS-001:** native inventory/recorded-era figures (`7c72e41a`; retained historical stats records); metric definitions remain above.
<a id="artist-001--replace-revisit-tab-with-an-artist-hub"></a>
- **ARTIST-001:** PC source-fill preview/apply, conservative merge, pins/hide/display names and PC-authoritative links (`57a4fa85`, `532b7cc0`, `b5c4eafa`); tablet editing is a separate open implementation item.
