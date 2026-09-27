"""Isolated replica tests: no real library, storage or provider requests."""
import copy
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.test_capture_api_stub import fake_s3
import app as api_app
import head_cache
import mobile_collections
from fastapi.testclient import TestClient

AUTH = {"Authorization": "Bearer collections-test"}


def work(id="work", name="작품", type="manga"):
    return {"id": id, "name": name, "type": type, "createdAt": "2026-09-07T00:00:00Z", "updatedAt": "2026-09-07T00:00:00Z", "artworks": [], "volumes": []}


def blob(data=b"image"):
    digest = hashlib.sha256(data).hexdigest()
    return {"sha256": digest, "sizeBytes": len(data), "contentType": "image/webp", "objectKey": "work-artwork/mobile/" + digest}


def av_info():
    return {"productCode": "TEST-001", "titleJa": "作品", "maker": "Maker", "label": "Label",
            "series": "Series", "genres": ["Genre"], "releaseDate": "2024-02-29",
            "people": [{"id": "person", "name": "Performer", "nameJa": "出演者",
                        "role": "performer", "order": 0, "portraitCrop": None},
                       {"id": "director", "name": "Director", "nameJa": None,
                        "role": "director", "order": 1, "portraitCrop": None}]}


class MobileCollectionsTests(unittest.TestCase):
    def setUp(self):
        self.clock = 0.0
        cache = head_cache.HeadMetadataCache(clock=lambda: self.clock)
        self.cache_patch = mock.patch.object(head_cache, "ticket_heads", cache)
        self.cache_patch.start()
        self.addCleanup(self.cache_patch.stop)
        endpoint_patch = mock.patch.object(fake_s3, "meta", mock.Mock(
            endpoint_url="https://" + "a" * 32 + ".r2.cloudflarestorage.com"), create=True)
        endpoint_patch.start()
        self.addCleanup(endpoint_patch.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.old_path, self.old_token = api_app.DB_PATH, api_app.API_TOKEN
        api_app.DB_PATH = Path(self.temp.name) / "fixture.sqlite"
        api_app.API_TOKEN = "collections-test"
        api_app.startup()
        api_app.startup_mobile_collections()
        fake_s3.objects.clear()
        self.client = TestClient(api_app.app)

    def tearDown(self):
        self.client.close()
        fake_s3.objects.clear()
        api_app.DB_PATH, api_app.API_TOKEN = self.old_path, self.old_token
        self.temp.cleanup()

    def publish(self, items, revision=None):
        return self.client.put("/v1/collections/replica", headers=AUTH, json={"version": 1, "baseRevision": revision, "collections": items})

    def listing(self, **params):
        return self.client.get("/v1/collections", headers=AUTH, params=params)

    def with_art(self):
        item, media = work(), blob()
        item.update(selectedWorkArtworkId="cover", artworks=[{"id": "cover", "kind": "cover", "selected": True, "thumbnail": media, "original": media}], volumes=[{"id": "volume", "volumeNumber": 2, "editionIndex": 1, "displayLabel": "2권", "coverArtworkId": "cover"}])
        return item, media

    def test_av_capability_precedes_publication_and_preserves_legacy_shape(self):
        status = self.client.get("/v1/collections/status", headers=AUTH).json()
        self.assertIsNone(status["revision"])
        self.assertEqual(status["collectionTypes"], ["game", "manga", "movie", "av"])
        items = [work(type="av"), work("manga")]
        reply = self.publish(items)
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual(reply.json()["collections"], 2)
        for item in self.listing().json()["items"]:
            self.assertNotIn("av", item)
        self.assertNotIn("av", self.client.get("/v1/collections/manga", headers=AUTH).json()["item"])
        with api_app.get_db() as db:
            self.assertEqual(mobile_collections.status_signal(db)["revision"], reply.json()["revision"])

    def test_av_list_detail_filter_counts_and_cover_crop_ticket(self):
        item, media = self.with_art()
        item.update(type="av", av=av_info())
        crop = {"artworkId": "cover", "x": 0.1, "y": 0, "w": 0.5, "h": 1}
        item["av"]["people"][0]["portraitCrop"] = crop
        fake_s3.objects[media["objectKey"]] = {"body": b"image", "content_type": "image/webp"}
        reply = self.publish([item, work("manga"), work("av-plain", type="av")])
        self.assertEqual(reply.status_code, 200, reply.text)
        listing = self.listing(type="av").json()
        self.assertEqual(listing["totalCount"], 2)
        self.assertEqual({row["id"] for row in listing["items"]}, {"work", "av-plain"})
        self.assertEqual(next(row for row in listing["items"] if row["id"] == "work")["av"], item["av"])
        self.assertEqual(self.listing(type="manga").json()["totalCount"], 1)
        self.assertEqual(self.listing().json()["totalCount"], 3)
        detail = self.client.get("/v1/collections/work", headers=AUTH).json()["item"]
        self.assertEqual(detail["av"], item["av"])
        self.assertEqual(self.client.post("/v1/collections/work/artworks/cover/media-ticket",
                                         headers=AUTH, json={}).status_code, 200)
        self.assertNotIn("objectKey", self.listing(type="av").text)

    def test_av_details_rejected_on_every_other_type(self):
        for kind in ("game", "manga", "movie"):
            with self.subTest(kind=kind):
                reply = self.publish([{**work(type=kind), "av": av_info()}])
                self.assertEqual(reply.status_code, 422, reply.text)
        self.assertFalse(self.listing().json()["ready"])

    def test_av_bounds_dates_ids_roles_and_private_fields(self):
        invalid = [("productCode", "x" * 65), ("titleJa", "x" * 2001),
                   *[(key, "x" * 501) for key in ("maker", "label", "series")],
                   ("genres", ["x"] * 65), ("genres", ["x" * 101]),
                   ("people", av_info()["people"][:1] * 65),
                   *[("releaseDate", value) for value in ("2026-02-29", "2024-2-01", "2024-01-01T00:00:00Z")],
                   ("portraitUrl", "https://private.invalid/portrait")]
        for key, value in invalid:
            with self.subTest(key=key, value=str(value)[:50]):
                info = {**av_info(), key: value}
                self.assertEqual(self.publish([{**work(type="av"), "av": info}]).status_code, 422)
        for key, value in (("id", "../person"), ("name", "x" * 501), ("nameJa", "x" * 501),
                           ("role", "actor"), ("order", 1.5), ("order", True),
                           ("portraitPath", "/private/portrait")):
            info = av_info()
            info["people"][0][key] = value
            with self.subTest(person_field=key):
                reply = self.publish([{**work(type="av"), "av": info}])
                self.assertEqual(reply.status_code, 422)
                self.assertNotIn("/private/portrait", reply.text)
        for value in (-0.01, 1.01, float("inf"), float("nan")):
            for coordinate in ("x", "y", "w", "h"):
                crop = {"artworkId": "cover", "x": 0, "y": 0, "w": 1, "h": 1, coordinate: value}
                with self.subTest(coordinate=coordinate, value=value):
                    with self.assertRaises(ValueError):
                        mobile_collections.AvPortraitCrop.model_validate(crop)

    def test_av_crop_requires_published_av_cover_in_current_snapshot(self):
        target = {**work("target", type="av"), "av": av_info()}
        target["av"]["people"][0]["portraitCrop"] = {
            "artworkId": "cover", "x": 0, "y": 0, "w": 1, "h": 1}
        source, media = self.with_art()
        source["type"] = "av"
        fake_s3.objects[media["objectKey"]] = {"body": b"image", "content_type": "image/webp"}
        for kind, artwork_kind, with_bytes in (("manga", "cover", True), ("av", "back", True),
                                                ("av", "cover", False)):
            bad_source = copy.deepcopy(source)
            bad_source["type"] = kind
            bad_source["artworks"][0]["kind"] = artwork_kind
            if not with_bytes:
                bad_source["artworks"][0].update(thumbnail=None, original=None)
            self.assertEqual(self.publish([target, bad_source]).status_code, 422)
        self.assertEqual(self.publish([target]).status_code, 422)
        self.assertEqual(self.publish([target, source, {**source, "id": "duplicate-cover"}]).status_code, 422)
        reply = self.publish([target, source])
        self.assertEqual(reply.status_code, 200, reply.text)
        # An old published cover cannot outlive its source in a complete replacement.
        self.assertEqual(self.publish([target], reply.json()["revision"]).status_code, 422)
        self.assertEqual(self.listing().json()["totalCount"], 2)

    def test_mobile_series_projection_and_revision_check(self):
        item = work(type="movie")
        item["series"] = {"status": "Ended", "cast": ["Actor"], "seasons": [{"id": 1, "seasonNumber": 1, "name": "Season 1", "airDate": "2020-01-01", "posterArtworkId": None, "episodes": [{"id": 2, "episodeNumber": 1, "name": "Episode", "airDate": None, "runtimeMinutes": 24}]}]}
        response = self.publish([item])
        self.assertEqual(response.status_code, 200)
        status = self.client.get("/v1/collections/status", headers=AUTH)
        self.assertEqual(status.json()["revision"], response.json()["revision"])
        self.assertEqual(self.client.get("/v1/collections/status").status_code, 401)
        self.assertNotIn("series", self.listing(type="movie").json()["items"][0])
        detail = self.client.get("/v1/collections/work", headers=AUTH).json()["item"]
        self.assertEqual(detail["series"]["seasons"][0]["episodes"][0]["runtimeMinutes"], 24)
        item["series"]["seasons"][0]["posterArtworkId"] = "outside"
        self.assertEqual(self.publish([item], response.json()["revision"]).status_code, 422)

    def test_mobile_film_projection_is_detail_only_and_optional(self):
        film_item, plain = work(type="movie"), work(id="plain", type="movie")
        film_item["film"] = {"cast": [{"name": "Actor", "character": "Hero"}],
                             "releases": [{"country": "KR", "releaseType": 3, "date": "2024-01-02", "certification": "15"}],
                             "related": {"collectionName": "Saga", "parts": [{"movieId": 7, "title": "Part 2", "releaseDate": None}]}}
        response = self.publish([film_item, plain])
        self.assertEqual(response.status_code, 200)
        self.assertTrue(all("film" not in item for item in self.listing(type="movie").json()["items"]))
        detail = self.client.get("/v1/collections/work", headers=AUTH).json()["item"]
        self.assertEqual(detail["film"]["related"]["parts"][0]["movieId"], 7)
        self.assertEqual(detail["film"]["releases"][0]["releaseType"], 3)
        self.assertIsNone(self.client.get("/v1/collections/plain", headers=AUTH).json()["item"]["film"])
        revision = response.json()["revision"]
        for key, value in (("posterPath", "/provider"), ("localCollectionId", "work")):
            leaked = copy.deepcopy(film_item)
            leaked["film"]["related"]["parts"][0][key] = value
            self.assertEqual(self.publish([leaked], revision).status_code, 422)

    def test_unpublished_differs_from_published_empty(self):
        self.assertFalse(self.listing().json()["ready"])
        self.assertEqual(self.publish([]).status_code, 200)
        self.assertEqual(self.listing().json()["items"], [])
        self.assertTrue(self.listing().json()["ready"])

    def test_every_route_requires_auth(self):
        self.assertEqual(self.client.get("/v1/collections").status_code, 401)
        self.assertEqual(self.client.get("/v1/collections/work").status_code, 401)
        self.assertEqual(self.client.put("/v1/collections/replica", json={}).status_code, 401)
        self.assertEqual(self.client.post("/v1/collections/artworks/prepare", json={k: v for k, v in blob().items() if k != "objectKey"}).status_code, 401)
        self.assertEqual(self.client.post("/v1/collections/work/artworks/cover/media-ticket", json={"variant": "thumbnail"}).status_code, 401)

    def test_private_fields_and_bad_ids_rejected_without_echo(self):
        item = work(); item["sourcePath"] = "C:/private/location"
        result = self.publish([item])
        self.assertEqual(result.status_code, 422)
        self.assertNotIn("private/location", result.text)
        self.assertEqual(self.publish([work("../escape")]).status_code, 422)
        self.assertEqual(self.publish([work(), work()]).status_code, 422)

    def test_batch_receipts_skip_storage_and_missing_media_invalidates_receipt(self):
        item, media = self.with_art()
        fake_s3.objects[media["objectKey"]] = {"body": b"image", "content_type": "image/webp"}
        request = {k:v for k,v in media.items() if k != "objectKey"}
        self.client.post("/v1/collections/artworks/prepare", headers=AUTH, json=request)
        self.assertEqual(self.publish([item]).status_code, 200)
        other = {**request, "sha256":"a"*64}
        with mock.patch.object(fake_s3, "head_object", side_effect=AssertionError("batch must not HEAD")):
            response = self.client.post("/v1/collections/artworks/check", headers=AUTH, json={"items":[request,other]})
            self.assertEqual(response.json(), {"missing":[other["sha256"]]})
            self.assertEqual(self.client.post("/v1/collections/artworks/check", json={"items":[]}).status_code, 401)
            self.assertEqual(self.client.post("/v1/collections/artworks/check", headers=AUTH, json={"items":[request]*257}).status_code, 422)
            self.assertEqual(self.client.post("/v1/collections/artworks/check", headers=AUTH, json={"items":[request,request]}).status_code, 422)
        fake_s3.objects.clear()
        self.assertEqual(self.client.post("/v1/collections/work/artworks/cover/media-ticket?fresh_head=true", headers=AUTH, json={"variant":"original"}).status_code, 404)
        self.assertEqual(self.client.post("/v1/collections/artworks/check", headers=AUTH, json={"items":[request]}).json(), {"missing":[request["sha256"]]})

    def test_committed_ticket_metadata_requires_no_head_but_checks_published_membership(self):
        item, media = self.with_art()
        fake_s3.objects[media["objectKey"]] = {"body": b"image", "content_type": "image/webp"}
        revision = self.publish([item]).json()["revision"]
        path = "/v1/collections/work/artworks/cover/media-ticket"
        with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head:
            for _ in range(2):
                self.assertEqual(self.client.post(path, headers=AUTH, json={}).status_code, 200)
            self.assertEqual(head.call_count, 0)
            self.assertEqual(self.client.post(path, json={}).status_code, 401)
            self.assertEqual(self.publish([], revision).status_code, 200)
            self.assertEqual(self.client.post(path, headers=AUTH, json={}).status_code, 404)
            self.assertEqual(head.call_count, 0)

    def test_fresh_missing_ticket_invalidates_receipt_and_recovers_immediately(self):
        item, media = self.with_art()
        stored = {"body": b"image", "content_type": "image/webp"}
        fake_s3.objects[media["objectKey"]] = stored
        self.assertEqual(self.publish([item]).status_code, 200)
        path = "/v1/collections/work/artworks/cover/media-ticket"
        self.assertEqual(self.client.post(path, headers=AUTH, json={}).status_code, 200)
        fake_s3.objects.clear()
        self.clock = 30
        self.assertEqual(self.client.post(path, headers=AUTH, json={}).status_code, 200)
        self.assertEqual(self.client.post(path + "?fresh_head=true", headers=AUTH, json={}).status_code, 404)
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM mobile_collection_artwork").fetchone()[0], 0)
        fake_s3.objects[media["objectKey"]] = stored
        self.assertEqual(self.client.post(path, headers=AUTH, json={}).status_code, 200)

    def test_prepare_missing_invalidates_warm_ticket_and_receipt(self):
        item, media = self.with_art()
        fake_s3.objects[media["objectKey"]] = {"body": b"image", "content_type": "image/webp"}
        self.assertEqual(self.publish([item]).status_code, 200)
        path = "/v1/collections/work/artworks/cover/media-ticket"
        self.assertEqual(self.client.post(path, headers=AUTH, json={}).status_code, 200)
        fake_s3.objects.clear()
        body = {k: v for k, v in media.items() if k != "objectKey"}
        prepared = self.client.post("/v1/collections/artworks/prepare", headers=AUTH, json=body)
        self.assertIsNotNone(prepared.json()["uploadUrl"])
        self.assertEqual(self.client.post(path, headers=AUTH, json={}).status_code, 404)
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM mobile_collection_artwork").fetchone()[0], 0)

    def test_manifest_change_rechecks_and_mismatch_is_not_sticky(self):
        item, media = self.with_art()
        fake_s3.objects[media["objectKey"]] = {"body": b"image", "content_type": "image/webp"}
        self.assertEqual(self.publish([item]).status_code, 200)
        path = "/v1/collections/work/artworks/cover/media-ticket"
        self.assertEqual(self.client.post(path, headers=AUTH, json={}).status_code, 200)
        # Isolate a changed current manifest from the separately tested publisher.
        with api_app.get_db() as db:
            db.execute("UPDATE mobile_collections SET payload=json_set(payload,'$.artworks[0].thumbnail.sizeBytes',6)")
            db.commit()
        with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head:
            self.assertEqual(self.client.post(path, headers=AUTH, json={}).status_code, 409)
            fake_s3.objects[media["objectKey"]]["body"] = b"image!"
            self.assertEqual(self.client.post(path, headers=AUTH, json={}).status_code, 200)
            self.assertEqual(head.call_count, 2)

    def test_ticket_storage_error_is_not_cached(self):
        item, media = self.with_art()
        fake_s3.objects[media["objectKey"]] = {"body": b"image", "content_type": "image/webp"}
        self.assertEqual(self.publish([item]).status_code, 200)
        path = "/v1/collections/work/artworks/cover/media-ticket"
        with mock.patch.object(fake_s3, "head_object", side_effect=RuntimeError("offline")):
            self.assertEqual(self.client.post(path + "?fresh_head=true", headers=AUTH, json={}).status_code, 502)
        self.assertEqual(self.client.post(path, headers=AUTH, json={}).status_code, 200)

    def test_missing_receipt_and_fresh_requests_still_head_both_artwork_variants(self):
        item, media = self.with_art()
        fake_s3.objects[media["objectKey"]] = {"body": b"image", "content_type": "image/webp"}
        self.assertEqual(self.publish([item]).status_code, 200)
        path = "/v1/collections/work/artworks/cover/media-ticket"
        with mock.patch.object(fake_s3, "head_object", wraps=fake_s3.head_object) as head:
            for variant in ("thumbnail", "original"):
                self.assertEqual(self.client.post(path, headers=AUTH, json={"variant": variant}).status_code, 200)
            self.assertEqual(head.call_count, 0)
            self.assertEqual(self.client.post(path + "?fresh_head=true", headers=AUTH, json={}).status_code, 200)
            self.assertEqual(head.call_count, 1)
            with api_app.get_db() as db:
                db.execute("DELETE FROM mobile_collection_artwork")
                db.commit()
            self.assertEqual(self.client.post(path, headers=AUTH, json={}).status_code, 200)
            self.assertEqual(head.call_count, 2)

    def test_prepare_reuses_confirmed_bytes_and_rejects_wrong_lengths(self):
        media = blob()
        request = {k: v for k, v in media.items() if k != "objectKey"}
        first = self.client.post("/v1/collections/artworks/prepare", headers=AUTH, json=request)
        self.assertEqual(first.status_code, 200)
        self.assertTrue(first.json()["uploadUrl"].startswith("https://"))
        fake_s3.objects[media["objectKey"]] = {"body": b"image", "content_type": "image/webp"}
        self.assertIsNone(self.client.post("/v1/collections/artworks/prepare", headers=AUTH, json=request).json()["uploadUrl"])
        request["sizeBytes"] += 1
        self.assertEqual(self.client.post("/v1/collections/artworks/prepare", headers=AUTH, json=request).status_code, 409)

    def test_missing_artwork_cannot_replace_previous_snapshot(self):
        revision = self.publish([work("old")]).json()["revision"]
        item, _ = self.with_art()
        self.assertEqual(self.publish([item], revision).status_code, 409)
        self.assertEqual(self.listing().json()["items"][0]["id"], "old")

    def test_public_detail_and_ticket_keep_artwork_out_of_assets(self):
        item, media = self.with_art()
        fake_s3.objects[media["objectKey"]] = {"body": b"image", "content_type": "image/webp"}
        self.assertEqual(self.publish([item]).status_code, 200)
        detail = self.client.get("/v1/collections/work", headers=AUTH).json()["item"]
        self.assertEqual(detail["volumes"][0]["editionIndex"], 1)
        self.assertTrue(detail["artworks"][0]["originalAvailable"])
        self.assertNotIn("objectKey", str(detail))
        self.assertNotIn("artworks", self.listing().json()["items"][0])
        ticket = self.client.post("/v1/collections/work/artworks/cover/media-ticket", headers=AUTH, json={"variant": "original"})
        self.assertEqual(ticket.status_code, 200)
        self.assertEqual(ticket.json()["size_bytes"], 5)
        self.assertNotIn("object_key", ticket.json())
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM assets").fetchone()[0], 0)
        self.assertEqual(self.client.post("/v1/collections/other/artworks/cover/media-ticket", headers=AUTH, json={"variant": "original"}).status_code, 404)

    def test_stale_publisher_and_stale_page_cannot_mix_snapshots(self):
        revision = self.publish([work("a"), work("b")]).json()["revision"]
        cursor = self.listing(limit=1).json()["nextCursor"]
        self.assertEqual(self.publish([work("c")], revision).status_code, 200)
        self.assertEqual(self.publish([work("d")], revision).status_code, 409)
        self.assertEqual(self.listing(limit=1, cursor=cursor).status_code, 409)
        self.assertEqual(self.listing().json()["items"][0]["id"], "c")

    def test_filters_literal_search_and_manual_showcase_order(self):
        first, second = work("a", "100%"), work("b", "100x", "game")
        first.update(showcase=True, showcaseOrder=2); second.update(showcase=True, showcaseOrder=1)
        self.publish([first, second, work("c", "normal", "movie")])
        self.assertEqual([i["id"] for i in self.listing(q="%").json()["items"]], ["a"])
        self.assertEqual([i["id"] for i in self.listing(showcase=True).json()["items"]], ["b", "a"])
        self.assertEqual([i["id"] for i in self.listing(type="movie").json()["items"]], ["c"])
        self.assertEqual(self.listing(limit=1).json()["totalCount"], 3)
        self.assertEqual(self.listing(limit=1, showcase=True).json()["totalCount"], 2)
        self.assertEqual(self.listing(type="movie").json()["totalCount"], 1)
        self.assertEqual(self.listing(q="%").json()["totalCount"], 1)
        self.assertEqual(self.listing(q="absent").json()["totalCount"], 0)
        cursor = self.listing(limit=1).json()["nextCursor"]
        self.assertEqual(self.listing(limit=1, cursor=cursor).json()["totalCount"], 3)
        self.assertEqual(self.listing(limit=1, q="other", cursor=cursor).status_code, 409)
        self.assertEqual(self.listing(cursor="malformed").status_code, 422)

    def test_reference_and_object_key_cannot_escape_collection(self):
        item, media = self.with_art()
        item["artworks"][0]["thumbnail"]["objectKey"] = "backups/library-metadata.sqlite"
        self.assertEqual(self.publish([item]).status_code, 422)
        self.assertEqual(self.publish([{**work(), "selectedWorkArtworkId": "absent"}]).status_code, 422)

    def test_rating_dates_and_pagination_apply_to_the_entire_library(self):
        items = [{**work(str(i), f"Work {i:02}"), "myScore": 4.5 if i % 2 else 0,
                  "createdAt": f"2026-09-{i+1:02}T00:00:00Z", "year": 2000+i} for i in range(20)]
        items += [{**work("unknown", "Unknown"), "year": None},
                  {**work("dated", "Dated"), "releaseDate": "2025-12-01", "year": 1999, "myScore": 4.5}]
        self.assertEqual(self.publish(items).status_code, 200)
        def ids(**params):
            return [i["id"] for i in self.listing(**params).json()["items"]]
        self.assertEqual(ids(rating="unrated"), ["unknown"])
        self.assertEqual(len(ids(rating="0")), 10)
        self.assertEqual(ids(sort="media_date", direction="desc")[0], "dated")
        self.assertEqual(ids(sort="media_date", direction="asc")[-1], "unknown")
        first = self.listing(sort="recent", direction="desc", rating="4.5", limit=2).json()
        self.assertEqual(first["filterVersion"], 1)
        self.assertEqual([i["id"] for i in first["items"]], ["19", "17"])
        second = self.listing(sort="recent", direction="desc", rating="4.5", limit=2, cursor=first["nextCursor"]).json()
        self.assertEqual([i["id"] for i in second["items"]], ["15", "13"])
        self.assertEqual(self.listing(sort="recent", direction="asc", rating="4.5", cursor=first["nextCursor"]).status_code, 409)
        self.assertEqual(self.listing(sort="recent", direction="desc", rating="0", cursor=first["nextCursor"]).status_code, 409)
        for params in ({"sort":"invalid"},{"direction":"bad"},{"rating":"4.6"},{"rating":"nan"},{"rating":"-1"}):
            self.assertEqual(self.listing(**params).status_code, 422)

    def test_showcase_keeps_manual_order_despite_library_filter_parameters(self):
        self.publish([{**work("a", "Zulu"), "showcase": True, "showcaseOrder": 0, "myScore": None},
                      {**work("b", "Alpha"), "showcase": True, "showcaseOrder": 1, "myScore": 5}])
        result = self.listing(showcase=True, sort="recent", direction="desc", rating="5").json()
        self.assertEqual([i["id"] for i in result["items"]], ["a", "b"])

    def test_unsupported_image_and_partial_descriptor_fail_validation(self):
        upload = {k: v for k, v in blob().items() if k != "objectKey"}
        upload["contentType"] = "text/html"
        self.assertEqual(self.client.post("/v1/collections/artworks/prepare", headers=AUTH, json=upload).status_code, 422)
        item, _ = self.with_art(); del item["artworks"][0]["thumbnail"]["sha256"]
        self.assertEqual(self.publish([item]).status_code, 422)

    def test_metadata_commit_reuses_verified_immutable_artwork_receipt(self):
        item, media = self.with_art()
        fake_s3.objects[media["objectKey"]] = {"body": b"image", "content_type": "image/webp"}
        self.client.post("/v1/collections/artworks/prepare", headers=AUTH, json={k: v for k, v in media.items() if k != "objectKey"})
        with mock.patch.object(fake_s3, "head_object", side_effect=AssertionError("unnecessary HEAD")):
            self.assertEqual(self.publish([item]).status_code, 200)

    def test_storage_outage_does_not_publish_partial_metadata(self):
        revision = self.publish([work("old")]).json()["revision"]
        item, _ = self.with_art()
        with mock.patch.object(fake_s3, "head_object", side_effect=RuntimeError("private storage details")):
            result = self.publish([item], revision)
        self.assertEqual(result.status_code, 502)
        self.assertNotIn("private storage details", result.text)
        self.assertEqual(self.listing().json()["revision"], revision)


if __name__ == "__main__":
    unittest.main()
