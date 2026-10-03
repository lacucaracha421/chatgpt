"""Incremental effective tag publication, search scopes and whole-walk TOCs."""
import hashlib
import conditional
import sqlite3
import unittest

from pydantic import ValidationError

from tests.test_capture_api_stub import fake_s3  # Installs offline R2 stub before app import.
import app as api_app
import asset_authority
import classification_authority
import authority
import asset_filters
import library_artists
import library_search as search
from tests.test_home_upcoming import HomeFixture
from tests.test_library_artists import artist, snapshot
from tests import test_asset_list_toc as toc_fixture


def tag(id="long_hair", label="긴 머리", category="general"):
    return {"id": id, "label": label, "category": category}


def upload(assets=None, vocabulary=None):
    return {"version": 1, "vocabulary": [tag()] if vocabulary is None else vocabulary,
            "assets": [{"assetId": "asset-1", "tags": ["long_hair"], "creatorKey": "alice"}]
            if assets is None else assets}


class CreatorFilterTests(unittest.TestCase):
    def test_published_null_suppresses_only_the_legacy_creator_fallback(self):
        with sqlite3.connect(":memory:") as db:
            db.executescript(search.DDL + library_artists.DDL)
            db.execute("CREATE TABLE assets(id TEXT PRIMARY KEY, creator_handle TEXT)")
            db.executemany("INSERT INTO assets VALUES(?, 'alice')",
                           [(id,) for id in ("cleared", "unpublished", "published", "assigned", "reassigned")])
            db.executemany("INSERT INTO library_artist_keys VALUES(?,?)",
                           [("alice", "artist:a1"), ("bob", "artist:other")])
            db.executemany("INSERT INTO library_tag_assets VALUES(?, 'digest', ?)",
                           [("cleared", None), ("published", "bob"), ("assigned", None)])
            db.executemany("INSERT INTO library_artist_assignments VALUES(?, ?)",
                           [("assigned", "artist:a1"), ("reassigned", "artist:other")])
            clause, params = asset_filters.filter_clause(asset_filters.Filters(artist="artist:a1"))
            matched = {row[0] for row in db.execute("SELECT asset.id FROM assets asset WHERE 1" + clause, params)}
            self.assertEqual(matched, {"unpublished", "assigned"})


class PublicationTests(HomeFixture):
    module = search

    def put(self, body, headers=None):
        return self.client.put(search.PREFIX, headers=headers or self.publisher, json=body)

    def test_rating_v2_storage_idempotency_validation_and_legacy_clear(self):
        body = upload([{"assetId": "asset-1", "tags": [], "contentRating": "g"}], [])
        body["version"] = 2
        first = self.ok(self.put(body))
        self.assertEqual(first["version"], 2)
        self.assertFalse(self.ok(self.put(body))["changed"])
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT content_rating FROM library_asset_ratings").fetchone()[0], "g")
        body["assets"][0]["contentRating"] = "e"
        changed = self.ok(self.put(body))
        self.assertEqual(changed["revision"], first["revision"] + 1)
        body["assets"][0]["contentRating"] = "invalid"
        self.assertEqual(self.put(body).status_code, 422)
        old = self.ok(self.put(upload([{"assetId": "asset-1", "tags": []}], [])))
        self.assertEqual(old["version"], 1)
        with self.get_db() as db:
            self.assertIsNone(db.execute("SELECT content_rating FROM library_asset_ratings").fetchone()[0])
        self.assertFalse(self.ok(self.put(upload([{"assetId": "asset-1", "tags": []}], [])))["changed"])

    def test_identical_legacy_v1_retry_after_upgrade_keeps_revision_and_relations(self):
        first = self.ok(self.put(upload()))
        legacy_digest = hashlib.sha256(conditional.encode(["alice", ["long_hair"]])).hexdigest()
        with self.get_db() as db:
            db.execute("UPDATE library_tag_assets SET digest=?", [legacy_digest])
            db.execute("DELETE FROM library_asset_ratings")
            db.execute("CREATE TRIGGER reject_relation_rewrite BEFORE DELETE ON library_asset_tags "
                       "BEGIN SELECT RAISE(ABORT,'unchanged retry must preserve relations'); END")
            db.commit()
        retry = self.ok(self.put(upload()))
        self.assertFalse(retry["changed"])
        self.assertEqual(retry["revision"], first["revision"])
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT digest FROM library_tag_assets").fetchone()[0], legacy_digest)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM library_asset_ratings").fetchone()[0], 0)

    def test_first_incremental_replace_and_lost_response_retry(self):
        first = self.ok(self.put(upload()))
        self.assertEqual((first["revision"], first["changed"]), (1, True))
        retry = self.ok(self.put(upload()))
        self.assertEqual((retry["revision"], retry["changed"]), (1, False))
        self.ok(self.put(upload([{"assetId": "asset-2", "tags": ["long_hair"]}], [])))
        self.ok(self.put(upload([{"assetId": "asset-1", "tags": []}], [])))
        with self.get_db() as db:
            rows = [tuple(row) for row in db.execute("SELECT asset_id,tag_id FROM library_asset_tags")]
        self.assertEqual(rows, [("asset-2", "long_hair")])
        changed = self.ok(self.put(upload([], [tag(label="긴머리")])) )
        self.assertTrue(changed["changed"])
        self.assertEqual(changed["revision"], 4)

    def test_exact_per_asset_tag_validation_limit(self):
        row = {"assetId": "a", "tags": [f"tag-{i}" for i in range(1000)]}
        self.assertEqual(len(search.Asset.model_validate(row).tags), 1000)
        with self.assertRaises(ValidationError):
            search.Asset.model_validate({**row, "tags": row["tags"] + ["extra"]})

    def test_auth_and_validation_are_atomic(self):
        self.assertEqual(self.put(upload(), self.auth).status_code, 401)
        self.assertEqual(self.client.put(search.PREFIX, json=upload()).status_code, 401)
        for body in (upload(assets=[{"assetId": "a", "tags": ["unknown"]}]),
                     upload(assets=[{"assetId": "a", "tags": ["long_hair", "long_hair"]}]),
                     upload(vocabulary=[tag(), tag()]),
                     {**upload(), "extra": True}):
            self.assertEqual(self.put(body).status_code, 422)
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM library_tag_vocabulary").fetchone()[0], 0)
        self.assertEqual(self.client.put(search.PREFIX, headers=self.publisher,
                                        content=b"x" * (search.MAX_BODY_BYTES + 1)).status_code, 413)
        self.assertEqual(self.put(upload(assets=[{"assetId": f"a-{i}", "tags": []}
                                                for i in range(101)])).status_code, 422)


class SearchFilterTests(unittest.TestCase):
    tearDown = toc_fixture.AssetListTocTests.tearDown
    read = toc_fixture.AssetListTocTests.read
    walk = toc_fixture.AssetListTocTests.walk

    def setUp(self):
        toc_fixture.AssetListTocTests.setUp(self)
        asset_authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            search.startup_db(db)
            library_artists.startup_db(db)
            for index, id in enumerate(self.assets):
                db.execute("UPDATE assets SET creator_handle=? WHERE id=?",
                           [("alice", "bob", "other", None)[index % 4], id])
                if index % 3 == 0:
                    db.execute("INSERT INTO asset_classifications VALUES(?,?,?)", [id, "second", "t"])
            db.commit()
        ids = list(self.assets)
        artists = snapshot(items=[artist(keys=["alice", "bob", "https://artist.test/alice"]),
                                  artist("artist:other", keys=["other"])], assignments=[
            {"assetId": ids[0], "artistId": "artist:other", "source": "manual"},
            {"assetId": ids[2], "artistId": "artist:a1", "source": "manual"}])
        response = self.client.put("/v1/library/artists", headers=self.publisher, json=artists)
        self.assertEqual(response.status_code, 200, response.text)
        rows = [{"assetId": id,
                 "creatorKey": ("alice", "bob", "other", "https://artist.test/alice")[i % 4],
                 "tags": (["long_hair"] if i % 2 == 0 else []) + (["glasses"] if i % 3 == 0 else [])}
                for i, id in enumerate(ids)]
        rows += [{"assetId": "uncommitted", "tags": ["long_hair"]},
                 {"assetId": "missing", "tags": ["long_hair"]}]
        response = self.client.put(search.PREFIX, headers=self.publisher,
                                   json=upload(rows, [tag(), tag("glasses", "안경")]))
        self.assertEqual(response.status_code, 200, response.text)

    def test_rating_payloads_are_live_for_library_album_and_character_pages(self):
        ids = list(self.assets)
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET kind='image' WHERE id=?", [ids[1]])
            db.commit()
        body = upload([{"assetId": ids[0], "tags": [], "contentRating": "g"},
                       {"assetId": ids[1], "tags": [], "contentRating": "q"}], [])
        body["version"] = 2
        self.assertEqual(self.client.put(search.PREFIX, headers=self.publisher, json=body).status_code, 200)
        for scope in ("library", "album"):
            response = self.read(scope, limit=100)
            self.assertEqual(response.status_code, 200, response.text)
            items = {item["id"]: item for item in response.json()["items"]}
            self.assertEqual(items[ids[0]]["contentRating"], "g")
            self.assertEqual(items[ids[1]]["contentRating"], "q")
            self.assertIsNone(items[ids[3]]["contentRating"])

        api_app.startup_mobile_characters()
        from tests import test_asset_filters as character_fixture
        revision = character_fixture.AssetFilterTests.publish_characters(self, ids)
        for sort in ("published", "newest"):
            response = self.client.get("/v1/library/characters/assets", headers=self.auth,
                params={"node": "character:c", "revision": revision, "limit": 100, "sort": sort})
            self.assertEqual(response.status_code, 200, response.text)
            items = {item["id"]: item for item in response.json()["items"]}
            self.assertEqual(items[ids[0]]["contentRating"], "g")
            self.assertEqual(items[ids[1]]["contentRating"], "q")
            self.assertIsNone(items[ids[3]]["contentRating"])

    def test_video_with_safe_publication_rating_stays_unknown_on_all_pages(self):
        ids = list(self.assets)
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET kind='video' WHERE id=?", [ids[0]])
            db.commit()
        body = upload([{"assetId": ids[0], "tags": [], "contentRating": "g"}], [])
        body["version"] = 2
        self.assertEqual(self.client.put(search.PREFIX, headers=self.publisher, json=body).status_code, 200)
        for scope in ("library", "album"):
            response = self.read(scope, limit=100)
            self.assertEqual(response.status_code, 200, response.text)
            item = next(item for item in response.json()["items"] if item["id"] == ids[0])
            self.assertIsNone(item["contentRating"])

    def test_artist_and_character_cover_ratings_read_current_publication(self):
        ids = list(self.assets)
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET kind='image' WHERE id=?", [ids[1]])
            db.commit()
        body = upload([{"assetId": ids[0], "tags": [], "contentRating": "g"},
                       {"assetId": ids[1], "tags": [], "contentRating": "e"}], [])
        body["version"] = 2
        self.assertEqual(self.client.put(search.PREFIX, headers=self.publisher, json=body).status_code, 200)
        self.assertEqual(self.client.put("/v1/library/artists", headers=self.publisher,
            json=snapshot(items=[artist(coverAssetIds=ids[:3])], assignments=[])).status_code, 200)
        reply = self.client.get("/v1/library/artists", headers=self.client_auth).json()
        self.assertEqual(reply["artists"][0]["coverContentRatings"], {ids[0]: "g", ids[1]: "e", ids[2]: None})
        api_app.startup_mobile_characters()
        from tests import test_asset_filters as character_fixture
        revision = character_fixture.AssetFilterTests.publish_characters(self, ids)
        with api_app.get_db() as db:
            current = db.execute("SELECT index_json FROM mobile_character_state").fetchone()[0]
            import json
            index = json.loads(current)
            index["nodes"][0]["thumbnailAssetId"] = ids[0]
            index["nodes"][1]["thumbnailAssetId"] = ids[1]
            db.execute("UPDATE mobile_character_state SET index_json=?", [json.dumps(index)])
            db.commit()
        index = self.client.get("/v1/library/characters", headers=self.auth).json()
        self.assertEqual(index["contentRatings"], {ids[0]: "g", ids[1]: "e"})

    def test_explicit_creator_clear_does_not_restore_replicated_handle(self):
        ids = list(self.assets)
        cleared, unpublished, assigned = ids[1], ids[4], ids[2]
        response = self.client.put(search.PREFIX, headers=self.publisher, json=upload([
            {"assetId": cleared, "creatorKey": None, "tags": []},
            {"assetId": assigned, "creatorKey": None, "tags": []},
        ], []))
        self.assertEqual(response.status_code, 200, response.text)
        with api_app.get_db() as db:
            db.execute("DELETE FROM library_tag_assets WHERE asset_id=?", [unpublished])
            db.commit()
        rows, _ = self.walk("library", artist="artist:a1")
        matched = {row["id"] for row in rows}
        self.assertNotIn(cleared, matched)
        self.assertIn(unpublished, matched, "Unpublished assets retain the legacy fallback")
        self.assertIn(assigned, matched, "Explicit artist assignments still take precedence")
        self.assertEqual(self.read("library", artist="artist:a1", toc=1).json()["totalCount"],
                         len(matched))

    def test_each_filter_and_combination_pagination_and_toc(self):
        combos = [({"tag": ["long_hair"]}, lambda i: i % 2 == 0),
                  ({"tag": ["long_hair", "glasses"]}, lambda i: i % 6 == 0),
                  ({"artist": "artist:a1"}, lambda i: (i % 4 != 2 and i != 0) or i == 2),
                  ({"classification_id": [toc_fixture.CLASSIFICATION, "second"]}, lambda i: i % 6 == 0),
                  ({"tag": ["long_hair", "glasses"], "artist": "artist:a1",
                    "classification_id": [toc_fixture.CLASSIFICATION, "second"], "media_kind": "images"},
                   lambda i: i % 6 == 0 and i != 0 and i % 4 != 2)]
        for sort in ("newest", "oldest"):
            for params, matches in combos:
                with self.subTest(sort=sort, params=params):
                    walked, _ = self.walk("library", sort=sort, **params)
                    expected = [id for i, id in enumerate(self.assets) if matches(i)]
                    expected.sort(key=lambda id: (self.assets[id]["date"], id), reverse=sort == "newest")
                    self.assertEqual([row["id"] for row in walked], expected)
                    response = self.read("library", sort=sort, toc=1, **params)
                    self.assertEqual(response.status_code, 200, response.text)
                    toc = response.json()
                    self.assertEqual(toc["totalCount"], len(expected))
                    for bucket in toc["buckets"]:
                        query = {"limit": 100, "sort": sort, **params}
                        if bucket["startCursor"]:
                            query["cursor"] = bucket["startCursor"]
                        page = self.read("library", **query).json()
                        self.assertEqual([row["id"] for row in page["items"]], expected[bucket["startIndex"]:])

    def test_cursor_etag_and_generation_bind_search(self):
        page = self.read("library", tag=["long_hair"], limit=1).json()
        self.assertEqual(page["searchVersion"], 1)
        cursor = page["next_cursor"]
        self.assertTrue(cursor)
        for params in ({"tag": ["glasses"]}, {"artist": "artist:a1"}, {}):
            self.assertEqual(self.read("library", cursor=cursor, **params).status_code, 400)
        page = self.read("library", classification_id=[toc_fixture.CLASSIFICATION, "second"], limit=1).json()
        self.assertEqual(self.read("library", classification_id=["second"], cursor=page["next_cursor"]).status_code, 400)
        legacy = api_app.encode_mobile_cursor("newest", "2019-01-01", "a")
        self.assertEqual(self.read("library", classification_id=["first", "second"], cursor=legacy).status_code, 400)
        for toc in (0, 1):
            first = self.read("library", tag=["missing-a"], toc=toc)
            second = self.read("library", tag=["missing-b"], toc=toc, headers={"If-None-Match": first.headers["etag"]})
            self.assertEqual(second.status_code, 200)
        before = self.read("library").json()["listGeneration"]
        self.client.put(search.PREFIX, headers=self.publisher, json=upload([], [tag(label="긴머리")]))
        self.assertNotEqual(before, self.read("library").json()["listGeneration"])
        before = self.read("library").json()["listGeneration"]
        self.client.put("/v1/library/artists", headers=self.publisher, json=snapshot(items=[], assignments=[]))
        self.assertNotEqual(before, self.read("library").json()["listGeneration"])

    def test_album_and_character_use_the_same_search_predicates(self):
        params = {"tag": ["long_hair"], "artist": "artist:a1"}
        all_items, _ = self.walk("library", **params)
        expected = [row["id"] for row in all_items if self.assets[row["id"]]["album"]]
        album_items, _ = self.walk("album", **params)
        self.assertEqual([row["id"] for row in album_items], expected)
        self.assertEqual(self.read("album", toc=1, **params).json()["totalCount"], len(expected))
        api_app.startup_mobile_characters()
        ids = list(self.assets)
        # Reuse the existing fixture's exact replica shape.
        from tests import test_asset_filters as character_fixture
        revision = character_fixture.AssetFilterTests.publish_characters(self, ids)
        rows, cursor = [], None
        for _ in range(30):
            response = self.client.get("/v1/library/characters/assets", headers=self.auth,
                                       params={"node": "character:c", "revision": revision, "limit": 2,
                                               **params, **({"cursor": cursor} if cursor else {})})
            self.assertEqual(response.status_code, 200, response.text)
            result = response.json()
            rows.extend(row["id"] for row in result["items"])
            self.assertEqual(result["totalCount"], len(all_items))
            cursor = result["next_cursor"]
            if not result["has_more"]:
                break
        self.assertEqual(rows, [id for id in ids if id in {row["id"] for row in all_items}])

    def test_repeated_classifications_under_active_single_assignment_authority(self):
        classification_authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            db.execute("INSERT INTO authority_domains(library_id,domain,epoch,contract_version,change_cursor,baseline_digest,activated_at) VALUES(?,?,1,1,0,'test','now')",
                       [toc_fixture.LIBRARY, "classifications"])
            for id in self.assets:
                db.execute("INSERT INTO classification_authority_assignments VALUES(?,?,?,1,'t','t')",
                           [toc_fixture.LIBRARY, id, toc_fixture.CLASSIFICATION])
            db.commit()
        response = self.read("library", classification_id=[toc_fixture.CLASSIFICATION, "second"], tag=["long_hair"], artist="artist:a1", toc=1)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["totalCount"], 0)
        rows, _ = self.walk("library", classification_id=[toc_fixture.CLASSIFICATION], tag=["long_hair"])
        self.assertEqual(len(rows), 7)

    def test_maintained_counts_follow_visibility_and_transaction_rollback(self):
        def check(db):
            expected = dict(db.execute("SELECT t.tag_id,COUNT(*) FROM library_asset_tags t "
                                      "JOIN visible_assets a ON a.id=t.asset_id WHERE a.committed=1 GROUP BY t.tag_id"))
            actual = dict(db.execute("SELECT tag_id,count FROM library_tag_counts WHERE count>0"))
            self.assertEqual(actual, expected)
            self.assertFalse(db.execute("SELECT 1 FROM library_tag_counts WHERE count<0").fetchone())

        with api_app.get_db() as db:
            check(db)
            id = list(self.assets)[0]
            db.execute("UPDATE assets SET committed=0 WHERE id=?", [id])
            check(db)
            db.rollback()
            check(db)
            db.execute("DELETE FROM assets WHERE id=?", [id])
            check(db)
            db.rollback()
            db.execute("INSERT INTO assets(id,kind,object_key,created_at,updated_at,committed) "
                       "VALUES('missing','image','key','t','t',0)")
            check(db)
            db.execute("UPDATE assets SET committed=1 WHERE id='missing'")
            check(db)
            db.execute("INSERT INTO authority_domains(library_id,domain,epoch,contract_version,change_cursor,baseline_digest,activated_at) "
                       "VALUES('count-test','assets',1,1,0,'digest','t')")
            check(db)  # Activation fails closed for every missing canonical row.
            db.execute("INSERT INTO asset_authority_state(library_id,asset_id,lifecycle,entity_revision,created_at,updated_at) "
                       "VALUES('count-test',?,'normal',1,'t','t')", [id])
            check(db)
            db.execute("UPDATE asset_authority_state SET lifecycle='trash' WHERE asset_id=?", [id])
            check(db)
            db.execute("UPDATE asset_authority_state SET lifecycle='normal' WHERE asset_id=?", [id])
            check(db)
            db.execute("DELETE FROM asset_authority_state WHERE asset_id=?", [id])
            check(db)
            db.execute("DELETE FROM authority_domains WHERE domain='assets'")
            check(db)
            db.execute("DELETE FROM library_asset_tags WHERE asset_id=?", [id])
            check(db)
            db.rollback()
            check(db)

    def test_suggestions_counts_ranking_cap_and_hidden_assets(self):
        route = "/v1/library/search/suggestions"
        self.assertEqual(self.client.get(route).status_code, 401)
        self.assertEqual(self.client.get(route, headers=self.client_auth, params={"limit": 21}).status_code, 422)
        result = self.client.get(route, headers=self.client_auth).json()["items"]
        self.assertEqual([(row["id"], row["count"]) for row in result], [("long_hair", 7), ("glasses", 5)])
        for text in ("긴 머리", "long hair", "ㄱㅁㄹ"):
            self.assertEqual(self.client.get(route, headers=self.client_auth, params={"text": text}).json()["items"][0]["id"], "long_hair")
        tags = [tag(f"tag-{i}", f"label-{i}") for i in range(30)]
        self.client.put(search.PREFIX, headers=self.publisher, json=upload(
            [{"assetId": list(self.assets)[1], "tags": [row["id"] for row in tags]}], tags))
        self.assertEqual(len(self.client.get(route, headers=self.client_auth, params={"limit": 20}).json()["items"]), 20)
        result = self.client.get(route, headers=self.client_auth, params={"text": "tag-2"}).json()["items"]
        self.assertEqual(result[0]["id"], "tag-2")
        # Active Asset authority fails closed for absent/trashed/tombstoned canonical rows.
        asset_authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            identity, inventory = asset_authority.current_inventory(db)
            staged = asset_authority.stage_baseline(db, library_id=toc_fixture.LIBRARY,
                expected_inventory=inventory,
                rows=[{"assetId": id, "lifecycle": "normal", "sha256": sha} for id, sha in identity], now="now")
            asset_authority.activate(db, library_id=toc_fixture.LIBRARY,
                                     expected_snapshot=staged["snapshotDigest"], now="now")
            ids = list(self.assets)
            db.execute("UPDATE asset_authority_state SET lifecycle='trash' WHERE asset_id=?", [ids[0]])
            db.execute("UPDATE asset_authority_state SET lifecycle='tombstoned' WHERE asset_id=?", [ids[1]])
            db.execute("DELETE FROM asset_authority_state WHERE asset_id=?", [ids[6]])
            db.commit()
        visible = self.client.get(route, headers=self.client_auth).json()["items"]
        counts = {row["id"]: row["count"] for row in visible}
        self.assertEqual(counts["long_hair"], 5)
        self.assertEqual(counts["glasses"], 3)
        self.assertFalse(any(row["id"].startswith("tag-") for row in visible))
        filtered, _ = self.walk("library", tag=["long_hair"])
        self.assertEqual(len(filtered), 5)
        self.assertEqual(self.read("library", tag=["long_hair"], toc=1).json()["totalCount"], 5)


if __name__ == "__main__":
    unittest.main()
