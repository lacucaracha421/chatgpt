"""Direct disposable SQLite command tests; no HTTP threads or provider I/O."""
import asyncio
from contextlib import contextmanager
import json
import sqlite3
import unittest
import uuid
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
import authority
import av_person_profile as profile
import collection_authority as ca
import mobile_collections as mobile

LIBRARY = "e" * 32


class PersonProfileTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript(authority.AUTHORITY_DDL)
        ca.startup_db(self.db)
        self.db.execute("INSERT INTO authority_domains VALUES(?,'collections',1,1,0,?,NULL,'2026')",
                        [LIBRARY, "a" * 64])
        self.source = {"source": "stashdb", "name": "Provider", "aliases": [],
                       **dict.fromkeys(profile.PROFILE_FIELDS - {"urls"}), "urls": [],
                       "heightCm": 156, "careerStart": 2021}
        payload = {"id": "p", "displayName": "Person", "nameJa": "日本名", "profile": self.source,
                   "memo": None, "favorite": False, "portrait": None}
        self.db.execute("INSERT INTO collection_authority_people(library_id,person_id,payload) VALUES(?,?,?)",
                        [LIBRARY, "p", ca.encode(payload)])
        self.call("createWork", workId="av", type="av", name="AV", legacyKind=None, fields={}, binding=None)
        self.call("setAvCredits", workId="av", expectedRevision=1, people=[],
                  credits=[{"personId": "p", "role": "performer", "order": 0, "creditName": "Work alias"}])

    def call(self, kind, operation=None, prepared=None, **fields):
        body = {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
                "operationId": operation or str(uuid.uuid4()), "commandType": kind, **fields}
        lib, epoch, version, op, kind, entity = ca.parse_command(body)
        with self.db:
            return ca.apply_command(self.db, library_id=lib, epoch=epoch, contract_version=version,
                                    command_type=kind, operation_id=op, entity=entity, now="2026-10-09T00:00:00Z",
                                    prepared_profile=prepared)

    def person(self):
        return mobile.public_person(self.db, "p", LIBRARY, entity=True)["person"]

    def edit(self, changes, expected=None, **kwargs):
        person = self.person()
        if expected is None:
            expected = {k: {"value": person.get(k) if k in profile.NAME_FIELDS else (person["profile"] or {}).get(k),
                            "overridden": k in person["profileOverrides"]} for k in changes}
        return self.call("setPersonProfileFields", personId="p", changes=changes, expected=expected, **kwargs)

    def refresh(self, source=None, id_="one", revision=None):
        source = self.source if source is None else source
        return self.call("setPersonProfile", personId="p", stashdbId=id_,
                         expectedRevision=self.person()["entityRevision"] if revision is None else revision,
                         prepared={"stashdbId": id_, "profile": source} if id_ else None)

    def test_legacy_source_migrates_lazily_and_plain_shape(self):
        before = mobile.public_person(self.db, "p", LIBRARY)["person"]
        self.assertEqual(self.person()["stashdbProfile"], before["profile"])
        self.assertEqual(self.person()["profileOverrides"], {})
        receipt = self.edit({"heightCm": 160})
        after = mobile.public_person(self.db, "p", LIBRARY)["person"]
        self.assertEqual(set(before), set(after))
        self.assertEqual(after, {**before, "profile": {**before["profile"], "heightCm": 160}})
        self.assertEqual(receipt["person"], self.person())
        self.assertEqual(receipt["entities"]["works"][0]["avPeople"][0]["profileOverrides"], {"heightCm": 160})

    def test_overrides_refresh_reset_and_clear(self):
        self.edit({"heightCm": 160, "cup": None})
        updated = {**self.source, "heightCm": 170, "cup": "F", "waistIn": 24}
        refresh = self.refresh(updated)
        self.assertEqual(refresh["person"]["profile"]["heightCm"], 160)
        self.assertIsNone(refresh["person"]["profile"]["cup"])
        self.assertEqual(refresh["person"]["profile"]["waistIn"], 24)
        self.assertEqual(refresh["person"]["stashdbProfile"], updated)
        reset = self.edit({"heightCm": {"reset": True}})
        self.assertEqual(reset["person"]["profile"]["heightCm"], 170)
        self.assertNotIn("heightCm", reset["person"]["profileOverrides"])
        cleared = self.refresh(id_=None)["person"]
        self.assertIsNone(cleared["stashdbProfile"])
        self.assertIsNone(cleared["stashdbId"])
        self.assertEqual(cleared["profileOverrides"], {"cup": None})
        self.assertIsNone(cleared["profile"]["cup"])
        self.assertIsNone(self.edit({"cup": {"reset": True}})["person"]["profile"])

    def test_attach_refresh_clear_never_change_names(self):
        for changes in ({}, {"displayName": "Manual", "nameJa": "手入力"}):
            if changes:
                self.edit(changes)
            before = self.person()
            row = self.db.execute("SELECT * FROM collection_authority_people").fetchone()
            stored_names = (row["display_name"], row["name_ja"])
            credits = self.db.execute("SELECT av_credits FROM collection_authority_works WHERE work_id='av'").fetchone()[0]
            for source, id_ in ((self.source, "one"),
                                ({**self.source, "name": "Meguri Minoshima"}, "one"),
                                (None, None)):
                with self.subTest(overridden=bool(changes), stashdbId=id_, source=source):
                    person = self.refresh(source, id_)["person"]
                    self.assertEqual((person["displayName"], person["nameJa"]),
                                     (before["displayName"], before["nameJa"]))
                    row = self.db.execute("SELECT * FROM collection_authority_people").fetchone()
                    self.assertEqual((row["display_name"], row["name_ja"]), stored_names)
                    payload = json.loads(row["payload"])
                    self.assertEqual((payload["displayName"], payload["nameJa"]),
                                     (before["displayName"], before["nameJa"]))
                    self.assertEqual(payload.get("profileBaseNames"), before.get("profileBaseNames"))
                    work = ca.av_work_entity(self.db, LIBRARY, ca.work_state(ca.work_row(self.db, LIBRARY, "av")))
                    self.assertEqual(ca.encode(work["avCredits"]), credits)
                    self.assertEqual((work["avPeople"][0]["displayName"], work["avPeople"][0]["nameJa"]),
                                     (before["displayName"], before["nameJa"]))

    def test_base_names_are_captured_on_first_manual_name_change(self):
        self.edit({"heightCm": 160, "nameJa": {"reset": True}})
        self.refresh()
        self.assertNotIn("profileBaseNames", self.person())
        payload = json.loads(self.db.execute("SELECT payload FROM collection_authority_people").fetchone()[0])
        payload.update(displayName="Current server name", nameJa="現在の名前")
        self.db.execute("UPDATE collection_authority_people SET payload=?", [ca.encode(payload)])
        self.edit({"displayName": "Manual"})
        self.assertEqual(self.person()["profileBaseNames"],
                         {"displayName": "Current server name", "nameJa": "現在の名前"})
        self.edit({"nameJa": "手入力"})
        self.refresh({**self.source, "name": "Romanized name"})
        person = self.edit({"displayName": {"reset": True}, "nameJa": {"reset": True}})["person"]
        self.assertEqual((person["displayName"], person["nameJa"]), ("Current server name", "現在の名前"))

    def test_status_advertises_profile_fields_without_writing(self):
        @contextmanager
        def get_db():
            yield self.db

        async def run_inline(fn):
            return fn()

        def require_client(authorization):
            if authorization != "fixture":
                raise HTTPException(401)

        app = FastAPI()
        ca.register(app, get_db, require_client, require_client)
        endpoint = next(route.endpoint for route in app.routes if route.path == ca.PREFIX + "/status")
        with patch.object(ca, "run_in_threadpool", run_inline):
            for active in (True, False):
                if not active:
                    self.db.execute("DELETE FROM authority_domains WHERE domain='collections'")
                self.db.commit()
                before = list(self.db.iterdump())
                status = asyncio.run(endpoint(authorization="fixture"))
                self.assertEqual(status["features"], ["personProfileFields", "kakaoReview"])
                self.assertEqual(status["active"], active)
                self.assertEqual(status["domain"], "collections")
                if active:
                    self.assertEqual(status["libraryId"], LIBRARY)
                    self.assertEqual(status["contractVersion"], 1)
                self.assertEqual(list(self.db.iterdump()), before)
            with self.assertRaises(HTTPException) as cm:
                asyncio.run(endpoint(authorization=None))
            self.assertEqual(cm.exception.status_code, 401)

    def test_explicit_null_links_and_same_value_ownership(self):
        self.assertTrue(self.edit({"heightCm": 156})["changed"])
        self.assertTrue(self.person()["profileOverrides"]["heightCm"] == 156)
        self.edit({"urls": None})
        self.assertEqual(self.person()["profile"]["urls"], [])
        self.assertIsNone(self.person()["profileOverrides"]["urls"])
        self.assertTrue(self.edit({"urls": []})["changed"])
        self.edit({"cup": "  "})
        self.assertIsNone(self.person()["profileOverrides"]["cup"])

    def test_cas_conflict_noop_replay_and_source_state(self):
        expected = {"heightCm": {"value": 156, "overridden": False}}
        op = str(uuid.uuid4())
        receipt = self.edit({"heightCm": 160}, expected, operation=op)
        self.edit({"cup": "E"})  # Independent field does not invalidate height CAS.
        self.assertEqual(self.edit({"heightCm": 160}, expected, operation=op), receipt)
        noop = self.edit({"heightCm": 160}, expected)
        self.assertFalse(noop["changed"])
        self.assertIsNone(noop["changeSequence"])
        for changes, token in (({"heightCm": 170}, expected),
                               ({"heightCm": {"reset": True}}, {"heightCm": {"value": 160, "overridden": False}})):
            with self.assertRaises(HTTPException) as cm:
                self.edit(changes, token)
            self.assertEqual(cm.exception.status_code, 409)
            self.assertEqual(cm.exception.detail["current"]["person"], self.person())
        self.assertFalse(self.edit({"hipIn": {"reset": True}}, {"hipIn": {"value": 1, "overridden": True}})["changed"])
        with self.assertRaises(HTTPException) as cm:
            self.edit({"heightCm": 170}, expected, operation=op)
        self.assertEqual(cm.exception.detail["code"], "operationConflict")

    def test_validation_limits_and_career_pair(self):
        invalid = {"heightCm": [0, 301, True, 155.5], "bandIn": [0, 201], "waistIn": [-1], "hipIn": [201],
                   "cup": ["E" * 21, []], "breastType": ["UNKNOWN", []],
                   "birthDate": ["2000-02-30", "1899", "2000-13"],
                   "careerStart": [1899, 2201, True], "careerEnd": [2020],
                   "displayName": ["a" * 501], "nameJa": ["a" * 501],
                   "urls": [[{"site": "x", "url": "javascript:bad"}],
                            [{"site": "x", "url": "https://u:p@example.com"}],
                            [{"site": "x" * 201, "url": "https://example.com"}],
                            [{"site": "x", "url": "https://example.com/" + "x" * 2000}],
                            [{"site": "x", "url": "https://example.com"}] * 101]}
        for key, values in invalid.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(HTTPException) as cm:
                    self.edit({key: value})
                self.assertEqual(cm.exception.status_code, 422)
        for value in ("2000", "2000-02", "2000-02-29"):
            self.edit({"birthDate": value})
        self.edit({"heightCm": 300, "bandIn": 200, "waistIn": 1, "hipIn": 200, "cup": "E" * 20,
                   "careerStart": 1900, "careerEnd": 2200,
                   "urls": [{"site": "x" * 200, "url": "https://example.com"}] * 100})
        for value in ("NATURAL", "FAKE", "NA"):
            self.edit({"breastType": value})

    def test_names_propagate_without_changing_credit_name(self):
        old_revision = ca.work_state(ca.work_row(self.db, LIBRARY, "av"))["entityRevision"]
        receipt = self.edit({"displayName": "한국 이름", "nameJa": "新しい名前"})
        person = receipt["person"]
        self.assertEqual((person["displayName"], person["nameJa"]), ("한국 이름", "新しい名前"))
        work = receipt["entities"]["works"][0]
        self.assertEqual(work["entityRevision"], old_revision + 1)
        credit = work["avCredits"][0]
        self.assertEqual((credit["name"], credit["nameJa"], credit["creditName"]), ("한국 이름", "新しい名前", "Work alias"))
        row = self.db.execute("SELECT * FROM collection_authority_people").fetchone()
        self.assertEqual((row["display_name"], row["name_ja"]), ("한국 이름", "新しい名前"))
        self.assertEqual(ca.av_person_identity(self.db, LIBRARY, "p", json.loads(row["payload"])), ("한국 이름", "新しい名前"))
        projection = json.loads(self.db.execute("SELECT payload FROM collection_authority_projection WHERE id='av'").fetchone()[0])
        self.assertEqual(projection["av"]["people"][0]["name"], "한국 이름")
        self.refresh()
        self.assertEqual(self.person()["displayName"], "한국 이름")
        reset = self.edit({"displayName": {"reset": True}, "nameJa": {"reset": True}})["person"]
        self.assertEqual((reset["displayName"], reset["nameJa"]), ("Person", "日本名"))
        credit = ca.work_state(ca.work_row(self.db, LIBRARY, "av"))["avCredits"][0]
        self.assertEqual((credit["name"], credit["nameJa"], credit["creditName"]), ("Person", "日本名", "Work alias"))

    def test_person_without_credits_still_receipted(self):
        self.call("setAvCredits", workId="av", expectedRevision=2, credits=[], people=[])
        receipt = self.edit({"cup": "E"})
        self.assertTrue(receipt["changed"])
        self.assertEqual(receipt["entities"], {})
        self.assertEqual(receipt["person"]["entityRevision"], 2)

    def test_missing_person_and_invalid_shapes(self):
        with self.assertRaises(HTTPException) as cm:
            self.call("setPersonProfileFields", personId="missing", changes={"cup": "E"},
                      expected={"cup": {"value": None, "overridden": False}})
        self.assertEqual(cm.exception.status_code, 404)
        for changes, expected in (({}, {}), ({"name": "x"}, {"name": None}),
                                  ({"cup": "E"}, {"cup": None}), ({"cup": "E"}, {}),
                                  ({"cup": {"reset": 1}}, {"cup": {"value": None, "overridden": False}})):
            with self.assertRaises(HTTPException):
                self.edit(changes, expected)

    def test_refresh_masked_source_change_is_not_noop(self):
        self.refresh()
        self.edit({"heightCm": 160})
        before = self.person()
        receipt = self.refresh({**self.source, "heightCm": 180})
        self.assertTrue(receipt["changed"])
        self.assertEqual(receipt["person"]["entityRevision"], before["entityRevision"] + 1)
        self.assertEqual(receipt["person"]["profile"]["heightCm"], 160)
        self.assertEqual(receipt["person"]["stashdbProfile"]["heightCm"], 180)
        self.assertFalse(self.refresh({**self.source, "heightCm": 180}, revision=1)["changed"])
        with self.assertRaises(HTTPException) as cm:
            self.refresh({**self.source, "heightCm": 190}, revision=1)
        self.assertEqual(cm.exception.status_code, 409)

    def test_name_clear_and_reset_are_compatible_strings(self):
        person = self.edit({"displayName": None, "nameJa": None})["person"]
        self.assertEqual(person["displayName"], "")
        self.assertIsNone(person["nameJa"])
        self.assertEqual(person["profileOverrides"], {"displayName": None, "nameJa": None})
        self.refresh()
        self.assertEqual(self.person()["displayName"], "")
        self.assertIsNone(self.person()["nameJa"])
        self.edit({"displayName": {"reset": True}, "nameJa": {"reset": True}})
        self.assertEqual((self.person()["displayName"], self.person()["nameJa"]), ("Person", "日本名"))
        self.refresh({**self.source, "name": "Next provider name"})
        self.assertEqual(self.person()["nameJa"], "日本名")
        self.refresh(id_=None)
        self.assertEqual(self.person()["nameJa"], "日本名")

    def test_staged_identity_without_payload_names_keeps_plain_keys(self):
        row = self.db.execute("SELECT payload FROM collection_authority_people").fetchone()
        payload = json.loads(row[0])
        payload.pop("displayName")
        payload.pop("nameJa")
        self.db.execute("UPDATE collection_authority_people SET payload=?,display_name=NULL,name_ja=NULL", [ca.encode(payload)])
        before = mobile.public_person(self.db, "p", LIBRARY)["person"]
        person = self.edit({"displayName": "Edited", "nameJa": "編集"})["person"]
        self.assertEqual((person["displayName"], person["nameJa"]), ("Edited", "編集"))
        self.assertEqual(set(mobile.public_person(self.db, "p", LIBRARY)["person"]), set(before))
        self.assertEqual(self.edit({"displayName": {"reset": True}})["person"]["displayName"], "Person")
        self.refresh()
        self.assertEqual(set(mobile.public_person(self.db, "p", LIBRARY)["person"]), set(before))

    def test_legacy_float_expected_is_exact_not_revalidated_as_write(self):
        payload = json.loads(self.db.execute("SELECT payload FROM collection_authority_people").fetchone()[0])
        payload["profile"]["heightCm"] = 155.5
        self.db.execute("UPDATE collection_authority_people SET payload=?", [ca.encode(payload)])
        self.assertTrue(self.edit({"heightCm": 156})["changed"])
        with self.assertRaises(HTTPException) as cm:
            self.edit({"heightCm": 157}, {"heightCm": {"value": True, "overridden": True}})
        self.assertEqual(cm.exception.status_code, 422)

    def test_rename_propagates_multiple_roles_trash_and_future_credit(self):
        for id_, lifecycle in (("second", "live"), ("trash", "trashed"), ("gone", "tombstoned")):
            self.call("createWork", workId=id_, type="av", name=id_, legacyKind=None, fields={}, binding=None)
            self.call("setAvCredits", workId=id_, expectedRevision=1, people=[],
                      credits=[{"personId": "p", "role": role, "order": 0, "creditName": role + " alias"}
                               for role in ("performer", "director")])
            self.db.execute("UPDATE collection_authority_works SET lifecycle=? WHERE work_id=?", [lifecycle, id_])
        receipt = self.edit({"displayName": "Renamed"})
        self.assertEqual({w["workId"] for w in receipt["entities"]["works"]}, {"av", "second", "trash"})
        for row in self.db.execute("SELECT * FROM collection_authority_works"):
            for credit in json.loads(row["av_credits"]):
                self.assertEqual(credit["name"], "Renamed")
                self.assertIn("alias", credit["creditName"])
            self.assertEqual(row["entity_revision"], 2 if row["work_id"] == "gone" else 3)
        self.call("createWork", workId="future", type="av", name="future", legacyKind=None, fields={}, binding=None)
        receipt = self.call("setAvCredits", workId="future", expectedRevision=1,
                            people=[{"personId": "p", "displayName": "Stale client name", "nameJa": None}],
                            credits=[{"personId": "p", "role": "performer", "order": 0, "creditName": None}])
        self.assertEqual(receipt["entities"]["works"][0]["avCredits"][0]["name"], "Renamed")

    def test_reset_career_pair_is_atomic(self):
        self.edit({"careerStart": 2010, "careerEnd": 2020})
        before = self.person()
        with self.assertRaises(HTTPException) as cm:
            self.edit({"careerStart": {"reset": True}})
        self.assertEqual(cm.exception.status_code, 422)
        self.assertEqual(self.person(), before)
        self.edit({"careerStart": {"reset": True}, "careerEnd": {"reset": True}})
        self.assertEqual(self.person()["profile"]["careerStart"], 2021)

    def test_total_person_size_bound_rolls_back(self):
        before = self.person()
        with self.assertRaises(HTTPException) as cm:
            self.edit({"urls": [{"site": "x" * 200, "url": "https://example.com/" + "x" * 500}] * 100})
        self.assertEqual(cm.exception.status_code, 413)
        self.assertEqual(self.person(), before)

    def test_other_person_receipts_include_manual_metadata(self):
        self.edit({"heightCm": 160, "displayName": "N" * 500, "nameJa": "J" * 500})
        memo = self.call("setPerson", personId="p", changes={"memo": "Memo"}, expected={"memo": None})
        self.assertEqual(memo["person"]["profileOverrides"]["heightCm"], 160)
        self.assertEqual(memo["person"]["stashdbProfile"], self.source)
        portrait = self.call("setPersonPortrait", personId="p", portrait=None, expectedRevision=1)
        self.assertFalse(portrait["changed"])
        self.assertEqual(portrait["person"], self.person())

    def test_first_edit_without_provider_and_reset(self):
        payload = json.loads(self.db.execute("SELECT payload FROM collection_authority_people").fetchone()[0])
        payload["profile"] = None
        self.db.execute("UPDATE collection_authority_people SET payload=?", [ca.encode(payload)])
        person = self.edit({"birthDate": "2000-02", "heightCm": 160})["person"]
        self.assertIsNone(person["stashdbProfile"])
        self.assertEqual(person["profile"]["birthDate"], "2000-02")
        mobile.PersonProfile.model_validate(person["profile"])
        person = self.edit({"birthDate": {"reset": True}, "heightCm": {"reset": True}})["person"]
        self.assertIsNone(person["profile"])
        self.assertEqual(person["profileOverrides"], {})
