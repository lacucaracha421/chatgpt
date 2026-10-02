# Cloud API SQLite plan audit — 2026-10-02

## Scope and reproduction

Run from `server/lakomics-api`:

```sh
timeout 120 .venv/bin/python tools/query_plan_audit.py --json /tmp/query-audit.json
timeout 90 .venv/bin/python -m unittest tests.test_query_plans tests.test_read_budget -v
```

The tool always creates a new temporary directory. It has no existing-database,
SSH, URL, or credential input. It reuses `poll_benchmark`'s startup/schema fixture,
skips every background worker, calls route functions directly, and executes real
SQLite queries. It does not use TestClient or open sockets. Catalog content is
imported and published locally through module functions with synthetic data.

Fixture: 10,000 committed Assets with one canonical authority row each (including
200 trashed Assets), active Asset/classification/album/bookmark domains, 9,000 tag
owners and **320,000 tag relations**, 600 classifications, 300 Albums/6,000 Album
members, 300 character nodes/30,000 character members, 667 character review items,
667 similarity review pairs, 500 catalog duplicate candidates, 549 collection
replicas/10,980 authoritative collection members, and 3,000 catalog works/36,000
catalog tags. Change feeds contain approximately 3,000 events each. Three extra
Asset events cover epoch/sequence ordering in the timestamp migration.

The audit captures SQL actually executed by the hot routes and supplementary
module functions, preserving the visibility TEMP VIEW and catalog bookmark TEMP
table in replay. Each statement gets `EXPLAIN QUERY PLAN`, three complete reads,
and a per-execution progress-handler cutoff (default one second). Reported times
are medians of SQLite execution plus fetching, excluding JSON digest calculation.
The first phase has no ANALYZE statistics; the second analyzes generated control
and catalog files. Both phases include populated, singleton and empty review,
candidate, character membership, Album membership and collection membership tables.
The analyzed edge cases refresh their statistics too.

Final run: Python 3.14.4 / SQLite 3.46.1; 190 distinct expanded SQL statements,
232 statement/edge executions per statistics phase, 464 total, zero errors or
result mismatches. The JSON records every measured statement, plan, timing,
error and result digest.
For changed statements it also executes the original JOIN or temporarily removes
the new index, in the **same database**, and checks identical ordered results.
`test_query_plans` additionally compares the changed routes' serialized bodies.
The startup UPDATE's exact value expression is measured as SELECT, keeping its
correlated lookup and fallback semantics without changing the fixture.

Source inspection covered server SQL joins, correlated EXISTS/NOT EXISTS,
JSON membership predicates, ordering, startup indexes and all connection creation
sites. Dynamic measurement concentrates on `poll_benchmark` and the requested
Library, Home, character, Album, collection and catalog paths. It is not proof for
every parameter combination, arbitrary future data distribution, or every write,
import and maintenance statement. No production database or VPS was inspected.

## Findings and changes

There is no `ANALYZE` or `PRAGMA optimize` in server startup or publication code.
Correctness/performance of the fixed plans therefore must not depend on stats.

| Statement | Original plan | New plan | No stats, ms before → after | With stats, ms before → after |
| --- | --- | --- | --- | --- |
| Character review totals | committed Assets outer; probe each selected target for every Asset | candidates outer; Asset ID lookup | 368 → 1.9 | 1.81 → 1.81 |
| Character review page | same Asset × target traversal; sort survivors | candidates outer; Asset ID lookup | 481 → 1.8 | 0.12 → 0.12 |
| Character review source-filtered page | same | same candidate-first plan | 486 → 1.9 | 0.13 → 0.12 |
| Character review per-target grouping | already candidate-first | shared pinned candidate-first FROM | 1.8 → 2.0 | 1.79 → 1.80 |
| Album page | walk whole Asset date index; probe Album membership | indexed Album members outer; Asset ID lookup; sort selected members | 20.0 → 0.13 | 0.12 → 0.13 |
| Album month TOC | same whole-library walk | same member-first selection | 19.4 → 0.06 | 0.06 → 0.06 |
| Startup lifecycle timestamp repair | each trash row searches the library's change history | exact library/Asset lookup in partial trash-event index | 112 → 5.0 | 119 → 5.4 |

Empty character-review totals/pages originally still cost roughly 150–160 ms;
singletons about 150–185 ms. Both now take about 0.06 ms without statistics.
Empty/singleton Album queries originally cost about 30 ms; now about 0.01–0.02 ms.
The existing similarity-review CROSS JOIN remains in place, including both Asset
lookups. Its uncorrelated `NOT IN (SELECT value FROM json_each(?))` lists are
materialized once; their producer excludes null Asset IDs. No rewrite was needed.

The new `asset_authority_last_trash` index follows existing startup
`CREATE INDEX IF NOT EXISTS` in `asset_authority.DDL`, **before** timestamp repair.
It contains only `trashAsset` events and `(library_id,asset_id,epoch,sequence)` keys,
not JSON payloads. At 1,502 indexed events it occupies about 88 KiB and builds in
about 0.8 ms locally. SQLite's ordinary disk-backed index construction is retained;
no memory-only temp store, large cache, backfill, or ANALYZE is introduced. Initial
build time/storage still scale with retained trash history; VPS startup has not
been measured. Subsequent startup uses the existing index. Latest epoch/sequence,
including timestamps that are not chronologically increasing, is regression-tested.

## Other measured plans

These statements were retained. Times are local per-statement ranges across stats
variants; they are not endpoint round-trip times or before/after improvements.

| Read family | Plan/evidence | Observed SQL time |
| --- | --- | --- |
| Sync/status and Asset/classification/Album/bookmark changes | singleton or `(library,epoch,sequence)` range searches | about 0.01–0.21 ms |
| Asset pages, technical filters | existing ordered Asset index, canonical state ID probes | about 0.07–0.25 ms |
| Classification/tag/artist filtered Assets | indexed candidate subqueries and creator/assignment probes; selected-set sort | about 0.1–4.8 ms |
| Full/filtered Asset TOC | one ordered eligible-Asset walk; full TOC necessarily reads the selection | about 5–21 ms |
| Classification counts / Home library summary | one assignment/Asset scan; nested checks all keyed by Asset ID | about 13–18 ms |
| Character index visibility correction | one 30,000-member scan, keyed visibility/hidden-member checks | about 28 ms |
| Character published/date pages and TOC | indexed node/filter members outer, Asset ID probes; scoped date sort | about 0.10–0.25 ms |
| Similarity review count/page | items outer, two Asset ID probes; empty/singleton checked | up to about 1.5 ms |
| Collection replica list / authority members and baseline sections | bounded collection sort; indexed work-members and baseline keys | about 0.01–0.34 ms |
| Library tag suggestions | precomputed counts; no scan of 320,000 relations on the request | about 0.06–0.12 ms |
| Home publications, artist state, pending captures, exclusions | singleton/sequence/status indexes; small pending-set sort | generally below 0.1 ms |
| Catalog search/count/detail/editions | indexed work/tag/group lookups; materialized matching candidates | about 0.01–6 ms |
| Catalog suggestions | one 36,000-tag aggregation with keyed translations/blocked tags | about 8 ms |
| Catalog duplicate candidates | candidates outer; indexed LEFT JOIN decisions; empty/singleton checked | below 1 ms |
| Revisit bundle/calendar | whole eligible-set aggregate/calendar ranking, temp sorting on date mode | about 33–60 ms for the slowest statements |

Catalog search retains an automatic covering index on its materialized matching
CTE. It is built once for that bounded snapshot query, not once per Asset or
requested group; group membership lookups are indexed. There was no demonstrated
pathological execution at this fixture size. Very large catalogs, revisit ranking,
full TOCs and global character visibility counts remain scaling risks: the budget
limits damage but is not a substitute for further measured optimization.

## Read execution budget

`ReadBudgetMiddleware` marks GET/HEAD request contexts. AnyIO copies that marker
into synchronous workers. Both the control database (`app.get_db`) and immutable
catalog reads (`open_publication`) install a SQLite progress handler on each marked
connection. Every 10,000 VM instructions it checks a monotonic **15-second wall
deadline**; one connection's queries and fetches share that deadline. Cancellation
of the HTTP peer is unnecessary for interruption.

Only an interrupt caused by that handler is translated to:

```json
{"detail":"Database read took too long; please retry"}
```

with HTTP **503**. Other database errors and unrelated interrupts retain existing
handling; connections close normally. Catalog search/detail/count keep their
existing explicit ten-second limit and existing 503 response text, now using the
shared handler implementation. Catalog reads outside those routes (for example,
the manga index) also receive the default GET budget.

POST/PUT/PATCH/DELETE commands and publications, imports, backfills, refresh jobs,
startup and background workers are explicitly outside automatic marking. A
long-poll's async wait holds no DB connection: its next short read gets a fresh
connection budget. This is a SQLite VM deadline, not a total HTTP deadline; it
does not time out Python loops, file/network IO, or locks (existing busy timeout
remains). A later read connection gets a new budget.

## Verification and limits

Added socket-free tests cover all changed plan families with/without statistics
and empty/singleton candidates; unchanged SQL result digests and serialized route
bodies; real SQLite interruption during execution/fetching; the shared connection
deadline; ContextVar propagation/cleanup; GET/HEAD versus writes/jobs; control and
catalog connection handling; retained catalog timeout; and actual ASGI 503 JSON.

Targeted existing catalog query/search/suggestion, library creator filter,
duplicate-rule/incremental-check and collection provider-merge tests were run.
TestClient-backed character/similarity/Album/Asset-filter/TOC/catalog API suites
were not run here. An attempted `test_mobile_catalog_refresh` run hung in its
TestClient publication and was interrupted; it is not passing evidence. The
controller should run the full suite outside the sandbox:

```sh
.venv/bin/python -m unittest discover -s tests -t .
```

Review was inline against the actual diff. No Git writes, deployment, native
client checks, production-data access or production changes were performed.

Final focused run: **64 tests passed** (15 new tests and 49 existing tests).
Existing scope: `test_library_search.CreatorFilterTests`,
`test_mobile_catalog.MobileCatalogQueryTests`, `test_mobile_catalog_search`,
`test_mobile_catalog_suggestions.SuggestionCacheTests` and `ShortNamespaceTests`,
`test_catalog_duplicates.RulePortTests` and `IncrementalCheckTests`, and
`test_collection_authority.ProviderMergeFixtureTests`. `git diff --check` passed.

Changed production files: `app.py`, `read_budget.py`, `character_review.py`,
`album_authority.py`, `asset_authority.py`, `mobile_catalog.py`,
`mobile_catalog_replica.py`. Added verification files: `tests/test_query_plans.py`,
`tests/test_read_budget.py`, `tools/query_plan_audit.py`, and this report.
