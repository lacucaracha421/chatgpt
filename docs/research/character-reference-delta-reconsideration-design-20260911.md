# Character Reference Expansion and Delta Reconsideration Design

Date: 2026-09-11
Status: Accepted workflow; implementation verification recorded 2026-09-12

## Authority and scope

This document records a proposed way to increase character references without
turning every reference change into a full historical reanalysis. It does not
authorize implementation, production-library writes, a backfill, Git writes, or
deployment.

The proposal supplements the character-change policy in
`character-autotag-steady-state-review-20260909.md`. The living backlog remains
the source for task status and priority.

This design covers **adding learned references**. Removing or replacing an
anchor or learned reference can invalidate prior evidence in a different way
and requires a stricter, separately reviewed policy.

## Product problem

2026-09-12 update: the approved unified-reference contract in
`character-classification-quiet-workflow-design-20260911.md` supersedes the user-facing
anchor/learned distinction below. Legacy storage still supports existing libraries.
Only currently valid references participate; trash/restore changes the active set
without erasing its stored links. Removal or replacement is not an append-only
delta and does not automatically schedule historical analysis.

More references can provide enough supporting matches for reliable automatic
classification. The current automatic threshold requires support from six
references, so a character with only five anchors cannot be automatically
confirmed. A character may use up to five anchors and twenty learned references.

The cost appears when references are added and historical assets are reconsidered.
If references are added one at a time, the same historical candidates can be
visited repeatedly under successive recognition contexts. This makes improving
accuracy feel like starting another long-running analysis job and adds more work
to an already tiring collection workflow.

## Clarified invariant

If new references must affect all eligible historical assets, the affected
historical candidate set must be visited at least once. That traversal cannot be
removed without leaving some old results unchanged.

It does **not** follow that Lakomics must repeat the full analysis pipeline.
A reference-addition pass should compare the new references only and reuse valid
query detections, embeddings, existing reference distances, and prior durable
evidence. If only future assets need the expanded references, no historical
traversal is required.

## Current implementation facts

- Reference and target identities are part of the recognition context. Adding a
  learned reference therefore changes the context used to authorize a result.
- Historical reconsideration is durable and supplied in bounded batches rather
  than loading the full series into the pending queue at once.
- The Rust incremental engine reuses prepared reference snapshots while the
  complete reference key remains equal. A changed reference set invalidates that
  bundle as intended.
- Python reference features are content-addressed and already cacheable. The Rust
  prepared-reference cache also avoids repeated reference capture, hashing, and
  temporary copying across candidates in an unchanged context.
- Candidate source capture and final identity checks remain per job because a
  cached database result alone must not authorize a decision for changed bytes.
- Recorded prediction evidence contains per-reference distances and can support
  an offline decision-rule replay. Reuse for publication still requires current
  input and recognition-context validation.

Historical measurement from the prepared-reference work showed the reference
preparation portion falling from 41.84 ms on the first item to 0.14 ms on a reused
item. That fixture is evidence that repeated reference preparation can be
amortized; it is not a production-library or Windows throughput claim.

## Recommended behavior

### 1. Add references as one batch

The user should be able to collect and validate several learned references, then
apply up to the existing twenty-reference limit in one operation. One transaction
creates one new reference-set revision and one reconsideration request. Adding
twenty references must not schedule twenty successive historical passes.

### 2. Separate future classification from historical refresh

Newly collected assets use the latest reference set immediately. Historical
refresh runs at lower priority and yields to ingestion, manual actions, and other
interactive work. Closing character review does not cancel it; pause and resume
remain available.

The UI should state these as separate facts:

- `새 이미지에 적용됨`
- `과거 미확정 이미지 갱신 중`

Historical refresh is maintenance, not a review obligation. It must not create a
new demand that the user clear a growing queue.

### 3. Reconsider only useful historical states by default

The default pass targets durable assets in `awaiting_candidates`, `unresolved`,
`partially_resolved`, or retryable failure states within the affected scope.
Manual accepted decisions remain authoritative. Existing automatic accepted
history is not silently audited or revoked merely because references grew; a
broader retrospective audit is a separate explicit operation.

### 4. Compute the reference delta

For every selected historical candidate:

1. Load its latest valid evidence and the old reference identities.
2. Determine which references are new in the current reference-set revision.
3. Reuse valid query detections and embeddings when present.
4. Compare the query only with the new reference features.
5. Combine the new distances with retained per-reference distances.
6. Re-run the unchanged recommendation and automatic-acceptance rules.
7. Publish only after source identity, current scope, competing targets, runtime,
   and reference-set revision pass the existing stale checks.

If required cached query evidence is missing, incompatible, or invalid, that
candidate may fall back to the existing full analysis path. The fallback should
be measured and reported rather than hidden.

### 5. Preserve safety boundaries

- Do not weaken candidate full-hash and final identity protection merely to skip
  the historical pass.
- A replaced, missing, or ineligible reference invalidates its prepared bundle
  and cannot authorize publication.
- Adding a reference cannot overwrite a later manual rejection or acceptance.
- Automatic publication must still consider the complete current competing
  character roster, even when only one character received new references.
- Windows retained-handle behavior and Linux replacement detection remain part
  of acceptance. Evidence from one platform does not prove the other.

## Proposed data and scheduling contract

A reference addition should produce a durable change record with:

- affected series and target;
- previous and current reference-set revisions;
- the identities and hashes of newly added references;
- a bounded cursor over eligible historical checkpoints;
- totals for visited candidates, delta comparisons, full-analysis fallbacks,
  newly resolvable results, failures, and remaining work.

Repeated additions before processing begins should coalesce into one pending
change containing the newest reference set and the combined delta. If processing
has started, a newer revision supersedes remaining work safely; completed work is
reused where its stored distances cover the new reference set.

Fresh ingestion has higher priority than historical reference reconsideration.
The scheduler continues to feed bounded batches and must not hold every affected
asset in memory or monopolize the worker.

## Complexity target

For an addition of `D` references to `A` eligible unresolved assets, the intended
comparison work is approximately `A × D`, plus bounded source validation and
fallbacks. It must not behave like `A × all references × all targets` when valid
prior evidence already covers the unchanged portion.

The pass remains linear in the number of historical candidates that are required
to receive the new evidence. The design reduces work per candidate and prevents
repeated whole-scope passes; it does not claim that retroactive completeness is
free.

## Verification requirements

Before claiming an improvement, measure the old and proposed paths on the same
inputs and reference changes.

- Add 1, 5, 10, and 20 references in a single revision and record elapsed time,
  candidates visited, delta comparisons, feature-cache misses, full-analysis
  fallbacks, and publication counts.
- Compare one twenty-reference batch with twenty sequential single-reference
  additions. The final decisions must match while the batched path avoids
  repeated unchanged work.
- Confirm that old reference distances are not recomputed when their identities
  remain unchanged.
- Confirm result equality with the existing full recomputation path for matched,
  unmatched, ambiguous, multi-person, and competing-character cases.
- Exercise restart, pause/resume, a reference added during an active pass, query
  replacement, reference replacement, manual decisions racing publication, and
  a changed series or candidate roster.
- Report fixture, production-library, Linux-native, and Windows-native evidence
  separately.

## Accepted historical-refresh policy

Historical reconsideration starts only when the user chooses `과거 미분류 이미지 갱신`.
Adding or confirming references affects newly enqueued images immediately and does
not create a historical scheduler row. The explicit refresh runs at low priority,
visits the eligible historical set once, and uses reference-delta comparison where
the stored evidence passes current safety validation.
