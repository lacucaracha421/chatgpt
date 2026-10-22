"""Parity batch D tablet reads: same-post strip, 작가 미상 scopes, artist 다시보기, statistics.

Real SQLite on the Asset authority fixture. The invariants: every read lists only what
`/v1/library/assets` can list (trash, uncommitted and cover-only Assets never appear), the
same-post group follows the PC's X status rule, rediscovery selects actual Assets and reports
when per-Asset activity is unknown, and statistics count without inventing activity.
"""
from __future__ import annotations

import unittest
from datetime import datetime, timezone
from unittest import mock

import api_auth

from tests.test_asset_authority import AssetAuthorityFixture
import tests.test_mobile_library_summary as summary_tests
from tests.test_library_artists import artist, snapshot

import app as api_app
import asset_authority
import library_artist_rediscovery
import library_artists
import library_search

NOW = datetime(2026, 10, 22, 3, 0, tzinfo=timezone.utc)  # 12:00 KST


class ReadProjectionFixture(AssetAuthorityFixture):
    publish = summary_tests.MobileLibrarySummaryTests.publish

    def setUp(self):
        super().setUp()
        api_app.startup_classifications()
        api_app.startup_mobile_collections()
        with api_app.get_db() as db:
            library_search.startup_db(db)
            library_artists.startup_db(db)
            _, token = api_auth.provision_token(db, "client", "parity-reader")
            db.commit()
        self.reader = {"Authorization": f"Bearer {token}"}

    def asset(self, asset_id, collected_at="2026-09-01T00:00:00Z", **columns):
        self.publish(asset_id, collected_at, kind=columns.pop("kind", "image"))
        if columns:
            with api_app.get_db() as db:
                db.execute(f"UPDATE assets SET {','.join(f'{name}=?' for name in columns)} WHERE id=?",
                           [*columns.values(), asset_id])
                db.commit()

    def trash(self, *asset_ids):
        self.activate()
        with api_app.get_db() as db:
            for asset_id in asset_ids:
                db.execute("UPDATE asset_authority_state SET lifecycle=? WHERE asset_id=?",
                           [asset_authority.TRASH, asset_id])
            db.commit()

    def get(self, path, expect=200, headers=None, **params):
        response = self.client.get(path, headers=headers or self.reader, params=params)
        self.assertEqual(response.status_code, expect, response.text)
        return response.json()

    def artists(self, items, assignments=()):
        response = self.client.put(library_artists.PREFIX, headers=self.publisher,
                                   json=snapshot(items=items, assignments=list(assignments)))
        self.assertEqual(response.status_code, 200, response.text)


class SamePostTests(ReadProjectionFixture):
    def path(self, asset_id):
        return f"/v1/library/assets/{asset_id}/same-post"

    def test_groups_one_x_status_across_hosts_and_hides_invisible_members(self):
        self.asset("a", "2026-09-01T00:00:02Z", source_url="https://x.com/artist/status/123/photo/1")
        self.asset("b", "2026-09-01T00:00:01Z", source_url="https://twitter.com/artist/status/123/photo/2")
        self.asset("longer", source_url="https://x.com/artist/status/1234/photo/1")
        self.asset("web", source_url="https://example.com/status/123")
        self.asset("cover", source_url="https://x.com/artist/status/123/photo/3", import_source="favorite_cover")
        self.asset("gone", source_url="https://x.com/artist/status/123/photo/4")
        self.trash("gone")
        body = self.get(self.path("a"))
        self.assertEqual([item["id"] for item in body["items"]], ["b", "a"])
        self.assertEqual(body["items"][0]["source_url"], "https://twitter.com/artist/status/123/photo/2")
        self.assertEqual(self.get(self.path("web"))["items"], [])
        self.get(self.path("gone"), expect=404)
        self.get(self.path("cover"), expect=404)

    def test_requires_a_client_credential(self):
        self.asset("a", source_url="https://x.com/artist/status/1/photo/1")
        self.assertEqual(self.client.get(self.path("a")).status_code, 401)
        self.assertEqual(self.client.get(self.path("a"), headers=self.admin).status_code, 200)


class UnknownArtistScopeTests(ReadProjectionFixture):
    def test_unknown_scopes_split_by_source_and_respect_keys_and_assignments(self):
        self.asset("bare")
        self.asset("sourced", source_url="https://arca.live/b/x/1")
        self.asset("handled", creator_handle="alice")
        self.asset("assigned")
        self.asset("tag-keyed", source_url="https://x.com/bob/status/9")
        self.asset("tag-blank", creator_handle="stale")
        self.artists([artist(keys=["alice"]), artist("artist:b", keys=["bob"])],
                     [{"assetId": "assigned", "artistId": "artist:a1", "source": "manual"}])
        with api_app.get_db() as db:
            # The PC-published key wins over the stored handle, in both directions.
            db.execute("INSERT INTO library_tag_assets VALUES('tag-keyed','d','bob')")
            db.execute("INSERT INTO library_tag_assets VALUES('tag-blank','d',NULL)")
            db.commit()
        ids = lambda scope: sorted(item["id"] for item in self.get(
            "/v1/library/assets", headers=self.admin, artist=scope, limit=100)["items"])
        self.assertEqual(ids("unknown:none"), ["bare", "tag-blank"])
        self.assertEqual(ids("unknown:source"), ["sourced"])


class RediscoveryTests(ReadProjectionFixture):
    def setUp(self):
        super().setUp()
        clock = mock.patch.object(library_artist_rediscovery, "_now", return_value=NOW)
        clock.start()
        self.addCleanup(clock.stop)

    def read(self, artist_id="artist:a1", **params):
        return self.get("/v1/library/artist-rediscovery",
                        **{"artist": artist_id, "localDate": "2026-10-22", "utcOffsetMinutes": 540, **params})

    def seed(self, last_opened=None):
        # 2025-10-21 15:30Z is 2025-10-22 00:30 KST: the same local day a year ago.
        self.asset("y1-a", "2025-10-21T15:30:00Z", creator_handle="alice")
        self.asset("y1-b", "2025-10-22T10:00:00Z", creator_handle="alice")
        self.asset("y1-late", "2025-10-22T15:30:00Z", creator_handle="alice")  # 10-23 KST
        self.asset("y3", "2023-10-22T01:00:00Z", creator_handle="alice")
        self.asset("recent", "2026-10-01T00:00:00Z", creator_handle="alice")
        self.asset("someone", "2025-10-22T01:00:00Z", creator_handle="carol")
        self.asset("trashed", "2025-10-22T02:00:00Z", creator_handle="alice")
        self.artists([artist(keys=["alice"], lastOpenedAt=last_opened)])
        self.trash("trashed")

    def test_on_this_day_and_long_unseen_select_actual_visible_assets(self):
        self.seed()
        body = self.read()
        day = body["onThisDay"]
        self.assertEqual((day["yearsAgo"], day["localDate"], day["total"]), (1, "2025-10-22", 2))
        self.assertEqual([item["id"] for item in day["items"]], ["y1-a", "y1-b"])
        self.assertTrue(body["longUnseenKnown"])
        # y1-b was saved less than 365 days before NOW.
        self.assertEqual([item["id"] for item in body["longUnseen"]["items"]], ["y3", "y1-a"])
        self.assertEqual(body["longUnseen"]["total"], 2)

    def test_long_unseen_is_unknown_when_the_artist_was_opened_this_year(self):
        self.seed(last_opened="2026-08-01T00:00:00Z")
        body = self.read()
        self.assertEqual((body["longUnseenKnown"], body["longUnseen"]), (False, None))
        self.assertEqual(body["onThisDay"]["total"], 2)

    def test_unknown_artist_and_bad_dates(self):
        self.seed()
        self.get("/v1/library/artist-rediscovery", expect=404, artist="artist:none", localDate="2026-10-22")
        self.get("/v1/library/artist-rediscovery", expect=422, artist="artist:a1", localDate="2026-13-40")
        self.assertIsNone(self.read(localDate="2026-03-01")["onThisDay"])


class StatisticsTests(ReadProjectionFixture):
    def test_counts_only_listable_assets_and_published_artists(self):
        self.asset("a", "2026-09-30T16:00:00Z", size_bytes=10)          # 2026-10 KST
        self.asset("b", "2026-09-30T14:00:00Z", kind="video", size_bytes=20)  # 2026-09 KST
        self.asset("c", "2026-08-01T00:00:00Z", kind="gif", size_bytes=30)
        self.asset("cover", import_source="favorite_cover")
        self.asset("gone")
        self.trash("gone")
        self.artists([artist(assetCount=5), artist("artist:b", keys=["bob"], label="bob", displayName=None,
                                                    assetCount=9)])
        body = self.get("/v1/library/statistics", utcOffsetMinutes=540)
        self.assertEqual((body["assets"], body["unclassified"], body["originalRecordedBytes"]), (3, 3, 60))
        self.assertEqual(sorted((row["label"], row["count"]) for row in body["mediaKinds"]),
                         [("gif", 1), ("image", 1), ("video", 1)])
        self.assertEqual(body["collectedMonths"], [{"label": "2026-10", "count": 1},
                                                   {"label": "2026-09", "count": 1},
                                                   {"label": "2026-08", "count": 1}])
        self.assertEqual([(row["label"], row["count"]) for row in body["artists"]], [("bob", 9), ("앨리스", 5)])
        self.assertIsNone(body["favorites"])  # no active Album authority: no Likes to count
        self.assertEqual(body["collections"]["total"], 0)
        listed = self.get("/v1/library/assets", headers=self.admin, limit=100)
        self.assertEqual(body["assets"], len(listed["items"]))

    def test_requires_a_client_credential(self):
        self.assertEqual(self.client.get("/v1/library/statistics").status_code, 401)


if __name__ == "__main__":
    unittest.main()
