"""Image translations stay optional and travel with captures and promoted Assets."""
import hashlib
import json
import inspect
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
import uuid
from unittest import mock

from tests.test_asset_authority import AssetAuthorityFixture, api_app, LIBRARY
from tests import test_capture_thumbnail_wake
from capture_store import StoredMedia
import asset_authority
import capture_routes
import library_assets
import library_search
import library_description

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

    def test_pending_list_uses_one_connection_for_all_text(self):
        self.create(image_text=LINES)
        self.create(source_url="https://x.com/example/status/124/photo/1")
        connect = sqlite3.connect
        with mock.patch.object(sqlite3, "connect", wraps=connect) as connections:
            response = self.client.get("/v1/captures/pending", headers=self.admin)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(connections.call_count, 1)
        items = response.json()["captures"]
        self.assertEqual(len(items), 2)
        self.assertEqual([item["image_text"] for item in items if "image_text" in item], [LINES])

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
            self.assertTrue(asset_authority.state_projection(asset_authority.state_row(db, LIBRARY, asset_id), asset_id)["hasImageText"])
            row = library_assets.image_text_flags(db, [
                db.execute("SELECT * FROM assets WHERE id=?", [asset_id]).fetchone()])[0]
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
            self.assertFalse(asset_authority.state_projection(asset_authority.state_row(db, LIBRARY, asset_id), asset_id)["hasImageText"])
            row = library_assets.image_text_flags(db, [
                db.execute("SELECT * FROM assets WHERE id=?", [asset_id]).fetchone()])[0]
            self.assertFalse(library_assets.mobile_asset_item(row)["has_image_text"])
        self.assertEqual(self.client.get(f"/v1/library/assets/{asset_id}/image-text", headers=self.admin).status_code, 404)


class ImageTextBulkTests(AssetAuthorityFixture):
    def test_capture_lookup_uses_covering_index_after_repeated_startup(self):
        api_app.startup_asset_authority()
        api_app.startup_asset_authority()
        with api_app.get_db() as db:
            db.executemany("INSERT INTO asset_authority_capture_map VALUES(?,?,?,?)",
                           [(LIBRARY, f"capture-{i}", f"asset-{i}", "now") for i in range(1000)])
            plan = [row[3] for row in db.execute(
                "EXPLAIN QUERY PLAN SELECT asset_id FROM asset_authority_capture_map WHERE capture_id=?",
                ["capture-500"])]
        self.assertTrue(any("SEARCH" in step and
                            "asset_authority_capture_map_by_capture" in step for step in plan), plan)
        self.assertFalse(any("SCAN" in step for step in plan), plan)

    def test_projection_is_pure_and_bulk_baseline_and_changes_keep_flags(self):
        self.assertEqual(list(inspect.signature(asset_authority.state_projection).parameters),
                         ["row", "asset_id"])
        self.activate()
        expected = {}
        with api_app.get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            for i in range(1000):
                identity = str(uuid.UUID(int=i + 1))
                expected[identity] = i % 2 == 0
                db.execute("INSERT INTO assets(id,kind,object_key,content_type,size_bytes,sha256,"
                           "committed,created_at,updated_at) VALUES(?,'image',?,'image/png',5,?,1,?,?)",
                           [identity, f"library/{identity}/original", f"{i:064x}", "now", "now"])
                if expected[identity]:
                    db.execute("INSERT INTO asset_image_text VALUES(?,?,?,?)",
                               [identity, "[]", "d" * 64, "now"])
                asset_authority.register_replication(db, LIBRARY, identity, "now")
            db.commit()
            rows = asset_authority.asset_page(db, LIBRARY, None, 1000)
            # All the previous projection fields must retain their values.
            keys = ("lifecycle", "entityRevision", "kind", "objectKey", "contentType",
                    "sizeBytes", "sha256", "sourceUrl", "creatorName", "creatorHandle",
                    "collectedAt", "sourcePublishedAt", "importSource", "createdAt", "updatedAt")
            row = tuple(asset_authority.state_row(db, LIBRARY, rows[0]["assetId"]))
        with mock.patch.object(api_app, "get_db", side_effect=AssertionError("projection opened DB")):
            self.assertEqual(asset_authority.state_projection(row, rows[0]["assetId"]),
                             {"assetId": rows[0]["assetId"], "hasImageText": bool(row[15]),
                              **dict(zip(keys, row[:15]))})
        self.assertEqual({item["assetId"]: item["hasImageText"] for item in rows}, expected)
        response = self.client.get("/v1/assets/authority/baseline", headers=self.publisher,
                                   params={"libraryId": LIBRARY, "epoch": 1, "limit": 1000})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual({item["assetId"]: item["hasImageText"]
                          for item in response.json()["items"]}, expected)
        changes = {}
        after = 0
        while True:
            response = self.client.get("/v1/assets/authority/changes", headers=self.publisher,
                                       params={"libraryId": LIBRARY, "epoch": 1,
                                               "after": after, "limit": 500})
            self.assertEqual(response.status_code, 200, response.text)
            page = response.json()
            for item in page["items"]:
                projection = item["asset"]
                changes[projection["assetId"]] = projection["hasImageText"]
            if not page["hasMore"]:
                break
            after = page["nextAfter"]
        self.assertEqual(changes, expected)


class ImageTextLockTests(test_capture_thumbnail_wake.CaptureThumbnailWakeTests):
    def setUp(self):
        super().setUp()
        with api_app.get_db() as db:
            self.assertEqual(db.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")

    def seed_text(self):
        response = self.create(image_text=LINES)
        self.assertEqual(response.status_code, 200, response.text)
        with api_app.get_db() as db:
            self.asset_id = db.execute("SELECT id FROM assets").fetchone()[0]

    def writer(self, timeout=0.5, change=False):
        started = time.monotonic()
        with closing(sqlite3.connect(self.database, timeout=timeout)) as writer:
            writer.execute("BEGIN IMMEDIATE")
            if change:
                writer.execute("UPDATE asset_list_generation SET generation=generation+1")
                writer.commit()
            else:
                writer.rollback()
        return time.monotonic() - started

    def assert_writer_available(self):
        # A zero busy timeout makes this fail immediately if a writer lock leaked.
        self.assertLess(self.writer(timeout=0), 1)

    def test_identical_resave_is_noop_and_changed_text_bumps_generation_once(self):
        self.seed_text()
        def snapshot():
            with api_app.get_db() as db:
                return (tuple(db.execute("SELECT payload,updated_at FROM capture_image_text").fetchone()),
                        tuple(db.execute("SELECT payload,digest,updated_at FROM asset_image_text").fetchone()),
                        db.execute("SELECT generation FROM asset_list_generation").fetchone()[0],
                        api_app.list_generation(db))
        original = snapshot()
        with mock.patch.object(api_app, "now_iso", return_value="2099-01-01T00:00:00Z"):
            self.assertFalse(self.create(image_text=LINES).json()["created"])
        self.assertEqual(snapshot(), original)
        # Also exercise the Asset guard independently of the Capture guard.
        with api_app.get_db() as db:
            capture_id = db.execute("SELECT id FROM captures").fetchone()[0]
            before = db.total_changes
            asset_authority.copy_capture_image_text(db, capture_id, self.asset_id, "later")
            self.assertEqual(db.total_changes, before)
            db.commit()
        latest = [{"original": "new", "korean": "새 번역"}]
        self.assertFalse(self.create(image_text=latest).json()["created"])
        changed = snapshot()
        self.assertEqual(changed[2], original[2] + 1)
        self.assertNotEqual(changed[3], original[3])
        self.assertEqual(json.loads(changed[0][0]), latest)
        self.assertEqual(json.loads(changed[1][0]), latest)
        self.assertNotEqual(changed[1][1], original[1][1])
        self.assertEqual(changed[1][1], hashlib.sha256(changed[1][0].encode()).hexdigest())
        self.assertFalse(self.create(image_text=latest).json()["created"])
        self.assertEqual(snapshot(), changed)

    def test_list_serializers_use_the_existing_connection_and_keep_flags(self):
        self.seed_text()
        with api_app.get_db() as db:
            library_search.startup_db(db)
            db.execute("UPDATE assets SET collected_at='2025-10-12T00:00:00Z',creator_handle='example'")
            library_description.publish(db, {"version": 1, "captions": [
                {"assetId": self.asset_id, "text": "blue sky"}], "names": []})
            db.commit()
            row = library_assets.image_text_flags(db, [
                db.execute("SELECT * FROM assets WHERE id=?", [self.asset_id]).fetchone()])[0]
        with mock.patch.object(api_app, "get_db", side_effect=AssertionError("serializer opened DB")):
            self.assertTrue(library_assets.mobile_asset_item(row)["has_image_text"])
        paths = ("/v1/library/search/description?q=blue&force=true",
                 "/v1/library/revisit?home=true&day=2026-10-12",
                 "/v1/library/revisit", "/v1/library/revisit/date",
                 "/v1/library/revisit/creator/example/assets")
        connect = sqlite3.connect
        for path in paths:
            with self.subTest(path=path), mock.patch.object(sqlite3, "connect", wraps=connect) as connections:
                response = self.client.get(path, headers=self.admin)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(connections.call_count, 1)
                body = response.json()
                items = body.get("items", [])
                for bundle in body.get("bundles", []):
                    items.extend(bundle.get("items", []))
                    for group in bundle.get("groups", []):
                        items.extend(group["items"])
                self.assertTrue(items, body)
                self.assertTrue(all(item["has_image_text"] for item in items), body)

    def test_wal_reader_snapshot_does_not_block_writer(self):
        self.seed_text()
        with ThreadPoolExecutor(max_workers=1) as pool:
            def check_snapshot(reader):
                self.assertTrue(reader.in_transaction)
                generation = api_app.list_generation(reader)
                elapsed = pool.submit(self.writer, change=True).result(timeout=1)
                self.assertLess(elapsed, 1)
                self.assertEqual(api_app.list_generation(reader), generation)

            with api_app.get_db() as reader:
                reader.execute("BEGIN")
                self.assertEqual(len(asset_authority.asset_page(reader, LIBRARY, None, 1000)), 1)
                check_snapshot(reader)

            original_get_db = api_app.get_db
            for path in ("/v1/library/assets", f"/v1/library/assets/{self.asset_id}/image-text"):
                observed = []

                class Cursor:
                    def __init__(self, cursor, reader):
                        self.cursor, self.reader = cursor, reader

                    def fetchall(self):
                        rows = self.cursor.fetchall()
                        check_snapshot(self.reader)
                        observed.append(True)
                        return rows

                    def fetchone(self):
                        row = self.cursor.fetchone()
                        check_snapshot(self.reader)
                        observed.append(True)
                        return row

                class Reader:
                    def __init__(self, db):
                        self.db = db

                    def __getattr__(self, name):
                        return getattr(self.db, name)

                    def execute(self, sql, *args):
                        target = sql.startswith("SELECT") and (
                            "asset.*" in sql or "text.payload,text.digest" in sql)
                        if target and not self.db.in_transaction:
                            self.db.execute("BEGIN")
                        cursor = self.db.execute(sql, *args)
                        return Cursor(cursor, self.db) if target else cursor

                @contextmanager
                def reading_db():
                    with original_get_db() as db:
                        yield Reader(db)

                with self.subTest(path=path), mock.patch.object(api_app, "get_db", reading_db):
                    response = self.client.get(path, headers=self.admin)
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertTrue(observed, "reader checkpoint was not exercised")
                self.assert_writer_available()

    def test_capture_and_duplicate_failure_release_writer_and_rollback(self):
        self.seed_text()
        original = capture_routes.store_image_text

        def fail_after_text(db, *args):
            original(db, *args)
            self.assertTrue(db.in_transaction)
            raise RuntimeError("injected image text failure")

        for changes in ({"source_url": "https://x.com/example/status/125/photo/1"}, {}):
            with self.subTest(changes=changes):
                with mock.patch.object(capture_routes, "store_image_text", side_effect=fail_after_text):
                    with mock.patch.object(api_app, "delete_r2_object"):
                        with self.assertRaisesRegex(RuntimeError, "injected image text failure"):
                            self.create(image_text=[{"original": "changed", "korean": "변경"}], **changes)
                self.assert_writer_available()
                with api_app.get_db() as db:
                    self.assertEqual(db.execute("SELECT count(*) FROM captures").fetchone()[0], 1)
                    self.assertEqual(json.loads(db.execute("SELECT payload FROM capture_image_text").fetchone()[0]), LINES)
                    self.assertEqual(json.loads(db.execute("SELECT payload FROM asset_image_text").fetchone()[0]), LINES)

    def test_command_failure_releases_writer_and_rolls_back_state_and_feed(self):
        self.seed_text()
        original = asset_authority._record_change

        def fail_after_change(db, **kwargs):
            original(db, **kwargs)
            self.assertTrue(db.in_transaction)
            raise RuntimeError("injected change failure")

        before = self.changes()["cursor"]
        with mock.patch.object(asset_authority, "_record_change", side_effect=fail_after_change):
            with self.assertRaisesRegex(RuntimeError, "injected change failure"):
                self.command(asset_authority.TRASH_ASSET, self.asset_id, 1)
        self.assert_writer_available()
        with api_app.get_db() as db:
            self.assertEqual(tuple(asset_authority.state_row(db, LIBRARY, self.asset_id)[:2]),
                             (asset_authority.NORMAL, 1))
            self.assertEqual(db.execute("SELECT count(*) FROM asset_authority_receipts").fetchone()[0], 0)
        self.assertEqual(self.changes()["cursor"], before)

    def test_replication_failure_releases_writer_and_rolls_back_state_and_feed(self):
        self.seed_text()
        identity = str(uuid.uuid4())
        prepared = self.client.post("/v1/replication/prepare", headers=self.publisher,
                                    json={"asset_id": identity, "kind": "image", "sha256": "b" * 64})
        self.assertEqual(prepared.status_code, 200, prepared.text)
        original = asset_authority.register_replication

        def fail_after_register(db, *args):
            original(db, *args)
            self.assertTrue(db.in_transaction)
            raise RuntimeError("injected replication failure")

        before = self.changes()["cursor"]
        with mock.patch.object(asset_authority, "register_replication", side_effect=fail_after_register):
            with self.assertRaisesRegex(RuntimeError, "injected replication failure"):
                self.client.post("/v1/replication/commit", headers=self.publisher, json={
                    "asset_id": identity, "kind": "image", "content_type": "image/png",
                    "original": {"object_key": f"library/{identity}/original",
                                 "content_type": "image/png", "size_bytes": 5, "sha256": "b" * 64},
                    "thumbnail": {"object_key": f"library/{identity}/thumbnail",
                                  "content_type": "image/webp", "size_bytes": 5},
                    "classification_ids": []})
        self.assert_writer_available()
        with api_app.get_db() as db:
            self.assertIsNone(asset_authority.state_row(db, LIBRARY, identity))
            self.assertEqual(db.execute("SELECT committed FROM assets WHERE id=?", [identity]).fetchone()[0], 0)
        self.assertEqual(self.changes()["cursor"], before)
