"""Scoped repair of missing Asset display metadata from a PC metadata snapshot.

Some committed Assets reached the cloud without ``width``/``height`` (images) or a
video duration: the original commit omitted the field, or the row predates the
dimension migration. Ordinary readers already treat NULL as "unknown" and never guess,
so a historical NULL only costs the mobile aspect/duration filters — it does not break
a read. Filling it is therefore a *scoped repair*, not a migration, and this module is
the whole of it: given a PC metadata snapshot, propose exactly the Assets that are
missing something this snapshot can supply, then apply the accepted candidates one
guarded transaction at a time.

# This module is not a worker

Nothing here polls, schedules, retries or starts a thread. There is no new queue and no
new table: the existing ``asset_list_update`` trigger already bumps the mobile list
generation for any committed Asset change, so a repaired row reaches clients through
the shipped path. An operator runs :func:`proposal` to review a snapshot, then
:func:`apply` for the reviewed candidates. Backup, manifest and the extraction of the
snapshot itself stay with the operator and the PC side; this module never reads the
production library, never touches object storage and never contacts the PC.

# Identity must match exactly, and the snapshot is untrusted input

A candidate is accepted only when the cloud Asset and the PC row agree on **identity**
— ``assets.id`` equals the PC asset id, ``assets.sha256`` equals the PC
``content_hash``, ``assets.size_bytes`` equals the PC ``byte_size``, and ``assets.kind``
equals the PC ``media_kind`` — and the PC row is ``status='normal'``. Identity is the
whole gate: a same-content Asset that was re-committed under a new ``sha256`` at the
same size would satisfy size alone, which is why the digest is compared too, and a
replaced Asset is rejected rather than repaired from the old snapshot's numbers.

Every field of a snapshot record is validated before it is trusted, because the
snapshot travels from another machine and another schema: unknown keys, a non-integer
or out-of-range value, or a video duration reported for a non-video are all refusals,
not something to normalize away. A repaired row feeds the aspect/duration filters, so a
fabricated ``0`` or a negative dimension would be a lasting wrong answer rather than a
missing one.

# What apply preserves

The write is deliberately a repair, never a projection of the PC row:

* only ``width``, ``height`` and ``duration_ms`` are ever written. ``thumbnail_key``,
  ``object_key``, ``content_type``, ``sha256``, ``size_bytes``, ``kind``, the identity
  and lifecycle columns, ``created_at`` and every column this module does not name are
  untouched;
* only NULL fields are filled. An existing non-NULL value is never overwritten, so a
  server-side value that disagrees with the snapshot is left alone rather than replaced
  by a stale PC number;
* ``updated_at`` is preserved. The existing Asset update trigger advances the list
  generation, so repairing technical metadata does not alter source chronology;
* partial dimensions are filled only when the known side agrees. Because the update is
  per-column ``COALESCE``, a missing side is *not* filled when the existing side
  disagrees with the snapshot pair — filling it would invent a width/height combination
  neither side ever observed. The pair is atomic: either both sides come from the
  snapshot, or neither does. Duration is independent of pixel geometry, so a video's
  duration is still filled when its dimensions conflict.

# Apply is guarded by current committed identity

The guard is re-read inside the same transaction as the write, against the shipped
``visible_assets`` projection, under ``BEGIN IMMEDIATE`` so the read and the
compare-and-set cannot be separated by a concurrent replication commit or lifecycle
command. An Asset that was trashed, tombstoned, uncommitted, deleted, replaced or
renamed in the meantime is reported and left untouched: the update matches on id,
sha256, size and kind and requires that the row is still present and committed. A
candidate is applied at most once — re-running a fully applied candidate finds nothing
NULL to fill and reports it as skipped — which is what makes an interrupted run safely
repeatable.

# Reporting carries no secrets

Results and log lines carry an Asset id, a coded reason and counts. They never carry an
object key, a signed URL, a snapshot path, a credential or raw exception text: the
report is meant to be pasted into a review, not scrubbed first.
"""
from __future__ import annotations


import json
import logging


from asset_visibility import install as install_visibility

LOG = logging.getLogger("lakomics.asset-metadata-repair")

#: Repairable kinds, exactly the vocabulary ``assets.kind`` already uses. A kind outside
#: this set is not repaired rather than being guessed at.
MEDIA_KINDS = ("image", "gif", "video")
GEO_KINDS = ("image", "gif")
VIDEO_KIND = "video"

# Match ReplicationCommit's u32 metadata dimensions. This path imports numbers,
# not decoded pixels, so the thumbnail encoder's memory budget does not apply.
MAX_DIMENSION = 4_294_967_295
MAX_DURATION_MS = 9_223_372_036_854_775_807

#: Statuses eligible for repair, exactly the PC ``assets.status`` values.
NORMAL_STATUSES = ("normal",)

#: Outcome vocabulary. Stable strings, safe to compare in a test and safe to log.
#: Every outcome names the *first* reason a candidate did not proceed, so a report reads
#: as a diagnosis rather than a single "did not apply" bucket.
FILLED = "filled"
COMPLETE = "complete"
CONFLICT = "conflict"
NOT_FOUND = "notFound"
HIDDEN = "hidden"
UNCOMMITTED = "uncommitted"
REPLACED = "replaced"
INVALID = "invalid"

#: Fields a caller may pass through ``fields`` to narrow a repair. Default is all three.
DEFAULT_FIELDS = ("width", "height", "duration_ms")
REPAIRABLE_COLUMNS = ("width", "height", "duration_ms")

#: Identity columns a snapshot row must state. The extraction query below and the
#: validator above are the two halves of one contract, so they name the same set.
IDENTITY_KEYS = ("id", "sha256", "size_bytes", "kind")


class SnapshotError(ValueError):
    """A snapshot that is not the reviewed shape. Refused whole, never partially read."""


# ---------------------------------------------------------------------------
# Extraction: the snapshot's own contract, separate from extraction tooling
# ---------------------------------------------------------------------------

def extraction_query():
    """The exact SQL an extraction tool for the PC library should run.

    Provided so the extraction script and this module cannot drift on which fields
    identity requires. It is deliberately one plain ``SELECT`` with no side effect: this
    module still never opens the production library, the operator owns running it.
    """
    return (
        "SELECT a.id, a.content_hash AS sha256, a.byte_size AS size_bytes, a.media_kind AS kind, a.status,"
        " a.width, a.height, v.duration_ms"
        " FROM assets AS a LEFT JOIN video_assets AS v ON v.asset_id = a.id"
        " WHERE a.status = 'normal'"
        " ORDER BY a.id")


# ---------------------------------------------------------------------------
# Snapshot parsing and candidate proposal
# ---------------------------------------------------------------------------

def _text(value):
    """A non-empty trimmed string, or ``None``."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _dimension(value):
    """An in-range pixel dimension, or ``None``. ``bool`` is not an integer here."""
    if type(value) is not int:
        return None
    if value < 1 or value > MAX_DIMENSION:
        return None
    return value


def _duration(value):
    """An in-range non-negative duration, or ``None``. ``0`` is a real duration."""
    if type(value) is not int:
        return None
    if value < 0 or value > MAX_DURATION_MS:
        return None
    return value


def _pixel_pair(width, height, position):
    """A validated ``(width, height)`` pair, or ``None`` when either side is absent.

    Rejects a half-stated pair rather than repairing from one side: a snapshot that
    carries a width and no height cannot supply a second dimension, and inventing one
    from an aspect guess is exactly the fabricated metadata this module exists to avoid.
    """
    if width is None and height is None:
        return None
    checked_width, checked_height = _dimension(width), _dimension(height)
    if width is not None and checked_width is None:
        raise SnapshotError(f"record {position} has an invalid width")
    if height is not None and checked_height is None:
        raise SnapshotError(f"record {position} has an invalid height")
    if checked_width is None or checked_height is None:
        raise SnapshotError(f"record {position} states only one dimension")

    return (checked_width, checked_height)


def parse_records(records):
    """Validate snapshot records into a validated ``{asset_id: source}`` mapping.

    Refuses the snapshot whole on any invalid record rather than dropping it: a record
    that cannot be validated means the snapshot is not the reviewed shape, and silently
    skipping it would understate what the run covered. A single ``asset_id`` stated
    twice is the same kind of refusal — two records for one Asset is a disagreement the
    caller has to resolve, not something to pick a winner from.
    """
    if isinstance(records, (str, bytes)) or not hasattr(records, "__iter__"):
        raise SnapshotError("snapshot must be a sequence of records")
    sources: dict[str, dict] = {}
    for position, record in enumerate(records):
        if not isinstance(record, dict):
            raise SnapshotError(f"record {position} is not an object")
        asset_id = _text(record.get("id"))
        if asset_id is None:
            raise SnapshotError(f"record {position} has no asset id")
        sha256 = _text(record.get("sha256"))
        if sha256 is None or len(sha256) != 64 or any(c not in "0123456789abcdef" for c in sha256.lower()):
            raise SnapshotError(f"record {position} has no sha256 content hash")
        sha256 = sha256.lower()
        byte_size = record.get("size_bytes")
        if type(byte_size) is not int or byte_size < 0:
            raise SnapshotError(f"record {position} has no integer byte size")
        kind = _text(record.get("kind"))
        if kind not in MEDIA_KINDS:
            raise SnapshotError(f"record {position} has an unsupported media kind")
        status = _text(record.get("status"))
        if status is None or status not in NORMAL_STATUSES:
            # Not an error: a trashed or tombstoned Asset is simply not repairable. It is
            # dropped here so a caller can see how many rows a snapshot carried against
            # how many were eligible.
            continue
        pair = _pixel_pair(record.get("width"), record.get("height"), position)
        duration = record.get("duration_ms")
        if duration is not None and _duration(duration) is None:
            raise SnapshotError(f"record {position} has an invalid video duration")
        if duration is not None and kind != VIDEO_KIND:
            # A duration on an image is a shape error, not a value to ignore.
            raise SnapshotError(f"record {position} states a duration for a non-video")
        source = {"id": asset_id, "sha256": sha256, "size_bytes": byte_size,
                  "kind": kind, "status": status, "pair": pair,
                  "duration_ms": duration if kind == VIDEO_KIND else None,
                  "geometric": kind in GEO_KINDS or kind == VIDEO_KIND}
        if asset_id in sources:
            raise SnapshotError(f"asset {asset_id} is stated twice")
        sources[asset_id] = source
    return sources


def _snapshot_rows(snapshot):
    """Records from either a validated mapping or a raw record sequence."""
    if isinstance(snapshot, dict) and not any(key in snapshot for key in IDENTITY_KEYS):
        # A JSON object keyed by asset id, as an extraction tool naturally emits.
        return [{"id": key, **value} if isinstance(value, dict) else value
                for key, value in snapshot.items()]
    if isinstance(snapshot, dict):
        return [snapshot]
    return snapshot


def load_snapshot(source):
    """Read snapshot records from a file path or a file object.

    JSON only: the extraction side writes deterministic JSON, and accepting a second
    format would mean two parsers free to disagree about what identity is.
    """
    if hasattr(source, "read"):
        return parse_records(_snapshot_rows(json.load(source)))
    with open(source, "r", encoding="utf-8") as handle:
        return parse_records(_snapshot_rows(json.load(handle)))


def _asset_row(db, asset_id):
    """The cloud Asset as an ordinary reader sees it, or ``None``.

    Read through the shipped ``visible_assets`` projection, not a re-derived rule, so
    "hidden" here means exactly what it means to mobile: ``None`` covers both "the row
    is gone" and "an ordinary reader must not see it".
    """
    return db.execute("SELECT * FROM visible_assets WHERE id=?", [asset_id]).fetchone()


def _asset_state(db, asset_id):
    """Raw identity of the Asset row, including whether it exists and is committed.

    Separate from :func:`_asset_row` because the repair must distinguish *why* an Asset
    is not repairable: a row that is present but hidden or uncommitted is a different
    operator question from one that does not exist at all.
    """
    return db.execute(
        "SELECT id,kind,sha256,size_bytes,width,height,duration_ms,committed"
        " FROM assets WHERE id=?", [asset_id]).fetchone()


def _fields(value):
    if value is None:
        return frozenset(DEFAULT_FIELDS)
    requested = frozenset(value)
    unknown = requested - set(REPAIRABLE_COLUMNS)
    if unknown:
        raise ValueError(f"unknown repair field(s): {sorted(unknown)}")
    return requested


def _planned(row, source, fields):
    """The concrete fills a guarded write would make, plus any genuine conflicts.

    Pure, so the same function decides what :func:`proposal` shows and what
    :func:`apply` writes: a proposal cannot advertise a fill the apply would not make.

    Width and height are decided **as a pair**. They are only offered when the snapshot
    states both *and* any existing side agrees with its counterpart, because filling one
    missing side from a pair the other side contradicts would record a pixel geometry
    neither the PC nor the cloud ever observed. Duration is decided independently: it
    carries no pixel relationship, so an image's geometry conflict cannot veto a video's
    duration.
    """
    pair = source["pair"]
    agree = False
    width = height = None
    if pair is not None:
        width, height = pair[0], pair[1]
        agree = all(row[field] is None or row[field] == pair[index]
                    for index, field in enumerate(("width", "height")))
    known = {"width": width if agree else None, "height": height if agree else None,
             "duration_ms": source["duration_ms"]}
    planned, conflicts = {}, []
    for column in REPAIRABLE_COLUMNS:
        if column not in fields:
            continue
        current, candidate = row[column], known[column]
        if current is not None:
            # An existing value is authoritative: never overwritten, and only a genuine
            # disagreement is worth reporting as a conflict.
            if candidate is not None and candidate != current:
                conflicts.append(column)
        elif candidate is not None:
            planned[column] = candidate
        elif (pair is not None and column in ("width", "height") and not agree
              and row["height" if column == "width" else "width"] is not None):
            # The pair is present but the row's other side contradicts it, so neither side
            # is written and the Asset stays as it was. The row is named, not the rejected
            # counterpart: "geometry" is the disagreement, and the operator compares the
            # pair themselves rather than reading a column pick this function made.
            conflicts.append("geometry")
    return planned, dict.fromkeys(conflicts)


def proposal(db, snapshot, *, fields=None, limit=None):
    """Snapshot-only candidates: what *can* be filled, with no write and no lock.

    Returned records describe intent, not an outcome. ``proposal`` deliberately does not
    re-read the Asset rows: making it a pure function of the snapshot means an operator
    reviews the same list twice and gets the same answer, and means a proposal run
    cannot be mistaken for something that already reconciled the cloud. :func:`apply` is
    where the cloud is consulted, under its guard.
    """
    requested = _fields(fields)
    sources = snapshot if isinstance(snapshot, dict) else parse_records(_snapshot_rows(snapshot))
    records, counts = [], {"snapshotRows": len(sources), "candidates": 0,
                          "complete": 0, "byKind": {}}
    for asset_id in sorted(sources):
        source = sources[asset_id]
        pair = source["pair"]
        fills = {"width": pair[0] if pair else None,
                 "height": pair[1] if pair else None,
                 "duration_ms": source["duration_ms"]}
        # A candidate is a snapshot Asset that carries at least one field this run would
        # write. Which of them the cloud is actually missing is a question only
        # :func:`apply` can answer, under its guard, against the real row.
        fills = {column: value for column, value in fills.items()
                 if column in requested and value is not None}
        if not fills:
            counts["complete"] += 1
            continue
        counts["candidates"] += 1
        counts["byKind"][source["kind"]] = counts["byKind"].get(source["kind"], 0) + 1
        records.append({"asset_id": asset_id, "kind": source["kind"],
                        "sha256": source["sha256"], "size_bytes": source["size_bytes"],
                        "width": fills.get("width"), "height": fills.get("height"),
                        "duration_ms": fills.get("duration_ms")})
    if limit is not None:
        records = records[:limit]
    return {"records": records, "counts": counts}


# ---------------------------------------------------------------------------
# Apply: one guarded transaction per candidate
# ---------------------------------------------------------------------------

def _empty_counts():
    return {"considered": 0, "filled": 0, "complete": 0, "notFound": 0,
            "hidden": 0, "uncommitted": 0, "replaced": 0, "conflict": 0,
            "invalid": 0,
            "fieldsFilled": {"width": 0, "height": 0, "duration_ms": 0}}


def _classify(row, visible, source):
    """Why a candidate is not repairable, or ``None`` when it may proceed.

    Ordered so the reported reason names the *first* thing that is wrong: "there is no
    such Asset" is a different operator question from "it exists but an ordinary reader
    must not see it", which is different again from "it was replaced since the snapshot".
    """
    if row is None:
        return NOT_FOUND
    if visible is None:
        return HIDDEN
    if not row["committed"]:
        # Separate from visibility on purpose: the legacy projection can expose an
        # uncommitted row, and the repair requires a committed Asset either way.
        return UNCOMMITTED
    if row["sha256"] != source["sha256"] or row["size_bytes"] != source["size_bytes"]:
        return REPLACED
    if row["kind"] != source["kind"]:
        return REPLACED
    return None


def apply(db, snapshot, *, fields=None, dry_run=False):
    """Apply snapshot candidates, one ``BEGIN IMMEDIATE`` transaction per candidate.

    Each candidate is committed on its own so an interruption leaves a prefix of applied
    Assets rather than an all-or-nothing run nobody can resume; re-running the same
    snapshot finishes the rest and re-reports the applied ones as skipped. ``dry_run``
    performs the same guarded reads and reports the same classifications without
    writing.

    ``db`` must be a connection whose ``visible_assets`` projection is installed (see
    :func:`install`); ``commit``/``rollback`` are used directly, so pass a connection
    that is not already inside an open transaction.
    """
    requested = _fields(fields)
    try:
        sources = snapshot if isinstance(snapshot, dict) else parse_records(_snapshot_rows(snapshot))
    except SnapshotError as error:
        # Refused whole: a partial read would understate coverage and the review depends
        # on knowing it was refused rather than quietly smaller.
        result = {"records": [], "counts": _empty_counts(), "dryRun": bool(dry_run)}
        result["counts"]["invalid"] = 1
        result["error"] = str(error)
        return result
    counts = _empty_counts()
    records = []
    for asset_id in sorted(sources):
        source = sources[asset_id]
        counts["considered"] += 1
        outcome = _apply_one(db, asset_id, source, requested, dry_run)
        counts[outcome["outcome"]] += 1
        if outcome["outcome"] == FILLED:
            for column in outcome["fields"]:
                counts["fieldsFilled"][column] += 1
        records.append(outcome)
    counts["records"] = len(records)
    return {"records": records, "counts": counts, "dryRun": bool(dry_run)}


def _apply_one(db, asset_id, source, requested, dry_run):
    db.execute("BEGIN IMMEDIATE")
    try:
        visible = _asset_row(db, asset_id)
        row = _asset_state(db, asset_id)
        reason = _classify(row, visible, source)
        if reason is not None:
            db.execute("ROLLBACK")
            return {"asset_id": asset_id, "outcome": reason, "fields": {},
                    "kind": source["kind"], "conflict": []}
        planned, conflicts = _planned(row, source, requested)
        if not planned:
            # Nothing NULL that this snapshot can fill. A genuine disagreement between a
            # known value and the snapshot is named; anything else is simply "already
            # complete", which is what makes a repeated run idempotent.
            db.execute("ROLLBACK")
            return {"asset_id": asset_id,
                    "outcome": CONFLICT if conflicts else COMPLETE,
                    "fields": {}, "kind": source["kind"],
                    "conflict": sorted(conflicts)}
        if dry_run:
            db.execute("ROLLBACK")
            return {"asset_id": asset_id, "outcome": FILLED, "fields": planned,
                    "kind": source["kind"], "conflict": sorted(conflicts),
                    "dryRun": True}
        # The compare-and-set is one statement, so identity and the write cannot be
        # separated. Every untouched column keeps its value by not being named; the
        # per-column COALESCE guarantees a value that appeared since the read wins.
        assignments = ", ".join(f"{column}=COALESCE({column},?)" for column in planned)
        updated = db.execute(
            f"UPDATE assets SET {assignments}"
            " WHERE id=? AND sha256=? AND size_bytes=? AND kind=? AND committed=1",
            [*planned.values(), asset_id, source["sha256"],
             source["size_bytes"], source["kind"]]).rowcount
        if not updated:
            db.execute("ROLLBACK")
            return {"asset_id": asset_id, "outcome": REPLACED, "fields": {},
                    "kind": source["kind"], "conflict": []}
        db.commit()
    except BaseException:
        db.rollback()
        raise
    return {"asset_id": asset_id, "outcome": FILLED, "fields": planned,
            "kind": source["kind"], "conflict": sorted(conflicts)}



def report(result, *, sample=0):
    """A pasteable, secret-free summary of an :func:`apply` result.

    Never prints an object key, a URL, a snapshot path or an Asset's content: the counts
    and coded outcomes are the whole of it, plus at most ``sample`` Asset ids when a
    caller asks for them explicitly.
    """
    counts = result["counts"]
    lines = ["asset metadata repair: " + ("dry run " if result.get("dryRun") else "") +
             f"considered={counts['considered']} filled={counts['filled']}"
             f" complete={counts['complete']} conflict={counts['conflict']}"
             f" notFound={counts['notFound']} hidden={counts['hidden']}"
             f" uncommitted={counts['uncommitted']} replaced={counts['replaced']}"
             f" invalid={counts['invalid']}"]
    if counts["filled"]:
        filled = counts["fieldsFilled"]
        lines.append(f"fields filled: width={filled['width']} height={filled['height']}"
                     f" duration_ms={filled['duration_ms']}")
    if result.get("error"):
        lines.append(f"refused: {result['error']}")
    if sample:
        interesting = [record for record in result["records"]
                       if record["outcome"] in (FILLED, CONFLICT, REPLACED, HIDDEN)]
        for record in interesting[:sample]:
            lines.append(f"{record['outcome']}: {record['asset_id']}")
    return "\n".join(lines)


def install(db):
    """Install the shipped visibility projection this module reads through."""
    install_visibility(db)


__all__ = [
    "COMPLETE", "CONFLICT", "DEFAULT_FIELDS", "FILLED", "HIDDEN", "IDENTITY_KEYS",
    "INVALID", "MEDIA_KINDS", "NOT_FOUND", "REPAIRABLE_COLUMNS", "REPLACED",
    "UNCOMMITTED", "SnapshotError", "apply", "extraction_query", "install",
    "load_snapshot", "parse_records", "proposal", "report",
]
