import contextlib
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from replay_dataset import SCHEMA, canonical
from s36_shadow_report import main, report


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.library = self.root / "library"
        self.cache = self.library / ".cache/characters/s36_shadow.sqlite"
        self.cache.parent.mkdir(parents=True)
        with sqlite3.connect(self.cache) as c:
            c.execute("CREATE TABLE scores(asset_id,content_hash,target_id,knn3,verdict,policy_version,feature_id,native_outcome,native_at,scored_at,prior_manual_rejections)")
            for i, verdict in enumerate(("automatic", "automatic", "recommended", "none", "abstain", "recommended")):
                c.execute("INSERT INTO scores VALUES(?,?,?,?,?,?,?,?,?,?,?)", (str(i),"a"*64,"t",.1,verdict,"v1","f"*64,"recommended","2026-01-01T00:00:00Z","2026-01-02T00:00:00Z",100))
        self.data = {"schema": SCHEMA, "library_root": str(self.library),
                     "assets": [{"id":str(i),"content_hash":"a"*64,"status":"normal","media_kind":"image"} for i in range(6)],
                     "decisions": []}
        for i, decision in enumerate(("accepted","rejected","accepted","rejected","accepted")):
            self.data["decisions"].append({"sequence":i+1,"source_asset_id":str(i),"asset_hash":"a"*64,"target_id":"t","origin":"manual","decision":decision,"created_at":"2026-01-03T00:00:00Z"})
        self.dataset = self.root / "export.json"
        self.save()

    def save(self):
        self.dataset.write_text(json.dumps({"sha256":hashlib.sha256(canonical(self.data)).hexdigest(),"dataset":self.data}))

    def test_manual_rates_cross_table_and_no_database_writes(self):
        before = self.cache.read_bytes()
        result, library = report(self.cache,self.dataset)
        bucket = result["policies"]["v1:"+"f"*64]
        self.assertEqual(result["recorded"],6)
        self.assertEqual(bucket["automatic_precision"],.5)
        self.assertEqual(bucket["recommendation_acceptance_rate"],1)
        self.assertEqual(bucket["verdicts"]["recommended"]["unreviewed"],1)
        self.assertEqual(bucket["native_comparison"]["recommended"]["automatic"]["rejected"],1)
        self.assertEqual(bucket["agreement"],{"comparable":5,"agreed":2,"rate":.4})
        self.assertEqual(self.cache.read_bytes(),before)
        self.assertEqual(library,self.library)
        self.assertFalse((self.library/"library.sqlite").exists())

    def test_old_equal_automatic_cleared_changed_and_wrong_target_labels_excluded(self):
        self.data["decisions"][0]["created_at"] = "2026-01-02T00:00:00Z"
        self.data["decisions"][1]["origin"] = "automatic"
        self.data["decisions"][2]["decision"] = "cleared"
        self.data["assets"][3]["content_hash"] = "b"*64
        self.data["decisions"][4]["target_id"] = "other"
        self.save()
        result,_ = report(self.cache,self.dataset)
        bucket = result["policies"]["v1:"+"f"*64]
        self.assertIsNone(bucket["automatic_precision"])
        self.assertIsNone(bucket["recommendation_acceptance_rate"])
        self.assertEqual(sum(v["unreviewed"] for v in bucket["verdicts"].values()),6)

    def test_cli_prints_and_writes_only_outside_library_exclusive(self):
        output = self.root / "report.json"
        args = ["--cache",str(self.cache),"--dataset",str(self.dataset)]
        with contextlib.redirect_stdout(io.StringIO()) as stream:
            main(args+["--output",str(output)])
        self.assertEqual(json.loads(stream.getvalue()),json.loads(output.read_text()))
        for bad in (self.library/"bad.json",output):
            with contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):
                main(args+["--output",str(bad)])
        link = self.root/"link";link.symlink_to(self.library,target_is_directory=True)
        with contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):
            main(args+["--output",str(link/"bad.json")])
        self.assertFalse((self.library/"bad.json").exists())

    def test_rejects_library_database_without_opening_it_and_bad_digest(self):
        db = self.library/"library.sqlite";db.write_bytes(b"do not open")
        with patch("sqlite3.connect",side_effect=AssertionError("must not open library DB")):
            with self.assertRaises(ValueError):report(db,self.dataset)
        self.dataset.write_text('{"sha256":"bad","dataset":{"schema":"wrong"}}')
        with self.assertRaises(ValueError):report(self.cache,self.dataset)


if __name__ == "__main__":
    unittest.main()
