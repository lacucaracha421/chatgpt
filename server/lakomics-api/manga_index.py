"""Small server-owned pin snapshot and bookmark-only Manga index.

Pins use the bookmark library/epoch fence, compare-and-set revisions and receipts.
The bounded full snapshot includes tombstones; publication never overwrites it.
"""
import json
import re
import sqlite3
import time

from fastapi import Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

import catalog_bookmarks as bookmarks
import conditional
import mobile_catalog_replica as replica
from mobile_catalog_query import eligible, freeze_query

PREFIX = "/v1/mobile-catalog/index"
MAX_ITEMS = 4096
DOMAIN = "manga-index-pins"
DDL = """
CREATE TABLE IF NOT EXISTS manga_index_pin_revisions(
 library_id TEXT NOT NULL, epoch INTEGER NOT NULL, revision INTEGER NOT NULL,
 PRIMARY KEY(library_id,epoch));
CREATE TABLE IF NOT EXISTS manga_index_pin_state(
 library_id TEXT NOT NULL, epoch INTEGER NOT NULL,
 kind TEXT NOT NULL, namespace TEXT NOT NULL, value TEXT NOT NULL, label TEXT NOT NULL,
 desired_state INTEGER NOT NULL, entity_revision INTEGER NOT NULL,
 created_at TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY(library_id,epoch,kind,namespace,value));
CREATE TABLE IF NOT EXISTS manga_index_pin_receipts(
 library_id TEXT NOT NULL, epoch INTEGER NOT NULL, operation_id TEXT NOT NULL,
 payload_digest TEXT NOT NULL, result_payload TEXT NOT NULL, accepted_at TEXT NOT NULL,
 PRIMARY KEY(library_id,epoch,operation_id));
"""


def startup(get_db):
    with get_db() as db:
        db.executescript(DDL)
        db.commit()


def valid_identity(kind, namespace, value, label):
    def bounded(text, size):
        return (isinstance(text, str) and bool(text.strip())
                and len(text.encode("utf-8")) <= size
                and not re.search(r"[\x00-\x1f\x7f]", text))
    return (kind in ("tag", "artist") and isinstance(namespace, str)
            and re.fullmatch(r"[a-z]{1,32}", namespace) is not None
            and (namespace == "artist") == (kind == "artist")
            and bounded(value, 200) and bounded(label, 400))


def public_item(row):
    return {"kind": row["kind"], "namespace": row["namespace"], "value": row["value"],
            "label": row["label"], "desiredState": bool(row["desired_state"]),
            "entityRevision": row["entity_revision"], "createdAt": row["created_at"],
            "updatedAt": row["updated_at"]}


def revision(db, library_id, epoch):
    row = db.execute("SELECT revision FROM manga_index_pin_revisions WHERE library_id=? AND epoch=?",
                     [library_id, epoch]).fetchone()
    return row[0] if row else 0


def sync_domain(db, domains):
    """Advertise the small preference domain under the bookmark identity fence.

    The aggregate status watcher can wake PC pulls when only tablet pins move.
    Older isolated sync fixtures have no pin tables and keep their old document.
    """
    owner = next((row for row in domains if row["domain"] == bookmarks.DOMAIN), None)
    if owner is None or not db.execute("SELECT 1 FROM sqlite_master WHERE name='manga_index_pin_revisions'").fetchone():
        return None
    return {"domain": DOMAIN, "libraryId": owner["libraryId"], "epoch": owner["epoch"],
            "contractVersion": 1, "cursor": revision(db, owner["libraryId"], owner["epoch"])}


def snapshot(db, library_id, epoch):
    bookmarks.require_authority(db, library_id, epoch)
    items = [public_item(row) for row in db.execute(
        "SELECT * FROM manga_index_pin_state WHERE library_id=? AND epoch=?"
        " ORDER BY created_at,kind,namespace,value LIMIT ?", [library_id, epoch, MAX_ITEMS + 1])]
    if len(items) > MAX_ITEMS:
        raise HTTPException(503, "Pin snapshot exceeds its bound")
    result = {"libraryId": library_id, "epoch": epoch, "contractVersion": 1,
              "revision": revision(db, library_id, epoch), "items": items}
    if len(replica.encode(result).encode()) > bookmarks.MAX_SNAPSHOT_BYTES:
        raise HTTPException(503, "Pin snapshot exceeds its byte bound")
    return result


def apply_command(db, kind, namespace, command, now):
    library_id, epoch = command["libraryId"], command["epoch"]
    bookmarks.require_authority(db, library_id, epoch)
    digest = replica.digest([kind, namespace, command])
    receipt = db.execute("SELECT payload_digest,result_payload FROM manga_index_pin_receipts"
                         " WHERE library_id=? AND epoch=? AND operation_id=?",
                         [library_id, epoch, command["operationId"]]).fetchone()
    if receipt:
        if receipt[0] != digest:
            raise HTTPException(409, "Operation id was already used with a different payload")
        return json.loads(receipt[1])
    identity = [library_id, epoch, kind, namespace, command["value"]]
    row = db.execute("SELECT * FROM manga_index_pin_state"
                     " WHERE library_id=? AND epoch=? AND kind=? AND namespace=? AND value=?", identity).fetchone()
    current = public_item(row) if row else {
        "kind": kind, "namespace": namespace, "value": command["value"], "label": command["label"],
        "desiredState": False, "entityRevision": 0, "createdAt": None, "updatedAt": None}
    cursor = revision(db, library_id, epoch)
    if current["entityRevision"] != command["expectedRevision"]:
        raise HTTPException(409, {"code": "revisionConflict", "current": current, "authorityCursor": cursor})
    target = command["desiredState"]
    changed = current["desiredState"] != target or (target and current["label"] != command["label"])
    if changed:
        if row is None and db.execute(
                "SELECT COUNT(*) FROM manga_index_pin_state WHERE library_id=? AND epoch=?",
                [library_id, epoch]).fetchone()[0] >= MAX_ITEMS:
            raise HTTPException(409, "Pin snapshot exceeds its bound")
        cursor += 1
        current.update(desiredState=target, label=command["label"],
                       entityRevision=current["entityRevision"] + 1, updatedAt=now)
        if target and not (row and row["desired_state"]):
            current["createdAt"] = now
        db.execute("INSERT INTO manga_index_pin_state VALUES(?,?,?,?,?,?,?,?,?,?)"
                   " ON CONFLICT(library_id,epoch,kind,namespace,value) DO UPDATE SET"
                   " label=excluded.label,desired_state=excluded.desired_state,"
                   " entity_revision=excluded.entity_revision,created_at=excluded.created_at,updated_at=excluded.updated_at",
                   [*identity, current["label"], int(target), current["entityRevision"], current["createdAt"], now])
        db.execute("INSERT INTO manga_index_pin_revisions VALUES(?,?,?)"
                   " ON CONFLICT(library_id,epoch) DO UPDATE SET revision=excluded.revision",
                   [library_id, epoch, cursor])
        # Fail the transaction before accepting a write that cannot be read back.
        snapshot(db, library_id, epoch)
    result = {"libraryId": library_id, "epoch": epoch, "contractVersion": 1,
              "revision": cursor, "changed": changed, **current}
    db.execute("INSERT INTO manga_index_pin_receipts VALUES(?,?,?,?,?,?)",
               [library_id, epoch, command["operationId"], digest, replica.encode(result), now])
    # Same retry window as bookmarks; remove only receipts older than that window.
    db.execute("DELETE FROM manga_index_pin_receipts WHERE accepted_at<?", [bookmarks._cutoff(bookmarks.RECEIPT_RETENTION_DAYS)])
    return result


def frequent(db, query, bookmark_count):
    query = freeze_query(db, query)
    where, params = eligible(query)
    source = ("online_catalog_bookmarks bookmark CROSS JOIN catalog.Works work"
              " ON work.Id=CAST(bookmark.work_id AS INTEGER)")
    if query["preparedState"]:
        source += " CROSS JOIN mobile_catalog_work_state state ON state.work_id=work.Id"
    rows = db.execute(
        "SELECT tag.Namespace,tag.Value,COUNT(DISTINCT work.Id),tr.label FROM " + source
        + " CROSS JOIN catalog.Tags tag ON tag.WorkId=work.Id"
        " LEFT JOIN catalog.Translations tr ON tr.namespace=tag.Namespace AND tr.value=tag.Value"
        " WHERE bookmark.provider='kHentai' AND bookmark.work_id=CAST(work.Id AS TEXT) AND " + where
        + " AND tag.Namespace NOT IN ('language','temp')"
        " AND NOT(tag.Namespace='parody' AND tag.Value='original')"
        " GROUP BY tag.Namespace,tag.Value ORDER BY COUNT(DISTINCT work.Id) DESC,tag.Namespace,tag.Value", params)
    result = {"bookmarkCount": bookmark_count, "tags": [], "artists": [], "tagLimit": 8, "artistLimit": 5}
    for namespace, value, count, label in rows:
        artist = namespace == "artist"
        item = {"kind": "artist" if artist else "tag", "namespace": namespace, "value": value,
                "label": label or value.replace("_", " "), "count": count}
        result["artists" if artist else "tags"].append(item)
    return result


def register(app, get_db, require_client, root, normalize, budget, unavailable):
    @app.get(PREFIX + "/pins")
    async def pins(request: Request, libraryId: str, epoch: int,
                   authorization: str | None = Header(default=None),
                   if_none_match: str | None = Header(default=None)):
        require_client(authorization)
        if set(request.query_params) != {"libraryId", "epoch"} or not re.fullmatch(r"[a-f0-9]{32}", libraryId) or epoch < 1:
            replica.fail(422)
        def run():
            with get_db() as db:
                db.execute("BEGIN")
                try:
                    return snapshot(db, libraryId, epoch)
                finally:
                    db.rollback()
        return conditional.json_response(await run_in_threadpool(run), if_none_match)

    @app.put(PREFIX + "/pins/{kind}/{namespace}")
    async def pin_command(kind: str, namespace: str, request: Request,
                          authorization: str | None = Header(default=None)):
        require_client(authorization)
        raw = bytearray()
        async for chunk in request.stream():
            if len(raw) + len(chunk) > 4096:
                replica.fail(413)
            raw.extend(chunk)
        try:
            command = json.loads(raw)
        except (ValueError, UnicodeError):
            replica.fail(422)
        keys = {"libraryId", "epoch", "contractVersion", "operationId", "expectedRevision", "desiredState", "value", "label"}
        if not isinstance(command, dict) or set(command) != keys:
            replica.fail(422)
        if (not isinstance(command["libraryId"], str) or not re.fullmatch(r"[a-f0-9]{32}", command["libraryId"])
                or type(command["epoch"]) is not int or command["epoch"] < 1
                or type(command["contractVersion"]) is not int or command["contractVersion"] != 1
                or not isinstance(command["operationId"], str) or not re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", command["operationId"])
                or type(command["expectedRevision"]) is not int or command["expectedRevision"] < 0
                or type(command["desiredState"]) is not bool
                or not valid_identity(kind, namespace, command["value"], command["label"])):
            replica.fail(422)
        def run():
            with get_db() as db:
                db.execute("BEGIN IMMEDIATE")
                try:
                    result = apply_command(db, kind, namespace, command, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
                    db.commit()
                    return result
                except BaseException:
                    db.rollback()
                    raise
        return await run_in_threadpool(run)

    @app.get(PREFIX + "/frequent")
    def frequent_index(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        if not set(request.query_params) <= {"language", "categories", "excludedTags", "revealBlocked"}:
            replica.fail(400)
        query = normalize(dict(request.query_params))
        authority = bookmarks.load(get_db)
        if authority is None:
            raise HTTPException(409, "Catalog bookmark authority is not active")
        with get_db() as db:
            if replica.current(db) is None:
                return {"ready": False}
        try:
            with replica.open_publication(root(), get_db, bookmarks=authority) as (db, publication):
                budget(db)
                return {"ready": True, "publicationRevision": publication["revision"],
                        **frequent(db, query, len(authority["bookmarks"]))}
        except sqlite3.Error as exc:
            unavailable(exc)
