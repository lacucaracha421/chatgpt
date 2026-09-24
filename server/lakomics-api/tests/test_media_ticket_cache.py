"""Real ticket routes against temporary SQLite and fake R2."""
import hashlib
import unittest
from unittest import mock

import head_cache
import asset_authority
from tests.test_asset_authority import AssetAuthorityFixture, CAPTURE, LIBRARY, api_app
from tests.test_capture_api_stub import fake_s3


class MediaTicketCacheTests(AssetAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()
        self.clock = 0.0
        cache_patch = mock.patch.object(head_cache, "ticket_heads", head_cache.HeadMetadataCache(clock=lambda: self.clock))
        cache_patch.start()
        self.addCleanup(cache_patch.stop)
        endpoint_patch = mock.patch.object(fake_s3, "meta", mock.Mock(
            endpoint_url="https://" + "a" * 32 + ".r2.cloudflarestorage.com"), create=True)
        endpoint_patch.start()
        self.addCleanup(endpoint_patch.stop)
        fake_s3.objects.clear()
        self.addCleanup(fake_s3.objects.clear)
        self.key = "derived/image-thumbnails/v1/" + "a" * 64 + ".webp"
        self.original = f"images/inbox/{CAPTURE}/original"
        with api_app.get_db() as db:
            self.aid, _ = asset_authority.promote_capture(
                db, library_id=LIBRARY, capture_id=CAPTURE, kind="image",
                object_key=self.original, content_type="image/png", size_bytes=5,
                sha256=hashlib.sha256(b"image").hexdigest(), import_source="capture")
            db.execute("UPDATE assets SET thumbnail_key=? WHERE id=?", [self.key, self.aid])
            db.commit()
        fake_s3.objects[self.key] = {"body": b"thumb", "content_type": "image/webp"}
        fake_s3.objects[self.original] = {"body": b"image", "content_type": "image/png"}
        self.path = f"/v1/library/assets/{self.aid}/media-ticket"

    def single(self, variant="thumbnail", query=""):
        return self.client.post(self.path + query, headers=self.admin, json={"variant": variant})

    def batch(self, variant="thumbnail", query=""):
        return self.client.post("/v1/library/media-tickets" + query, headers=self.admin,
                                json={"items": [{"asset_id": self.aid, "variant": variant}]}).json()["items"][0]

    def test_single_and_batch_share_head_success_but_presign_each_ticket(self):
        with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head, mock.patch.object(
                api_app, "presign_get", wraps=api_app.presign_get) as sign:
            first = self.single()
            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.json()["content_type"], "image/webp")
            self.assertEqual(first.json()["size_bytes"], 5)
            self.assertEqual(first.json()["expires_in"], 300)
            self.assertTrue(self.batch()["ok"])
            self.assertEqual(head.call_count, 1)
            self.assertEqual(sign.call_count, 2)
            sign.assert_called_with(self.key, 300)

    def test_auth_hidden_tombstoned_and_deleted_assets_cannot_use_warm_cache(self):
        self.assertEqual(self.single().status_code, 200)
        with mock.patch.object(fake_s3, "head_object", side_effect=AssertionError("not authorized")), mock.patch.object(
                api_app, "presign_get", side_effect=AssertionError("not authorized")):
            self.assertEqual(self.client.post(self.path, json={"variant": "thumbnail"}).status_code, 401)
            self.assertEqual(self.client.post("/v1/library/media-tickets", json={"items": [
                {"asset_id": self.aid, "variant": "thumbnail"}]}).status_code, 401)
            self.assertEqual(self.command("trashAsset", self.aid, 1).status_code, 200)
            self.assertEqual(self.single().status_code, 404)
            self.assertEqual(self.batch()["error"], "not_found")
            self.assertEqual(self.command("tombstoneAsset", self.aid, 2).status_code, 200)
            self.assertEqual(self.single().status_code, 404)
            self.assertEqual(self.batch()["error"], "not_found")
            with api_app.get_db() as db:
                db.execute("DELETE FROM assets WHERE id=?", [self.aid])
                db.commit()
            self.assertEqual(self.single().status_code, 404)
            self.assertEqual(self.batch()["error"], "not_found")

    def test_current_metadata_and_variant_key_are_read_on_every_request(self):
        self.assertEqual(self.single().status_code, 200)
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET metadata_revision=metadata_revision+1 WHERE id=?", [self.aid])
            db.commit()
        with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head:
            self.assertTrue(self.batch()["ok"])
            self.assertEqual(head.call_count, 1)
            with api_app.get_db() as db:
                db.execute("UPDATE assets SET thumbnail_key=NULL WHERE id=?", [self.aid])
                db.commit()
            self.assertEqual(self.single().status_code, 409)
            self.assertEqual(self.batch()["error"], "unavailable")
            self.assertEqual(head.call_count, 1)

    def test_unverified_clients_and_legacy_thumbnail_never_reuse_head(self):
        legacy = f"library/{self.aid}/thumbnail"
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET thumbnail_key=? WHERE id=?", [legacy, self.aid])
            db.commit()
        fake_s3.objects[legacy] = {"body": b"old", "content_type": "image/webp"}
        with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head:
            for variant, key in (("original", self.original), ("thumbnail", legacy)):
                self.assertEqual(self.single(variant).status_code, 200)
                fake_s3.objects[key] = {"body": b"new bytes", "content_type": "image/jpeg"}
                self.assertEqual(self.batch(variant)["size_bytes"], 9)
                del fake_s3.objects[key]
                self.assertEqual(self.single(variant).status_code, 409)
            self.assertEqual(head.call_count, 6)

    def test_tickets_never_send_a_null_digest(self):
        # Installed Android builds read a JSON null through optString() as "null"
        # and reject the download, so a missing digest must omit the key.
        self.assertNotIn("sha256", self.batch("thumbnail"))
        self.assertNotIn("sha256", self.single("thumbnail").json())
        self.assertIn("sha256", self.batch("original"))
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET sha256=NULL WHERE id=?", [self.aid])
            db.commit()
        self.assertNotIn("sha256", self.single("original").json())

    def test_verified_original_reuses_head_until_identity_changes(self):
        query = "?verify_digest=true"
        first = self.single("original", query)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["sha256"], hashlib.sha256(b"image").hexdigest())
        with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head:
            self.assertTrue(self.batch("original", query)["ok"])
            self.assertEqual(head.call_count, 0)
            for field, value in (("sha256", "b" * 64), ("size_bytes", 9),
                                 ("content_type", "image/jpeg"), ("updated_at", "changed"),
                                 ("metadata_revision", 55), ("object_key", "library/new/original")):
                with self.subTest(field=field):
                    fake_s3.objects["library/new/original"] = {"body": b"new bytes", "content_type": "image/jpeg"}
                    with api_app.get_db() as db:
                        db.execute(f"UPDATE assets SET {field}=? WHERE id=?", [value, self.aid])
                        db.commit()
                    head.reset_mock()
                    self.assertTrue(self.batch("original", query)["ok"])
                    self.assertEqual(head.call_count, 1)
                    self.assertEqual(self.single("original", query).status_code, 200)
                    self.assertEqual(head.call_count, 1)

    def test_warm_original_does_not_bypass_authorization_or_live_visibility(self):
        query = "?verify_digest=true"
        self.assertEqual(self.single("original", query).status_code, 200)
        with mock.patch.object(fake_s3, "head_object", side_effect=AssertionError("not authorized")), mock.patch.object(
                api_app, "presign_get", side_effect=AssertionError("not authorized")):
            self.assertEqual(self.client.post(self.path + query, json={"variant": "original"}).status_code, 401)
            self.assertEqual(self.command("trashAsset", self.aid, 1).status_code, 200)
            self.assertEqual(self.single("original", query).status_code, 404)
            self.assertEqual(self.batch("original", query)["error"], "not_found")
            self.assertEqual(self.command("tombstoneAsset", self.aid, 2).status_code, 200)
            self.assertEqual(self.single("original", query).status_code, 404)
            self.assertEqual(self.batch("original", query)["error"], "not_found")

    def test_original_retry_forces_head_and_missing_digest_cannot_opt_in(self):
        self.assertEqual(self.single("original", "?verify_digest=true").status_code, 200)
        fake_s3.objects[self.original] = {"body": b"new bytes", "content_type": "image/png"}
        with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head:
            retry = self.batch("original", "?verify_digest=true&fresh_head=true")
            self.assertEqual(head.call_count, 1)
            self.assertEqual(retry["size_bytes"], 9)
            self.assertEqual(retry["sha256"], hashlib.sha256(b"image").hexdigest())
            with api_app.get_db() as db:
                db.execute("UPDATE assets SET sha256=NULL WHERE id=?", [self.aid])
                db.commit()
            head.reset_mock()
            self.assertEqual(self.single("original", "?verify_digest=true").status_code, 200)
            self.assertTrue(self.batch("original", "?verify_digest=true")["ok"])
            self.assertEqual(head.call_count, 2)

    def test_expired_missing_and_storage_errors_do_not_stick(self):
        self.assertEqual(self.single().status_code, 200)
        del fake_s3.objects[self.key]
        self.clock = 30
        self.assertEqual(self.single().status_code, 409)
        self.assertEqual(self.batch()["error"], "unavailable")
        from botocore.exceptions import ClientError
        with mock.patch.object(fake_s3, "head_object", side_effect=ClientError({"Error": {"Code": "503"}}, "HeadObject")):
            self.assertEqual(self.single().status_code, 502)
            self.assertEqual(self.batch()["error"], "storage_unavailable")
        fake_s3.objects[self.key] = {"body": b"thumb", "content_type": "image/webp"}
        self.assertEqual(self.single().status_code, 200)
        self.assertTrue(self.batch()["ok"])


class OriginalHeadPolicyTests(unittest.TestCase):
    """Exercise the real ticket helper without an ASGI event loop."""
    def setUp(self):
        self.clock = 0
        self.cache = head_cache.HeadMetadataCache(clock=lambda: self.clock)
        self.storage = mock.Mock()
        self.storage.meta.endpoint_url = "https://test.r2.invalid"
        self.storage.head_object.return_value = {"ContentType": "image/png", "ContentLength": 5}
        self.asset = dict(object_key="library/a/original", sha256=hashlib.sha256(b"image").hexdigest(),
                          content_type="image/png", size_bytes=5, metadata_revision=1, updated_at="one")
        for patcher in (mock.patch.object(head_cache, "ticket_heads", self.cache),
                        mock.patch.object(api_app, "_s3", self.storage)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def ticket(self, **kwargs):
        return api_app._ticket_head(self.asset, "original", self.asset["object_key"], verify_digest=True, **kwargs)

    def test_repeat_is_zero_heads_and_each_identity_change_is_one(self):
        self.ticket()
        self.storage.head_object.reset_mock()
        self.ticket()
        self.assertEqual(self.storage.head_object.call_count, 0)
        for field, value in (("object_key", "library/b/original"), ("sha256", "b" * 64),
                             ("size_bytes", 7), ("content_type", "image/webp"),
                             ("updated_at", "two"), ("metadata_revision", 2)):
            with self.subTest(field=field):
                self.asset[field] = value
                self.storage.head_object.reset_mock()
                self.ticket()
                self.assertEqual(self.storage.head_object.call_count, 1)
                self.ticket()
                self.assertEqual(self.storage.head_object.call_count, 1)

    def test_expiry_fresh_retry_digestless_and_legacy_clients(self):
        self.ticket()
        self.storage.head_object.reset_mock()
        self.clock = 30
        self.ticket()
        self.assertEqual(self.storage.head_object.call_count, 1)
        self.ticket(fresh_head=True)
        self.assertEqual(self.storage.head_object.call_count, 2)
        self.asset["sha256"] = None
        self.ticket(); self.ticket()
        self.assertEqual(self.storage.head_object.call_count, 4)
        self.asset["sha256"] = "a" * 64
        for _ in range(2):
            api_app._ticket_head(self.asset, "original", self.asset["object_key"])
        self.assertEqual(self.storage.head_object.call_count, 6)

    def test_error_is_not_cached_and_retry_cannot_retain_stale_success(self):
        self.ticket()
        self.storage.head_object.side_effect = OSError("storage unavailable")
        with self.assertRaises(OSError):
            self.ticket(fresh_head=True)
        with self.assertRaises(OSError):
            self.ticket()
        self.storage.head_object.side_effect = None
        self.storage.head_object.return_value = {"ContentType": "image/png", "ContentLength": 9}
        self.assertEqual(self.ticket()["ContentLength"], 9)
