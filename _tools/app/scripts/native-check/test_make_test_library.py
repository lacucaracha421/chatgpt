"""Copy safety checks use only a generated SQLite fixture under TemporaryDirectory."""
import importlib.util
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('copy_fixture', Path(__file__).with_name('make_test_library.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CopyTest(unittest.TestCase):
    def test_copy_clears_external_roots_and_preserves_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'source', Path(directory) / 'test'
            source.mkdir()
            database = source / 'library.sqlite'
            with sqlite3.connect(database) as db:
                db.execute('CREATE TABLE library_settings(cloud_sync_enabled INTEGER, cloud_capture_enabled INTEGER, cloud_api_base_url TEXT, manga_root TEXT, collection_source_root TEXT, private_vault_last_root TEXT)')
                db.execute("INSERT INTO library_settings VALUES(1,1,'https://invalid.example','external-manga','external-collections','external-vault')")
            before = database.read_bytes()
            with patch.object(sys, 'argv', ['copy', str(source), str(target)]):
                module.main()
            self.assertEqual(before, database.read_bytes())
            with sqlite3.connect(target / 'library.sqlite') as db:
                self.assertEqual(db.execute('SELECT * FROM library_settings').fetchone(), (0, 0, None, None, None, None))
            self.assertTrue((target / module.DEV_MARKER).is_file())

    def test_nonempty_target_and_nested_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / 'source', Path(directory) / 'test'
            source.mkdir(); target.mkdir()
            (source / 'library.sqlite').write_bytes(b'fixture')
            existing = target / 'user-data'
            existing.write_bytes(b'preserve')
            for path in (target, source / 'nested'):
                with patch.object(sys, 'argv', ['copy', str(source), str(path)]):
                    with self.assertRaises(SystemExit):
                        module.main()
            self.assertEqual(existing.read_bytes(), b'preserve')


if __name__ == '__main__':
    unittest.main()
