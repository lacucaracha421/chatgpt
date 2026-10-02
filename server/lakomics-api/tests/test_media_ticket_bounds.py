"""Ticket admission/deadline/transport regressions, without TestClient or sockets."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import sqlite3
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock

from botocore.exceptions import (
    ClientError, ConnectTimeoutError, EndpointConnectionError, ReadTimeoutError,
)
from fastapi import FastAPI, HTTPException

import media_tickets as tickets


METADATA = {"ContentType": "image/webp", "ContentLength": 12}


class TicketBoundsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = self.temp.name + "/tickets.sqlite"
        with self.get_db() as db:
            db.execute("CREATE TABLE visible_assets (id TEXT, object_key TEXT, thumbnail_key TEXT, "
                       "content_type TEXT, committed INTEGER)")
            db.executemany("INSERT INTO visible_assets VALUES (?, ?, ?, 'image/png', 1)",
                           [(str(i), f"original/{i}", f"thumbnail/{i}") for i in range(50)])
            db.commit()
        self.services = SimpleNamespace(
            get_db=self.get_db, API_TOKEN="test", client_guard=lambda *_: lambda _: None,
            _ticket_head=mock.Mock(return_value=METADATA), _ticket_digest=lambda *_: {},
            _persist_thumbnail_metadata=mock.Mock(), MEDIA_TICKET_TTL_SECONDS=300,
            presign_get=mock.Mock(side_effect=lambda key, _: "https://test.invalid/" + key),
        )
        self.release = threading.Event()
        self.pool = ThreadPoolExecutor(max_workers=8)
        for name, value in (("api", self.services), ("_head_executor", self.pool),
                            ("_head_slots", threading.BoundedSemaphore(8)),
                            ("MEDIA_TICKET_DEADLINE_SECONDS", 1.0)):
            patch = mock.patch.object(tickets, name, value, create=True)
            patch.start()
            self.addCleanup(patch.stop)

    def tearDown(self):
        self.release.set()
        self.pool.shutdown(wait=True)

    @contextmanager
    def get_db(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    def request(self, count=50):
        return tickets.MediaTicketBatchRequest(items=[
            {"asset_id": str(i), "variant": "thumbnail"} for i in range(count)])

    def batch(self, count=50, **kwargs):
        return tickets.create_mobile_media_tickets(
            self.request(count), None, None, False, False, **kwargs)["items"]

    def test_transport_failures_are_per_item_and_success_order_is_preserved(self):
        failures = [ReadTimeoutError(endpoint_url="https://test.invalid"),
                    EndpointConnectionError(endpoint_url="https://test.invalid"),
                    ConnectTimeoutError(endpoint_url="https://test.invalid"),
                    ClientError({"Error": {"Code": "NoSuchKey"}}, "HeadObject"),
                    ClientError({"Error": {"Code": "AccessDenied"}}, "HeadObject")]

        def head(asset, *_args, **_kwargs):
            index = int(asset["id"])
            if index < len(failures):
                raise failures[index]
            return METADATA

        self.services._ticket_head.side_effect = head
        items = self.batch(6)
        self.assertEqual([item["asset_id"] for item in items], list(map(str, range(6))))
        self.assertEqual([item.get("error") for item in items], [
            "storage_unavailable", "storage_unavailable", "storage_unavailable",
            "unavailable", "storage_unavailable", None])
        self.assertTrue(items[-1]["ok"])
        self.services.presign_get.assert_called_once_with("thumbnail/5", 300)

    def test_single_ticket_transport_failure_is_502(self):
        for failure in (ReadTimeoutError(endpoint_url="https://test.invalid"),
                        EndpointConnectionError(endpoint_url="https://test.invalid"),
                        ConnectTimeoutError(endpoint_url="https://test.invalid")):
            with self.subTest(failure=type(failure).__name__):
                self.services._ticket_head.side_effect = failure
                with self.assertRaises(HTTPException) as raised:
                    tickets.create_mobile_media_ticket(
                        "0", tickets.MediaTicketRequest(variant="thumbnail"), None, None, False, False)
                self.assertEqual(raised.exception.status_code, 502)
        self.services.presign_get.assert_not_called()

    def test_ten_batches_and_single_tickets_share_eight_slots_without_queue_growth(self):
        entered = threading.Event()
        lock = threading.Lock()
        active = peak = 0

        def blocked(*_args, **_kwargs):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
                if active == 8:
                    entered.set()
            try:
                if not self.release.wait(5):
                    raise AssertionError("test did not release HEADs")
                return METADATA
            finally:
                with lock:
                    active -= 1

        self.services._ticket_head.side_effect = blocked
        with mock.patch.object(tickets, "MEDIA_TICKET_DEADLINE_SECONDS", 0.25), mock.patch.object(
                self.pool, "submit", wraps=self.pool.submit) as submit:
            with ThreadPoolExecutor(max_workers=10) as callers:
                batches = [callers.submit(self.batch) for _ in range(10)]
                try:
                    self.assertTrue(entered.wait(2))
                    for pending in batches:
                        result = pending.result(timeout=2)
                        self.assertEqual(len(result), 50)
                        self.assertTrue(all(item.get("error") == "storage_unavailable" for item in result))
                    # Timed-out calls do not release permits for still-running work.
                    for _ in range(3):
                        self.assertTrue(all(item["error"] == "storage_unavailable" for item in self.batch()))
                    with self.assertRaises(HTTPException) as raised:
                        tickets.create_mobile_media_ticket(
                            "0", tickets.MediaTicketRequest(variant="thumbnail"), None, None, False, False)
                    self.assertEqual(raised.exception.status_code, 502)
                    self.assertEqual(submit.call_count, 8)
                    self.assertEqual(peak, 8)
                finally:
                    self.release.set()
        self.pool.shutdown(wait=True)
        self.assertEqual(self.services._ticket_head.call_count, 8)
        self.services.presign_get.assert_not_called()

    def test_deadline_keeps_good_items_and_discards_late_metadata_fills(self):
        def head(asset, *_args, thumbnail_metadata_fills, **_kwargs):
            if asset["id"] != "0":
                if not self.release.wait(3):
                    raise AssertionError("test did not release HEADs")
            thumbnail_metadata_fills.append((asset["id"],))
            return METADATA

        self.services._ticket_head.side_effect = head
        started = time.monotonic()
        with mock.patch.object(tickets, "MEDIA_TICKET_DEADLINE_SECONDS", 0.15):
            result = self.batch()
        self.assertLess(time.monotonic() - started, 1)
        self.assertTrue(result[0]["ok"])
        self.assertTrue(all(item.get("error") == "storage_unavailable" for item in result[1:]))
        self.services._persist_thumbnail_metadata.assert_called_once_with([("0",)])
        self.release.set()
        self.pool.shutdown(wait=True)
        self.services.presign_get.assert_called_once_with("thumbnail/0", 300)
        self.services._persist_thumbnail_metadata.assert_called_once_with([("0",)])

    def test_cancellation_before_admission_starts_no_head_or_metadata_write(self):
        cancelled = threading.Event()
        cancelled.set()
        result = self.batch(_cancelled=cancelled)
        self.assertTrue(all(item["error"] == "storage_unavailable" for item in result))
        self.services._ticket_head.assert_not_called()
        self.services._persist_thumbnail_metadata.assert_not_called()

    def test_expired_queued_work_keeps_permits_until_drained_and_never_heads(self):
        # Slow worker startup can leave admitted tasks queued even with eight
        # permits. Expiry must not let cancelled queue tombstones accumulate.
        def blocked(*_args, **_kwargs):
            if not self.release.wait(3):
                raise AssertionError("test did not release HEAD")
            return METADATA

        self.services._ticket_head.side_effect = blocked
        with ThreadPoolExecutor(max_workers=1) as starting_pool:
            with mock.patch.object(tickets, "_head_executor", starting_pool), mock.patch.object(
                    tickets, "MEDIA_TICKET_DEADLINE_SECONDS", 0.1), mock.patch.object(
                    starting_pool, "submit", wraps=starting_pool.submit) as submit:
                try:
                    self.assertTrue(all(item["error"] == "storage_unavailable" for item in self.batch()))
                    self.assertTrue(all(item["error"] == "storage_unavailable" for item in self.batch()))
                    self.assertEqual(submit.call_count, 8)
                finally:
                    self.release.set()
        self.assertEqual(self.services._ticket_head.call_count, 1)
        self.services.presign_get.assert_not_called()
        self.services._ticket_head.side_effect = None
        self.assertTrue(self.batch(1)[0]["ok"])

    def test_completed_work_releases_capacity_and_duplicate_pairs_are_deduplicated(self):
        request = self.request(2)
        request.items += request.items
        for _ in range(2):
            result = tickets.create_mobile_media_tickets(request, None, None, False, False)["items"]
            self.assertEqual([item["asset_id"] for item in result], ["0", "1"])
            self.assertTrue(all(item["ok"] for item in result))
        self.assertEqual(self.services._ticket_head.call_count, 4)

    def test_http_wrapper_preserves_success_response_and_public_query_parameters(self):
        app = FastAPI()
        tickets.register(app, self.services)
        operation = app.openapi()["paths"]["/v1/library/media-tickets"]["post"]
        self.assertEqual({parameter["name"] for parameter in operation["parameters"]},
                         {"authorization", "lifecycle", "fresh_head", "verify_digest"})

        async def scenario():
            async def receive():
                await asyncio.Event().wait()

            async def heartbeat():
                while True:
                    await asyncio.sleep(0.01)

            tick = asyncio.create_task(heartbeat())
            try:
                result = await asyncio.wait_for(tickets._create_mobile_media_tickets_http(
                    self.request(2), SimpleNamespace(receive=receive), None, None, True, True), 2)
                self.assertEqual([item["asset_id"] for item in result["items"]], ["0", "1"])
                self.assertTrue(all(item["ok"] for item in result["items"]))
                for call in self.services._ticket_head.call_args_list:
                    self.assertTrue(call.kwargs["fresh_head"])
                    self.assertTrue(call.kwargs["verify_digest"])
            finally:
                tick.cancel()
                await asyncio.gather(tick, return_exceptions=True)

        asyncio.run(scenario())

    def test_registered_asgi_route_stops_admission_on_disconnect(self):
        async def scenario():
            app = FastAPI()
            tickets.register(app, self.services)
            receive_queue = asyncio.Queue()
            loop = asyncio.get_running_loop()
            entered = asyncio.Event()

            def blocked(*_args, **_kwargs):
                loop.call_soon_threadsafe(entered.set)
                if not self.release.wait(3):
                    raise AssertionError("test did not release HEADs")
                return METADATA

            self.services._ticket_head.side_effect = blocked
            body = self.request().model_dump_json().encode()
            receive_queue.put_nowait({"type": "http.request", "body": body, "more_body": False})
            sent = []

            async def send(message):
                sent.append(message)

            scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                     "method": "POST", "scheme": "https", "path": "/v1/library/media-tickets",
                     "raw_path": b"/v1/library/media-tickets", "query_string": b"",
                     "headers": [(b"content-type", b"application/json")],
                     "client": ("test", 123), "server": ("test", 443), "root_path": ""}
            # This sandbox blocks thread wakeup writes to the event-loop socket.
            # A timer lets the in-memory ASGI fixture process queued notifications.
            async def heartbeat():
                while True:
                    await asyncio.sleep(0.01)

            tick = asyncio.create_task(heartbeat())
            task = asyncio.create_task(app(scope, receive_queue.get, send))
            try:
                try:
                    await asyncio.wait_for(entered.wait(), 2)
                except TimeoutError:
                    self.fail(f"HEAD not entered: done={task.done()}, sent={sent!r}")
                receive_queue.put_nowait({"type": "http.disconnect"})
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(task, 1)
                admitted = self.services._ticket_head.call_count
                self.assertLessEqual(admitted, 8)
                self.release.set()
                await asyncio.sleep(0.1)
                self.assertEqual(self.services._ticket_head.call_count, admitted)
                self.services.presign_get.assert_not_called()
                self.services._persist_thumbnail_metadata.assert_not_called()
                self.assertFalse(sent)
            finally:
                self.release.set()
                task.cancel()
                tick.cancel()
                await asyncio.gather(task, tick, return_exceptions=True)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
