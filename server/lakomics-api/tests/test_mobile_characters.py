"""Isolated character projections, including the actual Rust export fixture."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.test_capture_api_stub import fake_s3
import app as api_app
from fastapi.testclient import TestClient

AUTH = {"Authorization": "Bearer character-test"}
PREFIX = "/v1/library/characters"


def fixture():
    return {"version": 1, "baseRevision": None,
            "nodes": [{"id": "series:s", "kind": "series", "sourceId": "s", "seriesId": "s", "parentId": None, "name": "시리즈"},
                      {"id": "character:c", "kind": "character", "sourceId": "c", "seriesId": "s", "parentId": "series:s", "name": "캐릭터"}],
            "scopes": [{"nodeId": "series:s", "filter": f, "assetIds": ["b", "a"] if f == "all" else []} for f in ("all", "unclassified", "needs_review")] +
                      [{"nodeId": "character:c", "filter": "all", "assetIds": ["b", "a", "pending"]}]}


class MobileCharactersTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_token = api_app.DB_PATH, api_app.API_TOKEN
        api_app.DB_PATH = Path(self.temp.name) / "fixture.sqlite"
        api_app.API_TOKEN = "character-test"
        api_app.startup()
        api_app.startup_replication()
        api_app.startup_mobile_characters()
        self.client = TestClient(api_app.app)
        for id in ("a", "b"):
            self.asset(id)

    def tearDown(self):
        self.client.close()
        api_app.DB_PATH, api_app.API_TOKEN = self.old_path, self.old_token
        self.temp.cleanup()

    def asset(self, id):
        with api_app.get_db() as db:
            db.execute("INSERT INTO assets(id,kind,object_key,content_type,size_bytes,sha256,collected_at,created_at,updated_at,committed,thumbnail_key) VALUES(?, 'image',?,'image/png',1,?,'2026','2026','2026',1,?)",
                       (id, "private/" + id, id, "private/thumb/" + id))
            db.commit()

    def publish(self, body):
        return self.client.put(PREFIX + "/replica", headers=AUTH, json=body)

    def index(self):
        return self.client.get(PREFIX, headers=AUTH).json()

    def browse(self, revision, **params):
        return self.client.get(PREFIX + "/assets", headers=AUTH, params={"node": "character:c", "revision": revision, **params})

    def test_navigation_order_is_versioned_with_character_projection(self):
        body = fixture()
        body["navigationOrder"] = ["s", "character:c"]
        first = self.publish(body).json()["revision"]
        self.assertEqual(self.index()["navigationOrder"], body["navigationOrder"])
        self.assertEqual(self.client.get(PREFIX + "/status", headers=AUTH).json()["revision"], first)
        self.assertEqual(self.client.get(PREFIX + "/status").status_code, 401)
        body["baseRevision"] = first
        body["navigationOrder"] = ["character:c", "s"]
        self.assertNotEqual(self.publish(body).json()["revision"], first)

    def test_unpublished_empty_auth_and_no_mutation_routes(self):
        self.assertFalse(self.index()["ready"])
        self.assertFalse(self.index()["capabilities"]["write"])
        self.assertEqual(self.client.get(PREFIX).status_code, 401)
        self.assertEqual(self.client.put(PREFIX + "/replica", json=fixture()).status_code, 401)
        self.assertEqual(self.client.get(PREFIX + "/assets", params={"node": "series:s", "revision": "a" * 64}).status_code, 401)
        self.assertEqual(self.client.post(PREFIX, headers=AUTH, json={}).status_code, 405)
        self.assertEqual(self.publish({"version": 1, "baseRevision": None, "nodes": [], "scopes": []}).status_code, 200)
        self.assertTrue(self.index()["ready"])
        self.assertEqual(self.index()["nodes"], [])

    def test_freezes_availability_order_and_counts_with_revision(self):
        with api_app.get_db() as db:
            db.execute("INSERT INTO asset_classifications(asset_id,classification_id,added_at) VALUES('b','s','2026')")
            db.commit()
        rev = self.publish(fixture()).json()["revision"]
        first = self.browse(rev, limit=1).json()
        self.assertEqual([a["id"] for a in first["items"]], ["b"])
        self.assertEqual(first["items"][0]["classification_ids"], ["s"])
        self.assertEqual((first["totalCount"], first["sourceCount"]), (2, 3))
        self.assertNotIn("private/", json.dumps(first))
        self.asset("pending")
        with api_app.get_db() as db:
            db.execute("DELETE FROM asset_classifications WHERE asset_id='b'")
            db.commit()
        self.assertEqual(self.browse(rev).json()["items"][0]["classification_ids"], ["s"])
        second = self.browse(rev, cursor=first["next_cursor"]).json()
        self.assertEqual([a["id"] for a in second["items"]], ["a"])
        self.assertEqual(second["totalCount"], 2)
        body = fixture(); body["baseRevision"] = rev
        new = self.publish(body).json()["revision"]
        self.assertNotEqual(new, rev)
        self.assertEqual(self.browse(rev).status_code, 409)
        self.assertEqual(self.browse(new).json()["totalCount"], 3)

    def test_cas_retry_and_bad_snapshots_preserve_previous(self):
        body = fixture()
        rev = self.publish(body).json()["revision"]
        self.assertEqual(self.publish(body).json()["revision"], rev)
        body["nodes"][0]["name"] = "changed"
        self.assertEqual(self.publish(body).status_code, 409)
        body["baseRevision"] = rev
        self.assertEqual(self.publish(body).status_code, 200)
        current = self.index()["revision"]
        for mutate in (
            lambda b: b["nodes"][0].update(sourcePath="private/path"),
            lambda b: b["nodes"][1].update(parentId="group:missing"),
            lambda b: b["scopes"][-1]["assetIds"].append("a"),
            lambda b: b["scopes"].pop(),
            lambda b: b["nodes"][1].update(sourceId="../bad"),
        ):
            invalid = copy.deepcopy(body); mutate(invalid)
            result = self.publish(invalid)
            self.assertEqual(result.status_code, 422, result.text)
            self.assertNotIn("private/path", result.text)
            self.assertEqual(self.index()["revision"], current)

    def test_cursors_cannot_cross_scope_or_revision(self):
        rev = self.publish(fixture()).json()["revision"]
        cursor = self.browse(rev, limit=1).json()["next_cursor"]
        self.assertEqual(self.browse(rev, cursor=cursor, node="series:s").status_code, 400)
        self.assertEqual(self.browse(rev, cursor="not-json").status_code, 400)
        self.assertEqual(self.browse(rev, node="character:missing").status_code, 404)
        self.assertEqual(self.browse(rev, filter="needs_review").status_code, 404)

    def test_body_limit_without_replacing_snapshot(self):
        rev = self.publish(fixture()).json()["revision"]
        with mock.patch("mobile_characters.MAX_BYTES", 10):
            self.assertEqual(self.publish(fixture()).status_code, 413)
        self.assertEqual(self.index()["revision"], rev)

    def test_index_budget_preserves_android_transport_compatibility(self):
        rev = self.publish(fixture()).json()["revision"]
        body = fixture(); body["baseRevision"] = rev; body["nodes"][0]["name"] = "new name"
        with mock.patch("mobile_characters.MAX_INDEX_BYTES", 10):
            self.assertEqual(self.publish(body).status_code, 413)
        self.assertEqual(self.index()["revision"], rev)

    def test_explicit_series_hero_requires_cloud_availability_and_cannot_be_a_character_field(self):
        body = fixture(); body["nodes"][0]["heroAssetId"] = "pending"
        rev = self.publish(body).json()["revision"]
        self.assertIsNone(self.index()["nodes"][0]["heroAssetId"])
        self.asset("pending"); body["baseRevision"] = rev
        self.assertEqual(self.publish(body).status_code, 200)
        self.assertEqual(self.index()["nodes"][0]["heroAssetId"], "pending")
        body["nodes"][1]["heroAssetId"] = "a"
        self.assertEqual(self.publish(body).status_code, 422)

    def test_shared_rust_projection_fixture(self):
        path = Path(__file__).resolve().parents[3] / "tests/fixtures/mobile-character-projection.json"
        body = json.loads(path.read_text())
        ids = {id for scope in body["scopes"] for id in scope["assetIds"]}
        for id in ids - {"a", "b"}:
            self.asset(id)
        published = self.publish(body)
        self.assertEqual(published.status_code, 200, published.text)
        revision = published.json()["revision"]
        for scope in body["scopes"]:
            response = self.browse(revision, node=scope["nodeId"], filter=scope["filter"]).json()
            self.assertEqual([a["id"] for a in response["items"]], scope["assetIds"])
            self.assertEqual(response["totalCount"], len(scope["assetIds"]))
