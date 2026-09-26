"""Aggregate sync status: one small authenticated read of active authority domains.

ADR-0037 decision 1: clients use an aggregate endpoint to discover which domains
have moved to server authority and how far each has advanced, then run their
domain-specific receive/flush logic. There is deliberately **no** global cursor:
each domain keeps its own epoch/cursor, and this response only reports them.

This endpoint is read-only and adds no behavior change to any domain. While no
authority row exists it reports zero active domains, which is exactly the state a
pre-cutover client must see.

Additive blocks (``protocolVersion`` stays 1, nothing new enters ``domains[]``):

* ``publisherLogs`` — only for a ``publisher`` credential: the head of every log the PC
  publisher polls, so it can skip a log read until its head moves past the local cursor.
* ``signals`` — only with ``?signals=1``: the revisions the tablet's own status polls
  compare. Opt-in, so a deployed client that sends no query keeps a byte-identical body
  and ETag (the tablet treats any other body change as "the library moved").

Long-poll (``?wait=<seconds>``, clamped to ``0..max_wait``): honoured only when
``If-None-Match`` already matches the current document. The request is then held,
without a threadpool thread, until a control-database write changes *this caller's*
document (answered ``200``) or the wait ends (``304``). Writes are observed through
:class:`change_signal.WriteSignal`; every ``recheck`` seconds the document is recomputed
anyway, which covers writers that bypass ``get_db``. Every response carries
``Lakomics-Status-Wait: <max_wait>`` so a client can detect the capability.
"""
import asyncio
import math
import threading

import api_auth
import authority
import conditional
from app_lifecycle import lifecycle
from fastapi import Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

PREFIX = "/v1/sync"

#: Longest hold a client may ask for. Below the PC agent (wait + 20 s) and tablet read
#: timeouts the clients configure for a long-poll, and below common proxy idle limits.
MAX_WAIT_SECONDS = 50
#: A held request recomputes at least this often even without a write signal.
RECHECK_SECONDS = 15
#: After a write signal, wait this long so a burst of writes costs one recompute.
DEBOUNCE_SECONDS = 0.1
#: Held requests beyond these answer at once, exactly like a request without ``wait``.
MAX_WAITERS = 64
MAX_WAITERS_PER_PRINCIPAL = 4
WAIT_HEADER = "Lakomics-Status-Wait"


def _active_view(domains):
    """The public domain list, with only the fields a client needs to poll cheaply."""
    return [{"domain": entry["domain"], "libraryId": entry["libraryId"], "epoch": entry["epoch"],
             "contractVersion": entry["contractVersion"], "cursor": entry["cursor"]}
            for entry in domains]


def _library_identity(domains):
    """The single logical library these domains agree on, or None when inactive.

    A single-library server cannot have two active libraries. Disagreement is an
    impossible state, so it is reported instead of resolved by picking one — a
    client that guessed here could reconcile against the wrong authority.
    """
    libraries = sorted({entry["libraryId"] for entry in domains})
    if len(libraries) > 1:
        raise HTTPException(503, detail={"code": authority.CODE_AUTHORITY_AMBIGUOUS,
                                         "message": "동기화 권위 상태가 모호합니다.",
                                         "libraries": libraries})
    return libraries[0] if libraries else None


def requested_wait(raw, ceiling):
    """``?wait=`` in seconds, clamped to ``0..ceiling``; anything unparseable means 0."""
    try:
        seconds = float(raw)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(seconds):
        return 0.0
    return max(0.0, min(seconds, ceiling))


class _Waiters:
    """Admission for held requests: bounded in total and per principal."""

    def __init__(self, total, per_principal):
        self.total, self.per_principal = total, per_principal
        self._lock = threading.Lock()
        self._held = {}
        self._count = 0

    def enter(self, principal):
        with self._lock:
            if self._count >= self.total or self._held.get(principal, 0) >= self.per_principal:
                return False
            self._count += 1
            self._held[principal] = self._held.get(principal, 0) + 1
            return True

    def leave(self, principal):
        with self._lock:
            self._count -= 1
            left = self._held[principal] - 1
            if left:
                self._held[principal] = left
            else:
                del self._held[principal]


async def _disconnected(receive):
    """Returns once the peer has gone (the ASGI ``http.disconnect`` message)."""
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            return


def register_sync_status(app, get_db, require_client, exchange_status=None, *,
                         publisher_logs=None, signals=None, write_signal=None,
                         max_wait=MAX_WAIT_SECONDS, recheck=RECHECK_SECONDS,
                         debounce=DEBOUNCE_SECONDS, max_waiters=MAX_WAITERS,
                         max_waiters_per_principal=MAX_WAITERS_PER_PRINCIPAL):
    """Register ``GET /v1/sync/status``.

    ``exchange_status(db, principal)``, ``publisher_logs(db)`` and ``signals(db)`` add
    their blocks inside the same read transaction. Without ``write_signal`` there is no
    long-poll and no ``Lakomics-Status-Wait`` header.
    """
    def startup():
        authority.startup(get_db)

    lifecycle(app).on_startup(startup)

    waiters = _Waiters(max_waiters, max_waiters_per_principal)
    extra_headers = {WAIT_HEADER: format(max_wait, "g")} if write_signal is not None else None
    # (write generation, principal, signals) -> task computing (body, etag), so the waiters
    # woken by one write recompute once per caller. A principal's role never changes (a new
    # role is a new credential), so the principal id implies it.
    memo = {}

    def document(principal, want_signals):
        exchange = logs = extra = None
        with get_db() as db:
            db.execute("BEGIN")
            try:
                domains = authority.active_domains(db)
                # File exchange arrivals ride on this poll instead of a poll of their own.
                if exchange_status is not None:
                    exchange = exchange_status(db, principal)
                if publisher_logs is not None and api_auth.principal_role(db, principal) == "publisher":
                    logs = publisher_logs(db)
                if want_signals and signals is not None:
                    extra = signals(db)
            finally:
                db.rollback()
        payload = {"protocolVersion": authority.PROTOCOL_VERSION,
                   "active": bool(domains),
                   "libraryId": _library_identity(domains),
                   "domains": _active_view(domains)}
        if exchange is not None:
            payload["exchange"] = exchange
        if logs is not None:
            payload["publisherLogs"] = logs
        if extra is not None:
            payload["signals"] = extra
        body = conditional.encode(payload)
        return body, conditional.etag_for(body)

    def authenticated_document(authorization, want_signals):
        """Auth and the first computation in one threadpool hop (the common, non-waiting path)."""
        principal = require_client(authorization)
        return (principal, *document(principal, want_signals))

    async def shared_document(generation, principal, want_signals):
        """``document`` computed once per write generation and caller, however many wake."""
        key = (generation, principal, want_signals)
        loop = asyncio.get_running_loop()
        task = memo.get(key)
        if task is None or task.get_loop() is not loop:
            for stale in [entry for entry in list(memo) if entry[0] < generation]:
                memo.pop(stale, None)
            task = memo[key] = loop.create_task(run_in_threadpool(document, principal, want_signals))
        try:
            # Shielded: one waiter leaving must not cancel the computation others await.
            return await asyncio.shield(task)
        except Exception:
            if memo.get(key) is task:
                memo.pop(key, None)
            raise

    async def hold(request, authorization, principal, want_signals, if_none_match,
                   generation, body, etag, seconds):
        loop = asyncio.get_running_loop()
        deadline = loop.time() + seconds
        gone = asyncio.ensure_future(_disconnected(request.receive))
        try:
            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    break
                waiting = asyncio.ensure_future(
                    write_signal.wait_beyond(generation, min(remaining, recheck)))
                await asyncio.wait({waiting, gone}, return_when=asyncio.FIRST_COMPLETED)
                if gone.done():
                    waiting.cancel()
                    await asyncio.gather(waiting, return_exceptions=True)
                    break  # nobody is left to answer
                if waiting.result() != generation:
                    await asyncio.sleep(debounce)
                    generation = write_signal.generation
                    body, etag = await shared_document(generation, principal, want_signals)
                else:
                    # Recheck: a writer that bypasses `get_db` never signals.
                    generation = write_signal.generation
                    body, etag = await run_in_threadpool(document, principal, want_signals)
                if not conditional.matches(if_none_match, etag):
                    # New data only to a credential that is still accepted.
                    await run_in_threadpool(require_client, authorization)
                    break
        finally:
            gone.cancel()
            if gone.done() and not gone.cancelled():
                gone.exception()  # retrieved, so a failed receive is not logged as unhandled
        return conditional.encoded_response(body, etag, if_none_match, extra_headers)

    @app.get(PREFIX + "/status")
    async def sync_status(request: Request, authorization: str | None = Header(default=None),
                          if_none_match: str | None = Header(default=None)):
        want_signals = request.query_params.get("signals") == "1"
        seconds = 0.0
        generation = None
        if write_signal is not None:
            seconds = requested_wait(request.query_params.get("wait"), max_wait)
            # Read before computing: a write during the computation then ends the wait at once.
            generation = write_signal.generation
        # This is the most polled document on the server. Between commands it does not
        # change, so a client that sends the previous ETag back gets 304 and can skip
        # every per-domain change-feed poll until the aggregate moves.
        principal, body, etag = await run_in_threadpool(authenticated_document, authorization, want_signals)
        if seconds <= 0 or not conditional.matches(if_none_match, etag) or not waiters.enter(principal):
            return conditional.encoded_response(body, etag, if_none_match, extra_headers)
        try:
            return await hold(request, authorization, principal, want_signals, if_none_match,
                              generation, body, etag, seconds)
        finally:
            waiters.leave(principal)

    return startup
