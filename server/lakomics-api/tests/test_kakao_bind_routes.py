"""Server-stage HTTP/model/projection acceptance. Fake provider; no worker thread.

Requires the server's FastAPI test dependencies. Not run in the Windows plain-
Python sandbox; the controller runs this with the full server-stage suite.
"""
import os
import types
import unittest
import uuid
from unittest import mock

from tests import test_collection_authority as fixtures
import collection_bindings as bindings
import kakao_bind_worker as kb

PREFIX = "/v1/collections/bindings"


class KakaoBindRouteTests(unittest.TestCase):
    def setUp(self):
        environment = mock.patch.dict(os.environ, {kb.ENV: "0"})
        environment.start()
        self.addCleanup(environment.stop)
        self.fixture = fixtures.CollectionAuthorityTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.addCleanup(self.fixture.tearDown)
        self.fixture.ready()
        os.environ[kb.ENV] = "1"
        with fixtures.api_app.get_db() as db:
            kb.startup_db(db)
            db.commit()
        self.items = [{"itemId": f"fixture:{n}", "title": f"던전밥 {n}", "baseTitle": "던전밥",
                       "volumeNumber": n, "author": "작가", "publisher": "출판사", "isbn13": None,
                       "publicationDate": "2026-10-01", "thumbnail": None,
                       "itemUrl": "https://example.invalid/book", "raw": {"id": n}} for n in (1, 2)]
        key = mock.patch.object(bindings, "kakao_key", return_value="fixture")
        key.start()
        self.addCleanup(key.stop)
        transport = mock.patch.object(bindings, "search_kakao_items", return_value=(self.items, 0))
        self.transport = transport.start()
        self.addCleanup(transport.stop)
        worker = kb.Worker(fixtures.api_app.get_db)
        worker.thread = types.SimpleNamespace(is_alive=lambda: True)
        current = mock.patch.object(kb, "_current", worker)
        current.start()
        self.addCleanup(current.stop)
        self.worker = worker

    def body(self, *, legacy=False):
        group = bindings.group_kakao(self.items)[0]
        selection = {key: group[key] for key in ("anchorItemId", "groupFingerprint")}
        choice = {"query": "던전밥", "title": "던전밥", **(selection if legacy else {"groups": [selection]})}
        return {"version": 1, "operationId": str(uuid.uuid4()), "collectionId": "a", "provider": "kakao", "choice": choice}

    def submit(self, body):
        reply = self.fixture.client.post(PREFIX + "/requests", headers=self.fixture.auth, json=body)
        return self.fixture.ok(reply)["request"]

    def test_atomic_completion_real_projection_and_legacy_replay(self):
        body = self.body(legacy=True)
        request = self.submit(body)
        self.assertEqual(request["executor"], "server")
        self.worker.execute(request["requestId"])
        self.assertEqual(self.submit(body)["state"], "applied")
        detail = self.fixture.ok(self.fixture.client.get("/v1/collections/a", headers=self.fixture.auth))["item"]
        self.assertEqual([volume["volumeNumber"] for volume in detail["volumes"]], [1, 2])
        self.assertEqual(detail["volumes"][0]["id"], "vol-1")
        self.assertEqual(detail["volumes"][0]["coverArtworkId"], "cover")
        self.worker.execute(request["requestId"])
        self.assertEqual(self.transport.call_count, 1)
        changed = {**body, "choice": {**body["choice"], "query": "different"}}
        reply = self.fixture.client.post(PREFIX + "/requests", headers=self.fixture.auth, json=changed)
        self.assertEqual((reply.status_code, self.fixture.code(reply)), (409, "operationConflict"))

    def test_publisher_etag_cursor_and_results_and_reason_visibility(self):
        request = self.submit(self.body())
        client = self.fixture.client
        reply = client.get(PREFIX + "/log", headers=self.fixture.publisher)
        payload = self.fixture.ok(reply)
        self.assertEqual(payload["items"], [])
        self.assertEqual(payload["nextCursor"], request["requestId"])
        self.assertIsNone(payload["oldestPendingSequence"])
        self.assertEqual(client.get(PREFIX + "/log", headers={**self.fixture.publisher,
                         "If-None-Match": reply.headers["etag"]}).status_code, 304)
        reply = client.post(PREFIX + f"/requests/{request['requestId']}/result", headers=self.fixture.publisher,
                            json={"version": 1, "state": "applied"})
        self.assertEqual((reply.status_code, self.fixture.code(reply)), (409, "bindExecutorMismatch"))
        self.transport.return_value = ([], 0)
        self.worker.execute(request["requestId"])
        listing = self.fixture.ok(client.get(PREFIX + "/requests", headers=self.fixture.auth,
                                           params={"collectionId": "a", "state": "all"}))
        self.assertEqual(listing["items"][0]["reason"]["code"], "ambiguousBinding")

    def test_status_advertisement_and_controlled_unavailable(self):
        client = self.fixture.client
        self.assertTrue(self.fixture.ok(client.get(PREFIX + "/status", headers=self.fixture.auth))["kakaoApply"])
        features = self.fixture.ok(client.get("/v1/collections/authority/status", headers=self.fixture.auth))["features"]
        self.assertIn(kb.FEATURE, features)
        with mock.patch.object(self.worker, "alive", return_value=False):
            self.assertNotIn("kakaoApply", self.fixture.ok(client.get(PREFIX + "/status", headers=self.fixture.auth)))
            reply = client.post(PREFIX + "/requests", headers=self.fixture.auth, json=self.body())
            self.assertEqual((reply.status_code, self.fixture.code(reply)), (503, "kakaoApplyUnavailable"))
