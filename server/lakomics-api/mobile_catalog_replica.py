"""Bounded PC projection import and immutable catalog publications."""
from __future__ import annotations
import hashlib
import json
import math
import os
import re
import shutil
import sqlite3
import tempfile
import time
from contextlib import contextmanager, closing
from pathlib import Path
from fastapi import HTTPException
from mobile_catalog_query import count_groups

MAX_CONTENT = 512 * 1024 * 1024
MAX_RECORD = 1024 * 1024
MAX_USERS = 8 * 1024 * 1024
TABLES = {
    "work": ("Works", "Id Title TitleJpn Category Uploader Posted Updated FileCount FileSize Rating Views Thumb Expunged".split()),
    "tag": ("Tags", "WorkId Namespace Value".split()),
    "member": ("online_catalog_group_members", "provider work_id catalog_work_id group_id thumbnail_valid completeness lineage_terminal".split()),
    "handle": ("online_catalog_group_handles", "provider anchor_work_id group_id sequence".split()),
    "translation": ("Translations", "namespace value label".split()),
}
CONTENT_DDL = """
CREATE TABLE Works(Id INTEGER PRIMARY KEY,Title TEXT NOT NULL,TitleJpn TEXT,Category INTEGER,Uploader TEXT,Posted INTEGER,Updated INTEGER,FileCount INTEGER NOT NULL,FileSize INTEGER,Rating REAL,Views INTEGER NOT NULL,Thumb TEXT,Expunged INTEGER NOT NULL);
CREATE TABLE Tags(WorkId INTEGER,Namespace TEXT,Value TEXT,PRIMARY KEY(WorkId,Namespace,Value)) WITHOUT ROWID;
CREATE TABLE online_catalog_group_members(provider TEXT,work_id TEXT,catalog_work_id INTEGER,group_id TEXT,thumbnail_valid INTEGER,completeness INTEGER,lineage_terminal INTEGER,PRIMARY KEY(provider,work_id),UNIQUE(provider,catalog_work_id)) WITHOUT ROWID;
CREATE TABLE online_catalog_group_handles(provider TEXT,anchor_work_id TEXT,group_id TEXT UNIQUE,sequence INTEGER,PRIMARY KEY(provider,anchor_work_id)) WITHOUT ROWID;
CREATE TABLE Translations(namespace TEXT,value TEXT,label TEXT,PRIMARY KEY(namespace,value)) WITHOUT ROWID;
CREATE TABLE Manifest(payload TEXT NOT NULL);
"""
INDEX_DDL = """
CREATE INDEX IdxTagsLookup ON Tags(Namespace,Value,WorkId);
CREATE INDEX IdxWorksPosted ON Works(Posted DESC,Id DESC);
CREATE INDEX IdxWorksRank ON Works(Expunged,Views DESC,Posted DESC,Id DESC);
CREATE INDEX online_catalog_group_members_reverse ON online_catalog_group_members(provider,group_id,catalog_work_id);
"""
# The membership key is (provider, catalog_work_id). Bind its leading column
# so validation probes each work instead of rescanning all members per work.
CONTENT_VALIDATION_SQL = """SELECT
              EXISTS(SELECT 1 FROM Works WHERE typeof(Id)!='integer' OR Id<=0 OR typeof(Title)!='text' OR typeof(FileCount)!='integer' OR FileCount<0 OR typeof(Views)!='integer' OR Views<0 OR Expunged NOT IN (0,1)) OR
              EXISTS(SELECT 1 FROM Tags t LEFT JOIN Works w ON w.Id=t.WorkId WHERE w.Id IS NULL OR typeof(t.Namespace)!='text' OR typeof(t.Value)!='text') OR
              EXISTS(SELECT 1 FROM online_catalog_group_members m LEFT JOIN Works w ON w.Id=m.catalog_work_id WHERE w.Id IS NULL OR m.work_id!=CAST(w.Id AS TEXT) OR m.group_id IS NULL OR m.thumbnail_valid NOT IN(0,1) OR m.lineage_terminal NOT IN(0,1)) OR
              EXISTS(SELECT 1 FROM Works w WHERE w.Expunged=0 AND NOT EXISTS(SELECT 1 FROM online_catalog_group_members m WHERE m.provider='kHentai' AND m.catalog_work_id=w.Id)) OR
              EXISTS(SELECT 1 FROM online_catalog_group_members m WHERE NOT EXISTS(SELECT 1 FROM online_catalog_group_handles h WHERE h.group_id=m.group_id))"""
USER_DDL = """
CREATE TABLE online_catalog_bookmarks(provider TEXT,work_id TEXT,created_at TEXT,PRIMARY KEY(provider,work_id)) WITHOUT ROWID;
CREATE TABLE online_catalog_hidden_categories(category INTEGER PRIMARY KEY,created_at TEXT);
CREATE TABLE online_catalog_blocked_tags(namespace TEXT,value TEXT,created_at TEXT,PRIMARY KEY(namespace,value)) WITHOUT ROWID;
CREATE TABLE online_catalog_group_preferences(provider TEXT,anchor_work_id TEXT,selected_work_id TEXT,edit_revision INTEGER,PRIMARY KEY(provider,anchor_work_id)) WITHOUT ROWID;
CREATE TABLE prepared_counts(language TEXT,reveal INTEGER,exact_count INTEGER,PRIMARY KEY(language,reveal)) WITHOUT ROWID;
"""

def encode(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)

def digest(value):
    return hashlib.sha256(encode(value).encode()).hexdigest()

def fail(status=422, message="Invalid catalog projection"):
    raise HTTPException(status, message)

def checked_digest(value):
    if not isinstance(value, str) or not re.fullmatch("[a-f0-9]{64}", value):
        fail()
    return value

def startup(get_db):
    with get_db() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS mobile_catalog_artifacts(digest TEXT PRIMARY KEY,manifest TEXT NOT NULL,ready_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mobile_catalog_users(revision TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mobile_catalog_publications(revision TEXT PRIMARY KEY,content_digest TEXT NOT NULL,user_revision TEXT NOT NULL,published_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS mobile_catalog_current(singleton INTEGER PRIMARY KEY CHECK(singleton=1),publication_revision TEXT NOT NULL);
        """)
        db.commit()

def current(db):
    return db.execute("SELECT p.* FROM mobile_catalog_current c JOIN mobile_catalog_publications p ON p.revision=c.publication_revision WHERE c.singleton=1").fetchone()

def artifact_path(root, value):
    return Path(root) / (checked_digest(value) + ".sqlite")

def users_path(root, value):
    return Path(root) / (checked_digest(value) + "-users.sqlite")

def import_content(path, expected, root, get_db):
    checked_digest(expected)
    counts = {kind: 0 for kind in TABLES}
    manifest = None
    h = hashlib.sha256()
    root = Path(root); root.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(root).free < Path(path).stat().st_size * 2 + 64 * 1024 * 1024:
        fail(507, "Insufficient space for a staged catalog projection")
    fd, temporary = tempfile.mkstemp(prefix="catalog-", suffix=".sqlite", dir=root)
    os.close(fd)
    try:
        with closing(sqlite3.connect(temporary)) as db, open(path, "rb") as source:
            db.executescript(CONTENT_DDL)
            total = 0
            while line := source.readline(MAX_RECORD + 1):
                total += len(line)
                if len(line) > MAX_RECORD or total > MAX_CONTENT:
                    fail(413, "Catalog projection exceeds its limit")
                h.update(line)
                try:
                    record = json.loads(line)
                except (ValueError, UnicodeError):
                    fail()
                if not isinstance(record, dict) or set(record) != {"kind", "value"}:
                    fail()
                kind, value = record["kind"], record["value"]
                if manifest is None:
                    if kind != "manifest" or not isinstance(value, dict) or set(value) != {"contractVersion", "schemaVersion", "sourceRevision", "groupGeneration", "groupDecisionRevision", "counts"}:
                        fail()
                    if value["contractVersion"] != 1 or value["schemaVersion"] != 1 or not isinstance(value["sourceRevision"], str) or not value["sourceRevision"] or value["sourceRevision"] == "legacy" or not isinstance(value["groupGeneration"], int) or value["groupGeneration"] < 1:
                        fail()
                    checked_digest(value["groupDecisionRevision"])
                    if not isinstance(value["counts"], dict) or set(value["counts"]) != set(TABLES) or any(type(n) is not int or n < 0 for n in value["counts"].values()):
                        fail()
                    manifest = value
                    db.execute("INSERT INTO Manifest VALUES(?)", [encode(value)])
                    continue
                if kind not in TABLES:
                    fail()
                table, columns = TABLES[kind]
                if not isinstance(value, dict) or set(value) != set(columns) or any(not (v is None or type(v) in (str, int, float)) for v in value.values()):
                    fail()
                if any(isinstance(v, str) and len(v.encode()) > 65536 for v in value.values()):
                    fail()
                numeric = {"work": ("Id", "FileCount", "Views", "Expunged"), "tag": ("WorkId",), "member": ("catalog_work_id", "thumbnail_valid", "completeness", "lineage_terminal"), "handle": ("sequence",), "translation": ()}[kind]
                if any(type(value[key]) is not int for key in numeric):
                    fail()
                nullable_numbers = ("Category", "Posted", "Updated", "FileSize") if kind == "work" else ()
                if any(value[key] is not None and type(value[key]) is not int for key in nullable_numbers):
                    fail()
                nullable_strings = ("TitleJpn", "Uploader", "Thumb") if kind == "work" else ()
                if kind == "work" and value["Rating"] is not None and (type(value["Rating"]) not in (int, float) or not math.isfinite(value["Rating"])):
                    fail()
                strings = set(columns) - set(numeric) - set(nullable_numbers) - ({"Rating"} if kind == "work" else set())
                if any(not isinstance(value[key], str) and not (key in nullable_strings and value[key] is None) for key in strings):
                    fail()
                if kind in ("member", "handle") and value["provider"] != "kHentai":
                    fail()
                try:
                    db.execute(f"INSERT INTO {table} VALUES({','.join('?' for _ in columns)})", [value[c] for c in columns])
                except (sqlite3.Error, OverflowError):
                    fail()
                counts[kind] += 1
            if manifest is None or h.hexdigest() != expected or counts != manifest["counts"]:
                fail()
            invalid = db.execute(CONTENT_VALIDATION_SQL).fetchone()[0]
            if invalid:
                fail()
            db.executescript(INDEX_DDL)
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                fail()
            db.commit()
        with open(temporary, "rb+") as sealed:
            os.fsync(sealed.fileno())
        destination = artifact_path(root, expected)
        # Atomic create-if-absent, including concurrent processes. Never replace
        # an immutable file held by readers. Staging is on the same filesystem.
        try:
            os.link(temporary, destination)
        except FileExistsError:
            pass
        os.unlink(temporary)
        with get_db() as db:
            db.execute("INSERT INTO mobile_catalog_artifacts VALUES(?,?,?) ON CONFLICT(digest) DO NOTHING", [expected, encode(manifest), str(int(time.time()))])
            db.commit()
        return {"contentDigest": expected, "ready": True, "counts": counts}
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def validate_users(value):
    if not isinstance(value, dict) or set(value) != {"bookmarks", "hiddenCategories", "blockedTags", "preferences", "decisions", "decisionRevision"}:
        fail()
    try:
        if len(encode(value).encode()) > MAX_USERS:
            fail(413)
    except (ValueError, TypeError):
        fail()
    expected = {"bookmarks": 3, "hiddenCategories": 2, "blockedTags": 3, "preferences": 4, "decisions": 6}
    for key, length in expected.items():
        rows = value[key]
        if not isinstance(rows, list) or len(rows) > 100000:
            fail()
        for row in rows:
            if not isinstance(row, list) or len(row) != length or any(x is not None and type(x) not in (str, int) for x in row):
                fail()
            if any(isinstance(x, str) and len(x.encode()) > 65536 for x in row):
                fail()
        if rows != sorted(rows, key=lambda r: encode(r)):
            fail()
    if value["decisionRevision"] != digest(value["decisions"]):
        fail()
    for provider, work, created in value["bookmarks"]:
        if provider not in ("kHentai", "heliotrope") or not isinstance(work, str) or not work.strip() or not isinstance(created, str):
            fail()
    for category, created in value["hiddenCategories"]:
        if type(category) is not int or not 1 <= category <= 11 or not isinstance(created, str):
            fail()
    for namespace, tag, created in value["blockedTags"]:
        if not all(isinstance(s, str) and s for s in (namespace, tag, created)):
            fail()
    for provider, anchor, selected, revision in value["preferences"]:
        if provider != "kHentai" or not isinstance(anchor, str) or selected is not None and not isinstance(selected, str) or type(revision) is not int or revision < 1:
            fail()
    for left, right, decision, evidence, reviewed, marker in value["decisions"]:
        if not all(isinstance(s, str) for s in (left, right, decision, evidence, reviewed, marker)) or left >= right or decision not in ("confirm", "falsePositive", "split") or marker != "kHentai":
            fail()
    return value

def prepare_users(root, content, revision, users):
    destination = users_path(root, revision)
    if destination.exists():
        return
    fd, temporary = tempfile.mkstemp(prefix="users-", suffix=".sqlite", dir=root); os.close(fd)
    try:
        with closing(sqlite3.connect(temporary, uri=True)) as db:
            db.executescript(USER_DDL)
            for key, table, n in (("bookmarks", "online_catalog_bookmarks", 3), ("hiddenCategories", "online_catalog_hidden_categories", 2), ("blockedTags", "online_catalog_blocked_tags", 3), ("preferences", "online_catalog_group_preferences", 4)):
                db.executemany(f"INSERT INTO {table} VALUES({','.join('?' for _ in range(n))})", users[key])
            db.execute("ATTACH DATABASE ? AS catalog", [artifact_path(root, content).as_uri() + "?mode=ro"])
            for language in ("all", "korean", "japanese"):
                for reveal in (False, True):
                    q = {"language": language, "revealBlocked": reveal, "text": "", "scope": "all", "sort": "latest"}
                    db.execute("INSERT INTO prepared_counts VALUES(?,?,?)", [language, int(reveal), count_groups(db, q)])
            db.commit()
        with open(temporary, "rb+") as sealed:
            os.fsync(sealed.fileno())
        try:
            os.link(temporary, destination)
        except FileExistsError:
            pass
        os.unlink(temporary)
    except sqlite3.Error:
        fail()
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def publish(body, root, get_db):
    if not isinstance(body, dict) or set(body) != {"version", "baseRevision", "contentDigest", "userSnapshot"} or body["version"] != 1:
        fail()
    content = checked_digest(body["contentDigest"])
    if body["baseRevision"] is not None:
        checked_digest(body["baseRevision"])
    users = validate_users(body["userSnapshot"])
    user_revision = digest(users)
    revision = digest(["mobile-catalog-v1", content, user_revision])
    with get_db() as db:
        artifact = db.execute("SELECT manifest FROM mobile_catalog_artifacts WHERE digest=?", [content]).fetchone()
        if artifact is None or not artifact_path(root, content).is_file():
            fail(409, "Catalog projection is not ready")
        if json.loads(artifact[0])["groupDecisionRevision"] != users["decisionRevision"]:
            fail(409, "Catalog decisions changed; export again")
        prior = current(db)
        if prior and prior["revision"] == revision:
            return dict(publicationRevision=revision, publishedAt=prior["published_at"], userRevision=user_revision)
        if (prior["revision"] if prior else None) != body["baseRevision"]:
            fail(409, "Catalog publication changed; refresh before publishing")
        if prior and prior["content_digest"] != content and prior["user_revision"] != user_revision and db.execute("SELECT EXISTS(SELECT 1 FROM mobile_catalog_publications WHERE content_digest=?)", [content]).fetchone()[0]:
            fail(409, "A rollback must retain the current user snapshot")
    prepare_users(root, content, revision, users)
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        prior = current(db)
        if (prior["revision"] if prior else None) != body["baseRevision"]:
            if not prior or prior["revision"] != revision:
                fail(409, "Catalog publication changed; refresh before publishing")
        published = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        db.execute("INSERT INTO mobile_catalog_users VALUES(?,?) ON CONFLICT DO NOTHING", [user_revision, encode(users)])
        db.execute("INSERT INTO mobile_catalog_publications VALUES(?,?,?,?) ON CONFLICT DO NOTHING", [revision, content, user_revision, published])
        db.execute("INSERT INTO mobile_catalog_current VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET publication_revision=excluded.publication_revision", [revision])
        db.commit()
        row = current(db)
        return dict(publicationRevision=revision, publishedAt=row["published_at"], userRevision=user_revision)

@contextmanager
def open_publication(root, get_db, revision=None):
    with get_db() as control:
        row = current(control) if revision is None else control.execute("SELECT * FROM mobile_catalog_publications WHERE revision=?", [checked_digest(revision)]).fetchone()
        if row is None:
            fail(409, "Catalog snapshot is unavailable; refresh")
        publication = dict(row)
    db = sqlite3.connect(users_path(root, publication["revision"]).as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        db.execute("ATTACH DATABASE ? AS catalog", [artifact_path(root, publication["content_digest"]).as_uri() + "?mode=ro"])
        db.execute("PRAGMA query_only=ON")
        db.execute("BEGIN")
        yield db, publication
    finally:
        db.close()
