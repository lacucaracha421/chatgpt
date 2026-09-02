"""CLOUD-006 배치 2: 전체 라이브러리 복제 계약 테스트.

prepare → 업로드(기존 presign) → commit의 멱등성과, 커밋 전 자산이
모바일 조회(/v1/assets)에 노출되지 않음을 검증한다. Cloud Capture 흐름은
건드리지 않는다.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

import sqlite3

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

# r2 스텁을 app보다 먼저 설치해 R2 env 없이 import 가능하게 한다.
from tests.test_capture_api_stub import fake_s3  # noqa: E402

import app as api_app  # noqa: E402
from fastapi.testclient import TestClient


class ReplicationStartupTests(unittest.TestCase):
    def test_registered_startup_handlers_initialize_a_fresh_database(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            original_database_path = api_app.DB_PATH
            api_app.DB_PATH = Path(temp_dir) / "lakomics.sqlite3"
            try:
                for handler in api_app.app.router.on_startup:
                    handler()
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
