"""Caption publication storage and description ranking (plain Python, no FastAPI)."""
import sqlite3
import unittest

import library_description as description

NAMES = [{"targetId": "t-reze", "displayName": "레제", "seriesName": "체인소맨", "tags": ["reze_(chainsaw_man)"]}]
CAPTIONS = {
    "a1": "눈이 내리는 겨울 풍경 속에 서 있는 소녀",
    "a2": "교실 창가에 앉아 책을 읽는 소녀",
    "a3": "바닷가에서 웃고 있는 소녀와 파란 하늘",
    "gone": "눈이 내리는 겨울 밤 거리",
    "hidden": "눈 덮인 겨울 산",
}


def database():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(description.DDL)
    db.executescript("""
        CREATE TABLE assets(id TEXT PRIMARY KEY, kind TEXT, committed INTEGER);
        CREATE TABLE library_asset_ratings(asset_id TEXT PRIMARY KEY, content_rating TEXT);
        CREATE TABLE library_tag_vocabulary(tag_id TEXT PRIMARY KEY, label TEXT, category TEXT);
        CREATE TABLE library_asset_tags(asset_id TEXT, tag_id TEXT, PRIMARY KEY(asset_id,tag_id));
    """)
    db.executemany("INSERT INTO assets VALUES(?,?,?)", [
        ("a1", "image", 1), ("a2", "image", 1), ("a3", "gif", 1), ("gone", "image", 0),
        ("hidden", "video", 1), ("r1", "image", 1), ("r2", "image", 1)])
    db.executemany("INSERT INTO library_tag_vocabulary VALUES(?,?,?)", [
        ("reze_(chainsaw_man)", "레제", "character"), ("blue_sky", "푸른 하늘", "general")])
    db.executemany("INSERT INTO library_asset_tags VALUES(?,?)", [
        ("r1", "reze_(chainsaw_man)"), ("r2", "reze_(chainsaw_man)"), ("gone", "reze_(chainsaw_man)")])
    return db


def publish(db, captions=None, names=None):
    result = description.publish(db, {"version": 1, "captions": [
        {"assetId": key, "text": text} for key, text in (CAPTIONS if captions is None else captions).items()],
        "names": NAMES if names is None else names})
    db.commit()
    return result


class PublicationTests(unittest.TestCase):
    def test_digest_idempotency_revision_and_deletion(self):
        db = database()
        first = publish(db)
        self.assertEqual((first["changed"], first["revision"]), (True, 1))
        self.assertFalse(publish(db)["changed"])
        self.assertEqual(publish(db)["revision"], 1)
        changed = publish(db, {"a1": "새 설명입니다"}, [])
        self.assertEqual((changed["changed"], changed["revision"]), (True, 2))
        removed = description.publish(db, {"version": 1, "captions": [{"assetId": "a1", "text": None}],
                                           "names": [{"targetId": "t-reze", "deleted": True}]})
        self.assertEqual(removed["revision"], 3)
        self.assertIsNone(db.execute("SELECT 1 FROM library_captions WHERE asset_id='a1'").fetchone())
        self.assertIsNone(db.execute("SELECT 1 FROM library_caption_names").fetchone())
        self.assertFalse(description.publish(db, {"version": 1, "captions": [{"assetId": "a1", "text": None}]})["changed"])

    def test_validation_rejects_bad_batches_before_any_write(self):
        db = database()
        for body in ({"version": 2}, {"version": 1, "extra": 1},
                     {"version": 1, "captions": [{"assetId": "a1", "text": "x"}, {"assetId": "a1", "text": "y"}]},
                     {"version": 1, "captions": [{"assetId": "../x", "text": "x"}]},
                     {"version": 1, "captions": [{"assetId": "a1", "text": "   "}]},
                     {"version": 1, "captions": [{"assetId": "a1", "text": "x", "extra": 1}]},
                     {"version": 1, "captions": [{"assetId": "a%d" % i, "text": "x"} for i in range(10001)]},
                     {"version": 1, "names": [{"targetId": "t", "displayName": "x", "seriesName": None, "tags": ["a", "a"]}]},
                     {"version": 1, "names": [{"targetId": "t", "displayName": "x"}]}):
            with self.assertRaises(ValueError, msg=body.keys()):
                description.publish(db, body)
        self.assertEqual(db.execute("SELECT COUNT(*) FROM library_captions").fetchone()[0], 0)


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.db = database()
        publish(self.db)

    def ids(self, query, **kwargs):
        result = description.search(self.db, query, **kwargs)
        return result, [row["id"] for row in result["items"]]

    def test_caption_ranking_excludes_uncommitted_and_non_image_assets(self):
        result, ids = self.ids("눈 내리는 겨울")
        self.assertTrue(result["ready"])
        self.assertEqual(ids[0], "a1")
        self.assertNotIn("gone", ids)
        self.assertNotIn("hidden", ids)
        self.assertEqual(result["route"], "captions")

    def test_vocabulary_gate_is_sixty_percent_and_force_overrides(self):
        result, ids = self.ids("우주 로봇")
        self.assertEqual((ids, result["gated"]), ([], True))
        forced, _ = self.ids("우주 로봇", force=True)
        self.assertFalse(forced["gated"])
        self.assertFalse(self.ids("소녀 우주 겨울")[0]["gated"])
        # Exactly 3 of 5 units known passes; 2 of 5 is gated.
        document = [("x", "가나다라", "gate-doc")]
        self.assertFalse(description.rank(document, "가나 나다 다라 사아 자차")[1])
        self.assertTrue(description.rank(document, "가나 나다 사아 자차 파하")[1])

    def test_character_name_uses_published_tags_and_absorbs_series(self):
        for query in ("레제", "체인소맨 레제"):
            result, ids = self.ids(query)
            self.assertEqual((result["route"], result["ready"], sorted(ids)), ("tags", True, ["r1", "r2"]), query)

    def test_name_with_description_ranks_inside_the_name_tags(self):
        self.db.execute("INSERT INTO library_captions VALUES('r2','눈 내리는 겨울 거리의 소녀','d2')")
        result, ids = self.ids("레제 겨울")
        self.assertEqual((result["route"], ids), ("mixed", ["r2"]))
        fallback, ids = self.ids("레제 우주")
        self.assertEqual((fallback["route"], sorted(ids)), ("mixed_fallback", ["r1", "r2"]))

    def test_empty_library_and_empty_query_are_quiet_not_ready(self):
        db = database()
        result = description.search(db, "눈 내리는 겨울")
        self.assertEqual((result["ready"], result["gated"], result["items"]), (False, False, []))
        self.assertEqual(description.search(self.db, "  ")["items"], [])

    def test_limit_and_missing_media_projection(self):
        self.assertEqual(len(self.ids("소녀", limit=1)[1]), 1)
        bare = sqlite3.connect(":memory:")
        bare.row_factory = sqlite3.Row
        bare.executescript(description.DDL)
        self.assertEqual(description.search(bare, "소녀")["items"], [])


if __name__ == "__main__":
    unittest.main()
