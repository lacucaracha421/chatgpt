"""Synthetic SQLite fixtures only; never opens a configured library."""
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import character_holdout as holdout
from holdout_dataset import build_dataset, open_readonly, save_exclusive, load_frozen
from holdout_rules import automatic_targets, recommendation, current_policy


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def evidence(distances=None, boxes=None, fallback=False):
    distances = distances or [[0.10] * 6]
    boxes = boxes if boxes is not None else [[0, 0, 100, 100]]
    return {"passed": any(sum(d <= 0.21323118981474148 for d in row) >= 2 for row in distances),
            "wholeFallback": fallback, "queryBoxes": boxes,
            "referenceHashes": [digest(f"reference-{i}") for i in range(len(distances[0]))],
            "evidence": [{"referenceDistances": row,
                          "matchedReferences": [i for i, d in enumerate(row) if d <= 0.21323118981474148]}
                         for row in distances]}


def database():
    c = sqlite3.connect(":memory:")
    c.executescript("""
    CREATE TABLE assets(id TEXT PRIMARY KEY,content_hash TEXT,status TEXT,media_kind TEXT,
                        perceptual_hash BLOB,perceptual_hash_quality INTEGER);
    CREATE TABLE character_targets(id TEXT PRIMARY KEY,series_classification_id TEXT,display_name TEXT);
    CREATE TABLE character_decisions(sequence INTEGER PRIMARY KEY,target_id TEXT,source_asset_id TEXT,
                                    asset_hash TEXT,decision TEXT,origin TEXT,created_at TEXT);
    CREATE TABLE character_autotag_jobs(asset_id TEXT PRIMARY KEY,source_generation INTEGER,state TEXT);
    CREATE TABLE character_autotag_evidence(id TEXT PRIMARY KEY,asset_id TEXT,generation INTEGER,
                        source_generation INTEGER,content_hash TEXT,runtime_fingerprint TEXT,created_at TEXT);
    CREATE TABLE character_autotag_predictions(evidence_id TEXT,target_id TEXT,series_id TEXT,
                                               target_fingerprint TEXT,result_json TEXT);
    INSERT INTO character_targets VALUES('hero','series','Hero'),('rival','series','Rival');
    PRAGMA user_version=72;
    """)
    return c


def add(c, asset, day=13, decision="accepted", origin="manual", content_hash=None, pdq=None,
        prediction=None, target="hero"):
    hash_ = content_hash or digest(asset)
    c.execute("INSERT OR IGNORE INTO assets VALUES(?,?, 'normal','image',?,100)", (asset, hash_, pdq))
    c.execute("INSERT OR IGNORE INTO character_autotag_jobs VALUES(?,1,'completed')", (asset,))
    ident = f"e-{asset}"
    c.execute("INSERT OR IGNORE INTO character_autotag_evidence VALUES(?,?,1,1,?,?,?)",
              (ident, asset, hash_, "a" * 64, f"2026-09-{day:02d}T00:00:00Z"))
    ev = prediction or evidence()
    raw = {"assetId": asset, "contentHash": hash_, "state": "recommended", "evidence": ev}
    c.execute("INSERT INTO character_autotag_predictions VALUES(?,?,?,?,?)",
              (ident, target, "series", "b" * 64, json.dumps(raw)))
    c.execute("INSERT INTO character_decisions(target_id,source_asset_id,asset_hash,decision,origin,created_at) VALUES(?,?,?,?,?,?)",
              (target, asset, hash_, decision, origin, f"2026-09-{day:02d}T00:00:01Z"))


class RulesTests(unittest.TestCase):
    def test_same_crop_and_sixth_distance_boundaries(self):
        policy = current_policy()
        self.assertEqual(policy["automatic_support"], 6)
        self.assertEqual(policy["automatic_max_distance"], 0.16)
        self.assertEqual(automatic_targets({"hero": evidence()}, {}, digest("query"), policy), {"hero"})
        for ev in [evidence([[0.1]*5]), evidence([[0.1]*5+[0.160001]]),
                   evidence([[0.1]*3+[0.4]*3, [0.4]*3+[0.1]*3], [[0,0,40,100],[60,0,100,100]]),
                   evidence(boxes=[], fallback=True)]:
            self.assertEqual(automatic_targets({"hero": ev}, {}, digest("query"), policy), set())
        self.assertTrue(automatic_targets({"hero": evidence([[0.16]*6])}, {}, digest("query"), policy))

    def test_competitor_veto_and_distinct_people(self):
        p = current_policy()
        bundle = {"hero": evidence(), "rival": evidence([[0.20]*2+[0.4]*4])}
        self.assertEqual(automatic_targets(bundle, {}, digest("q"), p), {"hero"})
        legacy = {**p, "logic_version": 1}
        legacy.pop("automatic_competitor_margin", None)
        self.assertEqual(automatic_targets(bundle, {}, digest("q"), legacy), set())
        boxes = [[0,0,40,100],[60,0,100,100]]
        bundle = {"hero": evidence([[0.1]*6,[0.4]*6], boxes),
                  "rival": evidence([[0.4]*6,[0.1]*6], boxes)}
        self.assertEqual(automatic_targets(bundle, {}, digest("q"), p), {"hero", "rival"})

    def test_competitor_margin_boundary_and_strong_rival_veto(self):
        p = current_policy()
        boundary = 0.1 + p["automatic_competitor_margin"]
        for distance, expected in [(boundary - 0.000001, set()), (boundary, {"hero"}),
                                   (boundary + 0.000001, {"hero"})]:
            bundle = {"hero": evidence(), "rival": evidence([[distance]*2+[0.4]*4])}
            self.assertEqual(automatic_targets(bundle, {}, digest("q"), p), expected)
        # Even a wide gap cannot resolve two independently auto-strong candidates.
        bundle = {"hero": evidence([[0.01]*6]), "rival": evidence([[0.16]*6])}
        self.assertEqual(automatic_targets(bundle, {}, digest("q"), p), set())

    def test_every_overlapping_crop_is_checked_without_mixing_people(self):
        p = current_policy()
        boxes = [[0,0,100,100], [10,10,90,90], [200,0,300,100]]
        for second, expected in [([0.14]*2+[0.4]*4, set()),
                                 ([0.16]*6, set()), ([0.2]*2+[0.4]*4, {"hero", "rival"})]:
            bundle = {"hero": evidence([[0.1]*6, [0.4]*6, [0.4]*6], boxes),
                      "rival": evidence([[0.2]*2+[0.4]*4, second, [0.01]*6], boxes)}
            # The rival's distant third person is independently classifiable.
            self.assertEqual(automatic_targets(bundle, {}, digest("q"), p), expected | {"rival"})

    def test_monie_hiyuki_saved_distances_and_weak_lara_gate(self):
        p = current_policy()
        monie = [0.0930563360452652, 0.06063959002494812, 0.0923059955239296,
                 0.1261855512857437, 0.062034815549850464, 0.19817233085632324,
                 0.10088373720645905, 0.1669408231973648, 0.11253073066473009,
                 0.06524112075567245, 0.07422041893005371, 0.2249622642993927,
                 0.06969894468784332, 0.05852421745657921]
        hiyuki = [0.25773942470550537, 0.30683422088623047, 0.19877029955387115,
                  0.2447524070739746, 1.0, 0.24989449977874756, 0.18796686828136444]
        bundle = {"monie": evidence([monie]), "hiyuki": evidence([hiyuki])}
        self.assertEqual(automatic_targets(bundle, {}, digest("q"), p), {"monie"})
        self.assertEqual(automatic_targets(bundle, {}, digest("q"), {**p, "logic_version": 1}), set())
        # A weak winner is never rescued by the absence of competitors.
        self.assertEqual(automatic_targets({"lara": evidence([[0.1]*5+[0.2531078]])}, {}, digest("q"), p), set())

    def test_invalid_competitor_and_policy_cannot_release_a_winner(self):
        p = current_policy()
        for invalid in [None, {}, evidence([[0.4]*6])]:
            if invalid and "evidence" in invalid:
                invalid["evidence"][0]["referenceDistances"] = [None]*6
            with self.assertRaises(ValueError):
                automatic_targets({"hero": evidence(), "rival": invalid}, {}, digest("q"), p)
        for margin in [-0.01, None, float("nan"), True]:
            with self.assertRaises(ValueError):
                automatic_targets({"hero": evidence()}, {}, digest("q"),
                                  {**p, "automatic_competitor_margin": margin})
        self.assertEqual(automatic_targets({"hero": evidence(boxes=[], fallback=True),
                                           "rival": evidence(boxes=[], fallback=True)}, {}, digest("q"), p), set())

    def test_manual_decisions_and_self_reference_are_authoritative(self):
        p = current_policy()
        self.assertFalse(automatic_targets({"hero": evidence()}, {"hero": "rejected"}, digest("q"), p))
        self.assertFalse(automatic_targets({"hero": evidence()}, {"rival": "accepted"}, digest("q"), p))
        self.assertFalse(automatic_targets({"hero": evidence()}, {}, digest("reference-0"), p))
        self.assertEqual(automatic_targets({"hero": evidence(), "rival": evidence()}, {"rival": "rejected"}, digest("q"), p), {"hero"})

    def test_incompatible_model_evidence_is_rejected(self):
        ev = evidence()
        ev["baselineFingerprint"] = "f" * 64
        with self.assertRaises(ValueError):
            automatic_targets({"hero": ev}, {}, digest("q"), current_policy())

    def test_malformed_distances_are_rejected(self):
        for value in [float("nan"), float("inf"), "0.1", True]:
            ev = evidence(); ev["evidence"][0]["referenceDistances"][0] = value
            with self.assertRaises(ValueError):
                automatic_targets({"hero": ev}, {}, digest("q"), current_policy())


class DatasetTests(unittest.TestCase):
    def setUp(self):
        self.c = database()
        self.addCleanup(self.c.close)

    def freeze(self, **kw):
        return build_dataset(self.c, "2026-09-12T00:00:00Z", **kw)

    def test_temporal_split_is_reproducible_and_reports_explicit_pairs(self):
        add(self.c, "old", 10); add(self.c, "new", 13); add(self.c, "negative", 13, "rejected")
        first = self.freeze()
        self.assertEqual(first, self.freeze())
        rows = first["dataset"]["rows"]
        self.assertEqual({r["asset"] for r in rows if r["partition"] == "calibration"}, {"old"})
        report = holdout.evaluate(first, "holdout")
        self.assertEqual(report["automatic"]["tp"], 1)
        self.assertEqual(report["automatic"]["fp"], 1)
        self.assertEqual(report["automatic"]["precision"], 0.5)
        self.assertEqual(report["labeled_pairs"], 2)
        self.assertEqual(report["per_target"]["hero"]["automatic"]["fp"], 1)

    def test_cleared_and_automatic_labels_are_not_ground_truth(self):
        add(self.c, "cleared"); add(self.c, "auto", origin="automatic")
        self.c.execute("INSERT INTO character_decisions(target_id,source_asset_id,asset_hash,decision,origin,created_at) VALUES('hero','cleared',?,'cleared','manual','2026-09-14T00:00:00Z')", (digest("cleared"),))
        self.assertEqual(self.freeze()["dataset"]["rows"], [])

    def test_predictions_after_feedback_and_changed_content_are_excluded(self):
        add(self.c, "late"); add(self.c, "changed")
        self.c.execute("UPDATE character_autotag_evidence SET created_at='2026-09-14T00:00:00Z' WHERE asset_id='late'")
        self.c.execute("UPDATE assets SET content_hash=? WHERE id='changed'", (digest("different"),))
        self.assertEqual(self.freeze()["dataset"]["rows"], [])

    def test_near_duplicates_group_transitively_and_never_cross_cutoff(self):
        add(self.c, "a", 10, pdq=bytes(32)); add(self.c, "b", 13, pdq=(1).to_bytes(32, "big"))
        add(self.c, "c", 13, pdq=(3).to_bytes(32, "big"))
        frozen = self.freeze(near_distance=1)
        self.assertEqual(frozen["dataset"]["rows"], [])
        self.assertEqual(frozen["dataset"]["excluded"]["crosses_cutoff"], 3)

    def test_exact_and_near_reference_duplicates_are_excluded(self):
        add(self.c, "self", content_hash=digest("reference-0"))
        add(self.c, "near", pdq=(1).to_bytes(32, "big"))
        self.c.execute("INSERT INTO assets VALUES('ref',?,'normal','image',?,100)", (digest("reference-1"), bytes(32)))
        frozen = self.freeze(near_distance=1)
        self.assertEqual(frozen["dataset"]["rows"], [])
        self.assertEqual(frozen["dataset"]["excluded"]["reference_overlap"], 2)

    def test_superseded_evidence_and_conflicting_duplicate_labels_are_excluded(self):
        add(self.c, "stale"); self.c.execute("UPDATE character_autotag_jobs SET state='superseded'")
        add(self.c, "x", content_hash=digest("same")); add(self.c, "y", decision="rejected", content_hash=digest("same"))
        self.assertEqual(self.freeze()["dataset"]["rows"], [])

    def test_frozen_evidence_survives_database_changes_and_rejects_tampering(self):
        add(self.c, "one")
        frozen = self.freeze()
        report = holdout.evaluate(frozen, "holdout")
        self.c.execute("DELETE FROM character_decisions")
        self.assertEqual(report, holdout.evaluate(frozen, "holdout"))
        tampered = copy.deepcopy(frozen); tampered["dataset"]["rows"][0]["label"] = 0
        with self.assertRaises(ValueError): holdout.evaluate(tampered, "holdout")

    def test_reanalysis_after_manual_feedback_cannot_replace_frozen_evidence(self):
        add(self.c, "one")
        self.c.execute("INSERT INTO character_autotag_evidence VALUES('new','one',2,1,?,?,'2026-09-14T00:00:00Z')", (digest("one"), "a" * 64))
        payload = {"assetId": "one", "contentHash": digest("one"), "state": "unmatched", "evidence": evidence([[0.4]*6])}
        self.c.execute("INSERT INTO character_autotag_predictions VALUES('new','hero','series',?,?)", ("b"*64, json.dumps(payload)))
        frozen = self.freeze()
        self.assertEqual(frozen["dataset"]["rows"][0]["evidence_id"], "e-one")
        self.assertEqual(holdout.evaluate(frozen)["automatic"]["tp"], 1)

    def test_unlabeled_competitors_still_block_automatic_assignment(self):
        add(self.c, "one")
        payload = {"assetId": "one", "contentHash": digest("one"), "state": "recommended",
                   "evidence": evidence([[0.14]*2+[0.4]*4])}
        self.c.execute("INSERT INTO character_autotag_predictions VALUES('e-one','rival','series',?,?)", ("b"*64, json.dumps(payload)))
        report = holdout.evaluate(self.freeze())
        self.assertEqual(report["labeled_pairs"], 1)
        self.assertEqual(report["automatic"]["fn"], 1)
        self.assertEqual(report["recommendation"]["tp"], 1)

    def test_missing_pdq_is_explicit_and_timezone_is_required(self):
        add(self.c, "one")
        self.assertFalse(self.freeze()["dataset"]["grouping"]["near_duplicate_check_complete"])
        with self.assertRaises(ValueError): build_dataset(self.c, "2026-09-12")

    def test_equivalent_baseline_formatting_is_portable_across_checkouts(self):
        add(self.c, "one")
        frozen = self.freeze()
        candidate = copy.deepcopy(current_policy())
        candidate["baseline_sha256"] = "f" * 64
        self.assertEqual(holdout.evaluate(frozen, "holdout", candidate)["automatic"]["tp"], 1)
        candidate["baseline_fingerprint"] = "f" * 64
        with self.assertRaises(ValueError): holdout.evaluate(frozen, "holdout", candidate)

    def test_empty_metrics_are_unknown_instead_of_perfect(self):
        report = holdout.evaluate(self.freeze(), "holdout")
        self.assertIsNone(report["automatic"]["precision"])
        self.assertIsNone(report["automatic"]["recall"])

    def test_readonly_uri_and_exclusive_output_guards(self):
        with tempfile.TemporaryDirectory() as root:
            base = Path(root); library = base / "library"; library.mkdir()
            db = library / "space # question.sqlite"
            out = sqlite3.connect(db); self.c.backup(out); out.close()
            before = db.read_bytes()
            with open_readonly(db) as ro:
                with self.assertRaises(sqlite3.OperationalError): ro.execute("DELETE FROM assets")
            frozen = self.freeze(); report = base / "frozen.json"
            save_exclusive(frozen, report, db)
            self.assertEqual(load_frozen(report), frozen)
            with self.assertRaises(FileExistsError): save_exclusive(frozen, report, db)
            with self.assertRaises(ValueError): save_exclusive(frozen, library / "report.json", db)
            self.assertEqual(db.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
