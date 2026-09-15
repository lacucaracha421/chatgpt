"""Reusable server-authority registry, shared by every cut-over domain.

ADR-0037 gives each shared domain its own authority state:
``library_id``, domain name, ``epoch``, ``contract_version``, a monotonically
increasing domain ``cursor``, baseline identity and activation metadata. There is
deliberately no global correctness cursor, so this module never reduces several
domains to one number.

The table itself is the one ``catalog_bookmarks`` already created and shipped
(B1/B3/B4). This module reads that same table and owns no domain state: domain
rows, commands, receipts and projections stay typed and owned by their domain
handler. Nothing here activates, mutates or migrates an authority row, and every
helper below is inert while no row exists.

Cutover contract (ADR-0037 decision 7): a legacy snapshot/publication route calls
:func:`fence_legacy_write` inside the same transaction that performs the protected
write. While the domain is inactive the call is a no-op, so existing behavior is
unchanged; once the domain's epoch is active the legacy writer is rejected with a
coded conflict. A writer that presents a different library identity is still
rejected, so a stale or foreign writer cannot bypass the fence by disagreeing
about which library it is.
"""
import sqlite3

from fastapi import HTTPException

#: Version of the aggregate sync-status document, not of any domain contract.
PROTOCOL_VERSION = 1

#: Identical to the definition ``catalog_bookmarks`` ships. Repeating the
#: ``IF NOT EXISTS`` form keeps this module usable in isolation without changing
#: the bookmark schema or its ownership.
AUTHORITY_DDL = """
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
"""

CODE_AUTHORITY_INACTIVE = "authorityInactive"
CODE_AUTHORITY_AMBIGUOUS = "authorityAmbiguous"
CODE_AUTHORITY_LIBRARY_MISMATCH = "authorityLibraryMismatch"
CODE_AUTHORITY_CONTRACT_UNSUPPORTED = "authorityContractUnsupported"
CODE_LEGACY_WRITER_FENCED = "legacyWriterFenced"
#: Intentionally the same code string the shipped bookmark change log already
#: returns, so one vocabulary describes one state across domains.
CODE_CURSOR_EXPIRED = "cursorExpired"

#: Column list shared by every read below, in a fixed order so rows can be read by
#: position. A caller-supplied ``row_factory`` cannot change what these helpers see.
_COLUMNS = ("library_id", "domain", "epoch", "contract_version", "change_cursor",
            "baseline_digest", "baseline_revision", "activated_at")


def startup(get_db):
    with get_db() as db:
        db.executescript(AUTHORITY_DDL)
        db.commit()


def _fail(status, code, message, **extra):
    raise HTTPException(status, detail={"code": code, "message": message, **extra})


def _row(values):
    """One authority row as a plain dict, keyed by the public camelCase contract."""
    return {"domain": values[1], "libraryId": values[0], "epoch": values[2],
            "contractVersion": values[3], "cursor": values[4],
            "baselineDigest": values[5], "baselineRevision": values[6],
            "activatedAt": values[7]}


def _select(db, domain=None):
    query = f"SELECT {','.join(_COLUMNS)} FROM authority_domains"
    params = []
    if domain is not None:
        query += " WHERE domain=?"
        params.append(domain)
    query += " ORDER BY domain, library_id"
    try:
        return db.execute(query, params).fetchall()
    except sqlite3.OperationalError as error:
        # A deployment whose control database predates this registry — or an
        # isolated fixture that only ran one domain's startup — has no authority
        # rows by definition. Reporting "no active authority" is the correct
        # answer there, and it is what keeps a legacy writer's behavior unchanged
        # instead of failing on a table it never needed.
        if "no such table" in str(error) and "authority_domains" in str(error):
            return []
        raise


def _singleton(rows, domain):
    """The one row for ``domain``, or None.

    Two rows for the same domain name means two libraries believe they own it.
    That is an impossible state for a single-library product, so it is reported
    rather than resolved by picking one.
    """
    if len(rows) > 1:
        _fail(503, CODE_AUTHORITY_AMBIGUOUS,
              "동기화 권위 상태가 모호합니다.", domain=domain,
              libraries=sorted({row[0] for row in rows}))
    return rows[0] if rows else None


def active_domains(db):
    """Every active authority domain, ordered by name.

    Raises the coded ambiguous state when one domain carries more than one
    library. Rows are read by position, so this works regardless of the
    connection's ``row_factory`` and inside an already-open transaction.
    """
    grouped = {}
    for row in _select(db):
        grouped.setdefault(row[1], []).append(row)
    return [_row(_singleton(rows, domain)) for domain, rows in sorted(grouped.items())]


def active_domain(db, domain, library_id=None):
    """One domain's active authority row, or None while the domain is PC-owned.

    ``library_id`` narrows the lookup when the caller already knows which library
    it speaks for. A mismatch is not an error here — it is reported as "no active
    authority for this caller", which is what a fence needs to see. Ambiguity is
    still checked against the *unfiltered* domain rows, because two libraries
    claiming one domain is impossible regardless of who is asking.
    """
    row = _singleton(_select(db, domain), domain)
    if row is None or (library_id is not None and row[0] != library_id):
        return None
    return _row(row)


def require_active(db, domain, library_id, contract_version):
    """The active authority row a read route may serve, or a coded rejection.

    Coded so a client can tell an unsupported contract from a stale identity
    instead of retrying a request that can never succeed.
    """
    rows = _select(db, domain)
    row = _singleton(rows, domain)
    if row is None:
        _fail(409, CODE_AUTHORITY_INACTIVE,
              "이 영역은 아직 서버 권위가 아닙니다.", domain=domain)
    if row[3] != contract_version:
        _fail(409, CODE_AUTHORITY_CONTRACT_UNSUPPORTED,
              "서버가 지원하지 않는 계약 버전입니다.", domain=domain,
              supported=row[3])
    if row[0] != library_id:
        _fail(409, CODE_AUTHORITY_LIBRARY_MISMATCH,
              "다른 라이브러리의 권위 상태입니다.", domain=domain, libraryId=row[0])
    return _row(row)


def fence_legacy_write(db, domain, library_id=None):
    """Reject a legacy snapshot/publication write once its domain is fenced.

    Returns ``None`` while the domain has no authority row, so the caller's legacy
    behavior is byte-identical to before this module existed. Once a row exists
    the write is always rejected:

    * an inactive domain proceeds unchanged;
    * an active domain is rejected with ``legacyWriterFenced``;
    * a writer presenting a different library identity is rejected with
      ``authorityLibraryMismatch`` rather than being allowed through, so
      disagreeing about the library can never bypass the fence.

    Performs reads only and never writes, so it is safe to call inside the
    ``BEGIN IMMEDIATE`` transaction that performs the protected write.
    """
    rows = _select(db, domain)
    row = _singleton(rows, domain)
    if row is None:
        return None
    if library_id is not None and row[0] != library_id:
        _fail(409, CODE_AUTHORITY_LIBRARY_MISMATCH,
              "이 라이브러리는 서버 권위로 전환되었습니다.", domain=domain,
              libraryId=row[0])
    _fail(409, CODE_LEGACY_WRITER_FENCED,
          "이 영역은 서버가 관리합니다. 이전 방식의 게시는 더 이상 반영되지 않습니다.",
          domain=domain, libraryId=row[0], epoch=row[2])
