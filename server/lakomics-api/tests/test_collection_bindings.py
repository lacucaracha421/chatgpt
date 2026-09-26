"""Tablet MangaDex / Kakao connect: server search, bind requests, PC result reports.

Outbound HTTP is always replaced by a fake ``http_get``; no test touches the network.
Route logic runs on a bare FastAPI app with a temporary control database; one test uses
the real application to prove the routes are not shadowed by `/v1/collections/{id}`.
"""
import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api_auth
import collection_authority
import collection_bindings as bindings

PREFIX = bindings.PREFIX
REPO = Path(__file__).resolve().parents[3]
PC_FIXTURES = REPO / "_tools/app/src-tauri/src/library/fixtures"
MANGA_ID = "d1a9fdeb-f713-407f-960c-8326b586e6fd"
COVER_FILE = "a1b2c3d4-e5f6-47a8-9000-111122223333.jpg"


def kakao_book(volume, title="스틸 볼 런", publisher="문학동네", isbn="", thumbnail=True):
    doc = {"title": f"{title} {volume}", "authors": ["아라키 히로히코"], "publisher": publisher, "isbn": isbn,
           "datetime": "2026-09-01T00:00:00.000+09:00",
           "url": f"https://search.daum.net/search?w=bookpage&bookId={volume}&q=test"}
    if thumbnail:
        doc["thumbnail"] = f"https://search1.kakaocdn.net/thumb/{volume}"
    return doc


class FakeHttp:
    """Records calls; ``responses`` maps host -> callable(url, params, headers) -> bytes."""

    def __init__(self):
        self.calls = []
        self.timeouts = []
        self.handlers = {}

    def __call__(self, url, params, headers, max_bytes, timeout, deadline=None):
        self.calls.append((url, dict(params) if params else {}, list(params or []), dict(headers)))
        self.timeouts.append((timeout, deadline))
        host = url.split("/")[2]
        return self.handlers[host](url, dict(params), headers)


def pages(documents_by_page):
    def handler(url, params, headers):
        page = int(params["page"])
        docs = documents_by_page[page - 1]
        return json.dumps({"meta": {"is_end": page == len(documents_by_page)}, "documents": docs}).encode()
    return handler


class Base(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        path = Path(self.temp.name) / "control.sqlite"

        @contextmanager
        def get_db():
            db = sqlite3.connect(path, timeout=5)
            db.row_factory = sqlite3.Row
            try:
                yield db
            finally:
                db.close()

        self.get_db = get_db
        api_auth.startup(get_db)
        with get_db() as db:
            _, client = api_auth.provision_token(db, "client")
            _, other = api_auth.provision_token(db, "client")
            _, publisher = api_auth.provision_token(db, "publisher")
            db.execute("""CREATE TABLE mobile_collections (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
                showcase INTEGER NOT NULL, showcase_order INTEGER, payload TEXT NOT NULL)""")
            for cid, kind in (("m1", "manga"), ("m2", "manga"), ("f1", "film")):
                db.execute("INSERT INTO mobile_collections VALUES(?,?,?,0,NULL,'{}')", (cid, kind, cid))
            collection_authority.startup_db(db)
            db.commit()
        self.auth = {"Authorization": "Bearer " + client}
        self.other = {"Authorization": "Bearer " + other}
        self.publisher = {"Authorization": "Bearer " + publisher}
        app = FastAPI()
        startup = bindings.register(app, get_db, api_auth.client_guard(get_db, None), api_auth.publisher_guard(get_db))
        with get_db() as db:
            startup(db)
            db.commit()
        self.client = TestClient(app)
        self.http = FakeHttp()
        patches = [mock.patch.object(bindings, "http_get", self.http),
                   mock.patch.object(bindings, "gate", bindings.SearchGate()),
                   mock.patch.object(bindings, "MANGADEX_MIN_INTERVAL", 0),
                   mock.patch.dict(os.environ, {bindings.KAKAO_KEY_ENV: "test-kakao-key"})]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def ok(self, reply):
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()

    def code(self, reply, status, code):
        self.assertEqual(reply.status_code, status, reply.text)
        self.assertEqual(reply.json()["detail"]["code"], code)
        return reply.json()["detail"]


class MangaDexSearch(Base):
    def test_shapes_the_pc_fixture_like_the_pc(self):
        body = (PC_FIXTURES / "mangadex_search.json").read_bytes()
        self.http.handlers["api.mangadex.org"] = lambda url, params, headers: body
        reply = self.ok(self.client.get(PREFIX + "/search/mangadex", params={"query": "  던전밥 "}, headers=self.auth))
        self.assertEqual(reply["query"], "던전밥")
        self.assertEqual(reply["items"], [{
            "mangaId": MANGA_ID, "title": "던전밥",
            "alternateTitles": ["Delicious in Dungeon", "Dungeon Meshi", "ダンジョン飯"],
            "author": "Ryoko Kui", "year": 2014, "status": "completed", "primaryCoverFileName": COVER_FILE,
            "coverUrl": f"https://uploads.mangadex.org/covers/{MANGA_ID}/{COVER_FILE}.256.jpg"}])
        url, params, raw, headers = self.http.calls[0]
        self.assertEqual(url, "https://api.mangadex.org/manga")
        self.assertEqual(raw, [("title", "던전밥"), ("limit", "20"), ("includes[]", "cover_art"),
                               ("includes[]", "author"), ("includes[]", "artist")])
        # Cached: the same query does not call MangaDex again.
        self.ok(self.client.get(PREFIX + "/search/mangadex", params={"query": "던전밥"}, headers=self.auth))
        self.assertEqual(len(self.http.calls), 1)

    def test_locale_priority_and_malformed_items_are_skipped(self):
        data = [
            {"id": "not-a-uuid", "attributes": {"title": {"en": "Bad"}}},
            {"id": str(uuid.uuid4()), "attributes": {"title": {"ja": "日本語"}, "altTitles": [{"en": "English"}]},
             "relationships": [{"id": "x", "type": "cover_art", "attributes": {"fileName": "../evil.jpg"}}]},
            {"id": MANGA_ID, "attributes": {"title": {"ja": "日本語"}, "altTitles": [{"en": "English"}, {"ko": "한국어"}],
                                            "year": None, "status": "ongoing"},
             "relationships": [{"id": "a", "type": "author", "attributes": {"name": "A"}},
                               {"id": "b", "type": "artist", "attributes": {"name": "A"}},
                               {"id": "c", "type": "artist", "attributes": {"name": "B"}}]},
        ]
        self.http.handlers["api.mangadex.org"] = lambda *a: json.dumps({"result": "ok", "data": data}).encode()
        items = self.ok(self.client.get(PREFIX + "/search/mangadex", params={"query": "ab"}, headers=self.auth))["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "한국어")
        self.assertEqual(items[0]["alternateTitles"], ["日本語", "English"])
        self.assertEqual(items[0]["author"], "A · B")
        self.assertIsNone(items[0]["coverUrl"])

    def test_non_canonical_ids_are_skipped(self):
        data = [{"id": MANGA_ID.upper(), "attributes": {"title": {"en": "Upper"}}},
                {"id": MANGA_ID.replace("-", ""), "attributes": {"title": {"en": "Bare"}}},
                {"id": MANGA_ID, "attributes": {"title": {"en": "Canonical"}}}]
        self.http.handlers["api.mangadex.org"] = lambda *a: json.dumps({"result": "ok", "data": data}).encode()
        items = self.ok(self.client.get(PREFIX + "/search/mangadex", params={"query": "ab"}, headers=self.auth))["items"]
        self.assertEqual([i["title"] for i in items], ["Canonical"])

    def test_malformed_query_values_use_the_documented_shape(self):
        self.code(self.client.get(PREFIX + "/search/mangadex", params={"query": "x" * 401}, headers=self.auth),
                  422, "invalidBindSearch")
        self.assertEqual(self.client.get(PREFIX + "/search/mangadex", params={"query": "x" * 401}).status_code, 401)

    def test_errors(self):
        self.code(self.client.get(PREFIX + "/search/mangadex", params={"query": " a "}, headers=self.auth),
                  422, "invalidBindSearch")
        self.http.handlers["api.mangadex.org"] = lambda *a: b'{"result":"error","data":[]}'
        self.code(self.client.get(PREFIX + "/search/mangadex", params={"query": "q1"}, headers=self.auth),
                  502, "bindSearchInvalidResponse")

        def raise_(kind, status=None):
            def handler(*a):
                raise bindings.Upstream(kind, status)
            return handler
        for (kind, status), (http_status, code) in {
                ("timeout", None): (504, "bindSearchTimedOut"),
                ("status", 429): (503, "bindSearchUpstreamRateLimited"),
                ("status", 500): (502, "bindSearchUpstreamFailed"),
                ("unavailable", None): (502, "bindSearchUpstreamFailed")}.items():
            self.http.handlers["api.mangadex.org"] = raise_(kind, status)
            detail = self.code(self.client.get(PREFIX + "/search/mangadex", params={"query": f"q-{kind}{status}"},
                                               headers=self.auth), http_status, code)
            self.assertEqual(detail["provider"], "mangadex")

    def test_auth(self):
        self.assertEqual(self.client.get(PREFIX + "/search/mangadex", params={"query": "ab"}).status_code, 401)
        self.assertEqual(self.client.get(PREFIX + "/status").status_code, 401)

    def test_real_http_get_refuses_other_hosts(self):
        for url in ("https://example.com/manga", "http://api.mangadex.org/manga",
                    "https://uploads.mangadex.org/covers/x"):
            with self.assertRaises(bindings.Upstream):
                type(self).real_http_get(url, [], {}, 10, 1)

    def test_real_http_get_caps_size_and_maps_status(self):
        import httpx

        seen = []

        def handler(request):
            seen.append(request)
            if request.url.path == "/big":
                return httpx.Response(200, content=b"x" * 100)
            if request.url.path == "/moved":
                return httpx.Response(302, headers={"Location": "https://example.com/"})
            return httpx.Response(200, content=b"ok")

        fake = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False)
        with mock.patch.object(bindings, "_client", fake):
            get = type(self).real_http_get
            self.assertEqual(get("https://api.mangadex.org/manga", [("title", "x")], {}, 10, 1), b"ok")
            self.assertTrue(seen[0].headers["User-Agent"].startswith("Lakomics-API/"))
            with self.assertRaises(bindings.Upstream) as big:
                get("https://api.mangadex.org/big", [], {}, 10, 1)
            self.assertEqual(big.exception.kind, "invalid")
            with self.assertRaises(bindings.Upstream) as moved:
                get("https://dapi.kakao.com/moved", [], {}, 10, 1)
            self.assertEqual((moved.exception.kind, moved.exception.status), ("status", 302))
        fake.close()

    real_http_get = staticmethod(bindings.http_get)


class RateLimit(Base):
    def test_per_client_window_counts_only_uncached_searches(self):
        self.http.handlers["api.mangadex.org"] = lambda *a: b'{"result":"ok","data":[]}'
        for index in range(bindings.SEARCH_PER_MINUTE):
            self.ok(self.client.get(PREFIX + "/search/mangadex", params={"query": f"query {index}"}, headers=self.auth))
        # A cached query is still served.
        self.ok(self.client.get(PREFIX + "/search/mangadex", params={"query": "query 0"}, headers=self.auth))
        reply = self.client.get(PREFIX + "/search/mangadex", params={"query": "new one"}, headers=self.auth)
        detail = self.code(reply, 429, "bindSearchRateLimited")
        self.assertGreater(detail["retryAfter"], 0)
        self.assertIn("Retry-After", reply.headers)
        # Another client has its own window.
        self.ok(self.client.get(PREFIX + "/search/mangadex", params={"query": "new one"}, headers=self.other))
        # The window slides.
        clock = [1000.0]
        gate = bindings.SearchGate(clock=lambda: clock[0])
        for _ in range(bindings.SEARCH_PER_MINUTE):
            self.assertEqual(gate.admit("x"), 0)
        self.assertGreater(gate.admit("x"), 0)
        clock[0] += 61
        self.assertEqual(gate.admit("x"), 0)

    def test_cache_expires_and_is_bounded(self):
        clock = [0.0]
        gate = bindings.SearchGate(clock=lambda: clock[0])
        gate.store("a", [1])
        self.assertEqual(gate.cached("a"), [1])
        clock[0] += bindings.CACHE_TTL + 1
        self.assertIsNone(gate.cached("a"))
        for index in range(bindings.CACHE_MAX + 5):
            gate.store(index, index)
        self.assertEqual(len(gate.cache), bindings.CACHE_MAX)


class KakaoSearch(Base):
    def test_all_pages_grouped_key_only_in_header(self):
        self.http.handlers["dapi.kakao.com"] = pages([[kakao_book(v) for v in range(1, 51)],
                                                      [kakao_book(v) for v in range(51, 55)]])
        reply = self.ok(self.client.get(PREFIX + "/search/kakao", params={"query": "스틸 볼 런"}, headers=self.auth))
        self.assertEqual(len(self.http.calls), 2)
        for index, (url, params, raw, headers) in enumerate(self.http.calls, 1):
            self.assertEqual(url, "https://dapi.kakao.com/v3/search/book")
            self.assertEqual(headers["Authorization"], "KakaoAK test-kakao-key")
            self.assertEqual(params, {"query": "스틸 볼 런", "target": "title", "sort": "latest", "size": "50",
                                      "page": str(index)})
            self.assertNotIn("test-kakao-key", json.dumps(params))
        self.assertNotIn("test-kakao-key", json.dumps(reply))
        [group] = reply["items"]
        self.assertEqual(group["title"], "스틸 볼 런")
        self.assertEqual(group["author"], "아라키 히로히코")
        self.assertEqual(group["publisher"], "문학동네")
        self.assertEqual(group["volumeCount"], 54)
        self.assertEqual((group["firstVolume"], group["lastVolume"]), (1, 54))
        self.assertEqual(group["ignoredCount"], 0)
        self.assertEqual(group["thumbnailUrl"], "https://search1.kakaocdn.net/thumb/1")
        self.assertEqual(group["volumes"][0]["publicationDate"], "2026-09-01")
        self.assertEqual(group["groupFingerprint"],
                         hashlib.sha256("스틸 볼 런\0아라키 히로히코\0문학동네".encode()).hexdigest())
        # Item ids without ISBN hash the canonical book URL (query parameter dropped), as the PC does.
        canonical = "https://search.daum.net/search?w=bookpage&bookId=1"
        first_id = "url:" + hashlib.sha256(canonical.encode()).hexdigest()
        self.assertIn(first_id, group["knownItemIds"])
        self.assertEqual(group["anchorItemId"], min(group["knownItemIds"]))
        self.assertEqual(group["knownItemIds"], sorted(v["providerItemId"] for v in group["volumes"]))

    def test_groups_like_the_pc_without_fuzzy_merging(self):
        # aladin_flow.rs groups_series_without_fuzzy_merging
        def item(item_id, base, volume, publisher, isbn13, date):
            return {"itemId": item_id, "title": f"{base} {volume}권", "author": "작가", "publisher": publisher,
                    "isbn13": isbn13, "publicationDate": date, "volumeNumber": volume, "baseTitle": base,
                    "thumbnail": None}
        groups = bindings.group_kakao([
            item("b-10", "던전밥", 10, "A출판", None, "2024-01-01"),
            item("b-2", "던전밥", 2, "A출판", "9782", "2023-01-01"),
            item("a-2", "던전밥", 2, "A출판", "9781", "2024-01-01"),
            item("other-1", "던전밥", 1, "B출판", "9791", None)])
        self.assertEqual(len(groups), 2)
        first = next(g for g in groups if g["publisher"] == "A출판")
        self.assertEqual([v["volumeNumber"] for v in first["volumes"]], [2, 10])
        self.assertEqual(first["volumes"][0]["providerItemId"], "a-2")
        self.assertEqual(first["ignoredCount"], 1)
        self.assertEqual(first["anchorItemId"], "a-2")
        self.assertEqual(len(first["groupFingerprint"]), 64)

    def test_volume_title_parsing_matches_the_pc(self):
        cases = {"원피스 105": (105, "원피스"), "원피스 제 3 권": (3, "원피스"), "Vol. 7": None,
                 "Dungeon Vol. 7": (7, "Dungeon"), "던전밥 12 (완결)": (12, "던전밥"),
                 "던전밥 3 한정판": (3, "던전밥"), "던전밥 3 (초판 한정판)": (3, "던전밥"),
                 "던전밥 세트 1": None, "던전밥 1.5": None, "던전밥": None, "던전밥 0": None,
                 "던전밥-4": (4, "던전밥"), "Novel 1": None}
        for title, expected in cases.items():
            self.assertEqual(bindings.parse_volume_product(title), expected, title)

    def test_isbn_preference(self):
        item = bindings.kakao_item(kakao_book(1, isbn="8954677533 9788954677530"))
        self.assertEqual(item["itemId"], "isbn13:9788954677530")
        item = bindings.kakao_item(kakao_book(1, isbn="895467753x"))
        self.assertEqual(item["itemId"], "isbn10:895467753X")
        bad = kakao_book(1)
        bad["url"] = "https://search.daum.net.evil.example/search?w=bookpage&bookId=1"
        with self.assertRaises(bindings.Upstream):
            bindings.kakao_item(bad)

    def test_deterministic_failures_are_cached_transient_ones_are_not(self):
        self.http.handlers["dapi.kakao.com"] = lambda *a: json.dumps(
            {"meta": {"is_end": False}, "documents": [kakao_book(1)]}).encode()
        with mock.patch.object(bindings, "KAKAO_MAX_PAGES", 3):
            for _ in range(2):
                self.code(self.client.get(PREFIX + "/search/kakao", params={"query": "원피스"}, headers=self.auth),
                          422, "kakaoSearchTooBroad")
        self.assertEqual(len(self.http.calls), 3)  # the second answer came from the cache
        self.http.handlers["dapi.kakao.com"] = lambda *a: b"not json"
        for _ in range(2):
            self.code(self.client.get(PREFIX + "/search/kakao", params={"query": "나루토"}, headers=self.auth),
                      502, "bindSearchInvalidResponse")
        self.assertEqual(len(self.http.calls), 4)

        def timeout(*a):
            raise bindings.Upstream("timeout")
        self.http.handlers["dapi.kakao.com"] = timeout
        for _ in range(2):
            self.code(self.client.get(PREFIX + "/search/kakao", params={"query": "블리치"}, headers=self.auth),
                      504, "bindSearchTimedOut")
        self.assertEqual(len(self.http.calls), 6)  # timeouts are retried

    def test_global_kakao_page_budget(self):
        self.http.handlers["dapi.kakao.com"] = pages([[kakao_book(v)] for v in range(1, 6)])
        with mock.patch.object(bindings, "KAKAO_PAGES_PER_MINUTE", 3):
            reply = self.client.get(PREFIX + "/search/kakao", params={"query": "스틸 볼 런"}, headers=self.auth)
            detail = self.code(reply, 429, "bindSearchRateLimited")
            self.assertGreater(detail["retryAfter"], 0)
            self.assertEqual(reply.headers["Retry-After"], str(detail["retryAfter"]))
            self.assertEqual(len(self.http.calls), 3)
            # The budget is global: another client is refused before any call, and nothing was cached.
            self.code(self.client.get(PREFIX + "/search/kakao", params={"query": "스틸 볼 런"}, headers=self.other),
                      429, "bindSearchRateLimited")
            self.assertEqual(len(self.http.calls), 3)

    def test_busy_provider_answers_at_once(self):
        slot = bindings.gate.provider_locks["kakao"]
        slot.acquire()
        try:
            with mock.patch.object(bindings, "PROVIDER_WAIT", 0.01):
                reply = self.client.get(PREFIX + "/search/kakao", params={"query": "스틸 볼 런"}, headers=self.auth)
            detail = self.code(reply, 429, "bindSearchBusy")
            self.assertIn("Retry-After", reply.headers)
            self.assertEqual(detail["provider"], "kakao")
        finally:
            slot.release()
        self.assertEqual(self.http.calls, [])
        self.assertLessEqual(bindings.PROVIDER_WAIT, 1.0)

    def test_whole_crawl_has_one_deadline(self):
        import time as real_time

        def slow(url, params, headers):
            real_time.sleep(0.03)
            return json.dumps({"meta": {"is_end": False}, "documents": [kakao_book(int(params["page"]))]}).encode()
        self.http.handlers["dapi.kakao.com"] = slow
        with mock.patch.object(bindings, "KAKAO_BUDGET", 0.1):
            self.code(self.client.get(PREFIX + "/search/kakao", params={"query": "스틸 볼 런"}, headers=self.auth),
                      504, "bindSearchTimedOut")
        self.assertLess(len(self.http.calls), 10)
        deadlines = {deadline for _, deadline in self.http.timeouts}
        self.assertEqual(len(deadlines), 1)  # every page shares the crawl deadline
        self.assertTrue(all(timeout <= 0.1 for timeout, _ in self.http.timeouts))

    def test_dates_must_be_rfc3339(self):
        for value in ("2026-09-01", "2026-09-01T00:00:00", "2026-09-01T00:00:00+0900", "２０２６-09-01T00:00:00Z"):
            raw = kakao_book(1)
            raw["datetime"] = value
            with self.assertRaises(bindings.Upstream, msg=value):
                bindings.kakao_item(raw)
        raw = kakao_book(1)
        raw["datetime"] = "2026-09-01t23:30:00z"
        self.assertEqual(bindings.kakao_item(raw)["publicationDate"], "2026-09-01")
        raw["datetime"] = "2026-09-01 23:30:00.123456789-05:00"
        self.assertEqual(bindings.kakao_item(raw)["publicationDate"], "2026-09-01")

    def test_missing_key_is_503_and_status_flag(self):
        with mock.patch.dict(os.environ, {bindings.KAKAO_KEY_ENV: ""}):
            detail = self.code(self.client.get(PREFIX + "/search/kakao", params={"query": "스틸 볼 런"},
                                               headers=self.auth), 503, "kakaoSearchUnavailable")
            self.assertEqual(detail["provider"], "kakao")
            self.assertFalse(self.ok(self.client.get(PREFIX + "/status", headers=self.auth))["kakaoSearch"])
        with mock.patch.dict(os.environ, {bindings.KAKAO_KEY_ENV: "bad key\r\n"}):
            self.code(self.client.get(PREFIX + "/search/kakao", params={"query": "스틸 볼 런"}, headers=self.auth),
                      503, "kakaoSearchUnavailable")
        self.assertEqual(self.http.calls, [])
        status = self.ok(self.client.get(PREFIX + "/status", headers=self.auth))
        self.assertEqual(status, {"version": 1, "mangadexSearch": True, "kakaoSearch": True, "bindRequests": True,
                                  "publisherSeenAt": None})

    def test_upstream_errors(self):
        def raise_(status):
            def handler(*a):
                raise bindings.Upstream("status", status)
            return handler
        self.http.handlers["dapi.kakao.com"] = raise_(401)
        self.code(self.client.get(PREFIX + "/search/kakao", params={"query": "q1"}, headers=self.auth),
                  503, "kakaoCredentialRejected")
        self.http.handlers["dapi.kakao.com"] = lambda *a: json.dumps(
            {"meta": {"is_end": False}, "documents": []}).encode()
        self.code(self.client.get(PREFIX + "/search/kakao", params={"query": "q2"}, headers=self.auth),
                  502, "bindSearchInvalidResponse")
        self.http.handlers["dapi.kakao.com"] = lambda *a: json.dumps(
            {"meta": {"is_end": False}, "documents": [kakao_book(1)]}).encode()
        with mock.patch.object(bindings, "KAKAO_MAX_PAGES", 3):
            self.code(self.client.get(PREFIX + "/search/kakao", params={"query": "q3"}, headers=self.auth),
                      422, "kakaoSearchTooBroad")


class BindRequests(Base):
    def mangadex(self, collection="m1", operation=None, manga_id=MANGA_ID, expected=None, headers=None):
        body = {"version": 1, "operationId": operation or str(uuid.uuid4()), "collectionId": collection,
                "provider": "mangadex", "choice": {"mangaId": manga_id, "title": "던전밥"}}
        if expected is not None:
            body["expected"] = expected
        return self.client.post(PREFIX + "/requests", json=body, headers=headers or self.auth)

    def kakao(self, collection="m1", operation=None, **choice):
        body = {"version": 1, "operationId": operation or str(uuid.uuid4()), "collectionId": collection,
                "provider": "kakao", "choice": {"query": "스틸 볼 런", "anchorItemId": "isbn13:9788954677530",
                                                "groupFingerprint": "a" * 64, "title": "스틸 볼 런",
                                                "publisher": "문학동네", "volumeCount": 24, **choice}}
        return self.client.post(PREFIX + "/requests", json=body, headers=self.auth)

    def log(self, after=0, **params):
        return self.client.get(PREFIX + "/log", params={"after": after, **params}, headers=self.publisher)

    def result(self, request_id, state, reason=None, headers=None):
        return self.client.post(f"{PREFIX}/requests/{request_id}/result",
                                json={"version": 1, "state": state, "reason": reason}, headers=headers or self.publisher)

    def test_create_and_idempotency(self):
        operation = str(uuid.uuid4())
        first = self.ok(self.mangadex(operation=operation, expected={"externalId": None}))["request"]
        self.assertEqual(first["state"], "pending")
        self.assertEqual(first["requestId"], 1)
        self.assertEqual(first["choice"], {"mangaId": MANGA_ID, "title": "던전밥", "coverUrl": None})
        self.assertEqual(first["expected"], {"externalId": None})
        self.assertIsNone(first["replaces"])
        again = self.ok(self.mangadex(operation=operation, expected={"externalId": None}))["request"]
        self.assertEqual(again, first)
        self.code(self.mangadex(operation=operation, collection="m2"), 409, "operationConflict")
        self.assertEqual(self.ok(self.log())["lastSequence"], 1)

    def test_manga_only_and_validation(self):
        self.code(self.mangadex(collection="f1"), 409, "collectionNotManga")
        self.code(self.mangadex(collection="missing"), 404, "collectionNotFound")
        self.code(self.mangadex(manga_id="D1A9FDEB-F713-407F-960C-8326B586E6FD"), 422, "invalidBindRequest")
        self.code(self.mangadex(operation="not-a-uuid-not-a-uuid-not-a-uuid-123"), 422, "invalidBindRequest")
        self.code(self.kakao(groupFingerprint="xyz"), 422, "invalidBindRequest")
        self.code(self.kakao(query=" 스틸 "), 422, "invalidBindRequest")
        self.code(self.kakao(extra=1), 422, "invalidBindRequest")
        body = {"version": 1, "operationId": str(uuid.uuid4()), "collectionId": "m1", "provider": "mangadex",
                "choice": {"mangaId": MANGA_ID, "title": "x" * 20_000}}
        self.code(self.client.post(PREFIX + "/requests", json=body, headers=self.auth), 413, "bindRequestTooLarge")
        self.assertEqual(self.mangadex(headers=self.publisher).status_code, 200)  # publisher may use client routes
        self.assertEqual(self.client.post(PREFIX + "/requests", json={}).status_code, 401)

    def kakao_groups(self, groups, **choice):
        body = {"version": 1, "operationId": str(uuid.uuid4()), "collectionId": "m1", "provider": "kakao",
                "choice": {"query": "찍히지 않습니다", "groups": groups, "title": "찍히지 않습니다", **choice}}
        return self.client.post(PREFIX + "/requests", json=body, headers=self.auth)

    def test_kakao_legacy_single_choice_is_normalized_to_groups(self):
        request = self.ok(self.kakao())["request"]
        self.assertEqual(request["choice"], {
            "query": "스틸 볼 런", "groups": [{"anchorItemId": "isbn13:9788954677530", "groupFingerprint": "a" * 64,
                                           "title": "스틸 볼 런", "volumeCount": 24}],
            "title": "스틸 볼 런", "author": None, "publisher": "문학동네", "volumeCount": 24, "thumbnailUrl": None})
        logged = self.ok(self.log())["items"][0]
        self.assertEqual(logged["choice"], request["choice"])
        self.code(self.kakao(groups=[{"anchorItemId": "x", "groupFingerprint": "b" * 64}]), 422, "invalidBindRequest")

    def test_kakao_multi_group_choice_from_the_tablet(self):
        # The exact shape the tablet sends: unknown group fields omitted, groups ordered by
        # volume range, explicit top-level nulls, volumeCount = sum of the groups' counts.
        groups = [
            {"anchorItemId": "isbn13:9791138490010", "groupFingerprint": "a" * 64, "title": "찍히지 않습니다",
             "firstVolume": 1, "lastVolume": 6, "volumeCount": 6},
            {"anchorItemId": "isbn13:9791138491150", "groupFingerprint": "b" * 64, "firstVolume": 7,
             "lastVolume": 7, "volumeCount": 1},
        ]
        request = self.ok(self.kakao_groups(groups, author=None, publisher=None, thumbnailUrl=None,
                                            volumeCount=7))["request"]
        self.assertEqual(request["choice"], {"query": "찍히지 않습니다", "groups": groups, "title": "찍히지 않습니다",
                                             "author": None, "publisher": None, "volumeCount": 7,
                                             "thumbnailUrl": None})
        self.assertEqual(self.ok(self.log())["items"][0]["choice"]["groups"], groups)

    def test_kakao_groups_bounds_and_uniqueness(self):
        def group(n):
            return {"anchorItemId": f"isbn13:{n}", "groupFingerprint": f"{n:064x}"}
        self.assertEqual(len(self.ok(self.kakao_groups([group(n) for n in range(10)]))["request"]["choice"]["groups"]), 10)
        self.code(self.kakao_groups([group(n) for n in range(11)]), 422, "invalidBindRequest")
        self.code(self.kakao_groups([]), 422, "invalidBindRequest")
        self.code(self.kakao_groups([group(1), {**group(1), "anchorItemId": "isbn13:other"}]), 422,
                  "invalidBindRequest")
        self.code(self.kakao_groups([{**group(1), "groupFingerprint": "A" * 64}]), 422, "invalidBindRequest")
        # A null optional group field is tolerated and not stored.
        stored = self.ok(self.kakao_groups([{**group(1), "title": None}]))["request"]["choice"]["groups"]
        self.assertEqual(stored, [group(1)])
        self.code(self.kakao_groups([{**group(1), "extra": 1}]), 422, "invalidBindRequest")
        self.code(self.kakao_groups([{"groupFingerprint": "c" * 64}]), 422, "invalidBindRequest")

    def test_newer_request_replaces_pending_per_provider(self):
        first = self.ok(self.kakao())["request"]
        mangadex = self.ok(self.mangadex())["request"]
        second = self.ok(self.kakao(anchorItemId="isbn13:1"))["request"]
        self.assertEqual(second["replaces"], first["requestId"])
        listing = self.ok(self.client.get(PREFIX + "/requests", params={"collectionId": "m1"}, headers=self.auth))
        states = {item["requestId"]: item["state"] for item in listing["items"]}
        self.assertEqual(states, {first["requestId"]: "superseded", mangadex["requestId"]: "pending",
                                  second["requestId"]: "pending"})
        self.assertEqual(listing["pending"]["kakao"]["requestId"], second["requestId"])
        self.assertEqual(listing["pending"]["mangadex"]["requestId"], mangadex["requestId"])
        pending = self.ok(self.client.get(PREFIX + "/requests", params={"state": "pending"}, headers=self.auth))
        self.assertEqual({i["requestId"] for i in pending["items"]}, {mangadex["requestId"], second["requestId"]})
        self.assertIsNone(pending["pending"])
        other = self.ok(self.client.get(PREFIX + "/requests", params={"collectionId": "m2"}, headers=self.auth))
        self.assertEqual(other["items"], [])
        self.assertEqual(other["pending"], {"mangadex": None, "kakao": None})

    def test_publisher_log_cursor_and_etag(self):
        ids = [self.ok(self.mangadex(collection=c))["request"]["requestId"] for c in ("m1", "m2")]
        ids.append(self.ok(self.kakao())["request"]["requestId"])
        page = self.ok(self.log(limit=2))
        self.assertEqual([i["requestId"] for i in page["items"]], ids[:2])
        self.assertTrue(page["hasMore"])
        self.assertEqual(page["nextCursor"], ids[1])
        self.assertEqual(page["oldestPendingSequence"], ids[0])
        rest = self.ok(self.log(after=page["nextCursor"]))
        self.assertEqual([i["requestId"] for i in rest["items"]], ids[2:])
        self.assertFalse(rest["hasMore"])
        empty = self.log(after=rest["nextCursor"])
        self.assertEqual(self.ok(empty)["items"], [])
        self.assertEqual(self.client.get(PREFIX + "/log", params={"after": rest["nextCursor"]},
                                         headers={**self.publisher, "If-None-Match": empty.headers["ETag"]}).status_code, 304)
        self.code(self.log(after=99), 409, "bindCursorRejected")
        self.assertIsNotNone(self.ok(self.client.get(PREFIX + "/status", headers=self.auth))["publisherSeenAt"])
        listing = self.client.get(PREFIX + "/requests", headers=self.auth)
        self.assertEqual(self.client.get(PREFIX + "/requests", headers={**self.auth,
                                         "If-None-Match": listing.headers["ETag"]}).status_code, 304)

    def test_state_transitions_via_publisher_report(self):
        applied = self.ok(self.mangadex())["request"]["requestId"]
        failed = self.ok(self.kakao())["request"]["requestId"]
        done = self.ok(self.result(applied, "applied"))["request"]
        self.assertEqual(done["state"], "applied")
        self.assertIsNotNone(done["resolvedAt"])
        self.assertEqual(self.ok(self.result(applied, "applied"))["request"], done)  # replay
        self.code(self.result(applied, "failed", {"code": "x", "message": "y"}), 409, "bindResultConflict")
        self.code(self.result(failed, "failed"), 422, "invalidBindResult")  # reason required
        reason = {"code": "bindingChanged", "message": "PC에서 이미 다른 작품에 연결되어 있습니다."}
        self.assertEqual(self.ok(self.result(failed, "failed", reason))["request"]["reason"], reason)
        self.code(self.result(999, "applied"), 404, "bindRequestNotFound")
        # A superseded request the PC applied anyway records its outcome; the newer one stays pending.
        old = self.ok(self.mangadex(collection="m2"))["request"]["requestId"]
        new = self.ok(self.mangadex(collection="m2"))["request"]["requestId"]
        self.assertEqual(self.ok(self.result(old, "applied"))["request"]["state"], "applied")
        pending = self.ok(self.client.get(PREFIX + "/requests", params={"collectionId": "m2"}, headers=self.auth))
        self.assertEqual(pending["pending"]["mangadex"]["requestId"], new)
        # A new request after resolution is independent.
        self.assertIsNone(self.ok(self.mangadex())["request"]["replaces"])

    def test_status_head_and_signal_follow_requests_and_results(self):
        """publisherLogs.bindings mirrors `/log`; signals.bindingRequests moves on file and resolve."""
        def heads():
            with self.get_db() as db:
                return bindings.status_head(db), bindings.status_signal(db)
        head, signal = heads()
        self.assertEqual((head["last"], head["oldestPending"]), (0, None))
        self.assertRegex(head["logEpoch"], r"^[0-9a-f]{32}$")
        self.assertEqual(signal, {"last": 0, "updatedAt": None})
        first = self.ok(self.mangadex())["request"]["requestId"]
        second = self.ok(self.kakao())["request"]["requestId"]
        head, filed = heads()
        page = self.ok(self.log())
        self.assertEqual(head, {"logEpoch": page["logEpoch"], "last": page["lastSequence"],
                                "oldestPending": page["oldestPendingSequence"]})
        self.assertEqual((head["last"], head["oldestPending"]), (second, first))
        self.assertEqual(filed["last"], second)
        self.ok(self.result(first, "applied"))
        head, resolved = heads()
        self.assertEqual((head["last"], head["oldestPending"]), (second, second))
        self.assertEqual(resolved["last"], second)
        self.assertNotEqual(resolved, filed)

    def test_log_epoch(self):
        first = self.ok(self.log())
        self.assertRegex(first["logEpoch"], r"^[0-9a-f]{32}$")
        self.assertEqual(self.ok(self.log())["logEpoch"], first["logEpoch"])
        self.assertEqual(self.code(self.log(after=5), 409, "bindCursorRejected")["logEpoch"], first["logEpoch"])
        with self.get_db() as db:  # a server restart (e.g. after a database restore)
            bindings.startup_db(db)
            db.commit()
        self.assertNotEqual(self.ok(self.log())["logEpoch"], first["logEpoch"])

    def test_malformed_values_use_the_documented_shape(self):
        for params in ({"limit": "abc"}, {"limit": "0"}, {"limit": "51"}, {"state": "done"},
                       {"collectionId": "bad id"}):
            self.code(self.client.get(PREFIX + "/requests", params=params, headers=self.auth), 422, "invalidBindRequest")
        for params in ({"after": "-1"}, {"after": "x"}, {"limit": "201"}):
            self.code(self.client.get(PREFIX + "/log", params=params, headers=self.publisher), 422, "invalidBindRequest")
        for request_id in ("abc", "0", "-3"):
            self.code(self.client.post(f"{PREFIX}/requests/{request_id}/result",
                                       json={"version": 1, "state": "applied"}, headers=self.publisher),
                      422, "invalidBindResult")
        self.code(self.client.post(f"{PREFIX}/requests/1/result", content=b"{", headers=self.publisher),
                  422, "invalidBindResult")
        self.code(self.client.post(PREFIX + "/requests", content=b"[]", headers=self.auth), 422, "invalidBindRequest")
        # Auth first: a malformed value from an unauthenticated caller is still 401.
        self.assertEqual(self.client.get(PREFIX + "/log", params={"after": "x"}, headers=self.auth).status_code, 401)
        self.assertEqual(self.client.get(PREFIX + "/requests", params={"limit": "x"}).status_code, 401)

    def test_roles(self):
        request_id = self.ok(self.mangadex())["request"]["requestId"]
        self.assertEqual(self.client.get(PREFIX + "/log", headers=self.auth).status_code, 401)
        self.assertEqual(self.result(request_id, "applied", headers=self.auth).status_code, 401)
        self.assertEqual(self.client.get(PREFIX + "/requests").status_code, 401)

    def test_pending_limit_and_retention(self):
        with mock.patch.object(bindings, "MAX_PENDING", 2):
            self.ok(self.mangadex(collection="m1"))
            self.ok(self.mangadex(collection="m2"))
            self.code(self.kakao(collection="m1"), 409, "bindRequestLimit")
            self.ok(self.mangadex(collection="m1"))  # replacing a pending one is always allowed
        with mock.patch.object(bindings, "RESOLVED_MAX", 1):
            first = self.ok(self.kakao(collection="m2"))["request"]["requestId"]
            self.ok(self.kakao(collection="m2"))
            with self.get_db() as db:
                rows = db.execute("SELECT state,COUNT(*) FROM collection_binding_requests GROUP BY state").fetchall()
                self.assertEqual(dict((r[0], r[1]) for r in rows), {"pending": 3, "superseded": 1})
                # The oldest resolved row (request 1, superseded by 3) was pruned; request 4 stays.
                self.assertIsNone(db.execute("SELECT 1 FROM collection_binding_requests WHERE sequence=1").fetchone())
                self.assertEqual(db.execute("SELECT state FROM collection_binding_requests WHERE sequence=?",
                                            (first,)).fetchone()[0], "superseded")


class RealApplication(unittest.TestCase):
    """The static bindings paths must win over `/v1/collections/{id}` in the real app."""

    def setUp(self):
        from tests import test_mobile_collections as fixtures
        self.fixtures = fixtures
        fixtures.MobileCollectionsTests.setUp(self)
        with fixtures.api_app.get_db() as db:
            api_auth.startup(fixtures.api_app.get_db)
            _, publisher = api_auth.provision_token(db, "publisher", "fixture")
            db.commit()
        self.publisher = {"Authorization": "Bearer " + publisher}

    def tearDown(self):
        self.fixtures.MobileCollectionsTests.tearDown(self)

    def test_routes_are_not_shadowed(self):
        auth = self.fixtures.AUTH
        self.assertEqual(self.client.put("/v1/collections/replica", headers=auth, json={
            "version": 1, "baseRevision": None,
            "collections": [self.fixtures.work("bindings"), self.fixtures.work("c1")]}).status_code, 200)
        with mock.patch.dict(os.environ, {bindings.KAKAO_KEY_ENV: ""}):
            status = self.client.get(PREFIX + "/status", headers=auth)
            self.assertEqual(status.status_code, 200, status.text)
            self.assertFalse(status.json()["kakaoSearch"])
            self.assertEqual(self.client.get("/v1/collections/status", headers=auth).json()["collectionBindings"],
                             {"version": 1, "mangadexSearch": True, "kakaoSearch": False, "bindRequests": True})
        body = {"version": 1, "operationId": str(uuid.uuid4()), "collectionId": "c1", "provider": "mangadex",
                "choice": {"mangaId": MANGA_ID, "title": "던전밥"}}
        self.assertEqual(self.client.post(PREFIX + "/requests", headers=auth, json=body).status_code, 200)
        body["operationId"], body["collectionId"] = str(uuid.uuid4()), "missing"
        self.assertEqual(self.client.post(PREFIX + "/requests", headers=auth, json=body).status_code, 404)
        self.assertEqual(self.client.get(PREFIX + "/requests", headers=auth).status_code, 200)
        self.assertEqual(len(self.client.get(PREFIX + "/log", headers=self.publisher).json()["items"]), 1)
        self.assertEqual(self.client.get("/v1/collections/c1", headers=auth).json()["item"]["id"], "c1")


if __name__ == "__main__":
    unittest.main()
