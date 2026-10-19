import unittest

from collection_volume_range import local_contains, provider_number
from kakao_review import review


class VolumeRangeTests(unittest.TestCase):
    def test_part_numbers_and_continuous_numbers(self):
        bounds = {"minVolume": 64, "maxVolume": 80, "restartNumbering": True}
        self.assertEqual([provider_number(n, bounds) for n in range(63, 82)],
                         [None, *range(1, 18), None])
        self.assertTrue(local_contains(1, bounds))
        self.assertFalse(local_contains(64, bounds))
        self.assertEqual(provider_number(12, {"minVolume": 12, "maxVolume": 30}), 12)

    def test_review_uses_local_part_numbers(self):
        bounds = {"minVolume": 64, "maxVolume": 80, "restartNumbering": True}
        binding = {"kakao": {"snapshot": {"volumes": [{"volumeNumber": n} for n in range(1, 18)]},
                              "config": {"reviewDismissedVolumes": list(range(1, 18))}}}
        value = review("part", "Part", binding, 17, 17, bounds, "原題")
        self.assertEqual(value["volumes"], list(range(1, 18)))
        self.assertFalse(value["partialDismissed"])
        binding["kakao"]["snapshot"]["volumes"].pop()
        binding["kakao"]["config"]["reviewDismissedVolumes"].pop()
        self.assertTrue(review("part", "Part", binding, 16, 16, bounds)["partialDismissed"])
