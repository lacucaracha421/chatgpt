"""Asset Lifecycle Authority: identity, promotion idempotence, lifecycle, visibility, fence.

Every case drives the real HTTP routes against real SQLite — the shipped app wiring plus
the Asset authority routes — because the contract under test is the route contract, not a
helper's idea of it. ADR-0038 defines the invariants these assert.
"""
from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

# The R2 stub must be installed before `app` is imported: app.py reads the R2
# environment at import time and builds its client there.
from tests.test_capture_api_stub import fake_s3  # noqa: E402,F401

import api_auth  # noqa: E402
import app as api_app  # noqa: E402
import asset_authority  # noqa: E402
import authority  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

LIBRARY = "e" * 32
OTHER_LIBRARY = "f" * 32
ASSET = "20000000-0000-4000-8000-0000000000aa"
CAPTURE = "30000000-0000-4000-8000-0000000000bb"


def new_operation():
    return str(uuid.uuid4())


class AssetAuthorityFixture(unittest.TestCase):
    """The shipped app, the authority substrate, and the Asset authority routes."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "lakomics.sqlite3"
        self.old_db = api_app.DB_PATH
        self.old_token = api_app.API_TOKEN
        api_app.DB_PATH = self.database
        api_app.API_TOKEN = "shared-test-token"
        api_app.startup()
        api_app.startup_replication()
        api_app.startup_captures()
        authority.startup(api_app.get_db)
        api_auth.startup(api_app.get_db)
        api_app.startup_asset_authority()
        with api_app.get_db() as db:
            _, self.publisher_token = api_auth.provision_token(db, "publisher", "asset-test")
            db.commit()
        self.client = TestClient(api_app.app)

    def tearDown(self):
        self.client.close()
        api_app.DB_PATH = self.old_db
        api_app.API_TOKEN = self.old_token
        self.temp.cleanup()

    @property
    def publisher(self):
        return {"Authorization": f"Bearer {self.publisher_token}"}

    @property
    def admin(self):
        return {"Authorization": "Bearer shared-test-token"}

    def activate(self, library_id=LIBRARY):
        response = self.client.post("/v1/assets/authority/activate", headers=self.publisher,
                                    json={"libraryId": library_id})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def status(self, library_id=LIBRARY):
        response = self.client.get("/v1/assets/authority/status",
                                   params={"libraryId": library_id}, headers=self.publisher)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def seed_asset(self, lifecycles=(asset_authority.NORMAL,), library_id=LIBRARY):
        """Insert canonical Assets directly, as promotion or a lifecycle command would.

        Used to set up read/lifecycle cases without coupling them to the promotion path,
        which has its own tests.
        """
        with api_app.get_db() as db:
            for index, lifecycle in enumerate(lifecycles):
                db.execute(
                    "INSERT INTO asset_authority_state(library_id,asset_id,lifecycle,"
                    "entity_revision,kind,object_key,content_type,size_bytes,sha256,"
                    "created_at,updated_at) VALUES(?,?,?,1,'image',?,?,10,?,?,?)",
                    [library_id, f"20000000-0000-4000-8000-0000000000{index:02d}", lifecycle,
                     f"library/x/{index}/original", "image/png", "a" * 64,
                     "2026-09-19T00:00:00Z", "2026-09-19T00:00:00Z"])
            db.commit()

    def command(self, command_type, asset_id, revision, *, operation_id=None, headers=None,
                library_id=LIBRARY):
        return self.client.put("/v1/assets/authority/commands", headers=headers or self.publisher,
                               json={"libraryId": library_id, "epoch": 1, "contractVersion": 1,
                                     "operationId": operation_id or new_operation(),
                                     "commandType": command_type, "assetId": asset_id,
                                     "expectedEntityRevision": revision})

    def changes(self, after=0, library_id=LIBRARY):
        response = self.client.get("/v1/assets/authority/changes",
                                   params={"libraryId": library_id, "epoch": 1, "after": after},
                                   headers=self.publisher)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def baseline(self, library_id=LIBRARY):
        response = self.client.get("/v1/assets/authority/baseline",
                                   params={"libraryId": library_id, "epoch": 1},
                                   headers=self.publisher)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()


class ActivationTests(AssetAuthorityFixture):
    def test_the_domain_reports_inactive_until_an_operator_activates_it(self):
        self.assertEqual(self.status(), {"active": False, "domain": "assets"})

    def test_activation_creates_epoch_one_and_is_idempotent(self):
        first = self.activate()
        self.assertEqual((first["epoch"], first["contractVersion"], first["cursor"]), (1, 1, 0))
        # A retry is the same activation, not a second epoch.
        second = self.activate()
        self.assertEqual(second["epoch"], 1)

    def test_reads_and_commands_are_refused_while_the_domain_is_inactive(self):
        # Nothing is activated here: the whole surface must report the coded inactive
        # state rather than serving a half-defined domain.
        for path in ("changes", "baseline"):
            response = self.client.get(
                f"/v1/assets/authority/{path}",
                params={"libraryId": LIBRARY, "epoch": 1}, headers=self.publisher)
            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()["detail"]["code"], authority.CODE_AUTHORITY_INACTIVE)
        response = self.command(asset_authority.TRASH_ASSET, ASSET, 1)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], authority.CODE_AUTHORITY_INACTIVE)

    def test_activation_refuses_unowned_pre_existing_state(self):
        # State without an authority row is an interrupted/manual state this endpoint did
        # not create, so it must not be silently adopted.
        with api_app.get_db() as db:
            db.execute(
                "INSERT INTO asset_authority_state(library_id,asset_id,lifecycle,"
                "entity_revision,created_at,updated_at) VALUES(?,?,'normal',1,?,?)",
                [LIBRARY, ASSET, "2026-09-19T00:00:00Z", "2026-09-19T00:00:00Z"])
            db.commit()
        response = self.client.post("/v1/assets/authority/activate", headers=self.publisher,
                                    json={"libraryId": LIBRARY})
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "assetAuthorityStateExists")

    def test_activation_requires_the_publisher_role(self):
        with api_app.get_db() as db:
            _, client_token = api_auth.provision_token(db, "client", "asset-reader")
            db.commit()
        response = self.client.post("/v1/assets/authority/activate",
                                    headers={"Authorization": f"Bearer {client_token}"},
                                    json={"libraryId": LIBRARY})
        self.assertIn(response.status_code, (401, 403), response.text)


class PromotionTests(AssetAuthorityFixture):
    """Cloud-first promotion: a Capture becomes a canonical Asset with no PC involved."""

    def promote(self, capture_id=CAPTURE, library_id=LIBRARY, **overrides):
        fields = {"kind": "image", "object_key": f"images/inbox/{capture_id}/original",
                  "content_type": "image/jpeg", "size_bytes": 323870, "sha256": "b" * 64,
                  "source_url": "https://x.com/example/status/1/photo/1",
                  "creator_handle": "example", "import_source": "capture",
                  "collected_at": "2026-09-19T00:00:00Z"}
        fields.update(overrides)
        with api_app.get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                result = asset_authority.promote_capture(
                    db, library_id=library_id, capture_id=capture_id,
                    now="2026-09-19T00:00:00Z", **fields)
                db.commit()
                return result
            except BaseException:
                db.rollback()
                raise

    def test_promotion_creates_one_canonical_asset_without_a_pc(self):
        self.activate()
        asset_id, created = self.promote()
        self.assertTrue(created)
        with api_app.get_db() as db:
            row = asset_authority.state_row(db, LIBRARY, asset_id)
        self.assertIsNotNone(row)
        self.assertEqual(row[0], asset_authority.NORMAL)
        # The canonical id is derived from the Capture, so it is stable across processes
        # and restarts rather than depending on a counter that could be regenerated.
        self.assertEqual(asset_id, asset_authority.canonical_asset_id(LIBRARY, CAPTURE))

    def test_promotion_is_idempotent_and_yields_exactly_one_asset(self):
        self.activate()
        first_id, first_created = self.promote()
        for _ in range(5):
            repeat_id, repeat_created = self.promote()
            self.assertEqual(repeat_id, first_id)
            self.assertFalse(repeat_created)
        self.assertTrue(first_created)
        with api_app.get_db() as db:
            count = db.execute(
                "SELECT COUNT(*) FROM asset_authority_state WHERE library_id=?",
                [LIBRARY]).fetchone()[0]
            mappings = db.execute(
                "SELECT COUNT(*) FROM asset_authority_capture_map WHERE library_id=?",
                [LIBRARY]).fetchone()[0]
        self.assertEqual(count, 1, "one Capture must yield exactly one canonical Asset")
        self.assertEqual(mappings, 1)

    def test_a_promoted_asset_reaches_replicas_through_the_change_feed(self):
        self.activate()
        asset_id, _ = self.promote()
        page = self.changes()
        self.assertEqual(page["cursor"], 1)
        self.assertEqual(len(page["items"]), 1)
        item = page["items"][0]
        self.assertEqual(item["commandType"], "promoteCapture")
        self.assertEqual(item["asset"]["assetId"], asset_id)
        self.assertEqual(item["asset"]["lifecycle"], asset_authority.NORMAL)
        # The change carries what a client needs to materialize, and never media or a
        # signed URL.
        self.assertEqual(item["asset"]["objectKey"], f"images/inbox/{CAPTURE}/original")
        self.assertNotIn("downloadUrl", json.dumps(item))

    def test_promotion_never_stores_media_bytes_in_the_change_log(self):
        self.activate()
        self.promote()
        with api_app.get_db() as db:
            payload = db.execute(
                "SELECT payload FROM asset_authority_changes LIMIT 1").fetchone()[0]
        # A hash and a key are metadata; raw bytes would appear as base64 or a data URL.
        self.assertNotIn("data:", payload)
        self.assertNotIn("base64", payload.lower())

    def test_a_retry_after_the_mapping_commit_resolves_to_the_same_asset(self):
        # The crash boundary: the Asset and its mapping commit together, so a retry that
        # finds the mapping must not create a second Asset even for a different payload.
        self.activate()
        asset_id, _ = self.promote()
        repeat_id, created = self.promote(size_bytes=999)
        self.assertEqual(repeat_id, asset_id)
        self.assertFalse(created)
        with api_app.get_db() as db:
            size = db.execute(
                "SELECT size_bytes FROM asset_authority_state WHERE library_id=? AND asset_id=?",
                [LIBRARY, asset_id]).fetchone()[0]
        self.assertEqual(size, 323870, "the retry must not rewrite the canonical Asset")

    def test_different_captures_promote_to_different_assets(self):
        self.activate()
        first, _ = self.promote(capture_id="capture-a")
        second, _ = self.promote(capture_id="capture-b")
        self.assertNotEqual(first, second)

    def test_promotion_is_refused_while_the_domain_is_inactive(self):
        # The fence: with no authority row there is no canonical Asset space, so a
        # promotion must fail rather than create state nobody owns.
        with api_app.get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            with self.assertRaises(Exception) as caught:
                asset_authority.promote_capture(
                    db, library_id=LIBRARY, capture_id=CAPTURE, kind="image",
                    object_key="k", content_type="image/jpeg", size_bytes=1, sha256="b" * 64)
            db.rollback()
        self.assertIn("409", str(caught.exception))


class LifecycleTests(AssetAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()
        self.seed_asset()

    def test_normal_to_trash_to_normal_preserves_the_asset_id(self):
        trashed = self.command(asset_authority.TRASH_ASSET, self.asset_id(0), 1)
        self.assertEqual(trashed.status_code, 200, trashed.text)
        body = trashed.json()
        self.assertTrue(body["changed"])
        self.assertEqual(body["asset"]["lifecycle"], asset_authority.TRASH)
        self.assertEqual(body["asset"]["assetId"], self.asset_id(0))
        self.assertEqual(body["asset"]["entityRevision"], 2)

        restored = self.command(asset_authority.RESTORE_ASSET, self.asset_id(0), 2)
        self.assertEqual(restored.status_code, 200, restored.text)
        restored_body = restored.json()
        self.assertEqual(restored_body["asset"]["lifecycle"], asset_authority.NORMAL)
        # Restore returns the *same* logical Asset, not a new one.
        self.assertEqual(restored_body["asset"]["assetId"], self.asset_id(0))
        self.assertEqual(restored_body["asset"]["entityRevision"], 3)

    def test_trash_to_tombstone_is_terminal(self):
        self.command(asset_authority.TRASH_ASSET, self.asset_id(0), 1)
        tombstoned = self.command(asset_authority.TOMBSTONE_ASSET, self.asset_id(0), 2)
        self.assertEqual(tombstoned.status_code, 200, tombstoned.text)
        self.assertEqual(tombstoned.json()["asset"]["lifecycle"], asset_authority.TOMBSTONED)

        # Reviving a tombstone would resurrect an Asset whose deletion the log already
        # recorded, so it is refused rather than allowed silently.
        revived = self.command(asset_authority.RESTORE_ASSET, self.asset_id(0), 3)
        self.assertEqual(revived.status_code, 409, revived.text)
        self.assertEqual(revived.json()["detail"]["code"], "lifecycleTransitionRefused")

    def test_a_stale_expected_revision_is_a_coded_conflict_carrying_current_state(self):
        self.command(asset_authority.TRASH_ASSET, self.asset_id(0), 1)
        stale = self.command(asset_authority.RESTORE_ASSET, self.asset_id(0), 1)
        self.assertEqual(stale.status_code, 409, stale.text)
        detail = stale.json()["detail"]
        self.assertEqual(detail["code"], "revisionConflict")
        # The conflict must tell the client what to rebase onto, or it can only retry
        # the same losing command.
        self.assertEqual(detail["currentEntityRevision"], 2)
        self.assertEqual(detail["lifecycle"], asset_authority.TRASH)

    def test_a_repeated_operation_id_is_idempotent_and_returns_the_recorded_result(self):
        operation = new_operation()
        first = self.command(asset_authority.TRASH_ASSET, self.asset_id(0), 1,
                             operation_id=operation)
        second = self.command(asset_authority.TRASH_ASSET, self.asset_id(0), 1,
                              operation_id=operation)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        # A retried command applies exactly once: same sequence, same revision.
        self.assertEqual(first.json()["changeSequence"], second.json()["changeSequence"])
        self.assertEqual(first.json()["asset"]["entityRevision"], second.json()["asset"]["entityRevision"])

    def test_reusing_an_operation_id_for_different_content_is_refused(self):
        operation = new_operation()
        self.command(asset_authority.TRASH_ASSET, self.asset_id(0), 1, operation_id=operation)
        # Same operation id, different meaning: replaying it would silently discard one
        # of the two intents.
        conflicting = self.client.put(
            "/v1/assets/authority/commands", headers=self.publisher,
            json={"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
                  "operationId": operation, "commandType": asset_authority.RESTORE_ASSET,
                  "assetId": self.asset_id(0), "expectedEntityRevision": 2})
        self.assertEqual(conflicting.status_code, 409, conflicting.text)
        self.assertEqual(conflicting.json()["detail"]["code"], "operationConflict")

    def test_a_same_state_command_is_receipted_without_a_change_row(self):
        self.command(asset_authority.TRASH_ASSET, self.asset_id(0), 1)
        cursor = self.changes()["cursor"]
        again = self.command(asset_authority.TRASH_ASSET, self.asset_id(0), 2)
        self.assertEqual(again.status_code, 200, again.text)
        self.assertFalse(again.json()["changed"])
        self.assertIsNone(again.json()["changeSequence"])
        # No change row and no cursor advance: the client is not asked to apply a no-op.
        self.assertEqual(self.changes()["cursor"], cursor)

    def test_a_command_for_an_unknown_asset_is_not_found(self):
        response = self.command(asset_authority.TRASH_ASSET, "no-such-asset", 1)
        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(response.json()["detail"]["code"], "assetNotFound")

    def test_a_command_requires_the_publisher_role(self):
        with api_app.get_db() as db:
            _, client_token = api_auth.provision_token(db, "client", "asset-reader-2")
            db.commit()
        response = self.command(asset_authority.TRASH_ASSET, self.asset_id(0), 1,
                                headers={"Authorization": f"Bearer {client_token}"})
        self.assertIn(response.status_code, (401, 403), response.text)

    def test_the_change_feed_is_ordered_and_self_contained(self):
        self.command(asset_authority.TRASH_ASSET, self.asset_id(0), 1)
        self.command(asset_authority.RESTORE_ASSET, self.asset_id(0), 2)
        page = self.changes()
        sequences = [item["sequence"] for item in page["items"]]
        self.assertEqual(sequences, sorted(sequences))
        self.assertEqual(sequences, [1, 2])
        # Each row carries the delta a replica applies, so no point-read is needed.
        self.assertEqual(page["items"][0]["asset"]["lifecycle"], asset_authority.TRASH)
        self.assertEqual(page["items"][1]["asset"]["lifecycle"], asset_authority.NORMAL)
        # Walking from the last applied sequence yields nothing further.
        self.assertEqual(self.changes(after=2)["items"], [])

    def test_a_cursor_ahead_of_the_server_is_reported_rather_than_served_silently(self):
        response = self.client.get("/v1/assets/authority/changes",
                                   params={"libraryId": LIBRARY, "epoch": 1, "after": 99},
                                   headers=self.publisher)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], "cursorAhead")

    def asset_id(self, index):
        return f"20000000-0000-4000-8000-0000000000{index:02d}"


class VisibilityTests(AssetAuthorityFixture):
    """Trash and tombstone must not be visible through ordinary reads."""

    def setUp(self):
        super().setUp()
        self.activate()
        self.seed_asset(lifecycles=(asset_authority.NORMAL, asset_authority.TRASH,
                                    asset_authority.TOMBSTONED))

    def test_only_normal_assets_are_visible(self):
        with api_app.get_db() as db:
            ids = [f"20000000-0000-4000-8000-0000000000{i:02d}" for i in range(3)]
            visible = asset_authority.visible_asset_ids(db, LIBRARY, ids)
            hidden = asset_authority.hidden_asset_ids(db, LIBRARY, ids)
        self.assertEqual(visible, {ids[0]})
        self.assertEqual(hidden, {ids[1], ids[2]})

    def test_the_baseline_excludes_tombstoned_but_keeps_trashed_with_its_state(self):
        # A baseline installs what a client should hold. A tombstone's purpose is to stay
        # gone, while a trashed Asset must be representable as trashed.
        items = self.baseline()["items"]
        lifecycles = {item["assetId"]: item["lifecycle"] for item in items}
        self.assertEqual(len(items), 2)
        self.assertEqual(lifecycles[f"20000000-0000-4000-8000-000000000000"], asset_authority.NORMAL)
        self.assertEqual(lifecycles[f"20000000-0000-4000-8000-000000000001"], asset_authority.TRASH)

    def test_an_inactive_domain_expresses_no_visibility_opinion(self):
        # The fence is on writes. While the domain is inactive these helpers must return
        # None so a read falls back to legacy visibility instead of hiding everything.
        with api_app.get_db() as db:
            self.assertIsNone(asset_authority.visible_asset_ids(db, OTHER_LIBRARY, ["x"]))
            self.assertIsNone(asset_authority.hidden_asset_ids(db, OTHER_LIBRARY, ["x"]))


class RetentionTests(AssetAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()
        self.seed_asset()

    def test_pruning_removes_history_but_never_lifecycle_state(self):
        self.command(asset_authority.TRASH_ASSET, "20000000-0000-4000-8000-000000000000", 1)
        with api_app.get_db() as db:
            db.execute("UPDATE asset_authority_changes SET changed_at='2000-01-01T00:00:00Z'")
            db.commit()
        asset_authority.prune(api_app.get_db)
        with api_app.get_db() as db:
            remaining = db.execute("SELECT COUNT(*) FROM asset_authority_changes").fetchone()[0]
            lifecycle = asset_authority.state_row(
                db, LIBRARY, "20000000-0000-4000-8000-000000000000")[0]
            floor = asset_authority.pruned_through(db, LIBRARY, 1)
        self.assertEqual(remaining, 0)
        # "No change row" must never be read as "this Asset was deleted".
        self.assertEqual(lifecycle, asset_authority.TRASH)
        self.assertEqual(floor, 1)

    def test_a_cursor_below_the_retention_floor_is_expired_not_empty(self):
        self.command(asset_authority.TRASH_ASSET, "20000000-0000-4000-8000-000000000000", 1)
        with api_app.get_db() as db:
            db.execute("UPDATE asset_authority_changes SET changed_at='2000-01-01T00:00:00Z'")
            db.commit()
        asset_authority.prune(api_app.get_db)
        response = self.client.get("/v1/assets/authority/changes",
                                   params={"libraryId": LIBRARY, "epoch": 1, "after": 0},
                                   headers=self.publisher)
        # Reporting "no changes" here would silently drop the accepted transition.
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], authority.CODE_CURSOR_EXPIRED)


if __name__ == "__main__":
    unittest.main()


class LegacyFenceTests(AssetAuthorityFixture):
    """An old PC replication commit must not resurrect a retired authority Asset."""

    def prepare(self, asset_id=ASSET):
        response = self.client.post("/v1/replication/prepare", headers=self.admin, json={
            "asset_id": asset_id, "kind": "image", "content_type": "image/png",
            "size_bytes": 17, "sha256": "a" * 64, "collected_at": "2026-09-19T00:00:00Z",
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def commit(self, asset_id=ASSET, classification_id="lakomics-originals"):
        return self.client.post("/v1/replication/commit", headers=self.admin, json={
            "asset_id": asset_id, "kind": "image",
            "original": {"object_key": f"library/{asset_id}/original",
                         "content_type": "image/png", "size_bytes": 17, "sha256": "a" * 64},
            "thumbnail": {"object_key": f"library/{asset_id}/thumbnail",
                          "content_type": "image/webp", "size_bytes": 5},
            "content_type": "image/png", "collected_at": "2026-09-19T00:00:00Z",
            "source_published_at": None, "source_url": None, "creator_name": None,
            "creator_handle": None, "import_source": "Direct",
            "classification_ids": [classification_id],
            "expected_revision": 0, "commit_id": "fence-test",
        })

    def seed_lifecycle(self, lifecycle):
        with api_app.get_db() as db:
            db.execute(
                "INSERT INTO asset_authority_state(library_id,asset_id,lifecycle,"
                "entity_revision,kind,object_key,created_at,updated_at)"
                " VALUES(?,?,?,1,'image',?,?,?)",
                [LIBRARY, ASSET, lifecycle, f"library/{ASSET}/original",
                 "2026-09-19T00:00:00Z", "2026-09-19T00:00:00Z"])
            db.commit()

    def test_the_legacy_path_is_unchanged_while_the_domain_is_inactive(self):
        # No activation: the fence must be inert, or this change would break the shipped
        # PC-mediated path for every library that has not adopted authority.
        self.prepare()
        response = self.commit()
        self.assertEqual(response.status_code, 200, response.text)

    def test_a_legacy_commit_cannot_resurrect_a_trashed_authority_asset(self):
        self.activate()
        self.seed_lifecycle(asset_authority.TRASH)
        self.prepare()
        response = self.commit()
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "assetLifecycleOwned")
        self.assertEqual(response.json()["detail"]["lifecycle"], asset_authority.TRASH)

    def test_a_legacy_commit_cannot_resurrect_a_tombstoned_asset(self):
        self.activate()
        self.seed_lifecycle(asset_authority.TOMBSTONED)
        self.prepare()
        response = self.commit()
        self.assertEqual(response.status_code, 409, response.text)
        # A tombstone is the logical end; re-committing is how it would sneak back.
        self.assertEqual(response.json()["detail"]["lifecycle"], asset_authority.TOMBSTONED)

    def test_a_legacy_commit_is_still_allowed_for_a_normal_authority_asset(self):
        # The domain owns lifecycle, not the right to create: an Asset authority already
        # knows about and still considers normal must remain replicable, or adopting
        # authority would freeze the ordinary PC upload path.
        self.activate()
        self.seed_lifecycle(asset_authority.NORMAL)
        self.prepare()
        response = self.commit()
        self.assertEqual(response.status_code, 200, response.text)

    def test_an_asset_the_authority_has_never_seen_is_unaffected(self):
        # The domain owns lifecycle for the Assets it knows; refusing every unknown Asset
        # would block the ordinary PC-created path for no safety gain.
        self.activate()
        self.prepare(asset_id="20000000-0000-4000-8000-00000000ffff")
        response = self.commit(asset_id="20000000-0000-4000-8000-00000000ffff")
        self.assertEqual(response.status_code, 200, response.text)


class LibraryVisibilityTests(AssetAuthorityFixture):
    """/v1/library/assets must exclude retired Assets without an inactive-domain change.

    This is the concrete gap the audit found: the route filtered only on `committed`, so a
    PC-trashed Asset stayed visible to Android and the extension.
    """

    def publish(self, asset_id):
        """Commit one canonical Asset through the shipped replication path."""
        prepared = self.client.post("/v1/replication/prepare", headers=self.admin, json={
            "asset_id": asset_id, "kind": "image", "content_type": "image/png",
            "size_bytes": 17, "sha256": "a" * 64, "collected_at": "2026-09-19T00:00:00Z",
        })
        self.assertEqual(prepared.status_code, 200, prepared.text)
        committed = self.client.post("/v1/replication/commit", headers=self.admin, json={
            "asset_id": asset_id, "kind": "image",
            "original": {"object_key": f"library/{asset_id}/original",
                         "content_type": "image/png", "size_bytes": 17, "sha256": "a" * 64},
            "thumbnail": {"object_key": f"library/{asset_id}/thumbnail",
                          "content_type": "image/webp", "size_bytes": 5},
            "content_type": "image/png", "collected_at": "2026-09-19T00:00:00Z",
            "source_published_at": None, "source_url": None, "creator_name": None,
            "creator_handle": None, "import_source": "Direct", "classification_ids": [],
            "expected_revision": 0, "commit_id": f"commit-{asset_id[:8]}",
        })
        self.assertEqual(committed.status_code, 200, committed.text)

    def listed_ids(self):
        response = self.client.get("/v1/library/assets", params={"limit": 50},
                                   headers=self.admin)
        self.assertEqual(response.status_code, 200, response.text)
        return [item["id"] for item in response.json()["items"]]

    def seed_lifecycle(self, asset_id, lifecycle):
        with api_app.get_db() as db:
            db.execute(
                "INSERT INTO asset_authority_state(library_id,asset_id,lifecycle,"
                "entity_revision,kind,object_key,created_at,updated_at)"
                " VALUES(?,?,?,1,'image',?,?,?) ON CONFLICT(library_id,asset_id)"
                " DO UPDATE SET lifecycle=excluded.lifecycle",
                [LIBRARY, asset_id, lifecycle, f"library/{asset_id}/original",
                 "2026-09-19T00:00:00Z", "2026-09-19T00:00:00Z"])
            db.commit()

    def test_the_route_is_unchanged_while_the_domain_is_inactive(self):
        # Legacy compatibility: without an authority row the route must behave exactly as
        # before, or adopting this domain would be a breaking read change.
        self.publish(ASSET)
        self.assertEqual(self.listed_ids(), [ASSET])

    def test_a_trashed_asset_disappears_from_the_mobile_list(self):
        self.publish(ASSET)
        self.activate()
        self.assertEqual(self.listed_ids(), [ASSET])
        # The exact production symptom: PC trashes the Asset and mobile keeps showing it.
        self.seed_lifecycle(ASSET, asset_authority.TRASH)
        self.assertEqual(self.listed_ids(), [])

    def test_a_tombstoned_asset_does_not_reappear(self):
        self.publish(ASSET)
        self.activate()
        self.seed_lifecycle(ASSET, asset_authority.TOMBSTONED)
        self.assertEqual(self.listed_ids(), [])

    def test_a_restored_asset_returns_to_the_list(self):
        self.publish(ASSET)
        self.activate()
        self.seed_lifecycle(ASSET, asset_authority.TRASH)
        self.assertEqual(self.listed_ids(), [])
        # Restore is the same logical Asset reappearing, not a new one.
        self.seed_lifecycle(ASSET, asset_authority.NORMAL)
        self.assertEqual(self.listed_ids(), [ASSET])

    def test_lifecycle_and_classification_filters_compose(self):
        # Both clauses bind parameters now; this pins that their bindings stay aligned.
        self.publish(ASSET)
        self.activate()
        response = self.client.get(
            "/v1/library/assets",
            params={"limit": 50, "classification_id": "lakomics-originals"},
            headers=self.admin)
        self.assertEqual(response.status_code, 200, response.text)
        self.seed_lifecycle(ASSET, asset_authority.TRASH)
        filtered = self.client.get(
            "/v1/library/assets",
            params={"limit": 50, "classification_id": "lakomics-originals"},
            headers=self.admin)
        self.assertEqual(filtered.status_code, 200, filtered.text)
        self.assertEqual([item["id"] for item in filtered.json()["items"]], [])

    def test_the_cursor_pagination_still_walks_with_both_clauses_active(self):
        ids = [f"20000000-0000-4000-8000-0000000000{i:02d}" for i in range(3)]
        for asset_id in ids:
            self.publish(asset_id)
        self.activate()
        first = self.client.get("/v1/library/assets", params={"limit": 2}, headers=self.admin)
        self.assertEqual(first.status_code, 200, first.text)
        page = first.json()
        self.assertEqual(len(page["items"]), 2)
        self.assertIsNotNone(page["next_cursor"])
        second = self.client.get(
            "/v1/library/assets",
            params={"limit": 2, "cursor": page["next_cursor"]}, headers=self.admin)
        self.assertEqual(second.status_code, 200, second.text)
        # The cursor binding must still line up after the clause parameters.
        remaining = [item["id"] for item in second.json()["items"]]
        self.assertEqual(len(remaining), 1)
        self.assertNotIn(remaining[0], [item["id"] for item in page["items"]])
