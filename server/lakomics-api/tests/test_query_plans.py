"""Production-shaped regressions without TestClient, sockets, or production files."""
import tempfile
import unittest
import json
import sqlite3
from fastapi import HTTPException
import read_budget
from pathlib import Path
from unittest.mock import patch

from tools import query_plan_audit as audit


class QueryPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='lakomics-plan-tests-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name)
        # The benchmark boot overrides these; restore them for the rest of discovery.
        cls.patches = [patch.object(audit.bench.api, 'DB_PATH'),
                       patch.object(audit.bench.api, 'API_TOKEN'),
                       patch.object(audit.bench.api.app.router, 'routes', list(audit.bench.api.app.routes)),
                       patch.dict(audit.bench.SIZES)]
        for p in cls.patches:
            p.start()
            cls.addClassCleanup(p.stop)
        tokens = audit.populate(cls.root)
        cls.tokens = tokens
        cls.reports = []
        for stats in (False, True):
            if stats:
                with audit.bench.api.get_db() as db:
                    db.execute('ANALYZE')
            reports, failures = audit.audit(cls.root, tokens, cutoff=2, analyzed=stats)
            if failures:
                raise AssertionError(failures)
            cls.reports.extend(reports)

    def assert_equivalent(self, report):
        """The fixed query must finish and match the old result. A slow host (the
        1-vCPU VPS) may interrupt the OLD pathological query at the cutoff; then
        there is nothing to compare, and that slowness is the defect being fixed."""
        self.assertIsNone(report['error'], report)
        if report['before']['error'] == 'interrupted':
            return
        self.assertTrue(report['identical'], report)

    def test_character_feed_counts_grouping_and_pages_start_with_candidates(self):
        found = []
        for report in self.reports:
            if 'FROM mobile_character_review_items i' not in report['sql']:
                continue
            found.append(report)
            with self.subTest(case=report['case'], sql=report['sql'][:45]):
                loops = [s for s in report['plan'] if s.startswith(('SCAN', 'SEARCH'))]
                self.assertTrue(loops[0].startswith(('SCAN i', 'SEARCH i ')), report['plan'])
                self.assertTrue(all('id=?' in s for s in loops if s.startswith('SEARCH asset ')), loops)
                self.assert_equivalent(report)
        self.assertGreaterEqual(len(found), 18)  # all three shapes, edges and stats
        self.assertTrue(any('GROUP BY i.target_id' in r['sql'] for r in found))
        self.assertTrue(any(r['case'].startswith('edge=0') for r in found))
        self.assertTrue(any(r['case'].startswith('edge=1') for r in found))

    def test_album_page_and_toc_start_with_members(self):
        found = []
        for report in self.reports:
            if 'FROM album_authority_members AS member' not in report['sql']:
                continue
            found.append(report)
            with self.subTest(case=report['case']):
                loops = [s for s in report['plan'] if s.startswith(('SCAN', 'SEARCH'))]
                self.assertTrue(loops[0].startswith('SEARCH member '), report['plan'])
                self.assertIn('album_id=?', loops[0])
                self.assertTrue(all('id=?' in s for s in loops if s.startswith('SEARCH asset ')), loops)
                self.assert_equivalent(report)
        self.assertGreaterEqual(len(found), 12)

    def test_empty_similarity_feed_keeps_both_asset_lookups_inside(self):
        found = [r for r in self.reports if 'FROM mobile_similarity_review_items i' in r['sql']]
        self.assertTrue(found)
        for report in found:
            loops = [s for s in report['plan'] if s.startswith(('SCAN', 'SEARCH'))]
            self.assertTrue(loops[0].startswith(('SCAN i', 'SEARCH i ')), report['plan'])
            self.assertTrue(all('id=?' in s for s in loops if s.startswith('SEARCH asset ')), loops)
            self.assertIsNone(report['error'])

    def test_startup_timestamp_repair_probes_one_assets_trash_history(self):
        found = [r for r in self.reports if r['case'] == 'asset_authority startup lifecycle timestamp migration']
        self.assertEqual(len(found), 2)
        for report in found:
            self.assert_equivalent(report)
            self.assertTrue(any('asset_authority_last_trash (library_id=? AND asset_id=?)' in s
                                for s in report['plan']), report['plan'])
        with audit.bench.api.get_db() as db:
            sql = found[0]['sql'].replace("WHERE lifecycle_changed_at=''", "WHERE asset_id='asset-00050'")
            self.assertEqual(db.execute(sql).fetchone()[0], '2026-09-21T00:00:00Z')

    def test_changed_route_bodies_are_byte_identical(self):
        original = sqlite3.connect

        class OldPlans(sqlite3.Connection):
            def execute(self, sql, parameters=()):
                if ('FROM mobile_character_review_items i' in sql or
                        'FROM album_authority_members AS member' in sql):
                    sql = sql.replace('CROSS JOIN visible_assets', 'JOIN visible_assets')
                return super().execute(sql, parameters)

        def old_connection(*args, **kwargs):
            return original(*args, **{**kwargs, 'factory': OldPlans})

        def body(value):
            return value.body if hasattr(value, 'body') else json.dumps(value, ensure_ascii=False).encode()

        with audit.direct_calls():
            for name, path, params, headers in audit.cases(self.tokens):
                if path not in ('/v1/albums/assets', '/v1/library/characters/review'):
                    continue
                with self.subTest(case=name):
                    after = body(audit.resolve_call(path, params, headers))
                    with patch.object(sqlite3, 'connect', old_connection):
                        before = body(audit.resolve_call(path, params, headers))
                    self.assertEqual(after, before)

    def test_audited_reads_do_not_hit_cutoff(self):
        self.assertGreater(len(self.reports), 400)
        self.assertFalse([r for r in self.reports if r['error']])

    def test_catalog_connections_also_enforce_http_read_budget(self):
        original = read_budget.install
        marker = read_budget.http_read.set(True)
        try:
            with patch.object(read_budget, 'install', side_effect=lambda db: original(db, seconds=0)):
                with self.assertRaises(HTTPException) as raised:
                    with audit.replica.open_publication(self.root / 'mobile-catalog', audit.bench.api.get_db) as (db, _):
                        db.execute('SELECT sum(a.Id*b.Id) FROM catalog.Works a CROSS JOIN catalog.Works b').fetchone()
                self.assertEqual(raised.exception.status_code, 503)
        finally:
            read_budget.http_read.reset(marker)
        # Background publication/refresh reads retain their unbudgeted connection.
        with patch.object(read_budget, 'install') as install:
            with audit.replica.open_publication(self.root / 'mobile-catalog', audit.bench.api.get_db) as (db, _):
                self.assertEqual(db.execute('SELECT COUNT(*) FROM catalog.Works').fetchone()[0], 3000)
            install.assert_not_called()


if __name__ == '__main__':
    unittest.main()
