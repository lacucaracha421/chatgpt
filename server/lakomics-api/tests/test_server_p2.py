"""Socket-free P2 read-path checks on synthetic SQLite data."""
import copy
from contextlib import contextmanager
import datetime
import sqlite3
import unittest
from unittest import mock

from fastapi import FastAPI
from starlette.responses import JSONResponse
import asset_visibility
import collection_authority as collections
import library_search as search
import mobile_catalog_suggestions as suggestions
import mobile_collections


class CollectionBatchTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript('''
            CREATE TABLE assets(id TEXT PRIMARY KEY, committed INTEGER);
            CREATE TABLE authority_domains(library_id TEXT, domain TEXT);
            CREATE TABLE asset_authority_state(library_id TEXT,asset_id TEXT,lifecycle TEXT);
            CREATE TABLE collection_authority_members(library_id TEXT,work_id TEXT,asset_id TEXT,
                desired_state INTEGER,added_at TEXT,PRIMARY KEY(library_id,work_id,asset_id));
            INSERT INTO authority_domains VALUES('lib','assets');
        ''')
        self.items = []
        for i in range(48):
            work = f'w{i}'
            for j, (committed, state) in enumerate(((1, 'normal'), (1, 'normal'), (1, 'trash'),
                                                   (0, 'normal'), (1, 'tombstoned'), (1, 'normal'))):
                asset = f'{work}-{j}'
                self.db.execute('INSERT INTO assets VALUES(?,?)', [asset, committed])
                self.db.execute('INSERT INTO asset_authority_state VALUES(?,?,?)', ['lib', asset, state])
                self.db.execute('INSERT INTO collection_authority_members VALUES(?,?,?,?,?)',
                                ['lib', work, asset, int(j != 5), 'same'])
            self.db.execute('INSERT INTO collection_authority_members VALUES(?,?,?,?,?)',
                            ['other', work, f'{work}-5', 1, 'earlier'])
            self.items.append({'id': work, 'coverAssetId': f'{work}-{i % 6}', 'assetCount': 99,
                               'artworks': [], 'volumes': [{'localReleaseDate': '2100-01-01'}]})
        asset_visibility.install(self.db)

    def legacy(self, item):
        members = [r[0] for r in self.db.execute('''SELECT m.asset_id FROM collection_authority_members m
            JOIN visible_assets a ON a.id=m.asset_id AND a.committed=1
            WHERE m.library_id='lib' AND m.work_id=? AND m.desired_state=1 ORDER BY m.added_at,m.asset_id''', [item['id']])]
        item['assetCount'] = len(members)
        item['coverAssetId'] = item['coverAssetId'] if item['coverAssetId'] in set(members) else (members[0] if members else None)
        return item

    def test_48_item_page_byte_identity_three_queries_and_no_dates(self):
        for active in (True, False):
            if not active:
                self.db.execute('DELETE FROM authority_domains')
            expected = [mobile_collections.public_item(self.legacy(copy.deepcopy(item))) for item in self.items]
            queries = []
            self.db.set_trace_callback(queries.append)
            with mock.patch.object(collections.datetime, 'datetime') as dates:
                actual = collections.finalize_items(self.db, 'lib', copy.deepcopy(self.items))
            self.db.set_trace_callback(None)
            dates.strptime.assert_not_called()
            self.assertEqual(JSONResponse([mobile_collections.public_item(i) for i in actual]).body,
                             JSONResponse(expected).body)
            self.assertEqual(len(queries), 3)

    def test_missing_members_missing_assets_and_detail_dates(self):
        item = copy.deepcopy(self.items[0]); item['id'] = 'missing'
        item['volumes'] = [{'localReleaseDate': v} for v in ('2026-01-01', '2026-01-02', 'bad', None)]
        collections.finalize_item(self.db, 'lib', item, today=datetime.date(2026, 1, 1))
        self.assertEqual((item['assetCount'], item['coverAssetId']), (0, None))
        self.assertEqual([v['releaseStatus'] for v in item['volumes']], ['released', 'upcoming', None, None])
        self.db.execute('DROP VIEW visible_assets'); self.db.execute('DROP TABLE assets')
        self.assertEqual(collections.finalize_items(self.db, 'lib', [copy.deepcopy(item)])[0]['assetCount'], 0)
        self.assertEqual(collections.finalize_items(self.db, 'lib', []), [])


class SuggestionInputTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:'); self.addCleanup(self.db.close)
        self.db.executescript('''ATTACH ':memory:' AS catalog;
            CREATE TABLE catalog.Tags(WorkId INTEGER,Namespace TEXT,Value TEXT);
            CREATE TABLE catalog.Translations(namespace TEXT,value TEXT,label TEXT);
            CREATE TABLE online_catalog_blocked_tags(namespace TEXT,value TEXT);
            CREATE TABLE unrelated(value TEXT);
            INSERT INTO catalog.Tags VALUES(1,'artist','foo'),(2,'artist','foo'),(3,'general','bar');
            INSERT INTO catalog.Translations VALUES('artist','foo','푸');''')
        self.cache = suggestions.SuggestionCache()

    def test_unrelated_publications_reuse_same_object(self):
        first = self.cache.index('r1', self.db)
        self.db.execute("INSERT INTO unrelated VALUES('bookmark or metadata')")
        self.assertIs(first, self.cache.index('r2', self.db))
        self.db.execute("INSERT INTO online_catalog_blocked_tags VALUES('artist','absent')")
        self.assertIs(first, self.cache.index('r3', self.db))
        self.assertEqual(self.cache.builds, 1)

    def test_counts_translation_blocking_and_deletion_invalidate(self):
        first = self.cache.index('initial', self.db)
        for rev, sql in enumerate(("INSERT INTO catalog.Tags VALUES(4,'general','bar')",
                                  "UPDATE catalog.Translations SET label='새 번역'",
                                  "INSERT INTO online_catalog_blocked_tags VALUES('artist','foo')",
                                  "DELETE FROM catalog.Tags WHERE Value='bar'")):
            self.db.execute(sql)
            actual = self.cache.index(str(rev), self.db)
            self.assertEqual(actual, suggestions.build_index(self.db))
            self.assertEqual(self.cache.builds, rev + 2)
        self.assertEqual(suggestions.match(actual, 'foo', 10), [])
        self.assertEqual(len(suggestions.match(actual, 'foo', 10, reveal_blocked=True)), 1)
        self.db.execute("DELETE FROM online_catalog_blocked_tags")
        self.assertEqual(self.cache.index('initial', self.db), suggestions.build_index(self.db))
        self.assertNotEqual(first, actual)


class LibraryAggregateTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:'); self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.executescript('''CREATE TABLE assets(id TEXT PRIMARY KEY,committed INTEGER,creator_handle TEXT);
            INSERT INTO assets VALUES('visible',1,NULL),('hidden',0,NULL);''')
        search.startup_db(self.db)
        self.db.executemany('INSERT INTO library_tag_vocabulary VALUES(?,?,?)',
                           [('long_hair', '긴 머리', 'general'), ('glasses', '안경', 'general')])
        self.db.executemany('INSERT INTO library_asset_tags VALUES(?,?)',
                           [('visible','long_hair'),('hidden','long_hair'),('visible','glasses')])
        self.db.commit()

    def restart(self):
        statements = []; before = self.db.total_changes
        self.db.set_trace_callback(statements.append); search.startup_db(self.db)
        self.db.set_trace_callback(None)
        return self.db.total_changes - before, statements

    def assert_rebuilt(self):
        self.assertIn('DELETE FROM library_tag_counts', self.restart()[1])
        self.assertEqual(dict(self.db.execute('SELECT tag_id,count FROM library_tag_counts')),
                         {'glasses': 1, 'long_hair': 1})
        self.assertEqual(self.restart()[0], 0)

    def test_healthy_restart_has_no_data_writes(self):
        self.assertEqual(self.restart()[0], 0)

    def test_missing_version_version_bump_empty_counts_or_visibility_rebuild(self):
        for sql in ('DELETE FROM library_tag_aggregate_state', 'UPDATE library_tag_aggregate_state SET version=0',
                    'DELETE FROM library_tag_counts', 'DELETE FROM library_tag_visibility'):
            self.db.execute(sql); self.db.commit(); self.assert_rebuilt()

    def test_missing_or_obsolete_trigger_rebuilds_and_rollback_keeps_counts(self):
        for obsolete in (False, True):
            self.db.execute('DROP TRIGGER tag_asset_update')
            if obsolete:
                self.db.execute('CREATE TRIGGER tag_asset_update AFTER UPDATE ON assets BEGIN SELECT 1; END')
            self.db.commit(); self.assert_rebuilt()
        self.db.execute("UPDATE assets SET committed=0 WHERE id='visible'")
        self.assertEqual(dict(self.db.execute('SELECT tag_id,count FROM library_tag_counts')), {'glasses': 0, 'long_hair': 0})
        self.db.rollback(); self.assertEqual(self.restart()[0], 0)

    def test_authority_schema_added_later_updates_trigger_predicate(self):
        self.db.executescript('''CREATE TABLE authority_domains(library_id TEXT,domain TEXT);
            CREATE TABLE asset_authority_state(library_id TEXT,asset_id TEXT,lifecycle TEXT);
            INSERT INTO authority_domains VALUES('lib','assets');
            INSERT INTO asset_authority_state VALUES('lib','visible','trash');''')
        self.restart()
        self.assertEqual(dict(self.db.execute('SELECT tag_id,count FROM library_tag_counts')), {})
        self.db.execute("UPDATE asset_authority_state SET lifecycle='normal'")
        self.assertEqual(dict(self.db.execute('SELECT tag_id,count FROM library_tag_counts')), {'glasses': 1, 'long_hair': 1})
        self.db.commit(); self.assertEqual(self.restart()[0], 0)

    def test_top_n_and_endpoint_bytes_match_full_sort(self):
        self.db.executemany('INSERT INTO library_tag_vocabulary VALUES(?,?,?)',
                           [(f'tag_{i}', ('긴머리' if i % 2 else 'Glasses') + str(i),
                             ('general', 'character', 'artist', 'meta', 'rating')[i % 5]) for i in range(1000)])
        self.db.executemany('INSERT INTO library_tag_counts VALUES(?,?)', [(f'tag_{i}', i % 13) for i in range(1000)])
        self.db.commit(); app = FastAPI()
        @contextmanager
        def get_db():
            try:
                yield self.db
            finally:
                self.db.rollback()
        search.register(app, get_db, lambda _: None, lambda _: None)
        endpoint = next(r.endpoint for r in app.routes if r.path.endswith('/search/suggestions'))
        rows = self.db.execute("SELECT v.tag_id,v.label,v.category,c.count FROM library_tag_vocabulary v "
                               "JOIN library_tag_counts c ON c.tag_id=v.tag_id WHERE c.count>0 "
                               "AND v.category NOT IN ('artist','meta','rating')").fetchall()
        for text in ('', 'tag', 'Glasses', 'ㅂ', 'ㄱㅁㄹ', '긴 머리', 'long_hair', 'absent'):
            for limit in (1, 10, 20):
                needle = search.normalize(text)
                ranked = [(rank, -row['count'], row['tag_id'], row) for row in rows
                          if (rank := (search.match_rank(needle, row['tag_id'], row['label']) if needle else 1)) is not None]
                ranked.sort(key=lambda i: i[:3])
                expected = [{'kind': 'tag', 'id': row['tag_id'], 'label': row['label'],
                             'category': row['category'], 'count': row['count']} for *_, row in ranked[:limit]]
                self.assertEqual(search.suggestion_items(self.db, needle, limit), expected)
                response = endpoint(text=text, limit=limit, authorization=None, if_none_match=None)
                self.assertEqual(response.body, search.conditional.json_response(
                    {'version': 1, 'text': text, 'limit': limit, 'items': expected}, None).body)
                self.assertEqual(endpoint(text=text, limit=limit, authorization=None,
                                          if_none_match=response.headers['etag']).status_code, 304)


if __name__ == '__main__':
    unittest.main()
