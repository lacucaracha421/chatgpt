# CATALOG-007A performance gate

Status: **STOPPED before API/UI integration; not DONE.**

The reviewed lineage design is safe on the observed data, but exact grouped COUNT
does not meet the requested performance gate. The existing raw catalog search
remains the application path. No grouped command, client type, card, edition UI,
or manual representative control has been enabled.

## Scope and reproducibility

Task baseline: `9968d657e6406f16a67448d3e5cdfa137ba3fca4` on
`codex/overnight-backlog-20260905`. Measurements used bundled SQLite **3.53.2**.
The real catalog and saved policy/bookmark database were attached with `mode=ro`;
only disposable/in-memory derived state was written. No production migration,
catalog replacement, ingestion run, server deployment, or canonical index change
was performed during this task.

Real scale: **131,210 Works, 1,801,026 Tags, 127,241 active Works**. The captured
policy has one hidden category and ten blocked tags. Validated lineage produces
110,491 components: 99,665 singletons and 10,826 multi-edition components, with a
largest component of 104. Three missing-reference works remain separate. The
synthetic regression has 131,210 Works and 1,836,940 Tags, mostly singletons and
two-edition groups plus a 104-edition chain; it does not model every real chain size.

One warm-up and three measured executions are used for each tabulated query;
values are medians in milliseconds. Measurements are warm-query observations,
not an OS cold-cache or native UI acceptance claim. The initial raw benchmark
uses the existing catalog performance harness and its full page projection.
Experimental SQL has a smaller projection and is labeled separately: its page
timings must not be substituted for the application's raw baseline.

```powershell
$env:LAKOMICS_CATALOG_BENCH_ROOT = '<explicit read-only library root>'
cargo test --manifest-path app/src-tauri/Cargo.toml --lib catalog_real_query_measurements -- --ignored --nocapture --test-threads=1
cargo test --manifest-path app/src-tauri/Cargo.toml --lib catalog_group_real_query_measurements -- --ignored --nocapture --test-threads=1
$env:LAKOMICS_CATALOG_COUNT_ALTERNATIVES = '1'
# Run catalog_group_real_query_measurements again; then remove this variable.
$env:LAKOMICS_CATALOG_COUNT_ORDINAL = '1'
# Run catalog_group_real_query_measurements again; then remove this variable.
$env:LAKOMICS_GROUP_PROFILE = '1'
cargo test --manifest-path app/src-tauri/Cargo.toml --lib catalog_groups_real_materializer_and_query_gate -- --ignored --nocapture --test-threads=1
```

Run measurements sequentially, without a concurrent compiler/build or benchmark.
The harness prints plans and samples; experiment JSON is written to the operating
system temporary directory. It never requires an application launch.

## Raw baseline versus final backend query draft

The draft uses the real materializer, durable UUID mapping, complete matching
predicate, SQL group pagination, and bounded representative selection. It is not
connected to the app. These phases exclude frontend rendering and card hydration.

| Policy | Query | Raw COUNT | Draft COUNT | Raw page | Draft page | Draft representatives |
|---|---|---:|---:|---:|---:|---:|
| Saved | default | 522.420 | 1007.964 | 0.381 | 1.669 | 2.049 |
| Saved | love | 115.306 | 146.058 | 5.863 | 5.381 | 2.733 |
| Saved | id:4169932 | 0.024 | 0.262 | 0.030 | 7.923 | 0.471 |
| Saved | female:glasses | 623.263 | 654.052 | 6.847 | 8.362 | 16.597 |
| Reveal | default | 13.795 | 433.957 | 0.258 | 1.458 | 2.215 |
| Reveal | love | 92.429 | 138.140 | 4.502 | 4.969 | 1.759 |
| Reveal | id:4169932 | 0.008 | 0.187 | 0.012 | 8.037 | 0.371 |
| Reveal | female:glasses | 131.969 | 206.426 | 3.374 | 5.040 | 8.048 |

The forced outer Posted traversal in the draft also costs about 8ms for exact ID
queries. That query should retain the direct rowid path before activation. It is
a separate draft limitation, not the dominant COUNT blocker.

With empty persisted policy sets, the original raw default measured
**9.350ms COUNT / 0.259ms page**; the UUID experiment measured
**418.90ms COUNT / 0.32ms page**. Empty sets omit their predicates; visibility
probes are not the explanation for the remaining grouped overhead.

Initial validation alone took about **120ms** in optimized standalone Rust.
The final real-data materializer/query harness took **3997.54ms** to read lineage,
allocate durable handles, and publish the complete membership into an in-memory
library database; an unchanged-source check took **0.199ms**. This is not a
durable on-disk materialization latency claim. Restart/backup persistence is
verified separately with disposable file-backed library fixtures.

## Query plans and alternatives

* Existing title semantics remain `Title LIKE '%term%' OR COALESCE(TitleJpn,'')
  LIKE '%term%'`, with the existing escaping and complete Boolean AST. Broad
  substring COUNT scans Works and remains a separate roughly 90–146ms cost in
  the observed `love` cases. FTS5 was neither introduced nor recommended for the
  lineage problem; it would require a separately reviewed substring contract.
* Tags has primary key `(WorkId,Namespace,Value)` WITHOUT ROWID and
  `IdxTagsLookup(Namespace,Value)`. Existing non-empty visibility checks use the
  WorkId-leading key and the blocked-policy primary key. Canonical keys and
  indexes are unchanged.
* Plain grouped JOIN can start with membership in opaque group-ID order, causing
  random Works lookups. A preliminary Python probe saw title COUNT grow from
  about 165ms to 1.4s. `Works NOT INDEXED CROSS JOIN membership` restores a
  sequential Works scan, but the final plan still has `USE TEMP B-TREE FOR
  count(DISTINCT)` and an indexed membership lookup for every qualifying work.
* The UUID membership lookup uses the unique `(provider,catalog_work_id)` index
  followed by the WITHOUT ROWID record to obtain group_id. Removing random Works
  access does not eliminate membership probes and global distinct accumulation.
* Ordinary Latest can incorrectly select the Views rank index and sort all
  candidates. The draft instead starts with `IdxWorksPosted`, probes the matching
  row by primary key, then reverse membership. Only the final Id tie needs a temp
  sort. Experimental unary `+Expunged` also recovered this plan but was not adopted
  in the draft's predicates.
* The sibling anti-match uses reverse membership followed by a work primary-key
  lookup. `CROSS JOIN` prevents a Hot-plan reversal that scanned the rank index
  per outer candidate. The initial experimental HotDay page was 326–425ms;
  that initial figure is not claimed as a final draft timing. All five sorts pass
  the final realistic draft oracle and broad runaway-scan guard.
* A representative subquery initially ignored the group constraint as an access
  path and scanned provider membership, taking about 800ms for 48 cards. Explicit
  use of the derived reverse index and membership-first traversal reduced default
  representative selection to about 2ms. The representative/count/bookmark
  summaries are one bounded SQL statement, not one statement per card.
* Anti-predecessor COUNT did not solve the problem: reveal default was about
  **454ms**, compared with about **412ms** for the UUID DISTINCT alternative.
  A covering index that the planner did not actually select was not accepted as
  proof of a covering-index improvement.

The strongest small storage experiment retained public UUIDs while using an
internal numeric group ordinal and an explicitly selected covering index. It was
only an in-memory experiment; no ordinal column/index was added to migration 35.

| Policy / query | Raw COUNT | Numeric covering COUNT | Added latency |
|---|---:|---:|---:|
| Saved / default | 510.14 | 642.31 | 132.17 |
| Saved / Korean | 671.74 | 763.72 | 91.99 |
| Saved / love | 121.84 | 130.67 | 8.83 |
| Reveal / default | 9.65 | 175.15 | 165.50 |
| Reveal / Korean | 149.66 | 308.40 | 158.73 |
| Reveal / love | 105.29 | 98.94 | -6.35 |

EXPLAIN confirms `COVERING experiment_member_ordinal_cover`. This is better than
UUID DISTINCT, but the reveal default remains about 18 times the baseline. An
additional 100ms was used as an investigation screening target, not presented as
a user-specified threshold. The actual stop decision is the material regression
in ordinary initial/default navigation despite the small SQL/storage alternatives.

## Implemented backend boundaries

1. **Schema 35:** one additive library.sqlite migration creates group handles,
   preferences, members, state and diagnostics. No foreign key points at external
   catalog rows. Existing bookmarks, progress, policies and update settings remain
   in place. Existing pre-migration backup behavior is preserved.
2. **Durable state:** each provider-work anchor owns an opaque UUID and increasing
   creation sequence. Components choose the oldest existing handle. Absorbed and
   absent handles are retained; old handles resolve through their anchor's current
   membership after a split. Preferences remain anchor-scoped with a nullable
   explicit automatic-selection tombstone and monotonic edit revision.
3. **Derived state:** membership, thumbnail/completeness ranking inputs, terminal
   flags, diagnostics and source/generation status are rebuildable. Canonical
   Works columns remain the evidence source; a redundant normalized edge table
   was omitted. No title/artist/language/page/category heuristic establishes identity.
4. **Acceptance:** only same-provider parent/first links with positive existing
   targets and matching non-empty target tokens can establish membership. The
   graph must prove one linear edition order with a consistent first root.
   Missing/malformed references, orphan keys, nonpositive IDs, mismatched keys,
   cycles, branching and conflicting roots poison the entire implicated component.
   Components over 4096 are separated. Current only validates forward movement
   inside the proven order; stale intermediate Current pointers are accepted.
5. **Lifecycle:** the common canonical writer compares stored fields and sorted
   tags before/after writing and changes one CrawlState content revision only for
   an actual content change. RawJson/CrawledAt, checkpoint-only actions and replay
   do not advance it. Import staging receives a fresh revision before existing
   replacement publication. No new global lock or network-spanning lock exists.
   The draft rebuilds on source/algorithm changes and requires a caller-owned
   transaction spanning membership and query reads. Incremental publication is
   not implemented.
6. **Matching/cardinality:** the NOT MATERIALIZED matching CTE applies the entire
   AST and bookmarked scope to the same eligible work. COUNT is DISTINCT groups;
   page donors eliminate a better matching sibling before LIMIT/OFFSET. React
   never folds raw pages. NULL Posted ties are deterministic.
7. **Representative/sorting:** representatives are chosen only from matching
   members, ordered by durable manual preference, Korean preference when language
   is unrestricted, valid thumbnail, completeness, proven terminal and Id.
   Hard language scope applies first. Latest/Views/Hot donors are independent of
   representatives. Hot retains the clamped-latest clock convention but takes its
   reference from eligible works so hidden siblings cannot move the visible window.
   The draft uses one captured clock value for COUNT and page.
8. **Work state:** no bookmark or progress is moved onto groups. A card's future
   version count is eligible membership count; its sibling-bookmark indicator uses
   eligible members. Manual choice storage/reset and query fallback are tested,
   but no manual control or lazy editions API is exposed yet.
9. **Deferred:** API/client types, group UI, lazy editions/unavailable metadata,
   public manual controls, pagination context and native acceptance remain undone.
   No runtime epoch, query fingerprint or extra user revision protocol was added.

## Required architecture decision before continuing

Do not enable grouped search or mark CATALOG-007A DONE with the present COUNT path.
The smallest additional design worth reviewing is an **exact default-query count
cache**, restricted initially to empty text and All scope, keyed by source/algorithm
and the actual eligibility inputs (language, reveal, visibility policy). A cached
value must be read from the same logical snapshot as the page; it cannot reuse an
old policy's count. Bookmarked and Hot scopes introduce additional invalidation
inputs and should not be casually added to that first cache.

Lazy memoization alone does **not** fix first-load or post-invalidation latency.
To satisfy the initial-loading gate, assess computing the relevant default counts
as part of derived-generation publication, with an explicit preparation lifecycle.
Measure its cold preparation, restart reuse, policy changes and catalog updates
before deciding whether a small set of exact count entries is sufficient or a
larger per-group eligibility aggregate is justified. The latter is a larger change
and is not established as necessary by this investigation. Neither may relax
same-member semantics or return a stale/approximate count. This extra derived state
and invalidation responsibility require review; they were not implemented here.

## Verification and checkpoint commits

* Focused Rust `cargo test --lib catalog`: **134 passed, 4 ignored**, exit 0.
* After the final query access-path changes, `cargo test --lib catalog_group`:
  **9 passed, 2 ignored**, exit 0; includes the realistic draft query across all
  five sorts. These are overlapping runs, not 143 unique tests.
* Database migration suite: **25 passed**, exit 0, including v34 user data and a
  real pre-migration snapshot. Pure standalone lineage: **17 passed**.
* Opt-in real raw, grouped experiment, ordinal experiment and final materializer/
  draft query measurements completed successfully. Passing functional oracles is
  explicitly **not** a passing latency gate.
* Frontend catalog/update/visibility/detail/client regressions: **45 passed in
  5 files**, exit 0. No frontend files were changed.
* Server catalog API regressions: **33 passed**, exit 0; server code is unchanged.
* `npx tsc --noEmit` and `npm run build`: exit 0. The existing large-chunk warning
  remains. New Rust files pass scoped rustfmt; task diffs pass whitespace checks.

Verified foundation commits, each pushed to the requested branch:

* `e9d78556cfe1d2707e92759b4b3a7b06b1c23367` — durable handles/preferences, migration.
* `7a5ad31afefd1905028f65dac843e3a801ab3aee` — conservative pure lineage validation.
* `746b05b3f043797cbda1c6ec2cf19b612f049ebc` — canonical publication revision boundary.
* The commit containing this report retains the unexposed materializer/query draft
  and reproducible performance gate for review; it does not activate grouped search.

Unrelated concurrent documentation/skill changes are excluded from these commits.
CATALOG-007B, Heliotrope, cross-provider grouping, heuristic discovery, FTS5, PR,
merge and deployment were not started.
