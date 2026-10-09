"""HTTP integration tests; skipped without the repository's API dependencies."""
import copy
import json
import os
import unittest
import uuid
from unittest import mock

import release_calendar as rc
import release_wishlist as rw
from tests.test_release_wishlist import NOW, KEYS, item, release, event, seed_body, Transport

try:
    import api_auth
    import collection_authority as ca
    import home_upcoming as home
    import work_providers as wp
    from app_lifecycle import lifecycle
    from tests.test_home_upcoming import HomeFixture, snapshot, title, SHA
except ModuleNotFoundError as exc:
    MISSING = str(exc)
    HomeFixture = unittest.TestCase
else:
    MISSING = None


@unittest.skipIf(MISSING is not None, f"API dependencies unavailable: {MISSING}")
class WishlistRoutes(HomeFixture):
    module = home if MISSING is None else None

    def setUp(self):
        super().setUp()
        env = mock.patch.dict(os.environ, KEYS)
        env.start()
        self.addCleanup(env.stop)
        previous = rw._current, rc._current
        self.addCleanup(setattr, rw, "_current", previous[0])
        self.addCleanup(setattr, rc, "_current", previous[1])
        client_guard = api_auth.client_guard(self.get_db, None)
        relay = wp.Relay()
        self.calendar = rc.register(self.client.app, self.get_db, client_guard, relay)
        self.worker = rw.register(self.client.app, self.get_db, client_guard,
                                  api_auth.publisher_guard(self.get_db), relay)
        self.assertIs(self.calendar.transport.relay, self.worker.transport.relay)
        self.worker.now = lambda: NOW
        self.worker.transport = Transport()
        with self.get_db() as db:
            rc.startup_db(db)
            rw.startup_db(db)
            db.commit()

    def state(self):
        with self.get_db() as db:
            return dict(home._state(db)), rw.export_private(db)

    def seed(self, **kwargs):
        with self.get_db() as db:
            body = seed_body(db, **kwargs)
        response = self.client.put(rw.PREFIX + "/handover", headers=self.publisher, json=body)
        return response, body

    def intent(self, action="mute", id_="igdb:1", **kwargs):
        return self.client.post(home.PREFIX + "/wishlist", headers=self.auth,
                                json={"version": 1, "operationId": str(uuid.uuid4()), "action": action,
                                      "itemId": id_, **kwargs})

    def test_auth_precedes_off_availability_and_export_remains_read_only(self):
        for suffix, method in (("/handover", self.client.put), ("/export", self.client.get),
                               ("/status", self.client.get), ("/run", self.client.post)):
            self.assertEqual(method(rw.PREFIX + suffix).status_code, 401)
        self.assertEqual(self.client.get(rw.PREFIX + "/export", headers=self.auth).status_code, 401)
        self.assertEqual(self.client.put(rw.PREFIX + "/handover", headers=self.auth, json={}).status_code, 401)
        with mock.patch.dict(os.environ, {rw.ENV: "0"}):
            before = self.state()
            self.assertEqual(self.client.get(rw.PREFIX + "/status", headers=self.auth).status_code, 200)
            self.assertEqual(self.client.get(rw.PREFIX + "/export", headers=self.publisher).status_code, 200)
            self.assertEqual(self.client.post(rw.PREFIX + "/run", headers=self.auth, json={}).status_code, 404)
            self.assertEqual(self.client.put(rw.PREFIX + "/handover", headers=self.publisher, json={}).status_code, 404)
            self.assertEqual(self.state(), before)

    def test_seed_idempotence_fences_old_pc_before_cursor_or_body_validation(self):
        response, body = self.seed(events=[event("old-read", read_at=NOW.isoformat())])
        expected = self.ok(response)
        before = self.state()
        self.assertEqual(self.ok(self.client.put(rw.PREFIX + "/handover", headers=self.publisher, json=body)), expected)
        self.assertEqual(self.state(), before)
        for switch in ("1", "0"):
            with mock.patch.dict(os.environ, {rw.ENV: switch}):
                for value in (snapshot(cursor=999), {"version": 1, "wishlistOnly": True, "wishlist": [], "intentCursor": 999}, {}):
                    response = self.client.put(home.PREFIX, headers=self.publisher, json=value)
                    self.assertEqual(response.status_code, 409)
                    self.assertEqual(self.code(response), "serverWishlistOwned")
                self.assertEqual(self.state(), before)
        conflict = copy.deepcopy(body)
        conflict["libraryId"] = "another"
        self.assertEqual(self.client.put(rw.PREFIX + "/handover", headers=self.publisher, json=conflict).status_code, 409)
        self.assertEqual(self.seed()[0].status_code, 409)

    def test_post_receipts_pending_signals_304_and_off_then_resume(self):
        self.ok(self.seed()[0])
        self.assertIn(rw.FEATURE, ca.advertised_features())
        with mock.patch.dict(os.environ, {"LAKOMICS_TMDB_API_KEY": ""}):
            self.assertIn(rw.FEATURE, ca.advertised_features())
        operation = str(uuid.uuid4())
        payload = {"version": 1, "operationId": operation, "action": "mute", "itemId": "igdb:1"}
        receipt = self.ok(self.client.post(home.PREFIX + "/wishlist", headers=self.auth, json=payload))
        state = self.ok(self.client.get(home.PREFIX, headers=self.auth))
        self.assertTrue(state["wishlist"][0]["muted"])
        self.assertEqual((state["pending"], state["acknowledgedThrough"]), ([], 1))
        before = self.state()
        self.assertEqual(self.ok(self.client.post(home.PREFIX + "/wishlist", headers=self.auth, json=payload)), receipt)
        self.assertEqual(self.state(), before)
        conflict = {**payload, "action": "remove"}
        self.assertEqual(self.client.post(home.PREFIX + "/wishlist", headers=self.auth, json=conflict).status_code, 409)
        etag = self.client.get(home.PREFIX, headers=self.auth).headers["etag"]
        self.assertEqual(self.client.get(home.PREFIX, headers={**self.auth, "If-None-Match": etag}).status_code, 304)
        with mock.patch.dict(os.environ, {rw.ENV: "0"}):
            self.assertNotIn(rw.FEATURE, ca.advertised_features())
            self.ok(self.intent("remove"))
            state = self.ok(self.client.get(home.PREFIX, headers=self.auth))
            self.assertEqual(len(state["pending"]), 1)
            self.assertEqual(len(state["wishlist"]), 1)
        self.worker.apply_pending()
        state = self.ok(self.client.get(home.PREFIX, headers=self.auth))
        self.assertEqual((state["pending"], state["wishlist"], state["acknowledgedThrough"]), ([], [], 2))

    def test_run_caps_validation_rate_limiting_worker_health_and_drain(self):
        for body in ({"version": True}, {"version": 2}, {"extra": 1}, []):
            self.assertEqual(self.client.post(rw.PREFIX + "/run", headers=self.auth, json=body).status_code, 422)
        self.assertEqual(self.client.post(rw.PREFIX + "/run", headers=self.auth, content=b"x" * 1025).status_code, 413)
        self.assertEqual(self.client.post(rw.PREFIX + "/run", headers=self.auth, json={}).status_code, 503)
        with mock.patch.object(self.worker, "alive", return_value=True), mock.patch.object(self.worker, "request") as request:
            for _ in range(5):
                self.assertEqual(self.client.post(rw.PREFIX + "/run", headers=self.auth, json={}).status_code, 200)
            response = self.client.post(rw.PREFIX + "/run", headers=self.auth, json={})
            self.assertEqual(response.status_code, 429)
            self.assertIn("Retry-After", response.headers)
            self.assertEqual(request.call_count, 5)
        self.worker.drain()
        self.assertFalse(self.worker.alive())
        self.assertTrue(self.worker.status_view()["draining"])

    def test_seed_validation_caps_cover_rollback_and_calendar_cover_refs(self):
        for body in ({}, {"version": True}, [], None):
            self.assertEqual(self.client.put(rw.PREFIX + "/handover", headers=self.publisher, json=body).status_code, 422)
        with mock.patch.object(rw, "MAX_SEED_BYTES", 10):
            self.assertEqual(self.client.put(rw.PREFIX + "/handover", headers=self.publisher, content=b"x" * 11).status_code, 413)
        self.confirm_artwork()
        calendar_title = title(cover={"sha256": SHA, "sizeBytes": 10, "contentType": "image/webp"})
        self.ok(self.client.put(home.PREFIX, headers=self.publisher, json=snapshot(entries=[calendar_title], wishlist=[], cursor=0)))
        with self.get_db() as db:
            db.execute("INSERT INTO release_calendar_owner VALUES(1,?)", (home._state(db)["digest"],))
            db.commit()
        self.ok(self.seed()[0])
        self.ok(self.ticket())
        self.ok(self.intent())
        self.ok(self.ticket())
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT digest FROM release_calendar_owner").fetchone()[0], home._state(db)["digest"])

    def test_shared_startup_off_creates_only_tables_without_thread(self):
        with mock.patch.dict(os.environ, {rw.ENV: "0", rc.ENV: "0"}):
            before = self.state()[0]
            for handler in lifecycle(self.client.app).startup_handlers:
                handler()
            self.assertEqual(self.state()[0], before)
            self.assertIsNone(self.calendar.thread)
            self.assertEqual(self.worker.transport.requests, [])
        self.assertIs(self.worker.scheduler, self.calendar)
        self.assertIs(self.calendar.wishlist_worker, self.worker)

    def test_add_cap_rejection_keeps_log_usable_for_remove(self):
        self.ok(self.client.put(home.PREFIX, headers=self.publisher,
                                json=snapshot(entries=[title("igdb:2")], wishlist=[], cursor=0)))
        self.ok(self.seed()[0])
        before = self.state()
        with mock.patch.object(rw, "MAX_ITEMS", 1):
            response = self.intent("add", "igdb:2")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.code(response), "wishlistItemLimit")
        self.assertEqual(self.state(), before)
        self.ok(self.intent("remove"))
        self.assertEqual(self.state()[0]["acknowledged_through"], 1)


if __name__ == "__main__":
    unittest.main()
