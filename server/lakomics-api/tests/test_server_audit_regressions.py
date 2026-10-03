"""Audit regressions on disposable databases, without production storage calls."""
import asyncio
import copy
import sqlite3
import threading
import unittest
from types import SimpleNamespace
from unittest import mock

from fastapi import HTTPException

import collection_authority as collections
import library_thumbnails as thumbnails
import media_tickets as tickets
import mobile_catalog
from tests import test_home_upcoming as home
from tests import test_classification_authority as classification
from tests import test_library_thumbnail_uploads as thumbnail
from tests import test_media_ticket_bounds as bounds
from tests import test_mobile_catalog as catalog


class UpcomingCursorTests(home.HomeFixture):
    module = home.upcoming
    put = home.UpcomingRoutes.put
    get = home.UpcomingRoutes.get
    intent = home.UpcomingRoutes.intent

    def test_stale_or_missing_cursor_preserves_acknowledged_wish(self):
        self.ok(self.put(home.snapshot(entries=[home.title("tmdb:77", kind="movie")], wishlist=[])))
        self.ok(self.intent(item="tmdb:77"))
        body = home.snapshot(cursor=1)
        first = self.ok(self.put(body))
        preserved = self.ok(self.get())
        self.assertEqual(len(preserved["wishlist"]), 1)
        self.assertEqual(preserved["pending"], [])
        for cursor in (0, None):
            with self.subTest(cursor=cursor):
                reply = self.put(home.snapshot(cursor=cursor, wishlist=[]))
                self.assertEqual((reply.status_code, self.code(reply)),
                                 (409, "upcomingIntentCursorRejected"))
                self.assertEqual(self.ok(self.get()), preserved)
        again = self.ok(self.put(body))
        self.assertEqual(again["revision"], first["revision"])
        self.assertFalse(again["changed"])


class ClassificationEpochTests(classification.ClassificationAuthorityFixture):
    def test_past_and_future_epochs_require_baseline_restart(self):
        self.activate(epoch=2, cursor=1)
        for epoch in (1, 3):
            for read in (self.baseline, self.changes):
                with self.subTest(epoch=epoch, route=read.__name__):
                    self.assert_coded(read(epoch=epoch), 409, "baselineChanged")
        for read in (self.baseline, self.changes):
            reply = read(epoch=2)
            self.assertEqual(reply.status_code, 200, reply.text)
            self.assertEqual(reply.json()["epoch"], 2)


class CollectionBatchPlanTests(unittest.TestCase):
    def test_requested_works_drive_member_lookup_with_and_without_statistics(self):
        class Capture(sqlite3.Connection):
            def execute(self, sql, parameters=()):
                if "WITH requested(work_id,cover_id)" in sql:
                    self.query = sql, parameters
                return super().execute(sql, parameters)

        with sqlite3.connect(":memory:", factory=Capture) as db:
            self.addCleanup(db.close)
            db.executescript("""
                CREATE TABLE assets(id TEXT PRIMARY KEY,committed INTEGER);
                CREATE TABLE authority_domains(library_id TEXT,domain TEXT);
                CREATE TABLE asset_authority_state(library_id TEXT,asset_id TEXT,lifecycle TEXT,
                    PRIMARY KEY(library_id,asset_id));
                INSERT INTO authority_domains VALUES('library','assets');
                CREATE TABLE collection_authority_members(
                    library_id TEXT,work_id TEXT,asset_id TEXT,desired_state INTEGER,
                    entity_revision INTEGER,added_at TEXT,updated_at TEXT,
                    PRIMARY KEY(library_id,work_id,asset_id));
                CREATE INDEX collection_authority_members_live
                    ON collection_authority_members(library_id,work_id,desired_state,added_at,asset_id);
                CREATE INDEX collection_authority_members_by_asset
                    ON collection_authority_members(library_id,asset_id);
            """)
            db.executemany("INSERT INTO assets VALUES(?,?)",
                           [(str(i), int(i != 2)) for i in range(10000)])
            db.executemany("INSERT INTO asset_authority_state VALUES('library',?,'normal')",
                           [(str(i),) for i in range(10000) if i != 4])
            db.executemany("INSERT INTO collection_authority_members VALUES(?,?,?,?,1,?,?)",
                           [("library", "target" if i < 4 else "other", str(i), int(i != 3),
                             f"{i:05}", "now") for i in range(10000)])
            items = [{"id": "target", "coverAssetId": "1"},
                     *[{"id": f"empty-{i}", "coverAssetId": "missing"} for i in range(49)]]
            for analyzed in (False, True):
                if analyzed:
                    db.execute("ANALYZE")
                actual = collections.finalize_items(db, "library", copy.deepcopy(items))
                sql, parameters = db.query
                plan = [r[3] for r in db.execute("EXPLAIN QUERY PLAN " + sql, parameters)]
                loops = [s for s in plan if s.startswith(("SCAN", "SEARCH")) and "CONSTANT" not in s]
                self.assertTrue(loops[0].startswith("SCAN requested"), plan)
                member = next(s for s in loops if "member " in s)
                self.assertIn("library_id=? AND work_id=? AND desired_state=?", member)
                asset = next(s for s in loops if "asset " in s)
                self.assertIn("id=?", asset)
                old_sql = sql.replace("CROSS JOIN", "JOIN")
                self.assertEqual(db.execute(sql, parameters).fetchall(),
                                 db.execute(old_sql, parameters).fetchall())
                self.assertEqual([(i["assetCount"], i["coverAssetId"]) for i in actual],
                                 [(2, "1"), *[(0, None)] * 49])


class ReceiptAdmissionTests(unittest.TestCase):
    setUp = bounds.TicketBoundsTests.setUp
    tearDown = bounds.TicketBoundsTests.tearDown
    get_db = bounds.TicketBoundsTests.get_db

    def test_verified_thumbnail_succeeds_with_all_eight_head_slots_occupied(self):
        digest = "a" * 64
        key = thumbnails.immutable_key(digest)
        with self.get_db() as db:
            for field, kind in (("sha256", "TEXT"), ("thumbnail_sha256", "TEXT"),
                                ("thumbnail_metadata_key", "TEXT"), ("thumbnail_verified", "INTEGER"),
                                ("thumbnail_size_bytes", "INTEGER"), ("thumbnail_content_type", "TEXT")):
                db.execute(f"ALTER TABLE visible_assets ADD COLUMN {field} {kind}")
            db.execute("UPDATE visible_assets SET thumbnail_key=?,thumbnail_metadata_key=?,"
                       "thumbnail_sha256=?,thumbnail_verified=1,thumbnail_size_bytes=12,"
                       "thumbnail_content_type='image/webp' WHERE id='0'", (key, key, digest))
            db.commit()
        self.services._ticket_head = tickets._ticket_head
        self.services._s3 = SimpleNamespace(head_object=mock.Mock(side_effect=AssertionError("HEAD")))
        self.services.R2_BUCKET = "test"
        slots = tickets._head_slots
        for _ in range(8):
            self.assertTrue(slots.acquire(blocking=False))
        try:
            request = tickets.MediaTicketBatchRequest(items=[
                {"asset_id": "0", "variant": "original"},
                {"asset_id": "0", "variant": "thumbnail"},
                {"asset_id": "missing", "variant": "thumbnail"},
                {"asset_id": "0", "variant": "thumbnail"}])
            with mock.patch.object(self.pool, "submit", wraps=self.pool.submit) as submit:
                result = tickets.create_mobile_media_tickets(
                    request, None, None, False, False,
                    _deadline=tickets.time.monotonic() + 0.05)["items"]
                self.assertEqual(len(result), 3)
                self.assertEqual(result[0]["error"], "storage_unavailable")
                self.assertTrue(result[1]["ok"], result)
                self.assertEqual(result[1]["size_bytes"], 12)
                self.assertEqual(result[2]["error"], "not_found")
                submit.assert_not_called()
            fresh = tickets.create_mobile_media_tickets(
                request, None, None, True, False,
                _deadline=tickets.time.monotonic() + 0.05)["items"]
            self.assertEqual(fresh[1]["error"], "storage_unavailable")
            cancelled = threading.Event()
            cancelled.set()
            result = tickets.create_mobile_media_tickets(
                request, None, None, False, False, _cancelled=cancelled)["items"]
            self.assertFalse(result[1]["ok"])
            self.services._s3.head_object.assert_not_called()
        finally:
            for _ in range(8):
                slots.release()


class GenerationUpdateTests(thumbnail.Fixture):
    def test_existing_trigger_is_replaced_and_only_visible_changes_bump(self):
        self.seed()
        with thumbnail.api.get_db() as db:
            db.execute("DROP TRIGGER asset_list_update")
            db.execute("CREATE TRIGGER asset_list_update AFTER UPDATE ON assets BEGIN "
                       "UPDATE asset_list_generation SET generation=generation+1; END")
            thumbnails.install(db)
            thumbnails.install(db)
            db.commit()
        generation = self.gen()
        for sql in ("UPDATE assets SET creator_name=creator_name,committed=committed",
                    "UPDATE assets SET metadata_revision=metadata_revision+1,metadata_commit_id='new'",
                    "UPDATE assets SET updated_at='internal-update',sha256='changed-digest'"):
            with thumbnail.api.get_db() as db:
                db.execute(sql)
                db.commit()
            self.assertEqual(self.gen(), generation, sql)
        # Assets have no title column; creator_name is displayed by the tablet mapper.
        for sql in ("UPDATE assets SET creator_name='New creator'",
                    "UPDATE assets SET width=1200", "UPDATE assets SET committed=0",
                    "UPDATE assets SET source_url='https://test.invalid/source'",
                    "UPDATE assets SET collected_at='2026-10-01'"):
            with thumbnail.api.get_db() as db:
                db.execute(sql)
                db.commit()
            generation += 1
            self.assertEqual(self.gen(), generation, sql)


class CatalogThreadpoolTests(unittest.TestCase):
    setUp = catalog.MobileCatalogApiTests.setUp
    tearDown = catalog.MobileCatalogApiTests.tearDown

    def endpoint(self, suffix):
        return next(r.endpoint for r in self.app.routes
                    if getattr(r, "path", "") == mobile_catalog.PREFIX + suffix)

    def run_async(self, awaitable):
        async def scenario():
            # A timer also lets this sandbox deliver thread completions when
            # asyncio's optional socket wakeup is unavailable.
            async def heartbeat():
                while True:
                    await asyncio.sleep(0.002)
            tick = asyncio.create_task(heartbeat())
            try:
                return await awaitable
            finally:
                tick.cancel()
                await asyncio.gather(tick, return_exceptions=True)
        return asyncio.run(scenario())

    def request(self, data, error=None):
        async def stream():
            yield data[:10]
            if error:
                raise error
            yield data[10:]
        return SimpleNamespace(stream=stream)

    def test_upload_file_io_runs_off_loop_and_cleanup_preserves_error(self):
        loop_thread = threading.get_ident()
        original = mobile_catalog.tempfile.NamedTemporaryFile
        original_unlink = mobile_catalog.Path.unlink
        operations = []

        def check(operation):
            self.assertNotEqual(threading.get_ident(), loop_thread, operation)
            operations.append(operation)

        class File:
            def __init__(self, wrapped):
                self.wrapped, self.name = wrapped, wrapped.name
            def write(self, data):
                check("write")
                return self.wrapped.write(data)
            def close(self):
                check("close")
                return self.wrapped.close()
            def __enter__(self):
                return self
            def __exit__(self, *_):
                self.close()

        def open_file(**kwargs):
            check("open")
            return File(original(**kwargs))

        def unlink(path, **kwargs):
            check("unlink")
            return original_unlink(path, **kwargs)

        upload = self.endpoint("/replicas/{digest}")
        with mock.patch.object(mobile_catalog.tempfile, "NamedTemporaryFile", side_effect=open_file), \
                mock.patch.object(mobile_catalog.Path, "unlink", unlink):
            self.run_async(upload(self.digest, self.request(self.data), catalog.AUTH["Authorization"]))
            self.assertEqual(operations[:4], ["open", "write", "write", "close"])
            self.assertIn("close", operations)
            self.assertIn("unlink", operations)
            error = RuntimeError("stream disconnected")
            with self.assertRaises(RuntimeError) as caught:
                self.run_async(upload(self.digest, self.request(self.data, error),
                                      catalog.AUTH["Authorization"]))
            self.assertIs(caught.exception, error)
            # Failure must release the admission lock and remove temporary files.
            self.run_async(upload(self.digest, self.request(self.data), catalog.AUTH["Authorization"]))
        self.assertEqual(list((self.root / "artifacts").glob("upload-*.ndjson")), [])

    def test_bookmark_authority_load_runs_off_loop_before_publication(self):
        loop_thread = threading.get_ident()
        calls = []
        def load(_get_db):
            self.assertNotEqual(threading.get_ident(), loop_thread)
            calls.append("load")
            return {"libraryId": "a" * 32}
        def publish(*args, **kwargs):
            calls.append("publish")
            return {"ok": True}
        route = self.endpoint("/publication")
        with mock.patch.object(mobile_catalog.catalog_bookmarks, "load", side_effect=load), \
                mock.patch.object(mobile_catalog.replica, "publish", side_effect=publish), \
                mock.patch.object(self.app.state.catalog_pruner, "trigger"), \
                mock.patch.object(self.app.state.catalog_duplicate_index, "trigger"):
            result = self.run_async(route(self.request(b"{}"), catalog.AUTH["Authorization"], "a" * 32))
            self.assertEqual(result, {"ok": True})
            self.assertEqual(calls, ["load", "publish"])
            calls.clear()
            with self.assertRaises(HTTPException) as caught:
                self.run_async(route(self.request(b"{}"), catalog.AUTH["Authorization"], "b" * 32))
            self.assertEqual(caught.exception.status_code, 409)
            self.assertEqual(calls, ["load"])
