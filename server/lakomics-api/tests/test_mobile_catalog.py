"""The same cases run through the PC Rust grouped query and this read API."""
import copy
import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import mobile_catalog_replica as replica
from mobile_catalog import register_mobile_catalog
from mobile_catalog_query import parse_query, QueryError, freeze_query, search_groups, count_groups

FIXTURE = json.loads((Path(__file__).resolve().parents[3] / "tests/fixtures/mobile-catalog-v1.json").read_text(encoding="utf-8"))
AUTH = {"Authorization": "Bearer catalog-test"}
GROUP_DDL = """CREATE TABLE online_catalog_group_members(provider TEXT,work_id TEXT,catalog_work_id INTEGER,group_id TEXT,thumbnail_valid INTEGER,completeness INTEGER,lineage_terminal INTEGER,PRIMARY KEY(provider,work_id)); CREATE TABLE online_catalog_group_handles(provider TEXT,anchor_work_id TEXT,group_id TEXT,sequence INTEGER,PRIMARY KEY(provider,anchor_work_id));"""

@contextmanager
def source_fixture():
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript(replica.USER_DDL + GROUP_DDL + FIXTURE["setup"])
    try:
        yield db
    finally:
        db.close()

def fixture_projection():
    with source_fixture() as source:
        records, counts = [], {}
        for kind, (table, columns) in replica.TABLES.items():
            owner = "catalog." if kind in ("work", "tag", "translation") else ""
            rows = [dict(row) for row in source.execute("SELECT " + ",".join(columns) + " FROM " + owner + table + " ORDER BY " + ",".join(columns))]
            records.extend({"kind": kind, "value": row} for row in rows)
            counts[kind] = len(rows)
        users = {
            "bookmarks": [list(r) for r in source.execute("SELECT provider,work_id,created_at FROM online_catalog_bookmarks")],
            "hiddenCategories": [list(r) for r in source.execute("SELECT category,created_at FROM online_catalog_hidden_categories")],
            "blockedTags": [list(r) for r in source.execute("SELECT namespace,value,created_at FROM online_catalog_blocked_tags")],
            "preferences": [list(r) for r in source.execute("SELECT provider,anchor_work_id,selected_work_id,edit_revision FROM online_catalog_group_preferences")],
            "decisions": [], "decisionRevision": replica.digest([]),
        }
        for key in ("bookmarks", "hiddenCategories", "blockedTags", "preferences"):
            users[key].sort(key=replica.encode)
    manifest = {"contractVersion": 1, "schemaVersion": 1, "sourceRevision": "fixture-v1", "groupGeneration": 1, "groupDecisionRevision": users["decisionRevision"], "counts": counts}
    data = b"".join((replica.encode(record) + "\n").encode() for record in [{"kind": "manifest", "value": manifest}, *records])
    return data, hashlib.sha256(data).hexdigest(), users

class MobileCatalogQueryTests(unittest.TestCase):
    def test_shared_pc_fixture_exact_representative_policy_and_count(self):
        with source_fixture() as db:
            for case in FIXTURE["queries"]:
                q = freeze_query(db, {k: v for k, v in case.items() if k != "expected"} | {"sort": "latest"})
                rows = search_groups(db, q)
                actual = [[r["groupId"], int(r["providerWorkId"]), r["versionCount"], r["hasBookmarkedVersion"]] for r in rows]
                self.assertEqual(actual, case["expected"], case)
                self.assertEqual(count_groups(db, q), len(actual))
                for sort in ("latest", "views", "hotDay", "hotWeek", "hotMonth"):
                    scoped = freeze_query(db, {**q, "sort": sort})
                    total = count_groups(db, scoped)
                    pages = [r for page in range(total + 1) for r in search_groups(db, scoped, page, 1)]
                    self.assertEqual(len({r["groupId"] for r in pages}), total)
                    self.assertEqual(len(pages), total)
    def test_invalid_queries_and_bounds(self):
        for query in [*FIXTURE["invalid"], "가" * 1366, "a " * 257]:
            with self.assertRaises(QueryError, msg=query[:30]):
                parse_query(query)
    def test_precedence_literals_and_numeric_limits(self):
        self.assertEqual(parse_query("a OR b AND -c")[0], "or")
        self.assertEqual(parse_query('"100%_"'), ("title", "100%_"))
        self.assertEqual(parse_query("category:만화"), ("category", 2))
        with self.assertRaises(QueryError):
            parse_query("id:9223372036854775808")

class MobileCatalogApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        @contextmanager
        def get_db():
            db = sqlite3.connect(self.root / "control.sqlite"); db.row_factory = sqlite3.Row
            try:
                yield db
            finally:
                db.close()
        def auth(value):
            if value != AUTH["Authorization"]:
                raise HTTPException(401)
        self.get_db = get_db
        self.app = FastAPI()
        self.gallery_html = '<html><script>const gallery = {"files":[{"name":"001.webp","image":{"url":"https://a.siam-cdn.net/001.webp?expires=1800000000","width":1200,"height":1800}},{"name":"002.webp","image":{"url":"https://siam-cdn.net/002.webp?expires=1800000100","width":1200,"height":1800}}]};</script></html>'
        start = register_mobile_catalog(self.app, get_db, auth, lambda: self.root / "artifacts", lambda: "catalog-test", lambda _work_id: self.gallery_html)
        start()
        self.client = TestClient(self.app)
        self.data, self.digest, self.users = fixture_projection()
    def tearDown(self):
        self.client.close(); self.temp.cleanup()
    def publish(self, base=None, users=None):
        uploaded = self.client.put("/v1/mobile-catalog/replicas/" + self.digest, headers=AUTH, content=self.data)
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        return self.client.put("/v1/mobile-catalog/publication", headers=AUTH, json={"version": 1, "baseRevision": base, "contentDigest": self.digest, "userSnapshot": users if users is not None else self.users})
    def search(self, **params):
        return self.client.get("/v1/mobile-catalog/search", headers=AUTH, params={"language": "all", **params})
    def test_actual_api_runs_shared_fixture(self):
        self.assertEqual(self.publish().status_code, 200)
        for case in FIXTURE["queries"]:
            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in case.items() if k != "expected"}
            response = self.search(**params)
            self.assertEqual(response.status_code, 200, response.text)
            page = response.json()
            actual = [[r["groupId"], int(r["providerWorkId"]), r["versionCount"], r["hasBookmarkedVersion"]] for r in page["items"]]
            self.assertEqual(actual, case["expected"], case)
            if page["countStatus"] == "ready":
                self.assertIsNone(page["countToken"])
                self.assertEqual(page["totalCount"], len(actual))
            else:
                count = self.client.get("/v1/mobile-catalog/count", headers=AUTH, params={"token": page["countToken"]})
                self.assertEqual(count.status_code, 200, count.text)
                self.assertEqual(count.json()["totalCount"], len(actual))
    def test_auth_unpublished_and_query_rejections(self):
        self.assertEqual(self.client.get("/v1/mobile-catalog/status").status_code, 401)
        self.assertFalse(self.search().json()["ready"])
        self.assertEqual(self.search(provider="heliotrope").status_code, 400)
        self.assertEqual(self.search(text="alpha OR").status_code, 422)
        self.assertEqual(self.search(limit=101).status_code, 400)
    def test_old_cursor_count_and_context_stay_pinned_after_new_user_publication(self):
        old = self.publish().json()["publicationRevision"]
        page = self.search(limit=1).json()
        users = copy.deepcopy(self.users); users["bookmarks"] = []
        newer = self.publish(old, users)
        self.assertEqual(newer.status_code, 200, newer.text)
        next_page = self.client.get("/v1/mobile-catalog/search", headers=AUTH, params={"cursor": page["nextCursor"]}).json()
        self.assertEqual(next_page["publicationRevision"], old)
        detail = self.client.get("/v1/mobile-catalog/works/kHentai/1", headers=AUTH, params={"context": page["context"]}).json()
        self.assertTrue(detail["item"]["bookmarked"])
        self.assertEqual(self.client.get("/v1/mobile-catalog/search", headers=AUTH, params={"cursor": page["nextCursor"], "text": "changed"}).status_code, 400)
        self.assertEqual(self.client.get("/v1/mobile-catalog/search", headers=AUTH, params={"cursor": page["nextCursor"] + "x"}).status_code, 400)
    def test_reader_returns_bounded_safe_page_manifest(self):
        self.publish()
        page = self.search(language="korean").json()
        response = self.client.get("/v1/mobile-catalog/works/kHentai/1/reader", headers=AUTH, params={"context": page["context"]})
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["publicationRevision"], page["publicationRevision"])
        self.assertEqual([item["index"] for item in body["pages"]], [0, 1])
        self.assertEqual(body["manifestExpiresAt"], 1800000000)
        self.assertTrue(all("siam-cdn.net" in item["url"] for item in body["pages"]))
        self.gallery_html = '<script>const gallery = {"files":[{"image":{"url":"https://evil.example/page.webp"}}]};</script>'
        rejected = self.client.get("/v1/mobile-catalog/works/kHentai/1/reader", headers=AUTH, params={"context": page["context"]})
        self.assertEqual(rejected.status_code, 502)

    def test_detail_editions_hide_excluded_manual_selection_and_keep_alias(self):
        self.publish()
        page = self.search(language="korean").json()
        response = self.client.get("/v1/mobile-catalog/groups/kHentai/alias2/editions", headers=AUTH, params={"context": page["context"]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(response.json()["selectedProviderWorkId"])
        self.assertEqual([x["providerWorkId"] for x in response.json()["items"]], ["1"])
        self.assertEqual(self.client.get("/v1/mobile-catalog/works/kHentai/2", headers=AUTH, params={"context": page["context"]}).status_code, 404)
