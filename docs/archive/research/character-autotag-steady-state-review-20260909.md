# Lakomics Character Auto-Tagging — Steady-State Implementation Contract Review

Date: 2026-09-09
Review target: local working tree at `/home/laku/chatgpt`
Base HEAD: `c3afe65ad54d680f6493714431744a1e8d332a0d`
Branch: `main`

## Status and authority

This report reviews the **current local working tree**, including uncommitted character-related changes. Do not reset, overwrite, or silently replace that state with the GitHub snapshot.

This revision incorporates a second implementation-contract review of the first architecture proposal. It is intended to be specific enough for Codex to plan implementation, while still requiring re-inspection of touched code before editing.

It does not authorize a production-library backfill, deployment, Git commit/push, dependency installation, or unrelated cleanup.

Priority labels in this document express **architecture dependency and expected steady-state value**. They are not claims that profiling has measured each item as a production freeze or assigned a percentage of current latency.

No runtime performance measurement was performed for this report.

## Product goal

The target is the steady state **after historical character analysis coverage is substantially complete**.
A normal steady-state event is:

- A new normal image is saved through the browser extension or another normal ingestion path.
- The image may be filed directly into a registered series, into a descendant of that series, or into an approved broad parent such as Games, Manga, or Other.
- Lakomics should process that asset generation only, identify the best matching registered character or characters in the applicable scope, and create durable relations quickly and safely.
- Multi-character images must support multiple relations when distinct detected people match different characters.
- Existing covered images should not be re-enumerated merely to discover that they were already processed.
- Ambiguous, unmatched, stale, and failed evidence must remain reviewable after restart when the product contract says review is still pending.

The normal hot-path cost should scale mainly with the number of applicable candidate characters and detected crops. Historical image count inside the same scope should have negligible effect once those historical assets are already covered.

## Executive assessment

The recognition engine, content-addressed feature cache, learned-reference eligibility, crop evidence, and conservative automatic-decision rules remain useful foundations.

The central mismatch is orchestration: current automation discovers new work through target-wide scans driven by renderer refresh state. The desired system is a native, durable, asset-centric incremental classifier, with explicit backfill/manual scan retained as separate work.

The first architecture proposal was directionally sound but incomplete as an implementation contract. The following contracts are mandatory before implementation: recognition-context identity, source-byte validity, durable prediction/review evidence, self-requeue prevention, character-change policy, and a same-scope performance gate.
## Current steady-state path observed

1. Extension `/v1/ingestions` calls `ingest_media` with a classification (`extension_api.rs`).
2. Native ingestion commits the asset and classification, then the extension server emits `extension://ingestion` to the renderer.
3. `App.tsx` turns added assets and duplicate classification changes into a broad `assetRefresh` increment.
4. `useCharacterAutomation` converts `refreshVersion` into a Boolean `requested` flag rather than retaining the changed asset identity.
5. It loads every ready target in every auto-classify series and starts target scans sequentially.
6. Each target scan enumerates its full eligible image scope, creates result rows, starts a Python worker, checks comparison cache keys, and processes misses.
7. While a scan is running, the renderer polls and may call `applyAutomatic` repeatedly whenever `completed > 0`, even when completion has not advanced.
8. `applyAutomatic` reconstructs candidate state from retained scan maps, validates context and files, and writes decisions/relations.

This path can classify a new image eventually, but steady-state discovery work remains coupled to existing target scope size.

## Existing behavior to preserve

- Frozen model/baseline verification and bounded inference behavior.
- Content-addressed feature cache with extraction identity separate from comparison identity.
- Five manual anchors plus eligible explicit human-approved learned references.
- Current learned examples remain retrieval evidence; automatic decisions do not become learned examples.
- Per-crop evidence and query boxes for multi-person reasoning.
- Automatic approval remains stricter than recommendation.
- Human rejected/cleared decisions remain authoritative blockers according to current decision semantics.
- Explicit manual review, manual scan, and broader historical backfill remain available.
## Architecture findings

### A1 — The automation trigger loses asset identity

`useCharacterAutomation` owns a Boolean dirty signal. `assetRefresh` is also shared by unrelated UI/library changes. The system therefore cannot distinguish one new image from a generic asset refresh.

The steady-state unit of work must be a concrete **asset generation** created by the native mutation that made that generation authoritative.

### A2 — Normal automation is target-oriented

`character_scan_inputs_mode` enumerates the target's full candidate scope. Warm caches avoid repeated inference, but inventory, metadata, cache-key, worker-start and result-map work remain proportional to existing covered assets.

The normal path should instead start from one changed asset and resolve only the candidate characters that apply to that asset.

### A3 — Automatic finalization is recomputed during polling

The renderer may invoke `applyAutomatic` repeatedly once a scan has any completed rows. The local implementation clones retained scan result maps and repeats candidate/freshness work.

Incremental finalization should be native-owned and occur once for a completed asset generation.

### A4 — Expensive validation currently overlaps the global DB mutex

`Library::connection()` holds `database_lock` for the `LockedConnection` lifetime. Current automatic evidence validation can hash managed originals while a transaction and that lock are alive.

The replacement contract must keep expensive file hashing and inference outside the global DB lock, then perform a short stale-safe write transaction.
### A5 — Worker lifetime is target-scoped

`run_character_scan` starts a new Python worker per target. Worker startup verifies model files and constructs detector, feature and metric ONNX sessions.

The incremental path should share one native-owned worker process across candidate targets and queued assets. Manual/background jobs must share that owner through an explicit scheduler rather than spawning competing workers.

### A6 — Query verification/loading repeats across targets

The worker protocol prepares one target reference set and queries against it. Repeating the current pattern across N targets invokes query cache/source verification N times even when detector inference is warm-cached.

The incremental path should hold one verified/extracted query feature object for the asset generation and compare it against multiple target reference bundles.

### A7 — Current review is not durable enough for the proposed queue

`character_review_page` derives predictions and broad-root candidates from in-memory `character_scan.status`, `character_scan.results`, and `character_scan.previous`.

A durable work queue alone would therefore be insufficient. If incremental work completes and the app restarts, unresolved predictions could disappear from review even though the queue row says completed.

The redesign must persist the latest incremental prediction/evidence state required by review and update the review API to read that durable state.

### A8 — Some current lookup/index costs deserve re-checking after redesign

The local decision path includes lookups by `source_asset_id` without a leading `source_asset_id` index in the character schema. Re-evaluate these queries with `EXPLAIN QUERY PLAN` after the new hot path is defined; add focused indexes only where that path still uses them.
## Mandatory contract 1 — Recognition context identity

Do not use the existing `Target.fingerprint` alone as the final automatic-decision context identity.

Current `read_character_target` builds `Target.fingerprint` from target ID, revision, series ID and the five anchor references. It does **not** include `learned_references`. In addition, an asset's automatic result depends on the complete competing candidate set, not only the candidate that eventually wins.

Define an explicit recognition-context snapshot/signature for each asset generation. It must cover at least:

- asset ID, expected content hash and queue generation;
- current direct classification and the classification lineage/topology relevant to scope resolution;
- applicable registered series IDs and their `auto_classify` state;
- the complete current ready candidate-target roster for that asset;
- each candidate target's stable target fingerprint/anchor identity;
- the ordered or canonically sorted eligible learned-reference identities actually used for that candidate;
- runtime/comparison fingerprint required to interpret evidence.

The implementation may introduce a separate `recognition_context_hash` or equivalent rather than changing the public/UI `Target.fingerprint` contract.

Before an automatic decision commits, recompute or otherwise validate the current applicable-series/candidate roster and candidate recognition identities inside the final transaction. A newly ready competitor, changed learned-reference set, target enable/disable state, series auto-classify toggle, target series move, or relevant hierarchy change must invalidate the old automatic context.
## Mandatory contract 2 — Verified source bytes and file lifetime

“Verify/extract once per asset generation” is a performance objective, not permission to weaken source integrity.

An external process may replace managed file bytes without changing the SQLite queue generation. The implementation must define a cross-platform **verified-source lease** that proves the inference evidence corresponds to the bytes that are still eligible at commit time.

Required properties:

- Snapshot DB asset identity/hash/path while holding the DB lock briefly, then release it before expensive reads.
- Perform full hashing and inference outside the global DB mutex.
- Do not repeat full query hashing once per candidate character.
- Ensure the bytes presented to Python cannot silently change between verification and inference, or detect such a change reliably.
- Before commit, verify that the DB generation/hash/path/context are still current.
- Also detect unmanaged on-disk replacement that left DB metadata unchanged before accepting automatic evidence.

Valid implementations may use a retained file handle with platform-appropriate write/replace exclusion, an immutable verified temporary snapshot consumed by the worker, or another tested mechanism with equivalent guarantees.

If a final full-file rehash is required because the chosen platform contract cannot prevent external replacement, perform it **once per asset generation**, outside the DB lock, and re-check its resulting identity in the short commit phase. Candidate count must not multiply source hashing bytes.

Apply byte-validity guarantees to candidate anchors and used learned references too, including negative competitors. A cached bundle key derived from DB identities cannot by itself prove that reference files still contain those bytes. Immutable temporary snapshots protect inference inputs; they do not by themselves establish freshness of the managed originals at commit. Define that final freshness boundary explicitly, including replacement after a final rehash and before commit, and do not claim external-write exclusion from an advisory lock.

Tests must include external query/reference replacement during inference and at the final validation boundary on both supported desktop platforms where practical.
## Mandatory contract 3 — Durable predictions and review evidence

A durable queue item is not sufficient evidence for post-restart review.

Persist the incremental classification result needed by review independently of the active worker/process. At minimum, durable incremental prediction state must retain:

- asset generation/content hash;
- recognition-context signature;
- candidate target ID and target recognition identity;
- runtime/comparison fingerprint;
- result state such as recommended, unmatched, ambiguous, error or stale;
- query boxes and the evidence required by current manual/automatic review decisions;
- reference/learned-reference identities actually used;
- failure diagnostics where review/retry requires them.

Persist an asset-level review disposition independently of per-target comparison states: awaiting candidates, unresolved, partially resolved, resolved, failed, or superseded. Losing candidates marked `unmatched` do not make a fully resolved asset pending review. For partially resolved multi-person images, retain unresolved query regions alongside accepted relations; reconsideration selects these asset/region dispositions, never all per-target `unmatched` rows.

An asset with zero ready candidates still receives a durable checkpoint with its effective scope and `awaiting_candidates` disposition. When the first applicable candidate becomes ready, scope-based reconsideration must find that checkpoint without requiring a target prediction row. An asset outside enabled recognition scope waits without busy retries; enabling a relevant scope can reconsider recorded checkpoints without sweeping accepted history.

The exact table split is an implementation choice. A reasonable shape is a durable job/checkpoint table plus per-target prediction rows keyed by asset generation and target.

`character_review_page` must be redesigned to read incremental durable predictions for steady-state assets. It may continue to union or separately expose in-memory/manual scan results for explicit historical scans, but unresolved incremental review must survive app restart without depending on `character_scan.previous`.

A queue item may enter `completed` only when the durable terminal state for that generation is committed: automatic decisions and relations if accepted, or durable unresolved/unmatched/error evidence when human review may still be required.

Superseded generations may be pruned later under an explicit retention policy. Do not delete the only reviewable evidence merely because processing finished.
## Mandatory contract 4 — Enqueue causality and self-requeue prevention

Classification mutation can be both an input to auto-tagging and an output of auto-tagging. The scheduler must distinguish these causes.

Required behavior:

- User/ingestion classification changes that alter effective scope create or advance the asset's auto-tag generation.
- A no-op classification write must not create a new generation.
- An automatic root-to-series move produced by finalizing the current auto-tag generation must **not** enqueue that same result as fresh user work.
- Character decisions, optional automatic series move, durable prediction state, and completion of the claimed generation should commit atomically when they belong to the same finalization.
- Cloud replication/outbox behavior caused by the series move must still be preserved.
- If a real user reclassification races finalization, it must advance the generation and cause the old finalization to fail its stale check.

Prefer a lower-level classification mutation helper that accepts an explicit mutation cause or enqueue policy, rather than globally suppressing hooks with renderer state.

Possible causes include `ingestion`, `user_reclassification`, `similarity_resolution`, and `character_autotag_finalization`. Names are implementation details; the semantic distinction is required.

Exact duplicate ingestion with unchanged effective classification creates no work. Exact duplicate ingestion with a real classification change advances the existing asset once.
## Mandatory contract 5 — Character-change and historical-reconsideration policy

Do not translate every target/reference change into a full historical rescan. Separate three concerns:

1. **In-flight validity:** any change that alters the current recognition context invalidates affected in-flight asset generations and causes them to retry against the latest context.
2. **Future assets:** newly arriving assets always use the latest candidate roster, anchors, learned references, enable state, hierarchy and series settings.
3. **Historical reconsideration:** existing covered assets are reconsidered only under an explicit bounded policy.

Recommended default historical policy:

- New character becomes ready, target is re-enabled, or learned references grow: apply immediately to future work and enqueue low-priority reconsideration of **asset-level awaiting-candidates/unresolved/partially-resolved** checkpoints in the affected scope. Do not automatically sweep every historical accepted asset.
- Anchor replacement or other material target recognition change: invalidate in-flight work; future work uses the new context; mark prior unresolved evidence for that target/context stale and allow targeted low-priority re-evaluation.
- Disabling a target stops future candidacy. Preserve existing durable relations/decision history unless existing product semantics explicitly require removal.
- Manual accepted decisions remain durable human decisions and are never silently revoked by scheduler context changes.
- Existing automatic accepted decisions also remain durable by default; a broader retrospective audit/reclassification requires an explicit rescan/audit operation rather than an implicit full sweep.
- Enabling auto-classification for an existing series for the first time may intentionally create a bounded historical backfill for that series.
- Model/extraction profile changes follow an explicit migration/backfill policy based on what evidence is actually invalidated.

This policy keeps correctness for current work without recreating a whole-library rescan under another name.
## Mandatory contract 6 — Shared worker ownership and scheduling

Manual scans, historical backfill, and incremental auto-tagging should share one native worker owner per library/runtime profile unless measurement later justifies a different limit.

Required scheduling semantics:

- Incremental queue work is durable and survives renderer navigation.
- A user-started manual analysis is interactive work and should not be forced to wait behind a long historical backfill.
- Background backfill should yield between asset/query boundaries so newly ingested work or an explicit manual request can run promptly.
- Cancelling a manual scan cancels that job/session; it should not discard unrelated durable auto-tag work.
- Pausing background auto-tag/backfill leaves durable queue state intact.
- Worker crash/restart affects the active inference request, then the scheduler retries according to job policy.
- Keep the Python process alive across target bundles and asset jobs when safe; kill/restart it for runtime-profile invalidation, protocol failure, explicit shutdown, or bounded idle policy.

A practical priority order is: explicit user/manual request, newly ingested incremental assets, then historical backfill/reconsideration. Exact ordering may vary, but starvation and ownership must be tested.

The current worker's one-in-flight bounded protocol is a useful safety property. Preserve serial worker ownership while improving job-level scheduling before considering multiple inference processes.
## Target architecture

### 1. Durable native asset-generation queue

Move correctness ownership from React to the native library layer. The exact schema should follow existing repository conventions, but work must be keyed by asset and latest generation/revision.

Queue/checkpoint semantics:

- `asset_id` and expected `content_hash` identify the managed asset generation.
- Store enough scope/generation metadata to reject stale work after reclassification.
- States cover pending, processing, completed and failed/retryable work.
- Multiple mutations before processing coalesce to the latest generation rather than creating unbounded duplicate jobs.
- Startup requeues interrupted processing work, following existing cloud/video recovery patterns.
- Durable prediction rows are separate from queue lifecycle where useful; completion does not mean evidence can be discarded.

Queue insertion should occur inside the same native transaction that makes the relevant asset/classification state authoritative whenever possible.

Important enqueue boundaries include normal image registration, meaningful set/patch classification changes, exact-duplicate retagging, and similarity-review resolution that promotes a normal classified image.

The renderer event may remain for visual refresh; it must not be the source of eventual-processing correctness.
### 2. Resolve scope from the asset once

For each claimed asset generation, resolve current ordinary classification and applicable registered auto-classify series once.

Required behavior:

- Direct registered series: compare only against ready characters in that series.
- Descendant folder of a registered series: that registered ancestor series is applicable.
- Approved broad root such as Games/Manga/Other: compare against ready characters in registered auto-classify series beneath that root.
- Unrelated roots are excluded.
- Candidate targets are deduplicated before inference.

The resolved candidate roster is part of the recognition context and must be checked again before commit.

### 3. One asset, one verified query, many target comparisons

After a short DB snapshot, establish the verified-source lease and obtain the query feature once. Keep the query resident for the current asset job.

Prepare or retrieve each candidate target bundle from its five anchors plus eligible learned references. Target bundle identity must include the exact reference identities used, not only the current public target fingerprint.

Compare the resident query against each target bundle using the existing frozen metric and learned-reference comparison behavior. Do not re-open/re-hash/reload the query once per target.

After all applicable target predictions exist, arbitrate distinct-person regions and candidate ambiguity for the asset as a whole.
### 4. Persist predictions before/with finalization

Write the generation's per-target predictions and evidence durably. Then finalize according to current policy:

- Safe unique match for one detected person: create the corresponding automatic relation/decision.
- Multiple distinct people with safe unique matches: create multiple relations atomically for that asset generation.
- Same-person competing matches: preserve predictions as ambiguous; do not force an assignment.
- No match: preserve unmatched evidence as required by review policy.
- Error: preserve bounded diagnostics and retry state according to failure class.

For a broad-root asset, an optional automatic move into a series remains valid only when accepted relations resolve to exactly one applicable series under the existing product rule.

The optional move is part of the finalization transaction and uses the self-requeue prevention contract above.

### 5. Short stale-safe final transaction

The final transaction must validate:

- claimed queue generation is still current;
- asset is still normal and its DB content hash/path/classification are current;
- verified-source lease/final byte check still proves current source identity;
- applicable series topology and `auto_classify` state still match;
- complete ready candidate roster still matches;
- each candidate recognition identity, including learned references, still matches;
- human decisions that block automatic action have not changed.

If any check fails, do not partially apply old evidence. Mark/requeue the latest generation or leave a durable stale state according to the mutation that occurred.
## Review and evidence model

The incremental review path should no longer infer broad-root candidates solely from in-memory scan maps.

Recommended behavior:

- Review queries read durable latest incremental predictions/evidence for the requested series/target/filter.
- Broad-root assets remain discoverable through persisted prediction scope/context, even if their ordinary classification has not moved into the series.
- Explicit manual/backfill scans may continue to expose temporary scan state, but the UI/API must make the source of evidence coherent and avoid duplicate rows when durable incremental evidence also exists.
- Manual accept/reject decisions bind to the immutable prediction snapshot being reviewed. Validate the source, target anchors, runtime identity and each learned reference actually used by that snapshot. Addition of new eligible learned references or new competing targets alone must not invalidate human review. Automatic finalization additionally requires the complete current roster and learned-reference set to match. Preserve successive manual approvals from one preview after the first approval creates a learned reference.
- Restart must preserve unresolved/ambiguous/error rows and their ability to be reviewed.
- Source/classification supersession invalidates approval evidence. A context-only reconsideration advances the work generation and claim token while preserving a separate source generation; it does not by itself invalidate a human preview of unchanged source and actually used references. Persist both identities in evidence.

The current `reference_snapshot` decision history can remain the durable human-decision record. The new prediction store serves recomputable machine evidence and review continuity, not a second human-decision authority.

## Backfill and reconsideration work

Keep broader work explicit and separate from the steady-state hot path:

- initial historical coverage;
- first-time auto-classify enable for an existing series;
- explicit user rescan/audit;
- targeted reconsideration of unresolved evidence after candidate/reference changes;
- model/extraction migration that truly invalidates prior evidence.

These jobs should share the worker/cache infrastructure but use lower scheduler priority than newly ingested assets and interactive manual work.

Startup should recover pending durable work. It should not infer that all registered targets require a fresh whole-scope scan merely because the app opened.
## Failure and retry behavior

- Missing/corrupt/unsupported source: durable failed state with bounded diagnostic; do not retry on renderer refresh.
- Transient worker/runtime failure: pending retry with bounded retry count/backoff.
- Worker crash: restart shared worker and retry the claimed job according to policy.
- Context changes during inference: old context cannot commit; latest generation/context is retried.
- Asset trash/delete: stop creating relations and terminally resolve or supersede the queue item. Restoring a trashed normal image advances its generation and enqueues it again even if classification is unchanged. Old claims and predictions cannot finalize the restored generation.
- App crash/restart: processing items return to pending, while already persisted predictions remain reviewable.
- Duplicate unchanged ingestion: no new auto-tag work.
- Duplicate real retag: exactly one new/latest generation for the existing asset.
- Finalization retry must be idempotent and must not duplicate durable character decisions.

## Structural performance contract

Before absolute latency targets are introduced, the design must satisfy these properties:

1. Processing one new steady-state image does not enumerate all already-covered images in the same applicable scope.
2. One new image does not start one Python/ONNX process per candidate character.
3. Query full-byte verification/extraction is bounded per asset generation and does not multiply with candidate count.
4. Automatic finalization runs for completed asset generations, not on every renderer polling interval.
5. Renderer refresh counters are unnecessary for eventual processing.
6. Expensive source hashing and ONNX work do not hold the global library DB mutex.
7. Work scales primarily with candidate character count/crops, rather than historical image count.
8. Batch ingestion coalesces per-asset generations and provides fair scheduling.
9. Unresolved evidence durability does not require retaining all active scan maps in memory.
## Required performance benchmark

The benchmark must grow **already-covered historical images inside the same effective scope while holding the candidate character set constant**. Growing unrelated folders would not test the problem this redesign is meant to remove.

Use representative fixtures or a safe synthetic library with, for example:

- the same registered series/root topology;
- the same ready candidate characters and reference bundles;
- 1,000 already-covered images in the applicable scope, then 8,000 already-covered images in that same scope;
- the same one newly enqueued image processed after warm-up;
- optionally a 25–100 image incremental batch after the single-item case.

Record at least:

- end-to-end queue-to-terminal latency for the new image;
- SQL rows read/scanned on the incremental character path where practical;
- worker process starts/restarts;
- full source hashing bytes and hash invocation count;
- query feature extraction count and feature-cache hits/misses;
- target bundle preparations/cache hits;
- comparison count;
- time holding the global library DB mutex during character auto-tag work;
- final DB transaction duration;
- stale/retry/failure count.

Expected result: increasing same-scope historical covered assets from 1,000 to 8,000 should not materially increase the structural work for one new image. Candidate target count is intentionally held constant.
## Required acceptance scenarios

### Scope and classification

- Direct series: new image in Series A considers only current ready candidates in Series A.
- Nested series folder: image below Series A resolves to Series A.
- Broad root: image in Games considers only registered auto-classify series beneath Games.
- Unrelated roots are excluded.
- Exact duplicate with unchanged classification creates no work.
- Exact duplicate retag advances one generation and processes its new scope.
- Automatic root-to-series move completes the current generation without scheduling itself again.
- A simultaneous user reclassification beats the stale automatic move and produces a latest-generation retry.

### Recognition context races

- Add a new ready competitor while an asset is being compared: old candidate roster cannot commit.
- Add/remove an eligible learned reference during inference: old recognition context cannot commit even if `Target.fingerprint` is unchanged.
- Toggle series `auto_classify` during inference: old context cannot commit.
- Move a target between series or change relevant hierarchy during inference: old scope cannot commit.
- Disable/re-enable target: in-flight work observes the new roster policy; historical decisions follow the explicit reconsideration policy rather than an implicit full sweep.

### Source-byte races

- Replace the managed original externally after DB snapshot but before inference: stale bytes cannot produce a committed decision.
- Replace it after inference but before finalization: final byte/lease validation blocks stale commit.
- Candidate count 1 versus many does not multiply full query hashing bytes.
### Multi-character and review

- Two distinct detected people matching two characters create two relations when each match satisfies automatic criteria.
- Same/overlapping person with competing targets remains ambiguous rather than double-assigned.
- Cross-series distinct people from a broad root may retain multiple relations while ordinary classification stays at the broad root.
- No-match/ambiguous result remains reviewable after app restart.
- Error evidence and retry state survive restart as required by the failure policy.
- Manual accept/reject validates the reviewed source and actually used evidence; two successive approvals still succeed after the first adds a learned reference.
- An A-confirmed image with unmatched B/C predictions is not selected by unresolved historical reconsideration.
- An A-confirmed image with a distinct unresolved companion retains region-level review work.
- An image ingested before any target is ready is reconsidered when the first applicable target becomes ready.
- Trash a queued asset, then restore it without retagging: only the restored generation may finalize.
- Replace a negative competitor's reference bytes without changing SQLite metadata: cached comparisons cannot authorize a stale automatic decision.

### Crash/restart durability

- Kill after asset/classification transaction commits but before worker claim: pending work survives.
- Kill while processing: job returns to pending and existing durable partial prediction state cannot authorize stale finalization.
- Kill after durable unresolved predictions are written: review survives even if no in-memory scan state exists.
- Kill during automatic finalization: transaction atomicity prevents partial relation/move/completion state.

### Shared worker scheduling

- A long historical backfill does not indefinitely block a newly ingested asset.
- A user-started manual scan can obtain interactive priority without destroying pending incremental work.
- Cancelling the manual scan does not clear the auto-tag queue.
- Worker restart after protocol failure does not duplicate decisions.

## Recommended implementation sequence

The implementation order should follow correctness dependencies rather than the old renderer flow.
### Phase A — Freeze the validity and persistence contracts

Before changing scheduling behavior:

- Define recognition-context identity, including learned-reference identity and complete candidate roster.
- Define verified-source lease/file replacement guarantees for Windows and Linux.
- Define durable queue generation and per-target prediction/evidence schema.
- Define review retention/supersession rules.
- Define enqueue causes and finalization self-requeue suppression.
- Define character-change/historical-reconsideration policy.
- Define shared worker job ownership, priorities and cancellation semantics.

Add focused tests for these contracts before removing the existing path.

### Phase B — Add durable queue and prediction storage

- Add a dedicated native module such as `library/character_autotag.rs` instead of continuing to grow `character_scan.rs`.
- Add the next available migration for queue/checkpoint and durable incremental prediction state.
- Add startup recovery for interrupted work.
- Add native query/status controls for UI and tests.
- Adapt review API to consume durable incremental evidence while preserving explicit manual scan behavior.

At the end of Phase B, persistence/restart behavior should be testable without changing the inference algorithm.
### Phase C — Connect native mutation boundaries

- Enqueue normal image registration in the same transaction as authoritative asset/classification registration.
- Enqueue meaningful manual classification changes and exact-duplicate retags through one centralized helper.
- Add similarity-resolution enqueue where a candidate becomes a normal classified asset. Enqueue trash restoration even when classification is unchanged.
- Preserve cloud replication/outbox behavior.
- Carry an explicit mutation cause so auto-tag finalization can move broad-root assets without recursively scheduling itself.

Do not remove the renderer-driven fallback until native enqueue coverage has tests for all intended ingestion/classification paths.

### Phase D — Introduce the shared asset-centric worker path

- Move worker process ownership above individual target scans.
- Establish the verified-source lease for a claimed asset generation.
- Load/extract the query feature once.
- Cache/reuse target reference bundles by exact recognition identity with bounded invalidation/eviction.
- Compare all candidate targets and persist per-target predictions.
- Preserve frozen model, threshold, crop and learned-reference comparison behavior.

Manual/backfill work should use the same worker manager under the scheduling contract rather than bypassing ownership.

### Phase E — Implement asset-level finalization

- Arbitrate all applicable target predictions for one asset together.
- Perform expensive validation outside the global DB lock.
- Execute the complete recognition-context stale check and short write transaction.
- Atomically write automatic decisions, optional root-to-series move, durable prediction terminal state and claimed-generation completion.
- Preserve local working-tree fixes that validate negative competitors and learned-reference freshness.
### Phase F — Reduce React to status/control

Only after native scheduling and persistence are proven:

- Remove target-by-target steady-state automation ownership from `useCharacterAutomation`.
- Remove renderer polling as the trigger for repeated automatic application.
- Keep UI status, pause/resume/retry and concise completion/error messages backed by native durable state.
- Keep explicit Character Review/manual scan actions for investigation and historical work.

### Phase G — Run the same-scope structural benchmark

- Compare 1,000 versus 8,000 already-covered same-scope assets with the same candidate roster.
- Record the counters listed in the performance benchmark section.
- Confirm the incremental path does not enter the full target inventory path.
- Confirm worker starts, query hash bytes and query extraction count remain bounded per new asset generation.
- Report measured results separately from architecture assertions.

## Likely ownership/files

Expected areas, subject to Codex re-inspection before editing:

- `app/src-tauri/src/library/character_autotag.rs` — new queue scheduler, context snapshots, prediction persistence and finalization.
- `app/src-tauri/src/library/ingestion.rs` — atomic enqueue for newly registered normal images.
- `app/src-tauri/src/library/classification.rs` — centralized meaningful-change enqueue and mutation cause/self-requeue contract.
- Similarity resolution modules — enqueue when normal classified state becomes authoritative.
- `app/src-tauri/src/library/characters.rs` — recognition identity helpers; do not assume existing `Target.fingerprint` includes learned references.
- `app/src-tauri/src/library/character_review.rs` — durable incremental prediction review instead of dependence on in-memory scan state.
- `app/src-tauri/src/library/character_worker.rs` — one shared worker manager and job scheduling/cancellation boundaries.
- `app/character-runtime/scan_worker.py` — resident-query / repeated-target-bundle protocol extension.
- `app/character-runtime/feature_cache.py` — preserve integrity checks while orchestration removes per-target query repetition.
- `app/src-tauri/src/library/mod.rs` / `db.rs` / next migration — persistence and startup recovery wiring.
- `app/src/characters/useCharacterAutomation.ts` and status UI — native status/control consumer after migration.
- Existing character scan/decision tests plus new incremental persistence/race/performance-contract tests.

## Avoid premature complexity

Do not introduce an ANN/vector database, another ML model, or a separate series-classification model merely to make this incremental.

At the current product scale, exact comparison against the applicable registered characters is simpler and safer. Consider a candidate prefilter only if measurement later shows candidate-character count is the dominant cost after historical-size dependence is removed.

Do not change recognition threshold, detector crop policy, learned-reference eligibility, or automatic confidence rules as part of scheduler work unless a separate failing accuracy case requires it.

Do not convert automatic decisions into learned references when current policy requires explicit human approval.

Do not interpret this report as authorization to run a production full backfill. Historical coverage/reconsideration execution remains separately controlled.

## Final directive to Codex

Treat the existing target-wide scan as a **manual/backfill/recovery mechanism**. Build the normal steady-state path as a **durable event-driven incremental classifier** only after the six mandatory contracts above are resolved in code/tests.

The intended hot path is:

`native asset/classification commit + durable generation -> claim asset -> snapshot full recognition context -> establish verified source -> extract query once -> compare complete candidate roster -> persist predictions -> arbitrate people -> revalidate source/context -> atomic decisions + optional move + completion`

For one newly saved image, Lakomics should do work for that image and its current candidate characters. It should not rediscover thousands of already-covered same-scope images, lose unresolved evidence on restart, or authorize a decision from a candidate/reference/file context that changed during processing.
## Local implementation checkpoint — 2026-09-09

The native queue now owns automatic inference. `character_incremental.rs` consumes durable image jobs; `character_worker.rs` shares one process with manual scans; Python retains a loaded query and a bounded reference-bundle cache. Manual scans no longer expand to every character or apply automatic decisions. Renderer refresh is observation only. Target/scope/manual-learning/reference-source events reconsider recorded unresolved jobs in bounded batches; no startup historical sweep is introduced.

The source implementation in `character_sources.rs` copies verified query and reference bytes into temporary immutable inference snapshots, then rehashes managed originals outside the DB lock. Identity checks bracket the final SQL changes. Windows additionally retains handles denying write/delete sharing. Linux checks inode/device, size, mtime and ctime; this detects tested replacements but does **not** exclude a noncooperating external writer between the final metadata check and SQLite commit. That strict contract remains open and must not be represented as completed cross-platform exclusion.

Four native process tests cover shared manual/automatic ownership, pause/resume without the renderer, a changed reference rejecting publication, and invariant per-new-image worker calls with 1k/8k same-scope historical fixtures. An installed-model synthetic-image test checks exact legacy/resident-query result parity and no repeated extraction. These do not establish real-library latency, recognition accuracy or Windows native acceptance.
