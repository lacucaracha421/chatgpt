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
            db.execute("UPDATE asset_authority_state SET lifecycle=?,updated_at=?,"
                       "entity_revision=? WHERE asset_id=?",
                       [lifecycle, updated_at, revision, asset_id])
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
