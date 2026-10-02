# Native check and performance kit

Drives a real Linux Lakomics WebKitGTK window on a disposable **test library**.
Screenshot mode is preserved. Performance mode records a single JSON scenario suite,
WebView marks, motion frame intervals and app process samples. It never builds the app.

## Prerequisites and safety

The controller must separately prepare the embedded-frontend binary at
`~/.cache/lakomics-native-check/target/debug/lakomics`. Do not launch the ordinary
`src-tauri/target/debug/lakomics` binary. Needs Node >=24, `sqlite3`, `dbus-daemon`,
`ss`, `getconf`, `~/.cargo/bin/tauri-driver` and `~/.cargo/bin/WebKitWebDriver`.

Use an already prepared library at `~/.cache/lakomics-native-check/library` with
`.lakomics-dev-library` and disabled/empty cloud settings. The runner rejects a
symlink library/database. Perf also requires `manga_root`, `collection_source_root`
and `private_vault_last_root` to be NULL, preventing copied settings from opening
external folders. It does not open a source library or repair the fixture on launch.

`make_test_library.py <source-root> [<empty-test-root>]` remains the separately
invoked read-only-copy helper. It reads the source through SQLite backup, copies
artwork/thumbnails/catalogs, clears cloud and external root settings and marks the
copy. It now refuses a nonempty target, instead of deleting its database. Source
copying needs its own task authorization; it is not part of measurement or dry-run.

The copy helper does **not** copy originals. For a successful perf run, prepare a
fully local disposable fixture with at least 1,000 images, original image files for
the first six assets, thumbnails, a populated first folder, collections and an offline
catalog. Use generated/test-owned media, never links into the real library. Keep a
fixture snapshot and describe its size/media/build with the results. Missing/broken
visible media is a failed scenario, not a fast successful viewer measurement. An
empty catalog measures only empty-state entry; label that condition explicitly.

Safety layers are retained for both live modes:

- Test marker and no cloud URL, sync or capture; no supplied production-library path.
- A private D-Bus session without service directories, so the host keyring is unavailable.
- Fresh private XDG config/data/cache/runtime directories for each run, under
  `~/.cache/lakomics-native-check/home-*`; no stale remembered library path.
- HTTP/HTTPS/all proxies point to a closed port. Perf ignores `NATIVE_CHECK_ALLOW_HOSTS`;
  screenshot mode keeps the existing explicit host override. This is defense in depth,
  **not OS network isolation**: code that ignores proxies is not sandboxed.
- `connections.txt` records the driver's app process tree connections at the end; it
  does not prove absence of earlier traffic. Config/cache folders remain for diagnosis.

## One command per kit

All commands here use repository-root paths unless a `cd` is shown.

```sh
# Native performance (already built binary and prepared test fixture only).
node _tools/app/scripts/native-check/run.mjs --perf _tools/app/scripts/native-check/scenarios/perf-all.json /tmp/native-before
node _tools/app/scripts/native-check/run.mjs --perf _tools/app/scripts/native-check/scenarios/perf-all.json /tmp/native-after --baseline /tmp/native-before/perf.json

# Existing screenshots; the file is the same JSON list as before.
node _tools/app/scripts/native-check/run.mjs steps.json /tmp/native-shots

# PC render/commit counts, compact table + complete JSON.
(cd _tools/app && node scripts/perf/run.mjs --out /tmp/pc-before.json)
(cd _tools/app && node scripts/perf/run.mjs --out /tmp/pc-after.json --baseline /tmp/pc-before.json)

# Tablet deterministic work counts (verbose prints the existing [perf] lines).
(cd _tools/app && npm run mobile:test -- --maxWorkers=2 --reporter=verbose mobile-client/perf.test.ts mobile-client/Collections.perf.test.tsx mobile-client/thumbnailWarm.perf.test.ts)

# Server, synthetic local FastAPI instance only; no listener or production URL.
(cd server/lakomics-api && timeout 300 .venv/bin/python tools/poll_benchmark.py --runs 200 --warmup 20 --json /tmp/server-before.json)
```

PC details: [render harness](../perf/README.md). Android device log capture and
summary: [tablet/device guide](../../../../android/tools/PERFORMANCE.md).
Server details: [local benchmark](../../../../server/lakomics-api/tools/PERFORMANCE.md).

## Native scenarios and outputs

`scenarios/perf-all.json` covers startup to assets, folder switch, 16,000 px deep
scroll, viewer open / next five / close, Collections, manga,
Home, Find open/type and visible idle 60 seconds. Hidden idle was dropped on
2026-10-02: WebKitGTK on this desktop never reports `visibilityState === hidden`
after a WebDriver minimize; the PC render harness (`workload-hidden`) covers it.
`setup` is unmeasured and resets to the all-assets grid at the top;
`steps` are measured. The viewport is 1440x1000. Adapt selectors/fixture-specific
folder choice in the JSON rather than inserting production app hooks.

Clicks are dispatched on the element itself after checking it is the topmost hit at
its centre: WebKitWebDriver's own element click lands on the wrong point under a
fractional device scale (desktop text scaling 1.1 turned the viewer close into a
trash click). Settle accepts `allowAlerts` (an expected offline banner, e.g. the
online catalog) and `ignoreBrokenSrc` (network-only previews such as Home release
posters, which the driver's dead proxy blocks).

Notes is **not** in `perf-all.json` (2026-10-02): the in-memory notes IPC fixture
below cannot install, because Tauri makes `window.__TAURI_INTERNALS__.invoke`
non-writable, and the private D-Bus has no Secret Service for real notes. Notes
typing is measured by the PC render harness. A native notes scenario needs a
disposable Secret Service inside the private bus (backlog).

The (currently inert) Notes fixture would install a **measurement-only in-memory notes IPC fixture in
this WebView**, intercepting only `notes_request`. It neither persists notes nor
unlocks the personal keyring. Its input/render timing is useful; it is not native
notes encryption, storage or sync latency. All other commands use the real backend.
This is enabled explicitly by `notesFixture: true` in the suite; no app source hook
was added. A run without it needs separate safe credential fixtures to edit notes.

`perf.json` holds raw frame intervals, long tasks, per-step measures, process samples,
capabilities, definitions, summaries and baseline deltas. `perf.md` is the compact
summary; the driver prints it. Reports are written after each scenario, preserving
partial failures; any failed scenario makes the live command exit nonzero.

| Number | Meaning and limits |
|---|---|
| WebView duration | `performance.mark/measure` from before action to the configured readiness check, including driver round trips and deliberate typing/wait cadence. Per-step records separate the action and settle cost. |
| Host duration | Monotonic driver duration. Startup includes fresh process/session creation and grid readiness, after an unmeasured path bootstrap. File/OS caches are warm; this is not cold boot. |
| Settled | Target exists and is visible, no visible busy/error/skeleton state, decoded visible images, 300 ms without subtree mutations, then two rAF callbacks. Bounded to 15 s; not proof of background/network idle. Viewer next also requires the visible original source to change, avoiding timing the retained previous image. |
| Frame p50/p95 | Nearest-rank positive rAF deltas during motion scenarios (including their settle tail). Not GPU presentation timestamps. Jank = delta > 1.5 x `frameBudgetMs`; set the budget to the display refresh interval and keep it fixed across baselines. |
| Long tasks | Supported PerformanceObserver long tasks during each instrumented scenario, count and total duration. Unsupported WebKit reports null, not zero. Startup tasks before probe installation cannot be observed. |
| JS heap | `performance.memory.usedJSHeapSize` at scenario end if exposed; null otherwise. Not WebView/native total memory. |
| CPU/RSS | `/proc` samples every ~250 ms for this driver's exact app executable and descendants, including WebKit. CPU uses utime+stime deltas divided by real elapsed time and CLK_TCK; 100% = one core, may exceed 100%. RSS sums pages using host PAGESIZE; shared pages can be double-counted. Short-lived exited children may be missed. No system-wide or unrelated Lakomics processes. |
| Idle hidden | Not in `perf-all.json` (see above). A custom suite may still add it: it requires real `document.visibilityState === hidden` after WebDriver minimize, no spoofing; unsupported minimize/visibility is a failure. |
| Baseline delta | After minus before, percentage undefined when before=0. Missing/unsupported metrics stay null; failed scenarios are excluded from deltas. New/missing scenarios are listed. A changed frame budget is rejected. Conditions and fixture/build must match manually. |

The initial session only remembers the test path; performance starts in a fresh
second process without arbitrary startup sleeps. Probes install when the new session
becomes available, so WebView duration is shorter than launch-to-grid host duration.
No initial-load long-task coverage is implied. Keep window/refresh rate, build profile,
power mode, fixture, display scale and cache condition fixed. Repeat several runs;
wall-clock percentiles are evidence, not standalone regression gates.

The screenshot step list still accepts `waitFor`, `eval`, `click`, `dblclick`, `key`,
`resize`, `wait` and `shot`. Perf schema accepts the documented suite operations only;
unknown flags/steps fail before app launch. `assert` is trusted measurement JavaScript.

## Offline validation (no app or library access)

```sh
node --test --test-isolation=none _tools/app/scripts/native-check/perf.test.mjs _tools/app/scripts/perf/report.test.mjs
node _tools/app/scripts/native-check/run.mjs --perf _tools/app/scripts/native-check/scenarios/perf-all.json /tmp/native-dry --dry-run
node _tools/app/scripts/native-check/run.mjs --perf _tools/app/scripts/native-check/scenarios/perf-all.json /tmp/native-sample --sample _tools/app/scripts/native-check/samples/recorded.json --baseline _tools/app/scripts/native-check/samples/recorded.json
```

The checked-in recording is deliberately synthetic report input, not measured native
performance. `--sample` can also re-summarize a previously captured `perf.json`; output
is labelled offline. These exits happen before binary/library checks, D-Bus or app
launch. Live selector readiness, minimize behavior, startup persistence, image decoding,
process coverage and screenshot compatibility still need the controller's built binary.

## PC viewer and Collections phase timing (W4)

The app enables these User Timing probes only when `window.__nativeCheckPerf` is
installed by this kit. Ordinary production sessions create no marks, cover observers
or extra decode calls. Marks use a `w4:` prefix and contain no asset IDs or URLs.
`perf-webview.mjs` exports app measures into `perf.json` at
`scenarios[].measures` alongside the existing driver step measures. Each app measure
has `name`, `startTime` (relative to the WebView time origin) and `duration` in ms.
Internal start marks are cleared on completion/unmount; app measures are cleared
at the next scenario start. The Markdown summary still reports whole scenarios.

| Measure | Meaning |
| --- | --- |
| `w4:viewer.open-to-visible` | Captured gallery double-click to the first image's paint opportunity. |
| `w4:viewer.next-to-visible` | Captured arrow key to the requested image's paint opportunity. |
| `w4:viewer.request.loaded` | Requested source commit to its DOM load event; absent for an already prefetched image. |
| `w4:viewer.request.decoded` | Requested source commit to decoded, active DOM image. Includes loading and React promotion; near zero for a warmed image. |
| `w4:viewer.request.visible` | The same request through two animation-frame boundaries after promotion. |
| `w4:viewer.decode.done` / `w4:viewer.prefetch-decode.done` | The actual element's `decode()` promise after load, for requested/speculative media. Cache-dependent; a rejected decode is treated as settled as before. |
| `w4:collections.query.arrived` | `list_collections` IPC dispatch to result. Usually in startup, not Collections entry, because the shell already holds the list. |
| `w4:collections.list-to-first-cover.loaded` / `.decoded` / `.visible` | List props committed to the browser through the first visible front cover's load, decode and paint opportunity. Includes layout/mount work after that commit; does not wait for every cover. |
| `w4:collections.open-to-visible` | Captured rail click to that first cover's paint opportunity. |

Two rAF boundaries are a paint opportunity, not proof of compositor presentation.
No cover measure is emitted for an empty/private list or failed image; missing is
not zero. An interrupted viewer request has no visible measure. Decode time after
`load` can be short even if WebKit spent CPU decoding during the load. These spans
cannot separate native protocol queue/file reads from WebKit loading; use the
requested-load span plus native process/frame samples for that boundary.

Keep the original scenario and quiet window for before/after comparisons. The
viewer scenario has **seven** settles (open, five next, close), each with a default
300 ms quiet window, 25 ms polling and two rAFs. At least 2.1 seconds of its total
is therefore deliberate quiet time, plus driver overhead; it is not six image
latencies. Collections has one such settle, observes the whole section (including
late shelf metadata/cover changes), and does not require any images for success.
The first-cover measure distinguishes usable content from that final quiet window.

The viewer warms one next library image only after the current image decodes. It
retains two actual DOM image slots, so promotion does not rely on WebKit reusing a
separate `new Image()` preload. Originals and zoom/animation fidelity are preserved;
there is no screen-size original variant in this path. Privacy mode, vault originals
and adjacent video media are not prefetched. A missing speculative image cannot
fail the current view. Supply at least seven local originals to measure all six
requested images with the final look-ahead present, and match the fixture in both runs.
