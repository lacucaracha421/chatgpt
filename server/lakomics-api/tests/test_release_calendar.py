"""Offline provider parity and real SQLite transaction/scheduler checks (stdlib only).

The shared JSON's _format describes the Rust-compatible request/response queue.
Expected entries are literal data, not computed by the implementation under test.
"""
import copy
import json
import os
import sqlite3
import threading
import unittest
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import release_calendar as rc

FIXTURE = Path(__file__).resolve().parents[3] / "_tools/app/src-tauri/src/library/fixtures/release_calendar.json"
NOW = datetime(2026, 10, 9, tzinfo=timezone.utc)
KEYS = {rc.ENV: "1", "LAKOMICS_TMDB_API_KEY": "fixture", "LAKOMICS_IGDB_CLIENT_ID": "fixture",
        "LAKOMICS_IGDB_CLIENT_SECRET": "fixture"}


class Transport:
    def __init__(self, responses):
        self.responses = copy.deepcopy(responses)
        self.requests = []

    def request(self, provider, query, budget):
        budget.take()
        request = {"provider": provider, "body": query} if provider == "igdb" else \
            {"provider": provider, "path": query[0], "params": query[1]}
        self.requests.append(request)
        if not self.responses:
            raise AssertionError("unexpected provider request")
        expected = self.responses.pop(0)
        for key, value in request.items():
            if expected[key] != value:
                raise AssertionError(f"request mismatch: {request!r} != {expected!r}")
        if "error" in expected:
            raise rc.ProviderFailure(expected["error"])
        return expected["response"]


class Parity(unittest.TestCase):
    def test_shared_provider_fixture(self):
        for case in json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]:
            with self.subTest(case=case["name"]):
                start, end = date.fromisoformat(case["rangeStart"]), date.fromisoformat(case["rangeEnd"])
                transport = Transport(case["responses"])
                rows = []
                for provider in rc.PROVIDERS:
                    rows.extend(rc.fetch_provider(transport, provider, start, end, rc.Budget()))
                actual = rc.sorted_entries(rows, start, end)
                self.assertEqual(actual, case["expectedEntries"])
                self.assertEqual(rc.encode(actual), rc.encode(case["expectedEntries"]))
                self.assertFalse(transport.responses)

    def test_half_open_period_overlap(self):
        start, end = date(2026, 10, 2), date(2027, 4, 10)
        for value, precision, expected in [("2026-10-01", "exact", False), ("2026-10-01", "month", True),
                                           ("2027-04-10", "exact", False), ("2027-01-01", "year", True),
                                           (None, "tbd", False)]:
            self.assertEqual(rc.overlaps({"date": value, "precision": precision}, start, end), expected)

    def test_cover_and_text_publication_rules(self):
        case = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"][0]
        expected = case["expectedEntries"][0]
        row = {**expected, "cover": "co-bad", "title": " \nHello\x00World ", "dates": [],
               "popularity": float("nan")}
        public = rc.public_title(row)
        self.assertIsNone(public["cover"])
        self.assertIsNone(public["popularity"])
        self.assertEqual(public["title"], "Hello World")
        row.update(kind="movie", cover="/../bad.jpg")
        self.assertIsNone(rc.public_title(row)["cover"])

    def test_request_and_time_budget(self):
        budget = rc.Budget(requests=1)
        budget.take()
        with self.assertRaises(rc.BudgetExceeded):
            budget.take()
        clock = [0]
        budget = rc.Budget(seconds=2, clock=lambda: clock[0])
        clock[0] = 2
        with self.assertRaises(rc.BudgetExceeded):
            budget.take()
        stop = threading.Event()
        stop.set()
        with self.assertRaises(rc.BudgetExceeded):
            rc.Budget(stop=stop).take()

    def test_igdb_page_limit(self):
        class Pages:
            def request(self, provider, query, budget):
                budget.take()
                return [{"id": n + 1, "name": "No date"} for n in range(500)]
        budget = rc.Budget()
        self.assertEqual(rc.fetch_provider(Pages(), "igdb", date(2026, 10, 2), date(2027, 4, 10), budget), [])
        self.assertEqual(budget.requests, 2)

    def test_discover_and_detail_limits(self):
        class Pages:
            def __init__(self):
                self.paths = []

            def request(self, provider, query, budget):
                budget.take()
                path, params = query
                self.paths.append(path)
                if path.startswith("/discover"):
                    offset = (int(params["page"]) - 1) * 20
                    return {"results": [{"id": n + 1, "title": "Movie", "popularity": n,
                                         "release_date": "2026-11-01"} for n in range(offset, offset + 20)],
                            "total_pages": 100}
                if path.startswith("/tv"):
                    return {"id": int(path.split("/")[-1]), "name": "Anime", "seasons": []}
                return {"results": []}
        for provider in ("tmdb", "tmdb_tv"):
            transport = Pages()
            budget = rc.Budget()
            rc.fetch_provider(transport, provider, date(2026, 10, 2), date(2027, 4, 10), budget)
            self.assertEqual(budget.requests, 63)
            self.assertEqual(sum(p.startswith("/discover") for p in transport.paths), 3)


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)

        @contextmanager
        def get_db():
            try:
                yield self.db
            finally:
                if self.db.in_transaction:
                    self.db.rollback()

        self.get_db = get_db
        with get_db() as db:
            rc.startup_db(db)
            # Identical store schema to home_upcoming; API/cover validation is covered
            # separately by the dependency-bearing route tests.
            db.executescript("""
            CREATE TABLE home_upcoming_state(singleton INTEGER PRIMARY KEY, revision INTEGER,
             published_at TEXT, digest TEXT, document TEXT, intent_sequence INTEGER,
             acknowledged_through INTEGER, pruned_through INTEGER);
            INSERT INTO home_upcoming_state VALUES(1,0,NULL,NULL,NULL,0,0,0);
            CREATE TABLE home_upcoming_ids(item_id TEXT PRIMARY KEY);
            CREATE TABLE home_upcoming_intents(sequence INTEGER PRIMARY KEY, payload TEXT);
            CREATE TABLE home_upcoming_receipts(operation_id TEXT PRIMARY KEY, payload TEXT);
            """)
        self.cover_calls = []
        self.moment = NOW
        self.patcher = mock.patch.dict(os.environ, KEYS)
        self.patcher.start()

        def publish(db, doc, now):
            return rc.store_calendar(db, doc, now, lambda value: value,
                                     lambda _, covers: self.cover_calls.append(covers))

        self.worker = rc.Worker(get_db, publish=publish, now=lambda: self.moment)
        self.case = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"][0]
        self.worker.transport = Transport(self.case["responses"])

    def tearDown(self):
        self.patcher.stop()

    def state(self):
        with self.get_db() as db:
            return dict(db.execute("SELECT * FROM home_upcoming_state").fetchone())

    def test_initial_snapshot_and_no_work_when_fresh(self):
        self.assertTrue(self.worker.run_once())
        published = self.state()
        self.assertEqual(json.loads(published["document"])["entries"], self.case["expectedEntries"])
        self.assertFalse(self.worker.run_once())
        self.assertEqual(self.state(), published)
        self.assertEqual(len(self.cover_calls), 1)
        self.assertFalse(self.worker.transport.responses)

    def test_manual_minimum_and_automatic_backoff(self):
        row = {"fetched_at": None, "attempted_at": NOW.isoformat(), "error_code": "rate_limited"}
        self.assertFalse(rc.due(row, NOW + timedelta(minutes=59)))
        self.assertTrue(rc.due(row, NOW + timedelta(hours=1)))
        self.assertFalse(rc.due(row, NOW + timedelta(seconds=59), True))
        self.assertTrue(rc.due(row, NOW + timedelta(minutes=1), True))
        row.update(fetched_at=NOW.isoformat(), error_code=None)
        self.assertFalse(rc.due(row, NOW + timedelta(minutes=59), True))
        self.assertTrue(rc.due(row, NOW + timedelta(hours=1), True))
        self.assertFalse(rc.due(row, NOW + timedelta(hours=23)))
        self.assertTrue(rc.due(row, NOW + timedelta(hours=24)))

    def test_unchanged_refresh_does_not_rewrite_snapshot_or_covers(self):
        self.worker.run_once()
        before = self.state()
        self.moment += timedelta(hours=2)
        self.worker.transport = Transport(self.case["responses"])
        self.assertFalse(self.worker.run_once(manual=True))
        self.assertEqual(self.state(), before)
        self.assertEqual(len(self.cover_calls), 1)
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT fetched_at FROM release_calendar_state WHERE provider='igdb'")
                             .fetchone()[0], self.moment.isoformat())

    def test_switch_off_no_thread_network_or_writes(self):
        with mock.patch.dict(os.environ, {rc.ENV: "0"}), mock.patch.object(rc, "_current", self.worker):
            self.worker.start()
            self.assertIsNone(self.worker.thread)
            self.assertFalse(self.worker.run_once())
            self.assertEqual(rc.features(), [])
            self.assertEqual(self.worker.transport.requests, [])
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM release_calendar_state").fetchone()[0], 0)

    def test_feature_requires_live_worker_and_all_credentials(self):
        with mock.patch.object(rc, "_current", self.worker), mock.patch.object(self.worker, "alive", return_value=True):
            self.assertEqual(rc.features(), [rc.FEATURE])
            with mock.patch.dict(os.environ, {"LAKOMICS_TMDB_API_KEY": ""}):
                self.assertEqual(rc.features(), [])
                self.worker.start()
                self.assertIsNone(self.worker.thread)
            with mock.patch.object(self.worker, "alive", return_value=False):
                self.assertEqual(rc.features(), [])

    def test_failure_retains_cache_and_stops_requests_during_backoff(self):
        self.worker.run_once()
        before = json.loads(self.state()["document"])["entries"]
        self.moment += timedelta(days=1)
        class Failure:
            def __init__(self):
                self.calls = 0

            def request(self, provider, query, budget):
                budget.take()
                self.calls += 1
                raise rc.ProviderFailure("rate_limited")
        transport = Failure()
        self.worker.transport = transport
        self.worker.run_once()
        self.assertEqual(json.loads(self.state()["document"])["entries"], before)
        self.worker.run_once()
        self.assertEqual(transport.calls, 3)
        self.moment += timedelta(hours=1)
        self.worker.run_once()
        self.assertEqual(transport.calls, 6)

    def test_expired_cache_does_not_replace_existing_document(self):
        self.worker.run_once()
        before = self.state()
        self.moment += timedelta(days=181)
        class Failure:
            def request(self, provider, query, budget):
                budget.take()
                raise rc.ProviderFailure("unavailable")
        self.worker.transport = Failure()
        self.worker.run_once()
        self.assertEqual(self.state(), before)
        self.assertTrue(all(s["fetchedAt"] is None for s in self.worker.status_view()["sources"]))

    def test_wishlist_latest_publication_and_cursor_are_preserved(self):
        self.worker.run_once()
        wish = {"id": "tmdb:88", "cover": None, "muted": True, "events": [{"id": "read-and-unread"}]}
        class ConcurrentPC:
            def request(inner, provider, query, budget):
                budget.take()
                with self.get_db() as db:
                    current = json.loads(self.state()["document"])
                    current["wishlist"] = [wish]
                    db.execute("UPDATE home_upcoming_state SET document=?,intent_sequence=9,acknowledged_through=4,pruned_through=2",
                               (rc.encode(current),))
                    db.execute("INSERT OR IGNORE INTO home_upcoming_intents VALUES(5,'pending')")
                    db.execute("INSERT OR IGNORE INTO home_upcoming_receipts VALUES('operation','receipt')")
                    db.commit()
                raise rc.ProviderFailure("unavailable")
        self.moment += timedelta(days=1)
        self.worker.transport = ConcurrentPC()
        self.worker.run_once()
        state = self.state()
        self.assertEqual(json.loads(state["document"])["wishlist"], [wish])
        self.assertEqual((state["intent_sequence"], state["acknowledged_through"], state["pruned_through"]), (9, 4, 2))
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT payload FROM home_upcoming_intents").fetchone()[0], "pending")
            self.assertEqual(db.execute("SELECT payload FROM home_upcoming_receipts").fetchone()[0], "receipt")
            self.assertIsNotNone(db.execute("SELECT 1 FROM home_upcoming_ids WHERE item_id='tmdb:88'").fetchone())

    def test_budget_never_replaces_a_complete_provider_cache(self):
        self.worker.run_once()
        self.moment += timedelta(hours=2)
        before = self.state()
        class Exhausted:
            def request(self, provider, query, budget):
                raise rc.BudgetExceeded()
        self.worker.transport = Exhausted()
        self.assertFalse(self.worker.run_once(manual=True))
        self.assertEqual(self.state(), before)
        with self.get_db() as db:
            self.assertTrue(all(r[0] == NOW.isoformat() for r in db.execute("SELECT fetched_at FROM release_calendar_state")))
        self.assertEqual(self.worker.status_view()["stopReason"], "budget")

    def test_budget_before_first_result_does_not_publish_empty_snapshot_and_rotates(self):
        class Exhausted:
            def __init__(self):
                self.providers = []

            def request(self, provider, query, budget):
                self.providers.append(provider)
                raise rc.BudgetExceeded()
        transport = Exhausted()
        self.worker.transport = transport
        self.assertFalse(self.worker.run_once())
        self.assertIsNone(self.state()["document"])
        self.assertFalse(self.worker.run_once())
        self.assertFalse(self.worker.run_once())
        self.assertEqual(transport.providers, list(rc.PROVIDERS))

    def test_partial_movie_result_is_discarded_on_budget_exhaustion(self):
        self.worker.run_once()
        before = self.state()
        self.moment += timedelta(hours=2)
        class Partial:
            def request(self, provider, query, budget):
                budget.take()
                if provider == "igdb":
                    raise rc.BudgetExceeded()
                if query[0] == "/discover/movie":
                    return {"results": [{"id": 999, "title": "Partial", "release_date": "2026-11-01"},
                                        {"id": 1000, "title": "Missing", "release_date": "2026-11-01"}]}
                if query[0] == "/movie/999/release_dates":
                    return {"results": []}
                raise rc.BudgetExceeded()
        self.worker.transport = Partial()
        self.worker.run_once(manual=True)  # Igdb yields; next wake starts at movies.
        self.worker.run_once(manual=True)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.worker.status_view()["nextProvider"], "tmdb_tv")

    def test_stop_during_fetch_prevents_all_writes(self):
        before = self.state()
        class Stop:
            def request(inner, provider, query, budget):
                budget.take()
                self.worker.drain()
                return []
        self.worker.transport = Stop()
        self.assertFalse(self.worker.run_once())
        self.assertEqual(self.state(), before)
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM release_calendar_state").fetchone()[0], 0)

    def test_unread_wishlist_survives_cache_expiry(self):
        self.worker.run_once()
        state = self.state()
        document = json.loads(state["document"])
        document["wishlist"] = [{"id": "tmdb:999", "cover": None, "events": [{"id": "unread"}]}]
        with self.get_db() as db:
            db.execute("UPDATE home_upcoming_state SET document=?", (rc.encode(document),))
            db.commit()
        self.moment += timedelta(days=181)
        class Fail:
            def request(self, provider, query, budget):
                budget.take()
                raise rc.ProviderFailure("unavailable")
        self.worker.transport = Fail()
        self.worker.run_once()
        self.assertEqual(json.loads(self.state()["document"])["wishlist"], document["wishlist"])
        with self.get_db() as db:
            self.assertTrue(all(r[0] == "[]" for r in db.execute("SELECT entries_json FROM release_calendar_state")))

    def test_no_database_writes_on_fresh_wake(self):
        self.worker.run_once()
        changes = self.db.total_changes
        self.worker.run_once()
        self.assertEqual(self.db.total_changes, changes)

    def test_missing_movie_detail_maps_to_pc_invalid_response_code(self):
        class Missing:
            def request(self, provider, query, budget):
                budget.take()
                raise rc.ProviderFailure("not_found")
        self.worker.transport = Missing()
        self.worker.run_once()
        self.assertTrue(all(s["errorCode"] == "invalid_response" for s in self.worker.status_view()["sources"]))

    def test_publication_failure_keeps_cache_and_retries_without_refetch(self):
        before = self.state()
        publish = self.worker.publish
        def fail(db, doc, now):
            publish(db, doc, now)  # Publication writes must roll back independently.
            raise ValueError("private payload must not be logged")
        self.worker.publish = fail
        with self.assertLogs(rc.__name__, level="ERROR") as logs:
            self.assertFalse(self.worker.run_once())
        self.assertEqual(logs.output, ["ERROR:release_calendar:ValueError"])
        self.assertEqual(self.state(), before)
        with self.get_db() as db:
            rows = list(db.execute("SELECT * FROM release_calendar_state"))
            self.assertEqual(len(rows), 3)
            self.assertTrue(all(r["fetched_at"] == NOW.isoformat() for r in rows))
            self.assertTrue(all(r["attempted_at"] == NOW.isoformat() for r in rows))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM release_calendar_owner").fetchone()[0], 0)
        self.assertEqual(self.worker.status_view()["stopReason"], "publish_failed")
        self.assertFalse(self.worker.busy)
        requests = list(self.worker.transport.requests)
        self.worker.publish = publish
        self.moment += timedelta(minutes=10)
        self.assertTrue(self.worker.run_once())
        self.assertEqual(self.worker.transport.requests, requests)
        self.assertEqual(self.worker.status_view()["stopReason"], None)

    def test_first_wake_provider_failure_keeps_pc_snapshot(self):
        document = {"wishlist": [], "entries": [{"id": "tmdb:pc"}]}
        with self.get_db() as db:
            db.execute("UPDATE home_upcoming_state SET document=?,digest=?,revision=7",
                       (rc.encode(document), "pc-digest"))
            db.commit()
        before = self.state()
        class Failure:
            def request(self, provider, query, budget):
                budget.take()
                raise rc.ProviderFailure("unavailable")
        self.worker.transport = Failure()
        publish = mock.Mock(wraps=self.worker.publish)
        self.worker.publish = publish
        self.assertFalse(self.worker.run_once())
        publish.assert_not_called()
        self.assertEqual(self.state(), before)
        self.assertEqual(self.worker.status_view()["stopReason"], "incomplete_cache")

    def test_partial_cache_keeps_document_even_if_server_owned(self):
        self.worker.run_once()
        before = self.state()
        with self.get_db() as db:
            db.execute("DELETE FROM release_calendar_state WHERE provider='tmdb_tv'")
            db.commit()
        class Failure:
            def request(self, provider, query, budget):
                budget.take()
                raise rc.ProviderFailure("unavailable")
        self.worker.transport = Failure()
        self.assertFalse(self.worker.run_once())
        self.assertEqual(self.state(), before)

    def test_pc_document_is_not_overwritten_after_successful_fetches(self):
        with self.get_db() as db:
            db.execute("UPDATE home_upcoming_state SET document=?,digest=?,revision=4",
                       (rc.encode({"wishlist": [], "entries": []}), "pc"))
            db.commit()
        before = self.state()
        self.assertFalse(self.worker.run_once())
        self.assertEqual(self.state(), before)
        self.assertEqual(len(self.worker.status_view()["checked"]), 3)

    def test_kst_day_boundary_changes_range_without_refetch(self):
        # UTC 14:59 is still October 9 in Korea; UTC 15:00 is October 10.
        self.moment = NOW.replace(hour=14, minute=59)
        self.assertTrue(self.worker.run_once())
        first = json.loads(self.state()["document"])
        self.assertEqual((first["rangeStart"], first["rangeEnd"]), ("2026-10-02", "2027-04-10"))
        requests = list(self.worker.transport.requests)
        self.moment += timedelta(minutes=1)
        self.assertTrue(self.worker.run_once())
        after = json.loads(self.state()["document"])
        self.assertEqual((after["rangeStart"], after["rangeEnd"]), ("2026-10-03", "2027-04-11"))
        self.assertEqual(self.worker.transport.requests, requests)


if __name__ == "__main__":
    unittest.main()
