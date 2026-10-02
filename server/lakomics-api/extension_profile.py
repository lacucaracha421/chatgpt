"""Extension pairing, sessions and the shared collector profile.

The application module is supplied at registration so its shared services and
compatibility hooks are resolved at call time, including test monkeypatches.
"""
import json
import os
import secrets
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from types import ModuleType
from urllib.parse import urlparse

from fastapi import HTTPException, Header, Request
from pydantic import BaseModel, Field

import authority
import classification_authority
import classification_snapshot


api: ModuleType


PAIRING_TTL_SECONDS = 10 * 60


MAX_EXTENSION_PROFILE_BYTES = 256 * 1024


MAX_EXTENSION_PROFILE_IDS = 2000


def _extension_public_origin(request: Request) -> str:
    configured = os.environ.get("LAKOMICS_EXTENSION_BASE_URL", "").strip()
    raw = configured or str(request.base_url)
    parsed = urlparse(raw)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise HTTPException(status_code=500, detail="Invalid extension base URL")
    return f"{parsed.scheme}://{parsed.netloc}"


class ExtensionPairExchange(BaseModel):
    secret: str = Field(min_length=16, max_length=256)


class ExtensionProfilePatch(BaseModel):
    expectedRevision: int = Field(ge=1)
    pinnedClassificationIds: list[str] | None = None
    listOrder: dict[str, list[str]] | None = None
    listOrderPatch: dict[str, list[str] | None] | None = None
    preferences: dict[str, bool] | None = None


def _read_extension_profile(db: sqlite3.Connection) -> dict:
    row = db.execute("SELECT revision,payload,updated_at FROM extension_profiles WHERE singleton=1").fetchone()
    if row is None:
        raise HTTPException(status_code=500, detail="Extension profile is not initialized")
    payload = json.loads(row["payload"])
    payload["revision"] = int(row["revision"])
    payload["updatedAt"] = row["updated_at"]
    return payload


def _validate_profile_ids(values: list[str]) -> list[str]:
    result = []
    seen = set()
    for raw in values[:api.MAX_EXTENSION_PROFILE_IDS]:
        value = str(raw).strip()
        if not value or len(value) > 240 or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _validate_list_order(value: dict[str, list[str]]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for parent, ids in list(value.items())[:api.MAX_EXTENSION_PROFILE_IDS]:
        parent = str(parent).strip()
        if not parent or len(parent) > 240 or not isinstance(ids, list):
            continue
        result[parent] = api._validate_profile_ids(ids)
    return result


def _classification_entries(items: list[dict]) -> list[dict]:
    """The compatibility wire entries the extension bootstrap ships to unchanged readers.

    The bootstrap and its pairing exchange both speak camelCase `entries`, so the shared
    projection is mapped rather than handed over in the mobile route's snake_case field
    names. The fields those consumers already know are unchanged — including `assetCount`,
    which is the live authority count now that the authority owns membership — and the
    ordering is the projection's, so display position survives the cutover.
    """
    return [{"id": item["id"], "kind": item["kind"], "name": item["name"],
             "parentId": item["parent_id"], "iconKey": item["icon_key"],
             "colorKey": item["color_key"], "assetCount": item["asset_count"]}
            for item in items]


def _classification_snapshot() -> dict:
    with api.get_db() as db:
        # One read transaction: the entries and the authority identity they were projected
        # under must describe the same state, or a command committing between the two reads
        # would ship a tree labeled with another read's generation.
        db.execute("BEGIN")
        try:
            row = db.execute(
                "SELECT payload,revision FROM classification_snapshots WHERE singleton=1"
            ).fetchone()
            active = authority.active_domain(db, classification_authority.DOMAIN)
            if active is not None:
                # Same canonical projection the mobile tree serves: after cutover a
                # structure accepted by the authority command lane must appear here too,
                # and the frozen publication may contribute display position only. The
                # sidecar is this route's own historical display list (`legacyEntries`,
                # the publisher's order), so its pre-cutover order is preserved.
                entries = api._classification_entries(classification_authority.compatibility_tree(
                    db, active,
                    classification_snapshot.display_order(
                        classification_snapshot.legacy_entries(row["payload"]))
                    if row is not None else None))
                return {"entries": entries, "revision": int(row["revision"]) if row is not None else 0}
        finally:
            db.rollback()
    if row is None:
        return {"entries": [], "revision": 0}
    # Entries only, for any stored version: the extension bootstrap must keep working
    # without understanding canonical collections or `snapshotVersion`.
    return {"entries": classification_snapshot.legacy_entries(row["payload"]),
            "revision": int(row["revision"])}


def create_extension_pairing(request: Request, authorization: str | None = Header(default=None)):
    api.require_auth(authorization)
    secret = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(seconds=api.PAIRING_TTL_SECONDS)
    with api.get_db() as db:
        db.execute("DELETE FROM extension_pairings WHERE used_at IS NOT NULL OR expires_at<?", (api.now_iso(),))
        db.execute(
            "INSERT INTO extension_pairings(secret_hash,expires_at,used_at) VALUES(?,?,NULL)",
            (api._token_hash(secret), expires.isoformat()),
        )
        db.commit()
    origin = api._extension_public_origin(request)
    return {"pairingUrl": f"{origin}/extension-pair#{secret}", "expiresAt": expires.isoformat()}


def exchange_extension_pairing(exchange: ExtensionPairExchange, request: Request):
    secret_hash = api._token_hash(exchange.secret)
    now = datetime.now(timezone.utc)
    client_id = str(uuid.uuid4())
    client_token = secrets.token_urlsafe(40)
    with api.get_db() as db:
        row = db.execute(
            "SELECT expires_at,used_at FROM extension_pairings WHERE secret_hash=?",
            (secret_hash,),
        ).fetchone()
        if row is None or row["used_at"] is not None:
            raise HTTPException(status_code=410, detail="Pairing link is no longer valid")
        try:
            expires = datetime.fromisoformat(row["expires_at"])
        except ValueError:
            raise HTTPException(status_code=410, detail="Pairing link is no longer valid")
        if expires <= now:
            raise HTTPException(status_code=410, detail="Pairing link has expired")
        db.execute("UPDATE extension_pairings SET used_at=? WHERE secret_hash=?", (now.isoformat(), secret_hash))
        db.execute(
            "INSERT INTO extension_clients(id,token_hash,created_at,last_seen_at,revoked_at) VALUES(?,?,?,?,NULL)",
            (client_id, api._token_hash(client_token), now.isoformat(), now.isoformat()),
        )
        profile = api._read_extension_profile(db)
        db.commit()
    return {
        "serverOrigin": api._extension_public_origin(request),
        "clientToken": client_token,
        "clientId": client_id,
        "profile": profile,
        "classifications": api._classification_snapshot(),
    }


def extension_bootstrap(authorization: str | None = Header(default=None)):
    api.require_extension_client(authorization)
    with api.get_db() as db:
        profile = api._read_extension_profile(db)
    return {"profile": profile, "classifications": api._classification_snapshot()}


def get_extension_profile(authorization: str | None = Header(default=None)):
    api.require_extension_client(authorization)
    with api.get_db() as db:
        return api._read_extension_profile(db)


def patch_extension_profile(patch: ExtensionProfilePatch, authorization: str | None = Header(default=None)):
    api.require_extension_client(authorization)
    with api.get_db() as db:
        current = api._read_extension_profile(db)
        if current["revision"] != patch.expectedRevision:
            raise HTTPException(status_code=409, detail={"code": "profile_conflict", "profile": current})
        next_profile = {
            "schemaVersion": 1,
            "pinnedClassificationIds": current.get("pinnedClassificationIds", []),
            "listOrder": current.get("listOrder", {}),
            "preferences": current.get("preferences", {"autoLikeOnSave": True, "xTranslateEnabled": True}),
        }
        if patch.pinnedClassificationIds is not None:
            next_profile["pinnedClassificationIds"] = api._validate_profile_ids(patch.pinnedClassificationIds)
        if patch.listOrder is not None:
            next_profile["listOrder"] = api._validate_list_order(patch.listOrder)
        if patch.listOrderPatch is not None:
            order = dict(next_profile["listOrder"])
            for parent, ids in list(patch.listOrderPatch.items())[:api.MAX_EXTENSION_PROFILE_IDS]:
                key = str(parent).strip()
                if not key or len(key) > 240:
                    continue
                if ids is None:
                    order.pop(key, None)
                else:
                    order[key] = api._validate_profile_ids(ids)
            next_profile["listOrder"] = order
        if patch.preferences is not None:
            allowed = {"autoLikeOnSave", "xTranslateEnabled"}
            preferences = dict(next_profile["preferences"])
            for key, value in patch.preferences.items():
                if key in allowed and isinstance(value, bool):
                    preferences[key] = value
            next_profile["preferences"] = preferences
        encoded = json.dumps(next_profile, separators=(",", ":"), sort_keys=True)
        if len(encoded.encode("utf-8")) > api.MAX_EXTENSION_PROFILE_BYTES:
            raise HTTPException(status_code=413, detail="Extension profile too large")
        revision = current["revision"] + 1
        updated_at = api.now_iso()
        db.execute(
            "UPDATE extension_profiles SET revision=?,payload=?,updated_at=? WHERE singleton=1",
            (revision, encoded, updated_at),
        )
        db.commit()
        return {**next_profile, "revision": revision, "updatedAt": updated_at}


def revoke_current_extension_client(authorization: str | None = Header(default=None)):
    client_id = api.require_extension_client(authorization)
    with api.get_db() as db:
        db.execute("UPDATE extension_clients SET revoked_at=COALESCE(revoked_at,?) WHERE id=?", (api.now_iso(), client_id))
        db.commit()
    return {"ok": True}


def revoke_extension_client(client_id: str, authorization: str | None = Header(default=None)):
    api.require_auth(authorization)
    with api.get_db() as db:
        changed = db.execute(
            "UPDATE extension_clients SET revoked_at=COALESCE(revoked_at,?) WHERE id=?",
            (api.now_iso(), client_id),
        ).rowcount
        db.commit()
    if changed == 0:
        raise HTTPException(status_code=404, detail="Extension client not found")
    return {"ok": True}


def register(app, services):
    global api
    api = services
    app.post("/v1/extension/pairings")(create_extension_pairing)
    app.post("/v1/extension/pair")(exchange_extension_pairing)
    app.get("/v1/extension/bootstrap")(extension_bootstrap)
    app.get("/v1/extension/profile")(get_extension_profile)
    app.patch("/v1/extension/profile")(patch_extension_profile)
    app.delete("/v1/extension/session")(revoke_current_extension_client)
    app.post("/v1/extension/clients/{client_id}/revoke")(revoke_extension_client)
