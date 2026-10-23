"""Scan publication uses the real collection projection and authenticated artwork ticket."""
import hashlib
import unittest
from unittest.mock import patch

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import api_auth
import authority
import manga_scans
import mobile_collections

ISBN = "9780306406157"
AUTH = {"Authorization": "Bearer scan-client"}
PUBLISHER = {"Authorization": "Bearer scan-publisher"}
JPEG = (Path(__file__).resolve().parents[3] / "_tools/app/src-tauri/src/library/fixtures/yes24-side.jpg").read_bytes()


class MangaScansTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.lock = threading.RLock()
        self.db.executescript(authority.AUTHORITY_DDL + api_auth.DDL)
        self.db.execute("INSERT INTO api_clients(id,token_hash,role,label,created_at) VALUES(?,?,'publisher',?,?)",
                        ["scan-pc", api_auth.token_hash("scan-publisher"), "Scan PC", "now"])
        self.db.commit()
        self.puts = []
        self.store = SimpleNamespace(put_object=lambda **kw: self.puts.append(kw))
        app = FastAPI()
        reader = api_auth.client_guard(self.get_db, "scan-client")
        startup = mobile_collections.register_collections(
            app, self.get_db, reader, lambda: self.store, lambda: "test-bucket",
            lambda key, seconds: "https://r2.example.test/" + key,
            lambda key, mime, seconds: "https://r2.example.test/" + key,
            require_client=reader, require_publisher=api_auth.publisher_guard(self.get_db))
        startup()
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        item = {"id": "work", "name": "Book", "type": "manga", "createdAt": "2026-10-23T00:00:00Z",
                "updatedAt": "2026-10-23T00:00:00Z", "artworks": [],
                "volumes": [{"id": "volume", "volumeNumber": 1, "editionIndex": 0,
                             "displayLabel": "1", "isbn13": ISBN}]}
        reply = self.client.put("/v1/collections/replica", headers=AUTH,
                                json={"version": 1, "baseRevision": None, "collections": [item]})
        self.assertEqual(reply.status_code, 200, reply.text)

    @contextmanager
    def get_db(self):
        with self.lock:
            try:
                yield self.db
            finally:
                self.db.rollback()

    def upload(self, part="side", data=JPEG, isbn=ISBN, auth=PUBLISHER, mime="image/jpeg", digest=None):
        return self.client.put(f"/v1/collections/manga-scans/{isbn}/{part}", content=data,
                               headers={**auth, "Content-Type": mime,
                                        "X-Content-SHA256": digest or hashlib.sha256(data).hexdigest()})

    def test_upload_is_idempotent_and_visible_through_existing_artwork_ticket(self):
        status = lambda: self.client.get("/v1/collections/status", headers=AUTH).json()
        before = status()
        for part in ("side", "back"):
            for _ in range(2):
                self.assertEqual(self.upload(part).status_code, 200)
        self.assertEqual(len(self.puts), 2)
        self.assertEqual(self.puts[0]["Key"], "work-artwork/mobile/" + hashlib.sha256(JPEG).hexdigest())
        self.assertIn("immutable", self.puts[0]["CacheControl"])
        after = status()
        self.assertEqual(before["revision"], after["revision"])
        self.assertNotEqual(before["scanRevision"], after["scanRevision"])
        detail_path = "/v1/collections/work"
        detail = self.client.get(detail_path, headers=AUTH)
        item = detail.json()["item"]
        for part, art_id in item["volumes"][0]["spineScan"].items():
            self.assertEqual(art_id, f"manga-scan-{ISBN}-{part}-{hashlib.sha256(JPEG).hexdigest()}")
            path = f"/v1/collections/work/artworks/{art_id}/media-ticket"
            self.assertEqual(self.client.post(path, json={}).status_code, 401)
            ticket = self.client.post(path, json={"variant": "thumbnail"}, headers=AUTH)
            self.assertEqual(ticket.status_code, 200, ticket.text)
            self.assertEqual(ticket.json()["sha256"], hashlib.sha256(JPEG).hexdigest())
            self.assertEqual(item["artworkVersions"][art_id]["thumbnail"], ticket.json()["sha256"])
        self.assertEqual(self.client.get(detail_path, headers={**AUTH, "If-None-Match": detail.headers["etag"]}).status_code, 304)
        self.assertEqual(self.client.post(f"/v1/collections/unknown/artworks/manga-scan-{ISBN}-side/media-ticket",
                                          json={}, headers=AUTH).status_code, 404)

    def test_auth_isbn_part_size_type_and_digest_are_validated(self):
        self.assertEqual(self.upload(auth=AUTH).status_code, 401)
        self.assertEqual(self.upload(auth={}).status_code, 401)
        for isbn in ("9780306406158", "1234567890123", "978030640615"):
            self.assertEqual(self.upload(isbn=isbn).status_code, 422)
        self.assertEqual(self.upload(part="front").status_code, 422)
        self.assertEqual(self.upload(data=b"x" * (manga_scans.MAX_BYTES + 1)).status_code, 413)
        self.assertEqual(self.upload(mime="image/png").status_code, 415)
        self.assertEqual(self.upload(data=b"not jpeg").status_code, 422)
        self.assertEqual(self.upload(digest="a" * 64).status_code, 422)
        self.assertEqual(self.puts, [])

    def test_list_scan_revision_changes_only_for_the_affected_work(self):
        listing = lambda: self.client.get("/v1/collections?type=manga", headers=AUTH).json()["items"][0]
        before = listing()["scanRevision"]
        self.assertEqual(self.upload(isbn="9780140328721").status_code, 200)
        self.assertEqual(listing()["scanRevision"], before)
        self.assertEqual(self.upload().status_code, 200)
        self.assertNotEqual(listing()["scanRevision"], before)

    def test_storage_failure_does_not_publish_availability(self):
        with patch.object(self.store, "put_object", side_effect=RuntimeError("offline")):
            self.assertEqual(self.upload().status_code, 502)
        detail = self.client.get("/v1/collections/work", headers=AUTH).json()["item"]
        self.assertNotIn("spineScan", detail["volumes"][0])
        self.assertEqual(self.upload().status_code, 200)

    def test_replacement_changes_the_manifest_and_cannot_reuse_the_old_ticket(self):
        self.assertEqual(self.upload().status_code, 200)
        path = "/v1/collections/work"
        before = self.client.get(path, headers=AUTH)
        previous = before.json()["item"]["volumes"][0]["spineScan"]["side"]
        other = (Path(__file__).resolve().parents[3] / "_tools/app/src-tauri/src/library/fixtures/yes24-placeholder.jpg").read_bytes()
        self.assertEqual(self.upload(data=other).status_code, 200)
        after = self.client.get(path, headers={**AUTH, "If-None-Match": before.headers["etag"]})
        self.assertEqual(after.status_code, 200)
        current = after.json()["item"]["volumes"][0]["spineScan"]["side"]
        self.assertNotEqual(previous, current)
        self.assertEqual(self.client.post(f"/v1/collections/work/artworks/{previous}/media-ticket", headers=AUTH, json={}).status_code, 404)
        with self.get_db() as db:
            db.execute("INSERT INTO api_clients(id,token_hash,role,created_at) VALUES(?,?,'client','now')",
                       ["tablet", api_auth.token_hash("tablet-token")])
            db.commit()
        ticket = self.client.post(f"/v1/collections/work/artworks/{current}/media-ticket",
                                  headers={"Authorization": "Bearer tablet-token"}, json={})
        self.assertEqual(ticket.status_code, 200, ticket.text)
        self.assertEqual(ticket.json()["sha256"], hashlib.sha256(other).hexdigest())
