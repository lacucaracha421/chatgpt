"""Merging identities uses the ordinary authority transaction and change feed."""
import json
import sqlite3
import unittest
import uuid

from fastapi import HTTPException
import authority
import collection_authority as ca

LIBRARY = "f" * 32


class PersonMergeTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript(authority.AUTHORITY_DDL)
        ca.startup_db(self.db)
        self.db.execute("INSERT INTO authority_domains VALUES(?,'collections',1,1,0,?,NULL,'2026')", [LIBRARY, "a" * 64])
        self.db.commit()
        for work in ("both", "other", "trash", "keep-only"):
            self.call("createWork", workId=work, type="av", name=work, legacyKind=None, fields={}, binding=None)
        self.call("setAvCredits", workId="both", expectedRevision=1,
                  people=[dict(personId="keep", displayName="Keep", nameJa="日本名"),
                          dict(personId="remove", displayName="Other", nameJa="日本名")],
                  credits=[self.credit("remove", 0), self.credit("keep", 3, "Keep alias")])
        for work, person in (("other", "remove"), ("trash", "remove"), ("keep-only", "keep")):
            self.call("setAvCredits", workId=work, expectedRevision=1, people=[], credits=[self.credit(person, 2)])
        self.call("deleteWork", workId="trash", expectedRevision=2)

    @staticmethod
    def credit(person, order, alias=None):
        return dict(personId=person, role="performer", order=order, creditName=alias)

    def call(self, command, operation=None, **fields):
        body = dict(libraryId=LIBRARY, epoch=1, contractVersion=1, operationId=operation or str(uuid.uuid4()), commandType=command, **fields)
        lib, epoch, version, op, kind, entity = ca.parse_command(body)
        with self.db:
            return ca.apply_command(self.db, library_id=lib, epoch=epoch, contract_version=version,
                                    operation_id=op, command_type=kind, entity=entity, now="2026-10-28")

    def merge(self, **fields):
        return self.call("mergePeople", **{**dict(personId="keep", removePersonId="remove", expectedRevision=1, expectedRemoveRevision=1), **fields})

    def payload(self, person, **changes):
        row = self.db.execute("SELECT payload FROM collection_authority_people WHERE person_id=?", [person]).fetchone()
        value = {**json.loads(row[0]), **changes}
        with self.db:
            self.db.execute("UPDATE collection_authority_people SET payload=? WHERE person_id=?", [ca.encode(value), person])

    def test_moves_and_deduplicates_live_and_trashed_credits_and_publishes_deletion(self):
        before = {r["work_id"]: r["entity_revision"] for r in self.db.execute("SELECT * FROM collection_authority_works")}
        receipt = self.merge()
        self.assertTrue(receipt["changed"])
        self.assertEqual(receipt["person"]["entityRevision"], 2)
        self.assertEqual(receipt["person"]["creditWorkCount"], 4)
        self.assertEqual(receipt["entities"]["deletedPeople"], [dict(personId="remove", entityRevision=1)])
        self.assertIsNone(self.db.execute("SELECT 1 FROM collection_authority_people WHERE person_id='remove'").fetchone())
        works = receipt["entities"]["works"]
        self.assertEqual({w["workId"] for w in works}, set(before))
        for work in works:
            self.assertEqual(work["entityRevision"], before[work["workId"]] + 1)
            self.assertEqual(len(work["avCredits"]), 1)
            credit = work["avCredits"][0]
            self.assertEqual(credit["personId"], "keep")
            if work["workId"] == "both":
                self.assertEqual((credit["role"], credit["order"], credit["creditName"]), ("performer", 3, "Keep alias"))
            if work["workId"] == "trash":
                self.assertEqual(work["lifecycle"], "trashed")
        feed = self.db.execute("SELECT payload FROM collection_authority_changes WHERE sequence=?", [receipt["changeSequence"]]).fetchone()[0]
        self.assertEqual(json.loads(feed)["entities"], receipt["entities"])

    def test_fills_empty_fields_preserves_owned_values_and_copies_portrait(self):
        self.payload("keep", memo="Keep memo", profile={"heightCm": 160, "cup": None}, profileOverrides={"cup": None})
        self.payload("remove", memo="Other memo", favorite=True, profile={"heightCm": 170, "cup": "F", "birthDate": "1999"}, profileOverrides={"birthDate": "2000"}, portrait={"source": "cover"})
        selection = dict(kind="crop", artworkId="cover", rect=dict(x=0, y=0, w=0.5, h=0.5))
        with self.db:
            self.db.execute("UPDATE collection_authority_people SET portrait_selection=? WHERE person_id='remove'", [ca.encode(selection)])
        kept = self.merge()["person"]
        self.assertEqual(kept["memo"], "Keep memo")
        self.assertTrue(kept["favorite"])
        self.assertEqual(kept["profile"]["heightCm"], 160)
        self.assertIsNone(kept["profile"]["cup"])
        self.assertEqual(kept["profile"]["birthDate"], "2000")
        self.assertEqual(kept["profileOverrides"], {"cup": None, "birthDate": "2000"})
        self.assertEqual(kept["portraitSelection"], selection)
        self.assertEqual(kept["displayName"], "Keep")

    def test_fills_memo_and_japanese_name_but_preserves_manual_clear(self):
        with self.db:
            self.db.execute("UPDATE collection_authority_people SET name_ja=NULL WHERE person_id='keep'")
        self.payload("keep", nameJa=None)
        self.payload("remove", memo="Other memo")
        kept = self.merge()["person"]
        self.assertEqual((kept["nameJa"], kept["memo"]), ("日本名", "Other memo"))

    def test_guards_both_revisions_and_replays_original_receipt(self):
        for changed in (dict(expectedRevision=2), dict(expectedRemoveRevision=2)):
            with self.assertRaises(HTTPException) as caught:
                self.merge(**changed)
            self.assertEqual(caught.exception.detail["code"], "revisionConflict")
            self.assertEqual(self.db.execute("SELECT COUNT(*) FROM collection_authority_people").fetchone()[0], 2)
        op = str(uuid.uuid4())
        first = self.merge(operation=op)
        self.assertEqual(self.merge(operation=op), first)
        with self.assertRaises(HTTPException) as caught:
            self.merge(operation=op, expectedRevision=2)
        self.assertEqual(caught.exception.detail["code"], "operationConflict")

    def test_manual_name_clear_and_selected_portrait_survive(self):
        self.payload("keep", nameJa=None, profileOverrides={"nameJa": None},
                     profileBaseNames={"displayName": "Keep", "nameJa": "Original"})
        selection = dict(kind="crop", artworkId="kept-cover", rect=dict(x=0, y=0, w=0.5, h=0.5))
        other = {**selection, "artworkId": "other-cover"}
        with self.db:
            for person, portrait in (("keep", selection), ("remove", other)):
                self.db.execute("UPDATE collection_authority_people SET portrait_selection=? WHERE person_id=?", [ca.encode(portrait), person])
        kept = self.merge()["person"]
        self.assertIsNone(kept["nameJa"])
        self.assertEqual(kept["portraitSelection"], selection)

    def test_transfers_image_ownership_before_deleting_the_source_person(self):
        import home_publications
        import mobile_collections
        home_publications.startup_db(self.db)
        self.db.execute("CREATE TABLE mobile_collection_artwork (sha256 TEXT PRIMARY KEY,size_bytes INTEGER,content_type TEXT)")
        image = dict(sha256="a" * 64, sizeBytes=100, contentType="image/jpeg", width=100, height=100)
        self.db.execute("INSERT INTO mobile_collection_artwork VALUES(?,?,?)", [image["sha256"], 100, "image/jpeg"])
        self.payload("remove", portrait={"source": "commons", "author": "Author"})
        with self.db:
            self.db.execute("UPDATE collection_authority_people SET portrait_image=? WHERE person_id='remove'", [ca.encode(image)])
        kept = self.merge()["person"]
        self.assertEqual(kept["portraitImage"], image)
        self.assertEqual(kept["portraitSelection"]["kind"], "image")
        self.assertEqual(kept["portraitSelection"]["attribution"]["author"], "Author")
        refs = self.db.execute("SELECT sha256 FROM home_cover_refs WHERE owner=?", [mobile_collections.PORTRAIT_OWNER]).fetchall()
        self.assertEqual([r[0] for r in refs], [image["sha256"]])

