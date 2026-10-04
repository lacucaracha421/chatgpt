"""Artist edit ordering, overlay continuity, receipts and publisher cursors."""
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from unittest import mock

import library_artists as artists
from tests.test_home_upcoming import HomeFixture
from tests.test_library_artists import artist, snapshot
from tests import test_home_upcoming as upcoming_tests

PREFIX = artists.PREFIX


class ArtistIntents(HomeFixture):
    module = artists

    def publish(self, **extra):
        return self.client.put(PREFIX, headers=self.publisher, json=snapshot(**extra))

    def post(self, action="rename", **extra):
        body = {"version": 1, "operationId": str(uuid.uuid4()), "artistId": "artist:a1",
                "action": action, **extra}
        return self.client.post(PREFIX + "/intents", headers=self.auth, json=body)

    def listing(self):
        return self.ok(self.client.get(PREFIX, headers=self.auth))

    def test_roles_validation_and_unknown(self):
        self.assertEqual(self.client.get(PREFIX + "/intents", headers=self.auth).status_code, 401)
        self.assertEqual(self.client.post(PREFIX + "/intents", json={}).status_code, 401)
        self.assertEqual(self.code(self.post()), "artistUnknown")
        self.ok(self.publish())
        for extra in ({"displayName": "x" * 121}, {"displayName": "a\nb"},
                      {"displayName": "a\rb"}, {"displayName": "a\x00b"}, {"displayName": 42},
                      {"operationId": "bad"}, {"unexpected": True}):
            response = self.post(**extra)
            self.assertEqual((response.status_code, self.code(response)), (422, "invalidArtistIntent"))
        self.assertEqual(self.post("pin", displayName="name").status_code, 422)
        self.assertEqual(self.post("merge").status_code, 422)
        for query in ("limit=0", "limit=201", "after=-1"):
            self.assertEqual(self.client.get(PREFIX + "/intents?" + query,
                                             headers=self.publisher).status_code, 422)
        oversized = self.client.post(PREFIX + "/intents", headers=self.auth,
                                     content=b"x" * (artists.MAX_INTENT_BYTES + 1))
        self.assertEqual((oversized.status_code, self.code(oversized)), (413, "artistIntentTooLarge"))

    def test_overlay_order_etags_and_stale_snapshot(self):
        self.ok(self.publish())
        old = self.client.get(PREFIX, headers=self.auth)
        detail = self.client.get(PREFIX + "/artist:a1", headers=self.auth)
        first = self.ok(self.post(displayName="  새 이름  "))
        self.ok(self.post("hide"))
        last = self.ok(self.post("unpin"))
        self.ok(self.publish(generatedAt="2026-10-04T00:00:00Z"))
        listing = self.listing()
        row = listing["artists"][0]
        self.assertEqual((row["label"], row["displayName"], row["hidden"], row["pinned"]),
                         ("새 이름", "새 이름", True, False))
        self.assertEqual([p["sequence"] for p in listing["pending"]], [1, 2, 3])
        self.assertGreater(last["revision"], first["revision"])
        for path, etag in ((PREFIX, old.headers["ETag"]), (PREFIX + "/artist:a1", detail.headers["ETag"])):
            self.assertEqual(self.client.get(path, headers={**self.auth, "If-None-Match": etag}).status_code, 200)
        self.assertEqual(self.ok(self.client.get(PREFIX + "/artist:a1", headers=self.auth))["artist"], row)
        self.ok(self.post(displayName="   "))
        self.ok(self.post("unhide"))
        self.ok(self.post("pin"))
        row = self.listing()["artists"][0]
        self.assertEqual((row["label"], row["displayName"], row["hidden"], row["pinned"]),
                         ("alice", None, False, True))
        with self.get_db() as db:
            self.assertEqual(artists.status_signal(db), self.listing()["revision"])
            self.assertEqual(artists.status_head(db)["last"], 6)

    def test_receipt_replay_conflict_and_pending_cap(self):
        self.ok(self.publish())
        operation = str(uuid.uuid4())
        first = self.ok(self.post("hide", operationId=operation))
        self.ok(self.post("unhide"))
        self.assertEqual(self.ok(self.post("hide", operationId=operation)), first)
        conflict = self.post("pin", operationId=operation)
        self.assertEqual((conflict.status_code, self.code(conflict)), (409, "artistIntentConflict"))
        with mock.patch.object(artists, "MAX_PENDING", 2):
            full = self.post("pin")
            self.assertEqual((full.status_code, self.code(full)), (409, "artistIntentLimit"))
            self.assertEqual(self.ok(self.post("hide", operationId=operation)), first)

    def test_name_cleaning_does_not_relax_payload_idempotency(self):
        self.ok(self.publish())
        operation = str(uuid.uuid4())
        first = self.ok(self.post(operationId=operation, displayName="  name  "))
        self.assertEqual(self.listing()["artists"][0]["displayName"], "name")
        self.assertEqual(self.ok(self.post(operationId=operation, displayName="  name  ")), first)
        self.assertEqual(self.code(self.post(operationId=operation, displayName="name")), "artistIntentConflict")

    def test_clearing_name_uses_the_published_fallback_without_a_source_name(self):
        self.ok(self.publish(items=[artist(sourceName=None, displayName=None, label="Fallback")]))
        self.ok(self.post(displayName="Custom"))
        self.ok(self.post(displayName=None))
        self.ok(self.publish(items=[artist(sourceName=None, displayName=None, label="New fallback")]))
        self.assertEqual(self.listing()["artists"][0]["label"], "New fallback")

    def test_paging_acknowledgement_and_rejected_rewind(self):
        self.ok(self.publish())
        self.ok(self.post("hide"))
        self.ok(self.post("unpin"))
        page = self.ok(self.client.get(PREFIX + "/intents?after=0&limit=1", headers=self.publisher))
        self.assertEqual((page["nextCursor"], page["lastSequence"], page["hasMore"]), (1, 2, True))
        next_page = self.ok(self.client.get(PREFIX + "/intents?after=1&limit=1", headers=self.publisher))
        self.assertEqual(([r["action"] for r in next_page["items"]], next_page["hasMore"]), (["unpin"], False))
        self.assertEqual(self.client.get(PREFIX + "/intents?after=3", headers=self.publisher).status_code, 409)
        self.assertEqual(self.publish(intentCursor=3).status_code, 422)
        before = self.listing()["revision"]
        # PC has applied hide but not unpin. The remaining overlay wins.
        body = snapshot()
        body["artists"][0]["hidden"] = True
        self.ok(self.publish(items=body["artists"], intentCursor=1))
        listing = self.listing()
        self.assertGreater(listing["revision"], before)
        self.assertEqual([p["sequence"] for p in listing["pending"]], [2])
        self.assertFalse(listing["artists"][0]["pinned"])
        self.assertEqual(self.publish(intentCursor=0).status_code, 422)
        self.assertEqual(self.publish().status_code, 422)
        body["artists"][0]["pinned"] = False
        self.ok(self.publish(items=body["artists"], intentCursor=2))
        self.assertEqual(self.listing()["pending"], [])
        self.assertFalse(self.ok(self.publish(items=body["artists"], intentCursor=2))["changed"])

    def test_pending_target_survives_omission_and_materialization(self):
        self.ok(self.publish(items=[artist("alice", displayName=None)], assignments=[]))
        self.ok(self.post(artistId="alice", displayName="새 이름"))
        self.ok(self.publish(items=[], assignments=[]))
        self.ok(self.post("hide", artistId="alice"))
        self.assertEqual(self.listing()["artists"][0]["label"], "새 이름")
        self.ok(self.publish(items=[artist("artist:materialized", displayName=None)], assignments=[]))
        rows = self.listing()["artists"]
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["id"], rows[0]["label"], rows[0]["hidden"]),
                         ("artist:materialized", "새 이름", True))

    def test_retention_prunes_only_acknowledged_and_keeps_receipts(self):
        self.ok(self.publish())
        operation = str(uuid.uuid4())
        result = self.ok(self.post("hide", operationId=operation))
        self.ok(self.post("pin"))
        with self.get_db() as db:
            old = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
            db.execute("UPDATE library_artist_intents SET created_at=?", (old,))
            db.commit()
        self.ok(self.publish(intentCursor=1))
        expired = self.client.get(PREFIX + "/intents?after=0", headers=self.publisher)
        self.assertEqual((expired.status_code, self.code(expired)), (409, "artistIntentsExpired"))
        page = self.ok(self.client.get(PREFIX + "/intents?after=1", headers=self.publisher))
        self.assertEqual((page["prunedThrough"], [r["sequence"] for r in page["items"]]), (1, [2]))
        self.assertEqual(self.ok(self.post("hide", operationId=operation)), result)

    def test_upgrade_preserves_existing_snapshot(self):
        self.ok(self.publish())
        with self.get_db() as db:
            db.executescript("DROP TABLE library_artist_intents; DROP TABLE library_artist_receipts; "
                             "DROP TABLE library_artist_intent_state;")
            artists.startup_db(db)
        self.assertEqual(len(self.listing()["artists"]), 2)
        self.assertEqual(self.ok(self.post("hide"))["sequence"], 1)


class ArtistIntentAppWiring(unittest.TestCase):
    setUp = upcoming_tests.AppWiring.setUp
    tearDown = upcoming_tests.AppWiring.tearDown

    def test_status_exposes_artist_log_to_publishers_only(self):
        self.assertEqual(self.client.put(PREFIX, headers=self.publisher, json=snapshot()).status_code, 200)
        response = self.client.post(PREFIX + "/intents", headers=self.fixtures.AUTH, json={
            "version": 1, "operationId": str(uuid.uuid4()), "artistId": "artist:a1", "action": "hide"})
        self.assertEqual(response.status_code, 200, response.text)
        status = self.client.get("/v1/sync/status?signals=1", headers=self.publisher).json()
        self.assertEqual(status["publisherLogs"]["artistIntents"],
                         {"last": 1, "acknowledgedThrough": 0, "prunedThrough": 0})
        self.assertEqual(status["signals"]["artists"], response.json()["revision"])
        client = self.client.get("/v1/sync/status?signals=1", headers=self.fixtures.AUTH).json()
        self.assertNotIn("publisherLogs", client)


if __name__ == "__main__":
    unittest.main()
