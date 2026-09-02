"""CLOUD-006 Batch 4 mobile replicated-library read contract."""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from tests.test_capture_api_stub import fake_s3  # noqa: E402

import app as api_app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


CLASSIFICATION_ID = "10000000-0000-4000-8000-000000000001"
OTHER_CLASSIFICATION_ID = "10000000-0000-4000-8000-000000000002"


class MobileLibraryApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "lakomics.sqlite3"
        self.original_database_path = api_app.DB_PATH
        self.original_api_token = api_app.API_TOKEN
        api_app.DB_PATH = self.database_path
        api_app.API_TOKEN = "test-token"
        api_app.startup()
        api_app.startup_replication()
        api_app.startup_captures()
        api_app.startup_classifications()
        fake_s3.objects.clear()
        self.client = TestClient(api_app.app)
        self.publish_classifications()

    def tearDown(self) -> None:
        self.client.close()
        fake_s3.objects.clear()
        api_app.DB_PATH = self.original_database_path
        api_app.API_TOKEN = self.original_api_token
        self.temp_dir.cleanup()

    @property
    def auth(self):
        return {"Authorization": "Bearer test-token"}

    def publish_classifications(self) -> None:
        response = self.client.put(
            "/v1/classifications",
            headers=self.auth,
            json={
                "entries": [
                    {
                        "id": CLASSIFICATION_ID,
                        "kind": "root",
                        "name": "게임",
                        "parentId": None,
                        "iconKey": "gamepad",
                        "colorKey": "blue",
                        "assetCount": 99,
                    },
                    {
                        "id": OTHER_CLASSIFICATION_ID,
                        "kind": "tag",
                        "name": "명조",
                        "parentId": CLASSIFICATION_ID,
                        "iconKey": None,
                        "colorKey": None,
                        "assetCount": 88,
                    },
                    {
                        "id": "10000000-0000-4000-8000-000000000003",
                        "kind": "tag",
                        "name": "빈 분류",
                        "parentId": CLASSIFICATION_ID,
                        "iconKey": None,
                        "colorKey": None,
                        "assetCount": 0,
                    },
                ],
                "published_at": "2026-09-02T00:00:00+00:00",
            },
        )
        self.assertEqual(response.status_code, 200)

    def prepare_asset(
        self,
        asset_id: str,
        *,
        kind: str = "image",
        collected_at: str = "2026-09-02T00:00:00.000Z",
    ):
        return self.client.post(
            "/v1/replication/prepare",
            headers=self.auth,
            json={
                "asset_id": asset_id,
                "kind": kind,
                "content_type": "video/mp4" if kind == "video" else "image/png",
                "size_bytes": 17,
                "sha256": "a" * 64,
                "collected_at": collected_at,
            },
        )

    def commit_asset(
        self,
        asset_id: str,
        *,
        kind: str = "image",
        classification_ids: list[str] | None = None,
        collected_at: str = "2026-09-02T00:00:00.000Z",
        thumbnail: bool = True,
    ) -> None:
        self.assertEqual(
            self.prepare_asset(asset_id, kind=kind, collected_at=collected_at).status_code,
            200,
        )
        content_type = "video/mp4" if kind == "video" else "image/png"
        response = self.client.post(
            "/v1/replication/commit",
            headers=self.auth,
            json={
                "asset_id": asset_id,
                "kind": kind,
                "original": {
                    "object_key": f"library/{asset_id}/original",
                    "content_type": content_type,
                    "size_bytes": 17,
                    "sha256": "a" * 64,
                },
                "thumbnail": {
                    "object_key": f"library/{asset_id}/thumbnail",
                    "content_type": "image/webp",
                    "size_bytes": 5,
                },
                "content_type": content_type,
                "collected_at": collected_at,
                "source_published_at": "2026-09-01T00:00:00.000Z",
                "source_url": f"https://fixture.invalid/{asset_id}",
                "creator_name": "Fixture Creator",
                "creator_handle": "fixture",
                "import_source": "Direct",
                "classification_ids": classification_ids or [CLASSIFICATION_ID],
            },
        )
        self.assertEqual(response.status_code, 200)
        fake_s3.objects[f"library/{asset_id}/original"] = {
            "body": b"original-payload!",
            "content_type": content_type,
        }
        if thumbnail:
            fake_s3.objects[f"library/{asset_id}/thumbnail"] = {
                "body": b"thumb",
                "content_type": "image/webp",
            }
        else:
            with closing(sqlite3.connect(self.database_path)) as db:
                db.execute("UPDATE assets SET thumbnail_key = NULL WHERE id = ?", (asset_id,))
                db.commit()

    def rows(self, query: str, params: tuple = ()):
        with closing(sqlite3.connect(self.database_path)) as db:
            db.row_factory = sqlite3.Row
            return [dict(row) for row in db.execute(query, params).fetchall()]

    def test_classification_tree_preserves_hierarchy_order_and_stable_ids(self):
        self.commit_asset("20000000-0000-4000-8000-000000000001")

        response = self.client.get("/v1/library/classifications", headers=self.auth)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["published_at"], "2026-09-02T00:00:00+00:00")
        self.assertEqual(
            response.json()["items"],
            [
                {
                    "id": CLASSIFICATION_ID,
                    "kind": "root",
                    "name": "게임",
                    "parent_id": None,
                    "icon_key": "gamepad",
                    "color_key": "blue",
                    "sort_index": 0,
                    "asset_count": 1,
                },
                {
                    "id": OTHER_CLASSIFICATION_ID,
                    "kind": "tag",
                    "name": "명조",
                    "parent_id": CLASSIFICATION_ID,
                    "icon_key": None,
                    "color_key": None,
                    "sort_index": 1,
                    "asset_count": 0,
                },
                {
                    "id": "10000000-0000-4000-8000-000000000003",
                    "kind": "tag",
                    "name": "빈 분류",
                    "parent_id": CLASSIFICATION_ID,
                    "icon_key": None,
                    "color_key": None,
                    "sort_index": 2,
                    "asset_count": 0,
                },
            ],
        )

    def test_classification_tree_does_not_invent_entries_from_capture_transport(self):
        with closing(sqlite3.connect(self.database_path)) as db:
            db.execute(
                """INSERT INTO captures (
                    id, source_url, media_url, classification_id, object_key,
                    content_type, size_bytes, status, created_at, media_type
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    "capture-1",
                    "https://x.com/example/status/1",
                    "https://pbs.twimg.com/media/1.jpg",
                    "capture-only",
                    "captures/capture-1/original",
                    "image/jpeg",
                    10,
                    "pending",
                    "2026-09-02T00:00:00Z",
                    "image",
                ),
            )
            db.commit()

        response = self.client.get("/v1/library/classifications", headers=self.auth)

        self.assertNotIn("capture-only", [item["id"] for item in response.json()["items"]])

    def seed_pagination_assets(self) -> list[str]:
        ids = [f"30000000-0000-4000-8000-{number:012d}" for number in range(1, 6)]
        for asset_id in ids:
            self.commit_asset(asset_id, collected_at="2026-09-02T12:00:00.000Z")
        self.commit_asset(
            "30000000-0000-4000-8000-000000000099",
            classification_ids=[OTHER_CLASSIFICATION_ID],
            collected_at="2026-09-03T12:00:00.000Z",
        )
        incomplete_id = "30000000-0000-4000-8000-000000000098"
        self.prepare_asset(incomplete_id, collected_at="2026-09-04T12:00:00.000Z")
        with closing(sqlite3.connect(self.database_path)) as db:
            db.execute(
                "INSERT INTO asset_classifications (asset_id, classification_id, added_at) VALUES (?, ?, ?)",
                (incomplete_id, CLASSIFICATION_ID, "2026-09-04T12:00:00Z"),
            )
            db.commit()
        return ids

    def test_cursor_pagination_has_no_duplicates_or_timestamp_tie_gaps(self):
        expected = list(reversed(self.seed_pagination_assets()))
        seen: list[str] = []
        cursor = None
        while True:
            params = {"classification_id": CLASSIFICATION_ID, "limit": 2}
            if cursor:
                params["cursor"] = cursor
            response = self.client.get("/v1/library/assets", headers=self.auth, params=params)
            self.assertEqual(response.status_code, 200)
            page = response.json()
            seen.extend(item["id"] for item in page["items"])
            if not page["has_more"]:
                self.assertIsNone(page["next_cursor"])
                break
            self.assertIsNotNone(page["next_cursor"])
            cursor = page["next_cursor"]

        self.assertEqual(seen, expected)
        self.assertEqual(len(seen), len(set(seen)))

    def test_asset_page_excludes_other_classification_and_incomplete_assets(self):
        expected = set(self.seed_pagination_assets())

        response = self.client.get(
            "/v1/library/assets",
            headers=self.auth,
            params={"classification_id": CLASSIFICATION_ID, "limit": 100},
        )

        self.assertEqual({item["id"] for item in response.json()["items"]}, expected)
        self.assertTrue(all(item["committed"] for item in response.json()["items"]))
        self.assertTrue(all(item["classification_ids"] == [CLASSIFICATION_ID] for item in response.json()["items"]))

    def test_asset_summary_contains_mobile_metadata_without_media_urls(self):
        asset_id = "40000000-0000-4000-8000-000000000001"
        self.commit_asset(asset_id)

        item = self.client.get(
            "/v1/library/assets",
            headers=self.auth,
            params={"classification_id": CLASSIFICATION_ID},
        ).json()["items"][0]

        self.assertEqual(item["id"], asset_id)
        self.assertEqual(item["kind"], "image")
        self.assertEqual(item["content_type"], "image/png")
        self.assertEqual(item["size_bytes"], 17)
        self.assertEqual(item["creator_handle"], "fixture")
        self.assertTrue(item["original_available"])
        self.assertTrue(item["thumbnail_available"])
        self.assertIsNone(item["width"])
        self.assertIsNone(item["height"])
        self.assertIsNone(item["duration_ms"])
        self.assertNotIn("url", item)
        self.assertNotIn("object_key", item)

    def test_asset_page_enforces_maximum_limit_and_rejects_invalid_cursor(self):
        too_large = self.client.get(
            "/v1/library/assets",
            headers=self.auth,
            params={"classification_id": CLASSIFICATION_ID, "limit": 101},
        )
        invalid_cursor = self.client.get(
            "/v1/library/assets",
            headers=self.auth,
            params={"classification_id": CLASSIFICATION_ID, "cursor": "not-a-cursor"},
        )
        self.assertEqual(too_large.status_code, 422)
        self.assertEqual(invalid_cursor.status_code, 400)

    def test_read_routes_require_authentication(self):
        self.assertEqual(self.client.get("/v1/library/classifications").status_code, 401)
        self.assertEqual(
            self.client.get(
                "/v1/library/assets", params={"classification_id": CLASSIFICATION_ID}
            ).status_code,
            401,
        )

    def ticket(self, asset_id: str, variant: str, **extra):
        return self.client.post(
            f"/v1/library/assets/{asset_id}/media-ticket",
            headers=self.auth,
            json={"variant": variant, **extra},
        )

    def test_thumbnail_ticket_uses_canonical_variant_and_short_expiry(self):
        asset_id = "50000000-0000-4000-8000-000000000001"
        self.commit_asset(asset_id)
        before = datetime.now(timezone.utc)

        response = self.ticket(asset_id, "thumbnail")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["variant"], "thumbnail")
        self.assertEqual(body["content_type"], "image/webp")
        self.assertEqual(body["size_bytes"], 5)
        expires_at = datetime.fromisoformat(body["expires_at"])
        self.assertGreater(expires_at, before)
        self.assertLessEqual((expires_at - before).total_seconds(), 305)
        self.assertTrue(body["url"].startswith("https://r2.example.test/"))

    def test_original_tickets_preserve_image_and_video_metadata(self):
        image_id = "50000000-0000-4000-8000-000000000002"
        video_id = "50000000-0000-4000-8000-000000000003"
        self.commit_asset(image_id)
        self.commit_asset(video_id, kind="video")

        image = self.ticket(image_id, "original")
        video = self.ticket(video_id, "original")

        self.assertEqual(image.status_code, 200)
        self.assertEqual(image.json()["content_type"], "image/png")
        self.assertEqual(image.json()["size_bytes"], 17)
        self.assertEqual(video.status_code, 200)
        self.assertEqual(video.json()["content_type"], "video/mp4")
        self.assertEqual(video.json()["size_bytes"], 17)

    def test_ticket_rejects_unknown_incomplete_and_unavailable_assets(self):
        incomplete_id = "50000000-0000-4000-8000-000000000004"
        no_thumbnail_id = "50000000-0000-4000-8000-000000000005"
        self.prepare_asset(incomplete_id)
        self.commit_asset(no_thumbnail_id, thumbnail=False)

        self.assertEqual(self.ticket("missing-asset", "original").status_code, 404)
        self.assertEqual(self.ticket(incomplete_id, "original").status_code, 404)
        self.assertEqual(self.ticket(no_thumbnail_id, "thumbnail").status_code, 409)

    def test_ticket_rejects_unknown_variant_and_object_key_injection(self):
        asset_id = "50000000-0000-4000-8000-000000000006"
        self.commit_asset(asset_id)

        self.assertEqual(self.ticket(asset_id, "preview").status_code, 422)
        self.assertEqual(
            self.ticket(asset_id, "original", object_key="captures/other/original").status_code,
            422,
        )


if __name__ == "__main__":
    unittest.main()
