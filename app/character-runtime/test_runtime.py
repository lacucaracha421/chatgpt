from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
import onnxruntime as ort
from PIL import Image

import runtime

ROOT = Path(__file__).resolve().parents[2]
EXPERIMENT = ROOT / "TEST_kisaki/_experiment"


class RuntimeTests(unittest.TestCase):
    def test_report_counts_do_not_depend_on_path_separators(self):
        from verify import classification_counts
        baseline = {"scores": {"a.png": {"label": "target"}, "b.png": {"label": "other"}, "c.png": {"label": "target"}}}
        for separator in ["/", "\\"]:
            rows = [{"assetId": f"target{separator}a.png", "passed": True},
                    {"assetId": f"others{separator}b.png", "passed": True},
                    {"assetId": f"target{separator}c.png", "passed": False}]
            self.assertEqual(classification_counts(rows, baseline), {"tp": 1, "fp": 1, "fn": 1})

    def test_different_query_crops_cannot_pool_reference_votes(self):
        result = runtime.consensus(np.array([[.1, .4, .4, .4, .4], [.4, .1, .4, .4, .4]]), [1]*5)
        self.assertFalse(result["passed"])

    def test_two_crops_from_one_reference_are_one_vote(self):
        result = runtime.consensus(np.array([[.1, .1, .4, .4, .4, .4]]), [2, 1, 1, 1, 1])
        self.assertFalse(result["passed"])

    def test_threshold_inclusive_and_best_crop_evidence(self):
        t = runtime.BASELINE["threshold"]
        result = runtime.consensus(np.array([[.5]*5, [.1, t, .5, .5, .5]]), [1]*5)
        self.assertTrue(result["passed"])
        self.assertEqual(result["bestQueryCrop"], 1)
        self.assertEqual(result["evidence"][1]["matchedReferences"], [0, 1])
        self.assertFalse(runtime.consensus(np.array([[.1, t+1e-8, .5, .5, .5]]), [1]*5)["passed"])

    def test_invalid_distances_and_reference_groups_rejected(self):
        with self.assertRaises(ValueError):
            runtime.consensus(np.zeros((1, 4)), [1]*4)
        with self.assertRaises(ValueError):
            runtime.consensus(np.full((1, 5), np.nan), [1]*5)

    def test_float32_just_above_public_threshold_is_rejected(self):
        t = runtime.BASELINE["threshold"]
        above = np.float32(t)
        self.assertGreater(float(above), t)
        result = runtime.consensus(np.array([[.1, above, .5, .5, .5]], dtype=np.float32), [1]*5)
        self.assertFalse(result["passed"])
        self.assertEqual(result["evidence"][0]["matchedReferences"], [0])

    def test_duplicate_reference_content_rejected(self):
        engine = runtime.Runtime.__new__(runtime.Runtime)
        feature = runtime.Features("same", [], np.zeros((1, 8), np.float32), True)
        with self.assertRaises(ValueError):
            engine.compare(feature, [feature]*5)

    def test_wrong_model_hash_rejected_before_session_creation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            (path / "model_feat.onnx").write_bytes(b"invalid model")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                runtime.Runtime(path)

    def test_no_detection_and_too_small_crop_use_whole_fallback(self):
        class Detector:
            def get_inputs(self):
                return [type("Input", (), {"name": "input"})()]
            def run(self, *args):
                return [np.zeros((1, 8400, 6), np.float32)]
        class Feature:
            def run(self, *args):
                return [np.ones((1, 8), np.float32)]
        engine = runtime.Runtime.__new__(runtime.Runtime)
        engine.detector, engine.feature = Detector(), Feature()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "blank.png"
            Image.new("RGB", (40, 40)).save(path)
            result = engine.extract(path)
            self.assertTrue(result.fallback)
            self.assertEqual(len(result.vectors), 1)
            from unittest.mock import patch
            with patch.object(runtime, "decode", return_value=(np.array([[0, 0, 2, 2]]), np.array([.9]))):
                self.assertTrue(engine.extract(path).fallback)

    def test_preprocessing_matches_original_experiment(self):
        sys.path.insert(0, str(EXPERIMENT))
        try:
            import analyze
            import crop_ccip
            with tempfile.TemporaryDirectory() as directory:
                p = Path(directory) / "alpha.png"
                Image.new("RGBA", (97, 43), (70, 120, 200, 110)).save(p)
                rotated = Path(directory) / "rotated.jpg"
                exif = Image.Exif(); exif[274] = 6
                Image.new("RGB", (43, 97), "red").save(rotated, exif=exif)
                for path in [p, rotated]:
                    a, b = runtime.rgb(path), analyze.rgb(path)
                    np.testing.assert_array_equal(a, b)
                    np.testing.assert_array_equal(runtime.ccip_input(a), crop_ccip.ccip_input(b))
                    blob, ratio = runtime.letterbox(a)
                    old, old_ratio = crop_ccip.letterbox_bgr(b)
                    np.testing.assert_array_equal(blob, old)
                    self.assertEqual(ratio, old_ratio)
                raw = np.zeros((1, 8400, 6), np.float32)
                raw[0, 200, 4:] = .95
                raw[0, 201, 4:] = .94
                boxes, scores = runtime.decode(raw, (97, 43), .5)
                old_boxes, old_scores = crop_ccip.decode_yolox(raw, (97, 43), .5, .3, .45)
                np.testing.assert_array_equal(boxes, old_boxes)
                np.testing.assert_array_equal(scores, old_scores)
                for box in boxes:
                    self.assertEqual(runtime.expanded_box(box, (97, 43)), crop_ccip.expanded_box(box, (97, 43), .18))
        finally:
            sys.path.remove(str(EXPERIMENT))

    def test_bounded_metric_matches_full_matrix(self):
        # Real frozen metric, real cached features; no detector/feature cache in worker.
        samples = sorted((EXPERIMENT / "crop-cache").glob("*.npy"))[:48]
        self.assertEqual(len(samples), 48)
        stack = np.stack([np.load(p, allow_pickle=False) for p in samples]).astype(np.float32)
        options = ort.SessionOptions(); options.intra_op_num_threads = 1
        engine = runtime.Runtime.__new__(runtime.Runtime)
        engine.metric = ort.InferenceSession(str(EXPERIMENT / "models/model_metrics.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
        engine.max_metric_vectors = 0
        full = engine.metric.run(["output"], {"input": stack})[0]
        refs = [runtime.Features(str(i), [], stack[i:i+1], False) for i in range(5)]
        for i in range(5, 48):
            query = runtime.Features(str(i), [], stack[i:i+1], False)
            expected = runtime.consensus(full[i:i+1, :5], [1]*5)
            actual = engine.compare(query, refs)
            self.assertLessEqual(abs(actual["distance"] - expected["distance"]), 1e-6)
            self.assertEqual(actual["passed"], expected["passed"])
        refs = [runtime.Features(str(i), [], stack[8*i:8*i+8], False) for i in range(5)]
        engine.compare(runtime.Features("query", [], stack[40:48], False), refs)
        self.assertEqual(engine.max_metric_vectors, 48)


if __name__ == "__main__":
    unittest.main()
