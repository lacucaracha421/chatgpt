"""PC hands calendar ownership over while continuing wishlist/cursor publication."""
import json
from datetime import datetime, timezone
from unittest import mock

import home_upcoming as upcoming
import release_calendar
from tests.test_home_upcoming import HomeFixture, PREFIX, snapshot, title, wish


class CalendarHandover(HomeFixture):
    module = upcoming

    def setUp(self):
        super().setUp()
        with self.get_db() as db:
            release_calendar.startup_db(db)
            db.commit()
        for name in ("enabled", "credentials_present"):
            patch = mock.patch.object(release_calendar, name, return_value=True)
            patch.start()
            self.addCleanup(patch.stop)

    def put(self, value):
        return self.client.put(PREFIX, headers=self.publisher, json=value)

    def state(self):
        with self.get_db() as db:
            state = dict(upcoming._state(db))
            owner = db.execute("SELECT digest FROM release_calendar_owner").fetchone()
            ids = {row[0] for row in db.execute("SELECT item_id FROM home_upcoming_ids")}
        return state, owner[0] if owner else None, ids

    def handover(self, wishlist=None, cursor=0, **extra):
        return self.put({"version": 1, "wishlistOnly": True, "wishlist": wishlist or [],
                         "intentCursor": cursor, **extra})

    def test_pc_document_handover_retains_calendar_and_worker_preserves_wishlist(self):
        original = snapshot()
        self.ok(self.put(original))
        original = json.loads(self.state()[0]["document"])
        self.assertIsNone(self.state()[1])
        self.ok(self.handover([wish(muted=True)]))
        state, owner, ids = self.state()
        document = json.loads(state["document"])
        for key in ("entries", "sources", "rangeStart", "rangeEnd", "generatedAt"):
            self.assertEqual(document[key], original[key])
        self.assertEqual(owner, state["digest"])
        self.assertEqual(ids, {"igdb:1942", "tmdb:77"})
        calendar = {key: document[key] for key in ("entries", "sources", "rangeStart", "rangeEnd")}
        calendar["entries"] = [upcoming.Title.model_validate(title("igdb:999", title="Server only")).model_dump()]
        with self.get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            self.assertTrue(upcoming.publish_calendar(db, calendar, datetime.now(timezone.utc)))
            db.commit()
        latest = self.state()
        self.assertTrue(json.loads(latest[0]["document"])["wishlist"][0]["muted"])
        self.assertEqual(latest[1], latest[0]["digest"])
        # The PC never uploads its stale calendar copy on the next wishlist update.
        self.ok(self.handover([wish(muted=False)]))
        self.assertEqual(json.loads(self.state()[0]["document"])["entries"], calendar["entries"])

    def test_first_and_unchanged_handover_and_full_upload_ownership(self):
        self.ok(self.handover([wish()]))
        before = self.state()
        self.assertEqual(before[1], before[0]["digest"])
        self.assertEqual(json.loads(before[0]["document"])["entries"], [])
        reply = self.ok(self.handover([wish()]))
        self.assertFalse(reply["changed"])
        self.assertEqual(self.state(), before)
        self.ok(self.put(snapshot()))
        self.assertIsNone(self.state()[1])
        reply = self.ok(self.handover([wish()]))
        self.assertFalse(reply["changed"])
        self.assertEqual(self.state()[1], self.state()[0]["digest"])

    def test_invalid_cursor_and_calendar_fields_do_not_change_ownership(self):
        self.ok(self.put(snapshot()))
        self.ok(self.handover([wish()]))
        before = self.state()
        self.assertEqual(self.handover([wish()], cursor=1).status_code, 409)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.handover([wish()], entries=[]).status_code, 422)
        self.assertEqual(self.state(), before)
        with mock.patch.object(release_calendar, "enabled", return_value=False):
            self.assertEqual(self.handover([wish()]).status_code, 503)
        self.assertEqual(self.state(), before)

    def test_server_only_add_carries_snapshot_title_and_is_acknowledged(self):
        self.ok(self.put(snapshot(entries=[title("igdb:999", title="Server only")], wishlist=[])))
        self.ok(self.handover())
        import uuid
        self.ok(self.client.post(PREFIX + "/wishlist", headers=self.auth,
                                json={"version": 1, "operationId": str(uuid.uuid4()),
                                      "action": "add", "itemId": "igdb:999"}))
        # The worker's next window/hype filter removes it before the PC reads.
        self.ok(self.put(snapshot(entries=[], wishlist=[])))
        self.ok(self.handover())
        page = self.ok(self.client.get(PREFIX + "/wishlist/intents", headers=self.publisher))
        self.assertEqual(page["items"][0]["title"]["title"], "Server only")
        wished = {**title("igdb:999", title="Server only"), "source": "calendar",
                  "addedAt": "2026-10-09T00:00:00Z", "muted": False, "released": False, "events": []}
        reply = self.ok(self.handover([wished], cursor=page["nextCursor"]))
        self.assertEqual(reply["acknowledgedThrough"], 1)
        state, owner, _ = self.state()
        self.assertEqual(owner, state["digest"])
        self.assertEqual(json.loads(state["document"])["wishlist"][0]["id"], "igdb:999")
        before = self.state()
        self.assertEqual(self.handover([wished], cursor=0).status_code, 409)
        self.assertEqual(self.state(), before)

    def test_legacy_intent_title_falls_back_to_current_document(self):
        import uuid
        self.ok(self.put(snapshot()))
        self.ok(self.client.post(PREFIX + "/wishlist", headers=self.auth,
                                json={"version": 1, "operationId": str(uuid.uuid4()),
                                      "action": "add", "itemId": "igdb:1942"}))
        with self.get_db() as db:
            db.execute("UPDATE home_upcoming_intents SET title_json=NULL")
            db.commit()
        page = self.ok(self.client.get(PREFIX + "/wishlist/intents", headers=self.publisher))
        self.assertEqual(page["items"][0]["title"]["id"], "igdb:1942")
        self.ok(self.put(snapshot(entries=[], wishlist=[])))
        page = self.ok(self.client.get(PREFIX + "/wishlist/intents", headers=self.publisher))
        self.assertNotIn("title", page["items"][0])

    def test_additive_intent_migration_is_repeatable_and_preserves_old_rows(self):
        import sqlite3
        db = sqlite3.connect(":memory:")
        db.executescript(upcoming.DDL)
        db.execute("INSERT INTO home_upcoming_intents VALUES(1,'old','add','igdb:1942',NULL,'2026-10-09T00:00:00Z')")
        upcoming.startup_db(db)
        upcoming.startup_db(db)
        self.assertEqual(db.execute("SELECT title_json FROM home_upcoming_intents").fetchone(), (None,))
        db.close()

    def test_wishlist_only_oversize_merge_rolls_back_document_cursor_and_owner(self):
        self.ok(self.put(snapshot()))
        before = self.state()
        cap = len(before[0]["document"].encode()) - 1
        with mock.patch.object(upcoming, "MAX_BODY_BYTES", cap):
            response = self.handover([wish()])
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.code(response), "upcomingUploadTooLarge")
        self.assertEqual(self.state(), before)
        # Also exercise the HTTP request cap, independent of the merged document cap.
        response = self.client.put(PREFIX, headers=self.publisher,
                                   content=b' ' * (upcoming.MAX_BODY_BYTES + 1))
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.state(), before)

    def test_on_off_on_preserves_digest_and_transfers_ownership_only_on_upload(self):
        self.ok(self.put(snapshot()))
        before = self.state()
        self.ok(self.handover([wish()]))
        handed = self.state()
        self.assertEqual(handed[0]["digest"], before[0]["digest"])
        with mock.patch.object(release_calendar, "enabled", return_value=False):
            self.assertEqual(self.handover([wish()]).status_code, 503)
        self.assertEqual(self.state(), handed)
        self.ok(self.handover([wish()]))
        self.assertEqual(self.state(), handed)
        # A genuine OFF PC fetch can reclaim ownership, then ON hands it back.
        with mock.patch.object(release_calendar, "enabled", return_value=False):
            self.ok(self.put(snapshot()))
        self.assertIsNone(self.state()[1])
        self.ok(self.handover([wish()]))
        self.assertEqual(self.state(), handed)

    def test_get_document_revalidates_with_etag_and_changes_after_intent(self):
        import uuid
        self.ok(self.put(snapshot()))
        response = self.client.get(PREFIX, headers=self.auth)
        self.ok(response)
        headers = {**self.auth, "If-None-Match": response.headers["etag"]}
        self.assertEqual(self.client.get(PREFIX, headers=headers).status_code, 304)
        self.ok(self.client.post(PREFIX + "/wishlist", headers=self.auth,
                                json={"version": 1, "operationId": str(uuid.uuid4()),
                                      "action": "add", "itemId": "igdb:1942"}))
        self.assertEqual(self.client.get(PREFIX, headers=headers).status_code, 200)
