"""Live catalog pruning: cross-process lock exclusion, automatic runs, reader races."""
import copy
import os
import subprocess
import sys
import textwrap
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mobile_catalog_replica as replica
import prune_catalog_artifacts as prune
from mobile_catalog_refresh import DDL, RefreshWorker
from tests import test_mobile_catalog as base
from tests.test_mobile_catalog_refresh import page

PACKAGE = Path(__file__).resolve().parents[1]
HOLDER = textwrap.dedent("""
    import sys
    sys.path.insert(0, sys.argv[1])
    import mobile_catalog_replica as replica
    with replica.catalog_lock(sys.argv[2], exclusive=sys.argv[3] == "ex", blocking=False) as held:
        print("held" if held else "busy", flush=True)
        sys.stdin.read()
""")


class LiveCatalogPruneTests(unittest.TestCase):
    setUp = base.MobileCatalogApiTests.setUp
    tearDown = base.MobileCatalogApiTests.tearDown
    publish = base.MobileCatalogApiTests.publish
    search = base.MobileCatalogApiTests.search

    @property
    def artifacts(self):
        return self.root / "artifacts"

    def stale(self):
        """An expired server artifact with its row, and an abandoned upload temp file."""
        digest = replica.digest("stale-derived")
        orphan = replica.artifact_path(self.artifacts, digest)
        orphan.write_bytes(b"old derived artifact")
        temp = self.artifacts / "upload-abcd1234.ndjson"
        temp.write_bytes(b"abandoned")
        for path in (orphan, temp):
            os.utime(path, (0, 0))
        with self.get_db() as db:
            db.execute("INSERT INTO mobile_catalog_artifacts VALUES(?,?,?)", [digest, "{}", "server-refresh"])
            db.commit()
        return digest, orphan, temp

    def hold(self, mode):
        """Hold the catalog lock from another process until cleanup."""
        process = subprocess.Popen([sys.executable, "-c", HOLDER, str(PACKAGE), str(self.artifacts), mode],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.assertEqual(process.stdout.readline().strip(), "held")

        def release():
            if process.poll() is None:
                process.stdin.close()
                process.wait(timeout=10)
            process.stdout.close()
        self.addCleanup(release)
        return release

    def wait_for(self, predicate, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.02)
        return predicate()

    def current_files(self):
        with self.get_db() as db:
            current = replica.current(db)
        return [replica.artifact_path(self.artifacts, current["content_digest"]),
                replica.users_path(self.artifacts, current["revision"])]

    def pruner(self, **kwargs):
        pruner = prune.AutoPruner(lambda: self.artifacts, self.get_db, **kwargs)
        self.addCleanup(pruner.stop)
        return pruner

    # Lock exclusion ---------------------------------------------------------

    def test_pruner_skips_while_a_writer_in_another_process_holds_the_lock(self):
        self.assertEqual(self.publish().status_code, 200)
        digest, orphan, temp = self.stale()
        release = self.hold("sh")
        self.assertIsNone(prune.prune_live(self.artifacts, self.get_db))
        self.assertTrue(orphan.exists() and temp.exists())
        release()
        summary = prune.prune_live(self.artifacts, self.get_db)
        self.assertEqual((summary.deleted, summary.errors), (2, []))
        self.assertFalse(orphan.exists() or temp.exists())
        self.assertTrue(all(path.exists() for path in self.current_files()))
        with self.get_db() as db:
            self.assertIsNone(db.execute("SELECT 1 FROM mobile_catalog_artifacts WHERE digest=?", [digest]).fetchone())

    def test_writer_waits_while_a_pruner_in_another_process_holds_the_lock(self):
        source = self.root / "upload.ndjson"
        source.write_bytes(self.data)
        self.artifacts.mkdir()
        release = self.hold("ex")
        finished = threading.Event()
        errors = []

        def upload():
            try:
                replica.import_content(source, self.digest, self.artifacts, self.get_db)
            except Exception as exc:  # pragma: no cover - reported below
                errors.append(exc)
            finally:
                finished.set()

        thread = threading.Thread(target=upload)
        thread.start()
        self.assertFalse(finished.wait(0.5))
        self.assertFalse(replica.artifact_path(self.artifacts, self.digest).exists())
        release()
        self.assertTrue(finished.wait(10))
        thread.join()
        self.assertEqual(errors, [])
        self.assertTrue(replica.artifact_path(self.artifacts, self.digest).exists())

    def test_publish_holds_the_writer_lock_until_commit(self):
        self.assertEqual(self.publish().status_code, 200)
        observed = []
        original = replica.prepare_users

        def prepare(*args):
            observed.append(prune.prune_live(self.artifacts, self.get_db))
            return original(*args)

        users = copy.deepcopy(self.users)
        users["bookmarks"] = []
        with mock.patch.object(replica, "prepare_users", side_effect=prepare):
            with self.get_db() as db:
                prior = replica.current(db)["revision"]
            replica.publish({"version": 1, "baseRevision": prior, "contentDigest": self.digest,
                             "userSnapshot": users}, self.artifacts, self.get_db)
        self.assertEqual(observed, [None])

    def test_same_process_writer_and_pruner_exclude_each_other(self):
        self.assertEqual(self.publish().status_code, 200)
        _, orphan, _ = self.stale()
        pruner = self.pruner()
        with replica.catalog_lock(self.artifacts):
            with self.assertLogs(prune.LOG, "INFO") as logs:
                self.assertIsNone(pruner.run_once())
            self.assertIn("skipped", logs.output[0])
        self.assertTrue(orphan.exists())
        with self.assertLogs(prune.LOG, "WARNING") as logs:
            self.assertEqual(pruner.run_once().deleted, 2)
        self.assertEqual(len(logs.output), 1)
        self.assertIn("deleted=2 files freed_bytes=", logs.output[0])

    def test_auto_prune_errors_are_logged_not_raised(self):
        pruner = self.pruner()
        self.artifacts.mkdir()
        with mock.patch.object(prune, "plan", side_effect=ValueError("boom")), \
                self.assertLogs(prune.LOG, "ERROR") as logs:
            self.assertIsNone(pruner.run_once())
        self.assertIn("boom", logs.output[0])

    # Automatic runs ---------------------------------------------------------

    def test_auto_prune_runs_after_publish_and_keeps_retained_files(self):
        first = self.publish().json()["publicationRevision"]
        first_files = self.current_files()
        _, orphan, temp = self.stale()
        pruner = self.app.state.catalog_pruner
        pruner.initial_delay = 3600  # Only the publish trigger may run it.
        pruner.start()
        self.addCleanup(pruner.stop)
        time.sleep(0.2)
        self.assertTrue(orphan.exists())
        users = copy.deepcopy(self.users)
        users["bookmarks"] = []
        with self.assertLogs(prune.LOG, "WARNING") as logs:
            response = self.publish(first, users)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(self.wait_for(lambda: not orphan.exists() and not temp.exists()))
            self.assertTrue(self.wait_for(lambda: logs.output))
        self.assertIn("deleted=2", logs.output[0])
        self.assertTrue(all(path.exists() for path in first_files + self.current_files()))
        with replica.open_publication(self.artifacts, self.get_db, first) as (db, _):
            self.assertGreater(db.execute("SELECT COUNT(*) FROM catalog.Works").fetchone()[0], 0)

    def test_auto_prune_runs_after_refresh_publication_only(self):
        self.assertEqual(self.publish().status_code, 200)
        _, orphan, _ = self.stale()
        pruner = self.pruner(initial_delay=3600)
        pruner.start()
        with self.get_db() as db:
            db.executescript(DDL)
        failing = mock.Mock()
        worker = RefreshWorker(self.get_db, lambda: self.artifacts, mock.Mock(side_effect=OSError("offline")), failing)
        worker.request(str(uuid.uuid4()), "korean")
        with self.assertLogs("mobile_catalog_refresh", "WARNING"):
            worker.run_once()
        failing.assert_not_called()
        worker = RefreshWorker(self.get_db, lambda: self.artifacts, lambda *_: page([1002, 1001]), pruner.trigger)
        worker.request(str(uuid.uuid4()), "korean")
        with self.assertLogs(prune.LOG, "WARNING"):
            self.assertTrue(worker.run_once())
            self.assertEqual(worker.status()["state"], "completed")
            self.assertTrue(self.wait_for(lambda: not orphan.exists()))
        self.assertTrue(all(path.exists() for path in self.current_files()))

    def test_startup_run_through_app_lifespan(self):
        self.assertEqual(self.publish().status_code, 200)
        _, orphan, _ = self.stale()
        pruner = self.app.state.catalog_pruner
        pruner.initial_delay = 0
        with self.assertLogs(prune.LOG, "WARNING"), TestClient(self.app):
            self.assertTrue(self.wait_for(lambda: not orphan.exists()))
        self.assertFalse(pruner.thread.is_alive())

    def test_disabled_setting_never_starts_or_prunes(self):
        first = self.publish().json()["publicationRevision"]
        _, orphan, _ = self.stale()
        pruner = self.app.state.catalog_pruner
        pruner.initial_delay = 0
        with mock.patch.dict(os.environ, {prune.AUTO_PRUNE_ENV: "0"}):
            with self.assertLogs(prune.LOG, "WARNING") as logs:
                pruner.start()
            self.assertIn("disabled", logs.output[0])
            self.assertIsNone(pruner.thread)
            users = copy.deepcopy(self.users)
            users["bookmarks"] = []
            self.assertEqual(self.publish(first, users).status_code, 200)
            time.sleep(0.3)
        self.assertTrue(orphan.exists())

    # Readers racing deletion ------------------------------------------------

    def race(self, victim):
        """Delete a file right after open_publication's existence check."""
        original = replica.publication_paths
        calls = []

        def check_then_delete(root, publication):
            paths = original(root, publication)
            if not calls:
                victim(paths).unlink()
            calls.append(1)
            return paths
        return mock.patch.object(replica, "publication_paths", side_effect=check_then_delete)

    def test_reader_racing_deletion_gets_409_not_500(self):
        revision = self.publish().json()["publicationRevision"]
        for name, victim in (("content", lambda paths: paths[1]), ("users", lambda paths: paths[0])):
            with self.subTest(file=name):
                files = self.current_files()
                backups = [path.read_bytes() for path in files]
                with self.race(victim), self.assertRaises(base.HTTPException) as raised:
                    with replica.open_publication(self.artifacts, self.get_db, revision):
                        self.fail("deleted publication opened")
                self.assertEqual(raised.exception.status_code, 409)
                for path, data in zip(files, backups):
                    if not path.exists():
                        path.write_bytes(data)
        with self.race(lambda paths: paths[1]):
            response = self.search()
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn("refresh", response.json()["detail"])

    def test_reader_that_opened_before_deletion_keeps_reading(self):
        revision = self.publish().json()["publicationRevision"]
        with replica.open_publication(self.artifacts, self.get_db, revision) as (db, _):
            for path in self.current_files():
                path.unlink()
            self.assertGreater(db.execute("SELECT COUNT(*) FROM catalog.Works").fetchone()[0], 0)
            self.assertGreater(db.execute("SELECT COUNT(*) FROM mobile_catalog_work_state").fetchone()[0], 0)

    def test_reupload_of_existing_digest_counts_as_newest_pc_upload(self):
        source = self.root / "upload.ndjson"
        source.write_bytes(self.data)
        with mock.patch.object(replica.time, "time", return_value=1000):
            replica.import_content(source, self.digest, self.artifacts, self.get_db)
        with mock.patch.object(replica.time, "time", return_value=2000):
            replica.import_content(source, self.digest, self.artifacts, self.get_db)
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT ready_at FROM mobile_catalog_artifacts WHERE digest=?",
                                        [self.digest]).fetchone()[0], "2000")


if __name__ == "__main__":
    unittest.main()
