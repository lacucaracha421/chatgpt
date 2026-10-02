"""Bound SQLite work on HTTP reads, independently of client disconnects.

The request marker is copied by AnyIO into synchronous worker threads. Deadlines
start per connection, not at HTTP arrival: async long-poll waits consume no budget.
Non-GET/HEAD requests, startup, import/publish/refresh/backfill and background jobs
are deliberately unmarked. This is a VM execution limit, not a network/lock timeout.
"""
from contextvars import ContextVar
import sqlite3
import time

from fastapi import HTTPException

READ_SECONDS = 15.0
PROGRESS_STEPS = 10_000
http_read = ContextVar("sqlite_http_read", default=False)


class ReadBudgetMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        marker = http_read.set(scope["type"] == "http" and scope.get("method") in ("GET", "HEAD"))
        try:
            await self.app(scope, receive, send)
        finally:
            http_read.reset(marker)


class Budget:
    def __init__(self, db, seconds):
        self.deadline = time.monotonic() + seconds
        self.expired = False
        db.set_progress_handler(self.check, PROGRESS_STEPS)

    def check(self):
        self.expired = self.expired or time.monotonic() >= self.deadline
        return int(self.expired)

    def translate(self, exc):
        # An unrelated interrupt or OperationalError must retain its old handling.
        if self.expired and getattr(exc, "sqlite_errorcode", None) == sqlite3.SQLITE_INTERRUPT:
            raise HTTPException(503, "Database read took too long; please retry") from exc


def install(db, seconds=READ_SECONDS):
    """Also shared by the catalog's existing, explicit ten-second read budget."""
    return Budget(db, seconds)
