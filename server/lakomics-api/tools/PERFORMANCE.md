# Local API performance kit

For offline Collections staging validation and projection comparison, see
[the baseline dry-run harness](COLLECTION_BASELINE.md).

From `server/lakomics-api`, using the existing environment:

```sh
timeout 300 .venv/bin/python tools/poll_benchmark.py --runs 200 --warmup 20 --json /tmp/server-before.json
```

This starts an in-process FastAPI TestClient over generated data and an R2 stub.
It does not start a listening server. No URL/host/token option or remote transport
exists, so production is unsupported even if someone passes a confirmation flag.
Do not add production transport without explicit target approval and confirmation.
Inherited API token and exchange settings are replaced; refresh, prune and image
thumbnail background workers are excluded from the measured request path.

The suite includes polling/conditional 304s, asset classification, media/aspect/duration
filters, tag+artist filters, full and filtered TOC at UTC+9, popular and typed library
suggestions, catalog suggestions, media tickets and artwork checks. Route/parameter
contracts are checked against the current app. The fixture includes nonempty tag and
creator indexes; suggestions no longer benchmark only an empty table.

Output: compact endpoint table and optional JSON with fixture version/sizes, HTTP
status, run/request counts, response body bytes/min/max, median, nearest-rank p95 and
mean milliseconds. Warmups and ETag preparation count toward requests but not latency
samples. A 4xx/5xx or missing expected ETag raises an error instead of becoming a fast
successful timing. Bytes/request counts are deterministic for this fixture; timings
include TestClient and server work without TLS/network/R2 and do not prove production
latency. Keep data sizes, Python, machine and run parameters fixed across JSON files.

`--keep /tmp/unique-benchmark-dir` reuses only an empty directory or this exact version's
marked fixture; other existing data and symlinks are rejected **before SQLite opens**.
A failed initial publication can leave an incomplete fixture; choose a new empty path
rather than hand-writing a marker or pointing at a real database. Prefer the default
disposable directory. The marker prevents accidental reuse, not malicious tampering.

```sh
.venv/bin/python -m unittest discover -s tools -p test_poll_benchmark.py -v
```

Tests cover safe roots, real schema/fixture population, route parameter names, status
validation, ETags and p95 math. They are distinct from the full HTTP benchmark. During
the 2026-10-02 tooling audit, the full command was bounded by `timeout`: this execution
environment blocked in the AnyIO TestClient thread bridge on catalog publication.
Offline tests succeeded; no full endpoint timings are claimed for that environment.
Run the command in a normal local shell before using its numbers as a baseline.

`endpoint_perf.py` already extends this fixture with SQL/connection/R2 HEAD counters
and whole-library walks. It remains a separate existing attribution tool; its extra
instrumentation does not establish correlation with real device latency by itself.
