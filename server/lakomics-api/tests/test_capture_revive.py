"""Only a new explicit save may revive deleted content; replay stays inert."""
import uuid
from datetime import datetime, timedelta
from unittest import mock

from tests.test_asset_authority import AssetAuthorityFixture, LIBRARY, api_app
import classification_authority
from capture_store import StoredMedia


class CaptureReviveTests(AssetAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()
        classification_authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            db.execute("INSERT INTO authority_domains(library_id,domain,epoch,contract_version,"
                       "change_cursor,baseline_digest,activated_at) VALUES(?,'classifications',1,1,0,'fixture',?)",
                       [LIBRARY, "2026-10-16T00:00:00Z"])
            for folder in ("a", "b"):
                db.execute("INSERT INTO classification_authority_state(library_id,classification_id,name,kind,"
                           "entity_revision,deleted,created_at,updated_at) VALUES(?,?,?,'root',1,0,?,?)",
                           [LIBRARY, folder, folder, "2026-10-16T00:00:00Z", "2026-10-16T00:00:00Z"])
            db.commit()
        self.payload = {"source_url": "https://x.com/example/status/123/photo/1",
                        "media_url": "https://pbs.twimg.com/media/example.png",
                        "classification_id": "a", "media_type": "image", "source": "x"}
        self.clock = "2026-10-16T00:00:01Z"
        for patch in (
            mock.patch.object(api_app, "fetch_media_to_r2", return_value=StoredMedia("image/png", 5, "a" * 64)),
            mock.patch.object(api_app, "now_iso", side_effect=lambda: self.clock),
            mock.patch("asset_authority.now_iso", side_effect=lambda: self.clock),
            mock.patch.object(api_app, "_image_thumbnail_worker", None),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def intent(self, at=None):
        return {"request_id": str(uuid.uuid4()), "requested_at": at or self.clock}

    def save(self, **changes):
        response = self.client.post("/v1/captures", headers=self.admin, json={**self.payload, **changes})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def state(self):
        with api_app.get_db() as db:
            return dict(db.execute("SELECT * FROM asset_authority_state").fetchone())

    def delete(self, permanent=True):
        def tick():
            self.clock = (datetime.fromisoformat(self.clock.replace("Z", "+00:00"))
                          + timedelta(seconds=1)).isoformat()
        tick()
        current = self.state()
        response = self.command("trashAsset", current["asset_id"], current["entity_revision"])
        self.assertEqual(response.status_code, 200, response.text)
        if permanent:
            tick()
            current = self.state()
            response = self.command("tombstoneAsset", current["asset_id"], current["entity_revision"])
            self.assertEqual(response.status_code, 200, response.text)
        tick()

    def test_explicit_save_revives_tombstone_with_same_capture_and_asset(self):
        original = self.save()
        old = self.state()
        self.delete()
        result = self.save(save_intent=self.intent())
        self.assertTrue(result["revived"])
        self.assertFalse(result["created"])
        self.assertEqual(result["capture"]["id"], original["capture"]["id"])
        self.assertEqual(result["capture"]["promotion_state"], "promoted")
        self.assertEqual(self.state()["asset_id"], old["asset_id"])
        self.assertEqual(self.state()["lifecycle"], "normal")
        self.assertEqual(self.state()["entity_revision"], 4)
        event = self.changes()["items"][-1]
        self.assertEqual(event["commandType"], "reviveCapture")
        self.assertEqual(event["asset"]["lifecycle"], "normal")

    def test_trash_and_tombstone_resave_to_new_folder_win_over_old_assignment(self):
        for permanent in (False, True):
            with self.subTest(permanent=permanent):
                self.save()
                self.delete(permanent)
                result = self.save(classification_id="b", save_intent=self.intent())
                self.assertTrue(result["revived"])
                with api_app.get_db() as db:
                    assignment = classification_authority.assignment_row(db, LIBRARY, self.state()["asset_id"])
                    self.assertEqual(assignment["classification_id"], "b")
                # Exercise reuse of an old capture/assignment receipt on the next round.
                self.clock = "2026-10-16T00:00:05Z"

    def test_old_capture_and_delayed_save_cannot_revive(self):
        self.save()
        delayed = self.intent()
        self.delete()
        self.assertFalse(self.save()["revived"])
        self.assertFalse(self.save(save_intent=delayed)["revived"])
        # A distinct capture with the same bytes also stays blocked without fresh intent.
        blocked = self.save(source_url="https://x.com/example/status/124/photo/1")
        self.assertEqual(blocked["capture"]["promotion_state"], "duplicateTombstoned")
        self.assertEqual(self.state()["lifecycle"], "tombstoned")
        pending = self.client.get("/v1/captures/pending", headers=self.admin)
        self.assertEqual(pending.status_code, 200, pending.text)
        self.assertEqual(pending.json()["captures"], [])

    def test_processed_request_cannot_revive_again_after_another_delete(self):
        first_intent = self.intent()
        self.save(save_intent=first_intent)
        self.delete()
        self.assertFalse(self.save(save_intent=first_intent)["revived"])
        fresh = self.intent()
        self.assertTrue(self.save(save_intent=fresh)["revived"])
        revision = self.state()["entity_revision"]
        self.assertFalse(self.save(save_intent=fresh)["revived"])
        self.assertEqual(self.state()["entity_revision"], revision)
        self.clock = "2026-10-16T00:00:05Z"
        self.assertEqual(self.command("tombstoneAsset", self.state()["asset_id"], revision).status_code, 200)
        self.clock = "2026-10-16T00:00:06Z"
        self.assertFalse(self.save(save_intent=fresh)["revived"])
        self.assertEqual(self.state()["lifecycle"], "tombstoned")

    def test_receipt_expiry_still_rejects_original_action_time(self):
        old = self.intent()
        self.save(save_intent=old)
        self.delete()
        with api_app.get_db() as db:
            db.execute("DELETE FROM asset_authority_receipts WHERE command_type='saveCapture'")
            db.commit()
        self.assertFalse(self.save(save_intent=old)["revived"])
        self.assertEqual(self.state()["lifecycle"], "tombstoned")

    def test_old_request_does_not_restore_trash_and_future_clock_is_refused(self):
        self.save()
        old = self.intent()
        self.delete(permanent=False)
        self.assertFalse(self.save()["revived"])
        self.assertFalse(self.save(save_intent=old)["revived"])
        response = self.client.post("/v1/captures", headers=self.admin,
                                    json={**self.payload, "save_intent": self.intent("2099-01-01T00:00:00Z")})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"]["code"], "captureSaveClockSkew")
        self.assertEqual(self.state()["lifecycle"], "trash")

    def test_normal_duplicate_is_unchanged_and_request_id_is_payload_bound(self):
        intent = self.intent()
        first = self.save(save_intent=intent)
        result = self.save(save_intent=self.intent())
        self.assertFalse(result["created"])
        self.assertFalse(result["revived"])
        self.assertEqual(result["capture"]["id"], first["capture"]["id"])
        response = self.client.post("/v1/captures", headers=self.admin,
                                    json={**self.payload, "classification_id": "b", "save_intent": intent})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "operationConflict")

    def test_legacy_capture_without_digest_is_verified_before_reviving(self):
        original = self.save()
        self.delete()
        with api_app.get_db() as db:
            db.execute("UPDATE captures SET sha256=NULL")
            db.commit()
        result = self.save(save_intent=self.intent())
        self.assertTrue(result["revived"])
        self.assertNotEqual(result["capture"]["object_key"], original["capture"]["object_key"])

    def test_failed_assignment_rolls_back_revive_and_receipt_together(self):
        self.save()
        self.delete()
        before = self.state()
        with mock.patch.object(classification_authority, "apply_command", side_effect=RuntimeError("assignment failed")):
            with self.assertRaisesRegex(RuntimeError, "assignment failed"):
                self.save(save_intent=self.intent())
        self.assertEqual(self.state(), before)
        self.assertNotEqual(self.changes()["items"][-1]["commandType"], "reviveCapture")
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM asset_authority_receipts WHERE command_type='saveCapture'").fetchone()[0], 0)

    def test_confirmation_is_bound_to_the_new_request_and_keeps_revive_result(self):
        self.save()
        self.delete()
        intent = self.intent()
        # The extension has its own auth boundary; exercise confirmation using a real token.
        with api_app.get_db() as db:
            db.execute("INSERT INTO extension_clients(id,token_hash,created_at,last_seen_at,revoked_at) "
                       "VALUES('revive-client',?,?,?,NULL)",
                       [api_app._token_hash("extension-test"), self.clock, self.clock])
            db.commit()
        headers = {"Authorization": "Bearer extension-test"}
        params = {key: self.payload[key] for key in ("source_url", "media_url", "classification_id")}
        params["request_id"] = intent["request_id"]
        def confirm():
            response = self.client.get("/v1/extension/captures/confirm", headers=headers, params=params)
            self.assertEqual(response.status_code, 200, response.text)
            return response.json()
        self.assertFalse(confirm()["found"])
        # Save through the extension credential, including the live-folder check.
        response = self.client.post("/v1/captures", headers=headers, json={**self.payload, "save_intent": intent})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["revived"])
        self.assertTrue(confirm()["found"])
        self.assertTrue(confirm()["revived"])
        params["classification_id"] = "b"
        self.assertFalse(confirm()["found"])
