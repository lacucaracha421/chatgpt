import hashlib
import unittest
from unittest.mock import Mock

import numpy as np

from runtime import BASELINE, FINGERPRINT, Features, Runtime
from reference_regions import project_reference, compare_bound, compare_bound_delta, inspect_references
from reference_curation import select_core_references, metric_distances


def feature(name, values, boxes=None):
    if boxes is None:
        boxes = [(i * 100, 0, i * 100 + 80, 100) for i in range(len(values))]
    return Features(hashlib.sha256(name.encode()).hexdigest(), boxes,
                    np.asarray(values, dtype=np.float32).reshape(-1, 1), not boxes)


def binding(f, index=0):
    return {"contentHash": f.content_hash, "baselineFingerprint": FINGERPRINT,
            "bounds": list(f.boxes[index])}


class Metric:
    def __init__(self):
        self.largest = 0
    def run(self, outputs, inputs):
        v = inputs["input"][:, 0]
        self.largest = max(self.largest, len(v))
        return [np.abs(v[:, None] - v[None, :]).astype(np.float32)]


def engine():
    value = Runtime.__new__(Runtime)
    value.metric = Metric()
    value.max_metric_vectors = 0
    return value


class RegionTests(unittest.TestCase):
    def test_selected_person_does_not_vote_for_a_companion(self):
        refs = [feature(str(i), [.8, .05]) for i in range(6)]
        query = feature("query", [.05])
        result = compare_bound(engine(), query, refs, [binding(f) for f in refs])
        self.assertFalse(result["passed"])
        self.assertTrue(all(row["matchedReferences"] == [] for row in result["evidence"]))
        self.assertEqual(result["referenceRegions"][0], binding(refs[0]))

    def test_unselected_multi_person_and_fallback_never_supply_votes(self):
        refs = [feature(str(i), [.02, .03]) for i in range(5)]
        refs.append(feature("fallback", [.02], []))
        result = compare_bound(engine(), feature("query", [.02]), refs, [None] * 6)
        self.assertFalse(result["passed"])
        self.assertEqual(result["referenceStatuses"], ["needs_region"] * 5 + ["no_region"])
        self.assertEqual(result["referenceSelections"], [None] * 6)

    def test_single_person_is_automatic_and_feature_objects_are_immutable(self):
        f = feature("single", [.1]); before = f.vectors.copy()
        selected, status, region = project_reference(f, None)
        self.assertEqual(status, "single")
        self.assertEqual(region, binding(f))
        np.testing.assert_equal(before, f.vectors)
        self.assertEqual(selected.content_hash, f.content_hash)

    def test_invalid_or_stale_binding_fails_closed(self):
        f = feature("multi", [.1, .2])
        for bad in [dict(binding(f), contentHash="bad"), dict(binding(f), baselineFingerprint="old"),
                    dict(binding(f), bounds=[0, 0, 9, 9]), dict(binding(f), bounds=[0., 0, 80, 100])]:
            with self.assertRaises(ValueError): project_reference(f, bad)

    def test_delta_and_full_results_agree_when_adding_a_bound_reference(self):
        refs = [feature(str(i), [.03]) for i in range(5)]
        extra = feature("extra", [.03, .8]); q = feature("query", [.03]); e = engine()
        old = compare_bound(e, q, refs, [None] * 5)
        delta = compare_bound_delta(e, q, old, [extra], [binding(extra, 1)])
        full = compare_bound(e, q, refs + [extra], [None] * 5 + [binding(extra, 1)])
        for field in ["passed", "distance", "evidence", "referenceRegions", "referenceStatuses", "referenceSelections"]:
            self.assertEqual(delta[field], full[field], field)
        self.assertEqual(len(delta["evidence"][0]["matchedReferences"]), 5)

    def test_multi_region_suggestion_is_not_an_implicit_selection(self):
        refs = [feature(str(i), [.03 + i * .01]) for i in range(5)]
        refs.append(feature("multi", [.8, .04]))
        result = inspect_references(engine(), refs, [None] * 6)
        self.assertEqual(result[-1]["suggestedIndex"], 1)
        self.assertIsNone(result[-1]["selectedIndex"])


class CurationTests(unittest.TestCase):
    def test_outlier_is_not_selected_just_because_it_is_different(self):
        d = np.abs(np.array([0., .01, .03, .07, .08, .11, .7])[:, None]
                   - np.array([0., .01, .03, .07, .08, .11, .7])[None, :])
        chosen = select_core_references(d, 0, 20)
        self.assertEqual(set(chosen), set(range(6)))
        self.assertEqual(chosen, select_core_references(d, 0, 20))

    def test_existing_references_constrain_candidates_and_do_not_become_suggestions(self):
        v = np.array([0., .02, .04, .06, .1, .12, .8])
        chosen = select_core_references(np.abs(v[:, None]-v[None, :]), 2, 20)
        self.assertTrue(chosen)
        self.assertTrue(all(2 <= i < 6 for i in chosen))

    def test_sparse_unrelated_candidates_are_not_recommended(self):
        self.assertEqual(select_core_references(np.ones((6, 6))-np.eye(6), 0, 20), [])

    def test_metric_runs_remain_bounded_and_use_the_official_metric(self):
        e = engine(); refs = [feature(str(i), [i / 100]) for i in range(89)]
        matrix = metric_distances(e, refs)
        self.assertEqual(matrix.shape, (89, 89))
        self.assertLessEqual(e.metric.largest, 48)
        self.assertAlmostEqual(float(matrix[1, 88]), .87, places=5)


if __name__ == "__main__":
    unittest.main()
