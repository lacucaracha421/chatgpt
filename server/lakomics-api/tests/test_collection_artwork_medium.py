"""Medium spine art: the real encoder child on a temporary database and an in-memory object store."""
import hashlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing, redirect_stdout
from pathlib import Path
from types import ModuleType
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import authority
import collection_artwork_medium as medium
import collection_artwork_medium_backfill as backfill
import collection_authority
from tests.test_card_art_medium import MemoryStore, picture, requires_pillow

try:
    from PIL import Image
except ImportError:  # pragma: no cover - the production venv installs Pillow
    Image = None


def spine(sha, size, content_type="image/jpeg", kind="spine"):
    return {"id": "art-" + sha[:8], "kind": kind, "selected": True,
            "original": {"sha256": sha, "sizeBytes": size, "contentType": content_type, "objectKey": "work-artwork/mobile/" + sha}}


@requires_pillow
class MediumSpines(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "control.sqlite"
        self.store = MemoryStore()
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("CREATE TABLE mobile_collections(id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,"
                       "showcase INTEGER NOT NULL,showcase_order INTEGER,payload TEXT NOT NULL)")
            db.executescript(authority.AUTHORITY_DDL)
            collection_authority.startup_db(db)
            db.commit()

    def add_work(self, id, type, *artworks):
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("INSERT INTO mobile_collections VALUES(?,?,?,0,NULL,?)",
                       [id, type, id, json.dumps({"id": id, "type": type, "artworks": list(artworks)})])
            db.commit()

    def add_original(self, data=None, content_type="image/jpeg", seed=0):
        data = picture(seed=seed) if data is None else data
        sha = hashlib.sha256(data).hexdigest()
        self.store.objects["work-artwork/mobile/" + sha] = (data, content_type)
        return spine(sha, len(data), content_type)

    def db(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        return closing(db)

    def run_backfill(self, *args):
        fake = ModuleType("r2")
        fake.thumbnail_storage_client = mock.Mock(return_value=self.store)
        fake.R2_BUCKET = "bucket"
        out = io.StringIO()
        with mock.patch.dict(sys.modules, {"r2": fake}), redirect_stdout(out):
            backfill.main(["--database", str(self.path), "--delay", "0", *args])
        return json.loads(out.getvalue()), fake

    def test_only_game_and_av_spines_are_wanted_once_each_and_unreadable_ones_are_set_aside(self):
        shared = self.add_original(seed=1)
        self.add_work("game", "game", shared, {**shared, "id": "cover", "kind": "cover"})
        self.add_work("av", "av", shared, self.add_original(seed=2))
        self.add_work("book", "manga", self.add_original(seed=3))
        gif = self.add_original(b"GIF89a", "image/gif")
        self.add_work("gif", "game", gif)
        with self.db() as db:
            sources = medium.wanted(db, "mobile_collections")
            self.assertEqual(len(sources), 3)
            sorted_sources = medium.classify(db, sources)
        self.assertEqual(len(sorted_sources["todo"]), 2)
        self.assertEqual(sorted_sources["unsupported"], [gif["original"]["sha256"]])

    def test_a_copy_is_a_768_px_webp_found_by_its_original_and_remembered(self):
        original = self.add_original(picture(1800, 2400, "PNG"), "image/png")
        self.add_work("game", "game", original)
        with self.db() as db:
            row = medium.classify(db, medium.wanted(db, "mobile_collections"))["todo"][0]
            digest, size, key = medium.make(self.store, "bucket", row)
            medium.install(db)
            medium.record(db, row, digest, size, key)
            self.assertEqual(key, "derived/collection-medium/v1/" + digest + ".webp")
            data, content_type = self.store.objects[key]
            self.assertEqual((content_type, len(data)), ("image/webp", size))
            with Image.open(io.BytesIO(data)) as image:
                self.assertEqual((image.format, image.size), ("WEBP", (576, 768)))
            sha = original["original"]["sha256"]
            self.assertEqual(medium.classify(db, medium.wanted(db, "mobile_collections"))["ready"], [sha])
            self.assertEqual(medium.digests(db, [{"type": "game", "artworks": [original]}]), {sha: digest})
            self.assertEqual(medium.lookup(db, sha)["object_key"], key)

    def test_the_backfill_dry_run_changes_nothing_and_apply_is_resumable_and_idempotent(self):
        for index in range(3):
            self.add_work("game%d" % index, "game", self.add_original(seed=index + 10))
        before = dict(self.store.objects)

        report, fake = self.run_backfill()
        self.assertEqual((report["dryRun"], report["spines"], report["todo"], report["unsupported"]), (True, 3, 3, 0))
        self.assertEqual(report["downloadBytes"], sum(len(data) for data, _ in before.values()))
        self.assertEqual(report["estimatedStoredBytes"], 3 * medium.ESTIMATED_BYTES)
        fake.thumbnail_storage_client.assert_not_called()
        self.assertEqual(self.store.objects, before)
        with self.db() as db:
            self.assertIsNone(db.execute("SELECT 1 FROM sqlite_master WHERE name='collection_artwork_medium'").fetchone())

        report, _ = self.run_backfill("--apply", "--limit", "2")
        self.assertEqual(report["outcome"], {"made": 2})
        report, _ = self.run_backfill("--apply")
        self.assertEqual((report["todo"], report["ready"], report["outcome"]), (1, 2, {"made": 1}))
        objects = dict(self.store.objects)
        report, _ = self.run_backfill("--apply")
        self.assertEqual((report["todo"], report["ready"], report["outcome"]), (0, 3, {}))
        self.assertEqual(self.store.objects, objects)
        self.assertEqual(len([key for key in objects if key.startswith(medium.PREFIX)]), 3)
        # Originals are untouched.
        self.assertTrue(all(objects[key] == before[key] for key in before))

    def test_the_worker_covers_what_is_left_and_gives_up_on_a_hopeless_original_until_restart(self):
        self.add_work("good", "game", self.add_original(seed=20))
        broken = self.add_original(b"not an image at all")
        self.add_work("broken", "av", broken)
        reads = []
        real_get = self.store.get_object
        self.store.get_object = lambda Bucket, Key: reads.append(Key) or real_get(Bucket, Key)
        worker = medium.CollectionArtworkMediumWorker(
            self.path, self.store, "bucket", wanted=lambda db: medium.wanted(db, "mobile_collections"),
            on_change=lambda db: None, batch=3, delay=0)
        self.assertEqual(worker.run_once(), 1)
        self.assertEqual(worker.run_once(), 0)
        self.assertEqual(reads.count("work-artwork/mobile/" + broken["original"]["sha256"]), 1)


if __name__ == "__main__":
    unittest.main()
