"""Date-sorted character TOCs agree with complete walks of published membership."""
import unittest
from unittest.mock import patch

from tests import test_asset_list_toc as toc_tests
import asset_list_query
import app as api_app


class CharacterAssetTocTests(unittest.TestCase):
    tearDown = toc_tests.AssetListTocTests.tearDown
    walk = toc_tests.AssetListTocTests.walk
    assert_toc = toc_tests.AssetListTocTests.assert_toc

    def setUp(self):
        toc_tests.AssetListTocTests.setUp(self)
        api_app.startup_mobile_characters()
        ids = list(reversed(self.assets)) + ["missing", "uncommitted"]
        body = {"version": 1, "baseRevision": None,
                "nodes": [{"id": "series:s", "kind": "series", "sourceId": "s",
                           "seriesId": "s", "parentId": None, "name": "Series"}] +
                         [{"id": f"character:{id}", "kind": "character", "sourceId": id,
                           "seriesId": "s", "parentId": "series:s", "name": id}
                          for id in ("c", "empty")],
                "scopes": [{"nodeId": "series:s", "filter": filter, "assetIds": ids if filter == "all" else []}
                           for filter in ("all", "unclassified", "needs_review")] +
                          [{"nodeId": "character:c", "filter": "all", "assetIds": ids},
                           {"nodeId": "character:empty", "filter": "all", "assetIds": []}]}
        response = self.client.put("/v1/library/characters/replica", headers=self.auth, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.revision = response.json()["revision"]

    def read(self, scope="character", *, headers=None, **params):
        return self.client.get("/v1/library/characters/assets", headers={**self.auth, **(headers or {})},
                               params={"node": "character:c", "revision": self.revision, **params})

    def expected(self, scope, sort, filters):
        return toc_tests.AssetListTocTests.expected(self, "library", sort, filters)

    def test_full_walk_filters_and_every_bucket_seek_in_both_orders(self):
        for sort in ("newest", "oldest"):
            for filters in ({}, {"media_kind": "images"}, {"media_kind": "videos"},
                            {"aspect_ratio": "portrait"}, {"aspect_ratio": "square"},
                            {"duration_ms_min": 1000, "duration_ms_max": 10000}):
                with self.subTest(sort=sort, filters=filters):
                    self.assert_toc("character", sort, **filters)

    def test_timezone_edges_and_created_at_fallback(self):
        ids = list(self.assets)
        with api_app.get_db() as db:
            for id, date in ((ids[0], "2026-09-30T14:59:59.999999Z"),
                             (ids[-1], "2026-09-30T15:00:00Z")):
                self.assets[id]["date"] = date
                db.execute("UPDATE assets SET created_at=?,collected_at=CASE WHEN collected_at IS NULL THEN NULL ELSE ? END WHERE id=?",
                           [date, date, id])
            db.commit()
        for sort in ("newest", "oldest"):
            for offset in (-720, 0, 540, 840):
                self.assert_toc("character", sort, utc_offset_minutes=offset)

    def test_tag_and_merged_artist_filters_match_walk_and_bucket_seeks(self):
        from tests.test_library_artists import artist, snapshot
        from tests.test_library_search import upload, tag
        import library_artists
        import library_search
        ids = list(self.assets)
        with api_app.get_db() as db:
            library_artists.startup_db(db)
            library_search.startup_db(db)
            db.commit()
        response = self.client.put("/v1/library/artists", headers=self.publisher, json=snapshot(
            items=[artist(keys=["alice", "bob"])],
            assignments=[{"assetId": ids[2], "artistId": "artist:a1", "source": "manual"}]))
        self.assertEqual(response.status_code, 200, response.text)
        response = self.client.put(library_search.PREFIX, headers=self.publisher, json=upload(
            [{"assetId": id, "creatorKey": ("alice", "bob", "other")[i % 3],
              "tags": ["long_hair"] if i % 2 == 0 else []} for i, id in enumerate(ids)], [tag()]))
        self.assertEqual(response.status_code, 200, response.text)
        filters = {"artist": "artist:a1", "tag": "long_hair"}
        for sort in ("newest", "oldest"):
            items, generation = self.walk("character", sort=sort, **filters)
            expected = [id for i, id in enumerate(ids) if i % 2 == 0 and (i % 3 != 2 or i == 2)]
            expected.sort(key=lambda id: (self.assets[id]["date"], id), reverse=sort == "newest")
            self.assertEqual([item["id"] for item in items], expected)
            toc = self.read(sort=sort, toc=1, **filters).json()
            self.assertEqual((toc["totalCount"], toc["listGeneration"]), (len(expected), generation))
            for bucket in toc["buckets"]:
                params = {"cursor": bucket["startCursor"]} if bucket["startCursor"] else {}
                result = self.read(sort=sort, limit=2, **filters, **params)
                self.assertEqual(result.status_code, 200, result.text)
                self.assertEqual([item["id"] for item in result.json()["items"]], expected[bucket["startIndex"]:bucket["startIndex"] + 2])
            cursor = next(bucket["startCursor"] for bucket in toc["buckets"] if bucket["startCursor"])
            self.assertEqual(self.read(sort=sort, cursor=cursor, artist="artist:a1").status_code, 400)

    def test_retired_and_missing_canonical_members_are_absent_from_walk_and_toc(self):
        import asset_authority
        asset_authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            identity, inventory = asset_authority.current_inventory(db)
            staged = asset_authority.stage_baseline(db, library_id="a" * 32, expected_inventory=inventory,
                rows=[{"assetId": id, "lifecycle": asset_authority.NORMAL, "sha256": sha} for id, sha in identity], now="now")
            asset_authority.activate(db, library_id="a" * 32, expected_snapshot=staged["snapshotDigest"], now="now")
            ids = list(self.assets)
            for id, lifecycle in zip(ids[:2], ("trash", "tombstoned")):
                db.execute("UPDATE asset_authority_state SET lifecycle=? WHERE asset_id=?", [lifecycle, id])
            db.execute("DELETE FROM asset_authority_state WHERE asset_id=?", [ids[3]])
            db.commit()
        for id in (ids[0], ids[1], ids[3]):
            del self.assets[id]
        for sort in ("newest", "oldest"):
            self.assert_toc("character", sort)

    def test_published_default_is_unchanged_and_cursors_cannot_cross_modes(self):
        default = self.read(limit=2).json()
        self.assertEqual([item["id"] for item in default["items"]], list(reversed(self.assets))[:2])
        self.assertEqual(self.read(sort="published", limit=2).json(), default)
        self.assertEqual(self.read(sort="newest", cursor=default["next_cursor"]).status_code, 400)
        cursor = self.read(sort="newest", toc=1).json()["buckets"][1]["startCursor"]
        for params in ({}, {"sort": "oldest"}, {"sort": "newest", "media_kind": "videos"},
                       {"sort": "newest", "node": "series:s"},
                       {"sort": "newest", "filter": "unclassified"},
                       {"sort": "newest", "revision": "b" * 64}):
            self.assertEqual(self.read(cursor=cursor, **params).status_code, 400)

    def test_validation_empty_scopes_and_conditional_responses(self):
        for params, status in (({"toc": 1}, 422), ({"sort": "name"}, 422),
                               ({"sort": "newest", "toc": 2}, 422),
                               ({"sort": "newest", "toc": 1, "cursor": ""}, 400),
                               ({"sort": "newest", "toc": 1, "utcOffsetMinutes": "1.5"}, 422),
                               ({"sort": "newest", "toc": 1, "utcOffsetMinutes": 841}, 422)):
            self.assertEqual(self.read(**params).status_code, status)
        self.assertEqual(self.read(sort="newest", utcOffsetMinutes="ignored").status_code, 200)
        for params in ({"node": "character:empty"}, {"duration_ms_min": 999999}):
            toc = self.read(sort="newest", toc=1, **params).json()
            self.assertEqual((toc["totalCount"], toc["buckets"]), (0, []))
        self.assertEqual(self.read(sort="newest", toc=1, node="character:missing").status_code, 404)
        self.assertEqual(self.read(sort="newest", toc=1, revision="b" * 64).status_code, 409)
        self.assertEqual(self.read(sort="newest", toc=1, headers={"Authorization": "Bearer invalid"}).status_code, 401)
        for toc in (0, 1):
            first = self.read(sort="newest", toc=toc)
            cached = self.read(sort="newest", toc=toc, headers={"If-None-Match": f'W/{first.headers["ETag"]}'})
            self.assertEqual(cached.status_code, 304)
            self.assertEqual(cached.content, b"")
            self.assertEqual(cached.headers["Cache-Control"], "private, no-cache")
        one = self.read(sort="newest", toc=1, utcOffsetMinutes=1)
        two = self.read(sort="newest", toc=1, utcOffsetMinutes=2)
        self.assertEqual(one.json()["buckets"], two.json()["buckets"])
        self.assertNotEqual(one.headers["ETag"], two.headers["ETag"])

    def test_live_visibility_and_dates_change_generation_without_republication(self):
        before = self.read(sort="newest", toc=1)
        id = list(self.assets)[0]
        with api_app.get_db() as db:
            db.execute("INSERT INTO mobile_character_hidden_members VALUES('character:c','all',?)", [id])
            db.commit()
        del self.assets[id]
        toc = self.assert_toc("character")
        self.assertNotEqual(toc["listGeneration"], before.json()["listGeneration"])
        self.assertEqual(self.read(sort="newest").json()["sourceCount"], self.read().json()["sourceCount"])
        before = self.read(sort="newest", toc=1)
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET collected_at='2020-01-01T00:00:00Z' WHERE id=?", [list(self.assets)[0]])
            db.commit()
        after = self.read(sort="newest", toc=1, headers={"If-None-Match": before.headers["ETag"]})
        self.assertEqual(after.status_code, 200)
        self.assertNotEqual(after.json()["listGeneration"], before.json()["listGeneration"])

    def test_toc_and_generation_share_snapshot_during_write(self):
        before = self.read(sort="newest", toc=1).json()
        original = asset_list_query.AssetListQuery.toc

        def mutate(query, db, generation, encode_cursor, utc_offset_minutes=0):
            self.assertTrue(db.in_transaction)
            with api_app.get_db() as writer:
                writer.execute("UPDATE assets SET collected_at='2020-01-01T00:00:00Z' WHERE id=?", [list(self.assets)[0]])
                writer.commit()
            return original(query, db, generation, encode_cursor, utc_offset_minutes)

        with patch.object(asset_list_query.AssetListQuery, "toc", mutate):
            response = self.read(sort="newest", toc=1)
        self.assertEqual(response.json(), before)
        self.assertNotEqual(self.read(sort="newest", toc=1).json()["listGeneration"], before["listGeneration"])


if __name__ == "__main__":
    unittest.main()
