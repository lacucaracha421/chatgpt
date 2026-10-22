# Online Catalog query regression investigation — 2026-09-05

Investigated from `1a33e0cd35d67edd9d58c8ea0f60ae2447f9fe82` on
`codex/overnight-backlog-20260905`, before CATALOG-003. CATALOG-003 and
CATALOG-007A were not started.

## Confirmed costs and selected fix

The installed catalog has 131,210 Works (127,241 non-expunged, 97%) and
1,801,026 Tags. The saved policy has two hidden categories and ten exact
blocked namespace/value pairs. No sqlite_stat tables were present.

1. SQLite treated `work.Expunged = 0` as selective and chose
   `IdxWorksRank(Expunged, Views DESC, Posted)` for latest searches. With
   visibility/category/title checks this fetched wide Works rows in Views
   order, then sorted all qualifying rows for a 48-result latest page.
2. Both visibility subqueries were emitted even when their policy tables
   were empty. The blocked-tag subquery still enumerated each work's tags
   before probing the empty blocked-policy table. The hidden-category
   reference also prevented a covering-index COUNT.
3. COUNT and result-page queries repeated the same WHERE. Consequently the
   bad traversal ran twice. The title compiler already evaluates the scalar
   substring condition before the correlated visibility probes; ordinary
   title search was chiefly paying for the wide-row access order, not an
   accidental change to title matching semantics.

The production change is limited to a `likely(work.Expunged = 0)` planner
hint for **Latest only** and independently omitting each visibility predicate when its persisted
set is empty. `likely` returns its argument unchanged and does not force an
index ([SQLite documentation](https://www.sqlite.org/lang_corefunc.html#likely)).
Both empty-set checks happen once on the same search connection while the
Library database lock is held. COUNT and page reuse the same resulting WHERE
and bindings. There is no new policy cache and no React filtering.

The original exact `NOT EXISTS` tag anti-match, Boolean parser/compiler,
`Title LIKE '%term%' OR COALESCE(TitleJpn, '') LIKE '%term%'` with literal
wildcard escaping, expunged/language/bookmark rules, ordering and pagination
are unchanged. No DB replacement, migration, ANALYZE, persistent index, FTS,
hit table or denormalized cache was introduced.

## Reproducible real-database measurements

The opt-in Rust test `catalog_real_query_measurements` uses the application's
bundled SQLite **3.53.2**, debug test profile. It attaches both source databases
with `mode=ro`, copies only policy/bookmark tables (including their original
keys) into an in-memory main database, and writes only that in-memory copy.
The empty-policy experiment clears only those copied policy tables.

Each cell is the median of three runs after one warm-up, in milliseconds.
Before and after use the same connection, real catalog, query, bindings,
48-result page and latest ordering. Every COUNT value and every selected
page column is asserted equal between versions. These are SQL execution
measurements, not UI paint/network or cold-start timings. Page measurements
include bookmark projection; production's separate bulk artist/series
hydration is unchanged and is included in the large-fixture Library test.

| Policy | Query | COUNT before | COUNT after | Page before | Page after |
|---|---|---:|---:|---:|---:|
| 2 hidden + 10 blocked | `(default)` | 1765.570 | 538.268 | 1756.412 | 0.365 |
| 2 hidden + 10 blocked | `love` | 682.575 | 115.108 | 688.159 | 5.315 |
| 2 hidden + 10 blocked | `id:4169932` | 0.024 | 0.027 | 0.025 | 0.031 |
| 2 hidden + 10 blocked | `female:glasses` | 1896.271 | 669.276 | 1849.976 | 12.834 |
| revealBlocked=true | `(default)` | 13.184 | 8.199 | 25.098 | 0.394 |
| revealBlocked=true | `love` | 661.632 | 92.408 | 631.694 | 4.588 |
| revealBlocked=true | `id:4169932` | 0.014 | 0.009 | 0.012 | 0.012 |
| revealBlocked=true | `female:glasses` | 125.128 | 131.090 | 651.475 | 6.036 |
| 0 hidden + 0 blocked | `(default)` | 1754.274 | 7.807 | 1738.549 | 0.237 |
| 0 hidden + 0 blocked | `love` | 736.944 | 95.750 | 858.861 | 4.699 |
| 0 hidden + 0 blocked | `id:4169932` | 0.012 | 0.008 | 0.035 | 0.025 |
| 0 hidden + 0 blocked | `female:glasses` | 2566.124 | 141.798 | 2221.002 | 3.299 |

The default saved-policy total falls from 3,521.982 ms to 538.633 ms
(6.5x); `love` falls from 1,370.734 ms to 120.423 ms (11.4x).
The remaining saved-policy default COUNT is the dominant request cost.
ID lookup remains a primary-key lookup; microsecond differences are noise.
The revealed exact-tag COUNT is essentially unchanged (125–131 ms), while
its first page improves substantially.

## EXPLAIN QUERY PLAN findings

Representative saved-policy default COUNT before:

```text
SEARCH work USING INDEX IdxWorksRank (Expunged=?)
CORRELATED SCALAR SUBQUERY
  SEARCH hidden_category USING PRIMARY KEY (category=?)
CORRELATED SCALAR SUBQUERY
  SEARCH blocked_work_tag USING PRIMARY KEY (WorkId=?)
  SEARCH blocked_tag USING PRIMARY KEY (namespace=? AND value=?)
```

The old page has the same expensive work traversal plus
`USE TEMP B-TREE FOR ORDER BY`. After the hint, saved-policy COUNT uses
`SCAN work`; the latest page uses `SCAN work USING INDEX IdxWorksPosted`
and `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`. This only sorts Posted ties
for the descending Id tiebreaker and can stop after the page is found.
After empty-policy omission, COUNT uses a covering rank-index scan and
neither visibility subquery appears. Each policy's omission is independently
tested in all four empty/nonempty combinations.

Title queries follow the same before/after Works access plans; they cannot
seek a regular B-tree for an arbitrary substring. ID queries retain
`SEARCH work USING INTEGER PRIMARY KEY (rowid=?)` in every policy case.
Exact tag queries use exact covering-key probes; SQLite 3.53.2 can transform
the EXISTS to `SEARCH query_tag EXISTS USING COVERING INDEX IdxTagsLookup
(Namespace=? AND Value=? AND WorkId=?)` for COUNT. Latest pages use the
WorkId-leading primary key probe instead.

`Tags` is WITHOUT ROWID with PRIMARY KEY `(WorkId, Namespace, Value)`.
The existing `IdxTagsLookup(Namespace, Value)` also contains WorkId as the
primary-key suffix. The original blocked anti-match uses only the WorkId
prefix before checking each tag against the small policy primary key.
Adding blocked rows does not materially change that original join plan;
empty tables do not make the compiled predicate free. The measured fix
changes the Works access order and skips absent policies, not the tag keys.

## Alternatives evaluated

Exploratory read-only Python/SQLite 3.50.4 measurements preceded the bundled
Rust measurements above; they are not mixed into the headline table.

- Starting the correlated anti-match from blocked policy rows with CROSS
  JOIN allowed full-key tag seeks, but still performed repeated per-work
  probes and did not address the costly Works access order. Improvement was
  much smaller than correcting that plan.
- A non-correlated NOT IN of blocked WorkIds could use the existing tag
  lookup index, but built the exclusion set again for each statement and
  increased an ID query from microseconds to approximately 2.6 ms. It also
  added work to an already fast first page. The simple existing anti-match
  was retained; it remains a possible separately measured COUNT optimization
  if the residual roughly 0.54-second default count is unacceptable.
- Disqualifying the Expunged index term with unary `+` also selected the
  better traversal. The final hint was preferred because it preserves the
  expression value/affinity and leaves index selection to SQLite.
- A follow-up Views probe exposed a regression from applying the hint to
  every sort: the saved-policy first page changed from a rank-index seek
  (0.334 ms) to a full scan/sort (330.924 ms) in SQLite 3.50.4. A new large
  fixture VM-step guard reproduced this failure. The final implementation
  applies the hint only to Latest; Views and all Hot sorts retain the exact
  original active predicate and rank-index eligibility. No speedup is claimed
  for their saved-policy COUNT paths. The normal suite protects Views page
  early exit as well as Latest, and existing tests cover all sort results.
- COUNT was not replaced with a window count: that would require processing
  all matches before yielding the first page and needs additional handling
  when an offset produces no rows. Keeping the two statements now allows
  the page to stop early, removing most of the duplicate full traversal.

## Title search and FTS decision

Title COUNT remains a linear scan: around 92–115 ms here, versus 632–858 ms
before depending on policy. It is a residual cost but does not justify an
unreviewed search index at this catalog size. **FTS5 is not recommended as
part of this fix.** If future scale or latency requirements demand indexing,
first benchmark a trigram candidate index over both title fields with the
existing escaped LIKE expression as the final predicate. Any design must
cover short terms, Japanese text, NULLs, literal `%`/`_`/backslashes, Boolean
NOT/OR and exact count/page parity. Ordinary token-based MATCH is not a
semantics-preserving replacement for arbitrary substring search.

## Verification

- Large fixture: 131,210 Works, 1,836,940 Tags, wide payload rows and the
  production Posted/rank/tag lookup indexes. The original code reproduced
  the regression: old COUNT+page 4.48 s versus actual Library search 4.69 s.
  After the fix an observed run was 4.13 s versus 13.8 ms with empty policy.
- Normal tests use deterministic SQLite VM-step budgets for COUNT and page;
  including a Views page budget; wall-clock measurements are diagnostic only. A separately derived fixture
  oracle checks title/ID/exact-tag results, persisted/revealed policy,
  expunged rows, nullable Japanese titles, tie ordering, and first/next pages.
- Focused Rust catalog suite: 89 passed, 0 failed; real benchmark excluded
  by default. Opt-in real benchmark: 1 passed, all 24 before/after result
  comparisons passed.
- `npx tsc --noEmit`: exit 0. `npm run build`: exit 0 (existing chunk-size
  warning). No frontend/client source was touched.
- Scoped rustfmt checks and `git diff --check`: passed. Existing unrelated
  formatting in online_catalog.rs was preserved; only changed lines checked.
- Independent review found no blocking correctness issue. Its timing-test
  robustness feedback was incorporated by using VM-step budgets.

Run the read-only benchmark explicitly from the repository root:

```powershell
$env:LAKOMICS_CATALOG_BENCH_ROOT = '<configured library root>'
cargo test --manifest-path app/src-tauri/Cargo.toml --lib catalog_real_query_measurements -- --ignored --nocapture --test-threads=1
```
