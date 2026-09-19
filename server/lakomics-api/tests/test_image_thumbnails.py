"""Bounded image thumbnail worker: queue, guard, encode and publication contracts.

Everything here runs against real SQLite and a real child encoder process; the only
fake is the storage client, which is the boundary the worker does not own. Tests that
need Pillow skip themselves when it is absent, so the suite stays honest about what it
actually verified instead of passing vacuously.
"""
from __future__ import annotations

import io
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import closing
from pathlib import Path
from typing import Any

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import image_thumbnail_encode as encoder
import image_thumbnails as worker_module

try:
    from PIL import Image
except ImportError:  # pragma: no cover - the production venv installs Pillow
    Image = None

requires_pillow = unittest.skipIf(Image is None, "Pillow is unavailable in this environment")
requires_posix = unittest.skipUnless(os.name == "posix", "POSIX resource limits are required")

ASSET_IMAGE = "10000000-0000-4000-8000-000000000001"
ASSET_VIDEO = "10000000-0000-4000-8000-000000000002"
ASSET_GIF = "10000000-0000-4000-8000-000000000003"
ASSET_TRASHED = "10000000-0000-4000-8000-000000000004"


def _new_image(mode, size, color=None):
    """A new Pillow image, via a local alias the type checker can see is not None.

    ``Image`` is ``None`` when Pillow is missing, which is exactly the state the
    ``requires_pillow`` decorators guard. Funnelling construction through here keeps
    the module importable without Pillow while leaving the helpers single-expression.
    """
    assert Image is not None
    return Image.new(mode, size, color)


def png_bytes(size=(800, 600), color=(20, 120, 220)):
    buffer = io.BytesIO()
    _new_image("RGB", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def jpeg_bytes(size=(600, 900), color=(200, 40, 40)):
    buffer = io.BytesIO()
    _new_image("RGB", size, color).save(buffer, format="JPEG", quality=90)
    return buffer.getvalue()


def webp_bytes(size=(700, 500), color=(30, 200, 90)):
    buffer = io.BytesIO()
    _new_image("RGB", size, color).save(buffer, format="WEBP")
    return buffer.getvalue()


def animated_webp_bytes():
    buffer = io.BytesIO()
    frames = [_new_image("RGB", (64, 64), color) for color in ((255, 0, 0), (0, 0, 255))]
    frames[0].save(buffer, format="WEBP", save_all=True, append_images=frames[1:],
                   duration=100)
    return buffer.getvalue()


def animated_png_bytes():
    buffer = io.BytesIO()
    frames = [_new_image("RGB", (64, 64), color) for color in ((255, 255, 0), (0, 255, 255))]
    frames[0].save(buffer, format="PNG", save_all=True, append_images=frames[1:],
                   duration=100)
    return buffer.getvalue()


def exif_oriented_jpeg_bytes(orientation):
    """A 40x20 JPEG whose EXIF says it should be displayed rotated."""
    buffer = io.BytesIO()
    image = _new_image("RGB", (40, 20), (10, 10, 10))
    exif = image.getexif()
    exif[274] = orientation
    image.save(buffer, format="JPEG", exif=exif)
    return buffer.getvalue()


def huge_png_bytes(side=6000):
    """36 MP of solid color: over the worker's pixel ceiling, cheap to generate."""
    buffer = io.BytesIO()
    _new_image("L", (side, side), 0).save(buffer, format="PNG", optimize=False,
                                          compress_level=1)
    return buffer.getvalue()


def transparent_png_bytes(size=(400, 300), color=(255, 0, 0, 0)):
    buffer = io.BytesIO()
    _new_image("RGBA", size, color).save(buffer, format="PNG")
    return buffer.getvalue()


def la_png_bytes(size=(300, 200)):
    """Grayscale+alpha, the other transparency-carrying mode the encoder must keep."""
    from PIL import Image as _PIL

    assert Image is not None
    image = _PIL.new("LA", size, (128, 0))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def palette_transparent_png_bytes(size=(256, 256)):
    """A P-mode PNG whose palette carries a fully transparent entry."""
    assert Image is not None
    image = Image.new("P", size, 0)
    palette = []
    for index in range(256):
        palette.extend((index, 0, 255 - index))
    image.putpalette(palette)
    image.info["transparency"] = 0
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", transparency=0)
    return buffer.getvalue()


class FakeS3:
    """Minimal storage double: enough to be a real boundary, not a mock of the worker."""

    def __init__(self):
        # Each stored object is either raw bytes or an exception to raise, which is how a
        # test models a definite "missing" answer versus a read that fails.
        self.objects: dict[str, dict[str, Any]] = {}
        self.puts: list[str] = []
        self.get_failures = 0
        self.put_failures = 0

    def add(self, key, body, content_type="image/png"):
        self.objects[key] = {"body": body, "content_type": content_type}

    def get_object(self, *, Bucket, Key):
        if self.get_failures > 0:
            self.get_failures -= 1
            raise RuntimeError("storage unavailable")
        stored = self.objects.get(Key)
        if stored is None:
            raise _NoSuchKey()
        body = stored["body"]
        if isinstance(body, Exception):
            raise body
        return {"Body": io.BytesIO(body)}

    def put_object(self, *, Bucket, Key, Body, ContentType):
        if self.put_failures > 0:
            self.put_failures -= 1
            raise RuntimeError("storage unavailable")
        payload = Body.read() if hasattr(Body, "read") else bytes(Body)
        self.objects[Key] = {"body": payload, "content_type": ContentType}
        self.puts.append(Key)


class _NoSuchKey(Exception):
    def __init__(self):
        super().__init__("missing")
        self.response = {"Error": {"Code": "NoSuchKey", "Message": "missing"}}


class _BrokenBody:
    """A body that fails partway through, as a dropped connection would."""

    def __init__(self, prefix):
        self.prefix = prefix
        self.done = False

    def read(self, _size):
        if self.done:
            raise OSError("read failed")
        self.done = True
        return self.prefix

    def close(self):
        pass


class Fixture(unittest.TestCase):
    """Real schema, real trigger, real visibility view, fake storage."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp.name) / "lakomics.sqlite3"
        self.s3 = FakeS3()
        self.workers = []
        with closing(sqlite3.connect(self.db_path)) as db:
            db.row_factory = sqlite3.Row
            db.executescript("""
                CREATE TABLE assets(
                 id TEXT PRIMARY KEY, kind TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE,
                 thumbnail_key TEXT, content_type TEXT, size_bytes INTEGER, sha256 TEXT,
                 committed INTEGER NOT NULL DEFAULT 0, import_source TEXT,
                 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE asset_list_generation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation INTEGER NOT NULL);
                INSERT INTO asset_list_generation VALUES(1,0);
                CREATE TRIGGER asset_list_insert AFTER INSERT ON assets BEGIN
                 UPDATE asset_list_generation SET generation=generation+1 WHERE singleton=1; END;
                CREATE TRIGGER asset_list_update AFTER UPDATE ON assets BEGIN
                 UPDATE asset_list_generation SET generation=generation+1 WHERE singleton=1; END;
                CREATE TRIGGER asset_list_delete AFTER DELETE ON assets BEGIN
                 UPDATE asset_list_generation SET generation=generation+1 WHERE singleton=1; END;
                CREATE TEMP VIEW visible_assets AS SELECT * FROM assets;
            """)
            worker_module.install(db)
            db.commit()
        self.db = self.open()

    def tearDown(self):
        for worker in self.workers:
            self.assertTrue(worker.stop(timeout=10), "worker outlived its test database")
            worker._close()
            worker._lock.release()
        self.db.close()
        self.temp.cleanup()

    def open(self):
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        connection.executescript(
            "CREATE TEMP VIEW IF NOT EXISTS visible_assets AS SELECT * FROM assets;")
        return connection

    def seed(self, asset_id, body, *, kind="image", committed=1, import_source="capture",
             content_type="image/png", thumbnail_key=None, sha256=None, object_key=None):
        import hashlib
        digest = sha256 if sha256 is not None else hashlib.sha256(body).hexdigest()
        key = object_key or f"images/inbox/{asset_id}/original"
        self.db.execute(
            "INSERT INTO assets(id,kind,object_key,thumbnail_key,content_type,size_bytes,"
            "sha256,committed,import_source,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,'2026-09-19T00:00:00Z','2026-09-19T00:00:00Z')",
            [asset_id, kind, key, thumbnail_key, content_type, len(body), digest,
             committed, import_source])
        self.db.commit()
        self.s3.add(key, body, content_type)
        return digest

    def hide(self, connection, *asset_ids):
        """Replace the connection's visibility projection to hide those Assets.

        This is the trash/tombstone path as every ordinary reader sees it: the row is
        still present and committed, and only ``visible_assets`` stops returning it.
        """
        quoted = ",".join(f"'{asset_id}'" for asset_id in asset_ids)
        connection.executescript(
            "DROP VIEW IF EXISTS temp.visible_assets;\n"
            f"CREATE TEMP VIEW visible_assets AS SELECT * FROM assets WHERE id NOT IN ({quoted});")

    def jobs(self, asset_id=None):
        query = f"SELECT * FROM {worker_module.TABLE}"
        params = []
        if asset_id is not None:
            query += " WHERE asset_id=?"
            params.append(asset_id)
        return [dict(row) for row in self.db.execute(query, params).fetchall()]

    def thumbnail_key(self, asset_id):
        return self.db.execute("SELECT thumbnail_key FROM assets WHERE id=?",
                               [asset_id]).fetchone()[0]

    def generation(self):
        return self.db.execute(
            "SELECT generation FROM asset_list_generation WHERE singleton=1").fetchone()[0]

    def worker(self, **kwargs):
        worker = worker_module.ImageThumbnailWorker(
            self.db_path, self.s3, "test-bucket",
            lock_path=str(Path(self.temp.name) / "worker.lock"), **kwargs)
        self.workers.append(worker)
        return worker


# ---------------------------------------------------------------------------
# Queue creation
# ---------------------------------------------------------------------------

class TriggerTests(Fixture):
    def test_a_new_capture_image_is_enqueued_exactly_once(self):
        self.seed(ASSET_IMAGE, png_bytes())
        jobs = self.jobs(ASSET_IMAGE)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["state"], worker_module.STATE_QUEUED)
        self.assertEqual(jobs[0]["attempts"], 0)

    def test_install_does_not_enqueue_historical_rows(self):
        # Rows that exist before install() are exactly the historical population this
        # worker must not sweep on deployment.
        with closing(sqlite3.connect(self.db_path)) as db:
            db.executescript("DROP TABLE image_thumbnail_jobs; DROP TRIGGER image_thumbnail_jobs_insert;")
            db.execute(
                "INSERT INTO assets(id,kind,object_key,content_type,size_bytes,sha256,"
                "committed,import_source,created_at,updated_at) "
                "VALUES('hist','image','images/inbox/hist/original','image/png',10,"
                "'%s',1,'capture','t','t')" % ("a" * 64))
            db.commit()
            worker_module.install(db)
            db.commit()
            self.assertEqual(
                db.execute("SELECT count(*) FROM image_thumbnail_jobs").fetchone()[0], 0)
        # And a new capture after install is still enqueued.
        self.seed(ASSET_IMAGE, png_bytes())
        self.assertEqual(len(self.jobs(ASSET_IMAGE)), 1)

    def test_only_new_captured_images_enter_the_queue(self):
        self.seed(ASSET_VIDEO, b"video-bytes", kind="video")
        self.seed(ASSET_GIF, b"gif-bytes", kind="gif")
        # Not committed yet: a replication prepare must not enqueue work for an Asset
        # that mobile cannot see.
        self.seed("10000000-0000-4000-8000-000000000010", png_bytes(), committed=0)
        # Committed but produced by the PC replication path, which supplies its own
        # thumbnail. The guard deliberately excludes it.
        self.seed("10000000-0000-4000-8000-000000000011", png_bytes(), import_source="replica")
        # Already has a thumbnail.
        self.seed("10000000-0000-4000-8000-000000000012", png_bytes(), thumbnail_key="library/x/t")
        self.seed(ASSET_IMAGE, png_bytes())
        self.assertEqual([job["asset_id"] for job in self.jobs()], [ASSET_IMAGE])

    def test_reinserting_the_same_asset_does_not_duplicate_its_job(self):
        self.seed(ASSET_IMAGE, png_bytes(), import_source="replica")
        self.assertEqual(self.jobs(ASSET_IMAGE), [])
        self.db.execute("UPDATE assets SET import_source='capture' WHERE id=?", [ASSET_IMAGE])
        self.db.commit()
        # The trigger is INSERT-only by design: an UPDATE never re-fires it.
        self.assertEqual(self.jobs(ASSET_IMAGE), [])
        connection = self.open()
        try:
            self.assertTrue(worker_module.enqueue(connection, ASSET_IMAGE))
            connection.commit()
        finally:
            connection.close()
        self.assertEqual(len(self.jobs(ASSET_IMAGE)), 1)


# ---------------------------------------------------------------------------
# Explicit scoped repair
# ---------------------------------------------------------------------------

class EnqueueTests(Fixture):
    def test_explicit_enqueue_accepts_only_eligible_visible_assets(self):
        self.seed(ASSET_IMAGE, png_bytes(), import_source="replica")
        connection = self.open()
        try:
            self.assertTrue(worker_module.enqueue(connection, ASSET_IMAGE))
            connection.commit()
            # Not eligible: wrong kind, uncommitted, already thumbnailed, or unknown.
            self.assertFalse(worker_module.enqueue(connection, ASSET_VIDEO))
            self.assertFalse(worker_module.enqueue(connection, "missing-asset"))
        finally:
            connection.close()
        self.assertEqual([job["asset_id"] for job in self.jobs()], [ASSET_IMAGE])

    def test_enqueue_is_idempotent_for_a_healthy_job(self):
        self.seed(ASSET_IMAGE, png_bytes())
        connection = self.open()
        try:
            self.assertFalse(worker_module.enqueue(connection, ASSET_IMAGE))
            connection.commit()
            row = self.jobs(ASSET_IMAGE)[0]
            self.assertEqual((row["state"], row["attempts"]), (worker_module.STATE_QUEUED, 0))
        finally:
            connection.close()

    def test_terminal_failure_is_preserved_unless_explicitly_retried(self):
        self.seed(ASSET_IMAGE, png_bytes())
        self.db.execute(
            f"UPDATE {worker_module.TABLE} SET state='failed',attempts=3,last_error='decodeFailed' "
            f"WHERE asset_id=?", [ASSET_IMAGE])
        self.db.commit()
        connection = self.open()
        try:
            self.assertFalse(worker_module.enqueue(connection, ASSET_IMAGE))
            connection.commit()
            self.assertEqual(self.jobs(ASSET_IMAGE)[0]["state"], "failed")
            # A justification-less override is still refused: the reason is the evidence
            # that an operator decided this is worth re-deriving.
            self.assertFalse(worker_module.enqueue(connection, ASSET_IMAGE, retry_terminal=True))
            connection.commit()
            self.assertEqual(self.jobs(ASSET_IMAGE)[0]["state"], "failed")
            self.assertTrue(worker_module.enqueue(
                connection, ASSET_IMAGE, retry_terminal=True, reason="encoder installed"))
            connection.commit()
        finally:
            connection.close()
        row = self.jobs(ASSET_IMAGE)[0]
        self.assertEqual((row["state"], row["attempts"], row["last_error"]),
                         (worker_module.STATE_QUEUED, 0, None))

    def test_enqueue_refuses_an_asset_that_is_no_longer_visible(self):
        # The Asset arrives through the ordinary capture path, so the trigger queues it.
        self.seed(ASSET_TRASHED, png_bytes())
        self.seed(ASSET_IMAGE, png_bytes(), object_key="images/inbox/visible/original")
        self.db.execute(
            f"UPDATE {worker_module.TABLE} SET state='failed' WHERE asset_id=?", [ASSET_TRASHED])
        self.db.execute("DELETE FROM image_thumbnail_jobs WHERE asset_id=?", [ASSET_IMAGE])
        self.db.commit()
        connection = self.open()
        try:
            # Trashed before any repair was requested: the row is present, committed and
            # a capture, and only the visibility projection hides it.
            self.hide(connection, ASSET_TRASHED)
            self.assertFalse(worker_module.enqueue(connection, ASSET_TRASHED))
            self.assertIsNone(worker_module.eligible(connection, ASSET_TRASHED))
            # A visible Asset on the same connection is still reachable through the
            # projection, so the refusal above is the trash and not a broken query.
            self.assertIsNotNone(worker_module.visible_asset(connection, ASSET_IMAGE))
        finally:
            connection.close()
        # The hidden Asset keeps its terminal state; no repair was enqueued for it.
        self.assertEqual(
            self.db.execute(f"SELECT state FROM {worker_module.TABLE} WHERE asset_id=?",
                            [ASSET_TRASHED]).fetchone()[0], "failed")


# ---------------------------------------------------------------------------
# Encoder
# ---------------------------------------------------------------------------

ENCODER = str(SERVER_DIR / "image_thumbnail_encode.py")


def run_encoder(arguments, *, timeout=60):
    """Run the real encoder exactly as the worker does.

    The child bounds itself before importing Pillow, so the parent passes no
    ``preexec_fn`` — only the wall-clock timeout it alone can supply.
    """
    return subprocess.run([sys.executable, ENCODER, *arguments], check=False,
                          capture_output=True, timeout=timeout)


class EncoderContractTests(unittest.TestCase):
    def test_usage_is_a_usage_exit_not_a_traceback(self):
        completed = run_encoder([])
        self.assertEqual(completed.returncode, encoder.EXIT_USAGE)
        self.assertEqual(completed.stdout, b"")

    @requires_pillow
    def test_a_missing_input_is_an_unsupported_input_not_a_crash(self):
        with tempfile.TemporaryDirectory() as directory:
            output = os.path.join(directory, "out.webp")
            completed = run_encoder([os.path.join(directory, "absent"), output])
            self.assertEqual(completed.returncode, encoder.EXIT_UNSUPPORTED_INPUT)
            self.assertFalse(os.path.exists(output))

    @requires_pillow
    def test_an_unknown_format_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "source")
            Path(source).write_bytes(b"not-an-image-at-all")
            output = os.path.join(directory, "out.webp")
            completed = run_encoder([source, output])
            self.assertEqual(completed.returncode, encoder.EXIT_UNSUPPORTED_INPUT)
            self.assertFalse(os.path.exists(output))


@requires_pillow
class EncoderBehaviourTests(unittest.TestCase):
    def encode(self, payload, *, expect=0):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        source = os.path.join(directory.name, "source")
        output = os.path.join(directory.name, "out.webp")
        Path(source).write_bytes(payload)
        completed = run_encoder([source, output])
        self.assertEqual(completed.returncode, expect, completed.stderr[-400:])
        if expect != 0:
            self.assertFalse(os.path.exists(output))
            return None
        assert Image is not None
        with Image.open(output) as encoded:
            self.assertEqual(encoded.format, "WEBP")
            return encoded.size

    def test_jpeg_png_and_webp_all_produce_a_webp_thumbnail(self):
        for payload in (jpeg_bytes(), png_bytes(), webp_bytes()):
            size = self.encode(payload)
            assert size is not None
            self.assertLessEqual(max(size), encoder.MAX_EDGE)
            self.assertGreater(max(size), 1)

    def test_longest_edge_is_512_and_aspect_ratio_is_preserved(self):
        size = self.encode(png_bytes(size=(1600, 800)))
        self.assertEqual(size, (512, 256))

    def test_a_small_source_is_never_upscaled(self):
        size = self.encode(png_bytes(size=(120, 90)))
        self.assertEqual(size, (120, 90))

    def test_exif_orientation_is_applied(self):
        # Orientation 6 means "rotate 90° CW for display", so a 40x20 file must come
        # out portrait; without the transpose it stays landscape.
        self.assertEqual(self.encode(exif_oriented_jpeg_bytes(6)), (20, 40))
        self.assertEqual(self.encode(exif_oriented_jpeg_bytes(1)), (40, 20))

    def test_animated_webp_is_rejected_rather_than_silently_taken_as_frame_zero(self):
        self.assertIsNone(self.encode(animated_webp_bytes(), expect=encoder.EXIT_UNSUPPORTED_INPUT))

    def test_animated_png_is_rejected(self):
        self.assertIsNone(self.encode(animated_png_bytes(), expect=encoder.EXIT_UNSUPPORTED_INPUT))

    def test_a_truncated_image_is_rejected(self):
        payload = png_bytes(size=(1200, 900))
        self.assertIsNone(self.encode(payload[: len(payload) // 2],
                                      expect=encoder.EXIT_UNSUPPORTED_INPUT))

    def test_an_over_pixel_budget_image_is_rejected(self):
        self.assertIsNone(self.encode(huge_png_bytes(),
                                      expect=encoder.EXIT_UNSUPPORTED_INPUT))

    def test_the_output_stays_within_the_size_bound(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        source = os.path.join(directory.name, "source")
        output = os.path.join(directory.name, "out.webp")
        Path(source).write_bytes(png_bytes(size=(1024, 1024)))
        run_encoder([source, output])
        self.assertLessEqual(os.path.getsize(output), encoder.MAX_OUTPUT_BYTES)

    def test_transparency_survives_instead_of_being_flattened_to_black(self):
        # A fully transparent PNG must stay transparent. Flattening it to RGB would turn
        # every transparent pixel opaque black, which is a visual corruption the user
        # would see as "my thumbnail is a black box".
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        source = os.path.join(directory.name, "source")
        output = os.path.join(directory.name, "out.webp")
        Path(source).write_bytes(transparent_png_bytes())
        self.assertEqual(run_encoder([source, output]).returncode, 0)
        assert Image is not None
        with Image.open(output) as encoded:
            self.assertEqual(encoded.format, "WEBP")
            self.assertIn("A", encoded.getbands())
            alpha = encoded.convert("RGBA").getchannel("A")
            self.assertEqual(alpha.getextrema(), (0, 0))

    def test_a_partially_transparent_source_keeps_its_alpha_range(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        source = os.path.join(directory.name, "source")
        output = os.path.join(directory.name, "out.webp")
        assert Image is not None
        image = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
        image.paste((255, 0, 0, 255), (0, 0, 100, 200))
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        Path(source).write_bytes(buffer.getvalue())
        self.assertEqual(run_encoder([source, output]).returncode, 0)
        with Image.open(output) as encoded:
            self.assertIn("A", encoded.getbands())
            self.assertEqual(encoded.convert("RGBA").getchannel("A").getextrema(), (0, 255))

    def test_grayscale_alpha_and_palette_transparency_are_preserved(self):
        for payload in (la_png_bytes(), palette_transparent_png_bytes()):
            directory = tempfile.TemporaryDirectory()
            self.addCleanup(directory.cleanup)
            source = os.path.join(directory.name, "source")
            output = os.path.join(directory.name, "out.webp")
            Path(source).write_bytes(payload)
            self.assertEqual(run_encoder([source, output]).returncode, 0)
            assert Image is not None
            with Image.open(output) as encoded:
                self.assertIn("A", encoded.getbands())

    def test_an_opaque_source_stays_rgb_without_a_synthetic_alpha_channel(self):
        size = self.encode(png_bytes(size=(600, 400)))
        assert size is not None
        self.assertEqual(size, (512, 341))

    def test_a_bomb_sized_image_is_refused_on_its_declared_dimensions(self):
        # Pillow only warns below twice MAX_IMAGE_PIXELS, so a declaration-only check is
        # what stops the decode before the allocation it is meant to prevent.
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        source = os.path.join(directory.name, "source")
        output = os.path.join(directory.name, "out.webp")
        Path(source).write_bytes(huge_png_bytes(side=5000))
        program = (
            "import sys\n"
            f"sys.path.insert(0, {str(SERVER_DIR)!r})\n"
            "import image_thumbnail_encode as encoder\n"
            "loaded = {'n': 0}\n"
            "import PIL.Image as PILImage\n"
            "original_load = PILImage.Image.load\n"
            "def counting_load(self):\n"
            "    loaded['n'] += 1\n"
            "    return original_load(self)\n"
            "PILImage.Image.load = counting_load\n"
            f"code = encoder.main(['x', {source!r}, {output!r}])\n"
            "print(code, loaded['n'])\n"
        )
        completed = subprocess.run([sys.executable, "-c", program], capture_output=True,
                                   timeout=120, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr[-400:])
        code, loads = completed.stdout.split()
        self.assertEqual(int(code), encoder.EXIT_UNSUPPORTED_INPUT)
        # The point of the check: a 25 MP bomb is rejected with zero decodes, so the
        # guard never depends on surviving the allocation it exists to prevent.
        self.assertEqual(int(loads), 0)
        self.assertFalse(os.path.exists(output))


# ---------------------------------------------------------------------------
# Worker end to end
# ---------------------------------------------------------------------------

@requires_pillow
@requires_posix
class WorkerRunTests(Fixture):
    def test_a_queued_asset_is_thumbnailed_and_published_with_a_derived_key(self):
        digest = self.seed(ASSET_IMAGE, png_bytes(size=(1600, 900)))
        worker = self.worker()
        self.assertTrue(worker.run_once())
        key = self.thumbnail_key(ASSET_IMAGE)
        self.assertEqual(key, f"derived/image-thumbnails/v1/{digest}.webp")
        self.assertIn(key, self.s3.puts)
        self.assertEqual(self.s3.objects[key]["content_type"], "image/webp")
        assert Image is not None
        with Image.open(io.BytesIO(self.s3.objects[key]["body"])) as encoded:
            self.assertEqual(encoded.format, "WEBP")
            self.assertEqual(max(encoded.size), 512)
        row = self.jobs(ASSET_IMAGE)[0]
        self.assertEqual((row["state"], row["last_error"]), ("done", None))
        # The original object is untouched: a derived key never replaces a source.
        self.assertIn(f"images/inbox/{ASSET_IMAGE}/original", self.s3.objects)
        self.assertEqual(self.s3.puts, [key])

    def test_running_twice_does_not_reencode_a_done_job(self):
        self.seed(ASSET_IMAGE, png_bytes())
        worker = self.worker()
        self.assertTrue(worker.run_once())
        self.assertFalse(worker.run_once())
        self.assertEqual(len(self.s3.puts), 1)

    def test_mobile_list_generation_advances_when_the_thumbnail_lands(self):
        self.seed(ASSET_IMAGE, png_bytes())
        before = self.generation()
        self.worker().run_once()
        # The shipped asset_list_update trigger must have fired for the mobile reader.
        self.assertGreater(self.generation(), before)

    def test_the_source_digest_is_verified_before_encoding(self):
        payload = png_bytes()
        self.seed(ASSET_IMAGE, payload, sha256="b" * 64)
        worker = self.worker()
        self.assertTrue(worker.run_once())
        self.assertIsNone(self.thumbnail_key(ASSET_IMAGE))
        row = self.jobs(ASSET_IMAGE)[0]
        self.assertEqual((row["state"], row["last_error"]),
                         ("failed", "sourceDigestMismatch"))
        self.assertEqual(self.s3.puts, [])

    def test_a_declared_size_mismatch_is_terminal(self):
        payload = png_bytes()
        self.seed(ASSET_IMAGE, payload)
        self.db.execute("UPDATE assets SET size_bytes=size_bytes+1 WHERE id=?", [ASSET_IMAGE])
        self.db.commit()
        worker = self.worker()
        worker.run_once()
        self.assertEqual(self.jobs(ASSET_IMAGE)[0]["last_error"], "sourceSizeMismatch")
        self.assertIsNone(self.thumbnail_key(ASSET_IMAGE))

    def test_an_oversize_declared_source_is_never_streamed(self):
        self.seed(ASSET_IMAGE, png_bytes())
        self.db.execute("UPDATE assets SET size_bytes=? WHERE id=?",
                        [worker_module.MAX_SOURCE_BYTES + 1, ASSET_IMAGE])
        self.db.commit()
        self.worker().run_once()
        self.assertEqual(self.jobs(ASSET_IMAGE)[0]["last_error"], "sourceTooLarge")
        self.assertEqual(self.s3.puts, [])

    def test_a_missing_remote_object_is_terminal_not_retried(self):
        payload = png_bytes()
        self.seed(ASSET_IMAGE, payload)
        self.s3.objects.clear()
        self.worker().run_once()
        row = self.jobs(ASSET_IMAGE)[0]
        self.assertEqual((row["state"], row["last_error"]), ("failed", "sourceUnavailable"))

    def test_a_non_image_content_type_is_terminal(self):
        self.seed(ASSET_IMAGE, png_bytes(), content_type="application/octet-stream")
        self.worker().run_once()
        row = self.jobs(ASSET_IMAGE)[0]
        self.assertEqual((row["state"], row["last_error"]), ("failed", "sourceNotImage"))

    def test_an_undecodable_object_is_terminal_after_one_attempt(self):
        self.seed(ASSET_IMAGE, b"this is not a png, it only claims to be")
        self.worker().run_once()
        row = self.jobs(ASSET_IMAGE)[0]
        self.assertEqual((row["state"], row["last_error"]),
                         ("failed", "sourceUndecodable"))
        self.assertEqual(row["attempts"], 1)
        self.assertEqual(self.s3.puts, [])

    def test_a_transient_storage_read_is_retried_with_backoff_then_succeeds(self):
        self.seed(ASSET_IMAGE, png_bytes())
        self.s3.get_failures = 1
        worker = self.worker()
        self.assertTrue(worker.run_once())
        row = self.jobs(ASSET_IMAGE)[0]
        self.assertEqual((row["state"], row["last_error"]),
                         ("queued", "storageReadFailed"))
        # The deferred job is not immediately claimable: backoff is real, not cosmetic.
        self.assertEqual(self.db.execute(
            f"SELECT lease_until FROM {worker_module.TABLE} WHERE asset_id=?",
            [ASSET_IMAGE]).fetchone()[0], row["lease_until"])
        self.assertFalse(worker.run_once())
        self.assertIsNone(self.thumbnail_key(ASSET_IMAGE))
        self.db.execute(f"UPDATE {worker_module.TABLE} SET lease_until=0 WHERE asset_id=?",
                        [ASSET_IMAGE])
        self.db.commit()
        self.assertTrue(worker.run_once())
        self.assertIsNotNone(self.thumbnail_key(ASSET_IMAGE))
        self.assertEqual(self.jobs(ASSET_IMAGE)[0]["state"], "done")

    def test_a_backoff_delay_grows_with_each_attempt_and_is_capped(self):
        # Bounded, increasing, and never unbounded: attempt 1 waits RETRY_BACKOFF[0],
        # attempt 2 waits RETRY_BACKOFF[1], attempt 3 is already terminal.
        self.assertEqual(len(worker_module.RETRY_BACKOFF_SECONDS), worker_module.MAX_ATTEMPTS - 1)
        self.assertTrue(all(delay > 0 for delay in worker_module.RETRY_BACKOFF_SECONDS))
        self.assertEqual(list(worker_module.RETRY_BACKOFF_SECONDS),
                         sorted(worker_module.RETRY_BACKOFF_SECONDS))
        self.seed(ASSET_IMAGE, png_bytes())
        self.s3.get_failures = 25
        worker = self.worker()
        worker.run_once()
        first = self.jobs(ASSET_IMAGE)[0]["lease_until"] - time.time()
        self.db.execute(f"UPDATE {worker_module.TABLE} SET lease_until=0 WHERE asset_id=?",
                        [ASSET_IMAGE])
        self.db.commit()
        worker.run_once()
        second = self.jobs(ASSET_IMAGE)[0]["lease_until"] - time.time()
        self.assertGreater(second, first)

    def test_a_read_that_fails_midway_is_transient_not_a_partial_digest(self):
        payload = png_bytes()
        self.seed(ASSET_IMAGE, payload)
        key = f"images/inbox/{ASSET_IMAGE}/original"
        self.s3.objects[key] = {"body": _BrokenBody(payload[:10]), "content_type": "image/png"}
        self.worker().run_once()
        row = self.jobs(ASSET_IMAGE)[0]
        self.assertEqual((row["state"], row["last_error"]), ("queued", "storageReadFailed"))
        self.assertIsNone(self.thumbnail_key(ASSET_IMAGE))

    def test_a_failed_upload_retries_and_never_publishes_a_dangling_key(self):
        self.seed(ASSET_IMAGE, png_bytes())
        self.s3.put_failures = 1
        worker = self.worker()
        worker.run_once()
        self.assertIsNone(self.thumbnail_key(ASSET_IMAGE))
        self.assertEqual(self.jobs(ASSET_IMAGE)[0]["last_error"], "storageWriteFailed")
        self.db.execute(f"UPDATE {worker_module.TABLE} SET lease_until=0 WHERE asset_id=?",
                        [ASSET_IMAGE])
        self.db.commit()
        worker.run_once()
        self.assertIsNotNone(self.thumbnail_key(ASSET_IMAGE))

    def test_bounded_retries_make_a_persistently_failing_job_terminal(self):
        self.seed(ASSET_IMAGE, png_bytes())
        self.s3.get_failures = 25
        worker = self.worker()
        seen = []
        for _ in range(worker_module.MAX_ATTEMPTS):
            worker.run_once()
            seen.append(self.jobs(ASSET_IMAGE)[0]["state"])
            # Simulate the backoff elapsing without sleeping through it.
            self.db.execute(f"UPDATE {worker_module.TABLE} SET lease_until=0 WHERE asset_id=?",
                            [ASSET_IMAGE])
            self.db.commit()
        self.assertEqual(seen, ["queued", "queued", "failed"])
        row = self.jobs(ASSET_IMAGE)[0]
        self.assertEqual((row["attempts"], row["last_error"]),
                         (worker_module.MAX_ATTEMPTS, "storageReadFailed"))
        # A terminal job is not claimable again; only an explicit repair requeues it.
        self.db.execute(f"UPDATE {worker_module.TABLE} SET lease_until=0 WHERE asset_id=?",
                        [ASSET_IMAGE])
        self.db.commit()
        self.assertFalse(worker.run_once())
        self.assertEqual(self.jobs(ASSET_IMAGE)[0]["state"], "failed")

    def test_a_crashed_run_is_recovered_when_its_lease_expires(self):
        digest = self.seed(ASSET_IMAGE, png_bytes())
        self.db.execute(
            f"UPDATE {worker_module.TABLE} SET state='running',attempts=1,lease_until=? "
            f"WHERE asset_id=?", [time.time() + 3600, ASSET_IMAGE])
        self.db.commit()
        worker = self.worker()
        # A live lease belongs to another (possibly still running) worker.
        self.assertFalse(worker.run_once())
        self.db.execute(f"UPDATE {worker_module.TABLE} SET lease_until=0 WHERE asset_id=?",
                        [ASSET_IMAGE])
        self.db.commit()
        self.assertTrue(worker.run_once())
        self.assertEqual(self.thumbnail_key(ASSET_IMAGE),
                         f"derived/image-thumbnails/v1/{digest}.webp")

    def test_a_trashed_asset_is_not_published(self):
        self.seed(ASSET_IMAGE, png_bytes())
        worker = self.worker()
        # Trash during the download/encode window. The shipped visibility projection no
        # longer returns the Asset, which is exactly what publication re-checks.
        self.hide(worker._connection(), ASSET_IMAGE)
        worker._connection().commit()
        self.assertTrue(worker.run_once())
        self.assertIsNone(self.thumbnail_key(ASSET_IMAGE))
        self.assertEqual(self.jobs(ASSET_IMAGE)[0]["last_error"], "jobNotFound")

    def test_an_asset_that_disappears_before_its_job_runs_is_terminal(self):
        self.seed(ASSET_IMAGE, png_bytes())
        self.db.execute("DELETE FROM assets WHERE id=?", [ASSET_IMAGE])
        self.db.commit()
        self.worker().run_once()
        row = self.jobs(ASSET_IMAGE)[0]
        self.assertEqual((row["state"], row["last_error"]), ("failed", "jobNotFound"))

    def test_an_asset_replaced_during_encoding_is_not_published(self):
        self.seed(ASSET_IMAGE, png_bytes())
        original_put = self.s3.put_object

        def replace_then_put(**kwargs):
            self.db.execute("UPDATE assets SET sha256=? WHERE id=?", ["c" * 64, ASSET_IMAGE])
            self.db.commit()
            return original_put(**kwargs)

        self.s3.put_object = replace_then_put
        self.worker().run_once()
        self.assertIsNone(self.thumbnail_key(ASSET_IMAGE))
        self.assertEqual(self.jobs(ASSET_IMAGE)[0]["last_error"], "assetChanged")
        # The derived object stays: another Asset with the same content may share it.
        self.assertEqual(len(self.s3.puts), 1)

    def test_a_thumbnail_that_appeared_meanwhile_wins(self):
        self.seed(ASSET_IMAGE, png_bytes())
        original_put = self.s3.put_object

        def publish_elsewhere_then_put(**kwargs):
            self.db.execute("UPDATE assets SET thumbnail_key='library/other/thumbnail' WHERE id=?",
                            [ASSET_IMAGE])
            self.db.commit()
            return original_put(**kwargs)

        self.s3.put_object = publish_elsewhere_then_put
        self.worker().run_once()
        self.assertEqual(self.thumbnail_key(ASSET_IMAGE), "library/other/thumbnail")
        self.assertEqual(self.jobs(ASSET_IMAGE)[0]["last_error"], "thumbnailAlreadyPresent")

    def test_identical_content_shares_one_immutable_derived_key(self):
        digest = self.seed(ASSET_IMAGE, png_bytes())
        self.seed(ASSET_VIDEO, png_bytes() + b"", object_key="images/inbox/other/original",
                  sha256=digest)
        worker = self.worker()
        worker.run_once()
        worker.run_once()
        self.assertEqual(self.s3.puts,
                         [f"derived/image-thumbnails/v1/{digest}.webp"] * 2)
        self.assertEqual(self.thumbnail_key(ASSET_IMAGE), self.thumbnail_key(ASSET_VIDEO))

    def test_a_timed_out_encoder_is_transient_and_leaves_no_artifact(self):
        self.seed(ASSET_IMAGE, png_bytes())
        worker = self.worker()
        worker.encoder_script = str(Path(self.temp.name) / "hang.py")
        Path(worker.encoder_script).write_text("import time\ntime.sleep(60)\n")
        worker_module.ENCODE_TIMEOUT_SECONDS, original = 0.5, worker_module.ENCODE_TIMEOUT_SECONDS
        try:
            started = time.monotonic()
            worker.run_once()
            self.assertLess(time.monotonic() - started, 15)
        finally:
            worker_module.ENCODE_TIMEOUT_SECONDS = original
        self.assertIsNone(self.thumbnail_key(ASSET_IMAGE))
        self.assertEqual(self.jobs(ASSET_IMAGE)[0]["last_error"], "encodeTimedOut")

    def test_an_oversized_child_artifact_is_refused_without_full_read(self):
        # The output file is written by a child the parent does not control, so the read
        # is bounded: a runaway child must not be able to make the API process pull an
        # arbitrary file into memory.
        self.seed(ASSET_IMAGE, png_bytes())
        worker = self.worker()
        worker.encoder_script = str(Path(self.temp.name) / "oversize.py")
        Path(worker.encoder_script).write_text(
            "import sys\n"
            "open(sys.argv[2], 'wb').write(b'x' * (4 * 1024 * 1024))\n")
        read_limit = worker_module.MAX_ARTIFACT_BYTES
        self.assertLess(read_limit, 4 * 1024 * 1024)
        self.assertTrue(worker.run_once())
        self.assertIsNone(self.thumbnail_key(ASSET_IMAGE))
        self.assertEqual(self.jobs(ASSET_IMAGE)[0]["last_error"], "sourceUndecodable")
        self.assertEqual(self.s3.puts, [])

    def test_repeated_crash_before_outcome_terminalizes_instead_of_incrementing_forever(self):
        # A crash between claim and outcome runs no handler, so the attempt counter alone
        # would rise without bound and the job would never leave the queue. The claim
        # path must therefore refuse an exhausted job and terminalize it.
        self.seed(ASSET_IMAGE, png_bytes())
        self.db.execute(
            f"UPDATE {worker_module.TABLE} SET state='running',attempts=?,lease_until=0 "
            f"WHERE asset_id=?", [worker_module.MAX_ATTEMPTS, ASSET_IMAGE])
        self.db.commit()
        worker = self.worker()
        self.assertFalse(worker.run_once())
        row = self.jobs(ASSET_IMAGE)[0]
        self.assertEqual(row["state"], "failed")
        self.assertEqual(row["attempts"], worker_module.MAX_ATTEMPTS)
        self.assertIsNotNone(row["last_error"])
        # A terminal job is not claimable; the counter cannot keep growing.
        self.db.execute(f"UPDATE {worker_module.TABLE} SET lease_until=0 WHERE asset_id=?",
                        [ASSET_IMAGE])
        self.db.commit()
        self.assertFalse(worker.run_once())
        self.assertEqual(self.jobs(ASSET_IMAGE)[0]["attempts"], worker_module.MAX_ATTEMPTS)


# ---------------------------------------------------------------------------
# Thread lifecycle and cross-process lock
# ---------------------------------------------------------------------------

class WorkerLifecycleTests(Fixture):
    def test_stop_retains_the_thread_handle_when_the_join_times_out(self):
        # Clearing the handle on a timed-out join would let a later start() clear the
        # stop flag and spawn a second thread while the first is still running — two
        # workers, one lock file, one database. The handle must survive that case.
        worker = self.worker(poll_seconds=0.05)
        entered, release = threading.Event(), threading.Event()
        original = worker._loop

        def blocked_loop():
            entered.set()
            release.wait(10)
            original()

        worker._loop = blocked_loop
        worker.start()
        try:
            self.assertTrue(entered.wait(5))
            live = worker._thread
            self.assertFalse(worker.stop(timeout=0.0))
            self.assertIsNotNone(worker._thread, "handle was cleared on a timed-out join")
            self.assertIs(worker._thread, live)
            # start() is therefore still a no-op rather than a second worker.
            worker.start()
            self.assertIs(worker._thread, live)
        finally:
            release.set()
            self.assertTrue(worker.stop(timeout=10.0))
        self.assertIsNone(worker._thread, "handle was not cleared after a real join")

    def test_a_stopped_worker_can_be_restarted(self):
        self.seed(ASSET_IMAGE, png_bytes())
        worker = self.worker(poll_seconds=0.05)
        worker.start()
        worker.stop()
        self.assertIsNone(worker._thread)
        worker.start()
        try:
            self.assertTrue(worker._thread is not None and worker._thread.is_alive())
        finally:
            worker.stop()

    def test_a_thread_still_alive_is_never_doubled_up(self):
        # The safety half of the liveness check: a live worker must refuse a second
        # start, otherwise two workers would share one lock file and one database.
        worker = self.worker(poll_seconds=0.05)
        worker.start()
        try:
            for _ in range(100):
                if worker._thread is not None and worker._thread.is_alive():
                    break
                time.sleep(0.01)
            live = worker._thread
            worker.start()
            self.assertIs(worker._thread, live)
        finally:
            worker.stop(timeout=10.0)

    @requires_pillow
    def test_start_after_a_timed_out_thread_exits_brings_the_worker_back(self):
        worker = self.worker(poll_seconds=0.05)
        original = worker._loop
        entered, released = threading.Event(), threading.Event()

        def slow_loop():
            entered.set()
            released.wait(10)
            original()

        worker._loop = slow_loop
        worker.start()
        try:
            self.assertTrue(entered.wait(5))
            self.assertFalse(worker.stop(timeout=0.0))
            live = worker._thread
            worker.start()
            self.assertIs(worker._thread, live)
            released.set()
            live.join(timeout=10.0)
            self.assertFalse(live.is_alive())
            worker._loop = original
            self.seed(ASSET_IMAGE, png_bytes())
            worker.start()
            self.assertIsNot(worker._thread, live)
            # Observe through this thread's connection, never the worker's connection.
            for _ in range(200):
                if self.thumbnail_key(ASSET_IMAGE) is not None:
                    break
                time.sleep(0.05)
            self.assertIsNotNone(self.thumbnail_key(ASSET_IMAGE))
        finally:
            released.set()
            self.assertTrue(worker.stop(timeout=10.0))

    @requires_pillow
    def test_a_slow_but_progressing_download_hits_the_absolute_deadline(self):
        # A stream that returns bytes slowly forever would never trip a per-read socket
        # timeout nor the 50 MiB ceiling. The absolute monotonic deadline is what stops
        # it. The clock is injected, so nothing here sleeps.
        self.seed(ASSET_IMAGE, png_bytes())
        worker = self.worker()
        worker_module.DOWNLOAD_TIMEOUT_SECONDS, original = 60.0, worker_module.DOWNLOAD_TIMEOUT_SECONDS
        ticks = iter([0.0, 0.0, 1_000.0] + [1_000.0 + index for index in range(50)])
        real = time.monotonic
        time.monotonic = lambda: next(ticks)
        try:
            worker.run_once()
        finally:
            time.monotonic = real
            worker_module.DOWNLOAD_TIMEOUT_SECONDS = original
        self.assertIsNone(self.thumbnail_key(ASSET_IMAGE))
        row = self.jobs(ASSET_IMAGE)[0]
        # Transient, not terminal: a slow peer is worth retrying under the attempt bound.
        self.assertEqual((row["state"], row["last_error"]),
                         ("queued", "storageReadFailed"))
        self.assertEqual(self.s3.puts, [])

    def test_start_and_stop_are_idempotent_and_leave_no_thread(self):
        worker = self.worker(poll_seconds=0.05)
        worker.start()
        worker.start()
        self.assertTrue(any(thread.name == "image-thumbnails"
                            for thread in threading.enumerate()))
        worker.stop()
        worker.stop()
        self.assertFalse(any(thread.name == "image-thumbnails"
                             for thread in threading.enumerate()))

    def test_a_second_worker_refuses_to_run_while_the_lock_is_held(self):
        first = self.worker(poll_seconds=0.05)
        second = self.worker(poll_seconds=0.05)
        first.start()
        # Wait for the first worker to actually take the lock, so this asserts the lock
        # rather than a race with thread startup.
        for _ in range(100):
            if first._lock._handle is not None:
                break
            time.sleep(0.01)
        self.assertTrue(second._lock.acquire() is False)
        second.start()
        time.sleep(0.1)
        self.assertFalse(any(thread.name == "image-thumbnails"
                             and thread.is_alive() and thread is not first._thread
                             for thread in threading.enumerate()))
        first.stop()
        # Once the owner exits, the lock is genuinely available again.
        self.assertTrue(second._lock.acquire())
        second._lock.release()

    @requires_pillow
    @requires_posix
    def test_the_running_thread_does_the_work_while_the_api_thread_stays_free(self):
        digest = self.seed(ASSET_IMAGE, png_bytes())
        worker = self.worker(poll_seconds=0.05)
        worker.start()
        try:
            for _ in range(200):
                if self.thumbnail_key(ASSET_IMAGE) is not None:
                    break
                time.sleep(0.05)
        finally:
            worker.stop()
        self.assertEqual(self.thumbnail_key(ASSET_IMAGE),
                         f"derived/image-thumbnails/v1/{digest}.webp")
        self.assertEqual(self.jobs(ASSET_IMAGE)[0]["state"], "done")


class GuardTests(unittest.TestCase):
    """The child must refuse to decode when it cannot bound itself.

    These exercise the real guard by making ``_apply_own_resource_limits`` fail, rather
    than relying on the parent to pre-apply limits: the child is now the only place
    limits are set, so the guard is what keeps an unbounded platform from decoding.
    """

    @requires_pillow
    def test_the_encoder_fails_closed_when_it_cannot_apply_its_own_memory_limit(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        source = os.path.join(directory.name, "source")
        output = os.path.join(directory.name, "out.webp")
        Path(source).write_bytes(png_bytes())
        # A real, otherwise-valid encode is sabotaged only at the guard, so a pass here
        # cannot come from the guard being unreachable.
        program = (
            "import sys\n"
            f"sys.path.insert(0, {str(SERVER_DIR)!r})\n"
            "import image_thumbnail_encode as encoder\n"
            "encoder._apply_own_resource_limits = lambda: False\n"
            f"sys.exit(encoder.main(['x', {source!r}, {output!r}]))\n"
        )
        completed = subprocess.run([sys.executable, "-c", program], capture_output=True,
                                   timeout=60, check=False)
        self.assertEqual(completed.returncode, encoder.EXIT_UNSUPPORTED_PLATFORM)
        self.assertEqual(completed.stdout, b"")
        self.assertFalse(os.path.exists(output))

    def test_resource_limits_reports_failure_when_the_platform_cannot_bound_it(self):
        # ``resource`` is POSIX-only. Faking its absence is how a Windows host appears
        # to this function, and the answer must be "cannot bound myself", not a
        # hopeful True that would let the process decode unbounded.
        import builtins
        real_import = builtins.__import__

        def refuse_resource(name, *args, **kwargs):
            if name == "resource":
                raise ImportError("no resource module")
            return real_import(name, *args, **kwargs)

        builtins.__import__ = refuse_resource
        try:
            self.assertFalse(encoder._apply_own_resource_limits())
        finally:
            builtins.__import__ = real_import

    @requires_posix
    def test_the_encoder_applies_its_own_limits_before_decoding(self):
        # The child is asked to prove it is capped from the inside, which is the
        # property the parent relies on when it passes no preexec callback at all.
        program = (
            "import sys, resource\n"
            f"sys.path.insert(0, {str(SERVER_DIR)!r})\n"
            "import image_thumbnail_encode as encoder\n"
            "assert encoder._apply_own_resource_limits() is True\n"
            "soft, _hard = resource.getrlimit(resource.RLIMIT_AS)\n"
            "assert soft == encoder.ADDRESS_SPACE_BYTES, soft\n"
            "print('bounded')\n"
        )
        completed = subprocess.run([sys.executable, "-c", program], capture_output=True,
                                   timeout=60, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr[-400:])
        self.assertEqual(completed.stdout.strip(), b"bounded")

    def test_the_worker_passes_no_preexec_callback_to_the_child(self):
        # A preexec_fn runs between fork and exec in the threaded API process, where
        # another thread may hold a lock, so it must never be reintroduced. The check is
        # aimed at the spawn call rather than the whole file, because the module also
        # documents why the callback is absent.
        source = Path(SERVER_DIR / "image_thumbnails.py").read_text()
        spawn = source.split("def _encode(", 1)[1].split("def _read_output", 1)[0]
        self.assertNotIn("preexec_fn", spawn)
        self.assertNotIn("start_new_session", spawn)
        self.assertNotIn("killpg", source)

    def test_the_worker_bounds_the_artifact_it_reads_back(self):
        # The output file is written by a child process, so the parent re-applies the
        # bound rather than trusting the child to have respected it.
        self.assertEqual(worker_module.MAX_ARTIFACT_BYTES, encoder.MAX_OUTPUT_BYTES)


if __name__ == "__main__":
    unittest.main()
