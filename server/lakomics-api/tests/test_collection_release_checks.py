"""Server daily Kakao new-volume checks (SERVER-INDEP-001 slice 1).

* ``FixtureParityTests`` pins the Python port of the PC refresh to the shared fixture
  ``_tools/app/src-tauri/src/library/fixtures/kakao_refresh.json`` (the Rust test reading the
  same file belongs to the PC side).
* ``ReleaseCheckTests`` runs real checks against the real application: active Collections
  authority, fake Kakao HTTP, real ``apply_command_batch``. No test touches the network.
"""
import json
import os
import sqlite3
import time
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

from tests import test_collection_authority as authority_tests
from tests import test_collection_bindings as binding_tests
import collection_authority as ca
import collection_bindings as bindings
import collection_release_checks as rc
import collection_releases as releases

api_app = authority_tests.api_app
LIBRARY = authority_tests.LIBRARY
FIXTURE = (Path(__file__).resolve().parents[3]
           / "_tools/app/src-tauri/src/library/fixtures/kakao_refresh.json")


# --- parity with the PC ---------------------------------------------------------------------

def items_of(products):
    """Search items of a fixture case, as the Rust test builds them (the raw document is the
    product's optional ``raw``, else ``{"id": id}``)."""
    items = []
    for product in products:
        number, base = bindings.classify_product(product["title"])
        items.append({"itemId": product["id"], "title": product["title"], "author": product["author"],
                      "publisher": product["publisher"], "isbn13": product["isbn13"],
                      "publicationDate": product["date"], "volumeNumber": number, "baseTitle": base,
                      "thumbnail": None, "itemUrl": product["url"],
                      "raw": product.get("raw", {"id": product["id"]})})
    return items


class FixtureParityTests(unittest.TestCase):
    def test_every_case_of_the_shared_fixture(self):
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        names = [case["name"] for case in fixture["cases"]]
        self.assertEqual(len(names), len(set(names)))
        for case in fixture["cases"]:
            with self.subTest(case["name"]):
                existing = {row["volume"]: {
                    "volumeNumber": row["volume"], "providerItemId": row["providerItemId"], "title": row["title"],
                    "author": row["author"], "publisher": row["publisher"], "isbn13": row["isbn13"],
                    "publicationDate": row["publicationDate"], "itemUrl": row["itemUrl"],
                    "data": row.get("data", {"id": row["providerItemId"]})} for row in case["existingSources"]}
                expected = case["expected"]
                call = dict(stored_config=case["binding"]["config"], external_id=case["binding"]["externalId"],
                            items=items_of(case["products"]), checked_at=case["checkedAt"],
                            existing_sources=existing, existing_slots=set(case["existingSlots"]),
                            gating=case["gating"], previous_checked_at=case["previousCheckedAt"])
                if expected["error"] is not None:
                    self.assertEqual(expected["error"], "ambiguousBinding")
                    with self.assertRaises(rc.Ambiguous):
                        rc.plan_refresh(**call)
                    continue
                plan = rc.plan_refresh(**call)
                raw = {product["id"]: product.get("raw", {"id": product["id"]}) for product in case["products"]}
                sources = [{**row, "data": row.get("data", {"id": row["providerItemId"]})}
                           for row in expected["sources"]]
                for row in plan["sources"]:
                    self.assertEqual(row["data"], raw[row["providerItemId"]])
                self.assertEqual(plan["externalId"], expected["externalId"])
                self.assertEqual(plan["config"], expected["config"])
                self.assertEqual(plan["snapshot"], expected["snapshot"])
                self.assertEqual(plan["sources"], sources)
                self.assertEqual(plan["newSlots"], expected["newSlots"])
                self.assertEqual(plan["events"], expected["events"])
                self.assertEqual(plan["result"], expected["result"])

    def test_fixture_covers_the_rules_it_claims(self):
        names = {case["name"] for case in json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]}
        for needed in ("refind_by_anchor_new_date_status", "refind_by_known_id", "refind_by_fingerprint",
                       "collapsed_groups", "duplicate_volume_across_groups", "unnumbered_is_volume_one",
                       "out_of_range_volumes_make_no_event", "no_ownership_tracking_no_events",
                       "dismissal_carried_over", "dismissal_dropped", "dismissal_carried_over_two_groups",
                       "dismissal_dropped_two_groups", "titles_are_trimmed_in_sources",
                       "raw_document_only_change"):
            self.assertIn(needed, names)

    def test_status_follows_the_check_date_in_its_own_offset(self):
        self.assertEqual(rc.release_status_at("2026-10-09", "2026-10-09T00:00:00Z"), "released")
        self.assertEqual(rc.release_status_at("2026-10-10", "2026-10-09T23:59:00Z"), "upcoming")
        # chrono's date_naive keeps the offset's own calendar date.
        self.assertEqual(rc.release_status_at("2026-10-10", "2026-10-10T01:00:00+09:00"), "released")
        self.assertIsNone(rc.release_status_at(None, "2026-10-09T00:00:00Z"))
        self.assertIsNone(rc.release_status_at("soon", "2026-10-09T00:00:00Z"))

    def test_backoff_table_is_the_pcs(self):
        steps = [1, 2, 3, 4, 9]
        self.assertEqual([rc.retry_seconds(rc.UNAVAILABLE, 500, None, n) for n in steps], [5, 30, 120, 600, 600])
        self.assertEqual([rc.retry_seconds(rc.TIMED_OUT, None, None, n) for n in steps], [5, 30, 120, 600, 600])
        self.assertEqual([rc.retry_seconds(rc.RATE_LIMITED, 429, None, n) for n in steps], [60, 120, 300, 900, 900])
        self.assertEqual(rc.retry_seconds(rc.NO_CREDENTIAL, None, None, 1), 3600)
        self.assertEqual(rc.retry_seconds(rc.BAD_CREDENTIAL, 403, None, 3), 3600)
        self.assertEqual(rc.retry_seconds(rc.UNAVAILABLE, 401, None, 1), 3600)
        # Retry-After is a minimum wait (capped at a day), also on a 503.
        self.assertEqual(rc.retry_seconds(rc.UNAVAILABLE, 503, 900, 1), 900)
        self.assertEqual(rc.retry_seconds(rc.RATE_LIMITED, 429, 10, 1), 60)
        self.assertEqual(rc.retry_seconds(rc.RATE_LIMITED, 429, 10 ** 9, 1), 86400)

    def test_failure_classes_follow_the_pc(self):
        up = bindings.Upstream
        for error, reason, work_error in (
                (up("timeout"), rc.TIMED_OUT, False), (up("unavailable"), rc.UNAVAILABLE, False),
                (up("status", 429), rc.RATE_LIMITED, False), (up("status", 403), rc.BAD_CREDENTIAL, False),
                (up("status", 500), rc.UNAVAILABLE, False), (up("status", 404), rc.UNAVAILABLE, True),
                (up("status", 408), rc.UNAVAILABLE, False), (up("invalid"), rc.INVALID_RESPONSE, False),
                (bindings.KakaoTooBroad(), rc.INVALID_RESPONSE, False), (rc.Ambiguous(), None, False)):
            with self.subTest(type(error).__name__ + str(getattr(error, "status", ""))):
                failure = rc.classify(error)
                self.assertEqual((failure.reason, failure.work_error), (reason, work_error))

    def test_retry_after_accepts_a_delay_or_an_http_date(self):
        now = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)
        with mock.patch.object(bindings, "now_utc", return_value=now):
            parse = bindings._retry_after
            self.assertEqual(parse({"retry-after": "120"}), 120)
            self.assertEqual(parse({"retry-after": "Fri, 09 Oct 2026 12:05:00 GMT"}), 300)
            self.assertEqual(parse({"retry-after": "Fri, 09 Oct 2026 11:00:00 GMT"}), 1)  # already past
            self.assertEqual(parse({"retry-after": "Sat, 10 Oct 2026 12:00:00 GMT"}), 86400)
            self.assertEqual(parse({"retry-after": "9999999"}), 86400)
            self.assertEqual(parse({"retry-after": "0"}), 1)
            self.assertIsNone(parse({"retry-after": "soon"}))
            self.assertIsNone(parse({}))
        failure = rc.classify(bindings.Upstream("status", 503, 300))
        self.assertEqual((failure.reason, failure.retry_after), (rc.UNAVAILABLE, 300))
        self.assertEqual(rc.retry_seconds(failure.reason, failure.http_status, failure.retry_after, 1), 300)

    def test_search_items_keep_internal_fields_that_replies_never_carry(self):
        document = binding_tests.kakao_book(1)
        item = bindings.kakao_item(document)
        self.assertEqual(item["raw"], document)
        self.assertEqual(item["itemUrl"], "https://search.daum.net/search?w=bookpage&bookId=1")
        for group in bindings.group_kakao([item]):
            self.assertFalse({"raw", "itemUrl"} & set(group))
            for volume in group["volumes"]:
                self.assertFalse({"raw", "itemUrl"} & set(volume))

    def test_background_pages_are_capped_inside_the_shared_budget(self):
        gate = bindings.SearchGate()
        for _ in range(bindings.KAKAO_BACKGROUND_PAGES_PER_MINUTE):
            self.assertEqual(gate.take_kakao_page(background=True), 0)
        self.assertGreater(gate.take_kakao_page(background=True), 0)
        # A person's search still has the rest of the minute...
        for _ in range(bindings.KAKAO_PAGES_PER_MINUTE - bindings.KAKAO_BACKGROUND_PAGES_PER_MINUTE):
            self.assertEqual(gate.take_kakao_page(), 0)
        # ...and the shared 300 are 300 for everybody.
        self.assertGreater(gate.take_kakao_page(), 0)
        self.assertGreater(gate.take_kakao_page(background=True), 0)


# --- real checks ----------------------------------------------------------------------------

SERIES = {"던전밥": 0, "나의 만화": 1}
BASE = datetime(2030, 1, 1, 12, 0, tzinfo=timezone.utc)  # "now" of the worker in these tests


def book(volume, date="2026-09-01", title="던전밥", publisher="소미미디어"):
    index = SERIES[title]
    return {"title": f"{title} {volume}", "authors": ["쿠이 료코"], "publisher": publisher,
            "isbn": f"978{index:02d}00000{volume:03d}", "datetime": f"{date}T00:00:00.000+09:00",
            "url": f"https://search.daum.net/search?w=bookpage&bookId=b{index}x{volume}"}


class ReleaseCheckTests(unittest.TestCase):
    tearDown = authority_tests.CollectionAuthorityTests.tearDown
    ready = authority_tests.CollectionAuthorityTests.ready
    command = authority_tests.CollectionAuthorityTests.command
    ok = authority_tests.CollectionAuthorityTests.ok
    code = authority_tests.CollectionAuthorityTests.code
    work = authority_tests.CollectionAuthorityTests.work
    status = authority_tests.CollectionAuthorityTests.status
    publish_legacy = authority_tests.CollectionAuthorityTests.publish_legacy
    baseline = authority_tests.CollectionAuthorityTests.baseline
    stage = authority_tests.CollectionAuthorityTests.stage
    activate = authority_tests.CollectionAuthorityTests.activate
    confirm = authority_tests.CollectionAuthorityTests.confirm

    def setUp(self):  # noqa: F811 - extends the borrowed fixture
        authority_tests.CollectionAuthorityTests.setUp(self)
        self.http = binding_tests.FakeHttp()
        self.http.handlers["dapi.kakao.com"] = self.serve({"던전밥": [book(1), book(2)]})
        for patch in (mock.patch.object(bindings, "http_get", self.http),
                      mock.patch.object(bindings, "gate", bindings.SearchGate()),
                      mock.patch.dict(os.environ, {rc.ENV: "1", bindings.KAKAO_KEY_ENV: "test-kakao-key"})):
            patch.start()
            self.addCleanup(patch.stop)
        self.moment = BASE
        self.worker = rc.Worker(api_app.get_db, now=lambda: self.moment)
        self.ready()

    # -- fixtures -------------------------------------------------------------------------
    def serve(self, docs_by_query):
        self.catalog = docs_by_query

        def handler(url, params, headers):
            docs = self.catalog[params["query"]]
            return json.dumps({"meta": {"is_end": True}, "documents": docs}).encode()
        return handler

    def bind(self, work_id="a", query="던전밥", watch=True):
        items = [bindings.kakao_item(document) for document in self.catalog[query]]
        [group] = bindings.grouped_kakao(items)
        candidate = group["candidate"]
        config = {"version": 1, "query": query, "groupFingerprint": candidate["groupFingerprint"],
                  "knownItemIds": sorted(item["itemId"] for item in group["items"])}
        anchor = candidate["anchorItemId"]
        self.ok(self.command("bindProvider", headers=self.publisher, workId=work_id, provider="kakao",
                             externalId=anchor, config=config, expectedRevision=0))
        self.ok(self.command("applyProviderSnapshot", headers=self.publisher, workId=work_id, provider="kakao",
                             externalId=anchor, snapshot=candidate, values={}, details=None,
                             baseSnapshotDigest=None))
        if watch:
            self.ok(self.command("setOwnershipTracking", workId=work_id, editionIndex=0, count=2,
                                 expectedCount=None, expectedRevision=None))
            self.ok(self.command("setReleaseSubscription", workId=work_id, enabled=True, expectedEnabled=False,
                                 expectedRevision=None))
        return anchor

    def rows(self, sql, *params):
        with api_app.get_db() as db:
            return [dict(row) for row in db.execute(sql, params)]

    def sources(self, work_id="a"):
        return {row["volume_number"]: row for row in self.rows(
            "SELECT * FROM collection_authority_volume_sources WHERE work_id=? AND deleted=0", work_id)}

    def events(self):
        return self.rows("SELECT * FROM collection_release_events ORDER BY volume_number, id")

    def cursor(self):
        return self.client.get(authority_tests.PREFIX + "/status", headers=self.auth).json()["cursor"]

    def state(self, work_id="a"):
        rows = self.rows("SELECT * FROM collection_release_check_state WHERE work_id=?", work_id)
        return rows[0] if rows else None

    def check(self, work_id="a", day=0):
        self.moment = BASE + timedelta(days=day)
        return self.worker.check_work(work_id, self.moment, {})

    # -- the check ------------------------------------------------------------------------
    def test_check_records_sources_slots_events_and_binding_through_authority_commands(self):
        anchor = self.bind()
        cursor = self.cursor()
        self.assertFalse(self.check())
        self.assertGreater(self.cursor(), cursor)
        sources = self.sources()
        self.assertEqual(sorted(sources), [1, 2])
        self.assertEqual(sources[1]["provider_item_id"], bindings.kakao_item(book(1))["itemId"])
        self.assertEqual(json.loads(sources[1]["data"]), book(1))
        self.assertEqual(sources[1]["item_url"], "https://search.daum.net/search?w=bookpage&bookId=b0x1")
        with api_app.get_db() as db:
            slots = {row["volume_number"]: row for row in db.execute(
                "SELECT * FROM collection_authority_volumes WHERE work_id='a' AND edition_index=0 AND deleted=0")}
            binding = ca.binding_projection(ca.binding_row(db, LIBRARY, "a", "kakao"))
        self.assertEqual(sorted(slots), [1, 2])
        self.assertEqual([slots[n]["sort_order"] for n in (1, 2)], [1, 2])
        self.assertEqual(binding["externalId"], anchor)
        self.assertEqual(binding["lastSyncedAt"], rc.iso(self.moment))
        # No source history: establish a quiet baseline on the first refresh.
        self.assertEqual(self.events(), [])
        self.assertEqual(self.work("a")["derived"].get("unreadReleaseCount", 0), 0)
        self.assertEqual(self.ok(self.client.get("/v1/collections/releases", headers=self.auth))["counts"]["unread"], 0)
        self.assertEqual(self.state()["last_checked_at"], rc.iso(self.moment))

        # Volume 3 appears a day later: exactly one new event, rows of 1 and 2 are untouched.
        self.catalog["던전밥"] = [book(1), book(2), book(3, "2026-12-01")]
        before = {n: dict(row) for n, row in self.sources().items()}
        self.assertTrue(self.check(day=1))
        self.assertEqual([(e["kind"], e["volume_number"]) for e in self.events()],
                         [("new_volume", 3)])
        after = self.sources()
        self.assertEqual({n: after[n] for n in (1, 2)}, {n: before[n] for n in (1, 2)})
        self.assertEqual(sorted(after), [1, 2, 3])
        with api_app.get_db() as db:
            config = json.loads(ca.binding_row(db, LIBRARY, "a", "kakao")["config"])
        self.assertEqual(len(config["knownItemIds"]), 3)

    def test_replay_and_a_second_run_the_same_day_change_nothing(self):
        self.bind()
        self.check()
        cursor, calls = self.cursor(), len(self.http.calls)
        events = self.events()
        self.assertFalse(self.worker.check_work("a", self.moment, {}))
        self.assertEqual((self.cursor(), len(self.http.calls), self.events()), (cursor, calls, events))
        # Even with a different crawl result: the day's batch is already receipted.
        self.catalog["던전밥"] = [book(1), book(2), book(3)]
        self.assertFalse(self.worker.check_work("a", self.moment + timedelta(hours=2), {}))  # same UTC day
        self.assertEqual((self.cursor(), self.events()), (cursor, events))

    def test_batch_ids_are_deterministic(self):
        self.bind()
        self.check()
        batch = str(uuid.uuid5(rc.NAMESPACE, f"a:kakao:{rc.iso(self.moment)[:10]}"))
        with api_app.get_db() as db:
            receipt = db.execute("SELECT command_type,entity_key FROM collection_authority_receipts"
                                 " WHERE operation_id=?", (batch,)).fetchone()
            self.assertEqual(tuple(receipt), ("providerApply", "a"))
            ids = {row[0] for row in db.execute("SELECT operation_id FROM collection_authority_receipts")}
        change = {"kind": "new_volume", "volumeNumber": 1, "previousValue": None,
                  "currentValue": "2026-09-01"}
        self.assertIn(str(uuid.uuid5(uuid.UUID(batch), "upsertVolumeSource:1")), ids)
        self.assertIn(str(uuid.uuid5(uuid.UUID(batch), "upsertVolume:2")), ids)
        ident = rc.event_id("a", change, rc.iso(self.moment)[:10])
        self.assertNotIn(str(uuid.uuid5(uuid.UUID(batch), f"recordReleaseEvent:{ident}")), ids)
        self.assertEqual(self.events(), [])
        self.catalog["던전밥"] = [book(1), book(2), book(3)]
        self.check(day=1)
        next_batch = uuid.uuid5(rc.NAMESPACE, f"a:kakao:{rc.iso(self.moment)[:10]}")
        change["volumeNumber"] = 3
        next_ident = rc.event_id("a", change, rc.iso(self.moment)[:10])
        with api_app.get_db() as db:
            self.assertIsNotNone(db.execute("SELECT 1 FROM collection_authority_receipts WHERE operation_id=?",
                (str(uuid.uuid5(next_batch, f"recordReleaseEvent:{next_ident}")),)).fetchone())
        self.assertEqual({e["event_id"] for e in self.events()}, {next_ident})
        # The day is part of the id: the same change on another day is another event.
        self.assertNotEqual(ident, rc.event_id("a", change, "2030-01-02"))

    def test_a_date_flipping_back_and_forth_is_recorded_each_time(self):
        self.bind()
        self.check()
        for day, date in enumerate(("2026-10-20", "2026-09-01", "2026-10-20"), start=1):
            self.catalog["던전밥"] = [book(1), book(2, date)]
            self.assertTrue(self.check(day=day))
        changes = [(e["previous_value"], e["current_value"]) for e in self.events()
                   if e["volume_number"] == 2 and e["kind"] == "release_date_changed"]
        self.assertEqual(changes, [("2026-09-01", "2026-10-20"), ("2026-10-20", "2026-09-01"),
                                   ("2026-09-01", "2026-10-20")])
        # A replay of the last day changes nothing.
        cursor, events = self.cursor(), self.events()
        self.assertFalse(self.worker.check_work("a", self.moment, {}))
        self.assertEqual((self.cursor(), self.events()), (cursor, events))

    def test_a_release_status_flipping_back_and_forth_is_recorded_each_time(self):
        self.catalog["던전밥"] = [book(1), book(2, "2030-01-03")]
        self.bind()
        self.check()  # 2030-01-01: volume 2 is upcoming
        self.assertTrue(self.check(day=3))  # 01-04, same date: upcoming -> released (events only)
        self.catalog["던전밥"] = [book(1), book(2, "2030-01-10")]
        self.assertTrue(self.check(day=4))  # 01-05: the date moves out again: released -> upcoming
        self.assertTrue(self.check(day=10))  # 01-11: upcoming -> released once more
        flips = [(e["previous_value"], e["current_value"]) for e in self.events()
                 if e["volume_number"] == 2 and e["kind"] == "release_status_changed"]
        self.assertEqual(flips, [("upcoming", "released"), ("released", "upcoming"), ("upcoming", "released")])

    def test_an_unchanged_check_writes_nothing_but_its_own_state(self):
        self.bind()
        self.check()
        cursor = self.cursor()
        tables = ("collection_authority_bindings", "collection_authority_works", "collection_authority_volumes",
                  "collection_authority_volume_sources", "collection_authority_receipts",
                  "collection_release_events")
        before = {table: self.rows(f"SELECT * FROM {table} ORDER BY 1, 2") for table in tables}
        self.assertFalse(self.check(day=1))
        self.assertEqual(self.cursor(), cursor)
        self.assertEqual({table: self.rows(f"SELECT * FROM {table} ORDER BY 1, 2") for table in tables}, before)
        # Only the check state moves (the status route reads it).
        self.assertEqual(self.state()["last_checked_at"], rc.iso(BASE + timedelta(days=1)))
        self.assertEqual(self.worker.status_view()["remaining"], 0)

    def test_a_raw_document_only_change_updates_the_source_without_an_event(self):
        self.bind()
        self.check()
        events, cursor = self.events(), self.cursor()
        self.catalog["던전밥"] = [book(1), {**book(2), "contents": "a new blurb"}]
        self.assertFalse(self.check(day=1))
        self.assertGreater(self.cursor(), cursor)
        self.assertEqual(json.loads(self.sources()[2]["data"])["contents"], "a new blurb")
        self.assertEqual(self.events(), events)

    def status_flips_after_a_pc_refresh(self, pc_refreshed):
        """Volume 2 is upcoming at our check on 2030-01-01 and released at the next one on 01-13;
        a PC refresh on 01-12 (it stamps the binding) saw it released already."""
        self.catalog["던전밥"] = [book(1), book(2, "2030-01-10")]
        self.bind()
        self.check()
        if pc_refreshed:
            with api_app.get_db() as db:
                db.execute("UPDATE collection_authority_bindings SET last_synced_at='2030-01-12T00:00:00Z'"
                           " WHERE work_id='a'")
                db.commit()
        self.check(day=12)
        return [(e["previous_value"], e["current_value"]) for e in self.events()
                if e["kind"] == "release_status_changed"]

    def test_the_previous_check_time_is_the_later_of_our_state_and_the_bindings_last_sync(self):
        self.assertEqual(self.status_flips_after_a_pc_refresh(pc_refreshed=True), [])

    def test_without_a_later_sync_the_status_change_is_raised(self):
        self.assertEqual(self.status_flips_after_a_pc_refresh(pc_refreshed=False), [("upcoming", "released")])

    def test_binding_race_aborts_without_writing(self):
        self.bind()
        base = self.catalog["던전밥"]
        with api_app.get_db() as db:
            binding = ca.binding_row(db, LIBRARY, "a", "kakao")
            revision, config = binding["entity_revision"], json.loads(binding["config"])

        def racing(url, params, headers):
            # Another writer (a PC) changes the binding while the crawl is in flight.
            racing.calls += 1
            if racing.calls == 1:
                self.ok(self.command("bindProvider", headers=self.publisher, workId="a", provider="kakao",
                                     externalId=binding["external_id"], config={**config, "query": "던전밥 "},
                                     expectedRevision=revision))
            return json.dumps({"meta": {"is_end": True}, "documents": base}).encode()
        racing.calls = 0
        self.http.handlers["dapi.kakao.com"] = racing
        cursor_before = self.cursor()
        with self.assertRaises(rc.BindingChanged):
            self.check()
        self.assertEqual(self.cursor(), cursor_before + 1)  # only the racing command
        self.assertEqual((self.sources(), self.events(), self.state()), ({}, [], None))
        # The next attempt starts from the new binding and succeeds.
        self.assertFalse(self.check(day=1))  # first successful check: quiet baseline
        self.assertEqual(sorted(self.sources()), [1, 2])

    def test_unbound_or_deleted_work_is_ineligible_not_an_error(self):
        self.bind()
        self.ok(self.command("deleteWork", workId="a", expectedRevision=self.work("a")["entityRevision"]))
        with self.assertRaises(rc.Ineligible):
            self.check()
        with self.assertRaises(rc.Ineligible):
            self.check("m")
        with self.assertRaises(rc.Ineligible):
            self.check("missing")

    # -- gating ---------------------------------------------------------------------------
    def assert_sources_without_events(self):
        self.assertFalse(self.check())
        self.assertEqual(sorted(self.sources()), [1, 2])
        self.assertEqual(self.events(), [])

    def test_no_events_without_owned_volume_tracking(self):
        self.bind(watch=False)
        self.ok(self.command("setReleaseSubscription", workId="a", enabled=True, expectedEnabled=False,
                             expectedRevision=None))
        self.assertEqual(self.work("a")["derived"].get("ownedVolumes"), None)
        self.assert_sources_without_events()

    def test_no_events_without_a_release_subscription(self):
        self.bind(watch=False)
        self.ok(self.command("setOwnershipTracking", workId="a", editionIndex=0, count=2, expectedCount=None,
                             expectedRevision=None))
        self.assertFalse(self.work("a")["derived"]["releaseWatch"]["enabled"])
        self.assert_sources_without_events()

    def test_events_only_inside_the_volume_range(self):
        self.catalog["던전밥"] = [book(1)]
        self.bind()
        self.check()
        self.catalog["던전밥"] = [book(n) for n in range(1, 6)]
        self.ok(self.command("setVolumeRange", workId="a", minVolume=3, maxVolume=4, hideConnectionPrompt=False,
                             expectedRange={"minVolume": None, "maxVolume": None, "hideConnectionPrompt": False},
                             expectedRevision=None))
        self.assertTrue(self.check(day=1))
        self.assertEqual(sorted(self.sources()), [1, 2, 3, 4, 5])
        self.assertEqual([e["volume_number"] for e in self.events()], [3, 4])

    def test_first_check_counts_from_the_bindings_last_sync(self):
        self.bind()
        self.assertIsNone(self.state())
        with api_app.get_db() as db:
            synced = rc.parse_time(ca.binding_row(db, LIBRARY, "a", "kakao")["last_synced_at"])
            self.assertEqual(self.worker.due(db, LIBRARY, synced + timedelta(hours=23)), [])
            self.assertEqual(self.worker.due(db, LIBRARY, synced + timedelta(hours=25)), ["a"])

    # -- the worker -----------------------------------------------------------------------
    def second_work(self):
        self.catalog["나의 만화"] = [book(1, title="나의 만화", publisher="다른출판"),
                                      book(2, title="나의 만화", publisher="다른출판")]
        return self.bind("s", "나의 만화")

    def test_a_wake_checks_at_most_batch_works_and_reports_the_pcs_status_shape(self):
        self.bind()
        self.second_work()
        with mock.patch.object(rc, "BATCH_WORKS", 1):
            status = self.worker.run_batch()
        self.assertEqual((status["checked"], status["remaining"], status["failed"]), (1, 1, 0))
        self.assertIsNone(status["finishedAt"])
        self.assertEqual(set(status), set(rc.default_status()))
        self.assertEqual(status["requests"], 1)
        status = self.worker.run_batch()
        self.assertEqual((status["checked"], status["remaining"]), (2, 0))
        self.assertIsNotNone(status["finishedAt"])
        view = self.worker.status_view()
        self.assertEqual((view["checked"], view["remaining"], view["busy"]), (2, 0, False))
        # Nothing is due for 24 h, whatever wakes the worker.
        calls = len(self.http.calls)
        self.worker.run_batch()
        self.assertEqual(len(self.http.calls), calls)
        self.moment += timedelta(hours=25)
        self.assertEqual(self.worker.status_view()["remaining"], 2)

    def test_the_next_wake_waits_exactly_as_long_as_needed(self):
        worker, status = self.worker, lambda **fields: {**rc.default_status(), **fields}
        self.assertEqual(worker.next_wait(status()), rc.WAKE_SECONDS)
        worker.more = True  # works are still due
        self.assertEqual(worker.next_wait(status()), rc.MORE_SECONDS)
        self.assertLess(rc.MORE_SECONDS, rc.WAKE_SECONDS)
        # A provider cool-down is waited out exactly (not rounded up to a wake) ...
        for seconds, wait in ((5, 6.0), (30, 31.0), (120, 121.0)):
            retry = rc.iso(self.moment + timedelta(seconds=seconds))
            self.assertEqual(worker.next_wait(status(retryAt=retry)), wait)
        # ... one that is over, or one longer than a wake, falls back to the interval.
        self.assertEqual(worker.next_wait(status(retryAt=rc.iso(self.moment - timedelta(seconds=1)))), rc.MORE_SECONDS)
        self.assertEqual(worker.next_wait(status(retryAt=rc.iso(self.moment + timedelta(hours=1)))), rc.WAKE_SECONDS)
        worker.delay = 7  # a page-budget wait
        self.assertEqual(worker.next_wait(status()), 8.0)
        worker.delay = 10 ** 6
        self.assertEqual(worker.next_wait(status()), rc.WAKE_SECONDS)

    def test_works_left_over_after_a_wake_bring_the_next_one_forward(self):
        self.bind()
        self.second_work()
        with mock.patch.object(rc, "BATCH_WORKS", 1):
            status = self.worker.run_batch()
        self.assertEqual(status["remaining"], 1)
        self.assertEqual(self.worker.next_wait(status), rc.MORE_SECONDS)
        status = self.worker.run_batch()
        self.assertEqual(status["remaining"], 0)
        self.assertEqual(self.worker.next_wait(status), rc.WAKE_SECONDS)

    def test_a_provider_stop_wakes_exactly_when_it_ends(self):
        self.bind()
        self.http.handlers["dapi.kakao.com"] = mock.Mock(side_effect=bindings.Upstream("status", 500))
        status = self.worker.run_batch()
        self.assertEqual(status["retryAt"], rc.iso(self.moment + timedelta(seconds=5)))
        self.assertEqual(self.worker.next_wait(status), 6.0)

    def test_page_budget_wait_reschedules_instead_of_failing(self):
        self.bind()
        for _ in range(bindings.KAKAO_BACKGROUND_PAGES_PER_MINUTE):
            bindings.gate.take_kakao_page(background=True)
        with self.assertRaises(bindings.PageBudget):
            self.check()
        status = self.worker.run_batch()
        self.assertEqual((status["failed"], status["checked"], status["stopReason"], status["retryAt"]),
                         (0, 0, None, None))
        self.assertGreater(self.worker.delay, 0)
        self.assertEqual((self.http.calls, self.sources(), self.state()), ([], {}, None))
        # A person's own search is not blocked by the full background share.
        self.assertEqual(bindings.gate.take_kakao_page(), 0)

    def test_provider_failures_stop_the_provider_with_the_pcs_waits(self):
        self.bind()
        self.http.handlers["dapi.kakao.com"] = mock.Mock(side_effect=bindings.Upstream("status", 429, 30))
        status = self.worker.run_batch()
        self.assertEqual((status["failed"], status["stopReason"], status["consecutiveFailures"]),
                         (1, "rate_limited", 1))
        self.assertEqual(status["retryAt"], rc.iso(self.moment + timedelta(seconds=60)))
        self.assertEqual(status["lastFailure"], {"collectionId": "a", "detectedAt": rc.iso(self.moment),
                                                 "kind": "http", "endpoint": "search", "httpStatus": 429,
                                                 "retryAfterSeconds": 30})
        row = self.state()
        self.assertEqual((row["last_error_code"], row["retry_at"], row["last_checked_at"]), ("rateLimited", None, None))
        # While the provider is cooling down nothing is requested.
        calls = self.http.handlers["dapi.kakao.com"].call_count
        self.assertEqual(self.worker.run_batch()["retryAt"], status["retryAt"])
        self.assertEqual(self.http.handlers["dapi.kakao.com"].call_count, calls)
        # After it, a second failure waits longer; a success resets the count.
        self.moment += timedelta(seconds=61)
        status = self.worker.run_batch()
        self.assertEqual((status["consecutiveFailures"], status["retryAt"]),
                         (2, rc.iso(self.moment + timedelta(seconds=120))))
        self.moment += timedelta(seconds=121)
        self.http.handlers["dapi.kakao.com"] = self.serve({"던전밥": [book(1), book(2)]})
        status = self.worker.run_batch()
        self.assertEqual((status["consecutiveFailures"], status["checked"], status["lastFailure"]), (0, 1, None))
        self.assertEqual(self.state()["last_error_code"], None)

    def test_a_rejected_batch_rolls_back_whole_and_defers_only_that_work(self):
        self.catalog["던전밥"] = [book(1)]
        self.bind()
        self.check()
        baseline_sources = self.sources("a")
        receipts = self.rows("SELECT * FROM collection_authority_receipts WHERE entity_key='a'"
                             " AND command_type='providerApply'")
        self.moment += timedelta(hours=25)
        self.catalog["던전밥"] = [book(1), book(2), book(3)]
        self.catalog["나의 만화"] = [book(1, title="나의 만화", publisher="다른출판")]
        self.bind("s", "나의 만화", watch=False)  # no events: its batch is accepted
        cursor = self.cursor()
        slots = self.rows("SELECT * FROM collection_authority_volumes WHERE work_id='a'")
        with mock.patch.object(releases, "MAX_EVENTS", 1), \
                self.assertLogs(rc.__name__, "WARNING") as logs:
            status = self.worker.run_batch()  # "a" records one event, the second hits the limit
        self.assertTrue(any("releaseEventLimit" in line for line in logs.output), logs.output)
        self.assertEqual((status["checked"], status["failed"], status["stopReason"], status["retryAt"]),
                         (1, 1, None, None))
        self.assertEqual(status["lastFailure"], {
            "collectionId": "a", "detectedAt": rc.iso(self.moment), "kind": "authority",
            "endpoint": "releaseEventLimit", "httpStatus": None, "retryAfterSeconds": None})
        # Nothing of the failed refresh survived; its baseline remains intact.
        self.assertEqual((self.sources("a"), self.events()), (baseline_sources, []))
        self.assertEqual(self.rows("SELECT * FROM collection_authority_volumes WHERE work_id='a'"), slots)
        self.assertEqual(self.rows("SELECT * FROM collection_authority_receipts WHERE entity_key='a'"
                                   " AND command_type='providerApply'"), receipts)
        self.assertEqual(sorted(self.sources("s")), [1])
        self.assertGreater(self.cursor(), cursor)  # only "s" advanced the feed
        broken = self.state("a")
        self.assertEqual((broken["last_error_code"], rc.parse_time(broken["retry_at"])),
                         ("releaseEventLimit", self.moment + timedelta(hours=24)))
        self.assertEqual(self.worker.status_view()["remaining"], 0)
        # A day later the work is tried again, and now succeeds.
        self.moment += timedelta(hours=25)
        self.worker.run_batch()
        self.assertEqual(sorted(self.sources("a")), [1, 2, 3])

    def test_another_rejected_batch_code_is_logged_and_kept_in_the_status(self):
        self.bind()
        error = HTTPException(409, {"code": "providerIdentityTaken", "message": "taken"})
        with mock.patch.object(ca, "apply_command_batch", side_effect=error), \
                self.assertLogs(rc.__name__, "WARNING") as logs:
            status = self.worker.run_batch()
        self.assertTrue(any("providerIdentityTaken" in line and "409" in line for line in logs.output), logs.output)
        self.assertEqual((status["failed"], status["lastFailure"]["endpoint"]), (1, "providerIdentityTaken"))
        self.assertEqual(self.state()["last_error_code"], "providerIdentityTaken")
        self.assertEqual(rc.parse_time(self.state()["retry_at"]), self.moment + timedelta(hours=24))

    def test_a_locked_database_is_tried_again_on_the_next_wake(self):
        self.bind()
        with mock.patch.object(ca, "apply_command_batch", side_effect=sqlite3.OperationalError("database is locked")), \
                self.assertLogs(rc.__name__, "WARNING"):
            status = self.worker.run_batch()
        self.assertEqual((status["failed"], status["consecutiveFailures"], status["stopReason"], status["retryAt"]),
                         (0, 0, None, None))
        self.assertIsNone(self.state())  # nothing remembered: not a 24 h defer
        self.assertEqual(self.worker.status_view()["remaining"], 1)
        self.assertEqual(self.worker.next_wait(status), rc.MORE_SECONDS)
        self.assertEqual(self.sources(), {})
        self.assertEqual(self.worker.run_batch()["checked"], 1)  # the next wake just works

    def test_an_unexpected_cycle_error_is_logged_with_its_traceback(self):
        self.worker.start_delay = 0

        def broken():
            self.worker.stop_event.set()  # one cycle only
            raise RuntimeError("boom")
        with mock.patch.object(self.worker, "run_batch", side_effect=broken), \
                self.assertLogs(rc.__name__, "ERROR") as logs:
            self.worker.run()
        self.assertIn("release check cycle failed", logs.output[0])
        self.assertIn("RuntimeError: boom", logs.output[0])

    def test_a_missing_key_stops_the_provider_for_an_hour(self):
        self.bind()
        with mock.patch.dict(os.environ, {bindings.KAKAO_KEY_ENV: ""}):
            status = self.worker.run_batch()
        self.assertEqual((status["stopReason"], status["retryAt"]),
                         ("credential_not_configured", rc.iso(self.moment + timedelta(hours=1))))
        self.assertEqual(self.http.calls, [])

    def test_a_work_specific_error_defers_only_that_work_for_a_day(self):
        self.bind()
        self.second_work()
        real = self.http.handlers["dapi.kakao.com"]

        def handler(url, params, headers):
            if params["query"] == "던전밥":
                raise bindings.Upstream("status", 404)
            return real(url, params, headers)
        self.http.handlers["dapi.kakao.com"] = handler
        status = self.worker.run_batch()
        self.assertEqual((status["checked"], status["failed"], status["stopReason"], status["retryAt"]),
                         (1, 1, None, None))
        broken = self.state("a")
        self.assertEqual(rc.parse_time(broken["retry_at"]), self.moment + timedelta(hours=24))
        self.assertEqual(broken["last_error_code"], "upstreamFailed")
        self.assertEqual(self.state("s")["last_error_code"], None)
        self.assertEqual(self.worker.status_view()["remaining"], 0)

    def test_an_unreadable_binding_is_deferred_like_the_pcs_ambiguous_binding(self):
        self.bind()
        with api_app.get_db() as db:
            db.execute("UPDATE collection_authority_bindings SET config='{\"version\":9}' WHERE work_id='a'")
            db.commit()
        status = self.worker.run_batch()
        self.assertEqual((status["failed"], status["stopReason"]), (1, None))
        self.assertEqual(self.state()["last_error_code"], "ambiguousBinding")
        self.assertEqual(self.http.calls, [])

    def test_shutdown_ends_a_crawl_between_pages_and_joins(self):
        self.bind()
        pages_seen = []

        def handler(url, params, headers):
            pages_seen.append(params["page"])
            self.worker.drain()
            return json.dumps({"meta": {"is_end": False}, "documents": [book(1)]}).encode()
        self.http.handlers["dapi.kakao.com"] = handler
        status = self.worker.run_batch()
        self.assertEqual(pages_seen, ["1"])
        self.assertEqual((status["checked"], status["failed"]), (0, 0))
        self.assertEqual((self.sources(), self.state()), ({}, None))

    def test_the_thread_starts_only_when_enabled_and_stop_joins_it(self):
        self.worker.start_delay = 0
        self.worker.stop_event.clear()
        with mock.patch.dict(os.environ, {rc.ENV: "0"}):
            self.worker.start()
            self.assertIsNone(self.worker.thread)
        self.worker.start()
        thread = self.worker.thread
        self.assertTrue(thread.is_alive())
        began = time.monotonic()
        self.worker.stop()
        self.assertFalse(thread.is_alive())
        self.assertLess(time.monotonic() - began, 3)
        self.assertIsNone(self.worker.thread)

    def test_the_loop_runs_a_wake(self):
        self.bind()
        self.worker.start_delay = 0
        self.worker.start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and not self.sources():
            time.sleep(0.05)
        self.worker.stop()
        self.assertEqual(sorted(self.sources()), [1, 2])

    # -- kill switch ----------------------------------------------------------------------
    def test_switch_off_nothing_runs_and_nothing_is_advertised(self):
        self.bind()
        features = self.advertised
        for value in ("", "0", "false", "no"):
            with mock.patch.dict(os.environ, {rc.ENV: value}):
                self.assertEqual(rc.features(), [])
                self.assertEqual(features(), ["personProfileFields", "kakaoReview"])
                self.worker.start()
                self.assertIsNone(self.worker.thread)
                self.worker.run_batch()
                self.assertEqual(self.http.calls, [])
                for reply in (self.client.get(rc.PREFIX + "/status", headers=self.auth),
                              self.client.post(rc.PREFIX + "/run", headers=self.auth, json={"provider": "kakao"})):
                    self.assertEqual(reply.status_code, 404, reply.text)
                    self.assertEqual(reply.json()["detail"]["code"], "releaseChecksUnavailable")
        with mock.patch.dict(os.environ):
            os.environ.pop(rc.ENV)
            self.assertEqual(rc.features(), [])

    def advertised(self):
        return self.client.get(authority_tests.PREFIX + "/status", headers=self.auth).json()["features"]

    def test_the_feature_needs_the_switch_a_server_key_and_a_live_worker(self):
        base = ["personProfileFields", "kakaoReview"]
        worker = api_app.app.state.release_check_worker
        worker.start_delay = 3600  # alive, but never wakes during the test
        self.addCleanup(worker.stop)
        self.assertFalse(worker.alive())
        self.assertEqual(self.advertised(), base)  # switch on, key set, but no thread
        worker.start()
        self.assertTrue(worker.alive())
        self.assertEqual(self.advertised(), base + [rc.FEATURE])
        with mock.patch.dict(os.environ, {bindings.KAKAO_KEY_ENV: ""}):
            self.assertEqual(self.advertised(), base)
        with mock.patch.dict(os.environ, {rc.ENV: "0"}):
            self.assertEqual(self.advertised(), base)
        worker.stop()
        self.assertFalse(worker.alive())
        self.assertEqual(self.advertised(), base)

    def test_inactive_authority_does_nothing(self):
        self.bind()
        with api_app.get_db() as db:
            db.execute("DELETE FROM authority_domains WHERE domain='collections'")
            db.commit()
        self.worker.run_batch()
        self.assertEqual(self.http.calls, [])

    # -- routes ---------------------------------------------------------------------------
    def test_routes_need_a_client_credential(self):
        self.bind()
        for method, path, body in (("get", "/status", None), ("post", "/run", {"provider": "kakao"})):
            for headers in ({}, {"Authorization": "Bearer nope"}):
                reply = getattr(self.client, method)(rc.PREFIX + path, headers=headers, **({"json": body} if body else {}))
                self.assertEqual((reply.status_code, reply.json()), (401, {"detail": "Unauthorized"}))
        reply = self.client.get(rc.PREFIX + "/status", headers=self.auth)
        self.assertEqual(reply.status_code, 200, reply.text)
        body = reply.json()
        self.assertEqual(set(body), {"version", "providers"})
        self.assertEqual(set(body["providers"]["kakao"]), set(rc.default_status()))
        self.assertEqual(self.client.get(rc.PREFIX + "/status", headers=self.publisher).status_code, 200)

    def test_run_wakes_the_worker_and_queues_a_due_work_first(self):
        self.bind()
        worker = api_app.app.state.release_check_worker
        self.assertIsInstance(worker, rc.Worker)
        with mock.patch.object(worker, "wake") as wake:
            reply = self.client.post(rc.PREFIX + "/run", headers=self.auth, json={"provider": "kakao"})
            self.assertEqual(reply.status_code, 200, reply.text)
            self.assertEqual({k: reply.json()[k] for k in ("version", "provider", "workId", "queued", "reason")},
                             {"version": 1, "provider": "kakao", "workId": None, "queued": True, "reason": None})
            wake.assert_called_once()
            # Just synced: not due, and a request never bypasses the once-a-day rule.
            reply = self.client.post(rc.PREFIX + "/run", headers=self.auth, json={"provider": "kakao", "workId": "a"})
            self.assertEqual((reply.json()["queued"], reply.json()["reason"]), (False, "notDue"))
            self.assertEqual(worker.priority, [])
            with api_app.get_db() as db:
                db.execute("UPDATE collection_authority_bindings SET last_synced_at='2020-01-01T00:00:00Z'")
                db.commit()
            reply = self.client.post(rc.PREFIX + "/run", headers=self.auth, json={"provider": "kakao", "workId": "a"})
            self.assertEqual((reply.json()["queued"], reply.json()["reason"]), (True, None))
            self.assertEqual(worker.priority, ["a"])
            worker.priority.clear()

    def test_run_rejects_bad_requests_and_unknown_works_and_is_rate_limited(self):
        self.bind()
        worker = api_app.app.state.release_check_worker
        post = lambda body: self.client.post(rc.PREFIX + "/run", headers={**self.auth, "X-Test": str(uuid.uuid4())},
                                             json=body)
        with mock.patch.object(worker, "wake"):
            for body in ({"provider": "aladin"}, {}, {"provider": "kakao", "extra": 1}, {"provider": "kakao", "workId": 5}):
                reply = post(body)
                self.assertEqual((reply.status_code, reply.json()["detail"]["code"]), (422, "invalidReleaseCheckRequest"))
            reply = post({"provider": "kakao", "workId": "m"})  # a movie
            self.assertEqual((reply.status_code, reply.json()["detail"]["code"]), (404, "releaseCheckWorkNotFound"))
            with mock.patch.dict(os.environ, {bindings.KAKAO_KEY_ENV: ""}):
                reply = post({"provider": "kakao"})
                self.assertEqual((reply.status_code, reply.json()["detail"]["code"]), (503, "kakaoSearchUnavailable"))
            # The six above were admitted; the seventh in the minute is not.
            reply = post({"provider": "kakao"})
            self.assertEqual(reply.status_code, 429, reply.text)
            self.assertEqual(reply.json()["detail"]["code"], "releaseCheckRateLimited")
            self.assertIn("Retry-After", reply.headers)

    # -- the release store ----------------------------------------------------------------
    def release(self, event_id, *, work="a", volume=2, previous=None, current="2026-10-20",
                detected="2026-10-06T00:00:00Z", kind="new_volume", provider="kakao"):
        return self.command("recordReleaseEvent", headers=self.publisher, workId=work, eventId=event_id,
                            provider=provider, kind=kind, volumeNumber=volume, previousValue=previous,
                            currentValue=current, detectedAt=detected)

    def test_record_release_ignores_the_same_change_under_another_id(self):
        first = self.ok(self.release("pc-random-1"))
        self.assertTrue(first["changed"])
        again = self.ok(self.release("pc-random-2"))
        self.assertFalse(again["changed"])
        self.assertEqual([e["event_id"] for e in self.events()], ["pc-random-1"])
        # Within 30 days either way round, also when the first one was already read.
        self.ok(self.client.post("/v1/collections/releases/acknowledge", headers=self.auth,
                                 json={"version": 1, "operationId": str(uuid.uuid4()), "eventIds": ["pc-random-1"]}))
        self.assertFalse(self.ok(self.release("pc-random-3", detected="2026-09-10T00:00:00Z"))["changed"])
        self.assertFalse(self.ok(self.release("pc-random-4", detected="2026-11-04T00:00:00Z"))["changed"])
        self.assertEqual(len(self.events()), 1)
        # A different content, work, provider or a detection more than 30 days later is a new event.
        for event_id, fields in (("v", {"volume": 3}), ("c", {"current": "2026-10-21"}), ("p", {"previous": "x"}),
                                 ("k", {"kind": "release_date_changed"}), ("w", {"work": "s"}),
                                 ("m", {"provider": "mangadex"}), ("late", {"detected": "2026-11-06T00:00:00Z"})):
            self.assertTrue(self.ok(self.release(event_id, **fields))["changed"], event_id)
        self.assertEqual(len(self.events()), 8)

    def test_record_release_keeps_real_flips_and_merges_repeats_of_the_latest_event(self):
        for kind, a, b in (("release_date_changed", "2026-09-01", "2026-10-20"),
                           ("release_status_changed", "upcoming", "released")):
            with self.subTest(kind):
                put = lambda name, previous, current, day: self.ok(self.release(
                    f"{kind}-{name}", kind=kind, previous=previous, current=current,
                    detected=f"2026-10-0{day}T00:00:00Z"))["changed"]
                self.assertTrue(put("1", a, b, 1))
                self.assertTrue(put("2", b, a, 2))
                self.assertTrue(put("3", a, b, 3))  # the third flip is not the first again
                self.assertFalse(put("4", a, b, 3))  # the same change under another id is
                self.assertFalse(put("5", a, b, 4))
                self.assertTrue(put("6", b, a, 4))
                stored = [(e["previous_value"], e["current_value"]) for e in self.events() if e["kind"] == kind]
                self.assertEqual(stored, [(a, b), (b, a), (a, b), (b, a)])

    def test_record_release_keeps_its_id_rules(self):
        self.ok(self.release("same-id"))
        self.assertFalse(self.ok(self.release("same-id"))["changed"])  # an exact replay
        reply = self.release("same-id", current="2026-12-31")  # same id, other content
        self.assertEqual((reply.status_code, self.code(reply)), (409, "releaseEventExists"))

    def test_a_pc_event_then_the_servers_check_records_the_change_once(self):
        self.bind()
        self.check()  # quiet source baseline exists
        self.catalog["던전밥"] = [book(1), book(2), book(3, "2026-12-01")]
        self.ok(self.release("pc-random", volume=3, current="2026-12-01",
                             detected=rc.iso(self.moment + timedelta(days=1))))
        self.check(day=1)
        self.assertEqual([e["volume_number"] for e in self.events() if e["kind"] == "new_volume"], [3])


if __name__ == "__main__":
    unittest.main()
