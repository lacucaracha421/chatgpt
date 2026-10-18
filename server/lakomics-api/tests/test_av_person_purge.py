"""deletePerson: only unreferenced people go and the feed says so; the operator script's dry run and apply."""
import json
import sqlite3
import unittest
import uuid

from fastapi import HTTPException
import authority
import av_person_purge as purge
import collection_authority as ca

LIBRARY = "d" * 32


def person(id_, name):
    return dict(personId=id_, displayName=name, nameJa=name + "JA")


def credit(id_, order):
    return dict(personId=id_, role="performer", order=order, creditName=None)


class Fixture:
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript(authority.AUTHORITY_DDL)
        ca.startup_db(self.db)
        self.db.execute("INSERT INTO authority_domains VALUES(?,'collections',1,1,0,?,NULL,'2026')", [LIBRARY, "a" * 64])
        self.db.commit()
        for work in ("live", "trashed"):
            self.call("createWork", workId=work, type="av", name=work, legacyKind=None, fields={}, binding=None)
        self.call("setAvCredits", workId="live", expectedRevision=1,
                  people=[person("used", "Used"), person("gone1", "Gone One"), person("gone2", "Gone Two")],
                  credits=[credit("used", 0), credit("gone1", 1), credit("gone2", 2)])
        self.call("setAvCredits", workId="trashed", expectedRevision=1, people=[person("held", "Held")], credits=[credit("held", 0)])
        self.call("deleteWork", workId="trashed", expectedRevision=2)
        # gone1 and gone2 lose their only credit; used stays on the live work and held on the trashed one.
        self.call("setAvCredits", workId="live", expectedRevision=2, people=[], credits=[credit("used", 0)])

    def call(self, kind, **fields):
        body = {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "operationId": str(uuid.uuid4()),
                "commandType": kind, **fields}
        lib, epoch, version, op, kind, entity = ca.parse_command(body)
        with self.db:
            return ca.apply_command(self.db, library_id=lib, epoch=epoch, contract_version=version,
                                    command_type=kind, operation_id=op, entity=entity, now="2026-10-18T00:00:00Z")

    def revision(self, person_id):
        return self.db.execute("SELECT entity_revision FROM collection_authority_people WHERE person_id=?", [person_id]).fetchone()[0]

    def people(self):
        return {r[0] for r in self.db.execute("SELECT person_id FROM collection_authority_people")}

    def cursor(self):
        return authority.active_domain(self.db, ca.DOMAIN)["cursor"]

    def delete(self, person_id, revision=None):
        return self.call("deletePerson", personId=person_id, expectedRevision=self.revision(person_id) if revision is None else revision)

    def rejected(self, func, code, status):
        with self.assertRaises(HTTPException) as caught:
            func()
        self.assertEqual((caught.exception.detail["code"], caught.exception.status_code), (code, status))


class PersonDeleteTests(Fixture, unittest.TestCase):
    def test_unreferenced_person_is_deleted_and_the_feed_says_so(self):
        result = self.delete("gone1")
        self.assertTrue(result["changed"])
        self.assertEqual(result["entities"], {"deletedPeople": [{"personId": "gone1", "entityRevision": 1}]})
        self.assertEqual(self.people(), {"used", "gone2", "held"})
        change = self.db.execute("SELECT payload FROM collection_authority_changes WHERE sequence=?",
                                 [result["changeSequence"]]).fetchone()[0]
        self.assertEqual(json.loads(change)["entities"], result["entities"])
        self.assertEqual(self.cursor(), result["changeSequence"])

    def test_credited_people_are_refused_on_live_and_trashed_works(self):
        for person_id in ("used", "held"):
            self.rejected(lambda: self.delete(person_id), "personInUse", 409)
        self.assertEqual(self.people(), {"used", "gone1", "gone2", "held"})

    def test_stale_revision_and_unknown_person(self):
        self.rejected(lambda: self.delete("gone1", revision=self.revision("gone1") + 1), "revisionConflict", 409)
        self.rejected(lambda: self.delete("nobody", revision=1), "personNotFound", 404)
        self.assertIn("gone1", self.people())


class PersonPurgeScriptTests(Fixture, unittest.TestCase):
    def run_purge(self, apply):
        db = self.db

        class Opener:
            def __enter__(self):
                return db

            def __exit__(self, *exc):
                return False
        return purge.run(Opener, apply, log=lambda line: None)

    def test_dry_run_lists_names_and_writes_nothing(self):
        cursor = self.cursor()
        summary = self.run_purge(False)
        self.assertEqual((summary["mode"], summary["peopleToDelete"], summary["names"]), ("dry-run", 2, ["Gone One", "Gone Two"]))
        self.assertEqual(self.people(), {"used", "gone1", "gone2", "held"})
        self.assertEqual(self.cursor(), cursor)

    def test_apply_deletes_only_unreferenced_people_and_rerun_is_quiet(self):
        self.assertEqual(self.run_purge(True)["outcomes"], {"deletePerson": 2})
        self.assertEqual(self.people(), {"used", "held"})
        again = self.run_purge(True)
        self.assertEqual((again["peopleToDelete"], again["outcomes"]), (0, {}))
