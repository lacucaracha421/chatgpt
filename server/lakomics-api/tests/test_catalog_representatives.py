"""Tablet representative-edition choices (parity U23): republished at once, applied by the PC."""
import json
import sqlite3
import sys
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import mobile_catalog_replica as replica
from mobile_catalog import register_mobile_catalog
from test_mobile_catalog import fixture_projection

CLIENT = {"Authorization": "Bearer client"}
PUBLISHER = {"Authorization": "Bearer publisher"}
ROUTE = "/v1/mobile-catalog/representatives"


class CatalogRepresentativeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

        @contextmanager
        def get_db():
            db = sqlite3.connect(self.root / "control.sqlite")
            db.row_factory = sqlite3.Row
            try:
                yield db
            finally:
                db.close()

        def client(value):
            if value not in (CLIENT["Authorization"], PUBLISHER["Authorization"]):
                raise HTTPException(401)

        def publisher(value):
            if value != PUBLISHER["Authorization"]:
                raise HTTPException(403)

        self.get_db = get_db
        self.app = FastAPI()
        register_mobile_catalog(self.app, get_db, client, lambda: self.root / "artifacts", lambda: "secret",
                                require_client=client, require_publisher=publisher)()
        self.client = TestClient(self.app)
        self.data, self.digest, self.users = fixture_projection()

    def tearDown(self):
        self.client.close()
        thread = self.app.state.catalog_duplicate_index.thread
        if thread is not None:
            thread.join(timeout=5)
        self.temp.cleanup()

    def publish(self, base=None, users=None):
        uploaded = self.client.put("/v1/mobile-catalog/replicas/" + self.digest, headers=PUBLISHER, content=self.data)
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        return self.client.put("/v1/mobile-catalog/publication", headers=PUBLISHER, json={
            "version": 1, "baseRevision": base, "contentDigest": self.digest,
            "userSnapshot": users if users is not None else self.users})

    def editions(self, handle):
        page = self.client.get("/v1/mobile-catalog/search", headers=CLIENT, params={"language": "all"}).json()
        response = self.client.get(f"/v1/mobile-catalog/groups/kHentai/{handle}/editions", headers=CLIENT,
                                   params={"context": page["context"]})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json(), page

    def choose(self, handle, selected, operation=None):
        return self.client.post(ROUTE, headers=CLIENT, json={
            "version": 1, "operationId": operation or str(uuid.uuid4()), "groupId": handle,
            "selectedProviderWorkId": selected})

    def test_tablet_choice_is_published_at_once_and_waits_for_the_pc(self):
        first = self.publish().json()
        before, page = self.editions("g6")
        self.assertIsNone(before["selectedProviderWorkId"])
        self.assertEqual(next(i for i in page["items"] if i["groupId"] == "g6")["providerWorkId"], "6")
        self.assertFalse(before["representativePending"])

        operation = str(uuid.uuid4())
        chosen = self.choose("g6", "7", operation)
        self.assertEqual(chosen.status_code, 200, chosen.text)
        self.assertNotEqual(chosen.json()["publicationRevision"], first["publicationRevision"])
        after, page = self.editions("g6")
        self.assertEqual(after["selectedProviderWorkId"], "7")
        self.assertTrue(after["representativePending"])
        # The alias handle of the same group reports the same choice.
        self.assertTrue(self.editions("alias7")[0]["representativePending"])
        group = next(item for item in page["items"] if item["groupId"] == "g6")
        self.assertEqual(group["providerWorkId"], "7")
        # Only the preference changed; bookmarks and visibility stay the PC's.
        with self.get_db() as db:
            users = json.loads(db.execute("SELECT payload FROM mobile_catalog_users WHERE revision=?",
                                          [replica.current(db)["user_revision"]]).fetchone()[0])
        for key in ("bookmarks", "hiddenCategories", "blockedTags", "decisions"):
            self.assertEqual(users[key], self.users[key])
        self.assertIn(["kHentai", "6", "7", 2], users["preferences"])

        # A replay is idempotent; reusing the id for other content is refused.
        self.assertEqual(self.choose("g6", "7", operation).json(), chosen.json())
        self.assertEqual(self.choose("g6", "6", operation).status_code, 409)

        feed = self.client.get(ROUTE + "/pending", headers=PUBLISHER).json()
        self.assertEqual([(i["groupId"], i["anchorWorkId"], i["selectedProviderWorkId"]) for i in feed["items"]],
                         [("g6", "6", "7")])
        sequence = feed["items"][0]["sequence"]
        self.assertEqual(self.client.post(ROUTE + "/acknowledge", headers=PUBLISHER,
                                          json={"version": 1, "through": sequence}).status_code, 200)
        self.assertEqual(self.client.get(ROUTE + "/pending", headers=PUBLISHER).json()["items"], [])
        self.assertFalse(self.editions("g6")[0]["representativePending"])

        # Back to automatic selection.
        self.assertEqual(self.choose("g6", None).status_code, 200)
        self.assertIsNone(self.editions("g6")[0]["selectedProviderWorkId"])

    def test_a_stale_pc_publication_cannot_drop_a_tablet_choice(self):
        first = self.publish().json()
        self.assertEqual(self.choose("g6", "7").status_code, 200)
        stale = self.publish(base=first["publicationRevision"])
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(self.editions("g6")[0]["selectedProviderWorkId"], "7")

    def test_unknown_groups_foreign_editions_and_roles_are_refused(self):
        self.publish()
        self.assertEqual(self.choose("missing", "6").status_code, 404)
        self.assertEqual(self.choose("g6", "1").status_code, 422)
        self.assertEqual(self.client.post(ROUTE, json={"version": 1, "operationId": str(uuid.uuid4()),
                                                       "groupId": "g6", "selectedProviderWorkId": "6"}).status_code, 401)
        self.assertEqual(self.client.get(ROUTE + "/pending", headers=CLIENT).status_code, 403)
        self.assertEqual(self.client.post(ROUTE + "/acknowledge", headers=CLIENT,
                                          json={"version": 1, "through": 0}).status_code, 403)
        self.assertEqual(self.client.post(ROUTE + "/acknowledge", headers=PUBLISHER,
                                          json={"version": 1, "through": 5}).status_code, 409)

    def test_choosing_the_current_representative_changes_nothing(self):
        first = self.publish().json()
        # Group g1 already shows work 2 (the PC's own preference).
        unchanged = self.choose("g1", "2").json()
        self.assertIsNone(unchanged["sequence"])
        self.assertEqual(unchanged["publicationRevision"], first["publicationRevision"])
        self.assertEqual(self.client.get(ROUTE + "/pending", headers=PUBLISHER).json()["items"], [])


if __name__ == "__main__":
    unittest.main()
