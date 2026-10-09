"""Offline wishlist contract: stdlib, in-memory SQLite, fixed clock, fake providers."""
import copy
import ast
import json
import math
import os
import sqlite3
import threading
import unittest
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import release_calendar as rc
import release_wishlist as rw

NOW = datetime(2026, 10, 9, tzinfo=timezone.utc)
FIXTURE = Path(__file__).resolve().parents[3] / "tests/fixtures/release_wishlist.json"
KEYS = {rw.ENV: "1", rc.ENV: "0", "LAKOMICS_TMDB_API_KEY": "fixture",
        "LAKOMICS_IGDB_CLIENT_ID": "fixture", "LAKOMICS_IGDB_CLIENT_SECRET": "fixture"}
HOME_DDL = """
CREATE TABLE home_upcoming_state(singleton INTEGER PRIMARY KEY,revision INTEGER,published_at TEXT,
 digest TEXT,document TEXT,intent_sequence INTEGER,acknowledged_through INTEGER,pruned_through INTEGER);
INSERT INTO home_upcoming_state VALUES(1,0,NULL,NULL,NULL,0,0,0);
CREATE TABLE home_upcoming_ids(item_id TEXT PRIMARY KEY);
CREATE TABLE home_upcoming_intents(sequence INTEGER PRIMARY KEY,operation_id TEXT,action TEXT,item_id TEXT,
 event_ids TEXT,created_at TEXT,title_json TEXT);
CREATE TABLE home_upcoming_receipts(operation_id TEXT PRIMARY KEY,payload_digest TEXT,result_json TEXT,created_at TEXT);
"""


def item(id_="igdb:1", **changes):
    kind, provider, external = rw.identity(id_)
    return {"id": id_, "kind": kind, "provider": provider, "external_id": external, "title": "Game",
            "original_title": None, "cover": "co1" if kind == "game" else "/poster.jpg",
            "platforms_json": '["PC"]' if kind == "game" else "[]", "tracked_platforms_json": None,
            "source": "calendar", "added_at": NOW.isoformat(), "muted": 0, "last_checked_at": NOW.isoformat(),
            "next_check_at": NOW.isoformat(), "released_at": None, **changes}


def release(id_="igdb:1", value="2026-10-20", precision="exact", **changes):
    return {"item_id": id_, "region": "worldwide", "platform": "PC", "date": value,
            "precision": precision, "checked_at": NOW.isoformat(), **changes}


def event(id_="read-event", item_id="igdb:1", **changes):
    return {"id": id_, "item_id": item_id, "event_kind": "date_changed", "previous_value": "tbd",
            "current_value": "2026-10-20", "detected_at": NOW.isoformat(), "read_at": None, **changes}


def seed_body(db, items=None, dates=None, events=None, cursor=0, **changes):
    state = db.execute("SELECT * FROM home_upcoming_state").fetchone()
    return {"version": 1, "operationId": str(uuid.uuid4()), "expectedRevision": state["revision"],
            "expectedDigest": state["digest"], "libraryId": "fixture-library", "endpoint": "https://fixture.invalid",
            "intentCursor": cursor, "items": [item()] if items is None else items,
            "dates": [release()] if dates is None else dates, "events": events or [], **changes}


class Transport:
    def __init__(self, responses=()):
        self.responses, self.requests = copy.deepcopy(list(responses)), []

    def request(self, provider, query, budget):
        budget.take()
        self.requests.append((provider, query))
        if not self.responses:
            raise AssertionError("unexpected provider request")
        response = self.responses.pop(0)
        if "provider" in response:
            if response["provider"] != provider:
                raise AssertionError("wrong upstream")
            if provider == "igdb" and response.get("ids"):
                if f"where id = ({','.join(map(str, response['ids']))})" not in query:
                    raise AssertionError("wrong IGDB ID query")
            if provider != "igdb" and (query[0] != response["path"] or query[1] != response["params"]):
                raise AssertionError("wrong TMDB detail query")
        if "error" in response:
            raise rc.ProviderFailure(response["error"], response.get("retryAfter"))
        return response["response"]


class Core(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.executescript(HOME_DDL)
        rw.startup_db(self.db)
        rc.startup_db(self.db)
        self.db.commit()
        self.env = mock.patch.dict(os.environ, KEYS)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(self.db.close)

    @contextmanager
    def get_db(self):
        try:
            yield self.db
        except Exception:
            self.db.rollback()
            raise

    def seed(self, **kwargs):
        body = seed_body(self.db, **kwargs)
        return rw.seed(self.db, body, NOW)

    def state(self):
        return dict(self.db.execute("SELECT * FROM home_upcoming_state").fetchone())

    def private(self):
        return rw.export_private(self.db)

    def append(self, action, id_="igdb:1", title=None, event_ids=None, sequence=None):
        seq = sequence or self.state()["intent_sequence"] + 1
        self.db.execute("INSERT INTO home_upcoming_intents VALUES(?,?,?,?,?,?,?)",
                        (seq, str(uuid.uuid4()), action, id_, rc.encode(event_ids) if event_ids else None,
                         NOW.isoformat(), rc.encode(title) if title is not None else None))
        self.db.execute("UPDATE home_upcoming_state SET intent_sequence=?,revision=revision+1", (seq,))
        self.db.commit()
        return seq

    def stored(self, id_="igdb:1"):
        row = self.db.execute("SELECT * FROM release_wishlist_items WHERE id=?", (id_,)).fetchone()
        return dict(row) if row else None

    def check(self, fetched, id_="igdb:1", now=NOW, expected=None, **kwargs):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            changed = rw.apply_check(self.db, expected or self.stored(id_), fetched, now, **kwargs)
            self.db.commit()
            return changed
        except Exception:
            self.db.rollback()
            raise

    def test_startup_migrates_without_touching_existing_home_rows(self):
        before = self.state()
        rw.startup_db(self.db)
        self.assertEqual(before, self.state())
        self.assertFalse(rw.owned(self.db))
        self.assertEqual(self.private()["owner"]["mode"], "awaitingSeed")

    def test_off_is_inert_before_and_after_seed(self):
        with mock.patch.dict(os.environ, {rw.ENV: "0"}):
            before = self.private(), self.state()
            worker = rw.Worker(self.get_db, Transport())
            self.assertFalse(worker.run_once())
            self.assertEqual(worker.apply_pending(), 0)
            with self.assertRaises(rw.Rejected):
                rw.seed(self.db, seed_body(self.db), NOW)
            self.assertEqual((self.private(), self.state()), before)
            self.assertEqual(worker.transport.requests, [])
            self.assertEqual(rw.features(), [])
        self.seed()
        self.append("remove")
        with mock.patch.dict(os.environ, {rw.ENV: "0"}):
            before = self.private(), self.state()
            self.assertEqual(rw.apply_intents(self.db, NOW), 0)
            self.assertTrue(rw.owned(self.db))
            self.assertEqual((self.private(), self.state()), before)

    def test_lossless_seed_read_history_over_50_dates_and_null_empty_scope(self):
        events = [event(f"ev-{n:03d}", read_at=NOW.isoformat() if n < 5 else None) for n in range(70)]
        items = [item(), item("igdb:2", tracked_platforms_json="[]")]
        dates = [release(), release(region="korea", value="2026-11-01"), release("igdb:2", platform="Switch")]
        self.seed(items=items, dates=dates, events=events)
        exported = self.private()
        self.assertEqual(len(exported["events"]), 70)
        self.assertEqual(len(exported["dates"]), 3)
        for wanted in items:
            actual = self.stored(wanted["id"])
            self.assertEqual({k: actual[k] for k in rw.ITEM_FIELDS}, wanted)
        public = rw.projection(self.db)
        first = next(r for r in public if r["id"] == "igdb:1")
        self.assertEqual([e["id"] for e in first["events"]], [f"ev-{n:03d}" for n in range(20, 70)])
        self.assertEqual(first["date"], "2026-11-01")
        self.assertEqual({r["id"]: r for r in exported["events"]}, {r["id"]: r for r in events})

    def test_empty_seed_is_explicit_ownership(self):
        self.seed(items=[], dates=[])
        self.assertTrue(rw.owned(self.db))
        self.assertEqual(rw.projection(self.db), [])

    def test_seed_cas_cursor_replay_and_second_seed(self):
        body = seed_body(self.db)
        for bad in ({"expectedRevision": 9}, {"expectedDigest": "0" * 64}, {"intentCursor": 1}):
            with self.assertRaises(rw.Rejected) as caught:
                rw.seed(self.db, {**body, **bad}, NOW)
            self.assertEqual(caught.exception.status, 409)
            self.assertFalse(rw.owned(self.db))
        result = rw.seed(self.db, body, NOW)
        before = self.private(), self.state()
        self.assertEqual(rw.seed(self.db, body, NOW + timedelta(hours=1)), result)
        self.assertEqual((self.private(), self.state()), before)
        with self.assertRaises(rw.Rejected) as caught:
            rw.seed(self.db, {**body, "libraryId": "changed"}, NOW)
        self.assertEqual(caught.exception.code, "operationConflict")
        with self.assertRaises(rw.Rejected) as caught:
            rw.seed(self.db, seed_body(self.db), NOW)
        self.assertEqual(caught.exception.code, "serverWishlistOwned")

    def test_seed_rollback_on_projection_and_cover_failure(self):
        before = self.private(), self.state()
        def broken(*args):
            raise ValueError("fixture publication failure")
        for kwargs in ({"validate": broken}, {"replace_covers": broken}):
            with self.assertRaises(ValueError):
                rw.seed(self.db, seed_body(self.db), NOW, **kwargs)
            self.assertEqual((self.private(), self.state()), before)

    def test_seed_rejects_invalid_rows_caps_and_does_not_partial_import(self):
        body = seed_body(self.db)
        cases = [{"items": [item("igdb:1", external_id="2")]}, {"items": [item(), item()]},
                 {"dates": [release("igdb:9")]}, {"dates": [release(), release()]},
                 {"dates": [release(value="2026-02-30")]}, {"dates": [release(value=None)]},
                 {"events": [event(), event()]}, {"events": [event(item_id="igdb:9")]},
                 {"items": [item(tracked_platforms_json='"bad"')]}, {"items": [item(muted=2)]},
                 {"items": [item(added_at="2026-10-09T00:00:00")]}, {"intentCursor": True}, {"version": True}]
        for bad in cases:
            with self.subTest(bad=bad):
                with self.assertRaises(rw.Rejected):
                    rw.seed(self.db, {**body, **bad}, NOW)
                self.assertFalse(rw.owned(self.db))
                self.assertEqual(self.private()["items"], [])
        with mock.patch.object(rw, "MAX_SEED_BYTES", 10):
            with self.assertRaises(rw.Rejected) as caught:
                rw.seed(self.db, body, NOW)
            self.assertEqual(caught.exception.status, 413)

    def test_cursor_lower_than_ack_is_rejected_and_seed_suffix_is_ordered(self):
        self.append("mute")
        self.db.execute("UPDATE home_upcoming_state SET acknowledged_through=1")
        self.db.commit()
        with self.assertRaises(rw.Rejected):
            self.seed(cursor=0)
        self.append("unmute")
        self.append("mute")
        self.seed(cursor=1, items=[item(muted=1)])
        self.assertEqual(self.state()["acknowledged_through"], 3)
        self.assertEqual(self.private()["owner"]["applied_through"], 3)
        self.assertTrue(self.stored()["muted"])

    def test_titleless_add_blocks_prefix_and_gap_is_visible(self):
        self.seed()
        self.append("mute")
        self.append("add", "igdb:2")
        self.append("remove")
        self.assertEqual(rw.apply_intents(self.db, NOW), 1)
        self.assertEqual(self.state()["acknowledged_through"], 1)
        status = json.loads(self.private()["status"]["status_json"])
        self.assertEqual((status["blockedSequence"], status["blockedError"]), (2, "wishlistTitleMissing"))
        self.assertTrue(self.stored()["muted"])
        self.db.execute("DELETE FROM home_upcoming_intents WHERE sequence=2")
        self.db.commit()
        rw.apply_intents(self.db, NOW)
        status = json.loads(self.private()["status"]["status_json"])
        self.assertEqual(status["blockedError"], "wishlistIntentGap")

    def test_captured_add_freezes_port_without_events_and_duplicate_add_is_noop(self):
        self.seed(items=[], dates=[])
        title = {"id": "igdb:2", "kind": "game", "title": "Port", "originalTitle": None, "cover": None,
                 "date": "2026-10-20", "precision": "exact", "region": None, "platforms": ["Switch 2"], "port": True}
        self.append("add", "igdb:2", title=title)
        rw.apply_intents(self.db, NOW)
        first = self.stored("igdb:2")
        self.assertEqual(json.loads(first["tracked_platforms_json"]), ["Switch 2"])
        self.assertEqual(self.private()["events"], [])
        self.assertEqual(self.private()["dates"][0]["region"], "")
        self.append("add", "igdb:2", title={**title, "title": "Changed"})
        rw.apply_intents(self.db, NOW)
        self.assertEqual(self.stored("igdb:2"), first)

    def test_legacy_add_falls_back_to_current_calendar_without_provider(self):
        self.seed(items=[], dates=[])
        document = json.loads(self.state()["document"])
        document["entries"] = [{"id": "igdb:2", "kind": "game", "title": "Legacy", "date": None,
                                "precision": "tbd", "platforms": [], "cover": None}]
        self.db.execute("UPDATE home_upcoming_state SET document=?", (rc.encode(document),))
        self.db.commit()
        self.append("add", "igdb:2")
        rw.apply_intents(self.db, NOW)
        self.assertEqual(self.stored("igdb:2")["title"], "Legacy")

    def test_exact_ack_belongs_to_item_and_preserves_read_history(self):
        self.seed(items=[item(), item("igdb:2")], events=[event("own"), event("other", "igdb:2"),
                                                       event("read", read_at="2026-10-01T00:00:00Z")])
        self.append("acknowledge", event_ids=["own", "other", "unknown", "read"])
        rw.apply_intents(self.db, NOW)
        events = {e["id"]: e for e in self.private()["events"]}
        self.assertEqual(events["own"]["read_at"], NOW.isoformat())
        self.assertIsNone(events["other"]["read_at"])
        self.assertEqual(events["read"]["read_at"], "2026-10-01T00:00:00Z")

    def test_projection_failure_rolls_back_domain_and_ack(self):
        self.seed()
        self.append("mute")
        before = self.stored(), self.state()
        def broken(doc):
            raise ValueError("fixture")
        self.assertEqual(rw.apply_intents(self.db, NOW, validate=broken), 0)
        self.assertEqual((self.stored(), self.state()), before)

    def test_unknown_remove_mute_unmute_ack_are_safe_noops(self):
        self.seed()
        for action in ("remove", "mute", "unmute", "acknowledge"):
            self.append(action, "igdb:99", event_ids=["ev"] if action == "acknowledge" else None)
        self.assertEqual(rw.apply_intents(self.db, NOW), 4)
        self.assertEqual(self.state()["acknowledged_through"], 4)
        self.assertIsNotNone(self.stored())

    def test_bounded_200_intent_prefix_and_restart_continuation(self):
        self.seed()
        for n in range(205):
            self.append("mute" if n % 2 == 0 else "unmute")
        self.assertEqual(rw.apply_intents(self.db, NOW), 200)
        self.assertEqual(self.state()["acknowledged_through"], 200)
        restarted = rw.Worker(self.get_db)
        self.assertEqual(restarted.apply_pending(), 5)
        self.assertEqual(self.state()["acknowledged_through"], 205)

    def test_membership_readd_mute_ack_and_double_result_fence(self):
        self.seed(events=[event()])
        expected = self.stored()
        self.append("remove")
        self.append("add", title={"id": "igdb:1", "kind": "game", "title": "Readded", "date": "2026-10-21",
                                  "precision": "exact", "platforms": ["PC"]})
        rw.apply_intents(self.db, NOW)
        self.assertGreater(self.stored()["revision"], expected["revision"])
        self.assertFalse(self.check(None, expected=expected))
        self.assertEqual(self.stored()["title"], "Readded")
        expected = self.stored()
        self.assertFalse(self.check(None, expected=expected))
        self.assertFalse(self.check(None, expected=expected))
        before = self.stored()
        self.append("mute")
        rw.apply_intents(self.db, NOW)
        self.assertFalse(self.check(None, expected=before))

    def test_unchanged_check_keeps_public_bytes_revision_calendar_fence(self):
        self.seed()
        state = self.state()
        self.db.execute("INSERT INTO release_calendar_owner VALUES(1,?)", (state["digest"],))
        self.db.commit()
        self.assertFalse(self.check(None))
        self.assertEqual(self.state(), state)
        self.assertEqual(self.stored()["next_check_at"], (NOW + timedelta(hours=6)).isoformat())
        self.assertEqual(self.db.execute("SELECT digest FROM release_calendar_owner").fetchone()[0], state["digest"])

    def test_calendar_and_wishlist_publications_preserve_each_other_and_cursor(self):
        self.seed()
        self.db.execute("INSERT INTO release_calendar_owner VALUES(1,?)", (self.state()["digest"],))
        self.db.commit()
        self.append("mute")
        rw.apply_intents(self.db, NOW)
        state = self.state()
        self.assertEqual(self.db.execute("SELECT digest FROM release_calendar_owner").fetchone()[0], state["digest"])
        wishlist = json.loads(state["document"])["wishlist"]
        document = {"rangeStart": "2026-10-02", "rangeEnd": "2027-04-10", "entries": [],
                    "sources": [{"provider": "igdb", "fetchedAt": NOW.isoformat(), "errorCode": None}]}
        self.db.execute("BEGIN IMMEDIATE")
        self.assertTrue(rc.store_calendar(self.db, document, NOW, lambda d: d, lambda *args: None))
        self.db.commit()
        self.assertEqual(json.loads(self.state()["document"])["wishlist"], wishlist)
        self.assertEqual(self.state()["acknowledged_through"], 1)
        self.append("unmute")
        rw.apply_intents(self.db, NOW)
        self.assertEqual(json.loads(self.state()["document"])["sources"], document["sources"])
        self.assertEqual(self.db.execute("SELECT digest FROM release_calendar_owner").fetchone()[0], self.state()["digest"])

    def test_missing_and_empty_scope_keep_baseline_but_detect_release_day(self):
        for scope in (None, "[]", '["Switch"]'):
            with self.subTest(scope=scope):
                self.db.execute("DELETE FROM release_wishlist_items")
                self.db.execute("UPDATE release_wishlist_owner SET mode='awaitingSeed',seed_operation_id=NULL")
                self.db.commit()
                self.seed(items=[item(tracked_platforms_json=scope)], dates=[release(value="2026-10-09")])
                fetched = rc.title_record("igdb:1", "game", "Ignored" if scope is not None else "Game", None, None,
                                          ["PC"], [{"region": "worldwide", "platform": "PC", "date": "2026-12-01", "precision": "exact"}], 0.0)
                self.assertTrue(self.check(None if scope is None else fetched))
                self.assertEqual(self.stored()["title"], "Game")
                self.assertIsNotNone(self.stored()["released_at"])
                self.assertEqual([e["event_kind"] for e in self.private()["events"]], ["released"])

    def test_latch_survives_postponement_and_real_date_flip_events_are_distinct(self):
        self.seed(dates=[release(value="2026-10-09")])
        self.check(None)
        latch = self.stored()["released_at"]
        for day in ("2026-12-01", "2026-10-09", "2026-12-01"):
            self.check(rc.title_record("igdb:1", "game", "Game", None, None, ["PC"],
                                      [{"region": "worldwide", "platform": "PC", "date": day, "precision": "exact"}], 0.0))
        events = self.private()["events"]
        self.assertEqual(len(events), 4)
        self.assertEqual(sum(e["event_kind"] == "released" for e in events), 1)
        self.assertEqual(len(set(e["id"] for e in events)), 4)
        for e in events:
            self.assertEqual(uuid.UUID(e["id"]).version, 4)
        self.assertEqual(self.stored()["released_at"], latch)

    def test_fixture_events_schedule_and_literal_public_bytes(self):
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        for case in data["cases"]:
            with self.subTest(case=case["name"]):
                db = sqlite3.connect(":memory:")
                db.row_factory = sqlite3.Row
                db.executescript(HOME_DDL)
                rw.startup_db(db)
                db.commit()
                body = seed_body(db, items=case["baseline"]["items"], dates=case["baseline"]["dates"], events=case["baseline"]["events"])
                rw.seed(db, body, NOW)
                transport = Transport(case["responses"])
                stored = dict(db.execute("SELECT * FROM release_wishlist_items").fetchone())
                budget = rw.Budget()
                fetched = rw.fetch_games(transport, [int(stored["external_id"])], budget).get(stored["id"]) \
                    if stored["provider"] == "igdb" else rw.fetch_title(transport, stored, budget)
                db.execute("BEGIN IMMEDIATE")
                with mock.patch.object(rw.uuid, "uuid4", side_effect=[uuid.UUID(v) for v in case["eventIds"]]):
                    rw.apply_check(db, stored, fetched, NOW)
                db.commit()
                events = [dict(r) for r in db.execute("SELECT * FROM release_wishlist_events ORDER BY detected_at,id")]
                self.assertEqual(events, case["expectedEvents"])
                self.assertEqual(db.execute("SELECT next_check_at FROM release_wishlist_items").fetchone()[0], case["expectedNextCheckAt"])
                self.assertEqual(rc.encode(rw.projection(db)), case["expectedWishlistBytes"])
                self.assertFalse(transport.responses)
                db.close()

    def test_worker_backoff_other_upstream_due_limits_and_rotation(self):
        self.seed(items=[item(), item("tmdb:2")], dates=[release(), release("tmdb:2", platform="")])
        transport = Transport([{"error": "rate_limited", "retryAfter": 90000},
                               {"response": {"id": 2, "title": "Movie", "release_date": "2026-11-01"}}])
        worker = rw.Worker(self.get_db, transport, now=lambda: NOW)
        worker.run_once()
        lanes = {r["upstream"]: r for r in self.private()["providers"]}
        self.assertEqual(lanes["igdb"]["retry_at"], (NOW + timedelta(days=1)).isoformat())
        self.assertIsNone(lanes["tmdb"]["error_code"])
        self.assertEqual(self.stored()["next_check_at"], NOW.isoformat())
        self.assertEqual(self.stored("tmdb:2")["title"], "Movie")
        worker.run_once()
        self.assertEqual(len(transport.requests), 2)

    def test_worker_unavailable_invalid_auth_timeout_backoff(self):
        self.seed()
        for code in ("timed_out", "unavailable", "invalid_response", "invalid_credential"):
            with self.subTest(code=code):
                self.db.execute("DELETE FROM release_wishlist_provider_state")
                self.db.commit()
                worker = rw.Worker(self.get_db, Transport([{"error": code}]), now=lambda: NOW)
                worker.run_once()
                lane = self.private()["providers"][0]
                self.assertEqual(lane["retry_at"], (NOW + timedelta(hours=1)).isoformat())
                self.assertEqual(self.stored()["next_check_at"], NOW.isoformat())

    def test_worker_title_limit_igdb_batches_and_muted_stopped_skipped(self):
        rows = [item(f"igdb:{n}", muted=int(n == 45), next_check_at=None if n == 44 else NOW.isoformat()) for n in range(1, 46)]
        self.seed(items=rows, dates=[])
        transport = Transport([{"response": []} for _ in range(4)])
        worker = rw.Worker(self.get_db, transport, now=lambda: NOW)
        worker.run_once()
        self.assertEqual(len(transport.requests), 4)
        for _, query in transport.requests:
            self.assertLessEqual(len(query.split("where id = (")[1].split(")")[0].split(",")), 10)
        status = worker.status_view()
        self.assertEqual((status["checked"], status["remaining"]), (40, 3))
        self.assertIsNone(self.stored("igdb:44")["next_check_at"])

    def test_worker_budget_yield_does_not_move_schedule_or_set_backoff(self):
        self.seed()
        class Busy:
            def request(self, *args):
                raise rc.BudgetExceeded()
        worker = rw.Worker(self.get_db, Busy(), now=lambda: NOW)
        worker.run_once()
        self.assertEqual(self.stored()["next_check_at"], NOW.isoformat())
        self.assertEqual(self.private()["providers"], [])
        self.assertEqual(worker.status_view()["stopReason"], "budget")

    def test_publication_retry_retains_result_and_does_not_refetch(self):
        self.seed()
        title = {"id": 1, "name": "Changed", "release_dates": []}
        transport = Transport([{"response": [title]}])
        worker = rw.Worker(self.get_db, transport, now=lambda: NOW)
        worker.validate = mock.Mock(side_effect=ValueError("fixture"))
        worker.run_once()
        self.assertEqual(self.stored()["title"], "Game")
        self.assertEqual(worker.status_view()["publicationError"], "wishlistPublicationFailed")
        worker.validate = lambda d: d
        worker.run_once()
        self.assertEqual(self.stored()["title"], "Changed")
        self.assertEqual(len(transport.requests), 1)
        self.assertIsNone(worker.status_view()["publicationError"])

    def test_remove_and_ack_do_not_depend_on_provider_credentials(self):
        self.seed(events=[event()])
        self.append("acknowledge", event_ids=["read-event"])
        self.append("remove")
        worker = rw.Worker(self.get_db, Transport(), now=lambda: NOW)
        with mock.patch.dict(os.environ, {"LAKOMICS_TMDB_API_KEY": ""}):
            worker.run_once()
        self.assertEqual(self.state()["acknowledged_through"], 2)
        self.assertEqual(self.private()["items"], [])
        self.assertEqual(worker.transport.requests, [])

    def test_applier_records_status_after_shared_cover_validator_rolls_back(self):
        self.seed()
        self.append("mute")
        before = self.stored(), self.state()
        def rolled_back(db, covers):
            db.rollback()
            raise ValueError("fixture cover error")
        worker = rw.Worker(self.get_db, replace_covers=rolled_back, now=lambda: NOW)
        self.assertEqual(worker.apply_pending(), 0)
        self.assertEqual((self.stored(), self.state()), before)
        self.assertEqual(worker.status_view()["blockedError"], "wishlistPublicationFailed")

    def test_two_second_intent_prefix_requests_continuation(self):
        self.seed()
        for _ in range(3):
            self.append("mute")
        clock = iter([0.0, 0.5, 2.1])
        worker = rw.Worker(self.get_db, now=lambda: NOW, clock=lambda: next(clock))
        worker.scheduler = mock.Mock()
        self.assertEqual(worker.apply_pending(), 1)
        self.assertEqual(self.state()["acknowledged_through"], 1)
        worker.scheduler.wake_event.set.assert_called_once()

    def test_unmute_keeps_stopped_schedule_and_ack_revision_discards_fetch(self):
        self.seed(items=[item(muted=1, next_check_at=None)], events=[event()])
        self.append("unmute")
        rw.apply_intents(self.db, NOW)
        expected = self.stored()
        self.assertIsNone(expected["next_check_at"])
        self.append("acknowledge", event_ids=["read-event"])
        rw.apply_intents(self.db, NOW)
        before = self.state(), self.stored()
        self.assertFalse(self.check(None, expected=expected))
        self.assertEqual((self.state(), self.stored()), before)

    def test_feature_only_owned_and_on_without_worker_health_or_keys(self):
        worker = rw.Worker(self.get_db, now=lambda: NOW)
        with mock.patch.object(rw, "_current", worker):
            self.assertEqual(rw.features(), [])
            self.seed()
            worker.drain()
            with mock.patch.dict(os.environ, {"LAKOMICS_TMDB_API_KEY": ""}):
                self.assertEqual(rw.features(), [rw.FEATURE])
            with mock.patch.dict(os.environ, {rw.ENV: "0"}):
                self.assertEqual(rw.features(), [])

    def test_provider_rotation_prevents_one_lane_from_taking_every_40_title_wake(self):
        rows = [item(f"igdb:{n}") for n in range(1, 42)] + [item("tmdb:2")]
        self.seed(items=rows, dates=[])
        transport = Transport([{"response": []} for _ in range(4)])
        worker = rw.Worker(self.get_db, transport, now=lambda: NOW)
        worker.run_once()
        self.assertEqual(worker.status_view()["nextLane"], "tmdb")
        transport.responses = [{"response": {"id": 2, "title": "Movie"}}, {"response": []}]
        worker.run_once()
        self.assertEqual(transport.requests[4][0], "tmdb")
        self.assertEqual(self.stored("tmdb:2")["title"], "Movie")

    def test_retained_results_are_bounded_before_schedule_changes(self):
        self.seed()
        worker = rw.Worker(self.get_db, Transport([{"response": [{"id": 1, "name": "x" * 1000}]}]), now=lambda: NOW)
        with mock.patch.object(rw, "MAX_RESULT_BYTES", 100):
            worker.run_once()
        self.assertEqual(self.stored()["title"], "Game")
        self.assertEqual(self.stored()["next_check_at"], NOW.isoformat())
        self.assertEqual(worker.status_view()["stopReason"], "invalid_response")

    def test_add_capacity_counts_pending_removes_and_rejects_before_log_append(self):
        self.seed()
        with mock.patch.object(rw, "MAX_ITEMS", 1):
            with self.assertRaises(rw.Rejected) as caught:
                rw.validate_add_capacity(self.db, "igdb:2", None, NOW)
            self.assertEqual(caught.exception.code, "wishlistItemLimit")
            self.assertEqual(self.state()["intent_sequence"], 0)
            rw.validate_add_capacity(self.db, "igdb:1", None, NOW)
            self.append("remove")
            rw.validate_add_capacity(self.db, "igdb:2", None, NOW)
        with mock.patch.object(rc, "MAX_SNAPSHOT_BYTES", 10):
            with self.assertRaises(rw.Rejected) as caught:
                rw.validate_add_capacity(self.db, "igdb:2", None, NOW)
            self.assertEqual(caught.exception.status, 413)


class Parity(unittest.TestCase):
    def test_shared_fixture_schedule_and_latched_transitions(self):
        data = json.loads(FIXTURE.read_text(encoding="utf-8"))
        for case in data["scheduleCases"]:
            value = (date(2026, 10, 9) + timedelta(days=case["untilDays"])).isoformat() if case["untilDays"] is not None else None
            expected = (NOW + timedelta(hours=case["hours"])).isoformat() if case["hours"] is not None else None
            self.assertEqual(rw.next_check(NOW, value, case["precision"]), expected)
        for case in data["transitionCases"]:
            events = rw.detect_changes(tuple(case["previous"]), tuple(case["current"]), case["latched"], date(2026, 10, 9))
            self.assertEqual([list(e) for e in events], case["events"])

    def test_schedule_boundaries_fixed_kst_and_coarse_never_stop(self):
        cases = [("2026-10-24", "exact", 24), ("2026-10-23", "exact", 6),
                 ("2026-09-09", "exact", 6), ("2026-09-08", "exact", None),
                 ("2020-01-01", "year", 24), ("2020-01-01", "quarter", 24),
                 ("2020-01-01", "month", 24), (None, "tbd", 24)]
        for value, precision, hours in cases:
            self.assertEqual(rw.next_check(NOW, value, precision), (NOW + timedelta(hours=hours)).isoformat() if hours else None)
        self.assertEqual(rw.today(datetime(2026, 10, 8, 15, tzinfo=timezone.utc)), date(2026, 10, 9))

    def test_precision_narrowing_inside_outside_period_tbd_and_latch(self):
        for previous, current, kind in [((None, "tbd"), ("2026-12-01", "month"), "date_set"),
                                        (("2026-10-01", "month"), ("2026-10-20", "exact"), "date_set"),
                                        (("2026-10-01", "quarter"), ("2026-12-31", "exact"), "date_set"),
                                        (("2026-10-01", "month"), ("2026-11-01", "exact"), "date_changed"),
                                        (("2026-10-01", "exact"), (None, "tbd"), "date_changed")]:
            events = rw.detect_changes(previous, current, True, date(2026, 10, 9))
            self.assertEqual(events[0][0], kind)
        self.assertEqual(rw.detect_changes((None, "tbd"), (None, "tbd"), False, date(2026, 10, 9)), [])
        self.assertEqual(rw.period_token(None, "tbd"), "tbd")

    def test_provider_missing_movie_404_season_and_invalid_identity(self):
        self.assertIsNone(rw.fetch_title(Transport([{"error": "not_found"}]), item("tmdb:2"), rw.Budget()))
        self.assertIsNone(rw.fetch_title(Transport([{"response": {"id": 2, "name": "Anime", "seasons": []}}]), item("tmdb:tv:2:s1"), rw.Budget()))
        for raw in ({"id": 9, "title": "Wrong"}, [], {"id": 2}):
            with self.assertRaises(rc.ProviderFailure):
                rw.fetch_title(Transport([{"response": raw}]), item("tmdb:2"), rw.Budget())
        for id_ in ("igdb:0", "igdb:01", "tmdb:tv:2:s0", "igdb:tv:2:s1", "tmdb:abc", "igdb:9223372036854775808"):
            with self.assertRaises(rw.Rejected):
                rw.identity(id_)

    def test_igdb_major_fallback_exclusion_and_requested_ids(self):
        game = {"id": 1, "name": "Game", "release_dates": [
            {"platform": {"id": 99, "name": "Other"}, "y": 2026, "category": 2, "region": 9},
            {"platform": {"id": 6}, "y": 2027, "category": 2, "region": 8}]}
        title = rw.igdb_title(game)
        self.assertEqual(title["platforms"], ["PC"])
        self.assertEqual(title["date"], "2027-01-01")
        game["release_dates"].pop()
        self.assertEqual(rw.igdb_title(game)["platforms"], ["Other"])
        self.assertIsNone(rw.igdb_title({**game, "game_type": {"type": "dlc_addon"}}))
        for raw in ([{**game, "id": 9}], [game, game], {}, [{}]):
            with self.assertRaises(rc.ProviderFailure):
                rw.fetch_games(Transport([{"response": raw}]), [1], rw.Budget())

    def test_budgets_queries_actual_outbound_and_bytes(self):
        clock = [0]
        budget = rw.Budget(clock=lambda: clock[0])
        for _ in range(40):
            budget.take()
        with self.assertRaises(rc.BudgetExceeded):
            budget.take()
        for _ in range(48):
            budget.outbound()
        with self.assertRaises(rc.BudgetExceeded):
            budget.outbound()
        budget = rw.Budget(clock=lambda: clock[0])
        budget.consume(16 * 1024 * 1024)
        with self.assertRaises(rc.BudgetExceeded):
            budget.outbound()
        budget = rw.Budget(clock=lambda: clock[0])
        clock[0] = 90
        with self.assertRaises(rc.BudgetExceeded):
            budget.take()
        stop = threading.Event()
        stop.set()
        with self.assertRaises(rc.BudgetExceeded):
            rw.Budget(stop=stop).take()

    def test_shared_daemon_runs_calendar_then_wishlist_sequentially(self):
        calendar = rc.Worker(lambda: None)
        order = []
        wishlist = mock.Mock()
        def calendar_pass(manual):
            order.append("calendar")
        def wishlist_pass():
            order.append("wishlist")
            calendar.stop_event.set()
        calendar.run_once = calendar_pass
        wishlist.run_once.side_effect = wishlist_pass
        calendar.wishlist_worker = wishlist
        calendar.wake_event = mock.Mock()
        calendar.loop()
        self.assertEqual(order, ["calendar", "wishlist"])
        self.assertEqual(calendar.wake_event.wait.call_args_list[0].args, (30,))
        with mock.patch.dict(os.environ, {rc.ENV: "0", rw.ENV: "0"}), mock.patch.object(rc.threading, "Thread") as thread:
            calendar.start()
            thread.assert_not_called()


class RelayCore(unittest.TestCase):
    """Execute the actual Relay class with stdlib globals, without API imports.

    The HTTP route modules require unavailable packages on Windows. AST extraction
    leaves method bodies unchanged and allows exercising their locking/accounting
    against a fake outbound reader. Full imports/routes still need the WSL suite.
    """
    def setUp(self):
        from contextlib import contextmanager
        from urllib.parse import urlencode
        path = Path(rw.__file__).with_name("work_providers.py")
        tree = ast.parse(path.read_text(encoding="utf-8"))
        selected = [n for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef))
                    and n.name in ("Relay", "UpstreamStatus", "finite_json_float")]
        self.clock, self.responses, self.calls = [100.0], [], []
        def fail(status, code, message):
            raise rw.Rejected(code, status)
        def outbound(url, **kwargs):
            self.calls.append((url, kwargs))
            response = self.responses.pop(0)
            if isinstance(response, Exception):
                raise response
            return rc.encode(response).encode(), "application/json"
        self.timer = SimpleNamespace(monotonic=lambda: self.clock[0], sleep=lambda s: self.clock.__setitem__(0, self.clock[0] + s))
        self.namespace = {"threading": threading, "contextmanager": contextmanager, "time": self.timer,
                          "json": json, "math": math, "re": __import__("re"), "urlencode": urlencode,
                          "fail": fail, "outbound": outbound, "credential": lambda name: "fixture",
                          "require_keys": lambda provider: None, "status_error": lambda s: fail(502, "fixtureStatus", ""),
                          "ValidationError": ValueError, "MAX_JSON_BYTES": 512 * 1024,
                          "MAX_RAW_RESPONSE_BYTES": 8 * 1024 * 1024, "REQUEST_SECONDS": 25,
                          "TMDB_KEY_ENV": "tmdb", "IGDB_ID_ENV": "id", "IGDB_SECRET_ENV": "secret",
                          "TOKEN_URL": "https://fixture.invalid/token", "GAMES_URL": "https://fixture.invalid/games",
                          "TMDB_ORIGIN": "https://fixture.invalid"}
        exec(compile(ast.Module(body=selected, type_ignores=[]), str(path), "exec"), self.namespace)
        self.relay = self.namespace["Relay"]()

    def test_pacing_yields_existing_provider_lock_and_interactive_work(self):
        self.responses = [{}, {}]
        self.relay.json_request("tmdb", "fixture", 125)
        interactive = []
        def sleep(seconds):
            self.assertFalse(self.relay.locks["tmdb"].locked())
            self.relay.paced("tmdb", lambda deadline: interactive.append(True))
            self.clock[0] += seconds
        self.timer.sleep = sleep
        with self.relay.request_scope("tmdb", background=True, budget=rw.Budget(clock=lambda: self.clock[0])):
            self.relay.json_request("tmdb", "fixture", 125)
        self.assertEqual(interactive, [True])
        self.assertFalse(self.relay.locks["tmdb"].locked())
        self.assertGreaterEqual(self.clock[0], 100.1)

    def test_failed_background_reacquisition_does_not_release_other_callers_lock(self):
        self.responses = [{}]
        self.relay.next_request["tmdb"] = 100.1
        def sleep(seconds):
            self.clock[0] += seconds
            self.relay.locks["tmdb"].acquire()
        self.timer.sleep = sleep
        with self.assertRaises(rc.BudgetExceeded):
            with self.relay.request_scope("tmdb", background=True):
                self.relay.json_request("tmdb", "fixture", 125)
        self.assertTrue(self.relay.locks["tmdb"].locked())
        self.relay.locks["tmdb"].release()
        self.assertEqual(self.calls, [])

    def test_oauth_401_retry_and_token_cache_use_same_actual_budget(self):
        self.responses = [{"access_token": "first", "expires_in": 3600},
                          self.namespace["UpstreamStatus"](401),
                          {"access_token": "second", "expires_in": 3600}, []]
        budget = rw.Budget(clock=lambda: self.clock[0])
        with self.relay.request_scope("igdb", background=True, budget=budget):
            self.assertEqual(self.relay.igdb("fields id;", 125), [])
        self.assertEqual(budget.outbound_requests, 4)
        self.assertEqual(self.relay.token, "second")
        self.assertFalse(self.relay.token_lock.locked())
        self.responses = [[]]
        with self.relay.request_scope("igdb", background=True, budget=budget):
            self.relay.igdb("fields id;", 125)
        self.assertEqual(budget.outbound_requests, 5)

    def test_outbound_cap_aggregate_limits_deadline_and_nonfinite_json(self):
        budget = rw.Budget(clock=lambda: self.clock[0])
        budget.outbound_requests = 48
        with self.assertRaises(rc.BudgetExceeded):
            with self.relay.request_scope("tmdb", background=True, budget=budget):
                self.relay.json_request("tmdb", "fixture", 125)
        self.assertFalse(self.calls)
        budget = rw.Budget(clock=lambda: self.clock[0])
        budget.bytes_left = 100
        self.responses = [{}]
        with self.relay.request_scope("tmdb", background=True, budget=budget):
            self.relay.json_request("tmdb", "fixture", 125, budget=[4 * 1024 * 1024])
        self.assertEqual(self.calls[0][1]["limit"], 100)
        self.assertEqual(budget.bytes_left, 98)
        with self.assertRaises(rw.Rejected):
            self.relay.json_request("tmdb", "fixture", 100)
        self.assertFalse(self.relay.locks["tmdb"].locked())
        self.responses = []
        self.namespace["outbound"] = lambda *args, **kwargs: (b'{"bad":NaN}', "application/json")
        with self.assertRaises(ValueError):
            self.relay.json_request("tmdb", "fixture", 125)

    def test_stashdb_outer_lock_contract_is_unchanged(self):
        self.responses = [{}]
        self.assertEqual(self.relay.paced("stashdb", lambda d: self.relay.json_request("stashdb", "fixture", d)), {})
        self.assertFalse(self.relay.locks["stashdb"].locked())


if __name__ == "__main__":
    unittest.main()
