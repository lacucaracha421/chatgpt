# PC React measurement harness

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
