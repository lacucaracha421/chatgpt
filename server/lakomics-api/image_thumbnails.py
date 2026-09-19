"""Bounded server-side image thumbnail worker (durable jobs, one low-priority thread).

Server-owned Assets created by ``asset_authority.promote_capture`` are committed with
``thumbnail_key IS NULL``, so mobile has no tile to fetch for them while every PC is
off. This module closes that gap inside the API process, without giving the API process
a decoder: bytes are streamed from R2 to a temp file, encoded by a separate bounded
child process (:mod:`image_thumbnail_encode`), and the derived object is published only
if the Asset is still the exact same content it was when the job was queued.

Shape of the contract
---------------------

* ``install(db)`` creates the durable job table and one ``AFTER INSERT`` trigger on
  ``assets``. The trigger enqueues **only** newly captured images — ``kind='image'``,
  ``committed=1``, ``thumbnail_key IS NULL``, ``import_source='capture'`` — and never
  touches rows that already exist. A deployment therefore repairs nothing by accident;
  historical rows are enqueued deliberately through :func:`enqueue`.
* :func:`enqueue` is the explicit, scoped-repair entry point. It refuses anything that
  is not a visible, committed, missing-thumbnail image, and it preserves a terminal
  failure unless the caller passes ``retry_terminal=True`` with a reason.
* :class:`ImageThumbnailWorker` owns one daemon thread that polls, claims one job at a
  time and never runs more than one encode concurrently. A cross-process ``fcntl``
  advisory lock keeps a second API process from processing the same queue.

Safety rules enforced here, in order of how they fail
-----------------------------------------------------

* *Nothing is decoded in the API process.* The child is the only place Pillow exists,
  and it is bounded by wall clock, CPU time, address space and priority.
* *Originals are never replaced.* The derived key is content-addressed
  (``derived/image-thumbnails/v1/{sha256}.webp``), so it is immutable and distinct from
  legacy ``library/{asset_id}/...`` keys, and it can be shared by identical content.
* *Publication is compare-and-set.* ``thumbnail_key`` is written only when the Asset
  still has the same ``sha256``, still has no thumbnail, and is still a visible,
  committed image. A trash, delete or replacement during the download wins, and the
  worker discards its artifact instead of publishing it.
* *Remote objects are never deleted.* A derived key may be shared by another Asset with
  the same content, so removing it on a lost race would break a live thumbnail.
* *Errors are coded, retries are bounded.* Transient storage/process failures retry with
  backoff up to ``MAX_ATTEMPTS``; validation and guard failures are terminal on the
  first occurrence. Log lines carry an error code and a job id only — never a filename,
  object key, signed URL, credential or raw exception text.
"""
from __future__ import annotations

import contextlib
import hashlib
import logging
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

LOG = logging.getLogger("lakomics.image-thumbnails")

TABLE = "image_thumbnail_jobs"

STATE_QUEUED = "queued"
STATE_RUNNING = "running"
STATE_DONE = "done"
STATE_FAILED = "failed"

#: Attempts before a job becomes terminal. Three attempts with backoff covers a brief
#: R2 or host hiccup without letting one bad object occupy the queue forever.
MAX_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = (15.0, 60.0)

POLL_SECONDS = 5.0
#: A claimed job is released back to the queue when its lease expires, which is what
#: makes a crashed or restarted worker recover its in-flight job without a hand-written
#: startup sweep.
LEASE_SECONDS = 300.0

#: Input bound, matching the capture download limit: an original larger than this is not
#: a thumbnail candidate and must not be streamed.
MAX_SOURCE_BYTES = 50 * 1024 * 1024

#: Absolute wall-clock bound on one source download, measured with a monotonic clock.
#: ``MAX_SOURCE_BYTES`` bounds how much is read but not how long it takes: a peer that
#: trickles bytes forever would otherwise hold the worker (and one job lease) open
#: indefinitely, since a per-read socket timeout only limits the gap *between* reads.
#: The storage client's own socket timeouts remain the controller's concern; this is
#: the total-budget guard that catches a slow-but-progressing stream either way.
DOWNLOAD_TIMEOUT_SECONDS = 60.0

#: Child-process wall-clock bound. The child applies its own CPU, address-space and
#: priority limits, so this is the only bound the parent must supply — it is the one
#: that cannot be self-applied. Nothing else is passed to the child: a ``preexec_fn``
#: callback would run between fork and exec in a threaded process and is a documented
#: deadlock risk, so it is deliberately not used.
ENCODE_TIMEOUT_SECONDS = 20.0

DERIVED_PREFIX = "derived/image-thumbnails/v1"
DERIVED_CONTENT_TYPE = "image/webp"

IMAGE_KIND = "image"
CAPTURE_IMPORT_SOURCE = "capture"

# ---------------------------------------------------------------------------
# Error vocabulary. Stable strings, safe to log and safe to compare in tests.
# ---------------------------------------------------------------------------
E_RETRY = {
    "storageReadFailed": "storageReadFailed",
    "storageWriteFailed": "storageWriteFailed",
    "encodeFailed": "encodeFailed",
    "encodeTimedOut": "encodeTimedOut",
}
E_TERMINAL = {
    "jobNotFound": "jobNotFound",
    "sourceUnavailable": "sourceUnavailable",
    "sourceSizeUnknown": "sourceSizeUnknown",
    "sourceTooLarge": "sourceTooLarge",
    "sourceSizeMismatch": "sourceSizeMismatch",
    "sourceDigestMismatch": "sourceDigestMismatch",
    "digestUnavailable": "digestUnavailable",
    "sourceNotImage": "sourceNotImage",
    "sourceUndecodable": "sourceUndecodable",
    "assetChanged": "assetChanged",
    "assetNotVisible": "assetNotVisible",
    "thumbnailAlreadyPresent": "thumbnailAlreadyPresent",
    "encodeUnsupportedPlatform": "encodeUnsupportedPlatform",
}

_DDL = f"""
-- One durable row per thumbnail job; the primary key on ``asset_id`` is what makes
-- enqueueing idempotent, so one Asset can never hold two jobs.
CREATE TABLE IF NOT EXISTS {TABLE}(
 asset_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','done','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 lease_until REAL,
 last_error TEXT,
 created_at REAL NOT NULL,
 updated_at REAL NOT NULL,
 PRIMARY KEY(asset_id));
CREATE INDEX IF NOT EXISTS image_thumbnail_jobs_claimable
 ON {TABLE}(state, lease_until, created_at);

-- Enqueue a new capture exactly once. The primary key is the dedupe, and the guard is
-- deliberately narrow: only a committed image Asset that a Capture promoted and that
-- still lacks a thumbnail qualifies. Existing rows are never scanned, so installing
-- this cannot enqueue historical Assets.
CREATE TRIGGER IF NOT EXISTS image_thumbnail_jobs_insert
AFTER INSERT ON assets
WHEN NEW.kind='{IMAGE_KIND}'
 AND NEW.committed=1
 AND NEW.thumbnail_key IS NULL
 AND NEW.import_source='{CAPTURE_IMPORT_SOURCE}'
BEGIN
 INSERT OR IGNORE INTO {TABLE}(asset_id,state,attempts,created_at,updated_at)
 VALUES(NEW.id,'queued',0,CAST(strftime('%s','now') AS REAL),CAST(strftime('%s','now') AS REAL));
END;
"""


def install(db) -> None:
    """Create the job table and the new-capture trigger. Idempotent and non-invasive."""
    db.executescript(_DDL)


def derived_key(sha256: str) -> str:
    """The immutable, content-addressed derived object key for a verified digest."""
    return f"{DERIVED_PREFIX}/{sha256}.webp"


def _is_hex_digest(value) -> bool:
    if not isinstance(value, str) or len(value) != 64:
        return False
    return all(character in "0123456789abcdef" for character in value)


def visible_asset(db, asset_id):
    """The Asset row when an ordinary reader can still see it, or ``None``.

    Visibility is the shipped ``visible_assets`` projection, not a re-derived rule, so
    "hidden" here means exactly what it means to mobile. Uncommitted, trashed or
    tombstoned Assets are invisible, and an Asset whose row is gone is invisible too
    (the projection cannot return what does not exist).
    """
    if not _visible_assets_available(db):
        return None
    try:
        return db.execute("SELECT * FROM visible_assets WHERE id=?", [asset_id]).fetchone()
    except sqlite3.OperationalError:
        return None


def is_thumbnail_candidate(row) -> bool:
    """True when ``row`` is a committed image that still lacks a thumbnail."""
    if row is None:
        return False
    return bool(row["committed"]) and row["kind"] == IMAGE_KIND and row["thumbnail_key"] is None


def eligible(db, asset_id):
    """The Asset row when it is a visible, committed, thumbnail-less image.

    Used by :func:`enqueue`, so a caller cannot "repair" a trashed, hidden,
    uncommitted, video or already-thumbnailed Asset by asking for it.
    """
    row = visible_asset(db, asset_id)
    return row if is_thumbnail_candidate(row) else None


def _visible_assets_available(db) -> bool:
    try:
        db.execute("SELECT 1 FROM visible_assets LIMIT 1").fetchone()
        return True
    except sqlite3.OperationalError:
        return False


def enqueue(db, asset_id, *, retry_terminal: bool = False, reason: str | None = None):
    """Explicitly enqueue a scoped repair for one eligible Asset.

    Deliberately not automatic: this is the only way a pre-existing Asset enters the
    queue, so a repair run is always a reviewed, bounded act rather than a side effect
    of deployment.

    A terminal failure is preserved, because "this source cannot be thumbnailed" is a
    real answer and re-deriving it on every start is churn. ``retry_terminal=True``
    with a ``reason`` overrides that, and is intended for an operator decision after
    the cause (a corrupted object, a missing Pillow) has actually changed.
    """
    if eligible(db, asset_id) is None:
        return False
    row = db.execute(f"SELECT state FROM {TABLE} WHERE asset_id=?", [asset_id]).fetchone()
    if row is None:
        db.execute(
            f"INSERT OR IGNORE INTO {TABLE}(asset_id,state,attempts,created_at,updated_at)"
            f" VALUES(?,'queued',0,?,?)", [asset_id, time.time(), time.time()])
        return True
    if row[0] == STATE_FAILED:
        if not retry_terminal or not reason:
            return False
        db.execute(
            f"UPDATE {TABLE} SET state='queued',attempts=0,last_error=NULL,lease_until=NULL,"
            f"updated_at=? WHERE asset_id=? AND state='failed'", [time.time(), asset_id])
        return True
    # Already queued, running with a live lease, or done. Re-arming a healthy job would
    # either duplicate an encode or discard a valid result.
    return False


class _TerminalError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class _TransientError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class _WorkerLock:
    """One cross-process worker lock, held for the lifetime of the thread.

    The database lease below already prevents two workers from *processing* the same
    job; this lock prevents a second worker from polling that queue at all, so an
    accidental double start costs nothing instead of doubling encoder load on a
    1 vCPU host.

    ``fcntl`` advisory locking is the Linux mechanism. It is unavailable on Windows,
    where ``msvcrt.locking`` is the equivalent; both are used when present, and when
    neither is importable the worker reports itself unavailable and processes nothing,
    which fails closed rather than running unlocked.
    """

    def __init__(self, path: str):
        self.path = path
        self._handle = None
        self._kind = None

    def acquire(self) -> bool:
        if self._handle is not None:
            return True
        try:
            handle = open(self.path, "a+b")
        except OSError:
            return False
        try:
            try:
                import fcntl
            except ImportError:
                import msvcrt  # type: ignore[import-not-found]
                handle.seek(0)
                handle.write(b"\0")
                handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                self._kind = "msvcrt"
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                self._kind = "fcntl"
        except (OSError, ImportError):
            handle.close()
            return False
        self._handle = handle
        return True

    def release(self) -> None:
        handle, kind = self._handle, self._kind
        self._handle = self._kind = None
        if handle is None:
            return
        try:
            if kind == "fcntl":
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            elif kind == "msvcrt":
                import msvcrt  # type: ignore[import-not-found]
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        except (OSError, ImportError):
            pass
        handle.close()


#: Exit codes the encoder documents. Anything else is a transient process failure.
EXIT_UNSUPPORTED_PLATFORM = 3
EXIT_UNSUPPORTED_INPUT = 4
EXIT_ENCODE_FAILED = 5

#: Ceiling on the encoded artifact, mirroring the encoder's own promise. The parent
#: re-applies it when reading the child's output file.
MAX_ARTIFACT_BYTES = 2 * 1024 * 1024

#: Bytes read per streaming chunk from R2.
DOWNLOAD_CHUNK_BYTES = 256 * 1024


class ImageThumbnailWorker:
    """Durable, single-threaded, low-priority image thumbnail worker."""

    def __init__(self, db_path, s3, bucket, *, poll_seconds=POLL_SECONDS,
                 lock_path=None, encoder_script=None):
        self.db_path = str(db_path)
        self.s3 = s3
        self.bucket = bucket
        self.poll_seconds = poll_seconds
        self.lock_path = lock_path or f"{self.db_path}.image-thumbnails.lock"
        self.encoder_script = encoder_script or str(
            Path(__file__).resolve().parent / "image_thumbnail_encode.py")
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread = None
        self._lock = _WorkerLock(self.lock_path)
        #: One writer connection owned by the thread. SQLite objects are not shared
        #: across threads, and the worker is the only writer of this table.
        self._db = None

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        """Start the worker thread, unless one is already *running*.

        The liveness check, not merely "is there a handle", is what makes this correct
        after a timed-out :meth:`stop`: that call retains the handle of a thread which
        may then finish on its own. Refusing on the retained handle alone would leave
        the worker permanently unstartable, so a dead thread is dropped here and a
        fresh one is started. A thread still alive is never doubled up, because that is
        the case where two workers would share one lock file and one SQLite file.
        """
        thread = self._thread
        if thread is not None and thread.is_alive():
            return
        self._thread = None
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="image-thumbnails",
                                        daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> bool:
        """Request a stop and return whether the thread finished within ``timeout``.

        The handle is retained when the join times out. Clearing it would let a later
        :meth:`start` clear the stop flag and spawn a second thread while the first is
        still alive, which would produce two workers sharing one lock file and one
        SQLite file. Retaining it keeps the stop flag set for the running thread while
        ``start`` still refuses to double up, and the handle is released later either by
        this method being called again after the thread exits, or by :meth:`start` once
        the thread is genuinely dead.
        """
        self._stop.set()
        self._wake.set()
        thread = self._thread
        if thread is None:
            return True
        thread.join(timeout=timeout)
        if not thread.is_alive():
            self._thread = None
            return True
        return False

    def _loop(self) -> None:
        if not self._lock.acquire():
            LOG.warning("thumbnail worker not started: another worker holds the lock")
            return
        try:
            self._db = self._open()
            while not self._stop.is_set():
                processed = False
                try:
                    processed = self.run_once()
                except Exception:
                    # A queue-level failure must not kill the thread; log the code only.
                    LOG.error("thumbnail worker pass failed: queueError")
                    self._reset_connection()
                if not processed:
                    self._wake.wait(self.poll_seconds)
                    self._wake.clear()
        finally:
            self._close()
            self._lock.release()

    def wake(self) -> None:
        self._wake.set()

    # -- database ----------------------------------------------------------

    def _open(self):
        connection = sqlite3.connect(self.db_path, timeout=30.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=30000")
        # The worker holds its own connection, so it must establish the visibility
        # projection itself. It cannot reuse an API request's connection (SQLite objects
        # are thread-bound and the worker outlives any one request), and without this the
        # publication re-check would fail closed on every job: with no view, no Asset is
        # ever "visible", which is the correct refusal but not a working worker.
        import asset_visibility
        asset_visibility.install(connection)
        return connection

    def _reset_connection(self):
        with contextlib.suppress(Exception):
            if self._db is not None:
                self._db.close()
        self._db = None

    def _close(self):
        self._reset_connection()

    def _connection(self):
        if self._db is None:
            self._db = self._open()
        return self._db

    # -- queue ------------------------------------------------------------

    def claim(self):
        """Claim the oldest claimable job, or ``None``.

        A job is claimable when it is queued *and past its backoff*, or when it is
        running with an expired lease — the second case is how a crashed worker's
        in-flight job is recovered, with no separate startup sweep.

        The backoff delay is stored in ``lease_until`` for a queued job and honoured
        here, so a transient failure genuinely waits instead of being retried in a tight
        loop by the next poll.

        A job whose attempts are already exhausted is terminalized rather than claimed.
        Without that, a job repeatedly interrupted by a crash between claim and outcome
        (no ``run_once`` handler ever runs, so nothing else would stop it) would
        increment its counter forever and never leave the queue.
        """
        now = time.time()
        connection = self._connection()
        connection.execute("BEGIN IMMEDIATE")
        try:
            row = connection.execute(
                f"SELECT * FROM {TABLE} WHERE "
                f"(state='queued' AND (lease_until IS NULL OR lease_until<=?)) "
                f"OR (state='running' AND lease_until IS NOT NULL AND lease_until<=?) "
                f"ORDER BY created_at LIMIT 1", [now, now]).fetchone()
            if row is None:
                connection.execute("ROLLBACK")
                return None
            if row["attempts"] >= MAX_ATTEMPTS:
                connection.execute(
                    f"UPDATE {TABLE} SET state='failed',lease_until=NULL,"
                    f"last_error=COALESCE(last_error,'attemptsExhausted'),updated_at=? "
                    f"WHERE asset_id=?", [now, row["asset_id"]])
                connection.commit()
                LOG.warning("thumbnail job abandoned after %d attempts: attemptsExhausted",
                            row["attempts"])
                return None
            connection.execute(
                f"UPDATE {TABLE} SET state='running',attempts=attempts+1,lease_until=?,"
                f"updated_at=? WHERE asset_id=?",
                [now + LEASE_SECONDS, now, row["asset_id"]])
            connection.commit()
            return {"asset_id": row["asset_id"], "attempts": row["attempts"] + 1}
        except BaseException:
            connection.rollback()
            raise

    def _finish(self, asset_id, state, error_code):
        connection = self._connection()
        connection.execute(
            f"UPDATE {TABLE} SET state=?,lease_until=NULL,last_error=?,updated_at=? "
            f"WHERE asset_id=?", [state, error_code, time.time(), asset_id])
        connection.commit()

    def run_once(self) -> bool:
        """Process at most one claimed job. Returns whether one was claimed."""
        claim = self.claim()
        if claim is None:
            return False
        asset_id = claim["asset_id"]
        try:
            self._process(asset_id)
        except _TerminalError as error:
            self._finish(asset_id, STATE_FAILED, error.code)
            LOG.info("thumbnail job terminal: %s", error.code)
        except _TransientError as error:
            self._fail_or_defer(claim, error.code)
        except Exception:
            # Unknown failure: transient by default, and the attempt counter bounds it.
            self._fail_or_defer(claim, "internalError")
        return True

    def _fail_or_defer(self, claim, error_code):
        """Record a transient outcome, terminalizing once attempts are exhausted."""
        attempts = claim["attempts"]
        if attempts >= MAX_ATTEMPTS:
            self._finish(claim["asset_id"], STATE_FAILED, error_code)
            LOG.warning("thumbnail job failed after %d attempts: %s", attempts, error_code)
            return
        delay = RETRY_BACKOFF_SECONDS[min(attempts - 1, len(RETRY_BACKOFF_SECONDS) - 1)]
        self._defer(claim["asset_id"], error_code, delay)
        LOG.info("thumbnail job deferred: %s", error_code)

    def _defer(self, asset_id, error_code, delay):
        connection = self._connection()
        connection.execute(
            f"UPDATE {TABLE} SET state='queued',lease_until=?,last_error=?,updated_at=? "
            f"WHERE asset_id=?", [time.time() + delay, error_code, time.time(), asset_id])
        connection.commit()

    # -- one job ----------------------------------------------------------

    def _process(self, asset_id):
        row = self._eligible_row(asset_id)
        if row is None:
            raise _TerminalError(E_TERMINAL["jobNotFound"])
        sha256 = row["sha256"]
        size_bytes = row["size_bytes"]
        object_key = row["object_key"]
        content_type = row["content_type"]
        if row["kind"] != IMAGE_KIND:
            raise _TerminalError(E_TERMINAL["sourceNotImage"])
        if not _is_hex_digest(sha256):
            raise _TerminalError(E_TERMINAL["digestUnavailable"])
        if not isinstance(object_key, str) or not object_key:
            raise _TerminalError(E_TERMINAL["sourceUnavailable"])
        if not isinstance(content_type, str) or not content_type.startswith("image/"):
            raise _TerminalError(E_TERMINAL["sourceNotImage"])
        # A missing or non-positive declared size would make the byte bound unenforceable.
        # Stream what is knowable and let the digest check fail closed otherwise.
        if isinstance(size_bytes, int) and (size_bytes <= 0 or size_bytes > MAX_SOURCE_BYTES):
            raise _TerminalError(E_TERMINAL["sourceTooLarge"]
                                 if size_bytes > MAX_SOURCE_BYTES
                                 else E_TERMINAL["sourceSizeUnknown"])

        with tempfile.TemporaryDirectory(prefix="lakomics-thumb-") as directory:
            source = os.path.join(directory, "source")
            output = os.path.join(directory, "thumbnail.webp")
            self._download(object_key, source, size_bytes, sha256)
            self._encode(asset_id, source, output)
            payload = self._read_output(output)
            self._publish(asset_id, sha256, payload)

    def _eligible_row(self, asset_id):
        """The visible Asset for a claimed job, or ``None``.

        Note the asymmetry with :func:`eligible`: a job whose Asset already has a
        thumbnail still resolves here. Publication is where that is decided, so the
        distinction between "gone or hidden", "replaced" and "already thumbnailed" is
        preserved in the recorded outcome instead of collapsing into one code.
        """
        row = visible_asset(self._connection(), asset_id)
        if row is None or not bool(row["committed"]):
            return None
        return row

    def _download(self, object_key, path, size_bytes, sha256):
        """Stream the original to a temp file, verifying declared size and digest.

        Bounded three ways: bytes read, an absolute monotonic deadline checked around
        every read, and a digest/size check before anything downstream sees the file.
        """
        deadline = time.monotonic() + DOWNLOAD_TIMEOUT_SECONDS
        hasher = hashlib.sha256()
        total = 0
        try:
            body = self.s3.get_object(Bucket=self.bucket, Key=object_key)["Body"]
        except Exception as error:
            # A missing object is permanent; anything else is worth one more attempt.
            if _is_missing_object(error):
                raise _TerminalError(E_TERMINAL["sourceUnavailable"])
            raise _TransientError(E_RETRY["storageReadFailed"])
        if time.monotonic() > deadline:
            raise _TransientError(E_RETRY["storageReadFailed"])
        try:
            with open(path, "wb") as handle:
                while True:
                    chunk = body.read(DOWNLOAD_CHUNK_BYTES)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_SOURCE_BYTES:
                        raise _TerminalError(E_TERMINAL["sourceTooLarge"])
                    # Checked after every read as well as before it, so a stream that
                    # makes progress slowly is still cut off at the deadline rather
                    # than being allowed to run until the byte ceiling.
                    if time.monotonic() > deadline:
                        raise _TransientError(E_RETRY["storageReadFailed"])
                    hasher.update(chunk)
                    handle.write(chunk)
        except (_TerminalError, _TransientError):
            raise
        except Exception:
            raise _TransientError(E_RETRY["storageReadFailed"])
        finally:
            with contextlib.suppress(Exception):
                body.close()
        if total == 0:
            raise _TerminalError(E_TERMINAL["sourceUnavailable"])
        if isinstance(size_bytes, int) and size_bytes > 0 and total != size_bytes:
            raise _TerminalError(E_TERMINAL["sourceSizeMismatch"])
        if hasher.hexdigest() != sha256:
            raise _TerminalError(E_TERMINAL["sourceDigestMismatch"])

    def _encode(self, asset_id, source, output):
        """Run the bounded child encoder. No decoding happens in this process.

        The child bounds itself (CPU, address space, priority) before it imports Pillow,
        so this call passes nothing but a wall-clock timeout. ``subprocess.run`` kills
        and reaps the direct child on timeout, and the encoder spawns no descendants, so
        there is no process group left to clean up.
        """
        command = [sys.executable, self.encoder_script, source, output]
        try:
            completed = subprocess.run(
                command, timeout=ENCODE_TIMEOUT_SECONDS, check=False,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            # A timeout can be contention rather than a bad object, so it is worth one
            # more attempt under a quieter host — but it is bounded like any other retry.
            raise _TransientError(E_RETRY["encodeTimedOut"])
        except (OSError, subprocess.SubprocessError):
            raise _TransientError(E_RETRY["encodeFailed"])
        code = completed.returncode
        if code == 0:
            return
        if code == EXIT_UNSUPPORTED_PLATFORM:
            # The child could not bound its own memory. Retrying cannot change that, and
            # publishing nothing keeps the original untouched.
            raise _TerminalError(E_TERMINAL["encodeUnsupportedPlatform"])
        if code in (EXIT_UNSUPPORTED_INPUT, EXIT_ENCODE_FAILED):
            # The object was read and rejected: a truncated, animated, oversize or
            # unreadable image will be exactly as unreadable on the next attempt.
            raise _TerminalError(E_TERMINAL["sourceUndecodable"])
        raise _TransientError(E_RETRY["encodeFailed"])

    @staticmethod
    def _read_output(path):
        """Read the encoded artifact, bounded by the same size the encoder promises.

        The child already refuses to exceed ``MAX_ARTIFACT_BYTES``, so this is a second
        bound on a file the parent did not write: a misbehaving or replaced child must
        not be able to make the API process read an arbitrary amount into memory.
        """
        try:
            with open(path, "rb") as handle:
                payload = handle.read(MAX_ARTIFACT_BYTES + 1)
        except OSError:
            raise _TerminalError(E_TERMINAL["sourceUndecodable"])
        if not payload or len(payload) > MAX_ARTIFACT_BYTES:
            raise _TerminalError(E_TERMINAL["sourceUndecodable"])
        return payload

    def _publish(self, asset_id, sha256, payload):
        """Upload the derived object, then compare-and-set the thumbnail column."""
        key = derived_key(sha256)
        try:
            self.s3.put_object(Bucket=self.bucket, Key=key, Body=payload,
                               ContentType=DERIVED_CONTENT_TYPE)
        except Exception:
            raise _TransientError(E_RETRY["storageWriteFailed"])
        # Re-check every condition in the publication transaction: the Asset may have
        # been trashed, deleted, replaced or thumbnailed while we downloaded and encoded.
        # On any of those the artifact is dropped, not published — and never deleted from
        # R2, because an identical Asset may legitimately share this content-addressed key.
        connection = self._connection()
        connection.execute("BEGIN IMMEDIATE")
        try:
            row = visible_asset(connection, asset_id)
            # Ordered deliberately: "is it still there" is answered before "is it still
            # the same bytes", so the recorded outcome names the real reason.
            if row is None or not bool(row["committed"]):
                connection.execute("ROLLBACK")
                raise _TerminalError(E_TERMINAL["assetNotVisible"])
            if row["sha256"] != sha256:
                connection.execute("ROLLBACK")
                raise _TerminalError(E_TERMINAL["assetChanged"])
            if row["thumbnail_key"] is not None:
                connection.execute("ROLLBACK")
                raise _TerminalError(E_TERMINAL["thumbnailAlreadyPresent"])
            # The compare-and-set is one statement, so the guard and the write cannot be
            # separated: the row is updated only while it is *still* this content, still
            # lacks a thumbnail, and is still a committed image. A concurrent replication
            # commit or lifecycle command therefore wins wherever it lands.
            updated = connection.execute(
                "UPDATE assets SET thumbnail_key=?, updated_at=? "
                "WHERE id=? AND sha256=? AND thumbnail_key IS NULL AND committed=1 AND kind=?",
                [key, _now_iso(), asset_id, sha256, IMAGE_KIND]).rowcount
            if not updated:
                connection.execute("ROLLBACK")
                raise _TerminalError(E_TERMINAL["thumbnailAlreadyPresent"])
            connection.execute(
                f"UPDATE {TABLE} SET state='done',lease_until=NULL,last_error=NULL,updated_at=? "
                f"WHERE asset_id=?", [time.time(), asset_id])
            connection.commit()
        except BaseException:
            connection.rollback()
            raise


def _now_iso():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _is_missing_object(error) -> bool:
    """True for a definite "this key does not exist" storage answer."""
    response = getattr(error, "response", None)
    if isinstance(response, dict):
        code = str(response.get("Error", {}).get("Code", ""))
        if code in ("404", "NoSuchKey", "NotFound"):
            return True
    return False
