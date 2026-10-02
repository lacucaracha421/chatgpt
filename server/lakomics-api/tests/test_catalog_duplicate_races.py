"""Publication changes while waiting/scanning must not erase indexed new works."""
import threading
import shutil
import sqlite3
from pathlib import Path
from contextlib import contextmanager
from unittest import mock

from tests.test_catalog_duplicates import Fixture, work
import catalog_duplicates as dup
import mobile_catalog_replica as replica


class DuplicatePublicationRaceTests(Fixture):
    def setUp(self):
        super().setUp()
        replica.startup(self.get_db)
        self.add(work(1, 'Unrelated First Title'))
        with self.get_db() as db, self.catalog() as catalog:
            dup.rebuild_title_index(db, catalog, digest='seed')
        self.publish('A')
        self.opened = []
        self.rebuilder = dup.TitleIndexRebuilder(lambda: self.temp.name, self.get_db)

    def publish(self, revision, digest=None):
        with self.get_db() as db:
            db.execute('INSERT INTO mobile_catalog_publications VALUES(?,?,?,?)',
                       (revision, digest or revision, 'user', revision))
            db.execute('INSERT OR REPLACE INTO mobile_catalog_current VALUES(1,?)', [revision])
            db.commit()

    @contextmanager
    def open_publication(self, *args):
        with self.get_db() as db:
            publication = dict(replica.current(db))
        self.opened.append(publication['revision'])
        snapshot = Path(self.temp.name) / f"snapshot-{len(self.opened)}.sqlite"
        shutil.copyfile(self.artifact, snapshot)
        catalog = sqlite3.connect(":memory:")
        catalog.execute("ATTACH DATABASE ? AS catalog", [str(snapshot)])
        try:
            yield catalog, publication
        finally:
            catalog.close()

    def ids(self):
        with self.get_db() as db:
            return [r[0] for r in db.execute('SELECT DISTINCT work_id FROM catalog_duplicate_title_index ORDER BY work_id')]

    def test_late_rebuild_does_not_delete_concurrent_refresh_rows(self):
        real_lock = threading.RLock()
        waiting = threading.Event()
        main = threading.get_ident()

        class Lock:
            def __enter__(self):
                if threading.get_ident() != main:
                    waiting.set()
                real_lock.acquire()

            def __exit__(self, *args):
                real_lock.release()

        errors = []

        def rebuild():
            try:
                self.rebuilder.rebuild_once()
            except BaseException as exc:
                errors.append(exc)

        with mock.patch.object(dup, '_INDEX_LOCK', Lock()), mock.patch.object(
                replica, 'open_publication', self.open_publication):
            with real_lock:
                thread = threading.Thread(target=rebuild)
                thread.start()
                self.assertTrue(waiting.wait(5))
                self.add(work(2, 'Shared New Work Title'))
                self.publish('B')
                self.check([2], digest='B')
            thread.join(5)
            self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(self.ids(), [1, 2])
        self.add(work(3, 'Shared New Work Title'))
        self.assertEqual(self.check([3], digest='C')['candidates'], 1)
        self.assertEqual(self.ids(), [1, 2, 3])

    def test_publication_move_during_scan_reopens_current_before_replace(self):
        original = dup.title_keys
        moved = False

        def keys(title, japanese):
            nonlocal moved
            if not moved:
                moved = True
                self.publish('B')
            return original(title, japanese)

        with mock.patch.object(replica, 'open_publication', self.open_publication), mock.patch.object(
                dup, 'title_keys', side_effect=keys):
            self.rebuilder.rebuild_once()
        self.assertEqual(self.opened, ['A', 'B'])
        with self.get_db() as db:
            self.assertEqual(db.execute('SELECT index_digest FROM catalog_duplicate_state').fetchone()[0], 'B')

    def test_revision_change_with_same_digest_is_also_fenced(self):
        with self.get_db() as db:
            publication = dict(replica.current(db))
        self.publish('B', digest='A')
        with self.get_db() as db, self.catalog() as catalog:
            with self.assertRaises(dup._PublicationMoved):
                dup.rebuild_title_index(db, catalog, digest='A', publication=publication)
            self.assertEqual(db.execute('SELECT index_digest FROM catalog_duplicate_state').fetchone()[0], 'seed')
        self.assertEqual(self.ids(), [1])
