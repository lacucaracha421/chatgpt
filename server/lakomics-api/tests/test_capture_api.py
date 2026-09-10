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


# Canonical stub lives in test_capture_api_stub so test modules that import
# app.py (catalog transport tests) share the same mutable fake regardless of
# import order.
from tests.test_capture_api_stub import fake_s3  # noqa: E402

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


    def test_animated_gif_is_preserved_as_gif(self):
        data = b"GIF89a\x01\x00\x01\x00"
        result, _stream = self.fetch(
            FakeResponse([data], content_type="image/gif"),
            "https://pbs.twimg.com/media/ANIMATED.gif",
            "images/inbox/capture-gif/original",
            "animated_gif",
        )
        self.assertEqual(result, ("image/gif", len(data)))
        self.assertEqual(fake_s3.objects["images/inbox/capture-gif/original"]["body"], data)

    def test_generic_web_rejects_private_dns_before_network(self):
        stream = FakeStream(FakeResponse([b"image"], content_type="image/png"))
        with mock.patch.object(capture_store.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 443))]):
            with mock.patch.object(capture_store.httpx, "stream", stream):
                with self.assertRaises(capture_store.CaptureValidationError):
                    capture_store.fetch_media_to_r2(
                        "https://example.test/image.png",
                        "images/inbox/private/original",
                        "image",
                        "web",
                    )
        self.assertEqual(stream.calls, [])

    def test_generic_web_allows_dns_rotation_after_verified_peer(self):
        class NetworkStream:
            def get_extra_info(self, name):
                return ("93.184.216.34", 443) if name == "server_addr" else None

        response = FakeResponse([b"image"], content_type="image/png")
        response.extensions = {"network_stream": NetworkStream()}
        stream = FakeStream(response)
        first_dns = [(2, 1, 6, "", ("93.184.216.34", 443))]
        rotated_dns = [(2, 1, 6, "", ("1.1.1.1", 443))]
        with mock.patch.object(capture_store.socket, "getaddrinfo", side_effect=[first_dns, rotated_dns]) as resolver:
            with mock.patch.object(capture_store.httpx, "stream", stream):
                result = capture_store.fetch_media_to_r2(
                    "https://example.test/image.png",
                    "images/inbox/rotating/original",
                    "image",
                    "web",
                )

        self.assertEqual(result, ("image/png", 5))
        self.assertEqual(resolver.call_count, 1)
        self.assertEqual(fake_s3.objects["images/inbox/rotating/original"]["body"], b"image")

    def test_generic_web_rejects_connection_outside_validated_dns(self):
        class NetworkStream:
            def get_extra_info(self, name):
                return ("1.1.1.1", 443) if name == "server_addr" else None

        response = FakeResponse([b"image"], content_type="image/png")
        response.extensions = {"network_stream": NetworkStream()}
        stream = FakeStream(response)
        public_dns = [(2, 1, 6, "", ("93.184.216.34", 443))]
        with mock.patch.object(capture_store.socket, "getaddrinfo", return_value=public_dns):
            with mock.patch.object(capture_store.httpx, "stream", stream):
                with self.assertRaisesRegex(capture_store.CaptureValidationError, "connection address was not validated"):
                    capture_store.fetch_media_to_r2(
                        "https://example.test/image.png",
                        "images/inbox/unvalidated/original",
                        "image",
                        "web",
                    )
        self.assertNotIn("images/inbox/unvalidated/original", fake_s3.objects)


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
        api_app.startup_classifications()
        api_app.startup_saved_x_media()
        api_app.startup_extension_profile()
        self.media_calls: list[tuple[str, str, str, str]] = []
        self.storage_error: Exception | None = None

        def fake_fetch(media_url: str, object_key: str, media_type: str = "image", source: str = "x"):
            self.media_calls.append((media_url, object_key, media_type, source))
            if self.storage_error is not None:
                raise self.storage_error
            content_type = "video/mp4" if media_type == "video" else "image/gif" if media_type == "animated_gif" else "image/jpeg"
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

    def test_pending_cursor_reaches_tail_without_acknowledging_head(self):
        ids = sorted(self.create_capture(source_url=f"https://x.com/artist/status/{i}/photo/1").json()["capture"]["id"] for i in range(3))
        first = self.client.get("/v1/captures/pending", headers=self.auth, params={"limit": 2}).json()["captures"]
        self.assertEqual([row["id"] for row in first], ids[:2])
        tail = self.client.get("/v1/captures/pending", headers=self.auth, params={"limit": 2, "after_id": ids[1]}).json()["captures"]
        self.assertEqual([row["id"] for row in tail], ids[2:])

    def test_old_image_request_defaults_to_image(self):
        response = self.create_capture()

        self.assertEqual(response.status_code, 200)
        payload = response.json()["capture"]
        self.assertEqual(payload["media_type"], "image")
        self.assertTrue(payload["object_key"].startswith("images/inbox/"))
        self.assertEqual(self.media_calls[0][2], "image")

    def test_animated_gif_capture_keeps_media_identity(self):
        response = self.create_capture(
            media_type="animated_gif",
            media_url="https://pbs.twimg.com/media/ANIMATED.gif",
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()["capture"]
        self.assertEqual(payload["media_type"], "animated_gif")
        self.assertEqual(payload["content_type"], "image/gif")
        self.assertTrue(payload["object_key"].startswith("images/inbox/"))
        self.assertEqual(self.media_calls[0][2:], ("animated_gif", "x"))

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


class ExtensionProfileApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "lakomics.sqlite3"
        self.original_database_path = api_app.DB_PATH
        self.original_api_token = api_app.API_TOKEN
        api_app.DB_PATH = self.database_path
        api_app.API_TOKEN = "test-token"
        api_app.startup()
        api_app.startup_classifications()
        api_app.startup_extension_profile()
        self.client = TestClient(api_app.app)
        self.admin = {"Authorization": "Bearer test-token"}
        published = self.client.put("/v1/classifications", headers=self.admin, json={
            "entries": [
                {"id": "games", "kind": "root", "name": "게임", "parentId": None},
                {"id": "blue", "kind": "work", "name": "블루 아카이브", "parentId": "games"},
            ],
            "published_at": "2026-09-09T00:00:00+00:00",
        })
        self.assertEqual(published.status_code, 200)

    def tearDown(self) -> None:
        self.client.close()
        api_app.DB_PATH = self.original_database_path
        api_app.API_TOKEN = self.original_api_token
        self.temp_dir.cleanup()

    def pair(self):
        created = self.client.post("/v1/extension/pairings", headers=self.admin, json={})
        self.assertEqual(created.status_code, 200)
        pairing_url = created.json()["pairingUrl"]
        secret = pairing_url.split("#", 1)[1]
        exchanged = self.client.post("/v1/extension/pair", json={"secret": secret})
        self.assertEqual(exchanged.status_code, 200)
        token = exchanged.json()["clientToken"]
        return secret, exchanged.json(), {"Authorization": f"Bearer {token}"}

    def test_pairing_is_single_use_and_bootstraps_profile_and_classifications(self):
        secret, exchanged, auth = self.pair()
        self.assertEqual(exchanged["profile"]["revision"], 1)
        self.assertEqual([row["id"] for row in exchanged["classifications"]["entries"]], ["games", "blue"])
        self.assertEqual(self.client.post("/v1/extension/pair", json={"secret": secret}).status_code, 410)
        bootstrap = self.client.get("/v1/extension/bootstrap", headers=auth)
        self.assertEqual(bootstrap.status_code, 200)
        self.assertEqual(bootstrap.json()["profile"]["revision"], 1)

    def test_pairing_uses_configured_public_extension_origin(self):
        public = "https://laku.example.test:8443"
        with mock.patch.dict(api_app.os.environ, {"LAKOMICS_EXTENSION_BASE_URL": public}, clear=False):
            created = self.client.post("/v1/extension/pairings", headers=self.admin, json={})
            self.assertEqual(created.status_code, 200)
            self.assertTrue(created.json()["pairingUrl"].startswith(public + "/extension-pair#"))
            secret = created.json()["pairingUrl"].split("#", 1)[1]
            exchanged = self.client.post("/v1/extension/pair", json={"secret": secret})
            self.assertEqual(exchanged.status_code, 200)
            self.assertEqual(exchanged.json()["serverOrigin"], public)

    def test_profile_patch_is_revision_safe_and_field_scoped(self):
        _secret, _exchanged, auth = self.pair()
        first = self.client.patch("/v1/extension/profile", headers=auth, json={
            "expectedRevision": 1,
            "pinnedClassificationIds": ["blue"],
            "listOrderPatch": {"games": ["blue"]},
        })
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["revision"], 2)
        self.assertEqual(first.json()["pinnedClassificationIds"], ["blue"])
        conflict = self.client.patch("/v1/extension/profile", headers=auth, json={
            "expectedRevision": 1,
            "preferences": {"autoLikeOnSave": False},
        })
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["detail"]["profile"]["revision"], 2)
        second = self.client.patch("/v1/extension/profile", headers=auth, json={
            "expectedRevision": 2,
            "preferences": {"autoLikeOnSave": False},
        })
        self.assertEqual(second.status_code, 200)
        self.assertFalse(second.json()["preferences"]["autoLikeOnSave"])
        self.assertEqual(second.json()["listOrder"]["games"], ["blue"])

    def test_extension_token_can_read_classifications_but_cannot_publish_them(self):
        _secret, _exchanged, auth = self.pair()
        self.assertEqual(self.client.get("/v1/classifications", headers=auth).status_code, 200)
        denied = self.client.put("/v1/classifications", headers=auth, json={
            "entries": [], "published_at": "2026-09-09T01:00:00+00:00"
        })
        self.assertEqual(denied.status_code, 401)


class ExtensionBackupApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "lakomics.sqlite3"
        self.original_database_path = api_app.DB_PATH
        self.original_api_token = api_app.API_TOKEN
        api_app.DB_PATH = self.database_path
        api_app.API_TOKEN = "test-token"
        api_app.startup()
        api_app.startup_extension_backup()
        self.client = TestClient(api_app.app)

    def tearDown(self) -> None:
        self.client.close()
        api_app.DB_PATH = self.original_database_path
        api_app.API_TOKEN = self.original_api_token
        self.temp_dir.cleanup()

    @property
    def auth(self):
        return {"Authorization": "Bearer test-token"}

    @staticmethod
    def envelope(ciphertext: str = "Y2lwaGVydGV4dC1wYXlsb2Fk"):
        return {
            "version": 1,
            "algorithm": "AES-GCM",
            "iv": "MDEyMzQ1Njc4OWFi",
            "ciphertext": ciphertext,
        }

    def test_server_backup_requires_auth_and_round_trips_latest_ciphertext(self):
        body = self.envelope()
        self.assertEqual(self.client.put("/v1/extension-backup", json=body).status_code, 401)
        self.assertEqual(self.client.get("/v1/extension-backup").status_code, 401)
        publish = self.client.put("/v1/extension-backup", headers=self.auth, json=body)
        self.assertEqual(publish.status_code, 200)
        self.assertGreater(publish.json()["byte_size"], 0)
        restored = self.client.get("/v1/extension-backup", headers=self.auth)
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(restored.json()["version"], 1)
        self.assertEqual(restored.json()["algorithm"], "AES-GCM")
        self.assertEqual(restored.json()["iv"], body["iv"])
        self.assertEqual(restored.json()["ciphertext"], body["ciphertext"])
        self.assertIn("published_at", restored.json())

        replacement = self.envelope("bmV3LWNpcGhlcnRleHQtcGF5bG9hZA==")
        self.client.put("/v1/extension-backup", headers=self.auth, json=replacement)
        latest = self.client.get("/v1/extension-backup", headers=self.auth).json()
        self.assertEqual(latest["ciphertext"], replacement["ciphertext"])

    def test_missing_and_oversized_server_backup_are_bounded(self):
        self.assertEqual(self.client.get("/v1/extension-backup", headers=self.auth).status_code, 404)
        oversized = self.envelope("x" * (api_app.MAX_EXTENSION_BACKUP_BYTES * 2 + 1))
        response = self.client.put("/v1/extension-backup", headers=self.auth, json=oversized)
        self.assertEqual(response.status_code, 422)

    def test_plaintext_snapshot_shape_is_rejected(self):
        response = self.client.put(
            "/v1/extension-backup",
            headers=self.auth,
            json={"version": 1, "data": {"connectionToken": "secret"}},
        )
        self.assertEqual(response.status_code, 422)


class MetadataBackupApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_api_token = api_app.API_TOKEN
        api_app.API_TOKEN = "test-token"
        fake_s3.objects.clear()
        self.client = TestClient(api_app.app)

    def tearDown(self) -> None:
        self.client.close()
        api_app.API_TOKEN = self.original_api_token
        fake_s3.objects.clear()

    @property
    def auth(self):
        return {"Authorization": "Bearer test-token"}

    def test_metadata_backup_ticket_requires_auth_and_returns_fixed_r2_object(self):
        self.assertEqual(self.client.get("/v1/library/metadata-backup").status_code, 401)
        self.assertEqual(self.client.get("/v1/library/metadata-backup", headers=self.auth).status_code, 404)
        fake_s3.objects[api_app.METADATA_BACKUP_OBJECT_KEY] = {
            "bucket": "test-bucket",
            "body": b"sqlite-snapshot",
            "content_type": "application/vnd.sqlite3",
        }
        response = self.client.get("/v1/library/metadata-backup", headers=self.auth)
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["size_bytes"], len(b"sqlite-snapshot"))
        self.assertEqual(payload["content_type"], "application/vnd.sqlite3")
        self.assertIn(api_app.METADATA_BACKUP_OBJECT_KEY, payload["download_url"])
        self.assertEqual(payload["required_headers"], {})


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
