"""The shipped Album snapshot route and Pydantic model, exercised as production runs it.

`test_album_authority` builds its own minimal dict route so the authority fences can be
tested in isolation. That cannot catch a model-level wire mismatch, which is exactly what
happened once: the Rust publisher sends `snapshotVersion`, while the production model
declared `snapshot_version` under `extra="forbid"`, so the documented field was rejected
as unknown. These tests therefore drive the real `app.AlbumReplicaPublish` model and the
real `PUT /v1/library/album-snapshot` route.
"""
import sqlite3
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.test_capture_api_stub import fake_s3  # noqa: E402

import app as api_app  # noqa: E402
import album_authority  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic import ValidationError  # noqa: E402

SNAPSHOT = "/v1/library/album-snapshot"
LIBRARY = "a" * 32
ASSET = "20000000-0000-4000-8000-000000000001"


def body(version=3):
    """A publisher body using the exact wire keys the Rust client sends."""
    document = {
        "published_at": "2026-09-15T00:00:00Z",
        "albums": [{"id": "root", "name": "업로드용", "parent_id": None,
                    "icon_key": "folder", "color_key": "blue"}],
        "media": [],
    }
    if version is not None:
        document["snapshotVersion"] = version
    if version is not None and version >= album_authority.SNAPSHOT_VERSION:
        document["memberships"] = [{"albumId": "root", "assetId": ASSET}]
    return document


class AlbumSnapshotModelTests(unittest.TestCase):
    """The accepted wire keys must match what the publisher sends."""

    def test_camel_case_snapshot_version_is_accepted(self):
        model = api_app.AlbumReplicaPublish.model_validate(body(3))
        self.assertEqual(model.resolved_version(), 3)

    def test_an_omitted_version_is_the_legacy_display_snapshot(self):
        model = api_app.AlbumReplicaPublish.model_validate(body(None))
        self.assertEqual(model.resolved_version(), 1)
        self.assertIsNone(model.memberships)

    def test_unknown_extra_fields_are_still_rejected(self):
        """The alias fix must not make the model permissive."""
        document = body(3)
        document["unexpected"] = 1
        with self.assertRaises(ValidationError):
            api_app.AlbumReplicaPublish.model_validate(document)

    def test_the_python_field_name_remains_usable_internally(self):
        document = body(3)
        del document["snapshotVersion"]
        document["snapshot_version"] = 3
        self.assertEqual(api_app.AlbumReplicaPublish.model_validate(document).resolved_version(), 3)

    def test_canonical_membership_requires_its_camel_case_keys(self):
        document = body(3)
        document["memberships"] = [{"album_id": "root", "asset_id": ASSET}]
        with self.assertRaises(ValidationError):
            api_app.AlbumReplicaPublish.model_validate(document)


class AlbumSnapshotRouteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database_path = Path(self.temp.name) / "lakomics.sqlite3"
        self.original_database_path = api_app.DB_PATH
        self.original_api_token = api_app.API_TOKEN
        api_app.DB_PATH = self.database_path
        api_app.API_TOKEN = "album-wire-token"
        api_app.startup()
        api_app.startup_replication()
        api_app.startup_captures()
        api_app.startup_classifications()
        api_app.startup_album_replica()
        api_app.startup_album_authority()
        fake_s3.objects.clear()
        self.client = TestClient(api_app.app)
        # Activation requires canonical membership to reference a committed server
        # Asset, so the fixture commits one through the real `assets` schema.
        with api_app.get_db() as db:
            db.execute(
                "INSERT OR REPLACE INTO assets(id,kind,object_key,committed,created_at,updated_at)"
                " VALUES(?,'image',?,'1','2026-09-15T00:00:00Z','2026-09-15T00:00:00Z')",
                (ASSET, f"images/{ASSET}/original"))
            db.commit()

    def tearDown(self):
        self.client.close()
        fake_s3.objects.clear()
        api_app.DB_PATH = self.original_database_path
        api_app.API_TOKEN = self.original_api_token
        self.temp.cleanup()

    @property
    def auth(self):
        return {"Authorization": "Bearer album-wire-token"}

    def publish(self, document):
        return self.client.put(SNAPSHOT, headers=self.auth, json=document)

    def test_an_omitted_version_publishes_a_legacy_display_snapshot(self):
        response = self.publish(body(None))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["snapshotVersion"], 1)

    def test_the_current_camel_case_version_publishes_and_reports_its_digest(self):
        response = self.publish(body(3))
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["snapshotVersion"], 3)
        self.assertRegex(payload["snapshotDigest"], r"^[0-9a-f]{64}$")
        with api_app.get_db() as db:
            self.assertEqual(payload["snapshotDigest"],
                             album_authority.stored_snapshot_digest(db))

    def test_an_unsupported_version_returns_the_coded_error(self):
        response = self.publish(body(99))
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"]["code"], "unsupportedAlbumSnapshotVersion")
        self.assertEqual(response.json()["detail"]["supported"], [1, 2, 3])

    def test_an_unknown_extra_field_is_rejected_by_the_route(self):
        document = body(3)
        document["unexpected"] = 1
        self.assertEqual(self.publish(document).status_code, 422)

    def test_version_3_without_canonical_membership_returns_the_coded_error(self):
        document = body(3)
        del document["memberships"]
        response = self.publish(document)
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"]["code"], "missingAlbumMemberships")

    def test_legacy_display_read_still_hides_trashed_assets(self):
        """Canonical membership is richer, so the display route must not change."""
        document = body(3)
        # The display array deliberately omits the Asset while canonical membership
        # includes it, which is the trash case this contract exists to express.
        response = self.publish(document)
        self.assertEqual(response.status_code, 200, response.text)
        display = self.client.get("/v1/library/album-media",
                                  params={"album_id": "root"}, headers=self.auth)
        # The Asset has no committed object in this fixture, so the display replica
        # reports no media for it; what matters is that it does not appear merely
        # because canonical membership mentions it.
        self.assertEqual(display.status_code, 200, display.text)
        self.assertEqual(display.json()["media"], [])

    def test_the_staging_route_accepts_a_snapshot_at_the_documented_bound(self):
        """The upload bound must not reject a library the contract supports."""
        albums = [{"id": f"album-{index}", "name": f"A{index}", "parent_id": None,
                   "icon_key": None, "color_key": None} for index in range(500)]
        memberships = [{"albumId": f"album-{index}", "assetId": ASSET}
                       for index in range(500)]
        document = {"snapshotVersion": 3, "published_at": "2026-09-15T00:00:00Z",
                    "albums": albums, "media": [], "memberships": memberships}
        response = self.publish(document)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["snapshotVersion"], 3)


if __name__ == "__main__":
    unittest.main()
