"""`/v1/sync/status` additive blocks and long-poll (PERF-ALL-001 S1/S2).

The tablet trap: the deployed tablet treats *any* change of this body (other than
`exchange`) as "the library moved" and walks its whole Picker. So a caller that does not
ask for the new blocks must keep receiving HEAD's exact bytes and ETag. The golden tests
below compare against a frozen copy of HEAD's route (encoder and tag included) and
against literal bytes, not against the module under test.

Long-poll tests run the ASGI app in-process on the test's own event loop
(`httpx.ASGITransport`), so concurrency, timing and threadpool use are real.
"""
import asyncio
import hashlib
import json
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import anyio.to_thread
import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.testclient import TestClient

import api_auth
import authority
import change_signal
import file_exchange
import sync_status
from app_lifecycle import lifecycle

STATUS = "/v1/sync/status"
LIBRARY = "a" * 32
SHARED = "shared-token"
EMPTY_BODY = b'{"protocolVersion":1,"active":false,"libraryId":null,"domains":[]}'
EMPTY_ETAG = '"874171ccf61500be7ceb0b03de334d98"'
EMPTY_EXCHANGE_BODY = (b'{"protocolVersion":1,"active":false,"libraryId":null,"domains":[],'
                       b'"exchange":{"revision":0}}')
EMPTY_EXCHANGE_ETAG = '"bd63e596572be773983526f70d7ebe90"'


# --- frozen HEAD (a1cb720) reference -------------------------------------------------
# Verbatim logic of the shipped route, with its own encoder and tag, so a change to
# `sync_status` or `conditional` cannot move both sides of the comparison together.

def head_encode(payload):
    return json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=None,
                      separators=(",", ":")).encode("utf-8")


def head_document(db, principal, exchange_status):
    exchange = None
    db.execute("BEGIN")
    try:
        domains = authority.active_domains(db)
        if exchange_status is not None:
            exchange = exchange_status(db, principal)
    finally:
        db.rollback()
    libraries = sorted({entry["libraryId"] for entry in domains})
    payload = {"protocolVersion": 1,
               "active": bool(domains),
               "libraryId": libraries[0] if libraries else None,
               "domains": [{"domain": e["domain"], "libraryId": e["libraryId"], "epoch": e["epoch"],
                            "contractVersion": e["contractVersion"], "cursor": e["cursor"]}
                           for e in domains]}
    if exchange is not None:
        payload["exchange"] = exchange
    body = head_encode(payload)
    return body, '"' + hashlib.sha256(body).hexdigest()[:32] + '"'


def authority_row(db, domain, cursor, library=LIBRARY):
    db.execute("INSERT INTO authority_domains(library_id,domain,epoch,contract_version,change_cursor,"
               "baseline_digest,baseline_revision,activated_at) VALUES(?,?,1,1,?,?,NULL,'2026-09-26')",
               [library, domain, cursor, "d" * 64])


class Database:
    """A disposable control database whose writes bump a `WriteSignal`."""

    def __init__(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "control.sqlite"
        self.signal = change_signal.WriteSignal()

        @contextmanager
        def raw():
            db = sqlite3.connect(self.path, timeout=10)
            db.row_factory = sqlite3.Row
            try:
                yield db
            finally:
                db.close()

        self.raw = raw
        self.get_db = change_signal.tracked_get_db(raw, self.signal)
        api_auth.startup(self.get_db)
        authority.startup(self.get_db)
        with self.get_db() as db:
            db.executescript(file_exchange.DDL)
            db.executescript("""
                CREATE TABLE publisher_log(singleton INTEGER PRIMARY KEY, value INTEGER NOT NULL);
                INSERT INTO publisher_log VALUES(1,0);
                CREATE TABLE tablet_signal(singleton INTEGER PRIMARY KEY, value INTEGER NOT NULL);
                INSERT INTO tablet_signal VALUES(1,0);
            """)
            db.commit()
        self.log_reads = 0
        self.signal_reads = 0

    def token(self, role):
        with self.get_db() as db:
            principal, token = api_auth.provision_token(db, role, role)
            db.commit()
        return principal, {"Authorization": f"Bearer {token}"}

    def publisher_logs(self, db):
        self.log_reads += 1
        return {"log": db.execute("SELECT value FROM publisher_log").fetchone()[0]}

    def signals(self, db):
        self.signal_reads += 1
        return {"tablet": db.execute("SELECT value FROM tablet_signal").fetchone()[0]}

    def write(self, table):
        with self.get_db() as db:
            db.execute(f"UPDATE {table} SET value=value+1")
            db.commit()

    def close(self):
        self.temp.cleanup()


def build(database, exchange=True, **options):
    app = FastAPI()
    guard = api_auth.client_guard(database.get_db, SHARED)
    sync_status.register_sync_status(
        app, database.get_db, guard, exchange_status=file_exchange.status if exchange else None,
        publisher_logs=database.publisher_logs, signals=database.signals,
        write_signal=database.signal, **options)

    # A write from another request, the way every real command reaches the database.
    @app.post("/_test/write/{table}")
    def write(table: str, authorization: str | None = Header(default=None)):
        guard(authorization)
        if table not in ("publisher_log", "tablet_signal", "authority_domains"):
            raise HTTPException(404)
        if table == "authority_domains":
            with database.get_db() as db:
                count = db.execute("SELECT COUNT(*) FROM authority_domains").fetchone()[0]
                authority_row(db, f"domain-{count}", count)
                db.commit()
        else:
            database.write(table)
        return {"ok": True}
    return app


# --- change_signal --------------------------------------------------------------------

class WriteSignalTests(unittest.IsolatedAsyncioTestCase):
    async def test_bump_from_a_worker_thread_wakes_an_asyncio_waiter(self):
        signal = change_signal.WriteSignal()
        start = signal.generation
        waiter = asyncio.ensure_future(signal.wait_beyond(start, 5))
        while signal.waiter_count == 0:
            await asyncio.sleep(0.001)
        began = time.perf_counter()
        threading.Thread(target=signal.bump).start()
        self.assertEqual(await asyncio.wait_for(waiter, 1), start + 1)
        self.assertLess(time.perf_counter() - began, 0.25)
        self.assertEqual(signal.waiter_count, 0)

    async def test_a_bump_before_parking_is_not_lost(self):
        signal = change_signal.WriteSignal()
        seen = signal.generation
        signal.bump()  # the write lands between reading the generation and parking
        began = time.perf_counter()
        self.assertEqual(await signal.wait_beyond(seen, 5), seen + 1)
        self.assertLess(time.perf_counter() - began, 0.05)
        self.assertEqual(signal.waiter_count, 0)

    async def test_timeout_and_cancellation_deregister(self):
        signal = change_signal.WriteSignal()
        self.assertEqual(await signal.wait_beyond(signal.generation, 0.02), 0)
        self.assertEqual(signal.waiter_count, 0)
        waiter = asyncio.ensure_future(signal.wait_beyond(signal.generation, 5))
        while signal.waiter_count == 0:
            await asyncio.sleep(0.001)
        waiter.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await waiter
        self.assertEqual(signal.waiter_count, 0)

    def test_tracked_get_db_bumps_only_after_a_row_change(self):
        database = Database()
        self.addCleanup(database.close)
        before = database.signal.generation
        with database.get_db() as db:
            db.execute("BEGIN")
            db.execute("SELECT * FROM publisher_log").fetchall()
            db.rollback()
        self.assertEqual(database.signal.generation, before)
        database.write("publisher_log")
        self.assertEqual(database.signal.generation, before + 1)
        with self.assertRaises(RuntimeError):
            with database.get_db() as db:
                db.execute("UPDATE publisher_log SET value=value+1")
                raise RuntimeError("the handler failed after writing")
        self.assertEqual(database.signal.generation, before + 2)


# --- S1: payload ------------------------------------------------------------------------

class GoldenStatusTests(unittest.TestCase):
    """Callers that ask for nothing new get HEAD's bytes and ETag, byte for byte."""

    def setUp(self):
        self.database = Database()
        self.client = TestClient(build(self.database))
        _, self.client_auth = self.database.token("client")
        device, self.device_auth = self.database.token("client")
        with self.database.get_db() as db:
            db.execute("INSERT INTO exchange_devices VALUES(?,?,?,?,?,?,NULL,0)",
                       ["00000000-0000-4000-8000-000000000001", "tablet", "android", device,
                        "2026", "2026"])
            db.commit()
        self.device = device
        self.legacy_auth = {"Authorization": f"Bearer {SHARED}"}

    def tearDown(self):
        self.client.close()
        self.database.close()

    def principal(self, headers):
        return api_auth.client_guard(self.database.get_db, SHARED)(headers["Authorization"])

    def assert_head_identical(self, query=""):
        for headers in (self.legacy_auth, self.client_auth, self.device_auth):
            with self.database.raw() as db:
                body, etag = head_document(db, self.principal(headers), file_exchange.status)
            reply = self.client.get(STATUS + query, headers=headers)
            self.assertEqual(reply.status_code, 200, reply.text)
            self.assertEqual(reply.content, body)
            self.assertEqual(reply.headers["ETag"], etag)
            self.assertEqual(reply.headers["Cache-Control"], "private, no-cache")
            self.assertEqual(reply.headers["Content-Type"], "application/json")
            self.assertEqual(reply.headers[sync_status.WAIT_HEADER], "50")
            cached = self.client.get(STATUS + query, headers={**headers, "If-None-Match": etag})
            self.assertEqual((cached.status_code, cached.content, cached.headers["ETag"]), (304, b"", etag))

    def test_literal_bytes_before_any_authority(self):
        legacy = self.client.get(STATUS, headers=self.legacy_auth)
        self.assertEqual((legacy.content, legacy.headers["ETag"]), (EMPTY_BODY, EMPTY_ETAG))
        client = self.client.get(STATUS, headers=self.client_auth)
        self.assertEqual((client.content, client.headers["ETag"]), (EMPTY_EXCHANGE_BODY, EMPTY_EXCHANGE_ETAG))

    def test_identical_across_states_and_ignored_queries(self):
        queries = ("", "?signals=0", "?signals=true", "?wait=abc", "?wait=-5", "?wait=nan", "?other=1")
        for query in queries:
            self.assert_head_identical(query)
        with self.database.get_db() as db:
            authority_row(db, "albums", 7)
            authority_row(db, "catalog-bookmarks", 3)
            file_exchange.bump(db, ["00000000-0000-4000-8000-000000000001"])
            db.execute("UPDATE publisher_log SET value=9")
            db.execute("UPDATE tablet_signal SET value=4")
            db.commit()
        for query in queries:
            self.assert_head_identical(query)

    def test_identical_without_exchange(self):
        client = TestClient(build(self.database, exchange=False))
        self.addCleanup(client.close)
        for headers in (self.legacy_auth, self.client_auth, self.device_auth):
            reply = client.get(STATUS, headers=headers)
            self.assertEqual((reply.content, reply.headers["ETag"]), (EMPTY_BODY, EMPTY_ETAG))

    def test_no_new_domain_and_protocol_version_one(self):
        _, publisher = self.database.token("publisher")
        body = self.client.get(STATUS + "?signals=1", headers=publisher).json()
        self.assertEqual(body["protocolVersion"], 1)
        self.assertEqual(body["domains"], [])
        self.assertFalse(body["active"])


class RoleMatrixTests(unittest.TestCase):
    def setUp(self):
        self.database = Database()
        self.client = TestClient(build(self.database))
        _, self.publisher = self.database.token("publisher")
        _, self.client_auth = self.database.token("client")
        self.legacy = {"Authorization": f"Bearer {SHARED}"}

    def tearDown(self):
        self.client.close()
        self.database.close()

    def keys(self, headers, query=""):
        reply = self.client.get(STATUS + query, headers=headers)
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.json()

    def test_publisher_logs_only_for_the_publisher_role(self):
        base = {"protocolVersion", "active", "libraryId", "domains"}
        self.assertEqual(set(self.keys(self.legacy)), base)
        self.assertEqual(set(self.keys(self.client_auth)), base | {"exchange"})
        publisher = self.keys(self.publisher)
        self.assertEqual(set(publisher), base | {"exchange", "publisherLogs"})
        self.assertEqual(publisher["publisherLogs"], {"log": 0})

    def test_signals_only_when_asked_for_any_role(self):
        base = {"protocolVersion", "active", "libraryId", "domains"}
        self.assertEqual(set(self.keys(self.legacy, "?signals=1")), base | {"signals"})
        self.assertEqual(set(self.keys(self.client_auth, "?signals=1")), base | {"exchange", "signals"})
        both = self.keys(self.publisher, "?signals=1")
        self.assertEqual(set(both), base | {"exchange", "publisherLogs", "signals"})
        self.assertEqual(both["signals"], {"tablet": 0})
        self.assertEqual(list(both)[-2:], ["publisherLogs", "signals"])

    def test_a_publisher_view_is_heads_added_to_the_client_view(self):
        publisher = self.keys(self.publisher)
        client = self.keys(self.client_auth)
        publisher.pop("publisherLogs")
        self.assertEqual(publisher, client)

    def test_revoked_or_unknown_principal_is_never_a_publisher(self):
        with self.database.get_db() as db:
            self.assertEqual(api_auth.principal_role(db, api_auth.LEGACY_CLIENT), "client")
            self.assertEqual(api_auth.principal_role(db, "missing"), "client")
            principal, _ = api_auth.provision_token(db, "publisher")
            self.assertEqual(api_auth.principal_role(db, principal), "publisher")
            api_auth.revoke_token(db, principal)
            self.assertEqual(api_auth.principal_role(db, principal), "client")
        self.assertEqual(self.client.get(STATUS, headers={"Authorization": "Bearer nope"}).status_code, 401)


class RealAppStatusTests(unittest.TestCase):
    """The production composition: every head and signal, read through the real app."""

    def setUp(self):
        from tests.test_capture_api_stub import fake_s3  # noqa: F401  (R2 stub before app)
        import app as api_app

        self.api_app = api_app
        self.temp = tempfile.TemporaryDirectory()
        self.original = api_app.DB_PATH, api_app.API_TOKEN
        api_app.DB_PATH = Path(self.temp.name) / "lakomics.sqlite3"
        api_app.API_TOKEN = SHARED
        background = {"AutoPruner.start", "RefreshWorker.startup", "ExchangeSweeper.start",
                      "startup_image_thumbnails"}
        for handler in lifecycle(api_app.app).startup_handlers:
            if handler.__qualname__ not in background:
                handler()
        with api_app.get_db() as db:
            _, publisher = api_auth.provision_token(db, "publisher", "pc")
            _, client = api_auth.provision_token(db, "client", "tablet")
            db.commit()
        self.publisher = {"Authorization": f"Bearer {publisher}"}
        self.client_auth = {"Authorization": f"Bearer {client}"}
        self.legacy = {"Authorization": f"Bearer {SHARED}"}
        self.client = TestClient(api_app.app)

    def tearDown(self):
        self.client.close()
        self.api_app.DB_PATH, self.api_app.API_TOKEN = self.original
        self.temp.cleanup()

    def test_client_body_is_heads_bytes(self):
        # (`app.require_client` binds the shared token at import, so the legacy credential
        # is exercised by the golden fixture above rather than here.)
        for headers in (self.client_auth,):
            reply = self.client.get(STATUS, headers=headers)
            self.assertEqual(reply.status_code, 200, reply.text)
            principal = self.api_app.require_client(headers["Authorization"])
            exchange = self.api_app.file_exchange.status if self.api_app.EXCHANGE_ENABLED else None
            with self.api_app.get_db() as db:
                body, etag = head_document(db, principal, exchange)
            self.assertEqual((reply.content, reply.headers["ETag"]), (body, etag))
            self.assertEqual(reply.headers[sync_status.WAIT_HEADER], "50")

    def test_publisher_logs_and_signals_shapes(self):
        body = self.client.get(STATUS + "?signals=1", headers=self.publisher).json()
        logs = body["publisherLogs"]
        self.assertEqual(set(logs), {"characterExclusions", "characterReviewDecisions", "similarityDecisions",
                                     "catalogDuplicateDecisions", "releaseReads", "bindings", "personalEdits",
                                     "captures", "upcomingIntents"})
        self.assertEqual(logs["upcomingIntents"], {"last": 0, "acknowledgedThrough": 0, "prunedThrough": 0})
        for name in ("characterExclusions", "characterReviewDecisions", "similarityDecisions",
                     "catalogDuplicateDecisions", "personalEdits"):
            self.assertEqual(logs[name], 0, name)
        self.assertEqual(logs["releaseReads"], {"last": 0, "prunedThrough": 0})
        self.assertEqual(set(logs["bindings"]), {"logEpoch", "last", "oldestPending"})
        self.assertRegex(logs["bindings"]["logEpoch"], r"^[0-9a-f]{32}$")
        self.assertEqual((logs["bindings"]["last"], logs["bindings"]["oldestPending"]), (0, None))
        self.assertEqual(logs["captures"], {"pending": 0, "latest": None})
        signals = body["signals"]
        self.assertEqual(set(signals), {"listGeneration", "characters", "collections", "releases", "catalog",
                                        "bindingRequests", "notes", "upcoming", "avPick", "artists"})
        self.assertEqual((signals["upcoming"], signals["avPick"], signals["artists"]), (0, 0, 0))
        self.assertEqual(signals["collections"],
                         {"revision": None, "personalEditCursor": None, "appliedPersonalEditCursor": None})
        self.assertEqual(signals["bindingRequests"], {"last": 0, "updatedAt": None})
        self.assertEqual(signals["notes"], 0)

    def test_signals_match_the_status_routes_they_replace(self):
        signals = self.client.get(STATUS + "?signals=1", headers=self.client_auth).json()["signals"]
        generation = self.client.get("/v1/library/list-generation", headers=self.legacy).json()["generation"]
        self.assertEqual(signals["listGeneration"], generation)
        characters = self.client.get("/v1/library/characters/status", headers=self.legacy).json()
        self.assertEqual(signals["characters"], characters["revision"])
        collections = self.client.get("/v1/collections/status", headers=self.legacy).json()
        self.assertEqual(signals["collections"]["revision"], collections["revision"])
        catalog = self.client.get("/v1/mobile-catalog/status", headers=self.client_auth).json()
        self.assertEqual(signals["catalog"], catalog["publicationRevision"])
        releases = self.client.get("/v1/collections/releases", headers=self.client_auth).json()
        self.assertEqual(signals["releases"], releases["revision"])

    def test_list_generation_signal_moves_with_an_asset_write_and_notes_with_a_note(self):
        first = self.client.get(STATUS + "?signals=1", headers=self.client_auth).json()["signals"]
        with self.api_app.get_db() as db:
            db.execute("INSERT INTO assets(id,kind,object_key,created_at,updated_at) "
                       "VALUES('x','image','k','2026','2026')")
            db.commit()
        note = self.client.put("/v1/notes/" + "a" * 32 + "/" + "b" * 32, headers=self.legacy, json={
            "expectedRevision": 0, "operationId": "c" * 32,
            "payload": {"version": 1, "nonce": "0" * 24, "ciphertext": "0" * 32}})
        self.assertEqual(note.status_code, 200, note.text)
        second = self.client.get(STATUS + "?signals=1", headers=self.client_auth).json()["signals"]
        self.assertNotEqual(second["listGeneration"], first["listGeneration"])
        self.assertEqual(second["notes"], first["notes"] + 1)

    def test_get_db_bumps_on_writes_only(self):
        signal = self.api_app.write_signal
        before = signal.generation
        self.client.get(STATUS + "?signals=1", headers=self.publisher)
        self.client.get("/v1/library/list-generation", headers=self.legacy)
        self.assertEqual(signal.generation, before)
        with self.api_app.get_db() as db:
            db.execute("UPDATE asset_list_generation SET generation=generation+1")
            db.commit()
        self.assertEqual(signal.generation, before + 1)


# --- S2: long-poll ---------------------------------------------------------------------

class LongPollTests(unittest.IsolatedAsyncioTestCase):
    options = {"max_wait": 5, "recheck": 15}

    async def asyncSetUp(self):
        self.database = Database()
        self.app = build(self.database, **self.options)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        _, self.client_auth = self.database.token("client")
        _, self.publisher = self.database.token("publisher")

    async def asyncTearDown(self):
        await self.http.aclose()
        self.database.close()

    async def etag(self, headers, query=""):
        reply = await self.http.get(STATUS + query, headers=headers)
        self.assertEqual(reply.status_code, 200, reply.text)
        return reply.headers["ETag"]

    def hold(self, headers, etag, wait=5, query=""):
        joiner = "&" if query else "?"
        return asyncio.ensure_future(self.http.get(
            f"{STATUS}{query}{joiner}wait={wait}", headers={**headers, "If-None-Match": etag}))

    async def parked(self, count):
        deadline = time.perf_counter() + 2
        while self.database.signal.waiter_count < count:
            self.assertLess(time.perf_counter(), deadline, "waiters never parked")
            await asyncio.sleep(0.005)

    async def test_waiter_released_quickly_by_a_write_from_another_request(self):
        etag = await self.etag(self.client_auth)
        waiter = self.hold(self.client_auth, etag)
        await self.parked(1)
        wrote = await self.http.post("/_test/write/authority_domains", headers=self.publisher)
        self.assertEqual(wrote.status_code, 200)
        began = time.perf_counter()
        reply = await asyncio.wait_for(waiter, 2)
        self.assertLess(time.perf_counter() - began, 0.25)
        self.assertEqual(reply.status_code, 200)
        self.assertNotEqual(reply.headers["ETag"], etag)
        self.assertEqual(reply.json()["domains"][0]["domain"], "domain-0")
        self.assertEqual(reply.headers[sync_status.WAIT_HEADER], "5")
        self.assertEqual(self.database.signal.waiter_count, 0)

    async def test_publisher_only_write_does_not_release_a_client_waiter(self):
        client_etag = await self.etag(self.client_auth)
        publisher_etag = await self.etag(self.publisher)
        client = self.hold(self.client_auth, client_etag, wait=1)
        publisher = self.hold(self.publisher, publisher_etag, wait=1)
        await self.parked(2)
        began = time.perf_counter()
        await self.http.post("/_test/write/publisher_log", headers=self.publisher)
        released = await asyncio.wait_for(publisher, 2)
        self.assertEqual(released.status_code, 200)
        self.assertEqual(released.json()["publisherLogs"], {"log": 1})
        self.assertFalse(client.done())
        reply = await asyncio.wait_for(client, 3)
        self.assertEqual(reply.status_code, 304)
        self.assertGreaterEqual(time.perf_counter() - began, 0.8)
        self.assertEqual(reply.headers["ETag"], client_etag)
        self.assertEqual(reply.headers[sync_status.WAIT_HEADER], "5")

    async def test_a_signals_waiter_wakes_on_its_signal_only_when_it_asked(self):
        plain = await self.etag(self.client_auth)
        opted = await self.etag(self.client_auth, "?signals=1")
        without = self.hold(self.client_auth, plain, wait=0.6)
        with_signals = self.hold(self.client_auth, opted, wait=5, query="?signals=1")
        await self.parked(2)
        await self.http.post("/_test/write/tablet_signal", headers=self.client_auth)
        reply = await asyncio.wait_for(with_signals, 2)
        self.assertEqual((reply.status_code, reply.json()["signals"]), (200, {"tablet": 1}))
        self.assertEqual((await asyncio.wait_for(without, 2)).status_code, 304)

    async def test_wait_without_a_matching_etag_answers_at_once(self):
        for headers in (self.client_auth, {**self.client_auth, "If-None-Match": '"stale"'}):
            began = time.perf_counter()
            reply = await self.http.get(STATUS + "?wait=5", headers=headers)
            self.assertLess(time.perf_counter() - began, 0.2)
            self.assertEqual(reply.status_code, 200)
            self.assertEqual(reply.headers[sync_status.WAIT_HEADER], "5")
        self.assertEqual(self.database.signal.waiter_count, 0)

    async def test_wait_is_clamped_and_ends_in_304(self):
        etag = await self.etag(self.client_auth)
        began = time.perf_counter()
        reply = await self.http.get(STATUS + "?wait=0.3", headers={**self.client_auth, "If-None-Match": etag})
        elapsed = time.perf_counter() - began
        self.assertEqual((reply.status_code, reply.content, reply.headers["ETag"]), (304, b"", etag))
        self.assertGreaterEqual(elapsed, 0.28)
        self.assertLess(elapsed, 1.0)
        self.assertEqual(sync_status.requested_wait("999", 50), 50)
        self.assertEqual(sync_status.requested_wait("-1", 50), 0)
        self.assertEqual(sync_status.requested_wait("inf", 50), 0)
        self.assertEqual(sync_status.requested_wait(None, 50), 0)

    async def test_waiters_woken_together_compute_once_per_caller(self):
        etag = await self.etag(self.client_auth, "?signals=1")
        waiters = [self.hold(self.client_auth, etag, query="?signals=1") for _ in range(4)]
        await self.parked(4)
        reads = self.database.signal_reads
        await self.http.post("/_test/write/tablet_signal", headers=self.client_auth)
        replies = await asyncio.wait_for(asyncio.gather(*waiters), 2)
        self.assertEqual([r.status_code for r in replies], [200] * 4)
        self.assertEqual(self.database.signal_reads - reads, 1)

    async def test_a_revoked_credential_gets_no_new_document(self):
        principal, headers = self.database.token("client")
        etag = await self.etag(headers)
        waiter = self.hold(headers, etag)
        await self.parked(1)
        with self.database.get_db() as db:
            api_auth.revoke_token(db, principal)
            authority_row(db, "albums", 1)
            db.commit()
        self.assertEqual((await asyncio.wait_for(waiter, 2)).status_code, 401)

    async def test_disconnect_deregisters_and_frees_the_slot(self):
        etag = await self.etag(self.client_auth)
        token = self.client_auth["Authorization"].encode()
        for _ in range(sync_status.MAX_WAITERS_PER_PRINCIPAL + 1):
            gone = asyncio.Event()
            received = []

            async def receive():
                if not received:
                    received.append(True)
                    return {"type": "http.request", "body": b"", "more_body": False}
                await gone.wait()
                return {"type": "http.disconnect"}

            sent = []

            async def send(message):
                sent.append(message)

            scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET",
                     "scheme": "http", "path": STATUS, "raw_path": STATUS.encode(), "root_path": "",
                     "query_string": b"wait=5", "client": ("127.0.0.1", 1), "server": ("test", 80),
                     "headers": [(b"host", b"test"), (b"authorization", token),
                                 (b"if-none-match", etag.encode())]}
            task = asyncio.ensure_future(self.app(scope, receive, send))
            await self.parked(1)
            began = time.perf_counter()
            gone.set()
            await asyncio.wait_for(task, 1)
            self.assertLess(time.perf_counter() - began, 0.2)
            self.assertEqual(self.database.signal.waiter_count, 0)
        # Every one of the (cap + 1) held requests was admitted, so each left its slot.

    async def test_cancelled_routes_deregister_waiters_and_free_admission(self):
        etag = await self.etag(self.client_auth)
        counts = []
        # More sequential cancellations than the admission cap reproduced leaked
        # signal waiters even though the route admission slots were released.
        for _ in range(sync_status.MAX_WAITERS_PER_PRINCIPAL + 2):
            before = self.database.signal.waiter_count
            task = self.hold(self.client_auth, etag)
            await self.parked(before + 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            counts.append(self.database.signal.waiter_count)
        self.assertEqual(counts, [0] * 6)

    async def test_recheck_catches_a_write_that_bypassed_get_db(self):
        app = build(self.database, max_wait=5, recheck=0.2)
        http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(http.aclose)
        etag = (await http.get(STATUS, headers=self.client_auth)).headers["ETag"]
        waiter = asyncio.ensure_future(http.get(STATUS + "?wait=5",
                                                headers={**self.client_auth, "If-None-Match": etag}))
        await self.parked(1)
        with self.database.raw() as db:  # no signal: like the thumbnail worker or a CLI tool
            authority_row(db, "albums", 1)
            db.commit()
        began = time.perf_counter()
        reply = await asyncio.wait_for(waiter, 2)
        self.assertEqual(reply.status_code, 200)
        self.assertLess(time.perf_counter() - began, 0.6)

    async def test_twenty_waiters_hold_no_threadpool_slot(self):
        limiter = anyio.to_thread.current_default_thread_limiter()
        original = limiter.total_tokens
        limiter.total_tokens = 1  # a waiter holding a thread would starve everything below
        self.addCleanup(setattr, limiter, "total_tokens", original)
        principals = [self.database.token("client")[1] for _ in range(5)]
        etag = await self.etag(principals[0])
        waiters = [self.hold(headers, etag, wait=5)
                   for headers in principals for _ in range(sync_status.MAX_WAITERS_PER_PRINCIPAL)]
        await self.parked(20)
        self.assertEqual(limiter.borrowed_tokens, 0)
        began = time.perf_counter()
        normal = await asyncio.wait_for(self.http.get(STATUS, headers=self.publisher), 2)
        self.assertEqual(normal.status_code, 200)
        self.assertLess(time.perf_counter() - began, 0.5)
        self.assertEqual(self.database.signal.waiter_count, 20)
        await self.http.post("/_test/write/authority_domains", headers=self.publisher)
        replies = await asyncio.wait_for(asyncio.gather(*waiters), 5)
        self.assertEqual({r.status_code for r in replies}, {200})


class WaiterCapTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.database = Database()
        self.app = build(self.database, max_wait=5, max_waiters=3, max_waiters_per_principal=2)
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.http.aclose()
        self.database.close()

    async def test_over_the_cap_answers_at_once(self):
        one, two = self.database.token("client")[1], self.database.token("client")[1]
        etag = (await self.http.get(STATUS, headers=one)).headers["ETag"]

        def hold(headers):
            return asyncio.ensure_future(self.http.get(STATUS + "?wait=5",
                                                       headers={**headers, "If-None-Match": etag}))

        held = [hold(one), hold(one)]
        while self.database.signal.waiter_count < 2:
            await asyncio.sleep(0.005)
        began = time.perf_counter()
        per_principal = await hold(one)  # third for one principal
        self.assertEqual(per_principal.status_code, 304)
        self.assertEqual(per_principal.headers[sync_status.WAIT_HEADER], "5")
        held.append(hold(two))
        while self.database.signal.waiter_count < 3:
            await asyncio.sleep(0.005)
        total = await hold(two)  # fourth overall
        self.assertEqual(total.status_code, 304)
        self.assertLess(time.perf_counter() - began, 0.5)
        self.database.write("tablet_signal")  # invisible to these callers: they keep waiting
        await asyncio.sleep(0.3)
        self.assertFalse(any(task.done() for task in held))
        with self.database.get_db() as db:
            authority_row(db, "albums", 1)
            db.commit()
        replies = await asyncio.wait_for(asyncio.gather(*held), 2)
        self.assertEqual({r.status_code for r in replies}, {200})


class NoSignalAppTests(unittest.TestCase):
    def test_without_a_write_signal_there_is_no_long_poll_or_header(self):
        database = Database()
        self.addCleanup(database.close)
        app = FastAPI()
        sync_status.register_sync_status(app, database.get_db, api_auth.client_guard(database.get_db, SHARED))
        client = TestClient(app)
        self.addCleanup(client.close)
        headers = {"Authorization": f"Bearer {SHARED}"}
        first = client.get(STATUS, headers=headers)
        self.assertEqual((first.content, first.headers["ETag"]), (EMPTY_BODY, EMPTY_ETAG))
        self.assertNotIn(sync_status.WAIT_HEADER, first.headers)
        began = time.perf_counter()
        cached = client.get(STATUS + "?wait=5&signals=1", headers={**headers, "If-None-Match": EMPTY_ETAG})
        self.assertEqual(cached.status_code, 304)
        self.assertLess(time.perf_counter() - began, 0.5)


if __name__ == "__main__":
    unittest.main()
