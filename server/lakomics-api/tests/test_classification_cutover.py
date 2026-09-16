"""Classification Authority 2A.2: digest-bound activation and legacy cutover fences."""
from __future__ import annotations

import copy
import hashlib
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from tests.test_capture_api_stub import fake_s3  # noqa: E402,F401

import api_auth  # noqa: E402
import app as api_app  # noqa: E402
import authority  # noqa: E402
import classification_authority  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

LIBRARY = "c" * 32
OTHER_LIBRARY = "d" * 32
ROOT = "10000000-0000-4000-8000-000000000001"
TAG = "10000000-0000-4000-8000-000000000002"
OTHER = "10000000-0000-4000-8000-000000000003"
ORIGINALS = "lakomics-originals"
ASSET = "20000000-0000-4000-8000-000000000001"
UNMATERIALIZED = "20000000-0000-4000-8000-0000000000ff"


def snapshot(assignments=None, *, published_at="2026-09-16T00:00:00+00:00", roles=None):
    return {
        "snapshotVersion": 2,
        "published_at": published_at,
        "entries": [
            {"id": ORIGINALS, "kind": "root", "name": "오리지널", "parentId": None,
             "iconKey": "sparkles", "colorKey": None, "assetCount": 0},
            {"id": ROOT, "kind": "root", "name": "게임", "parentId": None,
             "iconKey": "folder", "colorKey": "blue", "assetCount": 1},
            {"id": TAG, "kind": "tag", "name": "아로나", "parentId": ROOT,
             "iconKey": None, "colorKey": None, "assetCount": 1},
            {"id": OTHER, "kind": "root", "name": "기타", "parentId": None,
             "iconKey": None, "colorKey": None, "assetCount": 0},
        ],
        "assignments": assignments if assignments is not None else [],
        "roles": roles if roles is not None else
                 [{"role": "originals", "classificationId": ORIGINALS}],
    }


class ClassificationCutoverTests(unittest.TestCase):
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
        api_app.startup_classifications()
        api_app.startup_extension_profile()
        authority.startup(api_app.get_db)
        api_auth.startup(api_app.get_db)
        classification_authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            _, self.publisher_token = api_auth.provision_token(db, "publisher", "cutover-test")
            db.commit()
        self.client = TestClient(api_app.app)

    def tearDown(self):
        self.client.close()
        api_app.DB_PATH = self.old_db
        api_app.API_TOKEN = self.old_token
        self.temp.cleanup()

    @property
    def admin(self):
        return {"Authorization": "Bearer shared-test-token"}

    @property
    def publisher(self):
        return {"Authorization": f"Bearer {self.publisher_token}"}

    def stage(self, body=None):
        return self.client.put("/v1/classifications", headers=self.admin,
                               json=body if body is not None else snapshot())

    def activate(self, digest=None, library_id=LIBRARY, headers=None):
        if digest is None:
            digest = self.client.get("/v1/classifications/meta", headers=self.admin).json()["snapshotDigest"]
        return self.client.post(
            "/v1/classifications/authority/activate",
            headers=headers or self.publisher,
            json={"libraryId": library_id, "expectedSnapshotDigest": digest},
        )

    def prepare_asset(self):
        response = self.client.post("/v1/replication/prepare", headers=self.admin, json={
            "asset_id": ASSET, "kind": "image", "content_type": "image/png",
            "size_bytes": 17, "sha256": "a" * 64, "collected_at": "2026-09-16T00:00:00Z",
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def commit_asset(self, classification_id, expected_revision=0, commit_id="first"):
        return self.client.post("/v1/replication/commit", headers=self.admin, json={
            "asset_id": ASSET, "kind": "image",
            "original": {"object_key": f"library/{ASSET}/original", "content_type": "image/png",
                         "size_bytes": 17, "sha256": "a" * 64},
            "thumbnail": {"object_key": f"library/{ASSET}/thumbnail", "content_type": "image/webp",
                          "size_bytes": 5},
            "content_type": "image/png", "collected_at": "2026-09-16T00:00:00Z",
            "source_published_at": None, "source_url": None, "creator_name": None,
            "creator_handle": None, "import_source": "Direct",
            "classification_ids": [classification_id],
            "expected_revision": expected_revision, "commit_id": commit_id,
        })

    def pair_extension(self):
        created = self.client.post("/v1/extension/pairings", headers=self.admin, json={})
        self.assertEqual(created.status_code, 200, created.text)
        secret = created.json()["pairingUrl"].split("#", 1)[1]
        exchanged = self.client.post("/v1/extension/pair", json={"secret": secret})
        self.assertEqual(exchanged.status_code, 200, exchanged.text)
        return {"Authorization": f"Bearer {exchanged.json()['clientToken']}"}

    def test_activation_is_digest_bound_and_imports_the_staged_state(self):
        staged = self.stage(snapshot(assignments=[
            {"assetId": ASSET, "classificationId": TAG},
            {"assetId": UNMATERIALIZED, "classificationId": ROOT},
        ]))
        self.assertEqual(staged.status_code, 200, staged.text)
        digest = staged.json()["snapshotDigest"]
        self.assertEqual(self.activate("0" * 64).json()["detail"]["code"],
                         "classificationBaselineChanged")
        activated = self.activate(digest)
        self.assertEqual(activated.status_code, 200, activated.text)
        body = activated.json()
        self.assertEqual((body["libraryId"], body["epoch"], body["contractVersion"], body["cursor"]),
                         (LIBRARY, 1, 1, 0))
        self.assertEqual((body["classificationCount"], body["assignmentCount"], body["roleCount"]),
                         (4, 2, 1))
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM classification_authority_state").fetchone()[0], 4)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM classification_authority_assignments").fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT classification_id FROM classification_authority_assignments WHERE asset_id=?",
                                        [UNMATERIALIZED]).fetchone()[0], ROOT)
        baseline = self.client.get(
            "/v1/classifications/authority/baseline",
            headers=self.publisher,
            params={"libraryId": LIBRARY, "epoch": 1},
        )
        self.assertEqual(baseline.status_code, 200, baseline.text)
        self.assertEqual(baseline.json()["snapshotCursor"], 0)
        self.assertEqual(baseline.json()["roles"],
                         [{"role": "originals", "classificationId": ORIGINALS}])
        retry = self.activate(digest)
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.json(), body)

    def test_activation_refuses_a_library_identity_that_disagrees_with_existing_domains(self):
        staged = self.stage()
        self.assertEqual(staged.status_code, 200, staged.text)
        with api_app.get_db() as db:
            db.execute(
                "INSERT INTO authority_domains(library_id,domain,epoch,contract_version,"
                "change_cursor,baseline_digest,baseline_revision,activated_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                [OTHER_LIBRARY, "albums", 1, 1, 0, "e" * 64, None,
                 "2026-09-16T00:00:00Z"],
            )
            db.commit()
        response = self.activate(staged.json()["snapshotDigest"], library_id=LIBRARY)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], authority.CODE_AUTHORITY_LIBRARY_MISMATCH)
        with api_app.get_db() as db:
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM authority_domains WHERE domain=?",
                [classification_authority.DOMAIN]).fetchone()[0], 0)

    def test_activation_requires_v2_and_publisher_authority(self):
        v1 = {"entries": [], "published_at": "2026-09-16T00:00:00+00:00"}
        self.assertEqual(self.stage(v1).status_code, 200)
        denied = self.activate(headers=self.admin)
        self.assertEqual(denied.status_code, 401)
        response = self.activate()
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "classificationSnapshotNotAuthorityReady")

    def test_originals_role_must_target_a_root(self):
        response = self.stage(snapshot(roles=[{"role": "originals", "classificationId": TAG}]))
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"]["code"], "invalidClassificationRole")

    def test_activation_fences_later_snapshot_publication_without_changing_staging(self):
        staged = self.stage()
        digest = staged.json()["snapshotDigest"]
        self.assertEqual(self.activate(digest).status_code, 200)
        before = self.client.get("/v1/classifications/meta", headers=self.admin).json()
        later = snapshot(published_at="2026-09-17T00:00:00+00:00")
        later["entries"][1]["name"] = "덮어쓰기"
        response = self.stage(later)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], authority.CODE_LEGACY_WRITER_FENCED)
        self.assertEqual(self.client.get("/v1/classifications/meta", headers=self.admin).json(), before)

    def test_replication_keeps_asset_metadata_but_cannot_overwrite_classification_after_activation(self):
        self.prepare_asset()
        first = self.commit_asset(ROOT, 0, "before-activation")
        self.assertEqual(first.status_code, 200, first.text)
        staged = self.stage(snapshot(assignments=[{"assetId": ASSET, "classificationId": TAG}]))
        self.assertEqual(staged.status_code, 200, staged.text)
        self.assertEqual(self.activate(staged.json()["snapshotDigest"]).status_code, 200)
        second = self.commit_asset(OTHER, 1, "after-activation")
        self.assertEqual(second.status_code, 200, second.text)
        with api_app.get_db() as db:
            self.assertEqual(db.execute("SELECT metadata_revision FROM assets WHERE id=?", [ASSET]).fetchone()[0], 2)
            self.assertEqual(db.execute("SELECT classification_id FROM asset_classifications WHERE asset_id=?", [ASSET]).fetchone()[0], ROOT)
            self.assertEqual(db.execute("SELECT classification_id FROM classification_authority_assignments WHERE asset_id=?", [ASSET]).fetchone()[0], TAG)

    def test_contains_uses_authority_assignment_after_activation(self):
        self.prepare_asset()
        self.assertEqual(self.commit_asset(ROOT, 0, "legacy-relation").status_code, 200)
        staged = self.stage(snapshot(assignments=[{"assetId": ASSET, "classificationId": TAG}]))
        self.assertEqual(self.activate(staged.json()["snapshotDigest"]).status_code, 200)
        tag = self.client.get(f"/v1/library/classifications/{TAG}/contains/{ASSET}", headers=self.admin)
        self.assertEqual(tag.status_code, 200)
        self.assertTrue(tag.json()["is_child"])
        self.assertFalse(self.client.get(
            f"/v1/library/classifications/{OTHER}/contains/{ASSET}", headers=self.admin).json()["is_child"])

    def test_capture_validation_uses_authority_not_the_frozen_legacy_snapshot(self):
        staged = self.stage()
        self.assertEqual(self.activate(staged.json()["snapshotDigest"]).status_code, 200)
        deleted = self.client.put("/v1/classifications/authority/commands", headers=self.publisher, json={
            "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
            "operationId": "11111111-1111-4111-8111-111111111111",
            "commandType": "deleteClassification", "classificationId": TAG,
            "expectedRevision": 1,
        })
        self.assertEqual(deleted.status_code, 200, deleted.text)
        auth = self.pair_extension()
        response = self.client.post("/v1/captures", headers=auth, json={
            "source_url": "https://x.com/example/status/1",
            "media_url": "https://pbs.twimg.com/media/example.jpg",
            "classification_id": TAG, "media_type": "image", "source": "x",
        })
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "classification_stale")


if __name__ == "__main__":
    unittest.main()
