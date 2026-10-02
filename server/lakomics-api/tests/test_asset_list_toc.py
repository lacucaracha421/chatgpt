"""Month TOCs use the same scope, filters, ordering and snapshot as Asset pages."""
import base64
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.test_capture_api_stub import fake_s3  # noqa: E402
import album_authority  # noqa: E402
import api_auth  # noqa: E402
import asset_authority  # noqa: E402
import asset_list_query  # noqa: E402
import authority  # noqa: E402
import classification_authority  # noqa: E402
import app as api_app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

LIBRARY = "a" * 32
CLASSIFICATION = "10000000-0000-4000-8000-000000000001"
ALBUM = "root"
DATES = [
    "2019-01-31T23:59:59.999999Z", "2019-01-31T23:59:59.999999Z",
    "2019-02-01T00:00:00Z", "2019-02-01T00:00:00Z", "2019-02-01T00:00:00Z",
    "2019-02-28T23:59:59+00:00", "2019-02-28T23:59:59+00:00",
    "2019-03-01T00:00:00.000Z", "2019-03-01T00:00:00.000Z", "2019-03-01T00:00:00.000Z",
    "2019-03-31T23:59:59.999999Z", "2019-03-31T23:59:59.999999Z",
    "2019-04-01T00:00:00Z", "2019-04-01T00:00:00Z",
]


class AssetListTocTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original = api_app.DB_PATH, api_app.API_TOKEN
        api_app.DB_PATH = Path(self.temp.name) / "toc.sqlite3"
        api_app.API_TOKEN = "toc-token"
        api_app.startup()
        api_app.startup_replication()
        api_app.startup_classifications()
        api_app.startup_album_replica()
        authority.startup(api_app.get_db)
        album_authority.startup(api_app.get_db)
        self.client = TestClient(api_app.app)
        self.auth = {"Authorization": "Bearer toc-token"}
        self.assets = {}
        with api_app.get_db() as db:
            api_auth.startup(api_app.get_db)
            _, publisher = api_auth.provision_token(db, "publisher", "toc")
            _, client = api_auth.provision_token(db, "client", "toc")
            for index, date in enumerate(DATES):
                asset_id = f"70000000-0000-4000-8000-{index + 1:012d}"
                kind = ("image", "video", "gif")[index % 3]
                width, height = ((1000, 1000), (1600, 1000), (1000, 1600))[index % 3]
                duration = index * 1000 if kind == "video" else None
                if index == 7:
                    width = height = duration = None
                collected = None if index == 13 else date
                self.assets[asset_id] = {"date": date, "kind": kind, "width": width,
                                         "height": height, "duration": duration,
                                         "classified": index % 2 == 0,
                                         "album": index not in (2, 6, 10)}
                db.execute(
                    "INSERT INTO assets(id,kind,object_key,content_type,size_bytes,created_at,"
                    "updated_at,collected_at,committed,width,height,duration_ms)"
                    " VALUES(?,?,?,'image/png',17,?,?,?,1,?,?,?)",
                    [asset_id, kind, f"objects/{asset_id}", date, date, collected,
                     width, height, duration])
                if index % 2 == 0:
                    db.execute("INSERT INTO asset_classifications VALUES(?,?,?)",
                               [asset_id, CLASSIFICATION, date])
            db.execute("INSERT INTO assets(id,kind,object_key,content_type,size_bytes,"
                       "created_at,updated_at,collected_at,committed)"
                       " VALUES('uncommitted','image','objects/u','image/png',17,?,?,?,0)",
                       [DATES[-1]] * 3)
            db.commit()
        self.publisher = {"Authorization": f"Bearer {publisher}"}
        self.client_auth = {"Authorization": f"Bearer {client}"}
        published = self.client.put("/v1/library/album-snapshot", headers=self.auth, json={
            "published_at": "2026-10-01T00:00:00Z", "snapshotVersion": 3,
            "albums": [{"id": name, "name": name, "parent_id": None,
                        "icon_key": None, "color_key": None} for name in (ALBUM, "empty")],
            "media": [], "memberships": [{"albumId": ALBUM, "assetId": asset_id}
                                           for asset_id, data in self.assets.items() if data["album"]]
        })
        self.assertEqual(published.status_code, 200, published.text)
        activated = self.client.post("/v1/albums/authority/activate", headers=self.publisher, json={
            "libraryId": LIBRARY, "expectedSnapshotDigest": published.json()["snapshotDigest"]})
        self.assertEqual(activated.status_code, 200, activated.text)
        # Include a removed relation and an uncommitted member: neither may be counted.
        with api_app.get_db() as db:
            for asset_id, desired in ((list(self.assets)[2], 0), ("uncommitted", 1)):
                db.execute("INSERT INTO album_authority_members(library_id,album_id,asset_id,"
                           "desired_state,entity_revision,created_at,updated_at) VALUES(?,?,?,?,1,?,?)",
                           [LIBRARY, ALBUM, asset_id, desired, "now", "now"])
            db.commit()

    def tearDown(self):
        self.client.close()
        api_app.DB_PATH, api_app.API_TOKEN = self.original
        self.temp.cleanup()

    def read(self, scope, *, headers=None, **params):
        if scope == "album":
            route, auth = "/v1/albums/assets", self.client_auth
            params = {"libraryId": LIBRARY, "epoch": 1, "albumId": ALBUM, **params}
        else:
            route, auth = "/v1/library/assets", self.auth
            if scope == "classification":
                params = {"classification_id": CLASSIFICATION, **params}
        return self.client.get(route, headers={**auth, **(headers or {})}, params=params)

    def walk(self, scope, **params):
        items, cursor, generation = [], None, None
        for _ in range(30):
            query = {"limit": 2, **params}
            if cursor:
                query["cursor"] = cursor
            response = self.read(scope, **query)
            self.assertEqual(response.status_code, 200, response.text)
            page = response.json()
            if generation is None:
                generation = page["listGeneration"]
            self.assertEqual(page["listGeneration"], generation)
            items.extend(page["items"])
            cursor = page.get("nextCursor", page.get("next_cursor"))
            if not page.get("hasMore", page.get("has_more")):
                self.assertIsNone(cursor)
                return items, generation
            self.assertTrue(cursor)
        self.fail("page walk did not terminate")

    def expected(self, scope, sort, filters):
        result = []
        for asset_id, data in self.assets.items():
            if scope == "classification" and not data["classified"]:
                continue
            if scope == "album" and not data["album"]:
                continue
            if filters.get("unclassified") and data["classified"]:
                continue
            media = filters.get("media_kind")
            if media == "images" and data["kind"] not in ("image", "gif"):
                continue
            if media == "videos" and data["kind"] != "video":
                continue
            aspect = filters.get("aspect_ratio")
            if aspect:
                if not data["width"] or not data["height"]:
                    continue
                ratio = data["width"] / data["height"]
                if not {"square": 0.8 <= ratio <= 1.25, "portrait": ratio < 0.8,
                        "landscape": ratio > 1.25}[aspect]:
                    continue
            lower, upper = filters.get("duration_ms_min"), filters.get("duration_ms_max")
            if lower is not None or upper is not None:
                if data["kind"] != "video" or data["duration"] is None:
                    continue
                if lower is not None and data["duration"] < lower:
                    continue
                if upper is not None and data["duration"] >= upper:
                    continue
            result.append(asset_id)
        return sorted(result, key=lambda asset_id: (self.assets[asset_id]["date"], asset_id),
                      reverse=sort == "newest")

    def assert_toc(self, scope, sort="newest", *, utc_offset_minutes=0, **filters):
        params = {"sort": sort, "utcOffsetMinutes": utc_offset_minutes, **filters}
        items, generation = self.walk(scope, **params)
        ids = [item["id"] for item in items]
        self.assertEqual(ids, self.expected(scope, sort, filters))
        response = self.read(scope, toc=1, limit=1, **params)
        self.assertEqual(response.status_code, 200, response.text)
        toc = response.json()
        self.assertEqual(set(toc), {"tocVersion", "listGeneration", "totalCount", "sort",
                                    "utcOffsetMinutes", "buckets"})
        self.assertEqual(toc["tocVersion"], 1)
        self.assertEqual(toc["utcOffsetMinutes"], utc_offset_minutes)
        self.assertEqual(toc["listGeneration"], generation)
        self.assertEqual(toc["sort"], sort)
        self.assertEqual(toc["totalCount"], len(ids))
        expected_buckets = []
        for index, asset_id in enumerate(ids):
            month = datetime.fromisoformat(self.assets[asset_id]["date"].replace("Z", "+00:00"))
            if month.tzinfo is not None:
                month = month.astimezone(timezone.utc)
            month = (month + timedelta(minutes=utc_offset_minutes)).strftime("%Y-%m")
            if not expected_buckets or expected_buckets[-1]["key"] != month:
                expected_buckets.append({"key": month, "startIndex": index, "count": 0})
            expected_buckets[-1]["count"] += 1
        self.assertEqual([{k: bucket[k] for k in ("key", "startIndex", "count")}
                          for bucket in toc["buckets"]], expected_buckets)
        self.assertEqual(sum(bucket["count"] for bucket in toc["buckets"]), len(ids))
        for bucket in toc["buckets"]:
            self.assertEqual(set(bucket), {"key", "startIndex", "count", "startCursor"})
            start = bucket["startIndex"]
            query = {"limit": 2, **params}
            if start == 0:
                self.assertIsNone(bucket["startCursor"])
            else:
                cursor = bucket["startCursor"]
                query["cursor"] = cursor
                decoded = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
                # Cursor is the real preceding (date,id) pair, never the bucket head.
                self.assertEqual(decoded["p"][-2:], [self.assets[ids[start - 1]]["date"], ids[start - 1]])
            page = self.read(scope, **query)
            self.assertEqual(page.status_code, 200, page.text)
            self.assertEqual([item["id"] for item in page.json()["items"]], ids[start:start + 2])
        return toc

    def test_totals_and_every_bucket_seek_match_full_walk_in_both_directions(self):
        for scope in ("library", "classification", "album"):
            for sort in ("newest", "oldest"):
                with self.subTest(scope=scope, sort=sort):
                    self.assert_toc(scope, sort)
                    if scope == "library":
                        self.assert_toc(scope, sort, unclassified=1)

    def test_technical_filters_match_full_walk_and_seek_in_every_scope(self):
        cases = [{"media_kind": "images"}, {"media_kind": "videos"},
                 {"aspect_ratio": "square"}, {"aspect_ratio": "portrait"},
                 {"aspect_ratio": "landscape"}, {"duration_ms_min": 1000},
                 {"duration_ms_max": 10000},
                 {"media_kind": "videos", "aspect_ratio": "landscape",
                  "duration_ms_min": 1000, "duration_ms_max": 14000}]
        for scope in ("library", "classification", "album"):
            for sort in ("newest", "oldest"):
                for filters in cases:
                    with self.subTest(scope=scope, sort=sort, filters=filters):
                        self.assert_toc(scope, sort, **filters)

    def test_month_uses_utc_and_created_at_fallback(self):
        asset_id = list(self.assets)[-1]
        # Stored offset crosses the local calendar boundary, but stays April in UTC.
        date = "2019-05-01T00:30:00+02:00"
        self.assets[asset_id]["date"] = date
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET created_at=? WHERE id=?", [date, asset_id])
            db.commit()
        for scope in ("library", "classification", "album"):
            for sort in ("newest", "oldest"):
                with self.subTest(scope=scope, sort=sort):
                    toc = self.assert_toc(scope, sort)
                    self.assertNotIn("2019-05", [bucket["key"] for bucket in toc["buckets"]])

    def test_kst_month_edge_and_every_bucket_cursor(self):
        ids = list(self.assets)
        dates = {ids[0]: "2026-09-30T15:30:00Z",
                 ids[4]: "2026-09-30T14:59:59.999999Z",
                 ids[13]: "2026-09-30T15:00:00Z"}
        with api_app.get_db() as db:
            for asset_id, date in dates.items():
                self.assets[asset_id]["date"] = date
                # Preserve the last row's NULL collected_at to check created_at fallback.
                db.execute("UPDATE assets SET created_at=?, collected_at=CASE"
                           " WHEN collected_at IS NULL THEN NULL ELSE ? END WHERE id=?",
                           [date, date, asset_id])
            db.commit()
        for scope in ("library", "classification", "album"):
            for sort in ("newest", "oldest"):
                with self.subTest(scope=scope, sort=sort):
                    utc = self.assert_toc(scope, sort)
                    self.assertIn("2026-09", [bucket["key"] for bucket in utc["buckets"]])
                    self.assertNotIn("2026-10", [bucket["key"] for bucket in utc["buckets"]])
                    kst = self.assert_toc(scope, sort, utc_offset_minutes=540)
                    counts = {bucket["key"]: bucket["count"] for bucket in kst["buckets"]}
                    self.assertEqual(counts["2026-10"], 1 if scope == "classification" else 2)
                    self.assertEqual(counts["2026-09"], 1)
                    self.assertEqual(kst["listGeneration"], utc["listGeneration"])
                    self.assertEqual(kst["totalCount"], utc["totalCount"])

    def test_negative_offset_month_edge_and_naive_utc_timestamp(self):
        asset_id = list(self.assets)[0]
        for date in ("2026-10-01T00:30:00Z", "2026-10-01T00:30:00",
                     "2026-10-01T02:30:00+02:00"):
            self.assets[asset_id]["date"] = date
            with api_app.get_db() as db:
                db.execute("UPDATE assets SET collected_at=? WHERE id=?", [date, asset_id])
                db.commit()
            for scope in ("library", "classification", "album"):
                for sort in ("newest", "oldest"):
                    with self.subTest(date=date, scope=scope, sort=sort):
                        utc = self.assert_toc(scope, sort)
                        shifted = self.assert_toc(scope, sort, utc_offset_minutes=-60)
                        self.assertIn("2026-10", [bucket["key"] for bucket in utc["buckets"]])
                        self.assertIn("2026-09", [bucket["key"] for bucket in shifted["buckets"]])
                        self.assertNotIn("2026-10", [bucket["key"] for bucket in shifted["buckets"]])

    def test_offset_defaults_bounds_and_album_parameter_allowlist(self):
        for scope in ("library", "classification", "album"):
            with self.subTest(scope=scope):
                default = self.read(scope, toc=1)
                zero = self.read(scope, toc=1, utcOffsetMinutes=0)
                self.assertEqual(default.status_code, 200, default.text)
                self.assertEqual(default.json()["utcOffsetMinutes"], 0)
                self.assertEqual(default.json(), zero.json())
                self.assertEqual(default.headers["ETag"], zero.headers["ETag"])
            for offset in (-720, 840):
                with self.subTest(scope=scope, offset=offset):
                    self.assert_toc(scope, utc_offset_minutes=offset)
        self.assertEqual(self.read("album", toc=1, utcOffsetMinutes=540,
                                   unknown="value").status_code, 422)

    def test_bad_offsets_rejected_only_for_tocs(self):
        values = (-721, 841, "1.5", "540.0", "true", "", "1_0", "not-an-integer")
        for scope in ("library", "classification", "album"):
            page = self.read(scope, toc=0, limit=2)
            cursor = page.json().get("nextCursor", page.json().get("next_cursor"))
            for offset in (540, *values):
                with self.subTest(scope=scope, offset=offset):
                    ignored = self.read(scope, toc=0, utcOffsetMinutes=offset, limit=2)
                    self.assertEqual(ignored.status_code, 200, ignored.text)
                    self.assertEqual(ignored.json(), page.json())
                    self.assertEqual(ignored.headers["ETag"], page.headers["ETag"])
                    implicit_page = self.read(scope, utcOffsetMinutes=offset, limit=2,
                                              cursor=cursor)
                    normal_page = self.read(scope, limit=2, cursor=cursor)
                    self.assertEqual(implicit_page.status_code, 200, implicit_page.text)
                    self.assertEqual(implicit_page.json(), normal_page.json())
                    if offset in values:
                        self.assertEqual(self.read(scope, toc=1,
                                                   utcOffsetMinutes=offset).status_code, 422)

    def test_toc_etag_varies_by_offset_even_when_buckets_are_unchanged(self):
        for scope in ("library", "classification", "album"):
            with self.subTest(scope=scope):
                utc = self.read(scope, toc=1)
                # Positive offsets 1 and 2 move exactly the same fixture rows.
                one = self.read(scope, toc=1, utcOffsetMinutes=1)
                two = self.read(scope, toc=1, utcOffsetMinutes=2,
                                headers={"If-None-Match": one.headers["ETag"]})
                self.assertEqual(two.status_code, 200, two.text)
                self.assertEqual(one.json()["buckets"], two.json()["buckets"])
                self.assertEqual(len({utc.headers["ETag"], one.headers["ETag"],
                                      two.headers["ETag"]}), 3)
                cached = self.read(scope, toc=1, utcOffsetMinutes=2,
                                   headers={"If-None-Match": two.headers["ETag"]})
                self.assertEqual(cached.status_code, 304)
                self.assertEqual(cached.content, b"")

    def test_empty_results(self):
        for scope in ("library", "classification", "album"):
            for sort in ("newest", "oldest"):
                with self.subTest(scope=scope, sort=sort):
                    toc = self.assert_toc(scope, sort, duration_ms_min=999999)
                    self.assertEqual(toc["totalCount"], 0)
                    self.assertEqual(toc["buckets"], [])
        for scope, params in (("classification", {"classification_id": "missing"}),
                              ("album", {"albumId": "empty"})):
            response = self.read(scope, toc=1, **params)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["buckets"], [])

    def test_toc_cursor_combination_is_400_even_for_empty_cursor(self):
        for scope in ("library", "classification", "album"):
            for cursor in ("", "invalid"):
                with self.subTest(scope=scope, cursor=cursor):
                    self.assertEqual(self.read(scope, toc=1, cursor=cursor).status_code, 400)

    def test_invalid_toc_and_sort_are_rejected(self):
        for scope in ("library", "album"):
            for params in ({"toc": 2}, {"toc": -1}, {"toc": "true"}, {"sort": "name"}):
                with self.subTest(scope=scope, params=params):
                    self.assertEqual(self.read(scope, **params).status_code, 422)

    def test_toc_cursors_keep_the_scope_sort_and_filter_bindings(self):
        for scope in ("library", "classification", "album"):
            cursor = self.read(scope, toc=1).json()["buckets"][1]["startCursor"]
            status = 422 if scope == "album" else 400
            with self.subTest(scope=scope):
                self.assertEqual(self.read(scope, cursor=cursor, sort="oldest").status_code, status)
                self.assertEqual(self.read(scope, cursor=cursor, media_kind="videos").status_code, status)
                wrong_scope = {"albumId": "empty"} if scope == "album" else {"classification_id": "missing"}
                self.assertEqual(self.read(scope, cursor=cursor, **wrong_scope).status_code, status)

    def test_toc_preserves_authentication_and_album_existence_guards(self):
        for scope in ("library", "album"):
            with self.subTest(scope=scope):
                self.assertEqual(self.read(scope, toc=1, headers={"Authorization": "Bearer invalid"}).status_code, 401)
        self.assertEqual(self.read("album", toc=1, albumId="missing").status_code, 404)
        with api_app.get_db() as db:
            db.execute("UPDATE album_authority_state SET deleted=1 WHERE album_id=?", [ALBUM])
            db.commit()
        self.assertEqual(self.read("album", toc=1).status_code, 404)

    def test_album_cursors_cannot_change_sort_and_newest_keeps_its_tag(self):
        for sort in ("newest", "oldest"):
            cursor = self.read("album", sort=sort, limit=1).json()["nextCursor"]
            opposite = "oldest" if sort == "newest" else "newest"
            self.assertEqual(self.read("album", sort=opposite, cursor=cursor).status_code, 422)
            if sort == "newest":
                decoded = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
                self.assertEqual(decoded["p"][0], album_authority.ALBUM_ASSETS_SORT)

    def test_conditional_reads_for_tocs_and_pages(self):
        for scope in ("library", "classification", "album"):
            for toc in (0, 1):
                with self.subTest(scope=scope, toc=toc):
                    first = self.read(scope, toc=toc)
                    self.assertEqual(first.status_code, 200)
                    etag = first.headers["ETag"]
                    cached = self.read(scope, toc=toc, headers={"If-None-Match": f'"other", W/{etag}'})
                    self.assertEqual(cached.status_code, 304)
                    self.assertEqual(cached.content, b"")
                    self.assertEqual(cached.headers["Cache-Control"], "private, no-cache")
                    with api_app.get_db() as db:
                        db.execute("UPDATE assets SET size_bytes=size_bytes+1 WHERE id=?", [list(self.assets)[0]])
                        db.commit()
                    changed = self.read(scope, toc=toc, headers={"If-None-Match": etag})
                    self.assertEqual(changed.status_code, 200)
                    self.assertNotEqual(changed.headers["ETag"], etag)

    def test_generation_counts_and_cursors_share_a_snapshot_during_a_write(self):
        original_toc = asset_list_query.AssetListQuery.toc
        for scope in ("library", "classification", "album"):
            before = self.read(scope, toc=1).json()
            def mutate_then_read(query, db, generation, encode_cursor, utc_offset_minutes=0):
                self.assertTrue(db.in_transaction)
                with api_app.get_db() as writer:
                    writer.execute("UPDATE assets SET collected_at='2020-01-01T00:00:00Z' WHERE id=?",
                                   [list(self.assets)[0]])
                    writer.commit()
                return original_toc(query, db, generation, encode_cursor, utc_offset_minutes)
            with patch.object(asset_list_query.AssetListQuery, "toc", mutate_then_read):
                response = self.read(scope, toc=1)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json(), before)
            after = self.read(scope, toc=1).json()
            self.assertNotEqual(after["listGeneration"], before["listGeneration"])
            self.assertNotEqual(after["buckets"], before["buckets"])
            with api_app.get_db() as db:
                db.execute("UPDATE assets SET collected_at=? WHERE id=?", [DATES[0], list(self.assets)[0]])
                db.commit()

    def test_unclassified_full_walk_pages_and_toc(self):
        for sort in ("newest", "oldest"):
            for filters in ({}, {"media_kind": "images"}, {"aspect_ratio": "landscape"},
                            {"media_kind": "videos", "duration_ms_min": 0}):
                with self.subTest(sort=sort, filters=filters):
                    params = {"unclassified": 1, **filters}
                    self.assert_toc("library", sort, **params)
                    full = self.read("library", sort=sort, limit=100, **params)
                    self.assertEqual(full.status_code, 200, full.text)
                    self.assertEqual([row["id"] for row in full.json()["items"]],
                                     self.expected("library", sort, params))
                    self.assertTrue(all(not row["classification_ids"] for row in full.json()["items"]))
        self.assertEqual(self.read("classification", unclassified=1).json()["items"], [])
        for value in (-1, 2, "bad"):
            self.assertEqual(self.read("library", unclassified=value).status_code, 422)

    def test_unclassified_cursor_and_etag_identity(self):
        for source, destination in (({}, {"unclassified": 1}), ({"unclassified": 1}, {})):
            page = self.read("library", limit=2, **source).json()
            self.assertEqual(self.read("library", cursor=page["next_cursor"], **destination).status_code, 400)
        legacy = base64.urlsafe_b64encode(json.dumps(["newest", DATES[-1], list(self.assets)[-1]]).encode()).decode()
        self.assertEqual(self.read("library", unclassified=1, cursor=legacy).status_code, 400)
        with api_app.get_db() as db:
            db.execute("DELETE FROM asset_classifications")
            db.commit()
        # Even identical rows/buckets are different query identities.
        for params in ({"limit": 100}, {"toc": 1}):
            ordinary = self.read("library", **params)
            unsorted = self.read("library", unclassified=1, **params)
            self.assertNotEqual(ordinary.headers["etag"], unsorted.headers["etag"])
            self.assertEqual(self.read("library", unclassified=1, headers={"If-None-Match": unsorted.headers["etag"]}, **params).status_code, 304)
            self.assertEqual(self.read("library", unclassified=1, headers={"If-None-Match": ordinary.headers["etag"]}, **params).status_code, 200)

    def test_canonical_classification_assignments_replace_legacy_membership(self):
        classification_authority.startup(api_app.get_db)
        entries = [{"id": CLASSIFICATION, "kind": "root", "name": "Folder",
                    "parentId": None, "iconKey": None, "colorKey": None}]
        assignments = []
        for data in self.assets.values():
            data["classified"] = not data["classified"]
        for asset_id, data in self.assets.items():
            assignments.append({"assetId": asset_id,
                                "classificationId": CLASSIFICATION if data["classified"] else None})
        with api_app.get_db() as db:
            classification_authority.activate(
                db, library_id=LIBRARY, entries=entries, assignments=assignments, roles=[],
                baseline_digest="fixture", baseline_revision=None, snapshot_version=1, now="now")
            db.commit()
        missing = list(self.assets)[0]
        self.assets[missing]["classified"] = False
        with api_app.get_db() as db:
            db.execute("DELETE FROM classification_authority_assignments WHERE asset_id=?", [missing])
            db.commit()
        for sort in ("newest", "oldest"):
            self.assert_toc("classification", sort)
            self.assert_toc("classification", sort, media_kind="videos")
            self.assert_toc("library", sort, unclassified=1)
            self.assert_toc("library", sort, unclassified=1, media_kind="images")

    def test_trashed_tombstoned_and_missing_canonical_assets_are_not_counted(self):
        asset_authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            identity, inventory = asset_authority.current_inventory(db)
            staged = asset_authority.stage_baseline(
                db, library_id=LIBRARY, expected_inventory=inventory,
                rows=[{"assetId": asset_id, "lifecycle": asset_authority.NORMAL, "sha256": sha}
                      for asset_id, sha in identity], now="now")
            asset_authority.activate(db, library_id=LIBRARY,
                                     expected_snapshot=staged["snapshotDigest"], now="now")
            ids = list(self.assets)
            for asset_id, lifecycle in zip(ids[:2], ("trash", "tombstoned")):
                db.execute("UPDATE asset_authority_state SET lifecycle=? WHERE asset_id=?",
                           [lifecycle, asset_id])
            db.execute("DELETE FROM asset_authority_state WHERE asset_id=?", [ids[3]])
            db.commit()
        for asset_id in (ids[0], ids[1], ids[3]):
            del self.assets[asset_id]
        for scope in ("library", "classification", "album"):
            for sort in ("newest", "oldest"):
                with self.subTest(scope=scope, sort=sort):
                    self.assert_toc(scope, sort)


if __name__ == "__main__":
    unittest.main()
