"""Isolated duplicate-edition tests: rule port, incremental checker, and routes.

No app.py import: a bare FastAPI app, a temporary control database and a small
catalog artifact built from the production content DDL.
"""
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import closing, contextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api_auth
import catalog_duplicates as dup
import mobile_catalog_replica as replica

PREFIX = dup.PREFIX


def work(work_id, title, pages=20, category=2, title_jpn=None, artists=("artist:kim",),
         languages=("korean",), group=None, expunged=0):
    return {"id": work_id, "title": title, "titleJpn": title_jpn, "pages": pages, "category": category,
            "creators": list(artists), "languages": list(languages), "group": group or f"g{work_id}",
            "expunged": expunged}


def evidence(w):
    return {"workId": str(w["id"]), "groupId": w["group"], "title": w["title"], "titleJpn": w["titleJpn"],
            "pages": w["pages"], "category": w["category"], "creators": sorted(w["creators"]),
            "languages": sorted(w["languages"])}


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.control = root / "control.sqlite"
        self.artifact = root / "artifact.sqlite"

        @contextmanager
        def get_db():
            db = sqlite3.connect(self.control, timeout=5)
            db.row_factory = sqlite3.Row
            try:
                yield db
            finally:
                db.close()

        self.get_db = get_db
        with closing(sqlite3.connect(self.artifact)) as db, db:
            db.executescript(replica.CONTENT_DDL + replica.INDEX_DDL)

    def tearDown(self):
        self.temp.cleanup()

    def add(self, *works):
        with closing(sqlite3.connect(self.artifact)) as db, db:
            for w in works:
                db.execute("INSERT INTO Works(Id,Title,TitleJpn,Category,FileCount,Views,Expunged) VALUES(?,?,?,?,?,0,?)",
                           (w["id"], w["title"], w["titleJpn"], w["category"], w["pages"], w["expunged"]))
                db.execute("INSERT OR IGNORE INTO online_catalog_group_handles VALUES('kHentai',?,?,?)",
                           (str(w["id"]), w["group"], w["id"]))
                db.execute("INSERT INTO online_catalog_group_members VALUES('kHentai',?,?,?,1,0,1)",
                           (str(w["id"]), w["id"], w["group"]))
                tags = [c.split(":", 1) for c in w["creators"]] + [["language", v] for v in w["languages"]]
                db.executemany("INSERT INTO Tags VALUES(?,?,?)", [(w["id"], n, v) for n, v in tags])

    def filler(self, count, start=10_000):
        with closing(sqlite3.connect(self.artifact)) as db, db:
            db.executemany("INSERT INTO Works(Id,Title,Category,FileCount,Views,Expunged) VALUES(?,?,2,20,0,0)",
                           [(i, f"Unrelated filler work number {i}") for i in range(start, start + count)])

    @contextmanager
    def catalog(self):
        # Same shape as mobile_catalog_replica.open_publication: artifact attached as `catalog`.
        conn = sqlite3.connect(":memory:")
        conn.execute("ATTACH DATABASE ? AS catalog", (self.artifact.as_uri() + "?mode=ro",))
        conn.execute("PRAGMA query_only=ON")
        try:
            yield conn
        finally:
            conn.close()

    def check(self, works, **kwargs):
        with self.get_db() as db, self.catalog() as conn:
            return dup.check_new_works(db, conn, works, **kwargs)

    def candidates(self):
        with self.get_db() as db:
            return [dict(r) for r in db.execute(
                "SELECT * FROM catalog_duplicate_candidates WHERE removed=0 ORDER BY left_work_id,right_work_id")]


class RulePortTests(unittest.TestCase):
    def test_normalize_matches_rust_whitespace_and_lowercase(self):
        self.assertEqual(dup.normalize("  Foo　\tBAR  baz "), "foo bar baz")
        # U+001C..U+001F are not Rust whitespace although Python's str.split() splits on them.
        self.assertEqual(dup.normalize("a\x1cb"), "a\x1cb")
        self.assertEqual(dup.normalize("ΟΔΟΣ"), "οδος")  # final sigma, as Rust to_lowercase

    def test_review_title_drops_only_a_delimited_korean_alternate(self):
        self.assertEqual(dup.review_title("Original Title | 한국어 제목 (C99) [Kor]"), "original title (c99) [kor]")
        self.assertEqual(dup.review_title("Original Title | English Alt"), "original title | english alt")
        self.assertEqual(dup.review_title("Short | 한국어"), "short | 한국어")
        self.assertEqual(dup.review_title("Original Title | 한국어 | 둘"), "original title | 한국어 | 둘")
        self.assertEqual(dup.title_keys("Tiny", None), [])

    def test_match_rules(self):
        a = evidence(work(1, "Original Long Title"))
        self.assertEqual(dup.match_works(a, evidence(work(2, "original  long title"))), ("exactTitle", 0))
        self.assertIsNone(dup.match_works(a, evidence(work(2, "Original Long Title", pages=21))))
        korean = evidence(work(2, "Original Long Title | 한국어 제목", pages=21))
        self.assertEqual(dup.match_works(a, korean), ("koreanAlternateTitle", 1))
        self.assertIsNone(dup.match_works(a, evidence(work(2, "Original Long Title | 한국어 제목", pages=23))))
        self.assertIsNone(dup.match_works(a, evidence(work(2, "Original Long Title", group="g1"))))
        self.assertIsNone(dup.match_works(a, evidence(work(2, "Original Long Title", category=3))))
        self.assertIsNone(dup.match_works(a, evidence(work(2, "Original Long Title", languages=("japanese",)))))
        self.assertIsNone(dup.match_works(a, evidence(work(2, "Original Long Title", artists=("artist:lee",)))))
        zero = evidence(work(3, "Original Long Title", category=0))
        self.assertIsNone(dup.match_works(zero, evidence(work(4, "Original Long Title", category=0))))


class IncrementalCheckTests(Fixture):
    def test_finds_korean_alternate_edition_for_a_new_work(self):
        self.add(work(100, "Original Long Title"), work(200, "Original Long Title | 한국어 번역 제목", pages=21))
        self.filler(500)
        stats = self.check([200])
        self.assertTrue(stats["indexBuilt"])
        self.assertEqual(stats["candidates"], 1)
        [row] = self.candidates()
        self.assertEqual((row["left_work_id"], row["right_work_id"], row["source"], row["reason"], row["page_gap"]),
                         ("100", "200", "server", "koreanAlternateTitle", 1))
        # Same check again: nothing new, no revision churn.
        self.assertEqual(self.check([200])["candidates"], 0)

    def test_payload_only_works_of_one_batch_find_each_other(self):
        self.add(work(1, "Some Other Title"))
        rows = [{"work": {"Id": i, "Title": "Brand New Long Title", "TitleJpn": None, "FileCount": 30,
                          "Category": 2, "Expunged": 0},
                 "tags": [["artist", "park"], ["language", "korean"]]} for i in (301, 302)]
        stats = self.check(rows)
        self.assertEqual(stats["candidates"], 1)
        self.assertEqual([(r["left_work_id"], r["right_work_id"], r["reason"]) for r in self.candidates()],
                         [("301", "302", "exactTitle")])

    def test_crowded_title_bucket_is_skipped_like_the_pc(self):
        self.add(*[work(i, "Crowded Common Title", group=f"g{i}") for i in range(1, dup.BUCKET + 2)])
        stats = self.check([1])
        self.assertEqual((stats["skippedBuckets"], stats["candidates"]), (1, 0))

    def test_decided_pair_is_not_readded(self):
        self.add(work(100, "Original Long Title"), work(200, "Original Long Title"))
        with self.get_db() as db:
            dup.startup_db(db)
            db.execute("INSERT INTO catalog_duplicate_decisions VALUES('kHentai','100','200','notDuplicate',NULL,1,1,'t')")
            db.commit()
        self.assertEqual(self.check([200])["candidates"], 0)

    def test_lookup_touches_only_indexed_rows(self):
        """Benchmark-style guard: cost is independent of catalog size, plans are SEARCHes."""
        self.add(work(100, "Original Long Title"), work(200, "Original Long Title"))
        self.filler(20_000)
        with self.get_db() as db, self.catalog() as conn:
            dup.rebuild_title_index(db, conn)
            reads = []
            conn.set_progress_handler(lambda: reads.append(1) and 0, 100)
            stats = dup.check_new_works(db, conn, [200])
            conn.set_progress_handler(None, 0)
            plans = [r[3] for r in db.execute("EXPLAIN QUERY PLAN " + dup.INDEX_LOOKUP_SQL, (1, 9))]
            for sql in (dup.WORK_SQL, dup.TAGS_SQL):
                plans += [r[3] for r in conn.execute("EXPLAIN QUERY PLAN " + sql.format(s="catalog"),
                                                     ("kHentai", 1) if sql is dup.WORK_SQL else (1, 65))]
        self.assertEqual(stats["candidates"], 1)
        # One key, two index hits, two works with three tag rows each.
        self.assertLessEqual(stats["rowsRead"], 12)
        # A scan of 20k works would take thousands of VM-step callbacks.
        self.assertLess(len(reads), 50)
        self.assertTrue(plans)
        for plan in plans:
            self.assertNotIn("SCAN", plan, plans)
        self.assertTrue(any("catalog_duplicate_title_index USING PRIMARY KEY (key_hash=?)" in p for p in plans), plans)


class ApiTests(Fixture):
    def setUp(self):
        super().setUp()
        api_auth.startup(self.get_db)
        with self.get_db() as db:
            _, client = api_auth.provision_token(db, "client")
            _, publisher = api_auth.provision_token(db, "publisher")
            db.commit()
        self.auth = {"Authorization": f"Bearer {client}"}
        self.publisher = {"Authorization": f"Bearer {publisher}"}
        app = FastAPI()
        startup = dup.register(app, self.get_db, api_auth.client_guard(self.get_db, None),
                               api_auth.publisher_guard(self.get_db))
        startup()
        self.client = TestClient(app)

    def item(self, left, right, reason="exactTitle", gap=0):
        return {"provider": "kHentai", "reason": reason, "pageGap": gap, "algorithm": dup.ALGORITHM,
                "left": evidence(left), "right": evidence(right)}

    def publish(self, items, generation="gen-1", final=True, **extra):
        body = {"version": 1, "operationId": str(uuid.uuid4()), "generation": generation, "final": final,
                "items": items, **extra}
        return self.client.put(PREFIX + "/candidates", headers=self.publisher, json=body)

    def listing(self, **params):
        reply = self.client.get(PREFIX, headers=self.auth, params=params)
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()

    def decide(self, candidate, decision="keepBoth", expected=0, hidden=None, operation=None):
        body = {"version": 1, "operationId": operation or str(uuid.uuid4()), "candidateId": candidate,
                "decision": decision, "hiddenWorkId": hidden, "expectedRevision": expected}
        return self.client.post(PREFIX + "/decisions", headers=self.auth, json=body)

    def code(self, reply):
        return reply.json()["detail"]["code"]

    def test_roles_and_bounds(self):
        a, b = work(1, "Original Long Title"), work(2, "Original Long Title")
        body = {"version": 1, "operationId": str(uuid.uuid4()), "generation": "g", "final": True,
                "items": [self.item(a, b)]}
        self.assertEqual(self.client.put(PREFIX + "/candidates", headers=self.auth, json=body).status_code, 401)
        self.assertEqual(self.client.get(PREFIX + "/decisions", headers=self.auth).status_code, 401)
        self.assertEqual(self.client.get(PREFIX).status_code, 401)
        big = b"x" * (dup.MAX_BODY_BYTES + 1)
        self.assertEqual(self.client.put(PREFIX + "/candidates", headers=self.publisher, content=big).status_code, 413)
        self.assertEqual(self.code(self.publish([self.item(a, a)])), "invalidDuplicateCandidates")
        self.assertEqual(self.code(self.publish([{**self.item(a, b), "extra": 1}])), "invalidDuplicateCandidates")
        self.assertEqual(self.client.get(PREFIX, headers=self.auth, params={"x": 1}).status_code, 422)

    def test_publication_generations_ordering_and_idempotency(self):
        a, b, c = work(1, "Original Long Title"), work(2, "Original Long Title"), work(3, "Another Long Title")
        body = {"version": 1, "operationId": str(uuid.uuid4()), "generation": "gen-1", "final": False,
                "items": [self.item(b, a)]}  # reversed: stored with left < right
        first = self.client.put(PREFIX + "/candidates", headers=self.publisher, json=body)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(self.client.put(PREFIX + "/candidates", headers=self.publisher, json=body).json(), first.json())
        body["final"] = True
        self.assertEqual(self.code(self.client.put(PREFIX + "/candidates", headers=self.publisher, json=body)),
                         "operationConflict")
        [row] = self.listing()["items"]
        self.assertEqual((row["leftWorkId"], row["rightWorkId"], row["source"]), ("1", "2", "pc"))
        self.assertEqual(row["reasonText"], dup.reason_text("exactTitle", 0))
        revision = self.listing()["revision"]
        # Identical content in a new generation does not churn the revision.
        self.assertEqual(self.publish([self.item(a, b)], generation="gen-2").json()["changed"], 0)
        self.assertEqual(self.listing()["revision"], revision)
        # A final chunk of gen-3 retires everything the PC no longer publishes.
        result = self.publish([self.item(a, c)], generation="gen-3").json()
        self.assertEqual((result["changed"], result["retired"]), (1, 1))
        self.assertEqual([(i["leftWorkId"], i["rightWorkId"]) for i in self.listing()["items"]], [("1", "3")])

    def test_server_candidates_survive_pc_replace_unless_covered(self):
        self.add(work(100, "Original Long Title"), work(200, "Original Long Title"))
        self.check([200])
        self.publish([], generation="pc-1")
        self.assertEqual([i["source"] for i in self.listing()["items"]], ["server"])
        self.publish([], generation="pc-2", includesServerWorks=True)
        self.assertEqual(self.listing()["items"], [])

    def test_decisions_conflicts_filters_and_feeds(self):
        a, b, c = work(1, "Original Long Title"), work(2, "Original Long Title"), work(3, "Original Long Title")
        self.publish([self.item(a, b), self.item(a, c)])
        items = self.listing()["items"]
        self.assertEqual([i["rightWorkId"] for i in items], ["3", "2"])  # newest first
        target = items[1]["candidateId"]
        self.assertEqual(self.code(self.decide(target, "hideEdition")), "invalidDuplicateDecision")
        self.assertEqual(self.code(self.decide(target, "hideEdition", hidden="9")), "invalidDuplicateDecision")
        self.assertEqual(self.code(self.decide(target, "cleared")), "duplicateDecisionConflict")
        operation = str(uuid.uuid4())
        first = self.decide(target, "hideEdition", hidden="2", operation=operation)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()["revision"], 1)
        self.assertEqual(self.decide(target, "hideEdition", hidden="2", operation=operation).json(), first.json())
        self.assertEqual(self.code(self.decide(target, "keepBoth", operation=operation)), "operationConflict")
        self.assertEqual(self.code(self.decide(target, "notDuplicate", expected=0)), "duplicateDecisionConflict")
        self.assertEqual([i["rightWorkId"] for i in self.listing()["items"]], ["3"])
        decided = self.listing(state="decided")
        self.assertEqual(decided["counts"], {"undecided": 1, "decided": 1})
        self.assertEqual(decided["items"][0]["decision"], {"decision": "hideEdition", "hiddenWorkId": "2"})
        self.assertEqual(self.decide(target, "cleared", expected=1).status_code, 200)
        self.assertEqual(len(self.listing()["items"]), 2)
        self.assertEqual(self.decide(target, "notDuplicate", expected=2).status_code, 200)
        # Publisher decision feed: after-exclusive, bounded, ETag.
        feed = self.client.get(PREFIX + "/decisions", headers=self.publisher, params={"limit": 2})
        page = feed.json()
        self.assertEqual(([i["decision"] for i in page["items"]], page["hasMore"], page["nextCursor"]),
                         (["hideEdition", "cleared"], True, 2))
        rest = self.client.get(PREFIX + "/decisions", headers=self.publisher, params={"after": 2}).json()
        self.assertEqual(([i["decision"] for i in rest["items"]], rest["hasMore"]), (["notDuplicate"], False))
        again = self.client.get(PREFIX + "/decisions", headers={**self.publisher, "If-None-Match": feed.headers["ETag"]},
                                params={"limit": 2})
        self.assertEqual(again.status_code, 304)
        self.assertEqual(self.code(self.client.get(PREFIX + "/decisions", headers=self.publisher,
                                                   params={"after": 99})), "duplicateCursorRejected")
        # A decision on a retired candidate is refused; the decision itself is kept.
        self.publish([], generation="gen-2")
        self.assertEqual(self.code(self.decide(target, "keepBoth", expected=3)), "duplicateCandidateMissing")

    def test_change_feed_and_list_paging(self):
        works = [work(i, "Original Long Title") for i in range(1, 6)]
        self.publish([self.item(works[0], w) for w in works[1:]])
        page = self.listing(limit=3)
        self.assertTrue(page["hasMore"])
        rest = self.listing(limit=3, cursor=page["nextCursor"])
        self.assertEqual(len(page["items"]) + len(rest["items"]), 4)
        self.assertFalse(rest["hasMore"])
        cached = self.client.get(PREFIX, headers=self.auth)
        self.assertEqual(self.client.get(PREFIX, headers={**self.auth, "If-None-Match": cached.headers["ETag"]}).status_code, 304)
        changes = self.client.get(PREFIX + "/changes", headers=self.auth, params={"limit": 3}).json()
        self.assertEqual((len(changes["items"]), changes["hasMore"], changes["nextCursor"]), (3, True, 3))
        self.decide(page["items"][0]["candidateId"])
        tail = self.client.get(PREFIX + "/changes", headers=self.auth, params={"after": 3}).json()
        self.assertEqual([i["revision"] for i in tail["items"]], [5])
        self.assertIsNotNone(tail["items"][-1]["decision"])
        self.assertEqual(self.code(self.client.get(PREFIX + "/changes", headers=self.auth, params={"after": 99})),
                         "duplicateCursorRejected")
        self.assertEqual(self.code(self.client.get(PREFIX, headers=self.auth, params={"cursor": "!!"})),
                         "invalidDuplicateCursor")


if __name__ == "__main__":
    unittest.main()
