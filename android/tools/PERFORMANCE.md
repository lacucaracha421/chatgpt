# Tablet performance measurements

From `_tools/app/`, the single fixture command is:

```sh
npm run mobile:test -- --maxWorkers=2 --reporter=verbose mobile-client/perf.test.ts mobile-client/Collections.perf.test.tsx mobile-client/thumbnailWarm.perf.test.ts
```

The `[perf]` lines report shelf component render counts, thumbnail bridge calls,
page requests and cache probes, using jsdom and fake time. These are deterministic
work counts, not Android latency, decoding, GPU frames or battery measurements.
Existing count caps only tighten; pair any proposed improvement with a device run
under the same data, cache and power conditions. `perf.test.ts` also checks timing
log events and cancellation; it does not simulate device speed.

For the whole mobile suite use `npm run mobile:test -- --maxWorkers=2`.

## Startup

Startup instrumentation uses the same opt-in `LakomicsPerf=DEBUG` property as
Catalog. Install a controller-supplied instrumentation-only build first; this
step changes no request order, pool limits, launch readiness or cache policy.
Keep the connection, library, orientation, network, cache, device and power
conditions identical across runs. Force-stop gives a new process, not an empty
cache. Do not clear storage or caches. Repeat each build at least three times.

Run these commands from the repository root (replace `SERIAL`). Start capture
in a second terminal before launching, and leave it running for at least 20 s
after launch. If startup requests remain pending, capture until their terminal
lines arrive (a status long-poll may take about 70 s).

```sh
adb -s SERIAL shell setprop log.tag.LakomicsPerf DEBUG
adb -s SERIAL shell am force-stop com.lakomics.mobile
# Second terminal: capture only new timing lines. Ctrl+C ends capture.
adb -s SERIAL logcat -v threadtime -T 1 -s LakomicsPerf:I '*:S' > startup-before.log
# First terminal:
adb -s SERIAL shell am start -W -n com.lakomics.mobile/.MainActivity
# After capture ends:
python android/tools/perf_summary.py startup-before.log
adb -s SERIAL shell setprop log.tag.LakomicsPerf INFO
```

Use a separate log per process. Save `am start -W` output alongside the log:
Android's activity launch time is not the time until Home's data/images appear.
In PowerShell, `> startup-before.log` is also supported; the summary reads UTF-8.
Repeat as `startup-after.log` only after a later optimization build is supplied.

The new lines have these formats (all times in milliseconds):

```text
startupNative phase=notesDb activityMs=40 processMs=90 durationMs=30 uiThread=1
startupRequest route=library.assets lane=bridge status=ok submitMs=300 queueMs=10 runMs=80 poolSize=4 active=4 queued=2
startupHttp route=library.assets lane=bridge status=finished startMs=310 queueMs=10 runMs=75 poolSize=4 active=4
js startupRequest=library.assets status=ok startMs=100 endMs=200
js startup=1 firstReactRenderMs=60 homeReadyMs=500 viewportImagesReadyMs=630 splashLeavingMs=630 splashEndMs=870 issued=3 cancelled=1 reissued=1 pending=0 requests=library.assets:100:120:200:3:1:1:0
```

- `startupNative` offsets use `elapsedRealtime` from `onCreate` entry and
  `Process.getStartElapsedRealtime()` (API 24+; otherwise `processMs=-1`). Phases
  include entry/end, WebView creation, `loadUrl`, page started/finished, settings,
  Notes DB setup, vault initialization, media cache initialization (with a nested
  thumbnail directory scan/journal restore), first Picker read/resume, and native
  Album/Exchange initialization. `uiThread` shows where measured helpers actually
  ran. Nested phases overlap; never sum them. Page finished is not Home ready.
- Native bridge submissions in the first 15 s after `onCreate` report executor
  queue wait, total task run time and submit-time live pool size/active/queued
  counts. Lanes distinguish `bridge` (four workers), `media` (four), `thumbnail`
  (eight) and `catalogCover` (six). Live `poolSize` may be zero before workers
  start. Errors, cancellation and rejection remain visible; an operation that
  never started has `queueMs=-1` and `runMs=-1`.
- `startupHttp` records CloudClient API calls, status long-polls and downloads
  started in that window, including terminal lines after 15 s. Routes are fixed
  names; signed downloads use `download`, never a URL. `finished` means the call
  terminated, including failures; use bridge `status` for caller success. HTTP
  time includes response reading/parsing. Background lanes identify Album,
  Picker, Exchange, status-watch and ticket executors separately. Their queue
  measurement excludes the timer's intentional delay. Multiple HTTP calls in
  one executor task share its queue/snapshot; never add those queue times.
  `lane=direct` and `-1` pool/queue fields mean no measured executor context,
  not zero wait or evidence that the request used the four-worker bridge.
- `js startup=1` is emitted once when the existing React splash disappears.
  Offsets use `performance.now()` (navigation start), not the native clock.
  `firstReactRenderMs` is App's first render entry; `homeReadyMs` is the existing
  Home first-load condition. Image readiness is sampled when the splash starts
  leaving, after the existing image/quiet wait: it requires every current
  viewport image to have decoded or settled. It is not GPU paint or successful
  decoding of every image. `-1` means unobserved (for example a launch cap,
  connection screen or images still loading); it never means zero.
- `requests` is a comma-separated list of
  `name:firstStartMs:firstEndMs:lastEndMs:issued:cancelled:reissued:pending`.
  Those are all native bridge attempts admitted before splash removal,
  including local reads/cache probes. Each terminal `js startupRequest` also
  records its own start/end and status, including finishes after splash removal.
  Cancellation means an actual aborted attempt. Reissue means the same canceled
  API path (including its cursor), or the same native read identity/revision,
  was issued again; it does not guess why or count a different pagination cursor
  or media identity as a retry. These counts are evidence,
  not proof that a sync signal caused the cancellation.
- `collections.manga`, `.game` and `.movie` count individual shelf page reads;
  `library.assets` exposes the Home entry's first Asset-page fetch. Counts do
  not claim its returned data was consumed. Queries, cursors, IDs, tokens,
  titles and file names are never emitted in these startup lines.

The summary groups native phases, queue/run samples by route/lane/status, JS
milestones and per-route counts; `-1` values are omitted, not counted as zero.
Compare milestone median/p90 and request counts together. No latency threshold
or speed improvement is claimed by this instrumentation-only change.

## Catalog covers

Catalog timing is opt-in; the existing Library logs remain unchanged. On a build
containing `catalogPerf.ts` and the catalog changes in `PerfLog.java`, enable the
Android tag property before entering Catalog:

```sh
adb -s SERIAL shell setprop log.tag.LakomicsPerf DEBUG
adb -s SERIAL logcat -v threadtime -T 1 -s LakomicsPerf:I '*:S' > /tmp/catalog-after.log
# Stop capture with Ctrl+C, then disable catalog timing:
adb -s SERIAL shell setprop log.tag.LakomicsPerf INFO
```

Use the same device, orientation, network, query, sort, visible cover count and
power/warm settings for before and after. Capture a first visit, an immediate
revisit, and quick two-row down/up scrolling as separate runs; repeat each three
times. Do not clear app storage or the media cache. A first visit is not proof of
a cache miss: classify requests by the logged `cache` field. Do not compare a
cold before run with a warmed after run.

`catalogCover` reports `jsQueueMs`, `nativeQueueMs`, `cache`, `downloadMs`, `bytes`,
`storeMs`, `permitMs` and `status`. `storeMs` is cache bookkeeping/reservation and
commit outside the download callback; phases overlap and must not be summed.
`js catalogScreen` reports `firstCoverMs` and `visible90Ms` from list DOM layout
to decoded covers for the visible cohort frozen at entry (excluding preloads).
Keep the list still until the summary, then scroll. Leaving before 90% produces
`status=incomplete` and `visible90Ms=-1`. These timings are decode readiness, not
GPU paint timings. Cache-only or already decoded revisits remain distinct.

Older builds have no catalog timing. For an equivalent logged baseline the
controller must supply a build with only this instrumentation and the original
scheduling/range. Otherwise record both builds' screens and count frames from
list appearance to first/90% visible covers; native catalog breakdown is then
available only after the change. `perf_summary.py` parses native cover and JS screen lines.
Compare screen median/p90, request miss/cancel/error counts, total bytes and 429
failures directly in these logs; check quick scrolling for blanks or fading.

The offline six-slot fixture uses a fixed 200 ms native reply and twelve visible
covers; it is a queue regression measurement, not an Android speed estimate:

```sh
cd _tools/app
npm run mobile:test -- --maxWorkers=2 mobile-client/catalogMedia.test.ts mobile-client/CatalogCover.test.tsx mobile-client/catalogPerf.test.ts mobile-client/thumbnailWarm.test.ts mobile-client/collectionWarm.test.ts
```

## Thumbnail cohorts and Collection artwork

Thumbnail bridge requests prepare cache misses for the existing 50-item ticket endpoint
before entering the download queue. The frontend admits 24 visible requests plus at most
three speculative requests; native runs eight small downloads with a 48-entry queue.
Cache hits skip tickets. Cancellation detaches queued tickets and downloads. Original
media keeps its own four workers, eight transfer permits and ticket executor. Catalog
covers retain six workers/permits and no longer compete for original transfer permits.
Collection thumbnails use eight frontend slots; original artwork bypasses that queue.
Collection artwork still uses one ticket POST per miss: the current server has no batch
artwork route. No server change is required for Library thumbnail batches.

Enable `log.tag.LakomicsPerf DEBUG` as above to record `collectionArtwork` alongside
`catalogCover`. Artwork lines include cache, queue, lock, ticket, permit, download, bytes,
store, status and download retry counters. Identifiers are sanitized; payloads, tokens
and signed URLs are never logged. Disable with `INFO` after collection.

The parser includes both operations and `js catalogScreen`. Per-operation batch values
are overlapping observations; `native/ticketBatches unique` counts each batch once.
Split inputs at process restarts because batch IDs restart. Thumbnail `ticketMs` measures
only the worker's remaining wait; the ticket POST can overlap its native queue time.
Compare unique batch sizes/counts, cold queue/download timing and viewer latency under
matched conditions. Fixture counts do not establish device improvement.

Home uses same-day revisit snapshots (at most seven date images) for first paint and
reserves the existing mosaic geometry without a snapshot. Its lower sections wait for
that first revisit answer, including an empty/error answer, so they are not pushed down.
Live source signals refresh Home immediately; unchanged Home uses a ten-minute safety
read. Similarity has no dedicated server signal and uses that safety read plus its local
change events. Unsupported signals retain the one-minute fallback. Refreshes keep values.

## Existing Android instrumentation

Use an already installed build containing `PerfLog.java` and `mobile-client/perf.ts`.
No debug toggle is needed: media/thumbnail operations and the one-way JS timing
bridge emit the `LakomicsPerf` tag. This procedure does not install or clear app data.
Run from the repository root, select the intended serial from `adb devices -l`:

```sh
adb -s SERIAL logcat -v threadtime -T 1 -s LakomicsPerf:I '*:S' > /tmp/lakomics-device.log
# While capture runs: open Library, scroll, open an image, next five times, close.
# Repeat on a separately labelled warm-cache pass; finish logcat with Ctrl+C.
python3 android/tools/perf_summary.py /tmp/lakomics-device.log > /tmp/lakomics-device-summary.txt
# Or summarize existing logs directly:
adb -s SERIAL logcat -d -v threadtime -s LakomicsPerf:I '*:S' | python3 android/tools/perf_summary.py
```

Record device/build, orientation, visible/hidden state, battery saver/charging,
network, data size and whether caches were already warm alongside each log. Keep
before/after logs in separate files. Do not clear storage to manufacture a cold run.
Opening the installed app may use its configured server; device acceptance is a
separate authorized run, not part of the offline fixture command.

`perf_summary.py` prints count, median, nearest-rank p90 and max per cache class.
Native `totalMs` starts at worker submission (includes queue); `ticketMs`, download,
permit/lock and obtain fields explain waiting but overlap and must not be summed.
JS `openToCommitMs` is effect-start to DOM commit, not touch-to-paint. Native and JS
use different clocks; the parser joins by `(request id, asset id)` and subtracts
JS offsets for decode/commit phase lengths. Prepared/memory/shared/unmatched samples
remain distinct. Failures/cancellations are excluded from timing and counted.
The `js video=...` state events and proxy diagnostics are not timing samples and
are intentionally ignored. This kit does not yet instrument whole-app Android cold
start, screen navigation, hidden idle CPU or battery drain.

Offline parser checks:

```sh
python3 -m unittest discover -s android/tests -p test_perf_summary.py
```
