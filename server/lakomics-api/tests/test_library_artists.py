"""작가 list: PC snapshot upload (replace, idempotent), tablet list and detail reads with ETag."""
import unittest
from urllib.parse import quote

import library_artists as artists
from tests.test_home_upcoming import HomeFixture

PREFIX = artists.PREFIX


def artist(artist_id="artist:a1", keys=("alice",), **extra):
    return {"id": artist_id, "label": "앨리스", "displayName": "앨리스", "sourceName": "alice", "keys": list(keys),
            "assetCount": 12, "recentCount": 2, "firstSavedAt": "2025-01-01T00:00:00Z",
            "lastSavedAt": "2026-09-01T00:00:00Z", "lastOpenedAt": None, "pinned": True, "hidden": False,
            "main": True, "coverAssetIds": ["asset-1", "asset-2"], **extra}


def snapshot(items=None, assignments=None, **extra):
    return {"version": 1, "generatedAt": "2026-09-26T00:00:00Z",
            "settings": {"mainMinCount": 5, "recentMinCount": 2, "recentDays": 30},
            "unknown": {"none": 3, "source": 4},
            "artists": [artist(), artist("https://x.com/bob", keys=["https://x.com/bob"], pinned=False, main=False,
                                         displayName=None, label="bob")] if items is None else items,
            "assignments": [{"assetId": "asset-9", "artistId": "artist:a1", "source": "source_url"}]
            if assignments is None else assignments, **extra}


class ArtistRoutes(HomeFixture):
    module = artists

    def put(self, body, headers=None):
        return self.client.put(PREFIX, headers=headers or self.publisher, json=body)

    def test_roles(self):
        self.assertEqual(self.put(snapshot(), headers=self.auth).status_code, 401)
        self.assertEqual(self.client.get(PREFIX).status_code, 401)
        self.assertEqual(self.client.get(PREFIX + "/artist:a1").status_code, 401)
        self.ok(self.put(snapshot()))
        self.ok(self.client.get(PREFIX, headers=self.publisher))

    def test_no_client_writes(self):
        for method in ("post", "delete", "patch"):
            self.assertEqual(getattr(self.client, method)(PREFIX, headers=self.auth).status_code, 405)

    def test_validation(self):
        bad = [
            snapshot(items=[artist(), artist()]),
            snapshot(items=[artist(), artist("artist:a2")]),  # a key on two artists
            snapshot(assignments=[{"assetId": "asset-9", "artistId": "artist:zz", "source": "manual"}]),
            snapshot(assignments=[{"assetId": "asset-9", "artistId": "artist:a1", "source": "manual"}] * 2),
            snapshot(assignments=[{"assetId": "a/b", "artistId": "artist:a1", "source": "manual"}]),
            snapshot(items=[artist(assetCount=-1)]),
            snapshot(items=[artist(label="")]),
            snapshot(items=[artist(coverAssetIds=["a"] * 9)]),
            snapshot(settings={"mainMinCount": 0, "recentMinCount": 2, "recentDays": 30}),
            {**snapshot(), "extra": True},
        ]
        for body in bad:
            reply = self.put(body)
            self.assertEqual((reply.status_code, self.code(reply)), (422, "invalidArtistUpload"), body)
        big = b'{"artists":"' + b"x" * (artists.MAX_BODY_BYTES + 1) + b'"}'
        reply = self.client.put(PREFIX, headers=self.publisher, content=big)
        self.assertEqual((reply.status_code, self.code(reply)), (413, "artistUploadTooLarge"))

    def test_snapshot_replace_etag_and_detail(self):
        empty = self.ok(self.client.get(PREFIX, headers=self.auth))
        self.assertEqual((empty["publishedAt"], empty["artists"]), (None, []))
        first = self.ok(self.put(snapshot()))
        self.assertEqual((first["changed"], first["artists"], first["assignments"]), (True, 2, 1))
        reply = self.client.get(PREFIX, headers=self.auth)
        body, etag = reply.json(), reply.headers["ETag"]
        self.assertEqual([a["id"] for a in body["artists"]], ["artist:a1", "https://x.com/bob"])
        self.assertEqual((body["revision"], body["unknown"], body["assignments"][0]["assetId"]),
                         (first["revision"], {"none": 3, "source": 4}, "asset-9"))
        self.assertEqual(self.client.get(PREFIX, headers={**self.auth, "If-None-Match": etag}).status_code, 304)
        again = self.ok(self.put(snapshot()))
        self.assertEqual((again["changed"], again["revision"]), (False, first["revision"]))
        detail = self.ok(self.client.get(PREFIX + "/artist:a1", headers=self.auth))
        self.assertEqual((detail["artist"]["keys"], detail["assignedAssetCount"]), (["alice"], 1))
        bob = self.ok(self.client.get(PREFIX + "/" + quote("https://x.com/bob", safe=""), headers=self.auth))
        self.assertEqual(bob["artist"]["label"], "bob")
        detail_etag = self.client.get(PREFIX + "/artist:a1", headers=self.auth).headers["ETag"]
        self.assertEqual(self.client.get(PREFIX + "/artist:a1", headers={**self.auth, "If-None-Match": detail_etag}
                                         ).status_code, 304)
        # A new snapshot replaces everything; the old detail is gone.
        self.ok(self.put(snapshot(items=[artist("artist:a3", keys=["carol"])], assignments=[])))
        reply = self.client.get(PREFIX, headers={**self.auth, "If-None-Match": etag})
        self.assertEqual(([a["id"] for a in reply.json()["artists"]], reply.json()["assignments"]),
                         (["artist:a3"], []))
        missing = self.client.get(PREFIX + "/artist:a1", headers=self.auth)
        self.assertEqual((missing.status_code, self.code(missing)), (404, "artistNotFound"))

    def test_signal(self):
        def signal():
            with self.get_db() as db:
                return artists.status_signal(db)
        self.assertEqual(signal(), 0)
        self.ok(self.put(snapshot()))
        self.ok(self.put(snapshot()))
        self.assertEqual(signal(), 1)
        self.ok(self.put(snapshot(assignments=[])))
        self.assertEqual(signal(), 2)


if __name__ == "__main__":
    unittest.main()
