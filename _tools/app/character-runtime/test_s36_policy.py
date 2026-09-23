"""The pinned S36 shadow policy stays well-formed and separate from the active B36 baseline."""
import json
import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent


class S36PolicyTest(unittest.TestCase):
    def test_policy_is_ordered_and_bound_to_a_feature_namespace(self):
        policy = json.loads((HERE / "s36_policy.json").read_text())
        self.assertEqual(policy["version"], "s36-knn3-v1")
        self.assertEqual(policy["scorer"], "knn3")
        self.assertRegex(policy["feature_id"], r"^[0-9a-f]{64}$")
        automatic, recommendation = policy["automatic_max_knn3"], policy["recommendation_max_knn3"]
        # Distances: a stricter automatic threshold is the smaller one.
        self.assertTrue(0 < automatic < recommendation < 0.5)
        self.assertIsInstance(policy["automatic_min_prior_manual_rejections"], int)
        self.assertGreater(policy["automatic_min_prior_manual_rejections"], 0)
        for key in ("dataset_sha256", "report_sha256"):
            self.assertTrue(re.fullmatch(r"[0-9a-f]{64}", policy["calibration"][key]))

    def test_baseline_is_not_replaced(self):
        baseline = json.loads((HERE / "baseline.json").read_text())
        self.assertEqual(baseline["version"], "ccip-crop-consensus-v1")
        self.assertNotIn("automatic_max_knn3", baseline)


if __name__ == "__main__":
    unittest.main()
