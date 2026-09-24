"""Aggregate sync status: one small authenticated read of active authority domains.

ADR-0037 decision 1: clients use an aggregate endpoint to discover which domains
have moved to server authority and how far each has advanced, then run their
domain-specific receive/flush logic. There is deliberately **no** global cursor:
each domain keeps its own epoch/cursor, and this response only reports them.

This endpoint is read-only and adds no behavior change to any domain. While no
authority row exists it reports zero active domains, which is exactly the state a
pre-cutover client must see.
"""
import authority
import conditional
from app_lifecycle import lifecycle
from fastapi import Header, HTTPException

PREFIX = "/v1/sync"


def _active_view(domains):
    """The public domain list, with only the fields a client needs to poll cheaply."""
    return [{"domain": entry["domain"], "libraryId": entry["libraryId"], "epoch": entry["epoch"],
             "contractVersion": entry["contractVersion"], "cursor": entry["cursor"]}
            for entry in domains]


def _library_identity(domains):
    """The single logical library these domains agree on, or None when inactive.

    A single-library server cannot have two active libraries. Disagreement is an
    impossible state, so it is reported instead of resolved by picking one — a
    client that guessed here could reconcile against the wrong authority.
    """
    libraries = sorted({entry["libraryId"] for entry in domains})
    if len(libraries) > 1:
        raise HTTPException(503, detail={"code": authority.CODE_AUTHORITY_AMBIGUOUS,
                                         "message": "동기화 권위 상태가 모호합니다.",
                                         "libraries": libraries})
    return libraries[0] if libraries else None


def register_sync_status(app, get_db, require_client, exchange_status=None):
    def startup():
        authority.startup(get_db)

    lifecycle(app).on_startup(startup)

    @app.get(PREFIX + "/status")
    def sync_status(authorization: str | None = Header(default=None),
                    if_none_match: str | None = Header(default=None)):
        principal = require_client(authorization)
        exchange = None
        with get_db() as db:
            db.execute("BEGIN")
            try:
                domains = authority.active_domains(db)
                # File exchange arrivals ride on this poll instead of a poll of their own.
                if exchange_status is not None:
                    exchange = exchange_status(db, principal)
            finally:
                db.rollback()
        # This is the most polled document on the server. Between commands it does not
        # change, so a client that sends the previous ETag back gets 304 and can skip
        # every per-domain change-feed poll until the aggregate moves.
        payload = {"protocolVersion": authority.PROTOCOL_VERSION,
                   "active": bool(domains),
                   "libraryId": _library_identity(domains),
                   "domains": _active_view(domains)}
        if exchange is not None:
            payload["exchange"] = exchange
        return conditional.json_response(payload, if_none_match)

    return startup
