"""오늘의 AV 배우: PC publish/remove, tablet read with ETag and 404 while off, blob cover ticket."""
import unittest

import home_av_pick as av
from tests.test_home_upcoming import SHA, HomeFixture

PREFIX = av.PREFIX


def pick(**extra):
    return {"date": "2026-09-26", "personId": "person-1", "name": "배우", "aliases": ["別名"], "workCount": 4,
            "latestWork": {"code": "ABC-123", "label": "ABC", "series": None, "title": None, "date": "2026-08-01",
                           "collectionId": "col-1"}, "cover": None, **extra}


class AvPickRoutes(HomeFixture):
    module = av

    def put(self, value, headers=None):
        return self.client.put(PREFIX, headers=headers or self.publisher, json={"version": 1, "pick": value})

    def get(self, headers=None):
        return self.client.get(PREFIX, headers=headers or self.auth)

    def test_roles(self):
        self.assertEqual(self.put(pick(), headers=self.auth).status_code, 401)
        self.assertEqual(self.client.delete(PREFIX, headers=self.auth).status_code, 401)
        self.assertEqual(self.client.get(PREFIX).status_code, 401)
        self.ok(self.put(pick()))
        self.ok(self.get(headers=self.publisher))

    def test_off_by_default_publish_etag_and_delete(self):
        reply = self.get()
        self.assertEqual((reply.status_code, self.code(reply)), (404, "avPickUnavailable"))
        first = self.ok(self.put(pick()))
        self.assertEqual((first["changed"], first["active"]), (True, True))
        reply = self.get()
        self.assertEqual(reply.json()["pick"]["latestWork"]["code"], "ABC-123")
        etag = reply.headers["ETag"]
        self.assertEqual(self.client.get(PREFIX, headers={**self.auth, "If-None-Match": etag}).status_code, 304)
        self.assertFalse(self.ok(self.put(pick()))["changed"])
        self.assertEqual(self.client.get(PREFIX, headers={**self.auth, "If-None-Match": etag}).status_code, 304)
        removed = self.ok(self.client.delete(PREFIX, headers=self.publisher))
        self.assertEqual((removed["changed"], removed["active"]), (True, False))
        self.assertEqual(self.get().status_code, 404)
        self.assertFalse(self.ok(self.client.delete(PREFIX, headers=self.publisher))["changed"])
        self.ok(self.put(pick(name="다른 배우")))
        self.assertTrue(self.ok(self.put(None))["changed"])
        self.assertEqual(self.get().status_code, 404)

    def test_validation(self):
        bad = [pick(name=""), pick(date="2026-13-01"), pick(personId="a/b"), pick(aliases=["x"] * 21),
               pick(workCount=-1), pick(cover={"url": "https://pics.dmm.co.jp/x.jpg"}),
               pick(latestWork={"code": "a\tb"}), {**pick(), "portrait": None}]
        for value in bad:
            reply = self.put(value)
            self.assertEqual((reply.status_code, self.code(reply)), (422, "invalidAvPick"), value)
        reply = self.client.put(PREFIX, headers=self.publisher, json={"version": 1})
        self.assertEqual(self.code(reply), "invalidAvPick")
        big = b'{"pick":"' + b"x" * av.MAX_BODY_BYTES + b'"}'
        reply = self.client.put(PREFIX, headers=self.publisher, content=big)
        self.assertEqual((reply.status_code, self.code(reply)), (413, "avPickTooLarge"))

    def test_blob_cover_ticket_follows_the_pick(self):
        cover = {"sha256": SHA, "sizeBytes": 10, "contentType": "image/webp"}
        reply = self.put(pick(cover=cover))
        self.assertEqual((reply.status_code, self.code(reply)), (409, "homeCoverNotUploaded"))
        self.assertEqual(self.get().status_code, 404)
        self.confirm_artwork()
        self.ok(self.put(pick(cover=cover)))
        self.assertEqual(self.ok(self.ticket())["url"], "https://r2.test/work-artwork/mobile/" + SHA)
        self.ok(self.client.delete(PREFIX, headers=self.publisher))
        self.assertEqual(self.ticket().status_code, 404)

    def test_signal(self):
        def signal():
            with self.get_db() as db:
                return av.status_signal(db)
        self.assertEqual(signal(), 0)
        self.ok(self.put(pick()))
        self.ok(self.put(pick()))
        self.assertEqual(signal(), 1)
        self.ok(self.client.delete(PREFIX, headers=self.publisher))
        self.assertEqual(signal(), 2)


if __name__ == "__main__":
    unittest.main()
