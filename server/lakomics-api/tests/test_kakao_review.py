import unittest
import json
from pathlib import Path
from kakao_review import review, snapshot_volumes


class KakaoReviewTests(unittest.TestCase):
    def test_shared_computation_fixture(self):
        fixture = Path(__file__).resolve().parents[3] / '_tools/app/src-tauri/src/library/fixtures/kakao_review.json'
        for case in json.loads(fixture.read_text('utf-8')):
            with self.subTest(case=case['name'], bindings=case['bindings']):
                actual = review('work', case['name'], case['bindings'], case['highestOwnedVolume'], case['ownedCount'], case['range'])
                self.assertEqual({key: actual[key] for key in case['expected']}, case['expected'])

    def test_query_is_clipped(self):
        self.assertEqual(len(review('work', 'Title', {'kakao': {'config': {'query': '가' * 2001}}}, 0, 0, {})['query']), 2000)

    def test_malformed_snapshot_volumes_are_ignored(self):
        self.assertEqual(snapshot_volumes({'groups': [{'volumes': 123}]}), [])

    def test_boolean_dismissal_numbers_do_not_match_integer_volumes(self):
        bindings = {'kakao': {'config': {'reviewDismissedVolumes': [True, 3]},
                             'snapshot': {'volumes': [{'volumeNumber': 1}, {'volumeNumber': 3}]}}}
        self.assertFalse(review('work', 'Title', bindings, 3, 2, {})['partialDismissed'])
    def test_query_and_partial_dismissal_follow_the_current_binding_volume_set(self):
        bindings = {"mangadex": {"snapshot": {"detail": {"data": {"attributes": {
            "altTitles": [{"en": "Dungeon"}, {"ko": "던전밥"}]}}}}}}
        value = review("work", "Dungeon", bindings, 14, 14, {})
        self.assertEqual((value["query"], value["querySource"]), ("던전밥", "mangadex"))
        bindings["kakao"] = {"config": {"query": "던전밥", "groupFingerprint": "f",
            "reviewDismissedVolumes": [1, 3]}, "snapshot": {"volumes": [{"volumeNumber": 1}, {"volumeNumber": 3}]}}
        self.assertTrue(review("work", "Dungeon", bindings, 14, 14, {})["partialDismissed"])
        bindings["kakao"]["snapshot"]["volumes"].append({"volumeNumber": 2})
        self.assertFalse(review("work", "Dungeon", bindings, 14, 14, {})["partialDismissed"])
        value = review("work", "던전밥", {}, 0, 0, {"hideConnectionPrompt": True})
        self.assertEqual(value["querySource"], "name")
        self.assertTrue(value["hideConnectionPrompt"])

    def test_joined_groups_deduplicate_and_ignore_invalid_volume_numbers(self):
        snapshot = {"groups": [{"volumes": [{"volumeNumber": 3}, {"volumeNumber": 1}]},
                               {"volumes": [{"volumeNumber": 3}, {"volumeNumber": True}, {"volumeNumber": 0}]}]}
        self.assertEqual(snapshot_volumes(snapshot), [1, 3])
