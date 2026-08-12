import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from tools.one_off.repair_comic_game_links import RepairRefused, find_candidates, repair


def make_library(path: Path, overlap_count: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.executescript("""
        CREATE TABLE classification_entries (id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE assets (id TEXT PRIMARY KEY);
        CREATE TABLE asset_classifications (
            asset_id TEXT NOT NULL,
            classification_id TEXT NOT NULL,
            PRIMARY KEY (asset_id, classification_id)
        );
        INSERT INTO classification_entries VALUES ('comic', '만화'), ('game', '게임'), ('other', '기타');
    """)
    for index in range(overlap_count):
        asset_id = f"asset-{index}"
        connection.execute("INSERT INTO assets VALUES (?)", (asset_id,))
        connection.executemany(
            "INSERT INTO asset_classifications VALUES (?, ?)",
            [(asset_id, "comic"), (asset_id, "game"), (asset_id, "other")],
        )
    connection.commit()
    connection.close()


def link_count(path: Path, classification_id: str) -> int:
    with closing(sqlite3.connect(path)) as connection:
        return connection.execute(
            "SELECT COUNT(*) FROM asset_classifications WHERE classification_id = ?",
            (classification_id,),
        ).fetchone()[0]


class RepairTests(unittest.TestCase):
    def test_refuses_zero_one_or_three_overlaps_without_writing(self) -> None:
        for count in (0, 1, 3):
            with self.subTest(count=count), tempfile.TemporaryDirectory() as temp:
                database = Path(temp) / "library.sqlite"
                make_library(database, count)
                with self.assertRaises(RepairRefused):
                    repair(database)
                self.assertFalse((database.parent / "backups").exists())
                self.assertEqual(link_count(database, "game"), count)

    def test_refuses_multiple_candidate_databases(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = root / "one" / "library.sqlite"
            second = root / "two" / "library.sqlite"
            make_library(first, 2)
            make_library(second, 2)
            with self.assertRaises(RepairRefused):
                find_candidates(root)
            self.assertEqual(link_count(first, "game") + link_count(second, "game"), 4)

    def test_two_overlaps_create_verified_backup_and_remove_only_game_links(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            database = Path(temp) / "library.sqlite"
            make_library(database, 2)
            backup = repair(database)

            self.assertTrue(backup.is_file())
            self.assertEqual(link_count(database, "game"), 0)
            self.assertEqual(link_count(database, "comic"), 2)
            self.assertEqual(link_count(database, "other"), 2)
            with closing(sqlite3.connect(database)) as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM assets").fetchone()[0], 2)
            with closing(sqlite3.connect(f"file:{backup.as_posix()}?mode=ro", uri=True)) as connection:
                self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(link_count(backup, "game"), 2)
            self.assertEqual(link_count(backup, "comic"), 2)
            self.assertEqual(link_count(backup, "other"), 2)


if __name__ == "__main__":
    unittest.main()
