"""Dependency-free tests for the selection SQL embedded in PC and read by the server."""
import json
import sqlite3
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SQL = ROOT.joinpath("home_revisit.sql").read_text(encoding="utf-8")


class SharedSelectionSqlTests(unittest.TestCase):
    def test_kst_exact_fallback_leap_day_and_year_boundary(self):
        fixture = ROOT.joinpath("tests/fixtures/home_revisit.json")
        fixture = json.loads(fixture.read_text(encoding="utf-8"))
        with sqlite3.connect(":memory:") as db:
            db.execute("CREATE TABLE fixture_assets(id TEXT, collected_at TEXT)")
            db.executemany("INSERT INTO fixture_assets VALUES (?, ?)",
                           [(asset["id"], asset["collected_at"]) for asset in fixture["assets"]])
            for case in fixture["cases"]:
                result = db.execute("WITH revisit_assets AS (SELECT * FROM fixture_assets)\n" + SQL,
                                    {"day": case["day"]}).fetchall()
                self.assertEqual([row[0] for row in result], case["ids"], case["day"])

    def test_twenty_item_limit_and_stable_id_ties(self):
        with sqlite3.connect(":memory:") as db:
            db.execute("CREATE TABLE fixture_assets(id TEXT, collected_at TEXT)")
            db.executemany("INSERT INTO fixture_assets VALUES (?, '2025-10-10T00:00:00Z')",
                           [(f"asset-{index:02}",) for index in reversed(range(25))])
            rows = db.execute("WITH revisit_assets AS (SELECT * FROM fixture_assets)\n" + SQL,
                              {"day": "2026-10-10"}).fetchall()
            self.assertEqual([row[0] for row in rows], [f"asset-{index:02}" for index in range(20)])
