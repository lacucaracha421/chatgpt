# Heavy-load performance audit and fix plan (2026-11-10)

Backlog item: [`PERF-AUDIT-20261110`](../roadmap/lakomics-backlog.md#perf-audit-20261110).
Source: `main` at `57c2a35e`. Question: where does Lakomics degrade when many jobs run at once, or when many heavy images, videos or WebGL covers load together?

## Method and evidence level

- **Round 1:** six parallel read-only audits.
  - Codex Sol `gpt-6.1-sol` medium covered background job concurrency and database/filesystem contention.
  - Claude Opus subagents covered the image pipeline, the video pipeline, 3D/WebGL and card rendering, and tablet/server/PC→cloud.
- **Round 2:** adversarial re-verification by a different worker for each area. Sol re-checked video, cards, image and tablet; Claude re-checked jobs and database. The controller read the source of the top claims and of the round-2 additions.
- **Not measured.** Nothing was run, profiled or measured. Every impact rating below is a static judgement. Under [Performance work](../agents/implementation.md#performance-work), each item is a suspected cost until stage 0 measures it. Items marked *confirmed* are confirmed mechanisms, not measured latencies.
- This does not repeat [`PERF-AUDIT-20261029`](../roadmap/lakomics-backlog.md#perf-audit-20261029), whose items 1–8 were partly fixed by `bb493307`, `78cab78e`, `ab181315`, `f1f40486`, `afbf8a11`, `bd974329`, `3d926468` and `1be7a1a1`. Where an item here continues one of those, it says so.

Path abbreviations: `R/` = `_tools/app/src-tauri/src/`, `F/` = `_tools/app/src/`, `M/` = `_tools/app/mobile-client/`, `A/` = `android/src/com/lakomics/mobile/`, `S/` = `server/lakomics-api/`.

## Verdicts

Verdict: **C** confirmed, **P** partial (real, but narrower than first claimed), **U** uncertain (needs measurement), **R** refuted.
Impact (H/M/L) and effort (S/M/L) are after re-verification.

### Background jobs (J)

| ID | V | Imp | Eff | Finding (after re-verification) | Evidence |
| --- | --- | --- | --- | --- | --- |
| J1 | P | L–M | S | All 12 publication lanes come due together on first use and every 10 min. Authority, asset materialization and replication start without waiting for launch settling. No shared admission budget. Each forced lane mostly does a DB check plus a conditional poll. | `R/cloud/auto_publication/schedule.rs:40-48`; `R/workload.rs:763-881` |
| J2 | C | M | S→M | The nightly auto-tag inbox import holds the global `connection()` for the whole replacement and tagger-review apply. It first runs about 120 s after library open, so every lock user stalls for the length of the import. | `R/library/auto_tag_inbox.rs:215-235,292-316`; `R/library/auto_tags.rs:394-498` |
| J3 | P | L | S/M | The CPU baseline character sessions are hard-coded to 6/1 threads. On the main PC the baseline runs on DirectML, so the cost applies only to the laptop, 절약 모드 manual scans or a DirectML fallback. The thread counts are part of a frozen extraction contract, so the holdout must be re-checked first. | `_tools/app/character-runtime/runtime.py:136-141`; `gpu_providers.py:35` |
| J4 | P | L | S | Card cutouts check only the incremental-character flag. A manual scan or curation can run beside the cutout model. The NL-search prewarm part is unreachable while NL search is paused (`enabled.json` false since 2026-10-17). | `R/card_cutouts/job.rs:44-51`; `R/library/mod.rs:226` |
| J5 | C | L | S | Artist-style ranking (about 7 s on one core) cannot pause and ignores restricted mode. It holds no library lock. | `R/library/artist_style.rs:544-566` |
| J6 | P | L–M | S/M | The per-target comparison is cheap. The real cost: while the auto-compare queue has rows the lane is due on every 10 s tick, and each batch reloads every comparable asset row under the global lock. That queue fills during imports. | `R/library/similarity_scan.rs:214-289`; `schedule.rs:356-361` |
| J7 | P | L | S | The work-artwork thumbnail backfill starts at library open and on recovery, with no launch settling and no single-flight guard. In steady state it is one SELECT plus an `exists()` per artwork. An undecodable artwork is re-read on every open. | `R/library/mod.rs:497`; `work_artwork.rs:629-711` |
| J8 = V7 | C | M | S | A video similarity re-scan SHA-256 hashes each whole source before the fingerprint cache lookup. That is up to 100 × 2 GiB, with a 60 s per-source deadline, so slow disks time out. Safe to reorder: review acceptance re-hashes both files before any destructive decision. | `R/library/video_similarity/scan.rs:444-457`; `review.rs:147-160` |

### Database and filesystem (D)

| ID | V | Imp | Eff | Finding | Evidence |
| --- | --- | --- | --- | --- | --- |
| D1 | P | M | S–M | Non-async `#[tauri::command]` functions run inline on the Windows UI thread (tauri-macros 2.6.3 `Blocking`; wry WebView2 callbacks), so a lock wait there stalls all IPC and `lakomics://` dispatch. Of the cited examples, only `list_collection_covers` (lock held through `read_dir` and sort) is hot. The hot sync lock-takers are: `get_video_similarity_scan` (polled every 1.2 s, 5 COUNT subqueries), `list_manga_series` (every Manga tab mount), `set_asset_classification` (folder drag), `patch_asset_collections`, and the reads that fire on collection-overlay open. | `R/commands.rs`; `F/.../VideoSimilarityPanel.tsx:71-88`; `MangaBrowser.tsx:99`; `R/library/collection_source.rs:356-402` |
| D2 | C | M | M | Grid queries (`list_assets`, refresh, date buckets, creators) still take the global lock plus a fresh connection. They run off the UI thread, so a busy lock makes them slower but does not freeze the UI. `bb493307` never targeted these. A fix must keep count-cache correctness: capture the generation before the snapshot and use one read transaction per call. | `R/library/query.rs:347,378,690,719`; `mod.rs:595-674`; `asset_count_cache.rs` |
| D3 | R | — | — | The character review save does not hash files. Every UI caller sends `scanId: null`, so the hashing path is dead code (`predictionRequest`, `character_review_page`). | `F/characters/confirmSave.ts:15-17`; `R/library/characters.rs:1635` |
| D4 | P | M | M | The cited catalog-count path is rare, but **every catalog review decision** (`decide_catalog_review`) runs a full membership rebuild under the lock. That rebuild reads about 132k works plus lineage analysis. Duplicate-decision sync rebuilds once or twice per withdrawn pair, then once more, all inside one transaction. | `R/library/catalog_review.rs:914`; `catalog_duplicate_sync.rs:370,378,654,675`; `catalog_groups.rs` |
| D5 | P | L | M | A baseline authority apply is one large transaction, but it only happens on first adoption, a server restore or a cursor rejection (180-day retention). Keep it atomic; no change now. | `R/library/asset_authority.rs:766-929` |
| D6 = I4 | P | L | S | Media lookups share 4 pooled readers with occasional long readers. At most two long readers overlap in practice, so no starvation is expected. Measure only. | `R/library/media_reads.rs:21-112` |
| D7 | P | L–M | S | No `synchronous`, `journal_size_limit` or `wal_autocheckpoint` policy, and no checkpoint on quit. The bundled defaults are FULL sync, so every commit fsyncs while holding `database_lock`. The 54–62 MB WAL is a high-water mark that survives close and is recovered on the next launch. | `R/library/db.rs:209-213,266`; `backup.rs:136-147` |
| D8 | P | M (dup videos) | S–M | Ingestion copies and hashes the whole source into staging before the exact-duplicate lookup. Materialization already knows the sha256 and could check first. User imports could hash in place first, then re-check while copying. The per-asset transactions and `sync_all` calls are integrity requirements. | `R/library/ingestion.rs:124-230` |

### Video (V)

| ID | V | Imp | Eff | Finding | Evidence |
| --- | --- | --- | --- | --- | --- |
| V1 | P | M | M | `video_lock` is held across a whole preparation batch (5 from the frontend, 10 from manual jobs). That blocks "set frame as thumbnail" and uncached similarity work. Upload preparation contends only in restricted or hidden mode. Per-video locking shortens the wait but does not bound it. | `R/library/video_media.rs:378-403,174,547` |
| V2 | P | M | M | Scrub generation decodes through the whole file with automatic threads at normal priority. `-skip_frame nokey` is **not** safe blindly, because sparse keyframes can fail the completeness check. Lower priority and benchmark a thread cap. | `video_media.rs:309-328,956` |
| V3 | C | M | M | Preparation never yields to viewer playback and cannot be stopped: the cancel flag is always false and videos are not `can_stop`. | `video_media.rs:389,731`; `R/auto_jobs.rs:535`; `F/app/App.tsx:398-403` |
| V4 | C | M | S | The grid refreshes only after `prepare(5)` returns. Selection order is random (UUIDv4), so first video thumbnails arrive late and scattered. | `F/video/useVideoPreparation.ts:83,103`; `video_media.rs:586` |
| V5 | P | M | M | Timeline drag seeks on every change into the 2-slot Original pool. Browser coalescing is unknown. Measure obsolete requests first. | `F/video/VideoPlayer.tsx:354-359`; `R/media_protocol.rs:792-810` |
| V6 | C | M | S | Freeze canvases are allocated at source resolution and never shrunk (4K ≈ 32 MiB each while mounted). Shrink only after the replacement is presented (no-flash). | `F/video/VideoTileMedia.tsx:113-123`; `VideoPlayer.tsx:214-227` |
| V8 | C | L | M | Every library open enumerates the scrub folder of every ready video. Measure cold open before changing. | `R/library/mod.rs:487`; `video_media.rs:436-501` |
| V9 | P | L | S | Hover preview plays `/playback` (the original or the proxy) after 160 ms. There is one active preview. | `VideoTileMedia.tsx:53,228-236` |

### Image pipeline (I)

| ID | V | Imp | Eff | Finding | Evidence |
| --- | --- | --- | --- | --- | --- |
| I1 | P | M | M | Remote and provider image routes bypass the media queue (no permit, `spawn_blocking`). Each kHentai thumbnail takes the global lock, opens a fresh connection and ATTACHes kdata **before** the disk-cache check. Misses are not de-duplicated. Give these routes their own bounded class, not the local pool. | `R/media_protocol_queue.rs:29-40`; `R/library/online_catalog.rs:577-593` |
| I2 | P | M | M | Manga reader: 5-ahead plus previous-view preloads are originals in the 2-slot pool. Every `/manga-page/` request holds the lock through `read_dir`, `symlink_metadata` and a sort of the folder. Overview tiles are lazy. | `F/manga/PageViewer.tsx:194-197`; `R/library/mod.rs:804-823`; `manga.rs:487-516` |
| I3 | C | L | M | `Original` (2 slots) is a catch-all: originals, `/preview/` generation, playback, vault and small tile routes. Cold card previews can delay video reads. | `media_protocol_queue.rs:48-60`; `R/performance.rs:35` |
| I5 | P | L | M | Several cover routes still use `connection()`. Work-artwork, collection and manga covers carry no cache policy. `collectionCover.ts` omits the revision, so it gets `no-store`. | `R/library/mod.rs:780-795`; `R/media_protocol.rs:1048-1066`; `F/collections/collectionCover.ts:9` |
| I6 | P | M | M | Collection-source and missing artwork thumbnails decode full size on request with no pixel preflight. Concurrent cold misses (including `/preview/`) decode twice. `/preview/` has a 150 MP guard, but oversized inputs fall back to sending the original bytes. | `collection_source.rs:847-855`; `work_artwork.rs:702-711`; `preview.rs:169,274-296` |
| I7 | P | M | M | The PC viewer can keep current, next and previous originals decoded (hidden slots force `decode()`). Hover quick preview uses the original. Similarity review shows the pair only, not every member. | `F/assets/AssetViewer.tsx:499`; `F/shared/ui/StableImage.tsx:81-85,144` |
| I8 | C | M | M | FIFO within a view generation. Scrolling does not bump the generation, so departed tiles are served before newly visible ones. Unrestricted LIFO would starve; use bounded visible-first priority. | `media_protocol_queue.rs:80-88`; `F/assets/AssetGallery.tsx:407` |
| I9 | C | L | M | `cache/remote-manga/pages` and `catalog-thumbs` have no aggregate size or age eviction. | `R/library/remote_media.rs:96-156` |

### Cards and WebGL (C)

There is one WebGL2 context app-wide, and it is well managed. There are no glTF/Draco/KTX2 assets; the "3D" is a procedural paperback mesh.

| ID | V | Imp | Eff | Finding | Evidence |
| --- | --- | --- | --- | --- | --- |
| C1 | P | M | M | PC album art uses `/preview/{id}/1280` for local art (in-memory LRU of 48 entries / 128 MiB). Tile art needs its own size: `/preview` clamps to ≥640, so `/360` does not work. The tablet uses 360 → 768. | `R/commands/cards.rs:140`; `preview.rs:30,179,275` |
| C2 | P | L | S | The luminance mask loads a second, CORS copy and draws without `decode()`. Whether WebView2 refetches is unproven. | `F/cards/luminance.ts:7-29` |
| C3 | P | M | S | Every `TradingCard` runs 12 infinite mote animations, though only LR shows them. The album is not virtualized but shows one card per character. | `F/cards/TradingCard.tsx:77`; `cards.css:1243-1246` |
| C4 | P | L | S | Cover textures resolve on load without awaiting `decode()`. | `F/collections/physical/loadCoverImage.ts:17-19` |
| C5 | P | L | S | The bake producer is not scroll-gated. | `F/collections/physical/RenderCache.ts:76-79` |
| C6 | P | L | S | Finished reveal-effect canvases stay allocated until the pack closes (5 cards, DPR ≤ 2). | `F/cards/PackOpening.tsx:208,260`; `RevealEffects.tsx:17-29` |

### Tablet, server and PC→cloud (T)

| ID | V | Imp | Eff | Finding | Evidence |
| --- | --- | --- | --- | --- | --- |
| T1 | P | **H** | L | The server bumps `asset_list_generation` on **any** `assets` UPDATE, including ticket metadata fills and the thumbnail worker's claim epoch. On each change, once the replacement list commits, the tablet clears its media cache, aborts in-flight originals and closes an unchanged open viewer. Events are coalesced; Picker walks are throttled and idle-gated. | `S/app.py:277-282`; `S/media_tickets.py:189-192`; `S/image_thumbnails.py:661,881`; `M/App.tsx:552-565` |
| T2 | U | M | M | PC uploads have no byte-rate cap (4 lanes). Uploads go straight to storage, and tablet thumbnail and original tickets use separate workers, so uplink contention is unproven. | `R/cloud/backfill.rs:705-735`; `R/cloud/client.rs:2210` |
| T3 | P | M | M | Visible-tile original warming makes the VPS fill `original-cache/` (deduplicated, 4 workers, ≤50 MiB each), with **no aggregate eviction**. | `M/Gallery.tsx:41-49`; `S/original_cache.py:107-206` |
| T4 | C | M | M | The tablet viewer decodes the current original with no pixel cap (only neighbours are capped). | `M/Viewer.tsx:286-330` |
| T5 | P | L | M | Thumbnail tickets share one FIFO batcher. Visible work already goes first in the web layer. | `A/TicketBatcher.java:105-122` |
| T6 | P | L | M | The tablet catalog is not virtualized. Covers are gated to the viewport plus two rows, 6 transfers, 3 GiB cache. | `M/Catalog.tsx:439,575` |

### Found in round 2

| ID | Imp | Eff | Finding | Evidence |
| --- | --- | --- | --- | --- |
| N1 | M | S/M | Every inspector selection (`AssetInfoPanel` → `artist_style_suggestion`) computes the artist-style input stamp: a join over all normal image assets with artist scope plus summaries, dismissals and exclusions, JSON + SHA-256, all under the global lock. Arrow-key browsing with the panel open repeats it per step. | `F/assets/AssetInfoPanel.tsx:110-116`; `R/library/artist_style.rs:204-233,570-580` |
| N2 | L–M | S | The single native timer loop runs publication readiness and launchbox queries synchronously on the global lock, so a long holder (J2, D4) stalls scheduling and window reconcile. | `R/workload.rs:631-898`; `auto_publication.rs:163-181` |
| N3 | U | S | `list_manga_series` may re-run `preview_catalog_recovery` (ATTACH kdata + full LEFT JOIN) on every Manga tab mount while unresolved recovery links remain. | `R/library/manga.rs:181-252,574-596` |
| N4 | L | S | Correctness: video review acceptance hashes both sources against one shared 60 s deadline and marks the review stale on *any* verification error, so a slow disk invalidates a legitimate review. | `R/library/video_similarity/review.rs:147-160` |
| N5 | L | S | The extension picker does canonicalize and reads up to 24 thumbnail files inside a pooled reader closure. | `R/extension_api/picker.rs:950-975` |
| N6 | L | S | Tablet original-ticket warming shares the serial ticket batcher with opening a different original. | `A/MediaRepository.java:164,181` |

## Stage 0 measurements (2026-11-10)

Backend probe (`perf_probe --only heavy --with-catalog --no-video-media --iterations 5`, release build of the working tree on top of `57c2a35e`). It ran on a copy of the real library: the app was stopped for about 3 s while `library.sqlite` (5.45 GB, 10,819 assets) and `kdata.db` (168 MB, 135,329 works) were copied. The copy was on the same NVMe disk, idle machine. Medians unless stated.

| Probe | Result | Gate | Decision |
| --- | --- | --- | --- |
| J2 auto-tag inbox import (394,320 tag rows, 10,209 assets) | **60.3 s** with the global lock held | >500 ms | **Fix** |
| D4 full catalog membership rebuild (one review decision) | **1.03 s** (p90 1.88 s) under the lock | >500 ms | **Fix** |
| N1 artist-style input stamp (10,070 assets) | **135 ms** (p90 369 ms) under the lock, per inspector selection | >50 ms common path | **Fix** |
| Grid page while a writer holds the lock for 300 ms | 313 ms (waits out the holder) | — | Confirms that J2 and D4 spill into grid browsing and that sync commands freeze the UI (D1) |
| J6 similarity comparable inventory (10,206 rows) | 33 ms per batch | >50 ms | Hold |
| N3 `list_manga_series` (0 unresolved recovery links) | 6.8 ms | >50 ms | Refuted; drop |
| D7 commit, `synchronous` FULL vs NORMAL | 0.85 ms vs 0.015 ms per commit | — | Small. User decision; default is to keep FULL |
| D7 first open with a leftover 62 MB WAL | 22 ms (TRUNCATE checkpoint 233 ms) | — | Launch-recovery cost negligible; drop the WAL items |
| D1 video-similarity poll | not measured (no scan row in the library) | — | Fix as part of D1: a sync lock-taker can freeze the UI behind J2 |
| `list_collection_covers` | not measured (source folders outside the copy) | — | Fix with D1 (structural) |

The UI-side gates (I7, I8) and the tablet gates (T1, T4) are still open: they need a real-app session and a connected tablet (none was attached on 2026-11-10).

### N7 — `character_autotag_predictions` dominates the database

Found while measuring; verified by Sol (`gpt-6.1-sol`, read-only) and by controller SQL on the copy.

**Size.**
- The table holds 4.06 GB of the 5.45 GB file: 879,634 rows, 3.9 GB of it in `result_json`.
- 809,413 rows (92%) are `unmatched`, each with about 4.25 KB of evidence.
- **Only 205,195 rows (1.1 GB) are the latest generation for their asset and target.** The rest (2.8 GB, 72%) are superseded generations: there are 79,899 evidence rows for 10,819 assets, with 1–15+ generations each, mostly from the 2026-09 and 2026-10 re-scans.
- Nothing prunes old generations. Only the FK cascade removes rows, when an asset or target is deleted.

**Unmatched evidence is still read.** Review, reference refresh/delta, regions, candidates and tagger review all read it, so dropping the evidence or rewriting it to fewer fields would change behaviour. Readers use the latest row per asset and target.

**Cost.**
- The daily metadata backup copies the whole file at the first launch of the day: about 19 s on 2026-11-10, 12:03:07–12:03:26.
- About 10 backups of 5 GB each are kept (about 50 GB).
- The size also inflates page-cache misses for every fresh connection.

**Candidate fix (needs approval: production-data migration).**
1. Prune superseded generations when a new generation is published.
2. Run a one-time migration that deletes non-latest generations, behind the existing pre-migration backup, then VACUUM.

Expected result: about 1.1 GB of predictions, a DB of about 2.5 GB, roughly halving backup time and size. First verify that no reader uses non-latest generations (decision snapshots copy their evidence into `character_decisions`).

### N7 first implementation attempt (2026-11-10, not merged)

Sol (batch F) wrote a per-publication prune plus a forward migration with a conservative keep rule, measured on the real-library copy. The patch is kept outside the repository.

**Result:**
- Predictions: 879,634 → 811,240 rows, only 8% removed.
- Evidence rows: 80,663 → 64,439.
- File size after VACUUM: 5.45 → 5.08 GB.
- Migration time: 78–90 s at library open. VACUUM time: 132–169 s.

**Why it removed so little.** The controller broke the keep rule down on the copy:
- 71,976 evidence rows are superseded.
- The job clause keeps 54,905 of them. That clause keeps every generation that shares the source generation of a non-superseded job, because a decision taken from an already open review page accepts any generation of the current source.
- The reference-refresh base clause keeps 5,877.
- The regions fallback clause keeps 1,685.

**Decision:** not merged. One-time cleanup needs no protection for open review pages, since none are open at startup. Rework as:
- a background, per-asset, small-transaction prune (no startup block) that drops the job clause for the one-time pass;
- the narrow live rule at publication time;
- a one-time VACUUM as an explicit, visible maintenance step.

Expected result: about 205k prediction rows and a database of about 2.4 GB. This needs the user's go-ahead on how the VACUUM step is shown.

### User decisions (2026-11-10)

- **N7:** approved. Prune superseded generations going forward and run a one-time cleanup migration behind the pre-migration backup.
- **D7:** keep `synchronous` FULL. Drop the WAL size and checkpoint items, since the measured launch recovery is 22 ms.
- **T1:** the user has never seen the tablet viewer close by itself during PC imports. Keep it in stage 4 at lower priority, unless a device measurement shows the reloads.
- **Commits:** approved once each batch is reviewed and tested.
- **Tablet measurements:** wireless ADB over the tailnet when the user enables 무선 디버깅.

## Delivered (2026-11-10)

All numbers come from `perf_probe` on a copy of the real library (Windows release build). They are backend timings, not native window measurements.

| Commit | Items | Before → after |
| --- | --- | --- |
| `f5f81604` | V1, V3, V4, V2a: video preparation is per-video locked, stoppable, quiet during playback, one video per call, newest first, below-normal FFmpeg priority | Structural; not timed |
| `d571d058` | J2: auto-tag import prepares outside the lock and diff-publishes. J8/V7: cached fingerprint before the full hash. N4: per-source verification budget | J2 lock held 82.6 s → 1.93 s (1.27 s for an unchanged re-import), with identical results in 10 tables |
| `5527eb81` | `perf_probe` heavy group and this record | — |
| `e0a08a51` | V6, C6, C3: freeze and reveal canvases released, motes only on LR | Structural; memory not measured |
| `a5121652` | D1: 19 lock-taking commands moved off the Windows UI thread; per-feature mutation ordering | Native responsiveness not measured |
| `6b1129a1` | N1: artist-style input stamp memoized behind a write counter | Per selection: 135 ms → 0.29 ms |
| `74ad5236` | D4: review and duplicate-sync membership computed in a private workspace; the lock is held only for a revalidated patch | Lock per decision: 1.18 s → about 10 ms. End to end: 1.2 s → 2.2 s |

| `ed89627b` | J7: artwork backfill single-flighted per library and launch-settled. J5: no artist re-rank in lightweight mode | Structural; not timed |
| `cf646816` | N7: per-publication prune, a one-time background pass, and a manual DB 최적화 (VACUUM) job | On the copy: predictions 879,634 → 270,864; file 5.45 → 2.06 GB after a 26 s VACUUM. The pass took 1,054 s in the background (longest transaction 204 ms). Review and candidate projections unchanged |

Held after measuring or re-checking:
- **I8** (FIFO within a view): thumbnail permit wait p95 12 ms, max 111 ms, below the 100 ms p95 gate.
- **J1** (publication safety dispatch): the startup check of every lane is deliberate, and each check is light.
- **J6** (inventory reload, 33 ms) and **N3** (manga list, 7 ms): below their gates.

Review notes:
- The controller fixed a Stop-reset bug (V3), a cover-scale bug (V6) and a writer that bypassed the change hooks (D4).
- A read-only Sol review of D4 found a batch-ordering bug in a "rebuild once per pass" shortcut; the shortcut was reverted.
- One pre-existing failing test is not caused by this work: `catalog_duplicate_pass_through_the_real_client_uploads_and_reports` expects a PUT where `f95a3314` added a representative GET.

## Real-app session (Windows main PC, 2026-11-10 22:33)

Release build of `cf646816` on the real library, with `LAKOMICS_PERF=1`, `LAKOMICS_MEDIA_TIMING=1` and the WebView2 DevTools port. The N7 background pass was running during the session.

- **Idle 30 s:** no long tasks; app 3.6% CPU; total private memory 477 MB.
- **Scripted grid scroll, 20 s, 48,000 px:** 2,399 frames, p50 8.3 ms, p95 8.4 ms, max 16.7 ms, 0 frames over 25 ms, one long animation frame of 51 ms.
- **Thumbnail requests during the scroll (1,465):**
  - permit wait p50 0 ms, p95 12.3 ms, max 111 ms;
  - serve p50 6.1 ms, p95 8.6 ms;
  - DB wait 0 ms.
  - **About 6–7 ms of each serve is `file_open_ms`.** Opening the thumbnail file dominates, not the queue or the database. Real-time antivirus scanning is a plausible cause; this is unverified and a new candidate.
- **Viewer, 20 ArrowRight steps over real images (I7):**
  - WebView2 GPU process private memory went from about 152 MB to **819 MB** at peak, and was 535 MB after closing;
  - the renderer stayed around 130 MB.

  This meets the 300 MB gate for I7. How much of it comes from the speculative next/previous decodes, rather than from showing each original, is unmeasured. An A/B run with prefetch disabled would answer it.

### Follow-up: viewer memory and thumbnail opens (2026-11-10 23:00)

**Viewer (I7): the A/B shows that speculative decodes are not the cost.**

The same release build ran with a runtime toggle, from a fresh process each time, over the same 20 images (2–12 MP each):

| Speculative next/previous decode | WebView2 GPU process peak | After closing |
| --- | --- | --- |
| Off | 620 MB | 508 MB |
| On | 612 MB | 512 MB |

The growth is Chromium's GPU-side image cache for the originals actually shown.
- Bounding the prefetch would not help, so I7 is dropped.
- The only lever left is to show a display-size rendition at fit and the original on zoom. With 24 GB of RAM this is not worth the quality and CPU trade-off.
- The earlier 819 MB peak was taken with the perf log and media timing on and the N7 pass running.

**Thumbnail `file_open_ms`: Windows Defender on-access scanning.** First-open timings on 300 real thumbnails, read-only:

| Location | First open p50 / p95 | Second open |
| --- | --- | --- |
| `C:` NTFS (library location) | 3.76 / 5.25 ms | 0.04 ms |
| `V:` Dev Drive (asynchronous scan) | 0.046 / 0.08 ms | 0.04 ms |

`realpath` (`canonicalize`) costs about 0.15 ms either way.
- Defender caches a clean result per file, so the cost repeats after cache resets, such as signature updates and reboots.
- Real-time protection is on; the exclusion list needs admin rights to read.
- No code change. The user can add Defender exclusions for the app-generated folders only (`thumbnails`, `video-media`, `collection-thumbnails`, `cache`; about 0.6 GB) to remove about 3.7 ms per cold thumbnail. Originals (`assets`) stay scanned.

### Tablet session (Galaxy Tab S11, 2026-11-10 23:30)

Wireless ADB, `LakomicsPerf` DEBUG, WebView DevTools. Turned off again afterwards.

- **Connectivity first.** The tablet's Tailscale VPN was off, so every API request failed: the asset screen errored and its tab did not switch. After the user turned it on, the tablet reached the server.
- **T4, viewer memory over 20 images.**
  - App PSS rose from 252 MB to a peak of 571 MB and was 425 MB after closing.
  - The WebView renderer rose from 147 MB to a peak of 250 MB and was 183 MB after closing.
  - Memory oscillates and is released; with 4 GB available out of 11.8 GB there was no pressure. Dropped.
- **T1.** No viewer close and no grid reload while browsing; the list-generation poll ran about 3 times a minute. Held, as the user never observed it.
- **New finding: cached thumbnails waited about 100 ms each.**
  - Symptom: tiles already in the local cache took 101 ms median (153 ms p90) when "모든 에셋" opened, growing about 4 ms per queued tile.
  - Cause: every media request read the connection through `SecureSettings.read()` under `CONNECTION_LOCK`, which means an Android Keystore open plus an AES-GCM decrypt each time.
  - Fix, commit `0.9.172`: the plaintext is cached per exact ciphertext. Cache-hit checks are also read-only, and recency is refreshed hourly.
  - Result: cached thumbnails 0.67 ms median (1.9 ms p90); screen images ready in 90 ms instead of 425 ms.

## Fix plan

Rules for every stage:
- **Measure first.** Fix an item only if (a) stage 0 shows a cost above its gate, or (b) it is a confirmed mechanism with a small, low-risk fix whose benefit is structural: a lock or main-thread hold, a missing cancel, or unbounded memory. Gates use deterministic counts or durations from the existing kits.
- After a verified win, lock it with a check whose threshold can only tighten.
- **Batches.** Each implementation batch has a disjoint write set, a targeted Rust/Vitest check, and a controller diff review.
- **Approvals.** Commits, deployments and device installs each need the user's explicit approval.

### Stage 0 — measure (no behaviour change)

0a. **Backend probe** on a closed-app snapshot of the real library, via `perf_probe` additions; the live library is never opened by SQLite. Items to time:

| Probe | Item |
| --- | --- |
| full `catalog_groups::rebuild` | D4 |
| one `decide_catalog_review`-equivalent rebuild | D4 |
| artist-style `inputs()` | N1 |
| `list_manga_series`, plus the count of unresolved recovery links | N3/D1 |
| `get_video_similarity_scan` | D1 |
| `load_comparable` | J6 |
| `list_collection_covers` for the largest collection | D1 |
| auto-tag `import_file` on a copy of the inbox file, if present | J2 |
| commit latency with `synchronous` FULL vs NORMAL | D7 |
| first open with a leftover WAL | D7 |
| page/table size breakdown of the 5.4 GB `library.sqlite` | context |

0b. **Real app session** on the Windows release build with `LAKOMICS_PERF=1` and `scripts/perf/windows-session.mjs`:
- arrow through 30 assets with the info panel open (N1);
- keep the video-similarity panel open for 30 s (D1);
- open the Manga tab ×5 (N3);
- open a collection overlay ×5 (D1);
- fast gallery scroll with media timing for `permit_wait_ms` (I8);
- flip through 20 large images for private memory (I7).

  No step writes production data; catalog review decisions are measured only in 0a.

0c. **Tablet over adb, when connected:**
- `dumpsys meminfo` for the app and the renderer process while paging through 20 large images (T4);
- the count of `lakomics-list-generation` events per minute during ordinary PC activity (T1).

  The user is asked whether the viewer has closed by itself during imports (T1).

Gates (initial):
- A UI-thread or lock-held operation over **50 ms** on a common path, or over **500 ms** on any path.
- Thumbnail `permit_wait_ms` p95 over **100 ms** during scroll.
- A memory step over **300 MB** from a single viewer action.

### Stage 1 — confirmed, small, low-risk (structural benefit)

1. **D7.** Run `wal_checkpoint(TRUNCATE)` on clean quit, set `journal_size_limit`, and measure FULL vs NORMAL. `synchronous=NORMAL` is the user's durability call: in WAL mode it is corruption-safe, but a power loss can drop the last commits.
2. **J2.** Start the auto-tag inbox import only after user inactivity, like launchbox (`inactive_since ≥ 120 s`).
3. **J8/V7.** Cheap checks plus a fingerprint-cache lookup before the full hash; hash only to compute a new fingerprint.
4. **N4.** Give each source its own verification deadline. Report a timeout as retryable, not stale.
5. **V1/V3/V4.**
   - Take `video_lock` per video.
   - Use frontend batches of 1 and a newest-import-first order.
   - Add a real cancel flag with requeue cleanup and enable `can_stop` for videos.
   - Do not start background preparation while the viewer plays.
   - Spawn preparation and similarity FFmpeg at `BELOW_NORMAL_PRIORITY_CLASS`.
6. **V6/C6/C3.**
   - Cap freeze canvases at the displayed size × DPR and shrink them after the replacement is presented.
   - Zero finished reveal canvases.
   - Render motes only for LR.
7. **J7/J1.**
   - Single-flight the artwork backfill and wait for launch settling.
   - Add a per-lane offset to the publication safety interval.
   - Gate authority, asset and replication starts on launch settling.
8. **J5.** Do not schedule an artist-style re-rank while restricted.

### Stage 2 — lock and UI-thread holds (gated by 0a/0b)

1. **D1.** Move the hot sync commands to `async` + `spawn_blocking`: the video-similarity poll, `list_manga_series`, collection-overlay reads and `list_collection_covers`. In `list_collection_covers`, release the lock before directory I/O. Keep mutation order for folder drags, by awaiting or serializing per feature.
2. **N1.** Memoize the artist-style stamp against an assets/artist generation.
3. **D4.**
   - Compute membership from a catalog read snapshot outside `database_lock`.
   - Compare-and-set the revision and the decision state in a short write.
   - Rebuild once per `apply_pending` pass.
4. **J6.** Keep the comparable inventory across batches, keyed by the assets generation, on a read connection.
5. **I2.** Drop the lock before listing the manga folder and cache the sorted page list by folder mtime.
6. **I1.** Add a bounded `Remote` media class and use a read-only kdata lookup that runs before the cache check is skipped.
7. **N2.** Move the publication readiness probe off the timer thread.
8. **N3**, only if 0a shows repeated recovery work.
9. **D2**, only if the contention probe exceeds its gate: grid reads on reusable read connections, keeping count-cache correctness.

### Stage 3 — media queue and memory (gated by 0b/0c)

1. **I8.** Bounded visible-first ordering within a generation, for thumbnail and cover classes.
2. **I3/V5.** Move small tile routes to `Cover` and give playback its own small pool. Coalesce timeline seeks while dragging, showing scrub frames and seeking once on release.
3. **I7.** Bound speculative viewer decodes by dimensions; use previews for hover and comparison. Keep the decoded-before-swap rule.
4. **I6.** De-duplicate in-flight work per output key and add a pixel preflight for on-request thumbnails.
5. **D8.** Run the duplicate lookup before staging on the materialization path, which already knows the sha256. User imports only if re-import volume justifies it.
6. **T4.** Native display derivative for oversized images on the tablet; original on zoom.

### Stage 4 — tablet and server (needs deploy and install approval)

1. **T1.**
   - Server: `AFTER UPDATE OF <list columns>` triggers so receipt, epoch and ticket-metadata writes do not bump the list generation.
   - Tablet: keep the media cache on a generation move and keep the viewer while its asset exists.
2. **T3.** Server `original-cache/` byte budget with LRU eviction.

### Held or dropped

| Items | Reason |
| --- | --- |
| D3 | Refuted; the dead scan-evidence path may be removed separately. |
| D5 | Rare; atomicity required. |
| D6/I4 | Measure only. |
| J3 | Main PC uses DirectML. |
| J4 NL part | Feature paused. |
| C1, C2, C4, C5 | Fold into `PERF-20261018` measurement. |
| I5, I9, V8, V9, T2, T5, T6, N5, N6 | Low or unproven; revisit with measurements. |
