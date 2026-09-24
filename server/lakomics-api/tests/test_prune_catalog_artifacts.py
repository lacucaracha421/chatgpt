"""Retention and maintenance safety tests, exclusively on temporary fixtures."""
import io
import fcntl
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mobile_catalog_replica as replica
import mobile_catalog_refresh as refresh
import prune_catalog_artifacts as prune
from tests import test_mobile_catalog as catalog_tests


class PruneCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.root = self.directory / "mobile-catalog"
        self.root.mkdir()
        self.db_path = self.directory / "control.sqlite"
        self.now = time.time()
        replica.startup(self.get_db)
        with self.get_db() as db:
            db.executescript(refresh.DDL)

    @contextmanager
    def get_db(self):
        db = sqlite3.connect(self.db_path, timeout=0)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    def file(self, name, age=72 * 3600):
        path = self.root / name
        path.write_bytes(b"fixture content")
        os.utime(path, (self.now - age, self.now - age))
        return path

    def artifact(self, key, ready="server-refresh", age=72 * 3600):
        digest = replica.digest(key)
        path = self.file(digest + ".sqlite", age)
        with self.get_db() as db:
            db.execute("INSERT INTO mobile_catalog_artifacts VALUES(?,?,?)", [digest, "{}", ready])
            db.commit()
        return digest, path

    def publication(self, key, hours=72, *, content=None, current=False):
        digest = content or self.artifact(key)[0]
        revision = replica.digest([key, "publication"])
        paths = [self.root / (digest + ".sqlite"),
                 self.file(revision + "-users-v2.sqlite"),
                 self.file(revision + "-users.sqlite")]
        published = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.now - hours * 3600))
        with self.get_db() as db:
            db.execute("INSERT INTO mobile_catalog_publications VALUES(?,?,?,?)", [revision, digest, replica.digest([key, "users"]), published])
            if current:
                db.execute("INSERT OR REPLACE INTO mobile_catalog_current VALUES(1,?)", [revision])
            db.commit()
        return revision, digest, paths

    def decisions(self):
        fd = prune.open_directory(self.root)
        try:
            with self.get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                return {entry.name: entry for entry in prune.plan(db, fd, self.db_path.stat(), self.now)}
        finally:
            os.close(fd)

    def execute(self, apply=False):
        output = io.StringIO()
        arguments = ["--db", str(self.db_path)]
        if apply:
            arguments += ["--apply", "--api-stopped"]
        with redirect_stdout(output), mock.patch.object(prune.time, "time", return_value=self.now):
            result = prune.main(arguments)
        return result, output.getvalue()

    def assert_kept(self, paths, reason):
        decisions = self.decisions()
        for path in paths:
            with self.subTest(file=path.name):
                self.assertFalse(decisions[path.name].delete)
                self.assertIn(reason, decisions[path.name].reasons)

    def test_current_publication_and_both_users_formats(self):
        _, _, paths = self.publication("current", current=True)
        self.assert_kept(paths, "current publication")

    def test_recent_publications_are_kept_independently_of_current(self):
        self.publication("current", hours=100, current=True)
        _, _, paths = self.publication("recent", hours=47)
        self.assert_kept(paths, "publication within 48h")

    def test_previous_two_before_current_not_latest_two(self):
        ancient = self.publication("ancient", hours=110)[2]
        previous = self.publication("previous2", hours=100)[2]
        previous += self.publication("previous1", hours=90)[2]
        self.publication("current", hours=80, current=True)
        future = self.publication("later", hours=70)[2]
        self.assert_kept(previous, "previous two publications")
        decisions = self.decisions()
        self.assertTrue(all(decisions[path.name].delete for path in ancient + future))

    def test_newest_pc_upload_uses_numeric_time_and_keeps_ties(self):
        _, old = self.artifact("old", ready="9")
        _, newest = self.artifact("new", ready="10")
        _, tied = self.artifact("tied", ready="10")
        _, derived = self.artifact("derived")
        self.assert_kept([newest, tied], "newest PC upload")
        self.assertTrue(self.decisions()[old.name].delete)
        self.assertTrue(self.decisions()[derived.name].delete)

    def test_recent_mtime_keeps_unreferenced_content_and_users(self):
        _, content = self.artifact("fresh", age=prune.RETENTION_SECONDS)
        users = [self.file(replica.digest("fresh-user") + suffix, age=10)
                 for suffix in ("-users.sqlite", "-users-v2.sqlite")]
        self.assert_kept([content, *users], "mtime within 48h")

    def test_recent_users_keep_their_content_source(self):
        _, _, paths = self.publication("fresh-users")
        os.utime(paths[1], (self.now, self.now))
        self.assert_kept(paths, "mtime within 48h")

    def test_queued_and_running_jobs_keep_uncertain_sources_even_expired(self):
        _, _, paths = self.publication("old")
        paths.append(self.file("refresh-content-ab12cd34.sqlite"))
        for state in ("queued", "running"):
            with self.subTest(state=state):
                with self.get_db() as db:
                    db.execute("DELETE FROM mobile_catalog_refresh_jobs")
                    db.execute("""INSERT INTO mobile_catalog_refresh_jobs
                      (id,language,state,created,updated,lease,watermark,pending_max,page_limit)
                      VALUES('job','korean',?,0,0,0,0,0,1)""", [state])
                    db.commit()
                self.assert_kept(paths, "queued/running refresh; source uncertain")

    def test_temp_age_and_strict_names(self):
        old = []
        fresh = []
        for prefix, suffix in (("upload", ".ndjson"), ("catalog", ".sqlite"),
                               ("users", ".sqlite"), ("refresh-content", ".sqlite")):
            old.append(self.file(prefix + "-ab12cd34" + suffix, prune.TEMP_SECONDS + 1))
            fresh.append(self.file(prefix + "-ab12cd35" + suffix, prune.TEMP_SECONDS))
        unknown = [self.file("catalog-" + "a" * 64 + ".sqlite"),
                   self.file("catalog-backup.sqlite"), self.file("control.sqlite.bak")]
        decisions = self.decisions()
        self.assertTrue(all(decisions[path.name].delete for path in old))
        self.assert_kept(fresh, "mtime within 1h")
        self.assert_kept(unknown, "unrecognized name (including backups)")

    def test_symlinks_directories_control_db_and_disguised_backup_are_kept(self):
        outside = self.directory / "outside"
        outside.write_bytes(b"do not touch")
        link = self.root / (replica.digest("link") + ".sqlite")
        link.symlink_to(outside)
        nested = self.root / (replica.digest("dir") + ".sqlite")
        nested.mkdir()
        control = self.root / (replica.digest("control") + ".sqlite")
        os.link(self.db_path, control)
        backup = self.root / (replica.digest("backup") + ".sqlite")
        shutil.copyfile(self.db_path, backup)
        os.utime(backup, (0, 0))
        self.assert_kept([link, nested], "symlink or non-regular entry")
        self.assert_kept([control], "control database")
        self.assert_kept([backup], "control backup or uncertain SQLite file")
        alias = self.directory / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            prune.open_directory(alias)

    def test_uncertain_times_are_retained(self):
        revision, _, paths = self.publication("bad-time")
        with self.get_db() as db:
            db.execute("UPDATE mobile_catalog_publications SET published_at='bad' WHERE revision=?", [revision])
            db.commit()
        self.assert_kept(paths, "uncertain publication time")
        _, path = self.artifact("bad-ready", ready="NaN")
        self.assert_kept([path], "uncertain PC upload time")

    def test_apply_deletes_old_unreferenced_files_and_artifact_rows_only(self):
        revision, digest, paths = self.publication("pruned")
        orphan_digest, orphan = self.artifact("orphan")
        orphan_users = self.file(replica.digest("orphan-user") + "-users.sqlite")
        stale = self.file("upload-abcd1234.ndjson", age=3601)
        result, output = self.execute(apply=True)
        self.assertEqual(result, 0)
        self.assertTrue(all(not path.exists() for path in [*paths, orphan, orphan_users, stale]))
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM mobile_catalog_artifacts WHERE digest IN (?,?)", [digest, orphan_digest]).fetchone()[0], 0)
            self.assertIsNotNone(db.execute("SELECT * FROM mobile_catalog_publications WHERE revision=?", [revision]).fetchone())
        self.assertIn("APPLY summary:", output.splitlines()[-1])

    def test_dry_run_files_and_database_are_byte_identical(self):
        self.publication("old")
        self.publication("current", current=True)
        self.file("catalog-abcd1234.sqlite", age=3601)
        before = {path: (path.read_bytes(), path.stat().st_mtime_ns)
                  for path in [self.db_path, *self.root.iterdir()]}
        result, output = self.execute()
        self.assertEqual(result, 0)
        after = {path: (path.read_bytes(), path.stat().st_mtime_ns)
                 for path in [self.db_path, *self.root.iterdir()]}
        self.assertEqual(before, after)
        self.assertIn("DELETE", output)
        self.assertIn("rule=current publication", output)
        self.assertIn("estimated_bytes_to_free=", output.splitlines()[-1])
        self.assertIn("DRY RUN summary:", output.splitlines()[-1])

    def test_hardlink_backup_survives_and_is_not_counted_as_freed_space(self):
        _, path = self.artifact("hardlinked")
        backup = self.directory / "operator-backup.sqlite"
        os.link(path, backup)
        _, output = self.execute()
        self.assertIn("links=2", output)
        self.assertIn("estimated_bytes_to_free=0 ", output)
        self.assertEqual(self.execute(apply=True)[0], 0)
        self.assertFalse(path.exists())
        self.assertEqual(backup.read_bytes(), b"fixture content")

    def test_database_rows_commit_before_unlink_and_missing_file_is_tolerated(self):
        digest, path = self.artifact("gone")
        original = os.unlink

        def unlink(name, **kwargs):
            with self.get_db() as db:
                self.assertIsNone(db.execute("SELECT * FROM mobile_catalog_artifacts WHERE digest=?", [digest]).fetchone())
                db.execute("BEGIN IMMEDIATE")  # Row deletion already committed.
            competing_fd = prune.open_directory(self.root)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(competing_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(competing_fd)
            original(name, **kwargs)
            raise FileNotFoundError(name)

        with mock.patch.object(prune.os, "unlink", side_effect=unlink):
            result, output = self.execute(apply=True)
        self.assertEqual(result, 0)
        self.assertFalse(path.exists())
        self.assertIn("already_gone=1", output)

    def test_plan_is_protected_by_control_write_transaction(self):
        self.artifact("old")
        original = prune.plan

        def inspect(db, *args):
            self.assertTrue(db.in_transaction)
            with self.get_db() as competing:
                with self.assertRaisesRegex(sqlite3.OperationalError, "locked"):
                    competing.execute("BEGIN IMMEDIATE")
            return original(db, *args)

        with mock.patch.object(prune, "plan", side_effect=inspect):
            self.execute(apply=True)

    def test_apply_requires_stopped_api_acknowledgement_before_opening_db(self):
        self.artifact("old")
        before = self.db_path.read_bytes()
        error = io.StringIO()
        with redirect_stderr(error), mock.patch.object(prune, "open_directory") as opened:
            result = prune.main(["--db", str(self.db_path), "--apply"])
        self.assertNotEqual(result, 0)
        opened.assert_not_called()
        self.assertIn("Refusing --apply", error.getvalue())
        self.assertIn("--api-stopped", error.getvalue())
        self.assertEqual(self.db_path.read_bytes(), before)

    def test_dry_run_is_read_only_and_does_not_take_a_write_lock(self):
        self.artifact("old")
        original = prune.plan

        def inspect(db, *args):
            self.assertTrue(db.in_transaction)
            with self.assertRaisesRegex(sqlite3.OperationalError, "readonly"):
                db.execute("DELETE FROM mobile_catalog_artifacts")
            with self.get_db() as competing:
                competing.execute("BEGIN IMMEDIATE")
            return original(db, *args)

        with mock.patch.object(prune, "plan", side_effect=inspect):
            self.assertEqual(self.execute()[0], 0)

    def test_explicit_dry_run_and_acknowledgement_without_apply_delete_nothing(self):
        _, path = self.artifact("old")
        for flags in (["--dry-run"], ["--api-stopped"], ["--dry-run", "--api-stopped"]):
            with self.subTest(flags=flags), redirect_stdout(io.StringIO()):
                self.assertEqual(prune.main(["--db", str(self.db_path), *flags]), 0)
                self.assertTrue(path.exists())

    def test_root_override_and_script_entrypoint(self):
        _, path = self.artifact("old")
        override = self.directory / "catalog with spaces"
        self.root.rename(override)
        result = subprocess.run([sys.executable, str(Path(prune.__file__)), "--db", str(self.db_path),
                                 "--root", str(override)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((override / path.name).exists())
        self.assertIn("DRY RUN summary:", result.stdout.splitlines()[-1])
        with redirect_stdout(io.StringIO()):
            self.assertEqual(prune.main(["--db", str(self.db_path), "--root", str(override),
                                         "--apply", "--api-stopped"]), 0)
        self.assertFalse((override / path.name).exists())

    def test_db_and_root_symlinks_are_refused_and_missing_db_is_not_created(self):
        alias = self.directory / "db-alias"
        alias.symlink_to(self.db_path)
        root_alias = self.directory / "root-alias"
        root_alias.symlink_to(self.root, target_is_directory=True)
        missing = self.directory / "missing.sqlite"
        for arguments in (["--db", str(alias)], ["--db", str(missing)],
                          ["--db", str(self.db_path), "--root", str(root_alias)]):
            with self.subTest(arguments=arguments), redirect_stderr(io.StringIO()):
                self.assertNotEqual(prune.main(arguments), 0)
        self.assertFalse(missing.exists())

    def test_second_apply_is_refused_while_first_holds_directory_lock(self):
        _, path = self.artifact("old")
        fd = prune.open_directory(self.root)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            error = io.StringIO()
            with redirect_stderr(error):
                self.assertNotEqual(self.execute(apply=True)[0], 0)
            self.assertIn("directory lock", error.getvalue())
            self.assertTrue(path.exists())
            self.assertEqual(self.execute()[0], 0)  # Dry run takes no directory lock.
        finally:
            os.close(fd)

    def test_kept_by_rule_counts_and_summary(self):
        self.publication("current", current=True)
        _, output = self.execute()
        self.assertIn("current publication=3", output)
        self.assertIn("files=3 retained=3 selected=0", output.splitlines()[-1])

    def test_direct_reader_of_pruned_publication_returns_409(self):
        revision, _, _ = self.publication("pruned")
        self.assertEqual(self.execute(apply=True)[0], 0)
        with self.assertRaises(catalog_tests.HTTPException) as raised:
            with replica.open_publication(self.root, self.get_db, revision):
                self.fail("pruned publication opened")
        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("refresh", raised.exception.detail)

    def test_reader_requires_both_content_and_users_but_accepts_legacy_users(self):
        revision, digest, paths = self.publication("files")
        publication = {"revision": revision, "content_digest": digest}
        self.assertEqual(replica.publication_paths(self.root, publication), (paths[1], paths[0]))
        paths[1].unlink()
        self.assertEqual(replica.publication_paths(self.root, publication), (paths[2], paths[0]))
        paths[0].unlink()
        with self.assertRaises(catalog_tests.HTTPException) as raised:
            replica.publication_paths(self.root, publication)
        self.assertEqual(raised.exception.status_code, 409)

    def test_real_sqlite_projections_prune_but_publication_and_user_history_survive(self):
        replica.catalog_bookmarks.startup(self.get_db)
        data, digest, users = catalog_tests.fixture_projection()
        source = self.directory / "fixture.ndjson"
        source.write_bytes(data)
        replica.import_content(source, digest, self.root, self.get_db)
        publication = replica.publish({"version": 1, "baseRevision": None,
                                       "contentDigest": digest, "userSnapshot": users},
                                      self.root, self.get_db)
        revision = publication["publicationRevision"]
        with replica.open_publication(self.root, self.get_db, revision) as (db, _):
            self.assertGreater(db.execute("SELECT COUNT(*) FROM catalog.Works").fetchone()[0], 0)
        with self.get_db() as db:
            db.execute("DELETE FROM mobile_catalog_current")
            db.execute("UPDATE mobile_catalog_artifacts SET ready_at='server-refresh'")
            db.execute("UPDATE mobile_catalog_publications SET published_at='2000-01-01T00:00:00Z'")
            db.commit()
            history = [tuple(row) for row in db.execute("SELECT * FROM mobile_catalog_publications")]
            snapshots = [tuple(row) for row in db.execute("SELECT * FROM mobile_catalog_users")]
        for path in self.root.iterdir():
            os.utime(path, (0, 0))
        self.assertEqual(self.execute(apply=True)[0], 0)
        self.assertFalse(replica.artifact_path(self.root, digest).exists())
        self.assertFalse(replica.users_path(self.root, revision).exists())
        with self.get_db() as db:
            self.assertEqual([tuple(row) for row in db.execute("SELECT * FROM mobile_catalog_publications")], history)
            self.assertEqual([tuple(row) for row in db.execute("SELECT * FROM mobile_catalog_users")], snapshots)
        with self.assertRaises(catalog_tests.HTTPException) as raised:
            with replica.open_publication(self.root, self.get_db, revision):
                self.fail("pruned publication opened")
        self.assertEqual(raised.exception.status_code, 409)

    def test_dry_run_with_live_wal_database_does_not_modify_database_or_wal(self):
        self.artifact("wal")
        with self.get_db() as live:
            self.assertEqual(live.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
            live.execute("INSERT INTO mobile_catalog_users VALUES('wal-fixture','{}')")
            live.commit()
            paths = [self.db_path, Path(str(self.db_path) + "-wal")]
            before = [path.read_bytes() for path in paths]
            self.assertEqual(self.execute()[0], 0)
            self.assertEqual([path.read_bytes() for path in paths], before)

    def test_apply_rejects_file_replaced_after_planning_before_deleting_rows(self):
        digest, path = self.artifact("replaced")
        original = prune.plan
        outside = self.directory / "outside"
        outside.write_bytes(b"keep outside")

        def replace(*args):
            entries = original(*args)
            path.unlink()
            path.symlink_to(outside)
            return entries

        with mock.patch.object(prune, "plan", side_effect=replace), redirect_stderr(io.StringIO()):
            self.assertNotEqual(self.execute(apply=True)[0], 0)
        self.assertTrue(path.is_symlink())
        self.assertEqual(outside.read_bytes(), b"keep outside")
        with self.get_db() as db:
            self.assertIsNotNone(db.execute("SELECT * FROM mobile_catalog_artifacts WHERE digest=?", [digest]).fetchone())


class PrunedReaderTests(unittest.TestCase):
    def test_pruned_revision_returns_refresh_for_every_token_reader(self):
        fixture = catalog_tests.MobileCatalogApiTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        published = fixture.publish()
        self.assertEqual(published.status_code, 200, published.text)
        revision = published.json()["publicationRevision"]
        page = fixture.search(limit=1).json()
        count = fixture.search(sort="hotWeek").json()["countToken"]
        self.assertIsNotNone(page["nextCursor"])
        self.assertIsNotNone(count)
        root = fixture.root / "artifacts"
        # Expire the stored publication/files, but keep the newly issued tokens
        # valid. This exercises GC's missing-files path, not token expiry.
        with fixture.get_db() as db:
            db.execute("UPDATE mobile_catalog_publications SET published_at='2000-01-01T00:00:00Z'")
            db.execute("UPDATE mobile_catalog_artifacts SET ready_at='server-refresh'")
            for index in range(3):
                next_revision = replica.digest(["later", index])
                db.execute("INSERT INTO mobile_catalog_publications VALUES(?,?,?,?)",
                           [next_revision, replica.digest("later-content"), replica.digest("users"),
                            f"2000-01-0{index + 2}T00:00:00Z"])
            db.execute("UPDATE mobile_catalog_current SET publication_revision=?", [next_revision])
            db.commit()
        for path in root.iterdir():
            os.utime(path, (0, 0))
        fd = prune.open_directory(root)
        try:
            with fixture.get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                entries = prune.plan(db, fd, (fixture.root / "control.sqlite").stat(), time.time())
                prune.execute_plan(db, fd, entries, apply=True, output=io.StringIO())
        finally:
            os.close(fd)
        self.assertFalse(replica.artifact_path(root, fixture.digest).exists())
        self.assertFalse(replica.users_path(root, revision).exists())
        with fixture.get_db() as db:
            self.assertIsNotNone(db.execute("SELECT * FROM mobile_catalog_publications WHERE revision=?", [revision]).fetchone())
        with self.assertRaises(catalog_tests.HTTPException) as raised:
            with replica.open_publication(root, fixture.get_db, revision):
                self.fail("pruned publication opened")
        self.assertEqual(raised.exception.status_code, 409)
        for endpoint, params in (
                ("search", {"cursor": page["nextCursor"]}),
                ("count", {"token": count}),
                ("works/kHentai/1", {"context": page["context"]}),
                ("works/kHentai/1/reader", {"context": page["context"]}),
                ("groups/kHentai/g1/editions", {"context": page["context"]})):
            with self.subTest(endpoint=endpoint):
                response = fixture.client.get("/v1/mobile-catalog/" + endpoint,
                                              headers=catalog_tests.AUTH, params=params)
                self.assertEqual(response.status_code, 409, response.text)
                self.assertIn("refresh", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
