"""Offline renumbering regressions through real planner and authority batches."""
import copy
import unittest

from tests import test_kakao_bind_core as core
from tests import test_kakao_first_check as first


def renumber(items, numbers, new_items=()):
    moved = copy.deepcopy(items)
    for item, number in zip(moved, numbers):
        item.update(volumeNumber=number, title=f"{item['baseTitle']} {number}")
    return moved + list(new_items)


class RenumberingFixtures:
    setUp = core.CoreTests.setUp
    tearDown = core.CoreTests.tearDown
    command = core.CoreTests.command
    create = core.CoreTests.create
    connection = core.CoreTests.connection
    products = core.CoreTests.products
    fetch = core.CoreTests.fetch
    choice = core.CoreTests.choice
    submit = core.CoreTests.submit
    row = core.CoreTests.row

    def sources(self):
        return [(r["volume_number"], r["provider_item_id"]) for r in self.db.execute(
            "SELECT * FROM collection_authority_volume_sources WHERE work_id='a'"
            " AND deleted=0 ORDER BY volume_number")]

    def protect_slots(self):
        self.command("upsertVolume", workId="a", volumeId="special-edition", volumeNumber=31,
                     editionIndex=1, sortOrder=99, displayLabel="special", coverArtworkId=None,
                     sourceProvider="mangadex", sourceCoverId="special-cover", deleted=False,
                     expectedRevision=0)
        for row in self.db.execute("SELECT * FROM collection_authority_volumes WHERE work_id='a'").fetchall():
            self.command("upsertVolume", workId="a", volumeId=row["volume_id"],
                         volumeNumber=row["volume_number"], editionIndex=row["edition_index"],
                         sortOrder=42, displayLabel="manual", coverArtworkId=None,
                         sourceProvider="mangadex", sourceCoverId="manual-cover", deleted=False,
                         expectedRevision=row["entity_revision"])
        self.command("setVolumeOwnership", workId="a", volumeNumber=31, editionIndex=1,
                     physical=True, digital=True, expectedRevision=0)
        return self.preserved_rows()

    def preserved_rows(self):
        return {table: [dict(row) for row in self.db.execute(
            f"SELECT * FROM {table} WHERE work_id='a' ORDER BY rowid")]
            for table in ("collection_authority_volumes", "collection_authority_ownership")}

    def assert_preserved(self, before):
        after = self.preserved_rows()
        for table, rows in before.items():
            for row in rows:
                self.assertIn(row, after[table])


class RefreshRenumberingTests(RenumberingFixtures, unittest.TestCase):
    prepare = first.FirstCheckTests.prepare
    slot = first.FirstCheckTests.slot
    check = first.FirstCheckTests.check
    events = first.FirstCheckTests.events

    def scenario(self, initial, next_numbers, new=False):
        self.prepare(initial, owned=31)
        self.assertFalse(self.check())
        before = self.protect_slots()
        self.items = renumber(self.items, next_numbers, self.products(numbers=(32,)) if new else ())
        expected = sorted((item["volumeNumber"], item["itemId"]) for item in self.items)
        self.assertEqual(self.check(1), new)
        self.assertEqual(self.sources(), expected)
        self.assertEqual(self.events(), [("new_volume", 32)] if new else [])
        self.assert_preserved(before)
        self.assertFalse(self.check(2))
        self.assertEqual(self.events(), [("new_volume", 32)] if new else [])

    def test_31_to_30(self):
        self.scenario((31,), (30,))

    def test_two_products_swap(self):
        self.scenario((30, 31), (31, 30))

    def test_move_plus_new_volume(self):
        self.scenario((31,), (30,), new=True)

    def test_other_work_conflict_rolls_back_retirement(self):
        self.prepare((31,), owned=31)
        self.check()
        new = self.products(numbers=(32,))[0]
        self.command("upsertVolumeSource", workId="b", provider="kakao", deleted=False,
                     expectedRevision=0, **self.rc.source_row(new))
        before = self.sources()
        self.items = renumber(self.items, (30,), (new,))
        with self.assertRaises(core.HTTPError) as error:
            self.check(1)
        self.assertEqual(error.exception.detail["code"], "providerIdentityTaken")
        self.assertEqual(self.sources(), before)
        self.assertEqual(self.events(), [])


class BindRenumberingTests(RenumberingFixtures, unittest.TestCase):
    def scenario(self, initial, next_numbers, new=False):
        self.items = self.products(numbers=initial)
        request = self.submit()
        self.worker.execute(request["requestId"])
        self.assertEqual(self.row(request["requestId"])["state"], "applied")
        before = self.protect_slots()
        self.items = renumber(self.items, next_numbers, self.products(numbers=(32,)) if new else ())
        request = self.submit()
        self.worker.execute(request["requestId"])
        self.assertEqual(self.row(request["requestId"])["state"], "applied")
        self.assertEqual(self.sources(), sorted((item["volumeNumber"], item["itemId"]) for item in self.items))
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_release_events").fetchone()[0], 0)
        self.assert_preserved(before)
        before_replay = list(self.db.iterdump())
        self.worker.execute(request["requestId"])
        self.assertEqual(list(self.db.iterdump()), before_replay)

    def test_31_to_30(self):
        self.scenario((31,), (30,))

    def test_two_products_swap(self):
        self.scenario((30, 31), (31, 30))

    def test_move_plus_new_volume(self):
        self.scenario((31,), (30,), new=True)


class RangeCleanupTests(RenumberingFixtures, unittest.TestCase):
    def test_phantom_blood_range_change_refresh_and_same_group_rebind(self):
        for action in ("refresh", "rebind"):
            with self.subTest(action=action):
                if action == "rebind":
                    self.tearDown()
                    self.setUp()
                self.items = self.products(name="팬텀 블러드", numbers=range(1, 81))
                choice = self.choice()
                request = self.submit(choice=choice)
                self.worker.execute(request["requestId"])
                self.assertEqual(len(self.sources()), 80)
                # Keep an owned slot, a source cover, a custom label and another edition.
                self.command("setVolumeOwnership", workId="a", volumeNumber=7, editionIndex=0,
                             physical=True, digital=False, expectedRevision=0)
                self.command("setVolumeOwnership", workId="a", volumeNumber=8, editionIndex=0,
                             physical=False, digital=True, expectedRevision=0)
                for number, label, provider, cover in ((9, "9", "mangadex", "jp-cover"),
                                                     (10, "Special", None, None)):
                    row = self.db.execute("SELECT * FROM collection_authority_volumes WHERE work_id='a'"
                                          " AND volume_number=?", (number,)).fetchone()
                    self.command("upsertVolume", workId="a", volumeId=row["volume_id"], volumeNumber=number,
                                 editionIndex=0, sortOrder=number, displayLabel=label, coverArtworkId=None,
                                 sourceProvider=provider, sourceCoverId=cover, deleted=False,
                                 expectedRevision=row["entity_revision"])
                self.command("upsertVolume", workId="a", volumeId="other-edition", volumeNumber=11,
                             editionIndex=1, sortOrder=11, displayLabel=None, coverArtworkId=None,
                             sourceProvider=None, sourceCoverId=None, deleted=False, expectedRevision=0)
                self.command("setVolumeRange", workId="a", minVolume=1, maxVolume=5,
                             hideConnectionPrompt=False, restartNumbering=True,
                             expectedRange={"minVolume": None, "maxVolume": None, "hideConnectionPrompt": False},
                             expectedRevision=None)
                if action == "rebind":
                    request = self.submit(choice=choice)
                    self.assertEqual(request["state"], "pending")
                    self.worker.execute(request["requestId"])
                    self.assertEqual(self.row(request["requestId"])["state"], "applied")
                else:
                    self.rc.startup_db(self.db)
                    self.db.commit()
                    checker = self.rc.Worker(self.connection)
                    self.assertFalse(checker.check_work("a", core.NOW + core.datetime.timedelta(days=1)))
                self.assertEqual(self.sources(), [(n, self.items[n-1]["itemId"]) for n in range(1, 6)])
                retired = self.db.execute("SELECT volume_number FROM collection_authority_volume_sources"
                                          " WHERE work_id='a' AND deleted=1 ORDER BY volume_number").fetchall()
                self.assertEqual([r[0] for r in retired], list(range(6, 81)))
                slots = self.db.execute("SELECT volume_number,edition_index FROM collection_authority_volumes"
                                        " WHERE work_id='a' AND deleted=0 ORDER BY volume_number").fetchall()
                self.assertEqual([tuple(r) for r in slots],
                                 [(n, 0) for n in (1, 2, 3, 4, 5, 7, 8, 9, 10)] + [(11, 1)])
                self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_volumes"
                                                 " WHERE work_id='a' AND deleted=1").fetchone()[0], 71)


if __name__ == "__main__":
    unittest.main()
