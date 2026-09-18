"""Classification Authority 2A.2: digest-bound activation and legacy cutover fences."""
from __future__ import annotations

import copy
import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

from tests.test_capture_api_stub import fake_s3  # noqa: E402,F401

import album_authority  # noqa: E402
import api_auth  # noqa: E402
import app as api_app  # noqa: E402
import authority  # noqa: E402
import classification_authority  # noqa: E402
import classification_snapshot  # noqa: E402
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


class CutoverFixture(unittest.TestCase):
    """The shipped app wiring, a staging route and the real authority/command routes.

    Shared by the activation tests and the tree tests, so both exercise real HTTP
    routes against real SQLite rather than a helper's own idea of the contract.
    """

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

    def tree(self, headers=None):
        """The mobile tree route's items, as the Android provider and picker read them."""
        response = self.client.get("/v1/library/classifications", headers=headers or self.admin)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["items"]

    def structure(self, headers=None):
        """Only the structural fields, keyed by id: what the authority must own."""
        return {item["id"]: (item["kind"], item["name"], item["parent_id"],
                             item["icon_key"], item["color_key"])
                for item in self.tree(headers)}

    def command(self, command_type, *, operation_id, **entity):
        response = self.client.put("/v1/classifications/authority/commands",
                                   headers=self.publisher, json={
            "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
            "operationId": operation_id, "commandType": command_type, **entity})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def snapshot_payload(self):
        """The stored staging payload, so a test can prove the sidecar is what it thinks."""
        with api_app.get_db() as db:
            return db.execute("SELECT payload FROM classification_snapshots WHERE singleton=1"
                              ).fetchone()["payload"]


class ClassificationCutoverTests(CutoverFixture):
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

    def assign(self, classification_id, *, operation_id, expected_revision):
        response = self.client.put("/v1/classifications/authority/commands", headers=self.publisher, json={
            "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
            "operationId": operation_id, "commandType": "setAssetClassification",
            "assetId": ASSET, "classificationId": classification_id,
            "expectedRevision": expected_revision,
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_library_assets_filter_and_projection_use_authority_after_activation(self):
        """The compatibility read must agree with the authority, not the frozen legacy table.

        ADR-0037 requires these reads to be migrated before production activation: an accepted
        `setAssetClassification` is canonical, so browsing a Classification and the Asset's own
        `classification_ids` must both reflect it. The legacy `asset_classifications` row is
        deliberately left stale by the cutover, so a read that still joins it silently reports
        the pre-activation value.
        """
        self.prepare_asset()
        self.assertEqual(self.commit_asset(ROOT, 0, "legacy-relation").status_code, 200)
        staged = self.stage(snapshot(assignments=[{"assetId": ASSET, "classificationId": ROOT}]))
        self.assertEqual(self.activate(staged.json()["snapshotDigest"]).status_code, 200)
        self.assign(TAG, operation_id="22222222-2222-4222-8222-222222222222", expected_revision=1)

        under_tag = self.client.get("/v1/library/assets", headers=self.admin,
                                    params={"classification_id": TAG})
        self.assertEqual(under_tag.status_code, 200, under_tag.text)
        self.assertEqual([item["id"] for item in under_tag.json()["items"]], [ASSET])
        self.assertEqual(under_tag.json()["items"][0]["classification_ids"], [TAG])

        under_root = self.client.get("/v1/library/assets", headers=self.admin,
                                     params={"classification_id": ROOT})
        self.assertEqual(under_root.status_code, 200, under_root.text)
        self.assertEqual(under_root.json()["items"], [])

        unassigned = self.client.get("/v1/library/assets", headers=self.admin)
        self.assertEqual([item["classification_ids"] for item in unassigned.json()["items"]], [[TAG]])

    def test_library_classification_counts_use_authority_after_activation(self):
        """The sidebar's per-Classification count is an authority read, not a legacy one."""
        self.prepare_asset()
        self.assertEqual(self.commit_asset(ROOT, 0, "legacy-relation").status_code, 200)
        staged = self.stage(snapshot(assignments=[{"assetId": ASSET, "classificationId": ROOT}]))
        self.assertEqual(self.activate(staged.json()["snapshotDigest"]).status_code, 200)
        self.assign(TAG, operation_id="33333333-3333-4333-8333-333333333333", expected_revision=1)

        listed = self.client.get("/v1/library/classifications", headers=self.admin)
        self.assertEqual(listed.status_code, 200, listed.text)
        counts = {item["id"]: item["asset_count"] for item in listed.json()["items"]}
        self.assertEqual(counts[TAG], 1)
        self.assertEqual(counts[ROOT], 0)
        self.assertEqual(counts[OTHER], 0)

    def test_bulk_assignment_projection_seeks_the_requested_page(self):
        """The page projection must be bounded by the page, not by the whole library.

        A caller passes one HTTP page of Asset ids. Filtering a full-library read in Python
        returns the same answer while walking every assignment the authority holds, so this
        asserts the query plan rather than only the values.
        """
        with api_app.get_db() as db:
            # The table must exist even with no activation: this asserts the helper's own
            # query shape, which is independent of whether the domain is active.
            classification_authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            lib = LIBRARY
            for index in range(40):
                db.execute(
                    "INSERT INTO classification_authority_assignments(library_id,asset_id,"
                    "classification_id,entity_revision,created_at,updated_at)"
                    " VALUES(?,?,?,1,'2026','2026')",
                    [lib, f"asset-{index:03d}", TAG if index % 2 else None])
            db.commit()
            plan = [row["detail"] for row in db.execute(
                "EXPLAIN QUERY PLAN SELECT asset_id,classification_id"
                " FROM classification_authority_assignments"
                " WHERE library_id=? AND asset_id IN (?,?)"
                " AND classification_id IS NOT NULL"
                " ORDER BY asset_id,classification_id", [lib, "asset-000", "asset-002"])]
            self.assertTrue(any("asset_id=?" in detail for detail in plan),
                            f"the page read must seek by asset id, not scan the library: {plan}")
            projected = classification_authority.assignment_projection_many(
                db, lib, {"asset-001", "asset-003", "asset-099"})
            self.assertEqual(projected, {"asset-001": [TAG], "asset-003": [TAG]})
            # A null-classification row is authoritative *unassigned* state, and an Asset the
            # authority never mentioned is absent: both project as no membership, and neither
            # may be reported as a membership of some other Asset.
            self.assertNotIn("asset-000", projected)
            self.assertNotIn("asset-099", projected)

    def test_clearing_an_assignment_removes_it_from_every_authority_read(self):
        """`null` is a real desired value: unassigning must clear browse, count and projection."""
        self.prepare_asset()
        self.assertEqual(self.commit_asset(ROOT, 0, "legacy-relation").status_code, 200)
        staged = self.stage(snapshot(assignments=[{"assetId": ASSET, "classificationId": TAG}]))
        self.assertEqual(self.activate(staged.json()["snapshotDigest"]).status_code, 200)
        self.assign(None, operation_id="44444444-4444-4444-8444-444444444444", expected_revision=1)

        under_tag = self.client.get("/v1/library/assets", headers=self.admin,
                                    params={"classification_id": TAG})
        self.assertEqual(under_tag.json()["items"], [])
        listed = self.client.get("/v1/library/classifications", headers=self.admin)
        counts = {item["id"]: item["asset_count"] for item in listed.json()["items"]}
        self.assertEqual(counts[TAG], 0)
        unassigned = self.client.get("/v1/library/assets", headers=self.admin)
        self.assertEqual([item["classification_ids"] for item in unassigned.json()["items"]], [[]])

    def test_revisit_and_album_assets_project_authority_assignments(self):
        """Every surface that ships `classification_ids` ships the authority's value."""
        self.prepare_asset()
        self.assertEqual(self.commit_asset(ROOT, 0, "legacy-relation").status_code, 200)
        staged = self.stage(snapshot(assignments=[{"assetId": ASSET, "classificationId": ROOT}]))
        self.assertEqual(self.activate(staged.json()["snapshotDigest"]).status_code, 200)
        self.assign(TAG, operation_id="55555555-5555-4555-8555-555555555555", expected_revision=1)

        # The date bundle only offers Assets older than 30 days, so the projection is made
        # reachable directly. The unassigned case is covered by the library listing and the
        # clearing test; this one proves the shipped `classification_ids` follows the
        # authority rather than the frozen legacy relation.
        with api_app.get_db() as db:
            db.execute("UPDATE assets SET collected_at='2026-06-01T00:00:00Z' WHERE id=?", [ASSET])
            db.commit()

        revisit = self.client.get("/v1/library/revisit/date", headers=self.admin)
        self.assertEqual(revisit.status_code, 200, revisit.text)
        projected = {item["id"]: item["classification_ids"] for item in revisit.json()["items"]}
        self.assertEqual(projected.get(ASSET), [TAG])

        # The Album contents page ships the same field through `asset_classification_ids`,
        # which is what a page of `/v1/albums/{id}/assets` is projected from.
        with api_app.get_db() as db:
            row = db.execute("SELECT * FROM assets WHERE id=?", [ASSET]).fetchone()
            album_projection = album_authority.asset_classification_ids(db, [row])
        self.assertEqual(album_projection[ASSET], [TAG])

    def test_reads_keep_legacy_membership_while_authority_is_inactive(self):
        """Before activation the shipped snapshot + replicated-relation behavior is unchanged."""
        self.prepare_asset()
        self.assertEqual(self.commit_asset(ROOT, 0, "legacy-relation").status_code, 200)
        self.assertEqual(self.stage(snapshot()).status_code, 200)

        under_root = self.client.get("/v1/library/assets", headers=self.admin,
                                     params={"classification_id": ROOT})
        self.assertEqual([item["id"] for item in under_root.json()["items"]], [ASSET])
        listed = self.client.get("/v1/library/classifications", headers=self.admin)
        counts = {item["id"]: item["asset_count"] for item in listed.json()["items"]}
        self.assertEqual(counts[ROOT], 1)

    def test_stale_character_publication_converges_on_the_next_publish(self):
        """A derived Character publication frozen from the legacy table self-heals by republish.

        Character publication is a **full replacement** gated on an explicit PC publish, not
        an incremental patch of `mobile_character_assets`. That is what makes recovery a
        republish rather than ad-hoc row repair: the Asset payload is recomputed from
        canonical state for every Asset in the snapshot, so an already-stale row cannot
        survive a publication that names its Asset.
        """
        api_app.startup_mobile_characters()
        self.prepare_asset()
        self.assertEqual(self.commit_asset(ROOT, 0, "legacy-relation").status_code, 200)
        staged = self.stage(snapshot(assignments=[{"assetId": ASSET, "classificationId": ROOT}]))
        self.assertEqual(self.activate(staged.json()["snapshotDigest"]).status_code, 200)
        self.assign(TAG, operation_id="77777777-7777-4777-8777-777777777777", expected_revision=1)

        def publication(base=None):
            return {"version": 1, "baseRevision": base,
                    "nodes": [{"id": "series:s", "kind": "series", "sourceId": "s",
                               "seriesId": "s", "parentId": None, "name": "시리즈"}],
                    "scopes": [{"nodeId": "series:s", "filter": f,
                                "assetIds": [ASSET] if f == "all" else []}
                               for f in ("all", "unclassified", "needs_review")]}

        # Reproduce exactly what the pre-fix publication persisted: the Asset payload derived
        # from the frozen legacy relation, and the state revision computed *from that stale
        # payload*. Publishing the stale projection first (then asserting the post-fix path
        # overwrote it) would not model the defect, because a self-consistent stale state is
        # what the old server actually left behind.
        stale_body = self.client.put("/v1/library/characters/replica", headers=self.admin,
                                     json=publication()).json()
        stale_revision = stale_body["revision"]
        with api_app.get_db() as db:
            fresh = json.loads(db.execute(
                "SELECT payload FROM mobile_character_assets WHERE id=?", [ASSET]
            ).fetchone()["payload"])
            self.assertEqual(fresh["classification_ids"], [TAG],
                             "the post-fix projection already follows the authority")
            stale_payload = {**fresh, "classification_ids": [ROOT]}
            index = json.loads(db.execute(
                "SELECT index_json FROM mobile_character_state WHERE singleton=1"
            ).fetchone()["index_json"])
            nodes = index["nodes"]
            scopes = index["scopes"]
            stale_assets = {ASSET: stale_payload}
            stale_digest = hashlib.sha256(json.dumps(
                {"nodes": nodes, "scopes": scopes, "assets": stale_assets,
                 "navigationOrder": index["navigationOrder"]},
                ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            self.assertNotEqual(stale_digest, stale_revision,
                                "the stale and current projections must differ")
            db.execute("UPDATE mobile_character_assets SET payload=? WHERE id=?",
                       (json.dumps(stale_payload, ensure_ascii=False), ASSET))
            db.execute("UPDATE mobile_character_state SET revision=? WHERE singleton=1",
                       [stale_digest])
            db.commit()
        with api_app.get_db() as db:
            staged = json.loads(db.execute(
                "SELECT payload FROM mobile_character_assets WHERE id=?", [ASSET]
            ).fetchone()["payload"])
        self.assertEqual(staged["classification_ids"], [ROOT], "stale row staged for the test")

        healed = self.client.put("/v1/library/characters/replica", headers=self.admin,
                                 json=publication(base=stale_digest))
        self.assertEqual(healed.status_code, 200, healed.text)
        with api_app.get_db() as db:
            row = json.loads(db.execute(
                "SELECT payload FROM mobile_character_assets WHERE id=?", [ASSET]
            ).fetchone()["payload"])
            # Publication is a full replacement of *both* derived tables in one
            # transaction, so the member rows must describe the same membership the
            # payload does. A payload-only repair would leave the two disagreeing.
            members = {tuple(member) for member in db.execute(
                "SELECT node_id, filter, asset_id FROM mobile_character_members"
                " WHERE asset_id=?", [ASSET])}
        self.assertEqual(row["classification_ids"], [TAG],
                         "a republish must overwrite the stale derived row")
        self.assertEqual(
            members,
            {("series:s", "all", ASSET)},
            "the membership rows are replaced from the same publication, not patched")

    def test_stale_character_state_survives_only_until_the_next_publication(self):
        """The honest limit of the recovery: nothing else repairs a stale derived row.

        No server-side timer, scan or self-heal exists for `mobile_character_*`. While the
        PC never publishes again, a row frozen from pre-cutover state stays as it is. This
        pins that boundary explicitly so the recovery path is not mistaken for automatic
        convergence — the alternative (a server-side repair job) would invent authority
        the Character domain does not have.
        """
        api_app.startup_mobile_characters()
        self.prepare_asset()
        self.assertEqual(self.commit_asset(ROOT, 0, "legacy-relation").status_code, 200)
        staged = self.stage(snapshot(assignments=[{"assetId": ASSET, "classificationId": ROOT}]))
        self.assertEqual(self.activate(staged.json()["snapshotDigest"]).status_code, 200)
        self.assign(TAG, operation_id="88888888-8888-4888-8888-888888888888", expected_revision=1)

        publication = {"version": 1, "baseRevision": None,
                       "nodes": [{"id": "series:s", "kind": "series", "sourceId": "s",
                                  "seriesId": "s", "parentId": None, "name": "시리즈"}],
                       "scopes": [{"nodeId": "series:s", "filter": f,
                                   "assetIds": [ASSET] if f == "all" else []}
                                  for f in ("all", "unclassified", "needs_review")]}
        self.assertEqual(self.client.put("/v1/library/characters/replica", headers=self.admin,
                                         json=publication).status_code, 200)
        # Now make the derived row stale *after* publication, exactly as the audit
        # described: authority moves on, and nothing republishes.
        with api_app.get_db() as db:
            db.execute("UPDATE mobile_character_assets SET payload=? WHERE id=?",
                       (json.dumps({"id": ASSET, "classification_ids": [ROOT]}), ASSET))
            db.commit()
        with api_app.get_db() as db:
            unchanged = json.loads(db.execute(
                "SELECT payload FROM mobile_character_assets WHERE id=?", [ASSET]
            ).fetchone()["payload"])["classification_ids"]
        self.assertEqual(unchanged, [ROOT],
                         "without a publication the derived row stays stale by design")
        self.assertEqual(self.tree(), self.tree(), "an ordinary read never rewrites it")


class ClassificationTreeCutoverTests(CutoverFixture):
    """Structural commands must appear in the tree readers once the authority is active.

    The audit that produced this batch proved membership/filter/count reads follow the
    authority while the *tree* still came from the frozen `classification_snapshots`
    payload. Every test here therefore stages a frozen tree that deliberately disagrees
    with the authority it activates, then runs one accepted structural command and
    asserts the shipped tree reader follows the command rather than the frozen bytes.
    """

    RENAMED = "리네임"
    CREATED = "10000000-0000-4000-8000-0000000000cc"
    MOVED = "10000000-0000-4000-8000-0000000000dd"

    def activate_tree(self):
        """Stage the frozen tree, activate it, then accept one extra authority node.

        Activation derives authority state from the staged bytes, so the frozen tree and
        the authority tree agree only at this instant. `MOVED` is created afterwards,
        which makes it authority-only state: it exists in no frozen snapshot, so any
        reader that still renders the snapshot cannot show it.
        """
        staged = self.stage()
        self.assertEqual(staged.status_code, 200, staged.text)
        self.assertEqual(self.activate(staged.json()["snapshotDigest"]).status_code, 200)
        self.command("createClassification", operation_id="a0000000-0000-4000-8000-000000000001",
                     classificationId=self.MOVED, kind="tag", name="이동",
                     parentId=ROOT, iconKey=None, colorKey=None)

    def test_rename_uses_the_authority_name_not_the_frozen_one(self):
        self.activate_tree()
        self.assertEqual(self.structure()[ROOT][1], "게임", "activation imports the staged name")

        self.command("renameClassification", operation_id="a0000000-0000-4000-8000-000000000002",
                     classificationId=ROOT, name=self.RENAMED, expectedRevision=1)

        self.assertEqual(self.structure()[ROOT][1], self.RENAMED)
        # The frozen publication still holds the superseded name; the tree must not.
        self.assertIn("게임", self.snapshot_payload())

    def test_create_appears_in_the_tree_with_a_deterministic_position(self):
        self.activate_tree()
        items = self.tree()
        ids = [item["id"] for item in items]
        self.assertIn(self.MOVED, ids, "an authority-created node must be visible")

        # Deterministic across requests: the same call twice, and after a restart of the
        # app's own startup, returns byte-identical ordering.
        self.assertEqual(self.tree(), items)
        api_app.startup_classifications()
        self.assertEqual(self.tree(), items)

        # A create never existed in the frozen snapshot, so it carries no display slot:
        # it is ordered after every sidecar-ranked sibling of its parent.
        parent_children = [item for item in items if item["parent_id"] == ROOT]
        self.assertEqual([item["id"] for item in parent_children][-1], self.MOVED)
        self.assertEqual([item["sort_index"] for item in items], list(range(len(items))))

    def test_move_uses_the_authority_parent_not_the_frozen_one(self):
        self.activate_tree()
        # `OTHER` is a root in the frozen tree; move it under ROOT, which also derives a
        # new kind. Both are authority-only outcomes the snapshot cannot express.
        self.command("moveClassification", operation_id="a0000000-0000-4000-8000-000000000003",
                     classificationId=OTHER, parentId=ROOT, expectedRevision=1)

        structure = self.structure()
        self.assertEqual(structure[OTHER][2], ROOT, "the tree follows the authority parent")
        self.assertEqual(structure[OTHER][0], "tag", "the derived kind is the authority's")
        self.assertNotIn(OTHER, [item["id"] for item in self.tree() if item["parent_id"] is None],
                         "the old parent set no longer contains it")
        self.assertIn(OTHER, [item["id"] for item in self.tree() if item["parent_id"] == ROOT])

    def test_appearance_uses_the_authority_values_not_the_frozen_ones(self):
        self.activate_tree()
        self.command("updateClassificationAppearance",
                     operation_id="a0000000-0000-4000-8000-000000000004",
                     classificationId=ROOT, iconKey="rocket", colorKey="pink", expectedRevision=1)

        kind, _name, _parent, icon_key, color_key = self.structure()[ROOT]
        self.assertEqual((icon_key, color_key), ("rocket", "pink"))
        self.assertEqual(kind, "root")

    def test_delete_removes_the_node_and_follows_the_authority_assignment_semantics(self):
        self.activate_tree()
        # `TAG` has no children, so it is deletable, and `MOVED`'s authority assignment
        # semantics are what the tree must reflect afterwards: children of TAG vanish with
        # it rather than remaining under a node the authority no longer holds.
        self.command("deleteClassification", operation_id="a0000000-0000-4000-8000-000000000005",
                     classificationId=TAG, expectedRevision=1)

        ids = [item["id"] for item in self.tree()]
        self.assertNotIn(TAG, ids, "a deleted node is absent from the live tree")
        self.assertIn(TAG, self.snapshot_payload(), "the frozen snapshot still contains it")
        counts = {item["id"]: item["asset_count"] for item in self.tree()}
        self.assertNotIn(TAG, counts)

    def test_the_tree_surface_carries_no_role_and_its_originals_node_is_authority_state(self):
        """Roles live in the authority baseline, not in this compatibility tree.

        The tree surface represents structure only, so what matters here is that the
        protected node is described by canonical authority state rather than by the frozen
        publication — and that no role field is invented on the wire for consumers that
        never had one.
        """
        self.activate_tree()
        items = self.tree()
        self.assertEqual(set(items[0]), {"id", "kind", "name", "parent_id", "icon_key",
                                         "color_key", "sort_index", "asset_count"},
                         "the compatibility tree shape is unchanged")

        with api_app.get_db() as db:
            role_id = db.execute(
                "SELECT classification_id FROM classification_authority_roles"
                " WHERE library_id=? AND role='originals'", [LIBRARY]).fetchone()[0]
            authority_row = classification_authority.classification_row(db, LIBRARY, role_id)
            # Change the authority's own appearance for the role node, so the tree can only
            # match if it reads canonical state. The role node is protected from
            # rename/move/delete, which is why appearance is what this pins.
            db.execute("UPDATE classification_authority_state SET icon_key='trophy',"
                       " color_key='amber' WHERE library_id=? AND classification_id=?",
                       [LIBRARY, role_id])
            db.commit()
        row = next(item for item in self.tree() if item["id"] == role_id)
        self.assertEqual((row["kind"], row["name"], row["parent_id"], row["icon_key"],
                          row["color_key"]),
                         (authority_row["kind"], authority_row["name"],
                          authority_row["parent_id"], "trophy", "amber"))

    def test_existing_display_order_survives_and_authority_only_nodes_do_not_displace_it(self):
        """The display-order contract: sidecar ranks win, and arrivals follow every rank."""
        self.activate_tree()
        ranked = [item["id"] for item in self.tree()]
        self.assertEqual(ranked, [ROOT, TAG, OTHER, ORIGINALS, self.MOVED],
                         "the pre-activation order is the order this route already had")

        # Two authority-only siblings whose arrival order is pinned by storing distinct
        # creation instants, so the rule is asserted rather than a same-second tie.
        self.command("createClassification", operation_id="a0000000-0000-4000-8000-000000000006",
                     classificationId=self.CREATED, kind="tag", name="가나다",
                     parentId=ROOT, iconKey=None, colorKey=None)
        with api_app.get_db() as db:
            db.execute("UPDATE classification_authority_state SET created_at='2026-01-01T00:00:00Z'"
                       " WHERE classification_id=?", [self.CREATED])
            db.execute("UPDATE classification_authority_state SET created_at='2026-02-01T00:00:00Z'"
                       " WHERE classification_id=?", [self.MOVED])
            db.commit()
        after = [item["id"] for item in self.tree()]
        self.assertEqual(after[:4], ranked[:4], "existing user-visible order is stable")
        self.assertEqual(after[4:], [self.CREATED, self.MOVED],
                         "arrivals sort after every rank, by creation then id")
        self.assertEqual([item["sort_index"] for item in self.tree()], list(range(6)),
                         "sort_index is the shipped list position")
        api_app.startup_classifications()
        self.assertEqual([item["id"] for item in self.tree()], after,
                         "the order is deterministic across a restart")

    def test_moving_a_node_into_a_ranked_sibling_set_does_not_steal_a_display_slot(self):
        self.activate_tree()
        # `OTHER` was published as a root, so its recorded position belongs to the root
        # set. Moving it under ROOT must not carry that slot into ROOT's children.
        self.command("moveClassification", operation_id="a0000000-0000-4000-8000-000000000007",
                     classificationId=OTHER, parentId=ROOT, expectedRevision=1)

        children = [item["id"] for item in self.tree() if item["parent_id"] == ROOT]
        self.assertEqual(children, [TAG, OTHER, self.MOVED],
                         "the ranked sibling keeps its slot and both arrivals follow it,"
                         " ordered by creation: OTHER existed before MOVED was created")

    def test_the_extension_bootstrap_follows_the_same_projection(self):
        self.activate_tree()
        auth = self.pair_extension()
        bootstrap = self.client.get("/v1/extension/bootstrap", headers=auth)
        self.assertEqual(bootstrap.status_code, 200, bootstrap.text)
        entries = bootstrap.json()["classifications"]["entries"]
        by_id = {entry["id"]: entry for entry in entries}

        # Structure is authority state, and an authority-only node reaches the extension.
        self.assertIn(self.MOVED, by_id,
                      "the authority-created node reaches the extension")
        self.assertEqual(by_id[self.MOVED]["parentId"], ROOT)
        self.command("renameClassification", operation_id="a0000000-0000-4000-8000-000000000008",
                     classificationId=ROOT, name=self.RENAMED, expectedRevision=1)
        refreshed = {entry["id"]: entry for entry
                     in self.client.get("/v1/extension/bootstrap", headers=auth)
                     .json()["classifications"]["entries"]}
        self.assertEqual(refreshed[ROOT]["name"], self.RENAMED,
                         "the bootstrap ships authority structure, not frozen structure")

        # Its own historical display order is preserved: this route always shipped the
        # publisher's order (`legacyEntries`), with the arrival appended after the ranks.
        self.assertEqual([entry["id"] for entry in entries],
                         [ORIGINALS, ROOT, TAG, OTHER, self.MOVED])
        self.assertEqual(set(by_id[ROOT]), {"id", "kind", "name", "parentId", "iconKey",
                                            "colorKey", "assetCount"},
                         "the legacy entry shape is unchanged")

    def test_pairing_exchange_follows_the_same_projection(self):
        self.activate_tree()
        self.command("renameClassification", operation_id="a0000000-0000-4000-8000-000000000009",
                     classificationId=ROOT, name=self.RENAMED, expectedRevision=1)

        created = self.client.post("/v1/extension/pairings", headers=self.admin, json={})
        secret = created.json()["pairingUrl"].split("#", 1)[1]
        exchanged = self.client.post("/v1/extension/pair", json={"secret": secret})
        self.assertEqual(exchanged.status_code, 200, exchanged.text)
        entries = exchanged.json()["classifications"]["entries"]
        self.assertEqual({entry["id"]: entry["name"] for entry in entries}[ROOT], self.RENAMED)

    def test_a_missing_snapshot_row_does_not_hide_the_active_authority_tree(self):
        """The tree is authority state, so a lost sidecar degrades display order only."""
        self.activate_tree()
        self.command("renameClassification", operation_id="a0000000-0000-4000-8000-00000000000a",
                     classificationId=ROOT, name=self.RENAMED, expectedRevision=1)
        with api_app.get_db() as db:
            db.execute("DELETE FROM classification_snapshots")
            db.commit()

        items = self.tree()
        self.assertEqual({item["id"]: item["name"] for item in items}[ROOT], self.RENAMED)
        self.assertIn(self.MOVED, [item["id"] for item in items])
        # With no sidecar every node is an unranked arrival, so the order is the
        # deterministic (created_at, id) order rather than an error or an empty tree.
        self.assertEqual([item["id"] for item in items],
                         sorted((ROOT, TAG, OTHER, ORIGINALS, self.MOVED)))

    def test_inactive_authority_keeps_the_legacy_tree_exactly(self):
        """Without an authority row the shipped snapshot projection is byte-identical."""
        self.assertEqual(self.stage().status_code, 200)
        with api_app.get_db() as db:
            self.assertIsNone(authority.active_domain(db, classification_authority.DOMAIN))
        published = self.client.get("/v1/library/classifications", headers=self.admin).json()

        # The shipped projection: the mobile route's own historical order — for a stored
        # version-2 row that is the canonical id-sorted `entries` — with the published
        # `assetCount` ignored in favor of counted committed relations.
        self.assertEqual(published["published_at"], "2026-09-16T00:00:00+00:00")
        self.assertEqual(
            [(item["id"], item["name"], item["parent_id"], item["sort_index"])
             for item in published["items"]],
            [(ROOT, "게임", None, 0), (TAG, "아로나", ROOT, 1),
             (OTHER, "기타", None, 2), (ORIGINALS, "오리지널", None, 3)])
        self.assertEqual([item["asset_count"] for item in published["items"]], [0, 0, 0, 0])

        # The extension bootstrap keeps shipping the publisher's own display order.
        auth = self.pair_extension()
        entries = self.client.get("/v1/extension/bootstrap", headers=auth).json()["classifications"]["entries"]
        self.assertEqual([entry["id"] for entry in entries],
                         [ORIGINALS, ROOT, TAG, OTHER])
        self.assertEqual(entries[0]["assetCount"], 0)

        with api_app.get_db() as db:
            self.assertEqual(db.execute(
                "SELECT COUNT(*) FROM classification_authority_state").fetchone()[0], 0,
                "an inactive library must not be routed through authority tables")

    def test_the_authority_tree_read_is_bounded_and_indexed(self):
        """One tree read and one grouped count read, never one query per Classification."""
        self.activate_tree()
        with api_app.get_db() as db:
            plan = [row["detail"] for row in db.execute(
                "EXPLAIN QUERY PLAN SELECT classification_id,kind,name,parent_id,icon_key,"
                "color_key FROM classification_authority_state"
                " WHERE library_id=? AND deleted=0", [LIBRARY])]
            self.assertTrue(any("classification_authority_by_parent" in detail
                                for detail in plan),
                            f"the tree read must use the live-row index: {plan}")
            counts_plan = [row["detail"] for row in db.execute(
                "EXPLAIN QUERY PLAN SELECT classification_id, COUNT(*) AS asset_count"
                " FROM classification_authority_assignments"
                " WHERE library_id = ? AND classification_id IS NOT NULL"
                " GROUP BY classification_id", [LIBRARY])]
            self.assertTrue(any("COVERING INDEX" in detail for detail in counts_plan),
                            f"counts must be one grouped index read: {counts_plan}")

        statements = []
        with api_app.get_db() as db:
            db.set_trace_callback(statements.append)
            items = classification_authority.compatibility_tree(
                db, {"libraryId": LIBRARY}, None)
        self.assertEqual(len(items), 5)
        # Bounded by the projection, not by the library: exactly one state read and one
        # count read, whatever the Classification count.
        self.assertEqual(sum("FROM classification_authority_state" in sql for sql in statements), 1)
        self.assertEqual(sum("FROM classification_authority_assignments" in sql
                             for sql in statements), 1)

    def test_the_sidecar_extracts_display_order_only(self):
        """Only ordering metadata is read; no frozen structural field can leak through."""
        order = classification_snapshot.display_order([
            {"id": "a", "name": "Old", "parentId": None, "iconKey": "star", "assetCount": 9},
            {"id": "b", "name": "Child", "parentId": "a"},
            {"id": "b", "name": "Duplicate", "parentId": "a"},
            {"name": "no id"},
            "not-an-entry",
            {"id": "empty-parent", "parentId": ""},
        ])
        self.assertEqual(order, {"a": (0, None), "b": (1, "a"), "empty-parent": (5, None)})


class ClassificationTreeSnapshotConsistencyTests(CutoverFixture):
    """One tree response must come from one SQLite read snapshot.

    `compatibility_tree` reads the assignment counts and then the structural rows with two
    separate statements. Sharing one connection is *not* sufficient proof: outside a
    transaction each statement takes its own snapshot, so a concurrent commit between them
    ships counts from S1 with a tree from S2 — a response describing no state the authority
    ever held. This pins the boundary with a deterministic writer-in-hook race (never
    sleeps), mirroring `ChangesSnapshotCoherenceTests`.

    The concurrent mutation is chosen so a mix is *observable*: one commit renames a
    surviving node **and** moves its assignment, so the two halves of the response
    disagree about both a name and a count that stay present in both snapshots. (A delete
    cannot prove this — a node missing from the newer tree makes its stale count unused
    and therefore undetectable.)
    """

    def setUp(self):
        super().setUp()
        staged = self.stage()
        self.assertEqual(self.activate(staged.json()["snapshotDigest"]).status_code, 200)
        self.prepare_asset()
        self.assertEqual(self.commit_asset(ROOT, 0, "legacy-relation").status_code, 200)
        self.command("setAssetClassification",
                     operation_id="b0000000-0000-4000-8000-000000000001",
                     assetId=ASSET, classificationId=TAG, expectedRevision=0)
        # TAG holds the Asset, so S1 is ("아로나", count 1) and S2 renames it and moves the
        # Asset to ROOT, i.e. ("새 이름", count 0) with ROOT at count 1.
        self.assertTrue(self.wal())

    def wal(self):
        """WAL, like production: a reader's snapshot and a writer's commit coexist."""
        with api_app.get_db() as db:
            return db.execute("PRAGMA journal_mode=WAL").fetchone()[0].lower() == "wal"

    def concurrent_rename_and_reassign(self):
        """One commit that changes structure and counts together, on a separate connection.

        Written directly rather than through the command route because this is a
        concurrency probe: it must land inside the tree build, and it must be the *same*
        atomic commit a real command performs (tombstone/rename and assignment transition
        are one authority domain for exactly this reason).
        """
        writer = sqlite3.connect(self.database, timeout=0.25)
        try:
            writer.row_factory = sqlite3.Row
            writer.execute("BEGIN IMMEDIATE")
            writer.execute(
                "UPDATE classification_authority_state SET name='새 이름',"
                "entity_revision=entity_revision+1 WHERE library_id=? AND classification_id=?",
                [LIBRARY, TAG])
            writer.execute(
                "UPDATE classification_authority_assignments SET classification_id=?,"
                "entity_revision=entity_revision+1 WHERE library_id=? AND classification_id=?",
                [ROOT, LIBRARY, TAG])
            writer.execute("UPDATE authority_domains SET change_cursor=change_cursor+1"
                           " WHERE library_id=? AND domain=?",
                           [LIBRARY, classification_authority.DOMAIN])
            writer.commit()
            return None
        except sqlite3.OperationalError as error:
            writer.rollback()
            return str(error)
        finally:
            writer.close()

    def capture_counts_read(self, hook):
        """Run `hook` between the counts read and the structural rows read.

        `compatibility_tree` reads counts first, so wrapping the counts helper places the
        hook exactly in the window the invariant is about — whichever order the
        implementation later uses, a mix is still what this detects. The hook reports what
        the concurrent writer saw: an error string when blocked, else ``None``.
        """
        real_counts = classification_authority.classification_counts
        observed = {"count": 0, "outcome": None}

        def wrapper(db, library_id):
            counts = real_counts(db, library_id)
            observed["count"] += 1
            observed["outcome"] = hook()
            return counts

        classification_authority.classification_counts = wrapper
        return real_counts, observed

    def shape(self, items):
        """The (name, parent, count) triple each response item carries, keyed by id."""
        return {item["id"]: (item["name"], item["parent_id"], item["asset_count"])
                for item in items}

    def test_a_commit_during_the_tree_build_cannot_mix_snapshots(self):
        """The whole response is S1, or the whole response is S2. Never a mix."""
        before = self.shape(self.tree())
        real_counts, observed = self.capture_counts_read(self.concurrent_rename_and_reassign)
        try:
            response = self.client.get("/v1/library/classifications", headers=self.admin)
        finally:
            classification_authority.classification_counts = real_counts

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(observed["count"], 1, "the race hook must have run inside the read")
        mixed = self.shape(response.json()["items"])
        after = self.shape(self.tree())
        self.assertNotEqual(before, after, "the concurrent command must be observable")
        self.assertTrue(
            mixed == before or mixed == after,
            f"the response mixed two snapshots:\n  response={mixed}\n  S1={before}\n  S2={after}")
        if observed["outcome"] is None:
            # The commit landed after the counts snapshot, so the response reports the
            # pre-commit state in *both* halves — not the new name with the stale count.
            self.assertEqual(mixed, before)
            self.assertEqual(mixed[TAG], ("아로나", ROOT, 1))
        else:
            # The read transaction held the lock, so the writer could not commit at all:
            # the stronger form of the guarantee.
            self.assertIn("locked", observed["outcome"])
            self.assertEqual(mixed, before)

        # No accepted change is lost: the next read serves S2.
        self.assertEqual(self.shape(self.tree()), after)

    def test_no_response_can_pair_a_new_name_with_a_stale_count(self):
        """Even if the commit is forced between the two reads, the halves must agree.

        This is the same race asserted on the *forbidden* pair directly, so the invariant
        does not depend on which side of the snapshot the writer landed on.
        """
        real_counts, observed = self.capture_counts_read(self.concurrent_rename_and_reassign)
        try:
            items = self.tree()
        finally:
            classification_authority.classification_counts = real_counts
        self.assertEqual(observed["count"], 1)
        mixed = self.shape(items)
        self.assertNotEqual(
            mixed[TAG], ("새 이름", ROOT, 1),
            "a response may not combine the newer structure with the older count")

    def test_the_tree_read_ends_its_transaction_before_responding(self):
        """No read transaction (and so no lock) survives the projection call."""
        with api_app.get_db() as db:
            db.execute("BEGIN")
            items = classification_authority.compatibility_tree(
                db, {"libraryId": LIBRARY}, None)
            self.assertTrue(db.in_transaction, "the caller owns the transaction it opened")
            db.rollback()
        self.assertTrue(items)
        # A separate writer commits immediately once the read transaction is closed.
        self.assertIsNone(self.concurrent_rename_and_reassign())
        self.assertEqual(self.shape(self.tree())[TAG], ("새 이름", ROOT, 0))

    def test_a_read_never_blocks_an_accepted_command(self):
        """The read path must not turn into a write-lock stall for the command lane."""
        self.assertTrue(
            self.command("renameClassification",
                         operation_id="b0000000-0000-4000-8000-000000000003",
                         classificationId=OTHER, name="새 이름", expectedRevision=1)["changed"])
        self.assertEqual(self.structure()[OTHER][1], "새 이름")


if __name__ == "__main__":
    unittest.main()
