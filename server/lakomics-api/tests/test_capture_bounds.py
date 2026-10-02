"""In-process capture deadlines, reservations and rollback cleanup; no sockets."""
import asyncio
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

import httpx
from fastapi import HTTPException
from tests.test_capture_api import FakeResponse, FakeStream, api_app, fake_s3
import capture_routes as routes
import capture_store as store


class CaptureDownloadBoundsTests(unittest.TestCase):
    def setUp(self):
        fake_s3.objects.clear()
        fake_s3.deleted.clear()
        fake_s3.fail_put = False

    def fetch(self):
        return store.fetch_media_to_r2('https://video.twimg.com/test.mp4', 'videos/inbox/test/original', 'video')

    def test_budget_scales_with_size_and_is_capped(self):
        self.assertEqual(store.download_budget(0), 30)
        self.assertEqual(store.download_budget(256 * 1024), 31)
        self.assertEqual(store.download_budget(512 * 1024 * 1024), 300)

    def test_deadline_cancels_slow_body_with_and_without_length_and_removes_temp(self):
        class SlowResponse(FakeResponse):
            async def aiter_bytes(self):
                while True:
                    await asyncio.sleep(.005)
                    yield b'x'

        paths = []
        original = tempfile.mkstemp

        def mkstemp(*args, **kwargs):
            fd, path = original(*args, **kwargs)
            paths.append(Path(path))
            return fd, path

        for length in (None, 512 * 1024 * 1024):
            with self.subTest(length=length), mock.patch.object(store, 'CAPTURE_DOWNLOAD_MAX_SECONDS', .025), mock.patch.object(
                    store, '_media_stream', FakeStream(SlowResponse(content_type='video/mp4', content_length=length))), mock.patch.object(
                    store.tempfile, 'mkstemp', side_effect=mkstemp):
                with self.assertRaisesRegex(store.CaptureDownloadError, 'deadline'):
                    self.fetch()
        self.assertFalse(fake_s3.objects)
        self.assertEqual(len(paths), 2)
        self.assertTrue(all(not path.exists() for path in paths))

    def test_deadline_cancels_waiting_for_response_headers(self):
        class SlowHeaders(FakeStream):
            async def __aenter__(self):
                await asyncio.sleep(10)
                return self.response

        with mock.patch.object(store, 'CAPTURE_DOWNLOAD_MAX_SECONDS', .02), mock.patch.object(
                store, '_media_stream', SlowHeaders(FakeResponse(content_type='video/mp4'))):
            with self.assertRaisesRegex(store.CaptureDownloadError, 'deadline'):
                self.fetch()
        self.assertFalse(fake_s3.objects)

    def test_real_httpx_async_stream_is_cancelled_and_closed_at_deadline(self):
        closed = []

        class Body(httpx.AsyncByteStream):
            async def __aiter__(self):
                while True:
                    await asyncio.sleep(.005)
                    yield b'x'

            async def aclose(self):
                closed.append(True)

        transport = httpx.MockTransport(lambda request: httpx.Response(
            200, headers={'content-type': 'video/mp4'}, stream=Body()))
        client = httpx.AsyncClient(transport=transport)
        with mock.patch.object(store.httpx, 'AsyncClient', return_value=client), mock.patch.object(
                store, 'CAPTURE_DOWNLOAD_MAX_SECONDS', .025):
            with self.assertRaisesRegex(store.CaptureDownloadError, 'deadline'):
                self.fetch()
        self.assertEqual(closed, [True])
        self.assertTrue(client.is_closed)
        self.assertFalse(fake_s3.objects)

    def test_global_slots_cover_upload_and_release_after_error(self):
        started = threading.Barrier(3)
        release = threading.Event()

        def upload(**kwargs):
            started.wait(timeout=5)
            if not release.wait(5):
                raise AssertionError('upload release missing')
            raise RuntimeError('storage failure')

        with mock.patch.object(store, '_media_stream', FakeStream(FakeResponse([b'video'], content_type='video/mp4'))), mock.patch.object(
                store._s3, 'put_object', side_effect=upload):
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(self.fetch) for _ in range(2)]
                try:
                    started.wait(timeout=5)
                    with self.assertRaises(store.CaptureBusyError):
                        self.fetch()
                finally:
                    release.set()
                for future in futures:
                    with self.assertRaises(store.CaptureDownloadError):
                        future.result(timeout=5)
        with mock.patch.object(store, '_media_stream', FakeStream(FakeResponse([b'ok'], content_type='video/mp4'))):
            self.assertEqual(self.fetch(), ('video/mp4', 2))


class CaptureReservationAndCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        for patch in (mock.patch.object(api_app, 'DB_PATH', Path(self.temp.name) / 'control.sqlite'),
                      mock.patch.object(api_app, 'API_TOKEN', 'test-token'),
                      mock.patch.object(api_app, '_image_thumbnail_worker', None)):
            patch.start()
            self.addCleanup(patch.stop)
        api_app.startup()
        api_app.startup_captures()
        self.deleted = []
        self.downloads = []

        def fetch(url, key, *args):
            self.downloads.append(key)
            return store.StoredMedia('image/png', 5, 'a' * 64)

        self.fetch = mock.patch.object(api_app, 'fetch_media_to_r2', side_effect=fetch).start()
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(api_app, 'delete_r2_object', side_effect=self.deleted.append).start()

    def request(self, number=1, classification='class'):
        return routes.create_capture(routes.CaptureCreate(
            source_url=f'https://x.com/a/status/{number}', media_url=f'https://pbs.twimg.com/{number}.png',
            classification_id=classification), authorization='Bearer test-token')

    def test_duplicate_and_capacity_use_existing_retry_status_without_extra_fetch(self):
        ready = threading.Barrier(3)
        release = threading.Event()
        original = self.fetch.side_effect

        def slow(*args):
            ready.wait(timeout=5)
            if not release.wait(5):
                raise AssertionError('capture release missing')
            return original(*args)

        self.fetch.side_effect = slow
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.request, i) for i in (1, 2)]
            try:
                ready.wait(timeout=5)
                for number in (1, 3):
                    with self.assertRaises(HTTPException) as raised:
                        self.request(number, classification=' class ')
                    self.assertEqual(raised.exception.status_code, 503)
                    self.assertEqual(raised.exception.headers['Retry-After'], '5')
                self.assertEqual(self.fetch.call_count, 2)
            finally:
                release.set()
            self.assertTrue(all(future.result(timeout=5)['created'] for future in futures))
        self.assertFalse(self.request()['created'])
        self.assertEqual(self.fetch.call_count, 2)
        self.assertFalse(routes._capture_inflight)

    def test_download_error_releases_identity_for_retry(self):
        original = self.fetch.side_effect
        self.fetch.side_effect = store.CaptureDownloadError('download failed')
        with self.assertRaises(HTTPException) as error:
            self.request()
        self.assertEqual(error.exception.status_code, 502)
        self.assertFalse(routes._capture_inflight)
        self.fetch.side_effect = original
        self.assertTrue(self.request()['created'])

    def test_integrity_conflict_keeps_winner_and_deletes_only_losing_upload(self):
        original = self.fetch.side_effect

        def competing_insert(*args):
            with api_app.get_db() as db:
                db.execute('''INSERT INTO captures
                    (id,source_url,media_url,classification_id,object_key,content_type,size_bytes,status,created_at)
                    VALUES('winner','https://x.com/a/status/1','https://pbs.twimg.com/1.png',
                           'class','images/inbox/winner/original','image/png',5,'pending','now')''')
                db.commit()
            return original(*args)

        self.fetch.side_effect = competing_insert
        reply = self.request()
        self.assertFalse(reply['created'])
        self.assertEqual(reply['capture']['id'], 'winner')
        self.assertEqual(self.deleted, self.downloads)
        self.assertNotIn('images/inbox/winner/original', self.deleted)

    def test_all_database_failures_delete_upload_and_release_reservation(self):
        original_get_db = api_app.get_db
        for phase in ('open', 'insert', 'commit'):
            for error in (sqlite3.OperationalError('database is locked'), sqlite3.OperationalError('disk full')):
                with self.subTest(phase=phase, error=str(error)):
                    calls = 0

                    class Connection:
                        def execute(self, *args):
                            if phase == 'insert':
                                raise error
                            return self.db.execute(*args)

                        def commit(self):
                            raise error

                    @contextmanager
                    def failing_db():
                        nonlocal calls
                        calls += 1
                        if calls == 2 and phase == 'open':
                            raise error
                        with original_get_db() as db:
                            if calls == 2:
                                wrapper = Connection()
                                wrapper.db = db
                                yield wrapper
                            else:
                                yield db

                    with mock.patch.object(api_app, 'get_db', failing_db):
                        with self.assertRaises(sqlite3.OperationalError):
                            self.request()
                    self.assertEqual(self.deleted[-1], self.downloads[-1])
                    self.assertFalse(routes._capture_inflight)
                    with original_get_db() as db:
                        self.assertEqual(db.execute('SELECT COUNT(*) FROM captures').fetchone()[0], 0)

    def test_cleanup_failure_preserves_original_database_error(self):
        with mock.patch.object(routes.authority, 'active_domain', side_effect=sqlite3.OperationalError('disk full')), mock.patch.object(
                api_app, 'delete_r2_object', side_effect=RuntimeError('R2 unavailable')):
            with self.assertRaisesRegex(sqlite3.OperationalError, 'disk full'):
                self.request()
        self.assertFalse(routes._capture_inflight)

    def test_promotion_rejection_also_removes_uncommitted_upload(self):
        with mock.patch.object(routes.authority, 'active_domain', return_value={'libraryId': 'library'}), mock.patch.object(
                routes.asset_authority, 'promote_capture', side_effect=HTTPException(422, 'rejected')):
            with self.assertRaises(HTTPException) as error:
                self.request()
        self.assertEqual(error.exception.status_code, 422)
        self.assertEqual(self.deleted, self.downloads)
        with api_app.get_db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM captures').fetchone()[0], 0)

    def test_post_commit_context_error_does_not_delete_referenced_upload(self):
        original_get_db = api_app.get_db
        calls = 0

        @contextmanager
        def failing_close():
            nonlocal calls
            calls += 1
            with original_get_db() as db:
                yield db
            if calls == 2:
                raise RuntimeError('notification failed after commit')

        with mock.patch.object(api_app, 'get_db', failing_close):
            with self.assertRaisesRegex(RuntimeError, 'notification'):
                self.request()
        self.assertEqual(self.deleted, [])
        self.assertFalse(self.request()['created'])
