from __future__ import annotations

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError, URLError

import httpx
from fastapi.testclient import TestClient

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

# r2.py reads R2_* env vars at import time; app.py imports capture_store which
# binds r2._s3 once at import time. test_capture_api.py registers a mutable fake
# r2 before importing, so both modules must share the one canonical stub instead
# of each inventing its own (import order would otherwise break capture tests).
try:  # production: r2 imports fine, this is a no-op there
    import r2  # noqa: F401
except KeyError:
    from tests.test_capture_api_stub import fake_s3  # noqa: F401

import app as api_app  # noqa: E402
import app as api_app  # noqa: E402


AUTH = {"Authorization": "Bearer test-token"}


class CatalogTransportApiTests(unittest.TestCase):
    """Phase 1(CATALOG-001) server endpoint tests.

    Covers: auth, valid requests, invalid ids, k-hentai 404 passthrough,
    transient 5xx retry/backoff, SSRF hardening, and response size caps.
    """

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "lakomics.sqlite3"
        self.original_database_path = api_app.DB_PATH
        self.original_api_token = api_app.API_TOKEN
        api_app.DB_PATH = self.database_path
        api_app.API_TOKEN = "test-token"
        api_app.startup()
        self.client = TestClient(api_app.app)
        api_app._catalog_cache.clear()

    def tearDown(self) -> None:
        self.client.close()
        api_app.DB_PATH = self.original_database_path
        api_app.API_TOKEN = self.original_api_token
        api_app._catalog_cache.clear()
        self.temp_dir.cleanup()

    # -- auth -------------------------------------------------------------

    def test_search_page_requires_bearer_token(self) -> None:
        response = self.client.get("/v1/catalog/search-page")
        self.assertEqual(response.status_code, 401)

        response = self.client.get("/v1/catalog/search-page", headers={"Authorization": "Bearer wrong"})
        self.assertEqual(response.status_code, 401)

    def test_gallery_requires_bearer_token(self) -> None:
        response = self.client.get("/v1/catalog/gallery/42")
        self.assertEqual(response.status_code, 401)

    # -- valid requests ----------------------------------------------------

    def test_search_page_valid_request_without_cursor(self) -> None:
        fetched: list[str] = []

        def fake_fetch_once(url: str) -> tuple[int, bytes]:
            fetched.append(url)
            return 200, b'{"works":[]}'

        with mock.patch.object(api_app, "_catalog_fetch_once", side_effect=fake_fetch_once):
            response = self.client.get("/v1/catalog/search-page", headers=AUTH)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"works": []})
        self.assertEqual(fetched, ["https://k-hentai.org/ajax/search?search=language%3Akorean"])

    def test_search_page_valid_cursor_is_forwarded(self) -> None:
        fetched: list[str] = []

        def fake_fetch_once(url: str) -> tuple[int, bytes]:
            fetched.append(url)
            return 200, b"page"

        with mock.patch.object(api_app, "_catalog_fetch_once", side_effect=fake_fetch_once):
            response = self.client.get(
                "/v1/catalog/search-page", params={"cursor": 4127793}, headers=AUTH
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(fetched, ["https://k-hentai.org/ajax/search?search=language%3Akorean&next-id=4127793"])

    def test_gallery_valid_request_returns_html(self) -> None:
        html = b'<html><script>const gallery = {"files": []};</script></html>'
        fetched: list[str] = []

        def fake_fetch_once(url: str) -> tuple[int, bytes]:
            fetched.append(url)
            return 200, html

        with mock.patch.object(api_app, "_catalog_fetch_once", side_effect=fake_fetch_once):
            response = self.client.get("/v1/catalog/gallery/42", headers=AUTH)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, html)
        self.assertEqual(fetched, ["https://k-hentai.org/r/42"])

    # -- invalid ids -------------------------------------------------------

    def test_search_page_rejects_non_positive_cursor(self) -> None:
        for cursor in ["0", "-1"]:
            response = self.client.get(
                "/v1/catalog/search-page", params={"cursor": cursor}, headers=AUTH
            )
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json()["detail"], "cursor must be a positive id")

    def test_gallery_rejects_non_positive_id(self) -> None:
        response = self.client.get("/v1/catalog/gallery/0", headers=AUTH)
        self.assertEqual(response.status_code, 400)

        response = self.client.get("/v1/catalog/gallery/-3", headers=AUTH)
        self.assertEqual(response.status_code, 400)

    # -- k-hentai 404 passthrough -----------------------------------------

    def test_gallery_404_from_khentai_maps_to_404(self) -> None:
        def fake_fetch_once(url: str) -> tuple[int, bytes]:
            return 404, b""

        with mock.patch.object(api_app, "_catalog_fetch_once", side_effect=fake_fetch_once):
            response = self.client.get("/v1/catalog/gallery/999999999", headers=AUTH)

        self.assertEqual(response.status_code, 404)

    def test_gallery_permanent_400_is_not_retried(self) -> None:
        calls: list[int] = []

        def fake_fetch_once(url: str) -> tuple[int, bytes]:
            calls.append(1)
            return 400, b""

        with mock.patch.object(api_app, "_catalog_fetch_once", side_effect=fake_fetch_once):
            response = self.client.get("/v1/catalog/gallery/42", headers=AUTH)

        self.assertEqual(response.status_code, 502)
        self.assertEqual(len(calls), 1, "4xx must never be retried")

    # -- transient retry ---------------------------------------------------

    def test_search_page_retries_transient_5xx_then_succeeds(self) -> None:
        responses = iter([(502, b""), (503, b""), (200, b"ok")])
        calls: list[str] = []

        def fake_fetch_once(url: str) -> tuple[int, bytes]:
            calls.append(url)
            return next(responses)

        sleeps: list[float] = []
        with (
            mock.patch.object(api_app, "_catalog_fetch_once", side_effect=fake_fetch_once),
            mock.patch.object(api_app.time, "sleep", side_effect=sleeps.append),
        ):
            response = self.client.get("/v1/catalog/search-page", headers=AUTH)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"ok")
        self.assertEqual(len(calls), 3)
        # exponential backoff: 0.75s then 1.5s
        self.assertEqual(sleeps, [0.75, 1.5])

    def test_search_page_gives_up_after_three_transient_failures(self) -> None:
        calls: list[int] = []

        def fake_fetch_once(url: str) -> tuple[int, bytes]:
            calls.append(1)
            return 503, b""

        sleeps: list[float] = []
        with (
            mock.patch.object(api_app, "_catalog_fetch_once", side_effect=fake_fetch_once),
            mock.patch.object(api_app.time, "sleep", side_effect=sleeps.append),
        ):
            response = self.client.get("/v1/catalog/search-page", headers=AUTH)

        self.assertEqual(response.status_code, 502)
        self.assertEqual(len(calls), api_app.CATALOG_ATTEMPTS)
        self.assertEqual(sleeps, [0.75, 1.5])

    # -- SSRF hardening ----------------------------------------------------

    def test_client_cannot_redirect_fetch_to_arbitrary_hosts(self) -> None:
        # The URL is assembled from a fixed origin plus validated numeric ids.
        # A traversal or scheme injection in the id cannot change the host.
        def fake_fetch_once(url: str) -> tuple[int, bytes]:
            self.assertTrue(url.startswith(f"{api_app.KHENTAI_ORIGIN}/r/"))
            self.assertTrue(url[len(f"{api_app.KHENTAI_ORIGIN}/r/"):].isdigit())
            return 200, b"html"

        with mock.patch.object(api_app, "_catalog_fetch_once", side_effect=fake_fetch_once):
            for work_id in ["42", "1", "4158172"]:
                response = self.client.get(f"/v1/catalog/gallery/{work_id}", headers=AUTH)
                self.assertEqual(response.status_code, 200)

    def test_gallery_huge_id_stays_numeric_and_hits_fixed_origin(self) -> None:
        # Python ints are unbounded; the id is forwarded but remains digits in a
        # fixed-origin path, so no SSRF surface is created.
        seen: list[str] = []

        def fake_fetch_once(url: str) -> tuple[int, bytes]:
            seen.append(url)
            return 404, b""

        with mock.patch.object(api_app, "_catalog_fetch_once", side_effect=fake_fetch_once):
            response = self.client.get("/v1/catalog/gallery/99999999999999999999", headers=AUTH)

        self.assertEqual(response.status_code, 404)
        self.assertEqual(
            seen,
            ["https://k-hentai.org/r/99999999999999999999"],
        )

    def test_search_page_rejects_non_numeric_cursor(self) -> None:
        response = self.client.get(
            "/v1/catalog/search-page", params={"cursor": "abc"}, headers=AUTH
        )
        self.assertEqual(response.status_code, 422)

    # -- response size limit ----------------------------------------------

    def test_response_larger_than_limit_is_rejected(self) -> None:
        oversized = b"x" * (api_app.CATALOG_MAX_BODY_BYTES + 1)

        def fake_fetch_once(url: str) -> tuple[int, bytes]:
            return 200, oversized

        with mock.patch.object(api_app, "_catalog_fetch_once", side_effect=fake_fetch_once):
            response = self.client.get("/v1/catalog/gallery/42", headers=AUTH)

        self.assertEqual(response.status_code, 502)
        self.assertEqual(
            response.json()["detail"],
            "k-hentai response too large",
        )

    # -- cache -------------------------------------------------------------

    def test_repeat_requests_serve_from_cache_without_refetch(self) -> None:
        calls: list[str] = []

        def fake_fetch_once(url: str) -> tuple[int, bytes]:
            calls.append(url)
            return 200, b"cached-body"

        with mock.patch.object(api_app, "_catalog_fetch_once", side_effect=fake_fetch_once):
            first = self.client.get("/v1/catalog/gallery/42", headers=AUTH)
            second = self.client.get("/v1/catalog/gallery/42", headers=AUTH)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.content, b"cached-body")
        self.assertEqual(len(calls), 1, "second request must hit the VPS cache")

    def test_cache_is_not_shared_across_different_ids(self) -> None:
        calls: list[str] = []

        def fake_fetch_once(url: str) -> tuple[int, bytes]:
            calls.append(url)
            return 200, f"body-for-{url}".encode()

        with mock.patch.object(api_app, "_catalog_fetch_once", side_effect=fake_fetch_once):
            self.client.get("/v1/catalog/gallery/42", headers=AUTH)
            self.client.get("/v1/catalog/gallery/43", headers=AUTH)

        self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()