"""Other Assets from the same source post, for the tablet Asset information (parity U06).

PC rule (``src-tauri/src/library/source_group.rs``): an Asset whose source URL is an
``https://x.com`` or ``https://twitter.com`` ``/<handle>/status/<digits>`` link groups with
every other ordinary Asset of that status id, across both hosts and any media suffix,
ordered by save time. Other sources have no group.

``GET /v1/library/assets/{asset_id}/same-post`` (client): ``{"version": 1, "assetId",
"items": [mobile Asset, ... <= 100], "listGeneration"}``, ETag / 304. Items include the
requested Asset itself and use the ``/v1/library/assets`` projection; ``items`` is empty when
the source is not a groupable post. Visibility is the shared ``visible_assets`` projection, so
trashed (after Asset authority activation), uncommitted and cover-only (``favorite_cover``)
Assets are never listed. A requested Asset that is not visible is 404 ``assetNotFound``.
"""
from types import ModuleType
from urllib.parse import urlsplit

from fastapi import Header, HTTPException

import conditional
import library_assets

MAX_ITEMS = 100
#: ``LIKE`` prefilter rows read before the exact key check; ids sharing a prefix are rare.
MAX_CANDIDATES = 400

api: ModuleType


def post_key(url):
    """The X status id of a source URL, or None (same rule as the PC)."""
    if not isinstance(url, str):
        return None
    try:
        parts = urlsplit(url)
        host = parts.hostname
    except ValueError:
        return None
    if parts.scheme != "https" or host not in ("x.com", "twitter.com"):
        return None
    segments = parts.path.split("/")[1:]
    if len(segments) < 3 or not segments[0] or segments[1] != "status":
        return None
    post = segments[2]
    return post if post and post.isascii() and post.isdigit() else None


def same_post(asset_id: str, authorization: str | None = Header(default=None),
              if_none_match: str | None = Header(default=None)):
    api.client_guard(api.get_db, api.API_TOKEN)(authorization)
    with api.get_db() as db:
        db.execute("BEGIN")
        try:
            generation = api.list_generation(db)
            row = db.execute("SELECT source_url FROM visible_assets WHERE id=? AND committed=1",
                             [asset_id]).fetchone()
            if row is None:
                raise HTTPException(404, {"code": "assetNotFound", "message": "에셋을 찾을 수 없습니다."})
            key = post_key(row["source_url"])
            rows = []
            if key is not None:
                candidates = db.execute(
                    "SELECT asset.* FROM visible_assets AS asset WHERE asset.committed=1"
                    " AND asset.source_url LIKE ? ORDER BY asset.collected_at, asset.id LIMIT ?",
                    [f"%/status/{key}%", MAX_CANDIDATES]).fetchall()
                rows = [candidate for candidate in candidates
                        if post_key(candidate["source_url"]) == key][:MAX_ITEMS]
            rows = library_assets.image_text_flags(db, rows)
            memberships = api._mobile_memberships(db, rows)
        finally:
            db.rollback()
    items = [api.mobile_asset_item(row, memberships.get(row["id"], [])) for row in rows]
    return conditional.json_response(
        {"version": 1, "assetId": asset_id, "items": items, "listGeneration": generation},
        if_none_match)


def register(app, services):
    global api
    api = services
    app.get("/v1/library/assets/{asset_id}/same-post")(same_post)
