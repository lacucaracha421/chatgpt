import unittest

import shadow_rule_replay as replay


class SameCropRuleTests(unittest.TestCase):
    def test_second_min_does_not_combine_votes_from_different_query_crops(self):
        row = {"crops": [[0.10, 0.90], [0.90, 0.10]]}

        self.assertFalse(replay.rule_second_min(0.20)(row))

    def test_support_does_not_combine_votes_from_different_query_crops(self):
        row = {"crops": [[0.10, 0.90, 0.90], [0.90, 0.10, 0.90]]}

        self.assertFalse(replay.rule_support(0.20, 2)(row))

    def test_mean_is_computed_within_one_query_crop(self):
        row = {"crops": [[0.10, 0.90], [0.90, 0.10]]}

        self.assertFalse(replay.rule_mean(0.20)(row))


class ProductionGateTests(unittest.TestCase):
    def test_requires_six_strong_references_on_one_query_crop(self):
        split_votes = {
            "crops": [
                [0.10, 0.11, 0.12, 0.40, 0.40, 0.40],
                [0.40, 0.40, 0.40, 0.10, 0.11, 0.12],
            ],
            "whole_fallback": False,
        }
        strong = {
            "crops": [[0.10, 0.11, 0.12, 0.13, 0.14, 0.16]],
            "whole_fallback": False,
        }
        weak_sixth = {
            "crops": [[0.10, 0.11, 0.12, 0.13, 0.14, 0.17]],
            "whole_fallback": False,
        }

        rule = replay.rule_production_support()
        self.assertFalse(rule(split_votes))
        self.assertTrue(rule(strong))
        self.assertFalse(rule(weak_sixth))

    def test_rejects_whole_image_fallback(self):
        row = {
            "crops": [[0.10, 0.11, 0.12, 0.13, 0.14, 0.15]],
            "whole_fallback": True,
        }

        self.assertFalse(replay.rule_production_support()(row))


class GroupedFoldTests(unittest.TestCase):
    def test_all_labels_for_one_asset_stay_in_the_same_fold(self):
        self.assertTrue(hasattr(replay, "grouped_buckets"))
        rows = [
            {"asset": "shared", "target": "a"},
            {"asset": "shared", "target": "b"},
            {"asset": "other-1", "target": "a"},
            {"asset": "other-2", "target": "b"},
        ]

        buckets = replay.grouped_buckets(rows, folds=3, seed=7)
        locations = {
            index: bucket
            for bucket, indices in enumerate(buckets)
            for index in indices
        }
        self.assertEqual(locations[0], locations[1])
        self.assertEqual(sorted(locations), list(range(len(rows))))


if __name__ == "__main__":
    unittest.main()
