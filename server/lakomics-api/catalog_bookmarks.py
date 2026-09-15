"""Server-owned catalog bookmark authority.

ADR-0036's first authority domain. B1 shipped the inactive-safe read substrate
(empty control tables, byte-identical reads until an authority row exists). B3
added one-time baseline activation and the publication fence. B4 added the
durable mutation command, the idempotency receipts and the ordered change log
that PC reconciliation consumes. B8.1 adds the retention policy, the expired-cursor
contract and the bounded baseline contract that activation requires.

The domain stays PC-owned (``load`` returns ``None``) until an authority row is
activated; nothing here changes published behavior before that point.
"""
import datetime
import hashlib
import json
import sqlite3

from fastapi import HTTPException

DOMAIN = "catalog-bookmarks"
CONTRACT_VERSION = 1

#: Supported offline/change-replay window. A client whose cursor predates retained
#: history must adopt a fresh baseline instead of replaying changes.
RETENTION_DAYS = 180
#: Receipts are kept at least as long as the change history, so a retry inside the
#: supported window always resolves through its recorded result instead of being
#: re-applied as a new logical mutation.
RECEIPT_RETENTION_DAYS = 180

#: Maximum encoded size of a bookmark baseline response. The authoritative bound is
#: bytes, not rows: work ids and timestamps are variable-length. This stays below
#: the 4 MiB native Android JSON response boundary (``CloudClient`` reads at most
#: 4 MiB) with margin for the surrounding envelope.
MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024
#: Secondary guard so a pathological row count fails fast before encoding.
MAX_SNAPSHOT_ITEMS = 200_000

DDL = """
CREATE TABLE IF NOT EXISTS authority_domains(
 library_id TEXT NOT NULL,
 domain TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 contract_version INTEGER NOT NULL,
 change_cursor INTEGER NOT NULL,
 baseline_digest TEXT NOT NULL,
 baseline_revision TEXT,
 activated_at TEXT NOT NULL,
 PRIMARY KEY(library_id,domain));
CREATE TABLE IF NOT EXISTS catalog_bookmark_state(
 library_id TEXT NOT NULL,
 provider TEXT NOT NULL,
 work_id TEXT NOT NULL,
 desired_state INTEGER NOT NULL CHECK(desired_state IN (0,1)),
 entity_revision INTEGER NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(library_id,provider,work_id));
CREATE INDEX IF NOT EXISTS catalog_bookmark_state_live
 ON catalog_bookmark_state(library_id,desired_state,work_id);
CREATE TABLE IF NOT EXISTS catalog_bookmark_receipts(
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 operation_id TEXT NOT NULL,
 payload_digest TEXT NOT NULL,
 provider TEXT NOT NULL,
 work_id TEXT NOT NULL,
 desired_state INTEGER NOT NULL CHECK(desired_state IN (0,1)),
 expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
 result_payload TEXT NOT NULL,
 accepted_at TEXT NOT NULL,
 PRIMARY KEY(library_id,epoch,operation_id));
CREATE TABLE IF NOT EXISTS catalog_bookmark_changes(
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 sequence INTEGER NOT NULL,
 provider TEXT NOT NULL,
 work_id TEXT NOT NULL,
 desired_state INTEGER NOT NULL CHECK(desired_state IN (0,1)),
 entity_revision INTEGER NOT NULL,
 operation_id TEXT NOT NULL,
 created_at TEXT,
 updated_at TEXT NOT NULL,
 changed_at TEXT NOT NULL,
 PRIMARY KEY(library_id,epoch,sequence),
 UNIQUE(library_id,epoch,operation_id));
-- Retention floor. `change_cursor - pruned_through` is exactly the number of
-- retained change sequences, which is what distinguishes an *expired* cursor from
-- a corrupt or ahead-of-server one once rows may have been deleted.
CREATE TABLE IF NOT EXISTS catalog_bookmark_retention(
 library_id TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 pruned_through INTEGER NOT NULL DEFAULT 0 CHECK(pruned_through >= 0),
 pruned_at TEXT,
 PRIMARY KEY(library_id,epoch));
-- Bounded pruning: both tables are scanned by age, so the cutoff needs its own
-- index rather than a full scan of the ever-growing history.
CREATE INDEX IF NOT EXISTS catalog_bookmark_changes_prune
 ON catalog_bookmark_changes(library_id,epoch,changed_at);
CREATE INDEX IF NOT EXISTS catalog_bookmark_receipts_prune
 ON catalog_bookmark_receipts(library_id,epoch,accepted_at);
"""

PROVIDERS = ("kHentai", "heliotrope")
MAX_WORK_ID = 65536


def startup(get_db):
    with get_db() as db:
        db.executescript(DDL)
        db.commit()


def load(get_db):
    """One coherent authority snapshot, or None while the domain is PC-owned.

    The authority row and its bookmark rows come from a single short read
    transaction so epoch/cursor and rows cannot be observed from two different
    revisions. The transaction and connection are released before the catalog
    query runs, so a response never holds a control-database read lock.
    """
    with get_db() as db:
        db.execute("BEGIN")
        try:
            rows = db.execute(
                "SELECT library_id,epoch,contract_version,change_cursor FROM authority_domains WHERE domain=?",
                [DOMAIN]).fetchall()
            if not rows:
                return None
            if len(rows) > 1:
                # One active server-bound library is the supported product scope.
                # Never pick a row arbitrarily.
                raise HTTPException(503, "Catalog bookmark authority is ambiguous")
            row = rows[0]
            library_id, epoch, contract_version, cursor = row[0], row[1], row[2], row[3]
            if contract_version != CONTRACT_VERSION:
                # B1 understands exactly one contract. Never interpret the bookmark
                # state of a version this build cannot reason about.
                raise HTTPException(503, "Catalog bookmark authority contract is unsupported")
            bookmarks = [(item[0], item[1], item[2]) for item in db.execute(
                "SELECT provider,work_id,created_at FROM catalog_bookmark_state"
                " WHERE library_id=? AND desired_state=1 ORDER BY provider,work_id",
                [library_id])]
        finally:
            db.rollback()
    return {"libraryId": library_id, "epoch": epoch, "contractVersion": contract_version,
            "cursor": cursor, "bookmarks": bookmarks}


def shadow_ddl(table):
    return f"""CREATE TEMP TABLE {table}(
 provider TEXT NOT NULL, work_id TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(provider,work_id)) WITHOUT ROWID"""


def snapshot_from(connection):
    """Coherent authority snapshot from an already-open connection.

    Used inside the publication commit transaction: it must not open another
    connection or issue a nested BEGIN, because that would read a different
    revision than the transaction about to commit.
    """
    rows = connection.execute(
        "SELECT library_id,epoch,contract_version,change_cursor FROM authority_domains WHERE domain=?",
        [DOMAIN]).fetchall()
    if len(rows) > 1:
        raise HTTPException(503, "Catalog bookmark authority is ambiguous")
    if not rows:
        return None
    row = rows[0]
    if row[2] != CONTRACT_VERSION:
        raise HTTPException(503, "Catalog bookmark authority contract is unsupported")
    bookmarks = [(item[0], item[1], item[2]) for item in connection.execute(
        "SELECT provider,work_id,created_at FROM catalog_bookmark_state"
        " WHERE library_id=? AND desired_state=1 ORDER BY provider,work_id",
        [row[0]])]
    return {"libraryId": row[0], "epoch": row[1], "contractVersion": row[2],
            "cursor": row[3], "bookmarks": bookmarks}


def signature(snapshot):
    """Identity of the authority state a publication derivation was based on."""
    if snapshot is None:
        return (False, None, None, None, None)
    return (True, snapshot["libraryId"], snapshot["epoch"], snapshot["contractVersion"], snapshot["cursor"])


def authority_row(db, library_id=None):
    """The singleton active authority row for this domain, or None."""
    query = "SELECT library_id,epoch,contract_version,change_cursor,baseline_digest,baseline_revision,activated_at FROM authority_domains WHERE domain=?"
    params = [DOMAIN]
    if library_id is not None:
        query += " AND library_id=?"
        params.append(library_id)
    return db.execute(query, params).fetchall()


def public_state(row, bookmarks):
    return {"libraryId": row["library_id"], "epoch": row["epoch"],
            "contractVersion": row["contract_version"], "cursor": row["change_cursor"],
            "baselineDigest": row["baseline_digest"], "baselineRevision": row["baseline_revision"],
            "activatedAt": row["activated_at"], "bookmarkCount": len(bookmarks)}


def activate(db, *, library_id, expected_revision, bookmarks, baseline_digest, current_revision, now):
    """One-time activation inside the caller's BEGIN IMMEDIATE transaction.

    Returns the authority state. Idempotent only for an identical retry; any
    other attempt against an existing authority is rejected.
    """
    existing = authority_row(db)
    if len(existing) > 1:
        raise HTTPException(503, "Catalog bookmark authority is ambiguous")
    if existing:
        row = existing[0]
        if (row["library_id"] == library_id and row["baseline_revision"] == current_revision
                and row["baseline_digest"] == baseline_digest):
            return public_state(row, bookmarks)
        raise HTTPException(409, "Catalog bookmark authority is already active")
    # Refuse to activate an authority whose *required recovery baseline* a client
    # could not consume. Checking here (not only on read) is what stops growth from
    # silently making the advertised authority unrecoverable: once activated, a
    # fresh-baseline recovery is mandatory, so the bound must hold from the start.
    prospective = [{"provider": provider, "workId": work_id, "desiredState": True,
                    "entityRevision": 1, "createdAt": created, "updatedAt": now}
                   for provider, work_id, created in bookmarks]
    encode_snapshot(library_id, 1, CONTRACT_VERSION, 0, prospective)
    db.execute(
        "INSERT INTO authority_domains(library_id,domain,epoch,contract_version,change_cursor,baseline_digest,baseline_revision,activated_at)"
        " VALUES(?,?,?,?,?,?,?,?)",
        [library_id, DOMAIN, 1, CONTRACT_VERSION, 0, baseline_digest, current_revision, now])
    db.executemany(
        "INSERT INTO catalog_bookmark_state(library_id,provider,work_id,desired_state,entity_revision,created_at,updated_at)"
        " VALUES(?,?,?,?,?,?,?)",
        [[library_id, provider, work_id, 1, 1, created, now] for provider, work_id, created in bookmarks])
    # Retention floor starts at zero: nothing has been pruned yet.
    db.execute(
        "INSERT INTO catalog_bookmark_retention(library_id,epoch,pruned_through,pruned_at)"
        " VALUES(?,?,0,NULL) ON CONFLICT(library_id,epoch) DO NOTHING",
        [library_id, 1])
    row = authority_row(db)[0]
    return public_state(row, bookmarks)


def payload_digest(library_id, epoch, contract_version, provider, work_id, desired_state, expected_revision):
    """Canonical command identity digest. The operation id is deliberately excluded."""
    return hashlib.sha256(json.dumps(
        [library_id, epoch, contract_version, provider, work_id, bool(desired_state), expected_revision],
        separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def public_result(row, *, changed, sequence, cursor, provider, work_id, desired_state,
                  entity_revision, created_at, updated_at):
    return {"libraryId": row["library_id"], "epoch": row["epoch"],
            "contractVersion": row["contract_version"], "provider": provider, "workId": work_id,
            "desiredState": desired_state, "entityRevision": entity_revision, "changed": changed,
            "changeSequence": sequence, "authorityCursor": cursor,
            "createdAt": created_at, "updatedAt": updated_at}


def conflict(row, current, provider, work_id):
    """409 body carrying the current authoritative entity state and cursor."""
    return HTTPException(409, detail={
        "code": "revisionConflict",
        "authorityCursor": row["change_cursor"],
        "current": {"provider": provider, "workId": work_id,
                    "desiredState": bool(current["desired_state"]) if current else False,
                    "entityRevision": current["entity_revision"] if current else 0,
                    "createdAt": current["created_at"] if current else None,
                    "updatedAt": current["updated_at"] if current else None}})


def apply_command(db, *, library_id, epoch, contract_version, provider, work_id,
                  desired_state, expected_revision, operation_id, now):
    """Execute one desired-state command inside the caller's BEGIN IMMEDIATE.

    The caller owns the transaction. Receipts, entity state, the change log and
    the authority cursor are written together or not at all.
    """
    rows = db.execute(
        "SELECT library_id,epoch,contract_version,change_cursor FROM authority_domains WHERE domain=?",
        [DOMAIN]).fetchall()
    if not rows:
        raise HTTPException(409, "Catalog bookmark authority is not active")
    if len(rows) > 1:
        raise HTTPException(503, "Catalog bookmark authority is ambiguous")
    row = rows[0]
    if row["library_id"] != library_id or row["epoch"] != epoch:
        raise HTTPException(409, "Catalog bookmark authority does not match this library")
    if row["contract_version"] != contract_version or contract_version != CONTRACT_VERSION:
        raise HTTPException(409, "Catalog bookmark authority contract is unsupported")

    digest = payload_digest(library_id, epoch, contract_version, provider, work_id,
                            desired_state, expected_revision)
    receipt = db.execute(
        "SELECT payload_digest,result_payload FROM catalog_bookmark_receipts"
        " WHERE library_id=? AND epoch=? AND operation_id=?",
        [library_id, epoch, operation_id]).fetchone()
    if receipt is not None:
        if receipt["payload_digest"] != digest:
            raise HTTPException(409, "Operation id was already used with a different payload")
        # Recorded result is durable: it never depends on later entity changes.
        return json.loads(receipt["result_payload"])

    current = db.execute(
        "SELECT desired_state,entity_revision,created_at,updated_at FROM catalog_bookmark_state"
        " WHERE library_id=? AND provider=? AND work_id=?",
        [library_id, provider, work_id]).fetchone()
    revision = current["entity_revision"] if current else 0
    if revision != expected_revision:
        raise conflict(row, current, provider, work_id)

    cursor = row["change_cursor"]
    target = bool(desired_state)
    # Conceptual state for a missing row is desired_state=false, revision 0.
    current_state = bool(current["desired_state"]) if current is not None else False
    if current_state == target:
        result = public_result(row, changed=False, sequence=None, cursor=cursor, provider=provider,
                               work_id=work_id, desired_state=target, entity_revision=revision,
                               created_at=current["created_at"] if current else None,
                               updated_at=current["updated_at"] if current else None)
        _record_receipt(db, library_id, epoch, operation_id, digest, provider, work_id,
                        target, expected_revision, result, now)
        return result

    new_revision = revision + 1
    if target:
        # New bookmark, or re-bookmarking a tombstone: acceptance time is the new
        # creation time, matching the PC insert semantics.
        created_at = now
    else:
        # Unbookmark keeps the original creation time and leaves a tombstone.
        created_at = current["created_at"]
    sequence = cursor + 1
    db.execute(
        "INSERT INTO catalog_bookmark_state(library_id,provider,work_id,desired_state,entity_revision,created_at,updated_at)"
        " VALUES(?,?,?,?,?,?,?)"
        " ON CONFLICT(library_id,provider,work_id) DO UPDATE SET"
        " desired_state=excluded.desired_state,entity_revision=excluded.entity_revision,"
        " created_at=excluded.created_at,updated_at=excluded.updated_at",
        [library_id, provider, work_id, int(target), new_revision, created_at, now])
    db.execute("UPDATE authority_domains SET change_cursor=? WHERE library_id=? AND domain=?",
               [sequence, library_id, DOMAIN])
    db.execute(
        "INSERT INTO catalog_bookmark_changes(library_id,epoch,sequence,provider,work_id,desired_state,"
        "entity_revision,operation_id,created_at,updated_at,changed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        [library_id, epoch, sequence, provider, work_id, int(target), new_revision,
         operation_id, created_at, now, now])
    result = public_result({**row, "change_cursor": sequence}, changed=True, sequence=sequence,
                           cursor=sequence, provider=provider, work_id=work_id, desired_state=target,
                           entity_revision=new_revision, created_at=created_at, updated_at=now)
    _record_receipt(db, library_id, epoch, operation_id, digest, provider, work_id,
                    target, expected_revision, result, now)
    return result


def _record_receipt(db, library_id, epoch, operation_id, digest, provider, work_id,
                    desired_state, expected_revision, result, now):
    db.execute(
        "INSERT INTO catalog_bookmark_receipts(library_id,epoch,operation_id,payload_digest,provider,"
        "work_id,desired_state,expected_revision,result_payload,accepted_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [library_id, epoch, operation_id, digest, provider, work_id, int(desired_state),
         expected_revision, json.dumps(result, sort_keys=True, ensure_ascii=False), now])


def _cutoff(days, now=None):
    """UTC cutoff timestamp for a retention window."""
    moment = now or datetime.datetime.now(datetime.timezone.utc)
    return (moment - datetime.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def pruned_through(db, library_id, epoch):
    """Highest change sequence already removed by retention pruning (0 if none)."""
    row = db.execute(
        "SELECT pruned_through FROM catalog_bookmark_retention WHERE library_id=? AND epoch=?",
        [library_id, epoch]).fetchone()
    return row["pruned_through"] if row else 0


def expired_cursor(row):
    """409 body telling a client its cursor predates retained history.

    Explicit and coded, so a client can tell it apart from the other 409s on this
    route (a cursor ahead of the server, a library/epoch mismatch) and from a
    generic transport failure. The recovery is a fresh baseline, never "no changes".
    """
    return HTTPException(409, detail={
        "code": "cursorExpired",
        "authorityCursor": row["change_cursor"],
        "retentionDays": RETENTION_DAYS})


def prune(get_db, days=RETENTION_DAYS, receipt_days=RECEIPT_RETENTION_DAYS, now=None):
    """Delete history older than the retention window. Returns a count summary.

    Bookmark *state* is never pruned: a tombstone must survive its change-log row,
    because "no change row" must never be read as "this bookmark was deleted".
    Only the change log (incremental replay) and operation receipts (idempotent
    retry resolution) are pruned, and only strictly older than the cutoff.
    """
    change_cutoff = _cutoff(days, now)
    receipt_cutoff = _cutoff(receipt_days, now)
    with get_db() as db:
        db.execute("BEGIN IMMEDIATE")
        try:
            # Never move the active cursor. The floor advances only to the highest
            # sequence actually removed, so it can only ever describe real gaps.
            floored = db.execute(
                "SELECT library_id,epoch,MAX(sequence) FROM catalog_bookmark_changes"
                " WHERE changed_at < ? GROUP BY library_id,epoch", [change_cutoff]).fetchall()
            removed = db.execute(
                "DELETE FROM catalog_bookmark_changes WHERE changed_at < ?", [change_cutoff]).rowcount
            receipts = db.execute(
                "DELETE FROM catalog_bookmark_receipts WHERE accepted_at < ?", [receipt_cutoff]).rowcount
            stamp = (now or datetime.datetime.now(datetime.timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
            for library_id, epoch, highest in floored:
                db.execute(
                    "INSERT INTO catalog_bookmark_retention(library_id,epoch,pruned_through,pruned_at)"
                    " VALUES(?,?,?,?)"
                    " ON CONFLICT(library_id,epoch) DO UPDATE SET"
                    " pruned_through=MAX(pruned_through,excluded.pruned_through), pruned_at=excluded.pruned_at",
                    [library_id, epoch, highest, stamp])
            db.commit()
        except BaseException:
            db.rollback()
            raise
    return {"changes": removed, "receipts": receipts}


def encode_snapshot(library_id, epoch, contract_version, cursor, items):
    """The exact encoded baseline response, or an explicit oversized rejection.

    The bound is measured on the real encoded contract shape rather than estimated
    from rows, because work ids and timestamps are variable-length.
    """
    payload = {"libraryId": library_id, "epoch": epoch, "contractVersion": contract_version,
               "cursor": cursor, "items": items}
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_SNAPSHOT_BYTES:
        # Explicit failure, never a truncated or partial baseline: a client that
        # received a subset as complete could not detect the loss.
        raise HTTPException(503, detail={
            "code": "baselineTooLarge",
            "maxBytes": MAX_SNAPSHOT_BYTES,
            "actualBytes": len(encoded)})
    return payload


def snapshot_items(db, library_id, epoch):
    """Every materialized row, tombstones included, in deterministic order."""
    return [{"provider": item[0], "workId": item[1], "desiredState": bool(item[2]),
             "entityRevision": item[3], "createdAt": item[4], "updatedAt": item[5]}
            for item in db.execute(
                "SELECT provider,work_id,desired_state,entity_revision,created_at,updated_at"
                " FROM catalog_bookmark_state WHERE library_id=?"
                " ORDER BY provider,work_id", [library_id])]


def change_items(db, library_id, epoch, after, limit):
    """Ascending sequence slice of the change log."""
    return [{"sequence": item[0], "provider": item[1], "workId": item[2],
             "desiredState": bool(item[3]), "entityRevision": item[4], "operationId": item[5],
             "createdAt": item[6], "updatedAt": item[7], "changedAt": item[8]}
            for item in db.execute(
                "SELECT sequence,provider,work_id,desired_state,entity_revision,operation_id,"
                "created_at,updated_at,changed_at FROM catalog_bookmark_changes"
                " WHERE library_id=? AND epoch=? AND sequence>? ORDER BY sequence LIMIT ?",
                [library_id, epoch, after, limit])]


def entity_revision(db, library_id, provider, work_id):
    """Current authority entity revision for one work, or 0 when never seen.

    A client composes ``expectedRevision`` from this. 0 is the server's own
    convention for an entity with no state row, so an absent work and a known
    tombstone stay distinguishable by revision rather than by guessing.
    """
    row = db.execute(
        "SELECT entity_revision FROM catalog_bookmark_state"
        " WHERE library_id=? AND provider=? AND work_id=?",
        [library_id, provider, work_id]).fetchone()
    return row[0] if row else 0


def require_authority(db, library_id, epoch):
    """The active authority row matching this library/epoch, or a coded rejection."""
    rows = db.execute(
        "SELECT library_id,epoch,contract_version,change_cursor FROM authority_domains WHERE domain=?",
        [DOMAIN]).fetchall()
    if not rows:
        raise HTTPException(409, "Catalog bookmark authority is not active")
    if len(rows) > 1:
        raise HTTPException(503, "Catalog bookmark authority is ambiguous")
    row = rows[0]
    if row["library_id"] != library_id or row["epoch"] != epoch:
        raise HTTPException(409, "Catalog bookmark authority does not match this library")
    if row["contract_version"] != CONTRACT_VERSION:
        raise HTTPException(409, "Catalog bookmark authority contract is unsupported")
    return row


def attach_shadow(connection, snapshot):
    """Materialize authority bookmarks into a TEMP table that shadows the
    publication's baked copy for unqualified SQL references.

    Must run before PRAGMA query_only=ON and before the immutable read BEGIN.
    The temp setup transaction is committed so the long catalog read never holds
    a control-database lock; the snapshot arrives as plain Python values.
    """
    connection.execute(shadow_ddl("online_catalog_bookmarks"))
    connection.executemany("INSERT INTO online_catalog_bookmarks VALUES(?,?,?)",
                           [list(item) for item in snapshot["bookmarks"]])
    connection.commit()


def shadowed(connection):
    """True when the TEMP authority shadow exists on this connection.

    Authority is detected from the connection's temp schema, never inferred from
    publication contents.
    """
    try:
        return connection.execute(
            "SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name='online_catalog_bookmarks'").fetchone() is not None
    except sqlite3.Error:
        return False


def live_work_ids(connection, provider, work_ids):
    """Subset of the requested ids bookmarked under this connection.

    Identity is exact stored text, matching the catalog query's comparison.
    """
    if not work_ids:
        return set()
    requested = {str(value) for value in work_ids}
    placeholders = ",".join("?" for _ in requested)
    return {row[0] for row in connection.execute(
        f"""SELECT work_id FROM online_catalog_bookmarks
            WHERE provider=? AND work_id IN ({placeholders})""",
        [provider, *sorted(requested)])}


def group_bookmark_flags(connection, provider, group_ids):
    """hasBookmarkedVersion per requested group id."""
    if not group_ids:
        return {}
    placeholders = ",".join("?" for _ in group_ids)
    result = {group: False for group in group_ids}
    for row in connection.execute(
        f"""SELECT m.group_id FROM online_catalog_group_members m
            WHERE m.provider=? AND m.group_id IN ({placeholders})
              AND EXISTS(SELECT 1 FROM online_catalog_bookmarks b
                         WHERE b.provider=m.provider AND b.work_id=m.work_id)""",
        [provider, *group_ids]):
        result[row[0]] = True
    return result


def patch_items(connection, items):
    """Overwrite only the bookmark-derived fields of prepared page items."""
    ids = [item["providerWorkId"] for item in items]
    live = live_work_ids(connection, "kHentai", ids)
    groups = group_bookmark_flags(connection, "kHentai", sorted({item["groupId"] for item in items}))
    for item in items:
        item["bookmarked"] = item["providerWorkId"] in live
        item["hasBookmarkedVersion"] = groups.get(item["groupId"], False)
    return items
