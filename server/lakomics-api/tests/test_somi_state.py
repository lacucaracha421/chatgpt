import sqlite3
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import api_auth
import somi_state
from fastapi import FastAPI
from fastapi.testclient import TestClient

POST = "abcdefghijklmnopqrstuv"
BOOKMARK = dict(bookmarked=True, title="제목", writerHandle="writer", writerName="작가",
                coverKey="a" * 64, postSeconds=123, changedAt=1000)


class SomiTests(unittest.TestCase):
    def setUp(self):
        # Files directly in the temp root also work on Windows sandbox ACLs.
        self.paths = []
        for _ in range(2):
            with tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False) as file:
                path = Path(file.name)
            path.unlink()
            self.paths.append(path)
            self.addCleanup(path.unlink, missing_ok=True)
        self.auth_path, self.state_path = self.paths

        @contextmanager
        def get_db():
            db = sqlite3.connect(self.auth_path)
            try:
                with db:
                    yield db
            finally:
                db.close()

        self.get_db = get_db
        api_auth.startup(get_db)
        app = FastAPI()
        somi_state.register(app, api_auth.client_guard(get_db, "legacy"), self.state_path)
        self.client = TestClient(app)
        self.headers = {"Authorization": "Bearer legacy"}

    def tearDown(self):
        self.client.close()

    def put(self, body, post=POST, kind="bookmarks", headers=None):
        return self.client.put(f"/v1/somi/{kind}/{post}", json=body, headers=self.headers if headers is None else headers)

    def changes(self, since=0, limit=200):
        return self.client.get(f"/v1/somi/state?since={since}&limit={limit}", headers=self.headers).json()

    def test_lww_repeat_stale_and_tombstones(self):
        first = self.put(BOOKMARK).json()
        self.assertEqual(self.put(BOOKMARK).json(), first)
        self.assertEqual(self.put({**BOOKMARK, "changedAt": 999, "bookmarked": False}).json(), first)
        winner = self.put({**BOOKMARK, "changedAt": 1001, "bookmarked": False}).json()
        self.assertEqual(winner["revision"], first["revision"] + 1)
        delta = self.changes(first["revision"])
        self.assertEqual(delta["items"], [winner])
        self.assertFalse(delta["items"][0]["bookmarked"])
        self.assertEqual(self.changes(winner["revision"])["items"], [])

    def test_progress_independent_lww_and_bounded_replay(self):
        bookmark = self.put(BOOKMARK).json()
        progress = self.put(dict(page=4, changedAt=20), kind="progress").json()
        self.assertEqual(self.put(dict(page=1, changedAt=19), kind="progress").json(), progress)
        self.assertEqual(self.put(dict(page=4, changedAt=20), kind="progress").json(), progress)
        first = self.changes(limit=1)
        self.assertEqual(first["items"], [bookmark])
        self.assertTrue(first["hasMore"])
        second = self.changes(first["nextRevision"], 1)
        self.assertEqual(second["items"], [progress])
        self.assertFalse(second["hasMore"])
        self.assertEqual(second["nextRevision"], second["latestRevision"])

    def test_validation_rejects_ids_keys_and_private_fields(self):
        for post in ["short", "é" * 22, "a" * 23]:
            self.assertEqual(self.put(BOOKMARK, post=post).status_code, 422)
        for body in [{**BOOKMARK, "coverKey": "A" * 64}, {**BOOKMARK, "coverKey": "https://example.com"},
                     {**BOOKMARK, "title": "x" * 1025}, {**BOOKMARK, "cookies": "private"},
                     {**BOOKMARK, "changedAt": True}]:
            self.assertEqual(self.put(body).status_code, 422)
        self.assertEqual(self.put({**BOOKMARK, "coverKey": ""}).status_code, 200)
        self.assertEqual(self.put(dict(page=-1, changedAt=5), kind="progress").status_code, 422)

    def test_auth_matches_catalog_roles_and_revocation(self):
        self.assertEqual(self.put(BOOKMARK, headers={}).status_code, 401)
        self.assertFalse(self.state_path.exists())
        self.assertEqual(self.client.get("/v1/somi/state").status_code, 401)
        for role in ["client", "publisher"]:
            with self.get_db() as db:
                identity, token = api_auth.provision_token(db, role)
            headers = {"Authorization": f"Bearer {token}"}
            self.assertEqual(self.put(BOOKMARK, headers=headers).status_code, 200)
            self.assertEqual(self.client.get("/v1/somi/state", headers=headers).status_code, 200)
            with self.get_db() as db:
                api_auth.revoke_token(db, identity)
            self.assertEqual(self.put(BOOKMARK, headers=headers).status_code, 401)
            self.assertEqual(self.client.get("/v1/somi/state", headers=headers).status_code, 401)
