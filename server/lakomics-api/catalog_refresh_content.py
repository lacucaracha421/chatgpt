"""Additive provider ingestion; PC decisions and existing memberships are retained.

The durable additions ledger is also applied to later PC publications, so an
offline PC cannot remove works accepted by a server refresh.
"""
import json
import math
import os
import shutil
import sqlite3
import tempfile
import uuid
from contextlib import closing

import mobile_catalog_replica as replica

MAX_PAGE_BYTES = 5 * 1024 * 1024


def parse_page(body, language):
    if not isinstance(body, (bytes, str)) or len(body) > MAX_PAGE_BYTES:
        raise ValueError("Invalid catalog page")
    values = json.loads(body)
    if not isinstance(values, list) or len(values) > 50:
        raise ValueError("Invalid catalog page")

    def integer(value, default=None):
        if value is None:
            return default
        if isinstance(value, bool) or not isinstance(value, (str, int)):
            raise ValueError("Invalid catalog number")
        number = int(value)
        if not -(2**63) < number < 2**63:
            raise ValueError("Invalid catalog number")
        return number

    def text(value):
        if value is None:
            return None
        if not isinstance(value, (str, int, float, bool)):
            raise ValueError("Invalid catalog text")
        value = str(value)
        if len(value.encode()) > 65536:
            raise ValueError("Invalid catalog text")
        return value

    rows = []
    for value in values:
        if not isinstance(value, dict):
            raise ValueError("Invalid catalog work")
        work_id = integer(value.get("id"), 0)
        if work_id <= 0:
            raise ValueError("Invalid catalog id")
        tags = value.get("tags")
        if not isinstance(tags, list):
            raise ValueError("Invalid catalog tags")
        pairs = set()
        for tag in tags:
            pair = tag.get("tag") if isinstance(tag, dict) else None
            if not isinstance(pair, list) or len(pair) != 2:
                raise ValueError("Invalid catalog tag")
            namespace, name = text(pair[0]), text(pair[1])
            if namespace and name and namespace.strip() and name.strip():
                pairs.add((namespace.strip(), name.strip()))
        if ("language", language) not in pairs:
            raise ValueError("Wrong catalog language")
        work = {"Id": work_id}
        for column, field in (("Title", "title"), ("TitleJpn", "title_jpn"), ("Uploader", "uploader"), ("Thumb", "thumb")):
            work[column] = text(value.get(field))
        work["Title"] = work["Title"] or ""
        for column, field in (("Category", "category"), ("Posted", "posted"), ("Updated", "updated"), ("FileCount", "filecount"), ("FileSize", "filesize"), ("Views", "views")):
            work[column] = integer(value.get(field), 0 if column in ("FileCount", "Views") else None)
        for column in ("Posted", "Updated"):
            while work[column] is not None and abs(work[column]) >= 100_000_000_000:
                work[column] = int(work[column] / 1000)
        rating = value.get("rating")
        work["Rating"] = None if rating is None else float(rating)
        if work["Rating"] is not None and not math.isfinite(work["Rating"]):
            raise ValueError("Invalid catalog rating")
        work["Expunged"] = int(value.get("expunged") in (True, 1, "1"))
        if work["FileCount"] < 0 or work["Views"] < 0:
            raise ValueError("Invalid catalog work")
        rows.append({"work": work, "tags": sorted(pairs)})
    ids = [row["work"]["Id"] for row in rows]
    if ids != sorted(set(ids), reverse=True):
        raise ValueError("Catalog page did not descend")
    return rows


def materialize(root, content, get_db, additions=()):
    """Build an immutable derived artifact without touching the readable baseline."""
    with get_db() as control:
        saved = control.execute("SELECT payload FROM mobile_catalog_server_additions ORDER BY work_id").fetchall()
    merged = {row["work"]["Id"]: row for row in map(lambda r: json.loads(r[0]), saved)}
    for row in additions:
        work_id = row["work"]["Id"]
        if work_id in merged:
            row = {**row, "tags": sorted({tuple(tag) for tag in merged[work_id]["tags"] + row["tags"]})}
        merged[work_id] = row
    if not merged:
        return content
    source = replica.artifact_path(root, content)
    changes = []
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as db:
        for work_id, row in sorted(merged.items()):
            exists = db.execute("SELECT 1 FROM Works WHERE Id=?", [work_id]).fetchone()
            languages = [tag for tag in row["tags"] if tag[0] == "language" and tag[1] in ("korean", "japanese")]
            missing = [tag for tag in languages if not db.execute("SELECT 1 FROM Tags WHERE WorkId=? AND Namespace=? AND Value=?", [work_id, *tag]).fetchone()]
            if not exists or missing:
                changes.append((row, bool(exists), missing))
    if not changes:
        return content
    derived = replica.digest(["server-catalog-additions-v1", content, changes])
    destination = replica.artifact_path(root, derived)
    if shutil.disk_usage(root).free < source.stat().st_size * 2 + 64 * 1024 * 1024:
        replica.fail(507, "Insufficient catalog storage")
    fd, temporary = tempfile.mkstemp(prefix="refresh-content-", suffix=".sqlite", dir=root)
    os.close(fd)
    try:
        shutil.copyfile(source, temporary)
        with closing(sqlite3.connect(temporary)) as db:
            manifest = json.loads(db.execute("SELECT payload FROM Manifest").fetchone()[0])
            sequence = db.execute("SELECT COALESCE(MAX(sequence),0) FROM online_catalog_group_handles").fetchone()[0]
            for row, exists, languages in changes:
                work, tags = row["work"], row["tags"]
                work_id = work["Id"]
                if not exists:
                    columns = replica.TABLES["work"][1]
                    db.execute(f"INSERT INTO Works({','.join(columns)}) VALUES({','.join('?' for _ in columns)})", [work[c] for c in columns])
                    handle = db.execute("SELECT group_id FROM online_catalog_group_handles WHERE provider='kHentai' AND anchor_work_id=?", [str(work_id)]).fetchone()
                    group = handle[0] if handle else str(uuid.uuid5(uuid.NAMESPACE_URL, f"lakomics:kHentai:{work_id}"))
                    sequence += 1
                    db.execute("INSERT OR IGNORE INTO online_catalog_group_handles VALUES('kHentai',?,?,?)", [str(work_id), group, sequence])
                    db.execute("INSERT INTO online_catalog_group_members VALUES('kHentai',?,?,?,?,0,1)", [str(work_id), work_id, group, int(bool(work["Thumb"]))])
                db.executemany("INSERT OR IGNORE INTO Tags VALUES(?,?,?)", [[work_id, *tag] for tag in (languages if exists else tags)])
            manifest["sourceRevision"] = "server:" + derived
            manifest["groupGeneration"] += 1
            manifest["counts"] = {kind: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for kind, (table, _) in replica.TABLES.items()}
            db.execute("UPDATE Manifest SET payload=?", [replica.encode(manifest)])
            if db.execute(replica.CONTENT_VALIDATION_SQL).fetchone()[0] or db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                replica.fail(422, "Invalid refreshed catalog")
            db.commit()
        if os.path.getsize(temporary) > replica.MAX_CONTENT:
            replica.fail(413, "Catalog storage limit reached")
        with open(temporary, "rb+") as sealed:
            os.fsync(sealed.fileno())
        try:
            os.link(temporary, destination)
        except FileExistsError:
            pass
        with get_db() as control:
            control.execute("INSERT INTO mobile_catalog_artifacts VALUES(?,?,?) ON CONFLICT DO NOTHING", [derived, replica.encode(manifest), "server-refresh"])
            control.commit()
        return derived
    finally:
        os.unlink(temporary)
