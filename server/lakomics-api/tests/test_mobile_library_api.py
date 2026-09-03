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
        creator: str | None = None,
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
        creator: str | None = None,
    ) -> None:
        self.assertEqual(
            self.prepare_asset(
                asset_id,
                kind=kind,
                collected_at=collected_at,
                creator=creator,
            ).status_code,
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
                "creator_name": creator or "Fixture Creator",
                "creator_handle": creator or "fixture",
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

    def test_oldest_sort_matches_pc_collected_order_across_cursor_pages(self):
        expected = self.seed_pagination_assets()
        seen: list[str] = []
        cursor = None
        while True:
            params = {
                "classification_id": CLASSIFICATION_ID,
                "limit": 2,
                "sort": "oldest",
            }
            if cursor:
                params["cursor"] = cursor
            response = self.client.get("/v1/library/assets", headers=self.auth, params=params)
            self.assertEqual(response.status_code, 200)
            page = response.json()
            seen.extend(item["id"] for item in page["items"])
            if not page["has_more"]:
                break
            cursor = page["next_cursor"]

        self.assertEqual(seen, expected)
        self.assertEqual(len(seen), len(set(seen)))

    def test_cursor_cannot_be_reused_with_another_sort(self):
        self.seed_pagination_assets()
        first = self.client.get(
            "/v1/library/assets",
            headers=self.auth,
            params={"classification_id": CLASSIFICATION_ID, "limit": 2, "sort": "newest"},
        ).json()

        response = self.client.get(
            "/v1/library/assets",
            headers=self.auth,
            params={
                "classification_id": CLASSIFICATION_ID,
                "limit": 2,
                "sort": "oldest",
                "cursor": first["next_cursor"],
            },
        )

        self.assertEqual(response.status_code, 400)

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

    def test_recent_assets_without_classification_are_global_newest_and_unique(self):
        older = "31000000-0000-4000-8000-000000000001"
        newer = "31000000-0000-4000-8000-000000000002"
        incomplete = "31000000-0000-4000-8000-000000000003"
        self.commit_asset(
            older,
            classification_ids=[CLASSIFICATION_ID, OTHER_CLASSIFICATION_ID],
            collected_at="2026-09-01T00:00:00.000Z",
        )
        self.commit_asset(
            newer,
            classification_ids=[OTHER_CLASSIFICATION_ID],
            collected_at="2026-09-02T00:00:00.000Z",
        )
        self.prepare_asset(incomplete, collected_at="2026-09-03T00:00:00.000Z")

        response = self.client.get(
            "/v1/library/assets",
            headers=self.auth,
            params={"sort": "newest", "limit": 100},
        )

        self.assertEqual(response.status_code, 200)
        items = response.json()["items"]
        self.assertEqual([item["id"] for item in items], [newer, older])
        self.assertEqual(len({item["id"] for item in items}), len(items))
        self.assertEqual(items[1]["classification_ids"], [CLASSIFICATION_ID, OTHER_CLASSIFICATION_ID])

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
        invalid_sort = self.client.get(
            "/v1/library/assets",
            headers=self.auth,
            params={"classification_id": CLASSIFICATION_ID, "sort": "creator"},
        )
        self.assertEqual(too_large.status_code, 422)
        self.assertEqual(invalid_cursor.status_code, 400)
        self.assertEqual(invalid_sort.status_code, 422)

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


class MobileRevisitTests(MobileLibraryApiTests):
    def test_revisit_date_excludes_recent_and_prefers_calendar_near_dates(self):
        # 30일 이내 자산은 date bundle에서 제외된다(최근 추가와 중복 방지).
        # 오래된 ±7일 캘린더 근처/같은 달/결정론적 오래된 자산만 후보다.
        recent = "41000000-0000-4000-8000-000000000001"
        old_near = "41000000-0000-4000-8000-000000000002"
        self.commit_asset(recent, collected_at="2026-09-10T00:00:00.000Z")
        self.commit_asset(old_near, collected_at="2025-09-12T00:00:00.000Z")

        response = self.client.get(
            "/v1/library/revisit", headers=self.auth, params={"limit": 12}
        )

        self.assertEqual(response.status_code, 200)
        bundles = {bundle["kind"]: bundle for bundle in response.json()["bundles"]}
        date_ids = {item["id"] for item in bundles["date"]["items"]}
        self.assertNotIn(recent, date_ids)
        self.assertIn(old_near, date_ids)

    def test_revisit_calendar_distance_wraps_year_boundary(self):
        expression = api_app._revisit_calendar_distance_sql(
            "'2024-12-31T00:00:00Z'",
            "'2025-01-01T00:00:00Z'",
        )
        with closing(sqlite3.connect(":memory:")) as db:
            distance = db.execute(f"SELECT {expression}").fetchone()[0]
        self.assertEqual(distance, 1)

    def test_revisit_creator_bundle_is_grouped_and_requires_three_or_more(self):
        solo = "42000000-0000-4000-8000-000000000001"
        trio = ["42000000-0000-4000-8000-000000000002",
                "42000000-0000-4000-8000-000000000003",
                "42000000-0000-4000-8000-000000000004",
                "42000000-0000-4000-8000-000000000005",
                "42000000-0000-4000-8000-000000000006"]
        self.commit_asset(solo, creator="solo-creator",
                          collected_at="2025-08-10T00:00:00.000Z")
        for index, asset_id in enumerate(trio):
            self.commit_asset(
                asset_id,
                collected_at=f"2025-08-{10 + index:02d}T00:00:00.000Z",
                creator="team",
            )

        response = self.client.get(
            "/v1/library/revisit", headers=self.auth, params={"limit": 12}
        )

        self.assertEqual(response.status_code, 200)
        bundles = {bundle["kind"]: bundle for bundle in response.json()["bundles"]}
        groups = bundles["creator"]["groups"]
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["creator_key"], "team")
        self.assertEqual(groups[0]["creator_key"], "team")
        self.assertEqual(groups[0]["asset_count"], len(trio))
        # preview items는 홈 미리보기 cap(최대 4~6)을 따른다 — 전체는
        # creator detail('모두 보기')에서 제공된다.
        preview_ids = {item["id"] for item in groups[0]["items"]}
        self.assertTrue(preview_ids.issubset(set(trio)))
        self.assertGreaterEqual(len(preview_ids), 4)
        # solo 작가(1개)는 그룹에서 제외된다.
        self.assertTrue(all(group["creator_key"] != "solo-creator" for group in groups))

    def test_revisit_deduplicates_assets_across_bundles_and_orders_deterministically(self):
        first = "43000000-0000-4000-8000-000000000001"
        second = "43000000-0000-4000-8000-000000000002"
        for asset_id, day in ((first, 20), (second, 10)):
            self.commit_asset(
                asset_id,
                collected_at=f"2026-09-{day:02d}T00:00:00.000Z",
                creator="team",
            )
        # 오래된 자산도 추가해 date bundle이 30일 제외 규칙을 따르는지 확인
        old_asset = "43000000-0000-4000-8000-000000000003"
        self.commit_asset(old_asset, collected_at="2024-09-11T00:00:00.000Z")

        response = self.client.get(
            "/v1/library/revisit", headers=self.auth, params={"limit": 12}
        )

        by_kind = {bundle["kind"]: bundle for bundle in response.json()["bundles"]}
        date_ids = [item["id"] for item in by_kind["date"]["items"]]
        # 최근 30일 자산은 date에서 배제되고 오래된 자산이 채택된다.
        self.assertNotIn(first, date_ids)
        self.assertNotIn(second, date_ids)
        self.assertIn(old_asset, date_ids)
        # 교차 묶음 중복 없음
        all_ids = [item["id"] for bundle in response.json()["bundles"]
                   for item in bundle.get("items", [])]
        for group in by_kind["creator"].get("groups", []):
            all_ids.extend(item["id"] for item in group["items"])
        self.assertEqual(len(all_ids), len(set(all_ids)))

    def test_revisit_creator_selection_alternates_count_and_oldest_history(self):
        specs = [
            ("count-top", 6, "2025-05"),
            ("count-second", 5, "2025-04"),
            ("oldest-history", 3, "2023-01"),
            ("count-third", 4, "2025-03"),
        ]
        serial = 1
        for creator, count, month in specs:
            for index in range(count):
                asset_id = f"44000000-0000-4000-8000-{serial:012d}"
                serial += 1
                self.commit_asset(
                    asset_id,
                    creator=creator,
                    collected_at=f"{month}-{10 + index:02d}T00:00:00.000Z",
                )

        response = self.client.get("/v1/library/revisit", headers=self.auth, params={"limit": 12})
        self.assertEqual(response.status_code, 200)
        creator_bundle = next(bundle for bundle in response.json()["bundles"] if bundle["kind"] == "creator")
        keys = [group["creator_key"] for group in creator_bundle["groups"]]
        self.assertEqual(keys, ["count-top", "oldest-history", "count-second"])

    def test_revisit_rejects_oversized_limit_and_requires_authentication(self):
        self.assertEqual(
            self.client.get("/v1/library/revisit").status_code, 401
        )
        self.assertEqual(
            self.client.get(
                "/v1/library/revisit",
                headers=self.auth,
                params={"limit": 51},
            ).status_code,
            422,
        )


class MobileBatchMediaTicketTests(MobileLibraryApiTests):
    def test_batch_tickets_require_auth_and_enforce_bounds(self):
        asset_id = "51000000-0000-4000-8000-000000000001"
        self.commit_asset(asset_id)

        self.assertEqual(
            self.client.post(
                "/v1/library/media-tickets",
                json={"items": [{"asset_id": asset_id, "variant": "thumbnail"}]},
            ).status_code,
            401,
        )
        oversized = [{"asset_id": asset_id, "variant": "thumbnail"} for _ in range(51)]
        self.assertEqual(
            self.client.post(
                "/v1/library/media-tickets",
                headers=self.auth,
                json={"items": oversized},
            ).status_code,
            422,
        )

    def test_batch_tickets_return_signed_items_and_isolate_failures(self):
        good = "52000000-0000-4000-8000-000000000001"
        unknown = "52000000-0000-4000-8000-000000000002"
        self.commit_asset(good)

        response = self.client.post(
            "/v1/library/media-tickets",
            headers=self.auth,
            json={"items": [
                {"asset_id": good, "variant": "thumbnail"},
                {"asset_id": unknown, "variant": "thumbnail"},
                {"asset_id": good, "variant": "original"},
                {"asset_id": good, "variant": "original"},  # 중복: 한 번만 서명
            ]},
        )

        self.assertEqual(response.status_code, 200)
        items = response.json()["items"]
        ok_items = {(entry["asset_id"], entry["variant"]): entry for entry in items if entry["ok"]}
        self.assertIn((good, "thumbnail"), ok_items)
        self.assertIn((good, "original"), ok_items)
        self.assertTrue(ok_items[(good, "thumbnail")]["url"].startswith("https://"))
        self.assertEqual(
            [entry for entry in items if not entry["ok"]],
            [{"asset_id": unknown, "variant": "thumbnail", "ok": False, "error": "not_found"}],
        )
        # 중복은 단일 항목으로 병합된다.
        self.assertEqual(len([entry for entry in items if entry["asset_id"] == good]), 2)

    def test_batch_rejects_invalid_variant_and_extra_fields(self):
        good = "53000000-0000-4000-8000-000000000001"
        self.commit_asset(good)
        response = self.client.post(
            "/v1/library/media-tickets",
            headers=self.auth,
            json={"items": [{"asset_id": good, "variant": "originals/evil"}]},
        )
        self.assertEqual(response.status_code, 422)

        injection = self.client.post(
            "/v1/library/media-tickets",
            headers=self.auth,
            json={"items": [{"asset_id": good, "variant": "thumbnail", "object_key": "library/other/original"}]},
        )
        self.assertEqual(injection.status_code, 422)


class MobileRevisitDetailTests(MobileLibraryApiTests):
    def _seed_team(self):
        ids = ["61000000-0000-4000-8000-000000000001",
               "61000000-0000-4000-8000-000000000002",
               "61000000-0000-4000-8000-000000000003",
               "61000000-0000-4000-8000-000000000004",
               "61000000-0000-4000-8000-000000000005",
               "61000000-0000-4000-8000-000000000006"]
        for index, asset_id in enumerate(ids):
            self.commit_asset(
                asset_id,
                collected_at=f"2025-0{1 + (index % 3)}-{10 + index:02d}T00:00:00.000Z",
                creator="detail-team",
            )
        return ids

    def test_creator_detail_returns_only_requested_creator_with_pagination(self):
        ids = self._seed_team()
        other = "61000000-0000-4000-8000-000000000099"
        self.commit_asset(other, creator="other-team", collected_at="2024-01-01T00:00:00.000Z")

        first = self.client.get(
            "/v1/library/revisit/creator/detail-team/assets",
            headers=self.auth, params={"limit": 2, "sort": "newest"},
        )
        self.assertEqual(first.status_code, 200)
        body = first.json()
        self.assertTrue(all(item["creator_handle"] == "detail-team" for item in body["items"]))
        self.assertEqual(body["items"][0]["classification_ids"], [CLASSIFICATION_ID])
        self.assertTrue(body["items"][0]["original_available"])
        self.assertTrue(body["items"][0]["thumbnail_available"])
        self.assertNotIn(other, [item["id"] for item in body["items"]])
        self.assertTrue(body["has_more"])

        second = self.client.get(
            "/v1/library/revisit/creator/detail-team/assets",
            headers=self.auth,
            params={"limit": 2, "sort": "newest", "cursor": body["next_cursor"]},
        )
        self.assertEqual(second.status_code, 200)
        second_ids = [item["id"] for item in second.json()["items"]]
        self.assertFalse(set(second_ids) & {item["id"] for item in body["items"]})

    def test_creator_detail_rejects_cross_sort_cursor(self):
        self._seed_team()
        page = self.client.get(
            "/v1/library/revisit/creator/detail-team/assets",
            headers=self.auth, params={"limit": 2, "sort": "newest"},
        ).json()
        swapped = self.client.get(
            "/v1/library/revisit/creator/detail-team/assets",
            headers=self.auth, params={"limit": 2, "sort": "oldest", "cursor": page["next_cursor"]},
        )
        self.assertEqual(swapped.status_code, 400)

    def test_date_detail_excludes_recent_and_paginates(self):
        recent = "62000000-0000-4000-8000-000000000001"
        self.commit_asset(recent, collected_at="2026-09-02T00:00:00.000Z", creator="recent-only")
        old_ids = []
        for index in range(5):
            asset_id = f"62000000-0000-4000-8000-{index + 2:012d}"
            old_ids.append(asset_id)
            self.commit_asset(
                asset_id,
                collected_at=f"2024-01-{index + 1:02d}T00:00:00.000Z",
                creator=f"old-creator-{index}",
            )

        seen = []
        cursor = None
        for _ in range(3):
            params = {"limit": 2}
            if cursor:
                params["cursor"] = cursor
            page = self.client.get("/v1/library/revisit/date", headers=self.auth, params=params)
            self.assertEqual(page.status_code, 200)
            body = page.json()
            page_ids = [item["id"] for item in body["items"]]
            self.assertFalse(set(page_ids) & set(seen), "date detail pages must not overlap")
            seen.extend(page_ids)
            cursor = body["next_cursor"]
            if not body["has_more"]:
                break

        self.assertNotIn(recent, seen)
        self.assertEqual(set(seen), set(old_ids))
        self.assertEqual(len(seen), len(set(seen)))

    def test_revisit_detail_routes_require_authentication(self):
        self.assertEqual(
            self.client.get("/v1/library/revisit/date").status_code, 401
        )
        self.assertEqual(
            self.client.get(
                "/v1/library/revisit/creator/some-team/assets"
            ).status_code,
            401,
        )
