"""B8.1 catalog credential separation.

The role model is deliberate and must not drift:

* a **client** reads the catalog, reads bookmark state, and submits ordinary user
  bookmark mutations;
* a **publisher** may use every client route and additionally upload replicas,
  publish a projection, and activate bookmark authority.

These tests pin the boundary itself, including the inversion B8.1 removes: the
legacy shared cloud token is a client credential and must never satisfy publisher
authority.
"""
import contextlib
import io
import sqlite3
import sys
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api_auth
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

LEGACY = "legacy-shared-cloud-token"


class GuardFixture(unittest.TestCase):
    """Guards wired exactly as ``app.py`` wires them."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)

        @contextmanager
        def get_db():
            db = sqlite3.connect(root / "control.sqlite", timeout=10)
            db.row_factory = sqlite3.Row
            try:
                yield db
            finally:
                db.close()

        self.get_db = get_db
        api_auth.startup(get_db)
        self.require_client = api_auth.client_guard(get_db, LEGACY)
        self.require_publisher = api_auth.publisher_guard(get_db)
        self.app = FastAPI()

        @self.app.get("/client")
        def client_route(authorization: str | None = Header(default=None)):
            return {"principal": self.require_client(authorization)}

        @self.app.get("/publisher")
        def publisher_route(authorization: str | None = Header(default=None)):
            return {"principal": self.require_publisher(authorization)}

        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def provision(self, role, label=None):
        with self.get_db() as db:
            client_id, token = api_auth.provision_token(db, role, label)
            db.commit()
        return client_id, token

    @staticmethod
    def headers(token):
        return {"Authorization": f"Bearer {token}"}

    def call(self, route, token):
        return self.client.get(route, headers=self.headers(token))


class ClientCredentialTests(GuardFixture):
    def test_legacy_shared_token_is_a_client_credential(self):
        response = self.call("/client", LEGACY)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["principal"], api_auth.LEGACY_CLIENT)

    def test_legacy_shared_token_cannot_satisfy_publisher_guard(self):
        # The inversion B8.1 removes: one credential must not prove every role.
        self.assertEqual(self.call("/publisher", LEGACY).status_code, 401)

    def test_provisioned_client_row_is_a_client_credential_only(self):
        _, token = self.provision("client")
        self.assertEqual(self.call("/client", token).status_code, 200)
        self.assertEqual(self.call("/publisher", token).status_code, 401)

    def test_client_rows_cannot_satisfy_publisher_guard_even_when_unrevoked(self):
        _, token = self.provision("client", "reader-device")
        self.assertEqual(self.call("/publisher", token).status_code, 401)

    def test_missing_and_malformed_credentials_are_rejected(self):
        for value in (None, "", "Bearer ", "publisher-token", "Basic abc"):
            headers = {} if value is None else {"Authorization": value}
            self.assertEqual(self.client.get("/client", headers=headers).status_code, 401, value)
            self.assertEqual(self.client.get("/publisher", headers=headers).status_code, 401, value)


class PublisherCredentialTests(GuardFixture):
    def test_provisioned_publisher_satisfies_publisher_guard(self):
        _, token = self.provision("publisher", "pc-publication")
        response = self.call("/publisher", token)
        self.assertEqual(response.status_code, 200, response.text)

    def test_provisioned_publisher_also_satisfies_client_guard(self):
        # A publisher is a superset of a client: it may use client routes too.
        _, token = self.provision("publisher")
        self.assertEqual(self.call("/client", token).status_code, 200)

    def test_unknown_and_revoked_publisher_credentials_are_rejected(self):
        _, token = self.provision("publisher")
        self.assertEqual(self.call("/publisher", token).status_code, 200)
        client_id, other = self.provision("publisher")
        with self.get_db() as db:
            self.assertTrue(api_auth.revoke_token(db, client_id))
            db.commit()
        self.assertEqual(self.call("/publisher", other).status_code, 401)
        self.assertEqual(self.call("/client", other).status_code, 401)
        self.assertEqual(self.call("/publisher", str(uuid.uuid4())).status_code, 401)

    def test_revoking_twice_reports_no_live_row(self):
        client_id, _ = self.provision("publisher")
        with self.get_db() as db:
            self.assertTrue(api_auth.revoke_token(db, client_id))
            self.assertFalse(api_auth.revoke_token(db, client_id))
            db.commit()


class ProvisioningTests(GuardFixture):
    def test_provisioned_token_is_random_and_hash_only_is_stored(self):
        first_id, first = self.provision("publisher")
        second_id, second = self.provision("publisher")
        self.assertNotEqual(first, second)
        self.assertNotEqual(first_id, second_id)
        with self.get_db() as db:
            row = db.execute("SELECT token_hash,role FROM api_clients WHERE id=?", [first_id]).fetchone()
        self.assertEqual(row["role"], "publisher")
        self.assertEqual(row["token_hash"], api_auth.token_hash(first))
        # The raw token is never persisted or recoverable.
        self.assertNotIn(first, row["token_hash"])

    def test_provision_rejects_an_unknown_role(self):
        with self.get_db() as db:
            with self.assertRaises(ValueError):
                api_auth.provision_token(db, "admin")

    def test_cli_provisions_without_an_http_route(self):
        # No route may mint a credential: a client credential must not be able to
        # escalate itself to publisher.
        paths = {route.path for route in self.app.routes}
        self.assertFalse([path for path in paths
                          if "provision" in path or "api_clients" in path or "credentials" in path])
        database = Path(self.temp.name) / "control.sqlite"
        # Capture stdout: provisioning prints the raw token once, and a test log
        # must not carry even a disposable generated secret.
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(api_auth.main(["--db", str(database), "provision",
                                           "--role", "publisher", "--label", "cli"]), 0)

    def test_cli_lists_roles_without_disclosing_secrets(self):
        self.provision("publisher", "pc")
        self.provision("client", "tablet")
        database = Path(self.temp.name) / "control.sqlite"
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            api_auth.main(["--db", str(database), "list"])
        joined = buffer.getvalue()
        self.assertIn("publisher", joined)
        self.assertIn("client", joined)
        with self.get_db() as db:
            for row in db.execute("SELECT token_hash FROM api_clients"):
                self.assertNotIn(row["token_hash"], joined)


class SharedDbPathTests(unittest.TestCase):
    def test_provisioning_default_matches_the_server_database(self):
        """The CLI and the server must agree, or provisioning writes elsewhere."""
        source = (Path(__file__).resolve().parents[1] / "app.py").read_text(encoding="utf-8")
        self.assertIn('DB_PATH = BASE_DIR / "data" / "lakomics.sqlite3"', source)
        self.assertEqual(api_auth.DEFAULT_DB,
                         Path(__file__).resolve().parents[1] / "data" / "lakomics.sqlite3")


if __name__ == "__main__":
    unittest.main()
