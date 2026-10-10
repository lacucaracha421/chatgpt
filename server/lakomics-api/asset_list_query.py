"""Shared date/id keyset selection for ordinary Asset pages and their TOCs."""

import hashlib
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


#: Sorts that rank rows by a computed key instead of the shared date/id keyset.
RANKED_SORTS = ("favorites", "random")
SEED_PATTERN = re.compile(r"[0-9A-Za-z]{8,64}")


def shuffle_rank(seed, asset_id) -> int:
    """A stable 56-bit position for one Asset under one client-supplied seed.

    The rank depends only on ``seed`` and the Asset id, so every page of one shuffle sees
    the same total order and a new seed is a new, unrelated order. 56 bits keep the value
    inside SQLite's signed integer range; a tie falls through to the Asset id.
    """
    digest = hashlib.blake2b(f"{seed}\0{asset_id}".encode(), digest_size=7).digest()
    return int.from_bytes(digest, "big")


def sort_identity(sort: str, seed: str | None) -> str:
    """The cursor's sort slot: a shuffle is bound to its seed, so a reshuffle never resumes."""
    return f"random:{seed}" if sort == "random" else sort


def ranked_after(sort: str, key: str, asset_id: str):
    """Decode the cursor's ``(key, id)`` slots for a ranked sort, or raise ``ValueError``."""
    if sort == "random":
        if not re.fullmatch(r"[0-9]{1,19}", key):
            raise ValueError("rank")
        return int(key), asset_id
    liked, separator, sort_at = key.partition(":")
    if liked not in ("0", "1") or separator != ":" or not sort_at:
        raise ValueError("favorites")
    return int(liked), sort_at, asset_id


class RankedAssetListQuery:
    """``favorites`` (liked first, then newest) and ``random`` (seeded) listings.

    It exposes the same ``page`` shape as :class:`AssetListQuery` so the route reads rows
    the same way, but there is deliberately no ``toc``: neither order is chronological, so
    a month index would describe positions the listing does not have.

    * ``favorites`` mirrors the PC (``query.rs`` ``FAVORITES_SQL``): liked Assets first,
      then ``collected_at DESC, id DESC``. ``liked_sql`` is the route's membership test
      for the Likes album, or ``0`` while no album authority is active.
    * ``random`` orders by :func:`shuffle_rank` of ``(seed, id)`` with the id as the
      tiebreak. The seed is a request parameter, so paging is stable and a reshuffle is
      simply a new seed.
    """

    def __init__(self, from_clause, where_clause, params, sort, *, seed=None,
                 liked_sql="0", liked_params=()):
        if sort not in RANKED_SORTS:
            raise ValueError(sort)
        if sort == "random" and not seed:
            raise ValueError("seed")
        self.from_clause = from_clause
        self.where_clause = where_clause
        self.params = list(params)
        self.sort = sort
        self.seed = seed
        self.liked_sql = liked_sql
        self.liked_params = list(liked_params)

    def select(self, *, after=None, limit=None):
        if self.sort == "random":
            rank_sql, rank_params = "shuffle_rank(?, asset.id)", [self.seed]
        else:
            rank_sql, rank_params = f"({self.liked_sql})", self.liked_params
        inner = (f"SELECT asset.*, {SORT_AT} AS mobile_sort_at, {rank_sql} AS mobile_rank"
                 f" FROM {self.from_clause} WHERE {self.where_clause}")
        params = rank_params + self.params
        outer = ""
        if after is not None:
            if self.sort == "random":
                outer = " WHERE (mobile_rank > ? OR (mobile_rank = ? AND id > ?))"
                params.extend([after[0], after[0], after[1]])
            else:
                outer = (" WHERE (mobile_rank < ? OR (mobile_rank = ? AND (mobile_sort_at < ?"
                         " OR (mobile_sort_at = ? AND id < ?))))")
                params.extend([after[0], after[0], after[1], after[1], after[2]])
        if self.sort == "random":
            order = " ORDER BY mobile_rank ASC, id ASC"
        else:
            order = " ORDER BY mobile_rank DESC, mobile_sort_at DESC, id DESC"
        sql = f"SELECT * FROM ({inner}){outer}{order}"
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        return sql, params

    def page(self, db, limit, after=None):
        if self.sort == "random":
            db.create_function("shuffle_rank", 2, shuffle_rank, deterministic=True)
        sql, params = self.select(after=after, limit=limit)
        return db.execute(sql, params).fetchall()

    @staticmethod
    def cursor_key(sort: str, row) -> str:
        """The cursor's key slot for the last row of a page."""
        if sort == "random":
            return str(row["mobile_rank"])
        return f"{int(row['mobile_rank'])}:{row['mobile_sort_at']}"
