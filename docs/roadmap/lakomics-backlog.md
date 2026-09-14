# Lakomics Backlog

Living source of truth for **active** Lakomics work only. Completed, superseded, applied, and incident-only records live in [lakomics-completed.md](lakomics-completed.md).

Reconciled 2026-09-13 against `main` / `origin/main` at `8b9a209`. This incorporates current source inspection and the user's current product acceptance; it is not a new Windows/Android full-system audit.

## Current priority

1. **CLOUD-AUTH-001** — establish the minimum server-authority primitives needed before any mobile write.
2. **MOBILE-007** — make catalog bookmarks the first and currently only planned everyday mobile write domain.
3. **CHAR-AUTO-006** — newly ingested images must appear immediately instead of waiting for a whole character-classification batch.
4. **CHAR-AUTO-001** — calibrate the remaining character-classification accuracy annoyance using representative mistakes.
5. **SIMILARITY-004** — discover near-duplicates that already coexist in the library.
6. **WORKS-001** — small Film polish: cast/director, release information, and related works.

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

## CLOUD-AUTH-001 — 서버 원본과 최신 PC 모델을 공유하는 모바일

Status: `IN_PROGRESS`

The read-publication foundation already exists for Collections/characters and current mobile browsing. The next target is **not** a one-shot migration of every domain; it is the minimum authority contract required for safe server-owned changes.

Current implementation target:

- domain/library authority epoch or equivalent revision fence;
- idempotent operation IDs and receipts;
- durable server change cursor/log for PC catch-up;
- stale-PC snapshot fences so an old PC cannot erase server-accepted changes;
- offline/retry/conflict/recovery semantics;
- server acceptance while the PC is off, followed by deterministic PC reconciliation.

First success criterion: a mobile bookmark change is finalized by the server while PC is off, and a later PC session receives the same change without inversion or loss.

References: [ADR-0036](../adr/0036-staged-server-authority.md), [server-authority audit](../research/server-authority-model-audit-20260913.md), [mobile character contract](../agents/mobile-character-contract.md).

## MOBILE-007 — Catalog bookmark changes across devices

Status: `TODO`
Dependency: `CLOUD-AUTH-001` authority primitives.

This is the currently planned everyday mobile write scope. Use stable `(provider, providerWorkId)` identity, idempotent add/remove operations, durable offline retry, explicit conflict semantics, and PC change reception. Do not implement blind toggles that can invert twice after response loss.

Acceptance: PC-off add/remove, duplicate request, response loss/retry, reconnect, concurrent PC/mobile edit, and stale-PC snapshot cases all converge to one server-authoritative bookmark state.

## MOBILE-008 — Catalog update requests and status

Status: `IN_PROGRESS` — server refresh worker and Android request/status UI already exist.

Remaining is bounded live-source/native acceptance and fuller PC/server grouping reconciliation. This is a server operation lane, not an expansion of normal mobile editing. Keep it behind the authority/reconciliation rules from `CLOUD-AUTH-001` where domains overlap.

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

1. `CLOUD-AUTH-001` minimum authority foundation.
2. `MOBILE-007` bookmark write pilot.
3. `CHAR-AUTO-006` immediate batch-ingest visibility.
4. `CHAR-AUTO-001` measured accuracy calibration.
5. `SIMILARITY-004` existing-library discovery.
6. `WORKS-001` small Film polish.
7. `LONG-001` AV external-source / candidate chooser when AV entry friction is worth tackling.
8. `SIMILARITY-002B` transform matching when useful.

Verification-only items may be closed opportunistically when the user naturally exercises them. HOLD items should not be promoted without a new product reason.
