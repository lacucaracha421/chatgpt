"""HOME-DASH-001: `/v1/library/summary`, the tablet Home's library counts.

Drives the shipped route against real SQLite on the Asset authority fixture. The
invariants: counts cover exactly the Assets `/v1/library/assets` can list, dated by
that list's sort key; today/this-week cut at the client's local midnight (Monday week);
`unclassified` follows the legacy relation before classification authority and the
canonical assignment after it; client auth; a stable response shape with an ETag.
"""
from __future__ import annotations

import hashlib
import io
import unittest
from datetime import datetime, timezone
from unittest import mock

import api_auth

from tests.test_asset_authority import AssetAuthorityFixture
from tests.test_capture_api_stub import fake_s3

import app as api_app
import asset_authority
import classification_authority

CLASS_ID = "10000000-0000-4000-8000-000000000001"
# Thursday 2026-09-24 20:30 UTC = Friday 2026-09-25 05:30 KST.
NOW = datetime(2026, 9, 24, 20, 30, tzinfo=timezone.utc)
KEYS = {"total", "addedToday", "addedThisWeek", "unclassified", "todayStart",
        "weekStart", "tzOffsetMinutes", "listGeneration"}


class MobileLibrarySummaryTests(AssetAuthorityFixture):
    def setUp(self):
        super().setUp()
        api_app.startup_classifications()
        clock = mock.patch.object(api_app, "_summary_now", return_value=NOW)
        clock.start()
        self.addCleanup(clock.stop)
        with api_app.get_db() as db:
            _, token = api_auth.provision_token(db, "client", "summary-reader")
            db.commit()
        self.reader = {"Authorization": f"Bearer {token}"}

    def publish(self, asset_id, collected_at, classification_ids=()):
        digest = hashlib.sha256(asset_id.encode()).hexdigest()
        prepared = self.client.post("/v1/replication/prepare", headers=self.admin, json={
            "asset_id": asset_id, "kind": "image", "content_type": "image/png",
            "size_bytes": 4, "sha256": digest, "collected_at": collected_at})
        self.assertEqual(prepared.status_code, 200, prepared.text)
        for variant in ("original", "thumbnail"):
            fake_s3.put_object(Bucket="test-bucket", Key=f"library/{asset_id}/{variant}",
                               Body=io.BytesIO(b"xxxx"), ContentType="image/png")
        committed = self.client.post("/v1/replication/commit", headers=self.admin, json={
            "asset_id": asset_id, "kind": "image",
            "original": {"object_key": f"library/{asset_id}/original",
                         "content_type": "image/png", "size_bytes": 4, "sha256": digest},
            "thumbnail": {"object_key": f"library/{asset_id}/thumbnail",
                          "content_type": "image/webp", "size_bytes": 4},
            "content_type": "image/png", "collected_at": collected_at,
            "source_published_at": None, "source_url": None, "creator_name": None,
            "creator_handle": None, "import_source": "Direct",
            "classification_ids": list(classification_ids),
            "expected_revision": 0, "commit_id": f"summary-{asset_id}"})
        self.assertEqual(committed.status_code, 200, committed.text)

    def summary(self, headers=None, **params):
        response = self.client.get("/v1/library/summary", params=params,
                                   headers=headers or self.reader)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def seed_dates(self):
        # Local KST (+540) day starts 2026-09-24T15:00Z; the Monday week 2026-09-20T15:00Z.
        self.publish("a-today-midnight", "2026-09-24T15:00:00+00:00")  # exactly local midnight
        self.publish("b-today", "2026-09-24T20:00:00.000Z")
        self.publish("c-yesterday", "2026-09-24T14:59:59.999Z")
        self.publish("d-monday", "2026-09-20T15:00:00Z")
        self.publish("e-sunday", "2026-09-20T14:59:59Z")
        self.publish("f-old", "2026-01-01T00:00:00Z")

    def test_counts_by_client_offset_with_monday_week(self):
        self.seed_dates()
        kst = self.summary(tzOffsetMinutes=540)
        self.assertEqual(kst["total"], 6)
        self.assertEqual(kst["addedToday"], 2)
        self.assertEqual(kst["addedThisWeek"], 4)
        self.assertEqual(kst["todayStart"], "2026-09-24T15:00:00Z")
        self.assertEqual(kst["weekStart"], "2026-09-20T15:00:00Z")
        # UTC: today is Thursday 2026-09-24, week from Monday 2026-09-21.
        utc = self.summary()
        self.assertEqual((utc["addedToday"], utc["addedThisWeek"]), (3, 3))
        self.assertEqual(utc["weekStart"], "2026-09-21T00:00:00Z")
        # Negative offset (-300): local now is 2026-09-24 15:30, same Thursday.
        west = self.summary(tzOffsetMinutes=-300)
        self.assertEqual(west["todayStart"], "2026-09-24T05:00:00Z")
        self.assertEqual((west["addedToday"], west["addedThisWeek"]), (3, 3))

    def test_a_monday_local_day_is_its_own_week_start(self):
        self.publish("x", "2026-09-20T16:00:00Z")
        # 2026-09-21 00:30 KST is Monday: today and week start coincide.
        with mock.patch.object(api_app, "_summary_now",
                               return_value=datetime(2026, 9, 20, 15, 30, tzinfo=timezone.utc)):
            body = self.summary(tzOffsetMinutes=540)
        self.assertEqual(body["todayStart"], body["weekStart"])
        self.assertEqual((body["addedToday"], body["addedThisWeek"]), (1, 1))

    def test_visibility_matches_the_library_list(self):
        self.seed_dates()
        self.activate()
        with api_app.get_db() as db:
            for asset_id, lifecycle in (("b-today", asset_authority.TRASH),
                                        ("d-monday", asset_authority.TOMBSTONED)):
                db.execute("UPDATE asset_authority_state SET lifecycle=? WHERE asset_id=?",
                           [lifecycle, asset_id])
            # An uncommitted Asset is never counted either.
            db.execute("UPDATE assets SET committed=0 WHERE id='f-old'")
            db.commit()
        body = self.summary(tzOffsetMinutes=540)
        listed = self.client.get("/v1/library/assets", headers=self.admin,
                                 params={"limit": 100}).json()
        self.assertEqual(body["total"], len(listed["items"]))
        self.assertEqual(body["total"], 3)
        # Left: a-today-midnight (today), c-yesterday (this week), e-sunday (last week).
        self.assertEqual((body["addedToday"], body["addedThisWeek"]), (1, 2))
        self.assertEqual(body["listGeneration"], listed["listGeneration"])

    def test_unclassified_before_and_after_classification_authority(self):
        self.publish("p", "2026-09-24T20:00:00Z", [CLASS_ID])
        self.publish("q", "2026-09-24T20:00:00Z")
        self.publish("r", "2026-09-24T20:00:00Z")
        self.assertEqual(self.summary()["unclassified"], 2)
        library = "summary-library"
        classification_authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            db.execute("INSERT INTO authority_domains VALUES(?,?,1,1,0,'digest',NULL,?)",
                       [library, classification_authority.DOMAIN, "2026-09-24T00:00:00Z"])
            # Canonical: p moved to 미분류 (null), q assigned, r assigned; the legacy
            # relation (p only) would answer 2 instead of 1.
            for asset_id, classification in (("p", None), ("q", CLASS_ID), ("r", CLASS_ID)):
                db.execute("INSERT INTO classification_authority_assignments "
                           "VALUES(?,?,?,1,'2026-09-24T00:00:00Z','2026-09-24T00:00:00Z')",
                           [library, asset_id, classification])
            db.commit()
        self.assertEqual(self.summary()["unclassified"], 1)
        with api_app.get_db() as db:
            db.execute("DELETE FROM classification_authority_assignments WHERE asset_id='r'")
            db.commit()
        # An Asset the authority never mentioned is unclassified too.
        self.assertEqual(self.summary()["unclassified"], 2)

    def test_requires_a_client_credential(self):
        self.assertEqual(self.client.get("/v1/library/summary").status_code, 401)
        self.assertEqual(self.client.get("/v1/library/summary",
                                         headers={"Authorization": "Bearer nope"}).status_code, 401)
        for headers in (self.admin, self.publisher, self.reader):
            self.assertEqual(self.client.get("/v1/library/summary", headers=headers).status_code, 200)

    def test_rejects_an_out_of_range_offset(self):
        for value in ("841", "-841", "5.5", "x"):
            response = self.client.get("/v1/library/summary", headers=self.reader,
                                       params={"tzOffsetMinutes": value})
            self.assertEqual(response.status_code, 422, value)

    def test_shape_and_conditional_get(self):
        empty = self.summary()
        self.assertEqual(set(empty), KEYS)
        self.assertEqual((empty["total"], empty["addedToday"], empty["addedThisWeek"],
                          empty["unclassified"], empty["tzOffsetMinutes"]), (0, 0, 0, 0, 0))
        first = self.client.get("/v1/library/summary", headers=self.reader)
        etag = first.headers["ETag"]
        again = self.client.get("/v1/library/summary",
                                headers={**self.reader, "If-None-Match": etag})
        self.assertEqual(again.status_code, 304)
        self.publish("n", "2026-09-24T20:00:00Z")
        changed = self.client.get("/v1/library/summary",
                                  headers={**self.reader, "If-None-Match": etag})
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(changed.json()["total"], 1)
        self.assertNotEqual(changed.json()["listGeneration"], empty["listGeneration"])


if __name__ == "__main__":
    unittest.main()
