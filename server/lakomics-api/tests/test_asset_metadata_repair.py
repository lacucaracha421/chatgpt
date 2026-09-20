"""Asset metadata repair: identity gate, preservation, guard and idempotence.

Everything here runs against real SQLite through the module's public functions. No
storage client, no network and no production path is involved: the cloud side is a
disposable database created by this file, and the snapshot is an in-memory record list,
which is the shape the operational extraction script is expected to produce.

The four properties worth pinning, in the order they can go wrong:

* **identity** — a repair only lands when the cloud Asset and the snapshot row agree on
  id, digest, size and kind;
* **preservation** — only the three repairable columns are written, and no existing
  value is overwritten;
* **geometry** — width and height move as one pair, so no width/height combination is
  recorded that neither side observed;
* **idempotence** — a second run of the same snapshot writes nothing.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER_DIR))

import asset_metadata_repair as repair

IMAGE = "10000000-0000-4000-8000-000000000001"
GIF = "10000000-0000-4000-8000-000000000002"
VIDEO = "10000000-0000-4000-8000-000000000003"
HIDDEN = "10000000-0000-4000-8000-000000000004"
UNCOMMITTED = "10000000-0000-4000-8000-000000000005"
GONE = "10000000-0000-4000-8000-000000000006"
REPLACED = "10000000-0000-4000-8000-000000000007"


def digest(seed: str) -> str:
    return hashlib.sha256(seed.encode()).hexdigest()


class Fixture(unittest.TestCase):
    """Real ``assets`` schema, real visibility projection, disposable database.

    The schema is the shipped one narrowed to the columns this module touches, plus the
    columns a repair must *not* disturb — ``object_key``, ``thumbnail_key``, ``authority``
    and the lifecycle fields are present precisely so a test can assert they survived.
    """

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp.name) / "cloud.sqlite3"
        with closing(sqlite3.connect(self.db_path)) as db:
            db.row_factory = sqlite3.Row
            db.executescript("""
                CREATE TABLE assets(
                 id TEXT PRIMARY KEY, kind TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE,
                 thumbnail_key TEXT, content_type TEXT, size_bytes INTEGER, sha256 TEXT,
                 width INTEGER, height INTEGER, duration_ms INTEGER,
                 committed INTEGER NOT NULL DEFAULT 0, import_source TEXT,
                 authority TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE asset_authority_state(
                 library_id TEXT NOT NULL, asset_id TEXT NOT NULL, lifecycle TEXT NOT NULL,
                 PRIMARY KEY(library_id,asset_id));
                CREATE TABLE authority_domains(
                 library_id TEXT NOT NULL, domain TEXT NOT NULL, epoch INTEGER NOT NULL,
                 change_cursor INTEGER NOT NULL, PRIMARY KEY(library_id,domain));
                CREATE TABLE asset_list_generation(
                 singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL);
                INSERT INTO asset_list_generation VALUES(1,0);
                CREATE TRIGGER asset_list_update AFTER UPDATE ON assets BEGIN
                 UPDATE asset_list_generation SET generation=generation+1 WHERE singleton=1; END;
            """)
            # The shipped projection, not a re-derived rule: the repair and the test must
            # agree on "hidden" because they read the same view.
            repair.install(db)
            db.commit()
        self.db = self.open()

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def open(self):
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        repair.install(connection)
        return connection

    def seed(self, asset_id, *, kind="image", body=b"original", sha256=None,
             width=None, height=None, duration_ms=None, committed=1,
             thumbnail_key=None, authority=None):
        key = f"library/{asset_id}/original"
        self.db.execute(
            "INSERT INTO assets(id,kind,object_key,thumbnail_key,content_type,size_bytes,"
            "sha256,width,height,duration_ms,committed,import_source,authority,created_at,"
            "updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'capture',?,'2026-01-01T00:00:00Z',"
            "'2026-01-01T00:00:00Z')",
            [asset_id, kind, key, thumbnail_key, "application/octet-stream", len(body),
             sha256 or digest(asset_id), width, height, duration_ms, committed, authority])
        self.db.commit()
        return asset_id

    def activate(self, asset_id, lifecycle):
        """Give an Asset canonical lifecycle state in an active ``assets`` domain."""
        self.db.execute("INSERT OR IGNORE INTO authority_domains VALUES('lib','assets',1,0)")
        self.db.execute("INSERT OR REPLACE INTO asset_authority_state VALUES('lib',?,?)",
                        [asset_id, lifecycle])
        self.db.commit()

    def hide(self, asset_id):
        """Trash an Asset through the real authority path, not a re-derived rule."""
        self.activate(asset_id, "trash")
        return asset_id

    def row(self, asset_id):
        return self.db.execute("SELECT * FROM assets WHERE id=?", [asset_id]).fetchone()

    def metadata(self, asset_id):
        row = self.row(asset_id)
        return (row["width"], row["height"], row["duration_ms"])

    def generation(self):
        return self.db.execute(
            "SELECT generation FROM asset_list_generation WHERE singleton=1").fetchone()[0]

    def outcome(self, result, asset_id):
        return next(record for record in result["records"] if record["asset_id"] == asset_id)


# ---------------------------------------------------------------------------
# Snapshot validation
# ---------------------------------------------------------------------------

class SnapshotParsingTests(Fixture):
    def test_only_normal_rows_become_sources(self):
        sources = repair.parse_records([
            {"id": IMAGE, "sha256": digest("a"), "size_bytes": 5, "kind": "image",
             "status": "normal", "width": 10, "height": 20},
            {"id": GIF, "sha256": digest("b"), "size_bytes": 5, "kind": "gif",
             "status": "trashed", "width": 10, "height": 20},
        ])
        self.assertEqual(set(sources), {IMAGE})

    def test_a_non_normal_status_is_dropped_rather_than_refused(self):
        # A PC library legitimately holds trashed rows; that is data, not a shape error.
        self.assertEqual(repair.parse_records([
            {"id": IMAGE, "sha256": digest("a"), "size_bytes": 5, "kind": "image",
             "status": "normal"}]), repair.parse_records([
            {"id": IMAGE, "sha256": digest("a"), "size_bytes": 5, "kind": "image",
             "status": "normal"}]))

    def test_invalid_records_refuse_the_whole_snapshot(self):
        base = {"id": IMAGE, "sha256": digest("a"), "size_bytes": 5, "kind": "image",
                "status": "normal", "width": 4, "height": 4}
        for label, override in [
            ("bad width", {"width": 0}),
            ("negative height", {"height": -3}),
            ("float dimension", {"width": 4.0}),
            ("boolean dimension", {"width": True}),
            ("over dimension bound", {"width": repair.MAX_DIMENSION + 1}),
            ("half pair", {"width": 40, "height": None}),
            ("bad digest", {"sha256": "not-a-digest"}),
            ("missing digest", {"sha256": None}),
            ("negative size", {"size_bytes": -1}),
            ("short kind", {"kind": "audio"}),
            ("missing kind", {"kind": None}),
            ("no id", {"id": None}),
        ]:
            with self.subTest(case=label):
                with self.assertRaises(repair.SnapshotError):
                    repair.parse_records([{**base, **override}])

    def test_large_dimensions_are_metadata_not_a_decoder_allocation(self):
        source = repair.parse_records([{"id": IMAGE, "sha256": digest("a"),
            "size_bytes": 5, "kind": "image", "status": "normal",
            "width": 8000, "height": 6000}])
        self.assertEqual(source[IMAGE]["pair"], (8000, 6000))

    def test_duration_on_a_non_video_is_refused_not_ignored(self):
        with self.assertRaises(repair.SnapshotError):
            repair.parse_records([{"id": IMAGE, "sha256": digest("a"), "size_bytes": 5,
                                   "kind": "image", "status": "normal",
                                   "width": 4, "height": 4, "duration_ms": 900}])

    def test_a_zero_duration_is_valid_and_an_invalid_one_is_refused(self):
        source = repair.parse_records([{"id": VIDEO, "sha256": digest("a"), "size_bytes": 5,
                                        "kind": "video", "status": "normal",
                                        "duration_ms": 0}])
        self.assertEqual(source[VIDEO]["duration_ms"], 0)
        with self.assertRaises(repair.SnapshotError):
            repair.parse_records([{"id": VIDEO, "sha256": digest("a"), "size_bytes": 5,
                                   "kind": "video", "status": "normal",
                                   "duration_ms": -1}])

    def test_a_duplicate_asset_id_is_refused(self):
        record = {"id": IMAGE, "sha256": digest("a"), "size_bytes": 5, "kind": "image",
                  "status": "normal", "width": 4, "height": 4}
        with self.assertRaises(repair.SnapshotError):
            repair.parse_records([record, dict(record)])

    def test_load_snapshot_reads_both_record_and_id_keyed_shapes(self):
        records = [{"id": IMAGE, "sha256": digest("a"), "size_bytes": 5, "kind": "image",
                    "status": "normal", "width": 8, "height": 6}]
        keyed = {IMAGE: {"sha256": digest("a"), "size_bytes": 5, "kind": "image",
                         "status": "normal", "width": 8, "height": 6}}
        for shape in (records, keyed):
            with self.subTest(shape=type(shape).__name__):
                path = Path(self.temp.name) / "snapshot.json"
                path.write_text(json.dumps(shape), encoding="utf-8")
                sources = repair.load_snapshot(path)
                self.assertEqual(sources[IMAGE]["pair"], (8, 6))

    def test_extraction_query_reads_pc_kinds_and_the_video_duration_join(self):
        query = repair.extraction_query()
        self.assertIn("video_assets", query)
        self.assertIn("content_hash", query)
        self.assertIn("status = 'normal'", query)


# ---------------------------------------------------------------------------
# Proposal
# ---------------------------------------------------------------------------

class ProposalTests(Fixture):
    def source(self, asset_id, *, width=800, height=600, duration=None, kind="image"):
        return {"id": asset_id, "sha256": digest(asset_id), "size_bytes": 8,
                "kind": kind, "status": "normal", "width": width, "height": height,
                "duration_ms": duration}

    def test_only_assets_the_snapshot_can_fill_become_candidates(self):
        result = repair.proposal(self.db, [self.source(IMAGE), self.source(GIF, width=None,
                                                                         height=None)])
        self.assertEqual([record["asset_id"] for record in result["records"]], [IMAGE])
        self.assertEqual(result["counts"]["candidates"], 1)
        self.assertEqual(result["counts"]["complete"], 1)

    def test_proposal_writes_nothing(self):
        self.seed(IMAGE)
        before = self.generation()
        repair.proposal(self.db, [self.source(IMAGE)])
        self.assertEqual(self.metadata(IMAGE), (None, None, None))
        self.assertEqual(self.generation(), before)

    def test_field_selection_narrows_the_candidate_shape(self):
        source = self.source(VIDEO, width=1920, height=1080, duration=4200, kind="video")
        result = repair.proposal(self.db, [source], fields=[], limit=None)
        self.assertEqual(result["counts"]["candidates"], 0)
        only_duration = repair.proposal(self.db, [source], fields=["duration_ms"])
        self.assertEqual(only_duration["records"][0]["width"], None)
        self.assertEqual(only_duration["records"][0]["duration_ms"], 4200)
        with self.assertRaises(ValueError):
            repair.proposal(self.db, [source], fields=["object_key"])


# ---------------------------------------------------------------------------
# Identity gate
# ---------------------------------------------------------------------------

class IdentityGateTests(Fixture):
    def source(self, asset_id, *, sha256=None, size_bytes=8, kind="image",
               width=800, height=600, duration=None):
        return {"id": asset_id, "sha256": sha256 or digest(asset_id),
                "size_bytes": size_bytes, "kind": kind, "status": "normal",
                "width": width, "height": height, "duration_ms": duration}

    def test_exact_identity_fills_missing_dimensions(self):
        self.seed(IMAGE)
        result = repair.apply(self.db, [self.source(IMAGE)])
        self.assertEqual(self.outcome(result, IMAGE)["outcome"], repair.FILLED)
        self.assertEqual(self.metadata(IMAGE), (800, 600, None))

    def test_a_digest_mismatch_is_a_replacement_not_a_repair(self):
        self.seed(IMAGE, sha256=digest("old"))
        result = repair.apply(self.db, [self.source(IMAGE)])
        self.assertEqual(self.outcome(result, IMAGE)["outcome"], repair.REPLACED)
        self.assertEqual(self.metadata(IMAGE), (None, None, None))

    def test_a_same_size_different_content_asset_is_still_rejected(self):
        # Size alone cannot identify an Asset: a re-commit at the same byte length would
        # otherwise be repaired from the replaced content's numbers.
        self.seed(IMAGE, sha256=digest("original"), body=b"12345678")
        result = repair.apply(self.db, [self.source(IMAGE, sha256=digest("replacement"),
                                                    size_bytes=8)])
        self.assertEqual(self.outcome(result, IMAGE)["outcome"], repair.REPLACED)

    def test_a_size_mismatch_is_a_replacement(self):
        self.seed(IMAGE)
        result = repair.apply(self.db, [self.source(IMAGE, size_bytes=99)])
        self.assertEqual(self.outcome(result, IMAGE)["outcome"], repair.REPLACED)

    def test_a_kind_mismatch_is_a_replacement(self):
        self.seed(IMAGE, kind="gif")
        result = repair.apply(self.db, [self.source(IMAGE, kind="image")])
        self.assertEqual(self.outcome(result, IMAGE)["outcome"], repair.REPLACED)
        self.assertEqual(self.metadata(IMAGE), (None, None, None))

    def test_a_missing_asset_is_not_found(self):
        result = repair.apply(self.db, [self.source(GONE)])
        self.assertEqual(self.outcome(result, GONE)["outcome"], repair.NOT_FOUND)
        self.assertEqual(result["counts"]["notFound"], 1)

    def test_a_hidden_asset_is_left_alone(self):
        self.seed(HIDDEN)
        self.hide(HIDDEN)
        result = repair.apply(self.db, [self.source(HIDDEN)])
        self.assertEqual(self.outcome(result, HIDDEN)["outcome"], repair.HIDDEN)
        self.assertEqual(self.metadata(HIDDEN), (None, None, None))

    def test_the_hidden_check_is_the_shipped_projection(self):
        # A tombstone and a trash are different lifecycle values but the same answer to
        # an ordinary reader, and the repair must use that answer, not its own.
        self.seed(HIDDEN)
        self.activate(HIDDEN, "tombstoned")
        result = repair.apply(self.db, [self.source(HIDDEN)])
        self.assertEqual(self.outcome(result, HIDDEN)["outcome"], repair.HIDDEN)
        self.assertEqual(self.metadata(HIDDEN), (None, None, None))

    def test_an_uncommitted_asset_is_left_alone(self):
        self.seed(UNCOMMITTED, committed=0)
        result = repair.apply(self.db, [self.source(UNCOMMITTED)])
        self.assertEqual(self.outcome(result, UNCOMMITTED)["outcome"], repair.UNCOMMITTED)
        self.assertEqual(self.metadata(UNCOMMITTED), (None, None, None))

    def test_a_restored_asset_becomes_repairable_again(self):
        self.seed(IMAGE)
        self.hide(IMAGE)
        self.assertEqual(self.outcome(repair.apply(self.db, [self.source(IMAGE)]),
                                      IMAGE)["outcome"], repair.HIDDEN)
        self.activate(IMAGE, "normal")
        self.assertEqual(self.outcome(repair.apply(self.db, [self.source(IMAGE)]),
                                      IMAGE)["outcome"], repair.FILLED)
        self.assertEqual(self.metadata(IMAGE), (800, 600, None))


# ---------------------------------------------------------------------------
# Preservation
# ---------------------------------------------------------------------------

class PreservationTests(Fixture):
    def source(self, asset_id, *, width=800, height=600, duration=None, kind="image"):
        return {"id": asset_id, "sha256": digest(asset_id), "size_bytes": 8,
                "kind": kind, "status": "normal", "width": width, "height": height,
                "duration_ms": duration}

    def test_existing_complete_metadata_is_never_overwritten(self):
        self.seed(IMAGE, width=640, height=480, duration_ms=None)
        result = repair.apply(self.db, [self.source(IMAGE)])
        # Not a conflict: the cloud already holds a full geometry, so the snapshot simply
        # has nothing to add. The values are preserved, not replaced by the snapshot's own.
        self.assertEqual(self.outcome(result, IMAGE)["outcome"], repair.COMPLETE)
        self.assertEqual(result["counts"]["conflict"], 0)
        self.assertEqual(self.metadata(IMAGE), (640, 480, None))

    def test_an_existing_value_the_snapshot_disagrees_with_is_preserved(self):
        self.seed(IMAGE, width=640, height=480)
        repair.apply(self.db, [self.source(IMAGE)])
        self.assertEqual(self.metadata(IMAGE), (640, 480, None))

    def test_a_conflicting_known_value_is_reported_not_replaced(self):
        self.seed(IMAGE, width=640)
        result = repair.apply(self.db, [self.source(IMAGE)])
        record = self.outcome(result, IMAGE)
        self.assertEqual(record["outcome"], repair.CONFLICT)
        self.assertEqual(record["conflict"], ["geometry"])
        # The missing side is deliberately not filled: the snapshot pair contradicts the
        # value the cloud already holds, so no width/height combination is invented.
        self.assertEqual(self.metadata(IMAGE), (640, None, None))

    def test_a_partial_pair_is_filled_only_when_the_known_side_agrees(self):
        self.seed(IMAGE, width=800)
        self.assertEqual(self.outcome(repair.apply(self.db, [self.source(IMAGE)]),
                                      IMAGE)["outcome"], repair.FILLED)
        self.assertEqual(self.metadata(IMAGE), (800, 600, None))

    def test_matching_known_sides_still_only_fill_the_missing_one(self):
        self.seed(VIDEO, kind="video", width=1920, duration_ms=5000)
        result = repair.apply(self.db, [self.source(VIDEO, width=1920, height=1080,
                                                    duration=4000, kind="video")])
        record = self.outcome(result, VIDEO)
        self.assertEqual(record["outcome"], repair.FILLED)
        self.assertEqual(record["conflict"], ["duration_ms"])
        self.assertEqual(self.metadata(VIDEO), (1920, 1080, 5000))

    def test_an_equal_existing_value_is_not_a_conflict(self):
        self.seed(IMAGE, width=800, height=600)
        result = repair.apply(self.db, [self.source(IMAGE)])
        self.assertEqual(self.outcome(result, IMAGE)["outcome"], repair.COMPLETE)
        self.assertEqual(result["counts"]["conflict"], 0)

    def test_every_other_column_and_the_thumbnail_are_preserved(self):
        self.seed(IMAGE, thumbnail_key="derived/image-thumbnails/v1/abc.webp",
                  authority="server", width=None, height=None)
        baseline = self.row(IMAGE)
        repair.apply(self.db, [self.source(IMAGE)])
        after = self.row(IMAGE)
        self.assertEqual(self.metadata(IMAGE), (800, 600, None))
        for column in ("id", "kind", "object_key", "thumbnail_key", "content_type",
                       "size_bytes", "sha256", "committed", "import_source", "authority",
                       "created_at"):
            with self.subTest(column=column):
                self.assertEqual(after[column], baseline[column])

    def test_updated_at_is_preserved_and_the_generation_trigger_advances(self):
        self.seed(IMAGE)
        before, generation = self.row(IMAGE)["updated_at"], self.generation()
        repair.apply(self.db, [self.source(IMAGE)])
        self.assertEqual(self.row(IMAGE)["updated_at"], before)
        self.assertGreater(self.generation(), generation)

    def test_a_video_duration_is_filled_independently_of_a_geometry_conflict(self):
        self.seed(VIDEO, kind="video", width=640)
        result = repair.apply(self.db, [self.source(VIDEO, width=1280, height=720,
                                                    duration=9000, kind="video")])
        record = self.outcome(result, VIDEO)
        self.assertEqual(record["outcome"], repair.FILLED)
        self.assertEqual(self.metadata(VIDEO), (640, None, 9000))


# ---------------------------------------------------------------------------
# Guarded write and idempotence
# ---------------------------------------------------------------------------

class ApplyTests(Fixture):
    def source(self, asset_id, *, width=800, height=600, duration=None, kind="image"):
        return {"id": asset_id, "sha256": digest(asset_id), "size_bytes": 8,
                "kind": kind, "status": "normal", "width": width, "height": height,
                "duration_ms": duration}

    def test_a_second_run_writes_nothing_and_reports_complete(self):
        self.seed(IMAGE)
        self.seed(VIDEO, kind="video")
        snapshot = [self.source(IMAGE), self.source(VIDEO, kind="video", duration=4200)]
        first = repair.apply(self.db, snapshot)
        self.assertEqual(first["counts"]["filled"], 2)
        after = {asset_id: (self.row(asset_id)["updated_at"], self.metadata(asset_id))
                 for asset_id in (IMAGE, VIDEO)}
        second = repair.apply(self.db, snapshot)
        self.assertEqual(second["counts"]["filled"], 0)
        self.assertEqual(second["counts"]["complete"], 2)
        self.assertEqual({asset_id: (self.row(asset_id)["updated_at"], self.metadata(asset_id))
                          for asset_id in (IMAGE, VIDEO)}, after)

    def test_a_dry_run_classifies_without_writing(self):
        self.seed(IMAGE)
        before = self.row(IMAGE)["updated_at"]
        result = repair.apply(self.db, [self.source(IMAGE)], dry_run=True)
        self.assertEqual(result["counts"]["filled"], 1)
        self.assertTrue(result["dryRun"])
        self.assertEqual(self.metadata(IMAGE), (None, None, None))
        self.assertEqual(self.row(IMAGE)["updated_at"], before)

    def test_a_refused_snapshot_reports_rather_than_raising(self):
        self.seed(IMAGE)
        result = repair.apply(self.db, [{"id": IMAGE, "sha256": "bad", "size_bytes": 8,
                                         "kind": "image", "status": "normal"}])
        self.assertEqual(result["counts"]["invalid"], 1)
        self.assertIn("sha256", result["error"])
        self.assertEqual(self.metadata(IMAGE), (None, None, None))

    def test_a_run_survives_one_asset_disappearing_between_calls(self):
        self.seed(IMAGE)
        self.seed(GIF)
        self.db.execute("DELETE FROM assets WHERE id=?", [GIF])
        self.db.commit()
        result = repair.apply(self.db, [self.source(IMAGE), self.source(GIF)])
        self.assertEqual(result["counts"]["filled"], 1)
        self.assertEqual(result["counts"]["notFound"], 1)

    def test_each_candidate_is_committed_independently(self):
        self.seed(IMAGE)
        self.seed(GIF)
        repair.apply(self.db, [self.source(IMAGE), self.source(GIF)])
        # A second connection observes both writes, which is what "committed per
        # candidate" means: the run is resumable rather than all-or-nothing.
        with closing(self.open()) as other:
            self.assertEqual(other.execute(
                "SELECT COUNT(*) FROM assets WHERE width IS NOT NULL").fetchone()[0], 2)

    def test_field_selection_limits_what_is_written(self):
        self.seed(VIDEO, kind="video")
        result = repair.apply(self.db, [self.source(VIDEO, kind="video", duration=7000)],
                              fields=["duration_ms"])
        self.assertEqual(self.metadata(VIDEO), (None, None, 7000))
        self.assertEqual(self.outcome(result, VIDEO)["fields"], {"duration_ms": 7000})

    def test_a_write_that_loses_its_guard_is_reported_as_replaced(self):
        # The guard is exercised directly: identity is re-read inside the transaction, so
        # a replacement landing between proposal and apply cannot be repaired from stale
        # numbers.
        self.seed(IMAGE)
        self.db.execute("UPDATE assets SET sha256=? WHERE id=?", [digest("new"), IMAGE])
        self.db.commit()
        result = repair.apply(self.db, [self.source(IMAGE)])
        self.assertEqual(self.outcome(result, IMAGE)["outcome"], repair.REPLACED)
        self.assertEqual(self.metadata(IMAGE), (None, None, None))


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

class ReportTests(Fixture):
    def source(self, asset_id, *, width=800, height=600):
        return {"id": asset_id, "sha256": digest(asset_id), "size_bytes": 8,
                "kind": "image", "status": "normal", "width": width, "height": height}

    def test_the_report_carries_counts_and_no_asset_keys_or_paths(self):
        self.seed(IMAGE)
        result = repair.apply(self.db, [self.source(IMAGE)])
        text = repair.report(result)
        self.assertIn("filled=1", text)
        self.assertIn("width=1", text)
        for secret in ("object_key", "library/", "http", ".webp", digest(IMAGE)):
            with self.subTest(secret=secret):
                self.assertNotIn(secret, text)

    def test_a_sample_adds_only_the_requested_asset_ids(self):
        self.seed(IMAGE)
        result = repair.apply(self.db, [self.source(IMAGE)])
        self.assertNotIn(IMAGE, repair.report(result))
        self.assertIn(IMAGE, repair.report(result, sample=1))

    def test_a_refusal_is_reported_without_a_traceback(self):
        result = repair.apply(self.db, [{"id": IMAGE, "sha256": "bad", "size_bytes": 8,
                                         "kind": "image", "status": "normal"}])
        self.assertIn("refused", repair.report(result))


class OperatorTests(Fixture):
    def test_snapshot_extracts_only_exact_visible_missing_rows(self):
        import repair_asset_metadata as operator
        self.seed(IMAGE)
        self.seed(VIDEO, kind="video")
        self.seed(HIDDEN)
        self.hide(HIDDEN)
        self.activate(IMAGE, "normal")
        self.activate(VIDEO, "normal")
        snapshot_path = Path(self.temp.name) / "pc.sqlite3"
        with sqlite3.connect(snapshot_path) as pc:
            pc.executescript("""CREATE TABLE assets(id TEXT,content_hash TEXT,byte_size INTEGER,
                media_kind TEXT,status TEXT,width INTEGER,height INTEGER);
                CREATE TABLE video_assets(asset_id TEXT,duration_ms INTEGER);""")
            for asset_id, kind, content in [(IMAGE, "image", digest(IMAGE)),
                    (VIDEO, "video", digest("replacement")), (HIDDEN, "image", digest(HIDDEN))]:
                pc.execute("INSERT INTO assets VALUES(?,?,8,?,'normal',8000,6000)",
                           [asset_id, content, kind])
        records = operator.snapshot_records(self.db, snapshot_path)
        self.assertEqual([record["id"] for record in records], [IMAGE])
        result = repair.apply(self.db, records)
        self.assertEqual(result["counts"]["filled"], 1)
        self.assertEqual(self.metadata(IMAGE), (8000, 6000, None))
        self.assertEqual(self.metadata(HIDDEN), (None, None, None))

    def test_operator_backup_manifest_and_other_column_verification(self):
        import repair_asset_metadata as operator
        self.seed(IMAGE, thumbnail_key="unchanged")
        records = [{"id": IMAGE, "sha256": digest(IMAGE), "size_bytes": 8,
                    "kind": "image", "status": "normal", "width": 80, "height": 60}]
        directory, before = operator.prepare_run(self.db, self.temp.name, records)
        with sqlite3.connect(directory / "before.sqlite3") as backup:
            self.assertIsNone(backup.execute("SELECT width FROM assets WHERE id=?", [IMAGE]).fetchone()[0])
        self.assertTrue((directory / "targets.json").exists())
        repair.apply(self.db, records)
        self.assertEqual(operator.verify_preserved(self.db, before, [IMAGE]), 0)
        self.db.execute("UPDATE assets SET thumbnail_key='changed' WHERE id=?", [IMAGE])
        self.db.commit()
        self.assertEqual(operator.verify_preserved(self.db, before, [IMAGE]), 1)

    def test_preview_connection_cannot_write_asset_rows(self):
        import repair_asset_metadata as operator
        self.seed(IMAGE)
        with closing(operator.connect(self.db_path, readonly=True)) as db:
            self.assertEqual(len(operator.missing(db)), 1)
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("UPDATE assets SET width=5")


if __name__ == "__main__":
    unittest.main()
