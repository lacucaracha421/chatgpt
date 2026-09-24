"""Regressions for the 2026-09-24 server review: upload bounds, disconnects, WAL reads.

Production observed `PUT /v1/saved-x-media` answering 500 with a traceback inside the
application-wide body-bounding middleware, and sporadic 500s on `GET /v1/sync/status`.
These tests drive the raw ASGI application so a mid-upload disconnect and a chunked
over-limit body can be reproduced exactly, and pin that a reader is not blocked by a
concurrent writer once the control database runs in WAL mode.
"""
import asyncio
import json
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tests.test_capture_api_stub import fake_s3  # noqa: F401  (installs the R2 stub)
import api_auth
import app as api_app
from fastapi.testclient import TestClient

PATH = "/v1/saved-x-media"


def drive(app, method, path, chunks, *, headers=(), disconnect_after=None, content_length=None):
    """Run one request through the ASGI app with explicit body chunks.

    ``disconnect_after`` sends ``http.disconnect`` after that many chunks, exactly as
    uvicorn does when the peer closes the socket mid-upload. Returns the raised
    exception (or None) and the messages the application sent.
    """
    messages = [{"type": "http.request", "body": chunk, "more_body": True}
                for chunk in (chunks if disconnect_after is None else chunks[:disconnect_after])]
    if disconnect_after is None:
        messages.append({"type": "http.request", "body": b"", "more_body": False})
    else:
        messages.append({"type": "http.disconnect"})
    consumed = iter(messages)
    sent = []
    raw_headers = [(b"authorization", b"Bearer test-token"), (b"content-type", b"application/json"),
                   *headers]
    if content_length is not None:
        raw_headers.append((b"content-length", str(content_length).encode()))
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
             "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": b"",
             "headers": raw_headers, "client": ("127.0.0.1", 1), "server": ("test", 80)}

    async def receive():
        try:
            return next(consumed)
        except StopIteration:
            await asyncio.sleep(3600)  # a real server would wait for the peer forever too

    async def send(message):
        sent.append(message)

    async def run():
        try:
            await app(scope, receive, send)
        except BaseException as error:  # noqa: BLE001 - the escape itself is the finding
            return error
        return None

    return asyncio.run(run()), sent


def status_of(sent):
    return next(message["status"] for message in sent if message["type"] == "http.response.start")


class ServerFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.original = api_app.DB_PATH, api_app.API_TOKEN
        api_app.DB_PATH = Path(self.temp.name) / "lakomics.sqlite3"
        api_app.API_TOKEN = "test-token"
        api_app.startup()
        api_app.startup_captures()
        api_app.startup_classifications()
        api_app.startup_saved_x_media()
        api_app.startup_sync_status()
        api_auth.startup(api_app.get_db)
        with api_app.get_db() as db:
            _, self.client_token = api_auth.provision_token(db, "client", "hardening")
            db.commit()
        self.auth = {"Authorization": "Bearer test-token"}

    def tearDown(self):
        api_app.DB_PATH, api_app.API_TOKEN = self.original
        self.temp.cleanup()


class SavedXMediaUploadTests(ServerFixture):
    def test_disconnect_mid_upload_is_not_a_server_error(self):
        body = json.dumps({"keys": ["1:1", "2:2"]}).encode()
        error, sent = drive(api_app.app, "PUT", PATH, [body[:6], body[6:]], disconnect_after=1,
                            content_length=len(body))
        self.assertIsNone(error, f"exception escaped the application: {error!r}")
        self.assertEqual(status_of(sent), 400)
        with api_app.get_db() as db:
            self.assertIsNone(db.execute("SELECT 1 FROM saved_x_media_snapshots").fetchone())

    def test_chunked_body_over_the_limit_is_rejected_before_being_buffered(self):
        chunk = b" " * (64 * 1024)
        limit = api_app.MAX_SAVED_X_MEDIA_SNAPSHOT_BYTES
        chunks = [chunk] * (limit // len(chunk) * 4)  # four times the cap, no Content-Length
        error, sent = drive(api_app.app, "PUT", PATH, chunks)
        self.assertIsNone(error)
        self.assertEqual(status_of(sent), 413)
        response_body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
        self.assertEqual(json.loads(response_body), {"detail": "Snapshot too large"})

    def test_chunked_body_stops_reading_at_the_limit(self):
        """The rejection happens on the first chunk that crosses the cap, not at the end."""
        limit = api_app.MAX_SAVED_X_MEDIA_SNAPSHOT_BYTES
        chunk = b" " * (256 * 1024)
        delivered = []

        async def app_with_counting_receive(scope, receive, send):
            async def counting():
                message = await receive()
                delivered.append(len(message.get("body", b"")))
                return message
            await api_app.app(scope, counting, send)

        error, sent = drive(app_with_counting_receive, "PUT", PATH, [chunk] * 40)
        self.assertIsNone(error)
        self.assertEqual(status_of(sent), 413)
        # 4 chunks reach the cap exactly; the 5th crosses it. Nothing after that is read.
        self.assertLessEqual(sum(delivered), limit + len(chunk))

    def test_declared_length_over_the_limit_is_rejected_without_reading(self):
        delivered = []

        async def app_with_counting_receive(scope, receive, send):
            async def counting():
                message = await receive()
                delivered.append(message)
                return message
            await api_app.app(scope, counting, send)

        error, sent = drive(app_with_counting_receive, "PUT", PATH, [b"{}"],
                            content_length=api_app.MAX_SAVED_X_MEDIA_SNAPSHOT_BYTES + 1)
        self.assertIsNone(error)
        self.assertEqual(status_of(sent), 413)
        self.assertEqual(delivered, [])

    def test_invalid_declared_length_is_a_bad_request(self):
        error, sent = drive(api_app.app, "PUT", PATH, [b"{}"], headers=[(b"content-length", b"abc")])
        self.assertIsNone(error)
        self.assertEqual(status_of(sent), 400)

    def test_unauthorized_upload_is_refused_before_the_body_is_read(self):
        delivered = []

        async def app_with_counting_receive(scope, receive, send):
            async def counting():
                message = await receive()
                delivered.append(message)
                return message
            await api_app.app(scope, counting, send)

        response = TestClient(app_with_counting_receive).put(
            PATH, content=b'{"keys":[]}', headers={"Content-Type": "application/json"})
        self.assertEqual(response.status_code, 401)
        self.assertEqual([m for m in delivered if m["type"] == "http.request"], [])

    def test_validation_errors_keep_the_fastapi_document_shape(self):
        with TestClient(api_app.app) as client:
            invalid = client.put(PATH, headers=self.auth, json={"keys": ["bad"]})
            self.assertEqual(invalid.status_code, 422)
            detail = invalid.json()["detail"]
            self.assertEqual(detail[0]["loc"], ["body", "keys", 0])
            self.assertIn("msg", detail[0])
            self.assertIn("type", detail[0])
            broken = client.put(PATH, headers={**self.auth, "Content-Type": "application/json"},
                                content=b"{not json")
            self.assertEqual(broken.status_code, 422)
            self.assertEqual(broken.json()["detail"][0]["loc"], ["body"])
            extra = client.put(PATH, headers=self.auth, json={"keys": [], "more": 1})
            self.assertEqual(extra.status_code, 422)
            ok = client.put(PATH, headers=self.auth, json={"keys": ["3:1", "3:1"]})
            self.assertEqual(ok.status_code, 200)
            self.assertEqual(ok.json()["count"], 1)
            self.assertEqual(client.get(PATH, headers=self.auth).json()["keys"], ["3:1"])

    def test_no_application_wide_body_middleware_remains(self):
        """Other routes must not pay for, or fail through, the upload bound."""
        self.assertEqual([m.cls.__name__ for m in api_app.app.user_middleware], [])


class ConditionalPollTests(ServerFixture):
    def test_sync_status_answers_304_until_an_authority_moves(self):
        headers = {"Authorization": f"Bearer {self.client_token}"}
        client = TestClient(api_app.app)
        first = client.get("/v1/sync/status", headers=headers)
        self.assertEqual(first.status_code, 200, first.text)
        etag = first.headers["ETag"]
        self.assertEqual(first.headers["Cache-Control"], "private, no-cache")
        self.assertEqual(first.json()["active"], False)
        cached = client.get("/v1/sync/status", headers={**headers, "If-None-Match": etag})
        self.assertEqual(cached.status_code, 304)
        self.assertEqual(cached.content, b"")
        self.assertEqual(cached.headers["ETag"], etag)
        weak = client.get("/v1/sync/status", headers={**headers, "If-None-Match": f'"other", W/{etag}'})
        self.assertEqual(weak.status_code, 304)
        with api_app.get_db() as db:
            db.execute(
                "INSERT INTO authority_domains(library_id,domain,epoch,contract_version,change_cursor,"
                "baseline_digest,activated_at) VALUES(?,'albums',1,1,7,'d','2026')", ["a" * 32])
            db.commit()
        moved = client.get("/v1/sync/status", headers={**headers, "If-None-Match": etag})
        self.assertEqual(moved.status_code, 200)
        self.assertNotEqual(moved.headers["ETag"], etag)
        self.assertEqual(moved.json()["domains"][0]["cursor"], 7)
        # The body is byte-identical to the framework's own JSON encoding.
        self.assertEqual(moved.content, json.dumps(moved.json(), ensure_ascii=False,
                                                    separators=(",", ":")).encode())

    def test_if_none_match_matching_rules(self):
        import conditional
        tag = conditional.etag_for(b"body")
        self.assertTrue(conditional.matches(tag, tag))
        self.assertTrue(conditional.matches(f"W/{tag}", tag))
        self.assertTrue(conditional.matches(f'"x", {tag}', tag))
        self.assertTrue(conditional.matches("*", tag))
        self.assertFalse(conditional.matches(None, tag))
        self.assertFalse(conditional.matches('"x"', tag))
        self.assertFalse(conditional.matches(tag[1:-1], tag))


class ControlDatabaseTests(ServerFixture):
    def test_startup_switches_the_control_database_to_wal(self):
        with sqlite3.connect(api_app.DB_PATH) as db:
            self.assertEqual(db.execute("PRAGMA journal_mode").fetchone()[0], "wal")

    def test_status_read_is_not_blocked_by_a_writer_holding_the_lock(self):
        """Reproduces the `/v1/sync/status` 500: a reader under a long write transaction.

        Under the rollback journal the reader waited for the busy timeout and then
        failed with `database is locked`; under WAL it reads the last committed state.
        """
        holding = threading.Event()
        release = threading.Event()

        def writer():
            with api_app.get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                db.execute("INSERT INTO saved_x_media_snapshots VALUES(1,'{}','now','now')")
                holding.set()
                release.wait(timeout=30)
                db.rollback()

        thread = threading.Thread(target=writer, daemon=True)
        thread.start()
        self.assertTrue(holding.wait(timeout=5))
        try:
            started = time.perf_counter()
            # No lifespan here: startup itself writes, and the point is the read path.
            response = TestClient(api_app.app).get(
                "/v1/sync/status", headers={"Authorization": f"Bearer {self.client_token}"})
            elapsed = time.perf_counter() - started
        finally:
            release.set()
            thread.join(timeout=5)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertLess(elapsed, api_app.DB_BUSY_TIMEOUT_SECONDS / 2)
        self.assertEqual(response.json()["active"], False)


if __name__ == "__main__":
    unittest.main()
