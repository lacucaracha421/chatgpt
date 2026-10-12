"""Isolated subtitle contract tests, also collectable by pytest."""
import asyncio
import json
import sqlite3
import tempfile
import unittest
import zlib
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI, HTTPException

import api_auth
import extension_subtitles as subtitles
from app_lifecycle import lifecycle


class ExtensionSubtitlesTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "subtitles.sqlite"

        @contextmanager
        def get_db():
            db = sqlite3.connect(self.path, timeout=5)
            try:
                yield db
            finally:
                db.close()

        self.get_db = get_db
        api_auth.startup(get_db)
        with get_db() as db:
            _, self.catalog_token = api_auth.provision_token(db, "client")
            db.execute("CREATE TABLE extension_clients(id TEXT, token_hash TEXT, revoked_at TEXT)")
            db.executemany("INSERT INTO extension_clients VALUES(?,?,?)", [
                ("installation-a", api_auth.token_hash("paired-a"), None),
                ("installation-b", api_auth.token_hash("paired-b"), None),
                ("other-library", api_auth.token_hash("paired-other"), None),
                ("no-scope", api_auth.token_hash("paired-no-scope"), None),
                ("revoked", api_auth.token_hash("paired-revoked"), "revoked"),
            ])
            db.commit()

        def guard(authorization):
            if authorization == "Bearer shared":
                return "admin"
            token = api_auth._bearer(authorization)
            with get_db() as db:
                row = db.execute("SELECT id FROM extension_clients WHERE token_hash=? AND revoked_at IS NULL",
                                 (api_auth.token_hash(token),)).fetchone()
            if row is None:
                raise HTTPException(401, "Unauthorized")
            return row[0]

        self.scopes = {"other-library": "other", "no-scope": None}
        self.app = FastAPI()
        self.startup = subtitles.register(
            self.app, get_db, guard,
            resolve_scope=lambda principal: self.scopes.get(principal, "library"),
        )
        self.startup()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()
        self.temp.cleanup()

    def headers(self, token="paired-a"):
        return {"Authorization": f"Bearer {token}"}

    def body(self, **updates):
        return {"video": "abcDEF_123-", "track": "en:manual", "mode": "translated-haeyo-v1",
                "model": "translator", "createdAt": 1720000000000, "register": "haeyo",
                "glossary": [{"source": "hello", "korean": "안녕"}],
                "cues": [{"startMs": 0, "endMs": 1000, "text": "안녕하세요", "orig": "Hello", "speaker": 1},
                         {"startMs": 1000, "endMs": 1000, "text": ""}], **updates}

    async def put(self, body=None, token="paired-a"):
        return await self.client.put(subtitles.PATH, headers=self.headers(token),
                                     json=self.body() if body is None else body)

    async def get(self, token="paired-a", **key):
        body = self.body()
        params = {name: body[name] for name in ("video", "track", "mode")}
        return await self.client.get(subtitles.PATH, headers=self.headers(token), params={**params, **key})

    async def test_authentication_and_scope_rejections_for_every_method(self):
        for headers in ({}, self.headers("invalid"), self.headers("paired-revoked"),
                        self.headers(self.catalog_token), {"Authorization": "Basic paired-a"}):
            for method in ("GET", "PUT", "DELETE"):
                with self.subTest(headers=headers, method=method):
                    response = await self.client.request(method, subtitles.PATH, headers=headers, json=self.body())
                    self.assertEqual(response.status_code, 401, response.text)
        for scope in (None, "", 12, "a" * 241):
            self.scopes["no-scope"] = scope
            for method in ("GET", "PUT", "DELETE"):
                response = await self.client.request(method, subtitles.PATH,
                                                     headers=self.headers("paired-no-scope"), json=self.body())
                self.assertEqual(response.status_code, 403, response.text)

    async def test_get_absent_then_exact_roundtrip(self):
        absent = await self.get()
        self.assertEqual((absent.status_code, absent.json()), (404, {"code": "not_found"}))
        written = await self.put()
        self.assertEqual((written.status_code, written.json()), (200, {"ok": True}))
        restored = await self.get()
        self.assertEqual((restored.status_code, restored.json()), (200, {"version": 1, **self.body()}))
        self.assertNotIn("orig", restored.json()["cues"][1])
        self.assertNotIn("speaker", restored.json()["cues"][1])

    async def test_upsert_compressed_payload_and_server_timestamps(self):
        with patch.object(subtitles.time, "time_ns", return_value=1_000_000_000):
            self.assertEqual((await self.put()).status_code, 200)
        replacement = self.body(model="new-model", createdAt=100, register=None, glossary=[])
        with patch.object(subtitles.time, "time_ns", return_value=2_000_000_000):
            self.assertEqual((await self.put(replacement, token="paired-b")).status_code, 200)
        self.assertEqual((await self.get()).json(), {"version": 1, **replacement})
        self.startup()
        with self.get_db() as db:
            rows = db.execute("SELECT payload,created_at,updated_at FROM extension_subtitles").fetchall()
            self.assertEqual(len(rows), 1)
            payload, created, updated = rows[0]
            self.assertEqual((created, updated), (1000, 2000))
            self.assertIsInstance(payload, bytes)
            compact = zlib.decompress(payload)
            self.assertEqual(compact, json.dumps({"version": 1, **replacement}, ensure_ascii=False,
                                                separators=(",", ":")).encode())

    async def test_scope_is_shared_by_installations_and_isolated_by_library(self):
        await self.put()
        for token in ("paired-b", "shared"):
            self.assertEqual((await self.get(token)).json(), {"version": 1, **self.body()})
        self.assertEqual((await self.get("paired-other")).status_code, 404)
        other = self.body(model="other-model")
        await self.put(other, "paired-other")
        self.assertEqual((await self.get("paired-other")).json()["model"], "other-model")
        self.assertEqual((await self.get()).json()["model"], "translator")
        response = await self.client.get(subtitles.PATH, headers=self.headers(),
                                         params={**{k: self.body()[k] for k in ("video", "track", "mode")},
                                                 "scope": "other"})
        self.assertEqual(response.json()["model"], "translator")

    async def test_delete_counts_all_keys_in_only_current_scope(self):
        for body in (self.body(), self.body(video="another-id"), self.body(track="ko:auto"),
                     self.body(mode="original")):
            self.assertEqual((await self.put(body)).status_code, 200)
        await self.put(token="paired-other")
        response = await self.client.delete(subtitles.PATH, headers=self.headers("paired-b"))
        self.assertEqual((response.status_code, response.json()), (200, {"ok": True, "deleted": 4}))
        self.assertEqual((await self.get()).status_code, 404)
        self.assertEqual((await self.get("paired-other")).status_code, 200)
        response = await self.client.delete(subtitles.PATH, headers=self.headers())
        self.assertEqual(response.json(), {"ok": True, "deleted": 0})

    async def test_invalid_keys_return_contract_errors_on_get_and_put(self):
        invalid = {"video": ["short", "v" * 21, "invalid/id", "abcdef\n", 123, None],
                   "track": ["en", "en:", ":auto", "en:auto:extra", "a" * 36 + ":auto", "en:auto\n", None],
                   "mode": ["m" * 81, "한글", "control\x7f", "newline\n", None]}
        for field, values in invalid.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    response = await self.put(self.body(**{field: value}))
                    self.assertEqual((response.status_code, response.json()), (400, {"code": "invalid"}))
                    # httpx encodes None as an empty query value; an empty mode
                    # is valid, whereas an omitted mode is tested below.
                    if field != "mode" or value is not None:
                        response = await self.get(**{field: value})
                        self.assertEqual((response.status_code, response.json()), (400, {"code": "invalid"}))
        for missing in ("video", "track", "mode"):
            params = {k: self.body()[k] for k in ("video", "track", "mode") if k != missing}
            response = await self.client.get(subtitles.PATH, headers=self.headers(), params=params)
            self.assertEqual((response.status_code, response.json()), (400, {"code": "invalid"}))

    async def test_invalid_documents_and_malformed_json(self):
        cue = {"startMs": 0, "endMs": 1, "text": "text"}
        patches = [{"model": "m" * 81}, {"model": 1}, {"createdAt": True},
                   {"createdAt": "1"}, {"register": "formal"}, {"register": 1},
                   {"glossary": [{"source": "s", "korean": "k"}] * 241},
                   {"glossary": [{"source": "s" * 81, "korean": "k"}]},
                   {"glossary": [{"source": "s", "korean": "k" * 81}]},
                   {"glossary": [{"source": 1, "korean": "k"}]}, {"glossary": [{}]},
                   {"glossary": None}, {"cues": []}, {"cues": [cue] * 20001},
                   {"cues": None}, {"cues": [{}]}, {"version": 1}, {"scope": "other"}]
        for field, value in (("startMs", -1), ("startMs", True), ("startMs", 0.5), ("startMs", "0"),
                             ("endMs", -1), ("endMs", False), ("endMs", 0.5), ("endMs", "1"),
                             ("text", "t" * 501), ("text", None), ("orig", "o" * 501),
                             ("orig", None), ("orig", 1), ("speaker", -1), ("speaker", 100),
                             ("speaker", None), ("speaker", True), ("speaker", 1.5), ("speaker", "1"),
                             ("extra", "x")):
            patches.append({"cues": [{**cue, field: value}]})
        patches.append({"cues": [{**cue, "startMs": 2}]})
        for index, updates in enumerate(patches):
            with self.subTest(case=index):
                response = await self.put(self.body(**updates))
                self.assertEqual((response.status_code, response.json()), (400, {"code": "invalid"}))
        for field in self.body():
            body = self.body()
            del body[field]
            self.assertEqual((await self.put(body)).status_code, 400)
        for raw in (b"{", b"[]", b"null", b"\xff"):
            response = await self.client.put(subtitles.PATH, headers=self.headers(), content=raw)
            self.assertEqual((response.status_code, response.json()), (400, {"code": "invalid"}))
        self.assertEqual((await self.get()).status_code, 404)

    async def test_inclusive_field_and_collection_limits(self):
        body = self.body(video="v" * 20, track="a" * 35 + ":auto", mode="m" * 80, model="m" * 80,
                         glossary=[{"source": "s" * 80, "korean": "한" * 80}] * 240,
                         cues=[{"startMs": 0, "endMs": 0, "text": "한" * 500, "orig": "o" * 500}])
        self.assertEqual((await self.put(body)).status_code, 200)
        for register in (None, "haeyo", "hapnida", "banmal"):
            response = await self.put(self.body(video="a" * 6, mode="", register=register,
                                                cues=[{"startMs": 0, "endMs": 0, "text": ""}] * 20000))
            self.assertEqual(response.status_code, 200, response.text)

    async def test_body_byte_cap_exact_limit_chunked_and_unicode(self):
        encoded = json.dumps(self.body()).encode()
        exact = encoded + b" " * (subtitles.MAX_BYTES - len(encoded))
        response = await self.client.put(subtitles.PATH, headers=self.headers(), content=exact)
        self.assertEqual(response.status_code, 200, response.text)
        for content in (exact + b" ", b" " * (subtitles.MAX_BYTES + 1)):
            response = await self.client.put(subtitles.PATH, headers=self.headers(), content=content)
            self.assertEqual((response.status_code, response.json()), (413, {"code": "too_large"}))

        async def chunks():
            yield exact[:100]
            yield exact[100:]
            yield b" "

        response = await self.client.put(subtitles.PATH, headers={**self.headers(), "Content-Length": "1"},
                                         content=chunks())
        self.assertEqual((response.status_code, response.json()), (413, {"code": "too_large"}))
        unicode_body = self.body(cues=[{"startMs": 0, "endMs": 1, "text": "한" * 500}] * 3000)
        raw = json.dumps(unicode_body, ensure_ascii=False).encode()
        self.assertLess(len(raw.decode()), subtitles.MAX_BYTES)
        self.assertGreater(len(raw), subtitles.MAX_BYTES)
        response = await self.client.put(subtitles.PATH, headers=self.headers(), content=raw)
        self.assertEqual((response.status_code, response.json()), (413, {"code": "too_large"}))
        self.assertEqual((await self.get()).json(), {"version": 1, **self.body()})

    async def test_competing_upserts_and_idempotent_startup_index(self):
        results = await asyncio.gather(self.put(), self.put(self.body(model="second"), "paired-b"))
        self.assertEqual([response.status_code for response in results], [200, 200])
        self.startup()
        self.assertIn(self.startup, lifecycle(self.app).startup_handlers)
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM extension_subtitles").fetchone()[0], 1)
            columns = db.execute("PRAGMA index_info(extension_subtitles_scope_video)").fetchall()
            self.assertEqual([column[2] for column in columns], ["scope", "video"])
            self.assertEqual(db.execute("PRAGMA quick_check").fetchone()[0], "ok")


if __name__ == "__main__":
    unittest.main()
