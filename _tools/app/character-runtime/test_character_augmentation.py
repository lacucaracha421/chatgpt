"""Deterministic tests for the optional native-ready augmentation runtime.

Fakes replace only the ONNX sessions and the on-disk feature stores. The
calibration bundle, reference projection and publication replay all run through
the real ``reference_regions`` / ``holdout_rules`` code, so these tests exercise
the data flow the native owner actually drives.
"""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

import character_augmentation as augmentation
from runtime import BASELINE, Features, FINGERPRINT

PDQ_HEX = 128
VECTORS = 768
BOXES = ((0, 0, 100, 100),)
REFERENCES = ("r0", "r1", "r2", "r3", "r4")
POLICY = {"logic_version": 2, "recommendation_threshold": BASELINE["threshold"],
          "automatic_support": 6, "automatic_max_distance": 0.16,
          "automatic_competitor_margin": 0.05, "baseline_fingerprint": FINGERPRINT}


def hash_of(name):
    return hashlib.sha256(name.encode()).hexdigest()


def pdq(seed, byte=0):
    """A 64-byte (128 hex) PDQ value, deterministic per seed.

    ``byte`` optionally nudges the first byte, which moves the value by a few
    Hamming bits inside one 32-byte half.
    """
    raw = bytearray(hashlib.sha256(("pdq:" + seed).encode()).digest() * 2)
    raw[0] ^= byte
    return raw.hex()


class FakeMetric:
    """B36 metric stand-in: cosine distance in the frozen square-matrix shape."""

    def run(self, names, feeds):
        stack = np.asarray(feeds["input"], dtype=np.float64)
        unit = stack / np.maximum(np.linalg.norm(stack, axis=1, keepdims=True), 1e-12)
        return 1.0 - unit @ unit.T


class FakeEngine:
    """Metric session stand-in whose ``compare`` mirrors ``Runtime.compare``."""

    def __init__(self):
        self.metric = FakeMetric()
        self.max_metric_vectors = 0

    def compare(self, query, references):
        from runtime import consensus
        sizes = [len(reference.vectors) for reference in references]
        stack = np.concatenate([query.vectors] + [reference.vectors for reference in references])
        self.max_metric_vectors = max(self.max_metric_vectors, len(stack))
        raw = self.metric.run(["output"], {"input": stack})
        result = consensus(raw[:len(query.vectors), len(query.vectors):], sizes)
        return {**result, "contentHash": query.content_hash, "queryBoxes": query.boxes,
                "wholeFallback": query.fallback,
                "referenceHashes": [reference.content_hash for reference in references],
                "referenceBoxes": [reference.boxes for reference in references],
                "referenceWholeFallback": [reference.fallback for reference in references],
                "baselineFingerprint": FINGERPRINT}


class FakeB36Cache:
    """Feature-cache stand-in; records every B36 extraction it serves."""

    def __init__(self, features):
        self.features, self.extracted = dict(features), []

    def extract(self, path, expected_hash):
        self.extracted.append(expected_hash)
        feature = self.features.get(expected_hash)
        if feature is None:
            raise ValueError("No B36 feature for " + expected_hash)
        return feature


class FakeEncoder:
    """SmallEncoder stand-in. Never creates a detector session."""

    def __init__(self, vectors=None):
        self.vectors, self.calls, self.detector = dict(vectors or {}), [], None

    def extract(self, path, expected_hash, boxes=None):
        self.calls.append((str(path), expected_hash, [tuple(box) for box in (boxes or [])]))
        count = len(boxes or [1])
        vectors = self.vectors.get(expected_hash)
        if vectors is None:
            vectors = np.ones((count, VECTORS), dtype=np.float32)
        return Features(expected_hash, [tuple(box) for box in (boxes or [])],
                        np.asarray(vectors, dtype=np.float32).reshape(count, VECTORS), not boxes)


class FakeS36Cache:
    """Atomic S36 cache stand-in; counts reads and writes."""

    def __init__(self):
        self.entries, self.reads, self.writes = {}, [], []

    def read(self, content_hash, boxes):
        self.reads.append(content_hash)
        return self.entries.get(content_hash)

    def write(self, feature):
        self.writes.append(feature.content_hash)
        self.entries[feature.content_hash] = feature


class Rig:
    """A tiny synthetic library: one target, five references, named sources.

    Every source is one person (``persons[name]``), so B36 distance is zero
    within a person and one across people. ``s36_person`` optionally overrides
    the S36 identity, which lets a test keep a source B36-compatible with the
    references while the learned head still separates it.
    """

    def __init__(self, persons, labels, quality=None, pdqs=None, s36_person=None):
        self.persons, self.labels = persons, labels
        self.quality, self.pdqs = quality or {}, pdqs or {}
        self.s36_person = dict(s36_person or {})
        self.names = sorted(persons)
        self.rebuild()

    def rebuild(self):
        self.b36 = {hash_of(name): self._feature(name) for name in self.names}
        self.s36 = {hash_of(name): self._vector(name) for name in self.names}
        return self

    def _vector(self, name):
        """S36 identity: the S36 override when present, else the person."""
        index = self.s36_person.get(name, self.persons[name])
        return self._one_hot(index)

    def _feature(self, name):
        """B36 identity: always the person, so reference matching is unaffected."""
        return Features(hash_of(name), list(BOXES), self._one_hot(self.persons[name]), False)

    @staticmethod
    def _one_hot(index):
        vector = np.zeros((1, VECTORS), dtype=np.float32)
        vector[0, index] = 1.0
        return vector

    def asset(self, name):
        labels = self.labels.get(name, {})
        return {"id": name, "hash": hash_of(name), "path": f"/tmp/{name}.png",
                "pdq": self.pdqs.get(name, pdq(name)), "quality": self.quality.get(name, 90),
                "labels": labels, "labelSequences": {tid: 1 for tid in labels}}

    def snapshot(self, references=REFERENCES):
        return {"version": 1, "runtime": "test",
                "targets": [{"id": "t", "references": [
                    {"assetId": name, "hash": hash_of(name), "role": "seed", "region": None}
                    for name in references]}],
                "assets": [self.asset(name) for name in self.names], "policy": POLICY}

    def session(self, snapshot=None, engine=None, encoder=None):
        encoder = encoder or FakeEncoder(self.s36)
        return augmentation.Session(
            {"snapshotId": "s1", "snapshot": self.snapshot() if snapshot is None else snapshot},
            engine or FakeEngine(), FakeB36Cache(self.b36), FakeS36Cache(), lambda: encoder)

    def partition(self, session, rule):
        """Give every source its own group, assign partitions, then load both features."""
        for name in self.names:
            session.assets[name]["group"] = name
            session.split[name] = rule(name)
        session.refresh_exposure()
        for name in self.names:
            session.load(session.assets[name])
        return session

    def model(self, snapshot=None):
        encoder = FakeEncoder(self.s36)
        model = augmentation.Model("/nowhere", "unused", tempfile.mkdtemp(), FakeEngine(),
                                   FakeB36Cache(self.b36))
        model.encoder_factory = lambda: encoder
        model.handle({"type": "augmentation_prepare", "snapshotId": "s1",
                      "snapshot": self.snapshot() if snapshot is None else snapshot})
        return model, encoder


def drain(model):
    for _ in range(300):
        response = model.handle({"type": "augmentation_step", "snapshotId": "s1"})
        if response["state"] == "ready":
            return response
    raise AssertionError("Snapshot never became ready")


def mixed_rig(calibration, test=None, queries=(), s36_person=None):
    """Two train positives, two train negatives, four calibration groups, plus tests."""
    persons = {name: 0 for name in REFERENCES}
    labels = {}
    for index in range(4):
        name = f"train-{index}"
        persons[name] = 0 if index < 2 else 2
        labels[name] = {"t": index < 2}
    for index in range(4):
        name = f"cal-{index}"
        persons[name] = 0 if index < 2 else 2
        if calibration[index] is not None:
            labels[name] = {"t": calibration[index]}
    if test is not None:
        for index in range(4):
            name = f"test-{index}"
            persons[name] = 0 if index < 2 else 2
            if test[index] is not None:
                labels[name] = {"t": test[index]}
    for name in queries:
        persons[name] = 0 if name.endswith("pos") else 2
    return Rig(persons, labels, s36_person=s36_person)


def partition_rule(name):
    if name.startswith("train"):
        return "train"
    if name.startswith("cal"):
        return "calibration"
    if name.startswith("test"):
        return "test"
    if name.startswith("query"):
        return "test"
    return "train"  # references are train-only


# --- snapshot contract -------------------------------------------------------


class SnapshotTests(unittest.TestCase):
    def test_snapshot_without_boxes_fallback_or_native(self):
        # Rust cannot supply geometry, fallback flags or native evidence. A
        # snapshot carrying only library metadata must still prepare and step.
        rig = Rig({name: 0 for name in REFERENCES + ("x",)}, {"x": {"t": True}})
        body = rig.snapshot()
        self.assertNotIn("native", body)
        for asset in body["assets"]:
            for forbidden in ("boxes", "fallback", "native"):
                self.assertNotIn(forbidden, asset)
        model, encoder = rig.model()
        response = drain(model)
        self.assertEqual(response["state"], "ready")
        self.assertEqual(len(response["modelId"]), 64)
        # Geometry came from the B36 cache, never from the snapshot.
        self.assertTrue(all(box == (0, 0, 100, 100) for _, _, boxes in encoder.calls for box in boxes))

    def test_wrong_version_and_identity_are_rejected(self):
        rig = Rig({name: 0 for name in REFERENCES}, {})
        for mutate in (lambda b: b.update(version=2),
                       lambda b: b.update(runtime=7),
                       lambda b: b["assets"][0].update(hash="zz"),
                       lambda b: b["assets"][0].update(pdq="00"),
                       lambda b: b["assets"][0].update(quality=-1)):
            broken = json.loads(json.dumps(rig.snapshot()))
            mutate(broken)
            with self.assertRaises(ValueError):
                rig.session(snapshot=broken)

    def test_non_finite_and_wrong_baseline_policy_are_rejected(self):
        rig = Rig({name: 0 for name in REFERENCES}, {})
        for mutate in (lambda p: p.update(logic_version=1),
                       lambda p: p.update(baseline_fingerprint="0" * 64),
                       lambda p: p.update(automatic_max_distance=float("nan")),
                       lambda p: p.update(automatic_support=1),
                       lambda p: p.update(automatic_competitor_margin=-1.0),
                       lambda p: p.update(recommendation_threshold=float("inf"))):
            broken = json.loads(json.dumps(rig.snapshot()))
            mutate(broken["policy"])
            with self.assertRaises(ValueError):
                rig.session(snapshot=broken)

    def test_reference_identity_must_match_its_asset(self):
        rig = Rig({name: 0 for name in REFERENCES}, {})
        broken = json.loads(json.dumps(rig.snapshot()))
        broken["targets"][0]["references"][0]["hash"] = hash_of("somewhere-else")
        with self.assertRaises(ValueError):
            rig.session(snapshot=broken)

    def test_snapshot_fingerprint_ignores_temporary_paths(self):
        rig = Rig({name: 0 for name in REFERENCES}, {})
        relocated = json.loads(json.dumps(rig.snapshot()))
        for asset in relocated["assets"]:
            asset["path"] = "/tmp/relocated/" + asset["id"] + ".png"
        first, second = rig.session(), rig.session(snapshot=relocated)
        self.assertEqual(first.snapshot_fingerprint(), second.snapshot_fingerprint())
        self.assertEqual(first.identity, second.identity)


# --- grouping and exposures --------------------------------------------------


class GroupingTests(unittest.TestCase):
    def _two(self, pdqs, labels):
        rig = Rig({"a": 0, "b": 0, **{name: 1 for name in REFERENCES}}, labels, pdqs=pdqs)
        session = rig.session()
        for asset in session.assets.values():
            session.load(asset)
        return rig, session

    def test_pdq_rotation_is_the_same_group(self):
        base = pdq("person-a")
        rig, session = self._two({"a": base, "b": base[64:] + base[:64]}, {"b": {"t": True}})
        self.assertEqual(session.assets["a"]["group"], session.assets["b"]["group"])

    def test_identical_pdq_values_are_unioned(self):
        shared = pdq("shared")
        rig, session = self._two({"a": shared, "b": shared}, {"b": {"t": True}})
        self.assertEqual(session.assets["a"]["group"], session.assets["b"]["group"])

    def test_distant_pdq_values_stay_separate(self):
        rig, session = self._two({"a": pdq("a"), "b": pdq("b")}, {"a": {"t": True}, "b": {"t": True}})
        self.assertNotEqual(session.assets["a"]["group"], session.assets["b"]["group"])

    def test_conflicting_group_labels_are_withheld(self):
        rig, session = self._two({"a": pdq("a"), "b": pdq("a")},
                                 {"a": {"t": True}, "b": {"t": False}})
        group = session.assets["a"]["group"]
        self.assertEqual(group, session.assets["b"]["group"])
        members = [asset for asset in session.assets.values() if asset["group"] == group]
        self.assertIsNone(session.group_labels("t", members))
        self.assertNotIn(group, [bag[2] for bag in session.bags("t")])

    def test_unknown_member_is_not_a_contradiction(self):
        rig, session = self._two({"a": pdq("a"), "b": pdq("a")}, {"a": {"t": True}})
        group = session.assets["a"]["group"]
        self.assertEqual(group, session.assets["b"]["group"])
        members = [asset for asset in session.assets.values() if asset["group"] == group]
        self.assertIn(True, [session.resolved_labels("t", member) for member in members])
        self.assertIn(None, [session.resolved_labels("t", member) for member in members])
        self.assertTrue(session.group_labels("t", members))

    def test_unlabelled_near_duplicate_is_exposed(self):
        rig = Rig({"a": 0, "dup": 0, **{name: 1 for name in REFERENCES}}, {"a": {"t": True}},
                  pdqs={"a": pdq("a", 1), "dup": pdq("a")})
        session = rig.session()
        self.assertEqual(session.assets["a"]["group"], session.assets["dup"]["group"])
        for asset in session.assets.values():
            session.load(asset)
        self.assertIn(hash_of("dup"), session.exposure_hashes)
        self.assertIn(hash_of("dup"), session.exposure_pdq)

    def test_seed_is_positive_but_a_support_reference_is_not(self):
        rig = Rig({name: (0 if name == REFERENCES[0] else 1) for name in REFERENCES}, {})
        session = rig.session()
        self.assertTrue(session.resolved_labels("t", session.assets[REFERENCES[0]]))
        support = json.loads(json.dumps(rig.snapshot()))
        support["targets"][0]["references"][0]["role"] = "support"
        session = rig.session(snapshot=support)
        self.assertIsNone(session.resolved_labels("t", session.assets[REFERENCES[0]]))

    def test_negative_seed_keeps_every_person_as_a_negative_bag(self):
        rig = Rig({name: 0 for name in REFERENCES}, {REFERENCES[0]: {"t": False}})
        session = rig.session()
        for asset in session.assets.values():
            session.load(asset)
        asset = session.assets[REFERENCES[0]]
        asset["feature"] = Features(asset["hash"], [BOXES[0], (120, 0, 220, 100)],
                                    np.stack([np.ones(VECTORS), -np.ones(VECTORS)]).astype(np.float32), False)
        session.seeds[REFERENCES[0]]["t"] = {"contentHash": asset["hash"],
                                            "baselineFingerprint": FINGERPRINT, "bounds": list(BOXES[0])}
        bag, label, _ = next(row for row in session.bags("t") if row[2] == asset["group"])
        self.assertFalse(label)
        self.assertEqual(len(bag), 2)

    def test_seed_manual_region_projects_only_when_it_matches(self):
        rig = Rig({name: (0 if name == REFERENCES[0] else 1) for name in REFERENCES}, {})
        session = rig.session()
        asset = session.assets[REFERENCES[0]]
        session.load(asset)
        # A stale manual region supplies no bag rather than a wrong person.
        session.seeds[REFERENCES[0]] = {"t": {"contentHash": asset["hash"],
                                              "baselineFingerprint": FINGERPRINT,
                                              "bounds": [1, 1, 9, 9]}}
        self.assertIsNone(session._project("t", asset))
        session.seeds[REFERENCES[0]] = {"t": {"contentHash": asset["hash"],
                                              "baselineFingerprint": FINGERPRINT,
                                              "bounds": list(BOXES[0])}}
        self.assertEqual(session._project("t", asset).shape, (1, VECTORS))


# --- train / calibration / test isolation ------------------------------------


class IsolationTests(unittest.TestCase):
    def test_test_partition_never_reaches_training_or_calibration(self):
        rig = mixed_rig([True, True, False, False], test=[True, True, False, False])
        session = rig.partition(rig.session(), partition_rule)
        trains, calibrations = session.split_bags("t")
        train_groups = {group for _, _, group in session.bags("t")
                        if session.split[group] == "train"}
        calibration_groups = {group for _, _, group in session.bags("t")
                              if session.split[group] == "calibration"}
        # No test group may appear on either side of the fit.
        self.assertEqual(len(trains), len(train_groups))
        self.assertEqual(len(calibrations), len(calibration_groups))
        self.assertTrue(all(not group.startswith("test") for group in train_groups | calibration_groups))
        session.fit()
        self.assertEqual(session.gates["t"]["positive"], 2)
        self.assertEqual(session.gates["t"]["negative"], 2)

    def test_test_labels_cannot_create_a_gate(self):
        # Only test groups are labelled; the calibration partition is empty.
        rig = mixed_rig([None, None, None, None], test=[True, True, False, False])
        session = rig.partition(rig.session(), partition_rule)
        session.fit()
        self.assertFalse(session.gates["t"]["enabled"])
        self.assertEqual(session.gates["t"]["positive"], 0)
        self.assertEqual(session.gates["t"]["negative"], 0)


# --- gates and competitors ---------------------------------------------------


class GateTests(unittest.TestCase):
    def _fitted(self, calibration):
        rig = mixed_rig(calibration)
        session = rig.partition(rig.session(), partition_rule)
        session.fit()
        return rig, session

    def test_enabled_gate_reports_recall_calibration(self):
        rig, session = self._fitted([True, True, False, False])
        gate = session.gates["t"]
        self.assertEqual((gate["positive"], gate["negative"]), (2, 2))
        self.assertEqual(gate["recovered"], 2)
        self.assertEqual(gate["false_positive"], 0)
        self.assertGreaterEqual(gate["threshold"], 0.5)
        self.assertTrue(gate["enabled"])
        self.assertEqual(session.model["heads"]["t"]["state"], "ready_shadow")

    def test_unknown_calibration_never_counts_as_negative(self):
        rig, session = self._fitted([True, True, None, None])
        self.assertLess(session.gates["t"]["negative"], 2)
        self.assertFalse(session.gates["t"]["enabled"])

    def _calibrate_scores(self, scores, labels):
        # Isolate threshold selection; fitting and bag scoring have other tests.
        head = {"weights": [1.0], "bias": 0.0, "state": "ready_shadow",
                "threshold": 0.01, "calibration": {"old": True}}
        with patch.object(augmentation, "probabilities", side_effect=[np.array(s) for s in scores]):
            return augmentation.calibrate_recall(head, [None] * len(scores), labels)

    def test_compensated_error_is_allowed(self):
        head = self._calibrate_scores([.9, .8, .7, .6, .95, .1], [True] * 4 + [False] * 2)
        self.assertEqual(head["state"], "ready_shadow")
        self.assertEqual(head["threshold"], .6)
        self.assertEqual(head["calibration"], {"positive": 4, "negative": 2,
                         "recovered": 4, "false_positive": 1, "utility": 2, "error_budget": 1})

    def test_ties_prefer_fewer_errors_then_higher_threshold(self):
        head = self._calibrate_scores([.9, .7, .6, .8, .1], [True] * 3 + [False] * 2)
        self.assertEqual(head["threshold"], .9)
        self.assertEqual(head["calibration"]["false_positive"], 0)

    def test_zero_utility_low_scores_and_excess_errors_hold(self):
        for scores, labels in [([.9, .8, .95, .1], [True, True, False, False]),
                               ([.4, .3, .2], [True, False, False]),
                               ([.6] * 6 + [.9, .8], [True] * 6 + [False] * 2)]:
            with self.subTest(scores=scores):
                head = self._calibrate_scores(scores, labels)
                self.assertEqual(head["state"], "no_positive_calibration_utility")
                self.assertNotIn("threshold", head)

    def test_minimum_counts_and_ten_percent_error_budget(self):
        head = self._calibrate_scores([.5, .2, .1], [True, False, False])
        self.assertEqual(head["threshold"], .5)
        for labels in ([True, False], [False, False]):
            self.assertEqual(self._calibrate_scores([.8] * len(labels), labels)["state"],
                             "insufficient_calibration")
        head = self._calibrate_scores([.6] * 5 + [.9] * 2 + [.1] * 18,
                                     [True] * 5 + [False] * 20)
        self.assertEqual(head["calibration"]["false_positive"], 2)
        self.assertEqual(head["state"], "ready_shadow")

    def test_bag_max_scores_and_invalid_labels(self):
        head = self._calibrate_scores([[.1, .8], [.2], [.3]], [True, False, False])
        self.assertEqual(head["threshold"], .8)
        with self.assertRaises(ValueError):
            self._calibrate_scores([.8, .2, .1], [True, 0, False])
        with self.assertRaises(ValueError):
            self._calibrate_scores([float("nan"), .2, .1], [True, False, False])

    def test_disabled_ready_rival_still_blocks_a_competitor(self):
        rig = mixed_rig([True, True, False, False])
        session = rig.partition(rig.session(), partition_rule)
        session.targets["u"] = {"id": "u", "references": session.targets["t"]["references"]}
        ready = {"state": "ready_shadow", "threshold": 0.0,
                 "weights": [1.0 / VECTORS] * VECTORS, "bias": 0.5}
        evidence = session.bundle(session.assets["cal-0"], session.reference_views())
        # Two ready heads on the shared crop compete; the addition is withheld.
        rival = augmentation.decide({"t": dict(ready), "u": dict(ready)},
                                    rig.s36[hash_of("cal-0")], ["t", "u"], False)
        self.assertEqual(rival["regions"][0]["state"], "competing_characters")
        self.assertEqual(augmentation.potential_additions([], evidence, rival, POLICY), {})
        # One ready head on the same data is not blocked.
        only = augmentation.decide({"t": dict(ready)}, rig.s36[hash_of("cal-0")], ["t"], False)
        self.assertEqual(augmentation.potential_additions([], evidence, only, POLICY), {"t": [0]})


# --- query guard -------------------------------------------------------------


class QueryTests(unittest.TestCase):
    def _ready(self):
        rig = mixed_rig([True, True, False, False], queries=("query-pos", "query-neg"))
        session = rig.partition(rig.session(), partition_rule)
        session.fit()
        session.resident = {name: (hash_of(name), list(BOXES), False)
                            for name in ("query-pos", "query-neg")}
        return rig, session

    def _bundle(self, session, rig, name):
        return session.bundle(session.assets[name], session.reference_views())

    def _request(self, name, identity=None, bundle=None):
        return {"assetId": name, "hash": hash_of(name), "path": f"/tmp/{name}.png",
                "queryIdentity": ({"pdq": pdq(name), "quality": 90}
                                  if identity is None else identity),
                "bundle": bundle}

    def test_query_uses_resident_geometry_and_identity_only_pdq_quality(self):
        rig, session = self._ready()
        result = session.query(self._request("query-pos", bundle=self._bundle(session, rig, "query-pos")))
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["boxes"], list(BOXES))

    def test_zero_b36_votes_still_reaches_s36_and_proposes_target(self):
        rig = mixed_rig([True, True, False, False], queries=("query-neg",),
                        s36_person={"query-neg": 0})
        session = rig.partition(rig.session(), partition_rule)
        session.fit()
        session.resident = {"query-neg": (hash_of("query-neg"), list(BOXES), False)}
        bundle = self._bundle(session, rig, "query-neg")
        self.assertFalse(bundle["t"]["passed"])
        self.assertEqual(bundle["t"]["evidence"][0]["matchedReferences"], [])
        session.s36_cache.reads.clear()
        result = session.query(self._request("query-neg", bundle=bundle))
        self.assertEqual(result["state"], "ready")
        self.assertEqual(session.s36_cache.reads, [hash_of("query-neg")])
        decision = augmentation.decide(session.model["heads"], result["feature"].vectors, ["t"])
        self.assertEqual(augmentation.potential_additions([], bundle, decision, POLICY), {"t": [0]})

    def test_no_enabled_addition_skips_the_encoder(self):
        rig, session = self._ready()
        bundle = self._bundle(session, rig, "query-pos")
        session.s36_cache.reads.clear()
        request = self._request("query-pos", bundle=bundle)
        request["nativeAccepted"] = ["t"]
        self.assertEqual(session.query(request)["reason"], "nothing_to_augment")
        request["nativeAccepted"] = []
        session.gates["t"]["enabled"] = False
        self.assertEqual(session.query(request)["reason"], "nothing_to_augment")
        self.assertEqual(session.s36_cache.reads, [])

    def test_invalid_or_low_quality_query_identity_holds(self):
        rig, session = self._ready()
        bundle = self._bundle(session, rig, "query-pos")
        for identity in ({"pdq": "00", "quality": 90}, {"pdq": pdq("q"), "quality": 49},
                         {"pdq": pdq("q").upper(), "quality": 90}, {}):
            result = session.query(self._request("query-pos", identity, bundle))
            self.assertEqual(result.get("reason"), "invalid_query_identity")

    def test_exact_and_near_exposure_both_hold(self):
        rig, session = self._ready()
        # Exact hash of an exposed training group member.
        session.exposure_pdq[hash_of("train-0")] = pdq("train-0")
        exact = session.query(self._request("query-pos", {"pdq": pdq("train-0"), "quality": 90},
                                            self._bundle(session, rig, "query-pos")))
        self.assertEqual(exact["reason"], "exposure")
        # An unknown PDQ that is a near-duplicate of an exposed group.
        near = pdq("train-0", 1)
        near_result = session.query(self._request("query-pos", {"pdq": near, "quality": 90},
                                                  self._bundle(session, rig, "query-pos")))
        self.assertEqual(near_result["reason"], "exposure")

    def test_bundle_must_cover_every_target_and_echo_resident_geometry(self):
        rig, session = self._ready()
        good = self._bundle(session, rig, "query-pos")
        self.assertEqual(session.query(self._request("query-pos", bundle={}))["reason"],
                         "invalid_bundle")
        for mutate in (lambda b: b["t"].update(queryBoxes=[[0, 0, 9, 9]]),
                       lambda b: b["t"].update(contentHash="0" * 64),
                       lambda b: b["t"].update(referenceHashes=[]),
                       lambda b: b["t"]["evidence"][0].update(matchedReferences=[0, 1, 2, 3, 4, 5, 6])):
            tampered = json.loads(json.dumps(good))
            mutate(tampered)
            self.assertEqual(session.query(self._request("query-pos", bundle=tampered))["reason"],
                             "invalid_bundle")

    def test_non_resident_query_holds(self):
        rig, session = self._ready()
        result = session.query(self._request("elsewhere"))
        self.assertEqual(result["reason"], "not_resident_query")

    def test_whole_fallback_query_holds(self):
        rig, session = self._ready()
        session.resident["query-pos"] = (hash_of("query-pos"), list(BOXES), True)
        result = session.query(self._request("query-pos"))
        self.assertEqual(result["reason"], "whole_fallback")


# --- protocol ----------------------------------------------------------------


class ProtocolTests(unittest.TestCase):
    def test_disabled_runtime_answers_without_extraction(self):
        unavailable = augmentation.Unavailable("model_unavailable")
        for kind in ("augmentation_prepare", "augmentation_step", "augment_query"):
            response = unavailable.handle({"type": kind, "snapshotId": "s1"})
            self.assertEqual(response["type"], "augmentation_unavailable")

    def test_unavailable_model_paths(self):
        self.assertFalse(augmentation.augmentation_available("/nowhere", None))
        self.assertFalse(augmentation.augmentation_available("/nowhere", "/missing.onnx"))
        with tempfile.TemporaryDirectory() as folder:
            fake = Path(folder) / "model_feat.onnx"
            fake.write_bytes(b"not the pinned weights")
            self.assertFalse(augmentation.augmentation_available(folder, fake))
        self.assertIsNone(augmentation.augmenter("/nowhere", None, "/tmp/c", None, None)[0])

    def test_one_source_per_step_and_no_second_detector(self):
        rig = Rig({name: 0 for name in REFERENCES + ("x",)}, {"x": {"t": True}})
        model, encoder = rig.model()
        counts, extractions = [], 0
        for _ in range(300):
            response = model.handle({"type": "augmentation_step", "snapshotId": "s1"})
            counts.append(len(model.session.loaded))
            extractions = len(rig_b36(model))
            if response["state"] == "ready":
                break
        self.assertEqual(counts, sorted(set(counts)))  # exactly one new source per step
        self.assertEqual(counts[-1], len(rig.names))
        self.assertEqual(encoder.detector, None)
        self.assertTrue(all(box == (0, 0, 100, 100) for _, _, boxes in encoder.calls for box in boxes))

    def test_building_then_ready(self):
        rig = Rig({name: 0 for name in REFERENCES + ("x",)}, {"x": {"t": True}})
        model, _ = rig.model()
        first = model.handle({"type": "augmentation_step", "snapshotId": "s1"})
        self.assertEqual(first["state"], "building")
        self.assertNotIn("modelId", first)
        final = drain(model)
        self.assertEqual(final["state"], "ready")
        self.assertEqual(len(final["modelId"]), 64)

    def test_query_responses_include_policy_and_calibration_receipts(self):
        rig = mixed_rig([True, True, False, False], queries=("query-pos",))
        model, _ = rig.model()
        session = rig.partition(model.session, partition_rule)
        session.fit()
        bundle = session.bundle(session.assets["query-pos"], session.reference_views())
        request = {"type": "augment_query", "snapshotId": "s1", "assetId": "query-pos",
                   "hash": hash_of("query-pos"), "path": "/tmp/query-pos.png", "bundle": bundle,
                   "queryIdentity": {"pdq": pdq("query-pos"), "quality": 90}}
        for resident, state in [({}, "skipped"),
                                ({"query-pos": (hash_of("query-pos"), list(BOXES), False)}, "ready")]:
            response = model.handle(request, resident=resident)
            self.assertEqual(response["state"], state)
            self.assertEqual(response["policyId"], augmentation.RECALL_POLICY)
            self.assertEqual(response["gates"], session.gates)
            self.assertEqual(response["gates"]["t"]["recovered"], 2)
            self.assertNotIn("additional_tp", response["gates"]["t"])

    def test_model_id_covers_weights_and_gates(self):
        rig = Rig({name: 0 for name in REFERENCES}, {})
        model, _ = rig.model()
        drain(model)
        before = model.session.model_id()
        model.session.model["heads"]["t"]["weights"] = [9.0] * VECTORS
        self.assertNotEqual(model.session.model_id(), before)
        model.session.model["heads"]["t"]["weights"] = [1.0] * VECTORS
        model.session.gates["t"]["enabled"] = not model.session.gates["t"]["enabled"]
        self.assertNotEqual(model.session.model_id(), before)

    def test_reuse_returns_ready_without_steps_and_keeps_state(self):
        rig = Rig({name: 0 for name in REFERENCES}, {})
        model, _ = rig.model()
        drain(model)
        resident = model.session
        response = model.handle({"type": "augmentation_prepare", "snapshotId": "s1",
                                 "snapshot": rig.snapshot()})
        self.assertEqual(response["state"], "ready")
        self.assertIs(model.session, resident)  # features and gates preserved

    def test_reprepare_keeps_partial_warmup(self):
        rig = Rig({name: 0 for name in REFERENCES}, {})
        model, _ = rig.model()
        model.handle({"type": "augmentation_step", "snapshotId": "s1"})
        resident = model.session
        response = model.handle({"type": "augmentation_prepare", "snapshotId": "s1",
                                 "snapshot": rig.snapshot()})
        self.assertEqual(response["state"], "building")
        self.assertIs(model.session, resident)
        self.assertEqual(len(model.session.loaded), 1)
        drain(model)
        self.assertEqual(len(model.b36_cache.extracted), len(rig.names))

    def test_changed_snapshot_identity_starts_a_new_session(self):
        rig = Rig({name: 0 for name in REFERENCES}, {})
        model, _ = rig.model()
        drain(model)
        resident = model.session
        response = model.handle({"type": "augmentation_prepare", "snapshotId": "s2",
                                 "snapshot": rig.snapshot()})
        self.assertEqual(response["state"], "building")
        self.assertIsNot(model.session, resident)

    def test_step_and_snapshot_guards(self):
        rig = Rig({name: 0 for name in REFERENCES}, {})
        # Nothing prepared yet: both messages must be refused.
        bare = augmentation.Model("/nowhere", "unused", "/tmp/cache", FakeEngine(),
                                  FakeB36Cache(rig.b36))
        with self.assertRaises(ValueError):
            bare.handle({"type": "augmentation_step", "snapshotId": "s1"})
        with self.assertRaises(ValueError):
            bare.handle({"type": "augment_query", "snapshotId": "s1", "assetId": "a",
                         "hash": hash_of("a"), "path": "/tmp/a.png", "queryIdentity": {},
                         "bundle": {}})
        model, _ = rig.model()
        drain(model)
        with self.assertRaises(ValueError):
            model.handle({"type": "augmentation_step", "snapshotId": "other"})
        with self.assertRaises(ValueError):
            model.handle({"type": "augmentation_explode"})

    def test_step_without_prepare_is_refused(self):
        model = augmentation.Model("/nowhere", "unused", "/tmp/cache", None, None)
        with self.assertRaises(ValueError):
            model.handle({"type": "augmentation_step", "snapshotId": "s1"})


def rig_b36(model):
    """The B36 cache's extraction log, for the one-source-per-step assertion."""
    return model.b36_cache.extracted


class S36CacheTests(unittest.TestCase):
    def test_stable_extraction_identity(self):
        import character_encoder as encoder
        from character_head import fingerprint
        source = Path(encoder.__file__).read_text()
        original = encoder.feature_id()
        self.assertEqual(original, fingerprint(encoder.contract(source)))
        unrelated = source + "\n# A comment\ndef unrelated():\n    return 42\n"
        self.assertEqual(original, fingerprint(encoder.contract(unrelated)))
        self.assertEqual(original, fingerprint(encoder.contract(source.replace(
            'Expanded feature file exceeds budget', 'Storage-only error'))))
        changed = source.replace('views = [image.crop(b) for b in boxes]',
                                 'views = [image.crop(b).transpose(Image.Transpose.FLIP_LEFT_RIGHT) for b in boxes]')
        self.assertNotEqual(original, fingerprint(encoder.contract(changed)))
        for old, new in [('"width": 768', '"width": 769'),
                         ('Source exceeds pixel limit', 'Changed validation'),
                         ('min(box[2] - box[0]', 'min(1 + box[2] - box[0]')]:
            self.assertNotEqual(original, fingerprint(encoder.contract(source.replace(old, new))))
        with patch.object(encoder, 'SMALL_SHA256', '0' * 64):
            self.assertNotEqual(original, encoder.feature_id())
        with patch.object(encoder, 'extraction_fingerprint', return_value='1' * 64):
            self.assertNotEqual(original, encoder.feature_id())

    def test_concurrent_writers_same_hash_and_startup_cleanup(self):
        from concurrent.futures import ThreadPoolExecutor
        import os
        import threading
        import time
        from character_encoder import load_feature
        with tempfile.TemporaryDirectory() as tmp:
            first, second = augmentation.S36FeatureCache(tmp), augmentation.S36FeatureCache(tmp)
            feature = Features(hash_of('concurrent'), list(BOXES), np.ones((1, 768), np.float32), False)
            barrier = threading.Barrier(2)
            names = []
            save = np.savez
            def simultaneous(stream, **values):
                names.append(stream.name)
                save(stream, **values)
                barrier.wait(timeout=5)
                # A new cache owner must not delete either active partial.
                augmentation.S36FeatureCache(tmp)
                self.assertTrue(Path(stream.name).exists())
            with patch.object(augmentation.np, 'savez', side_effect=simultaneous):
                with ThreadPoolExecutor(max_workers=2) as pool:
                    futures = [pool.submit(cache.write, feature) for cache in (first, second)]
                    for future in futures:
                        future.result(timeout=10)
            self.assertEqual(len(set(names)), 2)
            np.testing.assert_array_equal(load_feature(first.path(feature.content_hash), feature.content_hash).vectors, feature.vectors)
            self.assertFalse(list(first.root.glob('*.part')))
            legacy = first.root / ('a' * 64 + '.part')
            legacy.write_bytes(b'interrupted')
            os.utime(legacy, (time.time()-90000,) * 2)
            augmentation.S36FeatureCache(tmp)
            self.assertFalse(legacy.exists())

    def test_dead_writer_partial_is_cleaned_on_posix(self):
        import os
        if os.name != 'posix':
            self.skipTest('POSIX process-liveness probe')
        with tempfile.TemporaryDirectory() as tmp:
            cache = augmentation.S36FeatureCache(tmp)
            cache.root.mkdir(parents=True)
            partial = cache.root / '123-fixture.part'
            partial.write_bytes(b'interrupted')
            with patch.object(augmentation.os, 'kill', side_effect=ProcessLookupError):
                augmentation.S36FeatureCache(tmp)
            self.assertFalse(partial.exists())

    def test_failed_publish_cleans_only_own_temporary(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = augmentation.S36FeatureCache(tmp)
            feature = Features(hash_of('failed'), list(BOXES), np.ones((1, 768), np.float32), False)
            with patch.object(augmentation.os, 'replace', side_effect=OSError('fixture')):
                with self.assertRaises(OSError):
                    cache.write(feature)
            self.assertFalse(list(cache.root.iterdir()))


if __name__ == "__main__":
    unittest.main()
