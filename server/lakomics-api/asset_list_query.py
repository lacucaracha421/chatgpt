"""Shared date/id keyset selection for ordinary Asset pages and their TOCs."""

import re
from datetime import datetime, timedelta, timezone

SORT_AT = "COALESCE(asset.collected_at, asset.created_at)"


def parse_utc_offset_minutes(value: str) -> int:
    """Validate the TOC-only offset; page routes deliberately skip this parser."""
    if not re.fullmatch(r"[+-]?[0-9]+", value):
        raise ValueError("utcOffsetMinutes must be an integer between -720 and 840")
    offset = int(value)
    if not -720 <= offset <= 840:
        raise ValueError("utcOffsetMinutes must be an integer between -720 and 840")
    return offset


class AssetListQuery:
    """A resolved scope and filter set, before any page cursor is applied.

    SQL fragments are supplied by the route, never by request text. Both readers use
    this same selection and ordering, including visibility through ``visible_assets``.
    """

    def __init__(self, from_clause, where_clause, params, sort, *, prefer_id_lookup=False):
        self.from_clause = from_clause
        self.where_clause = where_clause
        self.params = list(params)
        self.sort = sort
        self.direction = "DESC" if sort == "newest" else "ASC"
        self.comparison = "<" if sort == "newest" else ">"
        # Unary + preserves values/order but stops the date index from winning over
        # an indexed artist candidate set. Sort the selected ids, not all Assets.
        self.order_at = f"+{SORT_AT}" if prefer_id_lookup else SORT_AT

    def select(self, columns, *, after=None, limit=None):
        where = self.where_clause
        params = self.params.copy()
        if after is not None:
            # Bound the leading index key so late pages seek past earlier dates.
            # Keep equality here; the existing id predicate resolves date ties.
            # Use order_at to preserve candidate-id lookup for sparse artist scopes.
            where += (f" AND {self.order_at} {self.comparison}= ?"
                      f" AND ({SORT_AT} {self.comparison} ?"
                      f" OR ({SORT_AT} = ? AND asset.id {self.comparison} ?))")
            params.extend([after[0], after[0], after[0], after[1]])
        sql = (f"SELECT {columns} FROM {self.from_clause} WHERE {where}"
               f" ORDER BY {self.order_at} {self.direction}, asset.id {self.direction}")
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        return sql, params

    def page(self, db, limit, after=None):
        sql, params = self.select(f"asset.*, {SORT_AT} AS mobile_sort_at",
                                 after=after, limit=limit)
        return db.execute(sql, params).fetchall()

    def toc(self, db, generation, encode_cursor, utc_offset_minutes=0):
        """Count ordered month runs and mint their preceding-row cursors.

        The caller holds the read transaction that also supplied ``generation``.
        Stream only date/id, keeping memory proportional to the bucket count.
        Using the actual ordering avoids a separate boundary query and preserves the
        id tie-break even when many Assets share a timestamp at a month edge.
        """
        # Month keys use the viewer's offset from UTC. Legacy naive timestamps are
        # UTC too. Parse without SQLite's millisecond rounding, which
        # would move 23:59:59.999999 at a month edge into the following month.
        offset = timedelta(minutes=utc_offset_minutes)
        sql, params = self.select(f"asset.id, {SORT_AT} AS mobile_sort_at")
        buckets = []
        total = 0
        previous = None
        for row in db.execute(sql, params):
            instant = datetime.fromisoformat(row["mobile_sort_at"].replace("Z", "+00:00"))
            if instant.tzinfo is not None:
                instant = instant.astimezone(timezone.utc)
            instant += offset
            month = f"{instant.year:04d}-{instant.month:02d}"
            if not buckets or buckets[-1]["key"] != month:
                buckets.append({"key": month, "startIndex": total, "count": 0,
                                "startCursor": encode_cursor(previous) if previous else None})
            buckets[-1]["count"] += 1
            total += 1
            previous = (row["mobile_sort_at"], row["id"])
        return {"tocVersion": 1, "listGeneration": generation, "totalCount": total,
                "sort": self.sort, "utcOffsetMinutes": utc_offset_minutes, "buckets": buckets}
