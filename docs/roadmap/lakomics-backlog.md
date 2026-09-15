# Lakomics Backlog

Living source of truth for **active** Lakomics work only. Completed, superseded, applied, and incident-only records live in [lakomics-completed.md](lakomics-completed.md).

Reconciled 2026-09-15 after the production server-authority/bookmark pilot completed end-to-end. This incorporates current source inspection and the user's current product acceptance; it is not a new Windows full-system audit.

## Current priority

1. **CLOUD-POST-001** — simplify PC/Android around the now-proven server-authority model.
2. **CHAR-AUTO-006** — newly ingested images must appear immediately instead of waiting for a whole character-classification batch.
3. **CHAR-AUTO-001** — calibrate the remaining character-classification accuracy annoyance using representative mistakes.
4. **SIMILARITY-004** — discover near-duplicates that already coexist in the library.
5. **WORKS-001** — small Film polish: cast/director, release information, and related works.

Later / optional: AV source-and-candidate selection (`LONG-001`), image mirror/rotation matching (`SIMILARITY-002B`), and optional provider work (`CATALOG-002B`). Similar-video calibration stays deferred until representative samples naturally appear.

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

Status: `TODO` — the gate cleared on 2026-09-15 when the bookmark authority pilot completed production deployment and two-direction device canaries. No post-authority client simplification has started yet.

Goal: once shared domains are genuinely server-authoritative, stop treating the server as a mobile publication target. PC and Android become clients with local replicas/caches; the server owns canonical shared state.

- Remove the product-level `PC -> publish -> mobile` mental model for domains that have moved to server authority. Existing `useMobilePublications`, manual `모바일 ... 업데이트/게시` controls, and one-way publication state should be retired or repurposed only after an equivalent server-owned live domain exists.
- Keep the PC SQLite/library instead of turning every screen into a remote REST query. It becomes a fast materialized replica plus workstation-only state: filesystem integration, drag-out, local paths, GPU/FFmpeg work, bulk ingest and recovery.
- Generalize the proven cursor + revision + durable outbox + idempotent operation pattern beyond catalog bookmarks so each new shared domain does not invent its own synchronization protocol.
- Device-only presentation/preferences remain local; shared user data and domain state converge through the server authority.
- Real-time SSE/WebSocket notification is optional polish after durable replicas work; do not prioritize sub-second push over correct local-first startup/reconciliation.

Acceptance: normal use no longer exposes a manual "publish to mobile" concept for migrated domains; PC and Android can render cached state immediately, work through temporary disconnection where supported, and deterministically converge to the same server state.

## MOBILE-CACHE-001 — Android durable metadata replica

Status: `HOLD` — post-authority optimization.

Current mobile binary caching (`MediaRepository` / `ThumbnailCache`) is useful, but much of the browsing metadata is still held in React `Map` caches or `localStorage`. Add a small durable Android metadata database once the server change contracts are stable.

- Persist browse metadata, revisions/cursors and durable outgoing intents in a local database rather than relying on process-memory caches for normal startup.
- Startup should render the last committed local state first, then fetch/apply server changes in the background.
- Keep binary media in the existing bounded media cache; metadata replica and media cache are separate concerns.
- Revisit `PickerLibrary`'s independent JSON snapshot after this exists. Prefer deriving Picker/album views from the durable replica rather than maintaining another full-library metadata copy.
- Preserve explicit cache invalidation when the configured server/library identity changes.

Acceptance: after one successful sync, relaunching the Android app can show the previous library view without waiting for a full remote page load; later server changes update it incrementally without losing pending local intent.

## CLOUD-INGEST-002 — Cloud Capture를 server-native ingest로 전환

Status: `HOLD` — only after asset authority/fencing is proven.

Today Cloud Capture still reflects the older path where the server holds a pending capture, the PC imports it into the local canonical library, and cloud replication later republishes the resulting asset. Under full server authority, remove that PC-off gap.

- Extension capture should be able to finalize a canonical server asset and R2 media while the PC is off.
- The committed asset becomes visible to Android immediately and reaches PC later through the normal change/reconciliation path.
- Preserve stable capture/asset identity, idempotent retries, content validation and any review/quarantine rules needed before canonical visibility.
- Character classification, similarity, video analysis and other heavy enrichment must not gate base asset visibility; they are follow-up jobs.
- Do not delete the old PC import path until server-native ingest has recovery and rollback evidence.

Acceptance: save from the extension while every PC is off; the asset becomes a canonical, viewable mobile item exactly once, and a PC started later adopts the same asset without re-ingesting or duplicating it.

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

## MEDIA-R2-001 — Aggressive R2 derived-media cache

Status: `TODO` — post-authority performance/capacity tradeoff; storage is intentionally spent to reduce transfer/decode latency.

The current replicated asset shape is essentially `library/{asset_id}/original` plus `thumbnail`. R2 capacity is available, so add immutable derived variants instead of repeatedly fetching/decoding oversized originals.

Suggested image variants (measure before fixing exact encodes):
- small thumbnail around 256 px for picker/very dense lists;
- normal thumbnail around 512 px for mobile masonry;
- preview around 1280 px for detail/quick viewing;
- preview around 2048 px for tablet full-screen viewing;
- original only for deep zoom, export or explicit original access;
- optional analysis-sized derivative for repeated CLIP/classifier input when it is demonstrably useful.

Suggested video/GIF variants:
- poster image for grids;
- bounded low-resolution preview (for example 480p) for lightweight motion preview;
- optional 720p viewing derivative where original files are disproportionately heavy;
- retain the original as the canonical media object.
Implementation constraints:
- Derivatives are caches/materializations, never independent authority. Regenerate them from the canonical object and metadata.
- Prefer immutable/versioned or content-hash-derived object keys so a new encode does not require risky in-place cache invalidation.
- Mobile chooses the smallest variant that fits the surface; do not fetch original-size media for a masonry tile or ordinary tablet preview.
- Preserve authenticated/private access. Do not make the personal R2 bucket public merely to gain CDN caching; edge-cache work is a separate optional layer.
- Track derivative version/digest and clean orphaned variants after source replacement or format-version retirement with a bounded lifecycle policy.
- Generate derivatives asynchronously after canonical asset commit; failure of a preview job must not hide the valid original asset.

Acceptance: common mobile browsing and full-screen viewing normally use a fitting derivative instead of the original, image/video cache misses remain recoverable, and deleting/replacing an asset cannot leave an unbounded set of orphaned R2 variants.

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

## MOBILE-008 — Catalog update requests and status

Status: `IN_PROGRESS` — server refresh worker and Android request/status UI already exist.

Remaining is bounded live-source/native acceptance and fuller PC/server grouping reconciliation. This is a server operation lane, not an expansion of normal mobile editing. Keep it behind the authority/reconciliation rules proven by the archived `CLOUD-AUTH-001` contract where domains overlap.

## CLOUD-UI-001 — Durable Cloud status, diagnostics, and problem surface

Status: `VERIFY`

Implementation exists. Keep only targeted real-world acceptance for durable error/status recovery; do not reopen completed replication/backfill work.

## MOBILE-003 — Safe global deletion / tombstone protocol

Status: `HOLD`
Risk: HIGH.

Global cross-device deletion remains intentionally deferred. Require tombstones, grace period, acknowledgement/reconciliation, explicit purge, conflict handling, and recovery before activation.

# Character classification

The character UI/management workflow is accepted for the current product scope and archived. Two current concerns remain: **accuracy** and **visibility while a batch is still classifying**.

## CHAR-AUTO-001 — Character classification accuracy calibration

Status: `PARTIAL`

Incremental classification, quiet workflow, explicit references, support=6 automatic confirmation, and user-driven historical refresh are already implemented and in daily use.

Current remaining scope:

- collect representative false-positive / false-negative examples from normal use;
- measure per-character and same-series confusion rather than changing global thresholds from anecdotes;
- evaluate reference quality/count and arbitration behavior against a holdout set;
- preserve conservative automatic confirmation and manual recovery;
- only pursue CPU/GPU/performance work if it is separately shown to affect normal interaction.

2026-09-14 stage 1: a read-only frozen evidence evaluator is implemented in
`_tools/app/character-runtime/character_holdout.py`. It preserves pre-feedback
predictions and explicit labels, screens content/PDQ/reference leakage, and reports
per-character/series metrics. This is historical evidence replay; real-library
accuracy and candidate model/crop evaluation remain separate work. Usage and limits:
[HOLDOUT.md](../../_tools/app/character-runtime/HOLDOUT.md).

Do not restart the old routine review inbox/global-progress UX. Do not initiate a full production backfill as an accuracy experiment.

## CHAR-AUTO-006 — Show ingested assets before batch character classification finishes

Status: `VERIFY`

User-visible problem (2026-09-13): when many images arrive together, they can remain absent from normal browsing until character classification for the batch finishes.

Desired contract:
- successful ingestion shows each normal asset in its ordinary series/folder gallery immediately;
- character analysis runs in the background and must not gate base-gallery publication;
- character-folder membership appears progressively as results commit;
- a slow or failed character job never hides an otherwise-valid ingested asset.

Implemented 2026-09-14: ordinary/series galleries coalesce same-scope refreshes
instead of discarding every in-flight read. Each completed read can publish while
classification continues; navigation and explicit mutations still invalidate old work.
Cloud capture ingestion now sends a native channel update after each local commit,
before acknowledgement and later downloads. Closed/stale UI listeners do not fail
an import or populate another library.

Regression coverage includes slow overlapping gallery reads, an app-level multi-file
import, a held/failed native character claim, and a fake-server assertion that local
publication precedes a failed ACK. Remaining acceptance is the real desktop browsing
experience on the user's library and native Windows verification.

## CHAR-AUTO-003 — Cluster-based character candidate research

Status: `HOLD`

Keep clustering/re-identification research deferred while explicit-reference classification remains usable. Reopen only if real-world accuracy evidence shows it solves a recurring gap better than reference/arbitration tuning.

# Similarity / media identity

## SIMILARITY-004 — Existing-library similarity discovery

Status: `TODO`

Current gap confirmed 2026-09-13: `index_missing_similarity_hashes()` backfills PDQ for existing normal image/GIF assets, making them candidates for future ingestion, but it does not compare already-stored assets against one another or create historical `similarity_reviews`.

Goal:
- add an explicit bounded `기존 보관함 유사 이미지 찾기` operation;
- reuse current PDQ quality/aspect/distance policy and the existing Similarity Review UI;
- discover historical pairs without forcing fingerprint reindex;
- skip already reviewed/decided pairs and remain idempotent across retry/restart;
- run in resumable batches without blocking normal browsing or ingestion;
- keep originals unchanged until the user makes an existing explicit similarity decision.

Acceptance: two pre-existing near-duplicates produce exactly one review; rerun/restart does not duplicate it; unrelated or incompatible candidates stay excluded. Measure the current ~8k–10k scale before considering a metric index.

## SIMILARITY-002B — PDQ geometric-invariance candidates

Status: `TODO`

After historical discovery is useful, evaluate mirror/flip and 90/180/270-degree transformed reposts. Prefer query-time transform candidates over unconditional full reindex, preserve the existing PDQ final gate, and benchmark false positives on real artwork before enabling by default.

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

# Desktop verification / low-priority exploration

## STATS-001 — Personal statistics

Status: `PARTIAL`

Inventory and recorded-era activity statistics are implemented. Remaining work is targeted native acceptance/metric-definition cleanup only; do not infer historical activity from file timestamps.

## PERF-NAV-001 — Folder/tab/image presentation latency

Status: `VERIFY`

Major navigation/query optimizations are implemented and the user has observed a clear improvement. Keep only targeted native timing investigation if a new concrete slowdown is reported; do not restart the completed synthetic optimization pass.

Reference: [desktop navigation measurements](../performance/desktop-navigation-20260912.md).

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

# Extension follow-up

## EXT-011 — 반원 수집 메뉴와 PC 브라우저 연결

Status: `VERIFY`

Implementation exists. Keep only real-browser/Titanium/PC integration acceptance for the current menu direction; do not revive older radial/list-only designs.

## EXT-012 — X 번역 단순화·공유 게시물 저장·PC 임시저장

Status: `VERIFY`

Implementation exists. Remaining scope is targeted real X/Titanium/Galaxy acceptance and concrete regressions only.

# Current execution order

This is guidance, not authorization to start or mutate production data.

1. `CLOUD-POST-001` post-authority PC/Android simplification.
2. `CHAR-AUTO-006` immediate batch-ingest visibility.
3. `CHAR-AUTO-001` measured accuracy calibration.
4. `SIMILARITY-004` existing-library discovery.
5. `WORKS-001` small Film polish.
6. `LONG-001` AV external-source / candidate chooser when AV entry friction is worth tackling.
7. `SIMILARITY-002B` transform matching when useful.

Verification-only items may be closed opportunistically when the user naturally exercises them. HOLD items should not be promoted without a new product reason.
