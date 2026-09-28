"""Synthetic-only coverage for the portable artist feature exporter."""
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import numpy as np
from artist_style_export import DIM, export


class ExportTests(unittest.TestCase):
    def test_shapes_bytes_and_mean(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            feats = np.arange(3 * DIM, dtype=np.float32).reshape(3, DIM) / 32
            np.savez(root / "preds.npz", ids=np.array(["000001.jpg", "000002", "000003"]), feat=feats)
            (root / "manifest.json").write_text(json.dumps({"000001": "a", "000002": "b", "000003": "c"}))
            self.assertEqual(export(root / "preds.npz", root / "manifest.json", root / "out.sqlite"), 3)
            with closing(sqlite3.connect(root / "out.sqlite")) as conn:
                meta = dict(conn.execute("SELECT key,value FROM meta"))
                self.assertEqual((meta["model"], meta["dim"]), ("kaloscope2", "2048"))
                np.testing.assert_array_equal(np.frombuffer(meta["mean"], dtype="<f4"), feats.mean(axis=0))
                rows = conn.execute("SELECT asset_id,vector FROM features ORDER BY asset_id").fetchall()
                self.assertEqual([row[0] for row in rows], ["a", "b", "c"])
                self.assertTrue(all(len(row[1]) == DIM * 2 for row in rows))
                np.testing.assert_array_equal(np.frombuffer(rows[1][1], dtype="<f2"), feats[1].astype("<f2"))

    def test_daily_chunks_add_new_assets_and_replace_repeated_ones(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            feats = np.ones((2, DIM), dtype=np.float32)
            np.savez(root / "preds.npz", ids=np.array(["000001", "000002"]), feat=feats)
            (root / "manifest.json").write_text(json.dumps({"000001": "a", "000002": "b"}))
            (root / "daily").mkdir()
            np.savez(root / "daily" / "style_1.npz", ids=np.array(["b", "c"]), feat=np.full((2, DIM), 3, np.float32))
            self.assertEqual(export(root / "preds.npz", root / "manifest.json", root / "out.sqlite", root / "daily"), 3)
            with closing(sqlite3.connect(root / "out.sqlite")) as conn:
                rows = dict(conn.execute("SELECT asset_id,vector FROM features"))
                mean = np.frombuffer(dict(conn.execute("SELECT key,value FROM meta"))["mean"], dtype="<f4")
            self.assertEqual(sorted(rows), ["a", "b", "c"])
            self.assertEqual(np.frombuffer(rows["b"], dtype="<f2")[0], 3)
            self.assertAlmostEqual(float(mean[0]), (1 + 3 + 3) / 3, places=5)

    def test_bad_input_preserves_existing_output(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / "out.sqlite"
            output.write_bytes(b"keep")
            (root / "manifest.json").write_text('{"1":"a"}')
            for ids, features in [(["missing"], np.zeros((1, DIM))), (["1"], np.zeros((1, 512))),
                                  (["1"], np.full((1, DIM), np.nan)), (["1"], np.full((1, DIM), 1e8)),
                                  (["1", "1"], np.zeros((2, DIM)))]:
                np.savez(root / "preds.npz", ids=np.array(ids), feat=features)
                with self.assertRaises(ValueError):
                    export(root / "preds.npz", root / "manifest.json", output)
                self.assertEqual(output.read_bytes(), b"keep")


if __name__ == "__main__":
    unittest.main()
