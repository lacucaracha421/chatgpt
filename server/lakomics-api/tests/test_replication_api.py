"""CLOUD-006 배치 2: 전체 라이브러리 복제 계약 테스트.

prepare → 업로드(기존 presign) → commit의 멱등성과, 커밋 전 자산이
모바일 조회(/v1/assets)에 노출되지 않음을 검증한다. Cloud Capture 흐름은
건드리지 않는다.
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

import sqlite3

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

# r2 스텁을 app보다 먼저 설치해 R2 env 없이 import 가능하게 한다.
from tests.test_capture_api_stub import fake_s3  # noqa: E402

import app as api_app  # noqa: E402
from fastapi.testclient import TestClient


class ReplicationStartupTests(unittest.TestCase):
    def test_registered_startup_handlers_initialize_a_fresh_database(self):
        hooks = api_app.lifecycle(api_app.app)
        expected_startup = [
            "app.startup",
            "app.startup_replication",
            "app.startup_captures",
            "app.startup_classifications",
            "app.startup_saved_x_media",
            "app.startup_extension_profile",
            "app.startup_extension_backup",
            "app.startup_album_replica",
            "notes.register_notes.<locals>.startup_notes",
            "mobile_catalog.register_mobile_catalog.<locals>.startup",
            "prune_catalog_artifacts.AutoPruner.start",
            "mobile_catalog_refresh.RefreshWorker.startup",
            "catalog_duplicates.register.<locals>.startup",
            "mobile_collections.register_collections.<locals>.startup_collections",
            "mobile_characters.register_characters.<locals>.startup",
            "sync_status.register_sync_status.<locals>.startup",
            "album_authority.register_album_authority.<locals>.<lambda>",
            "classification_authority.register_classification_authority.<locals>.<lambda>",
            "asset_authority.register_asset_authority.<locals>.<lambda>",
            "extension_settings.register.<locals>.startup",
            "app.startup_image_thumbnails",
        ]
        expected_shutdown = [
            "prune_catalog_artifacts.AutoPruner.stop",
            "mobile_catalog_refresh.RefreshWorker.shutdown",
            "app.shutdown_image_thumbnails",
        ]
        calls = []

        def record(handler):
            def run():
                handler()
                calls.append(f"{handler.__module__}.{handler.__qualname__}")
            return run

        async def async_startup():
            await asyncio.sleep(0)
            calls.append("async_startup")

        async def async_shutdown():
            await asyncio.sleep(0)
            calls.append("async_shutdown")

        async def run_lifespan():
            async with api_app.app.router.lifespan_context(api_app.app):
                self.assertEqual(calls, expected_startup + ["async_startup"])
            self.assertEqual(calls, expected_startup + ["async_startup"]
                             + expected_shutdown + ["async_shutdown"])
            self.assertIsNone(api_app._image_thumbnail_worker)

        refresh_worker = next(handler.__self__ for handler in hooks.shutdown_handlers
                              if handler.__module__ == "mobile_catalog_refresh")

        with tempfile.TemporaryDirectory() as temp_dir:
            original_database_path = api_app.DB_PATH
            api_app.DB_PATH = Path(temp_dir) / "lakomics.sqlite3"
            try:
                with mock.patch.object(hooks, "startup_handlers", [
                    *map(record, hooks.startup_handlers), async_startup,
                ]), mock.patch.object(hooks, "shutdown_handlers", [
                    *map(record, hooks.shutdown_handlers), async_shutdown,
                ]):
                    asyncio.run(run_lifespan())
                    self.assertFalse(refresh_worker.thread.is_alive())
            finally:
                api_app.DB_PATH = original_database_path


class ReplicationTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "lakomics.sqlite3"
        self.original_database_path = api_app.DB_PATH
        self.original_api_token = api_app.API_TOKEN
        api_app.DB_PATH = self.database_path
        api_app.API_TOKEN = "test-token"
        api_app.startup()
        api_app.startup_replication()
        self.client = TestClient(api_app.app)

    def tearDown(self) -> None:
        self.client.close()
        api_app.DB_PATH = self.original_database_path
        api_app.API_TOKEN = self.original_api_token
        self.temp_dir.cleanup()

    @property
    def auth(self):
        return {"Authorization": "Bearer test-token"}

    def rows(self, query: str, params: tuple = ()):
        with closing(sqlite3.connect(self.database_path)) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute(query, params).fetchall()]

    def prepare(self, asset_id: str = "00000000-0000-4000-8000-000000000001", **overrides):
        body = {
            "asset_id": asset_id,
            "kind": "image",
            "content_type": "image/png",
            "size_bytes": 17,
            "sha256": "a" * 64,
            "collected_at": "2026-08-30T00:00:00Z",
        }
        body.update(overrides)
        return self.client.post("/v1/replication/prepare", headers=self.auth, json=body)

    def test_stale_commit_cannot_overwrite_newer_revision_or_legacy_downgrade(self):
        first = self.prepare().json()
        self.assertEqual(first["metadata_revision"], 0)
        self.assertEqual(self.commit(expected_revision=0, commit_id="new", classification_ids=["new-folder"]).status_code, 200)
        delayed = self.commit(expected_revision=0, commit_id="old", classification_ids=["old-folder"])
        self.assertEqual(delayed.status_code, 409)
        self.assertEqual(self.commit(classification_ids=["legacy-folder"]).status_code, 409)
        self.assertEqual(self.rows("SELECT classification_id FROM asset_classifications"), [{"classification_id": "new-folder"}])
        self.assertEqual(self.prepare().json()["metadata_revision"], 1)
        self.assertEqual(self.commit(expected_revision=0, commit_id="new", classification_ids=["new-folder"]).status_code, 200)
        self.assertEqual(self.prepare().json()["metadata_revision"], 1)
        # A restart/restored local DB obtains the server revision instead of reusing a local counter.
        self.assertEqual(self.commit(expected_revision=1, commit_id="restored", classification_ids=["restored-folder"]).status_code, 200)
        self.assertEqual(self.commit(expected_revision=1, commit_id="late", classification_ids=["old-folder"]).status_code, 409)
        self.assertEqual(self.rows("SELECT classification_id FROM asset_classifications"), [{"classification_id": "restored-folder"}])

    def presign(self, object_key: str):
        return self.client.post(
            "/v1/uploads/presign",
            headers=self.auth,
            json={"object_key": object_key, "content_type": "application/octet-stream"},
        )

    def commit(self, asset_id: str = "00000000-0000-4000-8000-000000000001", **overrides):
        body = {
            "asset_id": asset_id,
            "kind": "image",
            "original": {
                "object_key": f"library/{asset_id}/original",
                "content_type": "image/png",
                "size_bytes": 17,
                "sha256": "a" * 64,
            },
            "thumbnail": {
                "object_key": f"library/{asset_id}/thumbnail",
                "content_type": "image/webp",
                "size_bytes": 512,
            },
            "content_type": "image/png",
            "collected_at": "2026-08-30T00:00:00Z",
            "source_published_at": "2026-01-01T00:00:00Z",
            "source_url": "https://x.com/example/status/1",
            "creator_handle": "example",
            "import_source": "Direct",
            "classification_ids": ["class-a", "class-b"],
        }
        body.update(overrides)
        return self.client.post("/v1/replication/commit", headers=self.auth, json=body)

    # --- prepare -----------------------------------------------------------

    def test_prepare_creates_incomplete_asset_and_is_idempotent(self):
        first = self.prepare()
        self.assertEqual(first.status_code, 200)
        self.assertFalse(first.json()["already_committed"])
        self.assertEqual(
            first.json()["object_keys"],
            {
                "original": "library/00000000-0000-4000-8000-000000000001/original",
                "thumbnail": "library/00000000-0000-4000-8000-000000000001/thumbnail",
            },
        )

        second = self.prepare()
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["object_keys"], first.json()["object_keys"])

        rows = self.rows("SELECT COUNT(*) AS n FROM assets")
        self.assertEqual(rows[0]["n"], 1)

    def test_prepare_after_commit_reports_already_committed(self):
        self.prepare()
        committed = self.commit()
        self.assertEqual(committed.status_code, 200)

        again = self.prepare()
        self.assertEqual(again.status_code, 200)
        self.assertTrue(again.json()["already_committed"])

    def test_prepare_rejects_invalid_kind(self):
        response = self.prepare(kind="document")
        self.assertEqual(response.status_code, 422)

    def test_prepare_requires_auth(self):
        response = self.client.post(
            "/v1/replication/prepare",
            json={"asset_id": "a", "kind": "image"},
        )
        self.assertEqual(response.status_code, 401)

    # --- replication upload key contract ---------------------------------

    def test_presign_accepts_exact_replication_variant_keys(self):
        asset_id = "00000000-0000-4000-8000-000000000001"
        for variant in ("original", "thumbnail"):
            object_key = f"library/{asset_id}/{variant}"
            with self.subTest(variant=variant):
                response = self.presign(object_key)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["object_key"], object_key)

    def test_presign_rejects_malformed_replication_keys(self):
        asset_id = "00000000-0000-4000-8000-000000000001"
        invalid_keys = (
            "library/",
            "library/foo",
            "library/not-a-uuid/original",
            f"library/{asset_id}/unexpected",
            f"library/{asset_id}/../../secrets",
            f"library/{asset_id}/original/extra",
            "unrelated/object",
        )
        for object_key in invalid_keys:
            with self.subTest(object_key=object_key):
                self.assertEqual(self.presign(object_key).status_code, 400)

    def test_prepare_keys_are_accepted_by_presign(self):
        prepared = self.prepare()
        self.assertEqual(prepared.status_code, 200)

        for object_key in prepared.json()["object_keys"].values():
            with self.subTest(object_key=object_key):
                response = self.presign(object_key)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["object_key"], object_key)

    # --- visibility --------------------------------------------------------

    def test_incomplete_asset_is_hidden_from_mobile_listing(self):
        self.prepare()
        listing = self.client.get("/v1/assets", headers=self.auth)
        self.assertEqual(listing.status_code, 200)
        self.assertEqual(listing.json()["items"], [])

    def test_committed_asset_becomes_visible_to_mobile_listing(self):
        self.prepare()
        self.commit()
        listing = self.client.get("/v1/assets", headers=self.auth)
        items = listing.json()["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["id"], "00000000-0000-4000-8000-000000000001")
        self.assertEqual(items[0]["committed"], 1)
        self.assertEqual(
            items[0]["thumbnail_key"],
            "library/00000000-0000-4000-8000-000000000001/thumbnail",
        )

    # --- commit ------------------------------------------------------------

    def test_commit_persists_metadata_and_classifications(self):
        self.prepare()
        response = self.commit()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["committed"])

        rows = self.rows(
            "SELECT * FROM assets WHERE id = ?",
            ("00000000-0000-4000-8000-000000000001",),
        )
        self.assertEqual(len(rows), 1)
        asset = rows[0]
        self.assertEqual(asset["committed"], 1)
        self.assertEqual(asset["source_url"], "https://x.com/example/status/1")
        self.assertEqual(asset["creator_handle"], "example")
        self.assertEqual(asset["collected_at"], "2026-08-30T00:00:00Z")
        self.assertEqual(asset["source_published_at"], "2026-01-01T00:00:00Z")
        self.assertEqual(asset["import_source"], "Direct")
        self.assertIsNotNone(asset["committed_at"])

        relations = self.rows(
            """SELECT classification_id FROM asset_classifications
             WHERE asset_id = ? ORDER BY classification_id""",
            ("00000000-0000-4000-8000-000000000001",),
        )
        self.assertEqual(
            [row["classification_id"] for row in relations],
            ["class-a", "class-b"],
        )

    def test_commit_is_idempotent_and_does_not_duplicate_rows(self):
        self.prepare()
        first = self.commit()
        second = self.commit()
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)

        rows = self.rows("SELECT COUNT(*) AS n FROM assets")
        self.assertEqual(rows[0]["n"], 1)
        relations = self.rows("SELECT COUNT(*) AS n FROM asset_classifications")
        self.assertEqual(relations[0]["n"], 2)

    # --- display dimensions (optional, additive) ---------------------------

    def test_commit_persists_optional_dimensions_and_duration(self):
        self.prepare()
        response = self.commit(width=1920, height=1080, duration_ms=65_432)
        self.assertEqual(response.status_code, 200)
        asset = self.rows(
            "SELECT width, height, duration_ms FROM assets WHERE id = ?",
            ("00000000-0000-4000-8000-000000000001",),
        )[0]
        self.assertEqual(asset["width"], 1920)
        self.assertEqual(asset["height"], 1080)
        self.assertEqual(asset["duration_ms"], 65_432)

    def test_legacy_recommit_omitting_new_fields_cannot_erase_known_dimensions(self):
        """A revision-aware recomit that omits the fields must not clear known values.

        Reachable in practice: a local library restored from an older backup re-commits the
        same Asset without the new fields. The first commit is revision 0, so the second
        must present `expected_revision=1` -- the revision the first commit produced.
        """
        asset_id = "00000000-0000-4000-8000-000000000001"
        self.prepare(asset_id)
        # Revision 0 commit supplies the dimensions.
        self.assertEqual(
            self.commit(asset_id=asset_id, expected_revision=0, commit_id="with-dims",
                        width=800, height=600, duration_ms=1_000).status_code,
            200,
        )
        self.assertEqual(
            self.rows("SELECT metadata_revision FROM assets WHERE id = ?", (asset_id,))[0][
                "metadata_revision"
            ],
            1,
        )

        # Same Asset at the next revision, omitting every new field. `commit_id` must differ
        # because an identical commit_id is treated as a replay and short-circuits the write.
        self.assertEqual(
            self.commit(asset_id=asset_id, expected_revision=1, commit_id="legacy-omit",
                        classification_ids=["class-a"]).status_code,
            200,
        )
        asset = self.rows(
            "SELECT width, height, duration_ms FROM assets WHERE id = ?", (asset_id,)
        )[0]
        self.assertEqual(asset["width"], 800)
        self.assertEqual(asset["height"], 600)
        self.assertEqual(asset["duration_ms"], 1_000)

    def test_legacy_client_omitting_new_fields_at_revision_zero(self):
        """A client that predates the fields keeps them NULL at the revision-0 commit."""
        asset_id = "00000000-0000-4000-8000-000000000001"
        self.prepare(asset_id)
        self.assertEqual(
            self.commit(asset_id=asset_id, expected_revision=0, commit_id="legacy-first").status_code,
            200,
        )
        asset = self.rows(
            "SELECT width, height, duration_ms FROM assets WHERE id = ?", (asset_id,)
        )[0]
        self.assertIsNone(asset["width"])
        self.assertIsNone(asset["height"])
        self.assertIsNone(asset["duration_ms"])

    def test_dimensions_upgrade_a_null_row_and_survive_replay(self):
        """A row committed before the fields existed is filled in by a later commit.

        This is the version-aware lane: revision 0 omits the new fields, revision 1 supplies
        them. It is distinct from a legacy client, which keeps omitting them.
        """
        asset_id = "00000000-0000-4000-8000-000000000001"
        self.prepare(asset_id)
        self.assertEqual(
            self.commit(asset_id=asset_id, expected_revision=0, commit_id="first").status_code, 200
        )
        self.assertEqual(
            self.commit(asset_id=asset_id, expected_revision=1, commit_id="with-dims",
                        width=1200, height=1800).status_code,
            200,
        )
        asset = self.rows(
            "SELECT width, height FROM assets WHERE id = ?", (asset_id,)
        )[0]
        self.assertEqual(asset["width"], 1200)
        self.assertEqual(asset["height"], 1800)

        # The same commit_id replays without changing anything and without error.
        self.assertEqual(
            self.commit(asset_id=asset_id, expected_revision=1, commit_id="with-dims",
                        width=1200, height=1800).status_code,
            200,
        )
        replayed = self.rows(
            "SELECT width, height FROM assets WHERE id = ?", (asset_id,)
        )[0]
        self.assertEqual((replayed["width"], replayed["height"]), (1200, 1800))

    def test_stale_revision_after_a_dimension_commit_is_rejected(self):
        """Guards the fixture itself: the second write must be at the revision the first made."""
        asset_id = "00000000-0000-4000-8000-000000000001"
        self.prepare(asset_id)
        self.assertEqual(
            self.commit(asset_id=asset_id, expected_revision=0, commit_id="one",
                        width=10, height=10).status_code,
            200,
        )
        # Reusing revision 0 is stale and must not be silently accepted.
        self.assertEqual(
            self.commit(asset_id=asset_id, expected_revision=0, commit_id="two",
                        width=20, height=20).status_code,
            409,
        )
        asset = self.rows("SELECT width FROM assets WHERE id = ?", (asset_id,))[0]
        self.assertEqual(asset["width"], 10)

    def test_zero_and_negative_dimensions_are_rejected(self):
        """A fabricated zero must not reach storage; the contract requires positive."""
        self.prepare()
        self.assertEqual(self.commit(width=0).status_code, 422)
        self.assertEqual(self.commit(width=-1).status_code, 422)
        self.assertEqual(self.commit(height=0).status_code, 422)
        self.assertEqual(self.commit(height=-1).status_code, 422)
        self.assertEqual(self.commit(duration_ms=-1).status_code, 422)

    def test_explicit_zero_duration_is_a_real_value(self):
        """Duration may legitimately be 0, unlike a zero dimension."""
        asset_id = "00000000-0000-4000-8000-000000000001"
        self.prepare(asset_id)
        self.assertEqual(
            self.commit(asset_id=asset_id, expected_revision=0, commit_id="zero-duration",
                        duration_ms=0).status_code,
            200,
        )
        asset = self.rows("SELECT duration_ms FROM assets WHERE id = ?", (asset_id,))[0]
        self.assertEqual(asset["duration_ms"], 0)

    def test_non_integer_and_boolean_dimensions_are_rejected(self):
        """A float or bool must not be coerced into a fabricated integer dimension."""
        self.prepare()
        self.assertEqual(self.commit(width=10.5).status_code, 422)
        self.assertEqual(self.commit(height=10.5).status_code, 422)
        self.assertEqual(self.commit(duration_ms=10.5).status_code, 422)
        # `True` is an `int` subclass; strict mode must still refuse it.
        self.assertEqual(self.commit(width=True).status_code, 422)
        self.assertEqual(self.commit(height=True).status_code, 422)
        self.assertEqual(self.commit(duration_ms=True).status_code, 422)

    def test_pc_valid_panorama_dimensions_are_accepted(self):
        """A PC-valid panoramic asset must not be refused by a product-limit bound.

        The PC accepts up to 200M total pixels, so one axis can legitimately be very large.
        """
        self.prepare()
        wide = 200_000
        tall = 1_000
        self.assertLessEqual(wide * tall, 200_000_000)
        self.assertEqual(self.commit(width=wide, height=tall).status_code, 200)
        asset = self.rows(
            "SELECT width, height FROM assets WHERE id = ?",
            ("00000000-0000-4000-8000-000000000001",),
        )[0]
        self.assertEqual((asset["width"], asset["height"]), (wide, tall))

    def test_absurd_dimensions_are_rejected(self):
        """Stored values stay inside the publisher and SQLite integer ranges."""
        self.prepare()
        self.assertEqual(self.commit(width=api_app.MAX_ASSET_DIMENSION + 1).status_code, 422)
        self.assertEqual(self.commit(height=api_app.MAX_ASSET_DIMENSION + 1).status_code, 422)
        self.assertEqual(
            self.commit(duration_ms=api_app.MAX_ASSET_DURATION_MS + 1).status_code, 422
        )
        self.assertEqual(
            self.commit(duration_ms=api_app.MAX_ASSET_DURATION_MS).status_code, 200
        )

    def test_rejected_commit_leaves_no_partial_dimension_write(self):
        """Validation happens before the transaction, so a bad request cannot half-apply."""
        self.prepare()
        self.assertEqual(self.commit(width=0).status_code, 422)
        asset = self.rows(
            "SELECT committed, width FROM assets WHERE id = ?",
            ("00000000-0000-4000-8000-000000000001",),
        )[0]
        self.assertEqual(asset["committed"], 0)
        self.assertIsNone(asset["width"])

    def test_persisted_dimensions_are_projected_to_the_mobile_listing(self):
        """The stored values must actually reach the projection mobile reads."""
        asset_id = "00000000-0000-4000-8000-000000000001"
        self.prepare(asset_id)
        self.assertEqual(
            self.commit(asset_id=asset_id, width=1080, height=1440, duration_ms=0).status_code,
            200,
        )
        with api_app.get_db() as db:
            row = db.execute("SELECT * FROM assets WHERE id = ?", (asset_id,)).fetchone()
            items = [api_app.mobile_asset_item(row)]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["width"], 1080)
        self.assertEqual(items[0]["height"], 1440)
        # An explicit zero duration is a real value for a still image, not "unknown".
        self.assertEqual(items[0]["duration_ms"], 0)

    def test_mobile_projection_reports_unknown_dimensions_as_null(self):
        """Without a value the projection stays null rather than sending a fabricated 0."""
        self.prepare()
        self.assertEqual(self.commit().status_code, 200)
        items = self.client.get("/v1/assets", headers=self.auth).json()["items"]
        self.assertIsNone(items[0]["width"])
        self.assertIsNone(items[0]["height"])
        self.assertIsNone(items[0]["duration_ms"])

    def test_startup_adds_dimension_columns_to_a_predating_populated_database(self):
        """A database created before these columns exist is extended without losing rows.

        The migration is additive, and the pre-existing rows must read as unknown rather
        than as a fabricated zero.
        """
        asset_id = "00000000-0000-4000-8000-0000000000aa"
        with closing(sqlite3.connect(self.database_path)) as db:
            db.execute("DROP TABLE assets")
            # The pre-existing shape: no width/height/duration_ms at all.
            db.execute(
                """CREATE TABLE assets (
                    id TEXT PRIMARY KEY, kind TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE,
                    thumbnail_key TEXT, content_type TEXT, size_bytes INTEGER, sha256 TEXT,
                    collected_at TEXT, source_published_at TEXT, source_url TEXT,
                    creator_name TEXT, creator_handle TEXT, import_source TEXT,
                    committed INTEGER NOT NULL DEFAULT 0 CHECK (committed IN (0, 1)),
                    committed_at TEXT, metadata_revision INTEGER NOT NULL DEFAULT 0,
                    metadata_commit_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                )"""
            )
            db.execute(
                "INSERT INTO assets (id, kind, object_key, content_type, size_bytes,"
                " collected_at, committed, committed_at, metadata_revision, created_at, updated_at)"
                " VALUES (?, 'image', ?, 'image/png', 17, '2026-08-30T00:00:00Z', 1,"
                " '2026-08-30T00:00:00Z', 3, '2026-08-30T00:00:00Z', '2026-08-30T00:00:00Z')",
                (asset_id, f"library/{asset_id}/original"),
            )
            db.commit()

        api_app.startup_replication()

        columns = {row["name"] for row in self.rows("PRAGMA table_info(assets)")}
        for column in ("width", "height", "duration_ms"):
            self.assertIn(column, columns)

        # The pre-existing row survives with NULL dimensions, and its revision is untouched.
        asset = self.rows(
            "SELECT width, height, duration_ms, metadata_revision, committed FROM assets WHERE id = ?",
            (asset_id,),
        )[0]
        self.assertIsNone(asset["width"])
        self.assertIsNone(asset["height"])
        self.assertIsNone(asset["duration_ms"])
        self.assertEqual(asset["metadata_revision"], 3)
        self.assertEqual(asset["committed"], 1)

        # The un-migrated row must project as unknown, not as 0.
        items = self.client.get("/v1/assets", headers=self.auth).json()["items"]
        projected = [item for item in items if item["id"] == asset_id]
        self.assertEqual(len(projected), 1)
        self.assertIsNone(projected[0]["width"])
        self.assertIsNone(projected[0]["height"])
        self.assertIsNone(projected[0]["duration_ms"])

        # Re-running the additive migration must be a no-op.
        before = self.rows("SELECT * FROM assets WHERE id = ?", (asset_id,))[0]
        api_app.startup_replication()
        api_app.startup_replication()
        self.assertEqual(self.rows("SELECT * FROM assets WHERE id = ?", (asset_id,))[0], before)

    def test_commit_rejects_mismatched_variant_keys(self):
        self.prepare()
        response = self.commit(
            original={
                "object_key": "images/some-other-key/original",
                "content_type": "image/png",
                "size_bytes": 17,
            }
        )
        self.assertEqual(response.status_code, 400)

    def test_commit_without_prepare_returns_404(self):
        response = self.commit(asset_id="never-prepared")
        self.assertEqual(response.status_code, 404)

    def test_commit_requires_thumbnail(self):
        self.prepare()
        response = self.commit(
            thumbnail={
                "object_key": "library/00000000-0000-4000-8000-000000000001/thumbnail",
                "content_type": "image/webp",
                "size_bytes": 0,
            }
        )
        self.assertEqual(response.status_code, 400)

    def test_commit_updates_relationships_on_repeat(self):
        self.prepare()
        self.commit()
        changed = self.commit(classification_ids=["class-c"])
        self.assertEqual(changed.status_code, 200)

        relations = self.rows(
            """SELECT classification_id FROM asset_classifications
             WHERE asset_id = ? ORDER BY classification_id""",
            ("00000000-0000-4000-8000-000000000001",),
        )
        self.assertEqual(
            [row["classification_id"] for row in relations],
            ["class-c"],
        )

    # --- video -------------------------------------------------------------

    def test_video_asset_prepare_and_commit(self):
        asset_id = "00000000-0000-4000-8000-000000000002"
        prepared = self.prepare(asset_id=asset_id, kind="video", content_type="video/mp4")
        self.assertEqual(prepared.status_code, 200)
        committed = self.commit(
            asset_id=asset_id,
            kind="video",
            original={
                "object_key": f"library/{asset_id}/original",
                "content_type": "video/mp4",
                "size_bytes": 4096,
                "sha256": "b" * 64,
            },
            thumbnail={
                "object_key": f"library/{asset_id}/thumbnail",
                "content_type": "image/webp",
                "size_bytes": 700,
            },
            content_type="video/mp4",
        )
        self.assertEqual(committed.status_code, 200)
        listing = self.client.get("/v1/assets", headers=self.auth)
        self.assertEqual(listing.json()["items"][0]["kind"], "video")


if __name__ == "__main__":
    unittest.main()
