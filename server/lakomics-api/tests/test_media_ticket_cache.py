"""Real ticket routes against temporary SQLite and fake R2."""
import hashlib
from contextlib import contextmanager
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
            # The key-bound immutable receipt survives unrelated metadata edits.
            self.assertEqual(head.call_count, 0)
            with api_app.get_db() as db:
                db.execute("UPDATE assets SET thumbnail_key=NULL WHERE id=?", [self.aid])
                db.commit()
            self.assertEqual(self.single().status_code, 409)
            self.assertEqual(self.batch()["error"], "unavailable")
            self.assertEqual(head.call_count, 0)

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

    def test_fresh_missing_and_storage_errors_do_not_stick(self):
        self.assertEqual(self.single().status_code, 200)
        del fake_s3.objects[self.key]
        self.clock = 30
        query = "?fresh_head=true"
        self.assertEqual(self.single(query=query).status_code, 409)
        self.assertEqual(self.batch(query=query)["error"], "unavailable")
        from botocore.exceptions import ClientError
        with mock.patch.object(fake_s3, "head_object", side_effect=ClientError({"Error": {"Code": "503"}}, "HeadObject")):
            self.assertEqual(self.single(query=query).status_code, 502)
            self.assertEqual(self.batch(query=query)["error"], "storage_unavailable")
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


class CommittedMediaTicketTests(AssetAuthorityFixture):
    """Cold-request HEAD gates using committed rows, never the process cache."""

    def setUp(self):
        super().setUp()
        self.cache = head_cache.HeadMetadataCache()
        patcher = mock.patch.object(head_cache, "ticket_heads", self.cache)
        patcher.start()
        self.addCleanup(patcher.stop)
        fake_s3.objects.clear()
        self.addCleanup(fake_s3.objects.clear)
        self.ids = []
        with api_app.get_db() as db:
            for i in range(50):
                aid = f"40000000-0000-4000-8000-{i:012d}"
                digest = hashlib.sha256(str(i).encode()).hexdigest()
                key = f"derived/image-thumbnails/v2/{digest}.webp"
                original = f"library/{aid}/original"
                self.ids.append(aid)
                db.execute(
                    "INSERT INTO assets(id,kind,object_key,sha256,content_type,size_bytes,"
                    "thumbnail_key,thumbnail_metadata_key,thumbnail_size_bytes,thumbnail_content_type,"
                    "committed,created_at,updated_at) VALUES(?,'image',?,?,'image/png',5,?,?,5,'image/webp',1,'one','one')",
                    [aid, original, digest, key, key])
                fake_s3.objects[key] = {"body": b"thumb", "content_type": "image/webp"}
                fake_s3.objects[original] = {"body": b"image", "content_type": "image/png"}
            db.commit()
        self.path = f"/v1/library/assets/{self.ids[0]}/media-ticket"

    def batch(self, variant="thumbnail", query=""):
        response = self.client.post("/v1/library/media-tickets" + query, headers=self.admin,
                                    json={"items": [{"asset_id": aid, "variant": variant} for aid in self.ids]})
        self.assertEqual(response.status_code, 200)
        return response.json()["items"]

    def update(self, **fields):
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET " + ",".join(f"{field}=?" for field in fields), list(fields.values()))
            db.commit()

    def test_cold_fifty_committed_thumbnails_require_zero_heads(self):
        with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head:
            for query in ("", "?verify_digest=true"):
                self.cache._entries.clear()
                items = self.batch(query=query)
                self.assertEqual(len(items), 50)
                self.assertTrue(all(item["ok"] for item in items))
                self.assertTrue(all(item["size_bytes"] == 5 and item["content_type"] == "image/webp" for item in items))
                self.assertTrue(all("sha256" not in item for item in items))
                self.assertEqual(head.call_count, 0)
            single = self.client.post(self.path, headers=self.admin, json={"variant": "thumbnail"})
            self.assertEqual(single.status_code, 200)
            self.assertEqual(single.json()["expires_in"], 300)
            self.assertEqual(head.call_count, 0)
            self.assertEqual(len(self.cache._entries), 0)

    def test_historical_batch_fills_once_and_second_cold_batch_skips_heads(self):
        self.update(thumbnail_metadata_key=None, thumbnail_size_bytes=None, thumbnail_content_type=None)
        statements = []
        get_db = api_app.get_db

        @contextmanager
        def traced_db():
            with get_db() as db:
                db.set_trace_callback(statements.append)
                yield db

        with mock.patch.object(api_app, "get_db", traced_db), mock.patch.object(
                fake_s3, "head_object", wraps=fake_s3.head_object) as head:
            self.assertTrue(all(item["ok"] for item in self.batch()))
            self.assertEqual(head.call_count, 50)
            self.cache._entries.clear()
            head.reset_mock()
            self.assertTrue(all(item["ok"] for item in self.batch()))
            self.assertEqual(head.call_count, 0)
        self.assertEqual(sum(sql.strip().upper().startswith("BEGIN") for sql in statements), 1)
        self.assertEqual(sum(sql.strip().upper() == "COMMIT" for sql in statements), 1)
        with get_db() as db:
            rows = db.execute("SELECT * FROM assets").fetchall()
        self.assertEqual(len(rows), 50)
        self.assertTrue(all(row["thumbnail_metadata_key"] == row["thumbnail_key"]
                            and row["thumbnail_size_bytes"] == 5
                            and row["thumbnail_content_type"] == "image/webp" for row in rows))
        with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head:
            self.assertTrue(all(item["ok"] for item in self.batch(query="?fresh_head=true")))
            self.assertEqual(head.call_count, 50)

    def test_single_historical_ticket_fills_metadata(self):
        self.update(thumbnail_metadata_key=None, thumbnail_size_bytes=None, thumbnail_content_type=None)
        with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head:
            for _ in range(2):
                self.cache._entries.clear()
                response = self.client.post(self.path, headers=self.admin, json={"variant": "thumbnail"})
                self.assertEqual(response.status_code, 200)
            self.assertEqual(head.call_count, 1)
        with api_app.get_db() as db:
            row = db.execute("SELECT * FROM assets WHERE id=?", [self.ids[0]]).fetchone()
        self.assertEqual(row["thumbnail_metadata_key"], row["thumbnail_key"])
        self.assertEqual((row["thumbnail_size_bytes"], row["thumbnail_content_type"]), (5, "image/webp"))

    def test_replaced_thumbnail_or_uncommitted_asset_is_not_recorded(self):
        original_head = fake_s3.head_object
        for changes in ({"thumbnail_key": "derived/image-thumbnails/v2/" + "f" * 64 + ".webp"},
                        {"committed": 0}):
            with self.subTest(changes=changes):
                self.update(thumbnail_metadata_key=None, thumbnail_size_bytes=None, thumbnail_content_type=None,
                            committed=1)
                with api_app.get_db() as db:
                    db.execute("UPDATE assets SET thumbnail_key='derived/image-thumbnails/v2/' || sha256 || '.webp'")
                    db.commit()
                self.cache._entries.clear()

                def head_then_replace(**kwargs):
                    metadata = original_head(**kwargs)
                    self.update(**changes)
                    return metadata

                with mock.patch.object(fake_s3, "head_object", side_effect=head_then_replace):
                    self.assertTrue(all(item["ok"] for item in self.batch()))
                with api_app.get_db() as db:
                    rows = db.execute("SELECT * FROM assets").fetchall()
                self.assertTrue(all(row["thumbnail_metadata_key"] is None
                                    and row["thumbnail_size_bytes"] is None
                                    and row["thumbnail_content_type"] is None for row in rows))

    def test_metadata_write_failure_rolls_back_batch_without_failing_tickets(self):
        self.update(thumbnail_metadata_key=None, thumbnail_size_bytes=None, thumbnail_content_type=None)
        with api_app.get_db() as db:
            # Fail the second update, so an earlier successful write must roll back.
            db.execute("CREATE TRIGGER reject_metadata BEFORE UPDATE OF thumbnail_metadata_key ON assets "
                       "WHEN EXISTS(SELECT 1 FROM assets WHERE thumbnail_metadata_key IS NOT NULL) "
                       "BEGIN SELECT RAISE(ABORT, 'metadata write failed'); END")
            db.commit()
        self.assertTrue(all(item["ok"] for item in self.batch()))
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM assets WHERE thumbnail_metadata_key IS NOT NULL")
                             .fetchone()[0], 0)
            db.execute("DROP TRIGGER reject_metadata")
            db.execute("CREATE TRIGGER reject_metadata BEFORE UPDATE OF thumbnail_metadata_key ON assets "
                       "BEGIN SELECT RAISE(ABORT, 'metadata write failed'); END")
            db.commit()
        self.assertEqual(self.client.post(self.path, headers=self.admin,
                                         json={"variant": "thumbnail"}).status_code, 200)

    def test_mutable_or_invalid_head_metadata_is_never_recorded(self):
        for key in ("library/legacy/thumbnail", "derived/unknown/thumbnail", None):
            with self.subTest(key=key):
                self.update(thumbnail_metadata_key=None, thumbnail_size_bytes=None, thumbnail_content_type=None)
                if key is not None:
                    self.update(thumbnail_key=key)
                    fake_s3.objects[key] = {"body": b"thumb", "content_type": "image/webp"}
                else:
                    with api_app.get_db() as db:
                        db.execute("UPDATE assets SET thumbnail_key='derived/image-thumbnails/v2/' || sha256 || '.webp'")
                        db.commit()
                for metadata in ({"ContentLength": 5, "ContentType": "image/webp"},) if key else (
                        {"ContentLength": 0, "ContentType": "image/webp"},
                        {"ContentLength": 5, "ContentType": None}):
                    self.cache._entries.clear()
                    with mock.patch.object(fake_s3, "head_object", return_value=metadata):
                        self.assertTrue(all(item["ok"] for item in self.batch()))
                    with api_app.get_db() as db:
                        self.assertEqual(db.execute("SELECT COUNT(*) FROM assets WHERE thumbnail_metadata_key IS NOT NULL")
                                         .fetchone()[0], 0)

    def test_fresh_thumbnails_head_and_report_deleted_objects(self):
        with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head:
            self.assertTrue(all(item["ok"] for item in self.batch(query="?fresh_head=true")))
            self.assertEqual(head.call_count, 50)
            fake_s3.objects.clear()
            single = self.client.post(self.path + "?fresh_head=true", headers=self.admin,
                                      json={"variant": "thumbnail"})
            self.assertEqual(single.status_code, 409)
            self.assertEqual(head.call_count, 51)
            self.assertTrue(all(item["error"] == "unavailable" for item in self.batch(query="?fresh_head=true")))
            self.assertEqual(head.call_count, 101)

    def test_missing_invalid_or_wrong_key_metadata_retains_cold_heads(self):
        for fields in ({"thumbnail_metadata_key": None}, {"thumbnail_size_bytes": None},
                       {"thumbnail_size_bytes": -1}, {"thumbnail_content_type": ""},
                       {"thumbnail_metadata_key": "derived/image-thumbnails/v1/" + "a" * 64 + ".webp"}):
            with self.subTest(fields=fields):
                with api_app.get_db() as db:
                    db.execute("UPDATE assets SET thumbnail_metadata_key=thumbnail_key,"
                               "thumbnail_size_bytes=5,thumbnail_content_type='image/webp'")
                    db.commit()
                self.update(**fields)
                self.cache._entries.clear()
                with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head:
                    self.assertTrue(all(item["ok"] for item in self.batch()))
                    self.assertEqual(head.call_count, 50)

    def test_mutable_originals_and_thumbnail_keys_keep_head_policy(self):
        with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head:
            self.assertTrue(all(item["ok"] for item in self.batch("original", "?verify_digest=true")))
            self.assertEqual(head.call_count, 50)
            head.reset_mock()
            with api_app.get_db() as db:
                db.execute("UPDATE assets SET thumbnail_key=object_key,thumbnail_metadata_key=object_key")
                db.commit()
            self.assertTrue(all(item["ok"] for item in self.batch()))
            self.assertEqual(head.call_count, 50)

    def test_uncommitted_and_hidden_assets_cannot_issue_metadata_tickets(self):
        self.activate()
        with mock.patch.object(fake_s3, "head_object", side_effect=AssertionError("not visible")):
            self.assertEqual(self.client.post(self.path, json={"variant": "thumbnail"}).status_code, 401)
            self.assertEqual(self.command("trashAsset", self.ids[0], 1).status_code, 200)
            self.assertEqual(self.client.post(self.path, headers=self.admin,
                                             json={"variant": "thumbnail"}).status_code, 404)
            self.assertEqual(self.batch()[0]["error"], "not_found")
            self.assertEqual(self.command("tombstoneAsset", self.ids[0], 2).status_code, 200)
            self.assertEqual(self.batch()[0]["error"], "not_found")
            self.update(committed=0)
            self.assertTrue(all(item["error"] == "not_found" for item in self.batch()))

    def test_content_addressed_original_requires_committed_digest_and_opt_in(self):
        digest = hashlib.sha256(b"image").hexdigest()
        key = f"work-artwork/mobile/{digest}"
        fake_s3.objects[key] = {"body": b"image", "content_type": "image/png"}
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET object_key=?,sha256=? WHERE id=?", [key, digest, self.ids[0]])
            db.commit()
            asset = dict(db.execute("SELECT * FROM assets WHERE id=?", [self.ids[0]]).fetchone())
        with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head:
            self.assertEqual(api_app._ticket_head(asset, "original", key, verify_digest=True)["ContentLength"], 5)
            self.assertEqual(head.call_count, 0)
            for changes, flags in (({}, {}), ({}, {"verify_digest": True, "fresh_head": True}),
                                   ({"committed": 0}, {"verify_digest": True}),
                                   ({"sha256": "b" * 64}, {"verify_digest": True}),
                                   ({"size_bytes": None}, {"verify_digest": True})):
                self.cache._entries.clear()
                head.reset_mock()
                api_app._ticket_head({**asset, **changes}, "original", key, **flags)
                self.assertEqual(head.call_count, 1)

    def test_additive_migration_does_not_invent_historical_metadata(self):
        columns = ("thumbnail_metadata_key", "thumbnail_size_bytes", "thumbnail_content_type")
        with api_app.get_db() as db:
            for column in columns:
                db.execute(f"ALTER TABLE assets DROP COLUMN {column}")
            db.commit()
        api_app.startup_replication()
        api_app.startup_replication()
        with api_app.get_db() as db:
            rows = db.execute("SELECT * FROM assets").fetchall()
            self.assertEqual(len(rows), 50)
            self.assertTrue(all(row["committed"] == 1 and row["thumbnail_key"] for row in rows))
            self.assertTrue(all(row[column] is None for row in rows for column in columns))
        with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head:
            self.assertTrue(all(item["ok"] for item in self.batch()))
            self.assertEqual(head.call_count, 50)
