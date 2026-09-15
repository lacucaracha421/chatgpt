"""Batch B4: durable bookmark mutation commands, change log, and read APIs.

Covers the mutation transaction semantics, the authoritative snapshot and
incremental change reads, and the publisher/client authorization foundation.
PC reconciliation, outbox, Android writes, and bookmarkWrite=true stay out of
scope; the mutation API is exercised directly here.
"""
import copy
import json
import sqlite3
import threading
import unittest
import uuid
from contextlib import contextmanager

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import api_auth
import catalog_bookmarks
import mobile_catalog_replica as replica
from mobile_catalog import register_mobile_catalog
from tests import test_mobile_catalog as base

AUTH = base.AUTH
LIBRARY = "a" * 32
OTHER_LIBRARY = "b" * 32
MUTATION = "/v1/mobile-catalog/bookmarks"
SNAPSHOT = "/v1/mobile-catalog/bookmarks"
CHANGES = "/v1/mobile-catalog/bookmarks/changes"


class MutationFixture(unittest.TestCase):
    """Wires the catalog routes with explicit client/publisher guards."""

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

        def legacy(value):
            if value != AUTH["Authorization"]:
                raise HTTPException(401)
            return "admin"

        self.get_db = get_db
        api_auth.startup(get_db)
        # The legacy shared credential is client-only, exactly as in production:
        # publisher authority needs a real publisher row. A fixture that let the
        # shared token publish would hide the separation this batch enforces.
        self.client_guard = api_auth.client_guard(get_db, "catalog-test")
        self.publisher_guard = api_auth.publisher_guard(get_db)
        self.publish_token = "publisher-fixture"
        self.add_client(self.publish_token, "publisher", client_id="publisher-fixture")
        self.app = FastAPI()
        self.gallery_html = '<script>const gallery = {"files":[{"name":"001.webp","image":{"url":"https://a.siam-cdn.net/001.webp?expires=1800000000","width":1200,"height":1800}}]};</script>'
        start = register_mobile_catalog(
            self.app, get_db, legacy, lambda: self.root / "artifacts", lambda: "catalog-test",
            lambda _work_id: self.gallery_html,
            require_client=self.client_guard, require_publisher=self.publisher_guard)
        start()
        self.client = TestClient(self.app)
        self.data, self.digest, self.users = base.fixture_projection()

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    # --- helpers ---
    def add_client(self, token, role, client_id=None, revoked=False):
        with self.get_db() as db:
            db.execute("INSERT INTO api_clients VALUES(?,?,?,?,?,?,?)",
                       [client_id or str(uuid.uuid4()), api_auth.token_hash(token), role, "test",
                        "2026-09-14T00:00:00Z", None, "2026-09-15T00:00:00Z" if revoked else None])
            db.commit()

    def headers(self, token=None):
        return AUTH if token is None else {"Authorization": f"Bearer {token}"}

    def publish(self, base_revision=None, users=None, library_id=LIBRARY):
        # Publication and replica upload are publisher operations.
        publisher = self.headers(self.publish_token)
        uploaded = self.client.put("/v1/mobile-catalog/replicas/" + self.digest, headers=publisher, content=self.data)
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        # The real PC client always identifies its library on publication
        # (client.rs sends X-Lakomics-Library-Id); the server requires it once the
        # bookmark authority is active.
        headers = dict(publisher)
        if library_id is not None:
            headers["X-Lakomics-Library-Id"] = library_id
        return self.client.put("/v1/mobile-catalog/publication", headers=headers, json={
            "version": 1, "baseRevision": base_revision, "contentDigest": self.digest,
            "userSnapshot": users if users is not None else self.users})

    def revision(self):
        return self.client.get("/v1/mobile-catalog/status", headers=AUTH).json()["publicationRevision"]

    def activate(self, library_id=LIBRARY, revision=None):
        return self.client.post("/v1/mobile-catalog/bookmark-authority/activate",
                                headers=self.headers(self.publish_token),
                                json={"libraryId": library_id,
                                      "expectedPublicationRevision": self.revision() if revision is None else revision})

    def command(self, provider="kHentai", work_id="1", desired=True, expected_revision=0,
                operation_id=None, library_id=LIBRARY, epoch=1, contract_version=1, extra=None):
        body = {"libraryId": library_id, "epoch": epoch, "contractVersion": contract_version,
                "operationId": operation_id or str(uuid.uuid4()),
                "expectedRevision": expected_revision, "desiredState": desired}
        if extra is not None:
            body = extra
        return self.client.put(f"{MUTATION}/{provider}/{work_id}", headers=AUTH, json=body)

    def authority_cursor(self):
        with self.get_db() as db:
            return db.execute("SELECT change_cursor FROM authority_domains WHERE domain=?",
                              [catalog_bookmarks.DOMAIN]).fetchone()[0]

    def state_row(self, work_id, provider="kHentai"):
        with self.get_db() as db:
            return db.execute(
                "SELECT desired_state,entity_revision,created_at,updated_at FROM catalog_bookmark_state"
                " WHERE provider=? AND work_id=?", [provider, work_id]).fetchone()

    def change_rows(self):
        with self.get_db() as db:
            return [tuple(row) for row in db.execute(
                "SELECT sequence,provider,work_id,desired_state,entity_revision FROM catalog_bookmark_changes"
                " ORDER BY sequence")]

    def receipt_rows(self):
        with self.get_db() as db:
            return [tuple(row) for row in db.execute(
                "SELECT operation_id,payload_digest,work_id,desired_state,expected_revision FROM catalog_bookmark_receipts")]

    def activated(self):
        self.publish()
        self.assertEqual(self.activate().status_code, 200)
        return self.revision()

    # --- 1. auth ---
    def test_mutation_requires_client_auth(self):
        self.activated()
        response = self.client.put(f"{MUTATION}/kHentai/6", headers={}, json={
            "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
            "operationId": str(uuid.uuid4()), "expectedRevision": 0, "desiredState": True})
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.change_rows(), [])

    # --- 2. shape ---
    def test_mutation_rejects_malformed_or_extraneous_commands(self):
        self.activated()
        op = str(uuid.uuid4())
        cases = [
            {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "operationId": op,
             "expectedRevision": 0, "desiredState": True, "extra": 1},
            {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "operationId": op, "expectedRevision": 0},
            {"libraryId": LIBRARY.upper(), "epoch": 1, "contractVersion": 1, "operationId": op,
             "expectedRevision": 0, "desiredState": True},
            {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "operationId": "not-a-uuid",
             "expectedRevision": 0, "desiredState": True},
            {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "operationId": op,
             "expectedRevision": -1, "desiredState": True},
            {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "operationId": op,
             "expectedRevision": True, "desiredState": True},
            {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "operationId": op,
             "expectedRevision": 0, "desiredState": 1},
            {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 2, "operationId": op,
             "expectedRevision": 0, "desiredState": True},
        ]
        for case in cases:
            self.assertEqual(self.command(extra=case).status_code, 422, case)
        self.assertEqual(self.command(provider="mangadex", work_id="1", extra={
            "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "operationId": op,
            "expectedRevision": 0, "desiredState": True}).status_code, 422)
        self.assertEqual(self.command(work_id="", extra={
            "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "operationId": op,
            "expectedRevision": 0, "desiredState": True}).status_code, 404)
        self.assertEqual(self.change_rows(), [])
        self.assertEqual(self.receipt_rows(), [])

    # --- 3/4. authority guards ---
    def test_mutation_rejects_inactive_authority(self):
        self.publish()
        response = self.command()
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.change_rows(), [])

    def test_mutation_rejects_wrong_library_epoch_or_contract(self):
        self.activated()
        self.assertEqual(self.command(library_id=OTHER_LIBRARY).status_code, 409)
        self.assertEqual(self.command(epoch=2).status_code, 409)
        self.assertEqual(self.command(contract_version=2).status_code, 422)
        self.assertEqual(self.change_rows(), [])

    # --- 5. exact text identity ---
    def test_exact_text_identity_remains_distinct(self):
        self.activated()
        # Baseline already carries kHentai/1, kHentai/03 and heliotrope/3; use ids
        # that are absent so the two commands are genuinely independent.
        self.assertEqual(self.command(work_id="7", desired=True, expected_revision=0).status_code, 200)
        self.assertEqual(self.command(work_id="07", desired=True, expected_revision=0).status_code, 200)
        self.assertIsNotNone(self.state_row("7"))
        self.assertIsNotNone(self.state_row("07"))
        self.assertEqual(self.state_row("07")["entity_revision"], 1)
        self.assertEqual([row[2] for row in self.change_rows()], ["7", "07"])
        # A baseline bookmark keeps its identity: "03" is revision 1, not work 3.
        self.assertEqual(self.state_row("03")["entity_revision"], 1)
        self.assertEqual(self.state_row("3"), None)
        self.assertEqual(self.command(work_id="03", desired=True, expected_revision=1).json()["changed"], False)
        # Provider separation: heliotrope/3 is not a kHentai bookmark.
        self.assertIsNone(self.state_row("3", provider="kHentai"))
        self.assertIsNotNone(self.state_row("3", provider="heliotrope"))

    # --- 6. absent false no-op ---
    def test_absent_false_is_an_accepted_no_op_with_a_receipt(self):
        self.activated()
        cursor = self.authority_cursor()
        before_receipts = len(self.receipt_rows())
        response = self.command(work_id="6", desired=False, expected_revision=0)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertFalse(body["changed"])
        self.assertIsNone(body["changeSequence"])
        self.assertEqual(body["entityRevision"], 0)
        self.assertEqual(body["authorityCursor"], cursor)
        self.assertIsNone(body["createdAt"])
        self.assertEqual(body["desiredState"], False)
        self.assertIsNone(self.state_row("6"))
        self.assertEqual(self.change_rows(), [])
        self.assertEqual(self.authority_cursor(), cursor)
        self.assertEqual(len(self.receipt_rows()), before_receipts + 1)

    # --- 7. absent true ---
    def test_absent_true_creates_state_and_advances_the_cursor(self):
        self.activated()
        cursor = self.authority_cursor()
        response = self.command(work_id="6", desired=True, expected_revision=0)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["changed"])
        self.assertEqual(body["entityRevision"], 1)
        self.assertEqual(body["changeSequence"], cursor + 1)
        self.assertEqual(body["authorityCursor"], cursor + 1)
        self.assertIsNotNone(body["createdAt"])
        row = self.state_row("6")
        self.assertEqual(row["desired_state"], 1)
        self.assertEqual(row["entity_revision"], 1)
        self.assertEqual(self.change_rows(), [(cursor + 1, "kHentai", "6", 1, 1)])

    # --- 8. true -> false tombstone ---
    def test_unbookmark_keeps_a_tombstone_and_preserves_created_at(self):
        self.activated()
        created = self.command(work_id="6", desired=True, expected_revision=0).json()
        removed = self.command(work_id="6", desired=False, expected_revision=1)
        self.assertEqual(removed.status_code, 200, removed.text)
        body = removed.json()
        self.assertTrue(body["changed"])
        self.assertEqual(body["entityRevision"], 2)
        self.assertEqual(body["createdAt"], created["createdAt"])
        row = self.state_row("6")
        self.assertIsNotNone(row, "tombstone row must survive")
        self.assertEqual(row["desired_state"], 0)
        self.assertEqual(row["entity_revision"], 2)
        self.assertEqual(row["created_at"], created["createdAt"])
        self.assertEqual([r[3] for r in self.change_rows()], [1, 0])

    # --- 9. re-bookmark resets created_at ---
    def test_rebookmarking_a_tombstone_resets_created_at(self):
        self.activated()
        self.assertEqual(self.command(work_id="6", desired=True, expected_revision=0).status_code, 200)
        self.assertEqual(self.command(work_id="6", desired=False, expected_revision=1).status_code, 200)
        # Acceptance timestamps are second-resolution, so pin an unambiguous past
        # value to prove the reset rather than relying on the wall clock advancing.
        old = "2020-01-01T00:00:00Z"
        with self.get_db() as db:
            db.execute("UPDATE catalog_bookmark_state SET created_at=? WHERE work_id='6'", [old])
            db.commit()
        again = self.command(work_id="6", desired=True, expected_revision=2)
        self.assertEqual(again.status_code, 200, again.text)
        body = again.json()
        self.assertEqual(body["entityRevision"], 3)
        self.assertNotEqual(body["createdAt"], old)
        self.assertEqual(body["createdAt"], body["updatedAt"])
        self.assertEqual(self.state_row("6")["created_at"], body["createdAt"])
        self.assertEqual(self.state_row("6")["desired_state"], 1)

    # --- 10/11. idempotency ---
    def test_same_desired_state_records_only_a_receipt(self):
        self.activated()
        first = self.command(work_id="6", desired=True, expected_revision=0).json()
        cursor = self.authority_cursor()
        receipts = len(self.receipt_rows())
        changes = len(self.change_rows())
        second = self.command(work_id="6", desired=True, expected_revision=1)
        self.assertEqual(second.status_code, 200, second.text)
        body = second.json()
        self.assertFalse(body["changed"])
        self.assertIsNone(body["changeSequence"])
        self.assertEqual(body["entityRevision"], 1)
        self.assertEqual(body["authorityCursor"], cursor)
        self.assertEqual(body["createdAt"], first["createdAt"])
        self.assertEqual(self.authority_cursor(), cursor)
        self.assertEqual(len(self.change_rows()), changes)
        self.assertEqual(len(self.receipt_rows()), receipts + 1)

    def test_identical_retry_returns_the_exact_recorded_result(self):
        self.activated()
        operation = str(uuid.uuid4())
        first = self.command(work_id="6", desired=True, expected_revision=0, operation_id=operation)
        self.assertEqual(first.status_code, 200, first.text)
        cursor = self.authority_cursor()
        receipts = len(self.receipt_rows())
        retry = self.command(work_id="6", desired=True, expected_revision=0, operation_id=operation)
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertEqual(retry.json(), first.json())
        self.assertEqual(self.authority_cursor(), cursor)
        self.assertEqual(len(self.receipt_rows()), receipts)

    def test_same_operation_with_a_different_payload_conflicts(self):
        self.activated()
        operation = str(uuid.uuid4())
        self.assertEqual(self.command(work_id="6", desired=True, expected_revision=0,
                                      operation_id=operation).status_code, 200)
        conflict = self.command(work_id="6", desired=False, expected_revision=1, operation_id=operation)
        self.assertEqual(conflict.status_code, 409, conflict.text)
        self.assertEqual(self.state_row("6")["desired_state"], 1)

    # --- 12/13. revision conflict ---
    def test_stale_expected_revision_is_rejected_without_side_effects(self):
        self.activated()
        self.assertEqual(self.command(work_id="6", desired=True, expected_revision=0).status_code, 200)
        cursor = self.authority_cursor()
        receipts = len(self.receipt_rows())
        changes = len(self.change_rows())
        stale = self.command(work_id="6", desired=False, expected_revision=0)
        self.assertEqual(stale.status_code, 409, stale.text)
        detail = stale.json()["detail"]
        self.assertEqual(detail["code"], "revisionConflict")
        self.assertEqual(detail["current"]["entityRevision"], 1)
        self.assertEqual(detail["current"]["desiredState"], True)
        self.assertEqual(detail["authorityCursor"], cursor)
        self.assertEqual(self.state_row("6")["desired_state"], 1)
        self.assertEqual(self.authority_cursor(), cursor)
        self.assertEqual(len(self.change_rows()), changes)
        self.assertEqual(len(self.receipt_rows()), receipts)

    # --- 14/15/16. sequences and atomicity ---
    def test_accepted_changes_receive_strictly_increasing_sequences(self):
        self.activated()
        start = self.authority_cursor()
        for work_id in ("6", "7", "8"):
            self.assertEqual(self.command(work_id=work_id, desired=True, expected_revision=0).status_code, 200)
        self.assertEqual([row[0] for row in self.change_rows()], [start + 1, start + 2, start + 3])
        self.assertEqual(self.authority_cursor(), start + 3)

    def test_state_receipt_change_and_cursor_are_atomic(self):
        self.activated()
        cursor = self.authority_cursor()
        state_before = self.state_row("1")
        receipts = len(self.receipt_rows())
        with self.get_db() as db:
            # Occupy the sequence the next mutation would allocate so the change
            # insert fails inside the transaction.
            db.execute("INSERT INTO catalog_bookmark_changes VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                       [LIBRARY, 1, cursor + 1, "kHentai", "9", 1, 1, "occupied", None, "now", "now"])
            db.commit()
        with self.assertRaises(Exception):
            self.command(work_id="6", desired=True, expected_revision=0)
        self.assertEqual(self.authority_cursor(), cursor)
        self.assertIsNone(self.state_row("6"))
        self.assertEqual(self.state_row("1"), state_before)
        self.assertEqual(len(self.receipt_rows()), receipts)

    def test_concurrent_commands_do_not_share_a_sequence(self):
        self.activated()
        start = self.authority_cursor()
        work_ids = ["6", "7", "8", "9"]
        errors = []
        barrier = threading.Barrier(len(work_ids))

        def run(work_id):
            with self.get_db() as db:
                try:
                    barrier.wait(timeout=10)
                    db.execute("BEGIN IMMEDIATE")
                    catalog_bookmarks.apply_command(
                        db, library_id=LIBRARY, epoch=1, contract_version=1, provider="kHentai",
                        work_id=work_id, desired_state=True, expected_revision=0,
                        operation_id=str(uuid.uuid4()), now="2026-09-14T00:00:00Z")
                    db.commit()
                except Exception as error:  # noqa: BLE001 - reported below
                    db.rollback()
                    errors.append(error)

        threads = [threading.Thread(target=run, args=(work_id,)) for work_id in work_ids]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        self.assertEqual(errors, [])
        sequences = [row[0] for row in self.change_rows()]
        self.assertEqual(len(sequences), len(set(sequences)), sequences)
        self.assertEqual(sorted(sequences), [start + 1, start + 2, start + 3, start + 4])
        self.assertEqual(self.authority_cursor(), start + 4)

    # --- 17. publication fence sees mutation cursor drift ---
    def test_publication_fence_rejects_drift_caused_by_a_mutation(self):
        before = self.publish().json()["publicationRevision"]
        self.assertEqual(self.activate().status_code, 200)
        original = replica.prepare_users
        fired = []

        def prepare(*args, **kwargs):
            if not fired:
                fired.append(True)
                self.command(work_id="6", desired=True, expected_revision=0)
            return original(*args, **kwargs)

        replica.prepare_users = prepare
        try:
            response = self.publish(base_revision=before)
        finally:
            replica.prepare_users = original
        self.assertTrue(fired, "mutation hook did not run")
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(self.revision(), before)

    # --- 18/19. snapshot read ---
    def test_snapshot_includes_live_rows_and_tombstones(self):
        self.activated()
        self.assertEqual(self.command(work_id="6", desired=True, expected_revision=0).status_code, 200)
        self.assertEqual(self.command(work_id="6", desired=False, expected_revision=1).status_code, 200)
        response = self.client.get(SNAPSHOT, headers=AUTH, params={"libraryId": LIBRARY, "epoch": 1})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["libraryId"], LIBRARY)
        self.assertEqual(body["epoch"], 1)
        self.assertEqual(body["contractVersion"], 1)
        self.assertEqual(body["cursor"], self.authority_cursor())
        items = {(item["provider"], item["workId"]): item for item in body["items"]}
        self.assertIn(("kHentai", "6"), items)
        tombstone = items[("kHentai", "6")]
        self.assertFalse(tombstone["desiredState"])
        self.assertEqual(tombstone["entityRevision"], 2)
        self.assertTrue(tombstone["createdAt"])
        self.assertTrue(tombstone["updatedAt"])
        self.assertIn(("kHentai", "1"), items)
        self.assertTrue(items[("kHentai", "1")]["desiredState"])

    def test_snapshot_ordering_is_deterministic_and_exact_text(self):
        self.activated()
        # "07"/"7" are absent from the baseline; the baseline "03" is compared too.
        for work_id in ("07", "7", "6"):
            self.assertEqual(self.command(work_id=work_id, desired=True, expected_revision=0).status_code, 200)
        body = self.client.get(SNAPSHOT, headers=AUTH, params={"libraryId": LIBRARY, "epoch": 1}).json()
        pairs = [(item["provider"], item["workId"]) for item in body["items"]]
        self.assertEqual(pairs, sorted(pairs))
        self.assertIn(("kHentai", "07"), pairs)
        self.assertIn(("kHentai", "7"), pairs)
        self.assertIn(("kHentai", "03"), pairs)
        self.assertNotEqual([item for item in body["items"] if item["workId"] == "07"],
                            [item for item in body["items"] if item["workId"] == "7"])
        again = self.client.get(SNAPSHOT, headers=AUTH, params={"libraryId": LIBRARY, "epoch": 1}).json()
        self.assertEqual(again["items"], body["items"])

    # --- 20/21/22/23. changes read ---
    def test_changes_after_zero_returns_all_post_baseline_changes(self):
        self.activated()
        for work_id in ("6", "7"):
            self.assertEqual(self.command(work_id=work_id, desired=True, expected_revision=0).status_code, 200)
        body = self.client.get(CHANGES, headers=AUTH,
                               params={"libraryId": LIBRARY, "epoch": 1, "after": 0}).json()
        self.assertEqual([item["workId"] for item in body["items"]], ["6", "7"])
        self.assertEqual([item["sequence"] for item in body["items"]], [1, 2])
        self.assertEqual(body["cursor"], self.authority_cursor())
        self.assertFalse(body["hasMore"])
        self.assertEqual(body["nextAfter"], 2)

    def test_changes_pagination_reports_next_after_and_has_more(self):
        self.activated()
        for work_id in ("6", "7", "8"):
            self.assertEqual(self.command(work_id=work_id, desired=True, expected_revision=0).status_code, 200)
        first = self.client.get(CHANGES, headers=AUTH,
                                params={"libraryId": LIBRARY, "epoch": 1, "after": 0, "limit": 2}).json()
        self.assertEqual([item["workId"] for item in first["items"]], ["6", "7"])
        self.assertTrue(first["hasMore"])
        self.assertEqual(first["nextAfter"], 2)
        second = self.client.get(CHANGES, headers=AUTH, params={
            "libraryId": LIBRARY, "epoch": 1, "after": first["nextAfter"], "limit": 2}).json()
        self.assertEqual([item["workId"] for item in second["items"]], ["8"])
        self.assertFalse(second["hasMore"])
        self.assertEqual(second["nextAfter"], 3)

    def test_changes_at_the_current_cursor_is_an_empty_success(self):
        self.activated()
        self.assertEqual(self.command(work_id="6", desired=True, expected_revision=0).status_code, 200)
        cursor = self.authority_cursor()
        body = self.client.get(CHANGES, headers=AUTH,
                               params={"libraryId": LIBRARY, "epoch": 1, "after": cursor})
        self.assertEqual(body.status_code, 200, body.text)
        self.assertEqual(body.json()["items"], [])
        self.assertFalse(body.json()["hasMore"])
        self.assertEqual(body.json()["nextAfter"], cursor)

    def test_changes_beyond_the_cursor_is_rejected(self):
        self.activated()
        response = self.client.get(CHANGES, headers=AUTH,
                                   params={"libraryId": LIBRARY, "epoch": 1,
                                           "after": self.authority_cursor() + 5})
        self.assertEqual(response.status_code, 409, response.text)

    def test_read_endpoints_reject_wrong_library_or_epoch(self):
        self.activated()
        for params in ({"libraryId": OTHER_LIBRARY, "epoch": 1}, {"libraryId": LIBRARY, "epoch": 2}):
            self.assertEqual(self.client.get(SNAPSHOT, headers=AUTH, params=params).status_code, 409, params)
            self.assertEqual(self.client.get(CHANGES, headers=AUTH, params=params).status_code, 409, params)
        self.assertEqual(self.client.get(SNAPSHOT, headers=AUTH,
                                        params={"libraryId": LIBRARY, "epoch": 1, "limit": 10}).status_code, 422)
        self.assertEqual(self.client.get(CHANGES, headers=AUTH,
                                        params={"libraryId": LIBRARY, "epoch": 1, "after": -1}).status_code, 422)
        self.assertEqual(self.client.get(CHANGES, headers=AUTH,
                                        params={"libraryId": LIBRARY, "epoch": 1, "limit": 0}).status_code, 422)
        self.assertEqual(self.client.get(CHANGES, headers=AUTH,
                                        params={"libraryId": LIBRARY, "epoch": 1, "limit": 501}).status_code, 422)

    def test_read_endpoints_do_not_modify_authority_state(self):
        self.activated()
        self.assertEqual(self.command(work_id="6", desired=True, expected_revision=0).status_code, 200)
        with self.get_db() as db:
            rows = [tuple(row) for row in db.execute("SELECT * FROM catalog_bookmark_state ORDER BY provider,work_id")]
            domain = [tuple(row) for row in db.execute("SELECT * FROM authority_domains")]
            changes = [tuple(row) for row in db.execute("SELECT * FROM catalog_bookmark_changes ORDER BY sequence")]
        for _ in range(3):
            self.client.get(SNAPSHOT, headers=AUTH, params={"libraryId": LIBRARY, "epoch": 1})
            self.client.get(CHANGES, headers=AUTH, params={"libraryId": LIBRARY, "epoch": 1, "after": 0})
        with self.get_db() as db:
            self.assertEqual([tuple(row) for row in db.execute("SELECT * FROM catalog_bookmark_state ORDER BY provider,work_id")], rows)
            self.assertEqual([tuple(row) for row in db.execute("SELECT * FROM authority_domains")], domain)
            self.assertEqual([tuple(row) for row in db.execute("SELECT * FROM catalog_bookmark_changes ORDER BY sequence")], changes)

    # --- 24. capability ---
    def test_bookmark_write_capability_enables_after_activation(self):
        self.activated()
        status = self.client.get("/v1/mobile-catalog/status", headers=AUTH).json()
        self.assertTrue(status["capabilities"]["bookmarkWrite"])


class AuthorizationRoleTests(MutationFixture):
    """The publisher/client boundary. The legacy shared token is client-only."""

    def test_legacy_shared_token_reads_and_mutates_but_cannot_publish(self):
        self.activated()
        # The legacy credential keeps working for its real job: reading and
        # ordinary user bookmark mutations.
        self.assertEqual(self.command(work_id="6", desired=True, expected_revision=0).status_code, 200)
        self.assertEqual(self.client.get(SNAPSHOT, headers=AUTH,
                                        params={"libraryId": LIBRARY, "epoch": 1}).status_code, 200)
        # It must not carry publisher authority. This is the inversion B8.1 removes.
        self.assertEqual(self.client.put("/v1/mobile-catalog/replicas/" + self.digest,
                                        headers=AUTH, content=self.data).status_code, 401)
        self.assertEqual(self.client.put("/v1/mobile-catalog/publication", headers=AUTH, json={
            "version": 1, "baseRevision": self.revision(), "contentDigest": self.digest,
            "userSnapshot": self.users}).status_code, 401)
        # Activation with the legacy credential itself, not the publisher helper.
        self.assertEqual(self.client.post("/v1/mobile-catalog/bookmark-authority/activate",
                                         headers=AUTH, json={
                                             "libraryId": LIBRARY,
                                             "expectedPublicationRevision": self.revision()}).status_code, 401)

    def test_publisher_credential_owns_the_publisher_routes(self):
        baseline = self.activated()
        # Activation is one-time: an identical retry of the original baseline is
        # accepted after the response was lost, but activating against a *moved*
        # publication is refused. Bookmark edits no longer move the revision once
        # authority is active (the fence holds them), so move a non-fenced field.
        users = copy.deepcopy(self.users)
        users["hiddenCategories"] = sorted(users["hiddenCategories"] + [[7, "now"]],
                                          key=replica.encode)
        self.assertEqual(self.publish(base_revision=self.revision(), users=users).status_code, 200)
        self.assertNotEqual(self.revision(), baseline, "the publication must have moved")
        self.assertEqual(self.activate(revision=baseline).status_code, 200)
        self.assertEqual(self.activate(revision=self.revision()).status_code, 409)

    def test_injected_client_token_can_read_and_mutate(self):
        self.activated()
        self.add_client("client-token", "client")
        headers = self.headers("client-token")
        self.assertEqual(self.client.get("/v1/mobile-catalog/status", headers=headers).status_code, 200)
        self.assertEqual(self.client.get(SNAPSHOT, headers=headers,
                                        params={"libraryId": LIBRARY, "epoch": 1}).status_code, 200)
        response = self.client.put(f"{MUTATION}/kHentai/6", headers=headers, json={
            "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
            "operationId": str(uuid.uuid4()), "expectedRevision": 0, "desiredState": True})
        self.assertEqual(response.status_code, 200, response.text)

    def test_client_token_cannot_publish_upload_or_activate(self):
        self.activated()
        self.add_client("client-token", "client")
        headers = self.headers("client-token")
        self.assertEqual(self.client.post("/v1/mobile-catalog/bookmark-authority/activate", headers=headers,
                                         json={"libraryId": LIBRARY,
                                               "expectedPublicationRevision": self.revision()}).status_code, 401)
        self.assertEqual(self.client.put("/v1/mobile-catalog/publication", headers=headers, json={
            "version": 1, "baseRevision": self.revision(), "contentDigest": self.digest,
            "userSnapshot": self.users}).status_code, 401)
        self.assertEqual(self.client.put("/v1/mobile-catalog/replicas/" + self.digest,
                                        headers=headers, content=self.data).status_code, 401)

    def test_publisher_token_uses_publisher_and_client_routes(self):
        self.activated()
        self.add_client("publisher-token", "publisher")
        headers = self.headers("publisher-token")
        self.assertEqual(self.client.get("/v1/mobile-catalog/status", headers=headers).status_code, 200)
        self.assertEqual(self.client.put(f"{MUTATION}/kHentai/7", headers=headers, json={
            "libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
            "operationId": str(uuid.uuid4()), "expectedRevision": 0, "desiredState": True}).status_code, 200)
        self.assertEqual(self.client.put("/v1/mobile-catalog/replicas/" + self.digest,
                                        headers=headers, content=self.data).status_code, 200)
        # A publisher row may publish, but must still identify its library.
        publish_headers = dict(headers, **{"X-Lakomics-Library-Id": LIBRARY})
        self.assertEqual(self.client.put("/v1/mobile-catalog/publication", headers=publish_headers, json={
            "version": 1, "baseRevision": self.revision(), "contentDigest": self.digest,
            "userSnapshot": self.users}).status_code, 200)

    def test_revoked_clients_are_rejected(self):
        self.activated()
        self.add_client("revoked-client", "client", revoked=True)
        self.add_client("revoked-publisher", "publisher", revoked=True)
        for token in ("revoked-client", "revoked-publisher"):
            self.assertEqual(self.client.get("/v1/mobile-catalog/status",
                                            headers=self.headers(token)).status_code, 401, token)
        self.assertEqual(self.client.put("/v1/mobile-catalog/publication",
                                         headers=self.headers("revoked-publisher"), json={
            "version": 1, "baseRevision": self.revision(), "contentDigest": self.digest,
            "userSnapshot": self.users}).status_code, 401)

    def test_legacy_shared_token_cannot_satisfy_the_publisher_guard(self):
        # Direct guard check, so the boundary is pinned independently of any route.
        with self.assertRaises(HTTPException) as caught:
            self.publisher_guard(AUTH["Authorization"])
        self.assertEqual(caught.exception.status_code, 401)
        # The same credential still satisfies the client guard.
        self.assertEqual(self.client_guard(AUTH["Authorization"]), api_auth.LEGACY_CLIENT)

    def test_extension_credentials_do_not_grant_catalog_access(self):
        self.activated()
        with self.get_db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS extension_clients("
                       "id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,"
                       " last_seen_at TEXT, revoked_at TEXT)")
            db.execute("INSERT INTO extension_clients VALUES('ext-1',?, '2026-09-14T00:00:00Z', NULL, NULL)",
                       [api_auth.token_hash("extension-token")])
            db.commit()
        self.assertEqual(self.client.get("/v1/mobile-catalog/status",
                                        headers=self.headers("extension-token")).status_code, 401)
        self.assertEqual(self.client.put("/v1/mobile-catalog/publication",
                                         headers=self.headers("extension-token"), json={
            "version": 1, "baseRevision": self.revision(), "contentDigest": self.digest,
            "userSnapshot": self.users}).status_code, 401)
        # extension_clients remains a separate boundary; it must not satisfy the
        # catalog client guard.
        with self.assertRaises(HTTPException):
            self.client_guard(self.headers("extension-token")["Authorization"])


if __name__ == "__main__":
    unittest.main()
