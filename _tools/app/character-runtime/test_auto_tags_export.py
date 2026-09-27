import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import numpy as np

from auto_tags_export import export, pack_asset_id, read_vocabulary


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

    def test_v10_pack_mapping_categories_and_complete_zero_score_coverage(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for folder in ("pixai", "canary"):
                (root / folder).mkdir()
            (root / "manifest.json").write_text(json.dumps({"000001": "a", "000002": "b"}))
            (root / "targets.json").write_text(json.dumps({"target": ["alice", "alice_costume"]}))
            (root / "pixai.csv").write_text("id,name,category\n8,hair,0\n9,alice,4\n10,series,3\n11,artist,1\n12,meta,5\n13,safe,9\n")
            (root / "canary.csv").write_text("tag_id,name,category,count\n50,alice,4,1\n51,hair,0,1\n")
            np.savez(root / "pixai/chunk_0.npz", ids=np.array(["000001.jpg", "000002"]),
                     rows=np.array([0, 0, 0, 0, 0, 0]), tags=np.arange(6),
                     scores=np.array([0.34, 0.1, 0.2, 0.3, 0.36, 0.9], dtype=np.float16))
            np.savez(root / "canary/chunk_0.npz", ids=np.array(["000001", "000002"]),
                     rows=np.array([0, 0]), tags=np.array([0, 1]),
                     scores=np.array([0.9, 0.99], dtype=np.float16), emb=np.zeros((2, 1)))
            out = root / "import.sqlite"
            export(root / "pixai", root / "pixai.csv", "pixai-v1.0", out,
                   manifest_path=root / "manifest.json", canary_backfill=root / "canary",
                   canary_tags=root / "canary.csv", target_tags=root / "targets.json")
            with sqlite3.connect(out) as c:
                self.assertEqual(dict(c.execute("SELECT tag,category FROM vocabulary")),
                                 dict(v for v in read_vocabulary(root / "pixai.csv") if v))
                self.assertEqual({r[0] for r in c.execute("SELECT tag FROM asset_tags")},
                                 {"alice", "series", "artist", "meta", "safe"})
                self.assertEqual(c.execute("SELECT COUNT(*) FROM tagger_assets").fetchone()[0], 4)
                self.assertEqual(c.execute("SELECT COUNT(*) FROM character_scores").fetchone()[0], 2)
                self.assertEqual(c.execute("SELECT COUNT(*) FROM target_tags").fetchone()[0], 2)
                self.assertEqual(c.execute("SELECT COUNT(*) FROM tagger_vocabulary").fetchone()[0], 2)
            self.assertEqual(pack_asset_id(b"000001.jpg", {"000001": "a"}), "a")
            with self.assertRaises(ValueError):
                pack_asset_id("missing", {"000001": "a"})
            before = out.read_bytes()
            (root / "manifest.json").write_text("{}")
            with self.assertRaises(ValueError):
                export(root / "pixai", root / "pixai.csv", "pixai-v1.0", out,
                       manifest_path=root / "manifest.json")
            self.assertEqual(out.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
