"""Classification assignment batch route: per-command results inside one transaction.

Only ``setAssetClassification`` is batchable. Each command keeps its own receipt, change row
and compare-and-set, so a refused command never takes the others down and a retry after a
lost reply is exactly-once.
"""
import copy
import sys
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import classification_authority
import command_batch
from tests import test_classification_authority as base

LIBRARY = base.LIBRARY
ROOT, WORK, TAG = base.ROOT, base.WORK, base.TAG
ASSET, ASSET2, ASSET3 = base.ASSET, base.ASSET2, base.ASSET3
BATCH = "/v1/classifications/authority/commands/batch"
ASSIGNMENT = classification_authority.ASSIGNMENT


def op():
    return str(uuid.uuid4())


def assign(asset_id, classification_id, revision, operation_id=None):
    return {"operationId": operation_id or op(), "commandType": ASSIGNMENT, "assetId": asset_id,
            "classificationId": classification_id, "expectedRevision": revision}


class ClassificationBatchTests(base.ClassificationAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.activate()

    def batch(self, listed, headers=None, **envelope):
        body = {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "batchId": op(),
                "commands": listed}
        body.update(envelope)
        return self.client.put(BATCH, headers=self.auth if headers is None else headers,
                               json=body)

    def assignment_rows(self):
        with self.get_db() as db:
            return [tuple(row) for row in db.execute(
                "SELECT asset_id,classification_id,entity_revision"
                " FROM classification_authority_assignments ORDER BY asset_id")]

    def change_rows(self):
        with self.get_db() as db:
            return [tuple(row) for row in db.execute(
                "SELECT sequence,command_type,asset_id,entity_revision"
                " FROM classification_authority_changes ORDER BY sequence")]

    def receipt_count(self):
        with self.get_db() as db:
            return db.execute(
                "SELECT COUNT(*) FROM classification_authority_receipts").fetchone()[0]

    def cursor(self):
        with self.get_db() as db:
            return db.execute("SELECT change_cursor FROM authority_domains WHERE domain=?",
                              [classification_authority.DOMAIN]).fetchone()[0]

    def test_all_commands_apply_with_their_own_sequences(self):
        response = self.batch([assign(ASSET, WORK, 0), assign(ASSET2, TAG, 0),
                               assign(ASSET3, ROOT, 0)])
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual([item["status"] for item in body["results"]], ["applied"] * 3)
        self.assertEqual([item["changeSequence"] for item in body["results"]], [1, 2, 3])
        self.assertEqual(body["authorityCursor"], 3)
        self.assertEqual(body["results"][1]["assignment"], {
            "assetId": ASSET2, "classificationId": TAG, "entityRevision": 1})
        self.assertEqual(self.assignment_rows(),
                         [(ASSET, WORK, 1), (ASSET2, TAG, 1), (ASSET3, ROOT, 1)])
        self.assertEqual(self.cursor(), 3)
        self.assertEqual(len(self.change_rows()), 3)

    def test_clearing_and_moving_within_one_batch(self):
        self.batch([assign(ASSET, WORK, 0), assign(ASSET2, WORK, 0)])
        response = self.batch([assign(ASSET, None, 1), assign(ASSET2, TAG, 1)])
        self.assertEqual([item["status"] for item in response.json()["results"]],
                         ["applied", "applied"])
        self.assertEqual(self.assignment_rows(), [(ASSET, None, 2), (ASSET2, TAG, 2)])

    def test_a_stale_revision_conflicts_alone_and_the_rest_apply(self):
        self.batch([assign(ASSET2, WORK, 0)])
        response = self.batch([assign(ASSET, TAG, 0),
                               assign(ASSET2, TAG, 0),        # stale: it is at revision 1
                               assign(ASSET3, TAG, 0)])
        self.assertEqual(response.status_code, 200, response.text)
        results = response.json()["results"]
        self.assertEqual([item["status"] for item in results], ["applied", "conflict", "applied"])
        self.assertEqual(results[1]["error"]["code"], "revisionConflict")
        self.assertEqual(results[1]["error"]["current"], {
            "assetId": ASSET2, "classificationId": WORK, "entityRevision": 1})
        self.assertEqual(self.assignment_rows(),
                         [(ASSET, TAG, 1), (ASSET2, WORK, 1), (ASSET3, TAG, 1)])
        self.assertEqual(self.cursor(), 3)

    def test_a_matching_value_is_a_noop_without_a_change_row(self):
        self.batch([assign(ASSET, WORK, 0)])
        before = self.change_rows()
        item = self.batch([assign(ASSET, WORK, 1)]).json()["results"][0]
        self.assertEqual(item["status"], "noop")
        self.assertIsNone(item["changeSequence"])
        self.assertEqual(self.change_rows(), before)

    def test_tombstoned_assets_and_unknown_classifications_are_rejected_per_command(self):
        base.activate_asset_lifecycle(self.get_db, LIBRARY, {ASSET: "normal", ASSET2: "tombstoned",
                                                             ASSET3: "normal"})
        response = self.batch([assign(ASSET2, WORK, 0),
                               assign(ASSET, "10000000-0000-4000-8000-0000000000ff", 0),
                               assign(ASSET3, WORK, 0)])
        results = response.json()["results"]
        self.assertEqual([item["status"] for item in results], ["rejected", "rejected", "applied"])
        self.assertEqual(results[0]["error"]["code"], "assetTombstoned")
        self.assertEqual(results[0]["error"]["status"], 409)
        self.assertEqual(results[1]["error"]["code"], "classificationNotFound")
        self.assertEqual(self.assignment_rows(), [(ASSET3, WORK, 1)])
        self.assertEqual(self.receipt_count(), 1)

    def test_replay_after_a_lost_reply_is_exactly_once(self):
        commands = [assign(ASSET, WORK, 0), assign(ASSET2, TAG, 0), assign(ASSET3, WORK, 0)]
        envelope = {"batchId": op()}
        first = self.batch(commands, **envelope).json()
        rows = (self.change_rows(), self.assignment_rows(), self.receipt_count(), self.cursor())
        self.assertEqual(self.batch(copy.deepcopy(commands), **envelope).json(), first)
        again = self.batch(copy.deepcopy(commands)).json()
        self.assertEqual(again["results"], first["results"])
        self.assertEqual((self.change_rows(), self.assignment_rows(), self.receipt_count(),
                          self.cursor()), rows)

    def test_a_reused_operation_id_with_another_payload_conflicts_for_that_command_only(self):
        reused = op()
        self.assertEqual(self.batch([assign(ASSET, WORK, 0, reused)]).status_code, 200)
        results = self.batch([assign(ASSET2, WORK, 0, reused), assign(ASSET3, WORK, 0)]
                             ).json()["results"]
        self.assertEqual([item["status"] for item in results], ["rejected", "applied"])
        self.assertEqual(results[0]["error"]["code"], "operationConflict")
        self.assertEqual(self.assignment_rows(), [(ASSET, WORK, 1), (ASSET3, WORK, 1)])

    def test_a_malformed_batch_writes_nothing(self):
        valid = assign(ASSET, WORK, 0)
        extra = dict(assign(ASSET2, WORK, 0), unexpected=1)
        missing = {key: value for key, value in assign(ASSET2, WORK, 0).items()
                   if key != "expectedRevision"}
        structural = {"operationId": op(), "commandType": classification_authority.RENAME,
                      "classificationId": WORK, "name": "x", "expectedRevision": 1}
        create = {"operationId": op(), "commandType": classification_authority.CREATE,
                  "classificationId": op(), "kind": "root", "name": "새 폴더", "parentId": None,
                  "iconKey": None, "colorKey": None}
        cases = {
            "extra key": [valid, extra], "missing key": [valid, missing],
            "rename in a batch": [valid, structural], "create in a batch": [valid, create],
        }
        for name, commands in cases.items():
            response = self.batch(commands)
            self.assertEqual(response.status_code, 422, f"{name}: {response.text}")
        self.assertEqual(self.assignment_rows(), [])
        self.assertEqual(self.change_rows(), [])
        self.assertEqual(self.receipt_count(), 0)
        self.assertEqual(self.cursor(), 0)

    def test_exactly_the_limit_is_accepted_and_an_oversized_body_is_refused(self):
        ids = [f"asset-{i}" for i in range(command_batch.MAX_COMMANDS)]
        with self.get_db() as db:
            db.executemany("INSERT OR IGNORE INTO assets(id,committed) VALUES(?,1)",
                           [(asset_id,) for asset_id in ids])
            db.commit()
        response = self.batch([assign(asset_id, WORK, 0) for asset_id in ids])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.cursor(), command_batch.MAX_COMMANDS)
        padded = self.client.put(BATCH, headers=self.auth, content=b" " * (65 * 1024))
        self.assertEqual(padded.status_code, 413)

    def test_identity_errors_refuse_the_whole_request(self):
        for envelope, code in (({"epoch": 2}, "authorityLibraryMismatch"),
                               ({"libraryId": base.OTHER_LIBRARY}, "authorityLibraryMismatch"),
                               ({"contractVersion": 2}, "authorityContractUnsupported")):
            response = self.batch([assign(ASSET, WORK, 0)], **envelope)
            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()["detail"]["code"], code)
        self.assertEqual(self.change_rows(), [])

    def test_a_client_credential_suffices_and_none_is_refused(self):
        self.assertEqual(self.batch([assign(ASSET, WORK, 0)]).status_code, 200)
        self.assertEqual(self.batch([assign(ASSET2, WORK, 0)], headers={}).status_code, 401)
        self.assertEqual(self.batch([assign(ASSET2, WORK, 0)],
                                    headers={"Authorization": "Bearer nope"}).status_code, 401)
        self.assertEqual(self.client.get(BATCH, headers=self.auth).status_code, 405)
        self.assertEqual(self.assignment_rows(), [(ASSET, WORK, 1)])

    def test_the_single_route_keeps_working_beside_the_batch(self):
        self.batch([assign(ASSET, WORK, 0)])
        single = self.command(ASSIGNMENT, op(), assetId=ASSET2, classificationId=WORK,
                              expectedRevision=0)
        self.assertEqual(single.status_code, 200, single.text)
        self.assertEqual(single.json()["changeSequence"], 2)


if __name__ == "__main__":
    unittest.main()
