"""Isolated settings API tests: no app.py, R2, or production database imports."""
import asyncio
import json
import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException

import api_auth
import extension_settings as settings


class ExtensionSettingsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "settings.sqlite"

        @contextmanager
        def get_db():
            db = sqlite3.connect(self.path, timeout=5)
            db.row_factory = sqlite3.Row
            try:
                yield db
            finally:
                db.close()

        self.get_db = get_db
        api_auth.startup(get_db)
        with get_db() as db:
            self.catalog_id, self.catalog_token = api_auth.provision_token(db, "client")
            db.execute("CREATE TABLE extension_clients(id TEXT, token_hash TEXT, revoked_at TEXT)")
            db.executemany("INSERT INTO extension_clients VALUES(?,?,?)", [
                ("installation-a", api_auth.token_hash("paired-a"), None),
                ("installation-b", api_auth.token_hash("paired-b"), None),
                ("other-library", api_auth.token_hash("paired-other"), None),
                ("revoked", api_auth.token_hash("paired-revoked"), "revoked"),
            ])
            db.commit()

        # Same credential boundary as require_admin_or_extension, without
        # importing the production app and its external-service dependencies.
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

        self.app = FastAPI()
        self.startup = settings.register(
            self.app, get_db, guard,
            resolve_scope=lambda principal: "other" if principal == "other-library" else "library",
        )
        self.startup()
        # Async transport avoids TestClient's blocking portal in restricted
        # environments while exercising FastAPI routing and validation.
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()
        self.temp.cleanup()

    def headers(self, token="paired-a", **extra):
        return {"Authorization": f"Bearer {token}", **extra}

    def body(self, revision=0):
        return {"schemaVersion": 1, "listOrder": {"__root__": ["mingchao", "reverse"]},
                "hiddenClassificationIds": ["reverse"], "expectedRevision": revision}

    async def put(self, body=None, token="paired-a", **headers):
        return await self.client.put(settings.PATH, json=self.body() if body is None else body,
                                     headers=self.headers(token, **headers))

    async def test_empty_document_etag_and_conditional_get(self):
        response = await self.client.get(settings.PATH, headers=self.headers())
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"schemaVersion": 1, "listOrder": {}, "hiddenClassificationIds": [], "revision": 0})
        self.assertEqual(response.headers["etag"], '"0"')
        cached = await self.client.get(settings.PATH, headers=self.headers(**{"If-None-Match": '"0"'}))
        self.assertEqual(cached.status_code, 304)
        self.assertEqual(cached.content, b"")

    async def test_reinstall_uses_library_scope_not_installation_id(self):
        written = await self.put()
        self.assertEqual(written.status_code, 200, written.text)
        self.assertEqual(written.headers["etag"], '"1"')
        for token in ("paired-b", "shared"):
            restored = await self.client.get(settings.PATH, headers=self.headers(token))
            self.assertEqual(restored.json(), written.json())
        other = await self.client.get(settings.PATH, headers=self.headers("paired-other"))
        self.assertEqual(other.json()["revision"], 0)
        self.assertEqual((await self.put(token="paired-other")).status_code, 200)

    async def test_authentication_rejects_missing_revoked_and_catalog_credentials(self):
        for headers in ({}, self.headers("invalid"), self.headers("paired-revoked"), self.headers(self.catalog_token)):
            self.assertEqual((await self.client.get(settings.PATH, headers=headers)).status_code, 401)
            self.assertEqual((await self.client.put(settings.PATH, headers=headers, json=self.body())).status_code, 401)
        # api_auth intentionally does not authorize paired extension credentials.
        with self.assertRaises(HTTPException):
            api_auth.client_guard(self.get_db, "shared")("Bearer paired-a")

    async def test_conflict_retry_and_clear(self):
        self.assertEqual((await self.put()).status_code, 200)
        stale = await self.put()
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json()["detail"]["revision"], 1)
        current = (await self.client.get(settings.PATH, headers=self.headers())).json()
        body = {**self.body(current["revision"]), "listOrder": {}, "hiddenClassificationIds": []}
        updated = await self.put(body)
        self.assertEqual(updated.json()["revision"], 2)
        self.assertEqual(updated.json()["hiddenClassificationIds"], [])

    async def test_if_match_and_required_preconditions(self):
        body = self.body()
        del body["expectedRevision"]
        self.assertEqual((await self.put(body)).status_code, 428)
        self.assertEqual((await self.put(body, **{"If-Match": '"0"'})).status_code, 200)
        self.assertEqual((await self.put(body, **{"If-Match": '"0"'})).status_code, 409)
        self.assertEqual((await self.put(self.body(1), **{"If-Match": '"2"'})).status_code, 400)
        for etag in ("*", 'W/"1"', "1", '"-1"'):
            self.assertEqual((await self.put(body, **{"If-Match": etag})).status_code, 400)

    async def test_strict_models_reject_extra_coercions_and_invalid_ids(self):
        invalid = [
            {"unexpected": 1}, {"scope": "other"}, {"schemaVersion": "1"},
            {"schemaVersion": True}, {"schemaVersion": 2}, {"expectedRevision": "0"},
            {"expectedRevision": False}, {"expectedRevision": -1},
            {"hiddenClassificationIds": [1]}, {"hiddenClassificationIds": [""]},
            {"hiddenClassificationIds": ["a" * 241]}, {"listOrder": {"": []}},
            {"listOrder": {"root": [True]}}, {"listOrder": []},
        ]
        for patch in invalid:
            with self.subTest(patch=patch):
                response = await self.put({**self.body(), **patch})
                self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual((await self.client.put(settings.PATH, headers=self.headers(), content=b"{")).status_code, 422)

    async def test_byte_cap_includes_chunked_whitespace_and_unicode(self):
        oversized = " " * settings.MAX_BYTES + json.dumps(self.body())

        async def chunks():
            for offset in range(0, len(oversized), 512):
                yield oversized[offset:offset + 512].encode()

        response = await self.client.put(settings.PATH, headers=self.headers(), content=chunks())
        self.assertEqual(response.status_code, 413)
        body = {**self.body(), "hiddenClassificationIds": ["명" * 200] * 30}
        self.assertEqual((await self.put(body)).status_code, 413)
        self.assertEqual((await self.client.get(settings.PATH, headers=self.headers())).json()["revision"], 0)

    async def test_competing_writes_and_durable_startup(self):
        results = await asyncio.gather(self.put(), self.put(token="paired-b"))
        self.assertEqual(sorted(response.status_code for response in results), [200, 409])
        self.startup()
        with self.get_db() as db:
            self.assertEqual(db.execute("SELECT count(*),max(revision) FROM extension_settings").fetchone()[:], (1, 1))
            self.assertEqual(db.execute("PRAGMA quick_check").fetchone()[0], "ok")


if __name__ == "__main__":
    unittest.main()
