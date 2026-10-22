"""Medium card art: the real encoder child on a temporary database and an in-memory object store."""
import hashlib
import io
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import asset_visibility
import card_art_medium
import cards
import image_thumbnail_encode as encoder

try:
    from PIL import Image
except ImportError:  # pragma: no cover - the production venv installs Pillow
    Image = None

SERVER_DIR = Path(__file__).resolve().parents[1]
NOW = "2026-10-15T03:00:00+00:00"
requires_pillow = unittest.skipIf(Image is None, "Pillow is unavailable in this environment")


class Missing(Exception):
    response = {"Error": {"Code": "NoSuchKey"}}


class MemoryStore:
    """Just the S3 calls the thumbnail download, publish and read-back use."""

    def __init__(self):
        self.objects = {}

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise Missing()
        data, content_type = self.objects[Key]
        return {"Body": io.BytesIO(data), "ContentLength": len(data), "ContentType": content_type}

    def put_object(self, Bucket, Key, Body, ContentType):
        self.objects[Key] = (Body.read(), ContentType)


def picture(width=2000, height=1400, fmt="JPEG", seed=0):
    image = Image.new("RGB", (width, height))
    image.putdata([((x * 7 + seed) % 256, (y * 5) % 256, ((x + y) * 3 + seed * 2) % 256)
                   for y in range(height) for x in range(width)])
    sink = io.BytesIO()
    image.save(sink, format=fmt)
    return sink.getvalue()


@requires_pillow
class MediumArt(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "control.sqlite"
        self.store = MemoryStore()
        with self.db() as db:
            db.execute("CREATE TABLE assets(id TEXT PRIMARY KEY,kind TEXT NOT NULL,content_type TEXT,object_key TEXT,"
                       "sha256 TEXT,size_bytes INTEGER,committed INTEGER,width INTEGER,height INTEGER,"
                       "created_at TEXT,updated_at TEXT,collected_at TEXT)")
            cards.startup_db(db)
            db.commit()

    def db(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        return closing_connection(db)

    def add_art(self, asset_id, data=None, *, kind="image", content_type="image/jpeg", committed=1, in_album=True):
        data = picture(seed=sum(asset_id.encode())) if data is None else data
        self.store.objects["original/" + asset_id] = (data, content_type)
        with self.db() as db:
            db.execute("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)",
                       [asset_id, kind, content_type, "original/" + asset_id, hashlib.sha256(data).hexdigest(),
                        len(data), committed, 2000, 1400, NOW, NOW])
            if in_album:
                db.execute("INSERT INTO card_album VALUES(?,?,1,1,?,?,?,NULL)",
                           ["character-" + asset_id, "n", asset_id, NOW, NOW])
            db.commit()

    def classify(self, ids):
        with self.db() as db:
            asset_visibility.install(db)
            return card_art_medium.classify(db, ids)

    def make_and_record(self, row):
        digest, size, key = card_art_medium.make(self.store, "bucket", row)
        with self.db() as db:
            asset_visibility.install(db)
            return card_art_medium.record(db, row, digest, size, key), digest, size, key

    def test_a_copy_is_a_768_px_webp_under_a_content_addressed_key_and_is_remembered(self):
        self.add_art("art1")
        self.add_art("art2", picture(1800, 2400, "PNG"), content_type="image/png")
        todo = self.classify(["art1", "art2"])["todo"]
        self.assertEqual([row["id"] for row in todo], ["art1", "art2"])
        for row, size in zip(todo, [(768, 538), (576, 768)]):
            recorded, digest, bytes_, key = self.make_and_record(row)
            self.assertTrue(recorded)
            self.assertEqual(key, "derived/card-medium/v1/" + digest + ".webp")
            data, content_type = self.store.objects[key]
            self.assertEqual((content_type, len(data), hashlib.sha256(data).hexdigest()), ("image/webp", bytes_, digest))
            with Image.open(io.BytesIO(data)) as image:
                self.assertEqual((image.format, image.size), ("WEBP", size))
        sorted_ids = self.classify(["art1", "art2"])
        self.assertEqual((sorted_ids["ready"], sorted_ids["todo"]), (["art1", "art2"], []))

    def test_classify_leaves_out_unreadable_assets_and_redoes_a_changed_original(self):
        self.add_art("art1")
        self.add_art("animated", kind="animated_gif", content_type="image/gif")
        self.add_art("hidden", committed=0)
        sorted_ids = self.classify(["art1", "animated", "hidden", "missing"])
        self.assertEqual(([row["id"] for row in sorted_ids["todo"]], sorted_ids["unsupported"], sorted_ids["gone"]),
                         (["art1"], ["animated"], ["hidden", "missing"]))
        self.make_and_record(sorted_ids["todo"][0])
        with self.db() as db:
            db.execute("UPDATE assets SET sha256=? WHERE id='art1'", ["d" * 64])
            db.commit()
        self.assertEqual([row["id"] for row in self.classify(["art1"])["todo"]], ["art1"])

    def test_nothing_is_recorded_when_the_original_changed_while_the_copy_was_made(self):
        self.add_art("art1")
        row = self.classify(["art1"])["todo"][0]
        digest, size, key = card_art_medium.make(self.store, "bucket", row)
        with self.db() as db:
            db.execute("UPDATE assets SET sha256=? WHERE id='art1'", ["d" * 64])
            db.commit()
            asset_visibility.install(db)
            self.assertFalse(card_art_medium.record(db, row, digest, size, key))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM card_art_medium").fetchone()[0], 0)

    def test_the_encoder_takes_a_larger_edge_only_within_its_bounds(self):
        source = Path(self.temp.name) / "source.jpg"
        source.write_bytes(picture())

        def run(*extra):
            output = Path(self.temp.name) / ("out%d.webp" % len(extra))
            code = subprocess.run([sys.executable, str(SERVER_DIR / "image_thumbnail_encode.py"), str(source), str(output),
                                   "image", *extra], stdin=subprocess.DEVNULL, capture_output=True).returncode
            return code, output
        code, output = run()
        with Image.open(output) as image:
            self.assertEqual((code, max(image.size)), (encoder.EXIT_OK, 512))
        self.assertEqual(run("768")[0], encoder.EXIT_OK)
        self.assertEqual(run("2048")[0], encoder.EXIT_USAGE)
        self.assertEqual(run("256")[0], encoder.EXIT_USAGE)

    def test_the_worker_makes_copies_in_batches_and_gives_up_on_a_hopeless_original_until_restart(self):
        self.add_art("art1")
        self.add_art("art2")
        self.add_art("broken", b"not an image at all", content_type="image/jpeg")
        reads = []
        real_get = self.store.get_object
        self.store.get_object = lambda Bucket, Key: reads.append(Key) or real_get(Bucket, Key)
        worker = card_art_medium.CardArtMediumWorker(
            self.path, self.store, "bucket", wanted=lambda db: cards.medium_wanted(db, "all"),
            on_change=cards.touch, batch=2, delay=0)
        # Same time drawn: album order falls back to the character id, so art1, art2, broken.
        self.assertEqual(worker.run_once(), 2)
        self.assertEqual(self.classify(["art1", "art2"])["ready"], ["art1", "art2"])
        self.assertEqual(worker.run_once(), 0)
        self.assertEqual(worker.run_once(), 0)
        self.assertEqual(reads.count("original/broken"), 1)
        with self.db() as db:
            self.assertEqual(db.execute("SELECT revision FROM card_state").fetchone()[0], 2)


class closing_connection:
    """A sqlite3 connection that closes on exit (sqlite3's own context manager only commits)."""

    def __init__(self, db):
        self.db = db

    def __enter__(self):
        return self.db

    def __exit__(self, *exc):
        self.db.close()


if __name__ == "__main__":
    unittest.main()
