"""Synthetic query regressions: 100k Assets, 2M memberships, no network I/O."""
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


class SearchPerformanceTests(unittest.TestCase):
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
                           for i in range(100_000)))
        cls.db.commit()
        asset_visibility.install(cls.db)
        library_artists.startup_db(cls.db)
        cls.db.execute("INSERT INTO library_artist_keys VALUES('sparse','artist:sparse')")
        cls.db.commit()
        library_search.startup_db(cls.db)
        cls.db.executemany('INSERT INTO library_tag_vocabulary VALUES(?,?,?)',
                          ((f'tag_{i:04}', f'태그 {i:04}', 'general') for i in range(4000)))
        cls.db.executemany('INSERT INTO library_asset_tags VALUES(?,?)',
                          ((f'a{i:06}', f'tag_{(i * 19 + j) % 4000:04}')
                           for i in range(100_000) for j in range(20)))
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

    def test_suggestions_at_two_million_relations(self):
        for query in ('', 'tag', 'tag_0042', '태그', 'ㅌㄱ', 'no-match'):
            reply, elapsed = self.suggestions(query)
            print(f'suggestions query={query!r}: {elapsed:.2f} ms', flush=True)
            self.assertEqual(reply.status_code, 200)
            self.assertLess(elapsed, 250, 'generous CI bound; local target is <50 ms')

    def test_sparse_artist_page_uses_indexes(self):
        clause, params = asset_filters.filter_clause(asset_filters.Filters(artist='artist:sparse'))
        selection = asset_list_query.AssetListQuery('visible_assets AS asset',
                                                   'asset.committed=1' + clause, params, 'newest',
                                                   prefer_id_lookup=True)
        sql, params = selection.select('asset.*', limit=50)
        plan = '\n'.join(row[3] for row in self.db.execute('EXPLAIN QUERY PLAN ' + sql, params))
        print('artist query plan:\n' + plan, flush=True)
        self.assertIn('library_artist_keys_by_artist', plan)
        self.assertIn('library_artist_assignments_by_artist', plan)
        self.assertIn('library_tag_assets_by_creator', plan)
        self.assertIn('idx_assets_creator_handle', plan)
        self.assertNotIn('SCAN asset', plan)
        self.assertNotIn('idx_assets_mobile_order', plan)
        started = time.perf_counter()
        rows = self.db.execute(sql, params).fetchall()
        elapsed = (time.perf_counter() - started) * 1000
        print(f'sparse artist first page: {elapsed:.2f} ms', flush=True)
        self.assertEqual(len(rows), 10)
        self.assertLess(elapsed, 100, 'generous CI bound; local target is <10 ms')
