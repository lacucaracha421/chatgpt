"""Manga Catalog duplicate-edition candidates and server-owned review decisions.

Decided 2026-09-24 (docs/roadmap/lakomics-backlog.md, "Manga Catalog duplicate-edition
checking"): the PC keeps the full comparison. It computes candidates with the rules in
`_tools/app/src-tauri/src/library/catalog_review.rs` and publishes them here. The server
never recomputes the whole catalog (1 CPU, 1.6 GB RAM, ~131k works): it only checks the
works its own hourly refresh adds (`check_new_works`), through an index on a hashed,
normalized title key, a few primary-key probes per work.

Candidates are keyed by stable work identity (provider + providerWorkId, ordered so the
smaller string is `left`, like the PC orders anchors). Review decisions are server-owned
so the PC and mobile share them; mobile reads the precomputed list, the PC consumes the
decision feed and applies it. Nothing is hidden or merged by the server itself.

Routes (all JSON, `{"code","message"}` errors with Korean messages):

* ``PUT  /v1/mobile-catalog/duplicates/candidates`` (publisher) - upsert one chunk of the
  PC's candidate set, tagged with a `generation`; the chunk with ``final: true`` retires
  every PC candidate of an older generation (and, with ``includesServerWorks``, the
  server-found ones the PC's comparison now covers). Idempotent by `operationId`.
* ``GET  /v1/mobile-catalog/duplicates`` (client) - the review list, newest first,
  undecided by default (``state=undecided|decided|all``), keyset pages, ETag.
* ``GET  /v1/mobile-catalog/duplicates/changes`` (client) - candidate change feed:
  every insert, content change, retirement and decision bumps the row to a new, unique
  revision; ``after`` is exclusive; bounded pages; ETag.
* ``POST /v1/mobile-catalog/duplicates/decisions`` (client) - record keep both / hide one
  edition / not duplicate / cleared against the pair's `expectedRevision` (409 on
  conflict). Idempotent by `operationId`.
* ``GET  /v1/mobile-catalog/duplicates/decisions`` (publisher) - the decision log the PC
  consumes, ``after`` exclusive, bounded pages, ETag.

Rule port notes (differences from catalog_review.rs) are in `match_works`.
"""
import base64
import functools
import hashlib
import json
import logging
import sqlite3
import threading
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import UUID

from fastapi import Header, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError
from starlette.concurrency import run_in_threadpool

import conditional
from app_lifecycle import lifecycle

PREFIX = "/v1/mobile-catalog/duplicates"
PROVIDER = "kHentai"
ALGORITHM = "translated-title-multisignal-canary-v2"  # catalog_review.rs ALGORITHM
MAX_CURSOR = 9_007_199_254_740_991
MAX_BODY_BYTES = 8 * 1024 * 1024
MAX_ITEMS = 5_000
MAX_COMMAND_BYTES = 4096
MAX_NEW_WORKS = 5_000        # one refresh publishes at most 40 pages x 50 works
MAX_SERVER_CANDIDATES = 500  # per check_new_works call
RECEIPTS_RETAINED = 1_000
BUCKET = 8                   # catalog_review.rs BUCKET: larger title buckets are skipped
TAGS = 64                    # catalog_review.rs TAGS: more tags = incomplete evidence
MIN_TITLE = 8                # catalog_review.rs: titles shorter than 8 chars never match
LOG = logging.getLogger(__name__)
# Serializes index writers in this process (refresh check vs. post-publication rebuild), so a
# rebuild's DELETE never drops rows a concurrent check just indexed. Reentrant: the check
# builds the index lazily through rebuild_title_index.
_INDEX_LOCK = threading.RLock()


def _index_writer(function):
    @functools.wraps(function)
    def locked(*args, **kwargs):
        with _INDEX_LOCK:
            return function(*args, **kwargs)
    return locked

WorkId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
Provider = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,32}$")]
Token = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._:+-]{1,128}$")]
CandidateId = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{32}$")]
Text = Annotated[str, StringConstraints(max_length=8192)]
TagText = Annotated[str, StringConstraints(min_length=1, max_length=520)]
Reason = Literal["exactTitle", "koreanAlternateTitle"]
Decision = Literal["keepBoth", "hideEdition", "notDuplicate", "cleared"]

DDL = """
CREATE TABLE IF NOT EXISTS catalog_duplicate_state(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
 decision_sequence INTEGER NOT NULL, pc_generation TEXT, pc_published_at TEXT,
 index_digest TEXT, index_built_at TEXT, index_rows INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO catalog_duplicate_state VALUES(1,0,0,NULL,NULL,NULL,NULL,0);
CREATE TABLE IF NOT EXISTS catalog_duplicate_candidates(
 id INTEGER PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE, provider TEXT NOT NULL,
 left_work_id TEXT NOT NULL, right_work_id TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('pc','server')), generation TEXT,
 reason TEXT NOT NULL, page_gap INTEGER NOT NULL, algorithm TEXT NOT NULL, evidence TEXT NOT NULL,
 removed INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL UNIQUE,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(provider,left_work_id,right_work_id));
CREATE TABLE IF NOT EXISTS catalog_duplicate_decisions(
 provider TEXT NOT NULL, left_work_id TEXT NOT NULL, right_work_id TEXT NOT NULL,
 decision TEXT, hidden_work_id TEXT, revision INTEGER NOT NULL, sequence INTEGER NOT NULL,
 updated_at TEXT NOT NULL, PRIMARY KEY(provider,left_work_id,right_work_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS catalog_duplicate_decision_log(
 sequence INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, payload_digest TEXT NOT NULL,
 candidate_id TEXT NOT NULL, provider TEXT NOT NULL, left_work_id TEXT NOT NULL,
 right_work_id TEXT NOT NULL, decision TEXT NOT NULL, hidden_work_id TEXT,
 revision INTEGER NOT NULL, created_at TEXT NOT NULL, result_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_duplicate_publish_receipts(
 operation_id TEXT PRIMARY KEY, payload_digest TEXT NOT NULL, result_json TEXT NOT NULL,
 created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS catalog_duplicate_title_index(
 key_hash INTEGER NOT NULL, work_id INTEGER NOT NULL, PRIMARY KEY(key_hash,work_id)) WITHOUT ROWID;
"""

# Every statement check_new_works runs per work. Each must be an index/PK SEARCH.
INDEX_LOOKUP_SQL = "SELECT work_id FROM catalog_duplicate_title_index WHERE key_hash=? LIMIT ?"
WORK_SQL = """SELECT w.Id,m.group_id,w.Title,w.TitleJpn,w.FileCount,COALESCE(w.Category,0),w.Expunged
 FROM {s}.Works w JOIN {s}.online_catalog_group_members m ON m.provider=? AND m.catalog_work_id=w.Id
 WHERE w.Id=?"""
TAGS_SQL = """SELECT Namespace,Value FROM {s}.Tags WHERE WorkId=? AND Namespace IN ('artist','group','language')
 ORDER BY Namespace,Value LIMIT ?"""


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def fail(status, code, message):
    raise HTTPException(status, {"code": code, "message": message})


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def startup_db(db):
    db.executescript(DDL)
    db.commit()


# ---------------------------------------------------------------------------------------
# Rule port (catalog_review.rs)

# Rust `char::is_whitespace` (Unicode White_Space). Python's `str.split()` also splits on
# U+001C..U+001F, which Rust does not, so the set is spelled out.
_WHITESPACE = frozenset("\t\n\x0b\x0c\r \x85\xa0\u1680\u2028\u2029\u202f\u205f\u3000"
                        + "".join(chr(c) for c in range(0x2000, 0x200B)))


def normalize(value):
    """`normalize`: collapse whitespace runs to one space, trim, lowercase. Punctuation,
    numbers and edition qualifiers are kept as identity evidence."""
    spaced = "".join(" " if ch in _WHITESPACE else ch for ch in value or "")
    return " ".join(part for part in spaced.split(" ") if part).lower()


def _hangul(text):
    return any("\uac00" <= ch <= "\ud7a3" for ch in text)


def review_title(value):
    """`review_title`: drop only a clearly delimited Korean alternate title
    (`original | 한국어 제목 (qualifiers)`), keeping bracketed qualifiers after it."""
    normalized = normalize(value)
    original, separator, alternate = normalized.partition(" | ")
    if not separator:
        return normalized
    marks = [i for i in (alternate.find("("), alternate.find("[")) if i >= 0]
    suffix = min(marks) if marks else len(alternate)
    translation = alternate[:suffix].strip(" ")
    if len(original) < MIN_TITLE or "|" in translation or not _hangul(translation):
        return normalized
    return normalize(f"{original} {alternate[suffix:]}")


def title_keys(title, title_jpn):
    """The bucket keys the PC's `generate` puts a work in (both titles, >= 8 chars)."""
    return sorted({key for key in (review_title(title), review_title(title_jpn or ""))
                   if len(key) >= MIN_TITLE})


def key_hash(key):
    return int.from_bytes(hashlib.sha256(key.encode("utf-8")).digest()[:8], "big", signed=True)


def exact_title_match(a, b):
    lefts = [normalize(a["title"]), normalize(a["titleJpn"] or "")]
    rights = {normalize(b["title"]), normalize(b["titleJpn"] or "")}
    return any(len(left) >= MIN_TITLE and left in rights for left in lefts)


def match_works(a, b):
    """``(reason, page_gap)`` when two works are a duplicate-edition candidate, else None.

    Same checks, in the same sense, as the pair loop of `generate` in catalog_review.rs:
    distinct groups, positive page counts, equal pages (or, only for the added-Korean-
    title variant, a gap of at most 2 pages and at most 10% of the smaller count),
    category 1..=11 and equal, non-empty equal language lists, and at least one shared
    `artist:`/`group:` tag. Differences:

    * Rust compares `group_id`s from membership rows; a work known only from a refresh
      payload (not in the artifact yet) has `groupId=None`, which never equals anything.
    * The PC dedups per group-anchor pair and skips group pairs with a negative decision;
      here identity and decisions are per work pair.
    """
    if a["groupId"] is not None and a["groupId"] == b["groupId"]:
        return None
    if a["pages"] <= 0 or b["pages"] <= 0:
        return None
    exact = exact_title_match(a, b)
    gap = abs(a["pages"] - b["pages"])
    pages_match = a["pages"] == b["pages"] or (
        not exact and gap <= 2 and gap <= max(min(a["pages"], b["pages"]), 0) // 10)
    if (not pages_match or not 1 <= a["category"] <= 11 or a["category"] != b["category"]
            or not a["languages"] or a["languages"] != b["languages"]
            or not set(a["creators"]) & set(b["creators"])):
        return None
    return ("exactTitle", 0) if exact else ("koreanAlternateTitle", gap)


def reason_text(reason, page_gap):
    """The PC's Korean evidence sentence for a reason code."""
    if reason == "exactTitle":
        return "제목 일치 · 작가/그룹 중복 · 페이지 수, 분류, 언어 일치"
    return f"덧붙인 한국어 제목 제외 시 제목 일치 · 작가/그룹 중복 · 분류, 언어 일치 · 페이지 수 차이 {page_gap}쪽"


def _evidence(work_id, group_id, title, title_jpn, pages, category, tags):
    """`ReviewWork`. More than TAGS artist/group/language tags = ineligible (no languages)."""
    creators, languages = [], []
    if len(tags) <= TAGS:
        for namespace, value in sorted(tags):
            if not value.strip():
                continue
            if namespace == "language":
                languages.append(value)
            elif namespace in ("artist", "group"):
                creators.append(f"{namespace}:{value}")
    return {"workId": str(work_id), "groupId": group_id, "title": title or "", "titleJpn": title_jpn,
            "pages": int(pages or 0), "category": int(category or 0),
            "creators": creators, "languages": languages}


def candidate_id(provider, left, right):
    return hashlib.sha256(f"{provider}\n{left}\n{right}".encode()).hexdigest()[:32]


# ---------------------------------------------------------------------------------------
# Storage

def _state(db):
    return db.execute("SELECT * FROM catalog_duplicate_state WHERE singleton=1").fetchone()


def status_head(db):
    """Decision-log head for ``/v1/sync/status`` ``publisherLogs.catalogDuplicateDecisions``."""
    return _state(db)["decision_sequence"]


def _bump(db):
    db.execute("UPDATE catalog_duplicate_state SET revision=revision+1 WHERE singleton=1")
    return db.execute("SELECT revision FROM catalog_duplicate_state WHERE singleton=1").fetchone()[0]


def _upsert(db, provider, left, right, source, generation, reason, page_gap, algorithm, evidence, now,
            *, replace_server=True):
    """Insert or update one candidate; returns True when its visible content changed.

    `replace_server=False` (server-found) never overwrites a live PC candidate."""
    row = db.execute("""SELECT source,reason,page_gap,algorithm,evidence,removed FROM catalog_duplicate_candidates
        WHERE provider=? AND left_work_id=? AND right_work_id=?""", (provider, left, right)).fetchone()
    body = encode(evidence)
    if row is None:
        db.execute("""INSERT INTO catalog_duplicate_candidates
            (candidate_id,provider,left_work_id,right_work_id,source,generation,reason,page_gap,algorithm,
             evidence,removed,changed,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?)""",
                   (candidate_id(provider, left, right), provider, left, right, source, generation, reason,
                    page_gap, algorithm, body, _bump(db), now, now))
        return True
    if not replace_server and not row[5]:
        return False
    if tuple(row) == (source, reason, page_gap, algorithm, body, 0):
        db.execute("""UPDATE catalog_duplicate_candidates SET generation=?
            WHERE provider=? AND left_work_id=? AND right_work_id=?""", (generation, provider, left, right))
        return False
    db.execute("""UPDATE catalog_duplicate_candidates SET source=?,generation=?,reason=?,page_gap=?,algorithm=?,
        evidence=?,removed=0,changed=?,updated_at=? WHERE provider=? AND left_work_id=? AND right_work_id=?""",
               (source, generation, reason, page_gap, algorithm, body, _bump(db), now, provider, left, right))
    return True


def _ordered(left, right):
    """Left is the smaller identity (string order, as the PC orders anchors)."""
    return (left, right, False) if left["workId"] < right["workId"] else (right, left, True)


# ---------------------------------------------------------------------------------------
# Normalized-title index and the incremental checker

def _schema(schema):
    if schema not in ("main", "catalog"):
        raise ValueError("schema must be 'main' or 'catalog'")
    return schema


@_index_writer
def rebuild_title_index(db, catalog_conn, *, schema="catalog", digest=None):
    """Rebuild the hashed title-key index from a catalog artifact. One streamed pass.

    O(works), ~1-2 s for 131k works: call it after a PC publication (off the request
    path), not per refresh. `check_new_works` keeps it current for server additions and
    builds it lazily once when it was never built. A stale entry is harmless (the work
    is re-read and re-verified from the artifact); a missing one only loses a server-side
    candidate the PC's own full comparison still covers.
    """
    s = _schema(schema)
    startup_db(db)
    entries = []
    cursor = catalog_conn.execute(f"SELECT Id,Title,TitleJpn FROM {s}.Works WHERE Expunged=0")
    while True:
        rows = cursor.fetchmany(5000)
        if not rows:
            break
        for work_id, title, title_jpn in rows:
            entries.extend((key_hash(key), work_id) for key in title_keys(title, title_jpn))
    entries.sort()
    db.execute("BEGIN IMMEDIATE")
    try:
        db.execute("DELETE FROM catalog_duplicate_title_index")
        db.executemany("INSERT OR IGNORE INTO catalog_duplicate_title_index VALUES(?,?)", entries)
        db.execute("UPDATE catalog_duplicate_state SET index_digest=?,index_built_at=?,index_rows=? WHERE singleton=1",
                   (digest, now_iso(), len(entries)))
        db.commit()
    except BaseException:
        db.rollback()
        raise
    return len(entries)


@_index_writer
def check_new_works(db, catalog_conn, works, *, schema="catalog", provider=PROVIDER, digest=None):
    """Find duplicate-edition candidates for works the server itself just added.

    `db` is the control database (no open transaction). `catalog_conn` reads the current
    catalog artifact (as `open_publication` yields it: tables under `catalog.`; pass
    `schema="main"` for a directly opened artifact). `works` are refresh rows
    (``{"work": {...}, "tags": [[ns, value], ...]}``) or plain work ids. Each work's
    evidence is read from the artifact by primary key, falling back to its payload.

    Never scans the catalog: per work it probes the title index for at most two keys
    (BUCKET+1 rows each), then reads each hit's Works/membership/Tags rows by key.
    Returns counters, including `rowsRead` (index + artifact rows fetched).
    """
    s = _schema(schema)
    works = list(works)
    if len(works) > MAX_NEW_WORKS:
        raise ValueError("Too many new works for one duplicate check")
    startup_db(db)
    stats = {"checked": 0, "lookups": 0, "rowsRead": 0, "skippedBuckets": 0,
             "candidates": 0, "indexBuilt": False}
    if db.execute("SELECT index_built_at FROM catalog_duplicate_state WHERE singleton=1").fetchone()[0] is None:
        rebuild_title_index(db, catalog_conn, schema=s, digest=digest)
        stats["indexBuilt"] = True
    cache = {}

    def load(work_id, payload=None):
        if work_id in cache:
            return cache[work_id]
        row = catalog_conn.execute(WORK_SQL.format(s=s), (provider, work_id)).fetchone()
        stats["rowsRead"] += 1
        value = None
        if row is not None:
            if not row[6]:
                tags = catalog_conn.execute(TAGS_SQL.format(s=s), (work_id, TAGS + 1)).fetchall()
                stats["rowsRead"] += len(tags)
                value = _evidence(row[0], row[1], row[2], row[3], row[4], row[5], [tuple(t) for t in tags])
        elif payload is not None:
            work = payload["work"]
            if not work.get("Expunged"):
                tags = [tuple(t) for t in payload.get("tags", ()) if t[0] in ("artist", "group", "language")]
                value = _evidence(work["Id"], None, work.get("Title"), work.get("TitleJpn"),
                                  work.get("FileCount"), work.get("Category"), tags)
        cache[work_id] = value
        return value

    new = []
    for item in works:
        payload = item if isinstance(item, dict) else None
        work_id = int(payload["work"]["Id"] if payload else item)
        evidence = load(work_id, payload)
        if evidence is not None:
            new.append((work_id, evidence, title_keys(evidence["title"], evidence["titleJpn"])))
    # Index the new works first so works of the same batch find each other.
    db.execute("BEGIN IMMEDIATE")
    try:
        db.executemany("INSERT OR IGNORE INTO catalog_duplicate_title_index VALUES(?,?)",
                       [(key_hash(key), work_id) for work_id, _, keys in new for key in keys])
        db.commit()
    except BaseException:
        db.rollback()
        raise
    found = {}
    for work_id, a, keys in new:
        stats["checked"] += 1
        for key in keys:
            stats["lookups"] += 1
            ids = [r[0] for r in db.execute(INDEX_LOOKUP_SQL, (key_hash(key), BUCKET + 1))]
            stats["rowsRead"] += len(ids)
            if len(ids) > BUCKET:
                stats["skippedBuckets"] += 1
                continue
            for other in ids:
                if other == work_id:
                    continue
                b = load(other)
                # Hash collisions and stale entries: re-verify the key from real titles.
                if b is None or key not in title_keys(b["title"], b["titleJpn"]):
                    continue
                result = match_works(a, b)
                if result is None:
                    continue
                left, right, _ = _ordered(a, b)
                found.setdefault((left["workId"], right["workId"]), (left, right, *result))
    now = now_iso()
    db.execute("BEGIN IMMEDIATE")
    try:
        for (left_id, right_id), (left, right, reason, gap) in sorted(found.items()):
            if stats["candidates"] >= MAX_SERVER_CANDIDATES:
                break
            decided = db.execute("""SELECT 1 FROM catalog_duplicate_decisions WHERE provider=? AND left_work_id=?
                AND right_work_id=? AND decision IS NOT NULL""", (provider, left_id, right_id)).fetchone()
            if decided:
                continue
            if _upsert(db, provider, left_id, right_id, "server", None, reason, gap, ALGORITHM,
                       {"left": left, "right": right}, now, replace_server=False):
                stats["candidates"] += 1
        if digest is not None:
            db.execute("UPDATE catalog_duplicate_state SET index_digest=? WHERE singleton=1", (digest,))
        db.commit()
    except BaseException:
        db.rollback()
        raise
    return stats


class TitleIndexRebuilder:
    """Rebuild the title index after a PC catalog publication, off the request path.

    `trigger` costs one primary-key read of the state row. It starts a background pass
    only when the index was built before (otherwise the next refresh check builds it
    lazily) and was built from different content than the current publication. Triggers
    that arrive during a pass coalesce into at most one more pass; one thread at a time.
    """

    def __init__(self, root, get_db):
        self.root, self.get_db = root, get_db
        self._lock = threading.Lock()
        self._pending = self._running = False
        self.thread = None

    def _stale(self):
        """Current content digest when the index needs a rebuild, else None."""
        import mobile_catalog_replica as replica
        with self.get_db() as db:
            try:
                row = db.execute("SELECT index_digest,index_built_at FROM catalog_duplicate_state"
                                 " WHERE singleton=1").fetchone()
            except sqlite3.OperationalError:
                return None  # tables not created yet: nothing was ever indexed
            current = replica.current(db)
        if row is None or row[1] is None or current is None or row[0] == current["content_digest"]:
            return None
        return current["content_digest"]

    def trigger(self):
        try:
            if self._stale() is None:
                return False
        except Exception:
            LOG.error("Catalog duplicate index check failed")
            return False
        with self._lock:
            self._pending = True
            if self._running:
                return True
            self._running = True
        self.thread = threading.Thread(target=self._run, name="catalog-duplicate-index", daemon=True)
        self.thread.start()
        return True

    def _run(self):
        while True:
            with self._lock:
                if not self._pending:
                    self._running = False
                    return
                self._pending = False
            try:
                self.rebuild_once()
            except Exception:
                LOG.error("Catalog duplicate title index rebuild failed; the previous index is kept")

    def rebuild_once(self):
        """Rebuild from the current publication (read-only; no catalog lock needed)."""
        import mobile_catalog_replica as replica
        if self._stale() is None:
            return None
        with replica.open_publication(self.root(), self.get_db) as (catalog, publication):
            with self.get_db() as db:
                return rebuild_title_index(db, catalog, digest=publication["content_digest"])


# ---------------------------------------------------------------------------------------
# Wire models

class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class EvidenceWork(Strict):
    workId: WorkId
    groupId: Token | None = None
    title: Text
    titleJpn: Text | None = None
    pages: int = Field(ge=0, le=1_000_000)
    category: int = Field(ge=0, le=1_000_000)
    creators: list[TagText] = Field(max_length=TAGS)
    languages: list[TagText] = Field(max_length=TAGS)


class Candidate(Strict):
    provider: Provider
    reason: Reason
    pageGap: int = Field(ge=0, le=2)
    algorithm: Token
    left: EvidenceWork
    right: EvidenceWork


class Publication(Strict):
    version: Literal[1]
    operationId: Annotated[str, StringConstraints(min_length=36, max_length=36)]
    generation: Token
    final: bool
    includesServerWorks: bool = False
    items: list[Candidate] = Field(max_length=MAX_ITEMS)


class Command(Strict):
    version: Literal[1]
    operationId: Annotated[str, StringConstraints(min_length=36, max_length=36)]
    candidateId: CandidateId
    decision: Decision
    hiddenWorkId: WorkId | None = None
    expectedRevision: int = Field(ge=0, le=MAX_CURSOR)


def _uuid(value, code, message):
    try:
        if str(UUID(value)) != value:
            raise ValueError()
    except ValueError:
        fail(422, code, message)


async def _bounded(request, limit, message):
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        raise HTTPException(413, message)
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > limit:
            raise HTTPException(413, message)
    return bytes(raw)


def _item(row):
    evidence = json.loads(row["evidence"])
    return {"candidateId": row["candidate_id"], "provider": row["provider"],
            "leftWorkId": row["left_work_id"], "rightWorkId": row["right_work_id"],
            "source": row["source"], "reason": row["reason"], "pageGap": row["page_gap"],
            "reasonText": reason_text(row["reason"], row["page_gap"]), "algorithm": row["algorithm"],
            "left": evidence["left"], "right": evidence["right"], "removed": bool(row["removed"]),
            "revision": row["changed"],
            "decision": None if row["decision"] is None else {
                "decision": row["decision"], "hiddenWorkId": row["hidden_work_id"]},
            "decisionRevision": row["decision_revision"] or 0}


JOINED = """SELECT c.*,d.decision,d.hidden_work_id,d.revision AS decision_revision
 FROM catalog_duplicate_candidates c LEFT JOIN catalog_duplicate_decisions d
 ON d.provider=c.provider AND d.left_work_id=c.left_work_id AND d.right_work_id=c.right_work_id"""


def _encode_cursor(value):
    return base64.urlsafe_b64encode(str(value).encode()).decode().rstrip("=")


def _decode_cursor(cursor):
    try:
        value = int(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode())
    except (ValueError, UnicodeDecodeError):
        fail(400, "invalidDuplicateCursor", "검토 목록 위치를 확인할 수 없습니다.")
    if not 0 < value <= MAX_CURSOR:
        fail(400, "invalidDuplicateCursor", "검토 목록 위치를 확인할 수 없습니다.")
    return value


def register(app, get_db, require_client, require_publisher):
    """Install the routes; returns the startup hook (creates empty tables only)."""

    def startup():
        with get_db() as db:
            startup_db(db)

    lifecycle(app).on_startup(startup)

    def invalid_publication():
        fail(422, "invalidDuplicateCandidates", "중복 판본 후보 목록을 확인할 수 없습니다.")

    def publish(body, publication):
        _uuid(publication.operationId, "invalidDuplicateCandidates", "게시 요청 식별자가 올바르지 않습니다.")
        prepared = {}
        for item in publication.items:
            if item.left.workId == item.right.workId:
                invalid_publication()
            left, right, _ = _ordered(item.left.model_dump(), item.right.model_dump())
            key = (item.provider, left["workId"], right["workId"])
            if key in prepared:
                invalid_publication()
            prepared[key] = (item, left, right)
        digest = hashlib.sha256(body).hexdigest()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            receipt = db.execute("SELECT * FROM catalog_duplicate_publish_receipts WHERE operation_id=?",
                                 (publication.operationId,)).fetchone()
            if receipt is not None:
                if receipt["payload_digest"] != digest:
                    fail(409, "operationConflict", "다른 내용으로 게시 요청을 재사용할 수 없습니다.")
                return json.loads(receipt["result_json"])
            now = now_iso()
            changed = 0
            for (provider, left_id, right_id), (item, left, right) in sorted(prepared.items()):
                changed += _upsert(db, provider, left_id, right_id, "pc", publication.generation, item.reason,
                                   item.pageGap, item.algorithm, {"left": left, "right": right}, now)
            retired = 0
            if publication.final:
                sources = ("pc", "server") if publication.includesServerWorks else ("pc",)
                stale = db.execute(f"""SELECT provider,left_work_id,right_work_id FROM catalog_duplicate_candidates
                    WHERE removed=0 AND source IN ({','.join('?' * len(sources))})
                    AND (generation IS NULL OR generation!=?)""", (*sources, publication.generation)).fetchall()
                for row in stale:
                    db.execute("""UPDATE catalog_duplicate_candidates SET removed=1,changed=?,updated_at=?
                        WHERE provider=? AND left_work_id=? AND right_work_id=?""", (_bump(db), now, *row))
                retired = len(stale)
                db.execute("UPDATE catalog_duplicate_state SET pc_generation=?,pc_published_at=? WHERE singleton=1",
                           (publication.generation, now))
            result = {"version": 1, "operationId": publication.operationId, "generation": publication.generation,
                      "final": publication.final, "items": len(prepared), "changed": changed, "retired": retired,
                      "revision": _state(db)["revision"]}
            db.execute("INSERT INTO catalog_duplicate_publish_receipts VALUES(?,?,?,?)",
                       (publication.operationId, digest, json.dumps(result), now))
            db.execute("""DELETE FROM catalog_duplicate_publish_receipts WHERE operation_id NOT IN
                (SELECT operation_id FROM catalog_duplicate_publish_receipts ORDER BY created_at DESC LIMIT ?)""",
                       (RECEIPTS_RETAINED,))
            db.commit()
            return result

    @app.put(PREFIX + "/candidates")
    async def put_candidates(request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        body = await _bounded(request, MAX_BODY_BYTES, "Duplicate candidate publication too large")
        try:
            publication = Publication.model_validate_json(body)
        except (ValidationError, ValueError):
            invalid_publication()
        return await run_in_threadpool(publish, body, publication)

    @app.get(PREFIX)
    def review(request: Request, state: Literal["undecided", "decided", "all"] = Query(default="undecided"),
               limit: int = Query(default=30, ge=1, le=100),
               cursor: str | None = Query(default=None, max_length=64),
               authorization: str | None = Header(default=None),
               if_none_match: str | None = Header(default=None)):
        require_client(authorization)
        if set(request.query_params.keys()) - {"state", "limit", "cursor"}:
            fail(422, "invalidDuplicateRequest", "검토 목록 요청을 확인할 수 없습니다.")
        before = _decode_cursor(cursor) if cursor is not None else MAX_CURSOR + 1
        filters = {"undecided": " AND d.decision IS NULL", "decided": " AND d.decision IS NOT NULL", "all": ""}[state]
        with get_db() as db:
            db.execute("BEGIN")
            current = _state(db)
            rows = db.execute(f"{JOINED} WHERE c.removed=0{filters} AND c.id<? ORDER BY c.id DESC LIMIT ?",
                              (before, limit + 1)).fetchall()
            counts = db.execute(f"""SELECT COALESCE(SUM(decision IS NULL),0),COALESCE(SUM(decision IS NOT NULL),0)
                FROM ({JOINED} WHERE c.removed=0)""").fetchone()
        more = len(rows) > limit
        rows = rows[:limit]
        return conditional.json_response({
            "version": 1, "revision": current["revision"], "pcGeneration": current["pc_generation"],
            "counts": {"undecided": counts[0], "decided": counts[1]},
            "items": [_item(r) for r in rows],
            "nextCursor": _encode_cursor(rows[-1]["id"]) if more else None, "hasMore": more}, if_none_match)

    @app.get(PREFIX + "/changes")
    def changes(after: int = Query(default=0, ge=0, le=MAX_CURSOR), limit: int = Query(default=100, ge=1, le=200),
                authorization: str | None = Header(default=None),
                if_none_match: str | None = Header(default=None)):
        require_client(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            revision = _state(db)["revision"]
            if after > revision:
                fail(409, "duplicateCursorRejected", "중복 판본 동기화 위치를 확인해 주세요.")
            rows = db.execute(f"{JOINED} WHERE c.changed>? ORDER BY c.changed LIMIT ?", (after, limit + 1)).fetchall()
        more = len(rows) > limit
        rows = rows[:limit]
        return conditional.json_response({
            "version": 1, "after": after, "revision": revision,
            "nextCursor": rows[-1]["changed"] if rows else after, "hasMore": more,
            "items": [_item(r) for r in rows]}, if_none_match)

    def apply(body, command):
        _uuid(command.operationId, "invalidDuplicateDecision", "검토 요청 식별자가 올바르지 않습니다.")
        digest = hashlib.sha256(encode(command.model_dump()).encode()).hexdigest()
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            receipt = db.execute("SELECT * FROM catalog_duplicate_decision_log WHERE operation_id=?",
                                 (command.operationId,)).fetchone()
            if receipt is not None:
                if receipt["payload_digest"] != digest:
                    fail(409, "operationConflict", "다른 내용으로 검토 요청을 재사용할 수 없습니다.")
                return json.loads(receipt["result_json"])
            row = db.execute(f"{JOINED} WHERE c.candidate_id=?", (command.candidateId,)).fetchone()
            if row is None or row["removed"]:
                fail(409, "duplicateCandidateMissing", "PC에서 이미 정리되었거나 사라진 후보입니다.")
            pair = (row["provider"], row["left_work_id"], row["right_work_id"])
            if (command.decision == "hideEdition") != (command.hiddenWorkId is not None) or (
                    command.hiddenWorkId is not None and command.hiddenWorkId not in pair[1:]):
                fail(422, "invalidDuplicateDecision", "숨길 판본을 후보 중에서 선택해 주세요.")
            current = row["decision_revision"] or 0
            if command.expectedRevision != current:
                fail(409, "duplicateDecisionConflict", "다른 기기에서 먼저 검토했습니다. 새로고침해 주세요.")
            if command.decision == "cleared" and row["decision"] is None:
                fail(409, "duplicateDecisionConflict", "취소할 검토 결정이 없습니다.")
            state = _state(db)
            sequence = state["decision_sequence"] + 1
            revision = current + 1
            decision = None if command.decision == "cleared" else command.decision
            now = now_iso()
            db.execute("""INSERT INTO catalog_duplicate_decisions VALUES(?,?,?,?,?,?,?,?)
                ON CONFLICT(provider,left_work_id,right_work_id) DO UPDATE SET decision=excluded.decision,
                hidden_work_id=excluded.hidden_work_id,revision=excluded.revision,sequence=excluded.sequence,
                updated_at=excluded.updated_at""", (*pair, decision, command.hiddenWorkId, revision, sequence, now))
            db.execute("UPDATE catalog_duplicate_state SET decision_sequence=? WHERE singleton=1", (sequence,))
            db.execute("UPDATE catalog_duplicate_candidates SET changed=?,updated_at=? WHERE candidate_id=?",
                       (_bump(db), now, command.candidateId))
            result = {"version": 1, "operationId": command.operationId, "candidateId": command.candidateId,
                      "provider": pair[0], "leftWorkId": pair[1], "rightWorkId": pair[2],
                      "decision": command.decision, "hiddenWorkId": command.hiddenWorkId,
                      "revision": revision, "sequence": sequence}
            db.execute("INSERT INTO catalog_duplicate_decision_log VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                       (sequence, command.operationId, digest, command.candidateId, *pair, command.decision,
                        command.hiddenWorkId, revision, now, json.dumps(result)))
            db.commit()
            return result

    @app.post(PREFIX + "/decisions")
    async def decide(request: Request, authorization: str | None = Header(default=None)):
        require_client(authorization)
        body = await _bounded(request, MAX_COMMAND_BYTES, "Duplicate decision too large")
        try:
            command = Command.model_validate_json(body)
        except (ValidationError, ValueError):
            fail(422, "invalidDuplicateDecision", "검토 요청을 확인할 수 없습니다.")
        return await run_in_threadpool(apply, body, command)

    @app.get(PREFIX + "/decisions")
    def decisions(after: int = Query(default=0, ge=0, le=MAX_CURSOR), limit: int = Query(default=100, ge=1, le=200),
                  authorization: str | None = Header(default=None),
                  if_none_match: str | None = Header(default=None)):
        require_publisher(authorization)
        with get_db() as db:
            db.execute("BEGIN")
            last = _state(db)["decision_sequence"]
            if after > last:
                fail(409, "duplicateCursorRejected", "중복 판본 동기화 위치를 확인해 주세요.")
            rows = db.execute("SELECT * FROM catalog_duplicate_decision_log WHERE sequence>? ORDER BY sequence LIMIT ?",
                              (after, limit + 1)).fetchall()
        more = len(rows) > limit
        rows = rows[:limit]
        return conditional.json_response({
            "version": 1, "after": after, "lastSequence": last,
            "nextCursor": rows[-1]["sequence"] if rows else after, "hasMore": more,
            "items": [{"sequence": r["sequence"], "operationId": r["operation_id"], "candidateId": r["candidate_id"],
                       "provider": r["provider"], "leftWorkId": r["left_work_id"], "rightWorkId": r["right_work_id"],
                       "decision": r["decision"], "hiddenWorkId": r["hidden_work_id"], "revision": r["revision"],
                       "createdAt": r["created_at"]} for r in rows]}, if_none_match)

    return startup
