"""Mocked provider HTTP, disposable authority DB, fake R2; no credentials/network."""
import io
import json
import os
import unittest
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

    def responses(self, *values):
        self.open.side_effect = [value if isinstance(value, (Response, Exception)) else Response(value)
                                 for value in values]

    def get(self, path, **params):
        return self.client.get("/v1/providers/" + path, params=params, headers=self.auth)

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
            "path": "/poster.jpg", "previewUrl": "https://image.tmdb.org/t/p/w185/poster.jpg"})
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
        self.assertEqual(detail["artwork"][0]["previewUrl"], "https://images.igdb.com/igdb/image/upload/t_thumb/co_99.jpg")
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
            self.assertEqual(put.call_count, 1)
        self.assertEqual((first["width"], first["height"]), (2, 3))
        self.assertEqual(set(first["original"]), {"sha256", "sizeBytes", "contentType"})
        blob = first["original"]
        self.assertEqual(fake_s3.objects[wp.artwork_key(blob["sha256"])]["body"], png())
        self.fixture.ok(self.fixture.create("artwork-work", "Artwork"))
        self.fixture.ok(self.fixture.command("addArtwork", workId="artwork-work", artworkId="art1",
            kind="poster", language=None, thumbnail=None, **first))
        with fixtures.api_app.get_db() as db:
            row = db.execute("SELECT size_bytes,content_type FROM mobile_collection_artwork WHERE sha256=?",
                             [blob["sha256"]]).fetchone()
        self.assertEqual(tuple(row), (blob["sizeBytes"], "image/png"))

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
