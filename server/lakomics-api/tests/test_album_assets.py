"""`GET /v1/albums/assets`: the authority-backed Album contents projection.

This is the read route that lets an Album's Assets be listed without copying Asset
display metadata into a replica. The properties that matter, and that are pinned here:

* it is served only by an active authority, with the same identity/contract validation
  the other Album read routes use, so it cannot become a second, looser door;
* contents come from authoritative `desired_state=1` membership joined to committed
  Assets, so a tombstoned relation is absent and an uncommitted Asset is not displayable;
* a deleted Album is *not* an empty Album;
* pagination is deterministic and cannot loop;
* it reads nothing from the legacy `album_replica` display snapshot, which is a different
  representation owned by a different path.

The fixture is the shipped FastAPI app, so the route, its guards and the injected mobile
Asset projection are the real ones.
"""
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import album_authority  # noqa: E402
import api_auth  # noqa: E402
import authority  # noqa: E402
from tests.test_capture_api_stub import fake_s3  # noqa: E402
import app as api_app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

ASSETS_ROUTE = "/v1/albums/assets"
LIBRARY = "a" * 32
OTHER_LIBRARY = "b" * 32
ALBUM = "root"
CHILD = "child"
GONE = "gone"

A1 = "20000000-0000-4000-8000-000000000001"
A2 = "20000000-0000-4000-8000-000000000002"
A3 = "20000000-0000-4000-8000-000000000003"
A4 = "20000000-0000-4000-8000-000000000004"
A5 = "20000000-0000-4000-8000-000000000005"
MISSING = "20000000-0000-4000-8000-000000000006"


class AlbumAssetsProjectionTests(unittest.TestCase):
    """The shipped app, with Album authority activated through the real publisher route."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "lakomics.sqlite3"
        self.original_database_path = api_app.DB_PATH
        self.original_api_token = api_app.API_TOKEN
        api_app.DB_PATH = self.database
        api_app.API_TOKEN = "test-token"
        api_app.startup()
        api_app.startup_replication()
        api_app.startup_album_replica()
        # The Album domain's own tables. TestClient is used without its context manager
        # here, so the app's startup events do not run and the schema is created directly
        # — the same tables the shipped startup hook creates.
        album_authority.startup(api_app.get_db)
        authority.startup(api_app.get_db)
        with api_app.get_db() as db:
            api_auth.startup(api_app.get_db)
            # Column order matters only for the INSERT below; the projection reads by name.
            for asset_id, sort_at, committed in ((A1, "2026-01-05", 1), (A2, "2026-01-04", 1),
                                                 (A3, "2026-01-03", 1), (A4, "2026-01-02", 1),
                                                 (A5, "2026-01-01", 0)):
                db.execute(
                    "INSERT INTO assets(id,kind,object_key,thumbnail_key,content_type,"
                    "size_bytes,created_at,updated_at,collected_at,committed,committed_at)"
                    " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (asset_id, "image", f"objects/{asset_id}", f"thumbs/{asset_id}",
                     "image/png", 128, sort_at, sort_at, sort_at, committed, sort_at))
            db.execute("INSERT INTO asset_classifications(asset_id,classification_id,added_at)"
                       " VALUES(?,?,?)", (A1, "10000000-0000-4000-8000-000000000001", sort_at))
            db.commit()
            _, self.publisher_token = api_auth.provision_token(db, "publisher", "albums")
            _, self.client_token = api_auth.provision_token(db, "client", "albums")
            db.commit()
        self.client = TestClient(api_app.app)

    def tearDown(self) -> None:
        self.client.close()
        api_app.DB_PATH = self.original_database_path
        api_app.API_TOKEN = self.original_api_token
        self.temp.cleanup()

    @property
    def publisher(self):
        return {"Authorization": f"Bearer {self.publisher_token}"}

    @property
    def client_auth(self):
        return {"Authorization": f"Bearer {self.client_token}"}

    # -- fixture ---------------------------------------------------------

    def publish(self, albums, memberships):
        """Stage a v3 snapshot through the shipped publisher route.

        The shipped snapshot route authenticates with the shared API token rather than
        the `publisher` role (that role guards activation), so the fixture presents the
        credential the real route actually requires.
        """
        response = self.client.put(
            "/v1/library/album-snapshot", headers={"Authorization": "Bearer test-token"},
            json={"published_at": "2026-09-16T00:00:00Z", "snapshotVersion": 3,
                  "albums": albums, "media": [], "memberships": memberships})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def activate(self, library_id=LIBRARY):
        digest = self.publish(
            [{"id": ALBUM, "name": "업로드용", "parent_id": None, "icon_key": None, "color_key": None},
             {"id": CHILD, "name": "임시", "parent_id": ALBUM, "icon_key": None, "color_key": None}],
            [{"albumId": ALBUM, "assetId": A1}, {"albumId": ALBUM, "assetId": A2},
             {"albumId": ALBUM, "assetId": A3}, {"albumId": CHILD, "assetId": A4}])
        response = self.client.post("/v1/albums/authority/activate", headers=self.publisher,
                                    json={"libraryId": library_id,
                                          "expectedSnapshotDigest": digest["snapshotDigest"]})
        self.assertEqual(response.status_code, 200, response.text)

    def read(self, album_id=ALBUM, **params):
        query = {"libraryId": LIBRARY, "epoch": "1", "albumId": album_id}
        query.update(params)
        return self.client.get(ASSETS_ROUTE, params=query, headers=self.client_auth)

    def walk(self, album_id=ALBUM, limit=2):
        """Every page, asserting the walk terminates and stays disjoint."""
        items, seen, cursor = [], set(), None
        for _ in range(50):
            params = {"limit": str(limit)}
            if cursor:
                params["cursor"] = cursor
            body = self.read(album_id, **params).json()
            for item in body["items"]:
                self.assertNotIn(item["id"], seen, "a page repeated an Asset")
                seen.add(item["id"])
                items.append(item)
            if not body["hasMore"]:
                self.assertIsNone(body["nextCursor"])
                return items, body
            self.assertIsNotNone(body["nextCursor"])
            self.assertNotEqual(body["nextCursor"], cursor)
            cursor = body["nextCursor"]
        raise AssertionError("pagination did not terminate")

    # -- inactive / identity ---------------------------------------------

    def test_inactive_authority_is_rejected_with_the_domain_code(self):
        response = self.read()
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], "authorityInactive")

    def test_another_library_identity_is_rejected(self):
        self.activate()
        response = self.client.get(
            ASSETS_ROUTE, params={"libraryId": OTHER_LIBRARY, "epoch": "1", "albumId": ALBUM},
            headers=self.client_auth)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"]["code"], "authorityLibraryMismatch")

    def test_authentication_is_required(self):
        self.activate()
        self.assertEqual(self.client.get(ASSETS_ROUTE, params={
            "libraryId": LIBRARY, "epoch": "1", "albumId": ALBUM}).status_code, 401)

    def test_request_validation_is_closed(self):
        self.activate()
        for params in ({"albumId": "bad/slash"}, {"albumId": ""}, {"epoch": "0"},
                       {"albumId": "a" * 129}, {"limit": "0"}, {"limit": "101"}):
            query = {"libraryId": LIBRARY, "epoch": "1", "albumId": ALBUM}
            query.update(params)
            self.assertEqual(self.client.get(ASSETS_ROUTE, params=query,
                                             headers=self.client_auth).status_code, 422, params)
        self.assertEqual(self.client.get(ASSETS_ROUTE, params={
            "libraryId": LIBRARY, "epoch": "1", "albumId": ALBUM, "unknown": "1"},
            headers=self.client_auth).status_code, 422)

    def test_a_malformed_cursor_is_rejected(self):
        self.activate()
        self.assertEqual(self.read(cursor="not-a-cursor").status_code, 422)

    def test_a_cursor_cannot_be_replayed_against_another_album(self):
        self.activate()
        cursor = self.read(ALBUM, limit="1").json()["nextCursor"]
        self.assertIsNotNone(cursor)
        # The Album is part of the cursor payload, so it cannot resume a different walk.
        response = self.read(CHILD, limit="1", cursor=cursor)
        self.assertEqual(response.status_code, 422)

    # -- contents ---------------------------------------------------------

    def test_live_membership_is_projected_with_mobile_asset_metadata(self):
        self.activate()
        items, _ = self.walk(ALBUM, limit=50)
        self.assertEqual([item["id"] for item in items], [A1, A2, A3])
        first = items[0]
        # The fields an Android/WebView consumer needs come from the Asset domain.
        for field in ("id", "kind", "content_type", "size_bytes", "collected_at",
                      "committed_at", "source_published_at", "original_available",
                      "thumbnail_available", "classification_ids", "committed"):
            self.assertIn(field, first)
        self.assertTrue(first["original_available"])
        self.assertTrue(first["thumbnail_available"])
        self.assertTrue(first["committed"])
        # Classification membership is carried because the published mobile projection
        # includes it; it is a different domain and does not decide Album membership.
        self.assertEqual(items[0]["classification_ids"],
                         ["10000000-0000-4000-8000-000000000001"])
        self.assertEqual(items[1]["classification_ids"], [])

    def test_activation_retains_missing_asset_until_it_is_materialized(self):
        digest = self.publish(
            [{"id": ALBUM, "name": "업로드용", "parent_id": None,
              "icon_key": None, "color_key": None}],
            [{"albumId": ALBUM, "assetId": MISSING}])
        activated = self.client.post(
            "/v1/albums/authority/activate", headers=self.publisher,
            json={"libraryId": LIBRARY, "expectedSnapshotDigest": digest["snapshotDigest"]})
        self.assertEqual(activated.status_code, 200, activated.text)
        self.assertEqual(activated.json()["membershipCount"], 1)

        before, _ = self.walk(ALBUM, limit=50)
        self.assertNotIn(MISSING, [item["id"] for item in before])

        with api_app.get_db() as db:
            db.execute(
                "INSERT INTO assets(id,kind,object_key,thumbnail_key,content_type,size_bytes,"
                "created_at,updated_at,collected_at,committed,committed_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (MISSING, "image", f"objects/{MISSING}", f"thumbs/{MISSING}", "image/png",
                 128, "2026-01-06", "2026-01-06", "2026-01-06", 1, "2026-01-06"))
            db.commit()
        after, _ = self.walk(ALBUM, limit=50)
        self.assertIn(MISSING, [item["id"] for item in after])

    def test_uncommitted_assets_are_not_displayable(self):
        self.activate()
        with api_app.get_db() as db:
            db.execute("INSERT INTO album_authority_members(library_id,album_id,asset_id,"
                       "desired_state,entity_revision,created_at,updated_at)"
                       " VALUES(?,?,?,1,1,?,?)", (LIBRARY, ALBUM, A5, "now", "now"))
            db.commit()
        items, _ = self.walk(ALBUM, limit=50)
        self.assertNotIn(A5, [item["id"] for item in items])

    def test_a_tombstoned_membership_is_not_listed(self):
        self.activate()
        with api_app.get_db() as db:
            db.execute("UPDATE album_authority_members SET desired_state=0"
                       " WHERE library_id=? AND album_id=? AND asset_id=?",
                       (LIBRARY, ALBUM, A2))
            db.commit()
        items, _ = self.walk(ALBUM, limit=50)
        self.assertEqual([item["id"] for item in items], [A1, A3])

    def test_album_membership_is_not_inferred_from_classification(self):
        self.activate()
        # A4 shares no Album with the others and A1 is the only classified Asset, so a
        # projection that leaked the Classification relation would show the wrong set.
        items, _ = self.walk(CHILD, limit=50)
        self.assertEqual([item["id"] for item in items], [A4])

    def test_a_deleted_album_is_not_an_empty_album(self):
        self.activate()
        response = self.client.put("/v1/albums/commands", headers=self.client_auth, json={
            "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
            "operationId": "11111111-1111-4111-8111-111111111111",
            "commandType": album_authority.DELETE, "albumId": CHILD,
            "expectedRevision": 1})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.read(CHILD).status_code, 404)
        self.assertEqual(self.read("neverExisted").status_code, 404)
        # The surviving Album is unaffected by its sibling's deletion.
        items, _ = self.walk(ALBUM, limit=50)
        self.assertEqual([item["id"] for item in items], [A1, A2, A3])

    def test_multi_page_walk_is_deterministic_and_disjoint(self):
        self.activate()
        whole, body = self.walk(ALBUM, limit=50)
        paged, _ = self.walk(ALBUM, limit=1)
        self.assertEqual([item["id"] for item in whole], [item["id"] for item in paged])
        self.assertEqual(len(whole), 3)
        self.assertEqual(body["libraryId"], LIBRARY)
        self.assertEqual(body["epoch"], 1)
        self.assertEqual(body["albumId"], ALBUM)
        self.assertEqual(body["contractVersion"], 1)

    def test_a_final_page_reports_no_continuation(self):
        self.activate()
        body = self.read(ALBUM, limit="50").json()
        self.assertFalse(body["hasMore"])
        self.assertIsNone(body["nextCursor"])

    def test_unknown_query_parameters_are_refused_rather_than_ignored(self):
        self.activate()
        self.assertEqual(self.read(section="albums").status_code, 422)

    def test_the_route_reads_no_mutation_capability(self):
        self.activate()
        for method in (self.client.post, self.client.put, self.client.delete, self.client.patch):
            self.assertIn(method(ASSETS_ROUTE, params={
                "libraryId": LIBRARY, "epoch": "1", "albumId": ALBUM},
                headers=self.client_auth).status_code, (405, 422))

    def test_it_does_not_depend_on_the_legacy_album_replica_snapshot(self):
        """Deleting the legacy snapshot row must not change the authority projection."""
        self.activate()
        before, _ = self.walk(ALBUM, limit=50)
        with api_app.get_db() as db:
            db.execute("DELETE FROM album_replica")
            db.commit()
        after, _ = self.walk(ALBUM, limit=50)
        self.assertEqual([item["id"] for item in before], [item["id"] for item in after])
        self.assertTrue(after)


if __name__ == "__main__":
    unittest.main()
