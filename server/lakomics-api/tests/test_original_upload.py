"""Original upload authorization and retries, using disposable DB/R2 fixtures.

Call the synchronous route handlers directly; the replication API suite covers
HTTP serialization separately. No storage credentials or network are used here.
"""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from botocore.exceptions import ClientError
from fastapi import HTTPException

from tests.test_capture_api_stub import fake_s3
import api_auth
import app as api_app


ASSET_ID = "00000000-0000-4000-8000-000000000001"
ORIGINAL = f"library/{ASSET_ID}/original"
THUMBNAIL = f"library/{ASSET_ID}/thumbnail"


class OriginalUploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = api_app.DB_PATH, api_app.API_TOKEN
        api_app.DB_PATH = Path(self.temp.name) / "test.sqlite3"
        api_app.API_TOKEN = "shared-test-token"
        api_app.startup()
        api_app.startup_replication()
        api_auth.startup(api_app.get_db)
        with api_app.get_db() as db:
            self.publisher_id, publisher = api_auth.provision_token(db, "publisher", "upload-test")
            _, client = api_auth.provision_token(db, "client", "upload-test")
            db.commit()
        self.publisher = f"Bearer {publisher}"
        self.client = f"Bearer {client}"
        self.shared = "Bearer shared-test-token"
        fake_s3.objects.clear()

    def tearDown(self):
        api_app.DB_PATH, api_app.API_TOKEN = self.previous
        fake_s3.objects.clear()
        self.temp.cleanup()

    def presign(self, key=ORIGINAL, authorization=None):
        return api_app.create_upload_presign(
            api_app.PresignRequest(object_key=key, content_type="image/png"),
            self.publisher if authorization is None else authorization,
        )

    def prepare(self):
        return api_app.replication_prepare(
            api_app.ReplicationPrepare(asset_id=ASSET_ID, kind="image"), self.publisher)

    def commit(self, revision=0):
        return api_app.replication_commit(api_app.ReplicationCommit(
            asset_id=ASSET_ID, kind="image", content_type="image/png",
            expected_revision=revision, commit_id=f"commit-{revision}",
            original=api_app.ReplicationVariant(object_key=ORIGINAL, content_type="image/png", size_bytes=8),
            thumbnail=api_app.ReplicationVariant(object_key=THUMBNAIL, content_type="image/webp", size_bytes=8),
        ), self.publisher)

    def put_original(self, key=ORIGINAL):
        fake_s3.objects[key] = {"body": b"original", "content_type": "image/png"}

    def assert_rejected(self, status, action):
        with self.assertRaises(HTTPException) as raised:
            action()
        self.assertEqual(raised.exception.status_code, status)

    def test_original_upload_requires_publisher_in_all_pc_namespaces(self):
        for prefix in ("library", "images", "videos"):
            key = f"{prefix}/{ASSET_ID}/original"
            for authorization in (self.shared, self.client, "Bearer unknown"):
                with self.subTest(prefix=prefix, principal="non-publisher"):
                    with mock.patch("r2.presign_put") as sign:
                        self.assert_rejected(401, lambda: self.presign(key, authorization))
                        sign.assert_not_called()
            self.assertEqual(self.presign(key)["object_key"], key)

    def test_revoked_publisher_cannot_upload(self):
        with api_app.get_db() as db:
            db.execute("UPDATE api_clients SET revoked_at='now' WHERE id=?", (self.publisher_id,))
            db.commit()
        self.assert_rejected(401, self.presign)

    def test_committed_original_cannot_get_an_overwrite_ticket(self):
        self.prepare()
        self.commit()
        self.put_original()
        with mock.patch("r2.presign_put") as sign:
            self.assert_rejected(409, self.presign)
            sign.assert_not_called()
        self.assertEqual(fake_s3.objects[ORIGINAL]["body"], b"original")
        # Both the new publisher upload and the shared-token thumbnail refresh work.
        for auth in (self.publisher, self.shared):
            self.assertEqual(self.presign(THUMBNAIL, auth)["method"], "PUT")

    def test_committed_original_with_a_legacy_key_is_also_protected(self):
        self.prepare()
        self.commit()
        key = "images/legacy-image.png"
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET object_key=? WHERE id=?", (key, ASSET_ID))
            db.commit()
        self.put_original(key)
        self.assert_rejected(409, lambda: self.presign(key))

    def test_missing_committed_original_can_be_repaired_but_head_errors_fail_closed(self):
        self.prepare()
        self.commit()
        self.assertEqual(self.presign()["method"], "PUT")
        for code in ("AccessDenied", "InternalError"):
            error = ClientError({"Error": {"Code": code}}, "HeadObject")
            with mock.patch.object(fake_s3, "head_object", side_effect=error), mock.patch("r2.presign_put") as sign:
                self.assert_rejected(503, self.presign)
                sign.assert_not_called()

    def test_publisher_upload_lifecycle_and_failed_commit_retry(self):
        self.assertFalse(self.prepare()["already_committed"])
        self.assertEqual(self.presign()["method"], "PUT")
        self.put_original()
        registered = api_app.create_asset(api_app.AssetCreate(
            id=ASSET_ID, kind="image", object_key=ORIGINAL), self.publisher)
        self.assertTrue(registered["ok"])
        self.assertEqual(self.presign(THUMBNAIL)["method"], "PUT")
        self.assert_rejected(409, lambda: self.commit(revision=999))
        self.assertFalse(self.prepare()["already_committed"])
        # A previous PUT succeeded, but commit failed: retry must still work.
        self.assertEqual(self.presign()["method"], "PUT")
        self.assertTrue(self.commit()["committed"])
        # A lost commit response is recovered by prepare, without another PUT.
        self.assertTrue(self.prepare()["already_committed"])
        self.assert_rejected(409, self.presign)

    def test_shared_token_still_uploads_non_original_objects(self):
        for key in (THUMBNAIL, "thumbnails/legacy.webp", "work-artwork/cover", "backups/metadata"):
            with self.subTest(key=key):
                self.assertEqual(self.presign(key, self.shared)["method"], "PUT")
