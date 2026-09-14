"""Exercise the real CLI against an isolated SQLite fixture."""
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from test_character_holdout import add, database


class CliTests(unittest.TestCase):
    def test_freeze_is_readonly_and_report_needs_only_the_frozen_file(self):
        tool = Path(__file__).with_name("character_holdout.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            library = root / "library"
            library.mkdir()
            source = library / "fixture.sqlite"
            memory = database()
            add(memory, "old", 10)
            add(memory, "new", 13)
            memory.commit()
            disk = sqlite3.connect(source)
            memory.backup(disk)
            disk.close()
            memory.close()
            before = source.read_bytes()
            frozen = root / "frozen.json"
            def run(*arguments):
                return subprocess.run([sys.executable, "-B", str(tool), *map(str, arguments)],
                                      text=True, capture_output=True, timeout=10)
            result = run("freeze", "--database", source, "--output", frozen,
                         "--cutoff", "2026-09-12T00:00:00Z")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(source.read_bytes(), before)
            repeated = run("freeze", "--database", source, "--output", frozen,
                           "--cutoff", "2026-09-12T00:00:00Z")
            self.assertEqual(repeated.returncode, 2)
            source.rename(library / "archived-fixture.sqlite")
            first = run("evaluate", "--dataset", frozen)
            second = run("evaluate", "--dataset", frozen, "--policy", "current")
            self.assertEqual(first.returncode, 0, first.stderr)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(json.loads(first.stdout), json.loads(second.stdout))
            self.assertEqual(json.loads(first.stdout)["labeled_pairs"], 1)
            report = root / "report.json"
            self.assertEqual(run("evaluate", "--dataset", frozen, "--output", report).returncode, 0)
            self.assertEqual(json.loads(report.read_text()), json.loads(first.stdout))


if __name__ == "__main__":
    unittest.main()
