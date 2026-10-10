"""Server-stage HTTP/model/projection acceptance for MangaDex binds. Fake provider; no worker thread.

Requires the server's FastAPI test dependencies. Not run in the Windows plain-
Python sandbox; the controller runs this with the full server-stage suite.
"""
import hashlib
import json
import os
import types
import unittest
import uuid
from pathlib import Path
from unittest import mock

from tests import test_collection_authority as fixtures
import collection_authority as ca
import collection_bindings as bindings
import kakao_bind_worker as kb
import mangadex_bind as md

PREFIX = "/v1/collections/bindings"
MANGA = "d1a9fdeb-f713-407f-960c-8326b586e6fd"
FIXTURES = Path(__file__).resolve().parents[3] / "_tools/app/src-tauri/src/library/fixtures"
MD_ENV = "LAKOMICS_MANGADEX_BINDS"


class MangaDexBindRouteTests(unittest.TestCase):
    def setUp(self):
        environment = mock.patch.dict(os.environ, {kb.ENV: "0", MD_ENV: "0"})
        environment.start()
        self.addCleanup(environment.stop)
        self.fixture = fixtures.CollectionAuthorityTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.addCleanup(self.fixture.tearDown)
        self.fixture.ready()
        os.environ[MD_ENV] = "1"
        with fixtures.api_app.get_db() as db:
            kb.startup_db(db)
            db.commit()
        self.detail = json.loads((FIXTURES / "mangadex_detail.json").read_text(encoding="utf-8"))
        self.covers = json.loads((FIXTURES / "mangadex_covers.json").read_text(encoding="utf-8"))["data"]
        self.requests = []

        def http_get(url, params, headers, max_bytes, timeout, deadline=None):
            self.requests.append(url)
            if "/manga/" in url:
                return json.dumps(self.detail).encode()
            offset = int(dict(params)["offset"])
            return json.dumps({"result": "ok", "data": self.covers[offset:offset + 100],
                               "total": len(self.covers), "offset": offset}).encode()

        def store(data, mime, deadline, get_db, storage, bucket, **kwargs):
            receipt = lambda payload, kind: {"sha256": hashlib.sha256(payload).hexdigest(),
                                             "sizeBytes": len(payload), "contentType": kind}
            original, thumbnail = receipt(data, mime), receipt(b"thumbnail", "image/webp")
            with get_db() as db:
                for item in (original, thumbnail):
                    db.execute("INSERT OR REPLACE INTO mobile_collection_artwork VALUES(?,?,?)",
                               (item["sha256"], item["sizeBytes"], item["contentType"]))
                db.commit()
            return {"provider": kwargs["provider"], "providerImageId": kwargs["provider_image_id"],
                    "original": original, "thumbnail": thumbnail, "width": 120, "height": 180}

        artwork = types.SimpleNamespace(mangadex_ready=lambda: True, store_artwork_bytes=store,
                                        mangadex_image=lambda manga, name, deadline: (b"original", "image/jpeg"),
                                        UpstreamStatus=type("UpstreamStatus", (Exception,), {}))
        patches = (mock.patch.object(bindings, "http_get", http_get),
                   mock.patch.object(bindings.gate, "mangadex_spacing", lambda: None))
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        manga = md.Provider(bindings, ca, fixtures.api_app.get_db, lambda: object(), lambda: "bucket",
                            artwork=artwork)
        worker = kb.Worker(fixtures.api_app.get_db, manga=manga)
        worker.thread = types.SimpleNamespace(is_alive=lambda: True)
        current = mock.patch.object(kb, "_current", worker)
        current.start()
        self.addCleanup(current.stop)
        self.worker = worker

    def body(self, work_id="s", **extra):
        return {"version": 1, "operationId": str(uuid.uuid4()), "collectionId": work_id, "provider": "mangadex",
                "choice": {"mangaId": MANGA, "title": "client hint", "coverUrl": "https://untrusted.invalid/x"}, **extra}

    def submit(self, body):
        reply = self.fixture.client.post(PREFIX + "/requests", headers=self.fixture.auth, json=body)
        return self.fixture.ok(reply)["request"]

    def listing(self, **params):
        return self.fixture.ok(self.fixture.client.get(PREFIX + "/requests", headers=self.fixture.auth,
                                                      params=params))

    def test_apply_covers_projection_replay_and_preservation(self):
        body = self.body("s")
        request = self.submit(body)
        self.assertEqual((request["executor"], request["state"]), ("server", "pending"))
        self.worker.execute(request["requestId"])
        self.assertEqual(self.submit(body)["state"], "applied")
        detail = self.fixture.ok(self.fixture.client.get("/v1/collections/s", headers=self.fixture.auth))["item"]
        self.assertEqual(detail["author"], "Ryoko Kui")
        self.assertEqual([volume["volumeNumber"] for volume in detail["volumes"]], [1])
        self.assertEqual(len(detail["artworks"]), 1)
        artwork_id = detail["artworks"][0]["id"]
        self.assertEqual(detail["selectedWorkArtworkId"], artwork_id)
        self.assertEqual(detail["volumes"][0]["coverArtworkId"], artwork_id)
        with fixtures.api_app.get_db() as db:
            row = db.execute("SELECT provider,provider_image_id,language FROM collection_authority_artworks"
                             " WHERE artwork_id=?", (artwork_id,)).fetchone()
            self.assertEqual(tuple(row), ("mangadex", self.covers[0]["id"], "ja"))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM collection_release_events").fetchone()[0], 0)
        calls = len(self.requests)
        self.worker.execute(request["requestId"])
        self.assertEqual(len(self.requests), calls)
        changed = {**body, "choice": {**body["choice"], "title": "different"}}
        reply = self.fixture.client.post(PREFIX + "/requests", headers=self.fixture.auth, json=changed)
        self.assertEqual((reply.status_code, self.fixture.code(reply)), (409, "operationConflict"))

    def test_apply_preserves_existing_selection_asset_and_volume_covers(self):
        # Separate test: the same MangaDex identity cannot be bound to two works
        # (providerIdentityTaken). Work "a" already has a selected cover, an Asset
        # cover and a volume cover: all stay.
        kept = self.submit(self.body("a"))
        self.worker.execute(kept["requestId"])
        self.assertEqual(self.listing(collectionId="a")["items"][0]["state"], "applied")
        detail = self.fixture.ok(self.fixture.client.get("/v1/collections/a", headers=self.fixture.auth))["item"]
        self.assertEqual(detail["selectedWorkArtworkId"], "cover")
        self.assertEqual(detail["coverAssetId"], fixtures.A2)
        self.assertEqual(detail["volumes"][0]["id"], "vol-1")
        self.assertEqual(detail["volumes"][0]["coverArtworkId"], "cover")
        with fixtures.api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM collection_release_events").fetchone()[0], 0)

    def test_publisher_log_result_fence_and_failure_reason_visibility(self):
        request = self.submit(self.body("s"))
        client = self.fixture.client
        reply = client.get(PREFIX + "/log", headers=self.fixture.publisher)
        payload = self.fixture.ok(reply)
        self.assertEqual(payload["items"], [])
        self.assertIsNone(payload["oldestPendingSequence"])
        reply = client.post(PREFIX + f"/requests/{request['requestId']}/result", headers=self.fixture.publisher,
                            json={"version": 1, "state": "applied"})
        self.assertEqual((reply.status_code, self.fixture.code(reply)), (409, "bindExecutorMismatch"))
        self.detail["data"]["id"] = str(uuid.uuid4())
        self.worker.execute(request["requestId"])
        failed = self.listing(collectionId="s", state="all")["items"][0]
        self.assertEqual((failed["state"], failed["reason"]["code"]), ("failed", "invalidMangaDexIdentity"))
        self.assertEqual(failed["reason"]["message"], md.MESSAGES["invalidMangaDexIdentity"])

    def test_status_advertisement_off_inert_and_controlled_unavailable(self):
        client = self.fixture.client
        status = self.fixture.ok(client.get(PREFIX + "/status", headers=self.fixture.auth))
        self.assertTrue(status["mangadexApply"])
        self.assertNotIn("kakaoApply", status)
        features = self.fixture.ok(client.get("/v1/collections/authority/status", headers=self.fixture.auth))["features"]
        self.assertIn("serverMangaDexBinds", features)
        self.assertNotIn(kb.FEATURE, features)
        with mock.patch.object(self.worker, "alive", return_value=False):
            self.assertNotIn("mangadexApply", self.fixture.ok(client.get(PREFIX + "/status", headers=self.fixture.auth)))
            reply = client.post(PREFIX + "/requests", headers=self.fixture.auth, json=self.body())
            self.assertEqual((reply.status_code, self.fixture.code(reply)), (503, "mangadexApplyUnavailable"))
        os.environ[MD_ENV] = "0"
        self.assertNotIn("mangadexApply", self.fixture.ok(client.get(PREFIX + "/status", headers=self.fixture.auth)))
        features = self.fixture.ok(client.get("/v1/collections/authority/status", headers=self.fixture.auth))["features"]
        self.assertNotIn("serverMangaDexBinds", features)
        legacy = self.submit(self.body("s"))
        self.assertNotIn("executor", legacy)
        self.worker.execute(legacy["requestId"])
        self.assertEqual(self.requests, [])

    def test_invalid_identity_is_refused_before_enqueue(self):
        body = self.body()
        body["choice"]["mangaId"] = MANGA.upper()
        reply = self.fixture.client.post(PREFIX + "/requests", headers=self.fixture.auth, json=body)
        self.assertEqual((reply.status_code, self.fixture.code(reply)), (422, "invalidBindRequest"))
        self.assertEqual(self.listing()["items"], [])

    def test_provider_unbind_supersedes_pending_server_request(self):
        request = self.submit(self.body("s"))
        fixture = self.fixture
        fixture.ok(fixture.command("bindProvider", headers=fixture.publisher, workId="s", provider="mangadex",
                                   externalId=MANGA, config=None, expectedRevision=0))
        with fixtures.api_app.get_db() as db:
            revision = ca.binding_row(db, fixtures.LIBRARY, "s", "mangadex")["entity_revision"]
        fixture.ok(fixture.command("unbindProvider", headers=fixture.publisher, workId="s", provider="mangadex",
                                   expectedRevision=revision))
        self.assertEqual(self.listing(collectionId="s")["items"][0]["state"], "superseded")
        self.assertEqual(request["provider"], "mangadex")


if __name__ == "__main__":
    unittest.main()
