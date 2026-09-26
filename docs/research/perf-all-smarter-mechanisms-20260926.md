# Smarter mechanisms survey (PERF-ALL-001 follow-up) — 2026-09-26

Read-only survey at `af3fa05` + the dirty worktree of that moment (the first fix batch was committed as `c553d16` while this ran; the Vault mount watcher is still uncommitted). No repo file changed, nothing built or run
against the library. Scope: change *how work is triggered or avoided* (events, cursors,
long-poll, caching by identity), not interval tuning.

Evidence labels: **M** = measured number quoted from `docs/research/perf-all-baseline-20260926.md`;
**C** = traced from code (file:line); **E** = my estimate (method stated). Nothing here was
measured on a device or in a native window.

Excluded as already in progress: `list_collections` plan, desktop idle re-render equality
(vault/character), tablet cover retry + media-queue cancel, tablet idle replica parse /
Picker-walk skip / warm-up progress, Private Vault mount watcher.

---

## Top 10 (ranked by value / risk)

| # | Finding | Where | Size | Risk | Baseline overlap |
|---|---|---|---|---|---|
| 1 | Character engine idles by re-querying the DB every 500 ms → block on a wake signal | PC Rust | S–M | low–med | new (baseline §6 only suspected the loop for lock starvation) |
| 2 | In-process "table changed" signal from one SQLite hook → wake the replication lane instead of the 2 s tick | PC Rust | S (lane) / M (bus) | low–med | extends rust §8 #7 (idle-tick trimming), not in combined top 10 |
| 3 | Server long-poll on `/v1/sync/status` + central write generation (304 without SQLite) | Server + PC + tablet | M (on top of #4) | medium | extends combined #4 (fold pollers); fixes BIND-POLL latency the fold alone cannot |
| 4 | Desktop thumbnails are `no-store` and each fetch takes the global DB lock → versioned, cacheable URLs | PC Rust + React | S–M | low–med | new; relieves combined #3 (lock queueing) for media |
| 5 | Push native state to JS with Tauri events instead of 5–10 s JS status polls | PC Rust + React | M | low–med | complements the excluded equality fix and combined #7 |
| 6 | Tablet warm-up: daily 9,300-call re-walk → incremental high-water mark + one batched native cache probe per page | Tablet | S–M | low | tablet §4 #5 (partly); sequence after the in-progress warm-up change |
| 7 | Server: store object size/type once for content-addressed keys → zero R2 HEADs on tickets | Server | S | low–med | combined #5 / tablet §4 #2, #9 (stronger than a longer TTL) |
| 8 | Android `ConnectivityManager` / power broadcasts drive the pass and warm-up instead of blind timers | Android | S | low | new |
| 9 | Extension saved-X index: unconditional full-list GET → ETag/revision (and skip identical re-PUTs) | Extension + server + PC | XS–S | low | new |
| 10 | MangaDex/Kakao refresh: 2 requests per bound manga per day → batched "what changed" query first | PC Rust | M | medium | new |

---

## 1. Character engine: 500 ms DB polling while idle → wake-on-work

- **Where (C):** `_tools/app/src-tauri/src/library/character_incremental.rs:294-399` (`incremental_loop`, `sleep(500ms)` at `:304` and `:394`). Runs whenever the character runtime is configured (`commands/characters.rs:89-100`), which is the user's normal state.
- **Now:** every idle turn (no jobs) runs, in order: `paused` query (1 connection), `claim_character_autotag` (connection + transaction, `character_autotag.rs:600-620`), `advance_character_reference_refresh` (connection + transaction, `character_reference_refresh.rs:229-250`), then `augmentation_idle_allowed` up to 3× (1 connection each, `:939-948`, called from augmentation, shadow and shadow-backfill), and `s36_catch_up` (`:865-935`): reads and JSON-parses `s36_policy.json` from disk, queries up to 500 recent completed jobs, and opens the separate `.cache/characters/s36_shadow.sqlite`. Then sleeps 500 ms and repeats.
- **Cost (E):** ~6 library connections + 1 extra SQLite open + 1 file read per turn ≈ 12 connection opens/s ≈ 720/min. At the measured open+schema floor (M: 1.37 ms release / 3.82 ms dev per connection) that is **≈1.0 s CPU/min release, ≈2.7 s/min dev from schema parsing alone** — larger than the whole measured idle subtotal in the baseline (M: 0.57 s / 1.45 s per min), which did not include this loop. It also takes the process-wide DB mutex ~12×/s, which is exactly the kind of holder the baseline found starves UI reads (std `Mutex`, non-FIFO; M: grid page 3 ms → 334 ms behind a holder).
- **Smarter:** block the loop on a `Condvar`/channel. Wake it from the places that create work (job enqueue in `character_autotag.rs`/`character_workflow.rs`/`character_hub.rs`, reference-refresh requests, pause/unpause, shadow queue push, backfill start, leaving lightweight mode) or from the generic change signal in #2 (tables `character_autotag_jobs`, `character_reference_refreshes`, `character_autotag_control`). When jobs exist but are delayed, sleep until `MIN(retry_at)` instead of 500 ms. Cache the S36 policy version per config instead of re-reading the file each turn. Keep a long safety timeout (e.g. 60 s).
- **User-visible:** lower idle CPU/fan/battery on the laptop whenever the app is open; fewer UI stalls behind the DB lock. Character tagging of new images starts immediately on the wake instead of within 500 ms (no regression).
- **Caveats:** none platform-specific. Every place that makes work must signal (or rely on #2's hook); the safety timeout covers misses. `retry_at` jobs need the computed next-due sleep.
- **Gate:** connections opened per idle minute by the engine (probe counter; now ≈720 E → ~1).

## 2. One SQLite hook as an in-process "something changed" signal → wake lanes instead of ticking

- **Where (C):** every connection is created in `library/db.rs:69-74` (`open_database`), reached from `library/mod.rs:450-463`. rusqlite already has the `hooks` feature (`Cargo.toml:25`). `PRAGMA data_version` is *not* usable here, because it only reports changes by other connections and every call opens a fresh connection.
- **Now (first target):** the replication lane runs every 2 s (10 s light) from `workload.rs:615-623`; each idle cycle opens 4 connections and runs 8 statements including 2 no-op UPDATEs (`cloud/backfill.rs:544-570`). M: ~325 ms CPU/min release, ~880 ms dev, 0 useful work when the queue is empty. The 10 s publication tick (`workload.rs:527-536`, `cloud/auto_publication.rs:48-83`) spawns 7 lane threads that each re-read config/state before their own throttles (E: ≥7–15 connection opens per 10 s, baseline §5).
- **Smarter:** register `update_hook` in `open_database` and record touched table names into a process-wide set of per-table generation counters (`AtomicU64`), notifying a `Condvar`. Treat it as a *hint* (re-check the DB on wake), so rollbacks or missed WITHOUT ROWID tables only cost a spurious wake or fall back to a long timer. Then:
  - replication lane: sleep until `cloud_sync_queue`/`cloud_backfill_control` changes or the earliest retry time; drop the 2 s tick;
  - publication lanes: dirty lanes wake on their tables (`mobile_publication_state`, visibility tables, etc.) and otherwise sleep until their own next due time (`last_polled+60`, `retry_after`, `last_dirty+30`);
  - #1 and #5 subscribe to the same signal.
- **User-visible:** idle CPU from the replication lane ≈0 (M: −0.33 s/min release, −0.88 s/min dev); a new capture starts uploading immediately rather than within 2 s. Laptop battery.
- **Caveats:** writes by other processes to `library.sqlite` would not fire the hook (I found none: the Python character runtime writes its own cache DB; the bins are offline tools) — keep a slow safety timer (60 s). `update_hook` does not fire for WITHOUT ROWID tables and for some truncation paths; check the tables used as triggers. Remote cursors still need network polling (#3).
- **Size/risk:** replication-lane only: S / low. Full bus with lanes: M / medium.

## 3. Server long-poll `/v1/sync/status` (+ fold) with a central write generation

- **Where (C):** `server/lakomics-api/sync_status.py:45-73` (sync handler, ETag → 304), `app.py:50-58` (`get_db`, one connection per request), single-process uvicorn (`docs/research/server-review-2026-09-24.md:8`). Clients: PC authority pass (5→60 s backoff, `authority_pass.rs`, `workload.rs:537-614`), PC exchange receiver (5 s / 15 s, `exchange/mod.rs:45-47,862`), tablet pass (`ForegroundSchedule.java:73` 5→60 s) plus the tablet's JS 30–60 s polls.
- **Now (M/C from baseline):** PC ≈185–200 idle requests/15 min (+180 with an exchange token); tablet 180–240/h per tab; each 304 still costs the server 10 SQL statements and 2 connections (M: 2.56 ms). Latency is set by the backoff: bind pickup 0–70 s, captures 15–60 s, tablet sees PC changes after up to 60 s. Combined #4 (fold every log cursor into the status) cuts *requests*, but as the baseline notes it does **not** shorten idle pickup, because the status read itself backs off to 60 s.
- **Smarter:** `GET /v1/sync/status?wait=55` with `If-None-Match`: the handler (`async def`) returns immediately if the ETag differs, otherwise waits on an `asyncio.Event` until something changes or the timeout, then answers 304. The change signal is central: in `get_db()`'s `finally`, if `conn.total_changes > 0`, bump a process-wide generation and wake waiters (`loop.call_soon_threadsafe`). The same generation lets any conditional endpoint answer 304 **without opening SQLite** when nothing was written since its ETag was computed (memo keyed by principal + generation). Fold the per-lane cursors (combined #4) into the same document so one held request covers every domain; PC and tablet each keep exactly one outstanding request while in the foreground.
- **User-visible:** tablet ↔ PC changes, extension captures on the PC, bind requests ("연결됨"), file-exchange arrivals appear in **~1 s instead of 5–70 s**, with the same or fewer requests (≈1 per 55 s per client when idle vs today's 60 s backoff + 30–60 s JS polls + 5 s exchange poll).
- **Caveats:** handlers must not block the event loop (compute the payload via `anyio.to_thread`); writes from outside `get_db` (other processes, e.g. thumbnail workers if separate) need a slow fallback re-check (e.g. every 5 s while waiting). Client timeouts must exceed `wait` (PC `ureq` `timeout_global` 20–60 s in places; tablet `HttpURLConnection` read timeout). Old server: ignores `wait` → client sees a normal immediate response (safe fallback). On cellular a 55 s hold is no worse than today's 60 s poll; on Wi-Fi negligible. Tablet keeps the rule that new status fields must not count as "Library changed" (`SyncStatusPass.java:16-33`, baseline trap). Server tests exist for conditional responses; add a waiter test with a fake clock.
- **Size/risk:** M on top of combined #4 (L together) / medium (cross-client contract).

## 4. Desktop thumbnails: `no-store` + a DB-locked lookup per fetch → versioned, cacheable URLs

- **Where (C):** `media_protocol.rs:222-236` sets `Cache-Control: no-store` for `MediaVariant::Thumbnail`; `library/mod.rs:669-678` resolves every thumbnail with `self.connection()` (global DB mutex + open + schema parse) and a `SELECT thumbnail_relative_path`; video hover frames do the same per frame (`mod.rs:695-712`, `VideoTileMedia.tsx:48-51` cycles 4 frames every 720 ms). URL is `/thumbnail/<id>` with only an optional *global* cache key (`assets/mediaUrl.ts:16-19`, `AssetGallery.tsx:345`).
- **Now:** every time a tile's `<img>` mounts (virtualized grid scrolling back, switching folders and back, closing the viewer onto a re-mounted page), the WebView re-requests it: Rust worker → media permit → DB mutex → connection (M: 1.37 ms release / 3.82 ms dev floor) → canonicalize → read file. While a sidebar refresh or the character loop (#1) holds the mutex, thumbnails wait with it (M: a 3 ms grid page waited 334 ms / 1.97 s behind a sidebar refresh; thumbnails share that lock). Per-visit volume (E): ~29 visible tiles plus overscan per screen.
- **Smarter:** put a per-asset thumbnail revision in the URL (e.g. the content hash or the thumbnail file's stem/revision in `AssetSummary`), and serve library thumbnails and scrub frames with `Cache-Control: private, max-age=31536000, immutable`. Repeats then never leave the WebView cache. For first fetches, resolve from the URL itself (id + revision → known relative path) or an in-memory LRU of id→path, so the media path no longer needs the DB lock.
- **User-visible:** scrolling back and returning to a folder shows thumbnails instantly, even while background DB work runs; less CPU during browsing.
- **Caveats:** the current `no-store` is deliberate (test `media_protocol.rs:990-1008`, thumbnails regenerate in place) — correctness depends on the revision changing on every regeneration. Keep Private Vault routes `no-store` (WebView disk cache would persist decrypted thumbnails). WebView2 (Windows) and WebKitGTK (Linux) cache custom-scheme responses differently; verify both natively. The global `thumbnailCacheKey` can stay as a bulk invalidation.
- **Size/risk:** S–M / low–medium. Gate: protocol requests per "scroll down 5 pages and back" in a native window (not measurable in jsdom).

## 5. Push native state to JS instead of JS status polling

- **Where (C):** only four Rust→JS events exist today (`workload.rs:25,95,213,606`, `extension_api.rs:267`). JS polls native state it could be told about:
  - `useCloudBackfillSupervisor.ts:8-9,28` → `cloud_backfill_progress` every 10 s idle / 1.5 s running (M: 34 ms release, 13 statements, 12.8 k page misses per read);
  - `useCharacterAutomation.ts:103-141` → `character_incremental_status` every 5 s / 1 s (M: 2.4 ms);
  - `useSimilarityReviewInbound.ts:8,42` every 10 s, only to detect that the native similarity lane applied decisions;
  - `collections/ReleaseInbox.tsx:68` → `list_release_inbox` + update status every 5 s while shown;
  - `useMobilePublications.ts:9` → `run_due_mobile_publications` every 10 s, duplicating the native 10 s tick only to save the navigation order.
- **Smarter:** emit a Tauri event when the value changes, from the place that changes it (replication commit/finish, engine job start/finish, similarity apply, release receive), or from #2's change signal; JS reads once on mount and on the event. Save navigation order when the user changes it, not on a timer.
- **User-visible:** progress and counts update immediately instead of up to 10 s later; ≈54 idle IPC calls/min (M, harness) → near 0; less WebView and native CPU.
- **Caveats:** events are lost while no listener is attached → always read once on mount/library switch. Browser fallback (non-native gateway) keeps its polling. Overlaps the excluded equality fix only in files touched (`useCharacterAutomation.ts`, now in `c553d16`) — build on it.
- **Size/risk:** M / low–medium.

## 6. Tablet warm-up: incremental high-water mark + one batched cache probe per page

- **Where (C):** `_tools/app/mobile-client/thumbnailWarm.ts:24,57-86,114` (worktree version): a finished pass repeats every 24 h from page 1; each page calls `warmThumbnail` per asset (`media.ts:135-140`) → one native bridge call per asset → worker slot + Keystore decrypt (baseline §2.2). Native cache lifetime is 365 days with a 1 GiB LRU (`ThumbnailCache.java:10-14`), so almost every daily call is a hit.
- **Now (M):** a full pass = 93 page GETs + 93 native `status` + **9,300 native `thumbnail` calls**, daily, starting 5 s after launch — competing with first-screen covers.
- **Smarter:** (a) store the newest warmed asset (collected_at/id of the first page) and the server list generation at completion; the next pass walks newest-first only until it reaches that mark (only new assets), with a full pass only when the native cache generation changed (`ThumbnailCache.generation`, cleared cache) or rarely (e.g. monthly). (b) a native `thumbnailsCached([keys])` batch probe per page: one bridge call returns the misses, and only misses are ticketed (already batched by `TicketBatcher`).
- **User-visible:** after the first full pass, a daily resume does ~1–2 requests and ~1 bridge call instead of ~9,400 calls; cold-start cover loading no longer competes with the warm-up.
- **Caveats:** LRU eviction at 1 GiB means very old thumbnails may drop out; the occasional full pass covers it. `thumbnailWarm.ts` was just changed for warm-up progress (`c553d16`) → build on it.
- **Size/risk:** S–M / low.

## 7. Server: record object metadata once for content-addressed keys → no R2 HEAD per ticket

- **Where (C):** `server/lakomics-api/head_cache.py:12-17,31` (immutable-key regex; cache TTL 30 s, **max 512 entries**), used by `app.py:2508-2522` and `mobile_collections.py:357-367`.
- **Now (M):** a cold 50-thumbnail ticket batch costs 49 R2 HEADs (1,063 ms at a modeled 150 ms HEAD vs 7 ms warm); a cold artwork ticket 1 HEAD (153 ms modeled vs 2.2 ms). After any cold start the 30 s cache is empty.
- **Smarter:** the keys matched by `_IMMUTABLE_KEY` are content-addressed, so size/type never change. Record `ContentType`/`ContentLength` in SQLite when the object is written or first verified (upload verification and thumbnail derivation already HEAD/know it) and answer tickets from that row; HEAD only on a client `fresh_head` retry (the existing recovery path). A longer TTL alone is not enough: 9,300 thumbnails do not fit the 512-entry LRU.
- **User-visible:** first screens after a cold start (Collections covers, Library thumbnails) get tickets in milliseconds instead of waiting on HEAD round trips.
- **Caveats:** a deleted object stays ticketable until a download fails → `fresh_head` retry already handles it. Legacy/non-content-addressed keys keep HEAD.
- **Size/risk:** S / low–medium. Overlaps combined #5 (batch artwork tickets) — complementary.

## 8. Android: react to connectivity and power instead of discovering them by polling

- **Where (C):** no `ConnectivityManager`/`NetworkCallback` anywhere in `android/src`; the pass backs off 5→60 s on unchanged/failed passes (`ForegroundSchedule.java:73,88`). Battery is read on demand (`MainActivity.java:58-68`) and the JS warm-up re-checks it every 60 s while waiting (`thumbnailWarm.ts:65,114`); the original-ticket warm checks it per schedule.
- **Now:** after Wi-Fi drops and returns, outboxes (album/classification edits, trash) and remote changes wait for the next backoff tick (up to 60 s); while offline, polls keep failing on schedule. Plugging in the charger starts the warm-up up to 60 s later; while waiting, 60 wakes/h.
- **Smarter:** `registerDefaultNetworkCallback`: `onAvailable`/validated → `ForegroundSchedule.wake()` and a `lakomics-network` event to JS (flush bookmark outbox, notes); `onLost` → suspend network polls. Register `ACTION_POWER_CONNECTED/DISCONNECTED` (and `ACTION_BATTERY_OKAY/LOW`) while in the foreground → `lakomics-power` event; the warm-up waits for it instead of a 60 s retry.
- **User-visible:** edits made offline sync within ~1 s of reconnecting; no "오프라인" flapping from failing polls; warm-up starts as soon as the tablet is plugged in.
- **Caveats:** callbacks only while foregrounded (unregister in `onPause`, like the existing schedule); `ACCESS_NETWORK_STATE` is not declared yet (`android/AndroidManifest.xml` has only INTERNET and USE_BIOMETRIC); it is a normal, install-time permission. Tailscale VPN networks report as VPN transport — treat "validated default network" as online.
- **Size/risk:** S / low.

## 9. Extension saved-X index: conditional/incremental instead of a full list

- **Where (C):** extension `extension-list/src/save-client.js:252-258` GETs `/v1/saved-x-media` (whole key list) on X gallery open and on window focus ≥60 s apart (`x-gallery.js:26,803-806,1243-1262`); server `app.py:1698-1709` returns the stored payload with no ETag (cap 1 MB, `app.py:1638`). The PC re-PUTs the *entire* snapshot whenever the SavedX publication is dirty (`cloud/captures.rs:188-190,346-353`).
- **Now (E):** every X tab focus after a minute downloads the whole index (tens to hundreds of KB, one key ≈ 20–25 B); each X save triggers a full re-upload from the PC.
- **Smarter:** return the snapshot with an ETag (`conditional.json_response`, already used elsewhere) and send `If-None-Match` from the extension (cache the keys in `chrome.storage.local`) → 304 almost always; optionally a `?since=<revision>` delta. On the PC, skip the PUT when the key-set hash equals the last published one.
- **User-visible:** less data on each X focus; saved markers still refresh as today.
- **Caveats:** Chrome MV3 service worker restarts — keep the ETag + keys in `chrome.storage.local`, not memory.
- **Size/risk:** XS–S / low.

## 10. MangaDex/Kakao refresh: ask "what changed" in one request before per-manga fetches

- **Where (C):** `library/collection_updates.rs:10-11,53-60,176-200` (due = each bound manga once per day, 8 per 15 s batch, continuation every 1 s from `useReleaseWatchCheck.ts:59`); per manga `mangadex::fetch_work` = detail + covers requests (`mangadex.rs:276-280`), paced by `provider_requests.rs:91-102`.
- **Now (E):** ~149 manga (Linux library count in the baseline) × 2 requests ≈ 300 MangaDex requests/day plus pacing; the check runs as many short batches.
- **Smarter:** one list request `GET /manga?ids[]=…&limit=100` (≤100 ids per call) with the stored `updatedAt`, and one `GET /cover?manga[]=…` page set; fetch per-manga detail only for manga whose `updatedAt`/latest volume moved. Kakao: same idea only if its API offers a batch/`since` form (not verified).
- **User-visible:** the daily check finishes in seconds, fewer rate-limit stops ("retry later"), release notifications as fresh or fresher.
- **Caveats:** MangaDex list/`ids[]`/cover-batch semantics are from general API knowledge, **not verified in this repo** — confirm limits and fields first. Keep the per-manga path as fallback.
- **Size/risk:** M / medium.

---

## Also found (lower value or overlapping)

- **Similarity auto-compare (PC):** `library/similarity_scan.rs:170-235` handles 16 queued Assets per 10 s lane tick and reloads *every* comparable hash (`load_comparable`) for each batch. After an import of N images the full hash set is reloaded N/16 times and pairs trail the import by ~N/1.6 s (E: 1,000 images ≈ 10 min). Smarter: drain continuously while the queue is non-empty (wake from #2) and keep the loaded comparable set cached by a hash-table generation. S / low.
- **Catalog-duplicate fingerprint (PC):** `catalog_duplicate_sync.rs:748-780` hashes every row of `online_catalog_review_decisions` and `catalog_duplicate_pairs` once a minute to decide nothing changed. Smarter: a trigger-maintained revision counter (the pattern already used by `mobile_publication_state`). XS–S / low; value small unless those tables grow.
- **Tablet exchange screen:** `ExchangeService.java:36,229-234,299-301` reads inbox + outbox (conditional) every 5 s while 보내기/받기 is open (≈1,440 requests/h), although the device's exchange revision already rides on `/v1/sync/status` (`file_exchange.py:190-211`, `observeStatus`). Gate the reads on the revision (or #3's long-poll). S / low.
- **Server per-request connections:** `app.py:50-58` opens a new SQLite connection and reinstalls the `visible_assets` temp view per `get_db()` (M: 2–5 connections per request). Thread-local persistent connections with the view created once. S / low–medium (thread safety, WAL checkpoints).
- **Server catalog search:** copies every bookmark into a temp table per request (M: 433 statements, 400 inserts). Query the persistent bookmarks table directly. S / low.
- **Tablet cold start:** `ThumbnailCache` scans ~10k files on the UI thread to rebuild byte/count totals (baseline tablet #10). Smarter than moving it off-thread: persist the totals and let the existing hourly sweep correct them. S / low.
- **Tablet list generation:** read unconditionally every pass and twice per page load (baseline tablet #6, #8). Put it in the status ETag / page envelope (already proposed there).
- **PC native loop:** `workload.rs:476-481` polls `is_focused()`/`is_visible()` every second; Tauri `WindowEvent::Focused` could drive focus wakes. Tiny.
- **Tablet timers:** Home day-change every 60 s (`Home.tsx:21`), Catalog `useNow` 30 s (`CatalogRefresh.tsx:85`) → one timeout to the next boundary. XS, tiny.

## Already smart (checked, no change suggested)

Collections publication hashes artwork through a descriptor cache and asks the server which blobs are missing (`cloud/collections.rs:549-580,261`); the online-catalog update is watermark-incremental (`catalog_update.rs`); catalog count preparation re-check is 0.13 ms when unchanged (M); the character review feed digest is cursor-based (`character_review_feed.rs:320-345`); server background workers wait on `threading.Event` wakes (`mobile_catalog_refresh.py`, `catalog_duplicates.py:480-500`); the desktop credential reads go through a session cache (`credential.rs:397-437`).

## Not verified / where I looked

- Read: baseline doc in full; PC `workload.rs`, `cloud/{backfill,auto_publication,collections,captures}.rs`, `library/{mod,db,character_incremental,character_autotag,character_reference_refresh,character_shadow_backfill,similarity_scan,similarity_review_sync,catalog_duplicate_sync,character_review_feed,collection_updates,mangadex}.rs`, `media_protocol.rs`, `lib.rs`; React pollers under `_tools/app/src`; tablet `thumbnailWarm.ts`, `media.ts`, `useVisibleInterval` users; Android `MainActivity`, `ForegroundSchedule`, `ThumbnailCache`, `ExchangeService`, `AssetReplica`; server `sync_status.py`, `head_cache.py`, `app.py` (get_db, saved-x-media), `file_exchange.py`; extension `save-client.js`, `x-gallery.js`, `profile-store.js`, `content.js`.
- Not measured: #1's per-turn cost (needs a probe run with the character runtime configured), #4's request volume in a native WebView, the saved-X payload size, MangaDex batch API behaviour, whether WebView2/WebKitGTK honor `immutable` for the custom scheme.
- #5 (`useCharacterAutomation.ts`) and #6 (`thumbnailWarm.ts`) touch files changed by the first fix batch (`c553d16`); build on that commit.
