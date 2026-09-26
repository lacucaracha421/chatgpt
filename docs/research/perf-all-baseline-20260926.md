# PERF-ALL-001 baseline — 2026-09-26

Phase 1 of `PERF-ALL-001`: measure and rank, no product behavior changed. Measured at `pre-perf` (`699d0e4`, Android 0.8.27) by three Opus workers (Codex was unavailable: 401 on every request) plus controller checks on the tablet. Every number states its method; code traces and estimates are marked as such.

## Combined ranking (controller)

Ordered by user-visible gain per risk. Details, gate metrics and files are in the sections below.

| # | Candidate | Where | Evidence | Size / risk |
|---|---|---|---|---|
| 1 | Fix the `list_collections` query plan (rewrite, and/or `ANALYZE`) | PC | 349 ms release / 1.92 s dev → 3–5 ms on a snapshot copy; also drives the sidebar refresh | S / low |
| 2 | Stop idle whole-app re-renders (stable Vault and character status updates) | PC | ~28 whole-tree commits/min idle → 0 in the harness | S / low |
| 3 | Move synchronous DB commands off the main thread; stop reads queuing behind the single DB lock | PC | a 3 ms grid page waited 334 ms / 1.97 s behind a sidebar refresh; 97 sync commands | M–L / medium |
| 4 | Fold idle pollers into `/v1/sync/status` cursors (PC-POLL-002, BIND-POLL-001), gate the exchange receiver | PC + server + tablet | ~190 idle requests / 15 min → ~20–35 (code estimate); bind pickup 0–70 s | L / medium |
| 5 | Collections covers: retry a failed cover while visible; a full native queue waits instead of failing; batch artwork tickets | Tablet + server | code trace (medium-high confidence); not reproduced on device with a warm cache | S–M / low |
| 6 | Tablet idle CPU/network: no full replica parse on the 15 s trash poll; skip the Picker walk when unchanged; keep warm-up progress on errors | Tablet | ~300 replica parses/h, ~94 requests per resume walk (code trace + JVM microbench) | S–M / low |
| 7 | Remove the focus relay and own-echo "changes" that reload everything | PC | 4 whole-tree renders + 15 native calls per window focus | S–M / medium |
| 8 | Reuse DB connections with a larger page cache; skip grid recounts on pages 2+ | PC | 1.37 ms per call schema parse; filtered pages 13–20 ms | M / medium |
| 9 | Character review pages and the target-list N+1 | PC | 165 ms–600 ms release; 884 statements for 56 targets | M / medium |
| 10 | Optimize SQLite in the dev profile (only if the dev app is used daily) | PC dev | SQL paths 2.5–5.5× slower in dev (estimate) | XS / low |

## Tablet measurements (controller, 2026-09-26 08:40 KST, Galaxy Tab S11, 0.8.27)

- Cold start (`am start -W`): TotalTime 653 ms, 302 ms, 392 ms.
- Collections right after a force-stop, and right after `adb install -r` of the same APK: every first-screen cover visible within 3–5 s; scrolled rows and the 만화 tab also complete; 0 `status=rejected`, max `queued=1`. The cold-start blank covers were not reproduced — the covers were already in the disk cache. The next observation to capture is the placeholder text on a blank cover ("이미지를 불러오지 못했습니다" = failed and never retried; "표지" = still queued).


---

### PERF-ALL-001 phase 1 — PC backend (Rust) and lightweight mode

Owner: brief items 1 (PC backend, `_tools/app/src-tauri`) and 6 (lightweight processing mode).
Baseline commit: `699d0e4` (clean `main`). Only file changed: `_tools/app/src-tauri/src/bin/perf_probe.rs` (measurement-only binary; no product code, migrations, manifests or tests touched).

### 1. Method

#### Probe (`src/bin/perf_probe.rs`, rewritten)

```
cargo build --release --bin perf_probe      # and plain `cargo build --bin perf_probe` for the dev profile
target/release/perf_probe --library "<library root>" --snapshot-dir <scratch dir> \
    --iterations 25 --with-catalog --idle-ticks [--keep-snapshot] [--only <substr>] [--skip <substr>]
```

- **Snapshot, never the live DB.** `library.sqlite`, `catalogs/kdata.db` (+ `suggestions.json`, `tag-ko.json`) and the `video-media/` tree are copied with plain read-only file reads into a directory outside the library. The probe refuses a snapshot directory inside the library and refuses a source with a non-empty `-wal` (app running). SQLite never opens the source: a read-only SQLite open of a WAL database may create `-wal`/`-shm` next to it, which the old probe did (it also hard-linked `video-media`, which fails across filesystems and shares inodes with the library).
- **Network isolation.** Before `Library::open`, the snapshot's `library_settings.cloud_api_base_url` is set to `http://127.0.0.1:9` (closed local port). The only network-capable path measured (idle replication cycle) is run only after a conservative query confirms nothing is eligible, so it returns before credentials or network.
- **Write check.** A fingerprint (name, size, mtime) of every library-root entry and every `catalogs/*` file is compared before/after: `library_root_unchanged: true` in every run. Separately, two runs under `strace -f -e trace=openat,creat,unlink*,rename*,mkdir*,link*,symlink*,truncate,ftruncate,copy_file_range,sendfile` showed **only `O_RDONLY` opens** under the library path (13,187 read-only opens incl. the `video-media` copy; zero write/create/rename/unlink).
- **SQL accounting.** An SQLite auto-extension (`sqlite3_auto_extension`) is registered before any connection opens, so every connection the Library opens is counted. On traced calls each connection gets `sqlite3_trace_v2` (STMT/PROFILE/ROW/CLOSE): statements, write statements (`sqlite3_stmt_readonly = 0`), rows changed (`sqlite3_total_changes`), rows returned, VM steps / full-scan steps / sorts / autoindexes (`sqlite3_stmt_status`), page-cache misses/hits (`SQLITE_DBSTATUS_CACHE_MISS/HIT` at close), and per-statement text for paths with median ≥ 20 ms. Timed iterations run with the trace hook **off**.
- **Per path:** 1 cold call, N timed calls (release N=25, debug N=15; contention cases capped at 8), then 2 traced calls; `counts stable` = both traced calls agree on statements, VM steps, connections and page misses. p95 is nearest-rank.
- IDs are picked from the data: largest classification by subtree total (“게임”, 5,837 assets, 428 direct), median classification, largest album/collection, top creator, the series with most ready character targets.

#### Environment

Linux, AMD Ryzen 5 5625U (6C/12T), 12 GB RAM, AC power, `balanced` profile, load < 1.5 during runs (other phase-1 workers were idle or on light work; runs were never overlapped with my own builds). Snapshot on tmpfs (`/tmp`), so OS I/O is RAM-speed; SQLite page-cache misses are still real work (page copies + parsing). Library: 9,147 normal assets (9,300 rows), 58 classification entries, 3 albums, 343 collections, 56 character targets / 18 series, 153 trashed, catalog 131,748 works / 1.8 M tags. `library.sqlite` 784 MB — **545 MB of it is `character_autotag_predictions`** (32 k overflow pages); `assets` is 6 MB. SQLite 3.53.2 (bundled). Schema: 395 objects.

Builds: **release** = shipped app. **debug** = `npm run tauri -- dev` (the user often runs the dev app). The dev profile compiles the bundled SQLite C code at `-O0` (Cargo.toml only raises `opt-level` for image crates), which is why debug SQL-heavy paths are 2.5–5.5× slower.

Reproducibility: two full debug runs agree within 3 % on every non-contention path; two release runs (25 iterations) agree within 6.6 % worst case (`date_buckets_365d`). A first validation run (debug, 3 iterations, before the `video-media` copy existed) was 2–10× slower on page-miss-heavy paths for an unexplained reason and is excluded; its snapshot also lacked `video-media`, which made startup requeue all 447 videos (see §3).

Raw outputs (scratchpad `perf/rust/`): `release-run2.txt`, `debug-run3.txt` (tables below), `debug-run.txt`, `debug-run2.txt`, `release-run1-killed-in-contention.txt`, `release-whatif-analyze.txt`, `bench-*.log`, `strace-*.txt`.

### 2. Measured table

Method for every row: `perf_probe` on the snapshot, wall-clock around the Library call (the Tauri IPC/serialization hop and `spawn_blocking` scheduling are **not** included). Counters are per call (deterministic, `stable = yes` unless noted). Confidence: **high** for release/debug medians of rows marked stable (reproduced within ±7 % across runs); absolute ms only apply to this machine.

| group | path (what the UI does) | result | release median / p95 ms | debug median / p95 ms | conns | SQL stmts | write stmts (rows changed) | VM steps | page misses |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| connection | open only (`db::open_database`, no schema) | – | 0.05 / 0.06 | 0.07 / 0.09 | 1 | 1 | 0 | 5 | 0 |
| connection | open + first statement (loads 395-object schema) — fixed floor of **every** Library call | – | 1.37 / 2.09 | 3.82 / 5.84 | 1 | 2 | 0 | 13 | 32 |
| sidebar | `list_classifications` (tree + subtree totals) | 58 | 7.43 / 7.61 | 28.36 / 29.01 | 1 | 5 | 0 | 409,158 | 380 |
| sidebar | `list_albums` | 3 | 3.62 / 3.73 | 14.57 / 15.00 | 1 | 2 | 0 | 137,310 | 169 |
| sidebar | **`list_collections`** (Collections/Works list; *sync command → main thread*) | 343 | **348.70 / 360.11** | **1,924 / 1,938** | 1 | 2 | 0 | **31,433,423** | 491 |
| sidebar | `character_sidebar_counts` | – | 152.33 / 155.28 | 589.12 / 603.85 | 1 | 66 | 0 | 6,169,572 | 9,617 |
| sidebar | App `refreshSidebar` (classifications + albums + collections) | – | **360.57 / 370.77** | **1,963 / 1,970** | 3 | 9 | 0 | 31,979,891 | 1,040 |
| sidebar | `get_library_statistics` | – | 55.84 / 57.48 | 131.75 / 134.34 | 1 | 13 | 0 | 999,807 | 21,844 |
| grid | root, newest, page 1 (100) | 100 / total 9,147 | 2.92 / 2.99 | 10.98 / 11.72 | 1 | 3 | 0 | 132,959 | 197 |
| grid | root, oldest | 100 | 3.04 / 3.09 | 11.04 / 11.17 | 1 | 3 | 0 | 132,965 | 288 |
| grid | root, favorites sort | 100 | 16.50 / 17.90 | 40.00 / 41.56 | 1 | 3 | 0 | 414,907 | 7,150 |
| grid | root, random sort | 100 | 17.19 / 18.15 | 40.70 / 41.56 | 1 | 3 | 0 | 434,768 | 7,151 |
| grid | root, images filter | 100 / 8,703 | 12.96 / 13.79 | 26.04 / 26.92 | 1 | 3 | 0 | 166,974 | 6,999 |
| grid | root, videos filter | 100 / 444 | 13.17 / 14.57 | 25.40 / 25.82 | 1 | 3 | 0 | 114,927 | 7,183 |
| grid | root, favorite-only | 0 | 19.41 / 20.76 | 36.29 / 37.94 | 1 | 3 | 0 | 146,429 | 12,416 |
| grid | root, unclassified-only | 0 | 9.31 / 9.65 | 33.36 / 34.97 | 1 | 3 | 0 | 402,545 | 603 |
| grid | root, landscape filter | 100 / 2,085 | 12.80 / 13.62 | 26.60 / 27.23 | 1 | 3 | 0 | 163,235 | 7,065 |
| grid | badge: unsorted count (limit 1) | total 0 | 9.05 / 9.39 | 33.44 / 34.69 | 1 | 3 | 0 | 402,545 | 603 |
| grid | largest classification, recursive | 100 / 5,837 | 6.98 / 7.20 | 26.54 / 26.68 | 1 | 6 | 0 | 318,481 | 460 |
| grid | largest classification, direct | 100 / 428 | 5.16 / 5.59 | 12.15 / 12.65 | 1 | 6 | 0 | 52,648 | 1,345 |
| grid | largest classification, images | 100 / 5,670 | 18.06 / 18.54 | 42.40 / 43.30 | 1 | 6 | 0 | 345,237 | 7,474 |
| grid | median classification, recursive | 74 | 2.78 / 2.82 | 7.15 / 7.19 | 1 | 6 | 0 | 12,694 | 261 |
| grid | largest album | 17 | 2.15 / 2.17 | 5.54 / 5.83 | 1 | 6 | 0 | 3,101 | 82 |
| grid | root newest page 2 / 10 / 30 (keyset) | 100 | 2.93 / 3.04 / 3.44 | 11.00 / 11.41 / 12.47 | 1 | 3 | 0 | 134 k / 140 k / 156 k | 202 / 234 / 373 |
| grid | `list_asset_creators` (root) | 2,344 | 33.58 / 34.44 | 99.86 / 100.88 | 1 | 2 | 0 | 1,155,156 | 7,022 |
| grid | top creator's assets | 43 | 20.34 / 21.58 | 39.42 / 41.31 | 1 | 3 | 0 | 195,896 | 12,450 |
| grid | date buckets, 365 days | 286 | 4.10 / 4.18 | 13.88 / 13.96 | 1 | 2 | 0 | 139,449 | 246 |
| grid | revisit slate (existing) | – | 1.49 / 1.54 | 4.06 / 4.18 | 1 | 5 | 0 | 265 | 42 |
| viewer | `get_asset` | – | 1.46 / 1.52 | 4.01 / 4.14 | 1 | 2 | 0 | 48 | 42 |
| viewer | `get_asset_classifications` | 1 | 3.81 / 3.90 | 11.64 / 12.13 | 1 | 2 | 0 | 45,984 | 379 |
| viewer | `get_asset_albums` / `get_asset_collections` / character relations | – | 1.47–1.50 | 3.97–4.02 | 1 | 2–3 | 0 | 32–36 | 36–40 |
| viewer | `list_source_group_assets` | 1 | 10.01 / 10.63 | 19.18 / 19.49 | 1 | 3 | 0 | 54,942 | 5,559 |
| characters | `list_character_targets` | 56 | 41.12 / 42.20 | 94.08 / 95.63 | 1 | **884** | 0 | 74,901 | 1,217 |
| characters | `character_review_pending_map` | – | 40.40 / 42.02 | 92.19 / 93.38 | 1 | **884** | 0 | 74,901 | 1,217 |
| characters | `character_series` | 18 | 1.47 / 1.52 | 4.00 / 4.02 | 1 | 2 | 0 | 266 | 34 |
| characters | `character_incremental_status` (UI polls 5 s idle / 1 s active) | – | 2.43 / 2.49 | 6.38 / 6.50 | 1 | 4 | 0 | 23,140 | 549 |
| characters | series gallery `browse_character_assets` all (busiest series, 5 targets) | 100 / 512 | 11.95 / 12.29 | 41.07 / 41.95 | 2 | 5 | 0 | 360,717 | 714 |
| characters | series gallery, unclassified / needs review | 100 / 186; 27 | 22.95 / 25.35 | 80.92 / 91.35 | 2 | 5 | 0 | 868 k / 1.06 M | 1,253 / 962 |
| characters | target gallery | 14 | 8.03 / 8.14 | 24.62 / 25.21 | 3 | 21 | 0 | 140,350 | 585 |
| characters | review page, one target, filter all / pending (40 rows) | 40 | **165.20 / 166.86** | **318.36 / 320.93** | 3 | 24 | 0 | 1,104,018 | **92,056** |
| characters | review page, whole series, recommended | 0 | **599.89 / 604.62** | **1,425 / 1,461** | 5 | 900 | 0 | 2,738,515 | **173,480** |
| characters | shadow (S36) review page | 0 | 0.01 (returns before any SQL in the snapshot) | 0.02 | 0 | 0 | 0 | 0 | 0 |
| review | similarity badge (limit 1) / page 50 / video (limit 1) / inbound status | 0 items | 1.41–1.48 | 3.89–4.05 | 1 | 2–6 | 0 | 16–45 | 33–34 |
| trash | badge (limit 1) / page 100 | 1 / 100 of 153 | 1.82 / 2.26 | 4.76 / 6.44 | 1 | 7 | 0 | 3,814 / 8,368 | 193 / 197 |
| collections | `list_release_inbox` (PC ReleaseInbox polls 5 s while shown) | 0 | 1.42 / 1.47 | 3.98 / 4.08 | 1 | 2 | 0 | 37 | 33 |
| collections | `collection_update_status` mangadex / kakao | – | 2.25 / 1.51 | 5.07 / 4.11 | 1 | 3 | 0 | 1,835 / 315 | 695 / 55 |
| catalog | `catalog_status` | – | 2.19 / 2.23 | 5.08 / 5.18 | 3 | 9 | 0 | 92 | 351 |
| catalog | **`search_catalog_groups`** (what the UI calls), empty, latest | – | 5.73 / 5.95 | 18.90 / 19.94 | 1 | 18 | 0 | 134,956 | 618 |
| catalog | `search_catalog_groups`, text "love" | – | 63.95 / 65.53 | 177.16 / 178.94 | 1 | 14 | 0 | 1,812,530 | 19,715 |
| catalog | `search_catalog_groups`, empty, views | – | 5.10 / 5.20 | 14.82 / 15.48 | 1 | 18 | 0 | 81,723 | 716 |
| catalog | legacy `search_online_catalog`, empty latest / views / "love" | total 114,175 | 236 / 592 / 51 | 988 / 1,446 / 156 | 1 | 6 | 0 | 11.0 M / 11.0 M / 1.7 M | 22,740 / 272,542 / 15,665 |
| catalog | `suggest_online_catalog` (cached after first 154 ms) | 10 | 3.76 / 3.83 | 6.04 / 6.27 | 0 | 0 | 0 | 0 | 0 |
| idle | `cloud_backfill_progress` (JS supervisor: 10 s idle, 1.5 s while running, 60 s hidden) | – | 34.35 / 35.24 | 77.70 / 79.64 | 1 | 13 | 0 | 514,870 | 12,848 |
| idle | replication cycle, nothing eligible (native every **2 s**, 10 s in light mode) | – | 10.84 / 11.31 | 29.35 / 30.44 | **4** | 8 | 2 (0) | 93,259 | 1,449 |
| contention | grid page 1 while another thread re-reads the tree every 2 ms | – | 10.39 / 10.85 | 38.98 / 39.99 | – | – | – | – | – (not stable) |
| contention | **grid page 1 requested 5 ms after `refreshSidebar` starts** | – | **334.30 / 337.16** | **1,971 / 1,975** | 4 | 12 | 0 | 32,112,850 | 1,237 |

JSON payload sizes (serde of the returned value, a proxy for IPC bytes): grid page ≈ 50–64 KB/100 items, `list_collections` 355 KB, `list_asset_creators` 686 KB, `list_character_targets` 137 KB.

#### Startup (single sample each, low–medium confidence)

- `Library::open` on the snapshot: **27 ms release / 60 ms debug**, 11 connections, 27 statements, 1,022 page misses; then background threads (work-artwork thumbnail backfill, catalog preparation check) settle in ~1.25 s wall with 30–40 ms CPU, 3–4 more connections.
- Without `video-media` present, `requeue_interrupted_video_preparation` marks every ready video incomplete and runs **447 × (connection + transaction + 2 UPDATEs)**: open took 1.9–4.6 s in debug. Not a production path (derivatives exist), but it shows the per-item connection/transaction pattern at startup costs ~4 ms per item in debug.

#### Heaviest statements (from traced calls; statement text in `release-run2.txt` §“Heaviest statements”)

- **`list_collections`**: one statement; correlated subqueries 2 (fallback cover) and 7 (asset count) are planned as `SEARCH asset USING COVERING INDEX assets_by_trash_age (status=?)` + probe `collection_assets(collection_id, asset_id)` — i.e. every collection walks all 9,147 normal assets twice (343 × 9,147 × 2 ≈ 6.3 M probes, 31 M VM steps). There is **no `sqlite_stat1`** (the library was never `ANALYZE`d), so the planner guesses. Forcing `collection_assets` to drive (`CROSS JOIN`) returns identical rows in **3.1 ms instead of 400 ms** (Python sqlite 3.46 on the same snapshot).
- **`character_sidebar_counts`**: 56 recursive-scope queries + 7 recursive COUNTs (66 statements, 6.2 M VM steps); same `assets`-drives-the-join pattern.
- **Character review pages**: a recursive-scope query plus `character_autotag_evidence JOIN character_autotag_predictions` reading `result_json` from the 545 MB predictions table (overflow pages): 92 k page misses for one target's 40-row page, 173 k for the series-wide recommended page (which also runs the 884-statement target listing).
- **`list_character_targets` / `character_review_pending_map`**: N+1 — 884 statements for 56 targets (per target: references, learned references JOIN assets, regions, target row, and ~12 recursive scope queries). `character_review_pending_map` calls it.
- **Grid filters/sorts other than plain newest/oldest**: `list_assets` always runs a catch-all `COUNT(*)` (`?11 IS NULL OR …` predicates) for `totalCount` on every page, including pages 2..n; with filters it walks the `(status, collected_at)` index and looks up each asset row → ~7,000 page misses per call, on a cold SQLite cache because every call opens a new connection.
- **`cloud_backfill_progress`**: 6 separate `COUNT(*) FROM cloud_sync_queue JOIN assets …` + 1 `EXISTS` (34 ms, 12.8 k page misses) every 10 s while the window is open.
- **Legacy `search_online_catalog`** (not the path the UI uses): full `COUNT(*)` over Works with per-work visibility subqueries (0.24–0.59 s release). `search_catalog_groups` (UI path) serves counts from prepared data and is 5–64 ms.

### 3. What-if: statistics only (`ANALYZE` on a snapshot copy)

`ANALYZE` (143 ms, 175 `sqlite_stat1` rows) on a copy of the snapshot, then the same release probe (15 iterations). Paths that moved > 20 % (none got slower):

| path | baseline median ms | after ANALYZE | VM steps | page misses |
|---|---:|---:|---|---|
| `list_collections` | 348.70 | **5.33** | 31.4 M → 59.9 k | 491 → 362 |
| `refreshSidebar` | 360.57 | **12.57** | 32.0 M → 396 k | 1,040 → 847 |
| `character_sidebar_counts` | 152.33 | 85.45 | 6.2 M → 2.8 M | 9,617 → 8,600 |
| `list_albums` | 3.62 | 1.56 | 137 k → 318 | 169 → 100 |
| `get_asset_classifications` | 3.81 | 1.93 | 46 k → 1.6 k | 379 → 300 |

Confidence high for the direction and size on this data; a product change would still need the plan checked for the other ~500 statements (`PRAGMA optimize` / `ANALYZE` changes plans globally).

### 4. Existing `#[ignore]` benchmarks (debug test profile, `cargo test --lib <name> -- --ignored --nocapture`)

Real-data tests were pointed at a **snapshot copy** (`LAKOMICS_CATALOG_BENCH_ROOT=<scratch copy>`), never the library. All passed.

| test | result (debug build) | wall |
|---|---|---:|
| `query_navigation_tests::navigation_query_benchmark` (50 k synthetic assets) | all 100 rows: 98 ms; sparse folder: 5.8 ms; creators (500): **451 ms** | 3.6 s |
| `character_reference_refresh_bench::reference_refresh_fixture_metrics` | delta refresh 0.47–1.16 ms vs full 0.55–1.70 ms (2,000 assets); batch20 1.16 ms vs sequential20 6.30 ms; 0 old recomparisons | 0.4 s |
| `character_sources::benchmark_prepared_reference_lifecycle` | before 314.7 ms/asset (3.2/s) → after 8.2 ms/asset (121.9/s) | 7.1 s |
| `similarity::candidate_search_scans_fifty_thousand_hashes` | 50 k hash scan 261 ms | 9.3 s |
| `catalog_performance_tests::catalog_real_query_measurements` (real catalog copy) | empty-policy count 15.7 ms; "love" count 105 ms (after) vs 318 ms (before); worst legacy count/page 1.0–1.5 s; id lookup 0.01 ms | 67 s |
| `catalog_performance_tests::catalog_large_fixture_empty_policy…` | old COUNT+page 2.63 s vs real search 22.8 ms | 15.6 s |
| `catalog_group_performance_tests::catalog_group_real_query_measurements` | baseline counts 16–1,360 ms depending on policy/sort; grouped counts 16–26 ms; text/tag 205–256 ms | 100 s |
| `catalog_group_performance_tests::catalog_group_realistic_fixture…` | pass (assertions only) | 26.8 s |
| `catalog_groups::catalog_groups_real_materializer_and_query_gate` | materialize **4,410 ms**, unchanged re-check 0.13 ms | 14.2 s |
| `catalog_duplicate_sync_tests::catalog_duplicate_real_catalog_scan_gate` | materialize 4,403 ms, **scan 7,006 ms** (97 found, 0 confident), rescan 7,021 ms | 19.2 s |
| `catalog_count_fixture_tests::catalog_count_realistic_fixture…` | pass (assertions only) | 26.0 s |

Not run: `catalog_count_gate_tests` (5 explicit-source gates; correctness gates for count work, long), native FFmpeg/Python/keyring/network/operator tests (not benchmarks or need external runtimes). Side effect: `catalog_group_real_query_measurements` writes `/tmp/lakomics-catalog-group-performance.json` (moved to scratchpad `perf/rust/`).

### 5. Idle backend cost (local work only)

Measured per-tick cost × cadence from code. Release / debug CPU per minute, window open and idle, normal mode:

| source | cadence (code) | per tick | per minute (release / debug) |
|---|---|---|---:|
| replication cycle (`workload.rs` native timer → `run_cloud_backfill_cycle`) | 2 s (10 s light) | 4 connections, 8 stmts incl. 2 no-op UPDATEs, 1,449 page misses | ~325 ms / ~880 ms |
| `cloud_backfill_progress` (JS `useCloudBackfillSupervisor`) | 10 s idle, 1.5 s while running, 60 s hidden/light | 13 stmts, 12.8 k page misses | ~206 ms / ~466 ms |
| `character_incremental_status` (JS) | 5 s idle, 1 s active, 60 s hidden/light | 4 stmts | ~29 ms / ~77 ms |
| `similarity_review_inbound_status` (JS) | 10 s (60 s light) | 2 stmts | ~8 ms / ~23 ms |
| **measured subtotal** | | | **~0.57 s / ~1.45 s CPU per minute (≈1 % / 2.4 % of one core)** |

Not measured (network lanes, unsafe on a snapshot): the 10 s mobile-publication tick (7 lanes, each ≥ 1 connection for `cloud_sync_config` plus lane state reads before its own throttle), the authority pass (5–60 s backoff, 20 s floor in light mode), the file-exchange receiver (5 s shown / 15 s hidden). Estimate for those lanes' local part: ≥ 7–15 connection opens per 10 s → ≥ 10–20 ms release / 30–60 ms debug per tick from schema loading alone (low confidence, from the measured 1.37 / 3.82 ms per connection). Every Library call opens a new connection (536 `.connection()` call sites), so the SQLite page cache is always cold and the 395-object schema is re-parsed every time.

### 6. Gaps in the probe

- Character screens: the snapshot has no character reference files, so all 56 targets read as not `ready` (0 ready); the review pages still ran their full queries (rows returned), but `recommended` pages returned 0 rows and the S36 shadow review page returned before any SQL (machine-local S36 settings are not in the snapshot). Treat character numbers as medium confidence / lower bounds.
- `authority_sync_health`, `classification_sync_status`, `album_sync_status`, `run_saved_mobile_publications` are `pub(crate)` and cannot be called from the bin; `list_collection_covers` reads the machine-specific source folder (not in the snapshot).
- No IPC/serialization or `spawn_blocking` scheduling time; no native Tauri window. The main-thread impact of sync commands is inferred from Tauri's documented behavior (commands without `async` run on the main thread), not measured in a window.
- Contention: std `Mutex` is not FIFO. A gap-free loop holding the DB mutex starved a grid request for minutes (debug: median 3.8–4.0 s, p95 51–208 s; release run killed after > 20 min for < 25 samples). The default probe now uses a 2 ms gap. Whether any production loop is gap-free (the character engine’s loop is the closest candidate) is not verified.

### 7. Lightweight processing mode (item 6)

Gate API (`src/workload.rs`): `is_restricted()` = lightweight on **or** within 180 s after leaving it; `is_lightweight()` = the setting only; `is_hidden()` = window hidden. JS side: `useWorkloadProfile().restricted`, `workloadPollDelay(normal)` = max(60 s, normal) when restricted **or hidden**.

**New since `05b18b6`** marked ★. “Gated” = does less or nothing while restricted.

| background job (owner) | normal cadence | lightweight behavior | gate location | status |
|---|---|---|---|---|
| ★ Authority pass (albums, classifications, bookmarks) — native `workload.rs` timer, `library/authority_pass.rs` | 5 → 15 → 30 → 60 s backoff; immediate on focus/local write | floor 20 s between passes | `AuthoritySchedule::finished(restricted)` | gated (throttled) |
| Asset lane (materialize media) — native, after each pass | per pass | materializes 5 instead of 25 per pass | `run_asset_lane(status, restricted)` → `pending_materializations` | gated (throttled) |
| Replication / new-ingest upload (`run_cloud_backfill_cycle`) — native | every 2 s | every 10 s, concurrency 1, new ingests only, videos prepared only if an upload waits | `workload.rs:615`, `cloud/backfill.rs:25,46,560` | gated (by design keeps mobile-critical uploads) |
| Mobile publication tick (`run_saved_mobile_publications`, 7 lanes) — native | every 10 s, visible and hidden | **not gated**; only the `collections` republish defers ≤ 30 min after a mobile edit | `cloud/auto_publication.rs` (`is_lightweight`) | by design (mobile-critical) |
| ★ lane `catalogDuplicates` (duplicate-edition auto-merge; scan 7 s + materialize 4.4 s in debug) | when due, via the 10 s tick | skipped | `catalog_duplicate_sync.rs:811` | gated |
| ★ lane `releases` (manga release notifications) | receive ≤ 1/min, upload when due | **not gated** | `collection_release_sync.rs:188` | ungated (cheap, network) |
| ★ lane `bindings` (tablet MangaDex/Kakao connect requests) | ≤ 1/min (`POLL_SECONDS = 60` — also the cause of BIND-POLL-001) | **not gated** | `collection_binding_sync.rs:51,379` | ungated |
| lanes `characters` / `similarity` / `visibility` / `collections` receives | ≤ 1/min for personal edits; per lane throttles | not gated (collections deferral only) | `cloud/auto_publication.rs` | by design |
| ★ File exchange receiver (`exchange/mod.rs`) — native thread, own conditional `/v1/sync/status` read | **5 s shown / 15 s hidden** | **not gated** (only hidden/visible) | `exchange::poll_interval` | **ungated — candidate** |
| ★ File exchange sender | on demand | not gated | – | on demand |
| Character engine (incremental loop) | continuous while jobs exist | fresh jobs only; no reconsideration/augmentation/shadow; idle Python worker released; 500 ms idle sleeps | `character_incremental.rs:228,296–354,590,653`, `character_autotag.rs:598` | gated |
| Similarity (PDQ) indexing | on ingest/batch | skipped per asset | `similarity.rs:552` | gated |
| Video preparation (FFmpeg) | on demand/batch | stops (except uploads waiting on a video) | `video_media.rs:249`, backfill `prepare_videos` | gated |
| Catalog count preparation | at open / after changes | skipped; re-requested when leaving light mode | `catalog_preparation.rs:69,117`, `workload.rs:513` | gated |
| Online catalog update (JS hourly → `run_due_online_catalog_update`) | hourly | returns `None` | `commands.rs:2258` | gated |
| Collection updates (MangaDex/Kakao refresh) | user/JS triggered | stops | `collection_updates.rs:114,177`; UI button disabled | gated |
| Release watch (JS hourly) | hourly | loop breaks | `release_watch.rs:160` | gated |
| Daily metadata backup | JS at start/daily | skipped | `backup.rs:68` | gated |
| Trash auto-purge | JS/due | skipped | `trash.rs:189` | gated |
| Work-artwork thumbnail backfill | at open | skipped; restarted after light mode | `work_artwork.rs:501,508` | gated |
| JS `useCloudBackfillSupervisor` → `cloud_backfill_progress` (34 ms release per read) | 10 s idle / 1.5 s running | 60 s when hidden or restricted (`workloadPollDelay`) | `useCloudBackfillSupervisor.ts:32,58` | gated |
| JS `useMobilePublications` → `run_due_mobile_publications` (saves nav order, UPDATE … WHERE changed) | 10 s | **not gated**; duplicates the native 10 s tick's cadence | `useMobilePublications.ts` | ungated (cheap) |
| JS `useCloudCaptureSync` | 15 s active / 60 s background | ≥ 60 s | `useCloudCaptureSync.ts:36–47` | gated |
| JS `useSimilarityReviewInbound` | 10 s | 60 s | `useSimilarityReviewInbound.ts:42` | gated |
| JS `useCharacterAutomation` status | 5 s idle / 1 s active | 60 s (hidden or restricted) | `useCharacterAutomation.ts:122` | gated |
| JS PC `ReleaseInbox` (while mounted) | 5 s | 60 s | `ReleaseInbox.tsx:68` | gated |
| JS `useExternalVaultAvailability` | 3 s | 60 s | `useExternalVaultAvailability.ts:53` | gated |
| JS notes refresh | 5 min + focus (when unlocked) | not gated | `NotesView.tsx:117` | ungated (cheap) |
| JS album/classification/bookmark/asset sync hooks | native path active (`nativeWorkload()`), JS loops only in browser fallback | – | `use*AuthoritySync.ts` | superseded by the native pass (cf2075b) |

Findings for item 6: every CPU-heavy job added since `05b18b6` (duplicate-edition scan, catalog preparation re-requests) is gated. The ungated new work is network polling: the **file-exchange receiver (5 s/15 s, an extra `/v1/sync/status` read separate from the authority pass)** and two ≤ 1/min publication lanes. The 10 s publication tick itself runs in every mode by design; its local cost per tick was not measurable safely (network lanes).

### 8. Top optimization candidates (PC backend)

Ranked by user-visible gain × confidence. “Gate” = a deterministic metric from `perf_probe` counters that tracks the measured latency here (VM steps and page misses moved with ms in every change observed; statement/connection counts are exact).

1. **Fix the `list_collections` plan (and siblings) — collection list and sidebar refresh from ~350 ms (release) / ~1.9 s (dev) to ~5–13 ms.**
   Gain: Collections/Works list, every `refreshSidebar` (after authority/collection change events), and any grid request that queues behind it (measured 334 ms / 1.97 s wait). Evidence: §3 and the CROSS JOIN test (400 → 3.1 ms, identical rows).
   Options: rewrite the two correlated subqueries to drive from `collection_assets` (smallest, local), and/or run `PRAGMA optimize`/`ANALYZE` (global; also fixes `list_albums`, `get_asset_classifications`, halves `character_sidebar_counts`).
   Gate: `list_collections` VM steps ≤ 100 k (now 31.4 M) and `refreshSidebar` ≤ 500 k (now 32.0 M).
   Risk: low for the rewrite; medium for global ANALYZE (plan changes elsewhere — gate all probe paths). Size: S. Files: `library/collection.rs` (`COLLECTION_SUMMARY_SQL`), possibly `library/db.rs` (optimize at open/close).

2. **Move main-thread (sync) DB commands off the main thread.**
   97 `#[tauri::command]`s are non-`async`, which Tauri runs on the main thread; among them `list_collections` (349 ms / 1.9 s measured), `list_trash`, `list_similarity_reviews`, `list_release_inbox` (polled every 5 s while the inbox is shown), `classification_sync_status`, `album_sync_status`, `list_collection_covers` (filesystem walk), `trash_assets`/`restore_assets`, `set_asset_classification`. A slow one freezes the window (inferred, not measured in a window).
   Gate: count of sync `#[tauri::command]` functions that call `library.*` (static check; ratchet down). Risk: low (mechanical `async` + `spawn_blocking`, the pattern already used by ~120 commands). Size: M (many small edits). Files: `src/commands.rs`, `src/commands/*.rs`.

3. **Connection reuse (small pool or per-thread cached read connection) with a larger page cache.**
   Every call pays open + schema parse (1.37 ms release / 3.82 ms dev per connection — the entire cost of ~20 of the 60 paths) and starts with a cold 2 MB page cache (filtered grid pages need ~7,000 page reads). Background ticks multiply it (replication cycle: 4 connections every 2 s).
   Gate: connections per call (now 1–4; target 0 new connections on a warm path) and page misses per repeated call. Risk: medium — connection state (pragmas, `foreign_keys`, attached catalog, transactions) and the `database_lock` semantics must stay identical; WAL readers could then run concurrently. Size: M–L. Files: `library/mod.rs` (`connection`, `LockedConnection`), `library/db.rs`.

4. **Replace the process-wide DB `Mutex` for reads (or make it fair) — UI requests queue behind background work.**
   All 536 `.connection()` call sites serialize on one non-FIFO `std::sync::Mutex`, although the DB is WAL. Measured: a grid page (3 ms alone) waits 334 ms release / 1.97 s dev behind a sidebar refresh; a gap-free holder starved it for minutes.
   Gate: grid page p95 in the probe's two contention cases (not deterministic; pair with a deterministic check that read paths do not take the write mutex). Risk: medium–high (write ordering assumptions). Size: M. Files: `library/mod.rs`. Depends partly on 3.

5. **Dev-profile SQLite at `-O3` (only if the user keeps running `tauri dev` daily — confirm).**
   Traced SQL time ≈ total time on heavy paths, and dev is 2.5–5.5× slower than release (e.g. `refreshSidebar` 1.96 s vs 0.36 s, `character_sidebar_counts` 589 vs 152 ms). Adding `[profile.dev.package.libsqlite3-sys] opt-level = 3` next to the existing image-crate overrides should recover most of it (estimate, not measured — needs a manifest change and a separate target dir to test without disturbing the user's dev build).
   Gate: debug/release median ratio on `list_classifications` and `list_assets(images)` ≤ 1.5. Risk: very low (build-only). Size: XS. Files: `_tools/app/src-tauri/Cargo.toml`.

6. **Specialize the `list_assets` count and filter SQL; skip the count on pages 2..n.**
   Catch-all `(?x IS NULL OR …)` SQL plus a full `COUNT(*)` on every page: filtered/sorted grids cost 13–20 ms release / 25–42 ms dev per page and ~7,000–12,400 page misses (favorites sort/random 17 ms, favorite-only 19 ms, top creator 20 ms, classification+images 18 ms), vs 3 ms for plain newest. `unclassified` badge: 9 ms / 33 ms.
   Gate: page misses per `list_assets` call for the probe's filter set (now ~7 k for images/landscape/videos) and statements per page-2+ request (drop the COUNT). Risk: medium (predicate equivalence; cursor semantics). Size: M. Files: `library/query.rs`.

7. **Idle-tick trimming: replication cycle and backfill progress.**
   Replication cycle every 2 s opens 4 connections and runs 8 statements (2 no-op UPDATEs) when nothing is eligible; `cloud_backfill_progress` runs 6 separate COUNT joins (34 ms release) every 10 s. Together ≈ 0.5 s CPU/min release, 1.3 s/min dev, window open and idle.
   Options: early-exit on a cheap queue revision/`EXISTS` before the UPDATEs; one grouped COUNT for progress; poll progress only while running.
   Gate: statements and connections per idle replication tick (now 8 / 4, target ≤ 2 / 1) and per progress read (now 13). Risk: low. Size: S. Files: `cloud/backfill.rs`, `_tools/app/src/app/useCloudBackfillSupervisor.ts`.

8. **Character screens: review pages and the target-list N+1.**
   Review page for one target 165 ms release / 318 ms dev (92 k page misses); series-wide recommended page 600 ms / 1.43 s (173 k page misses, 900 statements). `list_character_targets` issues 884 statements for 56 targets (41 / 94 ms), also paid by `character_review_pending_map`; `character_sidebar_counts` 66 recursive statements (152 / 589 ms). Main lever: avoid reading `result_json` rows of the 545 MB predictions table for rows that are not on the page (keyset first, then fetch 40), and batch the per-target reads.
   Gate: page misses per review page (now 92 k / 173 k), statements per `list_character_targets` ≤ 10 (now 884), VM steps of `character_sidebar_counts` (now 6.2 M). Risk: low–medium. Size: M. Files: `library/character_review.rs`, `library/characters.rs`, `library/character_hub.rs`.

9. **File-exchange receiver: fold into the authority pass or back off when idle; honor lightweight mode.**
   An independent `/v1/sync/status` read every 5 s shown / 15 s hidden in every mode (≈180 / 60 requests per 15 min) — the only new ungated periodic network work since `05b18b6`. Wake-ups are a battery/CPU cost on laptops; request counts belong to the PC-POLL-002 section.
   Gate: receiver requests per idle 15 min in a fixture (deterministic with a fake clock). Risk: low–medium (arrival latency expectations: “about five seconds while shown”). Size: S–M. Files: `src/exchange/mod.rs`, `src/workload.rs`.

10. **Catalog duplicate scan cost (gated but heavy when due).**
    Real-catalog gate in debug: materialize 4.4 s + scan 7.0 s per pass. Runs from the 10 s publication tick when its own claim says due; skipped in light mode.
    Gate: the existing `catalog_duplicate_real_catalog_scan_gate` timings plus VM steps. Risk: medium. Size: M. Files: `library/catalog_duplicate_sync.rs`. Lower priority until its due frequency is confirmed in the field.

### 9. Checks run

- `cargo build --bin perf_probe` and `cargo build --release --bin perf_probe`: pass, no warnings from `perf_probe.rs` (the lib's pre-existing 40–41 warnings unchanged).
- `rustfmt --edition 2021 --config skip_children=true src/bin/perf_probe.rs` (only the changed file; no `cargo fmt`); rebuilt and re-ran afterwards.
- Probe runs: debug × 4 full (10–15 iterations), release × 3 full (25 iterations; the first stopped in the starving contention case; `release-run3.txt`/`debug-run4.txt` add the character screen paths after a probe fix), release what-if ANALYZE × 1, plus 2 `strace` validation runs. Every run: `library_root_unchanged: true`; `strace`: only `O_RDONLY` under the library.
- 11 `#[ignore]` benchmarks (§4): all passed.
- `git status`: only `src/bin/perf_probe.rs` modified by me (other untracked files belong to the parallel workers). No dev app launched; `target/debug/lakomics` never run; snapshots under the scratchpad deleted after use.

#### Reproduce

```
cd _tools/app/src-tauri
cargo build --release --bin perf_probe
target/release/perf_probe --library "/home/laku/MEGA 다운로드/before-linux-backup/New_lakomics_assets" \
  --snapshot-dir <scratch> --iterations 25 --with-catalog --idle-ticks
### dev-profile numbers: cargo build --bin perf_probe && target/debug/perf_probe … --iterations 15
### gate-friendly subset: add --only list_collections (or --skip contention)
```

---

### Desktop: React render/commit counts and idle polling (PERF-ALL-001 phase 1, items 2 and 3)

Branch `main` at 699d0e4. No product code changed. Added measurement-only files:

- `_tools/app/src/app/App.perf.test.tsx`: render/commit harness for the whole desktop `App` (14 scenarios). It is skipped unless `LAKOMICS_PERF=1`, so the normal `npm test` run does not change.
- `_tools/app/src/test/perfGateway.ts`: a fake gateway. It copies the `App.test.tsx` fake, returns fresh objects from status reads (as real IPC does), and serves 1,000 synthetic assets in pages of 100 plus 60 Collections.

Run from `_tools/app/`:

```
LAKOMICS_PERF=1 npx vitest run src/app/App.perf.test.tsx --reporter=verbose --silent=false
LAKOMICS_PERF=1 LAKOMICS_PERF_QUIET=1 npx vitest run src/app/App.perf.test.tsx --reporter=verbose --silent=false
```

With `QUIET`, background status reads return stable objects. Interaction numbers then exclude the idle re-renders, which are measured separately.

### Method and confidence

- **Commits:** the number of `onRender` calls from one React `<Profiler>` around `<App>`.
- **Render counts:** components are wrapped through `vi.mock`, and each render-function call is counted. Counted components: AppShell, WorkspaceNavigation, ClassificationSidebar, StatusCenter, AssetBrowser, AssetToolbar, AssetGallery, AssetViewer, CollectionBrowser, NotesView. AppShell renders once per `LibraryWorkspace` render, so its count is the **root** (whole-tree) render count.
- **Tile renders:** counted as calls to `thumbnailUrl`, which each `AssetTile` render makes.
- **IPC calls:** counted per gateway method and per `invoke` command.
- **Time:** fake timers (`vi.advanceTimersByTimeAsync`). jsdom layout is stubbed to a 1200×900 viewport, which shows about 29 masonry tiles.
- **Determinism:** two full runs in each mode gave identical counts (diffed with durations removed). **Confidence: high** for these counts as properties of the React code.
- **Limits:** jsdom has no paint or layout. The Profiler's `actualDuration` is jsdom time and is not a latency. None of this proves WebView2/WebKitGTK frame cost. Native IPC latency is not included.
- **Idle-request table:** built from reading the code (intervals, gates, ETags). It is cross-checked against the 2026-09-24 server access log in `lakomics-completed.md#PC-POLL-001`. Confidence is marked per row.

### 1. Render/commit counts per interaction

`root` = whole-tree renders (AppShell). `tiles` = gallery tile renders. Default mode is realistic (status reads return fresh objects). Quiet mode is net of idle noise.

| Scenario | Default: commits / root / gallery / tiles | Quiet: commits / root / gallery / tiles | Native IPC in window (quiet) |
|---|---|---|---|
| Startup: open library → settled grid (5 s) | 10 / 6 / 5 / 145 | 9 / 5 / 4 / 116 | 31 calls (list*, backup, trash purge, ...) |
| **Idle 60 s, window visible and focused, Library grid** | **28 / 28 / 28 / 812** | 0 / 0 / 0 / 0 | 54 (vault 20, character status 12, progress 6, similarity inbound 6, mobile publications 6, captures 4) |
| **Idle 300 s, window visible but NOT focused** | **140 / 140 / 140 / 4,060** | 0 | 255 |
| Idle 60 s, Collections tab (60 items) | 28 / 28 (CollectionBrowser 28) | 0 | 54 |
| Idle 60 s, Notes open | 30 / 28 (NotesView 28) | 2 | 55 (+1 notes sync) |
| Idle 60 s, document hidden (minimised, native not hidden) | 8 / 4 / 4 / 116 | 0 | 23 |
| Idle 300 s, tray-hidden (`workload://changed hidden`) | 0 | 0 | 35 (captures 5, mobile publications 30) |
| Idle 300 s, lightweight mode, visible | 15 / 10 / 10 / 290 | 0 | 55 |
| **Window focus event (+2 s)** | 9 / 6 / 8 / 232 | **7 / 4 / 6 / 174** | **15 IPC + 1 network** (listClassifications, listAlbums, listAssets, dateBuckets, listTrash, preparePendingVideos, authoritySyncHealth×3, character targets/series/exclusions, captures poll) |
| Native `library://asset-authority-changed` (+2 s) | 9 / 6 / 8 / 232 | 7 / 4 / 6 / 174 | 14 (same reload as focus) |
| Native album / classification change (+2 s) | 7–9 / 4–6 | 7 / 4 / 6 / 174 | 7–12 |
| Native catalog-bookmarks change | 1 (vault tick) | 0 | 0 |
| Sidebar: select a folder (+2 s) | 7 / 6 / 7 / 203 | 6 / 4 / 5 / 145 | listAssets 1 |
| Grid: scroll → next page, per page | 7 / 4 / 6 / 233 | 7 / 3 / 5 / 233 | listAssets 1 |
| Grid: 3 pages cumulative | 21 / 11 / 17 / 734 | 21 / 9 / 15 / 734 | listAssets 3 |
| Viewer open (+1 s) | 6 / 2 / 3 / 87 | 4 / 1 / 2 / 58 | recordAssetOpened 1 |
| Viewer next, per ArrowRight | 2 / 0 / 1 / 29 | **2 / 0 / 1 / 29** | recordAssetOpened 1 |
| Viewer close | 4 / 1 / 2 / 58 | 1 / 0 / 1 / 29 | – |
| Collections tab open (+3 s) | 8 / 3 | 6 / 1 (CollectionBrowser 1) | – |
| Notes: open 메모 (+3 s) | 10 / 3 | 8 / 1 | notes state + sync |
| Notes: type 10 characters | 33 / 2 | **31 / 0** (about 3 commits per keystroke inside NotesWorkspace) | **notes save ×10 (one native save per keystroke)** |

jsdom `actualDuration` for reference only: idle Library about 205–229 ms per minute; idle Collections about 596 ms per minute (about 21 ms per root re-render, the heaviest view); 0 in quiet mode. Low confidence as a latency figure.

#### Wasted re-render findings (measured)

1. **Idle whole-tree re-render about 28 times a minute while the window is visible, focused or not.** Nothing in desktop `src` uses `React.memo`, so every `LibraryWorkspace` render re-renders the whole tree, including about 29 gallery tiles. The attribution runs (60 s) isolate the sources:
   - **Private Vault status, every 3 s (16 of 28 root renders):** `external-vault/useExternalVaultAvailability.ts:31` calls `setStatus(next)` with a fresh IPC object each time.
   - **Character automation status, every 5 s (12 root renders; about 4 of 28 coincide with the vault tick):** `characters/useCharacterAutomation.ts:102` calls `setHistoryRefreshes(status.historyRefreshes ?? [])`, and Rust always sends a new `historyRefreshes` array (`character_incremental.rs:139`).
   - **Cloud progress, every 10 s:** re-renders only `CloudStatusCenter` (6 commits a minute). This part is already isolated by design (`App.tsx:953`).
   - With these three made stable, idle = **0 commits**.
   - Result: about 1,680 root renders and about 48,700 tile renders per hour in the Library view. This continues while the window is merely unfocused and stops only when native `hidden` is set (tray).
2. **Every window focus reloads everything.** In native mode, `app/useAssetAuthoritySync.ts:20` relays `focus` as asset-lifecycle, album and classification "changed" events. Each focus costs 4 root renders, 174 tile renders and 15 IPC calls. The same focus also makes the native pass wake (2 status requests) and triggers a captures poll (1 request), so about 3 server requests per focus. The native `asset-authority-changed` event triggers the same full reload.
3. **Loading a grid page re-renders the root 3–4 times.** `assets/AssetBrowser.tsx:158` reports `onStatusChange` (loading and loadedCount) to `LibraryWorkspace` state (`App.tsx:200`, `:928`), which re-renders the sidebar, navigation and so on.
4. **Viewer next re-renders the gallery hidden behind the modal:** 1 AssetGallery render and about 29 tiles per ArrowRight.
5. **Notes: one native save per keystroke** (10 characters → 10 `notes_request:save`) and about 3 commits per keystroke. The root is not re-rendered. The immediate local write is by design; this is noted, not flagged.

### 2. Desktop idle requests (PC-POLL-002)

Periodic network requests while idle, per 15 minutes.

- **U** = window visible but not focused (the usual "idle" state and the state of the 2026-09-24 measurement). **F** = focused. **T** = hidden in the tray. **L** = lightweight mode.
- The native publication tick is about 10.0–10.1 s (`workload.rs:527`, 1 s loop). A durable `last_checked <= unixepoch()-60` gate turns that into about one request every 60–61 s, so about 15 per 15 minutes.
- "Gated" means the log is read only when the shared status, a cursor or an ETag says it moved.

| # | Endpoint | Trigger / interval | Gated by shared status or ETag? | U | F | T | L | Measured 09-24 | Confidence |
|---|---|---|---|---|---|---|---|---|---|
| 1 | GET `/v1/sync/status` (authority pass, client token) | Native pass: 5→15→30→60 s backoff; wakes on local write, focus, library switch, Asset change (`authority_pass.rs:37`, `workload.rs:484-610`) | It is the shared status. `If-None-Match` → 304 | 15 steady + wake episodes | +1 per focus | 15 | 15 (floor 20 s) | 25 | high |
| 2 | GET `/v1/mobile-catalog/status` (bookmarks) | Same pass (`authority_pass.rs:315`) | Own ETag; a separate endpoint, not in `/v1/sync/status` | 15 + episodes | same | 15 | 15 | 25 | high |
| 3 | Domain change feeds (assets, albums, classifications, bookmarks) | Only when a cursor moved, or after this pass sent | yes | ≈0 (+ echoes of own writes) | | | | small | high |
| 4 | GET `/v1/captures/pending` | React `useCloudCaptureSync.ts`: 15 s focused, 60 s unfocused/hidden/lightweight, plus every focus. A stale cursor adds a second, full-list request (`captures.rs:373-376`) | **no**, no ETag | 15–18 | **60** | 15 | 15 | 18 | high |
| 5 | GET `/v1/library/characters/exclusions` | Native "characters" lane, 60 s (`auto_publication.rs:198`) | **no** | 15 | 15 | 15 | 15 (not gated) | 16 | high |
| 6 | GET `/v1/library/characters/review/decisions` | Same lane (`character_review_sync.rs:266`) | **no** | 15 | 15 | 15 | 15 | 16 | high |
| 7 | GET `/v1/library/similarity/review/decisions` | "similarity" lane, 60 s (`similarity_review_sync.rs:321`) | **no** | 15 | 15 | 15 | 15 | 15 | high |
| 8 | GET `/v1/collections/status` | "collections" lane, 60 s (`collection_personal_edits.rs:383`) | **no**, no ETag | 15 | 15 | 15 | 15 | 15 | high |
| 9 | GET `/v1/collections/personal-edits` | Immediately after #8 | **no**, although #8 already returns `personalEditCursor` | 15 | 15 | 15 | 15 | 15 | high |
| 10 | GET `/v1/mobile-catalog/duplicates/decisions` | "catalogDuplicates" lane, 60 s. Only when `catalogs/kdata.db` exists | **no**. Off in lightweight mode | 15 | 15 | 15 | 0 | not in log (added 09-25) | high (code) |
| 11 | GET `/v1/collections/releases/reads` | "releases" lane, 60 s (`collection_release_sync.rs:196`) | **no** | 15 | 15 | 15 | 15 | not in log (added 09-25) | high (code) |
| 12 | GET `/v1/collections/bindings/log` | "bindings" lane, 60 s (`collection_binding_sync.rs:51,379`) | ETag only (304) | 15 | 15 | 15 | 15 | not in log (added 09-26) | high (code) |
| 13 | PUT `/v1/collections/releases/unread` | When the unread set changes, and a daily refresh | – | ≈0 | | | | – | high |
| 14 | GET `/v1/sync/status` (**exchange receiver**, device token) | Native thread: 5 s while the window is shown, 15 s when minimised or in the tray (`exchange/mod.rs:45-47,861`). **Only if an exchange token is configured** | ETag (304) | **180** | 180 | 60 | 180 (not gated) | not in log (added 09-25) | high (code); whether it is active is unknown |
| 15 | GET exchange devices / outbox / inbox | When the exchange revision moves. Every 60 s if the server sends no `exchange` field | revision | 0 (45 if the server has exchange off but the PC has a token) | | | | – | medium |
| 16 | Notes sync (`/v1/notes/…`) | Only while 메모 is open and unlocked: every 5 min + focus, at least 60 s apart | no | ≤3 | 3 + focus | 0 | ≤3 | – | high |
| 17 | POST `/v1/library/assets/{id}/media-ticket` (+ download) | Asset lane runs every pass. A **permanently failing** pending materialization retries on every pass | no | 0 normally; up to 15–25 | | | | 1 seen | medium |
| 18 | Online-catalog update, release watch | Hourly due-check. Network only when due; release watch goes to external providers | – | 0–1 | | | | – | high |

**Totals per 15 minutes.** These are estimates from code, cross-checked with the 151 requests measured on 09-24:

- **Without an exchange token:**
  - U ≈ 165 steady + about 20 from wake episodes ≈ **185–200**.
  - F ≈ 230–245.
  - T ≈ 185.
  - L ≈ 170–185 (lightweight saves only #10).
  - The 09-24 measurement of 151 predates #10–#12 (+45 now).
- **With an exchange token configured and the window shown:** +180 → **U ≈ 365–380**.
- **PC-POLL-002 target:** under 50.
- **Lightweight mode does not gate** #5–#9 and #11–#12 (`run_saved_mobile_publications`, `auto_publication.rs:48`, has no `restricted` check) or the exchange receiver.

**Idle IPC and local work (not network).** In the React harness (measured), 54 IPC calls a minute while visible:

- vault status every 3 s: 300 per 15 min. Each call enumerates mount roots and reads a vault-id file (`encrypted_runtime.rs:1617`).
- character status every 5 s.
- progress, similarity inbound and `runDueMobilePublications` every 10 s (the last one is an UPDATE of the navigation order, a no-op when unchanged).
- captures every 15 s.

Native, from code:

- the replication cycle runs `SUPERSEDED_UPLOAD_SQL` + EXISTS every 2 s (`backfill.rs:550`);
- 7 lane threads are spawned every 10 s (`auto_publication.rs:53`);
- similarity auto-compare runs every 10 s;
- the catalog-visibility digest is recomputed every 10 s;
- the character-review and similarity feeds are rebuilt every 5 min (`built_at<=unixepoch()-300`, upload only if the digest changed);
- the catalog-duplicate fingerprint (hash of all decisions and pairs) runs twice a minute.

None of this native local work was measured here. It is left for the perf_probe owner.

#### The ~3-minute fast-interval wake

**Not conclusively traced from code alone. No log was available.**

The fast interval (`AuthoritySchedule` idle=0) is re-entered only through:

- (a) `note_local_work()`: an Album, Classification, Bookmark or Asset-lifecycle intent was queued (`bookmark_outbox.rs:590`, `classification_authority.rs:532`, `album_authority.rs:583`, `asset_authority.rs:316`);
- (b) gaining window focus;
- (c) a library switch;
- (d) a pass whose outcome `changed()`: something applied or sent;
- (e) `changed_elsewhere()` after an Asset lane run with `applied_changes`, `materialized` or `flushed` > 0 (`workload.rs:610`).

Findings:

1. The Asset lane counts **every** change-feed row as `applied_changes`, including the echo of this PC's own replication commit (`asset_authority.rs:828`: `count += parsed.len()`).
   - Any upload by this PC therefore moves the server `assets` cursor. The next pass fetches its own echo, resets the backoff (+2–3 passes, about 5–6 extra requests) and emits `library://asset-authority-changed`.
   - That event triggers the full UI reload measured above (4–6 root renders, 14 IPC).
   - A materialization of an Asset uploaded from the tablet (`media-ticket`) does the same.
   - The three coincidences in the 09-24 log fit this chain: saved-X-media snapshot publish, character replica publish and a media ticket. All of them follow "a new Asset arrived", so the wake cadence would follow capture or tablet activity, not a timer.
2. The only 3-minute constant in the code is `fresh_job_due` = 180 s (`character_incremental.rs:25`). It limits character autotag to one fresh job every 3 min in lightweight mode (including the auto-enter lightweight mode).
   - It explains a 3-minute *character replica* publish cadence (the characters lane publishes 30 s after a character change).
   - I found **no path** from a character job to a wake source: autotag writes neither authority intents nor `cloud_sync_queue`, and the server's `/v1/library/characters/replica` has no authority side effects.
   - So it can coincide with the wakes but does not cause them.
3. How to settle it: a 15-minute idle window with the native side logging the reason for each wake (a phase-2 instrumentation change, or `eprintln!` in a dev build), correlated with the server log. Check `autoEnterMinutes` in `library-machine.json`. Check tablet traffic (proxy IP 100.76.119.29) and `/v1/replication/commit` / `/v1/assets/authority/changes` in the same window.

#### BIND-POLL-001: why a tablet connect request takes 10–60 s

The bindings lane runs on the 10 s publication tick but claims a poll only when `last_polled <= now-60` (`collection_binding_sync.rs:51,379`). A request made just after a poll waits about 60 s; the average wait is about 30 s. Only a `Pass::More` backlog re-polls on the next tick. No shared status carries a bindings signal: `/v1/collections/status` carries only the `collectionBindings` capability flags. At the current idle cadence of `/v1/sync/status` (60 s), adding a pending-request cursor there gives ≤60 s pickup when idle and about 5 s after activity. Sub-15 s pickup while idle needs either:

- a faster single status read when the window is shown (15 s → 60 per 15 min, 20 s → 45), or
- reusing the exchange receiver's 5 s status read, which already exists when an exchange token is set.

### 3. Top optimization candidates (desktop area)

| # | Candidate | Expected user-visible gain | Deterministic gate metric | Risk | Size | Files |
|---|---|---|---|---|---|---|
| 1 | **One shared status for every log (PC-POLL-002 + BIND-POLL-001).** The server adds head cursors to `/v1/sync/status` for bindings, character exclusions and review decisions, similarity decisions, catalog-duplicate decisions, release reads, personal edits, pending captures and the bookmark authority cursor. The PC reads a log only when its cursor is above the local one; the captures poll moves behind the same signal. | Idle requests about 185–200 → about 20–35 per 15 min (−80–90%). Tablet connect picked up on the next pass instead of the next 60 s lane slot. Less server and Wi-Fi wake traffic. | Rust fake-server test (as in the `authority_pass.rs` tests): over N simulated idle passes with no cursor movement, requests == N status reads (0 log reads). Then the 15-minute server-log window: < 50. | Medium: server + PC contract; older-server fallback; many lanes. | L | `server/lakomics-api/sync_status.py` (+ log modules), `library/authority_pass.rs`, `cloud/auto_publication.rs`, `library/{character_exclusions,character_review_sync,similarity_review_sync,catalog_duplicate_sync,collection_release_sync,collection_binding_sync,collection_personal_edits}.rs`, `cloud/client.rs`, `app/useCloudCaptureSync.ts` |
| 2 | **Stop idle whole-tree re-renders:** equality-guard `setStatus` in the vault hook and `setHistoryRefreshes`/`setActiveWork` in the character hook (compare fields or JSON before setting). | Idle Library view 28 root and 812 tile renders per minute → 0, while the window is visible or unfocused. Less WebView CPU and battery; smoother scrolling if a tick lands mid-scroll. | This harness: `idle(60s)` and `unfocused-visible(300s)` root = 0 and tiles = 0 in default mode (tighten-only). | Low | S | `external-vault/useExternalVaultAvailability.ts`, `characters/useCharacterAutomation.ts` |
| 3 | **Focus / Asset-change reload:** drop the JS `focus` → "changed" relay in native mode (the native pass already wakes on focus and emits only real changes). Have the Asset lane count only rows that changed the local projection (skip own echoes), and emit per-domain events. | Per focus: 4 root / 174 tile renders and 15 IPC → about 0. No full reload after this PC's own uploads. Fewer fast-interval episodes (−about 20 requests per 15 min). Likely part of the "~3 min" wake. | Harness `focus(+2s)` quiet: root 4 → 0, gateway list* calls → 0. Rust test: a pass that only receives its own commit echo gives `changed == false` and emits no event. | Low–medium: remote trash/restore refresh must be kept. | S–M | `app/useAssetAuthoritySync.ts`, `library/asset_authority.rs` (`catch_up_assets`/`apply`), `workload.rs` |
| 4 | **Exchange receiver:** fold its `/v1/sync/status` read into the shared read, or at least slow it when the window is unfocused. | −120 to −180 requests per 15 min when a token is set; the largest single idle source. | Same fake-server request count; server log. | Medium: different token/principal; the arrival-latency promise (~5 s) must be kept. | M | `exchange/mod.rs`, `exchange/client.rs`, `library/authority_pass.rs`, `workload.rs` |
| 5 | **Personal-edits quick win:** skip GET `personal-edits` when `/v1/collections/status.personalEditCursor` equals the local received cursor (client only). | −15 requests per 15 min. | Rust scripted-server test: N idle polls → 0 personal-edits requests. | Low | XS | `library/collection_personal_edits.rs` |
| 6 | **Grid page load re-renders the root:** keep `AssetBrowserStatus` out of `LibraryWorkspace` state (a small store read by the status bar), or memo heavy siblings. | Each next page: root 3 → 0–1. Sidebar, navigation and toolbar untouched while scrolling. | Harness `grid-scroll(step1)` quiet: root 3 → ≤1; tiles 233 → ≤ the new page's tiles. | Low | S–M | `app/App.tsx`, `assets/AssetBrowser.tsx` |
| 7 | **Viewer next re-renders the hidden gallery:** memo `AssetGallery`/`AssetTile`, or stop passing viewer-driven focus/selection to the gallery while the viewer is open. | Per ArrowRight: 1 gallery + 29 tile renders → 0. Faster next-image response on large pages. | Harness `viewer-next(x5)`: AssetGallery 5 → 0, tiles 145 → 0. | Low | S | `assets/AssetBrowser.tsx`, `assets/AssetGallery.tsx` |
| 8 | **Private Vault probe cadence:** every 3 s while visible, a mount-root scan plus a file read. Use 10–15 s, or react to focus/visibility plus OS mount events. | −200 to −250 filesystem probes per 15 min; avoids waking removable drives. | Harness gateway count `getEncryptedVaultStatus` per 60 s. | Low: USB insertion is noticed a few seconds later. | XS | `external-vault/useExternalVaultAvailability.ts` |
| 9 | **Captures poll:** 15 s while focused, no ETag, extra request with a stale cursor. Until #1: ETag or a 60 s floor, and drop the second full-list request. | −45 requests per 15 min while focused. | Scripted-server test: requests per idle poll == 1. | Low | S | `app/useCloudCaptureSync.ts`, `cloud/captures.rs`, `cloud/client.rs` |
| 10 | **Lightweight mode vs. polling:** lanes #5–#9, #11, #12 and the exchange receiver ignore `restricted`. | Lightweight mode actually cuts idle network (−about 90 per 15 min without #1). | Rust test: in restricted mode a publication tick issues no log reads more often than the chosen floor. | Low | S | `cloud/auto_publication.rs`, `exchange/mod.rs` |

### What could not be measured here, and what to measure natively

- **Real WebView cost:** Linux WebKitGTK and Windows WebView2 were not driven here. Keep the Library grid open with the window visible and unfocused for 5 min, and record WebView process CPU before and after candidate 2. On Linux: `pidstat -u -p $(pgrep -d, -f WebKitWebProcess) 60 5` (WebView2 on Windows: Task Manager / `Get-Counter '\Process(msedgewebview2*)\% Processor Time'`). React DevTools is not available in release builds.
- **Idle request volume, current build:** repeat the PC-POLL-001 method (server access log, the desktop client's IP, 15 min) in four states: visible-unfocused, focused, tray, lightweight. Report per endpoint. Also record whether the server runs with `LAKOMICS_EXCHANGE_ENABLED=1` and whether this PC has an exchange token. That decides whether row 14 (+180) applies.
- **3-minute wake:** in the same window, list non-304 `/v1/sync/status` responses with neighbouring `/v1/assets/authority/changes`, `/v1/replication/commit`, `/v1/library/assets/*/media-ticket` and tablet requests. Check `autoEnterMinutes`.
- **Native IPC round-trip cost** of the 54 idle IPC calls per minute: not measured.
- **Focus-driven server requests:** each focus is about 3 requests in total (focus pass: sync/status + mobile-catalog/status; captures: 1). Confirm on the native window.

### Checks run

- Full harness (14 scenarios) in default mode: passed; ran twice with identical counts. Command: `LAKOMICS_PERF=1 npx vitest run src/app/App.perf.test.tsx --reporter=verbose --silent=false`.
- Same harness with `LAKOMICS_PERF_QUIET=1`: passed; ran twice with identical counts.
- `npx vitest run src/app/App.perf.test.tsx` without the env var: 14 skipped, so the normal suite is unaffected.
- `npx tsc --noEmit -p tsconfig.json`: exit 0.
- The full `npm test` was not run, because no product code changed. There are no native, Tauri or server checks. The idle table is based on the code and on the 09-24 log.

Raw lines are in `scratchpad/perf/desktop-run1.txt` / `desktop-run2.txt` (default mode) and `desktop-quiet.txt` / `desktop-quiet2.txt` (quiet mode).

---

### PERF-ALL-001 phase 1 — Tablet (item 4) and Cloud API (item 5)

Baseline: `main` at 699d0e4 (Android source 0.8.27). No product code was changed. What was added (measurement only):

- `server/lakomics-api/tools/endpoint_perf.py`: in-process profile of the tablet's idle and hot endpoints on a throwaway SQLite fixture (reuses `poll_benchmark.py` boot/populate and the R2 stub). It reports p50/p95 ms, SQL statements per request, SQLite connections per request, **R2 HEAD calls per request** (HEAD cache cold or warm), response bytes, and whole-Library walk totals. `--head-latency-ms` models R2 HEAD latency.
- `_tools/app/mobile-client/Collections.perf.test.tsx`: cold-start cover fetch timing and concurrency on the real `Collections` component (fake timers, modeled per-cover latency), and Collections idle requests per hour.
- `_tools/app/mobile-client/thumbnailWarm.perf.test.ts`: bridge calls per warm-up pass (9,300 Assets) and what one transient page failure costs.

Method labels used below. **M** = measured here (in-process server or jsdom harness; deterministic counts, relative ms). **C** = traced from code (file:line), not run. **E** = estimate from code plus earlier device numbers (MOBILE-PERF-002: tablet→Tokyo API ~70–100 ms round trip; uncached R2 object 1.5–2.4 s). **D** = has to be measured on the tablet (plan in §5). Device and native-window numbers do not exist in this section. The fixture and jsdom results do not prove anything about the Galaxy Tab.

---

### 1. Tablet idle and background work

#### 1.1 Background (app paused or stopped)

**C, high confidence:** nothing runs periodically. `onPause` stops the native authority pass (`AlbumReplicaService.stop` → `ForegroundSchedule.stop`), pauses all WebView JS timers (`web.pauseTimers()`), and pauses the Photo Picker snapshot schedule and the exchange foreground (`MainActivity.java:344`). `onStop` cancels queued optional media work (`MainActivity.java:345-347`, `stopNonEssential`). Nothing uses a wake lock, WorkManager or AlarmManager. A transfer that was already running (exchange upload/download) continues. The system Photo Picker and DocumentsUI can call the providers on demand. **So the app's own battery cost is all foreground, screen-on time.**

#### 1.2 Foreground idle (app visible, no touches)

Per-hour counts assume steady state after the backoff. "Req" means network requests. "Wake" means a timer that wakes JS or a native thread without using the network.

| # | What | Interval / trigger | Where | Req/h (idle) | Other cost | Method |
|---|---|---|---|---|---|---|
| 1 | Native authority pass: `GET /v1/sync/status` (conditional, usually 304; with the device exchange token when one is stored) | Right after resume, then 5 → 15 → 30 → 60 s backoff while unchanged. Resets on a local write or a detected change. | `ForegroundSchedule.java:73,86-97`; `AlbumReplicaService.java:219-241,259-320` | ~60 | Asset, Album and Classification feeds are skipped while their cursors are unchanged (`AssetReplica.java:55`, `AlbumAuthoritySync.java:185`, `ClassificationAuthoritySync.java:194`) | C |
| 2 | Native `GET /v1/library/list-generation` (**unconditional**, 200 with 99 B) | Every pass once 60 s have passed since the last check. At steady state that is every pass. | `AlbumReplicaService.java:348-368` | ~60 | Server: 9 SQL statements, including a `sqlite_master` scan (M) | C+M |
| 3 | **Full asset-replica parse inside the pass**: `AssetReplica.sync` reads the whole snapshot before it compares cursors | Every pass (~60/h) | `AssetReplica.java:46` (read) vs `:55` (cursor compare); `AndroidReplicaDb.java:75-84` | 0 | Loads all ~9,300 `asset_state` rows, JSON-parses and regex-validates each, and builds two TreeMaps. JVM desktop: **25 ms median, 213 ms first run** per parse (M, scratch microbenchmark). Tablet ART is likely 2–5× slower (E). | C+M |
| 4 | **JS Library Trash poll → native `assetLifecycleState`**, mounted at App level, so it runs on every tab | Every 15 s while visible | `useLibraryTrash.tsx:47-50` → `AlbumReplicaService.java:964-972` → `readAssets` | 0 | Each poll does a Keystore decrypt (`scopeOrNull` → `SecureSettings.read`) **plus the same full 9,300-row parse**, only to compute `available`. It holds the service `gate`. **240/h.** | C+M |
| 5 | Photo Picker snapshot (CloudMediaProvider) **full Library walk** | On every resume when ≥15 min have passed since the last walk (always at cold start). Forced, at most every 5 min, after any list-generation change, changed pass or Album flush. | `PickerLibrary.java:39,44-58,66-96`; `PickerRefreshSchedule.java`; `AlbumReplicaService.java:365,390` | ~94 per walk: list-gen + classifications + 91 pages of `limit=100` + list-gen. **No skip when nothing changed** (the snapshot does not store the server generation). | Server per walk: 91 pages, 3.79 MB, 546 SQL statements, 91 connections, 563 ms in-process (M). Runs whether or not Lakomics is the selected picker provider. While the PC is importing, up to 12 walks/h ≈ 1,100 req/h (E). | C+M |
| 6 | Library thumbnail warm-up | 5 s after launch or visibility (`START_DELAY`). A full pass repeats every 24 h. While the battery gate fails, it retries every 60 s. After an error it retries after 60 s. | `thumbnailWarm.ts:23-25,47-72,78-110` | Full pass: **93 page GETs + 93 native `status` + 9,300 native `thumbnail` calls** (M). Misses add batched ticket POSTs and R2 GETs. | Each native `thumbnail` call, even a disk-cache hit, takes a `mediaWorkers` slot and a Keystore decrypt under `CONNECTION_LOCK` (§2.2). **A single failed page restarts the pass from page 1** (`thumbnailWarm.ts:61-65`): one failure at 40 % gave 134 pages and 13,300 bridge calls instead of 93 and 9,300 (M). | C+M |
| 7 | Original-ticket warm for visible gallery images | Re-warms before each ticket expires (TTL 300 s, refreshed at 285 s) while a gallery is on screen. Needs battery ≥50 % or charging. | `originalTicketWarm.ts:14-45`; `MainActivity.java:57,253`; `app.py:1716` | ~12.6 (Library/gallery only) | Each batch (≤50 originals) costs **49 server R2 HEADs** when the HEAD cache is cold (TTL 30 s) (M) | C+M |
| 8 | Home / Library tab: `GET /v1/library/characters/status` (conditional) | 60 s | `App.tsx:486`; `usePublicationCheck.ts` | 60 | — | C |
| 9 | Home day-change timer | 60 s | `Home.tsx:21` | 0 | 60 wakes/h | C |
| 10 | Collections tab: `/v1/collections/status` + `/v1/collections/releases?limit=1…` (conditional) | 60 s each | `Collections.tsx:392-394` | **120** (M: harness counted 60 + 60 over one simulated hour) | — | M |
| 11 | Collections manga detail with a bind request pending: re-read `bindings/requests` | 60 s | `CollectionBindings.tsx:59` | 60 (while shown) | — | C |
| 12 | Catalog tab: `/v1/mobile-catalog/status` (conditional) | 30 s | `Catalog.tsx:106` | 120 | Plus the `useNow` 30 s UI timer (`CatalogRefresh.tsx:84-86`): 120 wakes/h; bookmark outbox flush every 30 s while something is pending (`useBookmarks.ts:116`) | C |
| 13 | Notes tab (unlocked): `GET /v1/notes/<vault>?after=…` (**unconditional**) | 60 s | `Notes.tsx:119`; `NotesRepository.java:181` | 60 | — | C |
| 14 | Exchange (보내기/받기) screen open: inbox + outbox reads | 5 s | `ExchangeService.java:37,229-234,299-301` | 1,440 (while open) | — | C |
| 15 | Trash screen / Album editor / Classification editor open: native state reads | 5 s | `LibraryTrash.tsx:14,73`; `AlbumMembershipEditor.tsx:54`; `ClassificationAssignmentEditor.tsx:174` | 0 | The Trash screen repeats the full replica parse (#4) every 5 s | C |
| 16 | Native media cache age sweep | Hourly, on the next cache write | `ThumbnailCache.java:26,44-53,56-58` | 0 | Stats ~10k files under the cache monitor. Every cached image read also rewrites its mtime (`ThumbnailCache.java:101-110`). | C |

**Idle totals per foreground hour (C/E, excluding one-off walks):**

| Tab left open | Network req/h | Full replica parses/h | JS/native timer wakes/h |
|---|---|---|---|
| Home | 60 status + 60 list-gen + 60 characters = **180** | 60 + 240 = **300** | ~420 |
| Collections | 120 + 120 = **240** | 300 | ~360 |
| Catalog | 120 + 120 = **240** | 300 | ~480 |
| Notes | 120 + 60 = **180** | 300 | ~360 |

Add one full Picker walk (~94 requests, ~3.9 MB) per resume after ≥15 min away, and a 9,300-call warm-up pass once a day. The native pass (60 s), the JS polls (60 s / 30 s) and the 15 s trash poll are independent timers with unaligned phases. The device therefore wakes several times a minute instead of once.

With the screen on, the display dominates battery. The items above most likely to matter measurably are the CPU work in #3 and #4 (~300 full parses per hour) and the repeated Picker walks in #5. Their real share has to come from the per-thread CPU measurement in §5 (M3).

---

### 2. Root causes

#### 2.1 BIND-POLL-001: tablet connect requests are picked up slowly (C, high confidence)

The tablet files `POST /v1/collections/bindings/requests`. The chain before the tablet shows "연결됨":

1. **PC pickup.** The desktop's publication tick fires every 10 s (`workload.rs:527-535`) and dispatches the `bindings` lane (`auto_publication.rs:67`). That lane is throttled by a durable `last_polled` stamp kept in `notes_state` (`collection_binding_sync.rs:51` `POLL_SECONDS = 60`, check at `:379`). A request therefore waits **0–70 s (mean ~35 s)** before the PC reads `GET …/bindings/log`. The PC's shared status pass (`authority_pass.rs`, which reads `/v1/sync/status` every 5 → 60 s) knows nothing about bind requests.
2. **Apply**: MangaDex/Kakao lookups; duration unknown (D).
3. **Republish.** The applied binding changes `collection_external_bindings`. Triggers from migration 0074 (`0074_mobile_publication.sql:58-72`) mark the Collections lane dirty. The lane publishes only after **30 s without further changes** (`auto_publication.rs:92`, `last_dirty<=unixepoch()-30`), on a 10 s tick.
4. **Tablet sees it.** While a request is pending, the detail re-reads the request list only every **60 s** (`CollectionBindings.tsx:59`). The republished detail arrives through the 60 s `/v1/collections/status` poll (`Collections.tsx:394`).

End to end (E): about 100 s on average, 170 s+ at worst plus the apply time. The backlog's "10–60 s" covers step 1 only.

**The planned fix and its limit.** Put a bind-request signal (for example the log's `lastSequence` or a pending count) into `/v1/sync/status`, which the PC already reads with an ETag. Wake the bindings lane when the signal moves and drop the separate once-a-minute `bindings/log` poll. That removes ~60 idle requests per hour. It does **not** shorten average pickup by itself, because the PC's status pass also backs off to 60 s when idle. Faster pickup needs one of:

- (a) a lower idle cap on the PC status pass;
- (b) a long-poll `GET /v1/sync/status?wait=N`: the server holds the request until the ETag changes. At N = 60 this gives ~1 s pickup with the same request count;
- (c) accepting ≤60 s at the PC and fixing only the tablet side (re-read 5 → 10 → 20 → 30 s while pending instead of 60 s).

Two design traps:

- The PC reads status with the shared Library token, so the signal can ride on the same aggregate. However, the **tablet** treats any change to the status document, apart from the `exchange` field, as a Library change (`SyncStatusPass.java:16-33`). That sets `passChanged` and forces a **full Picker walk** (`AlbumReplicaService.java:360-366`). The new field must either be excluded on the tablet the way `exchange` is, or be reported only to publisher credentials (the way `exchange` is reported only to device credentials, `sync_status.py:51-70`).
- The 30 s publication debounce (step 3) adds its own delay after the apply.

#### 2.2 Collections covers stay blank after a cold start, then load quickly after visiting other screens (MOBILE-PERF-002 / USER-REQ-20260926)

Cover sources (read-only count of the Linux library, 2026-09-26: 388 games, 149 manga, 13 movies): nearly every card goes through `native('collectionArtwork')`. Games use PC `collection-sources` covers published as artwork (`cloud/collections.rs:456-458`). None use `coverAssetId`. The default tab is 게임.

The path of one uncached cover (C):

1. JS queue: at most **4** artwork requests in flight (`Collections.tsx:51-61`).
2. Native `mediaWorkers`: **4 threads, FIFO, queue of 24** (`MainActivity.java:18`). This pool is shared with Library/Home thumbnails (JS allows 10 visible + 3 prefetch/warm-up), originals and Catalog covers (4) (`MainActivity.java:226`).
3. `MediaRepository.collectionArtwork` (`MediaRepository.java:194-207`):
   - `scopedIdentity`: a **Keystore decrypt of the connection (`SecureSettings.read`, `SecureSettings.java:20-24`) while holding the global `CONNECTION_LOCK`** (`MediaRepository.java:38-49`), even for a cache hit;
   - on a miss, a **separate, unbatched** `POST /v1/collections/{id}/artworks/{aid}/media-ticket`, which is a second Keystore read. On the server this costs one R2 HEAD (`mobile_collections.py:597-615`). The HEAD cache TTL is only 30 s (`head_cache.py:32`), so after a cold start the cache is always cold;
   - the R2 download (1.5–2.4 s, MOBILE-PERF-002) while **holding the worker thread**.

What was measured (M, harness, 2 s per uncached cover, 16 first-screen covers): **peak 4 in flight, first cover at 2.0 s, all 16 at 8.0 s**. The server side of a cold artwork ticket is 1 R2 HEAD (M). With a modeled 150 ms HEAD, the ticket takes 153 ms instead of 2.5 ms (M, `--head-latency-ms 150`).

**Most likely cause of "stays blank until I visit another screen" (C, medium-high confidence; confirm with the M1 screenshot):** a cover that fails once is never retried while it stays on screen. `Artwork` sets `failed` (`Collections.tsx:91-103`). The effect re-runs only when `[source, active, visible]` changes, so **switching tabs (active false → true) is exactly what retries it**. That matches the user's report.

At cold start, failures are likely because the native pool overflows:

- **Cancelled work stays queued.** Home/Library covers and tiles abort when you leave the tab, which frees their JS slots. Their native tasks stay in the 24-slot FIFO until a worker reaches them, while the warm-up keeps adding work (#6).
- **Overflow is a failure, not a wait.** Past 4 running + 24 queued, `execute` throws `RejectedExecutionException` and JS receives the error "요청이 많습니다" (`MainActivity.java:226`). The failed placeholder reads "이미지를 불러오지 못했습니다".
- **Other failures stick the same way:** the 45 s bridge timeout in JS (`transport.ts:57`), a native "Media busy" (180 s lock/permit deadline, `MediaRepository.java:145,159`), and "Media tickets busy" (`TicketBatcher.java:80`).

Home covers fail the same way: `Cover` in `CoverGroup.tsx:10-15` ignores errors and keeps the placeholder icon until `source` or `paused` changes.

**Contributing slowness, even without failures (C/E):**

- The first screen needs about ⌈16/4⌉ × (ticket RTT + cold HEAD + ~2 s R2) ≈ **8–10 s**. The Collections pipeline allows only 4 concurrent requests and the Library pipeline 13, but everything shares 4 native threads, and each miss holds a thread for the whole download.
- Cold-start bursts compete with the first Collections visit:
  - the Picker full walk starts **immediately on resume** (#5, ~94 sequential API calls, each one a Keystore read);
  - the thumbnail warm-up starts at +5 s whenever a daily pass is due or a previous pass failed (#6: 9,300 native calls, each one a Keystore read under `CONNECTION_LOCK`);
  - Home thumbnails and the first native pass also run.

  After these bursts drain, a revisit is fast because the covers the first visit managed to fetch are now disk-cache hits.
- **Main-thread cold-start work (C):**
  - `MediaRepository.get` in `onCreate` (`MainActivity.java:77`) builds `ThumbnailCache`, which lists and stats every cached file (~10k) on the UI thread (`ThumbnailCache.java:28-33`, `index()`);
  - `PickerLibrary.get` in `onResume` (`MainActivity.java:337`) reads and decodes the whole saved picker snapshot JSON on the UI thread (`PickerLibrary.java:33,36`).
- **Possible duplicate first load (C, low confidence):** the native first pass always reports a "new" list generation at cold start (`assetListGeneration` starts empty, `AlbumReplicaService.java:358-363`). If that event reaches JS before the first Home load has recorded its generation, `App.tsx:220-237` reloads the page and calls `clearMediaCache()`.

Why the problem might show "only right after installing a new build" could not be confirmed from code. The native cache and warm-up progress survive `adb install -r`. A first launch after an update also pays ART and WebView re-optimization, and it is often the first launch in >24 h, which makes the daily warm-up pass due.

---

### 3. Cloud API endpoints (M: in-process, `endpoint_perf.py`)

Conditions:

- Linux desktop, Python 3.14 `.venv`, FastAPI TestClient (no TLS or network), 40 runs after 4 warm-up runs.
- Synthetic fixture: 9,200 Assets, 600 Classifications, 3,000 changes per domain, 3,000-work catalog, 400 bookmarks.
- Collections: 550 works shaped like the Linux library (388 games, 149 manga with 0–104 volumes, 13 movies; 1,730 artworks; largest detail 17.7 KB). Thumbnail keys are content-addressed like production.
- The framework floor (no-op route) is 0.6 ms (`poll_benchmark.py`).

Statement counts include 3 setup statements per SQLite connection: every `get_db()` opens a new connection and recreates the `visible_assets` temp view (`app.py:51-59`, `asset_visibility.py:43-51`).

| Endpoint (who calls it) | Status | p50 / p95 ms | SQL stmts (writes) | Conns | R2 HEADs | Bytes |
|---|---|---|---|---|---|---|
| `GET /v1/sync/status`, device token, 304 (tablet pass) | 304 | 2.56 / 2.85 | 10 (0) | 2 | 0 | 0 |
| `GET /v1/sync/status`, device token, 200 | 200 | 2.58 / 2.74 | 10 (0) | 2 | 0 | 558 |
| `GET /v1/library/list-generation` (tablet pass, every page load ×2, Picker walk ×2) | 200 | 1.55 / 1.61 | 9 (0) | 1 | 0 | 99 |
| `GET /v1/library/characters/status` (Home/Library idle) | 200 | 1.51 / 1.71 | 4 | 1 | 0 | 17 |
| `GET /v1/collections/status` (Collections idle) | 200 | 1.56 / 1.74 | 7 | 1 | 0 | 292 |
| `GET /v1/collections/releases?limit=1…` 304 (Collections idle) | 304 | 1.68 / 1.88 | 8 | 1 | 0 | 0 |
| `GET /v1/mobile-catalog/status` 304 (Catalog idle) | 304 | 2.56 / 2.67 | 12 | 2 | 0 | 0 |
| `GET /v1/collections/bindings/log` 304 (PC, 1/min) | 304 | 2.61 / 2.71 | 12 | 2 | 0 | 0 |
| `GET /v1/collections/bindings/requests?collectionId` (tablet bind wait) | 200 | 1.62 / 1.76 | 7 | 1 | 0 | 65 |
| `GET /v1/library/assets?limit=40` first page | 200 | 3.53 / 3.64 | 6 | 1 | 0 | 16,963 |
| `GET /v1/library/assets?limit=40` page 51 (cursor) | 200 | 3.85 / 4.13 | 6 | 1 | 0 | 16,912 |
| `GET /v1/library/assets?limit=100` (warm-up / Picker page) | 200 | 5.58 / 6.05 | 6 | 1 | 0 | 42,070 |
| `GET /v1/library/classifications` (Picker walk) | 200 | 20.15 / 21.88 | 10 | 1 | 0 | 85,580 |
| `POST /v1/library/media-tickets?verify_digest=true`, 50 thumbnails, HEAD cache cold | 200 | 7.42 / 7.87 | 4 | 1 | **49** | 14,448 |
| same, HEAD cache warm (<30 s) | 200 | 7.07 / 8.12 | 4 | 1 | 0 | 14,448 |
| same, 50 originals, cold | 200 | 8.29 / 9.01 | 4 | 1 | **49** | 14,440 |
| `GET /v1/collections?type=game…media_date desc` page 1 (48 items) | 200 | 6.45 / 6.78 | 8 | 1 | 0 | 39,206 |
| same, page 2 (cursor) | 200 | 6.79 / 7.11 | 8 | 1 | 0 | 39,200 |
| `GET /v1/collections?type=manga&rating=4.5` | 200 | 6.00 / 6.26 | 8 | 1 | 0 | 11,884 |
| `GET /v1/collections?…showcase=true` | 200 | 3.34 / 3.58 | 8 | 1 | 0 | 13,219 |
| `GET /v1/collections/{104-volume manga}` detail | 200 | 3.82 / 5.54 | 7 | 1 | 0 | 18,016 |
| `POST …/artworks/cover/media-ticket`, HEAD cache cold | 200 | 3.07 / 3.71 | 5 | 1 | **1** | 270 |
| same, HEAD cache warm | 200 | 2.50 / 3.39 | 5 | 1 | 0 | 270 |
| `GET /v1/mobile-catalog/search` default (hotDay, korean, 40) | 200 | 13.39 / 28.93 | **433 (400 temp inserts)** | 5 | 0 | 13,732 |
| `GET /v1/mobile-catalog/search` with text | 200 | 8.62 / 19.46 | 430 (400) | 5 | 0 | 1,475 |
| **Walk** of all `/v1/library/assets?limit=100` pages (Picker snapshot / warm-up) | — | 563 ms total | 546 | 91 | 0 | 3,792,000 (91 pages) |

Modeled R2 HEAD latency (`--head-latency-ms 150`; a model, not an R2 measurement): a cold 50-thumbnail ticket batch takes **1,063 ms vs 7 ms warm** (49 HEADs over 8 server threads). A cold artwork ticket takes **153 ms vs 2.2 ms**.

Reading:

- **Server CPU is not the tablet's bottleneck.** Every handler is 1.5–20 ms, while a tablet round trip is ~70–100 ms (MOBILE-PERF-002) and an uncached R2 object 1.5–2.4 s. The server-side levers are:
  - **R2 HEADs per ticket.** Cold is 1 per item. The 30 s TTL means a cold start always pays them. The real server→R2 HEAD latency is unmeasured.
  - **Sequential round trips** the client makes. A Library page load is list-gen → page → list-gen (`App.tsx:168,187-193`): 3 serial round trips.
  - **Whole-Library walks**: Picker and warm-up.
- The catalog search copies every bookmark into a per-request temp table (`CREATE TEMP TABLE online_catalog_bookmarks` + one `INSERT` per bookmark: 400 in the fixture). The cost grows with the bookmark count. Its p95 (29 ms) is the noisiest route.

---

### 4. Top optimization candidates (tablet + Cloud API)

The gate metric for each is deterministic; wall time is reported only alongside it.

| Rank | Candidate | Expected user-visible gain | Deterministic gate metric | Risk | Size | Files |
|---|---|---|---|---|---|---|
| 1 | **Retry failed/rejected covers and thumbnails while they stay visible** (bounded backoff, e.g. 2/5/15 s). Make native "busy" a wait, not a failure: drop cancelled tasks from the queue (cancel-aware or priority queue) or make overflow a retryable code JS re-queues. | Collections/Home covers no longer stay blank after a cold start until the user changes tabs. **Confirm the cause first with M1** (placeholder text and `status=rejected`). | Harness with injected rejection: covers still failed after 30 simulated s = 0. Device: `status=rejected` lines during a cold start = 0; time until all first-screen covers show (M1 video). | Low | S | `Collections.tsx:86-108`, `CoverGroup.tsx`, `media.ts`, `MainActivity.java:18,226` |
| 2 | **Faster cover pipeline:** batch artwork tickets (like `/v1/library/media-tickets`); skip or long-cache the server R2 HEAD for content-addressed `work-artwork/mobile/<sha>` keys already confirmed in `mobile_collection_artwork`; give Collections/Catalog their own native lane or raise concurrency so the warm-up cannot starve them. | First screen of Collections covers ~8–10 s → ~2–4 s on a cold cache (E). | Harness `allFirstScreenMs` at 2 s per cover: 8000 → ≤4000. `endpoint_perf.py` `r2_heads` per artwork ticket: 1 → 0. Artwork ticket requests per first screen: 16 → 1. | Low–med | M | `Collections.tsx:51-61`, `MediaRepository.java:194-207`, `mobile_collections.py:597-615`, `head_cache.py` |
| 3 | **Stop parsing the whole asset replica on idle paths:** read only the header row for `available` and for the cursor check; drive the lifecycle state from events or pending rows instead of a 15 s poll. | Less idle CPU and battery on every tab (~300 full 9,300-row parses/h → ~0). Nothing visible besides battery. | Replica full-row reads per idle hour: 300 → ≤1 (a counter in the JVM replica tests). JS harness: `assetLifecycleState` calls per idle hour 240 → 0 when nothing is pending. Device: per-thread CPU time over 10 idle min (M3). | Low | S | `useLibraryTrash.tsx:47-50`, `AlbumReplicaService.java:964-980`, `AndroidReplicaDb.java:75-84`, `AssetReplica.java:46-55` |
| 4 | **Picker snapshot: skip the walk when nothing changed.** Store the server list generation and the Album cursor with the snapshot; walk only when they moved. Optionally walk only when Lakomics is the selected cloud media provider or the picker queries. | Cold-start network contention drops (~94 requests and ~3.9 MB per resume); less data and battery. | Requests per resume on an unchanged library: 94 → 1–2. Walks per hour while the PC imports: ≤1. Server per walk: 546 statements, 3.8 MB (M). | Medium (picker freshness) | S–M | `PickerLibrary.java:39-96`, `PickerRefreshSchedule.java`, `AlbumReplicaService.java:360-366,390` |
| 5 | **Cache the decrypted connection in memory** (cleared on configure/disconnect) so media scope checks and API calls stop doing a Keystore decrypt under `CONNECTION_LOCK`. **Keep warm-up progress on transient errors** and warm only assets newer than the last pass instead of a daily 9,300-call re-walk. | Faster cache-hit thumbnails and covers during bursts. Warm-up no longer ties up the media lane for minutes. | Keystore operations per cached thumbnail hit: 1 → 0. Harness `pagesTotal` after one failure: 134 → 93. Native calls per daily pass: 9,300 → new assets only. Device: native `thumbnail cache=hit` (totalMs − queueMs) median (M4). | Low–med (credential lifetime in memory) | S | `SecureSettings.java:20-24`, `MediaRepository.java:38-49,57-70`, `thumbnailWarm.ts:47-72` |
| 6 | **Coalesce idle polls** into the one conditional `/v1/sync/status` read: list generation, Collections publication and release revisions, the character revision, and the Notes revision. Catalog status 30 s → 60 s. | Idle requests per hour: Home 180 → ~60, Collections 240 → ~60, Catalog 240 → ~60 (E). Fewer wakes. | Harness: Collections idle hour 120 → 0 beyond the native status. Device/server access log: requests per 15 idle minutes per tab. | Medium: cross-client contract. The tablet must not treat the new fields as Library changes (`SyncStatusPass.java:16-33`), or each change forces a Picker walk. | M | `sync_status.py`, `AlbumReplicaService.java:259-368`, `usePublicationCheck.ts`, `Collections.tsx:392-394`, `App.tsx:486`, `Notes.tsx:119`, `Catalog.tsx:106` |
| 7 | **BIND-POLL-001:** a publisher-only bind signal in `/v1/sync/status`; the PC wakes the bindings lane on it and drops the 60 s log poll. The tablet re-reads 5/10/20/30 s while a request is pending. Long-poll `?wait=` if <10 s pickup is required. | Pick → "연결됨" from ~100 s mean (E) to ≤~60 s (fold plus tablet), or a few seconds with long-poll. | PC `bindings/log` requests per idle 15 min: 15 → 0. Measured pickup delay (M6). | Medium | M | `sync_status.py`, `collection_bindings.py:1013-1050`, `collection_binding_sync.rs:51,379`, `authority_pass.rs`, `CollectionBindings.tsx:59` |
| 8 | **One round trip per Library page:** return the list generation in the page envelope, computed in the same read transaction, instead of list-gen → page → list-gen. | Each Library/Home navigation −2 round trips (~150–250 ms on the tablet, E). | API requests per navigation: 3 → 1 (App test counting `api` calls). | Medium: keep the mid-traversal consistency guarantee. | S–M | `App.tsx:160-199`, `listGeneration.ts`, `app.py:1913+` (`/v1/library/assets`) |
| 9 | **Longer HEAD cache for immutable keys, or no HEAD:** store derived thumbnail size and type at derivation; TTL of hours for content-addressed keys. | First view after a cold start: each 50-thumbnail ticket batch skips up to 49 R2 HEADs (1.06 s at a modeled 150 ms HEAD). | `endpoint_perf.py` `r2_heads` for a repeated batch within an hour: 49 → 0. Device: LakomicsPerf `batch=…:httpMs` cold vs warm. | Low–med: a deleted object stays ticketed until expiry. The client's existing `fresh_head` retry covers it. | S | `head_cache.py:32`, `app.py:2508-2522`, `image_thumbnails.py` |
| 10 | **Move cold-start disk work off the UI thread:** the ThumbnailCache directory scan and the Picker snapshot load. | Faster first frame (D: `am start -W`). | Main-thread disk reads during startup = 0 (StrictMode in a debug build). `TotalTime` median over 5 cold starts. | Low | S | `MainActivity.java:77,337`, `ThumbnailCache.java:28-33`, `PickerLibrary.java:33,36` |

Lower priority, measured but small:

- Catalog search copies bookmarks into a temp table per request (433 statements; grows with bookmarks).
- Every request opens fresh SQLite connections and recreates a temp view (2–5 connections per request).
- Notes and list-generation reads are unconditional; they could use an ETag.

---

### 5. Device measurement plan (controller, over adb)

Setup:

```sh
adb connect <tablet-ip>:<port>            # port changes; ask the user
T="-s <tablet-ip>:<port>"
adb $T shell dumpsys package com.lakomics.mobile | grep -m2 -E 'versionName|userId='   # expect 0.8.27; note userId (UID)
adb $T shell settings put global stay_on_while_plugged_in 7   # keep the screen on during idle windows (restore afterwards)
```

**M1: Collections cold-start covers.** Answers §2.2 and candidates 1, 2 and 5.

1. Scenario A (as the user sees it):
   ```sh
   adb $T shell am force-stop com.lakomics.mobile; adb $T logcat -c
   adb $T shell screenrecord --time-limit 45 /sdcard/cold-a.mp4 &
   adb $T shell am start -W -n com.lakomics.mobile/.MainActivity     # read TotalTime
   ```
   When Home shows (~2 s), tap **Collections** (게임). Do not scroll.
2. Take screenshots 5 s and 20 s after the tap:
   ```sh
   adb $T exec-out screencap -p > a-05s.png
   adb $T exec-out screencap -p > a-20s.png
   ```
3. At 45 s:
   ```sh
   adb $T logcat -d -s LakomicsPerf > cold-a.log
   adb $T pull /sdcard/cold-a.mp4
   ```
4. Read:
   - **Placeholder text of each blank cover.** "표지" means still waiting (queue or slowness). "이미지를 불러오지 못했습니다" means failed and never retried (candidate 1). This single observation decides between the two causes.
   - From the video: time from the tap until every first-screen cover is visible. Step frames in any player.
   - `python3 android/tools/perf_summary.py cold-a.log`: native/thumbnail `cache=hit|miss` counts, `queueMs` median/p90 and `totalMs`.
   - `grep -c 'status=rejected' cold-a.log`, and the maximum `queued=` value:
     ```sh
     grep -o 'queued=[0-9]*' cold-a.log | sort -t= -k2 -n | tail -1
     ```
     Collection artwork operations are not logged themselves, but `queued=` counts them.
   - The number of `thumbnail` lines in the first 30 s with no matching `js event` lines is the warm-up volume.
5. Scenario B: the same, but wait **120 s on Home** before tapping Collections (startup bursts drained).
6. Scenario C: Settings → turn off the thumbnail warm-up (썸네일 미리 받기), force-stop, repeat A. Turn it back on afterwards.
7. Scenario D: in the same session as A, go to Library and back to Collections, then record the time until covers show (the user's "fast" case).

Expectation: if A ≫ B ≈ D, startup contention is the cause. If A ≫ C, the warm-up specifically is. Rejections or failed text point to candidate 1.

**M2: idle requests per tab (battery).**

For each of Home, Collections, Catalog and Notes: open the tab, leave it untouched for **15 min**, and count the tablet's requests. Most precise: the server access log for the tablet's IP or token (read-only) over the same window. On the device:

```sh
adb $T shell dumpsys netstats detail | grep -A4 "uid=<UID>"
```

Run it before and after, and diff rxBytes/txBytes/rxPackets/txPackets.

Expected from code, per 15 min: Home ≈ 45, Collections ≈ 60, Catalog ≈ 60, Notes ≈ 45. Add ~94 on the first resume after ≥15 min away (Picker walk). To measure the walk alone: background the app for 16 min, resume on Home, and count requests in the first 60 s.

**M3: idle CPU per thread** (candidate 3):

```sh
PID=$(adb $T shell pidof com.lakomics.mobile)
adb $T shell ps -T -p $PID -o TID,NAME,TIME > t0.txt
### Home, untouched for 10 min
adb $T shell ps -T -p $PID -o TID,NAME,TIME > t1.txt
```

Diff TIME per thread. Look at `lakomics-album-r` (the native pass), `pool-*` (the bridge `workers` that run the 15 s lifecycle reads) and the main thread.

Alternative:

```sh
adb $T shell dumpsys batterystats --reset
### 30 idle min on Home
adb $T shell dumpsys batterystats com.lakomics.mobile > bs.txt
```

Read the UID's CPU user/system time and Wi‑Fi packets.

Expected (E): ~300 full replica parses/h × 50–150 ms ≈ 15–45 s CPU per hour.

**M4: Keystore cost per cached media request** (candidate 5):

```sh
adb $T logcat -c
### scroll a Library grid of already-seen images for 20 s
adb $T logcat -d -s LakomicsPerf > hits.log
python3 android/tools/perf_summary.py hits.log
```

For `native/thumbnail cache=hit`, (totalMs − queueMs − lockMs) ≈ the Keystore decrypt under `CONNECTION_LOCK` plus a file stat. A median ≥5 ms, or growth with `inflightThumb`, confirms the serialization.

**M5: cold start to first frame** (candidate 10):

```sh
for i in 1 2 3 4 5; do
  adb $T shell am force-stop com.lakomics.mobile
  sleep 2
  adb $T shell am start -W -n com.lakomics.mobile/.MainActivity | grep TotalTime
done
```

Also note the cache file count shown in Settings (cache status). The UI-thread scan cost grows with it.

**M6: BIND-POLL-001 pickup.** On the tablet, open a manga → 연결 → MangaDex, pick one, and note the time T0. Record when the row shows "PC에서 적용됨" or "연결됨" (T1). Repeat 3×, with the PC idle and its window unfocused.

From the server access log (read-only), record:
- the POST `…/bindings/requests` time,
- the next PC `GET …/bindings/log` time (pickup),
- the PC `POST …/requests/{id}/result` time (apply),
- the PC `PUT /v1/collections/replica` time (republish).

Expected: pickup 0–70 s, republish ≥30 s after the apply, and tablet display up to 60 s after that.

Optional: the server→R2 HEAD latency (the cold-ticket cost in candidates 2 and 9) is read from `batch=<id>:<size>:<httpMs>` on `thumbnail cache=miss` lines in M1. Compare the first batch after a cold start with a repeat within 30 s.

---

### 6. Checks run

- `server/lakomics-api/.venv/bin/python tools/poll_benchmark.py --runs 30 --warmup 5`: ran, 21 endpoints, baseline matches §3.
- `.venv/bin/python tools/endpoint_perf.py --runs 40 --warmup 4 --json <scratchpad>/perf/endpoint-perf.json`: ran; results in §3. A second run with `--runs 5 --head-latency-ms 150` gave the modeled HEAD numbers.
- A scratch SQL trace of the catalog search (scratchpad `perf/catalog_trace.py`) found the 400 temp-table inserts.
- `npx vitest run --config vitest.mobile.config.ts mobile-client/Collections.perf.test.tsx mobile-client/thumbnailWarm.perf.test.ts`: 2 files, 4 tests passed. Metric lines:
  - `[perf] collections cold covers: firstScreen=16 requested=16 peakConcurrent=4 firstCoverMs=2000 allFirstScreenMs=8000`
  - `[perf] collections idle hour: /v1/collections/releases=60 /v1/collections/status=60 total=120`
  - `[perf] warm-up full pass (9300 assets): apiPages=93 nativeStatus=93 nativeThumbnail=9300`
  - `[perf] warm-up after one failed page at 4000/9300: pagesBeforeFailure=41 pagesTotal=134 retryStartsAt=first page nativeThumbnail=13300`
- JVM microbenchmark (scratchpad only; compiles `Json.java`, `AssetReplica.java` and `AlbumReplica.java` unchanged): the full 9,300-row replica parse took 25.4 ms best, 26.6 ms median and 213 ms on the first run (desktop JDK 17).
- Read-only count of the Linux library DB (opened `mode=ro&immutable=1`, nothing written): 9,300 Assets; Collections 388/149/13; volume and artwork spread; overview text sizes.
- Not run: the full mobile vitest suite, the Android JVM tests, the APK build, any device, the production server or R2.
