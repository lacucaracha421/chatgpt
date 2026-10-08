"""Mocked StashDB HTTP, disposable authority DB and fake R2; no live provider calls."""
import io
import json
import os
import unittest
import uuid
from urllib.error import HTTPError, URLError
from unittest import mock

from PIL import Image
from fastapi import FastAPI
from fastapi.testclient import TestClient
from tests import test_collection_authority as fixtures
from tests.test_capture_api_stub import fake_s3
from tests.test_work_providers import Response
import av_stashdb as av
import work_providers as wp


def performer(id_="one", **changes):
    return {"id": id_, "name": "日本名", "aliases": [" Ａlice   Ｎame "], "gender": "FEMALE",
            "birth_date": "2001-12-08", "height": 156, "band_size": 34, "waist_size": 23,
            "hip_size": 33, "cup_size": "E", "breast_type": "NATURAL", "career_start_year": 2021,
            "urls": [{"url": "https://example.com", "site": {"name": "Studio Profile"}}],
            "images": [{"id": "photo", "url": "https://stashdb.org/images/photo", "width": 2000, "height": 3000}], **changes}


def png(size=(2, 3), format_="PNG"):
    output = io.BytesIO()
    Image.new("RGB", size, "red").save(output, format=format_)
    return output.getvalue()


class StashDBTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CollectionAuthorityTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.addCleanup(self.fixture.tearDown)
        self.fixture.ready()
        self.fixture.av_person()
        for patch in (mock.patch.dict(os.environ, {av.KEY_ENV: "mock-only-secret"}, clear=True),
                      mock.patch.object(wp.time, "sleep"), mock.patch.object(av, "relay", wp.Relay())):
            patch.start()
            self.addCleanup(patch.stop)
        http = mock.patch.object(wp._opener, "open", side_effect=AssertionError("Unmocked outbound HTTP"))
        self.open = http.start()
        self.addCleanup(http.stop)
        app = FastAPI()
        for module in (wp, av):
            module.register(app, fixtures.api_app.get_db, fixtures.api_app._home_client,
                            lambda: fake_s3, lambda: "test-bucket")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.auth = self.fixture.auth

    def response(self, value, field="findPerformer"):
        self.open.side_effect = [Response({"data": {field: value}})]

    def get(self, suffix, **params):
        return self.client.get(av.PREFIX + suffix, headers=self.auth, params=params)

    def command(self, **changes):
        body = dict(personId="p", stashdbId="one", expectedRevision=1)
        body.update(changes)
        return self.fixture.command("setPersonProfile", **body)

    def code(self, reply, status, code):
        self.assertEqual(reply.status_code, status, reply.text)
        self.assertEqual(reply.json()["detail"]["code"], code)
        self.assertNotIn("mock-only-secret", reply.text)

    def photo(self, response=None, row=None):
        self.open.side_effect = [Response({"data": {"findPerformer": row or performer()}}),
                                 response or Response(png(), "image/png")]
        return self.client.post(av.PREFIX + "/portrait", headers=self.auth,
                                json={"stashdbId": "one", "imageId": "photo"})

    def test_search_pc_alias_width_whitespace_gender_and_preview(self):
        self.response([performer(), performer("male", gender="MALE")], "searchPerformer")
        reply = self.get("/search", query="alice name")
        self.assertEqual(reply.status_code, 200, reply.text)
        result = reply.json()
        self.assertEqual((result["status"], result["matchedId"]), ("matched", "one"))
        item = result["items"][0]
        self.assertEqual((item["heightCm"], item["bandIn"], item["waistIn"], item["hipIn"]), (156, 34, 23, 33))
        self.assertEqual(item["urls"][0]["site"], {"name": "Studio Profile"})
        self.assertTrue(item["previewUrl"].startswith(av.PREFIX + "/image?"))
        self.assertNotIn("https://stashdb.org/images", reply.text)
        request = self.open.call_args.args[0]
        self.assertEqual(request.get_header("Apikey"), "mock-only-secret")
        self.assertEqual(json.loads(request.data)["variables"], {"t": "alice name"})
        self.assertEqual(request.full_url, av.ENDPOINT)
        self.assertIsNone(self.fixture.person()["profile"])

    def test_ambiguous_none_and_unrelated_candidates_are_read_only(self):
        for rows, status in (([performer(), performer("two", gender=None)], "ambiguous"),
                             ([performer(name="Unrelated", aliases=[])], "ambiguous"),
                             ([performer(gender="MALE")], "none"), ([], "none")):
            self.response(rows, "searchPerformer")
            self.assertEqual(self.get("/search", query="日本名").json()["status"], status)
        self.assertIsNone(self.fixture.person()["profile"])

    def test_detail_normalization_bounds_dates_urls_images(self):
        row = performer(birth_date="2001-02-30", height=301, band_size=201, waist_size=0,
                        hip_size=-1, cup_size=" ", breast_type="unknown", career_end_year=2020)
        row["urls"].append({"url": "javascript:bad", "site": {"name": "bad"}})
        row["images"].append({"id": "bad", "url": "https://evil.test/photo", "width": 1, "height": 2})
        self.response(row)
        reply = self.get("/performers/one")
        self.assertEqual(reply.status_code, 200, reply.text)
        result = reply.json()
        for field in ("birthDate", "heightCm", "bandIn", "waistIn", "hipIn", "cup", "breastType", "careerEnd"):
            self.assertIsNone(result[field])
        self.assertEqual(len(result["urls"]), 1)
        self.assertEqual(len(result["images"]), 1)
        for value in ("2000", "2000-02", "2000-02-29"):
            self.assertEqual(av.valid_date(value), value)
        for kind in ("NATURAL", "FAKE", "NA"):
            self.assertEqual(av.normalize(performer(breast_type=kind))["breastType"], kind)

    def test_status_not_configured_and_invalid_key(self):
        for value in ("", "bad\nkey", "x" * 4097):
            os.environ[av.KEY_ENV] = value
            self.assertFalse(self.client.get("/v1/providers/status", headers=self.auth).json()["stashdb"])
            self.code(self.get("/search", query="name"), 503, "providerNotConfigured")
            self.code(self.command(), 503, "providerNotConfigured")
        self.open.assert_not_called()
        os.environ[av.KEY_ENV] = "mock-only-secret"
        reply = self.client.get("/v1/providers/status", headers=self.auth)
        self.assertTrue(reply.json()["stashdb"])
        self.assertNotIn("mock-only-secret", reply.text)

    def test_auth_validation_busy_and_request_limit(self):
        self.assertEqual(self.client.get(av.PREFIX + "/search", params={"query": "x"}).status_code, 401)
        self.code(self.get("/search", query=" "), 422, "providerQueryInvalid")
        self.code(self.get("/performers/bad%20id"), 422, "providerIdentityInvalid")
        av.relay.locks["stashdb"].acquire()
        try:
            self.code(self.get("/search", query="x"), 429, "providerBusy")
        finally:
            av.relay.locks["stashdb"].release()
        reply = self.client.post(av.PREFIX + "/portrait", headers=self.auth, content=b"x" * 2049)
        self.assertEqual(reply.status_code, 413)
        self.open.assert_not_called()

    def test_upstream_errors_timeout_size_and_secret_redaction(self):
        cases = [(TimeoutError("mock-only-secret"), 504, "providerTimeout"),
                 (URLError("mock-only-secret"), 502, "providerUnavailable"),
                 (Response({"errors": [{"message": "mock-only-secret"}]}), 502, "providerInvalidResponse"),
                 (Response(b"not-json"), 502, "providerInvalidResponse"),
                 (Response({}, headers={"Content-Length": str(av.MAX_JSON + 1)}), 413, "providerResponseTooLarge")]
        for upstream, status, code in cases:
            self.open.side_effect = [upstream]
            self.code(self.get("/search", query="x"), status, code)
        for status, code, returned in ((401, "providerUnauthorized", 502), (403, "providerUnauthorized", 502),
                                      (429, "providerRateLimited", 429), (500, "providerUnavailable", 502),
                                      (302, "providerRedirectRefused", 502)):
            self.open.side_effect = [HTTPError(av.ENDPOINT, status, "mock-only-secret", {}, None)]
            self.code(self.get("/search", query="x"), returned, code)

    def test_detail_missing_mismatched_gender_and_invalid_rows(self):
        for value, status, code in ((None, 404, "providerNotFound"), (performer("other"), 502, "providerInvalidResponse"),
                                   (performer(gender="MALE"), 502, "providerInvalidResponse"),
                                   (performer(name=""), 502, "providerInvalidResponse"),
                                   (performer(aliases=["x"] * 101), 502, "providerInvalidResponse")):
            self.response(value)
            self.code(self.get("/performers/one"), status, code)

    def test_profile_cas_replay_refresh_clear_and_republish(self):
        self.response(performer())
        operation = str(uuid.uuid4())
        receipt = self.fixture.ok(self.command(operation_id=operation))
        person = receipt["person"]
        self.assertEqual((person["entityRevision"], person["stashdbId"]), (2, "one"))
        self.assertEqual(person["profile"]["urls"], [{"site": "Studio Profile", "url": "https://example.com"}])
        self.assertNotIn("images", person["profile"])
        work = receipt["entities"]["works"][0]
        self.assertEqual(work["avPeople"][0]["profile"], person["profile"])
        self.assertEqual(work["entityRevision"], 3)
        self.assertEqual(self.fixture.person()["profile"], person["profile"])
        self.open.reset_mock()
        os.environ.pop(av.KEY_ENV)
        self.assertEqual(self.fixture.ok(self.command(operation_id=operation)), receipt)
        self.code(self.command(operation_id=operation, stashdbId=None), 409, "operationConflict")
        self.open.assert_not_called()
        os.environ[av.KEY_ENV] = "mock-only-secret"
        self.response(performer())
        self.assertFalse(self.fixture.ok(self.command())["changed"])
        self.response(performer(name="New"))
        self.code(self.command(), 409, "revisionConflict")
        self.response(performer(name="New"))
        refreshed = self.fixture.ok(self.command(expectedRevision=2))
        self.assertEqual(refreshed["person"]["entityRevision"], 3)
        os.environ.pop(av.KEY_ENV)
        cleared = self.fixture.ok(self.command(stashdbId=None, expectedRevision=3))
        self.assertIsNone(cleared["person"]["profile"])
        self.assertIsNone(cleared["person"]["stashdbId"])
        self.assertEqual(cleared["person"]["entityRevision"], 4)
        self.assertFalse(self.fixture.ok(self.command(stashdbId=None))["changed"])

    def test_missing_invalid_command_and_failed_fetch_do_not_write(self):
        self.code(self.command(personId="missing"), 404, "personNotFound")
        self.open.assert_not_called()
        for change in ({"expectedRevision": True}, {"stashdbId": "https://evil.test"}, {"profile": {}}):
            self.assertEqual(self.command(**change).status_code, 422)
        self.open.side_effect = [TimeoutError()]
        self.code(self.command(), 504, "providerTimeout")
        self.assertEqual(self.fixture.person()["entityRevision"], 1)
        self.assertIsNone(self.fixture.person()["profile"])

    def test_provider_io_releases_db_and_concurrent_edit_conflicts(self):
        def during(request, **kwargs):
            self.fixture.ok(self.fixture.command("setPerson", personId="p", changes={"memo": "new"}, expected={"memo": None}))
            return Response({"data": {"findPerformer": performer()}})
        self.open.side_effect = during
        self.code(self.command(), 409, "revisionConflict")
        self.assertEqual(self.fixture.person()["memo"], "new")
        self.assertIsNone(self.fixture.person()["profile"])

    def test_proxy_origin_only_auth_and_server_resolved_image(self):
        for url, key in (("https://stashdb.org/images/photo", "mock-only-secret"),
                         ("https://cdn.stashdb.org/images/ab/cd/photo", None)):
            row = performer(images=[{"id": "photo", "url": url, "width": 2, "height": 3}])
            self.open.side_effect = [Response({"data": {"findPerformer": row}}), Response(png(), "image/png")]
            reply = self.get("/image", stashdbId="one", imageId="photo")
            self.assertEqual(reply.status_code, 200, reply.text)
            self.assertEqual(reply.content, png())
            self.assertEqual(self.open.call_args.args[0].full_url, url)
            self.assertEqual(self.open.call_args.args[0].get_header("Apikey"), key)
            self.assertEqual(reply.headers["Cache-Control"], "private, max-age=86400")
        for url in ("https://evil.test/images/photo", "https://stashdb.org:443/images/photo", "https://stashdb.org/images/../graphql", "http://stashdb.org/images/photo", "https://stashdb.org/images/photo?apikey=bad"):
            self.assertFalse(av.image_address(url))
        self.response(performer())
        self.code(self.get("/image", stashdbId="one", imageId="missing"), 404, "providerNotFound")

    def test_photo_blob_receipt_then_set_person_portrait(self):
        reply = self.photo(Response(png((1800, 2400)), "image/png"))
        self.assertEqual(reply.status_code, 200, reply.text)
        result = reply.json()
        self.assertEqual((result["width"], result["height"]), (1200, 1600))
        self.assertEqual(result["original"]["contentType"], "image/jpeg")
        self.assertLessEqual(result["original"]["sizeBytes"], 5 * 1024 * 1024)
        self.assertEqual(result["attribution"], {"source": "stashdb", "sourceUrl": "https://stashdb.org/images/photo", "license": None, "author": None})
        stored = fake_s3.objects["work-artwork/mobile/" + result["original"]["sha256"]]["body"]
        with Image.open(io.BytesIO(stored)) as image:
            self.assertEqual((image.format, image.size), ("JPEG", (1200, 1600)))
        self.assertIsNone(self.fixture.person()["portraitSelection"])
        receipt = self.fixture.ok(self.fixture.command("setPersonPortrait", personId="p", portrait={"kind": "image", **result}, expectedRevision=1))
        self.assertEqual(receipt["person"]["portraitSelection"]["original"], result["original"])

    def test_image_size_mime_corruption_format_and_pixel_limits(self):
        for response, status, code in ((Response(b"x", "image/png", headers={"Content-Length": str(av.MAX_IMAGE_BYTES + 1)}), 413, "providerResponseTooLarge"),
                                      (Response(b"x" * (av.MAX_IMAGE_BYTES + 1), "image/png"), 413, "providerResponseTooLarge"),
                                      (Response(b"html", "text/html"), 422, "providerImageInvalid"),
                                      (Response(b"corrupt", "image/png"), 422, "providerImageInvalid"),
                                      (Response(png(), "image/jpeg"), 422, "providerImageInvalid"),
                                      (Response(png(format_="GIF"), "image/gif"), 422, "providerImageInvalid")):
            self.code(self.photo(response), status, code)
        with mock.patch.object(av, "MAX_IMAGE_PIXELS", 5):
            self.code(self.photo(), 422, "providerImageInvalid")
        with mock.patch.object(av.av_contract, "MAX_PORTRAIT_BYTES", 1):
            self.code(self.photo(), 413, "providerResponseTooLarge")
        self.assertIsNone(self.fixture.person()["portraitSelection"])

    def test_animation_exif_storage_failure_and_digest_reuse(self):
        animated = io.BytesIO()
        Image.new("RGB", (2, 3), "red").save(animated, format="PNG", save_all=True,
            append_images=[Image.new("RGB", (2, 3), "blue")], duration=100, loop=0)
        self.code(self.photo(Response(animated.getvalue(), "image/png")), 422, "providerImageInvalid")
        oriented = io.BytesIO()
        image = Image.new("RGB", (4, 2), "red")
        exif = image.getexif()
        exif[274] = 6
        image.save(oriented, format="JPEG", exif=exif)
        reply = self.photo(Response(oriented.getvalue(), "image/jpeg"))
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual((reply.json()["width"], reply.json()["height"]), (2, 4))
        with mock.patch.object(fake_s3, "put_object", wraps=fake_s3.put_object) as put:
            first = self.photo().json()
            second = self.photo().json()
            self.assertEqual(first, second)
            self.assertEqual(put.call_count, 1)
        with mock.patch.object(fake_s3, "fail_put", True):
            self.code(self.photo(Response(png((7, 9)), "image/png")), 502, "providerArtworkStorageUnavailable")
        self.assertIsNone(self.fixture.person()["portraitSelection"])
