"""Shutdown regressions without TestClient, listening sockets, or production data."""
import asyncio
import signal
import threading
import time
import unittest
from unittest import mock

from fastapi import FastAPI

import app_lifecycle
import change_signal
import file_exchange
import image_thumbnails
import mobile_catalog_refresh
import prune_catalog_artifacts
from tests.test_sync_status_longpoll import Database, build, authority_row
import httpx


class ShutdownPollTests(unittest.IsolatedAsyncioTestCase):
    async def test_shutdown_releases_all_parked_requests_and_preserves_timeout_response(self):
        database = Database()
        self.addCleanup(database.close)
        app = build(database, max_wait=50, recheck=50)
        hooks = app_lifecycle.lifecycle(app)
        _, auth = database.token('client')
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as http:
            first = await http.get('/v1/sync/status', headers=auth)
            tasks = [asyncio.create_task(http.get('/v1/sync/status?wait=50', headers={
                **auth, 'If-None-Match': first.headers['etag']})) for _ in range(4)]
            async with asyncio.timeout(2):
                while database.signal.waiter_count != 4:
                    await asyncio.sleep(.005)
            hooks.begin_shutdown()
            responses = await asyncio.wait_for(asyncio.gather(*tasks), 1)
            self.assertEqual([r.status_code for r in responses], [304] * 4)
            self.assertTrue(all(r.content == b'' and r.headers['etag'] == first.headers['etag']
                                and r.headers['Lakomics-Status-Wait'] == '50' for r in responses))
            self.assertEqual(database.signal.waiter_count, 0)
            late = await asyncio.wait_for(http.get('/v1/sync/status?wait=50', headers={
                **auth, 'If-None-Match': first.headers['etag']}), 1)
            self.assertEqual(late.status_code, 304)

    async def test_shutdown_recomputes_current_document_even_without_write_signal(self):
        database = Database()
        self.addCleanup(database.close)
        app = build(database, max_wait=50, recheck=50)
        _, auth = database.token('client')
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as http:
            first = await http.get('/v1/sync/status', headers=auth)
            pending = asyncio.create_task(http.get('/v1/sync/status?wait=50', headers={
                **auth, 'If-None-Match': first.headers['etag']}))
            async with asyncio.timeout(2):
                while database.signal.waiter_count != 1:
                    await asyncio.sleep(.005)
            with database.raw() as db:
                authority_row(db, 'classification', 12)
                db.commit()
            app_lifecycle.lifecycle(app).begin_shutdown()
            reply = await asyncio.wait_for(pending, 1)
            self.assertEqual(reply.status_code, 200)
            self.assertEqual(reply.json()['domains'][0]['cursor'], 12)
            self.assertNotEqual(reply.headers['etag'], first.headers['etag'])

    async def test_signal_close_race_and_restart(self):
        writes = change_signal.WriteSignal()
        before = writes.generation
        writes.close()
        self.assertEqual(await asyncio.wait_for(writes.wait_beyond(before, 50), .2), before)
        writes.reset()
        waiting = asyncio.create_task(writes.wait_beyond(before, 50))
        await asyncio.sleep(.01)
        self.assertFalse(waiting.done())
        writes.bump()
        self.assertEqual(await waiting, before + 1)


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_real_stop_paths_signal_first_and_share_one_deadline(self):
        app = FastAPI()
        hooks = app_lifecycle.lifecycle(app)
        prune = prune_catalog_artifacts.AutoPruner('.', None)
        refresh = mobile_catalog_refresh.RefreshWorker(None, None, None)
        exchange = file_exchange.ExchangeSweeper.__new__(file_exchange.ExchangeSweeper)
        exchange.stop_event = threading.Event()
        thumb = image_thumbnails.ImageThumbnailWorker('unused', None, 'unused')
        stops = [prune.stop_event, refresh.stop, exchange.stop_event, thumb._stop]
        joined = []

        class SlowThread:
            def join(self, timeout):
                self_check = all(stop.is_set() for stop in stops)
                joined.append((self_check, timeout, threading.get_ident()))
                time.sleep(timeout)

            def is_alive(self):
                return True

        for worker in (prune, refresh, exchange):
            worker.thread = SlowThread()
        thumb._thread = SlowThread()
        for stop in (prune.stop, refresh.shutdown, exchange.stop, thumb.stop):
            hooks.on_shutdown(stop)
        ticks = []

        async def ticker():
            for _ in range(8):
                await asyncio.sleep(.01)
                ticks.append(1)

        task = asyncio.create_task(ticker())
        began = time.monotonic()
        with mock.patch.object(app_lifecycle, 'WORKER_SHUTDOWN_SECONDS', .15):
            await hooks._shutdown_workers()
        elapsed = time.monotonic() - began
        self.assertEqual(len(ticks), 8)
        await task
        self.assertEqual(len(joined), 4)
        self.assertTrue(all(stopped for stopped, _, _ in joined))
        self.assertTrue(all(ident != threading.get_ident() for _, _, ident in joined))
        self.assertLess(elapsed, .4)
        self.assertGreaterEqual(elapsed, .14)
        self.assertTrue(all(timeout == 0 for _, timeout, _ in joined[1:]))
        self.assertIsNotNone(thumb._thread)

    async def test_signal_chaining_is_before_drain_and_restored_on_lifespan_exit(self):
        app = FastAPI()
        hooks = app_lifecycle.lifecycle(app)
        seen = []
        previous = lambda signum, frame: seen.append(signum)
        handlers = {signal.SIGINT: previous, signal.SIGTERM: previous}
        hooks.on_drain(lambda: seen.append('drain'))
        hooks.on_shutdown(lambda: seen.append('stop'))

        def install(sig, handler):
            handlers[sig] = handler

        with mock.patch.object(signal, 'getsignal', side_effect=handlers.get), mock.patch.object(
                signal, 'signal', side_effect=install):
            async with hooks.lifespan(app):
                handlers[signal.SIGTERM](signal.SIGTERM, None)
                await asyncio.sleep(0)
                self.assertEqual(seen, [signal.SIGTERM, 'drain'])
            self.assertEqual(seen, [signal.SIGTERM, 'drain', 'stop'])
            self.assertIs(handlers[signal.SIGTERM], previous)
            async with hooks.lifespan(app):
                self.assertFalse(hooks._draining)
            self.assertEqual(seen[-2:], ['drain', 'stop'])

    async def test_asyncio_signal_trampoline_is_also_chained(self):
        hooks = app_lifecycle.lifecycle(FastAPI())
        seen = []
        def _sighandler_noop(signum, frame):
            seen.append(signum)
        handlers = {signal.SIGINT: _sighandler_noop, signal.SIGTERM: _sighandler_noop}
        hooks.on_drain(lambda: seen.append('drain'))
        with mock.patch.object(signal, 'getsignal', side_effect=handlers.get), mock.patch.object(
                signal, 'signal', side_effect=lambda sig, handler: handlers.__setitem__(sig, handler)):
            async with hooks._shutdown_signals():
                handlers[signal.SIGTERM](signal.SIGTERM, None)
                await asyncio.sleep(0)
                self.assertEqual(seen, [signal.SIGTERM, 'drain'])
            self.assertIs(handlers[signal.SIGTERM], _sighandler_noop)

    async def test_failing_stop_hook_does_not_skip_other_stops_or_joins(self):
        hooks = app_lifecycle.lifecycle(FastAPI())
        thread = mock.Mock()
        thread.is_alive.return_value = False
        hooks.on_shutdown(mock.Mock(side_effect=ValueError('failure')))
        hooks.on_shutdown(lambda: app_lifecycle.join_worker(thread, 5))
        with self.assertRaises(ValueError):
            await hooks._shutdown_workers()
        thread.join.assert_called_once()
