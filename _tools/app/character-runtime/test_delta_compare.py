from pathlib import Path
import os
from types import SimpleNamespace
import unittest

import numpy as np
import onnxruntime as ort

from learned_compare import compare_supported, compare_reference_delta
import runtime

ROOT = Path(__file__).resolve().parents[2]
EXPERIMENT = ROOT / "TEST_kisaki/_experiment"


class DeterministicEngine:
    def __init__(self):
        self.compared_hashes = []

    @staticmethod
    def rows(references):
        values = [int(ref.content_hash) for ref in references]
        return [[0.05 + value / 1000 for value in values],
                [0.20 + value / 1000 for value in values]]

    def compare(self, query, references):
        rows = self.rows(references)
        second = [sorted(row)[1] for row in rows]
        best = int(np.argmin(second))
        return {
            "contentHash": "query", "queryBoxes": [[0, 0, 10, 10], [1, 1, 9, 9]],
            "wholeFallback": False, "baselineFingerprint": runtime.FINGERPRINT,
            "distance": second[best], "passed": second[best] <= runtime.BASELINE["threshold"],
            "bestQueryCrop": best,
            "evidence": [{"queryCrop": i, "distance": second[i],
                          "matchedReferences": [j for j, value in enumerate(row) if value <= runtime.BASELINE["threshold"]],
                          "referenceDistances": row} for i, row in enumerate(rows)],
            "referenceHashes": [ref.content_hash for ref in references],
            "referenceBoxes": [ref.boxes for ref in references],
            "referenceWholeFallback": [ref.fallback for ref in references],
        }

    def reference_distances(self, query, references):
        self.compared_hashes.extend(ref.content_hash for ref in references)
        return self.rows(references)

def refs(count):
    return [SimpleNamespace(content_hash=str(index), boxes=[], fallback=False) for index in range(count)]


def projection(result):
    keys = ("distance", "passed", "bestQueryCrop", "evidence", "referenceHashes",
            "referenceBoxes", "referenceWholeFallback", "learnedReferenceCount")
    return {key: result[key] for key in keys}


class DeltaCompareTests(unittest.TestCase):
    def test_delta_matches_full_and_only_requests_added_reference_distances(self):
        references = refs(10)
        query = SimpleNamespace(content_hash="query", boxes=[[0, 0, 10, 10], [1, 1, 9, 9]], fallback=False, vectors=np.zeros((2, 1), dtype=np.float32))
        old_engine = DeterministicEngine()
        old = compare_supported(old_engine, query, references[:7])
        engine = DeterministicEngine()
        delta = compare_reference_delta(engine, query, old, references[7:])
        full = compare_supported(DeterministicEngine(), query, references)
        self.assertEqual(projection(delta), projection(full))
        self.assertEqual(engine.compared_hashes, ["7", "8", "9"])
        self.assertEqual([row["referenceDistances"][:7] for row in delta["evidence"]],
                         [row["referenceDistances"] for row in old["evidence"]])

    def test_delta_rejects_non_additive_or_stale_evidence(self):
        references = refs(6)
        query = SimpleNamespace(content_hash="query", boxes=[[0, 0, 10, 10], [1, 1, 9, 9]], fallback=False, vectors=np.zeros((2, 1), dtype=np.float32))
        old = compare_supported(DeterministicEngine(), query, references[:5])
        with self.assertRaisesRegex(ValueError, "strict addition"):
            compare_reference_delta(DeterministicEngine(), query, old, [references[0]])
        stale = {**old, "contentHash": "other"}
        with self.assertRaisesRegex(ValueError, "query identity"):
            compare_reference_delta(DeterministicEngine(), query, stale, [references[5]])
        broken = {**old, "evidence": [{**old["evidence"][0], "referenceDistances": [0.1]}]}
        with self.assertRaisesRegex(ValueError, "old evidence"):
            compare_reference_delta(DeterministicEngine(), query, broken, [references[5]])

    def test_real_frozen_metric_delta_matches_full_comparison(self):
        model_dir = os.environ.get("LAKOMICS_CHARACTER_TEST_MODELS")
        if not model_dir:
            self.skipTest("set LAKOMICS_CHARACTER_TEST_MODELS to run frozen metric parity")
        metric_path = Path(model_dir) / "model_metrics.onnx"
        self.assertTrue(metric_path.is_file())
        options = ort.SessionOptions(); options.intra_op_num_threads = 1
        engine = runtime.Runtime.__new__(runtime.Runtime)
        engine.metric = ort.InferenceSession(str(metric_path), sess_options=options, providers=["CPUExecutionProvider"])
        engine.max_metric_vectors = 0
        rng = np.random.default_rng(421)
        vectors = rng.normal(size=(12, 768)).astype(np.float32)
        vectors /= np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-9)
        query = runtime.Features("query", [[0, 0, 10, 10], [1, 1, 9, 9]], vectors[10:12], False)
        references = [runtime.Features(str(i), [], vectors[i:i+1], False) for i in range(10)]
        old = compare_supported(engine, query, references[:7])
        delta = compare_reference_delta(engine, query, old, references[7:10])
        full = compare_supported(engine, query, references)
        self.assertEqual(delta["passed"], full["passed"])
        self.assertEqual(delta["bestQueryCrop"], full["bestQueryCrop"])
        self.assertEqual(delta["referenceHashes"], full["referenceHashes"])
        np.testing.assert_allclose(
            [row["referenceDistances"] for row in delta["evidence"]],
            [row["referenceDistances"] for row in full["evidence"]], atol=1e-6, rtol=0,
        )


if __name__ == "__main__":
    unittest.main()
