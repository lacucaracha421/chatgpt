"""Retention, streaming observations and reclaim scheduling without sockets/R2."""
import json
import sqlite3
import threading
import unittest
from unittest import mock

from fastapi import FastAPI
from app_lifecycle import lifecycle
from tests.test_capture_api_stub import fake_s3  # Offline R2 import boundary.
import capture_routes as capture
import catalog_refresh_content as content
import mobile_catalog_refresh as refresh
import mobile_catalog_replica as replica
from tests import test_capture_orphan_reclaim as reclaim_fixture
from tests.test_catalog_publication_reduction import DirectCatalogFixture


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:'); self.addCleanup(self.db.close)
        self.db.executescript(refresh.DDL)
        self.now = 10_000_000
        self.cutoff = self.now - refresh.HISTORY_RETENTION_SECONDS

    def job(self, name, *, state='completed', updated=1, language='korean'):
        self.db.execute('''INSERT INTO mobile_catalog_refresh_jobs
            (id,language,state,created,updated,watermark,pending_max,page_limit)
            VALUES(?,?,?,?,?,1,1,1)''', [name, language, state, updated, updated])
        self.db.execute('INSERT INTO mobile_catalog_refresh_pages VALUES(?,1,?)', [name, '{}'])
        self.db.execute('INSERT INTO mobile_catalog_metadata_jobs(job_id) VALUES(?)', [name])

    def prune(self, **kwargs):
        self.db.commit(); self.db.execute('BEGIN IMMEDIATE')
        return refresh.prune_history(self.db, now=self.now, **kwargs)

    def ids(self):
        return {r[0] for r in self.db.execute('SELECT id FROM mobile_catalog_refresh_jobs')}

    def test_cutoff_active_receipts_latest_and_batch_references(self):
        for name in ('old', 'failed', 'receipt', 'parent', 'child', 'protected-parent', 'protected-child'):
            self.job(name, state='failed' if name == 'failed' else 'completed')
        self.job('running', state='running')
        self.job('batched', state='batched')
        self.job('boundary', updated=self.cutoff)
        self.job('recent', updated=self.now - 1)
        self.job('latest', updated=self.now)
        self.job('latest-japanese', language='japanese')
        self.db.executemany('INSERT INTO mobile_catalog_refresh_batches VALUES(?,?)',
                            [('parent','child'),('protected-parent','protected-child')])
        self.db.executemany('INSERT INTO mobile_catalog_refresh_receipts VALUES(?,?,?)',
                            [('operation-1','korean','receipt'),('operation-2','korean','protected-child')])
        self.assertEqual(self.prune(), 4)
        self.assertEqual(self.ids(), {'receipt','protected-parent','protected-child','running','batched',
                                     'boundary','recent','latest','latest-japanese'})
        for table in ('mobile_catalog_refresh_pages','mobile_catalog_metadata_jobs'):
            self.assertEqual({r[0] for r in self.db.execute(f'SELECT job_id FROM {table}')}, self.ids())
        self.assertEqual(list(self.db.execute('SELECT * FROM mobile_catalog_refresh_batches')),
                         [('protected-parent','protected-child')])
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM mobile_catalog_refresh_receipts').fetchone()[0], 2)

    def test_whole_family_and_per_pass_bound_and_transaction_rollback(self):
        self.job('p'); self.job('c'); self.job('latest', updated=self.now)
        self.db.execute("INSERT INTO mobile_catalog_refresh_batches VALUES('p','c')")
        self.assertEqual(self.prune(limit=1), 0)
        self.assertEqual(self.prune(limit=2), 2)
        self.db.rollback(); self.assertEqual(self.ids(), {'p','c','latest'})
        for i in range(150):
            self.job(f'old-{i}')
        self.assertEqual(self.prune(), 100)
        self.assertEqual(len(self.ids()), 53)

    def test_worker_runs_retention_only_when_due(self):
        worker = refresh.RefreshWorker(None, None, None)
        worker.stop = mock.Mock()
        worker.stop.is_set.side_effect = [False, False, True]
        with mock.patch.object(refresh.time, 'monotonic', side_effect=[0, 0, 1, 3601, 3601, 3601]), \
                mock.patch.object(worker, 'run_once', return_value=False), \
                mock.patch.object(worker, 'prune_history') as prune, \
                mock.patch.object(worker, 'due'), mock.patch.object(worker.wake, 'wait'):
            worker.loop()
        prune.assert_called_once_with()


class LedgerTests(DirectCatalogFixture, unittest.TestCase):
    def test_stream_merge_matches_previous_full_merge(self):
        saved = [self.observation(i, Views=100) for i in (1, 3, 5)]
        fresh = [self.observation(i, Views=99) for i in (2, 3, 4)]
        saved[1]['update_only'] = False
        fresh[1]['tags'].append(('language','japanese'))
        fresh.append(self.observation(3, Views=101))
        with self.get_db() as db:
            db.executemany('INSERT INTO mobile_catalog_server_additions VALUES(?,?)',
                           [(r['work']['Id'], replica.encode(r)) for r in saved]); db.commit()
            expected = {r['work']['Id']: json.loads(replica.encode(r)) for r in saved}
            for row in fresh:
                key = row['work']['Id']; expected[key] = content.merge_observation(expected.get(key), row)
            # Streaming must never call fetchall, including for an empty fresh set.
            class StreamingDB:
                def execute(self, *args):
                    return iter(db.execute(*args))
            actual = list(content.iter_observations(StreamingDB(), fresh))
            self.assertEqual(actual, sorted(expected.items()))
            self.assertEqual(len(list(content.iter_observations(StreamingDB(), ()))), 3)

    def test_unchanged_ledger_is_noop_and_changed_rows_keep_digest(self):
        saved = [self.observation(i) for i in (1, 2, 3)]
        with self.get_db() as db:
            db.executemany('INSERT INTO mobile_catalog_server_additions VALUES(?,?)',
                           [(r['work']['Id'], replica.encode(r)) for r in saved]); db.commit()
        with mock.patch.object(content.shutil, 'copyfile', side_effect=AssertionError('no copy')):
            self.assertEqual(content.materialize(self.artifacts, self.digest, self.get_db), self.digest)
        fresh = self.observation(3, Views=10000, Rating=4.8)
        merged = content.merge_observation(json.loads(replica.encode(saved[2])), fresh)
        expected = replica.digest(['server-catalog-observations-v2', self.digest,
                                   [(merged, True, [], {'Views': 10000, 'Rating': 4.8})]])
        actual = content.materialize(self.artifacts, self.digest, self.get_db, [fresh])
        self.assertEqual(actual, expected)
        with sqlite3.connect(replica.artifact_path(self.artifacts, actual)) as db:
            self.assertEqual(db.execute('SELECT Views,Rating FROM Works WHERE Id=3').fetchone(), (10000, 4.8))


class ReclaimScheduleTests(unittest.TestCase):
    def test_registration_does_not_access_storage_and_joins_lifecycle(self):
        app = FastAPI(); services = mock.Mock()
        with mock.patch.object(capture, 'reclaim_orphaned_inbox') as reclaim, \
                mock.patch.object(capture, 'api', create=True):
            capture.register(app, services)
        reclaim.assert_not_called()
        worker = app.state.capture_reclaimer
        self.assertIn(worker.start, lifecycle(app).startup_handlers)
        self.assertIn(worker.stop, lifecycle(app).shutdown_handlers)

    def test_delayed_hourly_small_pages_cursor_and_error_retry(self):
        worker = capture.InboxReclaimer(None)
        worker.stop_event = mock.Mock()
        worker.stop_event.is_set.return_value = False
        worker.stop_event.wait.side_effect = [False, False, False, True]
        result = {'cursor': {'images/inbox/': 'next'}}
        with mock.patch.object(capture, 'reclaim_orphaned_inbox', side_effect=[result, RuntimeError(), result]) as reclaim:
            worker.loop()
        self.assertEqual([c.args[0] for c in worker.stop_event.wait.call_args_list], [300,3600,3600,3600])
        self.assertEqual(reclaim.call_count, 3)
        self.assertEqual(reclaim.call_args_list[0].kwargs['limit'], 5)
        self.assertEqual(reclaim.call_args_list[1].kwargs['cursor'], result['cursor'])
        self.assertIs(reclaim.call_args.kwargs['stop_event'], worker.stop_event)
        worker.stop_event.is_set.return_value = True
        with mock.patch.object(capture, 'reclaim_orphaned_inbox') as reclaim:
            worker.run_once()
        reclaim.assert_not_called()

    def test_stop_signals_all_workers_before_shared_deadline_join(self):
        app = FastAPI(); hooks = lifecycle(app); workers = [capture.InboxReclaimer(None) for _ in range(2)]
        budgets = []
        for worker in workers:
            worker.thread = mock.Mock()
            worker.thread.is_alive.return_value = False
            def join(timeout):
                self.assertTrue(all(w.stop_event.is_set() for w in workers))
                budgets.append(timeout)
            worker.thread.join.side_effect = join
            hooks.on_shutdown(worker.stop)
        async def inline_join(fn):
            fn()
        # Drive the lifecycle coroutine without creating an event loop/socketpair.
        with mock.patch('app_lifecycle.asyncio.to_thread', side_effect=inline_join):
            coroutine = hooks._shutdown_workers()
            with self.assertRaises(StopIteration):
                coroutine.send(None)
        self.assertEqual(len(budgets), 2)
        self.assertTrue(0 <= budgets[1] <= budgets[0] <= 6)

    def test_start_is_idempotent_and_idle_stop_is_prompt(self):
        worker = capture.InboxReclaimer(None)
        try:
            worker.start(); first = worker.thread; worker.start()
            self.assertIs(worker.thread, first)
        finally:
            worker.stop()
        self.assertFalse(first.is_alive())


class ReclaimStopTests(unittest.TestCase):
    setUp = reclaim_fixture.OrphanReclaimTests.setUp
    get_db = reclaim_fixture.OrphanReclaimTests.get_db
    object = reclaim_fixture.OrphanReclaimTests.object
    reclaim = reclaim_fixture.OrphanReclaimTests.reclaim

    def test_stop_before_listing_or_between_deletions(self):
        event = threading.Event(); event.set()
        self.assertEqual(self.reclaim(stop_event=event)['scanned'], 0)
        self.assertEqual(self.storage.listed, [])
        event.clear(); self.object(1); self.object(2)
        self.storage.before_delete = event.set
        self.assertEqual(self.reclaim(stop_event=event)['deleted'], 1)
        self.assertEqual(len(self.storage.listed), 1)


if __name__ == '__main__':
    unittest.main()
