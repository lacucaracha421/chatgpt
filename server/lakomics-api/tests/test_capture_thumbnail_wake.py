"""Capture requests wake only after a new Asset's durable job is committed."""
import sqlite3
from contextlib import contextmanager
from unittest import mock

import image_thumbnails
from tests.test_asset_authority import AssetAuthorityFixture, LIBRARY, api_app
import classification_authority
from capture_store import StoredMedia


class CaptureThumbnailWakeTests(AssetAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()
        classification_authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            image_thumbnails.install(db)
            db.execute("BEGIN IMMEDIATE")
            classification_authority.activate(
                db, library_id=LIBRARY,
                entries=[{"id": "lakomics-originals", "kind": "root", "name": "Originals",
                          "parentId": None, "iconKey": None, "colorKey": None}],
                assignments=[], roles=[{"role": "originals", "classificationId": "lakomics-originals"}],
                baseline_digest="b" * 64, baseline_revision=1,
                now="2026-09-23T00:00:00Z", snapshot_version=2)
            db.commit()
        self.capture = {
            "source_url": "https://x.com/example/status/123/photo/1",
            "media_url": "https://pbs.twimg.com/media/example.png",
            "classification_id": "lakomics-originals", "media_type": "image", "source": "x"}
        self.worker = mock.Mock()
        worker_patch = mock.patch.object(api_app, "_image_thumbnail_worker", self.worker)
        worker_patch.start()
        self.addCleanup(worker_patch.stop)
        fetch_patch = mock.patch.object(api_app, "fetch_media_to_r2", return_value=StoredMedia("image/png", 5, "a" * 64))
        self.fetch = fetch_patch.start()
        self.addCleanup(fetch_patch.stop)

    def create(self, **changes):
        return self.client.post("/v1/captures", headers=self.admin, json={**self.capture, **changes})

    def test_wake_observes_committed_capture_asset_and_job_on_another_connection(self):
        def observe_commit():
            with api_app.get_db() as db:
                self.assertEqual(db.execute("SELECT status FROM captures").fetchone()[0], "imported")
                self.assertEqual(db.execute("SELECT committed FROM assets").fetchone()[0], 1)
                self.assertEqual(db.execute("SELECT state FROM image_thumbnail_jobs").fetchone()[0], "queued")
        self.worker.wake.side_effect = observe_commit
        response = self.create()
        self.assertEqual(response.status_code, 200, response.text)
        self.worker.wake.assert_called_once_with()

    def test_failed_commit_rolls_back_without_wake(self):
        original_get_db = api_app.get_db
        reached_commit = mock.Mock()

        class FailedCommit:
            def __init__(self, db):
                self.db = db

            def __getattr__(self, name):
                return getattr(self.db, name)

            def commit(self):
                reached_commit()
                # Prove the failure occurs after the queue trigger, not before promotion.
                assert self.db.execute("SELECT count(*) FROM image_thumbnail_jobs").fetchone()[0] == 1
                raise sqlite3.OperationalError("simulated commit failure")

        @contextmanager
        def failing_get_db():
            with original_get_db() as db:
                yield FailedCommit(db)

        with mock.patch.object(api_app, "get_db", failing_get_db):
            with self.assertRaisesRegex(sqlite3.OperationalError, "simulated commit failure"):
                self.create()
        reached_commit.assert_called_once()
        self.worker.wake.assert_not_called()
        with original_get_db() as db:
            for table in ("captures", "assets", "image_thumbnail_jobs"):
                self.assertEqual(db.execute(f"SELECT count(*) FROM {table}").fetchone()[0], 0)

    def test_duplicate_capture_and_duplicate_content_do_not_wake_again(self):
        self.assertEqual(self.create().status_code, 200)
        self.worker.wake.reset_mock()
        self.assertFalse(self.create().json()["created"])
        # A distinct capture with the same digest maps to the existing Asset.
        response = self.create(source_url="https://x.com/example/status/124/photo/1")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["created"])
        self.worker.wake.assert_not_called()
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM image_thumbnail_jobs").fetchone()[0], 1)

    def test_download_failure_does_not_wake(self):
        self.fetch.side_effect = api_app.CaptureDownloadError("unavailable")
        self.assertEqual(self.create().status_code, 502)
        self.worker.wake.assert_not_called()

    def test_no_worker_keeps_the_durable_job_for_polling(self):
        with mock.patch.object(api_app, "_image_thumbnail_worker", None):
            response = self.create()
        self.assertEqual(response.status_code, 200, response.text)
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT state FROM image_thumbnail_jobs").fetchone()[0], "queued")
