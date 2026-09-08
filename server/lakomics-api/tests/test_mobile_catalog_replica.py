import copy
import hashlib
import json
import unittest
from unittest import mock
from tests import test_mobile_catalog as base
AUTH = base.AUTH

class MobileCatalogReplicaTests(unittest.TestCase):
    setUp = base.MobileCatalogApiTests.setUp
    tearDown = base.MobileCatalogApiTests.tearDown
    publish = base.MobileCatalogApiTests.publish
    search = base.MobileCatalogApiTests.search
    def test_idempotent_publish_and_stale_base_preserve_current(self):
        first = self.publish()
        self.assertEqual(first.status_code, 200, first.text)
        again = self.publish()
        self.assertEqual(first.json(), again.json())
        users = copy.deepcopy(self.users); users["bookmarks"] = []
        conflict = self.publish(None, users)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(self.client.get("/v1/mobile-catalog/status", headers=AUTH).json()["publicationRevision"], first.json()["publicationRevision"])
    def test_invalid_uploads_leave_previous_publication_readable(self):
        self.publish()
        for data, digest in [(self.data[:-5], self.digest), (b'{"kind":"sql","value":"DROP TABLE Works"}\n', "a" * 64), (self.data, "b" * 64)]:
            response = self.client.put("/v1/mobile-catalog/replicas/" + digest, headers=AUTH, content=data)
            self.assertEqual(response.status_code, 422, response.text)
            self.assertEqual(len(self.search().json()["items"]), 3)
    def test_decision_mismatch_does_not_reset_user_data(self):
        prior = self.publish().json()["publicationRevision"]
        users = copy.deepcopy(self.users)
        users["decisions"] = [["1", "2", "split", "manual", "now", "kHentai"]]
        import mobile_catalog_replica as replica
        users["decisionRevision"] = replica.digest(users["decisions"])
        response = self.publish(prior, users)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.client.get("/v1/mobile-catalog/status", headers=AUTH).json()["publicationRevision"], prior)
    def test_unknown_private_field_and_duplicate_rows_rejected(self):
        self.publish()
        users = copy.deepcopy(self.users); users["localPath"] = "private"
        self.assertEqual(self.publish(None, users).status_code, 422)
        records = [json.loads(line) for line in self.data.splitlines()]
        records.append(records[1]); records[0]["value"]["counts"]["work"] += 1
        from mobile_catalog_replica import encode
        data = b"".join((encode(r) + "\n").encode() for r in records)
        response = self.client.put("/v1/mobile-catalog/replicas/" + hashlib.sha256(data).hexdigest(), headers=AUTH, content=data)
        self.assertEqual(response.status_code, 422)
    def test_content_rollback_requires_latest_user_snapshot(self):
        first = self.publish().json()["publicationRevision"]
        original_data, original_digest = self.data, self.digest
        records = [json.loads(line) for line in self.data.splitlines()]
        records[0]["value"]["sourceRevision"] = "fixture-v2"
        from mobile_catalog_replica import encode
        self.data = b"".join((encode(r) + "\n").encode() for r in records)
        self.digest = hashlib.sha256(self.data).hexdigest()
        newer_users = copy.deepcopy(self.users); newer_users["bookmarks"] = []
        second = self.publish(first, newer_users).json()["publicationRevision"]
        self.data, self.digest = original_data, original_digest
        self.assertEqual(self.publish(second, self.users).status_code, 409)
        rollback = self.publish(second, newer_users)
        self.assertEqual(rollback.status_code, 200, rollback.text)
        page = self.search(scope="bookmarked").json()
        self.assertEqual(page["items"], [])
    def test_fractional_rating_survives_import_publication_and_detail(self):
        records = [json.loads(line) for line in self.data.splitlines()]
        for record in records:
            if record["kind"] == "work" and record["value"]["Id"] == 1:
                record["value"]["Rating"] = 4.5
        from mobile_catalog_replica import encode
        self.data = b"".join((encode(r) + "\n").encode() for r in records)
        self.digest = hashlib.sha256(self.data).hexdigest()
        response = self.publish()
        self.assertEqual(response.status_code, 200, response.text)
        page = self.search().json()
        detail = self.client.get('/v1/mobile-catalog/works/kHentai/1', headers=AUTH, params={"context": page["context"]})
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json()["item"]["rating"], 4.5)
