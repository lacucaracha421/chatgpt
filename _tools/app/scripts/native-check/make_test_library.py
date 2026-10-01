"""Build a test library for native-app checks from a real library, read-only.

The real library is only read: the database through SQLite's online backup from a
read-only connection, files by copying. The copy gets the development-library marker
and loses every server setting, so an app opened on it has no server to talk to.

Usage: python3 make_test_library.py <real-library-root> [<test-root>]
Default test root: ~/.cache/lakomics-native-check/library
"""
import os
import shutil
import sqlite3
import sys
from pathlib import Path

COPIED_DIRS = ["work-artwork", "work-artwork-thumbnails", "collection-thumbnails", "thumbnails", "catalogs"]
DEV_MARKER = ".lakomics-dev-library"


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    source = Path(sys.argv[1]).resolve()
    target = Path(sys.argv[2] if len(sys.argv) > 2 else Path.home() / ".cache/lakomics-native-check/library").resolve()
    if target == source or source in target.parents or target in source.parents:
        sys.exit("the test library must be outside the real library")
    database = source / "library.sqlite"
    before = database.stat()
    target.mkdir(parents=True, exist_ok=True)

    copy = target / "library.sqlite"
    for leftover in (copy, Path(f"{copy}-wal"), Path(f"{copy}-shm")):
        leftover.unlink(missing_ok=True)
    real = sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True)
    test = sqlite3.connect(copy)
    real.backup(test)
    real.close()

    # The copy must never reach the server: no sync, no capture, no address.
    test.execute("UPDATE library_settings SET cloud_sync_enabled = 0, cloud_capture_enabled = 0, cloud_api_base_url = NULL")
    test.commit()
    settings = test.execute("SELECT cloud_sync_enabled, cloud_capture_enabled, cloud_api_base_url FROM library_settings").fetchall()
    test.close()
    assert all(row == (0, 0, None) for row in settings), settings

    for name in COPIED_DIRS:
        source_dir = source / name
        if source_dir.is_dir():
            shutil.copytree(source_dir, target / name, dirs_exist_ok=True, symlinks=False)
    (target / DEV_MARKER).write_text("native-check test library; copied read-only from the real library\n")

    after = database.stat()
    assert (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns), "real library.sqlite changed during the copy"
    print(f"test library ready: {target}")
    print(f"server settings in the copy: {settings}")


if __name__ == "__main__":
    main()
