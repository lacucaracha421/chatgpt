# Server tests

Run from `server/lakomics-api` with the existing virtual environment:

```sh
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tests -t .
```

The default search regression tests use 100 synthetic Assets and 2,000 tag
memberships in an in-memory database. They check the real suggestion SQL with
`EXPLAIN QUERY PLAN`, indexed sparse-artist lookup, and returned IDs/counts
without wall-clock assertions. The 100,000-Asset / 2-million-membership fixture
and its timing bounds run only when explicitly enabled (including class setup):

```sh
LAKOMICS_PERF=1 PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest tests.test_asset_search_performance -v
```

Keep this benchmark in a separate performance run on a consistent host; its
250 ms suggestion and 100 ms artist-page limits are hardware-sensitive. Skipping
it does not skip the small query-plan and result contracts.

`MutationFixture` contains setup and helpers only. Bookmark mutation, role, and
manga-index test classes each collect their own behavior cases, so importing or
inheriting the fixture does not repeat the bookmark mutation tests.

## Restricted runner: TestClient can stall before reaching a route

On 2026-10-02, the Codex sandbox stalled on the first HTTP request in discovery.
The same stall reproduced without FastAPI or application code:

```sh
timeout 10s .venv/bin/python - <<'PY'
from anyio.from_thread import start_blocking_portal
with start_blocking_portal() as portal:
    print(portal.call(lambda: "ok"), flush=True)
PY
```

Observed versions: Python 3.14, AnyIO 4.15.1, Starlette 1.6.0, FastAPI 0.141.1,
httpx 0.28.1. A stack dump showed the portal thread waiting in the selector and
the caller waiting on its future. Enabling asyncio debug logging in this probe
(`logging.basicConfig(level=logging.DEBUG)` and
`start_blocking_portal(backend_options={"debug": True})`) exposed
`PermissionError: [Errno 1] Operation not permitted` from
`asyncio.selector_events._write_to_self`, at `csock.send(b'\0')`. The sandbox
denies the event-loop wakeup socket write. Debug logging changed scheduling and
that probe completed despite the denied writes; it is not a reliable workaround.

This isolates an environment failure below the application routes, not a proven
application deadlock. Do not patch production code, skip HTTP coverage, or alter
the event loop to hide it. Use a runner whose normal policy permits these
wakeups for HTTP acceptance. Within a restricted runner, bound stalled runs and
report them as incomplete. The search module above calls route functions directly
and remains runnable, but does not establish HTTP transport acceptance.
