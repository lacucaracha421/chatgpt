"""Hourly scheduling uses existing bounded jobs, never a second ingestion path."""
import json
import time
import unittest
from unittest import mock

from tests import test_mobile_catalog_refresh as base

page = base.page
from mobile_catalog_refresh import RefreshWorker, REFRESH_INTERVAL_SECONDS as HOUR
from tests.test_catalog_publication_reduction import DirectCatalogFixture


class ScheduleTests(DirectCatalogFixture, unittest.TestCase):
    def revision(self):
        return self.current()["revision"]

    def setup_schedule(self):
        worker = self.worker(lambda *_: page([]))
        now = time.time()
        self.assertEqual(worker.due(now=now), [])
        self.assertIsNone(worker.status())
        return worker, now

    def test_first_adoption_waits_hour_then_both_languages_run_without_starvation(self):
        worker, now = self.setup_schedule()
        self.assertEqual(worker.due(now=now + HOUR - 1), [])
        self.assertEqual(worker.due(now=now + HOUR), ['korean', 'japanese'])
        with self.get_db() as db:
            japanese_due = db.execute("SELECT next_due FROM mobile_catalog_refresh_schedule WHERE language='japanese'").fetchone()[0]
        self.assertEqual(worker.due(now=now + HOUR + 1), [])
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT next_due FROM mobile_catalog_refresh_schedule WHERE language='japanese'").fetchone()[0], japanese_due)
        worker.run_once()
        self.assertEqual(worker.due(now=time.time()), [])
        self.assertFalse(worker.run_once())
        self.assertEqual(worker.status()['state'], 'completed')

    def test_restart_and_multiple_pollers_keep_one_job_and_no_receipts(self):
        worker, now = self.setup_schedule()
        other = RefreshWorker(self.get_db, worker.root, worker.fetch_page)
        self.assertEqual(other.due(now=now + HOUR - 1), [])
        self.assertEqual(other.due(now=now + HOUR), ['korean', 'japanese'])
        self.assertEqual(worker.due(now=now + HOUR), [])
        with self.get_db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM mobile_catalog_refresh_jobs').fetchone()[0], 2)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM mobile_catalog_refresh_receipts').fetchone()[0], 0)

    def test_partial_checkpoint_is_resumed_not_reset(self):
        worker, now = self.setup_schedule()
        with self.get_db() as db:
            db.execute("INSERT INTO mobile_catalog_refresh_streams VALUES('korean',6,3951,4000)")
            db.commit()
        self.assertEqual(worker.due(now=now + HOUR), ['korean', 'japanese'])
        with self.get_db() as db:
            row = db.execute('SELECT watermark,cursor,pending_max FROM mobile_catalog_refresh_jobs').fetchone()
            self.assertEqual(tuple(row), (6, 3951, 4000))
        calls = []
        worker.fetch_page = lambda language, cursor: calls.append(cursor) or page([])
        worker.run_once()
        # The incremental lane resumes; the independent metadata sweep starts
        # at the head once that lane completes.
        self.assertEqual(calls, [3951, None, None])

    def test_recent_manual_or_failed_attempt_defers_its_own_language(self):
        worker, now = self.setup_schedule()
        worker.fetch_page = lambda *_: '{'
        self.request(worker)
        with mock.patch('mobile_catalog_refresh.time.time', return_value=now + 100):
            worker.run_once()
        self.assertEqual(worker.status()['state'], 'failed')
        self.assertEqual(worker.due(now=now + HOUR, languages=('korean',)), [])
        self.assertEqual(worker.due(now=now + HOUR + 99, languages=('korean',)), [])
        self.assertEqual(worker.due(now=now + HOUR + 100, languages=('korean',)), ['korean'])

    def test_missing_language_is_not_started_and_late_publication_is_armed(self):
        worker = self.worker(lambda *_: page([]))
        now = time.time()
        actual = worker.published_baseline
        with mock.patch.object(worker, 'published_baseline', return_value=(None, None)):
            self.assertEqual(worker.due(now=now), [])
        with self.get_db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM mobile_catalog_refresh_schedule').fetchone()[0], 0)
        with mock.patch.object(worker, 'published_baseline', side_effect=actual):
            self.assertEqual(worker.due(now=now + 10), [])
        self.assertIsNone(worker.status())
        self.assertEqual(worker.due(now=now + 10 + HOUR), ['korean', 'japanese'])

    def test_zero_watermark_does_not_start_historical_language_scan(self):
        worker, now = self.setup_schedule()
        with self.get_db() as db:
            db.execute("INSERT INTO mobile_catalog_refresh_streams VALUES('korean',0,3951,4000)")
            db.commit()
        self.assertEqual(worker.due(now=now + HOUR, languages=('korean',)), [])
        self.assertIsNone(worker.status())

    def test_unchanged_metadata_still_uses_one_provider_page_and_same_revision(self):
        calls = []
        worker, now = self.setup_schedule()
        rows = json.loads(page([3]))
        rows[0].update(filecount=120, views=50, rating=None, posted=int(now))
        worker.fetch_page = lambda language, cursor: calls.append((language, cursor)) or (json.dumps(rows) if language == 'korean' else '[]')
        old_revision = self.revision()
        self.assertEqual(worker.due(now=now + HOUR), ['korean', 'japanese'])
        worker.run_once()
        self.assertEqual(calls, [('korean', None), ('japanese', None)])
        self.assertEqual(worker.status()['added'], 0)
        self.assertEqual(self.revision(), old_revision)
