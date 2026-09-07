"""Isolated replica tests: no real library, storage or provider requests."""
import copy
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.test_capture_api_stub import fake_s3
import app as api_app
from fastapi.testclient import TestClient

AUTH = {"Authorization": "Bearer collections-test"}


def work(id="work", name="작품", type="manga"):
    return {"id": id, "name": name, "type": type, "createdAt": "2026-09-07T00:00:00Z", "updatedAt": "2026-09-07T00:00:00Z", "artworks": [], "volumes": []}


def blob(data=b"image"):
    digest = hashlib.sha256(data).hexdigest()
    return {"sha256": digest, "sizeBytes": len(data), "contentType": "image/webp", "objectKey": "work-artwork/mobile/" + digest}


class MobileCollectionsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_token = api_app.DB_PATH, api_app.API_TOKEN
        api_app.DB_PATH = Path(self.temp.name) / "fixture.sqlite"
        api_app.API_TOKEN = "collections-test"
        api_app.startup()
        api_app.startup_mobile_collections()
        fake_s3.objects.clear()
        self.client = TestClient(api_app.app)

    def tearDown(self):
        self.client.close()
        fake_s3.objects.clear()
        api_app.DB_PATH, api_app.API_TOKEN = self.old_path, self.old_token
        self.temp.cleanup()

    def publish(self, items, revision=None):
        return self.client.put("/v1/collections/replica", headers=AUTH, json={"version": 1, "baseRevision": revision, "collections": items})

    def listing(self, **params):
        return self.client.get("/v1/collections", headers=AUTH, params=params)

    def with_art(self):
        item, media = work(), blob()
        item.update(selectedWorkArtworkId="cover", artworks=[{"id": "cover", "kind": "cover", "selected": True, "thumbnail": media, "original": media}], volumes=[{"id": "volume", "volumeNumber": 2, "editionIndex": 1, "displayLabel": "2권", "coverArtworkId": "cover"}])
        return item, media

    def test_unpublished_differs_from_published_empty(self):
        self.assertFalse(self.listing().json()["ready"])
        self.assertEqual(self.publish([]).status_code, 200)
        self.assertEqual(self.listing().json()["items"], [])
        self.assertTrue(self.listing().json()["ready"])

    def test_every_route_requires_auth(self):
        self.assertEqual(self.client.get("/v1/collections").status_code, 401)
        self.assertEqual(self.client.get("/v1/collections/work").status_code, 401)
        self.assertEqual(self.client.put("/v1/collections/replica", json={}).status_code, 401)
        self.assertEqual(self.client.post("/v1/collections/artworks/prepare", json={k: v for k, v in blob().items() if k != "objectKey"}).status_code, 401)
        self.assertEqual(self.client.post("/v1/collections/work/artworks/cover/media-ticket", json={"variant": "thumbnail"}).status_code, 401)

    def test_private_fields_and_bad_ids_rejected_without_echo(self):
        item = work(); item["sourcePath"] = "C:/private/location"
        result = self.publish([item])
        self.assertEqual(result.status_code, 422)
        self.assertNotIn("private/location", result.text)
        self.assertEqual(self.publish([work("../escape")]).status_code, 422)
        self.assertEqual(self.publish([work(), work()]).status_code, 422)

    def test_prepare_reuses_confirmed_bytes_and_rejects_wrong_lengths(self):
        media = blob()
        request = {k: v for k, v in media.items() if k != "objectKey"}
        first = self.client.post("/v1/collections/artworks/prepare", headers=AUTH, json=request)
        self.assertEqual(first.status_code, 200)
        self.assertTrue(first.json()["uploadUrl"].startswith("https://"))
        fake_s3.objects[media["objectKey"]] = {"body": b"image", "content_type": "image/webp"}
        self.assertIsNone(self.client.post("/v1/collections/artworks/prepare", headers=AUTH, json=request).json()["uploadUrl"])
        request["sizeBytes"] += 1
        self.assertEqual(self.client.post("/v1/collections/artworks/prepare", headers=AUTH, json=request).status_code, 409)

    def test_missing_artwork_cannot_replace_previous_snapshot(self):
        revision = self.publish([work("old")]).json()["revision"]
        item, _ = self.with_art()
        self.assertEqual(self.publish([item], revision).status_code, 409)
        self.assertEqual(self.listing().json()["items"][0]["id"], "old")

    def test_public_detail_and_ticket_keep_artwork_out_of_assets(self):
        item, media = self.with_art()
        fake_s3.objects[media["objectKey"]] = {"body": b"image", "content_type": "image/webp"}
        self.assertEqual(self.publish([item]).status_code, 200)
        detail = self.client.get("/v1/collections/work", headers=AUTH).json()["item"]
        self.assertEqual(detail["volumes"][0]["editionIndex"], 1)
        self.assertTrue(detail["artworks"][0]["originalAvailable"])
        self.assertNotIn("objectKey", str(detail))
        self.assertNotIn("artworks", self.listing().json()["items"][0])
        ticket = self.client.post("/v1/collections/work/artworks/cover/media-ticket", headers=AUTH, json={"variant": "original"})
        self.assertEqual(ticket.status_code, 200)
        self.assertEqual(ticket.json()["size_bytes"], 5)
        self.assertNotIn("object_key", ticket.json())
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM assets").fetchone()[0], 0)
        self.assertEqual(self.client.post("/v1/collections/other/artworks/cover/media-ticket", headers=AUTH, json={"variant": "original"}).status_code, 404)

    def test_stale_publisher_and_stale_page_cannot_mix_snapshots(self):
        revision = self.publish([work("a"), work("b")]).json()["revision"]
        cursor = self.listing(limit=1).json()["nextCursor"]
        self.assertEqual(self.publish([work("c")], revision).status_code, 200)
        self.assertEqual(self.publish([work("d")], revision).status_code, 409)
        self.assertEqual(self.listing(limit=1, cursor=cursor).status_code, 409)
        self.assertEqual(self.listing().json()["items"][0]["id"], "c")

    def test_filters_literal_search_and_manual_showcase_order(self):
        first, second = work("a", "100%"), work("b", "100x", "game")
        first.update(showcase=True, showcaseOrder=2); second.update(showcase=True, showcaseOrder=1)
        self.publish([first, second, work("c", "normal", "movie")])
        self.assertEqual([i["id"] for i in self.listing(q="%").json()["items"]], ["a"])
        self.assertEqual([i["id"] for i in self.listing(showcase=True).json()["items"]], ["b", "a"])
        self.assertEqual([i["id"] for i in self.listing(type="movie").json()["items"]], ["c"])
        cursor = self.listing(limit=1).json()["nextCursor"]
        self.assertEqual(self.listing(limit=1, q="other", cursor=cursor).status_code, 409)
        self.assertEqual(self.listing(cursor="malformed").status_code, 422)

    def test_reference_and_object_key_cannot_escape_collection(self):
        item, media = self.with_art()
        item["artworks"][0]["thumbnail"]["objectKey"] = "backups/library-metadata.sqlite"
        self.assertEqual(self.publish([item]).status_code, 422)
        self.assertEqual(self.publish([{**work(), "selectedWorkArtworkId": "absent"}]).status_code, 422)

    def test_unsupported_image_and_partial_descriptor_fail_validation(self):
        upload = {k: v for k, v in blob().items() if k != "objectKey"}
        upload["contentType"] = "text/html"
        self.assertEqual(self.client.post("/v1/collections/artworks/prepare", headers=AUTH, json=upload).status_code, 422)
        item, _ = self.with_art(); del item["artworks"][0]["thumbnail"]["sha256"]
        self.assertEqual(self.publish([item]).status_code, 422)

    def test_metadata_commit_reuses_verified_immutable_artwork_receipt(self):
        item, media = self.with_art()
        fake_s3.objects[media["objectKey"]] = {"body": b"image", "content_type": "image/webp"}
        self.client.post("/v1/collections/artworks/prepare", headers=AUTH, json={k: v for k, v in media.items() if k != "objectKey"})
        with mock.patch.object(fake_s3, "head_object", side_effect=AssertionError("unnecessary HEAD")):
            self.assertEqual(self.publish([item]).status_code, 200)

    def test_storage_outage_does_not_publish_partial_metadata(self):
        revision = self.publish([work("old")]).json()["revision"]
        item, _ = self.with_art()
        with mock.patch.object(fake_s3, "head_object", side_effect=RuntimeError("private storage details")):
            result = self.publish([item], revision)
        self.assertEqual(result.status_code, 502)
        self.assertNotIn("private storage details", result.text)
        self.assertEqual(self.listing().json()["revision"], revision)


if __name__ == "__main__":
    unittest.main()
