"""Date and creator revisit bundles for the mobile library.

The application module is supplied at registration so its shared services and
compatibility hooks are resolved at call time, including test monkeypatches.
"""
import base64
import binascii
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from types import ModuleType
from typing import Literal

from fastapi import HTTPException, Header, Query

import authority
import classification_authority


api: ModuleType

HOME_REVISIT_SQL = Path(__file__).with_name("home_revisit.sql").read_text(encoding="utf-8")
KST = timezone(timedelta(hours=9))


def home_revisit_rows(db, day: str):
    """Use the same read-only anniversary selection as the native Home command."""
    try:
        if datetime.strptime(day, "%Y-%m-%d").strftime("%Y-%m-%d") != day:
            raise ValueError()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid Home day")
    selected = db.execute(
        "WITH revisit_assets AS (SELECT id, collected_at FROM visible_assets "
        "WHERE committed = 1 AND kind IN ('image', 'gif', 'animated_gif'))\n" + HOME_REVISIT_SQL,
        {"day": day},
    ).fetchall()
    rows = []
    for entry in selected:
        row = db.execute("SELECT * FROM visible_assets WHERE id = ?", (entry["id"],)).fetchone()
        rows.append(row)
    return rows, selected[0]["distance"] if selected else None


def list_home_revisit(authorization: str | None = Header(default=None), day: str | None = None):
    api.require_auth(authorization)
    day = day or datetime.now(KST).date().isoformat()
    with api.get_db() as db:
        db.execute("BEGIN")
        rows, distance = home_revisit_rows(db, day)
        memberships = api._mobile_memberships(db, rows)
    title = "1년 전 오늘" if distance == 0 else "1년 전 이맘때"
    return {"day": day, "bundles": [{"kind": "date", "title": title,
            "items": [api.mobile_asset_item(row, memberships.get(row["id"], [])) for row in rows]}]}


def encode_revisit_date_cursor(rank: int, sort_at: str, asset_id: str) -> str:
    payload = json.dumps(["revisit-date", str(rank), sort_at, asset_id], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(payload).rstrip(b"=").decode()


def decode_revisit_date_cursor(cursor: str) -> tuple[int, str, str]:
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(base64.b64decode(cursor + padding, altchars=b"-_", validate=True))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid cursor")
    if (
        not isinstance(payload, list)
        or len(payload) != 4
        or payload[0] != "revisit-date"
        or payload[1] not in {"0", "1", "2"}
        or not all(isinstance(value, str) and value for value in payload[2:])
    ):
        raise HTTPException(status_code=400, detail="Invalid cursor")
    return int(payload[1]), payload[2], payload[3]


def _revisit_creator_exclusion_sql(alias: str = "asset") -> str:
    return f"""
          AND (
            {alias}.creator_handle IS NULL OR {alias}.creator_handle = '' OR {alias}.creator_handle NOT IN (
              SELECT eligible.creator_handle FROM visible_assets AS eligible
              WHERE eligible.committed = 1 AND eligible.creator_handle IS NOT NULL AND eligible.creator_handle != ''
              GROUP BY eligible.creator_handle HAVING COUNT(*) >= 3
                AND MIN(COALESCE(eligible.collected_at, eligible.created_at)) <= datetime('now', '-30 days')
            )
          )"""


def _revisit_calendar_distance_sql(timestamp_sql: str, reference_sql: str = "'now'") -> str:
    fixed_asset = f"julianday('2000-' || strftime('%m-%d', {timestamp_sql}))"
    fixed_now = f"julianday('2000-' || strftime('%m-%d', {reference_sql}))"
    delta = f"ABS({fixed_asset} - {fixed_now})"
    # Year 2000 is leap-safe; circular distance makes Dec 31 and Jan 1 adjacent.
    return f"MIN({delta}, 366 - {delta})"


def _revisit_date_bundle(db, limit: int) -> list:
    """과거의 이날 후보: 30일 이전 자산 중 오늘의 월/일 ±7일 근처 수집 자산.
    부족하면 같은 달의 오래된 자산, 그래도 부족하면 결정론적 오래된 자산으로
    확장한다(항상 30일 이전만 포함)."""
    creator_exclusion = api._revisit_creator_exclusion_sql("asset")
    calendar_distance = api._revisit_calendar_distance_sql("COALESCE(asset.collected_at, asset.created_at)")
    rows = db.execute(
        f"""
        SELECT asset.*, COALESCE(asset.collected_at, asset.created_at) AS mobile_sort_at
        FROM visible_assets AS asset
        WHERE asset.committed = 1
          AND COALESCE(asset.collected_at, asset.created_at) <= datetime('now', '-30 days')
          {creator_exclusion}
          AND ({calendar_distance}) <= 7
        ORDER BY mobile_sort_at DESC, asset.id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    if len(rows) >= limit:
        return rows
    seen = {row["id"] for row in rows}
    month_rows = db.execute(
        f"""
        SELECT asset.*, COALESCE(asset.collected_at, asset.created_at) AS mobile_sort_at
        FROM visible_assets AS asset
        WHERE asset.committed = 1
          AND COALESCE(asset.collected_at, asset.created_at) <= datetime('now', '-30 days')
          {creator_exclusion}
          AND strftime('%m', COALESCE(asset.collected_at, asset.created_at)) = strftime('%m', 'now')
        ORDER BY mobile_sort_at DESC, asset.id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    for row in month_rows:
        if row["id"] not in seen:
            rows.append(row)
            seen.add(row["id"])
            if len(rows) >= limit:
                return rows
    oldest_rows = db.execute(
        f"""
        SELECT asset.*, COALESCE(asset.collected_at, asset.created_at) AS mobile_sort_at
        FROM visible_assets AS asset
        WHERE asset.committed = 1
          AND COALESCE(asset.collected_at, asset.created_at) <= datetime('now', '-30 days')
          {creator_exclusion}
        ORDER BY mobile_sort_at ASC, asset.id ASC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    for row in oldest_rows:
        if row["id"] not in seen:
            rows.append(row)
            seen.add(row["id"])
            if len(rows) >= limit:
                break
    return rows[:limit]


def _revisit_creator_groups(db, limit: int, *, day: int | None = None) -> list[dict]:
    """Rotate through all eligible creators in stable daily groups (UTC).

    With at least six candidates adjacent days do not overlap. No history writes
    or per-refresh randomness: repeated requests on the same day remain stable.
    """
    day = datetime.now(timezone.utc).date().toordinal() if day is None else day
    creators = db.execute(
        """
        SELECT creator_handle,
               COUNT(*) AS asset_count,
               MIN(COALESCE(visible_assets.collected_at, visible_assets.created_at)) AS oldest_at,
               MAX(COALESCE(visible_assets.collected_at, visible_assets.created_at)) AS newest_at
        FROM visible_assets
        WHERE committed = 1
          AND creator_handle IS NOT NULL
          AND creator_handle != ''
        GROUP BY creator_handle
        HAVING COUNT(*) >= 3
          AND MIN(COALESCE(visible_assets.collected_at, visible_assets.created_at)) <= datetime('now', '-30 days')
        ORDER BY creator_handle ASC
        """
    ).fetchall()
    if not creators:
        return []
    start = (day * 3) % len(creators)
    chosen = [creators[(start + index) % len(creators)]
              for index in range(min(3, len(creators)))]
    groups = []
    for creator in chosen[:3]:
        rows = db.execute(
            """
            SELECT asset.*, COALESCE(asset.collected_at, asset.created_at) AS mobile_sort_at
            FROM visible_assets AS asset
            WHERE asset.committed = 1
              AND asset.creator_handle = ?
            ORDER BY mobile_sort_at DESC, asset.id DESC
            LIMIT ?
            """,
            (creator["creator_handle"], min(6, max(4, limit // 3))),
        ).fetchall()
        if len(rows) < 2:
            continue
        groups.append({
            "creator_key": creator["creator_handle"],
            "creator_name": rows[0]["creator_name"] or creator["creator_handle"],
            "creator_handle": creator["creator_handle"],
            "asset_count": creator["asset_count"],
            "rows": rows,
        })
    return groups[:3]


def list_mobile_revisit(
    authorization: str | None = Header(default=None),
    limit: int = Query(default=12, ge=1, le=50),
    home: bool = False,
    day: str | None = None,
):
    """Mobile Home 다시보기. PC revisit.rs의 묶음 유형 중 복제본에서 계산
    가능한 두 가지를 제공한다:

    - date "과거의 이날": 30일 이상 지난 자산 중 오늘의 월/일 ±7일 근처 수집
      자산(PC rediscovery 지향). 부족하면 같은 달의 오래된 자산, 그래도
      부족하면 결정론적 오래된 자산으로 확장한다.
    - creator "다시 만난 작가": 같은 작가(creator_handle)가 3개 이상인 그룹을
      그룹 단위로 돌려준다(flat 목록 아님). 홈에서는 작가별 rail로 렌더링된다.

    rediscovery(다시 만난 자산)는 favorite/asset_activity가 PC 전용 상태라
    복제본에 없어 제공하지 않는다. 정렬은 결정론적(collected_at DESC,
    id DESC)이며 랜덤 SQL 정렬은 없다. 읽기 전용 엔드포인트다.
    """
    if home:
        return list_home_revisit(authorization, day)
    api.require_auth(authorization)
    with api.get_db() as db:
        date_bundle = api._revisit_date_bundle(db, limit)
        creator_groups = api._revisit_creator_groups(db, limit)

        ids = [row["id"] for row in date_bundle]
        for group in creator_groups:
            ids.extend(row["id"] for row in group["rows"])
        memberships: dict[str, list[str]] = {}
        # Same cutover rule as the library listing: the shipped legacy projection is only
        # authoritative while the domain is still PC-owned.
        active = authority.active_domain(db, classification_authority.DOMAIN)
        if active is not None:
            memberships = classification_authority.assignment_projection_many(
                db, active["libraryId"], set(ids))
        elif ids:
            placeholders = ",".join("?" for _ in ids)
            for relation in db.execute(
                f"""
                SELECT asset_id, classification_id
                FROM asset_classifications
                WHERE asset_id IN ({placeholders})
                ORDER BY asset_id, classification_id
                """,
                ids,
            ).fetchall():
                memberships.setdefault(relation["asset_id"], []).append(
                    relation["classification_id"]
                )

    used: set[str] = set()

    def serialize(rows) -> list[dict]:
        items = []
        for row in rows:
            if row["id"] in used:
                continue
            used.add(row["id"])
            item = api.mobile_asset_item(row, memberships.get(row["id"], []))
            items.append(item)
        return items

    groups = []
    for group in creator_groups:
        items = serialize(group["rows"])
        if not items:
            continue
        groups.append({
            "creator_key": group["creator_key"],
            "creator_name": group["creator_name"],
            "creator_handle": group["creator_handle"],
            "asset_count": group["asset_count"],
            "items": items,
        })

    return {
        "bundles": [
            {
                "kind": "date",
                "title": "과거의 이날",
                "reason": "예전에 이맘때 저장한 자산",
                "items": serialize(date_bundle),
            },
            {
                "kind": "creator",
                "title": "다시 만난 작가",
                "reason": "예전에 저장한 작가의 작품",
                "groups": groups,
            },
        ]
    }


def list_mobile_revisit_date(
    authorization: str | None = Header(default=None),
    cursor: str | None = None,
    limit: int = Query(default=50, ge=1, le=100),
):
    """과거의 이날 전체 결과. Home preview와 같은 우선순위(±7일, 같은 달,
    그 외 오래된 자산)를 유지하면서 rank+timestamp+id 커서로 페이지네이션한다."""
    api.require_auth(authorization)
    timestamp_sql = "COALESCE(asset.collected_at, asset.created_at)"
    calendar_distance = api._revisit_calendar_distance_sql(timestamp_sql)
    creator_exclusion = api._revisit_creator_exclusion_sql("asset")
    rank_sql = f"""CASE
        WHEN ({calendar_distance}) <= 7 THEN 0
        WHEN strftime('%m', {timestamp_sql}) = strftime('%m', 'now') THEN 1
        ELSE 2
      END"""
    cursor_clause = ""
    params: list[object] = []
    if cursor is not None:
        cursor_rank, cursor_sort_at, cursor_asset_id = api.decode_revisit_date_cursor(cursor)
        cursor_clause = """
        WHERE revisit_rank > ?
           OR (
             revisit_rank = ? AND (
               mobile_sort_at < ?
               OR (mobile_sort_at = ? AND id < ?)
             )
           )
        """
        params.extend([cursor_rank, cursor_rank, cursor_sort_at, cursor_sort_at, cursor_asset_id])
    params.append(limit + 1)
    with api.get_db() as db:
        db.execute("BEGIN")  # the generation and the rows share one read snapshot
        generation = api.list_generation(db)
        rows = db.execute(
            f"""
            WITH ranked AS (
              SELECT asset.*, {timestamp_sql} AS mobile_sort_at, {rank_sql} AS revisit_rank
              FROM visible_assets AS asset
              WHERE asset.committed = 1
                AND {timestamp_sql} <= datetime('now', '-30 days')
                {creator_exclusion}
            )
            SELECT * FROM ranked
            {cursor_clause}
            ORDER BY revisit_rank ASC, mobile_sort_at DESC, id DESC
            LIMIT ?
            """,
            params,
        ).fetchall()
        has_more = len(rows) > limit
        page_rows = rows[:limit]
        memberships = api._mobile_memberships(db, page_rows)
    items = [api.mobile_asset_item(row, memberships.get(row["id"], [])) for row in page_rows]
    next_cursor = None
    if has_more and page_rows:
        last = page_rows[-1]
        next_cursor = api.encode_revisit_date_cursor(last["revisit_rank"], last["mobile_sort_at"], last["id"])
    return {"items": items, "next_cursor": next_cursor, "has_more": has_more,
            "listGeneration": generation}


def list_mobile_revisit_creator_assets(
    creator_key: str,
    authorization: str | None = Header(default=None),
    cursor: str | None = None,
    sort: Literal["newest", "oldest"] = "newest",
    limit: int = Query(default=50, ge=1, le=100),
):
    """특정 작가의 전체 자산(홈 '모두 보기'). creator_key는 creator_handle
    값이며 파라미터 바인딩으로만 쿼리된다. 커서는 정렬과 묶여 있어 정렬을
    바꾸면 거절된다."""
    api.require_auth(authorization)
    comparison = "<" if sort == "newest" else ">"
    direction = "DESC" if sort == "newest" else "ASC"
    params: list[object] = [creator_key]
    cursor_clause = ""
    if cursor is not None:
        cursor_sort_at, cursor_asset_id = api.decode_mobile_cursor(cursor, sort)
        cursor_clause = f"""
            AND (
                COALESCE(asset.collected_at, asset.created_at) {comparison} ?
                OR (
                    COALESCE(asset.collected_at, asset.created_at) = ?
                    AND asset.id {comparison} ?
                )
            )
        """
        params.extend([cursor_sort_at, cursor_sort_at, cursor_asset_id])
    params.append(limit + 1)
    with api.get_db() as db:
        db.execute("BEGIN")  # the generation and the rows share one read snapshot
        generation = api.list_generation(db)
        rows = db.execute(
            f"""
            SELECT asset.*, COALESCE(asset.collected_at, asset.created_at) AS mobile_sort_at
            FROM visible_assets AS asset
            WHERE asset.committed = 1
              AND asset.creator_handle = ?
              {cursor_clause}
            ORDER BY mobile_sort_at {direction}, asset.id {direction}
            LIMIT ?
            """,
            params,
        ).fetchall()
        has_more = len(rows) > limit
        page_rows = rows[:limit]
        memberships = api._mobile_memberships(db, page_rows)
    items = [api.mobile_asset_item(row, memberships.get(row["id"], [])) for row in page_rows]
    next_cursor = None
    if has_more and page_rows:
        last = page_rows[-1]
        next_cursor = api.encode_mobile_cursor(sort, last["mobile_sort_at"], last["id"])
    return {"items": items, "next_cursor": next_cursor, "has_more": has_more,
            "listGeneration": generation}


def register(app, services):
    global api
    api = services
    app.get("/v1/library/revisit")(list_mobile_revisit)
    app.get("/v1/library/revisit/date")(list_mobile_revisit_date)
    app.get("/v1/library/revisit/creator/{creator_key}/assets")(list_mobile_revisit_creator_assets)
