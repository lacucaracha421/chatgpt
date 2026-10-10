"""Favorites/random Asset ordering and folder subtree helpers (plain Python, no FastAPI).

The route-level contract lives in ``test_library_ranked_subtree_routes``; these tests pin the
SQL and the cursor keys the route builds on.
"""
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import asset_list_query
import classification_subtree
from asset_list_query import RankedAssetListQuery

LIKED_SQL = "EXISTS (SELECT 1 FROM likes WHERE likes.asset_id = asset.id)"


def fixture(count=40, liked=(), same_day=()):
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE assets(id TEXT PRIMARY KEY, kind TEXT, committed INTEGER,"
               " collected_at TEXT, created_at TEXT)")
    db.execute("CREATE TABLE likes(asset_id TEXT PRIMARY KEY)")
    for index in range(count):
        asset_id = f"a{index:03}"
        stamp = ("2026-01-01T00:00:00Z" if asset_id in same_day
                 else f"2026-01-{1 + index % 28:02}T{index % 24:02}:00:00Z")
        db.execute("INSERT INTO assets VALUES(?,?,?,?,?)", (asset_id, "image", 1, stamp, stamp))
    db.executemany("INSERT INTO likes VALUES(?)", [(asset_id,) for asset_id in liked])
    return db


def read_all(db, query, limit):
    """Walk every page with the same cursor keys the route mints and decodes."""
    seen, after = [], None
    while True:
        rows = query.page(db, limit + 1, after)
        page = rows[:limit]
        seen.extend(row["id"] for row in page)
        if len(rows) <= limit:
            return seen
        key = RankedAssetListQuery.cursor_key(query.sort, page[-1])
        after = asset_list_query.ranked_after(query.sort, key, page[-1]["id"])


class ShuffleRankTests(unittest.TestCase):
    def test_rank_is_stable_per_seed_and_differs_between_seeds(self):
        first = asset_list_query.shuffle_rank("seedseed01", "a001")
        self.assertEqual(first, asset_list_query.shuffle_rank("seedseed01", "a001"))
        self.assertNotEqual(first, asset_list_query.shuffle_rank("seedseed02", "a001"))
        self.assertNotEqual(first, asset_list_query.shuffle_rank("seedseed01", "a002"))
        self.assertTrue(0 <= first < 2 ** 56)

    def test_sort_identity_binds_the_seed(self):
        self.assertEqual(asset_list_query.sort_identity("newest", None), "newest")
        self.assertEqual(asset_list_query.sort_identity("favorites", None), "favorites")
        self.assertEqual(asset_list_query.sort_identity("random", "abcdefgh"), "random:abcdefgh")
        self.assertNotEqual(asset_list_query.sort_identity("random", "abcdefgh"),
                            asset_list_query.sort_identity("random", "abcdefgi"))

    def test_ranked_after_rejects_a_malformed_key(self):
        for key in ("", "x", "-1", "1.5", "9" * 20):
            with self.subTest(key=key), self.assertRaises(ValueError):
                asset_list_query.ranked_after("random", key, "a001")
        for key in ("", "1", "2:2026-01-01", "1:", ":2026-01-01", "x:2026"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                asset_list_query.ranked_after("favorites", key, "a001")
        self.assertEqual(asset_list_query.ranked_after("random", "42", "a001"), (42, "a001"))
        self.assertEqual(asset_list_query.ranked_after("favorites", "1:2026-01-01T00:00:00Z", "a001"),
                         (1, "2026-01-01T00:00:00Z", "a001"))


class RandomOrderTests(unittest.TestCase):
    def setUp(self):
        self.db = fixture()
        self.addCleanup(self.db.close)

    def query(self, seed):
        return RankedAssetListQuery("assets AS asset", "asset.committed = 1", [], "random",
                                    seed=seed)

    def test_every_asset_appears_once_across_pages_in_the_seeded_order(self):
        query = self.query("seedseed01")
        paged = read_all(self.db, query, 7)
        expected = sorted((f"a{index:03}" for index in range(40)),
                          key=lambda asset_id: (asset_list_query.shuffle_rank("seedseed01", asset_id),
                                                asset_id))
        self.assertEqual(paged, expected)
        self.assertEqual(len(paged), len(set(paged)))

    def test_page_size_does_not_change_the_order(self):
        query = self.query("seedseed01")
        self.assertEqual(read_all(self.db, query, 3), read_all(self.db, query, 11))

    def test_another_seed_is_a_different_order_over_the_same_assets(self):
        first = read_all(self.db, self.query("seedseed01"), 9)
        second = read_all(self.db, self.query("seedseed02"), 9)
        self.assertEqual(sorted(first), sorted(second))
        self.assertNotEqual(first, second)

    def test_random_needs_a_seed_and_other_sorts_are_not_ranked_sorts(self):
        with self.assertRaises(ValueError):
            RankedAssetListQuery("assets AS asset", "1", [], "random")
        with self.assertRaises(ValueError):
            RankedAssetListQuery("assets AS asset", "1", [], "newest")

    def test_filters_run_before_the_page_is_cut(self):
        self.db.execute("UPDATE assets SET committed = 0 WHERE id < 'a010'")
        query = self.query("seedseed01")
        paged = read_all(self.db, query, 6)
        self.assertEqual(len(paged), 30)
        self.assertTrue(all(asset_id >= "a010" for asset_id in paged))


class FavoritesOrderTests(unittest.TestCase):
    def query(self, db, liked_sql=LIKED_SQL):
        return RankedAssetListQuery("assets AS asset", "asset.committed = 1", [], "favorites",
                                    liked_sql=liked_sql)

    def test_liked_assets_come_first_then_newest_with_a_stable_tiebreak(self):
        liked = {"a003", "a017", "a030", "a031"}
        same_day = {f"a{index:03}" for index in range(0, 40, 2)}
        db = fixture(liked=liked, same_day=same_day)
        self.addCleanup(db.close)
        paged = read_all(db, self.query(db), 6)
        rows = db.execute("SELECT id, COALESCE(collected_at, created_at) AS at FROM assets").fetchall()
        expected = [row["id"] for row in sorted(
            rows, key=lambda row: (row["id"] in liked, row["at"], row["id"]), reverse=True)]
        self.assertEqual(paged, expected)
        self.assertEqual(len(paged), len(set(paged)))
        self.assertEqual(set(paged[:len(liked)]), liked)

    def test_without_likes_it_is_plain_newest_order(self):
        db = fixture()
        self.addCleanup(db.close)
        paged = read_all(db, self.query(db, "0"), 8)
        rows = db.execute("SELECT id, COALESCE(collected_at, created_at) AS at FROM assets").fetchall()
        expected = [row["id"] for row in sorted(rows, key=lambda row: (row["at"], row["id"]),
                                                reverse=True)]
        self.assertEqual(paged, expected)

    def test_liked_binding_parameters_precede_the_filter_bindings(self):
        db = fixture(liked={"a005"})
        self.addCleanup(db.close)
        query = RankedAssetListQuery(
            "assets AS asset", "asset.committed = 1 AND asset.kind = ?", ["image"], "favorites",
            liked_sql="EXISTS (SELECT 1 FROM likes WHERE likes.asset_id = asset.id AND ? = 'x')",
            liked_params=["x"])
        rows = query.page(db, 3)
        self.assertEqual(rows[0]["id"], "a005")
        self.assertEqual(rows[0]["mobile_rank"], 1)


class SubtreeHelperTests(unittest.TestCase):
    PARENTS = {"root": None, "work": "root", "tag": "work", "other": None, "leaf": "other"}

    def test_a_subtree_is_the_folder_and_everything_below_it(self):
        self.assertEqual(classification_subtree.subtree_ids(self.PARENTS, "root"),
                         ["root", "work", "tag"])
        self.assertEqual(classification_subtree.subtree_ids(self.PARENTS, "tag"), ["tag"])
        self.assertEqual(classification_subtree.subtree_ids(self.PARENTS, "missing"), ["missing"])

    def test_a_parent_cycle_cannot_loop(self):
        looped = {"a": "b", "b": "a", "c": "b"}
        self.assertEqual(sorted(classification_subtree.subtree_ids(looped, "a")), ["a", "b", "c"])

    def test_single_valued_totals_sum_the_direct_counts_below_each_folder(self):
        totals = classification_subtree.subtree_totals_single(
            self.PARENTS, {"root": 2, "work": 3, "tag": 4, "leaf": 1})
        self.assertEqual(totals, {"root": 9, "work": 7, "tag": 4, "other": 1, "leaf": 1})

    def test_legacy_multi_link_assets_count_once_per_folder(self):
        pairs = [("root", "a1"), ("work", "a1"), ("work", "a2"), ("tag", "a2"), ("tag", "a3"),
                 ("leaf", "a1")]
        totals = classification_subtree.subtree_totals_distinct(self.PARENTS, pairs)
        self.assertEqual(totals, {"root": 3, "work": 3, "tag": 2, "other": 1, "leaf": 1})


if __name__ == "__main__":
    unittest.main()
