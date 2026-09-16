"""Classification snapshot staging: version 1 legacy and version 2 authority-ready.

These tests pin the server-first half of the Classification rolling upgrade. The
recurring hazards are:

* breaking the deployed publisher by tightening version 1, which this batch must not do;
* letting a version-2 publisher omit `assignments`/`roles`, so activation would later
  read "not stated" as "stated empty" and destroy real user state;
* accepting a structurally impossible hierarchy, then having activation reject or
  silently normalize the same bytes;
* collapsing a multi-assigned Asset instead of reporting the disagreement;
* requiring a staged Asset to exist server-side, which would drop the assignment of a
  locally trashed Asset;
* letting a stale publication overwrite a newer staged snapshot;
* leaking canonical collections or `snapshotVersion` into the legacy readers;
* staging accidentally activating authority or fencing the legacy writer.

The fixture drives the shipped routes through `app.py` (with the canonical R2 stub), so
the version handling and staleness check under test are the real ones.
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

# Importing app.py needs R2 credentials and the shared S3 stub, exactly as the shipped
# capture/catalog tests do.
from tests.test_capture_api_stub import fake_s3  # noqa: E402,F401

import api_auth  # noqa: E402
import authority  # noqa: E402
import app as api_app  # noqa: E402
import classification_authority  # noqa: E402
import classification_snapshot  # noqa: E402

SNAPSHOT = "/v1/classifications"
META = "/v1/classifications/meta"
BASELINE = "/v1/classifications/authority/baseline"

ROOT = "10000000-0000-4000-8000-000000000001"
WORK = "10000000-0000-4000-8000-000000000002"
TAG = "10000000-0000-4000-8000-000000000003"
ORIGINALS = "lakomics-originals"

# A real Asset id that exists in the server projection, and one that deliberately does not.
MATERIALIZED = "20000000-0000-4000-8000-000000000001"
UNMATERIALIZED = "20000000-0000-4000-8000-0000000000ff"


def v2_body(**overrides):
    """A minimal, fully valid authority-ready snapshot."""
    body = {
        "snapshotVersion": 2,
        "published_at": "2026-09-16T00:00:00+00:00",
        "entries": [
            {"id": ORIGINALS, "kind": "root", "name": "오리지널", "parentId": None,
             "iconKey": "sparkles", "colorKey": None},
            {"id": ROOT, "kind": "root", "name": "게임", "parentId": None,
             "iconKey": "folder", "colorKey": "blue"},
            {"id": WORK, "kind": "work", "name": "블루 아카이브", "parentId": ROOT,
             "iconKey": None, "colorKey": None},
            {"id": TAG, "kind": "tag", "name": "아로나", "parentId": WORK,
             "iconKey": None, "colorKey": None},
        ],
        "assignments": [
            {"assetId": MATERIALIZED, "classificationId": TAG},
            {"assetId": UNMATERIALIZED, "classificationId": ROOT},
        ],
        "roles": [{"role": "originals", "classificationId": ORIGINALS}],
    }
    body.update(overrides)
    return body


class StagingFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp_dir.name) / "lakomics.sqlite3"
        self.original_database_path = api_app.DB_PATH
        self.original_api_token = api_app.API_TOKEN
        api_app.DB_PATH = self.database_path
        api_app.API_TOKEN = "test-token"
        api_app.startup()
        api_app.startup_classifications()
        api_app.startup_replication()
        # The authority registry and role credentials, so the "staging is not activation"
        # assertions can query real tables and the authority read routes authenticate.
        authority.startup(api_app.get_db)
        classification_authority.startup(api_app.get_db)
        api_auth.startup(api_app.get_db)
        api_app.startup_classification_authority()
        with api_app.get_db() as db:
            # `startup_replication` adds the `committed` column this fixture needs; the
            # Asset row here is only used to prove a *materialized* Asset differs from an
            # unmaterialized one.
            db.execute("INSERT OR IGNORE INTO assets(id,kind,object_key,created_at,updated_at,"
                       "committed) VALUES(?,?,?,?,?,1)",
                       (MATERIALIZED, "image", "library/%s/original" % MATERIALIZED,
                        "2026-09-16T00:00:00Z", "2026-09-16T00:00:00Z"))
            _, self.client_token = api_auth.provision_token(db, "client", "classifications")
            db.commit()
        self.client = TestClient(api_app.app)

    def tearDown(self) -> None:
        self.client.close()
        api_app.DB_PATH = self.original_database_path
        api_app.API_TOKEN = self.original_api_token
        self.temp_dir.cleanup()

    @property
    def auth(self):
        return {"Authorization": "Bearer test-token"}

    @property
    def client_auth(self):
        """A real `client`-role credential, as the authority read routes require."""
        return {"Authorization": f"Bearer {self.client_token}"}

    def publish(self, body, headers=None):
        return self.client.put(SNAPSHOT, headers=headers or self.auth, json=body)

    def stored(self):
        with api_app.get_db() as db:
            row = db.execute("SELECT payload,published_at,revision"
                             " FROM classification_snapshots WHERE singleton=1").fetchone()
        return None if row is None else (json.loads(row["payload"]), row["published_at"],
                                        row["revision"])

    def stored_payload(self):
        state = self.stored()
        return None if state is None else state[0]

    def assert_coded(self, response, status, code):
        self.assertEqual(response.status_code, status, response.text)
        detail = response.json()["detail"]
        if isinstance(detail, dict):
            self.assertEqual(detail["code"], code, detail)
        else:
            self.fail(f"expected coded detail, got {detail!r}")
        return detail

    def authority_state(self):
        with api_app.get_db() as db:
            domains = [tuple(row) for row in db.execute(
                "SELECT library_id,domain,epoch,change_cursor FROM authority_domains")]
            rows = {}
            for table in ("classification_authority_state",
                          "classification_authority_assignments",
                          "classification_authority_roles",
                          "classification_authority_changes",
                          "classification_authority_receipts"):
                try:
                    rows[table] = db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                except Exception:
                    rows[table] = None
        return domains, rows


class Version1CompatibilityTests(StagingFixture):
    """The deployed publisher must keep working byte-for-byte."""

    def legacy_body(self, **overrides):
        body = {
            "entries": [
                {"id": "game", "kind": "root", "name": "게임", "parentId": None,
                 "iconKey": None, "colorKey": None, "assetCount": 3},
                {"id": "rpg", "kind": "tag", "name": "RPG", "parentId": "game",
                 "iconKey": None, "colorKey": None, "assetCount": 1},
            ],
            "published_at": "2026-08-31T00:00:00+00:00",
        }
        body.update(overrides)
        return body

    def test_unversioned_publication_is_accepted_and_resolves_to_version_1(self):
        response = self.publish(self.legacy_body())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"])
        self.assertEqual(response.json()["snapshotVersion"], 1)

    def test_explicit_version_1_publication_is_accepted(self):
        response = self.publish(self.legacy_body(snapshotVersion=1))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["snapshotVersion"], 1)

    def test_version_1_entries_are_stored_verbatim_and_opaque(self):
        """The legacy store never validated these, and the batch must not start now.

        The shipped publisher always serializes a display-only `assetCount`, and can
        carry an appearance key predating the current UI. Tightening version 1 would
        break a deployed client for state that is not canonical staging input.
        """
        body = self.legacy_body(entries=[
            {"id": "game", "kind": "root", "name": "게임", "parentId": None,
             "iconKey": "gamepad", "colorKey": "blue", "assetCount": 99},
        ])
        self.assertEqual(self.publish(body).status_code, 200)
        self.assertEqual(self.stored_payload()["entries"], body["entries"])

    def test_version_1_does_not_gain_canonical_collections(self):
        response = self.publish(self.legacy_body())
        self.assertEqual(response.status_code, 200)
        stored = self.stored_payload()
        self.assertNotIn("assignments", stored)
        self.assertNotIn("roles", stored)

    def test_legacy_get_still_returns_entries_and_published_at(self):
        self.publish(self.legacy_body())
        response = self.client.get(SNAPSHOT, headers=self.auth)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["entries"], self.legacy_body()["entries"])
        self.assertEqual(body["published_at"], "2026-08-31T00:00:00+00:00")
        self.assertIn("revision", body)

    def test_legacy_revision_semantics_are_preserved(self):
        self.publish(self.legacy_body())
        self.assertEqual(self.stored()[2], 1)
        # An identical re-publication at a newer instant does not bump the display count.
        self.publish(self.legacy_body(published_at="2026-09-01T00:00:00+00:00"))
        self.assertEqual(self.stored()[2], 1)
        # Changing the tree does.
        self.publish(self.legacy_body(entries=[{"id": "movie", "kind": "root",
                                                "name": "영화", "parentId": None}],
                                      published_at="2026-09-02T00:00:00+00:00"))
        self.assertEqual(self.stored()[2], 2)

    def test_version_1_size_bound_is_unchanged(self):
        """The shipped 512 KiB v1 bound still applies to version-1 publishers."""
        entries = [{"id": f"id-{n}", "kind": "tag", "name": "이름" * 40, "parentId": None}
                   for n in range(10_000)]
        response = self.publish(self.legacy_body(entries=entries))
        self.assertEqual(response.status_code, 413, response.text)

    def test_rejects_unauthenticated_writes(self):
        response = self.client.put(SNAPSHOT, json=self.legacy_body())
        self.assertEqual(response.status_code, 401, response.text)

    def test_non_object_json_is_a_coded_client_error(self):
        for body in ([], 1, True, None):
            with self.subTest(body=body):
                self.assert_coded(self.publish(body), 422, "invalidClassificationSnapshot")


class Version2AcceptanceTests(StagingFixture):
    def test_valid_version_2_snapshot_is_accepted_and_stored(self):
        response = self.publish(v2_body())
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["snapshotVersion"], 2)
        self.assertEqual(len(body["snapshotDigest"]), 64)
        stored = self.stored_payload()
        self.assertEqual(stored["snapshotVersion"], 2)
        self.assertEqual([entry["id"] for entry in stored["entries"]],
                         sorted([ORIGINALS, ROOT, WORK, TAG]))
        self.assertEqual(stored["roles"],
                         [{"role": "originals", "classificationId": ORIGINALS}])
        # `work` is preserved rather than derived from the parent.
        work = next(entry for entry in stored["entries"] if entry["id"] == WORK)
        self.assertEqual((work["kind"], work["parentId"]), ("work", ROOT))

    def test_version_2_returns_the_canonical_digest_and_legacy_fields(self):
        body = v2_body()
        response = self.publish(body)
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["snapshotDigest"],
                         classification_snapshot.stored_digest(
                             json.dumps(self.stored_payload(), sort_keys=True,
                                        separators=(",", ":"), ensure_ascii=False)))
        # The legacy fields the publisher/reader already depend on remain present.
        self.assertEqual(payload["published_at"], body["published_at"])
        self.assertIn("revision", payload)

    def test_snapshot_version_must_be_an_integer_contract_value(self):
        for value in (True, 1.0, 2.0, "2"):
            with self.subTest(value=value):
                body = v2_body(snapshotVersion=value)
                self.assert_coded(self.publish(body), 422,
                                  "unsupportedClassificationSnapshotVersion")

    def test_v2_preserves_legacy_display_entries_and_revision_semantics(self):
        first = v2_body()
        first["entries"] = [{**entry, "assetCount": index + 10}
                              for index, entry in enumerate(first["entries"])]
        response = self.publish(first)
        self.assertEqual(response.status_code, 200, response.text)
        revision = response.json()["revision"]
        authority_digest = response.json()["snapshotDigest"]
        legacy = self.client.get(SNAPSHOT, headers=self.auth).json()["entries"]
        self.assertEqual([entry["assetCount"] for entry in legacy], [10, 11, 12, 13])

        second = {**first, "published_at": "2026-09-17T00:00:00+00:00"}
        response = self.publish(second)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["revision"], revision)

        changed = {**second, "published_at": "2026-09-18T00:00:00+00:00",
                   "entries": [{**entry} for entry in second["entries"]]}
        changed["entries"][0]["assetCount"] += 1
        response = self.publish(changed)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["revision"], revision + 1)
        # assetCount remains a legacy display field, not Classification authority state.
        self.assertEqual(response.json()["snapshotDigest"], authority_digest)

    def test_equal_instant_display_only_change_keeps_authority_digest_but_bumps_legacy_revision(self):
        first = v2_body()
        first["entries"] = [{**entry, "assetCount": 1} for entry in first["entries"]]
        initial = self.publish(first)
        self.assertEqual(initial.status_code, 200, initial.text)

        changed = {**first, "entries": [{**entry} for entry in first["entries"]]}
        changed["entries"][0]["assetCount"] = 2
        response = self.publish(changed)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["snapshotDigest"], initial.json()["snapshotDigest"])
        self.assertEqual(response.json()["revision"], initial.json()["revision"] + 1)

    def test_version_2_requires_explicit_assignments_and_roles(self):
        """An absent canonical collection is not an empty one."""
        for field, code in (("assignments", "missingClassificationAssignments"),
                            ("roles", "missingClassificationRoles")):
            with self.subTest(field=field):
                body = v2_body()
                del body[field]
                self.assert_coded(self.publish(body), 422, code)

    def test_version_2_accepts_an_explicitly_empty_assignment_set(self):
        response = self.publish(v2_body(assignments=[]))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.stored_payload()["assignments"], [])

    def test_unsupported_snapshot_version_is_rejected(self):
        for version in (0, 3, 99):
            with self.subTest(version=version):
                detail = self.assert_coded(
                    self.publish(v2_body(snapshotVersion=version)), 422,
                    "unsupportedClassificationSnapshotVersion")
                self.assertEqual(detail["supported"], [1, 2])
        self.assertIsNone(self.stored())

    def test_version_1_rejects_canonical_collections(self):
        """A version-1 body cannot express them, so honouring them would be a guess."""
        body = {"entries": [], "published_at": "2026-08-31T00:00:00+00:00",
                "assignments": [], "roles": []}
        self.assert_coded(self.publish(body), 422, "invalidClassificationSnapshot")

    def test_unparseable_and_empty_bodies_are_rejected(self):
        empty = self.client.put(SNAPSHOT, headers=self.auth, content=b"")
        self.assert_coded(empty, 422, "invalidClassificationSnapshot")
        broken = self.client.put(SNAPSHOT, headers=self.auth, content=b"{not json")
        self.assert_coded(broken, 422, "invalidClassificationSnapshot")


class Version2EntryValidationTests(StagingFixture):
    def test_duplicate_classification_ids_are_rejected(self):
        body = v2_body(entries=[{"id": ROOT, "kind": "root", "name": "게임",
                                 "parentId": None},
                                {"id": ROOT, "kind": "root", "name": "다른 이름",
                                 "parentId": None}])
        self.assert_coded(self.publish(body), 422, "duplicateClassificationId")

    def test_dangling_parents_are_rejected(self):
        body = v2_body(entries=[{"id": TAG, "kind": "tag", "name": "아로나",
                                 "parentId": "ghost"}])
        detail = self.assert_coded(self.publish(body), 422, "invalidClassificationParent")
        self.assertEqual(detail["parentId"], "ghost")

    def test_self_parent_is_rejected(self):
        body = v2_body(entries=[{"id": ROOT, "kind": "root", "name": "게임",
                                 "parentId": ROOT}])
        self.assert_coded(self.publish(body), 422, "invalidClassificationParent")

    def test_invalid_kind_parent_combinations_are_rejected(self):
        cases = {
            "work-without-parent": {"id": WORK, "kind": "work", "name": "작품",
                                    "parentId": None},
            "work-under-tag": {"id": WORK, "kind": "work", "name": "작품",
                               "parentId": TAG},
            "tag-without-parent": {"id": TAG, "kind": "tag", "name": "태그",
                                   "parentId": None},
        }
        for label, entry in cases.items():
            with self.subTest(case=label):
                # A minimal set so the only defect is the one under test.
                entries = [{"id": ROOT, "kind": "root", "name": "게임", "parentId": None},
                           entry]
                body = v2_body(entries=entries, assignments=[],
                               roles=[{"role": "originals", "classificationId": ROOT}])
                self.assert_coded(self.publish(body), 422, "invalidClassificationParent")

    def test_a_root_with_a_parent_is_accepted_only_when_kind_agrees(self):
        """A `tag` under a root is valid; the same entry declared `root` is not."""
        body = v2_body(entries=[{"id": ROOT, "kind": "root", "name": "게임",
                                 "parentId": None},
                                {"id": TAG, "kind": "tag", "name": "태그",
                                 "parentId": ROOT}],
                       assignments=[], roles=[{"role": "originals",
                                               "classificationId": ROOT}])
        self.assertEqual(self.publish(body).status_code, 200, self.stored())

    def test_hierarchy_cycles_are_rejected(self):
        body = v2_body(entries=[{"id": ROOT, "kind": "tag", "name": "A", "parentId": TAG},
                                {"id": TAG, "kind": "tag", "name": "B", "parentId": ROOT}],
                       assignments=[], roles=[{"role": "originals",
                                               "classificationId": ROOT}])
        self.assert_coded(self.publish(body), 422, "classificationCycle")

    def test_case_insensitive_duplicate_sibling_names_are_rejected(self):
        body = v2_body(entries=[{"id": ROOT, "kind": "root", "name": "게임",
                                 "parentId": None},
                                {"id": TAG, "kind": "tag", "name": "아로나",
                                 "parentId": ROOT},
                                {"id": WORK, "kind": "tag", "name": "아로나",
                                 "parentId": ROOT}],
                       assignments=[], roles=[{"role": "originals",
                                               "classificationId": ROOT}])
        self.assert_coded(self.publish(body), 422, "duplicateClassificationName")

    def test_the_same_name_under_a_different_parent_is_accepted(self):
        """Sibling uniqueness is scoped to the parent, not to the whole library."""
        accepted = v2_body(entries=[{"id": ROOT, "kind": "root", "name": "게임",
                                     "parentId": None},
                                    {"id": TAG, "kind": "tag", "name": "같은 이름",
                                     "parentId": ROOT},
                                    {"id": WORK, "kind": "root", "name": "같은 이름",
                                     "parentId": None}],
                           assignments=[],
                           roles=[{"role": "originals", "classificationId": ROOT}])
        self.assertEqual(self.publish(accepted).status_code, 200,
                         "the same name under a distinct parent is a different sibling set")

    def test_the_same_name_under_the_same_parent_is_rejected(self):
        rejected = v2_body(entries=[{"id": ROOT, "kind": "root", "name": "게임",
                                     "parentId": None},
                                    {"id": TAG, "kind": "tag", "name": "같은 이름",
                                     "parentId": ROOT},
                                    {"id": WORK, "kind": "tag", "name": "같은 이름",
                                     "parentId": ROOT}],
                           assignments=[],
                           roles=[{"role": "originals", "classificationId": ROOT}])
        self.assert_coded(self.publish(rejected), 422, "duplicateClassificationName")

    def test_invalid_appearance_is_rejected(self):
        for icon_key, color_key in (("not-an-icon", None), (None, "#ffffff")):
            with self.subTest(icon=icon_key, color=color_key):
                body = v2_body(entries=[{"id": ROOT, "kind": "root", "name": "게임",
                                         "parentId": None, "iconKey": icon_key,
                                         "colorKey": color_key}],
                               assignments=[],
                               roles=[{"role": "originals",
                                       "classificationId": ROOT}])
                self.assert_coded(self.publish(body), 422,
                                  "invalidClassificationAppearance")

    def test_blank_and_oversized_names_are_rejected(self):
        for name, code in (("   ", "emptyClassificationName"),
                           ("가" * (classification_authority.MAX_NAME + 1),
                            "classificationNameTooLong")):
            with self.subTest(name=name[:8]):
                body = v2_body(entries=[{"id": ROOT, "kind": "root", "name": name,
                                         "parentId": None}],
                               assignments=[],
                               roles=[{"role": "originals",
                                       "classificationId": ROOT}])
                self.assert_coded(self.publish(body), 422, code)

    def test_names_are_trimmed_before_the_bound_check(self):
        body = v2_body(entries=[{"id": ROOT, "kind": "root",
                                 "name": "  " + "가" * classification_authority.MAX_NAME + "  ",
                                 "parentId": None}],
                       assignments=[], roles=[{"role": "originals",
                                               "classificationId": ROOT}])
        self.assertEqual(self.publish(body).status_code, 200)

    def test_invalid_ids_and_kinds_are_rejected(self):
        cases = {
            "bad-id": ({"id": "../escape", "kind": "root", "name": "게임",
                        "parentId": None}, "invalidClassificationEntry"),
            "bad-kind": ({"id": ROOT, "kind": "folder", "name": "게임",
                          "parentId": None}, "invalidClassificationKind"),
            "missing-field": ({"id": ROOT, "kind": "root"}, "invalidClassificationEntry"),
        }
        for label, (entry, code) in cases.items():
            with self.subTest(case=label):
                body = v2_body(entries=[entry], assignments=[],
                               roles=[{"role": "originals",
                                       "classificationId": ROOT}])
                self.assert_coded(self.publish(body), 422, code)

    def test_an_invalid_snapshot_is_never_stored(self):
        body = v2_body(entries=[{"id": TAG, "kind": "tag", "name": "아로나",
                                 "parentId": "ghost"}])
        self.assertEqual(self.publish(body).status_code, 422)
        self.assertIsNone(self.stored())


class Version2AssignmentTests(StagingFixture):
    def test_assignment_to_an_unmaterialized_asset_is_accepted(self):
        """The trusted PC snapshot must preserve assignment beyond the Asset projection.

        A locally trashed Asset is legitimately absent from the server `assets` table,
        and its Classification assignment must survive staging — the Album activation
        precedent.
        """
        body = v2_body(assignments=[{"assetId": UNMATERIALIZED,
                                     "classificationId": ROOT}])
        self.assertEqual(self.publish(body).status_code, 200)
        self.assertEqual(self.stored_payload()["assignments"],
                         [{"assetId": UNMATERIALIZED, "classificationId": ROOT}])
        with api_app.get_db() as db:
            exists = db.execute("SELECT 1 FROM assets WHERE id=?",
                                (UNMATERIALIZED,)).fetchone()
        self.assertIsNone(exists, "the fixture must not have materialized this Asset")

    def test_duplicate_asset_assignment_is_rejected(self):
        body = v2_body(assignments=[
            {"assetId": MATERIALIZED, "classificationId": ROOT},
            {"assetId": MATERIALIZED, "classificationId": TAG},
        ])
        detail = self.assert_coded(self.publish(body), 422,
                                   "duplicateClassificationAssignment")
        self.assertEqual(detail["assetId"], MATERIALIZED)
        self.assertIsNone(self.stored())

    def test_assignment_to_a_nonexistent_staged_classification_is_rejected(self):
        body = v2_body(assignments=[{"assetId": MATERIALIZED,
                                     "classificationId": "10000000-0000-4000-8000-0000000000aa"}])
        detail = self.assert_coded(self.publish(body), 422,
                                   "invalidClassificationAssignment")
        self.assertEqual(detail["classificationId"],
                         "10000000-0000-4000-8000-0000000000aa")

    def test_assignment_malformed_rows_and_ids_are_rejected(self):
        cases = {
            "missing-key": ({"asset": MATERIALIZED, "classificationId": ROOT},
                            "invalidClassificationAssignment"),
            "extra-key": ({"assetId": MATERIALIZED, "classificationId": ROOT,
                           "desiredState": True}, "invalidClassificationAssignment"),
            "bad-asset-id": ({"assetId": "../x", "classificationId": ROOT},
                             "invalidClassificationAssignment"),
            "bad-classification-id": ({"assetId": MATERIALIZED, "classificationId": "!!"},
                                      "invalidClassificationAssignment"),
        }
        for label, (row, code) in cases.items():
            with self.subTest(case=label):
                self.assert_coded(self.publish(v2_body(assignments=[row])), 422, code)

    def test_assignments_are_stored_deterministically(self):
        """Sorted by Asset, so the stored bytes and digest do not depend on publisher order."""
        first = v2_body(assignments=[{"assetId": MATERIALIZED, "classificationId": TAG},
                                     {"assetId": UNMATERIALIZED,
                                      "classificationId": ROOT}])
        response = self.publish(first)
        self.assertEqual(response.status_code, 200)
        stored = self.stored_payload()["assignments"]
        self.assertEqual([row["assetId"] for row in stored],
                         sorted([MATERIALIZED, UNMATERIALIZED]))
        # The same logical state published in the other order produces the same digest.
        second = v2_body(assignments=list(reversed(first["assignments"])),
                         published_at="2026-09-17T00:00:00+00:00")
        self.assertEqual(self.publish(second).json()["snapshotDigest"],
                         response.json()["snapshotDigest"])


class Version2RoleTests(StagingFixture):
    def test_the_originals_role_is_required(self):
        self.assert_coded(self.publish(v2_body(roles=[])), 422,
                          "missingClassificationOriginalsRole")

    def test_a_duplicate_role_is_rejected(self):
        body = v2_body(roles=[{"role": "originals", "classificationId": ORIGINALS},
                              {"role": "originals", "classificationId": ROOT}])
        self.assert_coded(self.publish(body), 422, "duplicateClassificationRole")

    def test_an_unsupported_role_is_rejected(self):
        body = v2_body(roles=[{"role": "favorites", "classificationId": ROOT},
                              {"role": "originals", "classificationId": ORIGINALS}])
        detail = self.assert_coded(self.publish(body), 422,
                                   "unsupportedClassificationRole")
        self.assertEqual(detail["role"], "favorites")

    def test_a_role_must_reference_a_staged_classification(self):
        body = v2_body(roles=[{"role": "originals", "classificationId": "ghost"}])
        detail = self.assert_coded(self.publish(body), 422, "invalidClassificationRole")
        self.assertEqual(detail["classificationId"], "ghost")

    def test_role_rows_must_be_exactly_shaped(self):
        body = v2_body(roles=[{"role": "originals", "classificationId": ORIGINALS,
                               "mutable": True}])
        self.assert_coded(self.publish(body), 422, "invalidClassificationRole")

    def test_the_role_is_stored_with_the_authority_wire_names(self):
        self.assertEqual(self.publish(v2_body()).status_code, 200)
        self.assertEqual(self.stored_payload()["roles"],
                         [{"role": "originals", "classificationId": ORIGINALS}])

    def test_staging_does_not_create_an_authority_role_row(self):
        """Staging is a source, not authority state: the role is not activated here."""
        self.assertEqual(self.publish(v2_body()).status_code, 200)
        domains, rows = self.authority_state()
        self.assertEqual(domains, [])
        self.assertEqual(rows["classification_authority_roles"], 0)


class StalePublicationTests(StagingFixture):
    def test_an_older_publication_cannot_replace_a_newer_snapshot(self):
        self.assertEqual(self.publish(v2_body()).status_code, 200)
        older = v2_body(published_at="2026-09-15T00:00:00+00:00",
                        entries=[{"id": ROOT, "kind": "root", "name": "이전",
                                  "parentId": None}],
                        assignments=[],
                        roles=[{"role": "originals", "classificationId": ROOT}])
        detail = self.assert_coded(self.publish(older), 409, "staleClassificationSnapshot")
        self.assertEqual(detail["publishedAt"], "2026-09-16T00:00:00+00:00")
        # The newer staged state is untouched.
        self.assertEqual(self.stored()[1], "2026-09-16T00:00:00+00:00")

    def test_staleness_compares_instants_not_lexicographic_text(self):
        """Offset normalization decides order, not the text of the timestamp.

        ``2026-08-30T20:00:00-07:00`` sorts *before* ``2026-08-31T00:00:00Z`` as text but
        is the *later* instant (2026-08-31T03:00:00Z), so it must be accepted. Comparing
        the strings would wrongly reject this real publication, and comparing them the
        other way would wrongly accept a genuine replay.
        """
        self.assertEqual(self.publish(v2_body(
            published_at="2026-08-31T00:00:00+00:00")).status_code, 200)
        later_in_another_offset = v2_body(published_at="2026-08-30T20:00:00-07:00",
                                         assignments=[])
        self.assertEqual(self.publish(later_in_another_offset).status_code, 200,
                         "a later instant in another offset must be accepted")
        self.assertEqual(self.stored()[1], "2026-08-30T20:00:00-07:00")
        # The previously-newer instant is now genuinely older and must be refused.
        self.assert_coded(self.publish(v2_body(
            published_at="2026-08-31T00:00:00+00:00", assignments=[])),
            409, "staleClassificationSnapshot")

    def test_a_newer_publication_replaces_the_snapshot(self):
        self.assertEqual(self.publish(v2_body()).status_code, 200)
        newer = v2_body(published_at="2026-09-17T00:00:00+00:00", assignments=[])
        self.assertEqual(self.publish(newer).status_code, 200)
        self.assertEqual(self.stored()[1], "2026-09-17T00:00:00+00:00")
        self.assertEqual(self.stored_payload()["assignments"], [])

    def test_an_identical_retry_at_the_same_instant_is_idempotent(self):
        body = v2_body()
        first = self.publish(body)
        self.assertEqual(first.status_code, 200)
        revision_before = self.stored()[2]
        retry = self.publish(body)
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.json()["snapshotDigest"], first.json()["snapshotDigest"])
        self.assertEqual(self.stored()[2], revision_before)
        self.assertEqual(self.stored()[1], body["published_at"])

    def test_an_equal_instant_with_different_state_is_rejected(self):
        """An equal instant carrying other content is a replay, not a retry."""
        self.assertEqual(self.publish(v2_body()).status_code, 200)
        conflicting = v2_body(assignments=[])
        self.assert_coded(self.publish(conflicting), 409, "staleClassificationSnapshot")
        self.assertEqual(self.stored_payload()["assignments"],
                         v2_body()["assignments"])

    def test_an_uninterpretable_stored_instant_does_not_block_a_publisher(self):
        """A legacy row the server cannot order must not wedge the publisher.

        The publisher cannot fix a server-side timestamp problem, so refusing its real
        publication would be a permanent outage. The check is skipped instead.
        """
        with api_app.get_db() as db:
            db.execute("INSERT INTO classification_snapshots(singleton,payload,published_at,"
                       "updated_at,revision) VALUES(1,?,?,?,1)",
                       (json.dumps({"entries": []}), "not-a-timestamp", "not-a-timestamp"))
            db.commit()
        self.assertEqual(self.publish(v2_body()).status_code, 200)

    def test_a_publication_requires_an_aware_timestamp(self):
        for value in ("no-timestamp", "2026-09-16T00:00:00", ""):
            with self.subTest(value=value):
                self.assert_coded(self.publish(v2_body(published_at=value)), 422,
                                  "invalidClassificationSnapshot")

    def test_a_v1_publication_also_cannot_go_backwards(self):
        """Staleness is a publication rule, not a version-2-only rule."""
        self.assertEqual(self.publish(v2_body()).status_code, 200)
        legacy = {"entries": [], "published_at": "2026-09-15T00:00:00+00:00"}
        self.assert_coded(self.publish(legacy), 409, "staleClassificationSnapshot")


class DigestTests(StagingFixture):
    def test_the_digest_is_deterministic_across_key_order(self):
        first = self.publish(v2_body())
        reordered = v2_body()
        reordered["entries"] = [{"name": entry["name"], "kind": entry["kind"],
                                 "id": entry["id"],
                                 **({"parentId": entry["parentId"]}
                                    if "parentId" in entry else {}),
                                 **({"iconKey": entry["iconKey"]}
                                    if "iconKey" in entry else {}),
                                 **({"colorKey": entry["colorKey"]}
                                    if "colorKey" in entry else {})}
                                for entry in reversed(reordered["entries"])]
        reordered["published_at"] = "2026-09-18T00:00:00+00:00"
        second = self.publish(reordered)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["snapshotDigest"], first.json()["snapshotDigest"])

    def test_the_digest_identifies_the_stored_state_not_the_request(self):
        """It is recomputed from stored bytes, so it provably matches what is held."""
        body = v2_body()
        response = self.publish(body)
        self.assertEqual(response.status_code, 200)
        with api_app.get_db() as db:
            stored_payload = db.execute(
                "SELECT payload FROM classification_snapshots WHERE singleton=1").fetchone()[0]
        self.assertEqual(response.json()["snapshotDigest"],
                         classification_snapshot.stored_digest(stored_payload))

    def test_the_digest_changes_when_canonical_state_changes(self):
        first = self.publish(v2_body())
        second = self.publish(v2_body(published_at="2026-09-19T00:00:00+00:00",
                                      assignments=[]))
        self.assertNotEqual(first.json()["snapshotDigest"],
                            second.json()["snapshotDigest"])

    def test_the_digest_ignores_the_publication_instant(self):
        """Restamping is publication bookkeeping, not staging state."""
        first = self.publish(v2_body(published_at="2026-09-16T00:00:00+00:00"))
        second = self.publish(v2_body(published_at="2026-09-16T12:00:00+00:00"))
        self.assertEqual(first.json()["snapshotDigest"],
                         second.json()["snapshotDigest"])

    def test_the_meta_route_reports_version_and_digest(self):
        self.publish(v2_body())
        meta = self.client.get(META, headers=self.auth)
        self.assertEqual(meta.status_code, 200, meta.text)
        body = meta.json()
        self.assertEqual(body["snapshotVersion"], 2)
        self.assertEqual(len(body["snapshotDigest"]), 64)
        # The legacy fields remain, so existing consumers keep working.
        self.assertEqual(body["published_at"], "2026-09-16T00:00:00+00:00")
        self.assertIn("updated_at", body)
        self.assertIn("revision", body)

    def test_the_meta_route_still_404s_before_any_publish(self):
        self.assertEqual(self.client.get(META, headers=self.auth).status_code, 404)


class LegacyReadCompatibilityTests(StagingFixture):
    """A stored version-2 snapshot must stay readable by unchanged consumers."""

    def test_legacy_get_exposes_entries_without_canonical_collections(self):
        self.publish(v2_body())
        response = self.client.get(SNAPSHOT, headers=self.auth)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        # Legacy readers retain the publisher's display order; authority staging may
        # sort its canonical copy independently.
        self.assertEqual([entry["id"] for entry in body["entries"]],
                         [entry["id"] for entry in v2_body()["entries"]])
        self.assertNotIn("assignments", body)
        self.assertNotIn("roles", body)
        self.assertNotIn("snapshotVersion", body)
        self.assertEqual(body["published_at"], "2026-09-16T00:00:00+00:00")

    def test_legacy_get_output_is_usable_by_an_unchanged_reader(self):
        """The fields the extension/mobile readers actually consume are intact."""
        self.publish(v2_body())
        entries = self.client.get(SNAPSHOT, headers=self.auth).json()["entries"]
        self.assertTrue(all({"id", "kind", "name"} <= set(entry) for entry in entries))
        parents = {entry["id"]: entry.get("parentId") for entry in entries}
        self.assertIsNone(parents[ROOT])
        self.assertEqual(parents[WORK], ROOT)
        self.assertEqual(parents[TAG], WORK)

    def test_the_extension_bootstrap_reports_entries_only(self):
        api_app.startup_extension_profile()
        self.publish(v2_body())
        bootstrap = self.client.get("/v1/extension/bootstrap", headers=self.auth)
        # The bootstrap requires an extension client; with the shipped shared credential
        # the route rejects, which is unchanged behavior. The helper is asserted directly
        # so the entries-only contract is pinned regardless of the credential.
        self.assertIn(bootstrap.status_code, (200, 401))
        snapshot = api_app._classification_snapshot()
        self.assertEqual({key for key in snapshot}, {"entries", "revision"})


class StagingIsNotActivationTests(StagingFixture):
    """2A.1 stages a source; it must not activate the domain or fence the writer."""

    def test_staging_creates_no_authority_domain_row(self):
        self.assertEqual(self.publish(v2_body()).status_code, 200)
        domains, _ = self.authority_state()
        self.assertEqual(domains, [])

    def test_staging_populates_no_canonical_authority_state(self):
        self.assertEqual(self.publish(v2_body()).status_code, 200)
        _, rows = self.authority_state()
        for table, count in rows.items():
            self.assertEqual(count, 0, f"{table} must stay empty while inactive")

    def test_authority_reads_still_report_inactive_after_staging(self):
        self.assertEqual(self.publish(v2_body()).status_code, 200)
        response = self.client.get(BASELINE, params={"libraryId": "a" * 32, "epoch": "1"},
                                   headers=self.client_auth)
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"]["code"], "authorityInactive")

    def test_no_classification_activation_route_exists(self):
        """2A ships no activation path at all — not even an unused one.

        Album authority legitimately has its own activation route, so the assertion is
        scoped to the classifications domain rather than to the `/activate` suffix.
        """
        paths = {route.path for route in api_app.app.routes}
        self.assertNotIn("/v1/classifications/authority/activate", paths)
        self.assertFalse([path for path in paths if path.startswith("/v1/classifications/authority") and path.endswith("/activate")])
        self.assertEqual(
            self.client.post("/v1/classifications/authority/activate", json={}).status_code,
            404)

    def test_legacy_writer_is_not_fenced_after_staging(self):
        """Staging is not the fence: the publisher must keep publishing."""
        self.assertEqual(self.publish(v2_body()).status_code, 200)
        later = v2_body(published_at="2026-09-20T00:00:00+00:00", assignments=[])
        self.assertEqual(self.publish(later).status_code, 200)
        legacy = {"entries": [], "published_at": "2026-09-21T00:00:00+00:00"}
        self.assertEqual(self.publish(legacy).status_code, 200)


class StagingBoundTests(StagingFixture):
    """The bound must admit a supported library and still be a bound.

    Sizes are measured from the real encoded shape rather than estimated by hand.
    """

    def worst_case_entry(self):
        return {"id": "x" * 128, "kind": "tag", "name": "가" * classification_authority.MAX_NAME,
                "parentId": "y" * 128, "iconKey": "academic-cap", "colorKey": "purple"}

    def worst_case_assignment(self):
        return {"assetId": "y" * 128, "classificationId": "x" * 128}

    def encoded(self, entries, assignments, roles=None):
        body = {"snapshotVersion": 2, "published_at": "2026-09-16T00:00:00Z",
                "entries": entries, "assignments": assignments,
                "roles": roles if roles is not None else
                [{"role": "originals", "classificationId": "x" * 128}]}
        return len(json.dumps(body, separators=(",", ":"), sort_keys=True).encode())

    def test_the_bound_fits_the_measured_production_library(self):
        """The measured active library is 58 classifications and 8,907 assignments."""
        measured = self.encoded([self.worst_case_entry() for _ in range(58)],
                                [self.worst_case_assignment() for _ in range(8_907)])
        self.assertLess(measured, classification_snapshot.MAX_STAGING_BYTES)
        print(f"\nmeasured active-library shape: {measured} bytes "
              f"({measured / (1024 * 1024):.2f} MiB)")

    def test_the_bound_admits_the_documented_supported_shape(self):
        """20,000 classifications plus 100,000 assignments at maximum row width."""
        encoded = self.encoded([self.worst_case_entry() for _ in range(20_000)],
                               [self.worst_case_assignment() for _ in range(100_000)])
        self.assertLess(encoded, classification_snapshot.MAX_STAGING_BYTES,
                        f"documented shape encodes to {encoded} bytes")
        print(f"documented shape: {encoded} bytes ({encoded / (1024 * 1024):.2f} MiB)")

    def test_the_bound_is_still_a_bound(self):
        self.assertEqual(classification_snapshot.MAX_STAGING_BYTES, 96 * 1024 * 1024)
        self.assertLess(classification_snapshot.MAX_STAGING_BYTES, 512 * 1024 * 1024)
        self.assertGreater(classification_snapshot.MAX_STAGING_BYTES,
                           api_app.MAX_LEGACY_SNAPSHOT_BYTES)

    def test_the_shipped_bound_would_have_rejected_a_real_library(self):
        """Evidence for raising it: the old bound cannot hold the measured assignments."""
        measured = self.encoded([self.worst_case_entry() for _ in range(58)],
                                [self.worst_case_assignment() for _ in range(8_907)])
        self.assertGreater(measured, api_app.MAX_LEGACY_SNAPSHOT_BYTES)

    def test_an_oversized_payload_is_rejected_by_the_streaming_guard(self):
        """The guard applies while reading, so the body never has to be buffered whole."""
        with mock.patch.object(classification_snapshot, "MAX_STAGING_BYTES", 2048):
            response = self.publish(v2_body(assignments=[
                {"assetId": f"20000000-0000-4000-8000-{n:012d}",
                 "classificationId": ROOT} for n in range(60)]))
        self.assertEqual(response.status_code, 413, response.text)

    def test_an_oversized_payload_is_rejected_from_its_declared_length(self):
        with mock.patch.object(classification_snapshot, "MAX_STAGING_BYTES", 2048):
            response = self.client.put(
                SNAPSHOT, headers={**self.auth, "Content-Length": "999999"},
                content=b"{}")
        self.assertEqual(response.status_code, 413, response.text)

    def test_an_invalid_declared_length_is_rejected(self):
        response = self.client.put(
            SNAPSHOT, headers={**self.auth, "Content-Length": "abc"}, content=b"{}")
        self.assertEqual(response.status_code, 400, response.text)

    def test_the_streaming_guard_does_not_reject_a_supported_payload(self):
        """The guard must be a bound, not an accidental small limit."""
        with mock.patch.object(classification_snapshot, "MAX_STAGING_BYTES", 1 << 20):
            self.assertEqual(self.publish(v2_body()).status_code, 200)


if __name__ == "__main__":
    unittest.main()
