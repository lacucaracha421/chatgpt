"""Aged capture originals only; reference checks and bounded resumable listings."""
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tests.test_capture_api_stub import fake_s3  # noqa: F401
from capture_routes import reclaim_orphaned_inbox


class Storage:
    def __init__(self):
        self.objects = {}
        self.deleted = []
        self.listed = []
        self.failure = None
        self.before_delete = None

    def list_objects_v2(self, *, Bucket, Prefix, MaxKeys, StartAfter=''):
        self.listed.append((Prefix, MaxKeys, StartAfter))
        keys = sorted(key for key in self.objects if key.startswith(Prefix) and key > StartAfter)
        return {'Contents': [{'Key': key, 'LastModified': self.objects[key]} for key in keys[:MaxKeys]],
                'IsTruncated': len(keys) > MaxKeys}

    def delete_object(self, *, Bucket, Key):
        if self.before_delete:
            self.before_delete()
        if self.failure:
            raise self.failure
        self.deleted.append(Key)
        self.objects.pop(Key)


class OrphanReclaimTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'control.sqlite'
        self.storage = Storage()
        self.now = datetime(2026, 10, 2, tzinfo=timezone.utc)
        with self.get_db() as db:
            db.executescript('''
                CREATE TABLE captures(id TEXT PRIMARY KEY, object_key TEXT);
                CREATE TABLE assets(id TEXT PRIMARY KEY, object_key TEXT UNIQUE, thumbnail_key TEXT);
                CREATE TABLE asset_authority_state(asset_id TEXT PRIMARY KEY, object_key TEXT, lifecycle TEXT);
            ''')

    @contextmanager
    def get_db(self):
        db = sqlite3.connect(self.path, timeout=0)
        try:
            yield db
        finally:
            db.close()

    def object(self, number, *, prefix='images/inbox/', age=48):
        key = f'{prefix}{uuid.UUID(int=number)}/original'
        self.storage.objects[key] = self.now - timedelta(hours=age)
        return key

    def reclaim(self, **kwargs):
        return reclaim_orphaned_inbox(self.get_db, self.storage, 'test', now=self.now, **kwargs)

    def test_reclaims_only_old_unreferenced_capture_originals(self):
        orphan = self.object(1)
        video = self.object(2, prefix='videos/inbox/')
        pending = self.object(3)
        legacy = self.object(4)
        trash = self.object(5)
        tombstone = self.object(6)
        thumbnail = self.object(12)
        self.object(7, age=1)
        self.object(8, age=24)
        self.object(9, prefix='library/')
        self.storage.objects['images/inbox/not-a-capture/original'] = self.now - timedelta(days=2)
        self.storage.objects[f'images/inbox/{uuid.UUID(int=10)}/thumbnail'] = self.now - timedelta(days=2)
        self.storage.objects[f'images/inbox/{uuid.UUID(int=11)}/original'] = None
        with self.get_db() as db:
            db.execute('INSERT INTO captures VALUES(?,?)', ['capture', pending])
            db.execute('INSERT INTO assets VALUES(?,?,?)', ['asset', legacy, thumbnail])
            db.executemany('INSERT INTO asset_authority_state VALUES(?,?,?)',
                           [('trash', trash, 'trash'), ('tombstone', tombstone, 'tombstoned')])
            db.commit()
        self.assertEqual(self.reclaim()['deleted'], 2)
        self.assertEqual(set(self.storage.deleted), {orphan, video})
        self.assertTrue(all(key in self.storage.objects for key in (pending, legacy, trash, tombstone, thumbnail)))

    def test_cursor_advances_past_live_rows_with_strict_page_bound(self):
        keys = [self.object(i) for i in range(1, 8)]
        with self.get_db() as db:
            db.executemany('INSERT INTO captures VALUES(?,?)', [(str(i), key) for i, key in enumerate(keys[:4])])
            db.commit()
        cursor = {}
        deleted = 0
        for _ in range(4):
            result = self.reclaim(limit=2, cursor=cursor)
            cursor = result['cursor']
            self.assertLessEqual(result['scanned'], 4)
            deleted += result['deleted']
        self.assertEqual(deleted, 3)
        self.assertIsNone(cursor['images/inbox/'])
        self.assertEqual(set(self.storage.objects), set(keys[:4]))

    def test_missing_or_broken_reference_table_fails_closed(self):
        self.object(1)
        with self.get_db() as db:
            db.execute('DROP TABLE captures')
        with self.assertRaises(sqlite3.OperationalError):
            self.reclaim()
        self.assertFalse(self.storage.deleted)

    def test_storage_failure_is_counted_and_retryable_on_next_cycle(self):
        key = self.object(1)
        self.storage.failure = RuntimeError('R2 unavailable')
        result = self.reclaim()
        self.assertEqual((result['deleted'], result['errors']), (0, 1))
        self.assertIn(key, self.storage.objects)
        self.storage.failure = None
        self.assertEqual(self.reclaim(cursor=result['cursor'])['deleted'], 1)

    def test_reference_writers_cannot_race_check_and_delete(self):
        key = self.object(1)

        def write_reference():
            with self.get_db() as db:
                with self.assertRaisesRegex(sqlite3.OperationalError, 'locked'):
                    db.execute('INSERT INTO captures VALUES(?,?)', ['racing', key])

        self.storage.before_delete = write_reference
        self.assertEqual(self.reclaim()['deleted'], 1)

    def test_invalid_limits_and_foreign_cursor_are_rejected(self):
        for limit in (0, 101):
            with self.assertRaises(ValueError):
                self.reclaim(limit=limit)
        with self.assertRaises(ValueError):
            self.reclaim(cursor={'images/inbox/': 'library/private'})
