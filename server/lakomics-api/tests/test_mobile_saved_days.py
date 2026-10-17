"""`/v1/library/saved-days`, the tablet Home month calendar's per-day saved-image counts.

Same fixture and visibility rules as the library summary: counts cover the committed,
non-trashed image Assets `/v1/library/assets?media_kind=images` can list, dated by the list's
sort key and cut at the client's own local midnights.
"""
from __future__ import annotations

import unittest

import api_auth

from tests.test_asset_authority import AssetAuthorityFixture
import tests.test_mobile_library_summary as summary_tests

import app as api_app
import asset_authority

# Local KST (+540) days 2026-09-24, 09-25, 09-26 as the client sends them.
KST = ["2026-09-23T15:00:00.000Z", "2026-09-24T15:00:00.000Z",
       "2026-09-25T15:00:00.000Z", "2026-09-26T15:00:00.000Z"]


class MobileSavedDaysTests(AssetAuthorityFixture):
    publish = summary_tests.MobileLibrarySummaryTests.publish

    def setUp(self):
        super().setUp()
        with api_app.get_db() as db:
            _, token = api_auth.provision_token(db, "client", "saved-days-reader")
            db.commit()
        self.reader = {"Authorization": f"Bearer {token}"}

    def days(self, first="2026-09-24", bounds=KST, headers=None, expect=200):
        response = self.client.get(
            "/v1/library/saved-days", headers=headers or self.reader,
            params={"from": first, "bounds": ",".join(bounds)})
        self.assertEqual(response.status_code, expect, response.text)
        return response.json() if expect == 200 else response

    def counts(self, **kwargs):
        return {day["date"]: day["count"] for day in self.days(**kwargs)["days"]}

    def test_counts_images_per_local_day_with_midnight_edges(self):
        self.publish("a-start", "2026-09-23T15:00:00+00:00")   # exactly the 24th's local midnight
        self.publish("b-24", "2026-09-24T14:59:59.999Z")
        self.publish("c-25", "2026-09-24T15:00:00Z")           # the 25th starts here
        self.publish("d-25", "2026-09-25T03:00:00.000Z")
        self.publish("e-gif", "2026-09-25T04:00:00Z", kind="gif")
        self.publish("f-before", "2026-09-23T14:59:59Z")
        self.publish("g-after", "2026-09-26T15:00:00Z")
        self.assertEqual(self.counts(), {"2026-09-24": 2, "2026-09-25": 3, "2026-09-26": 0})

    def test_trash_video_and_uncommitted_are_not_counted(self):
        self.publish("keep", "2026-09-24T20:00:00Z")
        self.publish("trashed", "2026-09-24T20:00:00Z")
        self.publish("clip", "2026-09-24T20:00:00Z", kind="video")
        self.publish("uncommitted", "2026-09-24T20:00:00Z")
        self.activate()
        with api_app.get_db() as db:
            db.execute("UPDATE asset_authority_state SET lifecycle=? WHERE asset_id='trashed'",
                       [asset_authority.TRASH])
            db.execute("UPDATE assets SET committed=0 WHERE id='uncommitted'")
            db.commit()
        body = self.days()
        self.assertEqual(self.counts(), {"2026-09-24": 0, "2026-09-25": 1, "2026-09-26": 0})
        listed = self.client.get("/v1/library/assets", headers=self.admin,
                                 params={"limit": 100, "media_kind": "images"}).json()
        self.assertEqual(sum(day["count"] for day in body["days"]), len(listed["items"]))
        self.assertEqual(body["listGeneration"], listed["listGeneration"])

    def test_a_dst_length_day_follows_the_clients_cuts(self):
        # A 25-hour day (clocks back): the client's cut points, not 24 hours, decide membership.
        bounds = ["2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z", "2026-10-26T23:00:00.000Z"]
        self.publish("late", "2026-10-25T22:30:00Z")
        self.assertEqual(self.counts(first="2026-10-25", bounds=bounds),
                         {"2026-10-25": 1, "2026-10-26": 0})

    def test_accepts_one_and_forty_two_days_only(self):
        one = self.days(bounds=KST[:2])
        self.assertEqual([day["date"] for day in one["days"]], ["2026-09-24"])
        from datetime import datetime, timedelta, timezone
        start = datetime(2026, 8, 30, 15, tzinfo=timezone.utc)
        cuts = [(start + timedelta(days=i)).strftime("%Y-%m-%dT%H:%M:%S.000Z") for i in range(44)]
        full = self.days(first="2026-08-31", bounds=cuts[:43])
        self.assertEqual(len(full["days"]), 42)
        self.assertEqual(full["days"][-1]["date"], "2026-10-11")
        self.days(first="2026-08-31", bounds=cuts[:44], expect=400)
        self.days(bounds=KST[:1], expect=400)

    def test_bad_ranges_are_refused(self):
        self.days(first="2026-13-01", expect=400)
        self.days(first="soon", expect=400)
        self.days(bounds=[KST[1], KST[0]], expect=400)               # backwards
        self.days(bounds=[KST[0], KST[0]], expect=400)               # empty day
        self.days(bounds=[KST[0], "2026-09-25T15:00:00.000Z"], expect=400)  # 48 hours
        self.days(bounds=[KST[0], "2026-09-23T16:00:00.000Z"], expect=400)  # 1 hour
        self.days(bounds=[KST[0], "2026-09-24T15:00:00.500Z"], expect=400)  # sub-second cut
        self.days(bounds=[KST[0], "2026-09-24T15:00:00+09:00"], expect=400)
        self.days(bounds=[KST[0], ""], expect=400)
        response = self.client.get("/v1/library/saved-days", headers=self.reader,
                                   params={"from": "2026-09-24"})
        self.assertEqual(response.status_code, 422)

    def test_requires_a_client_credential(self):
        params = {"from": "2026-09-24", "bounds": ",".join(KST[:2])}
        self.assertEqual(self.client.get("/v1/library/saved-days", params=params).status_code, 401)
        self.assertEqual(self.client.get("/v1/library/saved-days", params=params,
                                         headers={"Authorization": "Bearer nope"}).status_code, 401)
        for headers in (self.admin, self.publisher, self.reader):
            self.assertEqual(self.client.get("/v1/library/saved-days", params=params,
                                             headers=headers).status_code, 200)

    def test_conditional_get_follows_the_library(self):
        params = {"from": "2026-09-24", "bounds": ",".join(KST[:2])}
        first = self.client.get("/v1/library/saved-days", params=params, headers=self.reader)
        again = self.client.get("/v1/library/saved-days", params=params,
                                headers={**self.reader, "If-None-Match": first.headers["ETag"]})
        self.assertEqual(again.status_code, 304)
        self.publish("n", "2026-09-24T10:00:00Z")
        changed = self.client.get("/v1/library/saved-days", params=params,
                                  headers={**self.reader, "If-None-Match": first.headers["ETag"]})
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(changed.json()["days"], [{"date": "2026-09-24", "count": 1}])


if __name__ == "__main__":
    unittest.main()
