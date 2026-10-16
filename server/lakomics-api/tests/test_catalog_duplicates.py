"""Isolated duplicate-edition tests: rule port, incremental checker, and routes.

No app.py import: a bare FastAPI app, a temporary control database and a small
catalog artifact built from the production content DDL.
"""
import json
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
    def test_confident_shared_table(self):
        cases = json.loads((Path(__file__).parent / "fixtures/catalog_confident.json").read_text(encoding="utf-8"))
        for case in cases:
            with self.subTest(name=case["name"]):
                self.assertEqual(dup.confident(case["left"], case["right"]), case["confident"])
                self.assertEqual(dup.confident(case["right"], case["left"]), case["confident"])

    def test_sequel_guard_shared_table(self):
        cases = json.loads((Path(__file__).parent / "fixtures/catalog_installments.json").read_text(encoding="utf-8"))
        for case in cases:
            with self.subTest(case=case):
                a = evidence(work(1, case["left"], title_jpn=case.get("leftJpn", "Shared neutral title")))
                b = evidence(work(2, case["right"], title_jpn=case.get("rightJpn", "Shared neutral title")))
                self.assertEqual(dup.sequel_conflict(a, b), case["conflict"])
                self.assertEqual(dup.sequel_conflict(b, a), case["conflict"])
                self.assertEqual(dup.match_works(a, b) is None, case["conflict"])

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
        self.assertEqual(dup.match_works(a, evidence(work(2, "Original Long Title", pages=21))), ("exactTitle", 1))
        korean = evidence(work(2, "Original Long Title | 한국어 제목", pages=21))
        self.assertEqual(dup.match_works(a, korean), ("koreanAlternateTitle", 1))
        self.assertIsNone(dup.match_works(a, evidence(work(2, "Original Long Title | 한국어 제목", pages=23))))
        self.assertIsNone(dup.match_works(a, evidence(work(2, "Original Long Title", group="g1"))))
        self.assertIsNone(dup.match_works(a, evidence(work(2, "Original Long Title", category=3))))
        self.assertIsNone(dup.match_works(a, evidence(work(2, "Original Long Title", languages=("japanese",)))))
        self.assertIsNone(dup.match_works(a, evidence(work(2, "Original Long Title", artists=("artist:lee",)))))
        zero = evidence(work(3, "Original Long Title", category=0))
        self.assertIsNone(dup.match_works(zero, evidence(work(4, "Original Long Title", category=0))))

    def test_k_page_gap_and_language_core(self):
        a = evidence(work(1, "Original Long Title"))
        b = evidence(work(2, "Original Long Title | 한국어 제목", pages=22,
                          languages=("korean", "translated", "rewrite", "speechless", "text_cleaned", "textless_narrative")))
        self.assertEqual(dup.match_works(a, b), ("koreanAlternateTitle", 2))
        b["pages"] = 23
        self.assertIsNone(dup.match_works(a, b))
        a["pages"], b["pages"] = 19, 21
        self.assertIsNone(dup.match_works(a, b))
        a["pages"], b["pages"] = 20, 22
        b["languages"].append("japanese")
        self.assertIsNone(dup.match_works(a, b))


    def test_v3_page_tolerance_is_a_tenth_of_the_smaller_work(self):
        self.assertEqual(dup.ALGORITHM, "catalog-duplicates-v3")
        for pages, other, reason, candidate in (
                (40, 43, "exactTitle", True), (50, 55, "exactTitle", True), (50, 56, "exactTitle", False),
                (15, 16, "exactTitle", True), (15, 17, "exactTitle", False), (5, 5, "exactTitle", True),
                (9, 10, "exactTitle", False), (50, 55, "koreanAlternateTitle", True),
                (50, 56, "koreanAlternateTitle", False)):
            with self.subTest(pages=pages, other=other, reason=reason):
                title = "Original Long Title | 한국어 제목" if reason == "koreanAlternateTitle" else "Original Long Title"
                a = evidence(work(1, "Original Long Title", pages=pages))
                b = evidence(work(2, title, pages=other))
                expected = (reason, abs(pages - other)) if candidate else None
                self.assertEqual(dup.match_works(a, b), expected)
                self.assertEqual(dup.match_works(b, a), expected)
                self.assertEqual(dup.confident(a, b), candidate)

    def test_reason_text_reads_for_larger_gaps(self):
        self.assertEqual(dup.reason_text("exactTitle", 0), "제목 일치 · 작가/그룹 중복 · 페이지 수, 분류, 언어 일치")
        self.assertIn("페이지 수 차이 5쪽", dup.reason_text("exactTitle", 5))
        self.assertNotIn("페이지 수, 분류", dup.reason_text("exactTitle", 5))
        self.assertIn("페이지 수 차이 12쪽", dup.reason_text("koreanAlternateTitle", 12))


class AutomaticStorageTests(unittest.TestCase):
    """Pure storage/rule tests also runnable with only the module's stdlib logic."""
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        dup.startup_db(self.db)
        self.addCleanup(self.db.close)

    def seed(self, left=None, right=None, source="server", removed=False):
        left = left or work(1, "Original Long Title")
        right = right or work(2, "Original Long Title")
        a, b, _ = dup._ordered(evidence(left), evidence(right))
        dup._upsert(self.db, "kHentai", a["workId"], b["workId"], source, None,
                    "exactTitle", abs(a["pages"] - b["pages"]), dup.ALGORITHM,
                    {"left": a, "right": b}, "now")
        if removed:
            self.db.execute("UPDATE catalog_duplicate_candidates SET removed=1")
        self.db.commit()

    def run_pass(self):
        self.db.execute("BEGIN IMMEDIATE")
        made = dup.auto_decide_pending(self.db)
        self.db.commit()
        return made

    def test_existing_confident_same_group_is_decided_once(self):
        self.seed(right=work(2, "Original Long Title", group="g1"))
        self.assertEqual(self.run_pass(), 1)
        row = self.db.execute("SELECT * FROM catalog_duplicate_decision_log").fetchone()
        self.assertEqual((row["decision"], row["revision"], row["sequence"]), ("keepBoth", 1, 1))
        self.assertEqual(row["operation_id"], dup.automatic_operation(row["candidate_id"]))
        self.assertEqual(json.loads(row["result_json"])["sequence"], 1)
        self.assertEqual(dup.status_head(self.db), 1)
        self.assertEqual(self.db.execute("SELECT changed FROM catalog_duplicate_candidates").fetchone()[0], 2)
        self.assertEqual(self.run_pass(), 0)
        self.assertEqual(dup.status_head(self.db), 1)

    def test_non_confident_stays_undecided(self):
        for b in (work(2, "Original Long Title", pages=23),
                  work(2, "Original Long Title", languages=("japanese",)),
                  work(2, "Original Long Title", title_jpn="作品 第3話")):
            with self.subTest(right=b):
                self.seed(left=work(1, "Original Long Title", title_jpn="作品 第2話"), right=b)
                self.assertEqual(self.run_pass(), 0)
        self.assertEqual(dup.status_head(self.db), 0)

    def test_any_decision_history_including_cleared_is_untouched(self):
        self.seed()
        for decision in ("keepBoth", "hideEdition", "notDuplicate", None):
            with self.subTest(decision=decision):
                self.db.execute("INSERT OR REPLACE INTO catalog_duplicate_decisions VALUES(?,?,?,?,?,?,?,?)",
                                ("kHentai", "1", "2", decision, None, 4, 4, "old"))
                self.db.commit()
                self.assertEqual(self.run_pass(), 0)
                row = self.db.execute("SELECT * FROM catalog_duplicate_decisions").fetchone()
                self.assertEqual((row["decision"], row["revision"], row["updated_at"]), (decision, 4, "old"))

    def test_pc_and_removed_candidates_are_untouched(self):
        self.seed(source="pc")
        self.assertEqual(self.run_pass(), 0)
        self.seed(removed=True)
        self.assertEqual(self.run_pass(), 0)

    def test_refresh_updates_server_evidence_but_never_pc_evidence(self):
        self.seed(right=work(2, "Original Long Title", pages=23))
        a, b = evidence(work(1, "Original Long Title")), evidence(work(2, "Original Long Title"))
        self.assertTrue(dup._upsert(self.db, "kHentai", "1", "2", "server", None, "exactTitle", 0,
                                  dup.ALGORITHM, {"left": a, "right": b}, "new", replace_server=False))
        self.db.commit()
        self.assertEqual(self.run_pass(), 1)
        self.seed(left=work(3, "Other Long Title"), right=work(4, "Other Long Title"), source="pc")
        self.assertFalse(dup._upsert(self.db, "kHentai", "3", "4", "server", None, "exactTitle", 0,
                                   dup.ALGORITHM, {"left": a, "right": b}, "new", replace_server=False))

    def test_refresh_inserts_logs_and_backfills_existing_pairs(self):
        with closing(sqlite3.connect(":memory:")) as catalog:
            catalog.executescript("""CREATE TABLE Works(Id INTEGER PRIMARY KEY,Title TEXT,TitleJpn TEXT,
                FileCount INTEGER,Category INTEGER,Expunged INTEGER);
                CREATE TABLE online_catalog_group_members(provider TEXT,work_id TEXT,
                catalog_work_id INTEGER,group_id TEXT);
                CREATE TABLE Tags(WorkId INTEGER,Namespace TEXT,Value TEXT);
                INSERT INTO Works VALUES(10,'Original Long Title',NULL,20,2,0),
                    (20,'Original Long Title',NULL,20,2,0);
                INSERT INTO online_catalog_group_members VALUES('kHentai','10',10,'g10'),
                    ('kHentai','20',20,'g20');
                INSERT INTO Tags VALUES(10,'artist','kim'),(20,'artist','kim'),
                    (10,'language','korean'),(20,'language','korean');""")
            self.seed(right=work(2, "Original Long Title", group="g1"))
            stats = dup.check_new_works(self.db, catalog, [20], schema="main")
            self.assertEqual((stats["candidates"], stats["automaticDecisions"]), (1, 2))
            logs = self.db.execute("SELECT * FROM catalog_duplicate_decision_log ORDER BY sequence").fetchall()
            self.assertEqual([r["sequence"] for r in logs], [1, 2])
            self.assertTrue(all(r["decision"] == "keepBoth" and r["revision"] == 1 for r in logs))
            self.assertEqual(dup.check_new_works(self.db, catalog, [20], schema="main")["automaticDecisions"], 0)
            # Use the command's writer to clear: the next refresh must preserve that history.
            row = self.db.execute(dup.JOINED + " WHERE c.left_work_id='10'").fetchone()
            self.db.execute("BEGIN IMMEDIATE")
            dup._record_decision(self.db, row, str(uuid.uuid4()), "clear-digest", "cleared")
            self.db.commit()
            self.assertEqual(dup.check_new_works(self.db, catalog, [20], schema="main")["automaticDecisions"], 0)
            self.assertEqual(dup.status_head(self.db), 3)


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
        self.startup = startup
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

    def test_publish_accepts_v3_page_gaps_and_still_bounds_them(self):
        a, b = work(1, "Original Long Title", pages=50), work(2, "Original Long Title", pages=55)
        self.assertEqual(self.publish([self.item(a, b, gap=5)]).status_code, 200)
        [row] = self.listing()["items"]
        self.assertEqual((row["pageGap"], row["algorithm"]), (5, "catalog-duplicates-v3"))
        self.assertIn("페이지 수 차이 5쪽", row["reasonText"])
        self.assertEqual(self.publish([self.item(a, b, gap=dup.MAX_PAGE_GAP)], generation="gen-2").status_code, 200)
        self.assertEqual(self.publish([self.item(a, b, gap=dup.MAX_PAGE_GAP + 1)], generation="gen-3").status_code, 422)

    def test_refresh_records_automatic_log_and_mobile_can_undo(self):
        self.add(work(1, "Original Long Title"), work(2, "Original Long Title"))
        self.assertEqual(self.check([2])["automaticDecisions"], 1)
        self.assertEqual(self.listing()["counts"], {"undecided": 0, "decided": 1})
        feed = self.client.get(PREFIX + "/decisions", headers=self.publisher).json()
        [item] = feed["items"]
        self.assertEqual(set(item), {"sequence", "operationId", "candidateId", "provider", "leftWorkId",
                                    "rightWorkId", "decision", "hiddenWorkId", "revision", "createdAt", "automatic"})
        self.assertTrue(item["automatic"])
        self.assertEqual((item["decision"], item["revision"], item["sequence"]), ("keepBoth", 1, 1))
        self.assertEqual(self.decide(item["candidateId"], "notDuplicate", expected=1).status_code, 200)
        self.assertEqual(self.check([2])["automaticDecisions"], 0)
        feed = self.client.get(PREFIX + "/decisions", headers=self.publisher).json()
        self.assertFalse(feed["items"][-1]["automatic"])
        self.assertEqual(feed["items"][-1]["decision"], "notDuplicate")

    def test_refresh_backfills_existing_candidates_and_does_not_repeat_cleared(self):
        a, b = evidence(work(1, "Original Long Title")), evidence(work(2, "Original Long Title", group="g1"))
        with self.get_db() as db:
            dup._upsert(db, "kHentai", "1", "2", "server", None, "exactTitle", 0, dup.ALGORITHM,
                        {"left": a, "right": b}, "old")
            db.commit()
        self.assertEqual(self.check([])["automaticDecisions"], 1)
        target = self.listing(state="decided")["items"][0]["candidateId"]
        self.assertEqual(self.decide(target, "cleared", expected=1).status_code, 200)
        self.assertEqual(self.check([])["automaticDecisions"], 0)
        self.assertEqual(self.listing()["counts"]["undecided"], 1)
        self.assertEqual(self.client.get(PREFIX + "/decisions", headers=self.publisher).json()["lastSequence"], 2)

    def test_startup_backfills_only_never_decided_server_candidates_once(self):
        with self.get_db() as db:
            for left, right, source in [(1, 2, "server"), (3, 4, "pc"), (5, 6, "server")]:
                dup._upsert(db, "kHentai", str(left), str(right), source, None, "exactTitle", 0,
                            dup.ALGORITHM, {"left": evidence(work(left, "Original Long Title")),
                                            "right": evidence(work(right, "Original Long Title"))}, "old")
            db.execute("INSERT INTO catalog_duplicate_decisions VALUES('kHentai','5','6',NULL,NULL,2,2,'old')")
            db.commit()
        self.startup()
        feed = self.client.get(PREFIX + "/decisions", headers=self.publisher).json()
        self.assertEqual([(i["leftWorkId"], i["automatic"]) for i in feed["items"]], [("1", True)])
        self.startup()
        self.assertEqual(self.client.get(PREFIX + "/decisions", headers=self.publisher).json(), feed)

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
        # The server decides this confident pair itself; the candidate still survives a
        # PC replace that does not cover server works.
        self.add(work(100, "Original Long Title"), work(200, "Original Long Title"))
        self.check([200])
        self.publish([], generation="pc-1")
        self.assertEqual([i["source"] for i in self.listing(state="all")["items"]], ["server"])
        self.publish([], generation="pc-2", includesServerWorks=True)
        self.assertEqual(self.listing(state="all")["items"], [])

    def test_final_upload_retires_old_pending_sequels_and_rejects_mobile_token(self):
        a = work(1, "Shared neutral title", title_jpn="作品 第2話")
        b = work(2, "Shared neutral title", title_jpn="作品 第3話")
        safe_a, safe_b = work(3, "Safe neutral title"), work(4, "Safe neutral title")
        # Seed evidence discovered under the old rules; do not run the new matcher.
        with self.get_db() as db:
            for left, right, source in ((a, b, "server"), (safe_a, safe_b, "server")):
                dup._upsert(db, "kHentai", str(left["id"]), str(right["id"]), source, None,
                            "exactTitle", 0, "translated-title-multisignal-canary-v2",
                            {"left": evidence(left), "right": evidence(right)}, "now")
            db.commit()
        pending = dup.candidate_id("kHentai", "1", "2")
        self.assertEqual(self.publish([], generation="v2", final=False).json()["retired"], 0)
        self.assertEqual(self.publish([], generation="v2", final=True).json()["retired"], 1)
        self.assertEqual([i["leftWorkId"] for i in self.listing()["items"]], ["3"])
        self.assertEqual(self.code(self.decide(pending)), "duplicateCandidateMissing")

    def test_final_upload_preserves_decided_server_sequel(self):
        a = work(1, "Shared neutral title", title_jpn="作品 第2話")
        b = work(2, "Shared neutral title", title_jpn="作品 第3話")
        with self.get_db() as db:
            dup._upsert(db, "kHentai", "1", "2", "server", None, "exactTitle", 0,
                        "translated-title-multisignal-canary-v2", {"left": evidence(a), "right": evidence(b)}, "now")
            db.commit()
        pending = dup.candidate_id("kHentai", "1", "2")
        self.assertEqual(self.decide(pending).status_code, 200)
        self.assertEqual(self.publish([], generation="v2").json()["retired"], 0)
        self.assertEqual(len(self.listing(state="decided")["items"]), 1)

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

    def test_status_head_moves_with_the_decision_log(self):
        """`/v1/sync/status` publisherLogs.catalogDuplicateDecisions is the log's last sequence."""
        def head():
            with self.get_db() as db:
                return dup.status_head(db)
        self.assertEqual(head(), 0)
        a, b = work(1, "Original Long Title"), work(2, "Original Long Title")
        self.publish([self.item(a, b)])
        self.assertEqual(head(), 0)
        target = self.listing()["items"][0]["candidateId"]
        self.assertEqual(self.decide(target, "keepBoth").status_code, 200)
        self.assertEqual(head(), 1)
        feed = self.client.get(PREFIX + "/decisions", headers=self.publisher).json()
        self.assertEqual(feed["lastSequence"], head())

    def test_list_paging(self):
        works = [work(i, "Original Long Title") for i in range(1, 6)]
        self.publish([self.item(works[0], w) for w in works[1:]])
        page = self.listing(limit=3)
        self.assertTrue(page["hasMore"])
        rest = self.listing(limit=3, cursor=page["nextCursor"])
        self.assertEqual(len(page["items"]) + len(rest["items"]), 4)
        self.assertFalse(rest["hasMore"])
        cached = self.client.get(PREFIX, headers=self.auth)
        self.assertEqual(self.client.get(PREFIX, headers={**self.auth, "If-None-Match": cached.headers["ETag"]}).status_code, 304)
        self.assertEqual(self.code(self.client.get(PREFIX, headers=self.auth, params={"cursor": "!!"})),
                         "invalidDuplicateCursor")


if __name__ == "__main__":
    unittest.main()
