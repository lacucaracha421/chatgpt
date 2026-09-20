import hashlib
import unittest
from unittest.mock import Mock

import numpy as np

from runtime import BASELINE, FINGERPRINT, Features, Runtime
from reference_regions import project_reference, compare_bound, compare_bound_delta, inspect_references, resolve_references
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

    def test_common_person_is_used_without_becoming_a_manual_selection(self):
        refs = [feature(str(i), [.03 + i * .01]) for i in range(5)]
        refs.append(feature("multi", [.8, .04]))
        result = inspect_references(engine(), refs, [None] * 6)
        self.assertEqual(result[-1]["suggestedIndex"], 1)
        self.assertIsNone(result[-1]["selectedIndex"])
        self.assertEqual(result[-1]["automaticIndex"], 1)
        self.assertEqual(result[-1]["state"], "automatic")
        compared = compare_bound(engine(), feature("query", [.04]), refs, [None] * 6)
        self.assertEqual(compared["referenceSelections"], [None] * 6)
        self.assertEqual(compared["referenceRegions"][-1], binding(refs[-1], 1))
        self.assertEqual(compared["referenceStatuses"], [r["state"] for r in result])
        self.assertEqual(compared["evidence"][0]["matchedReferences"], list(range(6)))

    def test_one_anchor_bootstraps_a_triangle_of_distinct_images(self):
        refs = [feature("anchor", [.02]), feature("left", [.03, .8]), feature("right", [.7, .04])]
        result = inspect_references(engine(), refs, [None] * 3)
        self.assertEqual([r["state"] for r in result], ["single", "automatic", "automatic"])
        self.assertEqual([r["automaticIndex"] for r in result], [None, 0, 1])

    def test_multiple_crops_in_one_peer_do_not_supply_multiple_votes(self):
        refs = [feature("anchor", [.02]), feature("left", [.03, .04, .05])]
        result = inspect_references(engine(), refs, [None] * 2)
        self.assertEqual(result[-1]["state"], "needs_region")
        with self.assertRaises(ValueError):
            resolve_references(engine(), refs + [refs[0]], [None] * 3)

    def test_ties_abstain_even_with_two_anchors(self):
        refs = [feature("anchor1", [.02]), feature("anchor2", [.03]), feature("tie", [.04, .05])]
        result = inspect_references(engine(), refs, [None] * 3)
        self.assertEqual(result[-1]["state"], "needs_region")
        self.assertIsNone(result[-1]["automaticIndex"])

    def test_manual_and_stale_choices_are_never_replaced_by_consensus(self):
        refs = [feature("anchor1", [.02]), feature("anchor2", [.03]),
                feature("manual", [.04, .8]), feature("stale", [.05, .9])]
        selections = [None, None, binding(refs[2], 1), dict(binding(refs[3]), contentHash="old")]
        result = inspect_references(engine(), refs, selections)
        self.assertEqual(result[2]["state"], "selected")
        self.assertEqual(result[2]["selectedIndex"], 1)
        self.assertEqual(result[3]["state"], "stale_region")
        self.assertIsNone(result[3]["automaticIndex"])
        # A stale reference cannot supply the third image needed for a triangle.
        result = inspect_references(engine(), [refs[0], refs[2], refs[3]], [None, None, selections[3]])
        self.assertEqual(result[1]["state"], "needs_region")

    def test_reference_order_does_not_change_choices(self):
        refs = [feature("anchor", [.02]), feature("left", [.03, .8]),
                feature("right", [.7, .04]), feature("tie", [.03, .05])]
        expected = {r["contentHash"]: r for r in inspect_references(engine(), refs, [None] * 4)}
        for order in ([3, 1, 0, 2], [2, 0, 3, 1]):
            actual = {r["contentHash"]: r for r in inspect_references(engine(), [refs[i] for i in order], [None] * 4)}
            self.assertEqual(actual, expected)

    def test_maximum_reference_set_uses_bounded_metric_batches(self):
        refs = [feature("anchor", [.01])] + [feature(str(i), [.02] + [1. + j for j in range(7)]) for i in range(24)]
        e = engine()
        result = inspect_references(e, refs, [None] * 25)
        self.assertEqual([r["automaticIndex"] for r in result[1:]], [0] * 24)
        self.assertLessEqual(e.metric.largest, 48)
        self.assertEqual(e.max_metric_vectors, e.metric.largest)

    def test_nonfinite_metric_fails_closed(self):
        refs = [feature("anchor", [.01]), feature("multi", [.02, .8])]
        e = engine()
        e.metric.run = Mock(return_value=[np.full((3, 3), np.nan)])
        with self.assertRaisesRegex(ValueError, "metric output"):
            resolve_references(e, refs, [None] * 2)

    def test_prepared_views_are_reused_for_queries(self):
        refs = [feature(str(i), [.02]) for i in range(4)] + [feature("multi", [.03, .8])]
        e = engine()
        projected = resolve_references(e, refs, [None] * 5)
        with unittest.mock.patch("reference_regions.resolve_references", side_effect=AssertionError("recomputed")):
            result = compare_bound(e, feature("query", [.02]), refs, [None] * 5, projected)
        self.assertEqual(result["referenceStatuses"][-1], "automatic")

    def test_delta_refuses_when_added_references_can_change_inference(self):
        q = feature("query", [.02]); e = engine()
        stable = [feature(str(i), [.02]) for i in range(5)]
        ambiguous = feature("ambiguous", [.02, .8])
        old = compare_bound(e, q, stable, [None] * 5)
        with self.assertRaisesRegex(ValueError, "full comparison"):
            compare_bound_delta(e, q, old, [ambiguous], [None])
        for refs in (stable[:4] + [ambiguous], [feature(str(i), [.02, .8]) for i in range(5)]):
            old = compare_bound(e, q, refs, [None] * 5)
            with self.assertRaisesRegex(ValueError, "full comparison"):
                compare_bound_delta(e, q, old, [feature("extra", [.02])], [None])


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
