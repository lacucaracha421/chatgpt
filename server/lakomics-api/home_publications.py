"""Shared pieces of the PC-published Home and Artist documents (HOME-DASH-001, ARTIST-001).

Used by ``home_upcoming`` (게임/영화 발매 예정 + wishlist), ``library_artists`` (작가) and
``home_av_pick`` (오늘의 AV 배우). Each of those is a PC snapshot the server stores as is and
serves to the tablet with an ETag; nothing is computed on the server.

Cover reference
---------------
Where a document carries a cover it is one of two JSON objects (or null):

* ``{"url": "https://images.igdb.com/..."}`` - a provider image URL. HTTPS only, default port,
  no user info or fragment, host exactly ``images.igdb.com`` or ``image.tmdb.org``, <= 2048
  characters. The tablet WebView loads it directly (its CSP allows ``https:`` images).
  Use this for IGDB/TMDB covers: build the URL from the PC's stored IGDB image id / TMDB
  poster path, e.g. ``https://images.igdb.com/igdb/image/upload/t_cover_big/<id>.jpg`` or
  ``https://image.tmdb.org/t/p/w342<path>``.
* ``{"sha256", "sizeBytes", "contentType"}`` - a blob uploaded through the existing
  Collections artwork flow (``POST /v1/collections/artworks/prepare`` -> PUT to the presigned
  URL -> the stored object ``work-artwork/mobile/<sha256>``). The publication is refused with
  ``409 homeCoverNotUploaded`` unless the server holds that flow's confirmed receipt
  (``mobile_collection_artwork``) with the same size and type, so call ``prepare`` again after
  uploading (it confirms an existing object) before publishing. The tablet fetches it with
  ``POST /v1/home/covers/{sha256}/media-ticket`` (client), which answers only for a blob a
  current Home publication references; reply ``{"url", "expires_in", "sha256",
  "content_type", "size_bytes"}`` like the Collection artwork ticket. Use this for covers
  that exist only on the PC (AV front covers).

No new blob storage and no background work: the referenced blobs are recorded per owner
(``home_cover_refs``) and replaced with each publication.
"""
import re
from datetime import date
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import Header, HTTPException
from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StringConstraints, field_validator

from collection_releases import parse_instant

COVER_HOSTS = ("images.igdb.com", "image.tmdb.org")
MAX_ARTWORK_BYTES = 16 * 1024 * 1024  # mobile_collections.MAX_ARTWORK_BYTES
TICKET_SECONDS = 300
Digest = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
ImageMime = Literal["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/bmp",
                    "image/heic", "image/heif"]
IsoDate = Annotated[str, StringConstraints(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")]
Instant = Annotated[str, StringConstraints(min_length=1, max_length=64)]
OperationId = Annotated[str, StringConstraints(min_length=36, max_length=36)]
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")

DDL = """
CREATE TABLE IF NOT EXISTS home_cover_refs(
 owner TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, content_type TEXT NOT NULL,
 PRIMARY KEY(owner, sha256)) WITHOUT ROWID;
"""


def startup_db(db):
    db.executescript(DDL)


def fail(status, code, message, **extra):
    raise HTTPException(status, {"code": code, "message": message, **extra})


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


def _single_line(value):
    if _CONTROL.search(value) or not value.strip():
        raise ValueError("invalid text")
    return value


def text(max_length):
    """A single-line, non-blank string of at most ``max_length`` characters."""
    return Annotated[str, StringConstraints(min_length=1, max_length=max_length), AfterValidator(_single_line)]


def valid_date(value):
    try:
        date.fromisoformat(value)
    except ValueError:
        raise ValueError("invalid date") from None
    return value


def valid_instant(value):
    try:
        parse_instant(value)
    except (ValueError, OverflowError):
        raise ValueError("invalid timestamp") from None
    return value


Day = Annotated[IsoDate, AfterValidator(valid_date)]
Timestamp = Annotated[Instant, AfterValidator(valid_instant)]


class UrlCover(Strict):
    url: Annotated[str, StringConstraints(min_length=1, max_length=2048)]

    @field_validator("url")
    @classmethod
    def _provider(cls, value):
        try:
            parts = urlsplit(value)
            port = parts.port
        except ValueError:
            raise ValueError("invalid cover url") from None
        if (parts.scheme != "https" or parts.hostname not in COVER_HOSTS or parts.username is not None
                or parts.password is not None or port not in (None, 443) or parts.fragment
                or parts.netloc.lower() not in COVER_HOSTS or _CONTROL.search(value) or " " in value):
            raise ValueError("cover url must be an https IGDB/TMDB image")
        return value


class BlobCover(Strict):
    sha256: Digest
    sizeBytes: int = Field(gt=0, le=MAX_ARTWORK_BYTES)
    contentType: ImageMime


Cover = UrlCover | BlobCover


def uuid_or_fail(value, code, message):
    try:
        if str(UUID(value)) != value:
            raise ValueError()
    except ValueError:
        fail(422, code, message)


async def bounded_body(request, limit, code, message):
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        fail(413, code, message)
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > limit:
            fail(413, code, message)
    return bytes(raw)


def blobs(covers):
    """The distinct blob covers among ``covers`` (``None`` and URL covers skipped)."""
    found = {}
    for cover in covers:
        if isinstance(cover, BlobCover):
            if cover.sha256 in found and found[cover.sha256] != cover:
                fail(422, "invalidHomeCover", "같은 표지에 서로 다른 정보가 있습니다.")
            found[cover.sha256] = cover
    return list(found.values())


def replace_cover_refs(db, owner, covers):
    """Record ``owner``'s blob covers, refusing any the artwork flow has not confirmed.

    Runs inside the caller's write transaction; on refusal the caller's transaction is
    rolled back by the raised error (the connection is closed without commit).
    """
    wanted = blobs(covers)
    if wanted:
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mobile_collection_artwork'"
                            ).fetchone()
        confirmed = {} if exists is None else {
            row[0]: (row[1], row[2]) for row in db.execute(
                "SELECT sha256,size_bytes,content_type FROM mobile_collection_artwork WHERE sha256 IN ("
                + ",".join("?" * len(wanted)) + ")", [cover.sha256 for cover in wanted])}
        missing = [c.sha256 for c in wanted if confirmed.get(c.sha256) != (c.sizeBytes, c.contentType)]
        if missing:
            db.rollback()
            fail(409, "homeCoverNotUploaded", "표지 이미지를 먼저 올려 주세요.", missing=missing)
    db.execute("DELETE FROM home_cover_refs WHERE owner=?", (owner,))
    db.executemany("INSERT INTO home_cover_refs VALUES(?,?,?,?)",
                   [(owner, c.sha256, c.sizeBytes, c.contentType) for c in wanted])


def register_cover_tickets(app, get_db, require_client, presign_get):
    """``POST /v1/home/covers/{sha256}/media-ticket`` for blobs a Home publication references."""

    @app.post("/v1/home/covers/{sha256}/media-ticket")
    def cover_ticket(sha256: str, authorization: str | None = Header(default=None)):
        require_client(authorization)
        if not re.fullmatch(r"[a-f0-9]{64}", sha256):
            fail(404, "homeCoverUnavailable", "표지를 찾을 수 없습니다.")
        with get_db() as db:
            row = db.execute("SELECT size_bytes,content_type FROM home_cover_refs WHERE sha256=? LIMIT 1",
                             (sha256,)).fetchone()
        if row is None:
            fail(404, "homeCoverUnavailable", "표지를 찾을 수 없습니다.")
        return {"url": presign_get("work-artwork/mobile/" + sha256, TICKET_SECONDS), "expires_in": TICKET_SECONDS,
                "sha256": sha256, "content_type": row[1], "size_bytes": row[0]}
