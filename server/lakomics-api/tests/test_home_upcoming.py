"""Home 발매 예정: PC snapshot upload, tablet read with ETag, wishlist intents and their log.

Route logic runs on a bare FastAPI app with a temporary control database (``HomeFixture``,
shared with the artist and AV-pick tests); ``AppWiring`` proves the real application registers
the routes and exposes the signals.
"""
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api_auth
from app_lifecycle import lifecycle
import home_publications
import home_upcoming as upcoming

PREFIX = upcoming.PREFIX
SHA = "a" * 64


class HomeFixture(unittest.TestCase):
    """A bare app with client and publisher credentials; subclasses set ``module``."""

    module = None

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        path = Path(self.temp.name) / "control.sqlite"

        @contextmanager
        def get_db():
            db = sqlite3.connect(path, timeout=5)
            db.row_factory = sqlite3.Row
            try:
                yield db
            finally:
                db.close()

        self.get_db = get_db
        api_auth.startup(get_db)
        with get_db() as db:
            _, client = api_auth.provision_token(db, "client")
            _, publisher = api_auth.provision_token(db, "publisher")
            db.commit()
        self.auth = {"Authorization": "Bearer " + client}
        self.publisher = {"Authorization": "Bearer " + publisher}
        app = FastAPI()
        require_client, require_publisher = api_auth.client_guard(get_db, None), api_auth.publisher_guard(get_db)
        self.module.register(app, get_db, require_client, require_publisher)()
        self.presigned = []
        home_publications.register_cover_tickets(
            app, get_db, require_client, lambda key, ttl: self.presigned.append(key) or "https://r2.test/" + key)
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def ok(self, reply):
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()

    def code(self, reply):
        return reply.json()["detail"]["code"]

    def confirm_artwork(self, sha=SHA, size=10, content_type="image/webp"):
        """What `POST /v1/collections/artworks/prepare` records for an uploaded blob."""
        with self.get_db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS mobile_collection_artwork"
                       "(sha256 TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL, content_type TEXT NOT NULL)")
            db.execute("INSERT OR REPLACE INTO mobile_collection_artwork VALUES(?,?,?)", (sha, size, content_type))
            db.commit()

    def ticket(self, sha=SHA, headers=None):
        return self.client.post(f"/v1/home/covers/{sha}/media-ticket", headers=headers or self.auth)


def title(item_id="igdb:1942", kind="game", date="2026-11-14", precision="exact", **extra):
    return {"id": item_id, "kind": kind, "title": "젤다", "originalTitle": None, "date": date,
            "precision": precision, "region": "KR", "platforms": ["Switch"], "releaseType": None,
            "cover": {"url": "https://images.igdb.com/igdb/image/upload/t_cover_big/co1.jpg"},
            "popularity": 12.5, **extra}


def wish(item_id="tmdb:77", **extra):
    base = title(item_id, kind="movie", date="2026-12-01", precision="month")
    base.update(source="calendar", addedAt="2026-09-20T10:00:00Z", muted=False, released=False,
                events=[{"id": "ev1", "kind": "date_set", "previousValue": None, "currentValue": "2026-12-01",
                         "detectedAt": "2026-09-21T00:00:00Z", "readAt": None}])
    base.update(extra)
    return base


def snapshot(entries=None, wishlist=None, cursor=None, **extra):
    body = {"version": 1, "generatedAt": "2026-09-26T00:00:00Z", "rangeStart": "2026-09-26",
            "rangeEnd": "2027-03-26", "entries": [title()] if entries is None else entries,
            "wishlist": [wish()] if wishlist is None else wishlist,
            "sources": [{"provider": "igdb", "fetchedAt": "2026-09-26T00:00:00Z", "errorCode": None}],
            **extra}
    if cursor is not None:
        body["intentCursor"] = cursor
    return body


class UpcomingRoutes(HomeFixture):
    module = upcoming

    def put(self, body, headers=None):
        return self.client.put(PREFIX, headers=headers or self.publisher, json=body)

    def get(self, headers=None):
        return self.client.get(PREFIX, headers=headers or self.auth)

    def intent(self, action="add", item="igdb:1942", operation=None, headers=None, **extra):
        body = {"version": 1, "operationId": operation or str(uuid.uuid4()), "action": action, "itemId": item,
                **extra}
        return self.client.post(PREFIX + "/wishlist", headers=headers or self.auth, json=body)

    def log(self, **params):
        return self.client.get(PREFIX + "/wishlist/intents", headers=self.publisher, params=params)

    def test_roles(self):
        self.assertEqual(self.put(snapshot(), headers=self.auth).status_code, 401)
        self.assertEqual(self.client.put(PREFIX, json=snapshot()).status_code, 401)
        self.assertEqual(self.client.get(PREFIX).status_code, 401)
        self.assertEqual(self.client.get(PREFIX, headers={"Authorization": "Bearer wrong"}).status_code, 401)
        self.assertEqual(self.client.post(PREFIX + "/wishlist", json={}).status_code, 401)
        self.assertEqual(self.client.get(PREFIX + "/wishlist/intents", headers=self.auth).status_code, 401)
        self.ok(self.put(snapshot()))
        self.ok(self.get(headers=self.publisher))

    def test_empty_before_first_publication(self):
        body = self.ok(self.get())
        self.assertEqual((body["publishedAt"], body["entries"], body["wishlist"], body["pending"]),
                         (None, [], [], []))

    def test_validation(self):
        bad = [
            snapshot(entries=[title(), title()]),
            snapshot(entries=[title(kind="movie")]),
            snapshot(entries=[title(date=None)]),
            snapshot(entries=[title(precision="tbd")]),
            snapshot(entries=[title(date="2026-02-30")]),
            snapshot(entries=[title(item_id="steam:1")]),
            snapshot(entries=[title(title=" ")]),
            snapshot(entries=[title(title="a\nb")]),
            snapshot(entries=[title(cover={"url": "http://images.igdb.com/x.jpg"})]),
            snapshot(entries=[title(cover={"url": "https://evil.test/x.jpg"})]),
            snapshot(entries=[title(cover={"url": "https://user@images.igdb.com/x.jpg"})]),
            snapshot(entries=[title(cover={"url": "https://images.igdb.com:444/x.jpg"})]),
            snapshot(entries=[{**title(), "extra": 1}]),
            snapshot(wishlist=[wish(), wish()]),
            snapshot(wishlist=[wish(source="steam")]),
            snapshot(rangeStart="2027-01-01", rangeEnd="2026-01-01"),
            snapshot(generatedAt="yesterday"),
            {**snapshot(), "version": 2},
        ]
        for body in bad:
            reply = self.put(body)
            self.assertEqual((reply.status_code, self.code(reply)), (422, "invalidUpcomingUpload"), body)
        big = b'{"entries":"' + b"x" * (upcoming.MAX_BODY_BYTES + 1) + b'"}'
        reply = self.client.put(PREFIX, headers=self.publisher, content=big)
        self.assertEqual((reply.status_code, self.code(reply)), (413, "upcomingUploadTooLarge"))
        tbd = title(item_id="igdb:5", date=None, precision="tbd")
        self.ok(self.put(snapshot(entries=[tbd])))

    def test_snapshot_replace_and_etag(self):
        first = self.ok(self.put(snapshot()))
        self.assertTrue(first["changed"])
        reply = self.get()
        etag = reply.headers["ETag"]
        body = reply.json()
        self.assertEqual([e["id"] for e in body["entries"]], ["igdb:1942"])
        self.assertEqual(body["wishlist"][0]["events"][0]["id"], "ev1")
        self.assertEqual(self.client.get(PREFIX, headers={**self.auth, "If-None-Match": etag}).status_code, 304)
        # The same snapshot again moves nothing.
        again = self.ok(self.put(snapshot()))
        self.assertEqual((again["changed"], again["revision"]), (False, first["revision"]))
        self.assertEqual(self.client.get(PREFIX, headers={**self.auth, "If-None-Match": etag}).status_code, 304)
        # A new snapshot replaces the whole document.
        self.ok(self.put(snapshot(entries=[title("igdb:7")], wishlist=[])))
        reply = self.client.get(PREFIX, headers={**self.auth, "If-None-Match": etag})
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(([e["id"] for e in reply.json()["entries"]], reply.json()["wishlist"]), (["igdb:7"], []))

    def test_intents_are_idempotent_and_pending_until_acknowledged(self):
        self.ok(self.put(snapshot()))
        operation = str(uuid.uuid4())
        first = self.ok(self.intent("add", "igdb:1942", operation=operation))
        self.assertEqual(first["sequence"], 1)
        self.assertEqual(self.ok(self.intent("add", "igdb:1942", operation=operation)), first)
        reply = self.intent("remove", "igdb:1942", operation=operation)
        self.assertEqual((reply.status_code, self.code(reply)), (409, "operationConflict"))
        self.ok(self.intent("mute", "tmdb:77"))
        self.ok(self.intent("acknowledge", "tmdb:77", eventIds=["ev1"]))
        pending = self.ok(self.get())["pending"]
        self.assertEqual([(p["sequence"], p["action"], p["itemId"]) for p in pending],
                         [(1, "add", "igdb:1942"), (2, "mute", "tmdb:77"), (3, "acknowledge", "tmdb:77")])
        self.assertEqual(pending[2]["eventIds"], ["ev1"])
        page = self.ok(self.log(after=0, limit=2))
        self.assertEqual(([i["sequence"] for i in page["items"]], page["nextCursor"], page["hasMore"]),
                         ([1, 2], 2, True))
        self.assertEqual([i["sequence"] for i in self.ok(self.log(after=2))["items"]], [3])
        # The PC applied 1-2 and publishes with its cursor: only 3 stays pending.
        reply = self.ok(self.put(snapshot(wishlist=[wish(), wish("igdb:1942", kind="game")], cursor=2)))
        self.assertEqual(reply["acknowledgedThrough"], 2)
        self.assertEqual([p["sequence"] for p in self.ok(self.get())["pending"]], [3])
        # The cursor never moves back, and never beyond the log.
        self.assertEqual(self.ok(self.put(snapshot(cursor=1)))["acknowledgedThrough"], 2)
        reply = self.put(snapshot(cursor=9))
        self.assertEqual((reply.status_code, self.code(reply)), (409, "upcomingIntentCursorRejected"))
        reply = self.log(after=9)
        self.assertEqual((reply.status_code, self.code(reply)), (409, "upcomingCursorRejected"))

    def test_intent_validation(self):
        self.ok(self.put(snapshot()))
        for extra in ({"action": "delete"}, {"item": "igdb:"}, {"operation": "x" * 36},
                      {"action": "acknowledge"}, {"action": "add", "eventIds": ["ev1"]},
                      {"action": "acknowledge", "eventIds": ["a", "a"]}, {"action": "acknowledge", "eventIds": []}):
            reply = self.intent(**extra)
            self.assertEqual((reply.status_code, self.code(reply)), (422, "invalidUpcomingIntent"), extra)
        reply = self.intent("add", "igdb:999")
        self.assertEqual((reply.status_code, self.code(reply)), (409, "upcomingItemUnknown"))
        big = b'{"itemId":"' + b"x" * upcoming.MAX_INTENT_BYTES + b'"}'
        reply = self.client.post(PREFIX + "/wishlist", headers=self.auth, content=big)
        self.assertEqual((reply.status_code, self.code(reply)), (413, "upcomingIntentTooLarge"))

    def test_pending_limit_and_retention(self):
        self.ok(self.put(snapshot()))
        with mock.patch.object(upcoming, "MAX_PENDING", 2):
            self.ok(self.intent())
            self.ok(self.intent("remove"))
            reply = self.intent("mute")
            self.assertEqual((reply.status_code, self.code(reply)), (409, "upcomingIntentLimit"))
        self.ok(self.put(snapshot(cursor=2)))
        later = datetime.now(timezone.utc) + timedelta(days=upcoming.INTENT_DAYS + 1)
        with mock.patch.object(upcoming, "now_utc", return_value=later):
            self.ok(self.intent("mute"))
        page = self.ok(self.log(after=2))
        self.assertEqual((page["prunedThrough"], [i["sequence"] for i in page["items"]]), (2, [3]))
        reply = self.log(after=1)
        self.assertEqual((reply.status_code, self.code(reply)), (409, "upcomingIntentsExpired"))
        self.assertEqual(reply.json()["detail"]["lastSequence"], 3)

    def test_status_head_and_signal(self):
        def head():
            with self.get_db() as db:
                return upcoming.status_head(db), upcoming.status_signal(db)
        self.assertEqual(head(), ({"last": 0, "acknowledgedThrough": 0, "prunedThrough": 0}, 0))
        self.ok(self.put(snapshot()))
        self.assertEqual(head()[1], 1)
        self.ok(self.intent())
        self.assertEqual(head(), ({"last": 1, "acknowledgedThrough": 0, "prunedThrough": 0}, 2))
        self.ok(self.put(snapshot(cursor=1)))
        self.assertEqual(head(), ({"last": 1, "acknowledgedThrough": 1, "prunedThrough": 0}, 3))

    def test_blob_cover_needs_the_artwork_receipt_and_gets_a_ticket(self):
        cover = {"sha256": SHA, "sizeBytes": 10, "contentType": "image/webp"}
        reply = self.put(snapshot(entries=[title(cover=cover)]))
        self.assertEqual((reply.status_code, self.code(reply)), (409, "homeCoverNotUploaded"))
        self.assertEqual(self.ok(self.get())["entries"], [])
        self.confirm_artwork(size=11)
        self.assertEqual(self.put(snapshot(entries=[title(cover=cover)])).status_code, 409)
        self.confirm_artwork()
        self.assertEqual(self.ticket().status_code, 404)
        self.ok(self.put(snapshot(entries=[title(cover=cover)])))
        self.assertEqual(self.ticket(headers={"Authorization": "Bearer wrong"}).status_code, 401)
        ticket = self.ok(self.ticket())
        self.assertEqual((ticket["sha256"], ticket["size_bytes"], ticket["content_type"]), (SHA, 10, "image/webp"))
        self.assertEqual(self.presigned, ["work-artwork/mobile/" + SHA])
        self.assertEqual(self.ticket("b" * 64).status_code, 404)
        self.assertEqual(self.ticket("not-a-digest").status_code, 404)
        # A snapshot without the cover retires its ticket.
        self.ok(self.put(snapshot()))
        self.assertEqual(self.ticket().status_code, 404)


class AppWiring(unittest.TestCase):
    """The real application: routes registered, signals and publisher head exposed."""

    def setUp(self):
        from tests import test_mobile_collections as fixtures
        self.fixtures = fixtures
        fixtures.MobileCollectionsTests.setUp(self)
        api = fixtures.api_app
        # Every table-creating startup (the status document reads all domains); no workers.
        workers = {("prune_catalog_artifacts", "start"), ("mobile_catalog_refresh", "startup"),
                   ("app", "startup_image_thumbnails")}
        for startup in lifecycle(api.app).startup_handlers:
            if (startup.__module__, startup.__name__) not in workers:
                startup()
        api_auth.startup(api.get_db)
        with api.get_db() as db:
            _, publisher = api_auth.provision_token(db, "publisher", "fixture")
            db.commit()
        self.publisher = {"Authorization": "Bearer " + publisher}

    def tearDown(self):
        self.fixtures.MobileCollectionsTests.tearDown(self)

    def test_routes_and_signals(self):
        auth = self.fixtures.AUTH
        status = self.client.get("/v1/sync/status?signals=1", headers=self.publisher).json()
        self.assertEqual({key: status["signals"][key] for key in ("upcoming", "avPick", "artists")},
                         {"upcoming": 0, "avPick": 0, "artists": 0})
        self.assertEqual(status["publisherLogs"]["upcomingIntents"],
                         {"last": 0, "acknowledgedThrough": 0, "prunedThrough": 0})
        self.assertEqual(self.client.put(PREFIX, headers=self.publisher, json=snapshot()).status_code, 200)
        self.assertEqual(self.client.put(PREFIX, headers=auth, json=snapshot()).status_code, 401)
        self.assertEqual(self.client.get(PREFIX, headers=auth).json()["entries"][0]["id"], "igdb:1942")
        self.assertEqual(self.client.get("/v1/home/av-pick", headers=auth).status_code, 404)
        self.assertEqual(self.client.get("/v1/library/artists", headers=auth).status_code, 200)
        signals = self.client.get("/v1/sync/status?signals=1", headers=self.publisher).json()["signals"]
        self.assertEqual(signals["upcoming"], 1)


if __name__ == "__main__":
    unittest.main()
