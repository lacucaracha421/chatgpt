"""Shared Asset filters across the three mobile gallery scopes.

The contract these tests pin:

* `media_kind` buckets follow PC exactly — GIF counts as an image;
* aspect arithmetic is PC's inclusive 0.8–1.25 band for square, and the two strict
  inequalities for landscape/portrait; it is mirrored from the Android client's
  `assetFilters.ts` so the two cannot disagree;
* a dimension or duration that is unknown (NULL, zero, negative, or the wrong type)
  satisfies no bucket instead of being silently treated as a value;
* `duration_ms_min` is inclusive, `duration_ms_max` is exclusive, both are bounded to
  positive i64, the range must be non-empty, and a bound is a video-only control;
* filtering happens in SQL before pagination, on all three routes, and the response
  always advertises `filterVersion:1` — including when nothing is filtered;
* a cursor carries the filter identity: a filtered request refuses a cursor minted under
  different filters and refuses a pre-filter legacy cursor, while an unfiltered request
  still accepts the legacy one, and every scope's current cursor binds its own scope;
* Character membership, order and revision stay frozen, but its technical fields are
  read live so a repaired dimension is usable while the PC is off.

The fixture is the shipped FastAPI app, so routes, guards and projections are real.
"""
import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import album_authority  # noqa: E402
import api_auth  # noqa: E402
import asset_filters  # noqa: E402
import authority  # noqa: E402
from tests.test_capture_api_stub import fake_s3  # noqa: E402
import app as api_app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

LIBRARY = "a" * 32
ALBUM = "root"
CLASSIFICATION_ID = "10000000-0000-4000-8000-000000000001"

# (asset id, kind, width, height, duration_ms) — one row per property under test.
# `unknown-dims` and `unknown-duration` are the NULL cases; the negative/zero rows are
# written directly below because HTTP validation refuses them.
ASSETS = [
    ("60000000-0000-4000-8000-000000000001", "image", 1000, 1000, None),   # square
    ("60000000-0000-4000-8000-000000000002", "image", 1000, 800, None),    # square, 1.25 edge
    ("60000000-0000-4000-8000-000000000003", "image", 800, 1000, None),    # square, 0.8 edge
    ("60000000-0000-4000-8000-000000000004", "image", 1600, 1000, None),   # landscape
    ("60000000-0000-4000-8000-000000000005", "image", 1000, 1600, None),   # portrait
    ("60000000-0000-4000-8000-000000000006", "gif", 400, 400, None),       # gif = image
    ("60000000-0000-4000-8000-000000000007", "video", 1920, 1080, 30_000),  # 30s
    ("60000000-0000-4000-8000-000000000008", "video", 1080, 1920, 0),      # 0ms
    ("60000000-0000-4000-8000-000000000009", "video", None, None, 60_000),  # unknown dims
    ("60000000-0000-4000-8000-000000000010", "image", None, None, None),   # fully unknown
]
UNKNOWN_DIM_ASSET = ASSETS[8][0]
SQUARE_EDGE = ASSETS[1][0]
SQUARE_LOW = ASSETS[2][0]


class AssetFilterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "lakomics.sqlite3"
        self.original = (api_app.DB_PATH, api_app.API_TOKEN)
        api_app.DB_PATH = self.database
        api_app.API_TOKEN = "filter-token"
        api_app.startup()
        api_app.startup_replication()
        api_app.startup_captures()
        api_app.startup_classifications()
        api_app.startup_album_replica()
        authority.startup(api_app.get_db)
        album_authority.startup(api_app.get_db)
        api_app.startup_mobile_characters()
        fake_s3.objects.clear()
        with api_app.get_db() as db:
            api_auth.startup(api_app.get_db)
            _, self.publisher_token = api_auth.provision_token(db, "publisher", "filters")
            _, self.client_token = api_auth.provision_token(db, "client", "filters")
            db.commit()
        self.client = TestClient(api_app.app)
        self.seed_assets()
        self.publish_classifications()
        self.activate_album()

    def tearDown(self) -> None:
        self.client.close()
        fake_s3.objects.clear()
        api_app.DB_PATH, api_app.API_TOKEN = self.original
        self.temp.cleanup()

    @property
    def auth(self):
        return {"Authorization": "Bearer filter-token"}

    @property
    def client_auth(self):
        return {"Authorization": f"Bearer {self.client_token}"}

    # -- fixture ---------------------------------------------------------

    def seed_assets(self) -> None:
        """Commit every fixture Asset through the shipped replication routes."""
        for index, (asset_id, kind, width, height, duration) in enumerate(ASSETS):
            content_type = "video/mp4" if kind == "video" else "image/png"
            collected = f"2026-02-{index + 1:02d}T00:00:00.000Z"
            self.assertEqual(self.client.post("/v1/replication/prepare", headers=self.auth, json={
                "asset_id": asset_id, "kind": kind, "content_type": content_type,
                "size_bytes": 17, "sha256": "a" * 64, "collected_at": collected}).status_code, 200)
            payload = {
                "asset_id": asset_id, "kind": kind, "content_type": content_type,
                "original": {"object_key": f"library/{asset_id}/original",
                             "content_type": content_type, "size_bytes": 17, "sha256": "a" * 64},
                "thumbnail": {"object_key": f"library/{asset_id}/thumbnail",
                              "content_type": "image/webp", "size_bytes": 5},
                "collected_at": collected, "source_published_at": "2026-01-01T00:00:00.000Z",
                "source_url": f"https://fixture.invalid/{asset_id}",
                "creator_name": "Fixture", "creator_handle": "fixture",
                "import_source": "Direct", "classification_ids": [CLASSIFICATION_ID],
            }
            if width is not None:
                payload["width"] = width
                payload["height"] = height
            if duration is not None:
                payload["duration_ms"] = duration
            self.assertEqual(self.client.post("/v1/replication/commit", headers=self.auth,
                                              json=payload).status_code, 200, asset_id)

    def publish_classifications(self) -> None:
        self.assertEqual(self.client.put("/v1/classifications", headers=self.auth, json={
            "entries": [{"id": CLASSIFICATION_ID, "kind": "root", "name": "게임",
                         "parentId": None, "iconKey": None, "colorKey": None, "assetCount": 0}],
            "published_at": "2026-01-01T00:00:00+00:00"}).status_code, 200)

    def activate_album(self, members=None) -> None:
        ids = members or [asset[0] for asset in ASSETS]
        digest = self.client.put("/v1/library/album-snapshot", headers=self.auth, json={
            "published_at": "2026-01-01T00:00:00Z", "snapshotVersion": 3,
            "albums": [{"id": ALBUM, "name": "업로드", "parent_id": None,
                        "icon_key": None, "color_key": None}],
            "media": [], "memberships": [{"albumId": ALBUM, "assetId": id} for id in ids]}).json()
        activated = self.client.post("/v1/albums/authority/activate",
                                     headers={"Authorization": f"Bearer {self.publisher_token}"},
                                     json={"libraryId": LIBRARY,
                                           "expectedSnapshotDigest": digest["snapshotDigest"]})
        self.assertEqual(activated.status_code, 200, activated.text)

    def publish_characters(self, asset_ids=None) -> str:
        body = {"version": 1, "baseRevision": None,
                "nodes": [{"id": "series:s", "kind": "series", "sourceId": "s", "seriesId": "s",
                           "parentId": None, "name": "시리즈"},
                          {"id": "character:c", "kind": "character", "sourceId": "c",
                           "seriesId": "s", "parentId": "series:s", "name": "캐릭터"}],
                "scopes": [{"nodeId": "series:s", "filter": name, "assetIds": []}
                           for name in ("all", "unclassified", "needs_review")] +
                          [{"nodeId": "character:c", "filter": "all",
                            "assetIds": asset_ids or [asset[0] for asset in ASSETS]}]}
        response = self.client.put("/v1/library/characters/replica", headers=self.auth, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["revision"]

    # -- helpers ---------------------------------------------------------

    def library(self, **params):
        return self.client.get("/v1/library/assets", headers=self.auth,
                               params={"limit": 50, **params})

    def album(self, **params):
        return self.client.get("/v1/albums/assets", headers=self.client_auth,
                               params={"libraryId": LIBRARY, "epoch": 1, "albumId": ALBUM,
                                       "limit": 50, **params})

    def characters(self, revision, **params):
        return self.client.get("/v1/library/characters/assets", headers=self.auth,
                               params={"node": "character:c", "revision": revision,
                                       "limit": 50, **params})

    def ids(self, response):
        self.assertEqual(response.status_code, 200, response.text)
        return [item["id"] for item in response.json()["items"]]

    def expected(self, predicate=lambda asset: True):
        """The fixture's matching ids in the order the route lists them: newest first.

        Every Asset is committed with a strictly increasing `collected_at` in fixture order,
        so the default listing is the fixture reversed. Asserting the order, not just the
        set, is what makes a page that silently ignores its cursor visible.
        """
        return [asset[0] for asset in reversed(ASSETS) if predicate(asset)]

    def walk(self, read, **params):
        """Every page of one scope, asserting pages are disjoint and the walk terminates.

        The Album read spells its continuation `hasMore`/`nextCursor` while the library and
        Character reads use `has_more`/`next_cursor`, exactly as the clients adapt them, so
        this normalizes the two rather than duplicating the walk three times.
        """
        seen, cursor = [], None
        for _ in range(50):
            query = dict(params)
            if cursor:
                query["cursor"] = cursor
            response = read(**query)
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            for item in body["items"]:
                self.assertNotIn(item["id"], seen)
                seen.append(item["id"])
            more = body.get("has_more", body.get("hasMore"))
            cursor = body.get("next_cursor", body.get("nextCursor"))
            if not more:
                self.assertIsNone(cursor)
                return seen, body
            self.assertIsNotNone(cursor)
            cursor = cursor
        raise AssertionError("pagination did not terminate")

    # -- media kind -------------------------------------------------------

    def test_images_includes_gif_and_videos_is_the_complement(self):
        images = self.ids(self.library(media_kind="images"))
        self.assertIn(ASSETS[5][0], images)   # gif counts as an image
        self.assertNotIn(ASSETS[6][0], images)
        videos = self.ids(self.library(media_kind="videos"))
        self.assertEqual(sorted(videos + images), sorted(asset[0] for asset in ASSETS))
        self.assertEqual(videos, self.expected(lambda asset: asset[1] == "video"))

    def test_an_unknown_media_kind_is_refused(self):
        for value in ("image", "gif", "video", "IMAGES", "", "images,videos"):
            self.assertEqual(self.library(media_kind=value).status_code, 422, value)

    # -- aspect ratio -----------------------------------------------------

    def test_square_band_matches_the_pc_arithmetic_inclusively(self):
        square = self.ids(self.library(aspect_ratio="square"))
        # 1.25 and 0.8 are inside the PC band (`>= 4/5`, `<= 5/4`), so both edges count.
        self.assertIn(SQUARE_EDGE, square)
        self.assertIn(SQUARE_LOW, square)
        self.assertNotIn(ASSETS[3][0], square)
        self.assertNotIn(ASSETS[4][0], square)
        self.assertEqual(square, self.expected(lambda asset: asset[0] in (
            ASSETS[0][0], SQUARE_EDGE, SQUARE_LOW, ASSETS[5][0])))

    def test_landscape_and_portrait_are_strict_and_do_not_overlap_square(self):
        landscape = self.ids(self.library(aspect_ratio="landscape"))
        portrait = self.ids(self.library(aspect_ratio="portrait"))
        self.assertEqual(landscape, self.expected(lambda asset: asset[0] in (ASSETS[3][0], ASSETS[6][0])))
        self.assertEqual(portrait, self.expected(lambda asset: asset[0] in (ASSETS[4][0], ASSETS[7][0])))
        self.assertFalse(set(landscape) & set(portrait))

    def test_unknown_or_non_positive_dimensions_satisfy_no_bucket(self):
        for aspect in ("square", "landscape", "portrait"):
            self.assertNotIn(UNKNOWN_DIM_ASSET, self.ids(self.library(aspect_ratio=aspect)))
        with api_app.get_db() as db:
            # A stored zero or negative dimension is unknown metadata, not a ratio; it must
            # not become "square" by arithmetic accident.
            db.execute("UPDATE assets SET width=0, height=0 WHERE id=?", (ASSETS[0][0],))
            db.execute("UPDATE assets SET width=-100, height=-100 WHERE id=?", (ASSETS[5][0],))
            db.commit()
        square = self.ids(self.library(aspect_ratio="square"))
        self.assertNotIn(ASSETS[0][0], square)
        self.assertNotIn(ASSETS[5][0], square)

    def test_an_unknown_aspect_ratio_is_refused(self):
        for value in ("all", "wide", "SQUARE", ""):
            self.assertEqual(self.library(aspect_ratio=value).status_code, 422, value)

    # -- duration ---------------------------------------------------------

    def test_duration_bounds_are_inclusive_minimum_and_exclusive_maximum(self):
        # `[0, 30000)` contains the 0ms video and excludes the 30000ms one: the maximum is
        # exclusive, so a client's "under 30s" bucket means exactly that.
        self.assertEqual(self.ids(self.library(duration_ms_min=0, duration_ms_max=30_000)),
                         self.expected(lambda asset: asset[0] == ASSETS[7][0]))
        # Widening the maximum by one millisecond admits the 30000ms video.
        self.assertEqual(self.ids(self.library(duration_ms_min=0, duration_ms_max=30_001)),
                         self.expected(lambda asset: asset[0] in (ASSETS[6][0], ASSETS[7][0])))
        # A minimum of 30000 excludes the 0ms video and keeps both longer ones.
        self.assertEqual(self.ids(self.library(duration_ms_min=30_000)),
                         self.expected(lambda asset: asset[0] in (ASSETS[6][0], UNKNOWN_DIM_ASSET)))
        # An exclusive maximum below every duration matches nothing but the 0ms video.
        self.assertEqual(self.ids(self.library(duration_ms_max=1)),
                         self.expected(lambda asset: asset[0] == ASSETS[7][0]))

    def test_a_duration_bound_is_a_video_only_control(self):
        """An image or GIF has no server-side duration, so it cannot satisfy a bucket."""
        bounded = self.ids(self.library(duration_ms_min=0))
        self.assertEqual(bounded, self.expected(
            lambda asset: asset[1] == "video"))
        self.assertTrue(all(item["kind"] == "video"
                            for item in self.library(duration_ms_min=0).json()["items"]))
        # A GIF is a video-ish media kind on PC but stores no duration here, so it stays out.
        self.assertNotIn(ASSETS[5][0], bounded)

    def test_an_empty_or_invalid_duration_range_is_refused(self):
        # An empty range is a client bug, not an empty result: answering "no Assets" would
        # hide the mistake behind a plausible page.
        for params in ({"duration_ms_min": 100, "duration_ms_max": 100},
                       {"duration_ms_min": 200, "duration_ms_max": 100}):
            self.assertEqual(self.library(**params).status_code, 400, params)
        # A malformed or out-of-column-range bound is refused before any range decision.
        for params in ({"duration_ms_min": -1},
                       {"duration_ms_max": -1},
                       {"duration_ms_min": 9_223_372_036_854_775_808},
                       {"duration_ms_max": 9_223_372_036_854_775_808},
                       {"duration_ms_min": "1.5"},
                       {"duration_ms_min": ""},
                       {"duration_ms_min": "soon"}):
            self.assertEqual(self.library(**params).status_code, 422, params)
        # A numeric string is a legal query parameter and is accepted, exactly as the
        # existing `limit` and `epoch` parameters are.
        self.assertEqual(self.library(duration_ms_min="5").status_code, 200)

    # -- all three scopes -------------------------------------------------

    def test_every_scope_filters_in_sql_before_pagination(self):
        revision = self.publish_characters()
        expectations = {
            "library": (self.library, {}),
            "album": (self.album, {}),
            "characters": (self.characters, {"revision": revision}),
        }
        for name, (read, extra) in expectations.items():
            unfiltered, _ = self.walk(lambda **params: read(**{**extra, **params}), limit=50)
            filtered, _ = self.walk(lambda **params: read(**{**extra, **params}),
                                    limit=50, media_kind="images")
            self.assertEqual(len(unfiltered), len(ASSETS), name)
            self.assertEqual(filtered,
                             [id for id in unfiltered
                              if next(a for a in ASSETS if a[0] == id)[1] != "video"], name)
            # The page is cut after filtering: limit=2 returns two *matching* Assets, not
            # the survivors of the first two rows.
            page = read(**{**extra, "limit": 2, "media_kind": "images"})
            self.assertEqual(len(page.json()["items"]), 2, name)
            self.assertTrue(page.json().get("has_more", page.json().get("hasMore")), name)

    def test_the_square_filter_agrees_across_scopes(self):
        revision = self.publish_characters()
        # The *set* is the filter's answer and must agree everywhere. The *order* is each
        # scope's own: the library and Album list newest first, while a Character scope
        # keeps the PC's published membership order. A filter must not rewrite either.
        square = {ASSETS[0][0], SQUARE_EDGE, SQUARE_LOW, ASSETS[5][0]}
        self.assertEqual(self.ids(self.library(aspect_ratio="square")), self.expected(
            lambda asset: asset[0] in square))
        self.assertEqual(self.ids(self.album(aspect_ratio="square")), self.expected(
            lambda asset: asset[0] in square))
        character_order = [asset[0] for asset in ASSETS if asset[0] in square]
        self.assertEqual(self.ids(self.characters(revision, aspect_ratio="square")),
                         character_order)

    def test_a_filtered_walk_is_deterministic_and_disjoint_in_every_scope(self):
        revision = self.publish_characters()
        for name, (read, extra) in (("library", (self.library, {})), ("album", (self.album, {})),
                                    ("characters", (self.characters, {"revision": revision}))):
            whole, _ = self.walk(lambda **params: read(**{**extra, **params}),
                                 media_kind="videos", duration_ms_min=0, limit=50)
            paged, _ = self.walk(lambda **params: read(**{**extra, **params}),
                                 media_kind="videos", duration_ms_min=0, limit=1)
            # Every page is disjoint and the walk terminates, and the set is the filter's
            # answer regardless of the scope's own ordering.
            self.assertEqual(whole, paged, name)
            self.assertEqual(len(paged), len(set(paged)), name)
            self.assertEqual(sorted(paged),
                             sorted(self.expected(lambda asset: asset[1] == "video")), name)
            if name != "characters":
                # Newest-first scopes are asserted in order; a Character scope keeps the
                # PC's published membership order, which is the fixture's own order.
                self.assertEqual(whole, self.expected(lambda asset: asset[1] == "video"), name)

    # -- filterVersion ----------------------------------------------------

    def test_filter_version_is_advertised_even_without_filters(self):
        revision = self.publish_characters()
        self.assertEqual(self.library().json()["filterVersion"], 1)
        self.assertEqual(self.album().json()["filterVersion"], 1)
        self.assertEqual(self.characters(revision).json()["filterVersion"], 1)
        self.assertEqual(asset_filters.FILTER_VERSION, 1)
        # The existing "does this server know about filtering" probe carries it too, so a
        # client can refuse to present an unfiltered list as a filtered one.
        self.assertEqual(self.client.get("/v1/library/list-generation",
                                         headers=self.auth).json()["filterVersion"], 1)

    # -- cursors ----------------------------------------------------------

    def test_a_legacy_cursor_is_accepted_without_filters_and_refused_with_them(self):
        # The pre-filter cursor was the bare ``[sort, sort_at, asset_id]`` payload. It is
        # still accepted by an unfiltered request for the same scope. Filters are what
        # makes it ambiguous: it cannot name the filter set it was cut in, so a filtered
        # request is refused rather than answered with a listing the client did not ask for.
        legacy = base64.urlsafe_b64encode(json.dumps(
            ["newest", "2026-02-10T00:00:00.000Z", ASSETS[9][0]]).encode()).decode().rstrip("=")
        unfiltered = self.library(cursor=legacy, limit=2)
        self.assertEqual(unfiltered.status_code, 200, unfiltered.text)
        self.assertEqual(len(unfiltered.json()["items"]), 2)
        # The pre-filter classification listing minted this same three-slot shape, so it
        # keeps walking the classification it was minted in rather than being cut off by it.
        scoped = self.library(cursor=legacy, limit=2, classification_id=CLASSIFICATION_ID)
        self.assertEqual(scoped.status_code, 200, scoped.text)
        self.assertEqual([item["id"] for item in scoped.json()["items"]],
                         self.expected()[1:3])
        # Resuming a pre-filter cursor inside a filtered walk would answer a different
        # question than the one asked, so it is rejected instead.
        for params in ({"media_kind": "images"}, {"aspect_ratio": "square"},
                       {"duration_ms_min": 0, "duration_ms_max": 60_000}):
            self.assertEqual(self.library(cursor=legacy, **params).status_code, 400, params)
        # The sort slot is all a pre-filter cursor can be bound to, and the sort it names
        # is not the one this request asks for.
        self.assertEqual(self.library(cursor=legacy, limit=2, sort="oldest").status_code, 400)

    def test_a_cursor_is_bound_to_the_classification_scope(self):
        body = self.library(classification_id=CLASSIFICATION_ID, limit=2).json()
        cursor = body["next_cursor"]
        self.assertIsNotNone(cursor)
        self.assertEqual(self.library(cursor=cursor, classification_id=CLASSIFICATION_ID,
                                      limit=2).status_code, 200)
        # Dropping the classification changes the query and must be refused.
        self.assertEqual(self.library(cursor=cursor, limit=2).status_code, 400)
        # Another classification is another question; the cursor must not answer it. A
        # filtered walk is bound to its filters too, so neither parameter may be dropped.
        self.assertEqual(self.library(
            cursor=cursor, limit=2, classification_id="10000000-0000-4000-8000-000000000002"
        ).status_code, 400)
        other = self.library(cursor=cursor, limit=2, aspect_ratio="square").status_code
        self.assertEqual(other, 400)
        # A cursor minted for the whole library stays out of a classification listing.
        plain = self.library(limit=2).json()["next_cursor"]
        self.assertEqual(self.library(
            cursor=plain, limit=2, classification_id=CLASSIFICATION_ID).status_code, 400)

    def test_a_cursor_cannot_be_resumed_under_different_filters(self):
        body = self.library(media_kind="images", limit=2).json()
        cursor = body["next_cursor"]
        self.assertIsNotNone(cursor)
        self.assertEqual(self.library(cursor=cursor, media_kind="images",
                                      limit=2).status_code, 200)
        for params in ({"media_kind": "videos"}, {"media_kind": "images", "aspect_ratio": "square"},
                       {"media_kind": "images", "duration_ms_min": 0, "duration_ms_max": 60_000}):
            self.assertEqual(self.library(cursor=cursor, limit=2, **params).status_code, 400, params)
        # No filters at all is also a different identity from "images".
        self.assertEqual(self.library(cursor=cursor, limit=2).status_code, 400)

    def test_album_and_character_cursors_bind_the_filter_identity(self):
        revision = self.publish_characters()
        album_cursor = self.album(aspect_ratio="square", limit=2).json()["nextCursor"]
        self.assertEqual(self.album(cursor=album_cursor, aspect_ratio="square",
                                    limit=2).status_code, 200)
        self.assertEqual(self.album(cursor=album_cursor, limit=2).status_code, 422)
        self.assertEqual(self.album(cursor=album_cursor, aspect_ratio="portrait",
                                    limit=2).status_code, 422)
        character_cursor = self.characters(revision, aspect_ratio="square",
                                           limit=2).json()["next_cursor"]
        self.assertEqual(self.characters(revision, cursor=character_cursor,
                                         aspect_ratio="square", limit=2).status_code, 200)
        self.assertEqual(self.characters(revision, cursor=character_cursor,
                                         limit=2).status_code, 400)

    def test_the_album_cursor_still_cannot_cross_albums(self):
        cursor = self.album(aspect_ratio="square", limit=2).json()["nextCursor"]
        # The Album id is inside the payload, so replaying it elsewhere is a cursor error
        # rather than a page of another Album.
        response = self.client.get("/v1/albums/assets", headers=self.client_auth,
                                   params={"libraryId": LIBRARY, "epoch": 1,
                                           "albumId": "other", "limit": 2, "cursor": cursor})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.album(cursor="not-a-cursor").status_code, 422)
        self.assertEqual(self.library(cursor="not-a-cursor").status_code, 400)

    # -- malformed cursors ------------------------------------------------

    def test_only_shipped_legacy_layouts_can_omit_the_filter_envelope(self):
        """Unfiltered legacy Album/Character cursors work; new library layout needs an envelope."""
        revision = self.publish_characters()
        forged = {
            "library": (self.library, {},
                        ["newest", None, "2026-02-10T00:00:00.000Z", ASSETS[9][0]]),
            "album": (self.album, {},
                      ["album-assets", ALBUM, "2026-02-10T00:00:00.000Z", ASSETS[9][0]]),
            "characters": (self.characters, {"revision": revision},
                           [revision, "character:c", "all", 3]),
        }
        for name, (read, extra, payload) in forged.items():
            cursor = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
            # Album and Character used these exact bare layouts before filters.
            expected_status = 400 if name == "library" else 200
            self.assertEqual(read(**{**extra, "cursor": cursor, "limit": 2}).status_code,
                             expected_status, name)
            # Filtered: it carries no filter identity at all, so it can never be resumed.
            filtered = read(**{**extra, "cursor": cursor, "limit": 2, "media_kind": "images"})
            self.assertIn(filtered.status_code, (400, 422), name)
        # The one bare payload that is still a cursor is the shipped three-slot library one,
        # and only the listing whose sort and scope it was minted for accepts it.
        legacy = base64.urlsafe_b64encode(json.dumps(
            ["newest", "2026-02-10T00:00:00.000Z", ASSETS[9][0]]).encode()).decode()
        self.assertEqual(self.library(cursor=legacy, limit=2).status_code, 200)
        self.assertEqual(self.album(cursor=legacy, limit=2).status_code, 422)

    def test_a_malformed_cursor_is_rejected_cleanly_in_every_scope(self):
        """Neither a wrong shape nor a wrong type may escape as an unhandled error."""
        revision = self.publish_characters()
        cases = {
            # Well-formed base64 of a JSON value that is not a cursor at all.
            "non-cursor json": base64.urlsafe_b64encode(json.dumps({"nope": 1}).encode()).decode(),
            "scalar json": base64.urlsafe_b64encode(json.dumps(7).encode()).decode(),
            "null json": base64.urlsafe_b64encode(b"null").decode(),
            # A dict whose fields are the wrong types.
            "wrong field types": base64.urlsafe_b64encode(json.dumps(
                {"kind": 5, "filters": "images", "p": {"x": 1}}).encode()).decode(),
            "legacy payload in new envelope": base64.urlsafe_b64encode(json.dumps(
                {"kind": "library-assets", "filters": [None, None, None, None],
                 "p": ["newest", "2026-02-10T00:00:00.000Z", ASSETS[9][0]]}).encode()).decode(),
            # A dict missing the payload entirely.
            "missing payload": base64.urlsafe_b64encode(json.dumps(
                {"kind": "library-assets", "filters": []}).encode()).decode(),
            # A payload whose slots are the wrong types.
            "non-string slots": base64.urlsafe_b64encode(json.dumps(
                {"kind": "library-assets", "filters": [None, None, None, None],
                 "p": [1, 2, 3, 4]}).encode()).decode(),
            "not base64": "!!!not base64!!!",
            "empty": "",
        }
        for name, cursor in cases.items():
            for read, extra, expected in (
                    (self.library, {}, 400), (self.album, {}, 422),
                    (self.characters, {"revision": revision}, 400)):
                response = read(**{**extra, "cursor": cursor})
                self.assertEqual(response.status_code, expected, (name, read))
                body = response.json()
                if expected == 422:
                    # The Album route reports its own coded rejection, never a raw string.
                    self.assertEqual(body["detail"]["code"], "invalidAlbumAssetsCursor", name)
                else:
                    self.assertIsInstance(body["detail"], str, name)

    def test_the_album_accepts_the_pre_filter_cursor_it_shipped(self):
        """The shipped list cursor keeps working, but only for the Album that minted it."""
        legacy = base64.urlsafe_b64encode(json.dumps(
            ["album-assets", ALBUM, "2026-02-10T00:00:00.000Z", ASSETS[9][0]]).encode()).decode()
        accepted = self.album(cursor=legacy, limit=2)
        self.assertEqual(accepted.status_code, 200, accepted.text)
        # It resumes strictly after the cursor's Asset in the shipped ordering, exactly as
        # the pre-filter route did.
        expected = self.expected()
        self.assertEqual([item["id"] for item in accepted.json()["items"]],
                         expected[expected.index(ASSETS[9][0]) + 1:][:2])
        # A legacy cursor still cannot cross Albums, and cannot be resumed under filters.
        other = base64.urlsafe_b64encode(json.dumps(
            ["album-assets", "other", "2026-02-10T00:00:00.000Z", ASSETS[9][0]]).encode()).decode()
        self.assertEqual(self.album(cursor=other).status_code, 422)
        self.assertEqual(self.album(cursor=legacy, media_kind="images").status_code, 422)
        # A legacy cursor in the library's layout is a different read's cursor.
        wrong_read = base64.urlsafe_b64encode(json.dumps(
            ["library-assets", "album-assets", "2026-01-01", ASSETS[0][0]]).encode()).decode()
        self.assertEqual(self.album(cursor=wrong_read).status_code, 422)

    # -- character technical metadata -------------------------------------

    def test_character_membership_and_order_survive_the_technical_overlay(self):
        revision = self.publish_characters()
        unfiltered, body = self.walk(lambda **params: self.characters(revision, **params), limit=50)
        self.assertEqual(unfiltered, [asset[0] for asset in ASSETS])
        # `sourceCount` is the published scope's own size and never moves with a filter.
        # `totalCount` is what the filter matches, so it shrinks while `sourceCount` does
        # not: the two answer different questions.
        self.assertEqual((body["totalCount"], body["sourceCount"]), (len(ASSETS), len(ASSETS)))
        images = self.characters(revision, media_kind="images").json()
        self.assertEqual(images["sourceCount"], len(ASSETS))
        self.assertEqual(images["totalCount"], len(images["items"]))
        self.assertEqual(images["totalCount"],
                         len([asset for asset in ASSETS if asset[1] != "video"]))
        self.assertEqual([item["id"] for item in images["items"]],
                         [asset[0] for asset in ASSETS if asset[1] != "video"])
        # The unfiltered read still reproduces the PC's own count exactly.
        self.assertEqual(self.characters(revision).json()["totalCount"], len(ASSETS))

    def test_character_total_count_describes_the_filtered_scope_not_the_page(self):
        """The count is the answer to the filter, so it does not change as the walk advances.

        Every page of one filtered walk is the same query continued, so a count that shrank
        with the cursor would make the client's own total disagree with itself between the
        first page and the page appended after it, and with the number `sourceCount` is
        compared against.
        """
        revision = self.publish_characters()
        images = [asset[0] for asset in ASSETS if asset[1] != "video"]
        whole = self.characters(revision, media_kind="images", limit=50).json()
        self.assertEqual((whole["totalCount"], whole["sourceCount"]), (len(images), len(ASSETS)))
        first = self.characters(revision, media_kind="images", limit=2).json()
        self.assertEqual((first["totalCount"], len(first["items"])), (len(images), 2))
        self.assertTrue(first["has_more"])
        appended = self.characters(revision, media_kind="images", limit=2,
                                   cursor=first["next_cursor"]).json()
        self.assertEqual(appended["totalCount"], first["totalCount"])
        self.assertEqual(appended["sourceCount"], first["sourceCount"])
        self.assertEqual([item["id"] for item in first["items"] + appended["items"]], images[:4])

    def test_a_character_cursor_position_is_bounded_by_the_published_scope(self):
        """A position that no scope can hold is a cursor error, not a 500."""
        revision = self.publish_characters()
        for position in (10_000_000, asset_filters.BOUND_MAX):
            cursor = base64.urlsafe_b64encode(json.dumps(
                {"filters": [None, None, None, None], "kind": "character-assets",
                 "p": [revision, "character:c", "all", position]}).encode()).decode()
            self.assertEqual(self.characters(revision, cursor=cursor).status_code, 200)
            self.assertEqual(self.characters(revision, cursor=cursor).json()["items"], [])
        # A position is a position in the published membership, so it is refused whenever it
        # is not an integer — including the boolean JSON would otherwise hand over as one.
        for position in (-1, "2", 2.5, True, asset_filters.BOUND_MAX + 1):
            cursor = base64.urlsafe_b64encode(json.dumps(
                {"filters": [None, None, None, None], "kind": "character-assets",
                 "p": [revision, "character:c", "all", position]}).encode()).decode()
            self.assertEqual(self.characters(revision, cursor=cursor).status_code, 400,
                             (position,))

    def test_known_metadata_filtering_is_consistent_with_each_page(self):
        """Every advertised Asset has known metadata, and each page agrees with the filter.

        The server excludes unknown metadata from a bucket, so a filtered page must ship no
        Asset that could not have satisfied the filter it was asked for. Checking the page's
        own items against the same arithmetic is what catches a predicate that leaks a row
        whose dimensions are unknown or non-positive.
        """
        revision = self.publish_characters()
        with api_app.get_db() as db:
            # Make the unknown-metadata cases explicit: NULL, zero and negative all mean
            # unknown, and none of them may reach a dimension bucket.
            db.execute("UPDATE assets SET width=NULL, height=NULL WHERE id=?", (UNKNOWN_DIM_ASSET,))
            db.execute("UPDATE assets SET width=0, height=0 WHERE id=?", (ASSETS[0][0],))
            db.execute("UPDATE assets SET width=-4, height=-4 WHERE id=?", (ASSETS[5][0],))
            db.execute("UPDATE assets SET duration_ms=NULL WHERE id=?", (ASSETS[6][0],))
            db.commit()
        for read, extra in ((self.library, {}), (self.album, {}),
                            (self.characters, {"revision": revision})):
            for aspect in ("square", "landscape", "portrait"):
                items = read(**{**extra, "aspect_ratio": aspect, "limit": 100}).json()["items"]
                self.assertTrue(items, (aspect, read))
                for item in items:
                    width, height = item["width"], item["height"]
                    # Known and positive, or the server would not have matched it.
                    self.assertIsInstance(width, int, (aspect, item["id"]))
                    self.assertIsInstance(height, int, (aspect, item["id"]))
                    self.assertGreater(width, 0, (aspect, item["id"]))
                    self.assertGreater(height, 0, (aspect, item["id"]))
                    buckets = {
                        "square": width * 5 >= height * 4 and width * 4 <= height * 5,
                        "landscape": width * 4 > height * 5,
                        "portrait": width * 5 < height * 4,
                    }
                    self.assertTrue(buckets[aspect], (aspect, item["id"]))
                    self.assertNotIn(item["id"],
                                     (UNKNOWN_DIM_ASSET, ASSETS[0][0], ASSETS[5][0]))
            for item in read(**{**extra, "duration_ms_min": 0,
                                "duration_ms_max": 120_000, "limit": 100}).json()["items"]:
                self.assertEqual(item["kind"], "video", item["id"])
                self.assertIsInstance(item["duration_ms"], int, item["id"])
                self.assertGreaterEqual(item["duration_ms"], 0, item["id"])
                self.assertLess(item["duration_ms"], 120_000, item["id"])

    def test_a_dimension_repaired_after_publication_replaces_the_stale_stored_value(self):
        """An overlay must take the live value, not prefer the frozen one.

        The stored payload carries a dimension from publication; the canonical Asset is then
        repaired. A projection that kept the stored value would still ship the stale number,
        so the page is checked against the live row rather than against the payload.
        """
        revision = self.publish_characters()
        stored_before = {item["id"]: item for item in self.characters(revision).json()["items"]}
        self.assertEqual((stored_before[ASSETS[3][0]]["width"],
                          stored_before[ASSETS[3][0]]["height"]), (1600, 1000))
        # Replace the published values with a different, still-known pair.
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET width=900, height=1600, duration_ms=NULL WHERE id=?",
                       (ASSETS[3][0],))
            db.commit()
        after = {item["id"]: item for item in self.characters(revision).json()["items"]}
        self.assertEqual((after[ASSETS[3][0]]["width"], after[ASSETS[3][0]]["height"]),
                         (900, 1600))
        # The Asset moved buckets with its metadata, and the stale ratio is gone.
        self.assertIn(ASSETS[3][0], self.ids(self.characters(revision, aspect_ratio="portrait")))
        self.assertNotIn(ASSETS[3][0], self.ids(self.characters(revision, aspect_ratio="landscape")))
        self.assertNotIn(ASSETS[3][0],
                         self.ids(self.characters(revision, duration_ms_min=0)))
        # Membership is untouched: same ids, same published order.
        self.assertEqual(list(after), [asset[0] for asset in ASSETS])

    def test_character_technical_fields_come_from_canonical_state_after_publication(self):
        revision = self.publish_characters()
        before = {item["id"]: item for item in self.characters(revision).json()["items"]}
        self.assertIsNone(before[UNKNOWN_DIM_ASSET]["width"])
        with api_app.get_db() as db:
            # A later metadata repair: technical fields are the server's to own, so they
            # must reach the frozen projection while the PC is off.
            db.execute("UPDATE assets SET width=2000, height=1000 WHERE id=?",
                       (UNKNOWN_DIM_ASSET,))
            db.commit()
        after = {item["id"]: item for item in self.characters(revision).json()["items"]}
        self.assertEqual((after[UNKNOWN_DIM_ASSET]["width"],
                          after[UNKNOWN_DIM_ASSET]["height"]), (2000, 1000))
        # The repaired Asset now browses as landscape even though its payload was
        # published with unknown dimensions.
        self.assertIn(UNKNOWN_DIM_ASSET, self.ids(self.characters(revision, aspect_ratio="landscape")))
        # Nothing but the technical fields moved: the stored payload is still the projection.
        self.assertEqual({key: after[id][key] for id in after for key in
                          ("kind", "content_type", "classification_ids", "committed")},
                         {key: before[id][key] for id in before for key in
                          ("kind", "content_type", "classification_ids", "committed")})
        # A duration learned after publication is usable too. `ASSETS[9]` is an image, so a
        # duration bound keeps it out: the bound is a video-only control in every scope.
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET duration_ms=45000 WHERE id=?", (ASSETS[4][0],))
            db.commit()
        self.assertNotIn(ASSETS[4][0], self.ids(self.characters(revision, duration_ms_min=45_000)))
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET duration_ms=45000 WHERE id=?", (ASSETS[6][0],))
            db.commit()
        self.assertIn(ASSETS[6][0], self.ids(self.characters(revision, duration_ms_min=45_000)))

    def test_a_deleted_character_asset_is_hidden_by_the_current_visibility_path(self):
        revision = self.publish_characters()
        import asset_authority
        asset_authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            # The Asset domain is library-scoped like the Album domain, so it activates the
            # library this fixture already published Albums under. Every fixture Asset shares
            # one sha256, so the duplicate-content conflict is cleared first, as the workflow
            # requires; activation is then bound to the server's own committed inventory.
            identity, inventory = asset_authority.current_inventory(db)
            db.execute("UPDATE assets SET sha256=NULL")
            db.commit()
            identity, inventory = asset_authority.current_inventory(db)
            staged = asset_authority.stage_baseline(
                db, library_id=LIBRARY, expected_inventory=inventory,
                rows=[{"assetId": asset_id, "lifecycle": asset_authority.NORMAL, "sha256": sha}
                      for asset_id, sha in identity], now="2026")
            asset_authority.activate(db, library_id=LIBRARY,
                                     expected_snapshot=staged["snapshotDigest"], now="2026")
            db.execute("UPDATE asset_authority_state SET lifecycle='trash' WHERE asset_id=?",
                       (ASSETS[0][0],))
            db.commit()
        items = self.characters(revision).json()["items"]
        self.assertNotIn(ASSETS[0][0], [item["id"] for item in items])
        # Hiding is the visibility path's decision, not a membership edit: restoring the
        # Asset restores it at its published position.
        with api_app.get_db() as db:
            db.execute("UPDATE asset_authority_state SET lifecycle='normal' WHERE asset_id=?",
                       (ASSETS[0][0],))
            db.commit()
        self.assertEqual([item["id"] for item in self.characters(revision).json()["items"]],
                         [asset[0] for asset in ASSETS])

    # -- existing behavior ------------------------------------------------

    def test_unfiltered_requests_keep_their_existing_page_shape(self):
        body = self.library().json()
        self.assertEqual([item["id"] for item in body["items"]],
                         [asset[0] for asset in reversed(ASSETS)])
        self.assertEqual(body["has_more"], False)
        self.assertIsNone(body["next_cursor"])
        album = self.album().json()
        self.assertEqual([item["id"] for item in album["items"]],
                         [asset[0] for asset in reversed(ASSETS)])
        self.assertEqual(album["libraryId"], LIBRARY)

    def test_album_and_character_reject_unknown_parameters(self):
        revision = self.publish_characters()
        self.assertEqual(self.album(media="images").status_code, 422)
        self.assertEqual(self.album(unknown="1").status_code, 422)
        self.assertEqual(self.characters(revision, media="images").status_code, 422)
        self.assertEqual(self.characters(revision, duration_ms_max="soon").status_code, 422)

    def test_filters_require_authentication(self):
        revision = self.publish_characters()
        self.assertEqual(self.client.get("/v1/library/assets",
                                         params={"media_kind": "images"}).status_code, 401)
        self.assertEqual(self.client.get("/v1/library/characters/assets",
                                         params={"node": "character:c", "revision": revision,
                                                 "media_kind": "images"}).status_code, 401)
        self.assertEqual(self.client.get("/v1/albums/assets", params={
            "libraryId": LIBRARY, "epoch": 1, "albumId": ALBUM,
            "media_kind": "images"}).status_code, 401)


if __name__ == "__main__":
    unittest.main()
