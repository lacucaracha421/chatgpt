"""Offline regressions using real planner, SQLite and authority command bodies.

Reuse the standard-library loader for Windows without FastAPI. HTTP validation
and deployed behavior still require the normal server suite/stage.
"""
import ast
import datetime
import json
import types
import unittest
from unittest import mock

from tests import test_kakao_bind_core as fixtures

load_core, NOW = fixtures.load_core, fixtures.NOW


class FirstCheckTests(unittest.TestCase):
    setUp = fixtures.CoreTests.setUp
    tearDown = fixtures.CoreTests.tearDown
    command = fixtures.CoreTests.command
    create = fixtures.CoreTests.create
    connection = fixtures.CoreTests.connection
    products = fixtures.CoreTests.products
    fetch = fixtures.CoreTests.fetch

    def prepare(self, numbers, owned=13):
        # Replace the bind-worker-only event stub with the real release schema.
        self.db.execute("DROP TABLE collection_release_events")
        releases = load_core("collection_releases", dict(
            datetime=datetime.datetime, timedelta=datetime.timedelta,
            timezone=datetime.timezone, json=json),
            lambda node: (isinstance(node, ast.FunctionDef) and node.name != "register")
            or (isinstance(node, ast.Assign) and all(isinstance(t, ast.Name)
                and t.id in {"DDL", "CONTENT", "MAX_EVENTS", "MAX_CURSOR", "READ_EVENT_DAYS",
                             "READ_LOG_DAYS", "READ_LOG_MAX", "RECEIPTS_RETAINED"} for t in node.targets)))
        # Model validation is covered by the normal HTTP/authority suite.
        releases.Event = fixtures.ModelAdapter
        # Swap only these two entries. patch.dict("sys.modules") would roll back the whole
        # table on stop and drop real modules first imported during the test, so later
        # suites would load second copies with different exception classes.
        import sys
        patched = {"collection_releases": releases,
                   "pydantic": types.SimpleNamespace(ValidationError=ValueError)}
        saved = {name: sys.modules.get(name) for name in patched}
        sys.modules.update(patched)

        def restore():
            for name, module in saved.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module
        self.addCleanup(restore)
        releases.startup_db(self.db)
        self.rc.startup_db(self.db)
        self.db.commit()
        self.items = self.products(numbers=numbers)
        candidate = self.bindings.group_kakao(self.items)[0]
        self.command("bindProvider", workId="a", provider="kakao",
                     externalId=candidate["anchorItemId"], expectedRevision=0,
                     config={"version": 1, "query": "던전밥",
                             "groupFingerprint": candidate["groupFingerprint"]})
        # Adoption may stamp a binding despite never observing Kakao sources.
        self.db.execute("UPDATE collection_authority_bindings SET snapshot_values='{}', last_synced_at=?",
                        (self.rc.iso(NOW - datetime.timedelta(days=4)),))
        self.db.commit()
        self.command("setOwnershipTracking", workId="a", editionIndex=0, count=owned,
                     expectedCount=None, expectedRevision=None)
        self.command("setReleaseSubscription", workId="a", enabled=True,
                     expectedEnabled=False, expectedRevision=None)
        self.checker = self.rc.Worker(self.connection)

    def slot(self, number, edition=0, deleted=False, revision=0):
        self.command("upsertVolume", workId="a", volumeId=f"slot-{number}-{edition}",
                     volumeNumber=number, editionIndex=edition, sortOrder=number,
                     displayLabel=None, coverArtworkId=None, sourceProvider=None,
                     sourceCoverId=None, deleted=deleted, expectedRevision=revision)

    def check(self, day=0):
        return self.checker.check_work("a", NOW + datetime.timedelta(days=day))

    def events(self):
        return [(r["kind"], r["volume_number"]) for r in self.db.execute(
            "SELECT * FROM collection_release_events ORDER BY id")]

    def test_work_a_empty_baseline_owned_1_to_13_then_new_14(self):
        self.prepare(range(1, 7))
        for n in range(1, 14):
            self.slot(n)
        self.assertFalse(self.check())
        self.assertEqual(self.events(), [])
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_volume_sources"
                                        " WHERE deleted=0").fetchone()[0], 6)
        # Previously unseen 7-13 remain quiet, while 14 is genuinely new.
        self.items = self.products(numbers=range(1, 15))
        self.assertTrue(self.check(1))
        self.assertEqual(self.events(), [("new_volume", 14)])
        self.assertFalse(self.check(1))
        self.assertEqual(self.events(), [("new_volume", 14)])

    def test_work_b_sparse_first_check_is_quiet(self):
        self.prepare((1, 2, 4, 5, 7, 8, 9, 12, 13, 14), owned=15)
        for n in range(1, 16):
            self.slot(n)
        self.assertFalse(self.check())
        self.assertEqual(self.events(), [])
        self.items = self.products(numbers=range(1, 17))
        self.assertTrue(self.check(1))
        self.assertEqual(self.events(), [("new_volume", 16)])

    def test_first_check_without_slots_also_establishes_quiet_baseline(self):
        self.prepare((1, 2))
        self.assertFalse(self.check())
        self.assertEqual(self.events(), [])
        self.items = self.products(numbers=(1, 2, 3))
        self.assertTrue(self.check(1))
        self.assertEqual(self.events(), [("new_volume", 3)])

    def test_any_live_edition_suppresses_new_volume_but_tombstone_does_not(self):
        self.prepare((1,))
        self.check()
        self.slot(2, edition=1)
        self.slot(3, edition=1)
        self.slot(3, edition=1, deleted=True, revision=1)
        self.items = self.products(numbers=(1, 2, 3))
        self.assertTrue(self.check(1))
        self.assertEqual(self.events(), [("new_volume", 3)])

    def test_rebind_retains_old_sources_but_is_quiet_then_notifies(self):
        self.prepare((1, 2))
        self.check()
        self.items = self.products(numbers=(1, 2, 3), publisher="Other")
        candidate = self.bindings.group_kakao(self.items)[0]
        binding = self.ca.binding_row(self.db, "e" * 32, "a", "kakao")
        self.command("bindProvider", workId="a", provider="kakao",
                     externalId=candidate["anchorItemId"], expectedRevision=binding["entity_revision"],
                     config={"version": 1, "query": "던전밥",
                             "groupFingerprint": candidate["groupFingerprint"]})
        self.assertFalse(self.check(1))
        self.assertEqual(self.events(), [])
        self.items = self.products(numbers=(1, 2, 3, 4), publisher="Other")
        self.assertTrue(self.check(2))
        self.assertEqual(self.events(), [("new_volume", 4)])

    def test_live_slot_added_during_fetch_is_read_at_commit(self):
        self.prepare((1,))
        self.check()
        self.items = self.products(numbers=(1, 2, 3))
        self.during_fetch = lambda: self.slot(2)
        self.assertTrue(self.check(1))
        self.assertEqual(self.events(), [("new_volume", 3)])

    def test_same_anchor_changed_group_also_gets_quiet_rebind_baseline(self):
        self.prepare((1, 2))
        self.check()
        binding = self.ca.binding_row(self.db, "e" * 32, "a", "kakao")
        self.items = self.products(numbers=(1, 2, 3), publisher="Other")
        candidate = self.bindings.group_kakao(self.items)[0]
        self.command("bindProvider", workId="a", provider="kakao",
                     externalId=binding["external_id"], expectedRevision=binding["entity_revision"],
                     config={"version": 1, "query": "던전밥",
                             "groupFingerprint": candidate["groupFingerprint"]})
        self.assertFalse(self.check(1))
        self.assertEqual(self.events(), [])
        self.items = self.products(numbers=(1, 2, 3, 4), publisher="Other")
        self.assertTrue(self.check(2))
        self.assertEqual(self.events(), [("new_volume", 4)])

    def test_known_slot_still_notifies_date_and_status_changes(self):
        self.prepare((1,))
        self.check()
        self.items[0]["publicationDate"] = "2026-12-01"
        self.assertTrue(self.check(1))
        self.assertEqual(self.events(), [("release_date_changed", 1), ("release_status_changed", 1)])


if __name__ == "__main__":
    unittest.main()
