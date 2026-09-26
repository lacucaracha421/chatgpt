import contextlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import numpy as np

import candidate_groups as cg
from character_encoder import feature_id

SCHEMA_SQL = """
CREATE TABLE assets(id, content_hash, media_kind, width, height, thumbnail_relative_path, source_url,
  import_batch_id, perceptual_hash, status, trashed_at);
CREATE TABLE character_decisions(sequence, target_id, asset_id, source_asset_id, decision, origin);
CREATE TABLE character_references(target_id, slot, asset_id);
CREATE TABLE character_reference_regions(target_id, asset_id, bounds_json);
CREATE TABLE classification_entries(id, name, parent_id);
CREATE TABLE character_series(classification_id);
CREATE TABLE asset_classifications(asset_id, classification_id);
CREATE TABLE character_targets(id, display_name, series_classification_id);
"""


def clique(members, weight=0.9):
    return {(i, j): weight for i in members for j in members if i < j}


class ChineseWhispersTests(unittest.TestCase):
    def test_two_cliques_and_singletons(self):
        edges = {**clique([0, 1, 2]), **clique([3, 4, 5, 6])}
        labels = cg.chinese_whispers(8, edges)
        self.assertEqual(len({labels[0], labels[1], labels[2]}), 1)
        self.assertEqual(len({labels[3], labels[4], labels[5], labels[6]}), 1)
        self.assertNotEqual(labels[0], labels[3])
        self.assertEqual(labels[7], -1)

    def test_deterministic_and_seed_independent_on_clean_graph(self):
        edges = {**clique([0, 2, 4, 6]), **clique([1, 3, 5]), (6, 7): 0.5, (4, 7): 0.5}
        first = cg.chinese_whispers(9, edges, seed=0)
        self.assertEqual(first.tolist(), cg.chinese_whispers(9, dict(reversed(list(edges.items()))), seed=0).tolist())
        for seed in range(5):
            self.assertEqual(first.tolist(), cg.chinese_whispers(9, edges, seed=seed).tolist())
        self.assertEqual(first.tolist(), [0, 1, 0, 1, 0, 1, 0, 0, -1])

    def test_knn_graph_is_symmetric_and_thresholded(self):
        rng = np.random.default_rng(1)
        base = np.eye(768, dtype=np.float32)[:2]
        vectors = cg.unit(np.concatenate([base[0] + 0.005 * rng.standard_normal((4, 768)),
                                          base[1] + 0.005 * rng.standard_normal((3, 768))]).astype(np.float32))
        edges = cg.knn_graph(vectors, 10, 0.2, block=3)
        self.assertTrue(all(i < j for i, j in edges))
        self.assertEqual(set(edges), set(clique([0, 1, 2, 3])) | set(clique([4, 5, 6])))
        self.assertEqual(cg.knn_graph(vectors, 10, 0.0), {})


class ClassifyTests(unittest.TestCase):
    def run_classify(self, statuses, labels=None, assets=None, posts=None, median=0.1):
        n = len(statuses)
        return cg.classify(statuses, labels or [""] * n, assets or [str(i) for i in range(n)],
                           posts or [str(i) for i in range(n)], median)

    def test_rules(self):
        u = "unlabeled"
        self.assertEqual(self.run_classify([u] * 4)[1], "too_few_assets")
        self.assertEqual(self.run_classify(["confirmed"] * 3 + [u] * 3, ["t"] * 3 + [""] * 3)[1], "mostly_labeled")
        self.assertEqual(self.run_classify(["confirmed"] + [u] * 5, ["t"] + [""] * 5),
                         ("expand_known", "pure_known_mostly_unlabeled", "t"))
        self.assertEqual(self.run_classify(["confirmed"] + [u] * 5, ["t"] + [""] * 5, median=0.2)[1], "loose_known")
        mixed = ["confirmed"] * 2 + [u] * 8
        self.assertEqual(self.run_classify(mixed, ["t", "s"] + [""] * 8)[1], "mixed_known")
        self.assertEqual(self.run_classify(["auto"] + [u] * 5)[1], "has_confirmed_or_auto")
        self.assertEqual(self.run_classify([u] * 6, posts=["p", "p", "q", "q", "q", "p"])[1], "few_source_posts")
        self.assertEqual(self.run_classify([u] * 6, median=0.14)[1], "loose")
        self.assertEqual(self.run_classify([u] * 6)[0], "new_candidate")

    def test_policy_thresholds_read_s36_v1(self):
        policy = json.loads((cg.HERE / "s36_policy.json").read_text(encoding="utf-8"))
        edge, suggest = cg.policy_thresholds(policy)
        self.assertAlmostEqual(edge, 0.1304, places=4)
        self.assertAlmostEqual(suggest, 0.1490, places=4)
        with self.assertRaises(ValueError):
            cg.policy_thresholds({"version": "other"})


class ReportTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.library = Path(temp.name) / "library"
        features = self.library / ".cache/characters" / cg.S36_NAMESPACE / feature_id()
        features.mkdir(parents=True)
        rng = np.random.default_rng(0)
        axes = np.eye(768, dtype=np.float32)
        rows = []
        # Character "t": 2 references + 6 unlabeled (one manually rejected); unnamed group: 6 images.
        for n, (axis, prefix) in enumerate([(0, "a")] * 8 + [(1, "b")] * 6 + [(2, "c")]):
            h = f"{n:064x}"
            vector = axes[axis] + 0.005 * rng.standard_normal(768).astype(np.float32)
            np.savez(features / f"{h}.npz", feature_id=feature_id(), content_hash=h,
                     boxes=np.asarray([[0, 0, 50, 100]], np.int32), vectors=vector[None], fallback=False)
            rows.append((f"{prefix}{n}", h, "image", 100, 200, f"thumbnails/{h}.webp",
                         f"https://x.com/u/status/{n}/photo/1", None, None, "normal", None))
        self.database = Path(temp.name) / "copy.sqlite"
        with sqlite3.connect(self.database) as c:
            c.executescript(SCHEMA_SQL)
            c.executemany("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?)", rows)
            c.executemany("INSERT INTO character_references VALUES('t', ?, ?)", [(0, "a0"), (1, "a1")])
            c.execute("INSERT INTO character_reference_regions VALUES('t', 'a1', '[0,0,50,100]')")
            c.execute("INSERT INTO character_decisions VALUES(1, 't', 'a7', 'a7', 'rejected', 'manual')")
            c.execute("INSERT INTO character_targets VALUES('t', 'Tee', 's')")
            c.execute("INSERT INTO classification_entries VALUES('s', 'Series', NULL)")
            c.execute("INSERT INTO character_series VALUES('s')")
        self.before = self.database.read_bytes()
        self.output = Path(temp.name) / "out"

    def build(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            cg.main(["build", "--library", str(self.library), "--database", str(self.database),
                     "--output-dir", str(self.output)])
        return json.loads((self.output / "report.json").read_text(encoding="utf-8"))

    def test_schema_classification_and_read_only(self):
        report = self.build()
        self.assertEqual(self.database.read_bytes(), self.before)
        self.assertEqual(report["schema"], cg.SCHEMA)
        self.assertEqual(report["policy"]["version"], cg.POLICY["version"])
        self.assertEqual(set(report), {"schema", "policy", "shadow_only", "label_rule", "summary",
                                       "expand_known", "new_candidates", "library_root", "generated_at"})
        summary = report["summary"]
        self.assertEqual((summary["expand_known_groups"], summary["expand_known_suggested_assets"],
                          summary["new_candidate_groups"]), (1, 5, 1))
        group = report["expand_known"][0]
        self.assertEqual(group["target"], {"id": "t", "name": "Tee", "series_id": "s", "series": "Series"})
        self.assertEqual(group["purity"], 1.0)
        self.assertEqual(group["excluded_rejected_asset_ids"], ["a7"])
        self.assertEqual([r["asset_id"] for r in group["references"]], ["a0", "a1"])
        self.assertEqual(group["references"][1]["box"], [0, 0, 50, 100])
        suggestion = group["suggestions"][0]
        self.assertEqual(set(suggestion), {"asset_id", "thumbnail", "image_size", "crops", "knn3_to_confirmed"})
        self.assertEqual(suggestion["crops"], [{"index": 0, "box": [0, 0, 50, 100]}])
        self.assertLess(suggestion["knn3_to_confirmed"], report["policy"]["suggestion_max_knn3"])
        self.assertEqual({s["asset_id"] for s in group["suggestions"]}, {"a2", "a3", "a4", "a5", "a6"})
        self.assertEqual(report["new_candidates"][0]["asset_ids"], sorted(f"b{n}" for n in range(8, 14)))
        self.assertEqual(set(report["new_candidates"][0]), {"id", "asset_ids"})
        preview = (self.output / "preview.html").read_text(encoding="utf-8")
        self.assertIn("Tee", preview)
        self.assertEqual(preview.count('class="ref"'), 2)
        self.assertEqual(preview.count('class="sug"'), 5)
        # Same input, same report (apart from timing fields).
        again = self.build()
        for r in (report, again):
            r.pop("generated_at")
            for key in ("total_seconds", "graph_and_clustering_seconds"):
                r["summary"].pop(key)
        self.assertEqual(report, again)


if __name__ == "__main__":
    unittest.main()
