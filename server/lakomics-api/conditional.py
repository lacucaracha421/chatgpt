"""Conditional GET for small, frequently polled JSON documents.

The status and change-feed reads are polled several times a minute by every device.
Their bodies are tiny and, between mutations, identical from one poll to the next.
Answering ``If-None-Match`` with ``304 Not Modified`` lets a client skip the transfer
and the re-parse, and lets a client that only wants to know "did anything move" stop
at the status document instead of walking every domain feed.

The tag is computed from the serialized body, so it is correct by construction for
any document, and the body bytes are exactly what ``fastapi.responses.JSONResponse``
would have produced: a client that ignores the header sees no difference.
"""
import hashlib
import json

from fastapi import Response

CACHE_CONTROL = "private, no-cache"


def encode(payload) -> bytes:
    return json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=None,
                      separators=(",", ":")).encode("utf-8")


def etag_for(body: bytes) -> str:
    return '"' + hashlib.sha256(body).hexdigest()[:32] + '"'


def matches(if_none_match: str | None, etag: str) -> bool:
    """RFC 9110 weak comparison over a comma-separated ``If-None-Match`` list."""
    if not if_none_match:
        return False
    for candidate in if_none_match.split(","):
        candidate = candidate.strip()
        if candidate == "*":
            return True
        if candidate.startswith("W/"):
            candidate = candidate[2:]
        if candidate == etag:
            return True
    return False


def json_response(payload, if_none_match: str | None = None) -> Response:
    """``payload`` as JSON with an ``ETag``, or ``304`` when the caller already has it."""
    body = encode(payload)
    return encoded_response(body, etag_for(body), if_none_match)


def encoded_response(body: bytes, etag: str, if_none_match: str | None = None,
                     headers: dict | None = None) -> Response:
    """:func:`json_response` for a body already encoded (and tagged) with :func:`encode`."""
    headers = {"ETag": etag, "Cache-Control": CACHE_CONTROL, **(headers or {})}
    if matches(if_none_match, etag):
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)
