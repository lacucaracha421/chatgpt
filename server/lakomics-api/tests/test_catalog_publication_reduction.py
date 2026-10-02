"""Socket-free publication/refresh regression tests on disposable catalogs only."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
import uuid
from contextlib import closing, contextmanager
from unittest import mock

import catalog_bookmarks
import catalog_refresh_content as content
import mobile_catalog_replica as replica
from mobile_catalog_refresh import DDL, RefreshWorker
from mobile_catalog_query import freeze_query, search_groups
from tests.test_mobile_catalog import fixture_projection


class DirectCatalogFixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.artifacts = self.root / 'artifacts'
        self.artifacts.mkdir()
        replica.startup(self.get_db)
        catalog_bookmarks.startup(self.get_db)
        with self.get_db() as db:
            db.executescript(DDL)
        self.data, self.digest, self.users = fixture_projection()
        upload = self.root / 'input.ndjson'
        upload.write_bytes(self.data)
        replica.import_content(upload, self.digest, self.artifacts, self.get_db)
        self.publish()

    @contextmanager
    def get_db(self):
        db = sqlite3.connect(self.root / 'control.sqlite')
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    def current(self):
        with self.get_db() as db:
            row = replica.current(db)
            return dict(row) if row else None

    def publish(self, *, additions=(), users=None, interval=0, finalize=None, digest=None):
        prior = self.current()
        return replica.publish({'version': 1, 'baseRevision': prior['revision'] if prior else None,
                                'contentDigest': digest or (prior['content_digest'] if prior else self.digest),
                                'userSnapshot': self.users if users is None else users},
                               self.artifacts, self.get_db, additions=additions,
                               counter_interval=interval, finalize=finalize)

    def observation(self, work_id=3, **updates):
        with replica.open_publication(self.artifacts, self.get_db) as (db, _):
            work = dict(db.execute('SELECT * FROM catalog.Works WHERE Id=?', [work_id]).fetchone())
            tags = [tuple(row) for row in db.execute('SELECT Namespace,Value FROM catalog.Tags WHERE WorkId=?', [work_id])]
        before = {key: work[key] for key in content.MUTABLE_FIELDS}
        return {'work': {**work, **updates}, 'tags': tags, 'before': before, 'update_only': True}

    def worker(self, fetch):
        return RefreshWorker(self.get_db, lambda: self.artifacts, fetch)

    def request(self, worker, language='korean'):
        return worker.request(str(uuid.uuid4()), language)

    def run_fast(self, worker):
        with mock.patch.object(worker.stop, 'wait', return_value=False):
            self.assertTrue(worker.run_once())

    def count_publications(self):
        with self.get_db() as db:
            return db.execute('SELECT COUNT(*) FROM mobile_catalog_publications').fetchone()[0]

    def old_publication(self, seconds=3601):
        with self.get_db() as db:
            db.execute('UPDATE mobile_catalog_publications SET published_at=?',
                       [time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - seconds))])
            db.commit()

    def page(self, language, work_id=1001):
        return json.dumps([{'id': work_id, 'title': f'New {work_id}', 'filecount': 20,
                            'views': 7, 'posted': int(time.time()),
                            'tags': [{'tag': ['language', language]}]}])

    def schedule(self, worker):
        now = time.time()
        self.assertEqual(worker.due(now=now), [])
        return worker.due(now=now + 3600)


class PublicationReductionTests(DirectCatalogFixture, unittest.TestCase):
    def test_no_change_has_no_copy_validation_or_projection_build(self):
        before = self.current()
        files = set(self.artifacts.iterdir())
        with mock.patch.object(content.shutil, 'copyfile', side_effect=AssertionError('unexpected copy')), \
                mock.patch.object(replica, 'count_groups', side_effect=AssertionError('unexpected counts')):
            self.publish(additions=[self.observation()], interval=3600)
        self.assertEqual(self.current(), before)
        self.assertEqual(self.count_publications(), 1)
        self.assertEqual(set(self.artifacts.iterdir()), files)

    def test_views_only_deferred_then_durable_ledger_publishes_after_interval(self):
        row = self.observation(Views=999)
        def save(db, revision):
            db.execute('INSERT INTO mobile_catalog_server_additions VALUES(?,?)', [3, replica.encode(row)])
        before = self.current()
        with mock.patch.object(content.shutil, 'copyfile', side_effect=AssertionError('unexpected copy')):
            self.publish(additions=[row], interval=3600, finalize=save)
        self.assertEqual(self.current(), before)
        self.old_publication()
        self.publish(interval=3600)  # No repeat observation is required.
        self.assertEqual(self.count_publications(), 2)
        with replica.open_publication(self.artifacts, self.get_db) as (db, _):
            self.assertEqual(db.execute('SELECT Views FROM catalog.Works WHERE Id=3').fetchone()[0], 999)

    def test_real_fields_publish_immediately(self):
        for field, value in [('Rating', 4.25), ('FileCount', 321), ('Updated', 1900000000), ('Expunged', 1)]:
            with self.subTest(field=field):
                before = self.current()['revision']
                self.publish(additions=[self.observation(**{field: value})], interval=3600)
                self.assertNotEqual(self.current()['revision'], before)

    def test_counter_threshold_boundary(self):
        row = self.observation(Views=999)
        with self.get_db() as db:
            db.execute("UPDATE mobile_catalog_publications SET published_at='2026-10-02T00:00:00Z'")
            db.commit()
        from datetime import datetime
        epoch = datetime.fromisoformat('2026-10-02T00:00:00+00:00').timestamp()
        with mock.patch.object(content.time, 'time', return_value=epoch + 3599):
            self.publish(additions=[row], interval=3600)
        self.assertEqual(self.count_publications(), 1)
        with mock.patch.object(content.time, 'time', return_value=epoch + 3600):
            self.publish(additions=[row], interval=3600)
        self.assertEqual(self.count_publications(), 2)

    def test_projection_hardlink_when_pages_unchanged(self):
        before = self.current()
        with mock.patch.object(replica, 'count_groups', side_effect=AssertionError('state rebuilt')):
            self.publish(additions=[self.observation(Rating=4.25)])
        old = replica.users_path(self.artifacts, before['revision'])
        new = replica.users_path(self.artifacts, self.current()['revision'])
        self.assertTrue(os.path.samefile(old, new))
        self.assert_projection_matches_fresh()

    def assert_projection_matches_fresh(self):
        current = self.current()
        with self.get_db() as db:
            users = json.loads(db.execute('SELECT payload FROM mobile_catalog_users WHERE revision=?', [current['user_revision']]).fetchone()[0])
        fresh = replica.digest(['fresh-test', current['revision']])
        replica.prepare_users(self.artifacts, current['content_digest'], fresh, users)
        with closing(sqlite3.connect(replica.users_path(self.artifacts, current['revision']))) as actual, \
                closing(sqlite3.connect(replica.users_path(self.artifacts, fresh))) as expected:
            tables = [row[0] for row in actual.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            for table in tables:
                self.assertEqual(actual.execute(f'SELECT * FROM {table} ORDER BY 1,2').fetchall(),
                                 expected.execute(f'SELECT * FROM {table} ORDER BY 1,2').fetchall(), table)

    def test_projection_pages_refreshed_without_rebuilding_state(self):
        before = self.current()
        old = replica.users_path(self.artifacts, before['revision'])
        old_bytes = old.read_bytes()
        with mock.patch.object(replica, 'count_groups', side_effect=AssertionError('state rebuilt')):
            self.publish(additions=[self.observation(Views=999, FileCount=200)])
        new = replica.users_path(self.artifacts, self.current()['revision'])
        self.assertFalse(os.path.samefile(old, new))
        self.assertEqual(old.read_bytes(), old_bytes)
        with replica.open_publication(self.artifacts, self.get_db) as (db, _):
            query = freeze_query(db, {'language': 'korean', 'revealBlocked': False,
                                     'text': '', 'scope': 'all', 'sort': 'latest'})
            self.assertEqual(replica.prepared_items(db, query, 0, 80, replica.prepared_count(db, query)), search_groups(db, query, 0, 80))
        self.assert_projection_matches_fresh()

    def test_changed_user_or_visibility_rebuilds_projection(self):
        for kwargs in ({'users': {**self.users, 'bookmarks': []}},
                       {'additions': [self.observation(Expunged=1)]}):
            with mock.patch.object(replica, 'reuse_users', side_effect=AssertionError('unsafe reuse')):
                self.publish(**kwargs)
            self.assert_projection_matches_fresh()

    def test_offline_comparison_reports_only_actual_fields(self):
        before = replica.artifact_path(self.artifacts, self.current()['content_digest'])
        original = before.read_bytes()
        self.publish(additions=[self.observation(Views=999, Rating=4.25)])
        after = replica.artifact_path(self.artifacts, self.current()['content_digest'])
        report = content.compare_catalogs(before, after)
        self.assertEqual(report['Works'], {'inserted': 0, 'deleted': 0, 'changed': 1,
                                          'fields': {'Views': 1, 'Rating': 1}})
        self.assertEqual(report['Tags']['changed'], 0)
        self.assertEqual(before.read_bytes(), original)
        with self.assertRaises(sqlite3.OperationalError):
            content.compare_catalogs(self.root / 'missing.sqlite', after)
        self.assertFalse((self.root / 'missing.sqlite').exists())

    def test_pc_publication_keeps_full_content_and_user_contract(self):
        records = [json.loads(line) for line in self.data.splitlines()]
        for record in records:
            if record['kind'] == 'work' and record['value']['Id'] == 3:
                record['value']['Views'] = 999
        data = b''.join((replica.encode(record) + '\n').encode() for record in records)
        digest = hashlib.sha256(data).hexdigest()
        path = self.root / 'pc.ndjson'
        path.write_bytes(data)
        replica.import_content(path, digest, self.artifacts, self.get_db)
        self.publish(digest=digest, users={**self.users, 'bookmarks': []})
        self.assertEqual(self.current()['content_digest'], digest)
        self.assert_projection_matches_fresh()

    def test_hardlinked_projection_survives_pruning_and_latest_pc_is_kept(self):
        import prune_catalog_artifacts as prune
        initial = self.current()
        for rating in (1.0, 2.0, 3.0, 4.0):
            self.publish(additions=[self.observation(Rating=rating)])
        self.old_publication(seconds=86400)
        for path in self.artifacts.glob('*.sqlite'):
            os.utime(path, (0, 0))
        result = prune.prune_live(self.artifacts, self.get_db)
        self.assertGreater(result.deleted, 0)
        self.assertFalse(replica.users_path(self.artifacts, initial['revision']).exists())
        self.assertTrue(replica.artifact_path(self.artifacts, self.digest).exists())
        with replica.open_publication(self.artifacts, self.get_db) as (db, _):
            self.assertEqual(db.execute('PRAGMA quick_check').fetchone()[0], 'ok')
            self.assertEqual(db.execute('SELECT Rating FROM catalog.Works WHERE Id=3').fetchone()[0], 4.0)

    def activate_bookmarks(self):
        current = self.current()
        with self.get_db() as db:
            db.execute('BEGIN IMMEDIATE')
            catalog_bookmarks.activate(db, library_id='a' * 32,
                                      expected_revision=current['revision'], bookmarks=[],
                                      baseline_digest=replica.digest([]), current_revision=current['revision'],
                                      now='2026-10-02T00:00:00Z')
            db.commit()

    def test_authority_change_during_reuse_is_fenced(self):
        before = self.current()
        original = replica.reuse_users
        def reuse(*args):
            original(*args)
            self.activate_bookmarks()
        with mock.patch.object(replica, 'reuse_users', side_effect=reuse), self.assertRaises(Exception) as raised:
            self.publish(additions=[self.observation(Rating=4.25)])
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(self.current(), before)
        self.publish(additions=[self.observation(Rating=4.25)])
        self.assert_projection_matches_fresh()
        with replica.open_publication(self.artifacts, self.get_db) as (db, _):
            self.assertEqual(db.execute('SELECT COUNT(*) FROM online_catalog_bookmarks').fetchone()[0], 0)

    def test_pointer_change_during_reuse_is_fenced(self):
        original = replica.reuse_users
        def reuse(*args):
            original(*args)
            self.publish(users={**self.users, 'bookmarks': []})
        with mock.patch.object(replica, 'reuse_users', side_effect=reuse), self.assertRaises(Exception) as raised:
            self.publish(additions=[self.observation(Rating=4.25)])
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(self.count_publications(), 2)
        with replica.open_publication(self.artifacts, self.get_db) as (db, _):
            self.assertIsNone(db.execute('SELECT Rating FROM catalog.Works WHERE Id=3').fetchone()[0])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM online_catalog_bookmarks').fetchone()[0], 0)


class RefreshCycleTests(DirectCatalogFixture, unittest.TestCase):
    def test_two_languages_one_publication_and_duplicate_check(self):
        worker = self.worker(lambda language, cursor: self.page(language, 1001 if language == 'korean' else 1002))
        self.assertEqual(self.schedule(worker), ['korean', 'japanese'])
        self.assertEqual(worker.status()['state'], 'queued')
        with mock.patch.object(worker, 'check_duplicates') as duplicates:
            self.run_fast(worker)
        self.assertEqual(self.count_publications(), 2)
        self.assertEqual({row['work']['Id'] for row in duplicates.call_args.args[1]}, {1001, 1002})
        with self.get_db() as db:
            jobs = db.execute('SELECT state,added,publication_revision FROM mobile_catalog_refresh_jobs').fetchall()
            self.assertEqual([tuple(row) for row in jobs], [('completed', 1, self.current()['revision'])] * 2)
            self.assertEqual(db.execute('SELECT COUNT(DISTINCT next_due) FROM mobile_catalog_refresh_schedule').fetchone()[0], 1)
        self.assert_projection_matches_fresh_for_cycle()

    assert_projection_matches_fresh_for_cycle = PublicationReductionTests.assert_projection_matches_fresh

    def test_staggered_schedules_coalesce(self):
        worker = self.worker(lambda *_: '[]')
        now = time.time()
        worker.due(now=now)
        with self.get_db() as db:
            db.execute("UPDATE mobile_catalog_refresh_schedule SET next_due=next_due+600 WHERE language='japanese'")
            db.commit()
        self.assertEqual(worker.due(now=now + 3600), ['korean', 'japanese'])
        self.run_fast(worker)
        self.assertEqual(self.count_publications(), 1)

    def test_restart_resumes_both_languages_under_one_lease(self):
        calls = []
        def fetch(language, cursor):
            calls.append(language)
            return self.page(language)
        worker = self.worker(fetch)
        self.schedule(worker)
        with mock.patch.object(worker.stop, 'wait', return_value=True):
            worker.run_once()  # Stops after durable Korean page, before Japanese.
        self.assertEqual(self.count_publications(), 1)
        with self.get_db() as db:
            parent = db.execute("SELECT id,owner FROM mobile_catalog_refresh_jobs WHERE state='running'").fetchone()
            db.execute('UPDATE mobile_catalog_refresh_jobs SET lease=0 WHERE id=?', [parent['id']])
            db.commit()
        resumed = self.worker(fetch)
        self.run_fast(resumed)
        self.assertEqual(calls, ['korean', 'japanese'])
        self.assertEqual(self.count_publications(), 2)
        with self.get_db() as db, self.assertRaises(Exception):
            worker.owned(db, parent['id'], parent['owner'])
        with replica.open_publication(self.artifacts, self.get_db) as (db, _):
            self.assertEqual(db.execute("SELECT COUNT(*) FROM catalog.Tags WHERE WorkId=1001 AND Namespace='language'").fetchone()[0], 2)

    def test_second_language_failure_does_not_hold_back_first_language(self):
        worker = self.worker(lambda language, cursor: self.page(language) if language == 'korean' else '{')
        self.schedule(worker)
        self.run_fast(worker)
        self.assertEqual(self.count_publications(), 2)
        with self.get_db() as db:
            self.assertEqual([row[0] for row in db.execute('SELECT state FROM mobile_catalog_refresh_jobs')], ['completed', 'failed'])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM mobile_catalog_refresh_pages').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM mobile_catalog_server_additions').fetchone()[0], 1)
            self.assertEqual([row[0] for row in db.execute('SELECT language FROM mobile_catalog_metadata_streams')], ['korean'])

    def test_failed_parent_language_can_commit_successful_companion(self):
        worker = self.worker(lambda language, cursor: '{' if language == 'korean' else self.page(language))
        self.schedule(worker)
        self.run_fast(worker)
        self.assertEqual(self.count_publications(), 2)
        with self.get_db() as db:
            self.assertEqual([row[0] for row in db.execute('SELECT state FROM mobile_catalog_refresh_jobs')], ['failed', 'completed'])
            self.assertEqual([row[0] for row in db.execute('SELECT language FROM mobile_catalog_metadata_streams')], ['japanese'])

    def test_idle_minute_poll_does_not_open_catalog_files(self):
        worker = self.worker(lambda *_: '[]')
        now = time.time()
        worker.due(now=now)
        with mock.patch.object(worker, 'published_baseline', side_effect=AssertionError('unexpected scan')):
            self.assertEqual(worker.due(now=now + 60), [])

    def test_final_lease_fence_rolls_back_whole_cycle(self):
        worker = self.worker(lambda language, cursor: self.page(language))
        self.schedule(worker)
        original = replica.prepare_users
        def expire(*args):
            original(*args)
            with self.get_db() as db:
                db.execute("UPDATE mobile_catalog_refresh_jobs SET lease=0 WHERE state='running'")
                db.commit()
        with mock.patch.object(replica, 'prepare_users', side_effect=expire):
            self.run_fast(worker)
        self.assertEqual(self.count_publications(), 1)
        with self.get_db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM mobile_catalog_server_additions').fetchone()[0], 0)
        self.run_fast(worker)
        self.assertEqual(self.count_publications(), 2)

    def test_manual_stays_one_language_and_no_change_finishes(self):
        calls = []
        worker = self.worker(lambda language, cursor: calls.append(language) or '[]')
        self.request(worker)
        self.run_fast(worker)
        self.assertEqual(calls, ['korean'])
        self.assertEqual(worker.status()['state'], 'completed')
        self.assertEqual(self.count_publications(), 1)

    def test_refresh_views_deferral_keeps_ledger_and_stream(self):
        row = self.observation(Views=999)['work']
        payload = {'id': 3, 'title': row['Title'], 'views': row['Views'], 'filecount': row['FileCount'],
                   'rating': row['Rating'], 'updated': row['Updated'], 'expunged': row['Expunged'],
                   'posted': int(time.time()), 'tags': [{'tag': ['language', 'korean']}]}
        worker = self.worker(lambda *_: json.dumps([payload]))
        self.request(worker)
        self.run_fast(worker)
        self.assertEqual(self.count_publications(), 1)
        self.assertEqual(worker.status()['state'], 'completed')
        with self.get_db() as db:
            self.assertEqual(json.loads(db.execute('SELECT payload FROM mobile_catalog_server_additions WHERE work_id=3').fetchone()[0])['work']['Views'], 999)
        self.old_publication()
        worker.fetch_page = lambda *_: '[]'
        self.request(worker)
        self.run_fast(worker)
        self.assertEqual(self.count_publications(), 2)
