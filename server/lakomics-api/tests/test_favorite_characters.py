"""Favourite characters: ordered merges, payload replacement, revisions and limits."""
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api_auth
import favorite_characters

PREFIX = favorite_characters.PREFIX


class FavoriteCharactersTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        path = Path(self.temp.name) / "control.sqlite"

        @contextmanager
        def get_db():
            db = sqlite3.connect(path, timeout=5)
            db.row_factory = sqlite3.Row
            try:
                yield db
            finally:
                db.close()

        self.get_db = get_db
        api_auth.startup(get_db)
        with get_db() as db:
            _, token = api_auth.provision_token(db, "client")
            db.commit()
        self.auth = {"Authorization": "Bearer " + token}
        app = FastAPI()
        favorite_characters.register(app, get_db, api_auth.client_guard(get_db, None))()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def send(self, *commands):
        reply = self.client.post(PREFIX, headers=self.auth, json={"commands": list(commands)})
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()

    def read(self):
        reply = self.client.get(PREFIX, headers=self.auth)
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()

    def test_auth_and_conditional_get(self):
        self.assertEqual(self.client.get(PREFIX).status_code, 401)
        self.assertEqual(self.client.post(PREFIX, json={"commands": [
            {"op": "add", "ids": ["a"]}]}).status_code, 401)
        tag = self.client.get(PREFIX, headers=self.auth).headers["ETag"]
        headers = {**self.auth, "If-None-Match": tag}
        self.assertEqual(self.client.get(PREFIX, headers=headers).status_code, 304)
        self.send({"op": "add", "ids": ["a"]})
        self.assertEqual(self.client.get(PREFIX, headers=headers).status_code, 200)

    def test_add_remove_order_merge_across_devices(self):
        first = self.send({"op": "add", "ids": ["a", "b", "a", "c"]})
        self.assertEqual(first["entries"][0], {
            "characterId": "a", "coverAssetId": None, "coverY": 50,
            "profile": {}, "workIds": [], "extraWorks": []})
        self.send({"op": "add", "ids": ["d"]})
        # A stale device's order keeps a later addition and cannot restore a removal.
        self.send({"op": "remove", "ids": ["a", "unknown"]})
        merged = self.send({"op": "order", "ids": ["c", "a", "c", "b"]})
        self.assertEqual([entry["characterId"] for entry in merged["entries"]], ["c", "b", "d"])
        # Unknown character ids are retained, with commands applied in request order.
        merged = self.send({"op": "add", "ids": ["b", "not-published"]},
                           {"op": "remove", "ids": ["c"]})
        self.assertEqual([entry["characterId"] for entry in merged["entries"]],
                         ["b", "d", "not-published"])

    def test_update_replaces_fields_and_ignores_removed_ids(self):
        payload = {"coverAssetId": "asset_1", "coverY": 25.5,
                   "profile": {"originalName": "Name", "birthMonth": 2, "birthDay": 29,
                               "heightCm": 170.5, "voiceActor": "Actor",
                               "affiliation": "Group", "memo": "Remember"},
                   "workIds": ["collection:work-1", "work.2"], "extraWorks": ["Other work"]}
        first = self.send({"op": "add", "ids": ["a", "b"]},
                          {"op": "update", "id": "a", "set": payload})
        self.assertEqual(first["entries"][0], {"characterId": "a", **payload})
        self.assertEqual(self.send({"op": "add", "ids": ["a"]}), first)
        changed = self.send({"op": "update", "id": "a", "set": {
            "coverAssetId": None, "profile": {"memo": None}, "workIds": [], "extraWorks": ["New"]}},
            {"op": "remove", "ids": ["b"]},
            {"op": "update", "id": "b", "set": payload})
        self.assertEqual(changed["entries"], [{
            "characterId": "a", "coverAssetId": None, "coverY": 25.5,
            "profile": {"memo": None}, "workIds": [], "extraWorks": ["New"]}])
        cleared = self.send({"op": "update", "id": "a", "set": {"profile": {}}})
        self.assertEqual(cleared["entries"][0]["profile"], {})

    def test_no_op_revision_and_status_signal(self):
        self.assertEqual(self.read(), {"version": 1, "revision": 0, "entries": []})
        with self.get_db() as db:
            self.assertEqual(favorite_characters.status_signal(db), 0)
        empty = self.send({"op": "update", "id": "missing", "set": {"coverY": 10}})
        self.assertEqual(empty["revision"], 0)
        first = self.send({"op": "add", "ids": ["a", "b"]})
        self.assertEqual(first["revision"], 1)
        no_op = self.send({"op": "add", "ids": ["a"]},
                          {"op": "remove", "ids": ["unknown"]},
                          {"op": "order", "ids": ["a", "b"]},
                          {"op": "update", "id": "a", "set": {"coverY": 50, "profile": {}}})
        self.assertEqual(no_op, first)
        self.assertEqual(self.send({"op": "add", "ids": ["c"]},
                                   {"op": "remove", "ids": ["c"]}), first)
        changed = self.send({"op": "order", "ids": ["b", "a"]})
        self.assertEqual(changed["revision"], 2)
        with self.get_db() as db:
            self.assertEqual(favorite_characters.status_signal(db), 2)

    def test_create_manual_defaults_replay_and_list_commands(self):
        create = {"op": "create", "id": "manual-new", "name": "  New character  ",
                  "seriesName": "Series"}
        first = self.send({"op": "add", "ids": ["a"]}, create)
        self.assertEqual(first["version"], 1)
        self.assertEqual(first["entries"][1], {
            "characterId": "manual-new", "name": "New character", "seriesName": "Series",
            "coverAssetId": None, "coverY": 50, "profile": {}, "workIds": [], "extraWorks": []})
        self.assertEqual(self.send({**create, "name": "Replay name"}), first)
        ordered = self.send({"op": "order", "ids": ["manual-new", "a"]})
        self.assertEqual([entry["characterId"] for entry in ordered["entries"]], ["manual-new", "a"])
        removed = self.send({"op": "remove", "ids": ["manual-new"]})
        self.assertEqual(removed["entries"], first["entries"][:1])
        with self.get_db() as db:
            self.assertEqual(favorite_characters.status_signal(db), removed["revision"])

    def test_link_keeps_position_and_data_and_replays(self):
        payload = {"coverAssetId": "imported-image", "coverY": 22.5,
                   "profile": {"memo": "Keep me"}, "workIds": ["work:1"], "extraWorks": ["Other"]}
        before = self.send({"op": "add", "ids": ["a"]},
                           {"op": "create", "id": "manual-new", "name": "Name", "seriesName": "Series"},
                           {"op": "update", "id": "manual-new", "set": payload},
                           {"op": "add", "ids": ["b"]})
        link = {"op": "link", "id": "manual-new", "characterId": "linked"}
        linked = self.send(link)
        self.assertEqual(linked["entries"], [before["entries"][0],
                         {"characterId": "linked", **payload}, before["entries"][2]])
        self.assertEqual(linked["revision"], before["revision"] + 1)
        self.assertEqual(self.send(link), linked)

    def test_link_conflict_rolls_back_whole_request(self):
        before = self.send({"op": "add", "ids": ["a"]},
                           {"op": "create", "id": "manual-new", "name": "Name"})
        reply = self.client.post(PREFIX, headers=self.auth, json={"commands": [
            {"op": "update", "id": "a", "set": {"coverY": 10}},
            {"op": "link", "id": "manual-new", "characterId": "a"}]})
        self.assertEqual(reply.status_code, 409, reply.text)
        self.assertEqual(reply.json(), {"detail": {"code": "favoriteCharacterExists"}})
        self.assertEqual(self.read(), before)

    def test_update_manual_names_and_ignore_names_on_asset_entries(self):
        before = self.send({"op": "add", "ids": ["a"]},
                           {"op": "create", "id": "manual-new", "name": "Name"})
        self.assertNotIn("seriesName", before["entries"][1])
        names = {"name": "  Changed  ", "seriesName": "Series"}
        self.assertEqual(self.send({"op": "update", "id": "a", "set": names}), before)
        changed = self.send({"op": "update", "id": "manual-new", "set": names})
        self.assertEqual(changed["entries"][0], before["entries"][0])
        self.assertEqual(changed["entries"][1], {
            **before["entries"][1], "name": "Changed", "seriesName": "Series"})
        self.assertEqual(changed["revision"], before["revision"] + 1)
        cleared = self.send({"op": "update", "id": "manual-new", "set": {"seriesName": ""}})
        self.assertEqual(cleared["entries"][1]["seriesName"], "")

    def test_validation_rejects_invalid_payloads_without_writes(self):
        invalid_commands = [
            {"op": "add", "ids": ["character:invalid"]},
            {"op": "add", "ids": ["manual-new"]},
            {"op": "create", "id": "asset", "name": "Name"},
            {"op": "create", "id": "manual-", "name": "Name"},
            {"op": "create", "id": "manual-" + "x" * 58, "name": "Name"},
            {"op": "create", "id": "manual-new"},
            {"op": "create", "id": "manual-new", "name": "  "},
            {"op": "create", "id": "manual-new", "name": "x" * 121},
            {"op": "create", "id": "manual-new", "name": "Name", "seriesName": "x" * 121},
            {"op": "link", "id": "a", "characterId": "b"},
            {"op": "link", "id": "manual-new", "characterId": "manual-other"},
            {"op": "update", "id": "manual-new", "set": {"name": "  "}},
            {"op": "update", "id": "manual-new", "set": {"name": None}},
            {"op": "update", "id": "a", "set": {"coverAssetId": "bad/id"}},
            {"op": "update", "id": "a", "set": {"coverY": 101}},
            {"op": "update", "id": "a", "set": {"profile": {"birthMonth": 3}}},
            {"op": "update", "id": "a", "set": {"profile": {"nickname": "Unknown field"}}},
            {"op": "update", "id": "a", "set": {"workIds": ["bad/work"]}},
            {"op": "update", "id": "a", "set": {"extraWorks": ["x" * 121]}},
        ]
        for command in invalid_commands:
            with self.subTest(command=command):
                reply = self.client.post(PREFIX, headers=self.auth, json={"commands": [
                    {"op": "add", "ids": ["a"]}, command]})
                self.assertEqual(reply.status_code, 422, reply.text)
        self.assertEqual(self.read()["revision"], 0)

    def test_full_document_rejects_write_atomically(self):
        full = self.send({"op": "add", "ids": [f"c{i}" for i in range(300)]})
        reply = self.client.post(PREFIX, headers=self.auth, json={"commands": [
            {"op": "update", "id": "c0", "set": {"coverY": 10}},
            {"op": "add", "ids": ["overflow"]}]})
        self.assertEqual(reply.status_code, 409, reply.text)
        self.assertEqual(reply.json(), {"detail": {"code": "favoriteCharactersFull"}})
        self.assertEqual(self.read(), full)
        # The cap applies to the final document, as with folder pins.
        replaced = self.send({"op": "add", "ids": ["replacement"]},
                             {"op": "remove", "ids": ["c0"]})
        self.assertEqual(len(replaced["entries"]), 300)
        self.assertEqual(replaced["revision"], full["revision"] + 1)


if __name__ == "__main__":
    unittest.main()
