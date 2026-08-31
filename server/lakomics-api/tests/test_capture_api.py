from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import types
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

import httpx
from fastapi.testclient import TestClient


SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[str, dict[str, object]] = {}
        self.deleted: list[str] = []
        self.fail_put = False

    def put_object(self, *, Bucket, Key, Body, ContentType):
        if self.fail_put:
            raise RuntimeError("R2 unavailable")
        self.objects[Key] = {
            "bucket": Bucket,
            "body": Body.read(),
            "content_type": ContentType,
        }

    def delete_object(self, *, Bucket, Key):
        self.deleted.append(Key)
        self.objects.pop(Key, None)


fake_s3 = FakeS3()
fake_r2 = types.ModuleType("r2")
fake_r2._s3 = fake_s3
fake_r2.R2_BUCKET = "test-bucket"
fake_r2.presign_get = lambda object_key, expires_in=600: (
    f"https://r2.example.test/{object_key}?expires={expires_in}"
)
sys.modules["r2"] = fake_r2

import capture_store  # noqa: E402
import app as api_app  # noqa: E402


class FakeResponse:
    def __init__(
        self,
        chunks: list[bytes] | None = None,
        *,
        status_code: int = 200,
        content_type: str = "application/octet-stream",
        content_length: int | None = None,
        iteration_error: Exception | None = None,
    ) -> None:
        self.status_code = status_code
        self.headers = {"content-type": content_type}
        if content_length is not None:
            self.headers["content-length"] = str(content_length)
        self._chunks = chunks or []
        self._iteration_error = iteration_error

    def iter_bytes(self, _chunk_size):
        yield from self._chunks
        if self._iteration_error is not None:
            raise self._iteration_error


class FakeStream:
    def __init__(self, response: FakeResponse) -> None:
        self.response = response
        self.calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def __call__(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return self

    def __enter__(self):
        return self.response

    def __exit__(self, _type, _value, _traceback):
        return False


class CaptureStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        fake_s3.objects.clear()
        fake_s3.deleted.clear()
        fake_s3.fail_put = False

    def fetch(self, response: FakeResponse, url: str, key: str, media_type: str):
        stream = FakeStream(response)
        with mock.patch.object(capture_store.httpx, "stream", stream):
            result = capture_store.fetch_media_to_r2(url, key, media_type)
        return result, stream

    def test_legacy_image_download_still_streams_to_r2(self):
        image = b"png-image"
        stream = FakeStream(FakeResponse([image], content_type="image/png"))
        with mock.patch.object(capture_store.httpx, "stream", stream):
            result = capture_store.fetch_image_to_r2(
                "https://pbs.twimg.com/media/IMAGE?format=png&name=orig",
                "images/inbox/capture-1/original",
            )

        self.assertEqual(result, ("image/png", len(image)))
        self.assertEqual(
            fake_s3.objects["images/inbox/capture-1/original"]["body"],
            image,
        )

    def test_video_mp4_streams_to_video_object_key(self):
        video = b"mp4-video"
        result, stream = self.fetch(
            FakeResponse([video], content_type="video/mp4; charset=binary"),
            "https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/VIDEO.mp4",
            "videos/inbox/capture-2/original",
            "video",
        )

        self.assertEqual(result, ("video/mp4", len(video)))
        stored = fake_s3.objects["videos/inbox/capture-2/original"]
        self.assertEqual(stored["body"], video)
        self.assertEqual(stored["content_type"], "video/mp4")
        self.assertEqual(stream.calls[0][1]["headers"]["Accept"], "video/mp4")
        self.assertFalse(stream.calls[0][1]["follow_redirects"])

    def test_zero_byte_video_is_rejected_before_r2_upload(self):
        with self.assertRaises(capture_store.CaptureValidationError):
            self.fetch(
                FakeResponse([], content_type="video/mp4", content_length=0),
                "https://video.twimg.com/empty.mp4",
                "videos/inbox/capture-empty/original",
                "video",
            )
        self.assertEqual(fake_s3.objects, {})

    def test_arbitrary_host_is_rejected_before_network_access(self):
        stream = FakeStream(FakeResponse([b"bad"], content_type="video/mp4"))
        with mock.patch.object(capture_store.httpx, "stream", stream):
            with self.assertRaises(capture_store.CaptureValidationError):
                capture_store.fetch_media_to_r2(
                    "https://example.com/private.mp4",
                    "videos/inbox/capture-3/original",
                    "video",
                )

        self.assertEqual(stream.calls, [])
        self.assertEqual(fake_s3.objects, {})

    def test_redirect_is_rejected_without_contacting_destination(self):
        response = FakeResponse(status_code=302, content_type="text/html")
        stream = FakeStream(response)
        with mock.patch.object(capture_store.httpx, "stream", stream):
            with self.assertRaises(capture_store.CaptureDownloadError):
                capture_store.fetch_media_to_r2(
                    "https://video.twimg.com/redirect.mp4",
                    "videos/inbox/capture-4/original",
                    "video",
                )

        self.assertFalse(stream.calls[0][1]["follow_redirects"])
        self.assertEqual(fake_s3.objects, {})

    def test_video_rejects_non_mp4_content_type(self):
        with self.assertRaises(capture_store.CaptureValidationError):
            self.fetch(
                FakeResponse([b"error page"], content_type="text/html"),
                "https://video.twimg.com/error.mp4",
                "videos/inbox/capture-5/original",
                "video",
            )
        self.assertEqual(fake_s3.objects, {})

    def test_declared_oversized_video_is_rejected_before_staging(self):
        with mock.patch.object(capture_store, "MAX_CAPTURE_VIDEO_BYTES", 4):
            with self.assertRaises(capture_store.CaptureValidationError):
                self.fetch(
                    FakeResponse(
                        [b"12345"],
                        content_type="video/mp4",
                        content_length=5,
                    ),
                    "https://video.twimg.com/large.mp4",
                    "videos/inbox/capture-6/original",
                    "video",
                )
        self.assertEqual(fake_s3.objects, {})

    def test_streamed_oversized_video_is_rejected(self):
        with mock.patch.object(capture_store, "MAX_CAPTURE_VIDEO_BYTES", 4):
            with self.assertRaises(capture_store.CaptureValidationError):
                self.fetch(
                    FakeResponse([b"123", b"45"], content_type="video/mp4"),
                    "https://video.twimg.com/large.mp4",
                    "videos/inbox/capture-7/original",
                    "video",
                )
        self.assertEqual(fake_s3.objects, {})

    def test_interrupted_download_leaves_no_r2_object(self):
        error = httpx.ReadError(
            "connection reset",
            request=httpx.Request("GET", "https://video.twimg.com/video.mp4"),
        )
        with self.assertRaises(capture_store.CaptureDownloadError):
            self.fetch(
                FakeResponse(
                    [b"partial"],
                    content_type="video/mp4",
                    iteration_error=error,
                ),
                "https://video.twimg.com/video.mp4",
                "videos/inbox/capture-8/original",
                "video",
            )
        self.assertEqual(fake_s3.objects, {})

    def test_failed_r2_upload_is_reported_and_cleaned_up(self):
        fake_s3.fail_put = True
        with self.assertRaises(capture_store.CaptureDownloadError):
            self.fetch(
                FakeResponse([b"video"], content_type="video/mp4"),
                "https://video.twimg.com/video.mp4",
                "videos/inbox/capture-9/original",
                "video",
            )

        self.assertEqual(fake_s3.objects, {})
        self.assertEqual(fake_s3.deleted, ["videos/inbox/capture-9/original"])

    def test_temporary_file_is_removed_after_success_and_failure(self):
        created_paths: list[Path] = []
        real_mkstemp = tempfile.mkstemp

        def recording_mkstemp(*args, **kwargs):
            fd, raw_path = real_mkstemp(*args, **kwargs)
            created_paths.append(Path(raw_path))
            return fd, raw_path

        with mock.patch.object(capture_store.tempfile, "mkstemp", recording_mkstemp):
            self.fetch(
                FakeResponse([b"video"], content_type="video/mp4"),
                "https://video.twimg.com/video.mp4",
                "videos/inbox/capture-10/original",
                "video",
            )
            with self.assertRaises(capture_store.CaptureValidationError):
                self.fetch(
                    FakeResponse([b"html"], content_type="text/html"),
                    "https://video.twimg.com/not-video.mp4",
                    "videos/inbox/capture-11/original",
                    "video",
                )

        self.assertTrue(created_paths)
        self.assertTrue(all(not path.exists() for path in created_paths))


class CaptureApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "lakomics.sqlite3"
        self.original_database_path = api_app.DB_PATH
        self.original_api_token = api_app.API_TOKEN
        api_app.DB_PATH = self.database_path
        api_app.API_TOKEN = "test-token"
        api_app.startup()
        api_app.startup_captures()
        self.media_calls: list[tuple[str, str, str]] = []
        self.storage_error: Exception | None = None

        def fake_fetch(media_url: str, object_key: str, media_type: str = "image"):
            self.media_calls.append((media_url, object_key, media_type))
            if self.storage_error is not None:
                raise self.storage_error
            content_type = "video/mp4" if media_type == "video" else "image/jpeg"
            return content_type, 123

        self.fetch_patch = mock.patch.object(
            api_app,
            "fetch_media_to_r2",
            side_effect=fake_fetch,
            create=True,
        )
        self.presign_patch = mock.patch.object(
            api_app,
            "presign_get",
            side_effect=lambda object_key, expires_in=600: (
                f"https://r2.example.test/{object_key}?expires={expires_in}"
            ),
            create=True,
        )
        self.fetch_patch.start()
        self.presign_patch.start()
        self.client = TestClient(api_app.app)

    def tearDown(self) -> None:
        self.client.close()
        self.presign_patch.stop()
        self.fetch_patch.stop()
        api_app.DB_PATH = self.original_database_path
        api_app.API_TOKEN = self.original_api_token
        self.temp_dir.cleanup()

    @property
    def auth(self):
        return {"Authorization": "Bearer test-token"}

    def capture_body(self, **overrides):
        body = {
            "source_url": "https://x.com/artist/status/123/photo/1",
            "media_url": "https://pbs.twimg.com/media/IMAGE?format=jpg&name=orig",
            "classification_id": "game",
            "published_at": "2026-08-01T10:20:30Z",
        }
        body.update(overrides)
        return body

    def create_capture(self, **overrides):
        return self.client.post(
            "/v1/captures",
            headers=self.auth,
            json=self.capture_body(**overrides),
        )

    def test_old_image_request_defaults_to_image(self):
        response = self.create_capture()

        self.assertEqual(response.status_code, 200)
        payload = response.json()["capture"]
        self.assertEqual(payload["media_type"], "image")
        self.assertTrue(payload["object_key"].startswith("images/inbox/"))
        self.assertEqual(self.media_calls[0][2], "image")

    def test_explicit_image_request_remains_supported(self):
        response = self.create_capture(media_type="image")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["capture"]["media_type"], "image")

    def test_video_capture_is_pending_and_listed_for_pc_consumer(self):
        response = self.create_capture(
            media_type="video",
            source_url="https://x.com/artist/status/456/video/1",
            media_url="https://video.twimg.com/ext_tw_video/1/VIDEO.mp4",
        )

        self.assertEqual(response.status_code, 200)
        created = response.json()["capture"]
        self.assertEqual(created["media_type"], "video")
        self.assertEqual(created["status"], "pending")
        self.assertTrue(created["object_key"].startswith("videos/inbox/"))

        pending_response = self.client.get(
            "/v1/captures/pending", headers=self.auth
        )
        self.assertEqual(pending_response.status_code, 200)
        pending = pending_response.json()["captures"]
        self.assertEqual(len(pending), 1)
        self.assertEqual(
            pending[0],
            {
                "id": created["id"],
                "kind": "video",
                "object_key": created["object_key"],
                "content_type": "video/mp4",
                "size_bytes": 123,
                "source_url": "https://x.com/artist/status/456/video/1",
                "classification_id": "game",
                "creator_handle": "artist",
                "source_published_at": "2026-08-01T10:20:30Z",
                "created_at": created["created_at"],
            },
        )

    def test_download_route_returns_presigned_get_ticket(self):
        capture = self.create_capture().json()["capture"]

        response = self.client.get(
            f"/v1/captures/{capture['id']}/download", headers=self.auth
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "method": "GET",
                "download_url": (
                    f"https://r2.example.test/{capture['object_key']}?expires=600"
                ),
                "required_headers": {},
            },
        )

    def test_unknown_capture_has_no_download_ticket(self):
        response = self.client.get(
            "/v1/captures/missing/download", headers=self.auth
        )
        self.assertEqual(response.status_code, 404)

    def test_acknowledge_is_idempotent_and_preserves_first_imported_at(self):
        capture = self.create_capture().json()["capture"]
        first_timestamp = "2026-08-31T01:02:03Z"
        second_timestamp = "2026-08-31T04:05:06Z"

        first = self.client.post(
            f"/v1/captures/{capture['id']}/acknowledge",
            headers=self.auth,
            json={"imported_at": first_timestamp},
        )
        retry = self.client.post(
            f"/v1/captures/{capture['id']}/acknowledge",
            headers=self.auth,
            json={"imported_at": second_timestamp},
        )

        self.assertEqual(first.status_code, 200)
        self.assertEqual(retry.status_code, 200)
        normalized_first = "2026-08-31T01:02:03+00:00"
        self.assertEqual(first.json()["imported_at"], normalized_first)
        self.assertEqual(retry.json()["imported_at"], normalized_first)
        pending = self.client.get(
            "/v1/captures/pending", headers=self.auth
        ).json()["captures"]
        self.assertEqual(pending, [])

    def test_acknowledge_rejects_non_rfc3339_datetime(self):
        capture = self.create_capture().json()["capture"]

        response = self.client.post(
            f"/v1/captures/{capture['id']}/acknowledge",
            headers=self.auth,
            json={"imported_at": "2026-W36-1T01:02:03Z"},
        )

        self.assertEqual(response.status_code, 422)

    def test_openapi_marks_acknowledge_timestamp_as_date_time(self):
        schema = self.client.get("/openapi.json").json()
        acknowledgement = schema["components"]["schemas"]["CaptureAcknowledge"]
        self.assertEqual(
            acknowledgement["properties"]["imported_at"]["format"],
            "date-time",
        )

    def test_legacy_imported_route_uses_same_stable_transition(self):
        capture = self.create_capture().json()["capture"]
        acknowledged = self.client.post(
            f"/v1/captures/{capture['id']}/acknowledge",
            headers=self.auth,
            json={"imported_at": "2026-08-31T01:02:03Z"},
        )
        legacy = self.client.post(
            f"/v1/captures/{capture['id']}/imported", headers=self.auth
        )

        self.assertEqual(legacy.status_code, 200)
        self.assertEqual(
            legacy.json()["imported_at"], acknowledged.json()["imported_at"]
        )

    def test_duplicate_video_does_not_upload_or_insert_twice(self):
        request = {
            "media_type": "video",
            "source_url": "https://x.com/artist/status/789/video/1",
            "media_url": "https://video.twimg.com/ext_tw_video/1/VIDEO.mp4",
        }
        first = self.create_capture(**request)
        second = self.create_capture(**request)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertTrue(first.json()["created"])
        self.assertFalse(second.json()["created"])
        self.assertEqual(
            first.json()["capture"]["id"], second.json()["capture"]["id"]
        )
        self.assertEqual(len(self.media_calls), 1)

    def test_failed_storage_does_not_create_pending_capture(self):
        self.storage_error = capture_store.CaptureDownloadError("R2 unavailable")

        response = self.create_capture(
            media_type="video",
            source_url="https://x.com/artist/status/999/video/1",
            media_url="https://video.twimg.com/ext_tw_video/1/FAILED.mp4",
        )

        self.assertEqual(response.status_code, 502)
        self.assertEqual(
            self.client.get(
                "/v1/captures/pending", headers=self.auth
            ).json()["captures"],
            [],
        )

    def test_capture_list_exact_filter_finds_item_beyond_first_500(self):
        target = self.create_capture(
            media_type="video",
            source_url="https://x.com/artist/status/777/video/1",
            media_url="https://video.twimg.com/ext_tw_video/1/TARGET.mp4",
        ).json()["capture"]
        with api_app.get_db() as db:
            db.executemany(
                """
                INSERT INTO captures (
                    id, source_url, media_url, classification_id, object_key,
                    content_type, size_bytes, published_at, status, created_at,
                    imported_at, media_type
                ) VALUES (?, ?, ?, 'game', ?, 'image/jpeg', 1, NULL,
                          'pending', '2000-01-01T00:00:00Z', NULL, 'image')
                """,
                [
                    (
                        f"old-{index}",
                        f"https://x.com/old/status/{index}/photo/1",
                        f"https://pbs.twimg.com/media/OLD{index}",
                        f"images/inbox/old-{index}/original",
                    )
                    for index in range(500)
                ],
            )
            db.commit()

        response = self.client.get(
            "/v1/captures",
            headers=self.auth,
            params={
                "source_url": "https://x.com/artist/status/777/video/1",
                "media_url": "https://video.twimg.com/ext_tw_video/1/TARGET.mp4",
                "classification_id": "game",
                "limit": 1,
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["id"] for item in response.json()["items"]], [target["id"]])

    def test_startup_migrates_existing_capture_rows_to_image(self):
        legacy_path = Path(self.temp_dir.name) / "legacy.sqlite3"
        with closing(sqlite3.connect(legacy_path)) as db:
            with db:
                db.execute(
                """
                CREATE TABLE captures (
                    id TEXT PRIMARY KEY,
                    source_url TEXT NOT NULL,
                    media_url TEXT NOT NULL,
                    classification_id TEXT NOT NULL,
                    object_key TEXT NOT NULL UNIQUE,
                    content_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL,
                    published_at TEXT,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    imported_at TEXT,
                    UNIQUE(source_url, media_url, classification_id)
                )
                """
                )
                db.execute(
                """
                INSERT INTO captures VALUES (
                    'legacy-1', 'https://x.com/a/status/1/photo/1',
                    'https://pbs.twimg.com/media/LEGACY', 'game',
                    'images/inbox/legacy-1/original', 'image/jpeg', 12,
                    NULL, 'pending', '2026-08-01T00:00:00Z', NULL
                )
                """
                )

        api_app.DB_PATH = legacy_path
        api_app.startup_captures()

        with closing(sqlite3.connect(legacy_path)) as db:
            columns = {
                row[1] for row in db.execute("PRAGMA table_info(captures)")
            }
            media_type = db.execute(
                "SELECT media_type FROM captures WHERE id = 'legacy-1'"
            ).fetchone()[0]
        self.assertIn("media_type", columns)
        self.assertEqual(media_type, "image")


if __name__ == "__main__":
    unittest.main()


class ClassificationSnapshotApiTests(unittest.TestCase):
    """PC publishes a snapshot; mobile extension reads it. PC는 원본이고 VPS는 저장소."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "lakomics.sqlite3"
        self.original_database_path = api_app.DB_PATH
        self.original_api_token = api_app.API_TOKEN
        api_app.DB_PATH = self.database_path
        api_app.API_TOKEN = "test-token"
        api_app.startup()
        api_app.startup_classifications()
        self.client = TestClient(api_app.app)

    def tearDown(self) -> None:
        self.client.close()
        api_app.DB_PATH = self.original_database_path
        api_app.API_TOKEN = self.original_api_token
        self.temp_dir.cleanup()

    @property
    def auth(self):
        return {"Authorization": "Bearer test-token"}

    def publish_body(self, **overrides):
        body = {
            "entries": [
                {"id": "game", "kind": "root", "name": "게임", "parentId": None},
                {"id": "rpg", "kind": "tag", "name": "RPG", "parentId": "game"},
            ],
            "published_at": "2026-08-31T00:00:00+00:00",
        }
        body.update(overrides)
        return body

    def test_publish_then_retrieve_round_trips_entries_unmodified(self):
        publish = self.client.put(
            "/v1/classifications", headers=self.auth, json=self.publish_body()
        )
        self.assertEqual(publish.status_code, 200)
        self.assertTrue(publish.json()["ok"])

        retrievals = self.client.get("/v1/classifications", headers=self.auth)
        self.assertEqual(retrievals.status_code, 200)
        self.assertEqual(retrievals.json()["entries"], self.publish_body()["entries"])
        self.assertEqual(retrievals.json()["published_at"], "2026-08-31T00:00:00+00:00")

    def test_rejects_unauthenticated_reads_and_writes(self):
        self.assertEqual(
            self.client.put("/v1/classifications", json=self.publish_body()).status_code,
            401,
        )
        self.assertEqual(
            self.client.get("/v1/classifications").status_code, 401
        )

    def test_overwrite_replaces_the_whole_snapshot(self):
        self.client.put("/v1/classifications", headers=self.auth, json=self.publish_body())
        replacement = self.publish_body(
            entries=[{"id": "movie", "kind": "root", "name": "영화", "parentId": None}],
            published_at="2026-09-01T00:00:00+00:00",
        )
        self.client.put("/v1/classifications", headers=self.auth, json=replacement)

        response = self.client.get("/v1/classifications", headers=self.auth)
        self.assertEqual(response.json()["entries"], replacement["entries"])
        self.assertEqual(response.json()["published_at"], "2026-09-01T00:00:00+00:00")

    def test_read_before_any_publish_returns_404(self):
        self.assertEqual(
            self.client.get("/v1/classifications", headers=self.auth).status_code, 404
        )
        self.assertEqual(
            self.client.get("/v1/classifications/meta", headers=self.auth).status_code,
            404,
        )

    def test_oversized_snapshot_is_rejected(self):
        entries = [
            {"id": f"id-{n}", "kind": "tag", "name": "이름" * 40, "parentId": None}
            for n in range(10_000)
        ]
        response = self.client.put(
            "/v1/classifications",
            headers=self.auth,
            json=self.publish_body(entries=entries),
        )
        self.assertEqual(response.status_code, 413)


class SavedXMediaSnapshotApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "lakomics.sqlite3"
        self.original_database_path = api_app.DB_PATH
        self.original_api_token = api_app.API_TOKEN
        api_app.DB_PATH = self.database_path
        api_app.API_TOKEN = "test-token"
        api_app.startup()
        api_app.startup_captures()
        api_app.startup_classifications()
        api_app.startup_saved_x_media()
        self.client = TestClient(api_app.app)

    def tearDown(self) -> None:
        self.client.close()
        api_app.DB_PATH = self.original_database_path
        api_app.API_TOKEN = self.original_api_token
        self.temp_dir.cleanup()

    @property
    def auth(self):
        return {"Authorization": "Bearer test-token"}

    def test_rejects_unauthenticated_reads_and_writes(self):
        self.assertEqual(self.client.get("/v1/saved-x-media").status_code, 401)
        self.assertEqual(
            self.client.put("/v1/saved-x-media", json={"keys": []}).status_code,
            401,
        )

    def test_empty_snapshot_round_trips(self):
        publish = self.client.put(
            "/v1/saved-x-media", headers=self.auth, json={"keys": []}
        )
        self.assertEqual(publish.status_code, 200)
        response = self.client.get("/v1/saved-x-media", headers=self.auth)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["keys"], [])
        self.assertIn("published_at", response.json())

    def test_normal_snapshot_deduplicates_and_round_trips(self):
        publish = self.client.put(
            "/v1/saved-x-media",
            headers=self.auth,
            json={"keys": ["1234567890123456789:1", "123:2", "123:2"]},
        )
        self.assertEqual(publish.status_code, 200)
        self.assertEqual(publish.json()["count"], 2)
        response = self.client.get("/v1/saved-x-media", headers=self.auth)
        self.assertEqual(
            response.json()["keys"], ["1234567890123456789:1", "123:2"]
        )

    def test_latest_snapshot_replaces_previous_snapshot(self):
        self.client.put(
            "/v1/saved-x-media", headers=self.auth, json={"keys": ["1:1", "2:2"]}
        )
        self.client.put(
            "/v1/saved-x-media", headers=self.auth, json={"keys": ["3:1"]}
        )
        response = self.client.get("/v1/saved-x-media", headers=self.auth)
        self.assertEqual(response.json()["keys"], ["3:1"])

    def test_malformed_and_overlong_keys_are_rejected(self):
        for key in ["bad", "123:0", "123:-1", "123:01", f"{'1' * 64}:1"]:
            with self.subTest(key=key):
                response = self.client.put(
                    "/v1/saved-x-media", headers=self.auth, json={"keys": [key]}
                )
                self.assertEqual(response.status_code, 422)

    def test_excessive_key_count_is_rejected(self):
        response = self.client.put(
            "/v1/saved-x-media",
            headers=self.auth,
            json={
                "keys": [
                    f"{index + 1}:1"
                    for index in range(api_app.MAX_SAVED_X_MEDIA_KEYS + 1)
                ]
            },
        )
        self.assertEqual(response.status_code, 422)

    def test_excessive_request_body_is_rejected(self):
        response = self.client.put(
            "/v1/saved-x-media",
            headers={**self.auth, "Content-Type": "application/json"},
            content=b" " * (api_app.MAX_SAVED_X_MEDIA_SNAPSHOT_BYTES + 1),
        )
        self.assertEqual(response.status_code, 413)

    def test_capture_and_classification_endpoints_remain_available(self):
        classification = self.client.put(
            "/v1/classifications",
            headers=self.auth,
            json={"entries": [], "published_at": "2026-08-31T00:00:00+00:00"},
        )
        capture = self.client.get("/v1/captures?limit=1", headers=self.auth)
        self.assertEqual(classification.status_code, 200)
        self.assertEqual(capture.status_code, 200)
