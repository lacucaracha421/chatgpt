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
