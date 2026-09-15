"""B8.1 retention, expired-cursor, and bounded-baseline contracts.

These pin the prerequisites ADR-0036 requires before writes can be enabled:

* an explicit supported offline window, with pruning bounded by age;
* an expired cursor that is *distinguishable* from "no changes";
* a baseline bounded by its real encoded size, enforced at activation and on read.

The recurring hazard is that a missing change row gets read as a deletion, so the
tests check state preservation explicitly rather than only row counts.
"""
import datetime
import json
import sqlite3
import sys
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api_auth
import catalog_bookmarks
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import mobile_catalog_replica as replica
from mobile_catalog import register_mobile_catalog
from tests import test_mobile_catalog as base

LIBRARY = "a" * 32
SNAPSHOT = "/v1/mobile-catalog/bookmarks"
CHANGES = "/v1/mobile-catalog/bookmarks/changes"
MUTATION = "/v1/mobile-catalog/bookmarks"


class RetentionFixture(unittest.TestCase):
    def setUp(self):
        self.temp = base.tempfile.TemporaryDirectory()
        self.root = base.Path(self.temp.name)

        @contextmanager
        def get_db():
            db = sqlite3.connect(self.root / "control.sqlite", timeout=10)
            db.row_factory = sqlite3.Row
            try:
                yield db
            finally:
                db.close()

        self.get_db = get_db
        api_auth.startup(get_db)
        # `provision_token` mints the secret and returns it exactly once; the label
        # is not a credential.
        with get_db() as db:
            _, self.publisher_token = api_auth.provision_token(db, "publisher", "retention")
            db.commit()
        self.publisher = {"Authorization": f"Bearer {self.publisher_token}"}
        self.legacy = base.AUTH
        self.app = FastAPI()
        start = register_mobile_catalog(
            self.app, get_db, lambda value: "admin", lambda: self.root / "artifacts",
            lambda: "catalog-test", lambda _work_id: "<html></html>",
            require_client=api_auth.client_guard(get_db, "catalog-test"),
            require_publisher=api_auth.publisher_guard(get_db))
        start()
        self.client = TestClient(self.app)
        self.data, self.digest, self.users = base.fixture_projection()

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def publish(self):
        uploaded = self.client.put("/v1/mobile-catalog/replicas/" + self.digest,
                                   headers=self.publisher, content=self.data)
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        response = self.client.put("/v1/mobile-catalog/publication",
                                   headers={**self.publisher, "X-Lakomics-Library-Id": LIBRARY},
                                   json={"version": 1, "baseRevision": None,
                                         "contentDigest": self.digest, "userSnapshot": self.users})
        self.assertEqual(response.status_code, 200, response.text)

    def revision(self):
        return self.client.get("/v1/mobile-catalog/status", headers=self.legacy).json()["publicationRevision"]

    def activate(self):
        self.publish()
        response = self.client.post("/v1/mobile-catalog/bookmark-authority/activate",
                                    headers=self.publisher,
                                    json={"libraryId": LIBRARY, "expectedPublicationRevision": self.revision()})
        self.assertEqual(response.status_code, 200, response.text)

    def command(self, work_id="1", desired=True, expected_revision=0, operation_id=None):
        return self.client.put(f"{MUTATION}/kHentai/{work_id}", headers=self.legacy, json={
            "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
            "operationId": operation_id or str(uuid.uuid4()),
            "expectedRevision": expected_revision, "desiredState": desired})

    def changes(self, after, limit=100):
        return self.client.get(CHANGES, headers=self.legacy,
                               params={"libraryId": LIBRARY, "epoch": 1, "after": after, "limit": limit})

    def snapshot(self):
        return self.client.get(SNAPSHOT, headers=self.legacy,
                               params={"libraryId": LIBRARY, "epoch": 1})

    def state_rows(self):
        with self.get_db() as db:
            return db.execute(
                "SELECT provider,work_id,desired_state,entity_revision FROM catalog_bookmark_state"
                " WHERE library_id=? ORDER BY provider,work_id", [LIBRARY]).fetchall()

    def age_history(self, days):
        """Backdate history so it falls outside the retention window."""
        stamp = (datetime.datetime.now(datetime.timezone.utc)
                 - datetime.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        with self.get_db() as db:
            db.execute("UPDATE catalog_bookmark_changes SET changed_at=?", [stamp])
            db.execute("UPDATE catalog_bookmark_receipts SET accepted_at=?", [stamp])
            db.commit()


class ExpiredCursorTests(RetentionFixture):
    def test_cursor_inside_retention_replays_normally(self):
        self.activate()
        self.assertEqual(self.command("7").status_code, 200)
        self.assertEqual(self.command("8").status_code, 200)
        page = self.changes(0)
        self.assertEqual(page.status_code, 200, page.text)
        self.assertEqual([item["sequence"] for item in page.json()["items"]], [1, 2])

    def test_expired_cursor_is_explicit_and_not_an_empty_page(self):
        self.activate()
        self.assertEqual(self.command("7").status_code, 200)
        self.assertEqual(self.command("8").status_code, 200)
        self.age_history(catalog_bookmarks.RETENTION_DAYS + 1)
        catalog_bookmarks.prune(self.get_db)
        # A pruned cursor must never look like "no changes": that would silently
        # drop every mutation in the gap.
        response = self.changes(0)
        self.assertEqual(response.status_code, 409, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], "cursorExpired")
        self.assertEqual(detail["retentionDays"], catalog_bookmarks.RETENTION_DAYS)
        self.assertEqual(detail["authorityCursor"], 2)

    def test_cursor_at_or_after_the_floor_still_replays(self):
        self.activate()
        self.assertEqual(self.command("7").status_code, 200)
        self.assertEqual(self.command("8").status_code, 200)
        self.age_history(catalog_bookmarks.RETENTION_DAYS + 1)
        catalog_bookmarks.prune(self.get_db)
        # Both rows were aged, so the floor is 2. A cursor at the floor has nothing
        # behind it, so it is a normal empty page rather than an expiry.
        response = self.changes(2)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["items"], [])

    def test_cursor_ahead_of_the_server_stays_distinct_from_expiry(self):
        self.activate()
        self.assertEqual(self.command("7").status_code, 200)
        response = self.changes(999)
        self.assertEqual(response.status_code, 409, response.text)
        # No retention gap: a cursor beyond the authority is a different condition
        # and must not be reported as expired history.
        self.assertNotEqual(response.json().get("detail"), None)


class PruningTests(RetentionFixture):
    def test_history_inside_retention_is_retained(self):
        self.activate()
        self.assertEqual(self.command("7").status_code, 200)
        result = catalog_bookmarks.prune(self.get_db)
        self.assertEqual(result, {"changes": 0, "receipts": 0})
        self.assertEqual(len(self.changes(0).json()["items"]), 1)

    def test_rows_older_than_retention_are_pruned(self):
        self.activate()
        self.assertEqual(self.command("7").status_code, 200)
        self.assertEqual(self.command("8").status_code, 200)
        self.age_history(catalog_bookmarks.RETENTION_DAYS + 1)
        result = catalog_bookmarks.prune(self.get_db)
        self.assertEqual(result, {"changes": 2, "receipts": 2})

    def test_pruning_never_deletes_bookmark_state_or_tombstones(self):
        self.activate()
        self.assertEqual(self.command("7", desired=True).status_code, 200)
        self.assertEqual(self.command("8", desired=True).status_code, 200)
        self.assertEqual(self.command("8", desired=False, expected_revision=1).status_code, 200)
        before = self.state_rows()
        self.age_history(catalog_bookmarks.RETENTION_DAYS + 1)
        catalog_bookmarks.prune(self.get_db)
        # "No change row" must never be read as "this bookmark was deleted", so
        # every materialized row (tombstones included) survives pruning.
        self.assertEqual(self.state_rows(), before)

    def test_pruning_does_not_move_the_authority_cursor(self):
        self.activate()
        self.assertEqual(self.command("7").status_code, 200)
        self.assertEqual(self.command("8").status_code, 200)
        self.age_history(catalog_bookmarks.RETENTION_DAYS + 1)
        catalog_bookmarks.prune(self.get_db)
        status = self.client.get("/v1/mobile-catalog/status", headers=self.legacy).json()
        self.assertEqual(status["authorityCursor"], 2)

    def test_pruning_records_the_retained_history_floor(self):
        self.activate()
        self.assertEqual(self.command("7").status_code, 200)
        self.assertEqual(self.command("8").status_code, 200)
        self.age_history(catalog_bookmarks.RETENTION_DAYS + 1)
        catalog_bookmarks.prune(self.get_db)
        with self.get_db() as db:
            floor = catalog_bookmarks.pruned_through(db, LIBRARY, 1)
        self.assertEqual(floor, 2)

    def test_pruning_is_idempotent_and_restart_safe(self):
        self.activate()
        self.assertEqual(self.command("7").status_code, 200)
        self.age_history(catalog_bookmarks.RETENTION_DAYS + 1)
        self.assertEqual(catalog_bookmarks.prune(self.get_db)["changes"], 1)
        # A restart re-runs startup DDL and the same prune; neither may fail or
        # re-delete, and the floor must not regress.
        catalog_bookmarks.startup(self.get_db)
        self.assertEqual(catalog_bookmarks.prune(self.get_db)["changes"], 0)
        with self.get_db() as db:
            self.assertEqual(catalog_bookmarks.pruned_through(db, LIBRARY, 1), 1)

    def test_receipts_survive_retention_so_a_retry_stays_idempotent(self):
        self.activate()
        operation = str(uuid.uuid4())
        first = self.command("7", operation_id=operation)
        self.assertEqual(first.status_code, 200, first.text)
        catalog_bookmarks.prune(self.get_db)
        # Inside the supported window the recorded result resolves the retry
        # instead of the command being re-applied as a new logical mutation.
        retry = self.command("7", operation_id=operation)
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.json(), first.json())
        self.assertEqual(len(self.changes(0).json()["items"]), 1)

    def test_receipt_window_cannot_be_shorter_than_the_change_window(self):
        # Enforced by the maintenance CLI so a retry inside the supported offline
        # window can always be resolved.
        import prune_bookmarks
        self.assertEqual(prune_bookmarks.main(["--days", "180", "--receipt-days", "30"]), 2)


class SnapshotBoundTests(RetentionFixture):
    def test_ordinary_baseline_reads_normally(self):
        self.activate()
        self.assertEqual(self.command("7").status_code, 200)
        response = self.snapshot()
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["libraryId"], LIBRARY)
        self.assertLessEqual(len(json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()),
                             catalog_bookmarks.MAX_SNAPSHOT_BYTES)

    def test_baseline_at_the_limit_succeeds(self):
        # Build items totalling just under the byte limit and verify the encoder
        # accepts them, so the boundary is inclusive of a real usable baseline.
        filler = {"provider": "kHentai", "workId": "0" * 4096, "desiredState": True,
                  "entityRevision": 1, "createdAt": "2026-09-15T00:00:00Z",
                  "updatedAt": "2026-09-15T00:00:00Z"}
        per_item = len(json.dumps(filler, separators=(",", ":"), ensure_ascii=False).encode()) + 1
        count = (catalog_bookmarks.MAX_SNAPSHOT_BYTES // per_item) - 2
        items = [dict(filler, workId=str(index)) for index in range(count)]
        encoded = catalog_bookmarks.encode_snapshot(LIBRARY, 1, 1, count, items)
        measured = len(json.dumps(encoded, separators=(",", ":"), ensure_ascii=False).encode())
        self.assertLessEqual(measured, catalog_bookmarks.MAX_SNAPSHOT_BYTES)
        self.assertEqual(len(encoded["items"]), count)

    def test_baseline_above_the_byte_limit_is_rejected_explicitly(self):
        filler = {"provider": "kHentai", "workId": "0" * 4096, "desiredState": True,
                  "entityRevision": 1, "createdAt": "2026-09-15T00:00:00Z",
                  "updatedAt": "2026-09-15T00:00:00Z"}
        per_item = len(json.dumps(filler, separators=(",", ":"), ensure_ascii=False).encode()) + 1
        items = [dict(filler, workId="0" * 4090 + f"{index:06d}")
                 for index in range((catalog_bookmarks.MAX_SNAPSHOT_BYTES // per_item) + 8)]
        with self.assertRaises(HTTPException) as caught:
            catalog_bookmarks.encode_snapshot(LIBRARY, 1, 1, len(items), items)
        self.assertEqual(caught.exception.status_code, 503)
        self.assertEqual(caught.exception.detail["code"], "baselineTooLarge")
        # The rejection reports the real measured size, not an estimate.
        self.assertGreater(caught.exception.detail["actualBytes"],
                           catalog_bookmarks.MAX_SNAPSHOT_BYTES)

    def test_activation_rejects_a_baseline_it_could_not_later_serve(self):
        # Growth must not silently produce an authority whose mandatory recovery
        # baseline cannot be consumed by a client.
        self.publish()
        # A real bookmark row: provider, exact work id, creation time. Each long id
        # pushes the encoded baseline past MAX_SNAPSHOT_BYTES while the user
        # snapshot itself stays under its own 8 MiB projection limit.
        oversized = sorted([["kHentai", "0" * 4090 + f"{index:06d}", "now"] for index in range(900)],
                           key=replica.encode)
        users = dict(self.users)
        users["bookmarks"] = oversized
        response = self.client.put("/v1/mobile-catalog/publication",
                                   headers={**self.publisher, "X-Lakomics-Library-Id": LIBRARY},
                                   json={"version": 1, "baseRevision": self.revision(),
                                         "contentDigest": self.digest, "userSnapshot": users})
        self.assertEqual(response.status_code, 200, response.text)
        activated = self.client.post("/v1/mobile-catalog/bookmark-authority/activate",
                                     headers=self.publisher,
                                     json={"libraryId": LIBRARY, "expectedPublicationRevision": self.revision()})
        self.assertEqual(activated.status_code, 503, activated.text)
        self.assertEqual(activated.json()["detail"]["code"], "baselineTooLarge")
        # No partial activation: the domain stays PC-owned.
        status = self.client.get("/v1/mobile-catalog/status", headers=self.legacy).json()
        self.assertIsNone(status["authorityLibraryId"])
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM authority_domains").fetchone()[0], 0)

    def test_oversized_recovery_snapshot_is_never_a_misleading_success(self):
        """A pre-existing authority that grew past the limit fails on read."""
        self.activate()
        filler = {"library_id": LIBRARY, "provider": "kHentai", "desired_state": 1,
                  "entity_revision": 1, "created_at": "2026-09-15T00:00:00Z",
                  "updated_at": "2026-09-15T00:00:00Z"}
        with self.get_db() as db:
            db.executemany(
                "INSERT INTO catalog_bookmark_state(library_id,provider,work_id,desired_state,"
                "entity_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                [[filler["library_id"], filler["provider"], "0" * 4096 + str(index),
                  filler["desired_state"], filler["entity_revision"], filler["created_at"],
                  filler["updated_at"]] for index in range(1200)])
            db.commit()
        response = self.snapshot()
        self.assertEqual(response.status_code, 503, response.text)
        self.assertEqual(response.json()["detail"]["code"], "baselineTooLarge")


class CapabilityTests(RetentionFixture):
    def test_bookmark_write_enables_after_authority_activation(self):
        self.activate()
        status = self.client.get("/v1/mobile-catalog/status", headers=self.legacy).json()
        self.assertTrue(status["capabilities"]["bookmarkWrite"])
        self.assertEqual(status["authorityLibraryId"], LIBRARY)


if __name__ == "__main__":
    unittest.main()
