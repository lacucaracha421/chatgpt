import json
import statistics
import time
import unittest
import uuid

from tests.test_catalog_bookmark_mutations import MutationFixture, AUTH, LIBRARY
import manga_index
import mobile_catalog_replica as replica
from mobile_catalog import normalize


class MangaIndexTests(unittest.TestCase):
    setUp = MutationFixture.setUp
    tearDown = MutationFixture.tearDown
    add_client = MutationFixture.add_client
    headers = MutationFixture.headers
    publish = MutationFixture.publish
    revision = MutationFixture.revision
    activate = MutationFixture.activate
    activated = MutationFixture.activated
    command = MutationFixture.command

    def put(self, desired=True, expected=0, value="tag", label="태그", operation=None, **extra):
        body = {"libraryId": LIBRARY, "epoch": 1, "contractVersion": 1,
                "operationId": operation or str(uuid.uuid4()), "expectedRevision": expected,
                "desiredState": desired, "value": value, "label": label, **extra}
        return self.client.put(manga_index.PREFIX + "/pins/tag/female", headers=AUTH, json=body)

    def pins(self, **extra):
        return self.client.get(manga_index.PREFIX + "/pins", headers=AUTH,
                               params={"libraryId": LIBRARY, "epoch": 1, **extra})

    def frequent(self, **params):
        return self.client.get(manga_index.PREFIX + "/frequent", headers=AUTH, params=params)

    def test_idempotent_put_delete_revision_and_conditional_list(self):
        self.activated()
        empty = self.pins()
        self.assertEqual(empty.json()["revision"], 0)
        operation = str(uuid.uuid4())
        first = self.put(operation=operation)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json(), self.put(operation=operation).json())
        self.assertFalse(self.put(expected=1).json()["changed"])
        listed = self.pins()
        self.assertEqual(listed.json()["revision"], 1)
        self.assertNotEqual(empty.headers["etag"], listed.headers["etag"])
        conditional = self.client.get(manga_index.PREFIX + "/pins", headers={**AUTH, "If-None-Match": listed.headers["etag"]}, params={"libraryId": LIBRARY, "epoch": 1})
        self.assertEqual(conditional.status_code, 304)
        removed = self.put(False, 1)
        self.assertEqual(removed.json()["entityRevision"], 2)
        self.assertFalse(self.pins().json()["items"][0]["desiredState"])
        self.assertEqual(self.pins().json()["revision"], 2)
        self.assertFalse(self.put(False, 2).json()["changed"])
        # A lost old acknowledgement cannot re-pin after a later deletion.
        self.assertEqual(first.json(), self.put(operation=operation).json())
        self.assertFalse(self.pins().json()["items"][0]["desiredState"])

    def test_conflict_and_receipt_identity(self):
        self.activated()
        operation = str(uuid.uuid4())
        self.put(operation=operation)
        conflict = self.put(False)
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.json()["detail"]["code"], "revisionConflict")
        self.assertEqual(conflict.json()["detail"]["current"]["entityRevision"], 1)
        self.assertEqual(self.put(False, 1, operation=operation).status_code, 409)
        self.assertEqual(self.put(expected=1, label="다른 이름").json()["entityRevision"], 2)

    def test_auth_identity_and_strict_validation(self):
        self.activated()
        for path in ("/pins?libraryId=" + LIBRARY + "&epoch=1", "/frequent"):
            self.assertEqual(self.client.get(manga_index.PREFIX + path).status_code, 401)
        self.assertEqual(self.client.put(manga_index.PREFIX + "/pins/tag/female", json={}).status_code, 401)
        self.assertEqual(self.pins(libraryId="b" * 32).status_code, 409)
        self.assertEqual(self.pins(epoch=2).status_code, 409)
        self.assertEqual(self.put(libraryId="b" * 32).status_code, 409)
        for extra in ({"epoch": True}, {"contractVersion": True}, {"desiredState": 1}, {"expectedRevision": -1}, {"label": ""}, {"value": "가" * 67}, {"unknown": 1}):
            self.assertEqual(self.put(**extra).status_code, 422, extra)
        self.assertEqual(self.pins(extra="x").status_code, 422)
        self.assertEqual(self.frequent(text="foo").status_code, 400)

    def test_inactive_authority_is_quietly_unavailable(self):
        self.publish()
        self.assertEqual(self.pins().status_code, 409)
        self.assertEqual(self.frequent().status_code, 409)
        self.assertEqual(self.put().status_code, 409)

    def test_counts_authority_exclusions_visibility_and_labels(self):
        records = [json.loads(line) for line in self.data.splitlines()]
        additions = [(1, "female", "tag"), (3, "female", "tag"), (4, "female", "tag"),
                     (5, "female", "tag"), (1, "temp", "translated"), (1, "parody", "original")]
        for work, namespace, value in additions:
            records.append({"kind": "tag", "value": {"WorkId": work, "Namespace": namespace, "Value": value}})
        records[0]["value"]["counts"]["tag"] += len(additions)
        records.append({"kind": "translation", "value": {"namespace": "female", "value": "tag", "label": "태그"}})
        records[0]["value"]["counts"]["translation"] += 1
        self.data = b"".join((replica.encode(r) + "\n").encode() for r in records)
        import hashlib
        self.digest = hashlib.sha256(self.data).hexdigest()
        self.activated()
        for work in ("2", "3", "4", "5"):
            self.assertEqual(self.command(work_id=work).status_code, 200)
        normal = self.frequent(language="all").json()
        self.assertEqual(normal["tags"], [{"kind": "tag", "namespace": "female", "value": "tag", "label": "태그", "count": 2}, {"kind": "tag", "namespace": "group", "value": "blocked", "label": "blocked", "count": 1}])
        self.assertEqual(normal["artists"][0]["count"], 2)
        self.assertEqual((normal["tagLimit"], normal["artistLimit"]), (8, 5))
        self.assertEqual(self.frequent(language="all", revealBlocked="true").json()["tags"][0]["count"], 4)
        self.assertEqual(self.frequent(language="all", categories="[]").json()["tags"], [])
        self.assertEqual(self.frequent(language="japanese").json()["artists"][0]["value"], "bar")
        self.assertEqual(self.frequent(excludedTags='[{"namespace":"female","value":"tag"}]').json()["tags"], [])
        # The published copy stays unchanged; live authority bookmarks supply counts.
        self.assertEqual(normal["bookmarkCount"], 7)

    def test_frequent_probes_bookmarks_without_full_catalog_scan(self):
        # Objective instruction count alongside timing; 50k unsaved works must not
        # affect the aggregation cost. This tests the same query used by the route.
        from tests.test_mobile_catalog import source_fixture
        with source_fixture() as db:
            query = normalize({"language": "all"})
            def measure():
                instructions = 0
                def progress():
                    nonlocal instructions
                    instructions += 100
                    return 0
                db.set_progress_handler(progress, 100)
                elapsed = []
                for _ in range(10):
                    start = time.perf_counter()
                    manga_index.frequent(db, query, 3)
                    elapsed.append((time.perf_counter() - start) * 1000)
                db.set_progress_handler(None, 0)
                return instructions, statistics.median(elapsed)
            before = measure()
            db.executemany("INSERT INTO catalog.Works(Id,Title,FileCount,Views,Expunged) VALUES(?,'unsaved',1,1,0)", [(i,) for i in range(100, 50100)])
            after = measure()
            print(f"Manga frequent 10 queries: instructions {before[0]} -> {after[0]}, median ms {before[1]:.3f} -> {after[1]:.3f} (50k unsaved works)")
            # Deeper B-tree probes cost a few instructions; a scan costs hundreds
            # of thousands. Bound this to 40 extra instructions per query.
            self.assertLessEqual(after[0], before[0] + 400)
