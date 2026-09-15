"""Safety substrate: reusable authority registry, aggregate status and legacy fence.

These tests pin the properties ADR-0037's first implementation batch requires
before another shared domain can migrate:

* zero authority rows change nothing (existing behavior is byte-identical);
* the shipped catalog-bookmark authority is reported, not reinterpreted;
* an impossible/ambiguous authority state fails explicitly instead of being
  resolved by picking a library;
* the legacy fence is inert while a domain is inactive and rejects it once active;
* a writer disagreeing about the library cannot bypass the fence.

The fixture writes authority rows directly, exactly like the bookmark retention
tests, because this batch adds no activation route.
"""
import sys
import unittest
import sqlite3
import tempfile
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api_auth
import authority
import catalog_bookmarks
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from sync_status import register_sync_status

LIBRARY = "a" * 32
OTHER_LIBRARY = "b" * 32
ACTIVE_DOMAIN = "classifications"
STATUS = "/v1/sync/status"


def authority_row(db, library_id=LIBRARY, domain=ACTIVE_DOMAIN, epoch=1,
                  contract_version=1, cursor=0, digest="d" * 64, revision=None):
    db.execute(
        "INSERT INTO authority_domains(library_id,domain,epoch,contract_version,change_cursor,"
        "baseline_digest,baseline_revision,activated_at) VALUES(?,?,?,?,?,?,?,?)",
        [library_id, domain, epoch, contract_version, cursor, digest, revision,
         "2026-09-15T00:00:00Z"])


class AuthorityFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "control.sqlite"

        @contextmanager
        def get_db():
            db = sqlite3.connect(self.database, timeout=10)
            db.row_factory = sqlite3.Row
            try:
                yield db
            finally:
                db.close()

        self.get_db = get_db
        authority.startup(get_db)
        api_auth.startup(get_db)
        with get_db() as db:
            _, self.token = api_auth.provision_token(db, "client", "sync-status")
            db.commit()
        self.headers = {"Authorization": f"Bearer {self.token}"}
        self.app = FastAPI()
        register_sync_status(self.app, get_db, api_auth.client_guard(get_db, "shared-token"))
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def query(self):
        return self.client.get(STATUS, headers=self.headers)

    def assert_coded(self, response, status, code):
        self.assertEqual(response.status_code, status, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], code, detail)


class InactiveAuthorityTests(AuthorityFixture):
    def test_zero_authority_rows_report_no_active_authority(self):
        response = self.query()
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["protocolVersion"], authority.PROTOCOL_VERSION)
        self.assertFalse(body["active"])
        self.assertIsNone(body["libraryId"])
        self.assertEqual(body["domains"], [])

    def test_status_requires_authentication(self):
        self.assertEqual(self.client.get(STATUS).status_code, 401)

    def test_untouched_schema_matches_the_shipped_authority_definition(self):
        authority.startup(self.get_db)
        with self.get_db() as db:
            columns = [row["name"] for row in db.execute("PRAGMA table_info(authority_domains)")]
        self.assertEqual(columns, ["library_id", "domain", "epoch", "contract_version",
                                   "change_cursor", "baseline_digest", "baseline_revision",
                                   "activated_at"])


class ActiveAuthorityTests(AuthorityFixture):
    def test_active_domain_reports_library_epoch_contract_and_cursor(self):
        with self.get_db() as db:
            authority_row(db, epoch=3, contract_version=1, cursor=17)
            db.commit()
        body = self.query().json()
        self.assertTrue(body["active"])
        self.assertEqual(body["libraryId"], LIBRARY)
        self.assertEqual(body["domains"], [{"domain": ACTIVE_DOMAIN, "libraryId": LIBRARY,
                                            "epoch": 3, "contractVersion": 1, "cursor": 17}])

    def test_existing_catalog_bookmark_authority_is_reported_unchanged(self):
        """The shipped authority is read through the shared registry, not migrated."""
        with self.get_db() as db:
            catalog_bookmarks.startup(self.get_db)
            authority_row(db, domain=catalog_bookmarks.DOMAIN, epoch=1, cursor=5)
            db.commit()
        body = self.query().json()
        self.assertTrue(body["active"])
        self.assertEqual([entry["domain"] for entry in body["domains"]],
                         [catalog_bookmarks.DOMAIN])
        entry = body["domains"][0]
        self.assertEqual((entry["libraryId"], entry["epoch"], entry["contractVersion"], entry["cursor"]),
                         (LIBRARY, 1, catalog_bookmarks.CONTRACT_VERSION, 5))
        self.assertEqual(body["libraryId"], LIBRARY)

    def test_several_domains_report_independent_cursors(self):
        with self.get_db() as db:
            authority_row(db, domain="classifications", epoch=1, cursor=3)
            authority_row(db, domain="albums", epoch=2, cursor=9)
            db.commit()
        body = self.query().json()
        self.assertEqual(body["libraryId"], LIBRARY)
        self.assertEqual([(entry["domain"], entry["epoch"], entry["cursor"])
                          for entry in body["domains"]],
                         [("albums", 2, 9), ("classifications", 1, 3)])

    def test_ambiguous_domains_fail_explicitly(self):
        with self.get_db() as db:
            authority_row(db, library_id=LIBRARY, domain="albums", epoch=1, cursor=0)
            authority_row(db, library_id=OTHER_LIBRARY, domain="albums", epoch=1, cursor=0)
            db.commit()
        self.assert_coded(self.query(), 503, authority.CODE_AUTHORITY_AMBIGUOUS)

    def test_ambiguous_libraries_across_domains_fail_explicitly(self):
        with self.get_db() as db:
            authority_row(db, library_id=LIBRARY, domain="albums", epoch=1, cursor=0)
            authority_row(db, library_id=OTHER_LIBRARY, domain="classifications", epoch=1, cursor=0)
            db.commit()
        self.assert_coded(self.query(), 503, authority.CODE_AUTHORITY_AMBIGUOUS)


class LegacyFenceTests(AuthorityFixture):
    def test_fence_is_a_no_op_for_an_inactive_domain(self):
        with self.get_db() as db:
            self.assertIsNone(authority.fence_legacy_write(db, "classifications"))
            self.assertIsNone(authority.fence_legacy_write(db, "classifications", LIBRARY))
            self.assertIsNone(authority.active_domain(db, "classifications"))

    def test_fence_rejects_an_active_domain(self):
        with self.get_db() as db:
            authority_row(db, epoch=4, cursor=11)
            db.commit()
        with self.get_db() as db:
            with self.assertRaises(HTTPException) as raised:
                authority.fence_legacy_write(db, ACTIVE_DOMAIN)
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], authority.CODE_LEGACY_WRITER_FENCED)
        self.assertEqual(raised.exception.detail["epoch"], 4)

    def test_fence_rejects_a_different_library_rather_than_letting_it_through(self):
        """Disagreeing about the library identity must not bypass the fence."""
        with self.get_db() as db:
            authority_row(db, library_id=LIBRARY, epoch=1, cursor=0)
            db.commit()
        with self.get_db() as db:
            with self.assertRaises(HTTPException) as raised:
                authority.fence_legacy_write(db, ACTIVE_DOMAIN, OTHER_LIBRARY)
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail["code"], authority.CODE_AUTHORITY_LIBRARY_MISMATCH)

    def test_fence_only_covers_its_own_domain(self):
        with self.get_db() as db:
            authority_row(db, domain="albums", epoch=1, cursor=0)
            db.commit()
        with self.get_db() as db:
            self.assertIsNone(authority.fence_legacy_write(db, "classifications"))

    def test_fence_is_usable_inside_the_protected_write_transaction(self):
        """A rolled-back legacy write leaves no authority or domain state behind."""
        with self.get_db() as db:
            authority_row(db, epoch=1, cursor=0)
            db.commit()
        with self.get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                authority.fence_legacy_write(db, ACTIVE_DOMAIN)
            except HTTPException:
                db.rollback()
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM authority_domains").fetchone()[0], 1)


class RequireActiveTests(AuthorityFixture):
    def test_require_active_reports_each_coded_state(self):
        with self.get_db() as db:
            with self.assertRaises(HTTPException) as inactive:
                authority.require_active(db, ACTIVE_DOMAIN, LIBRARY, 1)
        self.assertEqual(inactive.exception.detail["code"], authority.CODE_AUTHORITY_INACTIVE)

        with self.get_db() as db:
            authority_row(db, contract_version=9)
            db.commit()
        with self.get_db() as db:
            with self.assertRaises(HTTPException) as unsupported:
                authority.require_active(db, ACTIVE_DOMAIN, LIBRARY, 1)
        self.assertEqual(unsupported.exception.detail["code"],
                         authority.CODE_AUTHORITY_CONTRACT_UNSUPPORTED)
        self.assertEqual(unsupported.exception.detail["supported"], 9)

        with self.get_db() as db:
            with self.assertRaises(HTTPException) as mismatch:
                authority.require_active(db, ACTIVE_DOMAIN, OTHER_LIBRARY, 9)
        self.assertEqual(mismatch.exception.detail["code"],
                         authority.CODE_AUTHORITY_LIBRARY_MISMATCH)

        with self.get_db() as db:
            row = authority.require_active(db, ACTIVE_DOMAIN, LIBRARY, 9)
        self.assertEqual((row["libraryId"], row["epoch"], row["cursor"]), (LIBRARY, 1, 0))


class AppLevelIntegrationTests(unittest.TestCase):
    """The real `app` wiring: the route exists, is authenticated, and is inert.

    The isolated fixture above proves the helpers; this proves the production
    module registration reaches them without changing any shipped route.
    """

    def setUp(self):
        import tempfile as _tempfile
        from pathlib import Path as _Path

        from tests.test_capture_api_stub import fake_s3
        import app as api_app

        self.api_app = api_app
        self.fake_s3 = fake_s3
        self.temp = _tempfile.TemporaryDirectory()
        self.original_db_path = api_app.DB_PATH
        self.original_token = api_app.API_TOKEN
        api_app.DB_PATH = _Path(self.temp.name) / "lakomics.sqlite3"
        api_app.API_TOKEN = "sync-status-token"
        api_app.startup()
        api_app.startup_replication()
        api_app.startup_captures()
        api_app.startup_classifications()
        # The domain modules register their own startup closures; the real server
        # runs them through FastAPI's startup events, so this fixture calls them
        # directly rather than relying on a test client's lifespan handling.
        api_app.startup_mobile_catalog()
        api_app.startup_sync_status()
        # The registered route uses the shipped `client_guard`, which accepts an
        # unrevoked `api_clients` row or the legacy shared credential. Minting a
        # real client token exercises the production authorization path rather than
        # replacing it with a stub.
        with api_app.get_db() as db:
            _, self.client_token = api_auth.provision_token(db, "client", "sync-status")
            db.commit()
        self.client_headers = {"Authorization": f"Bearer {self.client_token}"}
        fake_s3.objects.clear()
        self.client = TestClient(api_app.app)

    def tearDown(self):
        self.client.close()
        self.fake_s3.objects.clear()
        self.api_app.DB_PATH = self.original_db_path
        self.api_app.API_TOKEN = self.original_token
        self.temp.cleanup()

    def test_real_app_reports_no_active_authority_before_any_cutover(self):
        response = self.client.get(STATUS, headers=self.client_headers)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertFalse(body["active"])
        self.assertEqual(body["domains"], [])
        self.assertIsNone(body["libraryId"])

    def test_real_app_rejects_an_unauthenticated_status_read(self):
        self.assertEqual(self.client.get(STATUS).status_code, 401)
        self.assertEqual(
            self.client.get(STATUS, headers={"Authorization": "Bearer wrong"}).status_code, 401)

    def test_real_app_reports_the_bookmark_authority_when_one_exists(self):
        with self.api_app.get_db() as db:
            db.execute(
                "INSERT INTO authority_domains(library_id,domain,epoch,contract_version,"
                "change_cursor,baseline_digest,baseline_revision,activated_at)"
                " VALUES(?,?,?,?,?,?,?,?)",
                [LIBRARY, catalog_bookmarks.DOMAIN, 1, catalog_bookmarks.CONTRACT_VERSION,
                 4, "d" * 64, None, "2026-09-15T00:00:00Z"])
            db.commit()
        body = self.client.get(STATUS, headers=self.client_headers).json()
        self.assertTrue(body["active"])
        self.assertEqual(body["libraryId"], LIBRARY)
        self.assertEqual(body["domains"], [{"domain": catalog_bookmarks.DOMAIN,
                                            "libraryId": LIBRARY, "epoch": 1,
                                            "contractVersion": catalog_bookmarks.CONTRACT_VERSION,
                                            "cursor": 4}])

    def test_shipped_routes_still_answer_unchanged(self):
        """Adding the aggregate route must not fence or alter an inactive domain."""
        # Classification publication keeps using the shipped shared credential
        # (`require_auth`), so this asserts the legacy path is untouched rather than
        # that the new route authorizes it.
        admin = {"Authorization": "Bearer sync-status-token"}
        published = self.client.put(
            "/v1/classifications",
            headers=admin,
            json={"entries": [{"id": "games", "kind": "root", "name": "게임",
                               "parentId": None}],
                  "published_at": "2026-09-15T00:00:00Z"})
        self.assertEqual(published.status_code, 200, published.text)
        read = self.client.get("/v1/library/classifications", headers=admin)
        self.assertEqual(read.status_code, 200, read.text)
        self.assertEqual([item["id"] for item in read.json()["items"]], ["games"])


if __name__ == "__main__":
    unittest.main()
