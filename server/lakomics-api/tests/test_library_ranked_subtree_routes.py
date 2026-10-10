"""Library Asset listing: folder subtree mode and the favorites/random sorts.

Direct-only listings and the newest/oldest sorts are covered by ``test_mobile_library_api``
and must stay byte-identical; these tests pin only what the new parameters add. They need the
FastAPI test client; the SQL and cursor keys they build on are covered without it by
``test_asset_list_ranked``.
"""
from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from tests.test_capture_api_stub import fake_s3  # noqa: E402

import album_authority  # noqa: E402
import app as api_app  # noqa: E402
import authority  # noqa: E402
import classification_authority  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

LIBRARY = "a" * 32
ROOT = "10000000-0000-4000-8000-000000000001"
WORK = "10000000-0000-4000-8000-000000000002"
TAG = "10000000-0000-4000-8000-000000000003"
OTHER = "10000000-0000-4000-8000-000000000004"
FOLDERS = [ROOT, WORK, TAG, OTHER]
SEED = "seedseed0001"
SEED2 = "seedseed0002"
LIKES_ALBUM = "40000000-0000-4000-8000-000000000001"


def asset_id(number: int) -> str:
    return f"30000000-0000-4000-8000-{number:012d}"


class RankedSubtreeRouteFixture(unittest.TestCase):
    count = 30

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "lakomics.sqlite3"
        self.original_database_path = api_app.DB_PATH
        self.original_api_token = api_app.API_TOKEN
        api_app.DB_PATH = self.database_path
        api_app.API_TOKEN = "test-token"
        api_app.startup()
        api_app.startup_replication()
        api_app.startup_captures()
        api_app.startup_classifications()
        fake_s3.objects.clear()
        self.client = TestClient(api_app.app)
        self.placement = {}
        with closing(sqlite3.connect(self.database_path)) as db:
            db.executescript(authority.AUTHORITY_DDL + classification_authority.DDL
                             + album_authority.DDL)
            for number in range(self.count):
                stamp = f"2026-02-{1 + number % 27:02}T00:00:00Z"
                db.execute(
                    "INSERT INTO assets(id,kind,object_key,created_at,updated_at,collected_at,"
                    "committed) VALUES(?,'image',?,?,?,?,1)",
                    (asset_id(number), f"objects/{number}", stamp, stamp, stamp))
                self.placement[asset_id(number)] = FOLDERS[number % 4]
            db.commit()
        self.publish_legacy_tree()

    def tearDown(self) -> None:
        self.client.close()
        fake_s3.objects.clear()
        api_app.DB_PATH = self.original_database_path
        api_app.API_TOKEN = self.original_api_token
        self.temp_dir.cleanup()

    @property
    def auth(self):
        return {"Authorization": "Bearer test-token"}

    def publish_legacy_tree(self):
        entries = [
            {"id": ROOT, "kind": "root", "name": "게임", "parentId": None, "iconKey": None,
             "colorKey": None, "assetCount": 0},
            {"id": WORK, "kind": "work", "name": "작품", "parentId": ROOT, "iconKey": None,
             "colorKey": None, "assetCount": 0},
            {"id": TAG, "kind": "tag", "name": "태그", "parentId": WORK, "iconKey": None,
             "colorKey": None, "assetCount": 0},
            {"id": OTHER, "kind": "root", "name": "만화", "parentId": None, "iconKey": None,
             "colorKey": None, "assetCount": 0},
        ]
        response = self.client.put("/v1/classifications", headers=self.auth, json={
            "entries": entries, "published_at": "2026-09-02T00:00:00+00:00"})
        self.assertEqual(response.status_code, 200, response.text)
        with closing(sqlite3.connect(self.database_path)) as db:
            db.executemany("INSERT INTO asset_classifications(asset_id,classification_id,added_at)"
                           " VALUES(?,?,?)",
                           [(asset, folder, "2026-09-02T00:00:00Z")
                            for asset, folder in self.placement.items()])
            db.commit()

    def activate_authority(self, liked=()):
        """Write the classification and album authority state directly, as the fixtures of
        ``test_classification_authority`` do; there is no activation route to call."""
        tree = [(ROOT, "root", "게임", None), (WORK, "work", "작품", ROOT),
                (TAG, "tag", "태그", WORK), (OTHER, "root", "만화", None)]
        with closing(sqlite3.connect(self.database_path)) as db:
            for folder, kind, name, parent in tree:
                db.execute(
                    "INSERT INTO classification_authority_state(library_id,classification_id,"
                    "kind,name,parent_id,deleted,entity_revision,created_at,updated_at)"
                    " VALUES(?,?,?,?,?,0,1,'x','x')", (LIBRARY, folder, kind, name, parent))
            for asset, folder in self.placement.items():
                db.execute(
                    "INSERT INTO classification_authority_assignments(library_id,asset_id,"
                    "classification_id,entity_revision,created_at,updated_at)"
                    " VALUES(?,?,?,1,'x','x')", (LIBRARY, asset, folder))
            for domain in ("classifications", "albums"):
                db.execute(
                    "INSERT INTO authority_domains(library_id,domain,epoch,contract_version,"
                    "change_cursor,baseline_digest,baseline_revision,activated_at)"
                    " VALUES(?,?,1,1,0,?,NULL,'x')", (LIBRARY, domain, "d" * 64))
            db.execute(
                "INSERT INTO album_authority_state(library_id,album_id,name,parent_id,"
                "icon_key,color_key,deleted,entity_revision,created_at,updated_at)"
                " VALUES(?,?,?,NULL,NULL,NULL,0,1,'x','x')",
                (LIBRARY, LIKES_ALBUM, album_authority.LIKES_NAME))
            db.execute("INSERT INTO album_library_settings(library_id,likes_album_id) VALUES(?,?)",
                       (LIBRARY, LIKES_ALBUM))
            for asset in liked:
                db.execute(
                    "INSERT INTO album_authority_members(library_id,album_id,asset_id,"
                    "desired_state,entity_revision,created_at,updated_at)"
                    " VALUES(?,?,?,1,1,'x','x')", (LIBRARY, LIKES_ALBUM, asset))
            db.commit()

    def get(self, **params):
        return self.client.get("/v1/library/assets", headers=self.auth, params=params)

    def walk(self, **params):
        """Every id across all pages, plus the last page, following next_cursor."""
        seen, cursor = [], None
        while True:
            query = dict(params, limit=6)
            if cursor:
                query["cursor"] = cursor
            response = self.get(**query)
            self.assertEqual(response.status_code, 200, response.text)
            page = response.json()
            seen.extend(item["id"] for item in page["items"])
            if not page["has_more"]:
                return seen, page
            cursor = page["next_cursor"]

    def subtree_members(self):
        return {asset for asset, folder in self.placement.items()
                if folder in (ROOT, WORK, TAG)}


class SubtreeListingTests(RankedSubtreeRouteFixture):
    def check_subtree(self):
        direct, direct_page = self.walk(classification_id=ROOT)
        self.assertEqual(set(direct), {a for a, f in self.placement.items() if f == ROOT})
        self.assertNotIn("subtree", direct_page["searchFilters"])
        listed, page = self.walk(classification_id=ROOT, subtree=1)
        self.assertEqual(set(listed), self.subtree_members())
        self.assertEqual(len(listed), len(set(listed)))
        self.assertEqual(page["searchFilters"]["subtree"], 1)

    def test_subtree_lists_the_folder_and_everything_below_it_before_activation(self):
        self.check_subtree()

    def test_subtree_lists_the_folder_and_everything_below_it_after_activation(self):
        self.activate_authority()
        self.check_subtree()

    def test_a_cursor_is_bound_to_its_mode(self):
        first = self.get(classification_id=ROOT, subtree=1, limit=3).json()
        self.assertEqual(self.get(classification_id=ROOT, limit=3,
                                  cursor=first["next_cursor"]).status_code, 400)
        direct = self.get(classification_id=ROOT, limit=3).json()
        self.assertEqual(self.get(classification_id=ROOT, subtree=1, limit=3,
                                  cursor=direct["next_cursor"]).status_code, 400)

    def test_the_month_index_of_a_subtree_counts_the_subtree(self):
        index = self.get(classification_id=ROOT, subtree=1, toc=1, utcOffsetMinutes=0)
        self.assertEqual(index.status_code, 200, index.text)
        self.assertEqual(index.json()["totalCount"], len(self.subtree_members()))

    def test_subtree_needs_a_classification_and_refuses_unclassified(self):
        self.assertEqual(self.get(subtree=1).status_code, 422)
        self.assertEqual(self.get(classification_id=ROOT, subtree=1, unclassified=1).status_code, 422)

    def test_the_direct_listing_is_unchanged(self):
        listed, page = self.walk(classification_id=ROOT)
        self.assertNotIn("subtree", page["searchFilters"])
        self.assertNotIn("sort", page["searchFilters"])
        self.assertEqual(listed, sorted(listed, key=lambda a: (self.stamp(a), a), reverse=True))

    def stamp(self, asset):
        with closing(sqlite3.connect(self.database_path)) as db:
            return db.execute("SELECT collected_at FROM assets WHERE id=?", [asset]).fetchone()[0]


class FolderCountTests(RankedSubtreeRouteFixture):
    def counts(self):
        response = self.client.get("/v1/library/classifications", headers=self.auth,
                                   params={"subtree_counts": 1})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def check(self, body, authority_identity=None):
        self.assertEqual(body["listVersion"], 2)
        self.assertEqual(body.get("authority"), authority_identity)
        items = {item["id"]: item for item in body["items"]}
        self.assertEqual(items[ROOT]["total_asset_count"], len(self.subtree_members()))
        self.assertEqual(items[ROOT]["asset_count"],
                         len([a for a, f in self.placement.items() if f == ROOT]))
        self.assertEqual(items[TAG]["total_asset_count"], items[TAG]["asset_count"])

    def test_subtree_counts_are_additive_before_activation(self):
        self.check(self.counts())

    def test_subtree_counts_are_additive_after_activation(self):
        self.activate_authority()
        self.check(self.counts(), {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1})

    def test_the_default_response_is_unchanged(self):
        for activate in (False, True):
            if activate:
                self.activate_authority()
            body = self.client.get("/v1/library/classifications", headers=self.auth).json()
            self.assertNotIn("listVersion", body)
            for item in body["items"]:
                self.assertNotIn("total_asset_count", item)


class RankedSortTests(RankedSubtreeRouteFixture):
    def test_random_is_a_stable_complete_seeded_order(self):
        first, page = self.walk(sort="random", seed=SEED)
        again, _ = self.walk(sort="random", seed=SEED)
        other, _ = self.walk(sort="random", seed=SEED2)
        self.assertEqual(first, again)
        self.assertEqual(sorted(first), sorted(self.placement))
        self.assertNotEqual(first, other)
        self.assertEqual(page["searchFilters"]["sort"], "random")

    def test_random_inside_a_subtree_stays_inside_it(self):
        listed, _ = self.walk(sort="random", seed=SEED, classification_id=ROOT, subtree=1)
        self.assertEqual(set(listed), self.subtree_members())

    def test_a_cursor_is_bound_to_its_sort_and_seed(self):
        page = self.get(sort="random", seed=SEED, limit=4).json()
        self.assertEqual(self.get(sort="random", seed=SEED2, limit=4,
                                  cursor=page["next_cursor"]).status_code, 400)
        self.assertEqual(self.get(sort="newest", limit=4,
                                  cursor=page["next_cursor"]).status_code, 400)
        newest = self.get(limit=4).json()
        self.assertEqual(self.get(sort="random", seed=SEED, limit=4,
                                  cursor=newest["next_cursor"]).status_code, 400)

    def test_the_seed_rules(self):
        self.assertEqual(self.get(sort="random").status_code, 422)
        self.assertEqual(self.get(sort="newest", seed=SEED).status_code, 422)
        self.assertEqual(self.get(sort="random", seed="short").status_code, 422)
        self.assertEqual(self.get(sort="random", seed="bad seed!!!").status_code, 422)

    def test_ranked_sorts_have_no_month_index(self):
        self.assertEqual(self.get(sort="random", seed=SEED, toc=1).status_code, 422)
        self.assertEqual(self.get(sort="favorites", toc=1).status_code, 422)

    def test_favorites_without_an_album_authority_is_plain_newest(self):
        favorites, _ = self.walk(sort="favorites")
        newest, _ = self.walk(sort="newest")
        self.assertEqual(favorites, newest)

    def test_favorites_puts_liked_assets_first_then_newest(self):
        liked = {asset_id(3), asset_id(11), asset_id(20), asset_id(29)}
        self.activate_authority(liked=liked)
        favorites, _ = self.walk(sort="favorites")
        self.assertEqual(len(favorites), len(set(favorites)))
        self.assertEqual(set(favorites[:len(liked)]), liked)
        rest = favorites[len(liked):]
        self.assertEqual(rest, sorted(rest, key=lambda a: (self.stamp(a), a), reverse=True))
        inside, _ = self.walk(sort="favorites", classification_id=ROOT, subtree=1)
        self.assertEqual(set(inside), self.subtree_members())

    def stamp(self, asset):
        with closing(sqlite3.connect(self.database_path)) as db:
            return db.execute("SELECT collected_at FROM assets WHERE id=?", [asset]).fetchone()[0]


if __name__ == "__main__":
    unittest.main()
