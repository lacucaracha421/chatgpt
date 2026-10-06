"""Mocked provider HTTP, disposable authority DB, fake R2; no credentials/network."""
import io
import json
import os
import unittest
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from unittest import mock

from tests import test_collection_authority as fixtures
from tests.test_capture_api_stub import fake_s3
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

import work_providers as wp


class Response(io.BytesIO):
    def __init__(self, value, mime="application/json", status=200, headers=None):
        data = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
        super().__init__(data)
        self.status = status
        self.headers = {"Content-Type": mime, **(headers or {})}


def movie():
    return {"id": 42, "title": "영화", "original_title": "Original", "overview": "줄거리",
            "release_date": "2024-02-01", "runtime": 123, "vote_average": 8.25, "vote_count": 10,
            "genres": [{"name": "Drama"}, {"name": "Drama"}],
            "production_companies": [{"name": "Studio"}, {"name": "Other"}, {"name": "Third"}],
            "credits": {"crew": [{"job": "Director", "name": "Director"},
                                  {"job": "Director", "name": "Director"}],
                        "cast": [{"name": "Later", "character": "B", "order": 2},
                                 {"name": "First", "character": "A", "order": 0}]},
            "release_dates": {"results": [{"iso_3166_1": "KR", "release_dates": [
                {"release_date": "2024-01-02T00:00:00Z", "type": 3, "certification": "12"}]}]},
            "poster_path": "/poster.jpg", "backdrop_path": "/backdrop.jpg",
            "images": {"posters": [{"file_path": "/poster.jpg", "width": 500, "height": 750}],
                       "backdrops": [{"file_path": "/backdrop.jpg", "width": 1920, "height": 1080}]}}


def game():
    return {"id": 99, "name": "Game", "summary": " A game. ", "first_release_date": 1704067200,
            "genres": [{"name": "RPG"}], "platforms": [{"name": "Windows"}],
            "release_dates": [{"date": 1672531200, "platform": {"name": "Dreamcast"}},
                              {"date": 1704067200, "platform": {"name": "Windows"}}],
            "involved_companies": [{"developer": True, "company": {"name": "Dev"}},
                                  {"publisher": True, "company": {"name": "Pub"}}],
            "cover": {"image_id": "co_99", "width": 264, "height": 374},
            "artworks": [{"image_id": "art99", "width": 1920, "height": 1080}],
            "screenshots": [{"image_id": "shot99", "width": 1280, "height": 720}]}


def png():
    output = io.BytesIO()
    Image.new("RGB", (2, 3), "red").save(output, format="PNG")
    return output.getvalue()


class WorkProviderTests(unittest.TestCase):
    def setUp(self):
        # Reuse existing authority activation/DB/R2 fixtures, without inheriting their tests.
        self.fixture = fixtures.CollectionAuthorityTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.addCleanup(self.fixture.tearDown)
        self.fixture.ready()
        self.env = mock.patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.http = mock.patch.object(wp._opener, "open")
        self.open = self.http.start()
        self.open.side_effect = AssertionError("Unmocked HTTP request")
        self.addCleanup(self.http.stop)
        sleep = mock.patch.object(wp.time, "sleep")
        sleep.start()
        self.addCleanup(sleep.stop)
        app = FastAPI()
        self.relay = wp.register(app, fixtures.api_app.get_db, fixtures.api_app._home_client,
                                 lambda: fake_s3, lambda: "test-bucket")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.auth = self.fixture.auth

    def keys(self):
        os.environ.update({wp.TMDB_KEY_ENV: "tmdb-fixture", wp.IGDB_ID_ENV: "client-fixture",
                           wp.IGDB_SECRET_ENV: "secret-fixture"})

    def apply_body(self, operation="create", provider="tmdb", work_id=None, **changes):
        body = {"commandId": str(uuid.uuid4()), "libraryId": fixtures.LIBRARY, "epoch": 1,
                "operation": operation, "provider": provider,
                "externalId": "42" if provider == "tmdb" else "99",
                "workId": work_id or str(uuid.uuid4())}
        if operation == "create":
            body["type"] = "movie" if provider == "tmdb" else "game"
        return {**body, **changes}

    def apply(self, body, headers=None):
        return self.client.post("/v1/providers/apply", headers=self.auth if headers is None else headers, json=body)

    def feed(self):
        return self.fixture.ok(self.fixture.client.get(fixtures.PREFIX + "/changes", headers=self.auth,
            params={"libraryId": fixtures.LIBRARY, "epoch": 1, "after": 0}))

    def test_image_proxy_allowed_sizes_fixed_hosts_cache_and_bytes(self):
        for provider, path, sizes, origin in (
            ("tmdb", "/poster.jpg", ("w185", "w342", "w780"), "https://image.tmdb.org/t/p/"),
            ("igdb", "co_99", ("t_cover_big", "t_screenshot_med", "t_720p"),
             "https://images.igdb.com/igdb/image/upload/")):
            for size in sizes:
                with self.subTest(provider=provider, size=size):
                    data = png()
                    self.responses(Response(data, "image/png"))
                    reply = self.get("image", provider=provider, path=path, size=size)
                    self.assertEqual(reply.status_code, 200, reply.text)
                    self.assertEqual(reply.content, data)
                    self.assertEqual(reply.headers["Content-Type"], "image/png")
                    self.assertEqual(reply.headers["Cache-Control"], "private, max-age=86400")
                    suffix = size + path if provider == "tmdb" else size + "/" + path + ".jpg"
                    self.assertEqual(self.open.call_args.args[0].full_url, origin + suffix)

    def test_image_proxy_refuses_sizes_urls_traversal_and_bad_queries(self):
        for provider, path, size in (
            ("tmdb", "/poster.jpg", "original"), ("tmdb", "/poster.jpg", "w500"),
            ("igdb", "co_99", "cover_big"), ("igdb", "co_99", "t_thumb"),
            ("tmdb", "https://evil.test/x.jpg", "w185"), ("tmdb", "//evil.test/x.jpg", "w185"),
            ("tmdb", "/../x.jpg", "w185"), ("igdb", "https://evil.test/x", "t_720p"),
            ("igdb", "../x", "t_720p")):
            self.code(self.get("image", provider=provider, path=path, size=size), 422, "providerImagePathInvalid")
        self.code(self.get("image", provider="evil", path="x", size="w185"), 422, "providerInvalid")
        self.code(self.get("image", provider="tmdb", path="/x.jpg"), 422, "providerImagePathInvalid")
        self.code(self.get("image", provider="tmdb", path="/x.jpg", size="w185", url="evil"),
                  422, "providerImagePathInvalid")
        self.open.assert_not_called()

    def test_image_proxy_redirect_mime_and_size_refused(self):
        params = {"provider": "tmdb", "path": "/poster.jpg", "size": "w185"}
        for response, status, code in (
            (HTTPError("https://ignored", 302, "redirect", {"Location": "https://evil.test"}, None),
             502, "providerRedirectRefused"),
            (Response(b"html", "text/html"), 422, "providerImageInvalid"),
            (Response(b"x", "image/png", headers={"Content-Length": str(wp.MAX_ARTWORK_BYTES + 1)}),
             413, "providerResponseTooLarge"),
            (Response(b"x" * (wp.MAX_ARTWORK_BYTES + 1), "image/png"), 413, "providerResponseTooLarge")):
            self.responses(response)
            self.code(self.get("image", **params), status, code)
        self.assertIsNone(wp.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.test"))

    def test_detail_and_search_previews_are_relative_api_paths(self):
        self.keys()
        self.responses(movie(), {"results": [movie()]}, {"access_token": "token", "expires_in": 3600},
                       [game()], [game()])
        film = self.ok(self.get("tmdb/movie/42"))
        search = self.ok(self.get("tmdb/search", query="film", kind="movie"))
        game_detail = self.ok(self.get("igdb/99"))
        games = self.ok(self.get("igdb/search", query="game"))
        previews = [a["previewUrl"] for d in (film, game_detail) for a in d["artwork"]]
        previews += [search["items"][0]["previewUrl"], games["items"][0]["previewUrl"]]
        for preview in previews:
            self.assertEqual(urlsplit(preview).path, "/v1/providers/image")
            self.assertEqual(urlsplit(preview).netloc, "")
            query = {key: value[0] for key, value in parse_qs(urlsplit(preview).query).items()}
            self.assertIn(query["size"], wp.PREVIEW_SIZES[query["provider"]])

    def test_apply_create_client_receipt_shape_feed_and_retry_without_lookup(self):
        self.keys()
        body = self.apply_body()
        self.responses(movie())
        result = self.ok(self.apply(body))
        self.assertEqual(len(result["receipts"]), 1)
        receipt = result["receipts"][0]
        self.assertEqual(set(receipt), {"libraryId", "epoch", "contractVersion", "commandType",
            "operationId", "changed", "changeSequence", "authorityCursor", "entities", "updatedAt"})
        self.assertEqual(receipt["commandType"], "createWork")
        self.assertEqual(receipt["operationId"], str(uuid.uuid5(uuid.UUID(body["commandId"]), "createWork")))
        state = self.fixture.work(body["workId"])
        self.assertEqual(state["name"], "영화")
        self.assertEqual(state["fields"]["runtimeMinutes"], 123)
        self.assertEqual(receipt["entities"]["bindings"][0]["snapshot"]["id"], 42)
        before = self.feed()
        self.open.reset_mock(side_effect=True)
        self.open.side_effect = AssertionError("A retry must not fetch provider data")
        os.environ.pop(wp.TMDB_KEY_ENV)
        self.assertEqual(self.ok(self.apply(body)), result)
        self.assertEqual(self.feed(), before)
        self.open.assert_not_called()
        self.code(self.apply({**body, "externalId": "43"}), 409, "operationConflict")

    def test_apply_igdb_create_and_refresh(self):
        self.keys()
        body = self.apply_body(provider="igdb")
        self.responses({"access_token": "token", "expires_in": 3600}, [game()])
        self.ok(self.apply(body))
        state = self.fixture.work(body["workId"])
        self.assertEqual(state["name"], "Game")
        self.assertEqual(state["fields"]["developer"], "Dev")
        self.fixture.ok(self.fixture.update(body["workId"], {"description": "My memo", "myScore": 4.5},
                                            revision=state["entityRevision"]))
        fresh = game()
        fresh["summary"] = "Fresh game"
        self.responses([fresh])
        refresh = self.apply_body("refresh", provider="igdb", work_id=body["workId"])
        result = self.ok(self.apply(refresh))
        self.assertEqual(result["receipts"][0]["commandType"], "applyProviderSnapshot")
        state = self.fixture.work(body["workId"])
        # Preserve the existing IGDB fill-only merge rule while refreshing its snapshot.
        self.assertEqual(state["fields"]["overview"], "A game.")
        self.assertEqual(result["receipts"][0]["entities"]["bindings"][0]["snapshot"]["summary"], "Fresh game")
        self.assertEqual(state["fields"]["description"], "My memo")
        self.assertEqual(state["fields"]["myScore"], 4.5)
        self.assertEqual(self.ok(self.apply(refresh)), result)

    def test_apply_tmdb_tv_identity_uses_tv_lookup_and_movie_type(self):
        self.keys()
        raw = self.tv()
        raw.update(overview="Series", seasons=[])
        self.responses(raw)
        body = self.apply_body(externalId="tv:42")
        receipt = self.ok(self.apply(body))["receipts"][0]
        self.assertIn("/tv/42?", self.open.call_args.args[0].full_url)
        self.assertEqual(receipt["entities"]["works"][0]["type"], "movie")
        self.assertEqual(receipt["entities"]["bindings"][0]["externalId"], "tv:42")

    def test_apply_identity_taken_returns_command_rejection(self):
        self.keys()
        holder = self.apply_body()
        self.responses(movie())
        self.ok(self.apply(holder))
        target = str(uuid.uuid4())
        self.fixture.ok(self.fixture.create(target, "Target"))
        args = dict(workId=target, provider="tmdb", externalId="42", config=None, expectedRevision=0)
        rejection = self.fixture.command("bindProvider", headers=self.fixture.publisher, **args)
        self.responses(movie())
        reply = self.apply(self.apply_body("connect", work_id=target))
        self.assertEqual(reply.status_code, rejection.status_code)
        self.assertEqual(reply.json(), rejection.json())

    def test_apply_refresh_cas_rejects_binding_changed_during_lookup(self):
        self.keys()
        body = self.apply_body()
        self.responses(movie())
        created = self.ok(self.apply(body))["receipts"][0]
        existing = created["entities"]["bindings"][0]
        args = {"workId": body["workId"], "provider": "tmdb", "externalId": "42",
                "snapshot": existing["snapshot"], "values": existing["values"],
                "details": wp.tmdb_normalize(movie(), "movie")["binding"]["details"],
                "baseSnapshotDigest": existing["snapshotDigest"]}
        def concurrent_refresh(request, **kwargs):
            self.fixture.ok(self.fixture.command("applyProviderSnapshot", headers=self.fixture.publisher, **args))
            return Response(movie())
        before = self.feed()["cursor"]
        self.open.side_effect = concurrent_refresh
        self.code(self.apply(self.apply_body("refresh", work_id=body["workId"])), 409, "providerSnapshotStale")
        self.assertEqual(self.feed()["cursor"], before + 1)

    def test_apply_connect_refresh_preserve_user_fields_and_two_receipts(self):
        self.keys()
        work_id = str(uuid.uuid4())
        self.fixture.ok(self.fixture.create(work_id, "My title", overview="My overview",
                                            description="My memo", myScore=4.5, director="My director"))
        connect = self.apply_body("connect", work_id=work_id)
        self.responses(movie())
        result = self.ok(self.apply(connect))
        self.assertEqual([r["commandType"] for r in result["receipts"]],
                         ["bindProvider", "applyProviderSnapshot"])
        self.assertEqual(self.ok(self.apply(connect)), result)
        state = self.fixture.work(work_id)
        self.assertEqual(state["name"], "My title")
        for field, value in (("description", "My memo"), ("myScore", 4.5),
                             ("overview", "My overview"), ("director", "My director")):
            self.assertEqual(state["fields"][field], value)
        self.assertEqual(state["fields"]["runtimeMinutes"], 123)
        fresh = movie()
        fresh.update(runtime=150, overview="Fresh overview")
        self.responses(fresh)
        refresh = self.apply_body("refresh", work_id=work_id)
        result = self.ok(self.apply(refresh))
        state = self.fixture.work(work_id)
        self.assertEqual(state["fields"]["runtimeMinutes"], 150)
        self.assertEqual(state["fields"]["overview"], "My overview")
        self.assertEqual(state["fields"]["description"], "My memo")
        self.assertEqual(state["fields"]["myScore"], 4.5)
        self.assertEqual(self.ok(self.apply(refresh)), result)

    def test_apply_stale_epoch_library_missing_binding_and_identity(self):
        for change in ({"epoch": 2}, {"libraryId": "f" * 32}):
            self.code(self.apply(self.apply_body(**change)), 409, "authorityLibraryMismatch")
        work_id = str(uuid.uuid4())
        self.fixture.ok(self.fixture.create(work_id, "Unbound"))
        self.code(self.apply(self.apply_body("refresh", work_id=work_id)), 409, "providerBindingRequired")
        self.code(self.apply(self.apply_body("connect")), 404, "workNotFound")
        self.open.assert_not_called()
        self.keys()
        self.responses(movie())
        self.ok(self.apply(self.apply_body("connect", work_id=work_id)))
        self.open.reset_mock()
        self.code(self.apply(self.apply_body("refresh", work_id=work_id, externalId="43")),
                  409, "providerBindingMismatch")
        self.open.assert_not_called()

    def test_apply_validation_and_auth(self):
        body = self.apply_body()
        for changes in ({"snapshot": {}}, {"type": "game"}, {"commandId": str(uuid.uuid5(uuid.NAMESPACE_URL, "x"))},
                        {"workId": "not-uuid"}, {"externalId": "https://evil.test"}, {"epoch": True},
                        {"provider": "steam"}, {"operation": "delete"}):
            self.code(self.apply({**body, **changes}), 422, "providerApplyInvalid")
        self.code(self.apply(self.apply_body("connect", type=None)), 422, "providerApplyInvalid")
        for headers in ({}, {"Authorization": "Bearer invalid"}):
            self.assertEqual(self.apply(body, headers=headers).status_code, 401)
            self.assertEqual(self.client.get("/v1/providers/image", headers=headers,
                params={"provider": "tmdb", "path": "/poster.jpg", "size": "w185"}).status_code, 401)
        self.open.assert_not_called()

    def test_apply_rejection_matches_commands_and_rolls_back_connect(self):
        self.keys()
        work_id = str(uuid.uuid4())
        self.fixture.ok(self.fixture.create(work_id, "Existing"))
        body = self.apply_body("connect", work_id=work_id)
        detail = wp.tmdb_normalize(movie(), "movie")
        args = {"workId": work_id, "provider": "tmdb", "externalId": "42",
                "config": None, "expectedRevision": 0}
        self.assertEqual(self.fixture.command("bindProvider", **args).status_code, 401)
        self.assertEqual(self.fixture.command("applyProviderSnapshot", workId=work_id,
            **{k: detail["binding"][k] for k in ("provider", "externalId", "snapshot", "values", "details")},
            baseSnapshotDigest=None).status_code, 401)
        # The second command rejects: neither the first binding nor its receipt/feed survives.
        before = self.feed()
        original = wp.ca.apply_command
        def reject_snapshot(db, **kwargs):
            if kwargs["command_type"] == wp.ca.APPLY_SNAPSHOT:
                wp.ca.fail(409, "providerSnapshotStale", "작품 정보가 변경되었습니다.")
            return original(db, **kwargs)
        self.responses(movie())
        with mock.patch.object(wp.ca, "apply_command", side_effect=reject_snapshot):
            self.code(self.apply(body), 409, "providerSnapshotStale")
        with fixtures.api_app.get_db() as db:
            self.assertIsNone(wp.ca.binding_row(db, fixtures.LIBRARY, work_id, "tmdb"))
        self.assertEqual(self.feed(), before)
        self.responses(movie())
        self.assertEqual(len(self.ok(self.apply(body))["receipts"]), 2)

    def responses(self, *values):
        self.open.side_effect = [value if isinstance(value, (Response, Exception)) else Response(value)
                                 for value in values]

    def get(self, route, /, **params):
        return self.client.get("/v1/providers/" + route, params=params, headers=self.auth)

    def artwork(self, path="/poster.jpg", provider="tmdb", size="original"):
        return self.client.post("/v1/providers/artwork", headers=self.auth,
                                json={"provider": provider, "path": path, "size": size})

    def ok(self, response):
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def code(self, response, status, code):
        self.assertEqual(response.status_code, status, response.text)
        self.assertEqual(response.json()["detail"]["code"], code)

    def create(self, detail, work_id="relay-work", kind="movie"):
        metadata = detail["metadata"]
        result = self.fixture.create(work_id, metadata["name"], type_=kind,
            binding=detail["binding"], **{k: v for k, v in metadata.items() if k != "name"})
        return self.fixture.ok(result)

    def test_status_configured_only_and_client_publisher_auth(self):
        self.assertEqual(self.ok(self.get("status")), {"tmdb": False, "igdb": False})
        os.environ[wp.IGDB_ID_ENV] = "only-id"
        self.assertFalse(self.ok(self.get("status"))["igdb"])
        self.keys()
        for headers in (self.auth, self.fixture.publisher, fixtures.AUTH):
            reply = self.client.get("/v1/providers/status", headers=headers)
            self.assertEqual(self.ok(reply), {"tmdb": True, "igdb": True})
            self.assertNotIn("fixture", reply.text)
        for headers in ({}, {"Authorization": "Bearer invalid"}):
            self.assertEqual(self.client.get("/v1/providers/status", headers=headers).status_code, 401)
        self.open.assert_not_called()

    def test_missing_keys_and_malformed_keys(self):
        for path, params in (("tmdb/search", {"query": "x", "kind": "movie"}),
                             ("tmdb/movie/42", {}), ("igdb/search", {"query": "x"}), ("igdb/99", {})):
            self.code(self.get(path, **params), 503, "providerNotConfigured")
        os.environ[wp.TMDB_KEY_ENV] = "not\na-key"
        self.assertFalse(self.ok(self.get("status"))["tmdb"])
        self.open.assert_not_called()

    def test_auth_precedes_provider_or_artwork_fetch(self):
        self.keys()
        for headers in ({}, {"Authorization": "Bearer invalid"}):
            for path in ("tmdb/movie/42", "igdb/99"):
                self.assertEqual(self.client.get("/v1/providers/" + path, headers=headers).status_code, 401)
            self.assertEqual(self.client.post("/v1/providers/artwork", headers=headers,
                json={"provider": "tmdb", "path": "/poster.jpg"}).status_code, 401)
        self.open.assert_not_called()

    def test_tmdb_search_movie_tv_year_and_no_secret_disclosure(self):
        self.keys()
        self.responses({"results": [movie()]}, {"results": [{"id": 42, "name": "TV",
            "original_name": "TV", "first_air_date": "2020-01-02", "poster_path": None}]})
        items = self.ok(self.get("tmdb/search", query=" 영화 ", kind="movie", year=2024))["items"]
        self.assertEqual(items[0], {"id": 42, "externalId": "42", "kind": "movie", "name": "영화",
            "originalTitle": "Original", "releaseDate": "2024-02-01", "year": 2024,
            "path": "/poster.jpg", "previewUrl": "/v1/providers/image?provider=tmdb&path=%2Fposter.jpg&size=w185"})
        request = self.open.call_args_list[0].args[0]
        params = parse_qs(urlsplit(request.full_url).query)
        self.assertEqual(params["language"], ["ko-KR"])
        self.assertEqual(params["year"], ["2024"])
        self.assertEqual(params["api_key"], ["tmdb-fixture"])
        tv = self.ok(self.get("tmdb/search", query="TV", kind="tv", year=2020))["items"][0]
        self.assertEqual(tv["externalId"], "tv:42")
        self.assertIsNone(tv["originalTitle"])
        self.assertEqual(parse_qs(urlsplit(self.open.call_args.args[0].full_url).query)["first_air_date_year"], ["2020"])

    def test_tmdb_jwt_bearer(self):
        self.keys()
        os.environ[wp.TMDB_KEY_ENV] = "eyJheader.payload.signature"
        self.responses({"results": []})
        self.ok(self.get("tmdb/search", query="x", kind="movie"))
        request = self.open.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer eyJheader.payload.signature")
        self.assertNotIn("api_key", request.full_url)

    def test_tmdb_detail_snapshot_exact_pc_shape_and_authority_create(self):
        self.keys()
        self.responses(movie())
        detail = self.ok(self.get("tmdb/movie/42"))
        snapshot = detail["binding"]["snapshot"]
        self.assertEqual(set(snapshot), {"id", "title", "original_title", "overview", "release_date",
            "runtime_minutes", "genres", "directors", "production_companies", "external_score",
            "poster_path", "backdrop_path", "posters", "backdrops", "film"})
        self.assertEqual(snapshot["posters"], [{"filePath": "/poster.jpg", "width": 500, "height": 750}])
        self.assertEqual(snapshot["production_companies"], ["Studio", "Other"])
        self.assertEqual(snapshot["external_score"], 83)
        self.assertEqual(snapshot["release_date"], "2024-01-02")
        self.assertEqual(snapshot["film"]["cast"][0]["name"], "First")
        self.assertEqual(detail["binding"]["details"], {"series": None, "film": snapshot["film"]})
        self.assertEqual(detail["metadata"]["director"], "Director")
        receipt = self.create(detail)
        binding = receipt["entities"]["bindings"][0]
        self.assertEqual(binding["snapshot"], snapshot)
        self.assertEqual(binding["values"], detail["binding"]["values"])
        self.assertEqual(receipt["entities"]["works"][0]["fields"]["runtimeMinutes"], 123)
        self.assertEqual([a["kind"] for a in detail["artwork"]], ["poster", "backdrop"])

    def test_tmdb_fallback_preserves_original_title_and_fetches_missing_fields(self):
        self.keys()
        primary, english = movie(), movie()
        primary.update(title="", original_title="原題", overview="", runtime=None, genres=[])
        english.update(title="English", overview="English overview", runtime=90)
        self.responses(primary, english)
        detail = self.ok(self.get("tmdb/movie/42"))
        self.assertEqual(detail["metadata"]["name"], "原題")
        self.assertIsNone(detail["metadata"]["originalTitle"])
        self.assertEqual(detail["metadata"]["overview"], "English overview")
        self.assertEqual(detail["metadata"]["runtimeMinutes"], 90)
        self.assertIn("language=en-US", self.open.call_args.args[0].full_url)

    def test_tmdb_related_snapshot_and_display_detail(self):
        self.keys()
        raw = movie(); raw["belongs_to_collection"] = {"id": 10}
        self.responses(raw, {"id": 10, "name": "Films", "parts": [
            {"id": 42, "title": "Self"}, {"id": 43, "title": "Next", "release_date": "2025-01-01",
                                          "poster_path": "/next.jpg"}]})
        detail = self.ok(self.get("tmdb/movie/42"))
        self.assertEqual(detail["binding"]["snapshot"]["film"]["related"]["parts"][0]["posterPath"], "/next.jpg")
        self.assertNotIn("posterPath", detail["binding"]["details"]["film"]["related"]["parts"][0])
        self.create(detail)

    def test_tmdb_related_failure_is_optional(self):
        self.keys()
        raw = movie(); raw["belongs_to_collection"] = {"id": 10}
        self.responses(raw, HTTPError("https://ignored", 503, "error", {}, None))
        detail = self.ok(self.get("tmdb/movie/42"))
        self.assertIsNone(detail["binding"]["snapshot"]["film"]["related"])

    def tv(self):
        return {"id": 42, "name": "드라마", "original_name": "Drama", "overview": "",
                "first_air_date": "2020-01-01", "last_air_date": "2021-01-01", "status": "Ended",
                "episode_run_time": [45], "created_by": [{"name": "Creator"}],
                "aggregate_credits": {"cast": [{"name": "Actor"}]},
                "seasons": [{"id": 100, "season_number": 1}]}

    def season(self):
        return {"id": 100, "season_number": 1, "name": "Season 1", "overview": "Season overview",
                "air_date": "2020-01-01", "poster_path": "/season.jpg", "episodes": [
                    {"id": 1001, "season_number": 1, "episode_number": 2, "name": "Second"},
                    {"id": 1000, "season_number": 1, "episode_number": 1, "name": "Pilot",
                     "runtime": 46, "overview": "Pilot overview", "air_date": "2020-01-01"}]}

    def test_tmdb_tv_snapshot_seasons_episodes_posters_and_authority_create(self):
        self.keys()
        self.responses(self.tv(), {"id": 42, "overview": "Fallback"}, self.season())
        detail = self.ok(self.get("tmdb/tv/42"))
        binding = detail["binding"]
        self.assertEqual(binding["externalId"], "tv:42")
        snapshot = binding["snapshot"]
        self.assertNotIn("film", snapshot)
        self.assertEqual(snapshot["media_type"], "tv")
        series = snapshot["series"]
        self.assertEqual(series["lastAirDate"], "2021-01-01")
        self.assertEqual(series["cast"], ["Actor"])
        self.assertEqual(series["seasons"][0]["episodes"][0]["name"], "Pilot")
        self.assertEqual(series["seasons"][0]["episodes"][0]["overview"], "Pilot overview")
        self.assertNotIn("overview", binding["details"]["series"]["seasons"][0]["episodes"][0])
        self.assertEqual(detail["metadata"]["director"], "Creator")
        self.assertEqual(detail["metadata"]["overview"], "Fallback")
        self.assertEqual(detail["artwork"][0]["kind"], "season_poster")
        self.assertEqual(detail["artwork"][0]["seasonId"], 100)
        self.create(detail)

    def test_tv_refuses_partial_or_mismatched_seasons(self):
        self.keys()
        raw = self.tv(); raw["overview"] = "Present"
        season = self.season(); season["id"] = 999
        self.responses(raw, season)
        self.code(self.get("tmdb/tv/42"), 502, "providerInvalidResponse")
        self.responses(raw, HTTPError("https://ignored", 404, "error", {}, None))
        self.code(self.get("tmdb/tv/42"), 404, "providerNotFound")

    def test_igdb_search_detail_raw_snapshot_values_metadata_and_authority_create(self):
        self.keys()
        raw = game()
        self.responses({"access_token": "token1", "expires_in": 3600}, [raw], [raw])
        search = self.ok(self.get("igdb/search", query='a"; \\x'))["items"][0]
        self.assertEqual(search["externalId"], "99")
        self.assertEqual(search["releaseDate"], "2023-01-01")
        self.assertEqual(search["platforms"], "Dreamcast · Windows")
        search_request = self.open.call_args_list[1].args[0]
        self.assertIn(b'search "a\\"; \\\\x";', search_request.data)
        detail = self.ok(self.get("igdb/99"))
        self.assertEqual(detail["binding"]["snapshot"], raw)
        self.assertIsNone(detail["binding"]["details"])
        self.assertEqual(detail["binding"]["values"], {"developer": "Dev", "publisher": "Pub",
            "releaseDate": "2023-01-01", "platforms": "Windows", "genres": "RPG", "overview": "A game."})
        self.assertEqual(detail["metadata"]["platforms"], "Dreamcast · Windows")
        self.assertEqual([a["kind"] for a in detail["artwork"]], ["cover", "artwork", "screenshot"])
        self.assertEqual(detail["artwork"][0]["previewUrl"],
                         "/v1/providers/image?provider=igdb&path=co_99&size=t_cover_big")
        self.create(detail, kind="game")
        self.assertEqual(sum(call.args[0].full_url == wp.TOKEN_URL for call in self.open.call_args_list), 1)

    def test_twitch_token_expiry_credentials_change_and_401_renewal(self):
        self.keys()
        self.responses({"access_token": "token1", "expires_in": 3600}, [game()], [game()],
                       {"access_token": "token2", "expires_in": 3600}, [game()],
                       {"access_token": "token3", "expires_in": 3600}, [game()],
                       HTTPError("https://ignored", 401, "error", {}, None),
                       {"access_token": "token4", "expires_in": 3600}, [game()])
        self.ok(self.get("igdb/99"))
        self.ok(self.get("igdb/99"))
        self.relay.token_expiry = 0
        self.ok(self.get("igdb/99"))
        os.environ[wp.IGDB_SECRET_ENV] = "changed-secret"
        self.ok(self.get("igdb/99"))
        self.ok(self.get("igdb/99"))
        self.assertEqual(self.open.call_count, 10)
        self.assertEqual(self.open.call_args.args[0].get_header("Authorization"), "Bearer token4")
        self.assertEqual(parse_qs(self.open.call_args_list[5].args[0].data.decode())["client_secret"], ["changed-secret"])

    def test_twitch_second_401_is_bounded_and_redacted(self):
        self.keys()
        self.responses({"access_token": "private-token", "expires_in": 3600},
            HTTPError("https://secret-url", 401, "secret-body", {}, None),
            {"access_token": "private-token-2", "expires_in": 3600},
            HTTPError("https://secret-url", 401, "secret-body", {}, None))
        reply = self.get("igdb/99")
        self.code(reply, 502, "providerUnauthorized")
        self.assertNotIn("secret", reply.text)
        self.assertNotIn("private-token", reply.text)
        self.assertEqual(self.open.call_count, 4)

    def test_twitch_invalid_token_and_empty_game(self):
        self.keys()
        self.responses({"access_token": "", "expires_in": 0})
        self.code(self.get("igdb/99"), 502, "providerInvalidResponse")
        self.responses({"access_token": "token", "expires_in": 3600}, [])
        self.code(self.get("igdb/99"), 404, "providerNotFound")

    def test_invalid_ids_queries_and_upstream_identity(self):
        self.keys()
        for path, params in (("tmdb/search", {"query": " ", "kind": "movie"}),
                             ("tmdb/search", {"query": "x", "kind": "bad"}),
                             ("tmdb/search", {"query": "x", "kind": "movie", "year": -1}),
                             ("tmdb/movie/0", {}), ("igdb/0", {}), ("igdb/search", {"query": "\n"})):
            self.assertEqual(self.get(path, **params).status_code, 422)
        self.open.assert_not_called()
        raw = movie(); raw["id"] = 999
        self.responses(raw)
        self.code(self.get("tmdb/movie/42"), 502, "providerInvalidResponse")
        self.responses({"access_token": "token", "expires_in": 3600}, [{"id": 98}])
        self.code(self.get("igdb/99"), 502, "providerInvalidResponse")

    def test_json_cap_timeout_malformed_and_sanitized_status(self):
        self.keys()
        for value, status, code in (
            (Response(b"x", headers={"Content-Length": str(wp.MAX_JSON_BYTES + 1)}), 413, "providerResponseTooLarge"),
            (Response(b"x" * (wp.MAX_JSON_BYTES + 1)), 413, "providerResponseTooLarge"),
            (Response(b"{invalid"), 502, "providerInvalidResponse"),
            (TimeoutError("private url/key"), 504, "providerTimeout"),
            (URLError("private url/key"), 502, "providerUnavailable"),
            (HTTPError("https://private", 429, "private", {}, None), 429, "providerRateLimited")):
            with self.subTest(code=code):
                self.responses(value)
                reply = self.get("tmdb/movie/42")
                self.code(reply, status, code)
                self.assertNotIn("private", reply.text)

    def test_pacing_and_busy_refusal(self):
        relay = wp.Relay()
        self.responses({}, {})
        with mock.patch.object(wp.time, "monotonic", return_value=100), mock.patch.object(wp.time, "sleep") as sleep:
            relay.json_request("igdb", wp.GAMES_URL, 125)
            relay.json_request("igdb", wp.GAMES_URL, 125)
            self.assertEqual(sleep.call_args.args[0], 0.25)
        self.keys()
        with self.relay.locks["tmdb"]:
            self.code(self.get("tmdb/movie/42"), 429, "providerBusy")

    def test_tmdb_aggregate_budget_and_lookup_deadline(self):
        self.keys()
        raw = self.tv()
        raw["overview"] = "Present"
        self.responses(raw, self.season())
        first_bytes = len(json.dumps(raw, ensure_ascii=False).encode())
        with mock.patch.object(wp, "MAX_JSON_BYTES", first_bytes + 10):
            self.code(self.get("tmdb/tv/42"), 413, "providerResponseTooLarge")
        self.open.reset_mock()
        with mock.patch.object(wp, "REQUEST_SECONDS", 0):
            self.code(self.get("tmdb/movie/42"), 504, "providerTimeout")
        self.open.assert_not_called()

    def test_portable_dates_and_pc_list_projection(self):
        self.assertEqual(wp.timestamp_date(-86400), "1969-12-31")
        self.assertIsNone(wp.timestamp_date(10**30))
        self.assertIsNone(wp.valid_date("2024-W01-1"))
        self.assertIsNone(wp.valid_date("2024-02-30"))
        raw = game()
        raw["genres"] = [{"name": "RPG"}, {"name": "RPG"}]
        detail = wp.igdb_normalize(raw)
        self.assertEqual(detail["metadata"]["genres"], "RPG · RPG")
        self.assertEqual(detail["binding"]["values"]["genres"], "RPG · RPG")

    def test_artwork_paths_sizes_fixed_hosts_and_auth(self):
        for provider, path, size in (
            ("tmdb", "https://evil.test/image.jpg", "original"),
            ("tmdb", "//evil.test/image.jpg", "original"),
            ("tmdb", "/../image.jpg", "original"), ("tmdb", "/x.jpg?url=evil", "original"),
            ("tmdb", "/x%2f.jpg", "original"), ("tmdb", "/x.jpg", "../evil"),
            ("igdb", "https://images.igdb.com/igdb/image/upload/t_original/x.jpg", "original"),
            ("igdb", "../x", "original"), ("igdb", "x", "w185"),
        ):
            with self.subTest(provider=provider, path=path, size=size):
                self.code(self.artwork(path, provider, size), 422, "providerImagePathInvalid")
        self.open.assert_not_called()
        self.responses(Response(png(), mime="image/png"), Response(png(), mime="image/png"))
        self.ok(self.artwork())
        self.ok(self.artwork("co_99", "igdb", "720p"))
        self.assertEqual(self.open.call_args_list[0].args[0].full_url, "https://image.tmdb.org/t/p/original/poster.jpg")
        self.assertEqual(self.open.call_args_list[1].args[0].full_url, "https://images.igdb.com/igdb/image/upload/t_720p/co_99.jpg")
        self.assertIsNone(self.open.call_args.args[0].get_header("Authorization"))

    def test_redirect_handler_and_artwork_refusal(self):
        handler = wp.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, "", {}, "https://evil.test"))
        for status in (301, 302, 307, 308):
            self.responses(HTTPError("https://image.tmdb.org/x", status, "redirect",
                                     {"Location": "https://evil.test/secret"}, None))
            self.code(self.artwork(), 502, "providerRedirectRefused")
        self.assertFalse(fake_s3.objects.keys() - {wp.artwork_key(self.fixture.cover["sha256"]),
                                                  wp.artwork_key(self.fixture.thumb["sha256"])})

    def test_artwork_declared_and_streamed_size_cap_non_image_and_corrupt_image(self):
        for response, status, code in (
            (Response(b"x", "image/png", headers={"Content-Length": str(wp.MAX_ARTWORK_BYTES + 1)}),
             413, "providerResponseTooLarge"),
            (Response(b"x" * (wp.MAX_ARTWORK_BYTES + 1), "image/png"), 413, "providerResponseTooLarge"),
            (Response(png(), "text/html"), 422, "providerImageInvalid"),
            (Response(b"not an image", "image/png"), 422, "providerImageInvalid"),
            (Response(png(), "image/jpeg"), 422, "providerImageInvalid")):
            with self.subTest(code=code, mime=response.headers["Content-Type"]):
                self.responses(response)
                self.code(self.artwork(), status, code)

    def test_artwork_receipt_idempotent_and_usable_by_add_artwork(self):
        self.responses(Response(png(), "image/png"), Response(png(), "image/png"))
        with mock.patch.object(fake_s3, "put_object", wraps=fake_s3.put_object) as put:
            first = self.ok(self.artwork())
            self.assertEqual(self.ok(self.artwork()), first)
            self.assertEqual(put.call_count, 2)  # the original and its thumbnail, once
        self.assertEqual((first["width"], first["height"]), (2, 3))
        self.assertEqual(set(first["original"]), {"sha256", "sizeBytes", "contentType"})
        blob, thumb = first["original"], first["thumbnail"]
        self.assertEqual(fake_s3.objects[wp.artwork_key(blob["sha256"])]["body"], png())
        self.assertEqual(thumb["contentType"], "image/webp")
        self.assertEqual(fake_s3.objects[wp.artwork_key(thumb["sha256"])]["body"][8:12], b"WEBP")
        self.fixture.ok(self.fixture.create("artwork-work", "Artwork"))
        self.fixture.ok(self.fixture.command("addArtwork", workId="artwork-work", artworkId="art1",
            kind="poster", language=None, **first))
        with fixtures.api_app.get_db() as db:
            rows = {row[0]: tuple(row[1:]) for row in db.execute(
                "SELECT sha256,size_bytes,content_type FROM mobile_collection_artwork WHERE sha256 IN (?,?)",
                [blob["sha256"], thumb["sha256"]])}
            stored = json.loads(db.execute("SELECT thumbnail FROM collection_authority_artworks"
                                           " WHERE artwork_id='art1'").fetchone()[0])
        self.assertEqual(rows, {blob["sha256"]: (blob["sizeBytes"], "image/png"),
                                thumb["sha256"]: (thumb["sizeBytes"], "image/webp")})
        self.assertEqual(stored["sha256"], thumb["sha256"])

    def test_artwork_thumbnail_follows_the_pc_bound_and_never_fails_the_artwork(self):
        from PIL import Image
        output = io.BytesIO()
        Image.new("RGB", (1000, 1500), "blue").save(output, format="JPEG")
        with Image.open(io.BytesIO(wp.artwork_thumbnail(output.getvalue()))) as image:
            self.assertEqual((image.format, image.size), ("WEBP", (240, 360)))
        self.assertIsNone(wp.artwork_thumbnail(b"not an image"))
        self.responses(Response(png(), "image/png"))
        with mock.patch.object(wp, "artwork_thumbnail", return_value=None):
            reply = self.ok(self.artwork())
        self.assertIsNone(reply["thumbnail"])

    def test_storage_failure_or_mismatch_never_confirms_receipt(self):
        self.responses(Response(png(), "image/png"), Response(png(), "image/png"))
        with mock.patch.object(fake_s3, "put_object", side_effect=RuntimeError("secret storage config")):
            reply = self.artwork()
            self.code(reply, 502, "providerArtworkStorageUnavailable")
            self.assertNotIn("secret", reply.text)
        with mock.patch.object(fake_s3, "head_object", return_value={"ContentLength": 1, "ContentType": "image/png"}):
            self.code(self.artwork(), 409, "providerArtworkMismatch")
        with fixtures.api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM mobile_collection_artwork").fetchone()[0], 2)

    def test_artwork_request_bound_and_sanitized_validation(self):
        reply = self.client.post("/v1/providers/artwork", headers=self.auth,
                                content=b"x" * 2049, follow_redirects=False)
        self.code(reply, 413, "providerRequestTooLarge")
        reply = self.client.post("/v1/providers/artwork", headers=self.auth,
            json={"provider": "evil", "path": "secret", "extra": "secret"})
        self.code(reply, 422, "providerArtworkInvalid")
        self.assertNotIn("secret", reply.text)
        self.open.assert_not_called()


if __name__ == "__main__":
    unittest.main()
