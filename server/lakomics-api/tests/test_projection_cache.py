"""Process-local projection caches: invalidation inputs, ETags and cached-route parity.

The route suites below are re-run with the startup invalidation DDL installed, so
every existing assertion also holds when responses may come from the cache.
"""
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests import test_capture_api_stub  # noqa: F401 (stubs the object store before app imports)
import app as api_app
import classification_authority
from projection_cache import ProjectionCache, install_generation_triggers

from tests import (test_classification_cutover, test_home_revisit, test_library_artists,
                   test_mobile_characters, test_mobile_library_api, test_mobile_library_summary)


def generation(db):
    return db.execute("SELECT generation FROM projection_generation WHERE singleton=1").fetchone()[0]


class GenerationTriggerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "cache.sqlite"
        self.db = sqlite3.connect(self.path)
        self.db.executescript("""
            CREATE TABLE asset_list_generation(singleton INTEGER PRIMARY KEY, generation INTEGER NOT NULL);
            INSERT INTO asset_list_generation VALUES(1, 7);
            CREATE TABLE asset_classifications(asset_id TEXT, classification_id TEXT);
            CREATE TABLE library_asset_ratings(asset_id TEXT PRIMARY KEY, content_rating TEXT);
            CREATE TABLE asset_authority_state(library_id TEXT, asset_id TEXT, lifecycle TEXT);
            CREATE TABLE mobile_collections(id TEXT PRIMARY KEY, type TEXT);
        """)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_installation_changes_no_existing_revision_and_is_idempotent(self):
        install_generation_triggers(self.db)
        install_generation_triggers(self.db)
        self.db.commit()
        self.assertEqual(generation(self.db), 0)
        self.assertEqual(self.db.execute("SELECT generation FROM asset_list_generation").fetchone()[0], 7)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0], 12)

    def test_every_input_write_bumps_only_the_private_counter(self):
        install_generation_triggers(self.db)
        writes = [
            "INSERT INTO asset_classifications VALUES('a','c')",
            "UPDATE asset_classifications SET classification_id='d'",
            "DELETE FROM asset_classifications",
            "INSERT INTO library_asset_ratings VALUES('a','g')",
            "UPDATE library_asset_ratings SET content_rating='r'",
            "INSERT INTO asset_authority_state VALUES('l','a','normal')",
            "UPDATE asset_authority_state SET lifecycle='trash'",
            "INSERT INTO mobile_collections VALUES('1','game')",
            "DELETE FROM mobile_collections",
        ]
        for sql in writes:
            before = generation(self.db)
            self.db.execute(sql)
            self.assertEqual(generation(self.db), before + 1, sql)
        self.assertEqual(self.db.execute("SELECT generation FROM asset_list_generation").fetchone()[0], 7)

    def test_a_rolled_back_write_leaves_the_counter_alone(self):
        install_generation_triggers(self.db)
        self.db.commit()
        self.db.execute("INSERT INTO library_asset_ratings VALUES('a','g')")
        self.db.rollback()
        self.assertEqual(generation(self.db), 0)

    def test_keys_need_the_installed_counter_and_a_file_database(self):
        cache = ProjectionCache()
        self.assertIsNone(cache.key(self.db, "r"))
        install_generation_triggers(self.db)
        first = cache.key(self.db, "r")
        self.assertIsNotNone(first)
        self.assertEqual(first, cache.key(self.db, "r"))
        self.assertNotEqual(first, cache.key(self.db, "other"))
        self.db.execute("INSERT INTO library_asset_ratings VALUES('a','g')")
        self.assertNotEqual(first, cache.key(self.db, "r"))
        memory = sqlite3.connect(":memory:")
        try:
            install_generation_triggers(memory)
            self.assertIsNone(cache.key(memory, "r"))
        finally:
            memory.close()

    def test_cache_is_bounded_and_none_keys_are_never_stored(self):
        cache = ProjectionCache(capacity=2)
        self.assertEqual(cache.put(None, b"x"), b"x")
        self.assertIsNone(cache.get(None))
        for name in ("a", "b", "c"):
            cache.put(name, name.encode())
        self.assertIsNone(cache.get("a"))
        self.assertEqual((cache.get("b"), cache.get("c")), (b"b", b"c"))


class StartupHookTests(unittest.TestCase):
    def test_hook_adds_the_counter_without_moving_the_list_generation(self):
        with tempfile.TemporaryDirectory() as temp:
            old = api_app.DB_PATH
            api_app.DB_PATH = Path(temp) / "fixture.sqlite"
            try:
                api_app.startup()
                api_app.startup_replication()
                with api_app.get_db() as db:
                    before = api_app.list_generation(db)
                api_app.startup_library_projection_cache()
                api_app.startup_library_projection_cache()
                with api_app.get_db() as db:
                    self.assertEqual(api_app.list_generation(db), before)
                    self.assertEqual(generation(db), 0)
            finally:
                api_app.DB_PATH = old


def with_cache(base, **extra):
    """A subclass of ``base`` whose app has the cache invalidation DDL installed."""
    def setUp(self):
        base.setUp(self)
        api_app.startup_library_projection_cache()
        # A test may create a component table after the hook; production creates them all before.
        original = classification_authority.startup

        def startup(get_db, *args, **kwargs):
            original(get_db, *args, **kwargs)
            api_app.startup_library_projection_cache()
        patch = mock.patch.object(classification_authority, "startup", startup)
        patch.start()
        self.addCleanup(patch.stop)
    return type("Cached" + base.__name__, (base,), {"setUp": setUp, "__module__": __name__, **extra})


class CachedArtistRoutes(test_library_artists.ArtistRoutes):
    def setUp(self):
        super().setUp()
        with self.get_db() as db:
            install_generation_triggers(db)
            db.commit()


def test_classification_relation_and_etag_follow_a_direct_write(self):
    self.publish("one", "2026-09-24T20:00:00Z")
    first = self.client.get("/v1/library/summary", headers=self.reader)
    self.assertEqual(first.json()["unclassified"], 1)
    etag = first.headers["ETag"]
    same = self.client.get("/v1/library/summary", headers={**self.reader, "If-None-Match": etag})
    self.assertEqual(same.status_code, 304)
    with api_app.get_db() as db:
        db.execute("INSERT INTO asset_classifications VALUES('one', ?, '2026')",
                   [test_mobile_library_summary.CLASS_ID])
        db.commit()
    changed = self.client.get("/v1/library/summary", headers={**self.reader, "If-None-Match": etag})
    self.assertEqual(changed.status_code, 200)
    self.assertEqual(changed.json()["unclassified"], 0)
    self.assertNotEqual(changed.headers["ETag"], etag)


CachedSummaryRoutes = with_cache(
    test_mobile_library_summary.MobileLibrarySummaryTests,
    test_classification_relation_and_etag_follow_a_direct_write=test_classification_relation_and_etag_follow_a_direct_write)
CachedCharacterRoutes = with_cache(test_mobile_characters.MobileCharactersTests)
CachedHomeRevisitRoutes = with_cache(test_home_revisit.HomeRouteTests)
CachedClassificationTreeRoutes = with_cache(test_classification_cutover.ClassificationTreeCutoverTests)


def test_a_classification_batch_rebuilds_the_cached_counts(self):
    self.prepare_asset()
    self.assertEqual(self.commit_asset(test_classification_cutover.ROOT, 0, "legacy-relation").status_code, 200)
    staged = self.stage(test_classification_cutover.snapshot(
        assignments=[{"assetId": test_classification_cutover.ASSET,
                      "classificationId": test_classification_cutover.ROOT}]))
    self.assertEqual(self.activate(staged.json()["snapshotDigest"]).status_code, 200)

    def counts():
        listed = self.client.get("/v1/library/classifications", headers=self.admin)
        self.assertEqual(listed.status_code, 200, listed.text)
        return {item["id"]: item["asset_count"] for item in listed.json()["items"]}

    self.assertEqual(counts()[test_classification_cutover.ROOT], 1)
    self.assertEqual(counts()[test_classification_cutover.TAG], 0)
    with api_app.get_db() as db:
        before = generation(db)
    batch = self.client.put("/v1/classifications/authority/commands/batch", headers=self.publisher, json={
        "libraryId": test_classification_cutover.LIBRARY, "epoch": 1, "contractVersion": 1,
        "batchId": "44444444-4444-4444-8444-444444444444",
        "commands": [{"operationId": "55555555-5555-4555-8555-555555555555",
                      "commandType": "setAssetClassification",
                      "assetId": test_classification_cutover.ASSET,
                      "classificationId": test_classification_cutover.TAG, "expectedRevision": 1}]})
    self.assertEqual(batch.status_code, 200, batch.text)
    self.assertEqual(batch.json()["results"][0]["status"], "applied")
    with api_app.get_db() as db:
        self.assertGreater(generation(db), before)
    rebuilt = counts()
    self.assertEqual(rebuilt[test_classification_cutover.TAG], 1)
    self.assertEqual(rebuilt[test_classification_cutover.ROOT], 0)


CachedClassificationBatchRoutes = with_cache(
    test_classification_cutover.CutoverFixture,
    test_a_classification_batch_rebuilds_the_cached_counts=test_a_classification_batch_rebuilds_the_cached_counts)
