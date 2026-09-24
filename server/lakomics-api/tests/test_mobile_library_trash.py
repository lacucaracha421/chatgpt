"""Mobile Library Trash: the client trash read route and trash-scoped media tickets.

Drives the shipped routes against real SQLite, on top of the Asset authority fixture.
The invariants: the trash list shows committed `trash` Assets only (never tombstoned),
newest trash first with the revision a restore needs; trash-scoped tickets sign media for
trashed Assets only; ordinary tickets are unchanged.
"""
from __future__ import annotations

import hashlib
import io
import unittest
from unittest import mock

import api_auth

from tests.test_asset_authority import AssetAuthorityFixture, new_operation  # noqa: F401
from tests.test_capture_api_stub import fake_s3

import app as api_app
import asset_authority

A = "20000000-0000-4000-8000-0000000000a1"
B = "20000000-0000-4000-8000-0000000000b2"
C = "20000000-0000-4000-8000-0000000000c3"
D = "20000000-0000-4000-8000-0000000000d4"


class MobileLibraryTrashTests(AssetAuthorityFixture):
    def publish(self, asset_id, size=40):
        digest = hashlib.sha256(asset_id.encode()).hexdigest()
        prepared = self.client.post("/v1/replication/prepare", headers=self.admin, json={
            "asset_id": asset_id, "kind": "image", "content_type": "image/png",
            "size_bytes": size, "sha256": digest, "collected_at": "2026-09-19T00:00:00Z"})
        self.assertEqual(prepared.status_code, 200, prepared.text)
        for variant, body in (("original", b"x" * size), ("thumbnail", b"t" * 5)):
            fake_s3.put_object(Bucket="test-bucket", Key=f"library/{asset_id}/{variant}",
                               Body=io.BytesIO(body), ContentType="image/png")
        committed = self.client.post("/v1/replication/commit", headers=self.admin, json={
            "asset_id": asset_id, "kind": "image",
            "original": {"object_key": f"library/{asset_id}/original",
                         "content_type": "image/png", "size_bytes": size, "sha256": digest},
            "thumbnail": {"object_key": f"library/{asset_id}/thumbnail",
                          "content_type": "image/webp", "size_bytes": 5},
            "content_type": "image/png", "collected_at": "2026-09-19T00:00:00Z",
            "source_published_at": None, "source_url": None, "creator_name": None,
            "creator_handle": None, "import_source": "Direct", "classification_ids": [],
            "expected_revision": 0, "commit_id": f"trash-{asset_id[-2:]}"})
        self.assertEqual(committed.status_code, 200, committed.text)

    def set_state(self, asset_id, lifecycle, updated_at, revision=2):
        with api_app.get_db() as db:
            db.execute("UPDATE asset_authority_state SET lifecycle=?,updated_at=?,lifecycle_changed_at=?,"
                       "entity_revision=? WHERE asset_id=?",
                       [lifecycle, updated_at, updated_at, revision, asset_id])
            db.commit()

    def trash(self, headers=None, **params):
        # The route takes the client role (the shared token also passes it in
        # production; this fixture sets the shared token after the guard was built).
        return self.client.get("/v1/library/trash", params=params,
                               headers=headers or self.client_token_headers())

    def seeded(self):
        for asset_id, size in ((A, 40), (B, 60), (C, 80), (D, 100)):
            self.publish(asset_id, size)
        self.activate()
        self.set_state(A, asset_authority.TRASH, "2026-09-24T01:00:00Z")
        self.set_state(B, asset_authority.TRASH, "2026-09-24T03:00:00Z", revision=4)
        self.set_state(C, asset_authority.TOMBSTONED, "2026-09-24T05:00:00Z")
        # D stays normal.

    def test_an_inactive_domain_has_an_empty_trash(self):
        self.publish(A)
        response = self.trash()
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertFalse(body["active"])
        self.assertEqual((body["items"], body["total_count"]), ([], 0))

    def test_lists_trash_newest_first_and_never_tombstoned(self):
        self.seeded()
        body = self.trash().json()
        self.assertTrue(body["active"])
        self.assertEqual([item["id"] for item in body["items"]], [B, A])
        self.assertEqual((body["total_count"], body["total_bytes"]), (2, 100))
        first = body["items"][0]
        self.assertEqual(first["lifecycle"], "trash")
        self.assertEqual(first["entityRevision"], 4)
        self.assertEqual(first["trashedAt"], "2026-09-24T03:00:00Z")
        self.assertTrue(first["thumbnail_available"])
        self.assertEqual((body["libraryId"], body["epoch"], body["contractVersion"]),
                         ("e" * 32, 1, 1))

    def test_pages_with_a_keyset_cursor(self):
        self.seeded()
        first = self.trash(limit=1).json()
        self.assertEqual([item["id"] for item in first["items"]], [B])
        self.assertTrue(first["has_more"])
        second = self.trash(limit=1, cursor=first["next_cursor"]).json()
        self.assertEqual([item["id"] for item in second["items"]], [A])
        self.assertFalse(second["has_more"])
        self.assertIsNone(second["next_cursor"])
        self.assertEqual(self.trash(cursor="not-a-cursor").status_code, 400)

    def test_replication_keeps_trash_order_cursor_and_queued_restore_revision(self):
        self.seeded()
        before = self.trash(limit=1).json()
        cursor = self.status()["cursor"]
        # Exercise the authority upsert directly: the legacy HTTP commit still
        # refuses non-normal Assets through its existing lifecycle fence.
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET creator_name='Updated creator' WHERE id=?", [A])
            asset_authority.register_replication(db, "e" * 32, A, "2026-09-25T00:00:00Z")
            db.commit()
        page = self.trash().json()
        self.assertEqual([i["id"] for i in page["items"]], [B, A])
        self.assertEqual(page["items"][1]["trashedAt"], "2026-09-24T01:00:00Z")
        self.assertEqual(page["items"][1]["entityRevision"], 2)
        self.assertEqual(self.trash(cursor=before["next_cursor"]).json()["items"][0]["id"], A)
        # No equal-revision change is emitted: shipped Android rejects such a delta.
        self.assertEqual(self.changes(after=cursor)["items"], [])
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT creator_name FROM asset_authority_state WHERE asset_id=?", [A]).fetchone()[0], "Updated creator")
        with mock.patch.object(asset_authority, "now_iso", return_value="2026-09-25T00:00:00Z"):
            restored = self.command(asset_authority.RESTORE_ASSET, A, 2)
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual(restored.json()["asset"]["entityRevision"], 3)
        self.assertEqual(restored.json()["asset"]["creatorName"], "Updated creator")
        self.assertEqual(self.changes(after=cursor)["items"][0]["asset"]["entityRevision"], 3)
        with mock.patch.object(asset_authority, "now_iso", return_value="2026-09-26T00:00:00Z"):
            self.assertEqual(self.command(asset_authority.TRASH_ASSET, A, 3).status_code, 200)
        retrash = self.trash().json()["items"][0]
        self.assertEqual((retrash["id"], retrash["trashedAt"], retrash["entityRevision"]),
                         (A, "2026-09-26T00:00:00Z", 4))
        self.assertEqual(self.command(asset_authority.TRASH_ASSET, A, 4).status_code, 200)
        self.assertEqual(self.trash().json()["items"][0]["trashedAt"], retrash["trashedAt"])
        stale = self.command(asset_authority.RESTORE_ASSET, A, 2)
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["detail"]["code"], "revisionConflict")

    def test_timestamp_ties_and_legacy_cursor_rejection(self):
        self.seeded()
        self.set_state(A, asset_authority.TRASH, "2026-09-24T03:00:00Z")
        first = self.trash(limit=1).json()
        self.assertEqual(first["items"][0]["id"], B)
        self.assertEqual(self.trash(cursor=first["next_cursor"]).json()["items"][0]["id"], A)
        legacy = api_app.encode_mobile_cursor("trash", "2026-09-24T03:00:00Z", B)
        reply = self.trash(cursor=legacy)
        self.assertEqual((reply.status_code, reply.json()["detail"]), (400, "Invalid cursor"))
        with api_app.get_db() as db:
            plan = db.execute("EXPLAIN QUERY PLAN SELECT asset.* FROM asset_authority_state state "
                              "JOIN assets asset ON asset.id=state.asset_id WHERE state.library_id=? "
                              "AND state.lifecycle='trash' AND asset.committed=1 "
                              "ORDER BY state.lifecycle_changed_at DESC,state.asset_id DESC LIMIT 2", ["e" * 32]).fetchall()
        details = " ".join(row[3] for row in plan)
        self.assertIn("asset_authority_trash_order", details)
        self.assertNotIn("TEMP B-TREE", details)

    def test_media_ticket_client_auth_and_revocation_for_both_shapes_and_scopes(self):
        self.seeded()
        with api_app.get_db() as db:
            token_id, token = api_auth.provision_token(db, "client", "media-reader")
            db.commit()
        client = {"Authorization": f"Bearer {token}"}
        for headers in (client, self.admin, self.publisher):
            for asset_id, params in ((A, {"lifecycle": "trash"}), (D, {})):
                for variant in ("thumbnail", "original"):
                    single = self.client.post(f"/v1/library/assets/{asset_id}/media-ticket",
                                              headers=headers, params=params, json={"variant": variant})
                    self.assertEqual(single.status_code, 200, single.text)
                    batch = self.client.post("/v1/library/media-tickets", headers=headers, params=params,
                                             json={"items": [{"asset_id": asset_id, "variant": variant}]})
                    self.assertEqual(batch.status_code, 200, batch.text)
                    self.assertTrue(batch.json()["items"][0]["ok"])
        for params, allowed in (({}, {D}), ({"lifecycle": "trash"}, {A, B})):
            for asset_id in (A, B, C, D):
                single = self.client.post(f"/v1/library/assets/{asset_id}/media-ticket", headers=client,
                                          params=params, json={"variant": "thumbnail"})
                self.assertEqual(single.status_code, 200 if asset_id in allowed else 404)
            batch = self.client.post("/v1/library/media-tickets", headers=client, params=params,
                                     json={"items": [{"asset_id": aid, "variant": "thumbnail"} for aid in (A, B, C, D)]})
            self.assertEqual({item["asset_id"] for item in batch.json()["items"] if item["ok"]}, allowed)
        # Media access does not grant the publisher-only permanent-delete command.
        self.assertEqual(self.command(asset_authority.TOMBSTONE_ASSET, A, 2, headers=client).status_code, 401)
        with api_app.get_db() as db:
            api_auth.revoke_token(db, token_id)
            db.commit()
        from tests.test_asset_authority import RoleBoundaryTests
        extension = RoleBoundaryTests.extension_token(self)
        for headers in ({}, client, extension, {"Authorization": "Bearer invalid"}):
            for params in ({}, {"lifecycle": "trash"}):
                self.assertEqual(self.client.post(f"/v1/library/assets/{A}/media-ticket", headers=headers,
                                                  params=params, json={"variant": "thumbnail"}).status_code, 401)
                self.assertEqual(self.client.post("/v1/library/media-tickets", headers=headers, params=params,
                                                  json={"items": [{"asset_id": A, "variant": "thumbnail"}]}).status_code, 401)

    def test_requires_a_client_credential(self):
        self.seeded()
        self.assertEqual(self.client.get("/v1/library/trash").status_code, 401)
        self.assertEqual(self.trash(headers=self.publisher).status_code, 200)

    def client_token_headers(self):
        import api_auth
        with api_app.get_db() as db:
            _, token = api_auth.provision_token(db, "client", "trash-reader")
            db.commit()
        return {"Authorization": f"Bearer {token}"}

    def ticket(self, asset_id, variant="thumbnail", scope="trash"):
        params = {"lifecycle": scope} if scope else {}
        return self.client.post(f"/v1/library/assets/{asset_id}/media-ticket",
                                params=params, headers=self.admin, json={"variant": variant})

    def batch(self, asset_ids, variant="thumbnail", scope="trash"):
        params = {"lifecycle": scope} if scope else {}
        response = self.client.post("/v1/library/media-tickets", params=params,
                                    headers=self.admin,
                                    json={"items": [{"asset_id": asset_id, "variant": variant}
                                                    for asset_id in asset_ids]})
        self.assertEqual(response.status_code, 200, response.text)
        return {entry["asset_id"]: entry for entry in response.json()["items"]}

    def test_trash_scoped_tickets_sign_trashed_assets_only(self):
        self.seeded()
        for variant in ("thumbnail", "original"):
            self.assertEqual(self.ticket(A, variant).status_code, 200)
        self.assertEqual(self.ticket(C).status_code, 404)   # tombstoned
        self.assertEqual(self.ticket(D).status_code, 404)   # normal needs no trash scope
        entries = self.batch([A, B, C, D])
        self.assertTrue(entries[A]["ok"] and entries[B]["ok"])
        self.assertEqual((entries[C]["error"], entries[D]["error"]), ("not_found", "not_found"))

    def test_ordinary_tickets_are_unchanged(self):
        self.seeded()
        self.assertEqual(self.ticket(D, scope=None).status_code, 200)
        self.assertEqual(self.ticket(A, scope=None).status_code, 404)
        entries = self.batch([A, D], scope=None)
        self.assertTrue(entries[D]["ok"])
        self.assertFalse(entries[A]["ok"])
        self.assertEqual(self.ticket(A, scope="tombstoned").status_code, 422)

    def test_a_client_trash_is_listed_and_a_client_restore_removes_it(self):
        self.seeded()
        headers = self.client_token_headers()
        trashed = self.command(asset_authority.TRASH_ASSET, D, 1, headers=headers)
        self.assertEqual(trashed.status_code, 200, trashed.text)
        listed = self.trash().json()
        self.assertEqual(listed["items"][0]["id"], D)
        revision = listed["items"][0]["entityRevision"]
        restored = self.command(asset_authority.RESTORE_ASSET, D, revision, headers=headers)
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertNotIn(D, [item["id"] for item in self.trash().json()["items"]])


if __name__ == "__main__":
    unittest.main()
