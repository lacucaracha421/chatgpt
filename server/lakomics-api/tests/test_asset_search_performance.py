"""Small query-plan contracts; opt-in 100k Asset / 2M membership benchmark."""
import json
import os
import sqlite3
import time
import unittest
from contextlib import contextmanager

from fastapi import FastAPI

import asset_filters
import asset_list_query
import asset_visibility
import asset_authority
import authority
import library_artists
import library_search


class SearchFixture:
    asset_count = 100
    tag_count = 64

    @classmethod
    def setUpClass(cls):
        cls.db = sqlite3.connect(':memory:')
        cls.db.row_factory = sqlite3.Row
        cls.db.executescript("""
            CREATE TABLE assets(id TEXT PRIMARY KEY, committed INTEGER, creator_handle TEXT,
                collected_at TEXT, created_at TEXT);
            CREATE INDEX idx_assets_committed ON assets(committed);
            CREATE INDEX idx_assets_mobile_order ON assets(committed,COALESCE(collected_at,created_at) DESC,id DESC);
        """)
        cls.db.executescript(authority.AUTHORITY_DDL + asset_authority.DDL)
        cls.db.executemany('INSERT INTO assets VALUES(?,1,?,?,?)',
                          ((f'a{i:06}', 'sparse' if i < 10 else 'other', '2026-10-01', '2026-10-01')
                           for i in range(cls.asset_count)))
        cls.db.commit()
        asset_visibility.install(cls.db)
        library_artists.startup_db(cls.db)
        cls.db.execute("INSERT INTO library_artist_keys VALUES('sparse','artist:sparse')")
        cls.db.commit()
        library_search.startup_db(cls.db)
        cls.db.executemany('INSERT INTO library_tag_vocabulary VALUES(?,?,?)',
                          ((f'tag_{i:04}', f'태그 {i:04}', 'general') for i in range(cls.tag_count)))
        cls.db.executemany('INSERT INTO library_asset_tags VALUES(?,?)',
                          ((f'a{i:06}', f'tag_{(i * 19 + j) % cls.tag_count:04}')
                           for i in range(cls.asset_count) for j in range(20)))
        cls.db.commit()
        library_search.startup_db(cls.db)
        cls.db.commit()

    @classmethod
    def tearDownClass(cls):
        cls.db.close()

    def suggestions(self, query):
        @contextmanager
        def get_db():
            yield self.db
        app = FastAPI()
        library_search.register(app, get_db, lambda _: None, lambda _: None)
        endpoint = next(route.endpoint for route in app.routes
                        if route.path == '/v1/library/search/suggestions')
        self.db.rollback()
        started = time.perf_counter()
        reply = endpoint(text=query, limit=10, authorization=None, if_none_match=None)
        elapsed = (time.perf_counter() - started) * 1000
        self.db.rollback()
        return reply, elapsed

    def sparse_artist_query(self):
        clause, params = asset_filters.filter_clause(asset_filters.Filters(artist='artist:sparse'))
        selection = asset_list_query.AssetListQuery('visible_assets AS asset',
                                                   'asset.committed=1' + clause, params, 'newest',
                                                   prefer_id_lookup=True)
        return selection.select('asset.*', limit=50)

    def assert_artist_indexes(self, sql, params):
        plan = '\n'.join(row[3] for row in self.db.execute('EXPLAIN QUERY PLAN ' + sql, params))
        print('artist query plan:\n' + plan, flush=True)
        self.assertIn('library_artist_keys_by_artist', plan)
        self.assertIn('library_artist_assignments_by_artist', plan)
        self.assertIn('library_tag_assets_by_creator', plan)
        self.assertIn('idx_assets_creator_handle', plan)
        self.assertNotIn('SCAN asset', plan)
        self.assertNotIn('idx_assets_mobile_order', plan)
        self.assertIn('idx_assets_committed_id', plan)


class SearchQueryPlanTests(SearchFixture, unittest.TestCase):
    def test_suggestions_use_indexed_counts_without_scanning_memberships(self):
        for query in ('', 'tag', 'tag_0042', '태그', 'ㅌㄱ', 'no-match'):
            with self.subTest(query=query):
                statements = []
                self.db.set_trace_callback(statements.append)
                try:
                    reply, _ = self.suggestions(query)
                finally:
                    self.db.set_trace_callback(None)
                self.assertEqual(reply.status_code, 200)
                items = json.loads(reply.body)['items']
                self.assertEqual(len(items), 0 if query == 'no-match' else 1 if query == 'tag_0042' else 10)
                if query == 'tag_0042':
                    self.assertEqual(items[0]['id'], 'tag_0042')
                for item in items:
                    expected = sum((i * 19 + j) % self.tag_count == int(item['id'][4:])
                                   for i in range(self.asset_count) for j in range(20))
                    self.assertEqual(item['count'], expected)
                # Trace the real endpoint SQL, not a hand-copied query that could drift.
                selects = [sql for sql in statements if sql.lstrip().upper().startswith('SELECT')]
                self.assertEqual(len(selects), 1, statements)
                plan = '\n'.join(row[3] for row in self.db.execute('EXPLAIN QUERY PLAN ' + selects[0]))
                self.assertIn('SEARCH c USING INDEX sqlite_autoindex_library_tag_counts_1', plan)
                self.assertNotIn('library_asset_tags', selects[0])
                self.assertNotIn('visible_assets', selects[0])

    def test_sparse_artist_page_uses_indexes(self):
        sql, params = self.sparse_artist_query()
        self.assert_artist_indexes(sql, params)
        rows = self.db.execute(sql, params).fetchall()
        self.assertEqual([row['id'] for row in rows], [f'a{i:06}' for i in reversed(range(10))])


@unittest.skipUnless(os.environ.get('LAKOMICS_PERF') == '1', 'set LAKOMICS_PERF=1 for the large benchmark')
class SearchPerformanceTests(SearchFixture, unittest.TestCase):
    asset_count = 100_000
    tag_count = 4000

    def test_suggestions_at_two_million_relations(self):
        for query in ('', 'tag', 'tag_0042', '태그', 'ㅌㄱ', 'no-match'):
            reply, elapsed = self.suggestions(query)
            print(f'suggestions query={query!r}: {elapsed:.2f} ms', flush=True)
            self.assertEqual(reply.status_code, 200)
            self.assertLess(elapsed, 250, 'benchmark bound; local target is <50 ms')

    def test_sparse_artist_page_uses_indexes(self):
        sql, params = self.sparse_artist_query()
        self.assert_artist_indexes(sql, params)
        started = time.perf_counter()
        rows = self.db.execute(sql, params).fetchall()
        elapsed = (time.perf_counter() - started) * 1000
        print(f'sparse artist first page: {elapsed:.2f} ms', flush=True)
        self.assertEqual(len(rows), 10)
        self.assertLess(elapsed, 100, 'benchmark bound; local target is <10 ms')
