import json
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager, closing
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from notes import register_notes

VAULT = "a" * 64
NOTE = "10000000-0000-4000-8000-000000000001"
AUTH = {"Authorization": "Bearer fixture"}


class NotesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "notes.sqlite"
        @contextmanager
        def db():
            conn = sqlite3.connect(self.path)
            conn.row_factory = sqlite3.Row
            try: yield conn
            finally: conn.close()
        def auth(value):
            if value != AUTH["Authorization"]: raise HTTPException(401)
        app = FastAPI()
        register_notes(app, db, auth)()
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def write(self, revision=0, operation="20000000-0000-4000-8000-000000000001", note=NOTE, cipher="ab"*32):
        return self.client.put(f"/v1/notes/{VAULT}/{note}", headers=AUTH, json={
            "expectedRevision": revision, "operationId": operation,
            "payload": {"version": 1, "nonce": "ab"*12, "ciphertext": cipher}})

    def test_revision_conflicts_and_ambiguous_retry_do_not_overwrite(self):
        first = self.write()
        self.assertEqual(first.status_code, 200)
        self.assertEqual(self.write().json(), first.json())
        self.assertEqual(self.write(cipher="cd"*32).status_code, 409)
        self.assertEqual(self.write(operation="30000000-0000-4000-8000-000000000001").status_code, 409)
        second = self.write(1, "30000000-0000-4000-8000-000000000001", cipher="ef"*32)
        self.assertEqual(second.json()["revision"], 2)
        self.assertEqual(self.write().status_code, 409)

    def test_authenticated_pagination_isolated_vaults_and_opaque_storage(self):
        self.assertEqual(self.client.get(f"/v1/notes/{VAULT}").status_code,401)
        self.write()
        self.write(note="10000000-0000-4000-8000-000000000002")
        first=self.client.get(f"/v1/notes/{VAULT}?limit=1",headers=AUTH).json()
        second=self.client.get(f"/v1/notes/{VAULT}?after={first['nextCursor']}&limit=1",headers=AUTH).json()
        self.assertNotEqual(first["items"][0]["id"],second["items"][0]["id"])
        self.assertIsNone(second["nextCursor"])
        self.assertEqual(self.client.get('/v1/notes/'+"b"*64,headers=AUTH).json()["items"],[])
        with closing(sqlite3.connect(self.path)) as db:
            payload=json.loads(db.execute('SELECT payload FROM notes LIMIT 1').fetchone()[0])
            self.assertEqual(set(payload),{"version","nonce","ciphertext"})

    def test_plaintext_or_malformed_envelopes_are_rejected(self):
        body={"expectedRevision":0,"operationId":NOTE,"payload":{"title":"private","body":"private"}}
        self.assertEqual(self.client.put(f"/v1/notes/{VAULT}/{NOTE}",headers=AUTH,json=body).status_code,422)


if __name__ == '__main__': unittest.main()
