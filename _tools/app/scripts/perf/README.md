# PC React measurement harness

## PC timing log (Windows/Linux, real app)

Use a release build containing this logger with your configured library. Logging is
opt-in for each process: native startup reads `LAKOMICS_PERF` once, and only the exact
value `1` enables it. Normal launches perform one frontend enablement check and
create no log. Logging never changes the splash, navigation, prefetch or lazy loading.

From `_tools/app/`, in PowerShell:

```powershell
$env:LAKOMICS_PERF='1'; & .\src-tauri\target\release\lakomics.exe
# Remove the variable before a later normal launch:
Remove-Item Env:LAKOMICS_PERF
```

From Git Bash on Windows, or a Linux shell:

```sh
# Git Bash
LAKOMICS_PERF=1 ./src-tauri/target/release/lakomics.exe
# Linux
LAKOMICS_PERF=1 ./src-tauri/target/release/lakomics
```

Exit any already-running instance first, so a new process reads the variable.
The app appends to its Tauri application log directory under
`perf/pc-timing-YYYYMMDD.jsonl` (local calendar date). The application log directory
is platform-specific:

- Windows: `%LOCALAPPDATA%\com.lakomics.desktop\logs\perf\pc-timing-YYYYMMDD.jsonl`
- Linux: `${XDG_DATA_HOME:-$HOME/.local/share}/com.lakomics.desktop/logs/perf/pc-timing-YYYYMMDD.jsonl`

The directory includes the bundle identifier from `src-tauri/tauri.conf.json`.
Each line has a per-process `launchId` and `processMs`. Files stop accepting writes
at 5 MiB; input lines over 4 KiB are refused. Output is best-effort: IO errors are
ignored, batches flush about once a second and on `pagehide`, and a crash or forced
close can lose the final batch. Move a full log aside before collecting more on the
same day. No folder names, paths, asset IDs or media URLs are included.

- `startup.process-to-home`: native process entry to Home data committed, its
  first-screen images decoded, and the launch splash gone, followed by a paint
  opportunity. Milestones are `firstReactRender`, `homeDataReady`,
  `homeViewportImagesReady`, `splashLeaving`, `splashEnd`, and `homeFullyShown`.
  Splash timeout alone does not establish Home image readiness. Leaving Home before
  this completes cancels the startup interaction.
- `library.folder-switch.<kind>`: navigation intent to the matching folder's
  committed first viewport images decoded and given a paint opportunity. Kind is
  only `series`, `plain`, `character`, `album` or `other`; `tileCount` is the
  gallery's first-screen tile estimate, including tiles without images. Shelf images
  within the viewport also participate in readiness, but not in the gallery count.
- `collections.open.first` / `.warm`: intent to open Collections, the existing
  list-commit and first visible decoded cover phase, and the destination shown with
  a paint opportunity. `first` is the first attempted open in this process;
  `warm` means a later open, not a guaranteed cache hit. Empty lists and failed covers
  cannot establish first-cover readiness; leaving cancels their pending measurement.
- `tab.switch.<destination>`: navigation intent to the area switch's destination
  commit/shown callback plus a paint opportunity. Fixed destinations are `home`,
  `assets`, `collections`, `manga`, `notes`, `exchange`, `private_vault`, and `manage`.
  This follows the existing area readiness gate and its caps; it does not promise
  that every image, background request or animation in the destination has finished.
- Other `w4:` measures retain the existing native kit's phase definitions, including
  Collections queries and list-to-first-cover subphases. They are diagnostic phases,
  not additional complete navigation samples.

Two animation-frame boundaries approximate paint; they are **not compositor
acknowledgement**. Images are observed without promoting lazy loading or fetching
anything. Successful image readiness requires decoding; an error is not a successful
decode. Superseded interactions and interactions pending at `pagehide` have
`status: "cancelled"` and are excluded from successful duration statistics. These
are real-app timings, not reproducible benchmark thresholds or proof of native
acceptance on the other operating system.

`startMs` and startup milestones are relative to `performance.timeOrigin`.
The clock record includes that origin and the native startup record includes
`processStartUnixMs`, allowing alignment as
`timeOrigin + startMs - processStartUnixMs`. `processMs` on each raw line is its
native write time, which includes batching delay; do not treat it as a frontend
completion timestamp. Alignment uses the wall clock and can be affected by clock
adjustments; interaction durations use the frontend monotonic clock.

With Node 22 or newer, summarize one or more logs:

```sh
node scripts/perf/pc-timing-summary.mjs /path/to/pc-timing-20261006.jsonl
node scripts/perf/pc-timing-summary.mjs first.jsonl second.jsonl --json summary.json
node --test --test-isolation=none scripts/perf/pc-timing-summary.test.mjs
```

Tables show successful count, median, nearest-rank p90, minimum, maximum and
cancelled count per metric, overall and per launch. JSON also includes the grouped
metrics and startup milestones. Missing timings remain missing, rather than becoming zero. A partial
final JSON line is skipped and reported. Summary files contain the same fixed labels
and timings as the input.

From `_tools/app/`:

```sh
node scripts/perf/run.mjs --out /tmp/pc-before.json
node scripts/perf/run.mjs --out /tmp/pc-after.json --baseline /tmp/pc-before.json
```

The wrapper runs the existing Vitest suite, prints a compact table, saves all
per-component/per-command counters and returns the test exit code. It never installs
a dependency. Failed test output is retained on stderr. For the raw harness:

```sh
LAKOMICS_PERF=1 npx vitest run src/app/App.perf.test.tsx --silent=false --reporter=verbose
```

`--log /tmp/vitest.log` parses an already recorded verbose log without rerunning;
its JSON has `testExitCode: null`, since parsing a log cannot prove test success.
The default Vitest reporter may hide successful console output, so retain `verbose`.
Baseline comparison reports new/missing scenarios; a missing counter in a matching
scenario means zero calls. Missing scenarios are never counted as a performance win.

- `commits`: React Profiler commits touching the app tree. A commit is not paint.
- `renders`: selected wrapper component calls and separately named helper calls
  (`thumbnailUrlCalls`, `buildMasonryLayout`); their aggregate is labelled probe calls,
  not total React renders. Detailed counters are in JSON.
- `gateway` / `invoke`: mock method/native command counts, not network request or SQL
  counts. Poll responses use fresh objects, mirroring IPC serialization.
- `profilerActualMs`: diagnostic React render work in jsdom, not interaction latency.
- `thumbnail-scroll-back`: revisioned image mounts, distinct URLs and unversioned
  mounts, in JSON. This auxiliary gate has no commit snapshot.

Scenarios use a fixed date, fake time, 1,000 generated assets (paged using the actual
requested limit), 60 collections, a synthetic note, and an uninstalled online catalog.
Home and manga therefore measure this fixture's screen entry, not populated production
content. The folder fixture returns the same dataset for each folder; it measures the
navigation/render path, not real filtered query cost. Viewer movement is exactly five
next actions (first + remaining four). Startup includes five fake seconds for Home plus
two for assets. Notes uses the current textarea editor; Find opens and types five letters.

Run the suite in the same order and environment for before/after. Optional
`LAKOMICS_PERF_QUIET=1` holds poll objects stable for attribution; never compare quiet
against ordinary runs (the wrapper rejects that). Wall times are descriptive. Keep the
existing idle/cache gates; establish correlation with the native kit before creating
any new tighten-only count thresholds. No native latency claim follows from these tests.
