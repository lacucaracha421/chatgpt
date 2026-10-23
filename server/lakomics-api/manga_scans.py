"""PC-published manga scans; the existing Collection artwork tickets/cache serve the bytes."""
import hashlib
import json
import re

from fastapi import Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

MAX_BYTES = 2 * 1024 * 1024
DDL = """CREATE TABLE IF NOT EXISTS manga_scans(
 isbn13 TEXT NOT NULL, part TEXT NOT NULL CHECK(part IN ('side','back')),
 sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
 PRIMARY KEY(isbn13,part));"""


def valid_isbn(value):
    return (re.fullmatch(r"97[89][0-9]{10}", value) is not None
            and sum(int(n) * (1 if i % 2 == 0 else 3) for i, n in enumerate(value)) % 10 == 0)


def version(db):
    rows = db.execute("SELECT isbn13,part,sha256 FROM manga_scans ORDER BY isbn13,part").fetchall()
    return hashlib.sha256(repr([tuple(row) for row in rows]).encode()).hexdigest()


def annotate_revisions(db, items, library_id=None):
    """List rows invalidate only when scans belonging to that work change."""
    works = {item["id"]: {v.get("isbn13") for v in item.get("volumes", []) if v.get("isbn13")}
             for item in items if item.get("type") == "manga"}
    if not works:
        return
    if library_id is not None:
        for work_id, isbn in db.execute(
                "SELECT work_id,isbn13 FROM collection_authority_volume_sources WHERE library_id=? "
                "AND deleted=0 AND work_id IN (SELECT value FROM json_each(?)) AND isbn13 IS NOT NULL",
                [library_id, json.dumps(list(works))]):
            works[work_id].add(isbn)
    scans = {}
    for isbn, part, digest in db.execute(
            "SELECT isbn13,part,sha256 FROM manga_scans WHERE isbn13 IN (SELECT value FROM json_each(?)) "
            "ORDER BY isbn13,part", [json.dumps(sorted(set().union(*works.values())))]):
        scans.setdefault(isbn, []).append((isbn, part, digest))
    for item in items:
        if item["id"] in works:
            rows = [row for isbn in sorted(works[item["id"]]) for row in scans.get(isbn, [])]
            item["scanRevision"] = hashlib.sha256(repr(rows).encode()).hexdigest()


def enrich(db, payload):
    """Read projection only: scan ids are virtual artwork served by the existing ticket route."""
    if payload.get("type") != "manga":
        return payload
    isbns = {v.get("isbn13") for v in payload.get("volumes", []) if v.get("isbn13")}
    if not isbns:
        return payload
    scans = {}
    for row in db.execute("SELECT isbn13,part,sha256,size_bytes FROM manga_scans "
                          "WHERE isbn13 IN (SELECT value FROM json_each(?))", [json.dumps(sorted(isbns))]):
        isbn, part, digest, size = row
        art_id = f"manga-scan-{isbn}-{part}-{digest}"
        scans.setdefault(isbn, {"side": None, "back": None})[part] = art_id
        blob = {"sha256": digest, "sizeBytes": size, "contentType": "image/jpeg",
                "objectKey": "work-artwork/mobile/" + digest}
        payload["artworks"].append({"id": art_id, "kind": "manga-" + part, "selected": False,
                                    "thumbnail": blob, "original": blob})
    for volume in payload.get("volumes", []):
        if volume.get("isbn13") in scans:
            volume["spineScan"] = scans[volume["isbn13"]]
    return payload


def register(app, get_db, publisher, storage, bucket):
    def save(isbn, part, digest, data):
        # Reuse the provider relay's bounded JPEG verification; optional decoding support
        # is checked on upload and must not prevent the API from starting.
        from work_providers import image_dimensions
        image_dimensions(data, "image/jpeg", max_pixels=40_000_000)
        key = "work-artwork/mobile/" + digest
        with get_db() as db:
            previous = db.execute("SELECT sha256 FROM manga_scans WHERE isbn13=? AND part=?", [isbn, part]).fetchone()
            if previous is not None and previous[0] == digest:
                return {"sha256": digest}
        try:
            storage().put_object(Bucket=bucket(), Key=key, Body=data, ContentType="image/jpeg",
                                 CacheControl="private, max-age=31536000, immutable")
        except Exception as exc:
            raise HTTPException(502, "Scan storage unavailable") from exc
        with get_db() as db:
            db.execute("INSERT INTO manga_scans VALUES(?,?,?,?) ON CONFLICT(isbn13,part) DO UPDATE SET "
                       "sha256=excluded.sha256,size_bytes=excluded.size_bytes", [isbn, part, digest, len(data)])
            db.execute("INSERT OR REPLACE INTO mobile_collection_artwork VALUES(?,?,?)", [digest, len(data), "image/jpeg"])
            db.commit()
        return {"sha256": digest}

    @app.put("/v1/collections/manga-scans/{isbn}/{part}")
    async def upload(isbn: str, part: str, request: Request,
                     authorization: str | None = Header(default=None),
                     x_content_sha256: str = Header(default="")):
        publisher(authorization)
        if not valid_isbn(isbn) or part not in ("side", "back") or not re.fullmatch("[a-f0-9]{64}", x_content_sha256):
            raise HTTPException(422, "Invalid scan identity")
        if request.headers.get("content-type", "").split(";")[0].strip() != "image/jpeg":
            raise HTTPException(415, "JPEG required")
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > MAX_BYTES:
                raise HTTPException(413, "Scan exceeds 2 MiB")
            data.extend(chunk)
        if not data or hashlib.sha256(data).hexdigest() != x_content_sha256:
            raise HTTPException(422, "Scan digest mismatch")
        return await run_in_threadpool(save, isbn, part, x_content_sha256, bytes(data))
