"""오늘의 AV 배우 (HOME-DASH-001): the PC's daily performer pick, shown on the tablet Home.

Decided 2026-09-26: AV Collection data may leave the PC for this card, behind a PC setting
that is off by default. The PC computes the pick (a daily seeded choice over performers with
at least one AV Collection) and publishes it; turning the setting off deletes it here, so the
server holds nothing AV-related while the card is off. Nothing runs in the background.

Errors are ``{"detail": {"code", "message"}}`` (401 from the guards is
``{"detail": "Unauthorized"}``; a client credential on a publisher route is 401 too).

Pick
----
``{"date": "YYYY-MM-DD" (the local day of the pick), "personId", "name", "aliases": [str,
... <= 20], "workCount": int, "latestWork": null | {"code"|null, "label"|null, "series"|null,
"title"|null, "date": "YYYY-MM-DD"|null, "collectionId"|null}, "cover": Cover|null}``

* ``personId``/``collectionId`` ``[A-Za-z0-9_-]{1,128}`` (the PC's ids); names <= 200,
  code/label <= 100, series/title <= 500, single-line.
* ``cover`` - see ``home_publications``. An AV front cover exists only on the PC, so upload it
  through the Collections artwork flow and send the blob form; the tablet fetches it with
  ``POST /v1/home/covers/{sha256}/media-ticket``. Omit it (null) for a text-only card.

1. ``PUT /v1/home/av-pick`` (publisher), <= 64 KiB: ``{"version": 1, "pick": Pick | null}``.
   ``null`` removes it (same as ``DELETE``). Idempotent. Reply ``{"version": 1, "revision",
   "changed": bool, "active": bool}``. Errors ``422 invalidAvPick``, ``413 avPickTooLarge``,
   ``409 homeCoverNotUploaded``.
2. ``DELETE /v1/home/av-pick`` (publisher): removes the pick and its cover reference. Reply as
   above (``active: false``); deleting nothing is not an error.
3. ``GET /v1/home/av-pick`` (client): ``{"version": 1, "revision", "publishedAt", "pick":
   Pick}`` with ETag / 304, or ``404 avPickUnavailable`` while there is none (setting off or
   never published).

Signal: ``signals.avPick`` = ``revision`` (moves on every change, including removal).
"""
import json
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import Header, Request
from pydantic import Field, StringConstraints, ValidationError
from starlette.concurrency import run_in_threadpool

import conditional
import home_publications as common
from home_publications import Cover, Day, Strict, fail, text

PREFIX = "/v1/home/av-pick"
MAX_BODY_BYTES = 64 * 1024
COVER_OWNER = "avPick"
Id = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,128}$")]

DDL = """
CREATE TABLE IF NOT EXISTS home_av_pick(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
 published_at TEXT, pick TEXT);
INSERT OR IGNORE INTO home_av_pick VALUES(1,0,NULL,NULL);
"""


def startup_db(db):
    db.executescript(DDL)
    common.startup_db(db)


class LatestWork(Strict):
    code: text(100) | None = None
    label: text(100) | None = None
    series: text(500) | None = None
    title: text(500) | None = None
    date: Day | None = None
    collectionId: Id | None = None


class Pick(Strict):
    date: Day
    personId: Id
    name: text(200)
    aliases: list[text(200)] = Field(default_factory=list, max_length=20)
    workCount: int = Field(ge=0, le=1_000_000)
    latestWork: LatestWork | None = None
    cover: Cover | None = None


class Upload(Strict):
    version: Literal[1]
    pick: Pick | None


def _row(db):
    return db.execute("SELECT * FROM home_av_pick WHERE singleton=1").fetchone()


def status_signal(db):
    """``signals.avPick``: the revision the tablet compares."""
    return _row(db)["revision"]


def register(app, get_db, require_client, require_publisher):
    """Install the routes; returns the startup hook (creates empty tables only)."""

    def store(pick):
        payload = None if pick is None else json.dumps(pick.model_dump(), ensure_ascii=False, sort_keys=True,
                                                       separators=(",", ":"))
        with get_db() as db:
            db.execute("BEGIN IMMEDIATE")
            row = _row(db)
            changed = payload != row["pick"]
            if changed:
                common.replace_cover_refs(db, COVER_OWNER, [] if pick is None else [pick.cover])
                db.execute("UPDATE home_av_pick SET revision=revision+1,pick=?,published_at=? WHERE singleton=1",
                           (payload, None if pick is None else datetime.now(timezone.utc).isoformat()))
            result = {"version": 1, "revision": _row(db)["revision"], "changed": changed, "active": pick is not None}
            db.commit()
            return result

    @app.put(PREFIX)
    async def put_pick(request: Request, authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        raw = await common.bounded_body(request, MAX_BODY_BYTES, "avPickTooLarge", "오늘의 배우 게시 요청이 너무 큽니다.")
        try:
            upload = Upload.model_validate_json(raw)
        except (ValidationError, ValueError):
            fail(422, "invalidAvPick", "오늘의 배우 정보를 확인할 수 없습니다.")
        return await run_in_threadpool(store, upload.pick)

    @app.delete(PREFIX)
    def delete_pick(authorization: str | None = Header(default=None)):
        require_publisher(authorization)
        return store(None)

    @app.get(PREFIX)
    def get_pick(authorization: str | None = Header(default=None),
                 if_none_match: str | None = Header(default=None)):
        require_client(authorization)
        with get_db() as db:
            row = _row(db)
        if row["pick"] is None:
            fail(404, "avPickUnavailable", "오늘의 배우가 없습니다.")
        return conditional.json_response({"version": 1, "revision": row["revision"],
                                          "publishedAt": row["published_at"], "pick": json.loads(row["pick"])},
                                         if_none_match)

    def startup():
        with get_db() as db:
            startup_db(db)
            db.commit()

    return startup

