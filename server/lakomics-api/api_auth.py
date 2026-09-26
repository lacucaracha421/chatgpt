"""Publisher/client authorization for the mobile catalog.

Two roles, one boundary. A **client** is an interactive device: it reads catalog
data, reads bookmark state, and submits ordinary user bookmark mutations. A
**publisher** is the trusted PC publication role: it may use every client route
and additionally upload replicas, publish a catalog projection, and activate
bookmark authority.

The roles are genuinely separate credentials. The legacy shared cloud token is
kept working during the transition, but only as a *client*-compatible credential:
it no longer satisfies :func:`publisher_guard`. Publisher authority therefore
requires a token that was deliberately provisioned with the ``publisher`` role,
which is what ADR-0036 means by proving publisher vs reader authorization at the
server boundary.

``extension_clients`` stays its own boundary and is deliberately not reused.
"""
import argparse
import hashlib
import secrets
import sqlite3
import sys
import time
import uuid
from pathlib import Path

from fastapi import HTTPException

ROLES = ("publisher", "client")

#: Principal id reported for the legacy shared token. It is not an ``api_clients``
#: row, so it is distinguishable in code and never collides with a real id.
LEGACY_CLIENT = "legacy-shared-token"

#: Label describing what the legacy shared credential is accepted as.
LEGACY_LABEL = "catalog-client-v1"

DDL = """
CREATE TABLE IF NOT EXISTS api_clients(
 id TEXT PRIMARY KEY,
 token_hash TEXT NOT NULL UNIQUE,
 role TEXT NOT NULL CHECK(role IN ('publisher','client')),
 label TEXT,
 created_at TEXT NOT NULL,
 last_seen_at TEXT,
 revoked_at TEXT);
"""

#: Mirrors ``app.DB_PATH``. Kept here so the provisioning CLI does not import
#: ``app`` (which requires the R2 environment and builds the whole application);
#: ``test_api_auth`` asserts the two paths stay identical.
DEFAULT_DB = Path(__file__).resolve().parent / "data" / "lakomics.sqlite3"


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def startup(get_db):
    with get_db() as db:
        db.executescript(DDL)
        db.commit()


def token_hash(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _bearer(authorization):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Unauthorized")
    token = authorization[7:].strip()
    if not token:
        raise HTTPException(401, "Unauthorized")
    return token


def _api_client(get_db, authorization, roles):
    """Unrevoked api_clients row whose role is in ``roles``, or None."""
    token = _bearer(authorization)
    with get_db() as db:
        row = db.execute(
            "SELECT id,role FROM api_clients WHERE token_hash=? AND revoked_at IS NULL",
            [token_hash(token)]).fetchone()
        if row is None or row[1] not in roles:
            return None
        return row[0]


def client_guard(get_db, shared_token):
    """Accept any unrevoked catalog row, plus the legacy shared credential.

    The shared token is accepted here *only*: it identifies an interactive client
    and must not be usable as a publisher credential.
    """
    def require_client(authorization: str | None = None):
        if shared_token and authorization == f"Bearer {shared_token}":
            return LEGACY_CLIENT
        principal = _api_client(get_db, authorization, ROLES)
        if principal is None:
            raise HTTPException(401, "Unauthorized")
        return principal
    return require_client


def principal_role(db, principal):
    """The role of a principal ``client_guard`` accepted: ``"publisher"`` or ``"client"``.

    The legacy shared credential is client-compatible only, so it is ``"client"``. A row
    that vanished or was revoked since authentication gets no elevated view either.
    A row's role never changes (a new role is a new credential), so the answer is a
    function of the principal id.
    """
    if principal == LEGACY_CLIENT:
        return "client"
    row = db.execute("SELECT role FROM api_clients WHERE id=? AND revoked_at IS NULL",
                     [principal]).fetchone()
    return "publisher" if row is not None and row[0] == "publisher" else "client"


def publisher_guard(get_db):
    """Accept unrevoked ``publisher`` rows only.

    Deliberately takes no shared token: one credential must not satisfy both
    roles, which is the separation ADR-0036 requires before writes are enabled.
    """
    def require_publisher(authorization: str | None = None):
        principal = _api_client(get_db, authorization, ("publisher",))
        if principal is None:
            raise HTTPException(401, "Unauthorized")
        return principal
    return require_publisher


def provision_token(connection, role, label=None, now=None):
    """Mint one role credential. Returns ``(id, raw_token)``.

    The raw token is returned exactly once, here. Only its SHA-256 hash is
    persisted, so it cannot be recovered from the database afterwards.
    """
    if role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}")
    token = secrets.token_urlsafe(32)
    client_id = uuid.uuid4().hex
    connection.execute(
        "INSERT INTO api_clients VALUES(?,?,?,?,?,?,?)",
        [client_id, token_hash(token), role, label, now or now_iso(), None, None])
    return client_id, token


def revoke_token(connection, token_id, now=None):
    """Revoke by client id. Returns True when a live row was revoked."""
    cursor = connection.execute(
        "UPDATE api_clients SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
        [now or now_iso(), token_id])
    return cursor.rowcount > 0


def _open(path):
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.executescript(DDL)
    return connection


def main(argv=None):
    """Server-local provisioning. Not an HTTP route: a client credential must
    never be able to escalate itself to publisher.
    """
    parser = argparse.ArgumentParser(description="Provision catalog API role credentials.")
    parser.add_argument("--db", default=str(DEFAULT_DB))
    actions = parser.add_subparsers(dest="action", required=True)
    create = actions.add_parser("provision", help="mint a new role credential")
    create.add_argument("--role", required=True, choices=ROLES)
    create.add_argument("--label", default=None)
    drop = actions.add_parser("revoke", help="revoke a credential by client id")
    drop.add_argument("--id", required=True)
    actions.add_parser("list", help="list credentials without secrets")
    arguments = parser.parse_args(argv)

    connection = _open(arguments.db)
    try:
        if arguments.action == "provision":
            client_id, token = provision_token(connection, arguments.role, arguments.label)
            connection.commit()
            print(f"id:    {client_id}")
            print(f"role:  {arguments.role}")
            # The only disclosure of the raw token. It is not stored and cannot be
            # printed again; capture it now through the operator's own channel.
            print(f"token: {token}")
        elif arguments.action == "revoke":
            if not revoke_token(connection, arguments.id):
                connection.commit()
                print("no live credential with that id", file=sys.stderr)
                return 1
            connection.commit()
            print(f"revoked: {arguments.id}")
        else:
            for row in connection.execute(
                    "SELECT id,role,label,created_at,revoked_at FROM api_clients ORDER BY created_at"):
                print(dict(row))
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
