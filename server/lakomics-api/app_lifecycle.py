"""Application lifecycle and bounded worker shutdown.

With systemd TimeoutStopSec=10, use uvicorn --timeout-graceful-shutdown 2:
request drain gets 2 seconds, all worker joins share 6 seconds, and the remaining
2 seconds cover scheduling and process teardown. Lifespan runs AFTER request
drain, so chain the server's signal handler to release long polls before drain.
Blocking external I/O can outlive the join budget; worker threads remain daemon
threads and retain their handles until they exit. No hook gets a fresh budget.
"""
import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
from inspect import isawaitable
import signal
import threading
import time

from fastapi import FastAPI

WORKER_SHUTDOWN_SECONDS = 6.0
_pending_joins = ContextVar("shutdown_worker_joins", default=None)


def join_worker(thread, timeout, on_stopped=None):
    """Defer lifecycle joins until every stop hook ran; preserve standalone stops."""
    def join(remaining):
        thread.join(timeout=remaining)
        stopped = not thread.is_alive()
        if stopped and on_stopped is not None:
            on_stopped()
        return stopped

    pending = _pending_joins.get()
    if pending is not None:
        pending.append(join)
        return False  # Keep ownership until the deferred join confirms exit.
    return join(timeout)


class AppLifecycle:
    def __init__(self, previous_lifespan):
        self.startup_handlers = []
        self.shutdown_handlers = []
        self.drain_handlers = []
        self._previous_lifespan = previous_lifespan
        self._draining = False

    def on_startup(self, handler):
        self.startup_handlers.append(handler)
        return handler

    def on_shutdown(self, handler):
        self.shutdown_handlers.append(handler)
        return handler

    def on_drain(self, handler):
        """Register a nonblocking callback for the beginning of request drain."""
        self.drain_handlers.append(handler)
        return handler

    def begin_shutdown(self):
        if not self._draining:
            self._draining = True
            for handler in self.drain_handlers:
                handler()

    @asynccontextmanager
    async def _shutdown_signals(self):
        installed = {}
        if threading.current_thread() is threading.main_thread():
            loop = asyncio.get_running_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                previous = signal.getsignal(sig)
                # Uvicorn owns termination. Never replace default/ignored signals
                # in standalone apps. For asyncio-installed handlers, the loop's
                # existing wakeup fd and signal callback stay installed as well.
                if not callable(previous):
                    continue

                def handle(signum, frame, previous=previous):
                    # Do not acquire a WriteSignal lock from a Python signal handler:
                    # the interrupted thread might already own that same lock.
                    loop.call_soon_threadsafe(self.begin_shutdown)
                    previous(signum, frame)

                signal.signal(sig, handle)
                installed[sig] = (previous, handle)
        try:
            yield
        finally:
            for sig, (previous, handle) in installed.items():
                if signal.getsignal(sig) is handle:
                    signal.signal(sig, previous)

    async def _shutdown_workers(self):
        deadline = time.monotonic() + WORKER_SHUTDOWN_SECONDS
        pending = []
        token = _pending_joins.set(pending)
        errors = []
        try:
            # Hooks only signal/defer; legacy app.py wrappers participate unchanged.
            # Stop ALL workers before joining any.
            for handler in self.shutdown_handlers:
                try:
                    result = handler()
                    if isawaitable(result):
                        await result
                except Exception as error:
                    errors.append(error)
        finally:
            _pending_joins.reset(token)

        def join_all():
            for join in pending:
                join(max(0.0, deadline - time.monotonic()))

        if pending:
            await asyncio.to_thread(join_all)
        if errors:
            raise errors[0]

    @asynccontextmanager
    async def lifespan(self, app):
        self._draining = False
        async with self._previous_lifespan(app) as state:
            for handler in self.startup_handlers:
                result = handler()
                if isawaitable(result):
                    await result
            async with self._shutdown_signals():
                try:
                    yield state
                finally:
                    self.begin_shutdown()
                    await self._shutdown_workers()


def lifecycle(app: FastAPI) -> AppLifecycle:
    """Install once per app, including apps built directly by module tests."""
    hooks = getattr(app.state, "_lakomics_lifecycle", None)
    if hooks is None:
        hooks = AppLifecycle(app.router.lifespan_context)
        app.state._lakomics_lifecycle = hooks
        app.router.lifespan_context = hooks.lifespan
    return hooks
