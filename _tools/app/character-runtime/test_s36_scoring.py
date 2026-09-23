"""Numerical replay and native geometry parity, without ONNX."""
from pathlib import Path
import subprocess
import sys
import unittest

import numpy as np

import s36_scoring as scoring


def rows(axes):
    return np.eye(768, dtype=np.float32)[list(axes)]


class ScoringTests(unittest.TestCase):
    def test_ccip_normalization(self):
        a = rows([0, 1])
        np.testing.assert_array_equal(scoring.cosine_distance(a * 3, a * 7), [[0, .5], [.5, 0]])
        self.assertEqual(scoring.cosine_distance(a[:1], -a[:1])[0, 0], 1)
        for bad in (np.zeros((1, 768)), np.full((1, 768), np.nan)):
            with self.assertRaises(ValueError):
                scoring.unit(bad)

    def test_knn3_short_pools_and_per_crop_contrast(self):
        q, p, n = rows([0, 1]), rows([0, 2]), rows([1])
        empty = p[:0]
        np.testing.assert_array_equal(scoring.knn(q, p), [.25, .5])
        result = scoring.crop_scores(q * 4, p * 2, n * 5, empty)
        np.testing.assert_array_equal(result['knn3'], [.25, .5])
        np.testing.assert_array_equal(result['contrast'], [-.25, .5])
        self.assertIsNone(scoring.crop_scores(q, empty, n, p)['knn3'])
        np.testing.assert_array_equal(scoring.crop_scores(q, p, empty, empty)['contrast'], [-.75, -.5])
        # Rejections use the SAME knn3 mean as historical replay, not nearest-1.
        np.testing.assert_array_equal(scoring.knn(q[:1], rows([0, 1, 2, 3])), np.array([1/3], np.float32))

    def test_same_person_native_boundary_containment_and_disjoint(self):
        # Exact formula transcribed from the inspected Rust function; boxes valid.
        def native(a, b):
            intersection = max(min(a[2], b[2])-max(a[0], b[0]), 0) * max(min(a[3], b[3])-max(a[1], b[1]), 0)
            smaller = min((a[2]-a[0])*(a[3]-a[1]), (b[2]-b[0])*(b[3]-b[1]))
            return intersection / smaller >= .5
        a = [0, 0, 10, 10]
        for b, expected in [([5, 0, 15, 10], True), ([5.001, 0, 15.001, 10], False),
                            ([2, 2, 3, 3], True), ([10, 0, 20, 10], False)]:
            self.assertEqual(scoring.same_person(a, b), expected)
            self.assertEqual(scoring.same_person(a, b), native(a, b))
            self.assertEqual(scoring.same_person(b, a), expected)
        self.assertFalse(scoring.same_person(a, [0, 0, 0, 0]))
        self.assertFalse(scoring.same_person(a, [0, 0, float('nan'), 1]))

    def test_import_does_not_load_onnx(self):
        result = subprocess.run([sys.executable, '-B', '-c',
            "import s36_scoring, sys; assert 'onnxruntime' not in sys.modules; assert 'runtime' not in sys.modules"],
            cwd=Path(__file__).parent, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
