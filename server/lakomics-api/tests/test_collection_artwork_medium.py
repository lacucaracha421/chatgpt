"""Medium spine art: the real encoder child on a temporary database and an in-memory object store."""
import hashlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import authority
import collection_artwork_medium as medium
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
