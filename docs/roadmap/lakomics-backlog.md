# Lakomics Backlog

Living source of truth for **active** Lakomics work only. Completed and superseded records live in [lakomics-completed.md](lakomics-completed.md).

Reconciled 2026-10-05 (night) against committed `main` at `223fac11`; full reconciliation 2026-10-03 at `adb00569`. Concurrent code edits are excluded. All pending native PC / tablet / Windows acceptance was closed by the user on 2026-10-05 after overall use of the current release build and tablet 0.9.26 ([night checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-05-night--ui-unification-phases-23-folder-move-motion-bookmarks-speed-and-acceptance-closure)); production rollout stays separate and uncertain claims are dated below. Removed records are indexed in the [2026-10-03](lakomics-completed.md#closure-checkpoint--2026-10-03-backlog-reconciliation), [2026-10-05](lakomics-completed.md#closure-checkpoint--2026-10-05--tablet-catch-up-ui-unification-phase-1-and-pc-speed) and [2026-10-05 (night)](lakomics-completed.md#closure-checkpoint--2026-10-05-night--ui-unification-phases-23-folder-move-motion-bookmarks-speed-and-acceptance-closure) checkpoints.

## Current priority

Updated 2026-10-05 (night): the tablet catch-up and the 2026-10-05 round are done and all pending device acceptance is closed (user 2026-10-05); order otherwise as set by the user on 2026-10-03/04. PC remains canonical; tablet follows in the same round.

1. **Next up:** done 2026-10-06 — newer views' thumbnails first (`90ae5664`) and tablet startup (`06f00160`, 0.9.28: launch to splash end ~3.1 s → ~1.5 s; stuck Home bar fixed in `acb79117`, 0.9.29). Continue with the order below.
2. **PERF-ALL-001:** PC release timings measured 2026-10-06 (below). First tab visits fixed 2026-10-06 (React lazy 300 ms Suspense throttle → idle preloading of tab code after Home settles): 컬렉션 425 → ~150 ms, 만화 553 → ~225 ms, 메모 358 → ~65 ms (release build, 4 launches; one 에셋 first visit outlier 1.07 s unexplained). PC start fixed 2026-10-06 (Home read reissue on collections arrival, sync IPC holding dispatch, TMDB/IGDB previews re-fetched every start → disk cache, non-Home startup work deferred until the splash leaves): warm launch Home data ~1.6-1.8 s → ~0.85 s, splash leaves ~2.4-2.6 s → ~1.03 s, Home fully shown ~2.7-2.9 s → ~1.29 s after page start (page starts ~0.25 s after the process; release build, 3 launches). Remaining: a background Home media re-read ~1.3-2.6 s after start; first launch after install still fetches previews. Next candidates: 태거 검토 series recommendations (~0.56 s backend), 만화 data (~0.15 s); remaining: PC idle residue on the new PC and `PC-POLISH-20261002` item 5. `PERF-20261002`, `MOBILE-PERF-002` and Home measurements are consolidated here.
3. **USER-REQ-20260924 / USER-REQ-20260926B:** Collections authority slices 1B (PC write paths + first tablet editing UI) and 1C (separately authorized activation), then tablet Collection creation. 1A (verify-only baseline, `883a36a6`) shipped and deployed 2026-10-04; design: [Collection authority](../research/collection-authority-design-20260924.md).
4. **TABLET-PARITY-001:** artist slice 1 (rename/hide/pin, 숨긴 작가) shipped 2026-10-04 in tablet 0.9.15; merge/detach stay PC-only unless the user asks; remaining tablet parity items below.
5. **Remaining work, preserving the previous priority order:** remaining tablet parity → `AUTO-TAG-001` approval → `PC-REVIEW-001` → `CLOUD-POST-001` → `HOME-OPT-001` test debt → `CHAR-AUTO-007`. Other low-priority and held requests retain their order below.

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
- **PC release timings (2026-10-06, Windows main PC, real library, release build 13:28, opt-in timing log, 3 launches):** launch → Home fully shown 2.9 / 3.0 s warm, 4.8 s first launch; first React render ~0.09 s, Home data ready ~1.6 s (3.5 s first launch), splash leaves ~2.4 s. Folder switch click → first-screen tiles shown: plain median 91 ms (p90 146), character 91 ms, series 163 ms (p90 262). Tab switch: Home 72 ms, 에셋 132 ms, 컬렉션 425 ms, 만화 553 ms, 메모 358 ms, 전송 354 ms, 관리 371 ms. Collections first open 0.47–0.52 s (was 2.36 s on the Linux debug test library, not comparable conditions); collections query 0.24–1.29 s (cold first). Backend `perf_probe` on a checkpointed copy: grid pages 8–42 ms, series browse 21–38 ms (`needs_review` 113 ms), series open from a plain folder ~245–270 ms cold (prefetched ~199 ms; suggestions 135 ms, character targets 75 ms, sidebar counts 56 ms), 태거 검토 `review_page_series_recommended` 563 ms; its 4.2 s library open is a copy artifact (no media files, 470 video resets). Tool: `LAKOMICS_PERF=1` timing log + `scripts/perf/pc-timing-summary.mjs`. Gaps: warm Collections reopen sometimes never reaches its cover signal and is logged as cancelled; the app leaves a ~54 MB `library.sqlite-wal` after a normal close, so `perf_probe` refuses the live library and needs a checkpointed copy.
- **Tablet original open (2026-10-04):** 0.9.13 measured ticket 231 ms + download 120 ms because original-ticket warming was off (battery 37 % unplugged; native gate needs charging or ≥50 % without power saving, `MainActivity.java:80`). Warming already exists (`originalTicketWarm.ts`); next step is only URL-free warm hit/miss diagnostics. 0.9.14 re-measure deferred by the user.
- **Tablet startup (done 2026-10-06):** opt-in startup timing (`619bf95c`, android/tools/PERFORMANCE.md "Startup"); 0.9.27 → 0.9.28 on the user's tablet, 3 cold starts each: Home ready 2.0–2.4 s → 0.75–0.91 s, splash end ~2.9–3.4 s → ~1.4–1.6 s after launch (persisted release-shelf input, first sync signal as baseline, bridge pool 6, thumbnail-cache restore off the UI thread). Left: 5 startup reads are still cancelled and reissued; uncached first launch still pages Collections.
- **Tablet startup requests (done 2026-10-06, 0.9.30, 3 cold starts each vs 0.9.29):** duplicate startup reads removed (status-object effect deps, two classification effects, double generation listeners; list-generation reads shared) and full Collections paging waits for Home's small reads: startup-window requests 49–51 → 35–38, cancelled 7 → 0, bridge queue wait median 95 → 0 ms (p90 397 → 292 ms), Home ready 0.89–0.92 → 0.72–0.89 s, splash end 1.31–1.35 → 1.14–1.32 s after page start. Uncached first launch still pages Collections before its first complete shelf, now after the small reads.
- **PC 동기화 점검 replication count (2026-10-06, read-only on a library copy):** "복제 완료 · 8,984 / 9,655 (93%)" — the 672 missing are all `browser_extension` captures collected since 2026-09-19 that have no PC upsert row, consistent with server-born Assets after the assets authority activation (inference; not checked against the server). The denominator counts every normal asset, so the bar can never reach 100 %. Count server-born Assets as present (or exclude them) in `cloud/backfill.rs` progress.
- **Tablet cold thumbnails:** measure first visits, cleared-cache/new-image cases, startup UI work, request counts/bytes and battery. `d8996552` / `4023d37a` implement immutable thumbnail keys; `0fb4afe0`, `15b33c62`, `8ba96f04`, `af8321ea`, `e85df550` implement cache, warming and catalog-entry improvements. Whole-migration completion and new cold-device timings are (unverified 2026-10-03).
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
- **1B plan (2026-10-06):** [collection-authority-1b-plan-20261006.md](../research/collection-authority-1b-plan-20261006.md) — six batches (dormant replica → core commands + tablet forms → artwork/volumes → providers/tracking → AV reads → fences + dry run); user chose to fence TMDB/IGDB, LaunchBox, AV editing and book import after 1C until slice 2.

<a id="user-req-20260926b--user-requests-2026-09-26-second-batch"></a>
## USER-REQ-20260926B — Tablet Collection creation

Status: `TODO` — implement tablet Collection creation after authority slice 1. Character creation stays PC-only by the user's 2026-09-27 decision; this item does not reopen it.

<a id="tablet-parity-001--bring-the-tablet-app-up-to-the-2026-09-27-pc-features"></a>
## TABLET-PARITY-001 — Remaining tablet parity

Status: `PARTIAL` — rename/hide/edit the Artist tab with PC-equivalent behaviour (priority 4, user 2026-10-03); committed `Artists.tsx` still directs these edits to PC.
- **Slice 1 (2026-10-04, `02656706`):** tablet rename / hide / pin + 숨긴 작가 list via the artist intent log (server overlay; PC applies on its artists publication pass). The status head now wakes the PC pass and open PC artist screens refresh on `library://artists-changed` (`ebb5f59b`). Merge/detach stay PC-only.
- Add subtree folder listing, shelf thumbnail/count projection and true batch album/folder server operations; individual album commands and multi-selection classification already exist (`c60e57f9`, `f027836c`). Keep cursor/cache identity bound to subtree mode; do not repurpose direct `asset_count`. User 2026-09-29 approved server deployment for this scope.
- Next IGDB refetch, one-off TMDB 400 and leftover diagnostics are (unverified 2026-10-03). Keep release-calendar ownership on PC. Deep character classification remains PC-only; viewer single-asset editors remain, multi-select character assignment stays dropped (user 2026-09-29).
- **Manga-spine touch target (from `COLLECTION-VIEW-20261001`):** manga spines are 30 px against the 44 px touch-target rule (unverified 2026-10-03); a source-level size gap, kept when the acceptance list was closed.

## TRANSFER-001 — LocalSend-style direct transfer first, server as fallback

Status: `TODO` — user 2026-10-03: add a LocalSend-style transfer path to 전송 (PC ↔ tablet file exchange) as the primary route, with today's server path (R2 exchange via the Cloud API, `ExchangeService` / `ExchangeView`) as the fallback. Supersedes the 2026-10-02 `EXTERNAL-REFS` note that had LocalSend only as a fallback.
- **Direct path:** discover the other device on the same network (LocalSend-style multicast announce + HTTP(S) registration; Tailscale address as a second candidate), pair once with the existing device identity, then send over an encrypted local HTTPS connection with resumable chunks. Keep the current hash/dedupe/trust checks, receive-folder rules and crash-safe receive on both ends.
- **Fallback:** when no direct peer answers within a short timeout (or the user is away from home), use the existing server exchange unchanged; the user sees one 전송 screen, not two features.
- **Clarified (user 2026-10-05):** on the same Wi-Fi, transfer goes directly (LocalSend-style) with relaxed size limits — speed is the goal; on a different network, the existing server path. Mainly Galaxy Tab ↔ PC, both send and receive.
- **Open questions before building:** Android background/foreground limits for a listening socket (the app is foreground-only today), Windows/Linux firewall prompts on the PC, whether to reuse LocalSend's protocol (interop with the LocalSend app) or a private one, and battery cost of discovery. Design first; PC first, tablet in the same round.

<a id="sec-token-001--shared-token-routes"></a>
## SEC-TOKEN-001 — Retire the shared cloud token from publication and admin routes

Status: `TODO` — read-only audit 2026-10-06 (source only; deployed versions and Credential Manager contents unconfirmed). The legacy shared token (`LAKOMICS_API_TOKEN`) is held by the PC (`Lakomics/CloudApi`) and typed into the tablet (`SecureSettings`), and `require_auth` accepts only that token. Publication/admin writes therefore accept a credential the tablet also holds: `PUT /v1/classifications`, `PUT /v1/saved-x-media`, `PUT /v1/library/album-snapshot`, legacy `PUT /v1/collections/replica` and `/v1/library/characters/replica`, `POST /v1/collections/artworks/prepare`, `POST /v1/extension/pairings`, `/v1/extension/clients/{id}/revoke`, `/v1/captures/{id}/acknowledge|imported`; `require_upload_client` and `require_admin_or_extension` also treat it as trusted. The Android app's `NetworkPolicy` blocks these calls, so the exposure is the bearer secret itself.
- **Order:** (1) PC sends `CloudPublisher` on its publication/admin calls; (2) server moves those routes to `publisher_guard`, and tablet-used reads plus notes to `client_guard` (list-generation, captures pending/download, library classifications/assets/contains, revisit, collections reads and artwork tickets, notes GET/PUT); (3) tablet setup accepts a provisioned `client` token (today its validation probe is a shared-only route); (4) rotate the shared token after both clients moved. Keep older-server compatibility in mind (`cloud/characters.rs:824`). `/v1/mobile-catalog/refresh` is already `client_guard`.

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

Status: `HOLD` — user deferred late PC calendar covers; no fix selected. Picker items 4–5 acceptance was closed 2026-10-05 (night checkpoint).

<a id="home-opt-001--home-optimisation-and-debugging-pass-pc-and-tablet"></a>
## HOME-OPT-001 — Residual test reliability

Status: `TODO` — make two parallel-run `src/app/App.test.tsx` cases deterministic or measure worker-count effects; also retain intermittent Albums, assetFilterUi, AssetGallery and library-root-switch failures from the user's 2026-10-01 report (unverified 2026-10-03). Passing reruns do not establish the scheduling cause.
Server `test_server_added_work_can_be_refreshed_and_survive_stale_pc` was intermittent on the VPS stage (2/3 failures, 2026-10-01); `198357b7` addresses a catalog refresh-count race, but equivalence to this failure is (unverified 2026-10-03). Home findings 1–8 are source-fixed; performance is in `PERF-ALL-001` and their acceptance was closed 2026-10-05.
Rust `thumbnail_maintenance::tests::apply_limit_is_resumable_and_skips_completed_files` failed repeatedly inside the Codex sandbox but passes in a normal shell (2026-10-05); find the sandbox-sensitive dependency (filesystem/timing) before trusting either result.

<a id="pc-review-001--fix-findings-of-the-2026-09-25-pc-app-review"></a>
## PC-REVIEW-001 — Residual 2026-09-25 review findings

Status: `PARTIAL` — [review report](../research/pc-app-review-2026-09-25.md); already-fixed follow-ups are archived. These remaining claims are (unverified 2026-10-03):
- Asset restore/error-recovery and relation re-baseline edges; repeated content-hash mismatches; dropped lifecycle-intent detail; remaining non-trash sync UI-thread work.
- `empty_trash`/purge lock scope, TrashBrowser retention reset and authority-path purge guard re-review; IGDB screenshot hero labeling; Aladin/Kakao renumbering retry; long HEVC/ProRes limits; S36 rollback after trashing an automatic acceptance.
In-flight artwork cleanup race is fixed (`af2fd1a4`); this does not prove every purge/recovery edge accepted.

## VAULT-ENC-001 — Residual audit claims

Status: `TODO` — low priority; kept when the vault's acceptance line was closed 2026-10-05 (ADR-0039). Original scan-error title/thumbnail preservation, full-image cache headers and per-tile-probe audit survivors are (unverified 2026-10-03); recheck the rewritten path only.

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
Live R2 signed Content-Length refusal is not established by fixtures (storage enforcement unverified); transfer recovery acceptance was closed 2026-10-05; implemented bounds/paging/reclaim are archived.

<a id="server-review-20260924--remaining-judgment-calls-of-the-cloud-api-review"></a>
## SERVER-REVIEW-20260924 — Residual server judgment calls

Status: `TODO` — low priority; [review](../research/server-review-2026-09-24.md). Personal-edit/noop, character/similarity decision histories and observation-ledger retention still need review (unverified 2026-10-03); refresh-job pruning is implemented (`5c1b80d7`) and is not the same history.
Items 5 (legacy long memo conflict) and 9 (auth before body validation) are fixed (`67e0cd97`). Shared-token trash/restore matches the retained design; the similarity-kept Trash refusal acceptance was closed 2026-10-05.

<a id="mobile-ux-001--portrait-real-use-follow-up"></a>
## MOBILE-UX-001 — Deferred portrait investigations

Status: `HOLD` — landscape two-pane Library stays parked (user 2026-09-28: need unclear); begin from actual wide-content/stand/split-screen use if resumed. Dimensions, sidebar, filters, copying and duplicate-review source work are archived; older unconfirmed device checks were closed 2026-10-05.
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
## LONG-001 — AV lookup rollout

Status: `PARTIAL` — collector → server inbox → PC LibreDMM/Wikidata chooser exists (`67e0cd97`, `b9c4f89a`, `b00f3bfe`). Confirm the recorded deployment/PC migration status before selecting rollout work (unverified 2026-10-03); native candidate-flow acceptance was closed 2026-10-05.
User 2026-09-27 chose LibreDMM; DMM/FANZA affiliate API dropped (Korean geo/address barrier), JavLibrary browsing only. Keep explicit front/spine/back selection and manual artwork preservation, acquisition separate from application, no Vault coupling or second lifecycle. [Design](../research/av-link-design-20260927.md), [sources](../research/av-sources-20260926.md), `docs/prototypes/av-link-20260927/`.

# Catalog / optional providers

## CATALOG-KEEP-001 — Keep bookmarked works when the source deletes them

Status: `TODO` — user 2026-10-06, not scheduled. On 2026-10-05 the bookmarked kHentai work 2583385 still listed and opened its detail from the published catalog, but its reader returned 404 because k-hentai no longer serves the gallery (`app.py` "work not found on k-hentai"); the tablet message now says so instead of "서버에 모바일 카탈로그 기능이 필요합니다". The user chose to keep copies of bookmarked works rather than look the work up on another source (that alternative stays with `CATALOG-002B`).
- **Direction:** store the pages of bookmarked works (server or PC) so the reader falls back to the kept copy when the source is gone; reuse the planned local-manga-on-the-server path (`MANGA-CATALOG-FEEDBACK-20261004`) and the existing catalog reader.
- **Open questions before building:** where copies live (VPS had ~23 GB free on 2026-10-04 and ~291 bookmarks), when to copy (on bookmark vs a background pass), image format/size limits, removal when a bookmark is cleared, and whether the PC reader needs the same fallback. Measure the bookmarks' total size first.

## CATALOG-002B — Optional Heliotrope coexistence

Status: `TODO` — low priority. VCK/kHentai stays default; isolate optional provider cache and verify page resolution separately from metadata. Disable/cache-clear preserves bookmarks/progress.

# Desktop UI follow-ups

## USER-FEEDBACK-20261005 — Requests of 2026-10-05

Status: `TODO` — remaining user requests and decisions of 2026-10-05; each bullet carries its own status. Requests delivered the same day are in the [2026-10-05](lakomics-completed.md#closure-checkpoint--2026-10-05--tablet-catch-up-ui-unification-phase-1-and-pc-speed) and [2026-10-05 (night)](lakomics-completed.md#closure-checkpoint--2026-10-05-night--ui-unification-phases-23-folder-move-motion-bookmarks-speed-and-acceptance-closure) checkpoints.
- **Tag translations (`TODO`, later batch):** manga catalog tags are often long-winded paraphrases or untranslated, and some asset tags are untranslated; the user will collect examples first.
- **AV work screen disc (`HOLD`):** tapping the disc plays a disc-out animation and opens a site; waits until the user picks the site.
- **Decided, not planned:** Notes media attachments — option (b) chosen 2026-10-05: dropping files inserts their paths (`19ef652e`); real encrypted attachments (outside ADR-0035's scope) only if the user asks. Series folder 미분류/전체 stays an inline control above the gallery, not in 보기, by design; revisit only if the user asks.

## WIN-FEEDBACK-20261004 — First Windows release-run findings

Status: `PARTIAL` — reported by the user 2026-10-04 on the first Windows release build (`e8b3d774`, WebView2). The source-fixed bullets were closed by the user on 2026-10-05 (night checkpoint); the bullets below remain.
- **Windows test debt:** the three `library::collection_source::tests::source_root_*` failures are fixed with native separators (`7c1dd0e5`). Server `tests.test_media_thumbnail_encode` `test_no_kind_leaves_a_partial_file_behind_on_an_unsupported_source` returns exit 7 instead of 4 under the WSL test venv (Pillow/codec environment; untouched code).
- **Abandoned thumbnail requests — source fix 2026-10-06:** media-protocol requests made after a view change (`media_view_changed`, sent on area and gallery scope changes) are served before older queued ones, FIFO within a view; old ones still finish. Native release timing during rapid switching is unmeasured.
- **No popping in (user 2026-10-04):** progressed — menus, dialogs, popovers, toasts, selection bar and tablet sheets ease in and out (`2748f0db`); first-screen tiles and late images appear together (`2eef344c`, `288ae552`); the launch mark covers the first Home load (`3dd73981`). Keep sweeping instant panels and late blocks found in use (≈150–250 ms ease-in, reduced motion respected; never fade from a blank frame where the no-flash rule applies).
- **Collections cache should survive (on hold — user 2026-10-04: seems fine after more use):** the user wanted the PC Collections screen to keep its cache instead of rebuilding it (compare `mobile-client` collection caching with the PC `collection_cache.rs` / frontend Collections loading and game-case bake cache).
- **Tablet manga back synopsis/price (`TODO`):** the tablet manga case back still needs the volume fields in the replica (server work), a separate item.

## MANGA-CATALOG-FEEDBACK-20261004 — Manga catalog requests

Status: `TODO` — requested by the user 2026-10-04 (PC).
- **Import local works — PC drop done (2026-10-06):** dropping folders or ZIP/CBZ on 망가 → 로컬 moves/extracts them into the manga root at once with a 되돌리기 toast (user: move, no confirmation); pages are renumbered when not already numeric; RAR/7Z refused (no dependency). Not done: the archive original stays in place (no trash helper; user wanted it sent to the trash), author-folder destinations (the manga root is flat today), and the tablet/server upload below.
- **Local manga on the tablet via the server (user 2026-10-04):** the user wants local manga readable on the tablet; NSFW content on the server is already accepted (assets are there). Direction: the PC uploads local works to the server and the tablet gets a 로컬 source in the catalog, read with the existing catalog reader, available while the PC is off. Measured 2026-10-04 (read-only): VPS `/` 52 GB with 23 GB free; local manga root `C:\laku\2군` is 197 MB. Decided (user 2026-10-04): every local work uploads automatically; import MOVES the source into the manga root (not copy). Destination (user 2026-10-04): automatic — read the artist from the name (e.g. `[작가명] 제목`, circle/artist brackets) into that artist folder; ask only when no artist can be read. Show a preview of where each item moves and confirm before moving (moves are hard to undo). Scheduled after the Home fill round.
- **Selection flash (user 2026-10-04):** selecting a work in the Manga catalog makes its thumbnail flash briefly as the selection effect appears. Check whether the selection style changes the image layer (scale/filter/transform start or end causing a re-raster, as with the shelf lift fixed this round) or swaps the image source.
- **Idea — real-time artist tweets via Web Push (user 2026-10-04, not scheduled):** https://github.com/sh1ma/Angelic-Angel (Rust, MIT, 206★, last push 2026-03-05) emulates a Firefox Web Push client on Mozilla AutoPush to receive X notifications for followed accounts with tweet notifications on, decrypts them and posts to a webhook; X API only at registration, no scraping. Possible use: new artist tweets flow straight into the Lakomics capture inbox (today the `extension-list` collector's job). Concerns before any use: it needs the X session cookies `auth_token`/`ct0` (account-equivalent secrets; must use the app credential store), unofficial-client ToS/account risk, and only notification-enabled accounts are covered (no backfill).
- **Idea — auto series grouping in 북마크 (user 2026-10-04):** group bookmarked works that belong to the same series (volumes/parts of one title) automatically in the 북마크 view. Not scheduled; decide how a series is recognised (catalog series/parody tags, title stem, same artist) before design.

<a id="pc-polish-20261002--remaining-polish-and-acceptance"></a>
## PC-POLISH-20261002 — Remaining notification feature

Status: `TODO` — native ledger notifications; current reminders are in-app only. Item 5 is in PERF; all implementation slices are archived and their acceptance was closed 2026-10-05. PC full-range month TOC remains absent, a limitation without approved new scope; memo conflicts retain copies, not per-item merging.

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

Status: `PARTIAL` — clarify any remaining inventory/recorded-era metric definitions (unverified 2026-10-03); never infer activity from file timestamps. Source exists; native acceptance was closed 2026-10-05.

<a id="collector-radar-001--image-based-already-have-and-taste-match-marks-on-x"></a>
## COLLECTOR-RADAR-001 — Image-based "already have" and taste-match marks on X

Status: `IDEA` — user 2026-10-03 liked this one among the brainstormed tools; not approved for implementation, do not start until the user explicitly asks.
While browsing X, the collector marks each image as already in the library by image content, not only by URL, so reposts from other accounts are caught; it may also show a taste-match score based on the library. Today's collector saved marks are URL-based only (`extension-list/src/x-gallery.js` `savedMedia`). Reuse the PC similarity and artist-style data through the existing collector ↔ PC connection; the score's definition and privacy of what is sent stay open.
Not chosen 2026-10-03 (judged impractical): source-loss monitoring, reverse-search quality upgrade, bookstore barcode check, yearly recap, tablet photo-frame mode.

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

Status: `PARTIAL` — user 2026-10-04: use the new main PC (RTX 5070 Ti 16 GB, 12 threads, 23 GB) for heavy one-off work over the whole library (~9,073 images, 459 videos) that would be slow on the laptop; afterwards the laptop only keeps up with new items. Gate everything on the machine-local `performance.profile = "main"`; laptop behaviour unchanged. Library counts below are from the restored DB on 2026-10-04.
- **Already done 2026-10-04:** full PixAI v1.0 / canary / Kaloscope re-run on GPU (0.2–0.4 s/image, pack-copy preprocessing, matches the prior DB to float16); exports placed in the auto-tag inbox; nightly tagger switched to the same pack copy.
- **Done 2026-10-05 — item 1, CCIP feature backfill:** B36 features now cover every normal image (user-approved one-off run, finished 23:23). Whether S36 also needs its own whole-library feature pass (the item was titled "B36 + S36") is (unverified 2026-10-05); check before item 3 relies on it ([night checkpoint](lakomics-completed.md#closure-checkpoint--2026-10-05-night--ui-unification-phases-23-folder-move-motion-bookmarks-speed-and-acceptance-closure)).
- **Suggested order: 2 → 3.**
  2. **Video similarity fingerprints:** 0 of 459 videos fingerprinted (12 samples/video, FFmpeg 1 decoder thread, serialized). Run several in parallel on the main PC and try NVDEC decode; the fingerprint contract (frame size, samples) must stay identical so laptop-made fingerprints compare.
  3. **Unknown-character grouping:** pairwise CCIP comparison over the whole library, grouping with Chinese Whispers (chosen in [OSS trial](../research/oss-trial-sqlitevec-ccip-20260926.md)); GPU for the N×N similarity. Item 1's features are now in place.
- **Design notes (read-only study 2026-10-04):** 2 = purpose-specific fingerprint backfill (not the 2–100-ID review scan), CPU only with N=2 bounded gate, resumable 600 s windows, keep `-threads 1` and test `-filter_threads 1`; NVDEC not adopted (no identity proof); fingerprint cache is keyed by the FFmpeg binary hash, so laptop and main PC do not share fingerprints. UI: a main-profile-only action beside the performance selector, no auto-run.
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
