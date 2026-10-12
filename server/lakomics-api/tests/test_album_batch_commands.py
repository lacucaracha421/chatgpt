"""Album membership batch route: per-command results inside one transaction.

The batch is a transport convenience. Every command keeps its own receipt, change row and
compare-and-set; these tests pin that a refused command never takes the others down, that a
retry after a lost reply is exactly-once, and that a malformed batch writes nothing.
"""
import copy
import sys
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import album_authority
import command_batch
from tests import test_album_authority as base

LIBRARY = base.LIBRARY
ASSET, ASSET2, ASSET3 = base.ASSET, base.ASSET2, base.ASSET3
BATCH = "/v1/albums/commands/batch"
MEMBERSHIP = album_authority.MEMBERSHIP


def op():
    return str(uuid.uuid4())


def member(album_id, asset_id, desired, revision, operation_id=None):
    return {"operationId": operation_id or op(), "commandType": MEMBERSHIP, "albumId": album_id,
            "assetId": asset_id, "desiredState": desired, "expectedRevision": revision}


class AlbumBatchTests(base.AlbumAuthorityFixture):
    def setUp(self):
        super().setUp()
        self.publish()
        self.activate()

    def batch(self, listed, headers=None, **envelope):
        body = {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1, "batchId": op(),
                "commands": listed}
        body.update(envelope)
        return self.client.put(BATCH, headers=self.client_auth if headers is None else headers,
                               json=body)

    def receipt_count(self):
        with self.get_db() as db:
            return db.execute("SELECT COUNT(*) FROM album_authority_receipts").fetchone()[0]

    def test_all_commands_apply_with_their_own_sequences(self):
        response = self.batch([member("other", ASSET, True, 0),
                               member("other", ASSET2, True, 0),
                               member("root", ASSET, False, 1)])
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual([item["status"] for item in body["results"]], ["applied"] * 3)
        self.assertEqual([item["changed"] for item in body["results"]], [True] * 3)
        self.assertEqual([item["changeSequence"] for item in body["results"]], [1, 2, 3])
        self.assertEqual(body["authorityCursor"], 3)
        self.assertEqual(body["results"][0]["membership"], {
            "albumId": "other", "assetId": ASSET, "desiredState": True, "entityRevision": 1})
        self.assertEqual(body["results"][2]["membership"]["desiredState"], False)
        self.assertEqual(self.cursor(), 3)
        self.assertEqual([row[1:4] for row in self.change_rows()],
                         [(MEMBERSHIP, "other", ASSET), (MEMBERSHIP, "other", ASSET2),
                          (MEMBERSHIP, "root", ASSET)])
        self.assertIn(("other", ASSET2, 1, 1), self.member_rows())
        self.assertIn(("root", ASSET, 0, 2), self.member_rows())

    def test_a_stale_revision_conflicts_alone_and_the_rest_apply(self):
        self.batch([member("other", ASSET3, True, 0)])  # revision of other/ASSET3 is now 1
        response = self.batch([member("other", ASSET, True, 0),
                               member("other", ASSET3, False, 0),       # stale: it is at 1
                               member("other", ASSET2, True, 0)])
        self.assertEqual(response.status_code, 200, response.text)
        results = response.json()["results"]
        self.assertEqual([item["status"] for item in results], ["applied", "conflict", "applied"])
        conflict = results[1]
        self.assertEqual(conflict["error"]["code"], "revisionConflict")
        self.assertEqual(conflict["error"]["status"], 409)
        self.assertEqual(conflict["error"]["current"], {
            "albumId": "other", "assetId": ASSET3, "desiredState": True, "entityRevision": 1})
        self.assertFalse(conflict["changed"])
        self.assertIsNone(conflict["changeSequence"])
        self.assertIn(("other", ASSET3, 1, 1), self.member_rows())
        self.assertEqual(response.json()["authorityCursor"], self.cursor())
        self.assertEqual(self.cursor(), 3)

    def test_a_matching_state_is_a_noop_without_a_change_row(self):
        response = self.batch([member("child", ASSET, True, 0)])  # already a member at revision 1
        item = response.json()["results"][0]
        self.assertEqual(item["status"], "noop")
        self.assertFalse(item["changed"])
        self.assertIsNone(item["changeSequence"])
        self.assertEqual(item["membership"]["entityRevision"], 1)
        self.assertEqual(self.change_rows(), [])
        self.assertEqual(self.receipt_count(), 1)

    def test_tombstoned_assets_and_unknown_albums_are_rejected_per_command(self):
        base.activate_asset_lifecycle(self.get_db, LIBRARY, {ASSET: "normal", ASSET2: "tombstoned",
                                                             ASSET3: "normal"})
        response = self.batch([member("other", ASSET2, True, 0),
                               member("missing", ASSET, True, 0),
                               member("other", ASSET3, True, 0)])
        self.assertEqual(response.status_code, 200, response.text)
        results = response.json()["results"]
        self.assertEqual([item["status"] for item in results], ["rejected", "rejected", "applied"])
        self.assertEqual(results[0]["error"]["code"], "assetTombstoned")
        self.assertEqual(results[0]["error"]["assetId"], ASSET2)
        self.assertEqual(results[1]["error"]["code"], "albumNotFound")
        self.assertEqual(results[1]["error"]["status"], 404)
        self.assertEqual(self.member_rows().count(("other", ASSET3, 1, 1)), 1)
        self.assertEqual([row[3] for row in self.change_rows()], [ASSET3])
        # A refused command leaves no receipt, so only the applied one is recorded.
        self.assertEqual(self.receipt_count(), 1)

    def test_replay_after_a_lost_reply_is_exactly_once(self):
        commands = [member("other", ASSET, True, 0), member("other", ASSET2, True, 0),
                    member("child", ASSET, True, 0)]
        envelope = {"batchId": op()}
        first = self.batch(commands, **envelope).json()
        rows = (self.change_rows(), self.member_rows(), self.receipt_count(), self.cursor())
        replay = self.batch(copy.deepcopy(commands), **envelope).json()
        self.assertEqual(replay, first)
        # A new batch id with the same operations is the same retry: receipts, not the batch, dedupe.
        again = self.batch(copy.deepcopy(commands)).json()
        self.assertEqual(again["results"], first["results"])
        self.assertEqual((self.change_rows(), self.member_rows(), self.receipt_count(),
                          self.cursor()), rows)

    def test_a_reused_operation_id_with_another_payload_conflicts_for_that_command_only(self):
        reused = op()
        self.assertEqual(self.batch([member("other", ASSET, True, 0, reused)]).status_code, 200)
        response = self.batch([member("other", ASSET2, True, 0, reused),
                               member("other", ASSET3, True, 0)])
        results = response.json()["results"]
        self.assertEqual([item["status"] for item in results], ["rejected", "applied"])
        self.assertEqual(results[0]["error"]["code"], "operationConflict")
        self.assertEqual(results[0]["error"]["status"], 409)
        self.assertNotIn(("other", ASSET2, 1, 1), self.member_rows())

    def test_a_leading_ensure_likes_designates_the_album_for_the_memberships(self):
        ensure = {"operationId": op(), "commandType": album_authority.ENSURE_LIKES,
                  "albumId": "likes-album"}
        response = self.batch([ensure, member("likes-album", ASSET, True, 0),
                               member("likes-album", ASSET2, True, 0)])
        self.assertEqual(response.status_code, 200, response.text)
        results = response.json()["results"]
        self.assertEqual([item["status"] for item in results], ["applied"] * 3)
        self.assertEqual(results[0]["album"]["name"], album_authority.LIKES_NAME)
        self.assertEqual(results[0]["album"]["id"], "likes-album")
        self.assertEqual(self.member_rows().count(("likes-album", ASSET, 1, 1)), 1)

    def test_a_malformed_or_oversized_batch_writes_nothing(self):
        valid = member("other", ASSET, True, 0)
        extra = dict(member("other", ASSET2, True, 0), unexpected=1)
        missing = {key: value for key, value in member("other", ASSET2, True, 0).items()
                   if key != "desiredState"}
        carries_scope = dict(member("other", ASSET2, True, 0), libraryId=LIBRARY)
        duplicate = member("other", ASSET2, True, 0, valid["operationId"])
        structural = {"operationId": op(), "commandType": album_authority.DELETE,
                      "albumId": "other", "expectedRevision": 1}
        late_ensure = {"operationId": op(), "commandType": album_authority.ENSURE_LIKES,
                       "albumId": "late"}
        cases = {
            "empty": [], "extra key": [valid, extra], "missing key": [valid, missing],
            "scope in command": [valid, carries_scope], "duplicate operation": [valid, duplicate],
            "structural command": [valid, structural], "ensure not first": [valid, late_ensure],
            "not an object": [valid, "x"],
            "over the limit": [member("other", f"a{i}", True, 0)
                               for i in range(command_batch.MAX_COMMANDS + 1)],
        }
        for name, commands in cases.items():
            response = self.batch(commands)
            self.assertEqual(response.status_code, 422, f"{name}: {response.text}")
        self.assertEqual(self.batch([valid], batchId="not-a-uuid").status_code, 422)
        self.assertEqual(self.batch([valid], commands="nope").status_code, 422)
        self.assertEqual(self.batch([valid], surprise=True).status_code, 422)
        self.assertEqual(self.change_rows(), [])
        self.assertEqual(self.member_rows(), [("child", ASSET, 1, 1), ("root", ASSET, 1, 1)])
        self.assertEqual(self.receipt_count(), 0)
        self.assertEqual(self.cursor(), 0)

    def test_exactly_the_limit_is_accepted_and_an_oversized_body_is_refused(self):
        at_limit = [member("other", f"asset-{i}", True, 0) for i in range(command_batch.MAX_COMMANDS)]
        with self.get_db() as db:
            db.executemany("INSERT OR IGNORE INTO assets(id,committed) VALUES(?,1)",
                           [(f"asset-{i}",) for i in range(command_batch.MAX_COMMANDS)])
            db.commit()
        response = self.batch(at_limit)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()["results"]), command_batch.MAX_COMMANDS)
        self.assertEqual(self.cursor(), command_batch.MAX_COMMANDS)
        padded = self.client.put(BATCH, headers=self.client_auth, content=b" " * (65 * 1024))
        self.assertEqual(padded.status_code, 413)

    def test_identity_errors_refuse_the_whole_request(self):
        for envelope, status, code in (
                ({"epoch": 2}, 409, "authorityLibraryMismatch"),
                ({"libraryId": base.OTHER_LIBRARY}, 409, "authorityLibraryMismatch"),
                ({"contractVersion": 2}, 409, "authorityContractUnsupported")):
            response = self.batch([member("other", ASSET, True, 0)], **envelope)
            self.assertEqual(response.status_code, status, response.text)
            self.assertEqual(response.json()["detail"]["code"], code)
        self.assertEqual(self.change_rows(), [])

    def test_a_bearer_token_is_required_and_the_route_is_put_only(self):
        self.assertEqual(self.batch([member("other", ASSET, True, 0)], headers={}).status_code, 401)
        self.assertEqual(self.batch([member("other", ASSET, True, 0)],
                                    headers={"Authorization": "Bearer nope"}).status_code, 401)
        self.assertEqual(self.client.get(BATCH, headers=self.client_auth).status_code, 405)
        self.assertEqual(self.change_rows(), [])

    def test_the_single_route_keeps_working_beside_the_batch(self):
        self.batch([member("other", ASSET, True, 0)])
        single = self.command(MEMBERSHIP, op(), album_id="other", assetId=ASSET2,
                              desiredState=True, expectedRevision=0)
        self.assertEqual(single.status_code, 200, single.text)
        self.assertEqual(single.json()["changeSequence"], 2)


if __name__ == "__main__":
    unittest.main()
