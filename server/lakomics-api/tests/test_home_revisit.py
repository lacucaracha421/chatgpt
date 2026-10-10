"""Native/tablet Home selection parity using the same library and expected IDs."""
import json
import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch
from datetime import datetime

import library_revisit
from tests.test_mobile_library_api import MobileLibraryApiTests


class HomeSelectionTests(unittest.TestCase):
    def test_shared_native_fixture(self):
        fixture = json.loads(Path(__file__).with_name("fixtures").joinpath("home_revisit.json").read_text())
        with sqlite3.connect(":memory:") as db:
            db.row_factory = sqlite3.Row
            db.execute("CREATE TABLE visible_assets(id TEXT, collected_at TEXT, committed INTEGER, kind TEXT)")
            db.executemany("INSERT INTO visible_assets VALUES (?, ?, 1, 'image')",
                           [(asset["id"], asset["collected_at"]) for asset in fixture["assets"]])
            for case in fixture["cases"]:
                rows, _ = library_revisit.home_revisit_rows(db, case["day"])
                self.assertEqual([row["id"] for row in rows], case["ids"], case["day"])

    def test_visible_images_and_limit(self):
        with sqlite3.connect(":memory:") as db:
            db.row_factory = sqlite3.Row
            db.execute("CREATE TABLE visible_assets(id TEXT, collected_at TEXT, committed INTEGER, kind TEXT)")
            db.executemany("INSERT INTO visible_assets VALUES (?, '2025-10-10T00:00:00Z', 1, 'image')",
                           [(f"image-{index:02}",) for index in range(24)])
            db.execute("UPDATE visible_assets SET committed = 0 WHERE id = 'image-00'")
            db.execute("UPDATE visible_assets SET kind = 'video' WHERE id = 'image-01'")
            rows, _ = library_revisit.home_revisit_rows(db, "2026-10-10")
            self.assertEqual(len(rows), 20)
            self.assertEqual(rows[0]["id"], "image-02")


class HomeRouteTests(MobileLibraryApiTests):
    def test_home_route_kst_rollover_and_auth(self):
        self.commit_asset("before", collected_at="2025-10-09T14:59:59Z")
        self.commit_asset("after", collected_at="2025-10-09T15:00:00Z")
        for instant, expected_day, expected_ids in [
            ("2026-10-09T14:59:00+00:00", "2026-10-09", ["before"]),
            ("2026-10-09T15:00:00+00:00", "2026-10-10", ["after"]),
        ]:
            with patch.object(library_revisit, "datetime") as clock:
                clock.now.return_value = datetime.fromisoformat(instant).astimezone(library_revisit.KST)
                clock.strptime.side_effect = datetime.strptime
                response = self.client.get("/v1/library/revisit?home=true", headers=self.auth)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["day"], expected_day)
            self.assertEqual([item["id"] for item in response.json()["bundles"][0]["items"]], expected_ids)
        self.assertEqual(self.client.get("/v1/library/revisit?home=true").status_code, 401)
        self.assertEqual(self.client.get("/v1/library/revisit?home=true&day=bad", headers=self.auth).status_code, 400)
