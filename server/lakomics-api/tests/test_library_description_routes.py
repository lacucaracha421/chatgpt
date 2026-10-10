"""Caption publication and description search routes (needs FastAPI and the app stub)."""
import unittest

from tests.test_capture_api_stub import fake_s3  # noqa: F401  Installs offline R2 stub before app import.
import app as api_app
import library_description as description
import library_search as search
from tests import test_asset_list_toc as toc_fixture


class DescriptionRouteTests(unittest.TestCase):
    tearDown = toc_fixture.AssetListTocTests.tearDown

    def setUp(self):
        toc_fixture.AssetListTocTests.setUp(self)
        with api_app.get_db() as db:
            search.startup_db(db)
            db.commit()
        # Kinds cycle image, video, gif; the first three ids are one of each.
        self.ids = list(self.assets)

    def put(self, body, headers=None):
        return self.client.put(description.PREFIX, headers=headers or self.publisher, json=body)

    def get(self, **params):
        return self.client.get(description.SEARCH, headers=self.client_auth, params=params)

    def test_before_any_caption_is_quiet_and_not_ready(self):
        reply = self.get(q="눈 내리는 겨울")
        self.assertEqual(reply.status_code, 200, reply.text)
        body = reply.json()
        self.assertEqual((body["ready"], body["gated"], body["items"]), (False, False, []))

    def test_publish_search_visibility_media_kind_and_mobile_shape(self):
        image, video, gif = self.ids[0], self.ids[1], self.ids[2]
        body = {"version": 1, "captions": [
            {"assetId": image, "text": "눈이 내리는 겨울 풍경"},
            {"assetId": video, "text": "눈이 내리는 겨울 영상"},
            {"assetId": gif, "text": "봄에 꽃이 피는 정원"},
            {"assetId": "uncommitted", "text": "눈이 내리는 겨울 밤"},
            {"assetId": "missing", "text": "눈이 내리는 겨울 낮"}], "names": []}
        first = self.put(body)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertFalse(self.put(body).json()["changed"])
        found = self.get(q="눈 내리는 겨울").json()
        self.assertTrue(found["ready"])
        self.assertEqual([item["id"] for item in found["items"]], [image])
        self.assertRegex(found["listGeneration"], r"^[a-f0-9]{64}$")
        item = found["items"][0]
        for key in ("kind", "width", "height", "thumbnail_available", "classification_ids", "contentRating"):
            self.assertIn(key, item)
        gated = self.get(q="우주 로봇").json()
        self.assertEqual((gated["gated"], gated["items"]), (True, []))
        forced = self.get(q="우주 로봇", force="true").json()
        self.assertFalse(forced["gated"])

    def test_character_name_route_uses_published_auto_tags(self):
        image, gif = self.ids[0], self.ids[2]
        tags = self.client.put(search.PREFIX, headers=self.publisher, json={
            "version": 1, "vocabulary": [{"id": "reze_(chainsaw_man)", "label": "레제", "category": "character"}],
            "assets": [{"assetId": image, "tags": ["reze_(chainsaw_man)"]}]})
        self.assertEqual(tags.status_code, 200, tags.text)
        names = self.put({"version": 1, "captions": [{"assetId": gif, "text": "봄에 꽃이 피는 정원"}], "names": [
            {"targetId": "t1", "displayName": "레제", "seriesName": "체인소맨", "tags": ["reze_(chainsaw_man)"]}]})
        self.assertEqual(names.status_code, 200, names.text)
        for query in ("레제", "체인소맨 레제"):
            body = self.get(q=query).json()
            self.assertEqual((body["route"], [item["id"] for item in body["items"]]), ("tags", [image]), query)

    def test_auth_and_validation(self):
        good = {"version": 1, "captions": [{"assetId": self.ids[0], "text": "x 설명"}]}
        self.assertIn(self.put(good, headers={}).status_code, (401, 403))
        self.assertIn(self.put(good, headers=self.client_auth).status_code, (401, 403))
        self.assertEqual(self.put({"version": 1, "captions": [{"assetId": "a b", "text": "x"}]}).status_code, 422)
        self.assertEqual(self.client.put(description.PREFIX, headers=self.publisher, content=b"{").status_code, 422)
        self.assertIn(self.client.get(description.SEARCH, params={"q": "눈"}).status_code, (401, 403))
        self.assertEqual(self.get(q="x" * 201).status_code, 422)
        self.assertEqual(self.get(q="눈", limit=201).status_code, 422)
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM library_captions").fetchone()[0], 0)

    def test_oversized_body_is_rejected(self):
        reply = self.client.put(description.PREFIX, headers=self.publisher,
                                content=b" " * (description.MAX_BODY_BYTES + 1))
        self.assertEqual(reply.status_code, 413, reply.text)


if __name__ == "__main__":
    unittest.main()
