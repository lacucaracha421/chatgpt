"""Plain-Python coverage of the actual read helper; no HTTP dependencies."""
import ast
import copy
import json
import re
import sqlite3
import unittest
from pathlib import Path


tree = ast.parse((Path(__file__).resolve().parents[1] / "collection_authority.py").read_text("utf-8"))
helper = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "volume_details")
namespace = {"json": json, "re": re}
exec(compile(ast.Module(body=[helper], type_ignores=[]), "collection_authority.py", "exec"), namespace)
volume_details = namespace["volume_details"]


class VolumeDetailsTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        self.addCleanup(self.db.close)
        self.db.execute("CREATE TABLE collection_authority_volume_sources(library_id,work_id,volume_number,provider,publisher,isbn13,data,deleted)")
        self.item = {"id": "work", "type": "manga", "volumes": [
            {"id": "one", "volumeNumber": 1, "editionIndex": 0},
            {"id": "special", "volumeNumber": 1, "editionIndex": 1},
            {"id": "two", "volumeNumber": 2, "editionIndex": 0, "isbn13": "legacy"}]}

    def source(self, provider="kakao", publisher="Publisher", data=None, deleted=0, library="library", work="work"):
        self.db.execute("INSERT INTO collection_authority_volume_sources VALUES(?,?,?,?,?,?,?,?)",
                        (library, work, 1, provider, publisher, "9780306406157", json.dumps(data or {}), deleted))

    def test_pre_feature_projection_uses_kakao_before_aladin_without_writes(self):
        self.source("aladin", "Other", {"contents": "Other copy", "price": 100})
        self.source(data={"contents": " Synopsis ", "price": " 12000 ", "sale_price": 9000})
        self.source(data={"contents": "Wrong library"}, library="other")
        self.source(data={"contents": "Wrong work"}, work="other")
        before = list(self.db.iterdump())
        result = volume_details(self.db, "library", self.item)
        for volume in result["volumes"][:2]:
            self.assertEqual(volume["contents"], "Synopsis")
            self.assertEqual(volume["price"], 12000)
            self.assertEqual(volume["publisher"], "Publisher")
            self.assertEqual(volume["isbn13"], "9780306406157")
        self.assertEqual(result["volumes"][2]["isbn13"], "legacy")
        self.assertEqual(list(self.db.iterdump()), before)

    def test_aladin_and_deleted_sources(self):
        self.source(deleted=1, data={"contents": "Deleted", "price": 12000})
        self.source("aladin", " ", {"publisher": " Raw publisher ", "contents": "Do not print", "price": 100})
        volume = volume_details(self.db, "library", self.item)["volumes"][0]
        self.assertEqual(volume["publisher"], "Raw publisher")
        self.assertNotIn("contents", volume)
        self.assertNotIn("price", volume)

    def test_price_validation_and_text_bounds(self):
        for price in (None, True, -1, 0, 12.5, "12.5", "1e3", "1,000", "１２", 9007199254740992):
            with self.subTest(price=price):
                self.db.execute("DELETE FROM collection_authority_volume_sources")
                self.source(publisher="p" * 2001, data={"contents": "x" * 20001, "price": price})
                volume = volume_details(self.db, "library", copy.deepcopy(self.item))["volumes"][0]
                self.assertNotIn("price", volume)
                self.assertEqual(len(volume["contents"]), 20000)
                self.assertEqual(len(volume["publisher"]), 2000)

    def test_missing_malformed_and_non_manga_data(self):
        before = copy.deepcopy(self.item)
        self.assertEqual(volume_details(self.db, "library", self.item), before)
        self.source(data={"contents": {}, "price": [], "publisher": 4}, publisher=None)
        for raw in ("invalid", "[]", "null"):
            self.db.execute("UPDATE collection_authority_volume_sources SET data=?", [raw])
            volume = volume_details(self.db, "library", copy.deepcopy(self.item))["volumes"][0]
            self.assertNotIn("contents", volume)
            self.assertNotIn("price", volume)
            self.assertNotIn("publisher", volume)
        movie = {**copy.deepcopy(before), "type": "movie"}
        self.assertEqual(volume_details(self.db, "library", movie), {**before, "type": "movie"})
