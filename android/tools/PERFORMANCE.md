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
Use explicit UTF-8 output in PowerShell as shown below. The summary also accepts
UTF-8 with BOM and UTF-16 output from Windows PowerShell 5.1 redirection (`>`).
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
  Notes DB setup, vault initialization, media cache setup, background thumbnail
  directory scan/journal restore, first Picker read/resume, and native
  Album/Exchange initialization. `uiThread` shows where measured helpers actually
  ran. Thumbnail scan/journal restore now runs on a background thread; its
  duration remains logged with `uiThread=0`. Nested phases overlap; never sum
  them. Page finished is not Home ready.
- Native bridge submissions in the first 15 s after `onCreate` report executor
  queue wait, total task run time and submit-time live pool size/active/queued
  counts. Lanes distinguish `bridge` (six workers), `media` (four), `thumbnail`
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
  not zero wait or evidence that the request used the six-worker bridge.
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
adb -s SERIAL logcat -v threadtime -T 1 -s LakomicsPerf:I '*:S' > catalog-after.log
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

WebView remote debugging is enabled only when `log.tag.LakomicsPerf` is `DEBUG`, using the same opt-in check as performance logging; it stays off by default. Set the property before starting a fresh app process, then use Chrome's `chrome://inspect` over adb to inspect the gallery DOM, scroll offset, canvas height and row bounds during a measurement round. Afterward set the property back to `INFO` and restart the app process to turn remote debugging off.

Use an already installed build containing `PerfLog.java` and `mobile-client/perf.ts`.
Enable `log.tag.LakomicsPerf DEBUG`: media/thumbnail operations and the one-way JS
timing bridge emit the `LakomicsPerf` tag only while opted in. This procedure does not install or clear app data.
Run from the repository root, select the intended serial from `adb devices -l`:

```sh
adb -s SERIAL logcat -v threadtime -T 1 -s LakomicsPerf:I '*:S' > lakomics-device.log
# While capture runs: open Library, scroll, open an image, next five times, close.
# Repeat on a separately labelled warm-cache pass; finish logcat with Ctrl+C.
python android/tools/perf_summary.py lakomics-device.log > lakomics-device-summary.txt
# Or summarize existing logs directly:
adb -s SERIAL logcat -d -v threadtime -s LakomicsPerf:I '*:S' | python android/tools/perf_summary.py
```

Record device/build, orientation, visible/hidden state, battery saver/charging,
network, data size and whether caches were already warm alongside each log. Keep
before/after logs in separate files. Do not clear storage to manufacture a cold run.
Opening the installed app may use its configured server; device acceptance is a
separate authorized run, not part of the offline fixture command.

`perf_summary.py` prints count, median, nearest-rank p90 and max per cache class.
Native `totalMs` starts at worker submission (includes queue); `ticketMs`, download,
permit/lock and obtain fields explain waiting but overlap and must not be summed.
JS `openToCommitMs` remains effect-start to displayed DOM commit.
`tapToDisplayedMs` adds the originating Library/Character/Artists/Home tap through
the first Viewer commit, including time before the effect; it is absent for next,
previous, prefetch and retries. Neither field is touch-to-GPU-paint. Native and JS
use different clocks; the parser joins new records by the measurement-local `req` (and accepts legacy
`(request id, asset id)` logs) and subtracts
JS offsets for decode/commit phase lengths. Prepared/memory/shared/unmatched samples
remain distinct. Failures/cancellations are excluded from timing and counted.
The `js video=...` state events and proxy diagnostics are not timing samples and
are intentionally ignored. Startup and screen navigation are instrumented as described above and below.
Hidden idle CPU and battery drain require a separate device round.

Offline parser checks:

```sh
python -m unittest discover -s android/tests -p test_perf_summary.py
```


## Whole-experience screen and HTTP round

Use a controller-provided instrumentation APK on the Galaxy Tab S11. This kit does
not install, bump a version, change readiness, start downloads, clear caches, or
change request order or lane limits. Enable DEBUG before the round and leave it on
until capture and pending calls have settled. INFO disables the new helpers and
media/JS logging. Keep one process per log; force-stop resets the process counters.
Do not mix cold-process and warmed revisits in the same comparison group.

Capture startup, visit every bottom tab, open/close More, open a Collection work,
album and folder, open the release calendar, submit content search, open an Asset
Viewer and tap Read in Catalog. Keep each destination still through its initial
image observation, then perform the same scroll/next/back sequence on every build.
Repeat matched runs at least three times, preserving library, query, orientation,
visible cohort, charging, network and cache conditions. Queries stay in your run
notes, never in the performance log. Closing/backgrounding the app produces a
session snapshot too; check `pending` before treating the final totals as complete.

New lines (milliseconds; fixed screen/route vocabulary):

```text
js screen=collections trigger=tab readyMs=120.0 imagesReadyMs=240.0 status=ok
js screen=collection.work trigger=open readyMs=150.0 imagesReadyMs=410.0 status=ok
js screen=album trigger=back readyMs=30.0 imagesReadyMs=-1.0 status=incomplete
js screen=catalog.reader trigger=open readyMs=80.0 imagesReadyMs=320.0 status=ok
sessionHttp route=library.assets.subtree sessionMs=60000 requests=12 finished=10 failed=1 canceled=1 pending=0 bytesIn=200000 bytesOut=0 failedBytesIn=400 failedBytesOut=0 canceledBytesIn=600 canceledBytesOut=0
```

The actual `sessionHttp` field order is `route sessionMs requests finished failed
canceled pending bytesIn bytesOut failedBytesIn failedBytesOut canceledBytesIn
canceledBytesOut`. A Viewer terminal line keeps its existing format without `id`,
and adds `tapToDisplayedMs` only for the originally opened asset:

```text
js event=commit req=MEASUREMENT kind=image prepared=0 source=native status=ok elapsedMs=200.000 nativeMs=120.000 decodeMs=190.000 commitMs=200.000 tapToDisplayedMs=230.000
```

`MEASUREMENT` represents a generated measurement-local correlation token, not an
Asset/work identity. No entity identifiers, titles, URLs, cursors or query text
are included. Native validates screen, trigger, route and status names.

| Scenario / fixed screen | Start | Existing data-ready signal |
| --- | --- | --- |
| Home / `home` | bottom tab tap, return Back | App's AreaSwitch readiness, including Home's first-load skeleton |
| Assets / `assets` | bottom tab tap | committed Library page, or folder index ready/error at the root |
| Collections / `collections` | bottom tab tap, work Back | existing committed shelf/empty/error readiness |
| Catalog / `catalog` | bottom tab tap | existing list/detail/empty/error readiness |
| Notes / `notes` | bottom tab tap | existing list/editor/unlock/recovery surface readiness |
| More / `more` | More button tap | existing sheet content mounted; More is a sheet, not a sixth bottom tab |
| Collection work / `collection.work` | shelf/book/open/find/Home action | matching detail or detail-error state; image observation follows the work's existing surface-ready gate |
| Album / `album`, folder / `folder` | scope selection or parent Back | committed page/root readiness, including cached/empty pages |
| Release calendar / `releaseCalendar` | Home or Collection shortcut tap | existing ready/empty/error state after its existing bounded cover preparation |
| Content results / `contentSearch` | submit/open action | committed description-search page, not input typing |
| Catalog reader / `catalog.reader` | Read tap, before manifest/cache adoption | mounted manifest; images follow the existing decoded page and displayed slot |

`readyMs` starts at the action handler, not mount/effect. The observer samples the
first viewport after one rendering opportunity, freezes that cohort, and observes
existing load/error/decode/surface-ready signals. It never calls decode, makes
images eager, waits in the screen's load path, or adds requests. Readiness is not
GPU paint and includes failed images settling; it is not a guarantee every image
successfully decoded. `-1` means unobserved, never zero. Empty/no-image viewports
settle at observation time. A replacement action emits `canceled`; missing data or
images after the measurement-only 15 s cap emits `incomplete`. Errors are separate.
The summary groups count/median/nearest-rank p90/max by screen, trigger and status.

Fixed route additions in both native and JS are `albums.commands/baseline/changes`,
`classifications.authority.commands/baseline/changes`, `home.upcoming.wishlist`,
`collections.bindings.status/requests/search.kakao/search.mangadex`,
`library.assets.subtree`, `library.assets.search` (tag/artist filters), and
`library.search.description`. Subtree classification takes precedence when combined
with a tag/artist query. Dynamic binding request identities collapse to `requests`.

`sessionHttp` counts CloudClient HTTP attempts, including API, conditional reads,
status long-polls, provider image bodies and signed downloads, across the whole
DEBUG session rather than only the startup 15 s window. It does not count local
conditional-cache hits as HTTP. A native bridge operation may issue zero, one or
several requests; operation bytes and HTTP bytes must not be added together.
Exchange transfers using their own transport and WebView/video-proxy traffic are
outside CloudClient; use UID netstats for aggregate device traffic.

Snapshots are cumulative per process/route. Automatic completion snapshots run
every 60 s of active completions; activity pause also emits a snapshot. There is no extra idle timer/executor. Thus an
idle minute alone need not emit a line. A supported on-demand one-way bridge call
(from an authorized instrumented WebView context) is:

```js
window.LakomicsNative?.request('', 'perfLog', '{"event":"http_session"}');
```

This is not an adb shell command, and does not require enabling WebView debugging.
Capture a final pause snapshot; active requests remain `pending`. If necessary,
wait for terminal operations, resume, and background again for a later snapshot.
Disabling DEBUG mid-request intentionally leaves incomplete observations; start
a new process/log for the next round. The parser uses the latest snapshot for each
route, never sums repeated cumulative snapshots. `bytesIn/Out` are body bytes
read/completed writes, not TLS, HTTP headers, compressed wire size or a server's
claimed Content-Length. They include partial attempts, with failed/canceled subsets
shown separately. A write that throws cannot reveal how many bytes reached the
socket. JSON errors read by CloudClient are included; unconsumed error bodies are
not. Per-operation totals separately include successful, failed and canceled bytes.

## Windows collection equivalents

Run from the repository root. Log/output paths below are relative; use `python`,
not the Windows `python3` Store stub. Replace SERIAL with the authorized device.
These commands are documentation for a separately authorized device round.

Windows PowerShell (5.1 or newer; start logcat in a second terminal):

```powershell
$adb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
$serial = 'SERIAL'
& $adb -s $serial shell setprop log.tag.LakomicsPerf DEBUG
& $adb -s $serial shell am force-stop com.lakomics.mobile
# Second terminal: Ctrl+C ends capture.
& $adb -s $serial logcat -v threadtime -T 1 -s LakomicsPerf:I '*:S' | Set-Content -Encoding utf8 whole-experience.log
# First terminal:
& $adb -s $serial shell am start -W -n com.lakomics.mobile/.MainActivity | Out-File -Encoding utf8 activity-launch.txt
# After the round, final pause snapshot and capture have ended:
python android/tools/perf_summary.py whole-experience.log | Out-File -Encoding utf8 whole-experience-summary.txt
& $adb -s $serial shell setprop log.tag.LakomicsPerf INFO
python -m unittest discover -s android/tests -p test_perf_summary.py
```

Git Bash on Windows (adb must be the existing SDK executable on PATH):

```sh
export MSYS_NO_PATHCONV=1
adb -s SERIAL shell setprop log.tag.LakomicsPerf DEBUG
adb -s SERIAL logcat -v threadtime -T 1 -s LakomicsPerf:I '*:S' > whole-experience.log
# In the first terminal while capture runs:
adb -s SERIAL shell am start -W -n com.lakomics.mobile/.MainActivity
python android/tools/perf_summary.py whole-experience.log > whole-experience-summary.txt
adb -s SERIAL shell setprop log.tag.LakomicsPerf INFO
```

`MSYS_NO_PATHCONV=1` prevents Git Bash from rewriting device paths. The parser accepts
UTF-8, UTF-8 BOM, UTF-16LE/BE BOM and BOM-less UTF-16 log prefixes, from a file or
stdin. Plain `>` in PowerShell 5.1 usually writes UTF-16LE; explicit UTF-8 is easier
to exchange with other tools. Use the same shell/encoding before and after.

## Device-side frames, battery and traffic

These are separate device measurements, not fixture assertions. Record the exact
start/end and screen sequence; resets below reset measurement history, not app data.
Do not reset the app's storage, media cache or library.

Around one matched scroll (Git Bash: keep `MSYS_NO_PATHCONV=1`):

```sh
adb -s SERIAL shell dumpsys gfxinfo com.lakomics.mobile reset
# Perform the fixed scroll, then capture immediately (buffer is bounded):
adb -s SERIAL shell dumpsys gfxinfo com.lakomics.mobile framestats > scroll-frames.txt
```

PowerShell equivalents use `& $adb -s $serial ... | Out-File -Encoding utf8
scroll-frames.txt`. App HWUI/RenderThread composites the WebView surface; gfxinfo
provides app-level frame timing, not a complete account of Chromium renderer,
JavaScript, image decoding, scroll responsiveness or actual panel presentation.
It may miss WebView-internal work and its finite frame history can drop early
frames. Pair it with a same-condition screen recording/visual inspection; do not
infer smoothness or touch-to-paint from React commit timestamps alone.

For a battery round, record charging/saver/brightness/network conditions first:

```sh
adb -s SERIAL shell dumpsys batterystats --reset
# Perform a matched timed round (avoid changing charging state mid-round).
adb -s SERIAL shell dumpsys batterystats --charged > battery-round.txt
```

`--reset` clears device-wide BatteryStats history and affects other battery
analysis. `--charged` dumps
statistics since the charged/reset boundary, not a request to charge. BatteryStats
attribution is model-based, shared-system work and charging can distort comparisons,
and a short run is not a precise battery-drain result. No fabricated mAh improvement
should be inferred from HTTP request counts.

For traffic, find the current package UID and capture cumulative counters before
and after the same round:

```sh
adb -s SERIAL shell dumpsys package com.lakomics.mobile > package-uid.txt
adb -s SERIAL shell dumpsys netstats detail > netstats-before.txt
# Perform the round, then capture the same UID/interfaces/sets/tags/time buckets:
adb -s SERIAL shell dumpsys netstats detail > netstats-after.txt
```

Locate `userId=`/the UID in package output; never hard-code it across installs or
users. Compute rxBytes/txBytes deltas for the same UID, keeping interface, time
bucket, foreground/default set and tag aggregation consistent; do not double count
summary and detail rows or tagged/untagged views. Counters may update late, roll
buckets, reset at reboot or include background/native/WebView/shared-UID traffic.
Netstats measures bytes, not request counts or API routes; subtract matched before/
after values and compare with CloudClient body counters only as different scopes.
PowerShell uses the same commands with `& $adb` and `Out-File -Encoding utf8`.
