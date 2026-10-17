"""Shared folder pins: per-id merge, auth, folders that no longer exist, and the status signal."""
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api_auth
import folder_pins

PREFIX = folder_pins.PREFIX


class FolderPinsTests(unittest.TestCase):
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
        self.folders = {"a", "b", "c", "d"}
        api_auth.startup(get_db)
        with get_db() as db:
            _, token = api_auth.provision_token(db, "client")
            db.commit()
        self.auth = {"Authorization": "Bearer " + token}
        app = FastAPI()
        folder_pins.register(app, get_db, api_auth.client_guard(get_db, None), lambda db: self.folders)()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def send(self, *commands):
        reply = self.client.post(PREFIX, headers=self.auth, json={"commands": [
            {"op": op, "ids": ids} for op, ids in commands]})
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()

    def read(self):
        reply = self.client.get(PREFIX, headers=self.auth)
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()

    def test_requires_a_client_credential(self):
        self.assertEqual(self.client.get(PREFIX).status_code, 401)
        self.assertEqual(self.client.post(PREFIX, json={"commands": [{"op": "add", "ids": ["a"]}]}).status_code, 401)
        self.assertEqual(self.client.get(PREFIX, headers={"Authorization": "Bearer nope"}).status_code, 401)

    def test_never_written_list_is_revision_zero(self):
        self.assertEqual(self.read(), {"version": 1, "revision": 0, "pinnedIds": []})

    def test_add_remove_order_and_replay(self):
        self.assertEqual(self.send(("add", ["a", "b", "c"]))["pinnedIds"], ["a", "b", "c"])
        self.assertEqual(self.send(("order", ["c", "a"]))["pinnedIds"], ["c", "a", "b"])
        self.assertEqual(self.send(("remove", ["a", "d"]))["pinnedIds"], ["c", "b"])
        # One request applies its commands in order, and an already pinned id keeps its place.
        self.assertEqual(self.send(("add", ["b", "d"]), ("remove", ["c"]))["pinnedIds"], ["b", "d"])
        before = self.read()
        again = self.send(("add", ["b", "d"]), ("remove", ["c"]))
        self.assertEqual(again, before)

    def test_two_devices_merge_instead_of_conflicting(self):
        self.send(("add", ["a", "b"]))
        # The tablet pins c and the PC pins d, both from the same starting list.
        self.send(("add", ["c"]))
        self.send(("add", ["d"]))
        self.assertEqual(self.read()["pinnedIds"], ["a", "b", "c", "d"])
        # A reorder made from a list that missed d keeps d, and does not bring back a removed pin.
        self.send(("remove", ["a"]))
        self.assertEqual(self.send(("order", ["b", "a", "c"]))["pinnedIds"], ["b", "c", "d"])

    def test_revision_and_signal_move_only_on_real_changes(self):
        with self.get_db() as db:
            self.assertEqual(folder_pins.status_signal(db), 0)
        first = self.send(("add", ["a", "b"]))["revision"]
        self.assertEqual(self.send(("add", ["a"]))["revision"], first)
        self.assertEqual(self.send(("remove", ["zzz"]))["revision"], first)
        self.assertEqual(self.send(("order", ["a", "b"]))["revision"], first)
        self.assertEqual(self.send(("order", ["b", "a"]))["revision"], first + 1)
        with self.get_db() as db:
            self.assertEqual(folder_pins.status_signal(db), first + 1)

    def test_deleted_folders_drop_out_and_unknown_folders_are_not_pinned(self):
        self.assertEqual(self.send(("add", ["a", "gone", "b"]))["pinnedIds"], ["a", "b"])
        self.folders = {"a"}
        # Deleted on the server: hidden at once, and removed from storage by the next write.
        self.assertEqual(self.read()["pinnedIds"], ["a"])
        revision = self.read()["revision"]
        self.assertEqual(self.send(("add", ["a"]))["revision"], revision + 1)
        self.folders = {"a", "b"}
        self.assertEqual(self.read()["pinnedIds"], ["a"])
        # With no folder list available nothing is filtered.
        self.folders = set()
        self.assertEqual(self.send(("add", ["zzz"]))["pinnedIds"], ["a", "zzz"])

    def test_conditional_get(self):
        self.send(("add", ["a"]))
        tag = self.client.get(PREFIX, headers=self.auth).headers["ETag"]
        self.assertEqual(self.client.get(PREFIX, headers={**self.auth, "If-None-Match": tag}).status_code, 304)
        self.send(("add", ["b"]))
        self.assertEqual(self.client.get(PREFIX, headers={**self.auth, "If-None-Match": tag}).status_code, 200)


if __name__ == "__main__":
    unittest.main()
