# CATALOG-007A hybrid COUNT continuation

Starting revision: `2a3328736679683944e1229e17b0c89c33e05b55`, branch
`codex/overnight-backlog-20260905`. This continues the reviewed
[stopped gate](catalog-lineage-performance-gate.md); it does not repeat or replace
that historical investigation.

Current status: **DONE. COUNT correctness/performance, grouped API/UI, and native
Tauri application acceptance all passed for CATALOG-007A.** No production database
migration, source revision initialization, ingestion, catalog replacement, deployment,
or Heliotrope integration was performed during this continuation.

## Revision and six persisted scalars

Schema 36 adds only `online_catalog_prepared_counts`. Its primary key is
provider/language/reveal. Each row contains the exact scalar, source revision,
group generation, count-rule version, policy identity, and an integrity digest.
No per-group eligibility masks, arbitrary query cache, FTS, or canonical indexes
are persisted.

The six definitions are the number of distinct public UUID groups with at least
one **same work** satisfying active status, optional hard language
(unrestricted/Korean/Japanese), and either saved visibility or reveal mode.
They apply to empty-text All-scope Latest/Views; sort does not change cardinality.
Bookmarks and manual representative choices do not invalidate these counts.
Hot is never cached.

An explicit setup/publication helper atomically replaces an absent or literal
`legacy` revision with a unique revision once. Existing nonlegacy revisions are
preserved. Reads never initialize it. No-op/replay/checkpoint-only ingestion does
not advance it. A literal `legacy` can never validate a prepared row.

Saved policy identity hashes the canonically ordered actual hidden categories
and blocked tag pairs, excluding timestamps. Reveal rows use a fixed independent
policy marker. The digest also covers the exact value, so a changed positive
scalar is rejected. Missing, stale, malformed or corrupt derived rows return
pending rather than a raw-work or stale-group total.

## Preparation and connections

Startup, actual source publication, catalog replacement, visibility changes and
metadata restore request a coalesced background preparation pass. Group algorithm
or source changes rebuild membership before count preparation. Unchanged startup
reuses persisted scalars. This is eager preparation, not first-search memoization.

The expensive compute phase uses an independent read-only connection and fixed
transaction over main/catalog. It releases both before a fresh publication
transaction rechecks source/generation/policy. A changed context discards the
result. All six rows publish atomically. A failed job records an error and can
recover on a subsequent request; invalid values remain unavailable.

Long COUNT does not acquire the normal Library DB mutex. A shared file guard keeps
its main/catalog handles alive safely; catalog replacement and metadata restore
take the exclusive guard before the DB mutex. SQLite connections close before
their file guards. Restore schedules preparation only after releasing both guards.

## Exact routing

The parsed AST proves mandatory leaves through AND only; OR/NOT do not supply an
anchor. Mandatory ID uses a point lookup and resolves one membership, with the
full effective predicate. `id:X OR love` remains general. ID donor selection no
longer forces the Posted index.

Small bookmarked queries start from canonical provider/work bookmarks and still
require the same work to satisfy every other condition. Mandatory exact tags or
hard languages use `IdxTagsLookup` when bounded candidate cardinality permits.
General title/Boolean/category/uploader/pages queries retain the direct exact
work-first UUID DISTINCT plan.

The measured COUNT seed cap is **65,536**, with a preflight limited to 65,537
index entries. At 65,536, tag seed plus preflight was 125.68 versus 308.97ms with
empty policy, and 787.71 versus 1,393.47ms with hidden 1 / blocked 10. At 120,000,
the latter gain shrank to 14%. This is a conservative material-benefit boundary,
not a claim that a mathematical crossover occurs exactly there. Boundary plans
used a 131,210-work / 1,953,730-tag fixture with the real key layout.

Hot captures the eligible latest Posted by descending first match once, clamps it
to the request clock, and binds one cutoff across COUNT/page/representatives.
Empty eligible sets fall back to the captured clock. Language/visibility remain
part of eligibility; bookmarks/text do not redefine the eligible anchor.

## File-backed real-data measurements

Project-pinned Rust **1.98.0**, bundled SQLite **3.53.2**; 131,210 Works / 1,801,026 Tags; 110,491 groups, largest
104; saved policy hidden 1 / blocked 10; 251 bookmarks. Source and saved metadata
were opened read-only and backed up/copied into disposable libraries. All source
initialization, preparation, restoration and invalidation writes were confined
to those fixtures.

Each median uses one warmup and three timed executions. These are warm SQL
measurements, not OS cold-cache, IPC or native rendering measurements. Older
group benchmarks kept membership in memory; this harness stores it in an actual
temporary library file. Compare the same-file before/after columns directly.

| Policy/query | Same-file generic COUNT | Routed COUNT | Donor page | Representatives |
|---|---:|---:|---:|---:|
| Saved default | 2223.584 | 0.127 | 1.788 | 3.350 |
| Reveal default | 765.433 | 0.111 | 0.706 | 1.133 |
| Saved love | 155.291 | 161.583 | 6.013 | 2.620 |
| Reveal love | 127.389 | 128.367 | 3.836 | 1.387 |
| Saved id:4169932 | 0.161 | 0.105 | 0.667 | 0.482 |
| Reveal id:4169932 | 0.089 | 0.056 | 0.419 | 0.322 |
| Saved female:glasses | 734.041 | 150.103 | 10.195 | 17.691 |
| Reveal female:glasses | 220.064 | 66.501 | 5.009 | 8.413 |

Across 136 combinations, all exact totals matched the direct UUID oracle.
Prepared lookup including validity was 0.080–0.200ms (reference raw reveal
7.929ms). Bookmarked COUNT was 0.278–7.559ms. All ID COUNT/donor medians were below
1ms. Tag-route medians were 4.688–150.103ms; every routed tag case was less than
one third of its generic baseline. The matrix includes all three Hot windows,
three language choices, both scopes/reveal modes, and saved/empty policies.

Four supplemental cases reproduce the previous exact Boolean expression:
`(love OR female:glasses) AND pages>=100`. Saved routed/generic/raw medians were
212.86/230.50/192.62ms; reveal 130.19/124.30/99.17ms. Supplemental love was
155.44/163.38/124.83ms saved and 120.90/123.39/95.59ms reveal. General routing
uses the same direct SQL, so small differences between sequential cohorts are
measurement variation rather than a distinct optimization. Title substring
still scans canonical titles; no FTS5 is recommended by this gate.

| Lifecycle phase | Median ms | Scope |
|---|---:|---|
| First generation | 8216.78 | Four fresh libraries; source backup excluded |
| Six-count compute | 1524.85 | Saved policy; fixed read snapshot |
| Six-count publish | 13.58 | New connection/validation/transaction/commit |
| Unchanged preparation reuse | 42.29 | Entire preparation entry point, no recompute |
| Normal restart reuse | 151.80 | Entire Library open, jobs and validation |
| Source revision invalidation | 6283 | Rebuild plus preparation; fixture revision change |
| Policy invalidation | 850.76 | Recompute after fixture policy changes |
| Generation invalidation | 820.37 | Recompute after fixture generation changes |

The last two invalidation measurements followed the empty-policy matrix; they
must not be presented as fresh saved-policy timings. Actual source/language
changes and split/merge correctness are also covered by focused regression tests.

## Page-plan follow-up

Japanese Bookmarked Views exposed a separate donor-page scan around 650–740ms.
A candidate-first page preserved exact group/work/order results and reduced it
to 1–7ms for 251–512 bookmarks. Applying that page plan to all bookmarks regressed
some broad Views cases, so the COUNT seed cap must not be reused blindly for page.

The verified bounded candidate-page condition is: at most 512 bookmarks,
a hard language, and at most one page of canonical bookmarked works satisfying
that language. A probe limited to page_size+1 proves the rank traversal cannot
fill a page before further predicates even apply. Korean with 251/512 bookmarks
returned 49 and retained its old plan at about 0.15ms probe cost. Japanese returned
19/21, at 0.42/2.68ms probe cost; probe plus candidate page remained far below the
full traversal. No language-name special case or new index is needed.

Final production Japanese Bookmarked Views medians (saved/reveal): planning
0.555/0.529ms, COUNT 2.040/0.628ms, donor page 1.586/1.272ms, representatives
1.149/0.792ms, SQL hydration 0.200/0.208ms. Both returned the exact 19 groups.
Production EXPLAIN confirmed candidate enumeration and no outer rank scan.

## Reproduction and remaining acceptance

```powershell
Set-Location C:\chatgpt\app # selects the repository-pinned Rust toolchain
$env:LAKOMICS_CATALOG_COUNT_GATE_SOURCE = '<explicit read-only library root>'
cargo test --manifest-path src-tauri/Cargo.toml --lib catalog_count_integrated_real_gate -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib catalog_count_fresh_generation_gate -- --ignored --nocapture
```

Run measurements sequentially with no concurrent compiler/benchmark. The
automated `catalog_count_realistic_fixture_production_routes_and_six_scalars`
test separately constructs 131,210 Works / 1,836,940 Tags / 110,491 real groups,
checks scalar parity and route plans, and covers seed boundaries without flaky
wall-clock assertions.

Machine evidence is JSON under TEMP. One expanded page experiment exited after
14 cases without a Rust failure report while build artifacts and frontend
dependencies disappeared from the shared workspace. Its incomplete observations
are not reported as a passing test. Subsequent focused boundary/probe runs passed.

## Page-first delivery and editions

`search_catalog_groups` uses one invocation-local Tauri channel. It emits a
hydrated grouped page before executing exact COUNT, then emits `count` or
`countError`. Admission is bounded to four workers before spawning. The read-only
transaction pins source revision, membership generation, policy, bookmarks and
the single Hot cutoff; the normal Library DB mutex is not held during COUNT.

When a prepared scalar is pending, the page is retained, the old reader is
released, and the request waits up to 30 seconds for already scheduled eager
preparation. A new lookup must match source/generation and saved policy; reveal
ignores policy identity. Failure or context drift produces a count error, never
a stale or raw total. Searches do not initiate preparation themselves.

The browser now uses grouped results, renders on the page event and clears the
previous exact total when a new request starts. A request sequence rejects stale
page/count/error callbacks. Count-dependent pagination waits for an exact total.
Bookmark mutations invalidate pending callbacks and refresh the current request.

Cards use provider/public-group UUID keys and display eligible edition counts.
Editions load only on demand, 40 at a time (server cap 100), with visibility and
language enforced in SQL. Manual selection persists through existing durable
anchor preferences; automatic selection writes null. Historical handles resolve
through their anchor after merge/split. Closing the dialog during a successful
save still refreshes the parent card. Provider-work bookmarks and reading
progress retain their existing identities.

## Native application acceptance — 2026-09-05

The earlier Computer Use `node_repl` path remained unusable after two
`failed to write kernel assets` / Windows path error 3 failures. Final acceptance
used the actual debug Tauri executable instead, with an isolated APPDATA,
LOCALAPPDATA, WebView2 profile and Lakomics library under a disposable repository
fixture. WebView2 remote debugging attached directly to the native Lakomics page;
no browser mock or production library was used.

The fixture contained 105 Korean catalog works: one singleton plus a verified
linear 104-work lineage. Native Manga catalog rendering returned exactly **2**
grouped results. The lineage card exposed **104 editions**, which loaded lazily as
**40 → 80 → 104** rows. Selecting `Native Edition 050` as the representative
updated the parent grouped card, persisted after closing/reopening the editions
dialog, and `Automatic selection` restored `Native Edition 104`. A full app
restart reopened the isolated library and reproduced the same two grouped cards.

The minimal catalog fixture intentionally did not reproduce the unrelated VCK
update/import schema, so catalog updater status is outside this acceptance. The
CATALOG-007A grouped search/count/edition/representative paths all completed over
real Tauri IPC. The active production library was never opened, migrated, or
modified during this check.

CATALOG-007B and Heliotrope remain untouched; no push, merge or deployment occurred.

Backend checkpoint: the pinned-toolchain catalog suite passed **166 tests**, with
8 opt-in benchmarks ignored; the focused backup suite passed **14**. Separate
opt-in gates passed for the 136-case matrix, fresh generation plus four historical
query cases, focused page boundaries/probes, and final production page SQL.

Final frontend verification: **41 tests passed** across client, browser and detail
regressions; `npx tsc --noEmit` and `npm run build` returned exit 0. The migration
suite passed **26 tests**, including v34/v35 preservation. The expanded catalog
run returned exit 1 with **175 passed / 1 failed / 9 ignored**: the new 104-edition
fixture incorrectly formed a branching lineage, which the conservative analyzer
correctly rejected. The fixture was changed to a verified linear chain; production
grouping rules were not loosened. Its focused rerun is recorded below.

Corrected final API rerun: **10 passed / 0 failed**, exit 0 (7.50 seconds).
The broader 175 passing cases were not repeated after this test-fixture-only
correction. Scoped Rust formatting and `git diff --check` passed. Independent
integration review found no remaining actionable blocker after the dialog-save
refresh fix; the isolated native acceptance above closes the final outstanding gate.

Earlier focused commits:

- `ece61cf52a074da2761d3b3c76250b92092c7faa`: one-time source revision.
- `37a8f3e6db4b3d2030647d81045583e06b102a20`: six exact counts and lifecycle.
- `3df3d6eb3892bb2d1617020200ab0353e8999cdc`: restore/read-connection coordination.
- `eed72c4bc3989367a423bf8cf2bcfa6485c88afb`: exact routes and sparse bookmark page.

At the 2026-09-05 native-acceptance closure pass, local and remote branch heads
started synchronized at `8cee4ec`. The isolated acceptance and documentation closure
were performed locally; no deployment or production-data operation was part of the
check. Unrelated worktree files remain outside this acceptance scope.
