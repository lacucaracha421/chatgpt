"""Medium-size spine art for the tablet's Collections 책장 (long edge 768 px, WebP).

The 360 px thumbnail of a spine is enlarged on a tablet shelf and the original is too heavy for the dozens of spines
a shelf mounts. This module makes the in-between copy the way :mod:`card_art_medium` does for card art, and reuses its
encoding and publishing steps unchanged:

* the original is streamed from R2 (``work-artwork/mobile/<sha256>``, the object the artwork ticket serves) and encoded by
  the bounded child process at 768 px;
* the result is stored under the content-addressed key ``derived/collection-medium/v1/<sha256 of the WebP>.webp`` and
  verified by reading it back; an existing object is never replaced or deleted;
* ``collection_artwork_medium`` records, per original (``source_sha256``), the copy made from it. A row exists only for a
  finished, verified object, so a rerun skips it. Originals are content-addressed, so the copy follows the bytes: it needs
  no work or artwork id, and an artwork whose original is replaced simply has no copy until the next run.

Which spines: the ``spine`` artwork of game and AV works in what ``/v1/collections`` serves (the authority projection while
that is active, else the PC replica). The list publishes a copy's digest as ``artworkVersions[<spine>].medium`` and the
artwork ticket serves it as ``variant: "medium"``; a client without it (or after a failure) keeps the thumbnail.

Nothing here decodes an image in the API process. The operator backfill (``collection_artwork_medium_backfill.py``) covers
the spines that exist; :class:`CollectionArtworkMediumWorker` (off unless ``LAKOMICS_COLLECTION_MEDIUM_WORKER=1``) keeps up
with spines published later.
"""
import contextlib
import json
import sqlite3

import card_art_medium
import image_thumbnails as thumbs_worker

PREFIX = "derived/collection-medium/v1/"
CONTENT_TYPE = card_art_medium.CONTENT_TYPE
ESTIMATED_BYTES = card_art_medium.ESTIMATED_BYTES
#: The work types that have a 책장 and so shelve spines.
SPINE_TYPES = ("game", "av")
TABLES = ("collection_authority_projection", "mobile_collections")

DDL = """CREATE TABLE IF NOT EXISTS collection_artwork_medium(
 source_sha256 TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
 object_key TEXT NOT NULL, created_at TEXT NOT NULL)"""

MediumError = card_art_medium.MediumError


def install(db):
    db.execute(DDL)


def _table_exists(db):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collection_artwork_medium'").fetchone() is not None


def source_table(active):
    """The table ``/v1/collections`` reads: the authority projection while the domain is active, else the PC replica."""
    return TABLES[0] if active is not None else TABLES[1]


def wanted(db, table):
    """The original of every game and AV spine in ``table``, as ``{sha256, size_bytes, content_type}``, once each."""
    if table not in TABLES:
        raise ValueError(table)
    rows = db.execute(
        "SELECT json_extract(a.value,'$.original.sha256'), json_extract(a.value,'$.original.sizeBytes'),"
        " json_extract(a.value,'$.original.contentType')"
        f" FROM {table} AS p, json_each(p.payload,'$.artworks') AS a"
        " WHERE p.type IN ('game','av') AND json_extract(a.value,'$.kind')='spine'"
        " AND json_extract(a.value,'$.original.sha256') IS NOT NULL ORDER BY p.name COLLATE NOCASE, p.id")
    found = {}
    for sha256, size_bytes, content_type in rows:
        found.setdefault(sha256, {"sha256": sha256, "size_bytes": size_bytes, "content_type": content_type})
    return list(found.values())


def classify(db, sources):
    """Sort originals (in the given order) into ``ready`` (a copy exists), ``todo`` and ``unsupported``.

    ``todo`` rows are what :func:`make` takes. ``unsupported``: not a still JPEG/PNG/WebP, no usable digest or size, or
    over the source size bound.
    """
    result = {"ready": [], "todo": [], "unsupported": []}
    done = set()
    if sources and _table_exists(db):
        done = {row[0] for row in db.execute(
            "SELECT source_sha256 FROM collection_artwork_medium WHERE source_sha256 IN (SELECT value FROM json_each(?))",
            [json.dumps([source["sha256"] for source in sources])])}
    for source in sources:
        row = {"id": source["sha256"], "kind": "image", "content_type": source["content_type"],
               "object_key": "work-artwork/mobile/" + str(source["sha256"]), "sha256": source["sha256"],
               "size_bytes": source["size_bytes"]}
        if source["sha256"] in done:
            result["ready"].append(source["sha256"])
        elif (thumbs_worker.encoder_kind(row) != thumbs_worker.IMAGE_KIND or not thumbs_worker._is_hex_digest(row["sha256"])
              or not isinstance(row["size_bytes"], int) or not 0 < row["size_bytes"] <= thumbs_worker.MAX_SOURCE_BYTES):
            result["unsupported"].append(source["sha256"])
        else:
            result["todo"].append(row)
    return result


def make(s3, bucket, row, **options):
    """Encode and publish one original. Returns ``(sha256, size_bytes, key)``; does not touch SQLite."""
    return card_art_medium.make(s3, bucket, row, prefix=PREFIX, **options)


def record(db, row, digest, size_bytes, key):
    db.execute("INSERT OR REPLACE INTO collection_artwork_medium VALUES(?,?,?,?,datetime('now'))",
               [row["sha256"], digest, size_bytes, key])
    db.commit()


def lookup(db, source_sha256):
    """The stored copy of an original (``sha256``, ``size_bytes``, ``object_key``), or None."""
    if not _table_exists(db):
        return None
    return db.execute("SELECT sha256,size_bytes,object_key FROM collection_artwork_medium WHERE source_sha256=?",
                      [source_sha256]).fetchone()


def digests(db, payloads):
    """``{original sha256: medium sha256}`` for the spine artwork of ``payloads`` (list or detail items) that has a copy."""
    shas = {art["original"]["sha256"] for payload in payloads if payload.get("type") in SPINE_TYPES
            for art in payload.get("artworks", ()) if art.get("kind") == "spine" and art.get("original")}
    if not shas or not _table_exists(db):
        return {}
    return {row[0]: row[1] for row in db.execute(
        "SELECT source_sha256,sha256 FROM collection_artwork_medium WHERE source_sha256 IN (SELECT value FROM json_each(?))",
        [json.dumps(sorted(shas))])}


class CollectionArtworkMediumWorker(card_art_medium.CardArtMediumWorker):
    """Keeps newly published spines supplied with a medium copy; the same low-priority pass as the card art worker.

    ``wanted(db)`` returns the originals to cover (:func:`wanted` of the table being served). Meant to be switched on after
    the operator backfill, so it only has the spines published since.
    """

    thread_name = "collection-artwork-medium"

    def run_once(self):
        """One pass; returns how many copies were recorded."""
        db = sqlite3.connect(self.db_path, timeout=30.0)
        db.row_factory = sqlite3.Row
        made = 0
        try:
            db.execute("PRAGMA busy_timeout=30000")
            install(db)
            todo = [row for row in classify(db, self.wanted(db))["todo"] if row["id"] not in self._terminal]
            for row in todo[:self.batch]:
                if self._stop.is_set():
                    break
                try:
                    digest, size, key = make(self.s3, self.bucket, row, stop=self._stop)
                except MediumError as error:
                    if not error.transient:
                        self._terminal.add(row["id"])
                    card_art_medium.LOG.warning("collection artwork medium skipped: %s", error.code)
                    continue
                record(db, row, digest, size, key)
                made += 1
                if self._stop.wait(self.delay):
                    break
        finally:
            with contextlib.suppress(Exception):
                db.close()
        return made
