"""Image translations stay optional and travel with captures and promoted Assets."""
import hashlib
import json
from unittest import mock

from tests.test_asset_authority import AssetAuthorityFixture, api_app, LIBRARY
from tests import test_capture_thumbnail_wake
from capture_store import StoredMedia
import asset_authority
import capture_routes
import library_assets

LINES = [{"original": "hello", "korean": "안녕", "box": {"x0": 0, "y0": 1, "x1": 1000, "y1": 900}}]
CAPTURE = {"source_url": "https://x.com/example/status/123/photo/1",
           "media_url": "https://pbs.twimg.com/media/example.png",
           "classification_id": "folder", "source": "x"}


class CaptureImageTextTests(AssetAuthorityFixture):
    def create(self, **changes):
        with mock.patch.object(api_app, "fetch_media_to_r2", return_value=StoredMedia("image/png", 5, "a" * 64)):
            return self.client.post("/v1/captures", headers=self.admin, json={**CAPTURE, **changes})

    def test_capture_and_pending_keep_lines(self):
        response = self.create(image_text=LINES)
        self.assertEqual(response.status_code, 200, response.text)
        capture_id = response.json()["capture"]["id"]
        with api_app.get_db() as db:
            self.assertEqual(json.loads(db.execute("SELECT payload FROM capture_image_text WHERE capture_id=?", [capture_id]).fetchone()[0]), LINES)
        pending = self.client.get("/v1/captures/pending", headers=self.admin).json()["captures"]
        self.assertEqual(pending[0]["image_text"], LINES)
        self.assertEqual(self.client.get("/v1/library/assets/missing/image-text", headers=self.admin).status_code, 404)
        self.assertEqual(self.client.get("/v1/library/assets/missing/image-text").status_code, 401)

    def test_invalid_lines_do_not_reject_capture(self):
        bad = [None, {}, {"original": 4, "korean": "bad"}, {"original": "", "korean": " "},
               {"original": "x" * 801, "korean": "bad"}, {"original": "", "korean": "k" * 801},
               {**LINES[0], "box": {"x0": True, "y0": 0, "x1": 10, "y1": 10}},
               {**LINES[0], "box": {"x0": 0, "y0": 0, "x1": 0, "y1": 10}},
               {**LINES[0], "box": {"x0": -1, "y0": 0, "x1": 10, "y1": 10}},
               {**LINES[0], "box": {"x0": 0.5, "y0": 0, "x1": 10, "y1": 10}}]
        response = self.create(image_text=bad + LINES * 65)
        self.assertEqual(response.status_code, 200, response.text)
        with api_app.get_db() as db:
            self.assertEqual(json.loads(db.execute("SELECT payload FROM capture_image_text").fetchone()[0]), LINES * 60)

    def test_duplicate_replaces_and_empty_does_not_erase(self):
        self.create(image_text=LINES)
        latest = [{"original": "new", "korean": "새 번역"}]
        response = self.create(image_text=latest)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["created"])
        for value in [None, [], {}, [{"original": "bad", "korean": ""}]]:
            self.assertEqual(self.create(image_text=value).status_code, 200)
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM captures").fetchone()[0], 1)
            self.assertEqual(json.loads(db.execute("SELECT payload FROM capture_image_text").fetchone()[0]), latest)

    def test_ordinary_save_omits_pending_text(self):
        self.assertEqual(self.create().status_code, 200)
        pending = self.client.get("/v1/captures/pending", headers=self.admin).json()["captures"]
        self.assertNotIn("image_text", pending[0])

    def test_models_trim_and_validate_strictly(self):
        line = capture_routes.ImageTextLine.model_validate({"original": " hello ", "korean": " 안녕 "})
        self.assertEqual(line.original, "hello")
        self.assertEqual(line.korean, "안녕")

    def test_startup_is_idempotent(self):
        self.create(image_text=LINES)
        api_app.startup()
        api_app.startup_captures()
        with api_app.get_db() as db:
            self.assertEqual(json.loads(db.execute("SELECT payload FROM capture_image_text").fetchone()[0]), LINES)


class PromotedImageTextTests(test_capture_thumbnail_wake.CaptureThumbnailWakeTests):
    def test_promoted_asset_route_flags_and_duplicate_replace(self):
        response = self.create(image_text=LINES)
        self.assertEqual(response.status_code, 200, response.text)
        capture_id = response.json()["capture"]["id"]
        with api_app.get_db() as db:
            asset_id = db.execute("SELECT asset_id FROM asset_authority_capture_map WHERE capture_id=?", [capture_id]).fetchone()[0]
            text = db.execute("SELECT payload,digest FROM asset_image_text WHERE asset_id=?", [asset_id]).fetchone()
            self.assertEqual(json.loads(text[0]), LINES)
            self.assertEqual(text[1], hashlib.sha256(text[0].encode()).hexdigest())
            self.assertTrue(asset_authority.state_projection(asset_authority.state_row(db, LIBRARY, asset_id), asset_id, db)["hasImageText"])
            row = db.execute("SELECT * FROM assets WHERE id=?", [asset_id]).fetchone()
            self.assertTrue(library_assets.mobile_asset_item(row)["has_image_text"])
        path = f"/v1/library/assets/{asset_id}/image-text"
        self.assertEqual(self.client.get(path, headers=self.admin).json(), {"lines": LINES, "digest": text[1]})
        items = self.client.get("/v1/library/assets", headers=self.admin).json()["items"]
        self.assertTrue(items[0]["has_image_text"])
        generation = self.client.get("/v1/library/list-generation", headers=self.admin).json()["generation"]
        latest = [{"original": "new", "korean": "새 번역"}]
        self.assertFalse(self.create(image_text=latest).json()["created"])
        self.assertEqual(self.client.get(path, headers=self.admin).json()["lines"], latest)
        self.assertNotEqual(self.client.get(path, headers=self.admin).json()["digest"], text[1])
        self.assertNotEqual(self.client.get("/v1/library/list-generation", headers=self.admin).json()["generation"], generation)
        with api_app.get_db() as db:
            self.assertEqual(json.loads(db.execute("SELECT payload FROM capture_image_text").fetchone()[0]), latest)
        # Different capture identity, same bytes: update the shared Asset's text.
        self.assertEqual(self.create(source_url="https://x.com/example/status/124/photo/1", image_text=LINES).status_code, 200)
        self.assertEqual(self.client.get(path, headers=self.admin).json()["lines"], LINES)

    def test_ordinary_asset_has_false_flags_and_no_text_route(self):
        self.assertEqual(self.create().status_code, 200)
        with api_app.get_db() as db:
            asset_id = db.execute("SELECT id FROM assets").fetchone()[0]
            self.assertFalse(asset_authority.state_projection(asset_authority.state_row(db, LIBRARY, asset_id), asset_id, db)["hasImageText"])
            row = db.execute("SELECT * FROM assets WHERE id=?", [asset_id]).fetchone()
            self.assertFalse(library_assets.mobile_asset_item(row)["has_image_text"])
        self.assertEqual(self.client.get(f"/v1/library/assets/{asset_id}/image-text", headers=self.admin).status_code, 404)
