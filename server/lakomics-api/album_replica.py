"""Publish and read the legacy Album display replica.

The application module is supplied at registration so its shared services and
compatibility hooks are resolved at call time, including test monkeypatches.
"""
import json
from datetime import timezone
from types import ModuleType
from typing import Annotated

from fastapi import HTTPException, Header, Query, Response
from fastapi.responses import JSONResponse
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

import album_authority
import authority


api: ModuleType


# Album metadata replica: independent of capture ingestion and asset replication.
class AlbumReplicaEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=256)
    parent_id: str | None = Field(default=None, max_length=64)
    #: Snapshot version 2+ fields. Absent means a version-1 publisher, which the server
    #: still accepts for the display replica but cannot treat as authority-ready.
    icon_key: str | None = Field(default=None, max_length=64)
    color_key: str | None = Field(default=None, max_length=64)


class AlbumReplicaMedia(BaseModel):
    """Display-oriented media rows. Normal-visible Assets only, by design."""
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=64)
    date: int = Field(ge=0)
    width: int = Field(ge=0)
    height: int = Field(ge=0)
    duration: int = Field(ge=0)
    albums: list[str] = Field(max_length=2000)


class AlbumReplicaMembership(BaseModel):
    """One canonical Asset<->Album relation, independent of Asset display status.

    A trashed Asset keeps its Album relations in the PC database, so the canonical
    membership collection must carry them too. Deriving canonical membership from the
    display `media` array instead would silently drop those relations at activation
    and break the product contract that restoring an Asset returns its Albums.
    """
    model_config = ConfigDict(extra="forbid")
    album_id: str = Field(alias="albumId", min_length=1, max_length=64)
    asset_id: str = Field(alias="assetId", min_length=1, max_length=64)


class AlbumReplicaPublish(BaseModel):
    likes_album_id: str | None = Field(default=None, alias="likesAlbumId", min_length=1, max_length=128)
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    #: The wire name is camelCase, matching the Rust publisher. Without this alias the
    #: model would reject the field as unknown under `extra="forbid"`, so the documented
    #: contract and the accepted contract would disagree.
    snapshot_version: int | None = Field(default=None, alias="snapshotVersion")
    published_at: AwareDatetime
    albums: list[AlbumReplicaEntry] = Field(max_length=2000)
    media: list[AlbumReplicaMedia] = Field(max_length=100000)
    #: Snapshot version 3 only. `None` distinguishes "a version-1/2 publisher that has
    #: no canonical membership to send" from "a version-3 publisher with no relations",
    #: which must be an explicit empty list rather than an absence.
    memberships: list[AlbumReplicaMembership] | None = Field(default=None, max_length=200000)

    def resolved_version(self) -> int:
        """The snapshot contract version this body represents.

        An older publisher omits the field; a newer one sets it. Deriving the version
        from the field rather than from content presence keeps "authority-ready" an
        explicit publisher statement instead of an inference about which keys appeared.
        """
        return 1 if self.snapshot_version is None else self.snapshot_version


def publish_album_replica(snapshot: AlbumReplicaPublish, authorization: str | None = Header(default=None)):
    api.require_auth(authorization)
    version = snapshot.resolved_version()
    if version not in (1, 2, album_authority.SNAPSHOT_VERSION):
        # An unknown version cannot be interpreted as any known shape, and guessing
        # could store albums a later activation would reject.
        raise HTTPException(422, {"code": "unsupportedAlbumSnapshotVersion",
                                  "message": "지원하지 않는 앨범 스냅샷 버전입니다.",
                                  "supported": [1, 2, album_authority.SNAPSHOT_VERSION]})
    ids = {album.id for album in snapshot.albums}
    if len(ids) != len(snapshot.albums) or len({m.id for m in snapshot.media}) != len(snapshot.media):
        raise HTTPException(400, "Duplicate IDs")
    if any(a.parent_id == a.id or (a.parent_id is not None and a.parent_id not in ids) for a in snapshot.albums):
        raise HTTPException(400, "Invalid album parent")
    if any(not m.albums or len(set(m.albums)) != len(m.albums) or not set(m.albums) <= ids for m in snapshot.media):
        raise HTTPException(400, "Invalid album membership")
    if version >= 2:
        # Appearance is canonical Album state, so a version-2+ publisher must state it
        # explicitly. Validating here means activation never has to guess, and an
        # unrenderable value is rejected at the publisher rather than stored.
        for album in snapshot.albums:
            if not album_authority.valid_appearance(album.icon_key, album.color_key):
                raise HTTPException(400, "Invalid album appearance")
    if snapshot.likes_album_id is not None and snapshot.likes_album_id not in ids:
        raise HTTPException(400, "Invalid likes album")
    memberships = None
    if version >= album_authority.SNAPSHOT_VERSION:
        # Canonical membership is its own collection precisely because it is *not*
        # display membership: a trashed Asset keeps its Album relations locally, and
        # activation must see them. Requiring the field (rather than defaulting it)
        # means a version-3 publisher cannot silently publish an empty canonical set.
        if snapshot.memberships is None:
            raise HTTPException(422, {"code": "missingAlbumMemberships",
                                      "message": "앨범 스냅샷에 canonical 연결 목록이 필요합니다."})
        seen = set()
        for membership in snapshot.memberships:
            key = (membership.album_id, membership.asset_id)
            if membership.album_id not in ids or key in seen:
                raise HTTPException(400, "Invalid album membership")
            seen.add(key)
        memberships = sorted(seen)
    payload = json.dumps(
        {**({"likesAlbumId": snapshot.likes_album_id} if snapshot.likes_album_id is not None else {}),
         "snapshotVersion": version,
         "albums": [a.model_dump() for a in snapshot.albums],
         "media": [m.model_dump() for m in snapshot.media],
         "memberships": [{"albumId": album_id, "assetId": asset_id}
                         for album_id, asset_id in (memberships or [])]},
        separators=(",", ":"), sort_keys=True)
    # The bound is measured against the documented maxima rather than inherited: the
    # supported contract allows 2,000 Albums, 100,000 display media rows and 100,000
    # canonical relations, which exceeds an arbitrary 16 MiB. This is a publisher-only
    # staging payload, so it is bounded generously but still bounded.
    if len(payload.encode()) > album_authority.MAX_STAGING_BYTES:
        raise HTTPException(413, {"code": "albumSnapshotTooLarge",
                                  "message": "앨범 스냅샷이 허용 크기를 초과합니다.",
                                  "maxBytes": album_authority.MAX_STAGING_BYTES})
    published = snapshot.published_at.astimezone(timezone.utc).isoformat()
    with api.get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        # Safety Batch 0's reusable fence, called inside the same transaction that
        # performs the legacy replacement. While no `albums` authority row exists
        # this is a no-op and the legacy route behaves exactly as before; once the
        # Album epoch is active the legacy publisher is rejected with a coded
        # conflict instead of overwriting server-authoritative state.
        authority.fence_legacy_write(db, album_authority.DOMAIN)
        old = db.execute("SELECT published_at FROM album_replica WHERE singleton=1").fetchone()
        if old and old["published_at"] > published:
            raise HTTPException(409, "Stale album snapshot")
        db.execute("""INSERT INTO album_replica VALUES (1,?,?)
            ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload,published_at=excluded.published_at""",
            (payload, published))
        db.commit()
    # The digest identifies the exact bytes now stored, so the publisher can present
    # it when activating and the server can re-derive from the same snapshot.
    with api.get_db() as db:
        snapshot_digest = album_authority.stored_snapshot_digest(db)
    return {"ok": True, "snapshotVersion": version, "snapshotDigest": snapshot_digest}


def read_album_replica(
    album_id: Annotated[list[str], Query(min_length=1, max_length=20)],
    authorization: str | None = Header(default=None),
    if_none_match: str | None = Header(default=None),
):
    api.require_auth(authorization)
    selected = set(album_id)
    with api.get_db() as db:
        row = db.execute("SELECT payload FROM album_replica WHERE singleton=1").fetchone()
        if row is None:
            raise HTTPException(503, "Album snapshot has not been published")
        snapshot = json.loads(row["payload"])
        albums = [a for a in snapshot["albums"] if a["id"] in selected]
        members = [m for m in snapshot["media"] if selected.intersection(m["albums"])]
        ready = {}
        for offset in range(0, len(members), 500):
            ids = [m["id"] for m in members[offset:offset + 500]]
            placeholders = ",".join("?" for _ in ids)
            for asset in db.execute(f"""SELECT id,content_type,size_bytes FROM visible_assets
                WHERE committed=1 AND thumbnail_key IS NOT NULL AND content_type IS NOT NULL
                AND size_bytes > 0 AND id IN ({placeholders})""", ids):
                ready[asset["id"]] = dict(asset)
        media = [{**m, "albums": sorted(selected.intersection(m["albums"])),
                  "mime": ready[m["id"]]["content_type"], "size": ready[m["id"]]["size_bytes"]}
                 for m in members if m["id"] in ready]
    import hashlib
    albums.sort(key=lambda a: a["id"])
    media.sort(key=lambda m: (-m["date"], m["id"]))
    payload = {"albums": albums, "media": media}
    revision = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    etag = '"' + revision + '"'
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if if_none_match == etag:
        return Response(status_code=304, headers=headers)
    return JSONResponse({**payload, "revision": revision, "generation": 1}, headers=headers)


def register(app, services):
    global api
    api = services
    app.put("/v1/library/album-snapshot")(publish_album_replica)
    app.get("/v1/library/album-media")(read_album_replica)
