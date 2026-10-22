"""Medium-size card art for the tablet album grid (long edge 768 px, WebP).

The 360 px Library thumbnail is enough for a list tile but is enlarged 1.5-2x in an album cell
on the tablet, and the original (long edge about 2000 px) is too heavy for 50+ cells. This
module makes the in-between copy with the recipe the server already trusts for thumbnails:

* the original is streamed from R2 and encoded by the bounded child process
  (:mod:`image_thumbnail_encode`, same quality and resource limits, only a larger edge);
* the result is published through :func:`library_thumbnails.publish_buffer` under the
  content-addressed key ``derived/card-medium/v1/<sha256 of the WebP>.webp`` and verified by
  reading it back; an existing object is never replaced or deleted;
* ``card_art_medium`` records, per art Asset, which original (``source_sha256``) the copy was
  made from. A row exists only for a finished, verified object, so a rerun skips it.

Nothing here decodes an image in the API process, and nothing writes the Library ``assets`` row.
:class:`CardArtMediumWorker` covers the art of new packs through :func:`classify` and
:func:`make`. Existing cards were backfilled once by a since-removed one-off script.
"""
import contextlib
import hashlib
import json
import logging
import os
import sqlite3
import tempfile
import threading
import time
from datetime import datetime, timezone

import asset_visibility
import image_thumbnails as thumbs_worker
import library_thumbnails as thumbs
from app_lifecycle import join_worker

LOG = logging.getLogger("lakomics.card-art-medium")

PREFIX = "derived/card-medium/v1/"
MAX_EDGE = 768
CONTENT_TYPE = "image/webp"
#: A 768 px WebP at the thumbnail quality measured 58 KB on average over 40 library images; only used for dry-run estimates.
ESTIMATED_BYTES = 60 * 1024
#: Card art is a still picture: GIFs yield their first frame like the Library tile.
ENCODER_KINDS = ("image", "gif")

DDL = """CREATE TABLE IF NOT EXISTS card_art_medium(
 asset_id TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL, sha256 TEXT NOT NULL,
 size_bytes INTEGER NOT NULL, object_key TEXT NOT NULL, created_at TEXT NOT NULL)"""


def install(db):
    db.execute(DDL)


def object_key(digest):
    return PREFIX + digest + ".webp"


def _table_exists(db):
    return db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='card_art_medium'").fetchone() is not None


def classify(db, asset_ids):
    """Sort art Asset ids (kept in the given order) into what is done and what is left.

    ``ready``: a copy of this exact original exists. ``todo``: Asset rows that can be encoded.
    ``unsupported``: visible, but not something the encoder takes (animated GIF kind, no digest,
    over the source size bound). ``gone``: hidden, uncommitted or missing Assets.
    """
    ids = list(dict.fromkeys(asset_ids))
    result = {"ready": [], "todo": [], "unsupported": [], "gone": []}
    if not ids:
        return result
    payload = json.dumps(ids)
    rows = {row["id"]: row for row in db.execute(
        "SELECT id,kind,content_type,object_key,sha256,size_bytes FROM visible_assets "
        "WHERE committed=1 AND id IN (SELECT value FROM json_each(?))", [payload])}
    done = {}
    if _table_exists(db):
        done = {row[0]: row[1] for row in db.execute(
            "SELECT asset_id,source_sha256 FROM card_art_medium WHERE asset_id IN (SELECT value FROM json_each(?))",
            [payload])}
    for asset_id in ids:
        row = rows.get(asset_id)
        if row is None:
            result["gone"].append(asset_id)
        elif done.get(asset_id) == row["sha256"]:
            result["ready"].append(asset_id)
        elif (thumbs_worker.encoder_kind(row) not in ENCODER_KINDS or not thumbs_worker._is_hex_digest(row["sha256"])
              or not isinstance(row["object_key"], str) or not row["object_key"]
              or not isinstance(row["size_bytes"], int)
              or not 0 < row["size_bytes"] <= thumbs_worker.MAX_SOURCE_BYTES):
            result["unsupported"].append(asset_id)
        else:
            result["todo"].append(row)
    return result


class MediumError(Exception):
    """A coded failure; ``transient`` ones may succeed on a later pass."""

    def __init__(self, code, transient):
        super().__init__(code)
        self.code = code
        self.transient = transient


def make(s3, bucket, row, *, encoder_script=None, stop=None, prefix=PREFIX):
    """Encode and publish one original. Returns ``(sha256, size_bytes, key)``; does not touch SQLite.

    The thumbnail worker's download (size, digest and time bound) and encode (child process in its
    own session, killed on timeout) steps are reused as they are; that object is never started.
    """
    toolbox = thumbs_worker.ImageThumbnailWorker(os.devnull, s3, bucket, encoder_script=encoder_script)
    if stop is not None:
        toolbox._stop = stop
    kind = thumbs_worker.encoder_kind(row)
    try:
        with tempfile.TemporaryDirectory(prefix="lakomics-card-medium-") as directory:
            source = os.path.join(directory, "source")
            output = os.path.join(directory, "medium.webp")
            toolbox._download(row["object_key"], source, row["size_bytes"], row["sha256"])
            toolbox._encode(row["id"], source, output, kind, max_edge=MAX_EDGE)
            payload = toolbox._read_output(output)
    except thumbs_worker._TerminalError as error:
        raise MediumError(error.code, False) from None
    except thumbs_worker._TransientError as error:
        raise MediumError(error.code, True) from None
    except thumbs_worker._StopRequested:
        raise MediumError("stopRequested", True) from None
    digest = hashlib.sha256(payload).hexdigest()
    try:
        thumbs.validate_webp(payload)
        key = thumbs.publish_buffer(s3, bucket, payload, digest, deadline=time.monotonic() + 60,
                                    key=prefix + digest + ".webp")
    except Exception:
        raise MediumError("storageWriteFailed", True) from None
    return digest, len(payload), key


def record(db, row, digest, size_bytes, key):
    """Remember the copy, unless the original changed or went away while it was made."""
    db.execute("BEGIN IMMEDIATE")
    try:
        current = db.execute("SELECT sha256 FROM visible_assets WHERE id=? AND committed=1", [row["id"]]).fetchone()
        if current is None or current["sha256"] != row["sha256"]:
            db.execute("ROLLBACK")
            return False
        db.execute("INSERT OR REPLACE INTO card_art_medium VALUES(?,?,?,?,?,?)",
                   [row["id"], row["sha256"], digest, size_bytes, key,
                    datetime.now(timezone.utc).isoformat()])
        db.commit()
        return True
    except BaseException:
        db.rollback()
        raise


class CardArtMediumWorker:
    """One low-priority thread that keeps the art of upcoming cards supplied with a medium copy.

    ``wanted(db)`` returns art Asset ids in order of need. Each pass makes at most ``batch``
    copies, one at a time, ``delay`` seconds apart; the encoder child already runs niced and
    resource-bounded. A transient failure is retried on a later pass, a terminal one is not
    retried until the process restarts; the card keeps showing its thumbnail meanwhile.
    ``on_change(db)`` runs after a copy was recorded (the cards signal bump).
    """

    thread_name = "card-art-medium"

    def __init__(self, db_path, s3, bucket, wanted, on_change, *, poll_seconds=120.0, batch=3, delay=2.0):
        self.db_path, self.s3, self.bucket = str(db_path), s3, bucket
        self.wanted, self.on_change = wanted, on_change
        self.poll_seconds, self.batch, self.delay = poll_seconds, batch, delay
        self._stop = threading.Event()
        self._thread = None
        self._terminal = set()

    def start(self):
        thread = self._thread
        if thread is not None and thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name=self.thread_name, daemon=True)
        self._thread.start()

    def stop(self, timeout=5.0, on_stopped=None):
        self._stop.set()
        thread = self._thread
        if thread is None:
            return True

        def stopped():
            if self._thread is thread:
                self._thread = None
            if on_stopped is not None:
                on_stopped()

        return join_worker(thread, timeout, stopped)

    def _loop(self):
        # Let the API finish starting before the first pass.
        while not self._stop.wait(self.poll_seconds):
            try:
                self.run_once()
            except Exception:
                LOG.error("card art medium pass failed: passError")

    def run_once(self):
        """One pass; returns how many copies were recorded."""
        db = sqlite3.connect(self.db_path, timeout=30.0)
        db.row_factory = sqlite3.Row
        made = 0
        try:
            db.execute("PRAGMA busy_timeout=30000")
            asset_visibility.install(db)
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
                    LOG.warning("card art medium skipped: %s", error.code)
                    continue
                if record(db, row, digest, size, key):
                    made += 1
                    self.on_change(db)
                if self._stop.wait(self.delay):
                    break
        finally:
            with contextlib.suppress(Exception):
                db.close()
        return made
