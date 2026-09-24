"""Capture promotion -> durable thumbnail job -> ordinary mobile media API."""
import hashlib
import os
from unittest import mock

import image_thumbnails
from tests.test_asset_authority import AssetAuthorityFixture, CAPTURE, LIBRARY, api_app
from tests.test_image_thumbnails import FakeS3, png_bytes
from tests.test_media_thumbnail_worker import gif_bytes
import asset_authority


class Storage(FakeS3):
    def head_object(self, *, Bucket, Key):
        value = self.objects[Key]
        return {"ContentLength": len(value["body"]), "ContentType": value["content_type"]}


class ThumbnailApiTests(AssetAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()
        self.payload = png_bytes()
        self.source_key = f"images/inbox/{CAPTURE}/original"
        with api_app.get_db() as db:
            image_thumbnails.install(db)

    def promote(self, db, kind="image", content_type="image/png"):
        return asset_authority.promote_capture(
            db, library_id=LIBRARY, capture_id=CAPTURE, kind=kind,
            object_key=self.source_key, content_type=content_type,
            size_bytes=len(self.payload), sha256=hashlib.sha256(self.payload).hexdigest(),
            import_source="capture")

    def test_promoted_image_reaches_mobile_without_a_pc(self):
        with api_app.get_db() as db:
            aid, created = self.promote(db)
            self.assertTrue(created)
            db.commit()
            canonical_before = tuple(db.execute(
                "SELECT * FROM asset_authority_state WHERE asset_id=?", [aid]).fetchone())
            self.assertEqual(db.execute("SELECT COUNT(*) FROM image_thumbnail_jobs").fetchone()[0], 1)
        before = self.client.get("/v1/library/list-generation", headers=self.admin).json()
        storage = Storage()
        storage.add(self.source_key, self.payload, "image/png")
        worker = image_thumbnails.ImageThumbnailWorker(self.database, storage, "test-bucket")
        try:
            self.assertTrue(worker.run_once())
        finally:
            worker._close()
        with mock.patch.object(api_app, "_s3", storage):
            response = self.client.post("/v1/library/media-tickets", headers=self.admin, json={
                "items": [{"asset_id": aid, "variant": v} for v in ("thumbnail", "original")]})
        self.assertEqual(response.status_code, 200)
        thumbnail, original = response.json()["items"]
        self.assertTrue(thumbnail["ok"])
        self.assertEqual(thumbnail["content_type"], "image/webp")
        self.assertTrue(original["ok"])
        self.assertEqual(original["size_bytes"], len(self.payload))
        self.assertEqual(storage.objects[self.source_key]["body"], self.payload)
        response = self.client.get("/v1/library/assets", headers=self.admin)
        self.assertEqual(response.status_code, 200, response.text)
        item = next(item for item in response.json()["items"] if item["id"] == aid)
        self.assertEqual((item["width"], item["height"], item["duration_ms"]), (800, 600, None))
        self.assertTrue(item["thumbnail_available"])
        self.assertNotEqual(before, self.client.get("/v1/library/list-generation", headers=self.admin).json())
        with api_app.get_db() as db:
            self.assertEqual(tuple(db.execute(
                "SELECT * FROM asset_authority_state WHERE asset_id=?", [aid]).fetchone()), canonical_before)
            self.assertEqual(self.promote(db), (aid, False))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM image_thumbnail_jobs").fetchone()[0], 1)
            db.commit()

    def test_promoted_gif_reaches_mobile_without_pc_or_ffmpeg(self):
        self.payload = gif_bytes()
        with api_app.get_db() as db:
            aid, created = self.promote(db, "gif", "image/gif")
            self.assertTrue(created)
            db.commit()
            canonical_before = tuple(db.execute(
                "SELECT * FROM asset_authority_state WHERE asset_id=?", [aid]).fetchone())
        storage = Storage()
        storage.add(self.source_key, self.payload, "image/gif")
        worker = image_thumbnails.ImageThumbnailWorker(self.database, storage, "test-bucket")
        try:
            with mock.patch.dict(os.environ, {'LAKOMICS_FFMPEG': '/missing/ffmpeg', 'LAKOMICS_FFPROBE': '/missing/ffprobe'}):
                self.assertTrue(worker.run_once())
        finally:
            worker._close()
        response = self.client.get("/v1/library/assets", headers=self.admin)
        self.assertEqual(response.status_code, 200, response.text)
        item = next(item for item in response.json()["items"] if item["id"] == aid)
        self.assertEqual(item["kind"], "gif")
        self.assertEqual((item["width"], item["height"], item["duration_ms"]), (800, 400, None))
        self.assertTrue(item["thumbnail_available"])
        with mock.patch.object(api_app, "_s3", storage):
            response = self.client.post("/v1/library/media-tickets", headers=self.admin, json={
                "items": [{"asset_id": aid, "variant": v} for v in ("thumbnail", "original")]})
        self.assertEqual(response.status_code, 200, response.text)
        thumbnail, original = response.json()["items"]
        self.assertTrue(thumbnail["ok"])
        self.assertEqual(thumbnail["content_type"], "image/webp")
        self.assertTrue(original["ok"])
        self.assertEqual(original["content_type"], "image/gif")
        self.assertEqual(storage.objects[self.source_key]["body"], self.payload)
        with api_app.get_db() as db:
            self.assertEqual(tuple(db.execute(
                "SELECT * FROM asset_authority_state WHERE asset_id=?", [aid]).fetchone()), canonical_before)

    def test_rolled_back_promotion_does_not_leave_a_job(self):
        with api_app.get_db() as db:
            self.promote(db)
            db.rollback()
            self.assertEqual(db.execute("SELECT COUNT(*) FROM image_thumbnail_jobs").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM assets").fetchone()[0], 0)

    def test_application_registers_worker_start_and_stop(self):
        self.assertIn(api_app.startup_image_thumbnails, api_app.lifecycle(api_app.app).startup_handlers)
        self.assertIn(api_app.shutdown_image_thumbnails, api_app.lifecycle(api_app.app).shutdown_handlers)
        with mock.patch.object(api_app, "_image_thumbnail_worker", None), mock.patch.object(
                image_thumbnails, "ImageThumbnailWorker") as worker_type:
            api_app.startup_image_thumbnails()
            api_app.startup_image_thumbnails()
            worker_type.assert_called_once()
            self.assertEqual(worker_type.call_args.args[0], self.database)
            api_app.shutdown_image_thumbnails()
            worker_type.return_value.stop.assert_called_once()
            self.assertIsNone(api_app._image_thumbnail_worker)

    def test_shutdown_keeps_a_worker_that_is_still_finishing(self):
        worker = mock.Mock()
        worker.stop.return_value = False
        with mock.patch.object(api_app, "_image_thumbnail_worker", worker):
            api_app.shutdown_image_thumbnails()
            self.assertIs(api_app._image_thumbnail_worker, worker)
            worker.stop.return_value = True
            api_app.shutdown_image_thumbnails()
            self.assertIsNone(api_app._image_thumbnail_worker)
