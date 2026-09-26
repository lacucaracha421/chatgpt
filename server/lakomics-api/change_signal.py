"""Process-local write signal: a generation counter that wakes long-poll waiters.

Every control-database connection handed out by ``get_db()`` that changed a row bumps
the generation when it closes (``tracked_get_db`` is the same rule for a test app's own
``get_db``). A ``/v1/sync/status`` long-poll parks on :meth:`WriteSignal.wait_beyond`
instead of re-reading the database on a timer, and recomputes only once something
was written.

The signal is a *hint*, never a correctness cursor (ADR-0037): a write that bypasses
``get_db`` (the image-thumbnail worker, catalog files, CLI tools) does not bump it, so a
waiter still re-reads on its own recheck interval, and a spurious bump only costs one
recompute that finds nothing changed.

``bump`` may be called from any thread (request handlers run in the AnyIO threadpool);
waiters are asyncio futures and are resolved on their own loop through
``call_soon_threadsafe``. Registration and the generation check happen under the same
lock as the increment, so a bump between a caller reading the generation and parking
is never lost: ``wait_beyond`` returns at once when the generation already moved.
"""
import asyncio
import threading
from contextlib import contextmanager


def _resolve(future):
    if not future.done():
        future.set_result(None)


class WriteSignal:
    def __init__(self):
        self._lock = threading.Lock()
        self._generation = 0
        self._waiters = set()

    @property
    def generation(self):
        with self._lock:
            return self._generation

    @property
    def waiter_count(self):
        with self._lock:
            return len(self._waiters)

    def bump(self):
        """Advance the generation and wake every parked waiter. Thread-safe."""
        with self._lock:
            self._generation += 1
            waiters = list(self._waiters)
        for loop, future in waiters:
            try:
                loop.call_soon_threadsafe(_resolve, future)
            except RuntimeError:
                pass  # that loop has closed; its waiter deregisters itself or is gone

    async def wait_beyond(self, generation, timeout):
        """Wait until the generation differs from ``generation`` or ``timeout`` seconds pass.

        Returns the generation observed afterwards (equal to ``generation`` on timeout).
        """
        loop = asyncio.get_running_loop()
        with self._lock:
            if self._generation != generation:
                return self._generation
            entry = (loop, loop.create_future())
            self._waiters.add(entry)
        try:
            await asyncio.wait_for(entry[1], timeout)
        except asyncio.TimeoutError:
            pass
        finally:
            with self._lock:
                self._waiters.discard(entry)
        return self.generation


def tracked_get_db(get_db, signal):
    """``get_db`` that bumps ``signal`` when the connection changed any row.

    The production ``app.get_db`` has the same rule built in; module test apps wrap
    their own connection factory with this so their writes wake waiters too.
    """
    @contextmanager
    def wrapped():
        changed = False
        try:
            with get_db() as db:
                try:
                    yield db
                finally:
                    changed = db.total_changes > 0
        finally:
            if changed:
                signal.bump()
    return wrapped
