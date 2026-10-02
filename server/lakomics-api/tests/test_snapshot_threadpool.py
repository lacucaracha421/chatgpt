"""Direct ASGI-handler regression: a SQLite writer must not freeze the event loop."""
import asyncio
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

from fastapi import HTTPException
from starlette.requests import Request
import authority
import classification_authority
import library_snapshots


class SnapshotThreadpoolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'control.sqlite'
        self.entered = threading.Event()
        self.threads = []
        authority.startup(self.get_db)
        with self.get_db() as db:
            db.execute('''CREATE TABLE classification_snapshots(
                singleton INTEGER PRIMARY KEY, payload TEXT, published_at TEXT,
                updated_at TEXT, revision INTEGER NOT NULL DEFAULT 1)''')
            db.commit()
        self.entered.clear()
        self.threads.clear()
        api = SimpleNamespace(get_db=self.get_db, require_auth=lambda _: None,
                              MAX_LEGACY_SNAPSHOT_BYTES=512 * 1024,
                              now_iso=lambda: '2026-10-02T00:00:00Z')
        patch = mock.patch.object(library_snapshots, 'api', api, create=True)
        patch.start()
        self.addCleanup(patch.stop)

    @contextmanager
    def get_db(self):
        db = sqlite3.connect(self.path, timeout=2)
        db.row_factory = sqlite3.Row
        self.threads.append(threading.get_ident())
        self.entered.set()
        try:
            yield db
        finally:
            db.close()

    async def publish(self, body=None):
        body = body or {'entries': [], 'published_at': '2026-10-02T00:00:00Z'}
        async def receive():
            return {'type': 'http.request', 'body': json.dumps(body).encode(), 'more_body': False}
        request = Request({'type': 'http', 'headers': []}, receive)
        return await library_snapshots.publish_classification_snapshot(request, 'Bearer test')

    async def test_writer_contention_leaves_loop_responsive_and_preserves_response(self):
        blocker = sqlite3.connect(self.path, check_same_thread=False)
        blocker.execute('BEGIN IMMEDIATE')
        # A watchdog makes the regression bounded even if BEGIN blocks the loop.
        release = threading.Event()
        def unlock():
            release.wait(.8)
            blocker.rollback()
            blocker.close()
        thread = threading.Thread(target=unlock)
        thread.start()
        try:
            task = asyncio.create_task(self.publish())
            async with asyncio.timeout(2):
                while not self.entered.is_set():
                    await asyncio.sleep(.005)
            self.assertFalse(task.done(), 'writer wait ran on the event loop')
            self.assertNotIn(threading.get_ident(), self.threads)
            heartbeat = asyncio.create_task(asyncio.sleep(.01))
            await asyncio.wait_for(heartbeat, .2)
            release.set()
            result = await asyncio.wait_for(task, 2)
            self.assertEqual(set(result), {'ok', 'snapshotVersion', 'snapshotDigest', 'published_at', 'revision'})
            self.assertTrue(result['ok'])
            self.assertEqual((result['snapshotVersion'], result['revision']), (1, 1))
            retry = await self.publish()
            self.assertEqual(retry, result)
        finally:
            release.set()
            thread.join(2)

    async def test_stale_conflict_and_authority_fence_still_rollback(self):
        first = await self.publish()
        with self.assertRaises(HTTPException) as stale:
            await self.publish({'entries': [], 'published_at': '2026-10-01T00:00:00Z'})
        self.assertEqual(stale.exception.status_code, 409)
        with self.get_db() as db:
            self.assertEqual(db.execute('SELECT revision FROM classification_snapshots').fetchone()[0], 1)
        with mock.patch.object(authority, 'fence_legacy_write', side_effect=HTTPException(409, 'fenced')) as fence:
            with self.assertRaises(HTTPException) as fenced:
                await self.publish()
            self.assertEqual(fenced.exception.status_code, 409)
            self.assertEqual(fence.call_args.args[1], classification_authority.DOMAIN)
        self.assertEqual(await self.publish(), first)
