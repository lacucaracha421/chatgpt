"""Date cursors preserve results and seek into the existing startup index."""
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

from tests.test_capture_api_stub import fake_s3  # noqa: F401: configure offline R2 imports
import app as api_app
import asset_authority
import asset_filters
import asset_list_query
import asset_visibility
import authority
from tests.test_asset_search_performance import SearchFixture


def legacy_select(query, columns, *, after=None, limit=None):
    """Pre-range-bound SQL, retained only as a result/work-count baseline."""
    where = query.where_clause
    params = query.params.copy()
    if after is not None:
        where += (f" AND ({asset_list_query.SORT_AT} {query.comparison} ?"
                  f" OR ({asset_list_query.SORT_AT} = ? AND asset.id {query.comparison} ?))")
        params.extend([after[0], after[0], after[1]])
    sql = (f"SELECT {columns} FROM {query.from_clause} WHERE {where}"
           f" ORDER BY {query.order_at} {query.direction}, asset.id {query.direction}")
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)
    return sql, params


def measured_rows(db, sql, params):
    steps = 0

    def progress():
        nonlocal steps
        steps += 1
        return 0

    db.set_progress_handler(progress, 1)
    try:
        rows = db.execute(sql, params).fetchall()
    finally:
        db.set_progress_handler(None, 0)
    return rows, steps


class AssetListPaginationTests(unittest.TestCase):
    asset_count = 50_000

    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        path = Path(cls.temp.name) / "pagination.sqlite3"
        # Exercise the shipped startup schema/index, rather than a stronger test index.
        with patch.object(api_app, "DB_PATH", path):
            api_app.startup()
            api_app.startup_replication()
        cls.db = sqlite3.connect(path)
        cls.db.row_factory = sqlite3.Row
        cls.db.executescript(authority.AUTHORITY_DDL + asset_authority.DDL)
        cls.db.executemany(
            "INSERT INTO assets(id,kind,object_key,created_at,updated_at,collected_at,"
            "source_published_at,committed) VALUES(?,'image',?,?,?,?,?,?)",
            ((f"a{i:06}", f"objects/{i}",
              (datetime(2020, 1, 1) + timedelta(days=i // 100)).isoformat(), "now",
              None if i % 7 == 0 else
              (datetime(2020, 1, 1) + timedelta(days=i // 100)).isoformat(),
              # Source dates deliberately disagree with the actual list sort key.
              (datetime(2030, 1, 1) - timedelta(days=i // 100)).isoformat(),
              int(i % 101 != 0)) for i in range(cls.asset_count)))
        cls.db.commit()
        asset_visibility.install(cls.db)

    @classmethod
    def tearDownClass(cls):
        cls.db.close()
        cls.temp.cleanup()

    def query(self, sort, prefer_id_lookup=False):
        return asset_list_query.AssetListQuery(
            "visible_assets AS asset", "asset.committed=? AND asset.kind=?",
            [1, "image"], sort, prefer_id_lookup=prefer_id_lookup)

    def ordered(self, query):
        return self.db.execute(*query.select(
            f"{asset_list_query.SORT_AT} AS date, asset.id")).fetchall()

    def assert_same_results(self, query, after, limit):
        columns = f"asset.*, {asset_list_query.SORT_AT} AS mobile_sort_at"
        expected = self.db.execute(*legacy_select(
            query, columns, after=after, limit=limit)).fetchall()
        actual = self.db.execute(*query.select(columns, after=after, limit=limit)).fetchall()
        self.assertEqual([tuple(row) for row in actual], [tuple(row) for row in expected])
        if limit is not None:
            self.assertEqual([tuple(row) for row in query.page(self.db, limit, after)],
                             [tuple(row) for row in expected])
        return actual

    def test_both_sorts_preserve_first_middle_late_and_exhausted_pages(self):
        for sort in ("newest", "oldest"):
            for prefer_ids in (False, True):
                query = self.query(sort, prefer_ids)
                ordered = self.ordered(query)
                cursors = [None, tuple(ordered[0]), tuple(ordered[123]),
                           tuple(ordered[-201]), tuple(ordered[-1])]
                for after in cursors:
                    for limit in (1, 100, None):
                        with self.subTest(sort=sort, prefer_ids=prefer_ids,
                                          after=after, limit=limit):
                            self.assert_same_results(query, after, limit)

    def test_date_ties_and_null_collected_dates_keep_created_date_fallback(self):
        info = {row["name"]: row for row in self.db.execute("PRAGMA table_info(assets)")}
        self.assertFalse(info["collected_at"]["notnull"])
        self.assertTrue(info["created_at"]["notnull"])
        # The effective COALESCE date cannot be NULL under the production schema.
        for sort in ("newest", "oldest"):
            query = self.query(sort)
            ordered = self.ordered(query)
            cursor = tuple(ordered[123])
            rows = self.assert_same_results(query, cursor, 100)
            self.assertEqual(rows[0]["mobile_sort_at"], cursor[0])
            self.assertNotEqual(rows[0]["id"], cursor[1])
            null_rows = [row for row in rows if row["collected_at"] is None]
            self.assertTrue(null_rows)
            for row in null_rows:
                self.assertEqual(row["mobile_sort_at"], row["created_at"])
                self.assert_same_results(query, (row["mobile_sort_at"], row["id"]), 5)

    def assert_range_plan_and_work(self, query, after):
        sql, params = query.select("asset.id", after=after, limit=100)
        plan = "\n".join(row[3] for row in self.db.execute("EXPLAIN QUERY PLAN " + sql, params))
        self.assertIn("SEARCH asset USING INDEX idx_assets_mobile_order", plan)
        self.assertRegex(plan, r"<expr>[<>]\?")
        self.assertNotIn("USE TEMP B-TREE FOR ORDER BY", plan)
        actual, steps = measured_rows(self.db, sql, params)
        expected, old_steps = measured_rows(self.db, *legacy_select(
            query, "asset.id", after=after, limit=100))
        _, first_steps = measured_rows(self.db, *query.select("asset.id", limit=100))
        self.assertEqual([tuple(row) for row in actual], [tuple(row) for row in expected])
        # VM counts are deterministic across host speeds; generous for SQLite versions.
        self.assertLess(steps, 10_000)
        self.assertLess(steps, first_steps * 10)
        self.assertLess(steps * 20, old_steps)
        print(f"{query.sort} cursor={after}: VM steps {old_steps} -> {steps} "
              f"(first={first_steps}); {plan.splitlines()[0]}", flush=True)

    def test_late_pages_use_date_range_in_both_directions(self):
        for sort in ("newest", "oldest"):
            with self.subTest(sort=sort):
                query = self.query(sort)
                self.assert_range_plan_and_work(query, tuple(self.ordered(query)[-201]))

    def test_late_toc_seek_matches_month_start_and_uses_range(self):
        for sort in ("newest", "oldest"):
            with self.subTest(sort=sort):
                query = self.query(sort)
                # Keep the real preceding-row cursor that toc() passes to its encoder.
                toc = query.toc(self.db, "fixture", lambda previous: previous, 540)
                full = self.ordered(query)
                bucket = toc["buckets"][-1]
                after = bucket["startCursor"]
                self.assertIsNotNone(after)
                rows = query.page(self.db, 100, after)
                self.assertEqual([row["id"] for row in rows],
                                 [row["id"] for row in full[bucket["startIndex"]:
                                                            bucket["startIndex"] + 100]])
                self.assert_same_results(query, after, 100)
                self.assert_range_plan_and_work(query, after)


class SparseArtistCursorTests(SearchFixture, unittest.TestCase):
    def test_date_bound_preserves_artist_candidate_indexes_and_results(self):
        clause, params = asset_filters.filter_clause(
            asset_filters.Filters(artist="artist:sparse"))
        for sort in ("newest", "oldest"):
            query = asset_list_query.AssetListQuery(
                "visible_assets AS asset", "asset.committed=1" + clause, params,
                sort, prefer_id_lookup=True)
            ids = sorted([f"a{i:06}" for i in range(10)], reverse=sort == "newest")
            after = ("2026-10-01", ids[4])
            sql, bindings = query.select("asset.id", after=after, limit=50)
            old_sql, old_bindings = legacy_select(query, "asset.id", after=after, limit=50)
            plan = "\n".join(row[3] for row in self.db.execute(
                "EXPLAIN QUERY PLAN " + sql, bindings))
            old_plan = "\n".join(row[3] for row in self.db.execute(
                "EXPLAIN QUERY PLAN " + old_sql, old_bindings))
            for index in ("library_artist_keys_by_artist", "library_artist_assignments_by_artist",
                          "library_tag_assets_by_creator", "idx_assets_creator_handle"):
                self.assertIn(index, plan)
            self.assertNotIn("SCAN asset", plan)
            # Some SQLite versions already use a date MULTI-INDEX OR for the old
            # cursor. The redundant bound must not introduce a date-index choice.
            if "idx_assets_mobile_order" not in old_plan:
                self.assertNotIn("idx_assets_mobile_order", plan)
            actual, steps = measured_rows(self.db, sql, bindings)
            expected, old_steps = measured_rows(self.db, old_sql, old_bindings)
            self.assertLess(steps, old_steps * 2)
            self.assertEqual([row["id"] for row in actual], ids[5:])
            self.assertEqual([tuple(row) for row in actual], [tuple(row) for row in expected])
