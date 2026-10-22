# Desktop navigation latency: implementation and verification

Baseline: `cc19cd4aa74536973d4f17efe7b2dfcabecd9d3c`, Linux checkout,
`_tools/app/`. This is the scoped execution record for the user's navigation
optimization request, not another product backlog. Implement and review inline.

## Plan

- [x] Optimize asset membership queries in `src-tauri/src/library/query.rs`.
  Add the missing classification-to-asset index through migration 70; start
  small scoped pages/counts from membership IDs, retaining existing
  filters, recursive membership, cursor ordering, and exact totals. Reuse the
  existing filter/paging test matrix; add a sparse-folder query-plan check.
- [x] Fix creator aggregation in the same module. Aggregate recent activity
  from the ranked rows once and join by creator key. Verify multiple creators,
  independent activity, cover IDs, empty data, and ordering.
- [x] Separate global date counts from navigation in `src/assets/AssetBrowser.tsx`.
  Reload on data changes, not scope changes. Retain bounded navigation snapshots
  in workspace-owned memory; show stale snapshots without interaction until
  the current query validates them. Verify refresh, failure, and stale requests.
- [x] Reduce cover delay in `src/collections/physical/RenderCache.ts` and
  `PhysicalCover.tsx`: keep the single renderer and cancellation/memory limits,
  yield without a fixed 16 ms per item, and show the source while baking.
  Verify queue cancellation, source replacement, and fallback behavior.
- [x] Reduce repeated date formatting in `src/assets/masonryLayout.ts` while
  preserving layout and local-date grouping. Verify existing geometry tests
  and compare the same synthetic inputs before and after.
- [x] Run focused Rust/frontend checks and TypeScript validation; review the
  combined diff and repeat the isolated measurements. Record actual results
  and distinguish native acceptance from synthetic checks.

## Boundaries

No new dependencies, production-library access, commits,
branches, or deployment. Keep database serialization, filesystem validation,
Windows/Linux media URL handling, render cache budgets, and live-book ownership.
Native GPU/decode and end-to-end click latency remain separate acceptance work.
Migration 70 only adds a lookup index and uses the existing backup/migration path;
it is verified on temporary databases, not applied to an operational library here.
Unmeasured candidates (image HTTP caching, inference concurrency, generic tab
keep-alive) are not included in this implementation.

## Baseline evidence

Current SQL and all 69 migrations, Python SQLite 3.46.1, in-memory synthetic
data, median of 3: a 20-image folder among 300,000 assets took 56.90 ms for
the page, 52.92 ms for the exact count; global date buckets took 134.64 ms.
Creator query, one run: 50,000 assets / 500 creators took 2,417 ms and returned
only one row. A separate 3-creator fixture also returned one row.

Actual TypeScript RenderCache with synthetic immediate producers: 16 results
completed in 264 ms; delaying the first producer by 300 ms delayed completion
to 561 ms. Actual masonry layout, 5-run median: 10,000 rows 39.28 ms,
50,000 rows 205.16 ms. These are not native click-to-image measurements.

## Results

Implemented and reviewed inline on 2026-09-12. No independent-agent review.

### Query plan decision

Adding an `IN` predicate alone still selected the library-wide status index.
Forcing membership-first lookup for every scope made a 100,000-member first
page slower (0.26 ms to 195 ms). The final implementation probes at most 1,001
membership links: scopes with at most 1,000 links use deduplicated member IDs
and primary-key lookup; larger scopes keep the existing ordered scan. Recursive
scope discovery still traverses the descendants. The bound applies to links,
not hierarchy nodes. Duplicate descendant memberships remain deduplicated.

The native SQLite query-plan regression confirms use of
`asset_classifications_by_classification` and the assets primary-key index for
the small scope. Another regression confirms that broad scopes retain the
original statement. The existing filter, sort, recursive scope, cursor,
anchor, before-page, and exact-total tests pass.

### Comparable synthetic measurements

Python SQLite 3.46.1, in-memory, median of 3. Each data size uses the same DB
before/after migration 70; old SQL is read from the baseline commit. The after
measurement includes the bounded probe and mirrors the production SQL rewrite.
Fixtures use unique IDs, equal collected timestamps, a 20-member folder and a
second folder containing every asset. This has more membership links than the
initial baseline above; compare within this table, not across fixtures.

| Fixture / operation | Before | After |
| --- | ---: | ---: |
| 100k assets, 20-member page | 47.848 ms | 0.130 ms |
| 100k assets, 20-member count | 46.178 ms | 0.054 ms |
| 300k assets, 20-member page | 145.175 ms | 0.145 ms |
| 300k assets, 20-member count | 148.531 ms | 0.053 ms |
| 300k assets, full-folder page | 0.308 ms | 0.463 ms |
| 300k assets, full-folder count | 142.975 ms | 136.649 ms |
| 300k assets, unscoped page | 0.224 ms | 0.257 ms |
| 300k assets, unscoped count | 24.197 ms | 26.463 ms |
| 50k assets / 500 creators | 2,403.030 ms | 147.330 ms |

The old creator query incorrectly returned one creator; the corrected query
returns all 500. Empty data and independent recent activity are also covered.
Exact counts for broad/global scopes remain proportional to the matching data;
the small differences in those timings are not claimed as improvements.

Actual TypeScript functions loaded from baseline/current source in one Node
process, using the same generated inputs:

| Operation | Before | After |
| --- | ---: | ---: |
| RenderCache, 16 immediate producers, median of 3 | 260.39 ms | 18.48 ms |
| Masonry, 10k items with date grouping, median of 5 | 65.43 ms | 10.82 ms |
| Masonry, 50k items with date grouping, median of 5 | 490.70 ms | 48.18 ms |

The cover benchmark measures scheduling with synthetic blobs, not image decode,
WebGL, or PNG encoding. The same renderer remains serial. A slow source can
still delay baked covers behind it, but visible cards now show their scoped
source image while waiting. Native browser timer scheduling can differ from
Node. Masonry inputs use widths `800 + i % 400`, height 1200, minute-spaced
timestamps, viewport 1400, target width 180, gap 8, captions off, dates on.
Absolute timings vary with host load; no production latency claim is made.

The actual Rust `Library::list_assets` ignored benchmark (temporary on-disk DB,
debug build, 50k assets, single run) returned 20 folder items and exact total 20
in 5.19 ms. Unscoped listing took 34.22 ms; 500 creators took 521.27 ms.
These include connection/command work and are not directly comparable to the
in-memory Python numbers. Reproduce from `_tools/app/src-tauri` with:

```sh
cargo test --lib navigation_query_benchmark -- --ignored --nocapture
```

### UI behavior and verification

- Global date buckets no longer reload on folder/sort/filter changes. They
  reload on data refresh and component remount. Tests verify folder navigation
  and refresh behavior.
- Workspace memory retains at most 8 navigation snapshots, each capped at 200
  rows. A return snapshot is display-only and inert until the current response
  arrives. Current-query failures hide stale results. Library changes remount
  the workspace and discard this memory.
- Cover previews and baking share the same scope/revision URL and CORS mode.
  Tests cover source replacement, late results, failure, and neutral game shells.
  Cache cancellation, budgets, and single-renderer ownership remain intact.
- Rust query tests: 31 passed, 1 intentionally ignored benchmark. DB migration
  and backup tests: 44 passed. The benchmark was separately executed and passed.
- Frontend targeted runs passed: AssetBrowser, App, PhysicalCover,
  CompleteCoverViewer, CollectionExhibition, RenderCache, and masonryLayout.
  The final PhysicalCover run passed all 3 tests after the neutral-shell review.
- TypeScript `tsc --noEmit` passed. The combined diff passed `git diff --check`.

### Remaining acceptance limits

No operational library was opened, migrated, indexed, or changed. Native Linux
Tauri interactions and Windows-native acceptance were not run. Browser/frontend
tests do not establish filesystem command latency, actual GPU/decode behavior,
or click-to-image time. This implementation preserves the existing cross-platform
URL and SQLite paths, but native verification is still needed for those claims.
AI inference loading, thumbnail HTTP caching, large-scope exact counts, and
background database-lock contention remain outside this measured change.
