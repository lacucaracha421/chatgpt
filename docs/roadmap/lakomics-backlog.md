# Lakomics Backlog

Living source of truth for **active** Lakomics work only. Completed, superseded, applied, and incident-only records live in [lakomics-completed.md](lakomics-completed.md).

Reconciled 2026-09-20 after the user separated completed server-authority rollouts from remaining client cleanup, accepted current media delivery, and closed the current character-accuracy improvement pass. See the [closure record](lakomics-completed.md#closure-checkpoint--2026-09-20--authority-scope-split-and-product-acceptance). This is a scope/status reconciliation, not a new deployment or Windows full-system audit.

Updated 2026-09-23 (evening): the Android 0.7 browse-first redesign, thumbnail loading work (0.7.4–0.7.6) and the in-range dependency update are archived in the [2026-09-23 evening checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-23-evening--mobile-07-thumbnails-and-dependencies). `CHAR-AUTO-007` reached stage 2d (shadow scoring) that evening.

Updated 2026-09-24: `CHAR-AUTO-007` stage 3 (per-series S36 publication) is implemented; `DEV-TEST-001` is archived in the [2026-09-24 checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-24--rust-test-runtime).

## Current priority

1. **CHAR-AUTO-007** — stage 3 implemented 2026-09-24 (machine-local, per series): series switched to S36 get automatic membership only from S36 (knn3 ≤ 0.1085 after the rejection guard); B36/augmentation acceptances stop there; rollback and a "doubtful existing acceptances" review tab exist. Evidence: prospective review 232/241 correct at ≤0.1085 (errors mostly 시시아); ≥427 of 1,527 B36 automatic acceptances were manually rejected. The four series (젠레스 with 시시아 excluded, 명조, 아이돌, 리버스) are switched on the Linux PC. 2026-09-24: new target 엘렌 (젠레스) got 11 automatic S36 acceptances in 15 min (knn3 0.063–0.106); the user checked all 11 as correct. Next: choose further series to widen to; Windows PC switches separately.
2. **CLOUD-POST-001** — remaining publication/compatibility cleanup only; completed authority domains are archived, and live unmigrated paths must stay intact.
3. **WORKS-001** — Film cast, release info and related works implemented on desktop 2026-09-24; remaining: in-app check after `TMDB 새로고침`.
4. **Server review follow-ups (2026-09-24)** — review branch merged (`ae9af4b`); catalog artifact pruning (server disk 83% full, ~3.4 GB/day), then judgment calls 4, 2, 1 and 7 from `docs/research/server-review-2026-09-24.md` §3. Deployment needs approval.
5. **VAULT-ENC-001** and **MOBILE-PARITY-001** — implemented; native/tablet acceptance remains.

`SIMILARITY-004` (existing-library near-duplicate discovery) and mobile tab-switching improvement were closed on 2026-09-23 at the user's confirmation; see the [closure record](lakomics-completed.md#closure-checkpoint--2026-09-23--similarity-discovery-and-mobile-tab-switching).

`MEDIA-R2-001` is closed at the currently satisfactory media-delivery scope; extra variants are not required. `CHAR-AUTO-001` is closed for this improvement pass; future concrete classification mistakes can open bounded follow-up work rather than keeping a permanent accuracy task active.

Later / optional: AV source-and-candidate selection (`LONG-001`), Artist hub (`ARTIST-001`), optional provider work (`CATALOG-002B`). Similar-video calibration stays deferred until representative samples naturally appear.

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

# Cloud / Mobile authority

## CLOUD-POST-001 — 서버 원천화 이후 클라이언트 구조 정리

Status: `PARTIAL` — remaining client/publication cleanup only. The completed authority
rollouts are separated into the [2026-09-20 closure record](lakomics-completed.md#closure-checkpoint--2026-09-20--authority-scope-split-and-product-acceptance).
Do not repeat the bookmark, Album, Classification or Asset lifecycle cutovers.

Remaining scope:
- Character and Collection structures still use PC-owned publication. Decide their
  ownership and migration contract before replacing that path; the shipped mobile
  character-exclusion channel is not full Character authority.
- Retire or repurpose manual publication controls and one-way publication state only
  where an equivalent live authority-backed consumer exists. `useMobilePublications`
  still serves unmigrated domains and must not be removed wholesale.
- Review retained compatibility readers, staging data and fenced writers against actual
  consumers and recovery needs before retiring anything. A retained fence or migration
  is not itself unfinished functionality.

Preserve the PC SQLite replica and workstation-only filesystem/compute state, durable
pending intent, domain-specific cursors/revisions and local presentation preferences.
Broader worker architecture, mobile editing and browsing-cache expansion remain in
`CLOUD-WORK-001`, `MOBILE-WRITE-002` and `MOBILE-CACHE-001`; this item does not restart
those deferred scopes.

Acceptance: any selected cleanup removes a demonstrated obsolete client/publication
path without losing a live consumer, offline intent, authority fence or recovery path.
New domain activation, deployment and production-data writes require separate approval.

## MOBILE-CACHE-001 — Android durable metadata replica

Status: `HOLD` — post-authority optimization.

Current mobile binary caching (`MediaRepository` / `ThumbnailCache`) is useful, but much of the browsing metadata is still held in React `Map` caches or `localStorage`. Add a small durable Android metadata database once the server change contracts are stable.

- Persist browse metadata, revisions/cursors and durable outgoing intents in a local database rather than relying on process-memory caches for normal startup.
- Startup should render the last committed local state first, then fetch/apply server changes in the background.
- Keep binary media in the existing bounded media cache; metadata replica and media cache are separate concerns.
- Revisit `PickerLibrary`'s independent JSON snapshot after this exists. Prefer deriving Picker/album views from the durable replica rather than maintaining another full-library metadata copy.
- Preserve explicit cache invalidation when the configured server/library identity changes.

Acceptance: after one successful sync, relaunching the Android app can show the previous library view without waiting for a full remote page load; later server changes update it incrementally without losing pending local intent.

## CLOUD-WORK-001 — Server-owned durable jobs with PC workers

Status: `HOLD` — post-authority worker architecture.

The server should own what work is pending and what result is current, while heavy compute can stay on the PC. Generalize the durable lease/restart pattern already used by `mobile_catalog_refresh_jobs` instead of making the VPS perform every expensive task.

- Server owns job identity/state (`queued/running/completed/failed`), lease owner/expiry, retry state and accepted result revision.
- PC startup order for worker-backed domains: reconcile server changes -> preserve/flush local intents -> only then claim new work. A worker must not blindly calculate from a stale local snapshot.
- A job/result carries enough identity to prove what was analyzed: `asset_id`, content hash, input/entity revision, model version, reference-set version and relevant classifier/config version.
- Result commit is compare-and-set/fenced: if the canonical asset or relevant classification state changed after the job input was captured, reject the stale automatic result or retain it only as a non-authoritative suggestion.
- Manual/user-confirmed classification outranks automatic classification. A late model result must never silently overwrite a user decision made from mobile or another PC.
- Job/result submission is idempotent by stable job/operation ID. If a PC dies mid-job, the lease expires and another worker may retry; duplicate late completions must not apply twice.
- Multiple PCs may participate later, but only the current lease holder may commit ordinary work; recovery from an expired lease remains deterministic.
- Keep light network/provider jobs on the server where convenient, while CLIP/embedding, FFmpeg/video and other expensive processing can be leased to a capable PC.

Acceptance includes: PC-off queueing; mobile/manual edit while PC is off; stale result rejection after that edit; worker crash and lease recovery; lost response/idempotent resubmit; and two-PC contention without a double commit or manual-state overwrite.

## MOBILE-WRITE-002 — 서버 원천화 이후 모바일 편집 확대

Status: `HOLD` — the production proof gate was satisfied by the 2026-09-15 bookmark pilot; keep this deferred until the user chooses the next mobile write domain.

Once bookmark convergence is boring and reliable, expand mobile writes only where the interaction benefits from a tablet/phone. Reuse the same stable identity, expected-revision, durable intent, receipt and conflict model rather than adding ad-hoc endpoints.

Preferred early domains:
- ratings/favorites/showcase state;
- album membership and lightweight organization;
- character-classification confirm/correct actions;
- tags and small metadata edits where bulk desktop tooling is unnecessary;
- Collection/read-state style personal metadata where cross-device continuity matters.

Keep destructive global media deletion under `MOBILE-003`; do not use this item to bypass tombstone/grace/recovery requirements. Bulk filesystem reorganization, GPU work and large maintenance operations remain PC-oriented even though their committed shared results converge through the server.

Acceptance: a supported edit can be made with PC off, survives offline retry/response loss, becomes authoritative exactly once, and appears later on PC without a manual publish/sync step.

## MOBILE-BUG-002 — Mobile Catalog search does nothing

Status: `DONE` — fixed in `7d2bfa6`; accepted on the tablet 2026-09-24 (archive with the next reconciliation).

Search in the Android Catalog does not work. Reproduce first on the current APK: record the query, whether any request reaches the server (`searchMode=mobile` search-page path), the response, and whether the UI ignores it. Then fix the failing layer and verify search together with category inclusion, excluded tags and paging.

## MOBILE-008 — Catalog update requests and status

Status: `IN_PROGRESS` — server refresh worker and Android request/status UI already exist.

Remaining is bounded live-source/native acceptance and fuller PC/server grouping reconciliation. This is a server operation lane, not an expansion of normal mobile editing. Keep it behind the authority/reconciliation rules proven by the archived `CLOUD-AUTH-001` contract where domains overlap.

## MOBILE-003 — Safe global deletion / tombstone protocol

Status: `HOLD`
Risk: HIGH.

Global cross-device deletion remains intentionally deferred. Require tombstones, grace period, acknowledgement/reconciliation, explicit purge, conflict handling, and recovery before activation.

## VAULT-ENC-001 — Lakomics-encrypted Private Vault (ADR-0039)

Status: `VERIFY` — stages 1–3 implemented (`cc917f6`, `590af74`, `bbf8502`); Linux native acceptance (real USB) confirmed by the user 2026-09-24; Windows acceptance waits for WIN-SYNC-001.

Replace VeraCrypt with Lakomics' own per-file encryption so a USB plugged into another computer shows nothing readable. The user copies the VeraCrypt contents (including `.lakomics/`) to the trusted PC, formats the 64 GB USB as exFAT, then imports.

Stages:
1. Crypto core: vault format, key wrapping (password, recovery key), chunked AES-256-GCM objects with seekable reads, encrypted atomic index, orphan cleanup. No UI.
2. Create/unlock/lock, remember-on-this-PC (OS credential store), import from a plaintext folder keeping old titles/custom thumbnails, encrypted thumbnails, browse through the media protocol with `no-store`.
3. In-app add, export, vault trash and empty; ranged video playback in the in-app player.
4. Native acceptance on Windows and Linux: real USB removal, credential store, large videos.

Also fix the bugs found in the 2026-09-24 audit where they survive the rewrite: scans that delete titles/thumbnails after partial failures, uncached full-image responses, per-tile status probes, and focus-only removal detection.

## WIN-SYNC-001 — Update the Windows PC after the 2026-09-24 changes

Status: `TODO` — the user's Windows PC is unavailable as of 2026-09-24.

Once the Linux PC publishes Collections with the personal-edit handshake, the older Windows build is refused for Collection publication only (other domains and local data are unaffected). On the Windows PC: pull `main` (requires the commits to be pushed first), rebuild, and verify:
- Collection publication resumes.
- Private Vault on Windows: Credential Manager remember/auto-unlock, USB detection by drive letter, removal lock, in-app video playback.
- FAULT game in WebView2 (`http://tauri.localhost` → `http://lakomics.localhost` original-image reads).
- Collections authority (docs/research/collection-authority-design-20260924.md) may be activated before this update; the old Windows build is then fenced for Collections and its local-only edits are not carried over (the upgrade produces a salvage report).

## USER-REQ-20260924 — User requests, 2026-09-24 evening

Status: `TODO` — recorded as given; scope and priority to be confirmed per item.

Mobile:
- Design consistency with the PC app (clarified 2026-09-24): the Home tab's top bar already has the logo — put it on every tab's top bar; use the top bar's space better; restyle buttons toward the PC app's button feel. The Home screen itself waits until Artist Revisit is rebuilt (PC and mobile).
- Monthly subscription calculator (clarified 2026-09-24): track the user's own subscription services (e.g. streaming) and their monthly total.
- Notes: more note types (see Notes v2). "API documentation for notes" means storing sensitive documents such as API keys inside the encrypted notes (clarified 2026-09-24) — covered by encrypted notes; consider a 'secret' note type with masked display/copy button in Notes v2.
- Battery usage: investigate and reduce (polling, thumbnail warm-up, background work).
- New-release notifications (clarified 2026-09-24): extend the PC app's existing Collections release-watch to the app — Collections only; shown inside the app (no push notifications).
- Notes: tapping 동기화 syncs with the PC immediately (confirmed 2026-09-24: sometimes needed right away) — the PC must pick up the change within seconds, not its 5-minute notes poll.
- Bottom navigation bar slightly higher.

PC:
- Start Collections authority slice 1 (docs/research/collection-authority-design-20260924.md).
- Asset viewer and video viewer improvements (!!), clarified 2026-09-24: the title at top-left and the buttons at top-right cover the image — keep them off the image or hide them; in videos, Left/Right should seek about 5 s (currently does nothing); the left/right `<` `>` arrows should auto-hide.

Second batch (same evening; details will be given at implementation time):

Mobile:
- Notes: when the keyboard opens, lift the editor by the keyboard height so the text being typed stays visible.
- ~~Manga Catalog reader: remove 이어읽기 (continue reading); add a page slider to jump directly to any page (e.g. page 25 of 40).~~ Done in 0.8.2–0.8.3 (`2af8d1e`, `f6ac798`); accepted on the tablet 2026-09-24.
- File exchange between the PC and mobile through the Lakomics server, replacing the current LocalSend workflow: send a file and it arrives on the other device right away. Decided 2026-09-24: both directions; received files go to the device's Downloads folder; transfers are one-off, so the server deletes them soon after delivery (short expiry for undelivered files).

PC:
- Lightweight processing mode ("데이터 처리용 라이트모드"): while the user is on the mobile app, keep only the PC work that mobile features depend on running and pause nearly everything else.

PC and mobile:
- Notes like a notes app, on both PC and mobile. Scope chosen 2026-09-24: checklist notes (items can be checked and reordered), note colours, and Markdown rendering. Design must fit the existing encrypted notes sync.

Collector (`extension-list/`):
- A better way into subfolders than double-tap (clarified 2026-09-24: double-tap is hard one-handed and taps are sometimes missed) — design a one-handed alternative (e.g. long-press, a chevron target, or a second ring).
- Store the semicircle menu's folder order and hidden folders (e.g. 리버스, 명조) on the server; today a reinstall resets them.
- Twitter/X only: add a control in X's left navigation (Profile, Home, …) that scrolls to the top and loads new posts in one step, replacing the manual scroll-up-and-refresh.
- Disable the right-side recommended-images button for now (keep the code; re-enable later).

NovelAI app items from this batch are in `nai_frontend/docs/BACKLOG.md` (NAI-009).

## PC-DECLUTTER-001 — PC app declutter (concepts A+B+C, staged)

Status: `IN PROGRESS` — stages C and A implemented 2026-09-24/25 (not yet native-accepted on Windows), plus user feedback rounds: 메모 back on the rail; 이동 and search merged into one 찾기 palette (Ctrl+K/Ctrl+F, also jumps to folder/album/character names); larger date headings; series view reduced to one header line + compact character tiles; group view opens on member tiles with 그룹 더보기 › 그룹 편집; character 더보기 panel rebuilt around references and crops; collections 내 별점 select; asset tree shows subtree totals ("N장 · 이 폴더만 M장"), quick views above pins, pins as chips, one expanded character series at a time, groups as single rows with members hidden; simpler person/group glyphs; scrollbars styled only via ::-webkit-scrollbar (standard scrollbar-width/color make WebKitGTK draw outlined native bars); online catalog tiles simplified like mobile, rare actions under 카탈로그 더보기, "N분 전 갱신" next to 망가. Stage B still waits for the Revisit rebuild. Concepts in `docs/prototypes/pc-declutter-20260924/` (README, index.html, PNGs); the user likes all three (2026-09-24). Staged plan combining them:
1. **C — Quiet chrome first** (lowest risk, mostly moving things): one top bar merging title bar and list header; one status indicator ("작업 N") opening a single panel for sync, running jobs, review queues and lightweight mode; selection bar that appears only while selecting; merged release notices; Settings › 일반 trimmed to ~7 items with maintenance/diagnostics under 고급 › 복구·진단; experimental/recovery buttons off the character series header.
2. **A — Focused navigation**: rail reduced to 에셋 · 컬렉션 · 망가; everything else via a `Ctrl+K` 이동 palette and 더보기, with review-queue counts shown only when non-zero; Revisit folded into the asset index for now.
3. **B — Task-first Home**: together with the Revisit rebuild (PC and mobile) — 이어 보기 as the hero, 확인할 것 queues that disappear at zero, tools in one row. Needs resume-position data and queue counts first; avoid a dashboard feel (DESIGN.md).
Ideas to carry to mobile (MOBILE-DESIGN-001): single status indicator, zero-hiding queues, neutral filters, search icon only where searchable, conclusion-first settings, continue-watching.

## CHAR-REVIEW-001 — Per-series S36 candidate review

Status: `TODO` — user chose this on 2026-09-24; start after PC-DECLUTTER-001 stage A.

The S36 candidate queue (자동 후보 + 추천 awaiting a judgment) is one list across all series. After stage C, the series header shows `후보 확인 · N`, but N is the global pending count (`character_shadow_review_page` summary), and the review opens the global list. Once S36 is enabled for more than one series, candidates from other series mix in.
- Native: let the shadow review page query accept an optional series scope, and return that series' pending counts (filter by the target character's series).
- PC: the series header count and the review opened from it use the series scope. A global entry (e.g. the status panel's 확인할 것 queue) can keep the all-series list.
- Mobile review of the same queue: check whether it should get the same filter and whether that touches the server path.

## MOBILE-DESIGN-001 — Premium mobile layout pass (Galaxy Tab S11 portrait)

Status: `TODO` — brief given by the user 2026-09-24; start after the mobile Private Vault UI work lands (same files). Home screen is out of scope (waits for the Revisit rebuild).

Goal: a calmer, premium feel ("이제 고급감을 추구할 때").
- **One screen, one conclusion:** on the S11 in portrait each screen's content must resolve within the viewport — no section header or row that peeks just below the fold (e.g. Library root's '기타' / '오리지널' needing a small scroll to appear). Compose sections so the first screen ends cleanly.
- **Shared top bar on every tab:** the logo (Home already has it) on all tabs; use the bar's space for actions moved up from the content (e.g. from the Library header); search becomes a small icon in the top bar, common to all tabs; buttons restyled toward the PC app's button feel.
- **Library tab:** remove the "최근 연 폴더" (recent folders) section.
- **Showcase:** the filter button is always shown active/white and distracts; make it neutral unless a non-default filter is set (filters are rarely changed).
- **Loading more assets on scroll:** smooth, Apple-like appearance of newly loaded tiles (no pop-in or layout jump; respect reduced motion; keep virtualization/perf).
- **Asset viewer top icons:** their meaning is not obvious — make each action recognisable (clearer icons, short labels or a first-use hint; accessible names already exist but are invisible).
- **Bottom navigation bar:** slightly taller across the app (it was raised 8px in 0.8.2; now increase its height a little too).
Earlier related request (USER-REQ-20260924): logo on all tabs, better use of the top bar, PC-like buttons.
Process: show browser-rendered mockups at 800×1280 (S11 portrait) for approval before the APK.

## PC-POLL-001 — Cut the desktop app's idle server polling

Status: `DONE` — implemented in `cf2075b`; re-measured 2026-09-25 (see below). Remaining pollers moved to `PC-POLL-002`.

Server access log, 15 min with the Linux desktop app idle (client 100.122.139.56): 1,606 requests (~6,400/h), all 200 — `/v1/sync/status` 502, `/v1/mobile-catalog/status` 334, asset/album/classification/bookmark change feeds ~167 each. The desktop sends no `If-None-Match`, although the server supports ETag/304 on these endpoints (`conditional.py`). Apply what Android 0.8.6 did (`f25ddd8`): one sync-status read per pass with ETag, fetch a domain feed only when its cursor moved, idle backoff (5 → 15 → 30 → 60 s, back to fast after local writes/focus/changes), share one status read across the React sync hooks (`useAssetAuthoritySync`, `useAlbumAuthoritySync`, `useClassificationAuthoritySync`, `useCatalogBookmarkSync`, …) and the native lightweight-mode ticks. Measure the same 15-minute idle window before/after. Note: tablet traffic reaches the server through the local proxy and is logged as 100.76.119.29 (tablet 0.8.5 → 0.8.6: 476 → 184 requests per 15 min, first 15 min after install).


After (`cf2075b`, Linux dev build, same 15-minute idle window, 2026-09-24 16:29–16:44 UTC): 151 requests (~600/h, −91%), 49 of them 304. `/v1/sync/status` 25 and `/v1/mobile-catalog/status` 25 (about one per minute once idle, as designed); the rest are pollers outside the coordinated pass (see `PC-POLL-002`). Three short returns to the 5 s interval (~every 3 min) coincided with the app's own uploads (character replica, saved X media, a media ticket); the source of that 3-minute cadence was not traced.

## PC-POLL-002 — Fold the remaining desktop pollers into the coordinated pass

Status: `TODO` — found by the 2026-09-25 `PC-POLL-001` re-measurement.

With the app idle for 15 minutes, these endpoints are still read about once a minute each, outside the shared status pass: `/v1/captures/pending` 18, `/v1/library/characters/review/decisions` 16, `/v1/library/characters/exclusions` 16, `/v1/library/similarity/review/decisions` 15, `/v1/collections/status` 15, `/v1/collections/personal-edits` 15 (~95 of 151 requests). Read them only when the shared status (or an ETag/cursor) says their domain moved, following `library/authority_pass.rs`; expected idle total under 50 per 15 minutes. Also find what wakes the fast interval every ~3 minutes while idle. Measure the same 15-minute window before/after.

## PERF-ALL-001 — Whole-app benchmark and optimization pass

Status: `TODO` — requested 2026-09-24 for later ("벤치마크 빡세게").

Apply `docs/agents/implementation.md` → "Performance work" across Lakomics, one user-visible path at a time: measure on the real platform first, gate with deterministic metrics (render/commit counts, query counts, bytes, request counts, instruction counts), confirm each metric tracks real latency, then lock wins with tighten-only thresholds. Candidate paths: PC Library open/scroll and viewer, character and similarity screens, Collections/Works; Android Library/viewer (instrumentation `LakomicsPerf` + `android/tools/perf_summary.py` exists), Catalog, cold start; Cloud API hot endpoints (`tools/poll_benchmark.py` exists) and idle request volume per client; Rust indexing/ingest. Start by listing the paths with their current numbers, then pick the worst.

## MOBILE-PARITY-001 — Desktop features requested on mobile (2026-09-24)

Status: `DONE` — slices 1–4 implemented and deployed (APK 0.8.x); accepted on the tablet 2026-09-24 (archive with the next reconciliation).

The user chose these desktop features for Android, in this suggested order (smallest and safest first):
1. **Film details** (read-only): show `WORKS-001` cast, release info and related works in mobile Collections. Publish the Film snapshot block alongside the TV `series` block (`src-tauri/src/cloud/collections.rs`, `committed_series`), then render it; local related works open the local work.
2. **Personal Collection metadata edits** ([design](../research/mobile-collection-personal-edits-design-20260924.md), decisions recorded 2026-09-24): my rating, Showcase membership and memo, through the `MOBILE-WRITE-002` durable intent / expected-revision / receipt model proven by bookmarks. Works with the PC off and appears on PC without a manual sync.
3. **Similarity review**: mobile shows the open review pairs and records `keep_existing` / `replace_existing` / `keep_both`; the PC applies file-level results. A decision must never delete or replace an original before the PC applies it under the existing ADR-0007 rules.
4. **Library Trash**: move assets to the Library Trash from mobile, and browse/restore it. This activates `MOBILE-003`: it must use the tombstone, grace-period, acknowledgement and recovery protocol, never immediate deletion. Emptying the trash stays PC-only unless separately decided.

Deferred but wanted on mobile later: character registration and reference-character management. Keep them PC-only until the user reopens them.

# Future-work notes — 2026-09-21

User-requested notes for later work, not an implementation start or priority change. Related entries below retain their existing status; these notes clarify or extend the requested scope without marking anything delivered.

## Mobile app

- **(Closed 2026-09-24: current physical-cover 3D is enough) Collection 3D model viewer:** view actual 3D models in Collection, rather than merely giving covers a 3D presentation. This clarifies the earlier `MOBILE-UX-001` 3D feasibility question; renderer and supported formats remain undecided.
- **New-release notifications:** add notifications for new releases. Follow targets and notification delivery details remain to be defined.
- **(Partly covered: mobile reviews PC-discovered similarity pairs, MOBILE-PARITY-001 slice 3; on-device discovery not built) Asset duplicate checking:** make duplicate checking available in the mobile Asset Library. Build on the completed desktop `SIMILARITY-004` discovery where relevant; keep this distinct from Catalog edition duplicates.
- **Manga Catalog duplicate-edition checking — decided 2026-09-24, queued after vault A1 / file exchange / notes v2 (can run in parallel with mobile work since it is mostly PC + server):** keep the full comparison on the PC — the PC computes duplicate-edition candidates with the existing `catalog_review.rs` rules (title match, artist/group overlap, page count, category, language) and publishes them with the catalog; the server does not recompute the whole catalog (VPS: 1 CPU, 1.6 GB RAM, ~131k works). The server only checks works it adds itself during hourly refresh (indexed title lookup, milliseconds each). Review decisions (hide/keep) are server-owned so PC and mobile share them; mobile gets a review screen that reads the precomputed list; the PC applies the decisions. Works with the PC off for already-published candidates and server-added works.
- **Asset Library multi-select move:** select multiple assets and move them together. Clarified 2026-09-24: both targets — add to albums and change classification (folders). Coordinate with `MOBILE-WRITE-002`; the destination and move semantics remain to be defined.

## Shared — Desktop and mobile

- **Artist Revisit on Home (2026-09-24: Revisit will be rebuilt from scratch later, PC and mobile; Home redesign waits for it):** surface artist rediscovery on the Home screen. Coordinate with `ARTIST-001`; this explicitly requests Home placement, not only an Artist hub.
- **(Deferred 2026-09-24: hope S36 improves it; revisit later) Competing character candidates in multi-person images:** improve the competing-candidate system when one image contains multiple people. Track as a bounded follow-up to the accepted character-classification pass, not a reopening of all accuracy work.

## Browser extension

These follow-ups apply to the active collector in `extension-list/` and relate to `EXT-011` / `EXT-012` (both closed 2026-09-23 and archived); they remain pending requests of their own.

- **(Done, user-confirmed 2026-09-24) Animation polish:** refine the semicircle menu's entrance and roulette-spinning animations for a more professional presentation.
- **(Done, user-confirmed 2026-09-24) Selection feedback:** improve the extension menu's visual selection effects.
- **(Done, user-confirmed 2026-09-24) Twitter/X GIF downloads:** support downloading GIF media from Twitter/X posts.

## Suggested implementation sequence — retained for later selection

Recorded at the user's request after the backlog review. This is a recommendation, not a replacement for Current priority / Current execution order, an activation of HOLD items, or authorization to implement or deploy. Existing item statuses remain unchanged.

Suggested first sequence:

1. **Extension polish:** refine entrance, roulette and selection effects. (The persistent-semicircle-after-navigation bug was confirmed resolved by the user on 2026-09-23.)
2. **Home artist Revisit (`ARTIST-001`):** start with a small Home rediscovery module, such as long-unseen or recently collected artists, rather than requiring the complete Artist hub first.
3. **Mobile multi-select move:** define album-membership changes versus actual folder/file moves before implementation; coordinate the chosen write scope with `MOBILE-WRITE-002`.

Mobile tab switching and `SIMILARITY-004` from the original sequence were completed on 2026-09-23. If prioritizing everyday usability, start with extension reliability.

Other follow-up candidates, without a fixed order:

- **(Done, user-confirmed 2026-09-24) Twitter/X GIF downloads:** inspect the current extraction/save path and add the missing support.
- **New-release notifications:** define followed artists/works and in-app versus Android notification delivery separately from Catalog refresh.
- **Mobile Asset duplicate review:** expose candidate inspection and decisions separately from the discovery operation above.
- **Mobile Manga Catalog edition review:** define candidate/evidence sharing and decision authority; published edition groups alone are not pending review candidates. Keep this separate from Asset duplicate review.
- **(Closed 2026-09-24) Collection 3D model viewer:** decide supported model formats, touch interaction and device performance limits; this is not the existing physical-cover renderer.
- **Multi-person character competition:** collect concrete mistakes and improve the affected arbitration cases without reopening the entire accepted classification pass.
- **Film Collection polish (`WORKS-001`):** implemented on desktop and mobile 2026-09-24; remaining is in-app acceptance.
- **AV metadata and cover acquisition (`LONG-001`):** fetch candidates and let the user choose artwork without silently replacing manual choices.

Keep larger foundation work separately scoped: durable mobile metadata (`MOBILE-CACHE-001`), additional mobile edit domains (`MOBILE-WRITE-002`), remaining Character/Collection ownership and publication cleanup (`CLOUD-POST-001`), server-owned jobs with PC workers (`CLOUD-WORK-001`), and safe global deletion (`MOBILE-003`). This recommendation does not restart completed authority rollouts or promote deferred architecture work.

Do not count implemented flows awaiting acceptance as new feature builds: PC-off Capture, early Asset visibility during classification, existing extension flows, similar-video sample validation and statistics verification. Catalog refresh retains its bounded acceptance/grouping-reconciliation scope. New extension bugs and feature requests above remain separate pending work. Optional providers, clustering/Jev experiments, large-scale similarity indexing and date-timeline exploration remain lower priority or deferred under their existing entries.

### First recommended batch — extension reliability and interaction polish

Planning checkpoint, 2026-09-21: source inspection only; no implementation, browser reproduction, device acceptance or deployment. This expands recommendation 1 above without changing the existing priority list; `EXT-011` / `EXT-012` were later closed on 2026-09-23.

Subsequent visual study: [three One UI-inspired concepts](../prototypes/collector-one-ui-concepts/index.html) and [comparison image](../prototypes/collector-one-ui-concepts/overview.png) present A — Everyday Light, B — Midnight Edge, and C — Soft Orbit. All show a separated center, spaced rounded sectors and the same selected folder. The standalone prototype only previews local selection; it performs no saves or network requests and does not implement dial motion or production lifecycle behavior. Headless Chrome rendering at 1680×1100 was inspected and JavaScript syntax checked. This is not live-extension, touch, animation or navigation-bug acceptance. The user subsequently chose B's dark appearance as the refinement base, not as production acceptance.

Refined B visual prototype: [interactive root-screen study](../prototypes/collector-one-ui-concepts/b-refined.html), [ordinary selected folder](../prototypes/collector-one-ui-concepts/b-refined.png), and [selected branch folder](../prototypes/collector-one-ui-concepts/b-refined-branch.png). Save and Temporary save now share one continuous central panel; checkmarks, branch chevrons and repeated destination text are removed. At the user's subsequent request, the central text labels are replaced by coordinated outline icons: folder-with-inward-arrow for Save and download-to-tray for Temporary save, retaining accessible action names and keyboard controls. Character and Game sectors expose a second surface behind the front face. Headless Chrome renders at 560×1080 were inspected in both selection states; focused jsdom checks passed for six sectors, two layered branches, mouse/keyboard selection, selected-branch styling and preview-only actions. The original three concepts remain intact. This is still a local prototype: no actual saving, dial rotation, production extension changes or device acceptance. The following motion checkpoint adds fixture child navigation to the previously static study.

Motion checkpoint, 2026-09-21: the user accepted the refined visual direction and requested entrance, save and child-navigation animation without perceived waiting. The same HTML now loads `b-refined.js`: entrance is 140 ms, child/Back transitions are 110 ms, and simulated successful-save dismissal runs for 100 ms alongside icon feedback. Selection and navigation state change synchronously; no action awaits animation completion and new input replaces in-flight effects rather than queueing. Single tap selects, double tap or ArrowRight opens fixture children, and the lower central action becomes Back inside folders. The standalone Replay control can interrupt dismissal; reduced motion skips effects while preserving actions and cleanup. Actual save success must remain receipt-driven when integrated, not inferred from an animation.

Verification: `node --test docs/prototypes/collector-one-ui-concepts/b-refined.test.mjs` passed 11 tests covering immediate interaction, nested navigation/Back, icon-only actions, simulated saves, stale-completion protection, reduced motion, gap dismissal and page departure. A bounded headless Chrome check observed real Web Animations progression, immediate selection during entrance, child-transition timing, simultaneous dismissal, interrupted reopening and reduced-motion behavior with no runtime exceptions. Root and [mid-transition child](../prototypes/collector-one-ui-concepts/b-motion-child.png) renders were inspected at 560×1080. This validates the local motion prototype, not the live extension navigation bug, production saves or Galaxy Tab touch feel.

Smoothing follow-up: the user found child navigation abrupt. Source inspection showed immediate removal of the old sector tree followed by a 70%-opaque incoming page over 110 ms. The prototype now keeps one non-interactive, accessibility-hidden outgoing snapshot for a 140 ms fade and crossfades the new page in over 180 ms with no ring translation. Incoming controls still activate synchronously. Rapid navigation replaces the outgoing snapshot rather than stacking pages; replay, reduced motion, save completion and page departure clean up the snapshot. Entrance and save durations remain unchanged. A new regression check failed against the previous immediate-removal implementation, then all 14 focused tests passed after the change. Bounded Chrome checks confirmed both layers at intermediate opacity, immediate selection during the crossfade, interruption cleanup and reduced motion without runtime exceptions; the 70 ms transition frame was inspected. Perceived smoothness on the user's device remains a user acceptance check.

Implementation checkpoint, 2026-09-21 (`extension-list/` 3.0.0.30): the user approved the refined B motion and explicitly expanded this batch to include X GIF-like media. The active renderer now uses dark rounded/separated sectors, rear branch layers and one icon-only central panel (upper Save, lower Temporary/Back). Entrance is 140 ms; folder navigation crossfades one inert outgoing snapshot for 140 ms with immediately usable incoming controls over 180 ms; confirmed-success feedback and exit run concurrently for 100 ms. Reduced motion skips these effects and dial coasting. Existing live hierarchy, pins/order, rotary overflow, explicit-save and opening-release behavior remain intact.

The controller now observes navigation for armed, pending and open invocations, with unconditional disposal even while locked or saving. Navigation API commits and page departure are handled directly, with history/hash events and a session-scoped URL poll on older browsers. Late state/save/unlock callbacks cannot take ownership of a newer menu; an accepted save is not resubmitted or reported as cancelled. The source-level cause was missing navigation teardown combined with guarded ordinary dismissal. The user's exact live X incident has not been reproduced on their device.

X progressive MP4 resources exposed by a mounted player or its `source` child are retained; otherwise the worker resolves the selected media through the existing public endpoint. Mixed-media ordinals, nested players, avatars/posters and quote boundaries are covered, and unavailable selected media never falls back to a different video. X animations served as MP4 retain MP4 bytes and the existing `video` capture contract; actual GIF handling remains supported. PC temporary downloads accept these X videos; Android's image-only temporary intent remains unchanged. No new dependency, permission, backend deployment or production-library write was introduced.

Verification: the combined worktree passed all **160 extension tests** with `npm test`. A bounded headless Chrome fixture loaded the actual renderer/controller and checked both edges, settings preview, rounded hit geometry and the central gutter, immediate controls, real 140/180 ms crossfade progression, interrupted navigation, receipt-gated 100 ms exit, reopening, reduced motion, real Navigation API cleanup while input-locked, and touch-release unlock. Root/left/settings/transition renders were inspected at 560×900 with no runtime exceptions in the final run. This is browser-fixture evidence, not installed-extension, live-server or Galaxy Tab/Titanium acceptance. The supplied post `2100596455262331116` remains unverified publicly; do not infer that it is private or deleted. Reload the extension and collecting tabs to activate this revision. Existing `EXT-011` / `EXT-012` device-acceptance status is unchanged.

The following initial plan is retained as context; the implementation checkpoint above supersedes its prototype-only status and original GIF exclusion.

**Scope and preserved behavior:** active `extension-list/` only. Keep the edge-attached semicircle, six visible folders, fixed central actions, live classification tree and portable order/pins. Preserve single-tap selection, double-tap child navigation, explicit Save, opening-finger protection and Back restoring selection/dial position. The user's subsequent design direction replaces the earlier warm-gray/NieR-like visual treatment with a Samsung One UI-inspired presentation for this extension surface only; it does not redesign Desktop or the Android app. The subsequent user request includes Twitter/X GIF support through existing capture/download contracts. Pairing changes, backend changes, new permissions/dependencies and legacy `extension/` edits remain excluded.

**Inspected baseline:** `src/content.js` owns the gesture/session and asynchronous opening; its scroll/wheel/blur cancellation only resets the armed phase, and it has no collector navigation teardown. `src/arc-collector.js` has internal disposal for DOM, timers and animation frames, but exposes `close` as the guarded `cancel` action, which is blocked while busy or input-locked. This supports a navigation-lifecycle hypothesis, not a confirmed cause of the user's incident. The dial already has continuous position, bounded momentum, friction, late detent capture and stable wedge/label nodes; do not replace it with a new animation engine. The current arc CSS has no entrance/exit transition or reduced-motion branch. Use the active README and manifest as the extension baseline; the older `docs/edge-extension.md` describes legacy UI.

1. **Reproduce and fix navigation cleanup first.**
   - Exercise same-document navigation on X, browser Back/Forward, normal document navigation and page restoration. Cover pending state loading, open idle, opening-finger lock, spinning and in-flight save states; determine which reproduces the report.
   - Select the smallest navigation detection supported by the actual extension/browser context. Do not assume that a content-script History API wrapper observes page-world calls, or that `popstate` covers `pushState` / `replaceState`.
   - Separate ordinary guarded dismissal from unconditional session disposal on navigation. Clear overlay/backdrop, animation frames, timers, pointer ownership, input locks and click suppression; make disposal idempotent and allow the next page to open a fresh collector.
   - Invalidate stale asynchronous opening/UI callbacks so a late result cannot recreate the old menu, close a newer session, steal focus or show stale failure UI. UI disposal must not be described as cancelling an already submitted save, nor trigger a retry/duplicate save; preserve legitimate save results and existing side-effect semantics.
   - Acceptance: navigation leaves no stale menu or input-blocking layer, late state responses cannot reopen it, and the next collection gesture works normally. Ordinary scrolling while an idle menu is open is not navigation.
2. **Redesign the static geometry and surfaces before tuning motion.**
   - User direction: emphasize a polished Samsung/One UI-like system-control appearance rather than the existing NieR-like instrument treatment. This is a visual reference, not Samsung branding, affiliation or verified compliance with an official specification.
   - Separate the central action cluster from the surrounding folder ring with a visible radial gutter. Separate adjacent folder sectors with consistent gaps and soften each sector's corners, retaining the overall semicircular arrangement rather than replacing it with a rectangular grid.
   - Initial visual-study values, not approved device measurements: central-to-ring gutter around 8–12 CSS px and adjacent-sector gaps around 4–6 CSS px at the current tablet size. Adjust against actual label space and touch targets rather than shrinking every control to force these numbers.
   - Refined B direction: keep Save and Temporary save together inside one continuous rounded central panel, not as a detached button below the menu. Give Save the larger primary area and Temporary save a smaller lower area, with a quiet internal gap. Use icon-only central actions: folder-with-inward-arrow for Save and download-to-tray for Temporary save. Keep accessible names and keyboard focus without adding hover tooltips or repeating destination text. Preserve explicit-save safety and the root/child action semantics when adapting this design to the live collector; the current refinement previews the root screen only.
   - Use the selected B direction: graphite/dark-neutral surfaces, readable light labels, restrained elevation and a blue selection accent. Replace beige/olive tones, metallic gradients and heavy machined rims. Keep disabled actions visibly muted; do not add a theme-setting system in this batch.
   - Use consistent, readable labels and preserve folder names. Indicate child folders with a second subtly offset sector surface visible behind the front face, rather than chevrons, counts or new icons. Keep the extra layer within the sector's allocated bounds so gutters remain open; distinguish it from selection through geometry rather than blue color. No Samsung logo, proprietary font acquisition or new icon dependency.
   - The current sectors use polygon clip paths: rounded outer corners on the button alone will not round each wedge. Choose the smallest geometry change that actually produces rounded, separated sectors while retaining node reuse and matching hit areas.
   - Gaps inside the menu envelope must not select a neighboring folder, submit media, dismiss the menu accidentally or click through to the page. Preserve deliberate outside dismissal and usable ring dragging. Check both left and right edges, long Korean/Japanese names and the settings preview.
3. **Define selection, press and keyboard-focus feedback.**
   - Refined B default: quiet dark-neutral sector; hover: subtle tonal change on mouse devices; press: immediate restrained feedback without moving hit targets; selected: blue surface, stronger label weight and a subtle inner edge. Remove selection checkmarks. Keep a separate visible keyboard-focus treatment, including the runtime label overlay outside the clipped sector.
   - Keep the chosen folder obvious even after pointer release and during rotation without permanently repeating its name inside the central Save button. Before live integration, resolve destination visibility when the selected sector rotates out of view; the static prototype does not exercise this case.
   - Distinguish selected, focused, disabled and saving states. Maintain accessible names, `aria-pressed`, contrast and opening-release protection; animation must not delay selection or trigger saving.
4. **Add restrained entrance and dismissal motion.**
   - Initial tuning proposal: 120–160 ms entrance with a small inward movement from the chosen edge and opacity; 80–120 ms ordinary dismissal. Aim for a smooth system panel, not a theatrical roulette reveal. No bounce, overshoot, staged folder reveal or long input delay.
   - Keep left/right mirroring separate from the animated transform. Navigation disposal is immediate and must never wait for `animationend` / `transitionend`.
   - Reduced motion removes positional animation and avoids delaying cleanup. Do not animate every settings-preview render.
5. **Refine the existing roulette/dial feel.**
   - Retain continuous direct manipulation, bounded momentum and late nearest-slot settling. Tune acceleration/deceleration from observed wheel, trackpad and touch behavior rather than merely increasing speed or adding exaggerated rotations.
   - Keep the central buttons stationary; separated sectors and their labels travel together without popping, clipping or changing selection identity. Preserve Back restoration, short lists and overflow behavior.
   - Stop animation work when settled or disposed. Reduced motion should retain direct manipulation but avoid prolonged post-release coasting. Verify interruption by a new drag, direction reversal and navigation; preserve no-save/no-selection behavior after a drag.

**Execution and verification:** implement in the numbered order, starting with a regression reproduction for navigation and then a static visual pass before motion tuning. Expected source scope is `extension-list/src/content.js` and `extension-list/src/arc-collector.js`, plus the active README and focused tests as needed. Use `node --test tests/content-gesture.test.mjs tests/controller.test.mjs tests/arc-collector.test.mjs` from `extension-list/` for lifecycle/interaction changes; add cases for navigation during pending opening, locked/busy states, late callbacks and fresh reopening. Geometry changes also need real rendered/hit-area inspection, not just DOM assertions. Inspect default/selected/pressed/focus/disabled/saving states, left/right layouts, rotation and reduced motion. Check Desktop Chromium and Galaxy Tab/Titanium separately; fixture success cannot establish native touch or live capture acceptance. Any save acceptance that writes production data requires its own authorization. No tests or visual runtime checks have been run for this planning checkpoint.

# Mobile portrait usability feedback

## MOBILE-UX-001 — Portrait real-use follow-up

Status: `PARTIAL` — the 0.7 browse-first redesign replaced the PC-style Library drawer and Collections toolbar; the user tried 0.7.3 on the Galaxy Tab and reported it working normally, and 0.7.6 (33) is installed. See the [2026-09-23 evening checkpoint](lakomics-completed.md#closure-checkpoint--2026-09-23-evening--mobile-07-thumbnails-and-dependencies) and `android/README.md`. Remaining: a landscape two-pane Library (deferred by design; landscape currently reuses the single-column drill-down), a Catalog and Notes redesign on the same principles, a 3-column root card option if 2 columns feel large, and the older items below that the redesign did not address (dimension/duplicate-check evaluations, 3D model files, classification capacity). The dated records below are history.

2026-09-19 Galaxy Tab feedback after the first portrait UI pass. These are user-reported observations and requested improvements, not independently reproduced defects or confirmed root causes. Keep portrait as the priority; landscape redesign remains later.

- **New-asset thumbnails missing on mobile, including after PC startup:** the initial report associated missing thumbnails with the PC app being off, but the user subsequently reports that starting the PC app still does not make new-asset thumbnails appear on mobile. This supersedes the assumption that running PC resolves the symptom; the initial report alone did not establish a root cause. The affected-asset trace and subsequent image-only server fix are recorded below. Verify real tablet rendering separately from server generation and delivery. The current media-delivery scope was subsequently accepted under archived `MEDIA-R2-001`; extra media variants are not required by this report. If a new ingest or worker dependency is demonstrated, coordinate with `CLOUD-INGEST-002` / `CLOUD-WORK-001`; this report does not authorize those broader migrations.
- **Asset Viewer information-panel design:** reorganize the panel for compact portrait use, reducing wasted space and redundant text while keeping the asset visually primary.
- **Asset Viewer information parity and copying:** the panel exposes less information than PC. Compare the actual PC/mobile fields and make useful missing information available on mobile. The first implementation copies creator text, the source URL, and a file-information summary; binary asset copying is not included.
- **Asset dimensions on the server:** include the asset's pixel width and height in server-backed metadata so mobile can display dimensions consistently with PC, including when the PC app is not running after synchronization. Trace existing extraction, synchronization, API and mobile presentation fields before deciding what is missing; no missing schema or confirmed transport defect is asserted yet. Coordinate with the Viewer information-parity item. Any production metadata backfill requires separate approval.
- **Sidebar folder-type icons:** add distinct icons for Character folders and Group folders so their types are recognizable at a glance.
- **Nested-folder selection highlight:** the user reports that the white selected-state highlight overlaps the line below the folder's `>` marker. The proposed direction is to limit the highlight to the folder-icon area so it does not overlap the hierarchy line; confirm the exact visual bounds against the current UI or a screenshot before implementation.

- **Character-folder thumbnail cropping:** the user reports that Character-folder thumbnails are too wide and appear cropped. Inspect the portrait container aspect ratio and image-fit behavior, then adjust the presentation to keep the character recognizable without distortion. The exact crop/container cause has not been verified.
- **Character-folder Back destination:** after entering a Character folder and going back, the user lands in a category labeled Series, whose purpose is unclear and which the user considers unnecessary. Reproduce the entry/return path and identify whether Series is an intentional parent screen, an exposed internal grouping, or an incorrect navigation fallback. Check both in-app and Android Back because the reported Back mechanism is unspecified. Prefer returning to the actual prior browsing context without an unnecessary intermediate screen; do not remove underlying classification data based on this UI report. Cause and intended destination remain to be verified.
- **Catalog hidden-tag controls:** place PC-style excluded-tag entry in a dedicated Catalog settings panel opened from a top-bar icon. A namespaced entry such as `female:scat` hides works carrying that tag; it is not a title substring exclusion or an ordinary search term. Trace PC matching/normalization and shared-policy ownership before adding writes, preserving namespace semantics and avoiding PC/mobile overwrite conflicts.
- **Catalog category controls:** replace the first-pass single-category selector with a checklist in the same Catalog settings panel, using existing PC categories. The user can include several categories at once, such as Doujinshi, Manga and Artist CG; selected categories combine with OR, then intersect with the search and exclusion policy. Do not require category query syntax or leave a separate category-filter row in the gallery. Preserve the chosen settings across searches. Define all/none selection and storage/sync behavior explicitly during implementation.
- **Catalog automatic refresh cadence:** the user subsequently requested a one-hour interval. The server-side incremental scheduler is implemented and tested in the later checkpoint below; deployment remains pending. Distinguish provider ingestion from mobile publication detection and bookmark polling.
- **Catalog duplicate checking (evaluation):** the user asks whether the PC's duplicate-check feature can be brought to mobile and suspects it may depend on a running PC. Trace the existing Catalog duplicate-check data and execution dependencies, distinguish already-known results from newly computed checks, and assess PC-off support before choosing an implementation. Neither the dependency nor mobile feasibility is confirmed; do not conflate this with general near-duplicate similarity scanning.

### 2026-09-20 next portrait pass: requested scope

The following records the requested scope; the implementation checkpoint below
identifies delivered source versus still-open investigations. The user's attached
PC sidebar screenshot is the visual reference. Keep artwork
primary, controls compact, and landscape redesign deferred.

1. **Catalog settings and search:** use the top-bar settings icon and category/hidden-tag contracts above. Make ordinary space-separated input find the same relevant indexed names/tags as underscore-separated input; reproduce the failing query path before changing parsing. Preserve explicit namespaces, quoted expressions and operators rather than blindly replacing all spaces with underscores. Verify category inclusion, excluded tags, pagination/counts and search together, not just the first visible page.
2. **PC-aligned mobile sidebar:** use the screenshot's compact hierarchy, separators, folder rows and consistent icon language as a reference without mechanically shrinking desktop hit targets. Remove the Recent saved tab and make All the default destination, retaining chronological access through the existing All ordering rather than deleting recent assets or metadata. Reproduce and correct malformed Album icons. Reuse the PC icons and corresponding semantics for expanding only the selected folder, collapsing all folders and related tree controls; inspect the PC actions instead of guessing from glyphs. Preserve the earlier selection-fill and direct Character Back fixes.
3. **Collection long-text balance (design):** titles and creator/studio names that exceed two lines currently disturb the visual balance, per the user. Inspect actual card layouts and representative long Korean/Japanese/Latin values. Evaluate a consistent reserved title area (for example, two lines), a bounded secondary creator line and full text on the existing detail surface. Do not shrink text per item, introduce hover-only disclosure or change cover proportions merely to accommodate a long name. The exact layout remains a design decision, not accepted implementation.
4. **3D feasibility (investigation):** assess the intended use before choosing a renderer: displaying actual 3D model assets and giving Collection covers a 3D presentation are different scopes. Evaluate Android WebView/device GPU compatibility, memory, battery, loading and a usable static fallback. No engine dependency, per-card live 3D contexts, asset conversion pipeline or server rendering is approved by this record.
5. **Character classification server load (investigation):** locate where current inference, reference embeddings, matching and result synchronization actually execute; do not assume all classification runs on the VPS. Separately estimate/measure whether server-side execution is viable on the existing small server, including model residency, CPU/GPU needs, concurrent work and impact on the API. Thumbnail-generation success does not establish classification capacity. Do not migrate inference or run a production classification/backfill workload merely to evaluate it.
6. **Settings-window cleanup:** audit the mobile settings window end to end and retain settings for currently used, functioning features. Consolidate duplicates, remove obsolete or nonfunctional placeholder controls, reduce redundant explanation, and keep context-specific Catalog options in Catalog settings rather than duplicating them globally. Trace actual consumers before removing an apparently unused option. Preserve necessary connection/authentication, security, data-safety and recovery controls in an appropriately compact secondary section; do not delete saved configuration or user data as part of UI cleanup. This is a mobile cleanup request, not blanket permission to remove PC settings or their underlying capabilities.

Suggested implementation order: Catalog settings/search, sidebar and global settings
cleanup, then Collection typography. Keep the 3D and classification-capacity questions
as bounded investigations rather than coupling them to these UI changes. Previously
open dimensions, duplicate-check evaluation, video/GIF thumbnails and real-device
interaction acceptance remain tracked; this pass does not mark them complete.

### 2026-09-20 next portrait bundle: source checkpoint

- **Catalog settings:** a single contextual top-bar button opens the shared dialog. Category checkboxes combine with OR; unrestricted/all is the default, an empty selection returns no works, and several categories can be included together. A single `namespace:value` input, such as `female:scat`, adds exact namespaced avoidance tags. Apply commits the draft once; opening, cancelling or applying unchanged settings preserves browsing state and unsent search text.
- **Ownership:** display preferences are stored on this device, scoped to the configured endpoint. They do not write `/visibility` or synchronize settings back to PC. The published PC policy still applies unless the existing explicit reveal option is used; device exclusions still apply when revealing that policy. New additive read parameters are advertised by `capabilities.displayPreferencesVersion:1`. An unsupported server keeps legacy browsing when no local filter is active; saved filters are never silently ignored, and capability-check failure has a retry action.
- **Server query:** categories and avoidance tags constrain eligibility before grouping, counts, pagination, detail, editions and reader access. Filtered queries bypass baked pages/counts and retain the conditions in signed tokens. JSON filter, normalized-query and native-path bounds prevent oversized preferences from breaking page navigation. No new write authority, catalog replacement or production backfill is introduced.
- **Search:** opt-in `searchMode=mobile` allows a whole plain phrase such as `john doe` to match exact tags stored as `john_doe` or `john doe`, with the same convenience for `artist:john doe`. The existing title-word branch remains; underscores and percent signs do not become SQL wildcards. Explicit operators/quotes retain their grammar, with separator aliases only on exact tag values. Clients omitting the mode retain the previous parser.
- **Sidebar/global settings:** Library starts at All; the redundant Recent saved sidebar entry is removed (the separate Home destination remains). Nested indentation and selection stay outside the expander/connector; Album appearance uses PC icon/color mappings. Collapse-all and current-path actions use the PC glyphs. Connection editing is collapsed when configured, while authentication, private-network security, media-cache operations and picker recovery remain available.
- **Collection/Viewer:** cards reserve a two-line title area and keep creator/studio text on one ellipsized line. The existing detail view exposes full names. Viewer information avoids a duplicate section/row heading while retaining values, copy actions and nested Back behavior. Cover proportions are unchanged.

Verification on the local checkout: the full mobile suite passed **293 tests / 26 files**; two subsequent publication-check regression tests were added, and that focused file passed **3 tests**. Mobile TypeScript/Vite production build passed. The real SQLite query suite passed **30 tests**, including the shared PC fixture, exact tag aliases, literal wildcard characters, prepared/fallback eligibility, counts and editions. The final HTTP/cursor suite could not import because local Python lacks `fastapi`; syntax checks passed, but HTTP acceptance is **not** claimed. Earlier worker results do not establish acceptance of the final rewritten query implementation.

Rendered fixture checks covered 390x844 and 800x1280 portrait and 1280x800 landscape. Final Catalog-dialog checks confirmed 11 initially checked categories, one tag input, visible Apply actions, no horizontal overflow and no runtime exceptions. Collection long-text and nested-sidebar screenshots were also inspected. These are browser fixtures, not Galaxy Tab, live Catalog or native acceptance. No new server deployment, APK build/install, Git commit/push or production-library write was performed for this bundle. Next operational step: separately authorize final server API verification/deployment and APK delivery, then accept the portrait interactions on the tablet.

### 2026-09-20 authorized API rollout and APK delivery

This operational checkpoint supersedes the source checkpoint's pending deployment/build/install and missing-FastAPI verification gaps, not its remaining real-device interaction gaps.

- **Server tests:** 71 final Catalog/filter/search/replica/refresh tests passed in 4.669 seconds in an isolated remote stage, using the existing production venv and live dependency modules. No production configuration, database or startup was loaded by those tests.
- **Deployment:** only `mobile_catalog.py`, `mobile_catalog_query.py` and `mobile_catalog_replica.py` were replaced after baseline/candidate SHA-256 verification. Rollback source copies and a SQLite online main-database backup (`quick_check=ok`) remain at `/home/linuxuser/lakomics-catalog-release-20260920/rollback-064`. Existing thumbnail code and `app.py` stayed unchanged; dimensions were not deployed. The API and existing HTTPS local proxy ended active/running with `NRestarts=0`.
- **Read-only live acceptance:** public tailnet HTTPS health/status returned 200 and advertised `displayPreferencesVersion:1`. Legacy browsing and pre-deployment cursors/detail contexts still worked. Empty categories returned zero items/count; multiple categories plus avoidance tags supported list/count/pagination/detail/editions. Empty-category detail access returned 404; unauthenticated status returned 401. A real artist query returned identical nonempty results for underscore and space spellings. Representative filtered pages took 2.0–2.2 seconds, count about 1.0 second and alias searches about 1.0 second; no sustained capacity claim follows. Publication `ba0e4c2bc7558bee67db0b386a0cfc90108ea5437c39e83510124e76629a1795`, its policy revision and publication count remained unchanged by these checks. No refresh, catalog backfill or production-library write was performed.
- **APK:** 0.6.4 (20), 1,246,628 bytes, SHA-256 `79619ce24f82f6fceca652b96f9402a7720d507d3117ef617a0aeccc4fc53279`. Mobile TypeScript/Vite and native release build passed, including existing native regression checks; alignment and v2/v3 signatures matched the existing installation identity. Settings version checks passed 8 tests.
- **Galaxy Tab S11:** target `SM-X730` was verified, in-place `adb install -r` succeeded, package metadata confirmed 0.6.4 (20), and `am start -W` reported `Status: ok` with the process alive afterward. No uninstall, data/cache reset or credential replacement occurred. Another app was foregrounded during subsequent inspection, so no further UI manipulation was attempted. This confirms installation/startup only, not the new portrait controls' visual/touch acceptance or end-to-end authenticated browsing.
- **Still open:** tablet acceptance of the Catalog dialog/search, nested sidebar controls, Settings and Collection/Viewer polish; the separately tracked dimensions, duplicate-check, video/GIF, 3D and classification-capacity work. No Git commit/push was performed for this bundle.

### 2026-09-20 icon cleanup delivered as 0.6.5

Following device feedback, Catalog settings uses a funnel instead of the global settings sliders. The Album heading's decorative folder icon and the expand-all folder control are removed; individual expansion, collapse-all and current-path expansion remain. App/Albums/Catalog tests passed 71 cases, and Settings passed 8 cases after the version bump. TypeScript/Vite and native APK build/checks passed, including alignment and existing-signer v2/v3 verification. APK SHA-256: `eddedb3266781d6dfed7ad46fd3774dccae9e1d099732124207e7e68b357d03e`. Authorized in-place installation on Galaxy Tab S11 succeeded; installed version 0.6.5 (21) and cold startup `Status: ok` were verified without uninstall or data reset. Visual/touch acceptance remains separate. No additional server deployment or Git write occurred.

### 2026-09-20 media metadata and parallel investigation checkpoint

At this source checkpoint, no production deployment, dependency installation,
historical repair, APK delivery or Git write had occurred. The authorized rollout
below supersedes the deployment/tool-installation gap, not tablet acceptance.

- **New Capture media:** `image_thumbnails.py` now queues image/GIF/video insertions.
  Existing image key recipes remain unchanged. GIF uses Pillow's first frame without
  FFmpeg or a full animation scan; total GIF duration remains unknown. MP4/MOV and
  WebM/Matroska use one bounded FFmpeg poster frame, with source rotation reflected in
  dimensions and declared video duration in milliseconds. GIF-kind MP4 retains its
  canonical kind. Animated PNG/WebP remain unsupported.
- **Metadata/read path:** a strict, bounded sidecar supplies source width/height, not
  the 512 px tile size. Thumbnail publication and missing metadata update atomically
  after rechecking visibility and source identity. Existing values win; incompatible
  partial dimensions are not combined. Ordinary Library and Album readers already
  expose these fields. Character publications still freeze Asset display metadata;
  an existing snapshot needs a later PC publication to reflect updated availability
  or dimensions. This batch does not change snapshot or lifecycle authority.
- **Resource/operational limits:** one encode at a time, 50 MiB image/GIF or 128 MiB
  video download, 24 MP source ceiling, 20 s outer timeout, bounded tool output and
  per-process resource limits. Parent process-group cleanup also handles an encoder
  that exits before its tool. These are protective bounds, not a sustained-load
  benchmark or an aggregate memory reservation. Missing tools produce terminal
  `encodeToolUnavailable` and do not block subsequent eligible jobs. Startup neither
  scans historical Assets nor retries terminal jobs. Rollout must include the
  existing application dimension migration before installing the worker and must
  provision video tools separately; read-only host checks found no FFmpeg/FFprobe.
- **Verification:** local `python3 -B -m unittest tests.test_image_thumbnails
  tests.test_media_thumbnail_worker tests.test_media_thumbnail_encode -q` passed
  **162 tests in 25.009 s**, no skips. Coverage includes real MP4/MOV/WebM/Matroska,
  real rotation metadata, short clips, GIF without FFmpeg, pipe floods/timeouts,
  descendant cleanup, queue upgrade without historical enqueue, publication races,
  metadata validation and preserving existing metadata. In isolated remote stage
  `/home/linuxuser/lakomics-media-test-20260920-uzl9_c32`, the existing venv ran
  `tests.test_image_thumbnail_api`, `tests.test_replication_api` and
  `tests.test_album_assets`: **54 tests passed in 2.835 s**. The copied app source,
  fake R2 and temporary SQLite were used without loading production settings/DB;
  encoder/worker/API-test hashes matched the local files. HTTP coverage confirms
  promoted image/GIF dimensions and thumbnail/original tickets without PC. A
  Starlette/httpx deprecation warning was non-failing. Video decoding was verified
  locally, not on the server or tablet. No Windows/native Android acceptance is claimed.

Investigation conclusions (source inspection, not new implementation):

- **Catalog refresh:** desktop defaults to enabled with a 3600 s due interval
  (`0018_online_catalog.sql`); `useOnlineCatalogUpdate.ts` checks immediately at
  mount and hourly thereafter. Mobile Catalog's 5 s publication check detects
  published changes; it does not ingest new works. `CatalogRefresh.tsx` observes
  refresh jobs at 2 s while busy / 30 s idle / 10 s after error. Its explicit request
  starts server-owned provider fetching (`mobile_catalog_refresh.py`), so it works
  independently of PC; no periodic server ingestion scheduler is implemented.
  Existing request bounds include one active job, up to 40 pages and 16 MiB staging.
- **Catalog edition merge review (not Asset duplicate review):** candidate generation and decisions remain PC-local in
  `catalog_review.rs`. Published groups can be browsed without PC, but groups are
  not pending candidates: generation skips pairs already in the same group. A
  mobile review feature needs an explicit candidate/evidence export and a decision
  authority contract; existing group data is not sufficient to reconstruct it.
- **Character capacity:** inference currently runs in the PC Python ONNX runtime
  with CPU execution (6 intra-op / 1 inter-op threads); the API serves the published
  snapshot, not inference. Collections, Characters and Catalog visibility have
  automatic dirty/debounced publication lanes in `auto_publication.rs`, not only
  manual publishing. The observed server has 1 vCPU and about 1.6 GiB RAM, with
  about 950 MiB available and 811 MiB swap used at the check. This snapshot does not
  establish active swapping or model throughput. Keep inference on PC for now;
  moving it to the shared VPS needs a separately scoped isolated model-memory and
  latency benchmark, not an unmeasured production trial.
- **3D:** desktop already has a shared custom WebGL2 physical-cover renderer and
  raster caching (`src/collections/physical/`); mobile currently uses flat artwork.
  Reuse/adaptation is feasible in principle, with static gallery fallback and at most
  one active interactive cover, but touch, WebView GPU behavior and battery cost need
  device validation. The bundled page and native media cache share
  `https://app.lakomics.local`; absent CORS headers alone are not a blocker on that
  same-origin path. Actual GLB/glTF model viewing is a separate unimplemented feature,
  not interchangeable with 3D book covers; no new renderer dependency is adopted.

The server rollout/tool-installation gate was subsequently authorized and completed
below. Next acceptance is new captures in the tablet Library/viewer. Historical
metadata/thumbnail repair remains separately scoped. After that, prioritize a small
portrait 3D-cover prototype or the duplicate-review contract rather than moving
character inference onto the VPS without capacity evidence.

### 2026-09-20 authorized media rollout

- **Tools:** installed official Ubuntu FFmpeg/FFprobe `7:8.0.1-3ubuntu2` with
  `--no-install-recommends`: 127 new packages including dependencies, no upgrades or
  removals. Unrelated service restarts were deferred; no dependency was added to
  the application's Python environment.
- **Host verification:** copied current sources/tests to the isolated
  `/home/linuxuser/lakomics-media-release-20260920-uazynrio/candidate` stage.
  Image worker, media worker, media encoder, thumbnail API, replication API and
  Album assets suites passed **216 tests in 111.294 s**, with no skips, using the
  existing venv, installed video tools, temporary SQLite and fake R2. This includes
  real MP4/MOV/WebM/Matroska and rotated-video decoding on the deployment host.
  The existing Starlette/httpx deprecation warning was non-failing.
- **Backup and scope:** retained original `app.py`, `album_authority.py`,
  `image_thumbnails.py` and `image_thumbnail_encode.py`, their SHA-256 manifest and
  a SQLite online backup under the release directory's `rollback/`; backup
  `PRAGMA quick_check` returned `ok`. Live/candidate module comparison found exactly
  these four differences. Guarded baseline and candidate hashes were checked before
  replacement, and deployed hashes matched afterward. No Catalog module changed.
- **Deployment:** stopped the API, replaced only those four modules, and started it
  with its existing service/configuration. Startup added nullable width/height/
  duration columns and upgraded the media INSERT trigger. The API-dependent existing
  HTTPS proxy stopped with the API and was explicitly restarted. Both finished
  `active/running`, `NRestarts=0`; no new service or public port was provisioned.
- **Live acceptance:** tailnet HTTPS health, authenticated Library list/generation,
  Catalog status and sync status returned 200. Three listed Assets carried the
  dimension/duration response fields; Catalog display-preferences version remained 1.
  An existing thumbnail ticket and WebP download returned 200 (24,950 bytes);
  unauthenticated Library access returned 401. All 22 completed thumbnail jobs and
  canonical lifecycle rows matched the pre-deployment backup. Existing metadata
  remained unknown (zero rows with dimensions/duration), confirming no historical
  fill or automatic repair at this checkpoint.
- **Remaining:** no new production Capture was created for testing and no tablet
  rendering was inspected. Verify a newly saved eligible image/GIF/video in the
  Gallery and Viewer. Historical repair, Character snapshot refresh, APK delivery,
  Git commit/push and sustained-load acceptance were not part of this rollout.

### 2026-09-20 authorized existing-video thumbnail repair

The user confirmed new thumbnail generation on the tablet, then explicitly requested
repair of existing video thumbnails. A read-only audit found four visible, committed
MP4 Assets with missing thumbnail keys, valid digests and sizes below the 128 MiB
worker limit (largest 11,658,049 bytes). Only those four IDs were enqueued through
`image_thumbnails.enqueue`; no failed job was reset and no second worker was started.
A checked SQLite backup and target/result manifests are retained in
`/home/linuxuser/lakomics-media-release-20260920-uazynrio/video-repair-v2icyb6u/`.

All four jobs finished `done` on their first attempt with no errors. Source dimensions
and duration were populated alongside the new thumbnails. Original object keys,
digests, sizes, content types and canonical kinds were unchanged. The authenticated
mobile media-ticket API returned four successful WebP tickets, and all four signed
downloads returned 200 with valid WebP signatures. The final visible supported-video
missing-thumbnail count was zero; the API remained active/running with `NRestarts=0`.
This confirms server generation and delivery; tablet rendering of these four repaired
items has not yet been separately confirmed. No APK or Git write was performed.

### 2026-09-23 video thumbnail limits and repair

Two X videos saved from the extension on 2026-09-23 showed no mobile thumbnail; both
jobs were terminal `sourceUndecodable`, while the files were valid. A 4K (3840x2160)
H.264 frame could not be decoded inside the 384 MiB encoder address-space cap (it
decodes at 768 MiB, peak RSS ~180 MiB, ~7 s CPU on the 1 vCPU host). The other video
(1426x1920) decoded fine on re-run: it had run out of time under load, and a timeout
was classified as terminal. Fix: video runs use 768 MiB, 30 s CPU and a 20 s decode
wall clock (worker bound 60 s); images are unchanged. A tool that runs out of wall
clock or CPU now exits `EXIT_TIMED_OUT` (8) and the worker retries it as
`encodeTimedOut`. Server tests 1,241/1,241 passed; the candidate encoder produced both
thumbnails on the host before deployment. Deployed after user approval (previous files
in `backups/video-thumb-limits-20260923T075105Z/`, service active, `NRestarts=0`), then
only the two failed jobs were re-queued with `retry_terminal`; both finished `done` on
the first attempt. Tablet rendering of these two items was not separately inspected.

### 2026-09-20 later posters, Asset filters and hourly refresh

**Implementation checkpoint (subsequent deployment/install recorded below):**

- Video poster recipe v2 uses an accurate duration-relative seek: 10% of duration,
  clamped to 0.5–3 seconds and capped at half-duration for sub-second clips. A clean
  no-frame result permits one first-frame fallback; tool failure/timeout does not.
  Long black introductions can still be black: this is not brightness-based scanning.
  Image/GIF recipes remain unchanged and existing video keys are not regenerated.
- Shared mobile Library/Album/Character filters: images (including GIF), videos;
  PC-compatible square ratio 0.8–1.25 inclusive, landscape and portrait; new mobile
  duration buckets under 30 s, 30–60 s, 1–5 min, and >=5 min. Server SQL filters before
  pagination. Cursor filter/scope binding preserves shipped unfiltered legacy layouts.
  Strict `filterVersion:1` checks include continuation and generation-change retries.
  Failed choices retain the previous committed gallery without relabelling it.
- Character membership/order/revision remain published; live technical metadata and
  visibility are overlaid at read time. Refresh invalidates technical-page caches even
  when publication revision is unchanged. Nested Back closes filters first.
- Durable per-language hourly scheduling reuses the existing bounded Catalog worker.
  Initial adoption waits one hour; zero/missing baselines are not backfilled. Partial
  checkpoints resume, failed/manual activity defers its own language, and one active
  job does not indefinitely postpone the other language. Idle due checks run every
  minute. Fetching already stops at each language's saved watermark; actual additions
  still copy the immutable artifact and prepare indexes/counts. No-change passes avoid
  artifact copies. This is not a full client delta protocol or old-work metadata refresh.

**Authorized production metadata repair completed:**

- Before: 8,956 visible committed Assets missing dimensions, including 421 videos
  missing duration. Imported 8,647 normal PC-backup rows only after exact ID, SHA-256,
  byte-size and kind matches (416 durations), then processed 309 remaining originals
  sequentially (304 images, 5 videos). About 228 MB of originals, not the full library,
  were needed; temporary encoded thumbnails were discarded, never uploaded/replaced.
- Final visible totals: 8,531 images, 5 GIFs, 427 videos. Missing dimensions/video
  durations: **zero**. Across all 8,999 stored Asset rows, exactly 8,956 changed only
  technical metadata; all other columns, including source/thumb keys and timestamps,
  were unchanged. `PRAGMA quick_check=ok`; API and proxy remained active. Authenticated
  live Library read confirmed all 40 returned Assets carried dimensions.
- Checked online backups, exact target manifests and result records are retained at
  `/home/linuxuser/lakomics-metadata-repair-20260920-kchr7f54/`; first pre-repair backup
  is `apply-ctl8p4ww/before.sqlite3`. The published PC metadata snapshot was read-only.
  The helper is operator-only, not a background scheduler; no catalog backfill, media
  re-upload, service restart, new deployment, APK install or Git write was performed.
- Extraction was a single sequential low-priority operator process using the deployed
  bounded encoder. The ordinary thumbnail worker stayed running, so this does not claim
  a global single-encoder lock or sustained-load benchmark for the repair.

**Verification and remaining acceptance:**

- Controller-observed local encoder/worker suites passed 180 tests; metadata helper and
  operator-fixture coverage passed 44 tests. Remote isolated scheduler/filter/thumbnail
  API selection passed 55 tests; the final filter-only check passed 31. Adjacent Library,
  Album, Character, replication and real-encoder selection ran 237 tests: 236 passed and
  one lacked a copied Character fixture; copying that existing fixture made the remaining
  test pass. Production DB/settings were not loaded by these tests.
- Mobile changed-surface checks and TypeScript passed. Full mobile suite: 339 passed,
  one Catalog Reader manifest-refresh timing assertion failed (expected two calls,
  observed three). The isolated Catalog file rerun passed all 36 tests. This suggests
  timing sensitivity, not a confirmed root cause; Catalog UI was not changed and no
  blanket full-suite success is claimed.
- Source review corrected an overflowing Character cursor, legacy classification cursor
  compatibility, a generation-retry filter-contract gap and stale Character technical
  cache reuse. At this source-test checkpoint native rendering and deployment remained
  unverified; the subsequent authorized delivery is recorded below.

**Authorized 0.6.6 delivery completed:**

- Deployed only `app.py`, `album_authority.py`, `mobile_characters.py`, `asset_filters.py`,
  `mobile_catalog_refresh.py`, `image_thumbnails.py` and `image_thumbnail_encode.py`.
  Candidate hashes matched local sources; their parsed implementations matched the
  previously verified isolated stage. Original modules, hash manifest and checked online
  DB backup remain under `/home/linuxuser/lakomics-mobile-066-release-20260920-0q0724jr/rollback/`.
  Operator metadata repair helpers were not installed into the service.
- Live HTTPS checks passed nine filter cases (83 returned rows across initial/continuation
  pages), disjoint pagination, mismatched-filter rejection, two actual pre-deployment
  Library/classification cursors, authentication and Character live technical fields.
  Korean/Japanese schedules were armed about 3,597 seconds ahead; zero jobs were active.
  No provider refresh was forced. Assets, Asset authority, domain state, Character
  publication and Catalog pointer fingerprints were unchanged across rollout.
- API and its dependent HTTPS proxy were both restarted as required and finished
  active/running with `NRestarts=0`. Deployed source hashes matched the candidate.
- APK `android/build/lakomics-mobile-0.6.6-release.apk`: 1,250,724 bytes, SHA-256
  `05bc479deba0d6debc7492ddbfb2f0f665bc5dbea8ca1a4a6d8841b69a0359ef`.
  Existing-certificate v2/v3 signing, alignment, manifest version and all 12 bundled
  asset bytes were verified. TypeScript/Vite and native release packaging completed;
  version-specific Settings tests passed 8/8. No dependencies or signing key were added.
- Galaxy Tab S11 accepted the in-place update to 0.6.6 (22), preserving first installation
  at `2026-09-08 17:56:50`. Cold launch returned `Status: ok`; the process remained running.
  A native portrait screenshot showed the gallery and active image/landscape filter state.
  No account reset, uninstall, cache clear or provider-setting changes were made.
- Remaining: first scheduled production refresh, fresh-video poster v2 end-to-end capture,
  exhaustive on-device Album/Character/duration interactions and landscape acceptance.
  Existing poster keys remain unchanged. No Git commit/push was performed.

**Next UI proposal, not implemented:** use a roughly 100 ms content opacity transition
only after new content commits, a 120–160 ms short drawer transition and a 120 ms folder
chevron rotation. Keep the old gallery until ready, honor reduced motion, and avoid tile
staggering, springs, sliding galleries or animated heights that disturb virtualization.

**Duplicate workflows stay separate:** Asset duplicate review compares image/video
files; Catalog edition merge review groups editions of a work. The earlier
`catalog_review.rs` investigation covers only the latter. Neither mobile review workflow
is implemented by this batch; do not treat published edition groups as Asset duplicates
or as pending merge candidates.

### 2026-09-19 implementation and investigation checkpoint

- **Thumbnail refresh:** reproduced a client-side failure in both Home and Gallery: a mounted asset initially marked `thumbnail_available:false` did not reload when fresh metadata changed that flag to `true`. Both effects now observe availability/pending transitions; two regression cases failed before the fix and passed afterward, with pause behavior retained. This client regression is separate from the live publication failure confirmed below; fixing refresh cannot supply an unregistered thumbnail. No queue repair, retry expansion or full backfill was run.
- **Affected-asset investigation (`x.com/hbd_bday/status/2101294431509057626/photo/1`):** after user-assisted SSH authentication, read-only inspection of the service-configured server database confirmed capture `70a9b791-5688-44da-bd9a-8090f1a6784b` was promoted at `2026-09-19T13:45:17.738847+00:00` to Asset `0846fbe5-7578-5562-9195-88dd93342926`. The Asset is normal and committed, retains the capture inbox original key, and has `thumbnail_key=NULL`. The live `/v1/library/media-tickets` response independently returned thumbnail `ok:false,error:unavailable` and original `ok:true,content_type:image/jpeg,size_bytes:723518`; signed URLs and credentials were not printed. Deployed `asset_authority.promote_capture` inserts new Assets without thumbnail metadata, confirming the affected ingestion path. PC source tracing shows local image thumbnails can be generated during authority materialization, but server-owned Assets are excluded from legacy outbound upserts. Thus this case has a server-side thumbnail publication gap, not merely stale mobile rendering; physical absence of all possible orphan thumbnail objects was not audited. The running Linux desktop holds its library lock under `before-linux-backup/New_lakomics_assets`; its data was not queried and local materialization for this Asset remains unverified. At that read-only investigation checkpoint no production writes, cache reset, queue reconciliation or backfill were performed. The user subsequently authorized deployment and recent missing-image-thumbnail repair, recorded below.
- **Portrait UI:** Character and Group sidebar icons are distinct; the selection fill is confined to the folder button, outside the expander/hierarchy line. Portrait Character cards use a 3:4 contain frame. Direct Character entry now returns to the previous committed browsing context/scroll instead of the synthetic Series overview, while in-browser drill-down retains parent navigation. Entry-state timing and filter-only Back regressions are covered.
- **Viewer:** compact information dialog shows available creator name/handle, source, source publication date, collection date, dimensions, duration, format and size. Publication date is not inferred from storage dates. Explicit text-copy actions use a bounded Android clipboard bridge that acknowledges the actual write; no clipboard read or file copy is added. Back/Escape closes information before the Viewer; failures have separate feedback.
- **Dimensions:** confirmed that general Asset replication omitted local width/height/duration and that server projections returned null. Added optional strict integer fields, nullable additive columns, legacy-omission preservation and mobile projection reads. Existing rows remain unknown until a separately authorized metadata update. No production migration, deployment or publication was performed.
- **Catalog category selector:** reuses the PC's category IDs/labels. The selector is independent of the user's search expression and composes a parenthesized expression through the existing `text` API; no unknown query parameter or new write authority. Typed advanced expressions are not rewritten.
- **Refresh cadence, source evidence:** PC upstream collection defaults to 3,600 seconds while the PC app is open; the actual configured library interval was not read. Server refresh is request-driven, not periodic, and accepted work can finish with PC/mobile closed. Foreground mobile checks publication changes every five seconds; this is not upstream collection. Refresh-job status uses two seconds while active and thirty seconds while idle. No schedule was changed.
- **Hidden tags and duplicates remain open:** the server applies published visibility policy, but Android has no policy-write allowlist/replica contract. Shared editing must account for PC publication overwrites; no ad-hoc whole-policy write was opened. New Catalog duplicate candidate generation currently runs in PC-local Rust over the Catalog database. Published grouping remains readable with PC off, but there is no mobile review/candidate API. This is distinct from general Asset similarity scanning.

Verification: full mobile suite passed 251 tests with two workers; after the final filter-only Back correction and information-dialog accessibility adjustment, 91 affected tests passed. Mobile TypeScript/Vite build passed. Browser fixtures covered 800x1280 and 390x844 portrait plus a 1280x800 landscape preservation check: 18 states, zero page horizontal overflow/runtime exceptions; these are not device acceptance. Android native policy/cache/replica checks, including eight clipboard-policy checks, and APK v2/v3 signing passed. Rust cloud coverage passed 134 tests (one ignored), including the dimension payload test. The Python API suite could not import because this host lacks `botocore` (and the server runtime dependencies); syntax checks passed, not API acceptance. Some Viewer tests retain React `act(...)` warnings.

Device delivery: built `android/build/lakomics-mobile-0.6.3-release.apk` with the existing signing identity (version unchanged), SHA-256 `8f80189d0d830d696a70890c29f75556f9d6fd477fef7e667b7027676c8f51a6`. Installed in place on the Galaxy Tab S11 (`SM-X730`) without uninstalling or clearing data; activity cold-start returned `Status: ok`. Installation/startup is not touch, clipboard, or live-thumbnail acceptance.

### Server image-thumbnail deployment and repair

The user authorized applying server image generation and initially repairing the latest 16 images, then expanded repair to all recent images missing thumbnails. Deployed only the thumbnail startup/shutdown hooks, `r2.py`'s bounded background client, `image_thumbnails.py`, `image_thumbnail_encode.py`, and the pinned Pillow 12.3.0 requirement. Existing local dimension/schema changes were excluded from the deployed artifact and remain undeployed. The previous runtime sources matched repository HEAD before patching; rollback code and a consistent read-only SQLite backup were retained privately on the server before restart.

New promoted image Assets enqueue durably in their creation transaction. A single lock-protected worker generates static JPEG/PNG/WebP thumbnails without a PC, with bounded downloads, child CPU/memory/time/pixel limits, safe retries, and visibility/digest-checked publication. No original is replaced, no lifecycle revision is changed, and no historical scan runs at startup. GIF/video and animated image formats are outside this worker's scope.

Verification: 313 targeted tests passed in an isolated release directory using the server Python environment, synthetic databases and fake storage (`test_image_thumbnails`, `test_image_thumbnail_api`, `test_capture_api`, `test_asset_authority`, `test_mobile_library_api`, and the deployed-baseline replication tests plus startup cleanup). These checks exercise real child encoding, promotion-to-mobile API delivery, queue/retry/visibility limits and lifecycle shutdown. A pre-existing httpx/Starlette deprecation warning remains. Review caught and corrected unsafe threaded `preexec_fn`, pre-decode pixel checking, alpha handling and worker restart semantics; controller verification also corrected thread-unsafe/timing-dependent test code and missing fixture shutdown.

During preparation two new images arrived, so the repair selection was rechecked and frozen at execution rather than silently changing an already-written batch. The latest 16 missing images completed; the expanded request added the one remaining recent missing image. All 17 jobs finished on their first attempt. Live verification returned 34 successful original/thumbnail tickets and downloaded/decoded all 17 WebP thumbnails (584,732 bytes total). The reported `hbd_bday` Asset now serves a 410x512, 44,688-byte WebP thumbnail. Original object keys, digests, sizes, media types and canonical authority-row fingerprints remained unchanged for all 17. At the final audit there were zero visible committed image Assets with `thumbnail_key=NULL`. This is not an audit of every pre-existing thumbnail object's storage health.

The API restarted successfully, health returned HTTP 200 and the worker lock was held; final service memory accounting was approximately 98 MiB (not a peak-load measurement). No full Cloud backfill, catalog/dimension deployment, mobile cache reset or APK rebuild was performed. The user subsequently confirmed that the repaired thumbnails are visible on Galaxy Tab. This accepts post-repair device rendering; future live capture with the PC off remains separate from verified server delivery and synthetic automatic-enqueue tests.

Remaining acceptance: verify a new live capture with the PC off; verify real tablet copy, nested Back, icons, framing and category filtering. Server dimension API execution and rollout, and any existing-row metadata update, are separate gates. Browser fixtures and successful packaging do not prove live synchronization.

# Mobile media / development tooling (2026-09-23)

## MOBILE-PERF-002 — First-view thumbnail latency

Status: `HOLD` — the client-side warm-up covers everyday browsing. Reconfirmed 2026-09-24: stay on hold; revisit with measurements during `PERF-ALL-001` if new-image thumbnails feel slow.

On the tablet an uncached thumbnail takes about 1.5–2.4 s: the Tokyo API answers a ticket in about 0.07–0.1 s and the nearest Cloudflare edge (ICN) is 3 ms away, so the time is R2 storage response latency. 0.7.4 parallelised and prefetched; 0.7.6 warms the whole Library into the native cache (about 200 thumbnails/min). Remaining slow cases are newly captured images and a cleared cache. Options if they matter: serve thumbnails from the Tokyo server's disk (13 GB free on 2026-09-23; ~360 MB for the current library) in batched requests, or move derived thumbnails to an APAC-hinted bucket. Both need server work, a copy of production thumbnails and deployment approval.

## DEPS-001 — Vitest 5

Status: `HOLD` — until `@testing-library/jest-dom` ships Vitest 5 matcher types.

Vitest 5 changes assertion types to `Assertion<R, T>`; jest-dom 7.0.1 still augments the old shape, so its matchers lose their types and the desktop `tsc` build (which type-checks tests) would fail. Runtime behaviour is unaffected. Our tests use none of the removed APIs; set `clearMocks: false` if call history across tests turns out to matter. Other dependencies were updated in range on 2026-09-23.

# Character classification

The character UI/management workflow and current accuracy-improvement pass are accepted and archived. [CHAR-AUTO-001](lakomics-completed.md#char-auto-001--current-accuracy-improvement-pass) retains the implementation evidence, delivery limits and policy for case-driven follow-up. Batch-classification visibility remains a separate verification item below.

## CHAR-AUTO-007 — Evidence-based accuracy plan (2026-09-23 re-analysis)

Status: `IN_PROGRESS` — stage 3 implemented 2026-09-24 as a machine-local per-series switch (see Current priority); next is enabling series on the user's PC and spot-checking S36 acceptances. Earlier: stages 1–2d done (2026-09-23): full-library S36 features extracted, a shadow policy pinned in `_tools/app/character-runtime/s36_policy.json` (automatic knn3 ≤ 0.1304 after ≥100 prior rejections, recommendations ≤ 0.1490), and in-app shadow scoring recording verdicts. The S36 review screen (stage 4 brought forward; series view → `S36 확인`) lets the user judge `automatic`/`recommended` shadow candidates through the normal manual decision path and shows running automatic precision and recommendation acceptance. Stage 3 used these judgments (232/241 correct at knn3 ≤ 0.1085).

Two read-only analyses of the active library (an Opus pass and an independent Fable review; scripts in the session scratchpad, not tracked) found:
- The CCIP metric model is exactly `0.5 × (1 − cosine)` of L2-normalized features, so comparisons need no ONNX batching.
- Random grouped cross-validation overstated gains (contrast score AUC 0.90) through target-prior leakage and same-day batch correlation. Chronological replay gives B36 AUC ≈ 0.61 and S36 ≈ 0.73–0.74 (recall at 2% FP ≈ 0.13 vs ≈ 0.33–0.38). Expect roughly one-third recall at a strict error budget, not 60%.
- S36 features beat B36 in every measured condition; B36+S36 fusion added nothing.
- Most rejections are unregistered people (open set), so "nearest registered character" arbitration is unsafe; competitors should be same-series only.
- Automatic acceptances after 2026-09-13 were never manually confirmed (14 later rejections, 0 confirmations), so their precision is unknown, not high.
- The 2026-09-11 안조 false-positive burst came from multi-person anchors voting with every crop before region handling existed. Current code already withholds unresolved multi-person anchors; 안조 now has 3 usable anchors and cannot auto-confirm.

Stages:
1. **Chronological feature-replay evaluator** (in progress): each prediction uses only earlier manual decisions, excludes same-post/PDQ neighbours, reports walk-forward thresholds and a target-prior leakage canary. All later changes are judged with it.
2. **S36 switch in shadow mode**: needs a full-library S36 feature extraction into the library cache (about 3.5–4.6 CPU hours, separate approval) and recalibrated thresholds.
3. **Scoring**: positive gallery = references + manual acceptances only; subtract the nearer of own manual rejections and same-series competitors. Keep automatic confirmation strict; growth goes to recommendations.
4. **Fast review loop** for recommendations so new manual decisions feed stage 3.

User follow-up for 안조: select regions for anchors `e60e44a1` (crop #1 or #2) and `90394071` (crop #4), and add the four manual acceptances as supporting references.

## CHAR-AUTO-008 — Multi-form characters and reference quality hints

Status: `TODO` — measure with the CHAR-AUTO-007 evaluator first.

Some characters have distinct forms (아리아: robot form and human form). With per-reference voting a minority form rarely reaches the six-vote automatic rule, although it does not hurt the majority form.
- Short term: add at least six references for each form that should auto-confirm.
- Direction: cluster a character's references into forms/outfits (auto-suggested, user-confirmable) and count votes within a form, so automatic confirmation means "six references of the same form".
- Reference hints in character settings should flag only isolated references that belong to no form cluster, not a whole second form. Observed isolated cases on 2026-09-23: 수나 `aeffff69` (abstract chibi), `5c2ca1c1` (backlit silhouette); 모니에 `720276e7` (legs only), `f29f450c` (blue silhouette). Also verify 수나 `ec4e8499`, whose automatically inferred region may be a different person. Thresholds for hints must come from the evaluator, not the ad-hoc 0.19 median used in the audit.

## CHAR-AUTO-009 — Person crop quality and main-character focus

Status: `HOLD` — measured 2026-09-23: in the chronological S36 + knn3 crop-policy comparison the current crop policy (P0) was best (recall 34.6% at ~3% FP) and every alternative (fragment/mascot filtering, head extension, box merging, main-character-only) was slightly worse. The user chose to keep the current crops and not adopt main-character-only. Reopen only with concrete new failure cases; the text below is the original proposal.

User reports (2026-09-23): crops sometimes cut a face in half or pick up mascots, and multi-person images attach minor background characters. A random sample of 72 library crops showed roughly: ~10 non-human/mascot crops (mascot cats, chibi mushrooms, plush toys, objects), ~10 fragments (half faces, hat/hand/legs only), ~5 boxes containing several people, and frequent duplicate boxes for the same person (full body plus upper body, overlapping manga panels).

User decisions:
- **Main characters only:** in multi-person images, classify only the prominent people — those comparable in size to the largest person. Equal-size group art keeps everyone.
- **Minor characters are ignored**: no automatic membership and no recommendation.

Direction, in order of expected safety:
1. Drop fragments, very small crops and non-human detections from classification.
2. Keep the whole head inside a person crop (locate the head and extend the box when it is cut).
3. Merge duplicate boxes of the same person.
4. Consider a different person detector only if 1–3 are insufficient.

Before enabling the main-character rule, measure how many existing manual acceptances are small/background people so the prominence threshold does not drop images the user deliberately assigned. Existing memberships are not removed retroactively without a separate decision.

## CHAR-AUTO-003 — Cluster-based character candidate research

Status: `HOLD`

Keep clustering/re-identification research deferred while explicit-reference classification remains usable. Reopen only if real-world accuracy evidence shows it solves a recurring gap better than reference/arbitration tuning.

# Similarity / media identity

## SIMILARITY-003 — Similar-video fingerprinting and review

Status: `PARTIAL` — implementation exists; verification is deferred because representative duplicate/variant videos have not naturally appeared yet.

Do not redesign the architecture without evidence. When suitable samples exist, validate re-encode/resolution positives plus trim/crop/watermark hard cases in the existing Similarity Review surface. Audio remains optional.

Reference: [video similarity execution record](../research/video-similarity-execution-plan-20260908.md).

## PERF-SIMILARITY — Metric index / BK-tree gate

Status: `HOLD`

Linear PDQ candidate scanning remains the default. Reopen only if historical discovery or representative 100k+/250k+ measurements show it is a material bottleneck.

# Works / Collections

## WORKS-001 — Film / TV Works polish

Status: `PARTIAL`

The Film/TV foundation is already implemented: TMDB Film/Series identity, posters/backdrops, season/episode structure, season posters and cached details exist. Do not restart that foundation.

Current remaining scope is deliberately small and Film-focused:
- clearer cast/director presentation;
- useful release-history / release-info presentation;
- related/connected works rail where provider semantics are trustworthy;
- keep provider scores visually secondary to personal state.

TV/anime season and episode structure is sufficient for now unless new concrete friction is reported.

## LONG-001 — AV metadata/cover acquisition and candidate selection

Status: `PARTIAL`

Current manual AV Collection, people/roles, front/spine/back surfaces, and focused viewing remain usable. The remaining inconvenience is acquisition, especially manual number entry and manual cover setup.

Future direction:
1. one or more external sources fetch metadata and cover candidates;
2. Lakomics presents those candidates separately from acquisition;
3. the user explicitly chooses which candidate becomes front / spine / back, or rejects all;
4. provider refresh never silently overwrites manual choices;
5. fetching and applying stay separate so a source can be replaced without redesigning the chooser.

Do not couple this to Private Vault or create a second Collection artwork lifecycle.

# Catalog / optional providers

## CATALOG-002B — Optional Heliotrope coexistence

Status: `TODO` — low priority / optional.

Keep VCK/kHentai as the default provider. If Heliotrope is revisited, isolate its cache and never assume metadata availability implies a valid page resolver. Provider disable/cache clear must preserve bookmarks/progress.

# Desktop UI consistency

## PC-UI-001 — PC UI consistency pass

Status: `IN_PROGRESS`

From a 2026-09-23 review of the design documents against real-app screenshots on the Linux host. Fix small items first; items marked *decision* need a user choice before implementation. Options and recommendations for the open decisions, plus larger visual-direction proposals, are in [PC UI design decisions pending](../research/pc-ui-design-decisions-20260923.md).

1. **Fixed 2026-09-23:** Settings: unchecked checkboxes (e.g. 비공개 모드) are nearly invisible on the dark surface, and labels mix action (`켜기`) with state (`켜짐`).
2. **Fixed 2026-09-23:** Settings: `캐릭터 누락 보완` stayed at `확인 중...` because every Settings open re-hashed the ~150 MB S36 model; successful verification is now cached in-process by path, length and modification time.
3. **Fixed 2026-09-23:** TV detail: season selection uses a white outline box instead of the documented selection language.
4. **Fixed 2026-09-23:** TV detail: season synopsis spans the full content width; limit it to the same reading measure as the work synopsis.
5. **Fixed 2026-09-23:** Character series view: removed the empty band; the overview now separates group, total character (including grouped members), and ordinary-folder counts. Group detail headings stay unchanged.
6. **Fixed 2026-09-23:** Manga catalog: the edition button appears only for 2 or more editions; covers show a static neutral loading icon without motion or layout shift, then the image or the existing failure state.
7. **Fixed 2026-09-23:** Work detail: a back chevron to the left of the title replaces the detail-close X beside window controls, preserving the existing exit and Escape/back handlers.
8. **Fixed 2026-09-23:** Collection index: two simultaneous ivory selections; resolved by the N4 selection treatment (parent level tinted, most specific level keeps the slab).
9. **Fixed 2026-09-23:** Collection cards/info/details, TV seasons/episodes and Asset date headings share the viewer-local current-year rule: `MM.DD`, otherwise `YYYY.MM.DD`; year-only values keep `YYYY`, month-only values keep `YYYY.MM`, and ranges use `–`. Invalid input passes through unchanged. Stored values, grouping/sorting, caption times and Revisit date headings stay unchanged.
10. **Fixed 2026-09-23:** Collection genre displays translate the eight exact TV-only English genre names; the whole Asset library uses `전체` in index and title. The Manga catalog DB update timestamp has a muted database icon and accessible description; its full local date/time remains explicit.
11. **Fixed 2026-09-23:** Gallery captions leave unknown creators empty while retaining the right-aligned time and accessible collected-time description.
12. **Dropped 2026-09-23:** the "cropped TV backdrop" was a scrolled screenshot, not a defect.

Native visual acceptance of items 5–7 and 9–11 remains pending.

Documentation follow-up: move feature/domain rules and verification logs out of `docs/agents/pc-design-reference.md`, record the resulting date/selection/toggle rules there, and point color values at `tokens.css`.

# Desktop verification / low-priority exploration

## STATS-001 — Personal statistics

Status: `PARTIAL`

Inventory and recorded-era activity statistics are implemented. Remaining work is targeted native acceptance/metric-definition cleanup only; do not infer historical activity from file timestamps.

## ARTIST-001 — Replace Revisit tab with an Artist hub

Status: `TODO` — low priority / product direction.

The current Revisit tab is rarely used. Prefer replacing that top-level destination with an `작가` hub rather than adding another navigation item. Preserve useful rediscovery behavior by folding it into the artist experience instead of keeping Revisit as a separate destination.

Initial direction:
- artist landing view: recently collected artists, most-collected artists, and long-unseen artists;
- artist home: representative images, library asset count, first/recent collected dates, frequently associated works/series and characters;
- same-artist continuous browsing / artist radio using existing library data;
- later, evaluate style-nearby artists using existing CLIP/embedding infrastructure without making similarity metadata mandatory;
- avoid new required manual metadata where existing artist/source information can be reused.

This is primarily a browsing/rediscovery surface, not a new organization workflow. Reuse any valuable Revisit logic as `오랜만에 보는 작가`, `오늘의 작가`, or similar modules inside the artist hub.

## IDEA-002 — Asset date timeline exploration

Status: `HOLD`

Keep the timeline idea deferred until there is a concrete browsing need beyond the current date-grouped library and Revisit flows.

# Optional AI / development tooling experiments

