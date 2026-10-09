"""Authenticated route/publication integration; requires the existing API dependencies.

No live providers, production library, daemon or network. The plain-Python sandbox
can discover these tests and reports skips when dependencies are unavailable.
"""
import json
import os
import unittest
from unittest import mock

import release_calendar as rc
from tests.test_release_calendar import FIXTURE, KEYS, NOW, Transport

try:
    import api_auth
    import collection_authority
    import home_upcoming
    from tests.test_home_upcoming import HomeFixture, SHA, snapshot, wish
except ModuleNotFoundError as error:
    MISSING = str(error)
    HomeFixture = unittest.TestCase
else:
    MISSING = None


@unittest.skipIf(MISSING is not None, f"API dependencies unavailable: {MISSING}")
class CalendarRoutes(HomeFixture):
    module = home_upcoming if MISSING is None else None

    def setUp(self):
        super().setUp()
        self.env = mock.patch.dict(os.environ, KEYS)
        self.env.start()
        self.addCleanup(self.env.stop)
        previous = rc._current
        self.addCleanup(setattr, rc, "_current", previous)
        self.worker = rc.register(self.client.app, self.get_db, api_auth.client_guard(self.get_db, None), mock.Mock())
        with self.get_db() as db:
            rc.startup_db(db)
            db.commit()
        self.worker.now = lambda: NOW
        case = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"][0]
        self.worker.transport = Transport(case["responses"])

    def test_route_auth_before_availability(self):
        for path in ("/status", "/run"):
            method = self.client.get if path == "/status" else self.client.post
            self.assertEqual(method(rc.PREFIX + path).status_code, 401)
        with mock.patch.dict(os.environ, {rc.ENV: "0"}):
            self.assertEqual(self.client.get(rc.PREFIX + "/status", headers=self.auth).status_code, 404)
            self.assertEqual(self.client.post(rc.PREFIX + "/run", headers=self.auth, json={}).status_code, 404)
            self.assertEqual(rc.features(), [])

    def test_status_run_validation_rate_limit_and_availability(self):
        self.assertEqual(self.client.get(rc.PREFIX + "/status", headers=self.auth).status_code, 200)
        self.assertEqual(self.client.post(rc.PREFIX + "/run", headers=self.auth, json={}).status_code, 503)
        for body in ({"version": 2}, {"extra": True}, {"version": True}):
            self.assertEqual(self.client.post(rc.PREFIX + "/run", headers=self.auth, json=body).status_code, 422)
        with mock.patch.object(self.worker, "alive", return_value=True), mock.patch.object(self.worker, "request") as wake:
            reply = self.client.post(rc.PREFIX + "/run", headers=self.auth, json={})
            self.assertEqual(reply.status_code, 200, reply.text)
            wake.assert_called_once()
            self.assertEqual(reply.json(), {"version": 1, "queued": True})
            self.assertIn(rc.FEATURE, collection_authority.advertised_features())
            with mock.patch.dict(os.environ, {"LAKOMICS_IGDB_CLIENT_SECRET": ""}):
                self.assertNotIn(rc.FEATURE, collection_authority.advertised_features())
                self.assertEqual(self.client.post(rc.PREFIX + "/run", headers=self.auth, json={}).status_code, 503)
            limited = self.client.post(rc.PREFIX + "/run", headers=self.auth, json={})
            self.assertEqual(limited.status_code, 429)
            self.assertIn("Retry-After", limited.headers)

    def test_pc_put_worker_pc_put_preserves_document_and_cursor_rules(self):
        self.confirm_artwork()
        wished = wish(cover={"sha256": SHA, "sizeBytes": 10, "contentType": "image/webp"})
        self.ok(self.client.put(home_upcoming.PREFIX, headers=self.publisher, json=snapshot(wishlist=[wished], cursor=0)))
        self.ok(self.client.post(home_upcoming.PREFIX + "/wishlist", headers=self.auth,
                                json={"version": 1, "operationId": "11111111-1111-4111-8111-111111111111",
                                      "action": "mute", "itemId": wished["id"]}))
        before = self.ok(self.client.get(home_upcoming.PREFIX, headers=self.auth))
        self.assertFalse(self.worker.run_once())
        reply = self.client.get(home_upcoming.PREFIX, headers=self.auth)
        after = self.ok(reply)
        self.assertEqual(after["wishlist"], before["wishlist"])
        self.assertEqual(after["pending"], before["pending"])
        self.assertEqual(after["acknowledgedThrough"], before["acknowledgedThrough"])
        self.assertEqual(after, before)
        # The PC still publishes and acknowledges the pending intent after a worker wake.
        put = lambda body: self.client.put(home_upcoming.PREFIX, headers=self.publisher, json=body)
        self.assertEqual(put(snapshot(wishlist=[wished], cursor=2)).status_code, 409)
        published = self.ok(put(snapshot(wishlist=[{**wished, "muted": True}], cursor=1)))
        self.assertEqual(published["acknowledgedThrough"], 1)
        self.assertEqual(put(snapshot(wishlist=[wished], cursor=0)).status_code, 409)
        self.assertEqual(put(snapshot(wishlist=[wished])).status_code, 409)
        final = self.ok(self.client.get(home_upcoming.PREFIX, headers=self.auth))
        self.assertEqual(final["pending"], [])
        self.assertEqual(final["acknowledgedThrough"], 1)
        self.ok(self.ticket())
        self.assertFalse(self.worker.run_once())
        etag = self.client.get(home_upcoming.PREFIX, headers=self.auth).headers["etag"]
        self.assertEqual(self.client.get(home_upcoming.PREFIX, headers={**self.auth, "If-None-Match": etag})
                         .status_code, 304)

    def test_disabled_startup_creates_tables_without_starting_worker(self):
        from app_lifecycle import lifecycle
        hooks = lifecycle(self.client.app)
        with mock.patch.dict(os.environ, {rc.ENV: "0"}):
            for handler in hooks.startup_handlers:
                handler()
        self.assertIsNone(self.worker.thread)
        self.assertFalse(self.worker.transport.requests)
        self.assertIn(self.worker.drain, hooks.drain_handlers)
        self.assertIn(self.worker.stop, hooks.shutdown_handlers)

    def test_transport_uses_shared_relay_locks_and_public_errors(self):
        import work_providers as wp
        relay = wp.Relay()
        transport = rc.LiveTransport(relay)
        relay.locks["tmdb"].acquire()
        try:
            with mock.patch.object(relay, "tmdb") as fetch:
                with self.assertRaises(rc.BudgetExceeded):
                    transport.request("tmdb_tv", ("/tv/1", {}), rc.Budget())
                fetch.assert_not_called()
        finally:
            relay.locks["tmdb"].release()
        for status, expected in ((401, "invalid_credential"), (429, "rate_limited"),
                                 (404, "not_found"), (503, "unavailable")):
            with mock.patch.object(relay, "tmdb", side_effect=wp.UpstreamStatus(status)):
                with self.assertRaises(rc.ProviderFailure) as caught:
                    transport.request("tmdb", ("/discover/movie", {}), rc.Budget())
            self.assertEqual(caught.exception.code, expected)
            self.assertFalse(relay.locks["tmdb"].locked())
        with mock.patch.object(relay, "twitch_token", return_value="fixture-token"), \
                mock.patch.object(relay, "json_request", return_value=[]) as fetch:
            transport.request("igdb", "fields id;", rc.Budget())
            self.assertEqual(fetch.call_args.kwargs["budget"], [rc.MAX_JSON_BYTES])

    def test_server_publication_then_identical_pc_put_revokes_ownership(self):
        self.assertTrue(self.worker.run_once())
        document = self.ok(self.client.get(home_upcoming.PREFIX, headers=self.auth))
        keys = ("generatedAt", "rangeStart", "rangeEnd", "entries", "wishlist", "sources")
        upload = {key: document[key] for key in keys}
        rejected = self.client.put(home_upcoming.PREFIX, headers=self.publisher,
                                   json={"version": 1, "intentCursor": 1, **upload})
        self.assertEqual(rejected.status_code, 409)
        with self.get_db() as db:
            self.assertIsNotNone(db.execute("SELECT * FROM release_calendar_owner").fetchone())
        result = self.ok(self.client.put(home_upcoming.PREFIX, headers=self.publisher,
                                        json={"version": 1, "intentCursor": 0, **upload}))
        self.assertFalse(result["changed"])
        with self.get_db() as db:
            self.assertIsNone(db.execute("SELECT * FROM release_calendar_owner").fetchone())
        from datetime import timedelta
        self.worker.now = lambda: NOW + timedelta(days=1)
        # New day requests have different windows, so use an empty offline transport.
        class Empty:
            def request(self, provider, query, budget):
                budget.take()
                return [] if provider == "igdb" else {"results": []}
        self.worker.transport = Empty()
        self.assertFalse(self.worker.run_once())
        self.assertEqual(self.ok(self.client.get(home_upcoming.PREFIX, headers=self.auth)), document)

    def test_interactive_relay_waits_briefly_for_worker_request(self):
        import threading
        import work_providers as wp
        for provider in ("tmdb", "igdb"):
            relay = wp.Relay()
            transport = rc.LiveTransport(relay)
            entered, release, waiting, done = (threading.Event() for _ in range(4))
            errors = []
            def fetch(*args, **kwargs):
                entered.set()
                if not release.wait(2):
                    raise AssertionError("worker not released")
                return []
            def worker():
                try:
                    query = "fields id;" if provider == "igdb" else ("/discover/movie", {})
                    transport.request(provider, query, rc.Budget())
                except Exception as error:
                    errors.append(error)
            def interactive():
                try:
                    waiting.set()
                    relay.paced(provider, lambda deadline: done.set())
                except Exception as error:
                    errors.append(error)
            with mock.patch.object(relay, provider, side_effect=fetch):
                thread = threading.Thread(target=worker)
                thread.start()
                self.assertTrue(entered.wait(1))
                user = threading.Thread(target=interactive)
                user.start()
                self.assertTrue(waiting.wait(1))
                self.assertFalse(done.wait(0.05))
                release.set()
                thread.join(2)
                user.join(2)
                self.assertFalse(thread.is_alive())
                self.assertFalse(user.is_alive())
            self.assertFalse(errors)
            self.assertTrue(done.is_set())
            # A permanently busy relay still rejects within the fixed bound.
            relay.locks[provider].acquire()
            try:
                from fastapi import HTTPException
                with self.assertRaises(HTTPException) as caught:
                    relay.paced(provider, lambda deadline: None)
                self.assertEqual(caught.exception.detail["code"], "providerBusy")
            finally:
                relay.locks[provider].release()

    def test_relay_rejects_nonfinite_json_and_invalid_token(self):
        import work_providers as wp
        for raw in (b'{"value":NaN}', b'{"value":Infinity}', b'{"value":-Infinity}', b'{"value":1e999}'):
            with mock.patch.object(wp, "outbound", return_value=(raw, {})):
                with self.assertRaises(rc.ProviderFailure) as caught:
                    rc.LiveTransport(wp.Relay()).request("tmdb", ("/discover/movie", {}), rc.Budget())
            self.assertEqual(caught.exception.code, "invalid_response")
        for raw in ([], None, {}, {"access_token": "", "expires_in": 100},
                    {"access_token": "token", "expires_in": 0}):
            relay = wp.Relay()
            with mock.patch.object(relay, "json_request", return_value=raw):
                with self.assertRaises(rc.ProviderFailure) as caught:
                    rc.LiveTransport(relay).request("igdb", "fields id;", rc.Budget())
            self.assertEqual(caught.exception.code, "invalid_response")
            self.assertIsNone(relay.token)

    def test_lifecycle_stops_a_live_worker_without_provider_requests(self):
        import threading
        started = threading.Event()
        def loop():
            started.set()
            self.worker.stop_event.wait(5)
        with mock.patch.object(self.worker, "loop", side_effect=loop):
            self.worker.start()
            try:
                self.assertTrue(started.wait(1))
                self.assertTrue(self.worker.alive())
                self.assertIn(rc.FEATURE, rc.features())
            finally:
                self.worker.stop()
        self.assertIsNone(self.worker.thread)
        self.assertNotIn(rc.FEATURE, rc.features())
        self.assertFalse(self.worker.transport.requests)


if __name__ == "__main__":
    unittest.main()
