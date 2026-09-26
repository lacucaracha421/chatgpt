import sqlite3
import tempfile
import unittest
from pathlib import Path

import numpy as np

from auto_tags_export import export


class AutoTagsExportTest(unittest.TestCase):
    def test_writes_import_file_with_threshold_and_skips_failed_assets(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "backfill").mkdir()
            (root / "tags.csv").write_text(
                "id,tag_id,name,category,count,ips\n"
                "0,1,1girl,0,10,[]\n1,2,long_hair,0,5,[]\n2,3,hoshino_(blue_archive),4,3,[]\n3,-1,,0,-1,[]\n",
                encoding="utf-8",
            )
            np.savez(
                root / "backfill" / "chunk_00000.npz",
                asset_ids=np.array(["a", "b", "failed"], dtype=object),
                rows=np.array([0, 0, 0, 1, 1], dtype=np.int32),
                tags=np.array([0, 1, 2, 0, 3], dtype=np.int32),
                scores=np.array([0.99, 0.2, 0.9, 0.5, 0.8], dtype=np.float16),
                emb=np.zeros((2, 4), dtype=np.float16),
                errors=np.array("[]"),
            )
            out = root / "out.sqlite"
            summary = export(root / "backfill", root / "tags.csv", "pixai-v0.9", out)
            self.assertEqual((summary["assets"], summary["rows"], summary["vocabulary"]), (2, 3, 3))
            connection = sqlite3.connect(out)
            meta = dict(connection.execute("SELECT key, value FROM meta"))
            self.assertEqual((meta["format"], meta["version"], meta["model"]), ("lakomics-auto-tags", "1", "pixai-v0.9"))
            rows = connection.execute("SELECT asset_id, tag, round(score, 2) FROM asset_tags ORDER BY asset_id, tag").fetchall()
            self.assertEqual(rows, [("a", "1girl", 0.99), ("a", "hoshino_(blue_archive)", 0.9), ("b", "1girl", 0.5)])
            self.assertEqual(
                dict(connection.execute("SELECT tag, category FROM vocabulary"))["hoshino_(blue_archive)"],
                "character",
            )
            connection.close()
            self.assertFalse((root / "out.sqlite.partial").exists())


if __name__ == "__main__":
    unittest.main()
