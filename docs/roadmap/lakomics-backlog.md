# Lakomics Backlog

Living source of truth for **active** Lakomics work only. Completed and superseded records live in [lakomics-completed.md](lakomics-completed.md).

Reconciled 2026-10-05 against committed `main` at `75f70dba` (today's commits, plus 2026-10-04 fixes where they close listed bullets); full reconciliation 2026-10-03 at `adb00569`. Concurrent code edits are excluded. Source completion is separate from native/device acceptance and production rollout; uncertain claims are dated below. Removed records are indexed in the [2026-10-03](lakomics-completed.md#closure-checkpoint--2026-10-03-backlog-reconciliation) and [2026-10-05](lakomics-completed.md#closure-checkpoint--2026-10-05--tablet-catch-up-ui-unification-phase-1-and-pc-speed) checkpoints.

## Current priority

Updated 2026-10-05: tablet catch-up (item 0) largely progressed today; order otherwise as set by the user on 2026-10-03/04. PC remains canonical; tablet follows in the same round.

0. **Tablet catch-up before Collections authority (user 2026-10-04):** source done — shared shelf/work-entry pieces, approved Home layout, motion phase 3, delayed busy labels and count parity shipped in Android 0.9.16 (`07af036e`), followed by 0.9.17–0.9.24 (0.9.21–0.9.24 installed on the tablet 2026-10-05). Left: the user's device check, then the in-progress round in `USER-FEEDBACK-20261005`, then resume Collections authority 1B (item 2).
1. **PERF-ALL-001:** measurements first — PC idle residue, PC Collections first open, tablet cold thumbnails/startup, and `PC-POLISH-20261002` item 5. `PERF-20261002`, `MOBILE-PERF-002` and Home measurements are consolidated here.
2. **USER-REQ-20260924 / USER-REQ-20260926B:** Collections authority slices 1B (PC write paths + first tablet editing UI) and 1C (separately authorized activation), then tablet Collection creation. 1A (verify-only baseline, `883a36a6`) shipped and deployed 2026-10-04; design: [Collection authority](../research/collection-authority-design-20260924.md).
3. **TABLET-PARITY-001:** artist slice 1 (rename/hide/pin, 숨긴 작가) shipped 2026-10-04 in tablet 0.9.15; merge/detach stay PC-only unless the user asks; remaining tablet parity items below.
4. **Remaining work, preserving the previous priority order:** Collections/manga acceptance → Home/artist/AV/calendar acceptance (`USER-REQ-20260927`, `HOME-DASH-001`) → release picker checks (`PC-RELEASE-FEEDBACK-20260929`) → remaining tablet parity → `ARTIST-SUGGEST-001` acceptance → `AUTO-TAG-001` approval → Windows gates (`PC-DECLUTTER-001`, `WIN-SYNC-001`, `VAULT-ENC-001`) → `PC-REVIEW-001` → `CLOUD-POST-001` → `PC-UI-001` / `ARTIST-001` acceptance → `HOME-OPT-001` test debt → `CHAR-AUTO-007`. Other low-priority and held requests retain their order below.

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

- **Done 2026-10-05 — PC folder switches and first Home load (source + `perf_probe`; native release timings pending):** thumbnail lookups use pooled read-only connections outside the library lock (~2.5 → ~0.15 ms each, concurrent; immutable revisioned URLs) (`c0e41223`); a folder switch waits only for first-screen tiles (e.g. 블아 278 → 56 images) and a 150 ms hover prefetches the folder's first page (`2eef344c`); series ↔ plain folder switches keep the painted view until the next is ready (`288ae552`); series suggestions (~140 ms) and sidebar counts (~60 ms) are cached across mounts and prefetched on hover (`01e48a31`). First Home no longer waits for the duplicate-edition scan (5.6–5.9 s per start → persisted count, ~26 ms on an unchanged restart); backup/trash maintenance start after the splash and the backup copies through a snapshot connection (reads during it 2.4–2.7 s → 6–21 ms) (`8431e063`). Probe scenarios `series_open` / `home` (`a093aa3b`). Remaining: release-build switch/first-Home timings on the target PC, plus the measurements below.
- **Done 2026-10-03 — PC idle residue:** quiet release, 10 min idle: 3.6 % → 1.6 % app (process median 1 %). Causes: ~12 publication threads spawned every 10 s with costly due checks (`0edba28c`, `7e2a83d8`), auto-tag publication re-walking all assets, Home bodies rebuilt every 60 s, review feeds every 5 min (`6025718e`), per-second window queries and unfocused pollers (`ffb44561`). Remaining ~1 %: catalog duplicate poll (60 s), AV link and a tokio worker; re-measure on the new PC.
- **PC Collections first open:** `6d6c00e0` improved native test-library/debug first open 3.15 → 2.36 s, list-to-first-cover 1.94 → 1.32 s; warm reopen ~0.65 s. Measure the remaining cover/paint cost on the quiet target PC; do not reuse the pre-fix 1.7 s estimate as current.
- **Tablet original open (2026-10-04):** 0.9.13 measured ticket 231 ms + download 120 ms because original-ticket warming was off (battery 37 % unplugged; native gate needs charging or ≥50 % without power saving, `MainActivity.java:80`). Warming already exists (`originalTicketWarm.ts`); next step is only URL-free warm hit/miss diagnostics. 0.9.14 re-measure deferred by the user.
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
- **1A (2026-10-04, `883a36a6`):** verify-only route `POST /v1/collections/authority/staging/verify` (staging v2, TEMP-table projection, digest-only report) and the PC Settings row "컬렉션 서버 이전 점검" with a PC-generated interop fixture. 1B inventory and user decisions (fence unsupported provider/import operations after activation, no type change under authority, tablet covers only from provider candidates via slice 2) are in the design doc §8. Open for 1B: `selectArtwork` updates selection slots but not the new per-artwork `selected` flag; a production dry run needs a server deploy (separate approval).

<a id="user-req-20260926b--user-requests-2026-09-26-second-batch"></a>
## USER-REQ-20260926B — Tablet Collection creation

Status: `TODO` — implement tablet Collection creation after authority slice 1. Character creation stays PC-only by the user's 2026-09-27 decision; this item does not reopen it.

<a id="tablet-parity-001--bring-the-tablet-app-up-to-the-2026-09-27-pc-features"></a>
## TABLET-PARITY-001 — Remaining tablet parity

Status: `PARTIAL` — rename/hide/edit the Artist tab with PC-equivalent behaviour (priority 4, user 2026-10-03); committed `Artists.tsx` still directs these edits to PC.
- **Slice 1 (2026-10-04, `02656706`):** tablet rename / hide / pin + 숨긴 작가 list via the artist intent log (server overlay; PC applies on its artists publication pass). The status head now wakes the PC pass and open PC artist screens refresh on `library://artists-changed` (`ebb5f59b`); native timing is (unverified 2026-10-05). Merge/detach stay PC-only.
- Add subtree folder listing, shelf thumbnail/count projection and true batch album/folder server operations; individual album commands and multi-selection classification already exist (`c60e57f9`, `f027836c`). Keep cursor/cache identity bound to subtree mode; do not repurpose direct `asset_count`. User 2026-09-29 approved server deployment for this scope.
- Next IGDB refetch, one-off TMDB 400 and leftover diagnostics are (unverified 2026-10-03). Keep release-calendar ownership on PC. Deep character classification remains PC-only; viewer single-asset editors remain, multi-select character assignment stays dropped (user 2026-09-29).

## TRANSFER-001 — LocalSend-style direct transfer first, server as fallback

Status: `TODO` — user 2026-10-03: add a LocalSend-style transfer path to 전송 (PC ↔ tablet file exchange) as the primary route, with today's server path (R2 exchange via the Cloud API, `ExchangeService` / `ExchangeView`) as the fallback. Supersedes the 2026-10-02 `EXTERNAL-REFS` note that had LocalSend only as a fallback.
- **Direct path:** discover the other device on the same network (LocalSend-style multicast announce + HTTP(S) registration; Tailscale address as a second candidate), pair once with the existing device identity, then send over an encrypted local HTTPS connection with resumable chunks. Keep the current hash/dedupe/trust checks, receive-folder rules and crash-safe receive on both ends.
- **Fallback:** when no direct peer answers within a short timeout (or the user is away from home), use the existing server exchange unchanged; the user sees one 전송 screen, not two features.
- **Clarified (user 2026-10-05):** on the same Wi-Fi, transfer goes directly (LocalSend-style) with relaxed size limits — speed is the goal; on a different network, the existing server path. Mainly Galaxy Tab ↔ PC, both send and receive.
- **Open questions before building:** Android background/foreground limits for a listening socket (the app is foreground-only today), Windows/Linux firewall prompts on the PC, whether to reuse LocalSend's protocol (interop with the LocalSend app) or a private one, and battery cost of discovery. Design first; PC first, tablet in the same round.

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
- **Find / natural-language search:** keep the rail Find button and later improve convenience (decided 2026-09-28). The natural-language search `HOLD` was lifted by the user on 2026-10-04; see `NL-SEARCH-001`.
- **Light theme (`HOLD`, decided 2026-09-28):** Settings choice, dark default, token-only light palette; [foundation palettes](../prototypes/design-foundation-20260928/part4.html).
- **Vanished manga folders:** UI is implemented (`4542a6b9`, `af2fd1a4`); production deletion still needs separate approval. Preserve user choice of selected records only with verified automatic backup (decided 2026-09-28).

<a id="pc-release-feedback-20260929--release-build-use-feedback-2026-09-29-evening"></a>
## PC-RELEASE-FEEDBACK-20260929 — Deferred calendar-cover latency

Status: `HOLD` — user deferred late PC calendar covers; no fix selected. Picker items 4–5 are in the consolidated acceptance section.

<a id="home-opt-001--home-optimisation-and-debugging-pass-pc-and-tablet"></a>
## HOME-OPT-001 — Residual test reliability

Status: `TODO` — make two parallel-run `src/app/App.test.tsx` cases deterministic or measure worker-count effects; also retain intermittent Albums, assetFilterUi, AssetGallery and library-root-switch failures from the user's 2026-10-01 report (unverified 2026-10-03). Passing reruns do not establish the scheduling cause.
Server `test_server_added_work_can_be_refreshed_and_survive_stale_pc` was intermittent on the VPS stage (2/3 failures, 2026-10-01); `198357b7` addresses a catalog refresh-count race, but equivalence to this failure is (unverified 2026-10-03). Home findings 1–8 are source-fixed; performance and acceptance are consolidated elsewhere.
Rust `thumbnail_maintenance::tests::apply_limit_is_resumable_and_skips_completed_files` failed repeatedly inside the Codex sandbox but passes in a normal shell (2026-10-05); find the sandbox-sensitive dependency (filesystem/timing) before trusting either result.

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

## USER-FEEDBACK-20261005 — Requests of 2026-10-05

Status: `IN_PROGRESS` — user requests and decisions of 2026-10-05; each bullet carries its own status. Requests delivered the same day are in the [2026-10-05 checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-05--tablet-catch-up-ui-unification-phase-1-and-pc-speed).
- **In progress (`IN_PROGRESS`, uncommitted at writing, 2026-10-05):**
  - Home: 다시보기 opens its destination directly; 지금 하는 중 shelf fixes (scrollbar, gap, cut edge).
  - Multi-person references: region-scoped references on assets owned by another character; whole-image references there stay blocked with a named hint.
  - Tagger review: a third decision "맞음 · 영역 틀림", and the review also covers the 오리지널 folder.
- **UI unification phase 2 — wording (`TODO`):** one wording per meaning on PC and tablet: 휴지통으로, 내 별점, 고정/좋아요, 검색 결과 없음, 빼기 vs 제거, 새로고침. Phase 1 (one icon family, shared IconButton/BookmarkToggle) shipped in `2eef344c`.
- **UI unification phase 3 — shared pieces (`TODO`):** Badge (count, scrim), SectionLabel, EmptyState, Skeleton, displayDate and DDay, shared by both clients.
- **Manga catalog single click (`TODO`, confirm with the user):** since `f9fe6c60` a single click on a work card is held ~500 ms to detect a double click before the detail opens; the user may prefer an immediate open.
- **Tag translations (`TODO`, later batch):** manga catalog tags are often long-winded paraphrases or untranslated, and some asset tags are untranslated; the user will collect examples first.
- **AV work screen disc (`HOLD`):** tapping the disc plays a disc-out animation and opens a site; waits until the user picks the site.
- **Decided, not planned:** Notes media attachments — option (b) chosen 2026-10-05: dropping files inserts their paths (`19ef652e`); real encrypted attachments (outside ADR-0035's scope) only if the user asks. Series folder 미분류/전체 stays an inline control above the gallery, not in 보기, by design; revisit only if the user asks.

## WIN-FEEDBACK-20261004 — First Windows release-run findings

Status: `PARTIAL` — reported by the user 2026-10-04 on the first Windows release build (`e8b3d774`, WebView2). Most bullets now have source fixes; close each only after a Windows release-build check.
- **Wrong Collection overview (found 2026-10-04, read-only):** 가치아쿠타 (`8a143d39…`) carries the MangaDex overview of 극락가 (Gokurakugai, same author Sano Yuto) while its Kakao volume data is correct; check the MangaDex binding and whether other works by the same author were matched to the wrong series.
- **Windows test debt:** the three `library::collection_source::tests::source_root_*` failures are fixed with native separators (`7c1dd0e5`). Server `tests.test_media_thumbnail_encode` `test_no_kind_leaves_a_partial_file_behind_on_an_unsupported_source` returns exit 7 instead of 4 under the WSL test venv (Pillow/codec environment; untouched code).
- **Abandoned thumbnail requests (found 2026-10-04, unverified natively):** `src-tauri/src/media_protocol_queue.rs` serves media-protocol thumbnail requests FIFO from a few slots and removing an `<img>` does not cancel its request, so after rapid tab/folder switches requests for views already left can queue ahead of visible ones. Not fixed (queue unchanged); mitigated by cheaper concurrent thumbnail lookups (`c0e41223`) and first-screen-only folder preloads (`2eef344c`). Check the request log during rapid switching and, if confirmed, drop or deprioritise requests whose view is gone.
- **No popping in (user 2026-10-04):** progressed — menus, dialogs, popovers, toasts, selection bar and tablet sheets ease in and out (`2748f0db`); first-screen tiles and late images appear together (`2eef344c`, `288ae552`); the launch mark covers the first Home load (`3dd73981`). Keep sweeping instant panels and late blocks found in use (≈150–250 ms ease-in, reduced motion respected; never fade from a blank frame where the no-flash rule applies).
- **Collections cache should survive (on hold — user 2026-10-04: seems fine after more use):** the user wanted the PC Collections screen to keep its cache instead of rebuilding it (compare `mobile-client` collection caching with the PC `collection_cache.rs` / frontend Collections loading and game-case bake cache).
- **Source fix; native check pending:**
  - **Starts in Saving Mode:** the launch label "절약 모드 해제 중" now waits for workload readiness (`1d9494b8`); whether the app actually entered the restricted state on Windows is unchecked.
  - **Tab ghosting / sidebar tab switch motion:** the old view stays until the new one is ready and is replaced in one frame (`1d9494b8`); sidebar, title and content switch together (`1d329325`); View Transitions tab switch (`07af036e`); the 망가 sidebar slides and morphs as one view transition (`6abacd47`, `288ae552`).
  - **Home tab delay:** Home stays mounted and refreshes in the background (`1d329325`); first Home load no longer waits for 중복 판본 (`8431e063`, see PERF-ALL-001).
  - **Shelf pop-in:** spine and cover reveal together (`7d118b1e`).
  - **쇼케이스:** count removed (`1d329325`); the PC showcase is laid out on the library shelf (`4d261d66`); type switches stay in the showcase and the tablet showcase gains type tabs (`3b3b2e8b`). Whether this meets the requested trayed-case display-shelf redesign needs the user's look.
  - **Delayed busy labels:** one shared helper (600 ms delay, 400 ms minimum) on PC and tablet, including the manga 로컬 scan label (`1d329325`, tablet `07af036e`).
  - **Tablet follow-up by sharing:** shared shelf/work-entry pieces in Android 0.9.16 (`07af036e`); 0.9.21–0.9.24 installed on the tablet. Tablet manga back synopsis/price still needs the volume fields in the replica (server work), a separate item.
  - **Asset folder switch bounce:** character-count space reserved (`1d329325`); a folder opened at the top no longer jumps (`2eef344c`); series ↔ plain switches swap in one step (`288ae552`); steady 미분류/전체 switch (`e643ec64`).
  - **Home fill — approved layout:** PC `2748f0db`, tablet `07af036e` (mockup `docs/prototypes/pc-home-fill-20261004/`, untracked; spec in the 2026-10-05 checkpoint).
  - **3D collection objects release check (1)–(6):** no hinge gap, no default spine flash, the work viewer waits for its artwork and record, stable shelf width, lifted items paint above neighbours, no cover snap after a lift (`1d329325`); that the last one covers (1) "front cover rises ahead of the case" is (unverified 2026-10-05).

## MANGA-CATALOG-FEEDBACK-20261004 — Manga catalog requests

Status: `TODO` — requested by the user 2026-10-04 (PC).
- **Source fix; native check pending:** 로컬 view settings dropped, no counts on the mode toggle, 폴더 스캔 중 on the shared delayed helper (`1d329325`); the 망가 tab counts as ready on its first list and stays mounted like Home (`2748f0db`).
- **Import local works:** add a way to bring works in from a local folder, supporting both archives and plain image folders (copy/move and destination decided below).
- **Local manga on the tablet via the server (user 2026-10-04):** the user wants local manga readable on the tablet; NSFW content on the server is already accepted (assets are there). Direction: the PC uploads local works to the server and the tablet gets a 로컬 source in the catalog, read with the existing catalog reader, available while the PC is off. Measured 2026-10-04 (read-only): VPS `/` 52 GB with 23 GB free; local manga root `C:\laku\2군` is 197 MB. Decided (user 2026-10-04): every local work uploads automatically; import MOVES the source into the manga root (not copy). Destination (user 2026-10-04): automatic — read the artist from the name (e.g. `[작가명] 제목`, circle/artist brackets) into that artist folder; ask only when no artist can be read. Show a preview of where each item moves and confirm before moving (moves are hard to undo). Scheduled after the Home fill round.
- **Selection flash (user 2026-10-04):** selecting a work in the Manga catalog makes its thumbnail flash briefly as the selection effect appears. Check whether the selection style changes the image layer (scale/filter/transform start or end causing a re-raster, as with the shelf lift fixed this round) or swaps the image source.
- **Idea — real-time artist tweets via Web Push (user 2026-10-04, not scheduled):** https://github.com/sh1ma/Angelic-Angel (Rust, MIT, 206★, last push 2026-03-05) emulates a Firefox Web Push client on Mozilla AutoPush to receive X notifications for followed accounts with tweet notifications on, decrypts them and posts to a webhook; X API only at registration, no scraping. Possible use: new artist tweets flow straight into the Lakomics capture inbox (today the `extension-list` collector's job). Concerns before any use: it needs the X session cookies `auth_token`/`ct0` (account-equivalent secrets; must use the app credential store), unofficial-client ToS/account risk, and only notification-enabled accounts are covered (no backfill).
- **Idea — auto series grouping in 북마크 (user 2026-10-04):** group bookmarked works that belong to the same series (volumes/parts of one title) automatically in the 북마크 view. Not scheduled; decide how a series is recognised (catalog series/parody tags, title stem, same artist) before design.

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
- **PC idle residue:** fixed 2026-10-03 (see PERF-ALL-001).
- **Server:** ticket executor threads are joined without a deadline at shutdown (a hung HEAD/DNS outlives the 6 s
  bound); thumbnail temp objects/sessions and CAS-lost final objects are never collected (manual CLI only); search
  suggestions normalise the whole vocabulary per keystroke and catalog fallback pages build the matching set twice;
  personal-edit/noop history and refresh receipts have no retention; `library_thumbnails.py` scans all keys at every
  start. The 14-day deletion of old `library/{id}/thumbnail` objects is not implemented yet (see PERF-20261002).

<a id="external-refs-20261002--external-projects-worth-borrowing-from-reference-list"></a>
## EXTERNAL-REFS-20261002 — Optional external references

Status: `IDEA` — user-shared survey 2026-10-02, not adoption. Later candidates: Actual recurring-date/history semantics and remaining-spend display; Playnite per-field provider preview/preservation; FiftyOne failure analysis; LocalSend transport is now its own item (`TRANSFER-001`, direct first, server fallback).
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

## LINUX-DESKTOP-001 — Deeper CachyOS / KDE Plasma integration

Status: `TODO` — user 2026-10-04 asked for deeper integration with the Linux PC (CachyOS, KDE Plasma 6 on Wayland). Today the app runs only as the dev build: no installed package or launcher entry. Existing integration: close-to-tray, KDE Wallet via Secret Service, and the build-cache cleanup timer. All items are Linux-only additions; Windows behaviour must not change. Suggested order: 1 → 2 → 7 → 5, others as wanted.
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

Status: `TODO` — user 2026-10-04: use the new main PC (RTX 5070 Ti 16 GB, 12 threads, 23 GB) for heavy one-off work over the whole library (~9,073 images, 459 videos) that would be slow on the laptop; afterwards the laptop only keeps up with new items. Gate everything on the machine-local `performance.profile = "main"`; laptop behaviour unchanged. Library counts below are from the restored DB on 2026-10-04.
- **Already done 2026-10-04:** full PixAI v1.0 / canary / Kaloscope re-run on GPU (0.2–0.4 s/image, pack-copy preprocessing, matches the prior DB to float16); exports placed in the auto-tag inbox; nightly tagger switched to the same pack copy.
- **Suggested order: 1 → 2 → 3.**
  1. **CCIP feature backfill (B36 + S36):** 6,826 of 9,073 images have B36 features (only `auto_classify` series were scanned). Fill the rest so history refresh and character tools cover the whole library. Run on CPU with more threads, not GPU, so vectors stay bit-identical to the cache and the equivalence receipts keep working (GPU output is not bit-identical).
  2. **Video similarity fingerprints:** 0 of 459 videos fingerprinted (12 samples/video, FFmpeg 1 decoder thread, serialized). Run several in parallel on the main PC and try NVDEC decode; the fingerprint contract (frame size, samples) must stay identical so laptop-made fingerprints compare.
  3. **Unknown-character grouping:** pairwise CCIP comparison over the whole library, grouping with Chinese Whispers (chosen in [OSS trial](../research/oss-trial-sqlitevec-ccip-20260926.md)); GPU for the N×N similarity. Needs 1.
- **Design notes (read-only study 2026-10-04):** 1 = new extraction-only `warm_features` op in `scan_worker.py` driven by the incremental owner (32/page, one Python owner, manual priority, Saving Mode wins, cache entries are the checkpoint); first prove S36 4-thread vectors are byte-identical to 2-thread and to the cache (ORT does not guarantee equality across thread counts). 2 = purpose-specific fingerprint backfill (not the 2–100-ID review scan), CPU only with N=2 bounded gate, resumable 600 s windows, keep `-threads 1` and test `-filter_threads 1`; NVDEC not adopted (no identity proof); fingerprint cache is keyed by the FFmpeg binary hash, so laptop and main PC do not share fingerprints. UI: two main-profile-only actions beside the performance selector, no auto-run.
- **Optional larger features:** text-to-image library search is now `NL-SEARCH-001` (vectors built 2026-10-04); upscaling for low-resolution manga pages.
- **Also possible later:** NVENC for Linux video proxies (`libx264` today) and CUDA for live CCIP inference — both need equivalence/feature-identity decisions first.

<a id="nl-search-001--korean-natural-language-image-search"></a>
## NL-SEARCH-001 — Korean natural-language image search (main PC)

Status: `PARTIAL` — PC shipped to main 2026-10-05; tablet option A is next. The user lifted the HOLD on 2026-10-04 after a GPU bake-off ([research](../research/nl-search-trial-20261004.md)).
- **Decided (user, 2026-10-04):**
  - **v1 search:** names from the library's character targets (with their series folder names) go to auto-tag scores. Every other query is translated with opus-mt-ko-en and embedded with SigLIP2 so400m on CPU, then ranked by cosine against precomputed image vectors (P@10 0.68 on 32 Korean queries).
  - **Precise mode:** Qwen3-VL-Embedding-8B image vectors are built too. Precise search (GPU at query time, about 4.8 GiB) is an optional setting (P@10 0.72).
  - **Platforms:** main PC only for now. Laptop and video come later.
  - **Tablet (decided 2026-10-05, option A):** server-side text search with no model at query time. Names go through the same character-name dictionary to the already published auto tags. Everything else runs over the Korean captions published to the server (Hangul-pair BM25), so the PC can be off. Measured P@10 0.55 against 0.68 on the PC; weak on mood and expression queries. The PC publishes captions (about 3 MB for 9k images). New images need captions from the main-PC nightly job. The tablet UI follows the PC option A, with a preview strip in the find sheet and a result state. Later options, not chosen: an int8 SigLIP text model on the VPS (1.6 GB RAM; needs measurement), or relaying to the main PC while it is on.
  - **UI:** option A from the mockup. The 찾기 palette gets an "이미지 내용" group with a strip of the top 7 results. The strip updates after a typing pause of about 0.4 s and after Hangul composition ends, never per keystroke, and keeps the old strip until the next one is ready. Enter opens a "내용 검색" result state in 에셋 with 검색 해제. Mockup: [prototype README](../prototypes/nl-search-20261004/README.md).
- **Architecture:** same as artist style. A machine-local GPU job (`_tools/app/nl-search-runtime/nl_index.py`) writes `nl-search-latest.sqlite` into the auto-tag inbox. The app imports it into `<library>/.cache/nl-search/` (disposable, PC-only, never published). Rust ranks the results. A Python query worker (`nl_query_worker.py`, newline-delimited JSON) starts when the palette opens and stops after 30 idle minutes.
- **PC done (2026-10-05, merged 7c7170d6 / 9e44fb2d):**
  - **Backend, palette and result UI:** done.
  - **Search behaviour:** a "no match" gate refuses nonsense queries; it needs 60 % of the query's units to appear in the caption vocabulary or the auto-tag words, and "그래도 가장 비슷한 그림 보기" overrides it. Searches replace each other instead of stacking. The 찾기 shortcut is now Ctrl+Q.
  - **Production check:** the dev app on the production library imported 9,139 SigLIP and Qwen vectors plus a 13,608-unit vocabulary without freezing the UI, and the user confirmed results.
  - **Follow-ups (2026-10-05):** release builds bundle the query worker (`9de785a2`); one Hangul syllable such as '밤' counts as a scene description (`d9a4d766`).
  - **Machine setup:** inbox `C:\laku\lakomics-inbox`. The task scheduler entry "Lakomics NL index" runs daily at 03:30 (`C:\laku\scripts\nl-index-nightly.ps1`, state `C:\laku\nlsearch-state`) and embeds new images only.
- **Next: tablet option A** (decided above; PC first, the tablet follows the PC design):
  1. **Captions on the main PC:** add Korean captioning (Qwen3-VL-8B NF4, batch 16, about 1.4 s/image) to the nightly job for images without captions. Seed it with the 9,103 trial captions (`C:\laku\nlsearch-state\captions.jsonl`). Export captions in the inbox file, so the vocabulary also stays current.
  2. **PC publication:** import the captions into a PC-only table or cache and publish them to the server through a publication lane like the auto-tag lane (digest-based, about 3 MB).
  3. **Server:** store the captions and add a search route, for example `GET /v1/library/search/description?q=`. Name tokens use the character-name dictionary and the published auto tags; other tokens use Hangul-pair BM25 over the captions; apply the same 60 % vocabulary gate, with a force flag. Add tests.
  4. **Tablet:** a NetworkPolicy allowlist entry for the new route. The find sheet gets an "이미지 내용" row with a preview strip (0.4 s pause, IME guard, no flash), and Enter opens a result state with 검색 해제 and "그래도 가장 비슷한 그림 보기".
  5. **Checks:** server tests, the tablet suite and a device check on the tablet.
- **Later:**
  - inspector description and image-type filter from the captions;
  - precise-mode setting in Settings;
  - laptop query side, needing a smaller text model;
  - video.
- **Laptop later:** the query worker holds about 4.1 GB RAM because the SigLIP text tower is fp32. New images need the main PC to index them.

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
