"""Response compression boundaries and conditional JSON reads."""
import gzip
import unittest

from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from starlette.responses import StreamingResponse

import conditional
from response_compression import TextGZipMiddleware


PAYLOAD = {"items": ["library item " * 30] * 20}
BODY = conditional.encode(PAYLOAD)


class ResponseCompressionTests(unittest.TestCase):
    def setUp(self):
        app = FastAPI()
        app.add_middleware(TextGZipMiddleware)

        @app.get("/json")
        def json_document(request: Request):
            return conditional.encoded_response(
                BODY, conditional.etag_for(BODY), request.headers.get("if-none-match"),
                headers={"Vary": "Authorization"})

        @app.get("/body")
        def body(kind: str = "application/octet-stream", status: int = 200,
                 content_range: bool = False, size: int = 2048):
            headers = {"Content-Range": "bytes 0-2047/4096"} if content_range else {}
            return Response(b"x" * size, media_type=kind, status_code=status, headers=headers)

        @app.get("/v1/sync/status")
        def status():
            return conditional.json_response(PAYLOAD)

        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def raw_get(self, path, headers):
        request = self.client.build_request("GET", path, headers={k: v for k, v in headers.items() if v is not None})
        if headers.get("Accept-Encoding") is None:
            del request.headers["Accept-Encoding"]
        response = self.client.send(request, stream=True)
        try:
            return response, b"".join(response.iter_raw())
        finally:
            response.close()

    def test_large_json_negotiation(self):
        for encoding in ("gzip", None, "identity", "gzip;q=0"):
            with self.subTest(encoding=encoding):
                response, body = self.raw_get("/json", {"Accept-Encoding": encoding})
                if encoding == "gzip":
                    self.assertEqual(response.headers.get("Content-Encoding"), "gzip")
                    self.assertEqual(gzip.decompress(body), BODY)
                else:
                    self.assertNotIn("Content-Encoding", response.headers)
                    self.assertEqual(body, BODY)
                self.assertEqual(int(response.headers["Content-Length"]), len(body))
                self.assertIn("accept-encoding", response.headers["Vary"].lower())
                self.assertIn("authorization", response.headers["Vary"].lower())

    def test_media_and_binary_are_not_compressed(self):
        for kind in ("image/svg+xml", "video/mp4", "audio/mpeg",
                     "application/octet-stream", "application/zip"):
            with self.subTest(kind=kind):
                response, body = self.raw_get("/body?kind=" + kind, {"Accept-Encoding": "gzip"})
                self.assertNotIn("Content-Encoding", response.headers)
                self.assertEqual(body, b"x" * 2048)

    def test_range_and_partial_responses_are_not_compressed(self):
        for path, extra in (("/json", {"Range": "bytes=0-1023"}),
                            ("/body?kind=application/json&status=206", {}),
                            ("/body?kind=application/json&content_range=true", {})):
            with self.subTest(path=path):
                response, _ = self.raw_get(path, {"Accept-Encoding": "gzip", **extra})
                self.assertNotIn("Content-Encoding", response.headers)

    def test_etag_matches_across_compressed_and_identity_reads(self):
        for first_encoding, next_encoding in (("gzip", "identity"), ("identity", "gzip")):
            with self.subTest(first=first_encoding):
                first, _ = self.raw_get("/json", {"Accept-Encoding": first_encoding})
                cached, body = self.raw_get("/json", {
                    "Accept-Encoding": next_encoding, "If-None-Match": first.headers["ETag"]})
                self.assertEqual(cached.status_code, 304)
                self.assertEqual(body, b"")
                self.assertEqual(cached.headers["ETag"], first.headers["ETag"])
                self.assertIn("accept-encoding", cached.headers["Vary"].lower())
                self.assertNotIn("Content-Encoding", cached.headers)

    def test_text_threshold_and_sync_status_exclusion(self):
        response, body = self.raw_get("/body?kind=text/plain", {"Accept-Encoding": "gzip"})
        self.assertEqual(response.headers.get("Content-Encoding"), "gzip")
        self.assertEqual(gzip.decompress(body), b"x" * 2048)
        response, body = self.raw_get("/body?kind=text/plain&size=1000", {"Accept-Encoding": "gzip"})
        self.assertNotIn("Content-Encoding", response.headers)
        self.assertEqual(body, b"x" * 1000)
        response, body = self.raw_get("/v1/sync/status?wait=25", {"Accept-Encoding": "gzip"})
        self.assertNotIn("Content-Encoding", response.headers)
        self.assertEqual(body, BODY)


class StreamingCompressionTests(unittest.IsolatedAsyncioTestCase):
    async def test_stream_chunks_are_forwarded_before_the_next_chunk(self):
        for length in (None, "4096"):
            with self.subTest(length=length):
                sent = []

                async def chunks():
                    yield b"a" * 2048
                    self.assertTrue(any(m.get("body") == b"a" * 2048 for m in sent))
                    yield b"b" * 2048

                response = StreamingResponse(chunks(), media_type="text/plain",
                                             headers={} if length is None else {"Content-Length": length})

                async def send(message):
                    sent.append(message)

                scope = {"type": "http", "method": "GET", "path": "/stream",
                         "asgi": {"spec_version": "2.4"}, "headers": [(b"accept-encoding", b"gzip")]}
                await TextGZipMiddleware(response)(scope, None, send)
                self.assertNotIn((b"content-encoding", b"gzip"), sent[0]["headers"])
                self.assertEqual(b"".join(m.get("body", b"") for m in sent), b"a" * 2048 + b"b" * 2048)
