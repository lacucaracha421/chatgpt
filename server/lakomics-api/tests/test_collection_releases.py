"""Collection release notifications: PC unread upload, mobile list/acknowledge, read log.

Route logic runs on a bare FastAPI app with a temporary control database; one test
uses the real application to prove `/v1/collections/releases` is not shadowed by
`GET /v1/collections/{collection_id}`.
"""
import json
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
import collection_releases as releases

PREFIX = releases.PREFIX


def event(event_id, collection="c1", kind="new_volume", volume=3, detected="2026-09-20T10:00:00+00:00",
          name="원피스", provider="aladin", previous=None, current="2026-10-01"):
    return {"eventId": event_id, "collectionId": collection, "collectionName": name, "provider": provider,
            "kind": kind, "volumeNumber": volume, "previousValue": previous, "currentValue": current,
            "detectedAt": detected}


class ReleaseRoutes(unittest.TestCase):
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
        startup = releases.register(app, get_db, api_auth.client_guard(get_db, None),
                                    api_auth.publisher_guard(get_db))
        with get_db() as db:
            startup(db)
            db.commit()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    # --- helpers -------------------------------------------------------------------
    def upload(self, items, generation="1", final=True, operation=None, headers=None):
        body = {"version": 1, "operationId": operation or str(uuid.uuid4()), "generation": generation,
                "final": final, "items": items}
        return self.client.put(PREFIX + "/unread", headers=headers or self.publisher, json=body)

    def ok(self, reply):
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()

    def listing(self, headers=None, **params):
        return self.client.get(PREFIX, headers=headers or self.auth, params=params)

    def ids(self, **params):
        return [item["eventId"] for item in self.ok(self.listing(**params))["items"]]

    def ack(self, headers=None, **body):
        body = {"version": 1, "operationId": str(uuid.uuid4()), **body}
        return self.client.post(PREFIX + "/acknowledge", headers=headers or self.auth, json=body)

    def reads(self, **params):
        return self.client.get(PREFIX + "/reads", headers=self.publisher, params=params)

    def code(self, reply):
        return reply.json()["detail"]["code"]

    # --- tests ---------------------------------------------------------------------
    def test_roles(self):
        self.assertEqual(self.upload([event("e1")], headers=self.auth).status_code, 401)
        self.assertEqual(self.client.get(PREFIX + "/reads", headers=self.auth).status_code, 401)
        self.assertEqual(self.client.get(PREFIX).status_code, 401)
        self.assertEqual(self.client.post(PREFIX + "/acknowledge", json={}).status_code, 401)
        # A publisher is a superset of a client.
        self.ok(self.upload([event("e1")]))
        self.ok(self.listing(headers=self.publisher))
        self.ok(self.ack(headers=self.publisher, eventIds=["e1"]))

    def test_upload_validation(self):
        self.assertEqual(self.code(self.upload([event("e1"), event("e1")])), "invalidReleaseUpload")
        self.assertEqual(self.code(self.upload([event("e1", kind="other")])), "invalidReleaseUpload")
        self.assertEqual(self.code(self.upload([event("e1", volume=0)])), "invalidReleaseUpload")
        self.assertEqual(self.code(self.upload([event("e1", detected="yesterday")])), "invalidReleaseUpload")
        self.assertEqual(self.code(self.upload([{**event("e1"), "extra": 1}])), "invalidReleaseUpload")
        self.assertEqual(self.code(self.upload([event("e1")], operation="not-a-uuid-but-36-characters-long!!")),
                         "invalidReleaseUpload")
        big = b'{"items":"' + b"x" * (releases.MAX_BODY_BYTES + 1) + b'"}'
        reply = self.client.put(PREFIX + "/unread", headers=self.publisher, content=big)
        self.assertEqual((reply.status_code, self.code(reply)), (413, "releaseUploadTooLarge"))

    def test_chunks_upsert_and_final_retires_older_generations(self):
        self.ok(self.upload([event("e1"), event("e2", collection="c2")], generation="1"))
        self.assertEqual(sorted(self.ids()), ["e1", "e2"])
        # A non-final chunk of g2 adds at once but retires nothing.
        first = self.ok(self.upload([event("e3")], generation="2", final=False))
        self.assertEqual((first["retired"], first["changed"]), (0, 1))
        self.assertEqual(sorted(self.ids()), ["e1", "e2", "e3"])
        # The final chunk: e1 is still unread on the PC, e2 was read there.
        final = self.ok(self.upload([event("e1", name="원피스 (개정)")], generation="2"))
        self.assertEqual((final["retired"], final["changed"]), (1, 1))
        self.assertEqual(sorted(self.ids()), ["e1", "e3"])
        items = {i["eventId"]: i for i in self.ok(self.listing())["items"]}
        self.assertEqual(items["e1"]["collectionName"], "원피스 (개정)")
        # An empty final chunk clears everything.
        self.assertEqual(self.ok(self.upload([], generation="3"))["retired"], 2)
        self.assertEqual(self.ids(), [])

    def test_upload_idempotency(self):
        operation = str(uuid.uuid4())
        first = self.ok(self.upload([event("e1")], operation=operation))
        self.assertEqual(self.ok(self.upload([event("e1")], operation=operation)), first)
        reply = self.upload([event("e2")], operation=operation)
        self.assertEqual((reply.status_code, self.code(reply)), (409, "operationConflict"))
        # Receipts are shared across routes: an ack cannot reuse the id either.
        self.assertEqual(self.code(self.ack(operationId=operation, eventIds=["e1"])), "operationConflict")

    def test_event_limit_writes_nothing(self):
        with mock.patch.object(releases, "MAX_EVENTS", 2):
            self.ok(self.upload([event("e1"), event("e2")]))
            reply = self.upload([event("e3")], generation="1", final=False)
            self.assertEqual((reply.status_code, self.code(reply)), (409, "releaseEventLimit"))
        self.assertEqual(sorted(self.ids()), ["e1", "e2"])

    def test_event_limit_ignores_rows_the_upload_will_retire(self):
        with mock.patch.object(releases, "MAX_EVENTS", 2):
            self.ok(self.upload([event("o1"), event("o2")], generation="1"))
            # A fresh two-chunk upload fits although the old rows still exist mid-upload.
            self.ok(self.upload([event("n1")], generation="2", final=False))
            self.ok(self.upload([event("n2")], generation="2", final=True))
            self.assertEqual(sorted(self.ids()), ["n1", "n2"])
            reply = self.upload([event("n1"), event("n2"), event("n3")], generation="3")
            self.assertEqual(self.code(reply), "releaseEventLimit")
        self.assertEqual(sorted(self.ids()), ["n1", "n2"])

    def test_generations_are_ordered(self):
        for bad in ("g1", "01", "0", "-1", "9007199254740992", 7):
            reply = self.upload([], generation=bad)
            self.assertEqual(self.code(reply), "invalidReleaseUpload", bad)
        late_final = str(uuid.uuid4())
        self.ok(self.upload([event("a")], generation="1700000000000", final=False))
        self.ok(self.upload([event("b")], generation="1700000000500"))
        # A late retry of the older final chunk (new operation id) cannot retire b.
        stale = self.upload([event("a")], generation="1700000000000", operation=late_final)
        self.assertEqual((stale.status_code, self.code(stale)), (409, "releaseGenerationStale"))
        self.assertEqual(self.ids(), ["b"])
        self.assertEqual(self.ok(self.listing())["generation"], "1700000000500")
        # A newer unfinished upload is not retired by a final of a lower (still allowed) generation.
        self.ok(self.upload([event("c")], generation="1700000000900", final=False))
        self.ok(self.upload([event("b")], generation="1700000000700"))
        self.assertEqual(sorted(self.ids()), ["b", "c"])

    def test_upload_idempotency_compares_the_parsed_body(self):
        operation = str(uuid.uuid4())
        body = {"version": 1, "operationId": operation, "generation": "1", "final": True, "items": [event("e1")]}
        first = self.ok(self.client.put(PREFIX + "/unread", headers=self.publisher, json=body))
        spaced = json.dumps(body, indent=2, ensure_ascii=True)
        again = self.client.put(PREFIX + "/unread", headers={**self.publisher, "Content-Type": "application/json"},
                                content=spaced)
        self.assertEqual(self.ok(again), first)

    def test_list_filters_counts_paging_and_etag(self):
        self.ok(self.upload([
            event("a", detected="2026-09-20T10:00:00Z"),
            event("b", kind="release_date_changed", detected="2026-09-21T10:00:00+09:00",
                  previous="2026-10-01", current="2026-10-08"),
            event("c", kind="release_status_changed", detected="2026-09-22T10:00:00Z",
                  previous="upcoming", current="released"),
            event("d", collection="c2", detected="2026-09-23T10:00:00.123456789+00:00"),
            event("e", collection="c2", detected="2026-09-19T10:00:00"),
        ]))
        # Default: the two tablet kinds, newest first by instant (b is 01:00Z).
        body = self.ok(self.listing())
        self.assertEqual([i["eventId"] for i in body["items"]], ["d", "b", "a", "e"])
        self.assertEqual(body["counts"], {"unread": 4, "collections": [
            {"collectionId": "c1", "unread": 2}, {"collectionId": "c2", "unread": 2}]})
        self.assertEqual(body["items"][1]["detectedAt"], "2026-09-21T10:00:00+09:00")
        self.assertFalse(body["items"][0]["read"])
        all_kinds = self.ok(self.listing(kinds=",".join(releases.KINDS)))
        self.assertEqual([i["eventId"] for i in all_kinds["items"]], ["d", "c", "b", "a", "e"])
        self.assertEqual(all_kinds["counts"]["unread"], 5)
        self.assertEqual(self.ids(collectionId="c2"), ["d", "e"])
        # Keyset pages.
        page = self.ok(self.listing(limit=3))
        self.assertTrue(page["hasMore"])
        rest = self.ok(self.listing(limit=3, cursor=page["nextCursor"]))
        self.assertEqual([i["eventId"] for i in page["items"] + rest["items"]], ["d", "b", "a", "e"])
        self.assertEqual((rest["hasMore"], rest["nextCursor"]), (False, None))
        # ETag, invalidated by a change.
        first = self.listing()
        cached = self.listing(headers={**self.auth, "If-None-Match": first.headers["ETag"]})
        self.assertEqual(cached.status_code, 304)
        self.ok(self.ack(eventIds=["a"]))
        self.assertEqual(self.listing(headers={**self.auth, "If-None-Match": first.headers["ETag"]}).status_code, 200)
        # Bad requests.
        self.assertEqual(self.code(self.listing(kinds="new_volume,bogus")), "invalidReleaseRequest")
        self.assertEqual(self.code(self.listing(unknown=1)), "invalidReleaseRequest")
        self.assertEqual(self.code(self.listing(cursor="!!")), "invalidReleaseCursor")

    def test_acknowledge_single_and_idempotent(self):
        self.ok(self.upload([event("e1"), event("e2")]))
        operation = str(uuid.uuid4())
        first = self.ok(self.ack(operationId=operation, eventIds=["e1"]))
        self.assertEqual((first["acknowledged"], first["alreadyRead"], first["missing"], first["lastSequence"]),
                         (["e1"], [], [], 1))
        self.assertEqual(self.ids(), ["e2"])
        self.assertEqual(self.ids(state="read"), ["e1"])
        self.assertEqual(self.ok(self.listing())["counts"]["unread"], 1)
        # Same operation replays; a new operation for the same id is already read.
        self.assertEqual(self.ok(self.ack(operationId=operation, eventIds=["e1"])), first)
        again = self.ok(self.ack(eventIds=["e1"]))
        self.assertEqual((again["acknowledged"], again["alreadyRead"], again["lastSequence"]), ([], ["e1"], 1))
        self.assertEqual(self.code(self.ack(operationId=operation, eventIds=["e2"])), "operationConflict")
        self.assertEqual(self.ok(self.reads())["lastSequence"], 1)

    def test_acknowledge_unknown_ids_and_validation(self):
        self.ok(self.upload([event("e1")]))
        reply = self.ok(self.ack(eventIds=["e1", "gone"]))
        self.assertEqual((reply["acknowledged"], reply["missing"]), (["e1"], ["gone"]))
        self.assertEqual(self.ok(self.ack(eventIds=["gone"]))["acknowledged"], [])
        for body in ({}, {"eventIds": []}, {"eventIds": ["x", "x"]}, {"eventIds": ["x"], "collectionId": "c1"},
                     {"eventIds": ["x"], "kinds": ["new_volume"]}, {"collectionId": "c1", "kinds": ["bogus"]}):
            self.assertEqual(self.code(self.ack(**body)), "invalidReleaseAcknowledge", body)

    def test_acknowledge_all_for_collection(self):
        self.ok(self.upload([event("a"), event("b", kind="release_date_changed"),
                             event("s", kind="release_status_changed"), event("o", collection="c2")]))
        reply = self.ok(self.ack(collectionId="c1"))
        self.assertEqual(sorted(reply["acknowledged"]), ["a", "b"])
        # The status change the tablet never showed stays unread for the PC.
        self.assertEqual(self.ids(kinds=",".join(releases.KINDS)), ["o", "s"])
        self.assertEqual(self.ok(self.ack(collectionId="c1", kinds=list(releases.KINDS)))["acknowledged"], ["s"])
        self.assertEqual(self.ok(self.ack(collectionId="c1"))["acknowledged"], [])

    def test_upload_never_resurrects_a_mobile_read(self):
        self.ok(self.upload([event("e1"), event("e2")]))
        self.ok(self.ack(eventIds=["e1"]))
        # The PC uploads before consuming the read log: e1 stays read and is reported.
        reply = self.ok(self.upload([event("e1"), event("e2")], generation="2"))
        self.assertEqual(reply["alreadyRead"], ["e1"])
        self.assertEqual(self.ids(), ["e2"])
        # Once the PC acknowledged it locally it drops out of the upload and is deleted.
        self.ok(self.upload([event("e2")], generation="3"))
        self.assertEqual(self.ids(state="all"), ["e2"])

    def test_read_log_cursor(self):
        self.ok(self.upload([event(f"e{i}", detected=f"2026-09-2{i}T00:00:00Z") for i in range(1, 5)]))
        self.ok(self.ack(eventIds=["e1", "e2"]))
        self.ok(self.ack(eventIds=["e3"]))
        first = self.reads(limit=2)
        page = self.ok(first)
        self.assertEqual(([i["eventId"] for i in page["items"]], page["nextCursor"], page["hasMore"],
                          page["lastSequence"]), (["e1", "e2"], 2, True, 3))
        self.assertEqual(page["items"][0]["collectionId"], "c1")
        tail = self.ok(self.reads(after=2))
        self.assertEqual(([i["eventId"] for i in tail["items"]], tail["nextCursor"], tail["hasMore"]), (["e3"], 3, False))
        empty = self.ok(self.reads(after=3))
        self.assertEqual((empty["items"], empty["nextCursor"]), ([], 3))
        self.assertEqual(self.client.get(PREFIX + "/reads", headers={**self.publisher, "If-None-Match": first.headers["ETag"]},
                                         params={"limit": 2}).status_code, 304)
        self.assertEqual(self.code(self.reads(after=4)), "releaseCursorRejected")

    def test_retention_prunes_log_and_old_reads(self):
        self.ok(self.upload([event("e1"), event("e2"), event("e3")]))
        self.ok(self.ack(eventIds=["e1", "e2"]))
        later = datetime.now(timezone.utc) + timedelta(days=releases.READ_EVENT_DAYS + 1)
        with mock.patch.object(releases, "now_utc", return_value=later):
            self.ok(self.ack(eventIds=["e3"]))
        # Old log entries pruned; old read events deleted even though still uploaded.
        reply = self.reads()
        self.assertEqual((reply.status_code, self.code(reply)), (409, "releaseReadCursorExpired"))
        self.assertEqual(reply.json()["detail"]["lastSequence"], 3)
        page = self.ok(self.reads(after=2))
        self.assertEqual(([i["eventId"] for i in page["items"]], page["prunedThrough"]), (["e3"], 2))
        self.assertEqual(self.ids(state="all"), ["e3"])


class ReleaseRouteOrder(unittest.TestCase):
    """The real application: the static path must win over `/v1/collections/{id}`."""

    def setUp(self):
        from tests import test_mobile_collections as fixtures
        self.fixtures = fixtures
        fixtures.MobileCollectionsTests.setUp(self)
        with fixtures.api_app.get_db() as db:
            api_auth.startup(fixtures.api_app.get_db)
            _, publisher = api_auth.provision_token(db, "publisher", "fixture")
            db.commit()
        self.publisher = {"Authorization": "Bearer " + publisher}

    def tearDown(self):
        self.fixtures.MobileCollectionsTests.tearDown(self)

    def test_releases_route_is_not_shadowed(self):
        auth = self.fixtures.AUTH  # the legacy shared token is a client credential
        self.assertEqual(self.client.put("/v1/collections/replica", headers=auth, json={
            "version": 1, "baseRevision": None,
            "collections": [self.fixtures.work("releases"), self.fixtures.work("c1")]}).status_code, 200)
        body = {"version": 1, "operationId": str(uuid.uuid4()), "generation": "1", "final": True,
                "items": [event("e1")]}
        self.assertEqual(self.client.put(PREFIX + "/unread", headers=self.publisher, json=body).status_code, 200)
        listing = self.client.get(PREFIX, headers=auth)
        self.assertEqual(listing.status_code, 200, listing.text)
        self.assertEqual([i["eventId"] for i in listing.json()["items"]], ["e1"])
        self.assertEqual(self.client.get(PREFIX + "/reads", headers=self.publisher).status_code, 200)
        self.assertEqual(self.client.get("/v1/collections/c1", headers=auth).json()["item"]["id"], "c1")
        self.assertEqual(self.client.get(PREFIX, headers={"Authorization": "Bearer wrong"}).status_code, 401)


if __name__ == "__main__":
    unittest.main()
