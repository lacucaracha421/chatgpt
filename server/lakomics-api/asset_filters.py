"""One Asset filter vocabulary for every mobile gallery scope.

The ordinary library, Album contents and Character scopes all offer the same three
controls, so the predicates live here once. A second copy of the arithmetic would
drift, and a drifted copy is exactly how one screen disagrees with another about
which Assets are "square".

PC owns the vocabulary: ``query.rs`` defines the same ``images``/``videos`` buckets
(GIF counts as an image) and the same inclusive aspect arithmetic. The Android client
mirrors them in ``mobile-client/assetFilters.ts``.

Three properties are deliberate:

* unknown metadata is never guessed. A row whose dimension is NULL, non-positive or not
  an integer cannot satisfy an aspect bucket, and only a video with a known non-negative
  duration can satisfy a duration bound;
* filtering happens in SQL, before a page is cut, so ``limit`` counts matching Assets
  rather than post-filter survivors of an arbitrary page;
* a filter change is a different query, not a decoration on top of one. The cursor
  therefore carries the filter identity (see :func:`encode_cursor`), so a page from one
  filter set can never be resumed inside another.
"""
import base64
import binascii
import json
from typing import Literal

from fastapi import HTTPException

#: Advertised contract version. Present on every filtered *and* unfiltered response
#: so an older server (no field) is distinguishable from a server that applied no
#: filter. Clients require it before they present a filtered list.
FILTER_VERSION = 1

MEDIA_KINDS: dict[str, tuple[str, ...]] = {"images": ("image", "gif"), "videos": ("video",)}
ASPECT_PREDICATES: dict[str, str] = {
    "square": "{alias}.width * 5 >= {alias}.height * 4 AND {alias}.width * 4 <= {alias}.height * 5",
    "landscape": "{alias}.width * 4 > {alias}.height * 5",
    "portrait": "{alias}.width * 5 < {alias}.height * 4",
}

#: SQLite stores both bounds as a signed i64, so a value outside this range is not a
#: filter the database could evaluate; it is a rejected request.
BOUND_MAX = 9_223_372_036_854_775_807

MediaKind = Literal["images", "videos"]
AspectRatio = Literal["square", "landscape", "portrait"]


class Filters:
    """One request's resolved Asset filters.

    ``None`` always means "not filtered". The mobile galleries spell "everything" as
    an absent parameter, so a control at its resting value adds nothing to the URL and
    the request stays byte-identical to the pre-filter contract.
    """

    __slots__ = ("aspect", "duration_max", "duration_min", "media")

    def __init__(self, media=None, aspect=None, duration_min=None, duration_max=None):
        self.media = media
        self.aspect = aspect
        self.duration_min = duration_min
        self.duration_max = duration_max

    @property
    def active(self) -> bool:
        return any(value is not None for value in
                   (self.media, self.aspect, self.duration_min, self.duration_max))

    @property
    def duration(self) -> bool:
        """A duration bound is a video-only control.

        PC has no duration filter and stores a value only for videos, so a bound
        cannot be satisfied by an image or a GIF — including a GIF whose real
        animation length is known locally but not on the server.
        """
        return self.duration_min is not None or self.duration_max is not None

    def identity(self) -> list:
        """Stable JSON-able identity, used as the cursor's filter binding."""
        return [self.media, self.aspect, self.duration_min, self.duration_max]


def parse(media=None, aspect=None, duration_min=None, duration_max=None) -> Filters:
    """Resolve the query parameters, or reject the request.

    Bounds are compared as integers, so ``min == max`` — an empty range that can never
    match — is refused rather than answered with a misleading empty page.
    """
    if duration_min is not None and duration_max is not None and duration_min >= duration_max:
        raise HTTPException(400, "duration_ms_min must be less than duration_ms_max")
    return Filters(media, aspect, duration_min, duration_max)


def filter_clause(filters: Filters, alias: str = "asset") -> tuple[str, list]:
    """The filter as an ``AND`` fragment ready to interpolate into a ``WHERE``, plus bindings.

    Every predicate degrades on unknown metadata rather than guessing: a dimension needs
    ``typeof`` integer and positive, and a duration bound needs a video whose duration is a
    known non-negative integer. SQLite's NULL comparison would already exclude those rows,
    but stating it keeps a non-integer column value from deciding a bucket by accident.

    The fragment is empty when nothing is filtered, so an unfiltered statement stays
    character-for-character what it was before filters existed.
    """
    conditions: list[str] = []
    params: list = []
    if filters.media is not None:
        placeholders = ",".join("?" for _ in MEDIA_KINDS[filters.media])
        conditions.append(f"{alias}.kind IN ({placeholders})")
        params.extend(MEDIA_KINDS[filters.media])
    if filters.aspect is not None:
        known = (f"typeof({alias}.width) = 'integer' AND {alias}.width > 0"
                 f" AND typeof({alias}.height) = 'integer' AND {alias}.height > 0")
        conditions.append(
            f"({known} AND ({ASPECT_PREDICATES[filters.aspect].format(alias=alias)}))")
    if filters.duration:
        known = (f"{alias}.kind = 'video' AND {alias}.duration_ms IS NOT NULL"
                 f" AND typeof({alias}.duration_ms) = 'integer' AND {alias}.duration_ms >= 0")
        bounds = []
        if filters.duration_min is not None:
            bounds.append(f"{alias}.duration_ms >= ?")
            params.append(filters.duration_min)
        if filters.duration_max is not None:
            bounds.append(f"{alias}.duration_ms < ?")
            params.append(filters.duration_max)
        conditions.append(f"({known} AND {' AND '.join(bounds)})")
    if not conditions:
        return "", params
    return " AND " + " AND ".join(conditions), params


def encode_cursor(kind: str, filters: Filters, payload: list) -> str:
    """Bind one cursor to its scope's own identity, its read, and its filter identity.

    The envelope is ``{"kind": …, "p": payload, "filters": […]}`. The filter identity is
    always all four explicit slots, so a cursor minted with no filter says so rather than
    omitting the field, and a cursor that differs from the request in any of them can only
    be rejected. The ``payload`` is the scope's own layout, which each route owns: the read
    tag names which one that is, so a cursor cannot be replayed against a different read.
    """
    return base64.urlsafe_b64encode(json.dumps(
        {"filters": filters.identity(), "kind": kind, "p": payload},
        ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()).rstrip(b"=").decode()


def decode_cursor(cursor, kind: str, filters: Filters, status: int, detail, lead=None):
    """Resolve one cursor, or reject it by raising ``HTTPException(status, detail)``.

    Every rejection below is the same rejection, because each one means the cursor cannot
    faithfully answer the request it arrived with:

    * the shape — a pre-filter cursor was the bare payload list, and only an unfiltered
      request may still use one. Anything that is neither that list nor a well-formed
      envelope is malformed, not a cursor;
    * the read — the envelope's tag must name the scope that minted it;
    * the scope identity, when the caller passes ``lead`` and the cursor is the current
      enveloped form — the payload's leading slots must equal it, so a cursor for another
      Album, node, filter, revision or classification is refused. A pre-filter cursor is
      exempt, because it cannot carry that identity: the caller re-validates its own layout
      after this returns, which is where scope is enforced for the legacy shape;
    * the filter identity — every slot must equal this request's, so resuming under another
      filter set, or under no filter at all, is refused.

    ``detail`` is passed through untouched, so a caller with a coded error keeps exactly the
    shape its other validations use rather than leaking a raw string.
    """
    # A cursor arrives as a query string, so it is text at most; refusing anything else up
    # front keeps a non-text caller from turning this rejection into a ``TypeError``.
    if not isinstance(cursor, str):
        raise HTTPException(status, detail)
    try:
        padding = "=" * (-len(cursor) % 4)
        decoded = json.loads(base64.b64decode(cursor + padding, altchars=b"-_", validate=True))
        if isinstance(decoded, list):
            # Only the layouts actually shipped before filters may omit the envelope.
            legacy_lengths = {"library-assets": 3, "album-assets": 4, "character-assets": 4}
            if len(decoded) != legacy_lengths.get(kind):
                raise ValueError
            payload, bound = decoded, None
        elif isinstance(decoded, dict):
            tag, bound, payload = decoded["kind"], decoded["filters"], decoded["p"]
            if (tag != kind or not isinstance(bound, list) or not isinstance(payload, list)
                    or len(payload) != 4):
                raise ValueError
        else:
            raise ValueError
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError,
            KeyError, AttributeError, IndexError):
        raise HTTPException(status, detail)
    if bound is not None and payload[:len(lead or [])] != list(lead or []):
        raise HTTPException(status, detail)
    if bound is not None and bound != filters.identity():
        raise HTTPException(status, detail)
    # Callers validate the legacy sort/Album/Character scope slots separately.
    if bound is None and filters.active:
        raise HTTPException(status, detail)
    return payload


def technical_fields(row) -> dict:
    """The three technical fields of the mobile Asset projection, canonically typed.

    Unknown stays ``None``; zero is a legal duration and is kept; a non-positive
    dimension is unknown, never a fabricated ``0``. Read by name so a caller can hand
    over a bare ``SELECT id,width,height,duration_ms`` row.
    """
    return {"width": _dimension(row, "width"), "height": _dimension(row, "height"),
            "duration_ms": _duration_ms(row, "duration_ms")}


def _dimension(row, column):
    try:
        value = row[column]
    except (IndexError, KeyError):
        return None
    return value if isinstance(value, int) and not isinstance(value, bool) and value > 0 else None


def _duration_ms(row, column):
    try:
        value = row[column]
    except (IndexError, KeyError):
        return None
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def require_strings(values, status: int, detail: str):
    """Reject a decoded cursor payload whose scope fields are not non-empty strings."""
    if not all(isinstance(value, str) and value for value in values):
        raise HTTPException(status, detail)
    return values
