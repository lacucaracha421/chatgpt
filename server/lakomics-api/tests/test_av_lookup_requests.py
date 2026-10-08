"""Collector inbox contract against temporary SQLite and the real auth guards."""
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from tests.test_capture_api_stub import fake_s3  # Installs the offline R2 stub.
import app as api_app
import api_auth
import av_lookup_requests as av
from fastapi import FastAPI
from fastapi.testclient import TestClient


class AvLookupTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        for name, value in (("DB_PATH", Path(temp.name) / "test.sqlite"), ("API_TOKEN", "av-admin")):
            patch = mock.patch.object(api_app, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        api_app.startup_extension_profile()
        api_auth.startup(api_app.get_db)
        self.auth = {"Authorization": "Bearer extension-test"}
        self.admin = {"Authorization": "Bearer av-admin"}
        with api_app.get_db() as db:
            db.execute("INSERT INTO extension_clients(id,token_hash,created_at) VALUES(?,?,?)",
                       ("extension", api_auth.token_hash("extension-test"), "2026"))
            _, publisher = api_auth.provision_token(db, "publisher")
            _, reader = api_auth.provision_token(db, "client")
            db.commit()
        self.publisher = {"Authorization": f"Bearer {publisher}"}
        self.reader = {"Authorization": f"Bearer {reader}"}
        app = FastAPI()
        setup = av.register(app, api_app.get_db, api_app.require_admin_or_extension,
                            api_auth.publisher_guard(api_app.get_db),
                            api_auth.client_guard(api_app.get_db, api_app.API_TOKEN))
        setup()
        setup()  # Startup is idempotent.
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def body(self, **changes):
        return {"requestId": str(uuid.uuid4()), "productCode": "SSIS-001",
                "sourceUrl": "https://www.javlibrary.com/ja/?v=example", **changes}

    def post(self, body=None, headers=None):
        return self.client.post("/v1/av-lookups", json=body if body is not None else self.body(),
                                headers=self.auth if headers is None else headers)

    def get(self, **params):
        return self.client.get("/v1/av-lookups", headers=self.publisher, params=params)

    def test_create_and_idempotent_replay(self):
        body = self.body(productCode=" ssis001 ", sourceUrl=None)
        first = self.post(body)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(set(first.json()), {"requestId", "sequence", "receivedAt"})
        self.assertEqual(datetime.fromisoformat(first.json()["receivedAt"]).utcoffset(), timedelta(0))
        self.assertEqual(self.post(body).json(), first.json())
        page = self.get().json()
        self.assertEqual(page["items"], [{**first.json(), "productCode": "ssis001", "sourceUrl": None}])
        self.assertFalse(page["hasMore"])

    def test_conflict(self):
        body = self.body()
        self.assertEqual(self.post(body).status_code, 200)
        for changes in ({"productCode": "SSIS-002"}, {"sourceUrl": None}):
            reply = self.post({**body, **changes})
            self.assertEqual(reply.status_code, 409)
            self.assertEqual(reply.json()["detail"]["code"], "avLookupConflict")
        self.assertEqual(len(self.get().json()["items"]), 1)

    def test_validation(self):
        for changes in ({"productCode": ""}, {"productCode": " "}, {"productCode": "x" * 41},
                        {"productCode": 123}, {"sourceUrl": "http://example.test/"},
                        {"sourceUrl": "https://"}, {"sourceUrl": 4},
                        {"sourceUrl": "https:example.test"},
                        {"sourceUrl": "https://example.test/" + "x" * 2048},
                        {"extra": 1}, {"requestId": str(uuid.uuid1())}, {"requestId": 2}):
            with self.subTest(changes=changes):
                self.assertEqual(self.post(self.body(**changes)).status_code, 422)
        self.assertEqual(self.post(self.body(productCode="x" * 40)).status_code, 200)

    def test_body_cap_before_json_parsing_and_chunked_body(self):
        for content in (b"{" + b" " * 4096, iter([b" " * 2048, b" " * 2049])):
            reply = self.client.post("/v1/av-lookups", headers=self.auth, content=content)
            self.assertEqual(reply.status_code, 413)
        reply = self.client.post("/v1/av-lookups", headers=self.auth, content=b"{" + b" " * 4095)
        self.assertEqual(reply.status_code, 422)

    def test_auth_matches_capture_and_publisher_boundary(self):
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(self.post(headers=self.admin).status_code, 200)
        tablet_body = self.body()
        first = self.post(tablet_body, self.reader)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(self.post(tablet_body, self.reader).json(), first.json())
        self.assertEqual(self.post(headers=self.publisher).status_code, 200)
        self.assertEqual(self.post(headers={}).status_code, 401)
        for headers in ({}, self.auth, self.admin, self.reader):
            self.assertEqual(self.client.get("/v1/av-lookups", headers=headers).status_code, 401)
        self.assertEqual(self.get().status_code, 200)
        with api_app.get_db() as db:
            db.execute("UPDATE extension_clients SET revoked_at='now'")
            db.commit()
        self.assertEqual(self.post().status_code, 401)

    def test_app_registration(self):
        api_app.startup_av_lookup_requests()
        client = TestClient(api_app.app)
        self.addCleanup(client.close)
        reply = client.post("/v1/av-lookups", headers=self.auth, json=self.body())
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual(client.get("/v1/av-lookups", headers=self.publisher).status_code, 200)

    def test_paging(self):
        receipts = [self.post().json() for _ in range(3)]
        first = self.get(after=0, limit=2).json()
        self.assertTrue(first["hasMore"])
        self.assertEqual([i["sequence"] for i in first["items"]], [r["sequence"] for r in receipts[:2]])
        rest = self.get(after=first["nextAfter"], limit=2).json()
        self.assertFalse(rest["hasMore"])
        self.assertEqual(rest["items"][0]["requestId"], receipts[2]["requestId"])
        end = self.get(after=rest["nextAfter"]).json()
        self.assertEqual(end, {"items": [], "nextAfter": rest["nextAfter"], "hasMore": False})
        for params in ({"after": -1}, {"limit": 0}, {"limit": 101}):
            self.assertEqual(self.get(**params).status_code, 422)

    def test_rate_limit_is_per_credential_and_expires(self):
        clock = [100.0]
        limiter = av.RateLimiter(clock=lambda: clock[0])
        with mock.patch.object(av.RateLimiter, "check", side_effect=limiter.check):
            body = self.body()
            for _ in range(30):
                self.assertEqual(self.post(body).status_code, 200)
            self.assertEqual(self.post(body).status_code, 429)
            self.assertEqual(self.post(headers=self.admin).status_code, 200)
            clock[0] += 60
            self.assertEqual(self.post(body).status_code, 200)

    def test_retention_is_bounded_and_sequences_never_rewind(self):
        now = datetime.now(timezone.utc)
        old = (now - timedelta(days=31)).isoformat()
        recent = (now - timedelta(days=29)).isoformat()
        with api_app.get_db() as db:
            for i in range(av.PRUNE_BATCH + 2):
                db.execute("INSERT INTO av_lookup_requests VALUES(?,?,?,?,?,?)",
                           (i + 1, str(uuid.uuid4()), "old", None, "digest", old))
            db.execute("UPDATE av_lookup_requests SET received_at=? WHERE sequence=1", (recent,))
            db.commit()
        first = self.post().json()
        self.assertGreater(first["sequence"], av.PRUNE_BATCH + 2)
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM av_lookup_requests").fetchone()[0], 3)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM av_lookup_requests WHERE received_at=?",
                                        (old,)).fetchone()[0], 1)
            # Closed items retain the legacy 30-day pruning and sequence guarantee.
            # Actionable server candidates must survive until reviewed.
            db.execute("UPDATE av_inbox SET status='dismissed'")
            # Expire everything, including the highest sequence.
            db.execute("UPDATE av_lookup_requests SET received_at=?", (old,))
            db.commit()
        second = self.post().json()
        self.assertGreater(second["sequence"], first["sequence"])
        self.assertEqual([i["sequence"] for i in self.get().json()["items"]], [second["sequence"]])


if __name__ == "__main__":
    unittest.main()
