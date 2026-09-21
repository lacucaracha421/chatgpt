"""Synthetic fixtures for the standalone character classifier.

Real functions only. Features are tiny synthetic 768-wide vectors and manifests are
written to a directory created beside this package; no library, database, image
decoder, ONNX session or network is touched. Real image/model inference is not
exercised here; the caller runs that separately against isolated data.
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest

import numpy as np

import character_classifier as classifier
import reference_regions
from character_encoder import contract, feature_id
from character_head import (POLICY, VERSION, calibrate, decide, fingerprint, fit_head,
                            grouped_split, probabilities)
from runtime import FINGERPRINT

WIDTH = 768
TARGET = 0
COMPANION = 1
SHARED = 2
SPREAD = 0.02


def aligned(axis, value=1.0, base=0.02, other=None, width=WIDTH):
    """A crop with one axis set explicitly; `other` adds a competing axis."""
    result = np.full((1, width), base, dtype=np.float32)
    result[:, axis] = value
    if other is not None:
        result[:, other[0]] = other[1]
    return result


def literal_head(positive_axes, negative_axes, bias=0.0):
    """A hand-built head with readable weights, for boundary cases that a fitted
    head would keep separating on its own training data."""
    weights = np.zeros(WIDTH, dtype=np.float64)
    for axis in positive_axes:
        weights[axis] += 8.0
    for axis in negative_axes:
        weights[axis] -= 8.0
    return {"state": "uncalibrated", "weights": weights.tolist(), "bias": bias,
            "positive": 2, "negative": 2}


class Arguments:
    """Plain argument holder; classifier commands only read attributes.

    Declared attributes keep static analysis useful while staying a trivial container.
    """

    manifest: Path
    features: Path
    output: Path
    model: Path
    image: Path
    small_model: Path
    detector_models: Path
    candidate: list[str] | None

    def __init__(self, **values):
        self.__dict__.update(values)


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def vector(axis, value=SPREAD, rows=1, width=WIDTH):
    """A tiny vector aligned with one axis; rows repeat the same crop."""
    result = np.full((rows, width), value, dtype=np.float32)
    result[:, axis] = 1.0
    return result


def bags(*axes):
    return [vector(axis) for axis in axes]


def fitted_head():
    """Fit and calibrate directly on the head layer, without the manifest pipeline."""
    training = bags(TARGET, TARGET, COMPANION, COMPANION)
    labels = [True, True, False, False]
    return calibrate(fit_head(training, labels), training, labels)


def ready_head():
    head = fitted_head()
    assert head["state"] == "ready_shadow"
    return head


def withheld_head(state="insufficient_calibration"):
    return {"state": state, "weights": [0.0] * WIDTH, "bias": -20.0, "positive": 1, "negative": 1,
            "calibration": {"positive": 1, "negative": 1}}


class Fixture:
    """Manifest, feature directory and output directory in one package-local temp root."""

    def __init__(self, test):
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        test.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.library = self.root / "library"
        self.library.mkdir()
        self.features = self.root / "features"
        self.features.mkdir()
        self.assets = []
        self.references = []
        self.targets = [{"id": "hero", "display_name": "Hero"}]

    def asset(self, name, axis, value=SPREAD, group=None, partition="development", label=None,
              boxes=1, fallback=False, target="hero", rows=None, seed=False, selection=None):
        content_hash = digest(name)
        vectors = vector(axis, value=value, rows=rows or (1 if fallback else max(1, boxes)))
        self.save_feature(content_hash, vectors, boxes, fallback)
        asset = {"id": name, "content_hash": content_hash, "relative_path": f"{name}.png",
                 "group": group or f"group-{name}", "partition": partition,
                 "original_name": f"{name}.png", "candidate_ids": [target],
                 "labels": {}, "label_provenance": {}}
        if label is not None:
            self.label(asset, label, target=target)
        self.assets.append(asset)
        if seed:
            self.references.append({"asset_id": name, "target_id": target, "asset_hash": content_hash,
                                    "role": "seed", "selection": selection})
        return asset

    def label(self, asset, value, target="hero"):
        asset["labels"][target] = value
        asset["label_provenance"][target] = {"origin": "manual", "asset_hash": asset["content_hash"],
                                             "decision": "accepted" if value else "rejected"}
        return asset

    def save_feature(self, content_hash, vectors, boxes=1, fallback=False):
        rows = 0 if fallback else (boxes if isinstance(boxes, int) else len(boxes))
        np.savez_compressed(self.features / (content_hash + ".npz"), content_hash=content_hash,
                            vectors=np.asarray(vectors, dtype=np.float32),
                            boxes=np.asarray([[0, 0, 40, 40]] * rows, dtype=np.int64).reshape(-1, 4),
                            fallback=fallback, feature_id=feature_id())

    def dataset(self):
        return {"library": str(self.library), "targets": self.targets, "assets": self.assets,
                "references": self.references}

    def write_manifest(self, name="manifest.json", mutate=None):
        data = self.dataset()
        if mutate is not None:
            mutate(data)
        path = self.root / name
        path.write_text(json.dumps({"dataset": data, "sha256": fingerprint(data)}), encoding="utf-8")
        return path

    def output(self, name="out"):
        path = self.root / name
        path.mkdir(exist_ok=True)
        return path

    def command(self, manifest=None, output=None, features=None):
        return Arguments(manifest=manifest or self.write_manifest(), features=features or self.features,
                         output=output or self.output())

    def fit(self):
        args = self.command()
        with quiet():
            classifier.fit(args)
        return args.output

    def model(self, output=None):
        return json.loads(((output or self.output()) / "model.json").read_text(encoding="utf-8"))

    def stored(self):
        return {a["id"]: classifier.load_feature(self.features / (a["content_hash"] + ".npz"),
                                                 a["content_hash"]) for a in self.assets}


@contextlib.contextmanager
def quiet():
    """Commands print progress lines; keep unit-test output readable."""
    with contextlib.redirect_stdout(io.StringIO()) as stream:
        yield stream


class HeadFitTests(unittest.TestCase):
    """A positive bag votes once and never marks every crop of the source positive."""

    def test_positive_bag_does_not_label_an_unregistered_companion(self):
        # A+unknown B: one positive source holding two people, plus negatives for B.
        positive_bag = np.vstack([vector(TARGET), vector(COMPANION)])
        head = fit_head([positive_bag, vector(TARGET), vector(COMPANION), vector(COMPANION)],
                        [True, True, False, False])
        self.assertEqual(head["state"], "uncalibrated")
        scores = probabilities(head, np.vstack([vector(TARGET), vector(COMPANION)]))
        self.assertGreater(float(scores[0]), 0.5)
        self.assertLess(float(scores[1]), 0.5)
        # The unregistered companion never became a positive witness.
        self.assertGreater(float(scores[0]), float(scores[1]))

    def test_mixed_positive_bag_is_not_scored_below_a_pure_negative_bag(self):
        mixed = np.vstack([vector(TARGET), vector(COMPANION, value=0.9)])
        head = fit_head([mixed, vector(TARGET), vector(COMPANION, value=0.9), vector(COMPANION)],
                        [True, True, False, False])
        positive_bag = float(probabilities(head, mixed).max())
        negative_bag = float(probabilities(head, vector(COMPANION, value=0.9)).max())
        self.assertGreater(positive_bag, negative_bag)

    def test_one_class_or_insufficient_source_training_is_withheld(self):
        cases = [(bags(TARGET, TARGET), [True, True]),
                 (bags(COMPANION, COMPANION), [False, False]),
                 (bags(TARGET, TARGET, COMPANION), [True, True, False]),
                 (bags(COMPANION, COMPANION, COMPANION, TARGET), [False, False, False, True])]
        for training, labels in cases:
            with self.subTest(labels=labels):
                head = fit_head(training, labels)
                self.assertEqual(head["state"], "insufficient_training")
                self.assertNotIn("weights", head)
                self.assertEqual(head["positive"] + head["negative"], len(labels))

    def test_empty_bags_are_not_fitted_at_all(self):
        with self.assertRaises(ValueError):
            fit_head([], [])

    def test_invalid_bags_and_labels_fail_loudly(self):
        for training, labels in [(bags(TARGET, COMPANION), [True]),
                                 (bags(TARGET, COMPANION), [True, 0.5]),
                                 (bags(TARGET, COMPANION), [True, "false"]),
                                 ([np.zeros((1, WIDTH), np.float32), vector(COMPANION)], [True, False]),
                                 ([vector(TARGET, rows=9), vector(COMPANION, rows=9)], [True, False]),
                                 ([vector(TARGET), vector(COMPANION, rows=9)], [True, False])]:
            with self.subTest(labels=labels):
                with self.assertRaises(ValueError):
                    fit_head(training, labels)

    def test_mismatched_widths_fail_loudly(self):
        wide = np.ones((1, 16), np.float32)
        narrow = np.ones((1, 8), np.float32)
        with self.assertRaises(ValueError):
            fit_head([wide, narrow], [True, False])


class CalibrationTests(unittest.TestCase):
    def head(self):
        return fit_head(bags(TARGET, TARGET, COMPANION, COMPANION), [True, True, False, False])

    def test_boundary_comes_from_the_calibration_set_only(self):
        head = self.head()
        calibration = bags(TARGET, TARGET, COMPANION, COMPANION)
        result = calibrate(head, calibration, [True, True, False, False])
        self.assertEqual(result["state"], "ready_shadow")
        self.assertEqual(result["calibration"], {"positive": 2, "negative": 2, "recovered": 2,
                                                 "false_positive": 0})
        # Fresh crops that took no part in calibration still split at that boundary.
        scores = probabilities(result, np.vstack([vector(TARGET), vector(COMPANION)]))
        self.assertGreaterEqual(float(scores[0]), result["threshold"])
        self.assertLess(float(scores[1]), result["threshold"])
        # Uncalibrated heads carry no calibration object at all.
        self.assertNotIn("calibration", fit_head(bags(TARGET, TARGET, COMPANION, COMPANION),
                                                 [True, True, False, False]))

    def test_ties_and_short_count_lists_never_produce_a_boundary(self):
        # A single positive against two negatives withholds on count before any tie.
        head = self.head()
        tied = [vector(TARGET), vector(COMPANION, value=10.0), vector(COMPANION, value=10.0)]
        result = calibrate(head, tied, [True, False, False])
        self.assertEqual(result["state"], "insufficient_calibration")
        self.assertNotIn("threshold", result)

        # With enough sources on both sides, an exact positive/negative score tie leaves
        # no unique positive score below every negative, so the head abstains.
        equal_scores = {"state": "uncalibrated", "weights": [0.0] * WIDTH, "bias": 0.0,
                        "positive": 2, "negative": 2}
        tied_pair = [vector(TARGET, value=1.0), vector(TARGET, value=1.0),
                     vector(COMPANION, value=1.0), vector(COMPANION, value=1.0)]
        result = calibrate(equal_scores, tied_pair, [True, True, False, False])
        self.assertEqual(result["state"], "calibration_not_separable")
        self.assertNotIn("threshold", result)

    def test_insufficient_calibration_counts_withhold_the_boundary(self):
        head = fit_head(bags(TARGET, TARGET, COMPANION, COMPANION), [True, True, False, False])
        for labels, calibration in [([True, False], bags(TARGET, COMPANION)),
                                    ([True, True, True], bags(TARGET, TARGET, TARGET)),
                                    ([False, False, False], bags(COMPANION, COMPANION, COMPANION))]:
            with self.subTest(labels=labels):
                result = calibrate(head, calibration, labels)
                self.assertEqual(result["state"], "insufficient_calibration")
                self.assertNotIn("threshold", result)

    def test_recovery_below_the_floor_withholds_the_boundary(self):
        # Two of the three calibration positives score below the hardest negative, so
        # the head may only recover one of them; that is below the policy floor.
        head = literal_head([TARGET], [COMPANION])
        calibration = [aligned(TARGET), aligned(TARGET, 0.2), aligned(TARGET, 0.9),
                       aligned(COMPANION), aligned(COMPANION, 0.9)]
        result = calibrate(head, calibration, [True, True, False, True, False])
        self.assertEqual(result["state"], "insufficient_calibration_recovery")
        self.assertNotIn("threshold", result)
        self.assertEqual(result["calibration"], {"positive": 3, "negative": 2, "recovered": 1,
                                                 "false_positive": 0})

    def test_negative_scoring_above_every_positive_forces_abstention(self):
        head = literal_head([TARGET], [COMPANION])
        # The calibration negatives sit on the positive axis and outscore every
        # positive, so no unique positive score clears them.
        calibration = [aligned(TARGET, 0.05), aligned(TARGET, 0.05),
                       aligned(TARGET, 0.9), aligned(TARGET, 0.9)]
        result = calibrate(head, calibration, [True, True, False, False])
        self.assertEqual(result["state"], "calibration_not_separable")
        self.assertNotIn("threshold", result)

    def test_a_narrow_margin_still_admits_a_boundary(self):
        # Same construction, but one positive clearly outranks every negative.
        head = literal_head([TARGET], [COMPANION])
        calibration = [aligned(TARGET), aligned(TARGET, 0.9), aligned(TARGET, 0.02),
                       aligned(TARGET, 0.01)]
        result = calibrate(head, calibration, [True, True, False, False])
        self.assertEqual(result["state"], "ready_shadow")
        self.assertLess(result["threshold"], float(probabilities(head, aligned(TARGET))[0]))

    def test_unfitted_head_is_not_calibrated(self):
        withheld = {"state": "insufficient_training", "positive": 0, "negative": 0}
        result = calibrate(withheld, [], [])
        self.assertEqual(result["state"], "insufficient_training")
        self.assertNotIn("calibration", result)
        self.assertNotIn("threshold", result)

    def test_invalid_calibration_labels_fail_loudly(self):
        head = fit_head(bags(TARGET, TARGET, COMPANION, COMPANION), [True, True, False, False])
        with self.assertRaises(ValueError):
            calibrate(head, bags(TARGET, COMPANION, COMPANION), [True, False, False, False])
        with self.assertRaises(ValueError):
            calibrate(head, bags(TARGET, TARGET, COMPANION, COMPANION), [1, 1, 0, 0])


class DecisionTests(unittest.TestCase):
    def test_duplicate_crops_agree_and_do_not_raise_a_region_score(self):
        head = ready_head()
        single = decide({"hero": head}, vector(TARGET), ["hero"])
        repeated = decide({"hero": head}, np.vstack([vector(TARGET)] * 8), ["hero"])
        self.assertEqual(single["accepted"], ["hero"])
        self.assertEqual(repeated["accepted"], ["hero"])
        for region in repeated["regions"]:
            self.assertEqual(region["state"], "accepted_shadow")
            self.assertEqual(region["candidates"], ["hero"])
            self.assertEqual(region["scores"]["hero"], single["regions"][0]["scores"]["hero"])
        # Seven identical crops cannot lift an independent competing crop over the
        # boundary: each crop is scored on its own, never on the count of its repeats.
        mixture = decide({"hero": head}, np.vstack([vector(TARGET)] * 7 + [vector(COMPANION)]), ["hero"])
        self.assertEqual(mixture["regions"][-1]["state"], "below_threshold_or_unavailable")
        self.assertEqual(mixture["regions"][-1]["candidates"], [])

    def test_same_crop_competing_heads_withhold_but_independent_crops_survive(self):
        # Two heads that both accept a crop aligned on the shared axis, while each still
        # accepts its own independent axis. The shared crop must be withheld.
        left = calibrate(literal_head([TARGET, SHARED], [COMPANION]),
                         [aligned(TARGET), aligned(TARGET, 0.9), aligned(COMPANION), aligned(COMPANION, 0.9)],
                         [True, True, False, False])
        right = calibrate(literal_head([SHARED, COMPANION], [TARGET]),
                          [aligned(COMPANION), aligned(COMPANION, 0.9), aligned(TARGET), aligned(TARGET, 0.9)],
                          [True, True, False, False])
        self.assertEqual((left["state"], right["state"]), ("ready_shadow", "ready_shadow"))
        shared = aligned(SHARED)
        stacked = np.vstack([shared, aligned(TARGET), aligned(COMPANION)])
        result = decide({"left": left, "right": right}, stacked, ["left", "right"])
        self.assertEqual(result["regions"][0]["state"], "competing_characters")
        self.assertEqual(sorted(result["regions"][0]["candidates"]), ["left", "right"])
        # Independent crops still resolve to exactly one head each.
        self.assertEqual(result["regions"][1]["candidates"], ["left"])
        self.assertEqual(result["regions"][2]["candidates"], ["right"])
        self.assertEqual(result["accepted"], ["left", "right"])
        self.assertEqual(result["state"], "partially_resolved")
        self.assertFalse(result["publication_allowed"])

    def test_unavailable_head_withholds_without_blocking_others(self):
        result = decide({"hero": ready_head(), "rival": withheld_head()},
                        np.vstack([vector(TARGET), vector(COMPANION)]), ["hero", "rival"])
        self.assertEqual(result["regions"][0]["state"], "accepted_shadow")
        self.assertEqual(result["regions"][0]["candidates"], ["hero"])
        self.assertEqual(result["regions"][1]["state"], "below_threshold_or_unavailable")
        self.assertEqual(result["accepted"], ["hero"])
        self.assertEqual(result["unavailable_heads"], {"rival": "insufficient_calibration"})

    def test_unavailable_target_never_becomes_ready(self):
        for state in ("insufficient_training", "insufficient_calibration",
                      "calibration_not_separable", "insufficient_calibration_recovery"):
            with self.subTest(state=state):
                result = decide({"rival": withheld_head(state)}, vector(TARGET), ["rival"])
                self.assertEqual(result["accepted"], [])
                self.assertEqual(result["state"], "held")
                self.assertEqual(result["regions"][0]["candidates"], [])
                self.assertEqual(result["unavailable_heads"], {"rival": state})

    def test_all_crops_accepted_reports_resolved_shadow(self):
        head = ready_head()
        result = decide({"hero": head}, np.vstack([vector(TARGET), vector(TARGET)]), ["hero"])
        self.assertEqual(result["state"], "resolved_shadow")
        self.assertEqual(result["accepted"], ["hero"])

    def test_fallback_never_accepts(self):
        result = decide({"hero": ready_head()}, vector(TARGET), ["hero"], fallback=True)
        self.assertEqual(result["accepted"], [])
        self.assertEqual(result["state"], "held")
        self.assertEqual(result["regions"][0]["state"], "no_detected_region")
        self.assertEqual(result["regions"][0]["candidates"], [])
        # Even a competing fallback crop cannot produce a partial acceptance.
        self.assertEqual(decide({"hero": ready_head(), "rival": withheld_head()}, vector(TARGET),
                                ["hero", "rival"], fallback=True)["accepted"], [])

    def test_unknown_or_duplicate_candidates_are_rejected(self):
        with self.assertRaises(ValueError):
            decide({"hero": ready_head()}, vector(TARGET), ["missing"])
        with self.assertRaises(ValueError):
            decide({"hero": ready_head()}, vector(TARGET), ["hero", "hero"])

    def test_no_candidates_holds_without_inventing_a_target(self):
        result = decide({"hero": ready_head()}, vector(TARGET), [])
        self.assertEqual(result["accepted"], [])
        self.assertEqual(result["state"], "held")
        self.assertEqual(result["regions"][0]["candidates"], [])
        self.assertEqual(result["regions"][0]["scores"], {})


class SplitTests(unittest.TestCase):
    def assets(self, count=20, labels=("hero", "rival")):
        return [{"group": f"g{index:02d}", "labels": {label: True for label in labels}}
                for index in range(count)]

    def test_split_is_deterministic_disjoint_and_keeps_references_in_training(self):
        assets = self.assets()
        assets[0]["partition"] = "reference"
        first = grouped_split(assets, {"g00"})
        self.assertEqual(first, grouped_split(assets, {"g00"}))
        self.assertEqual(set(first), {a["group"] for a in assets})
        self.assertEqual(first["g00"], "train")
        # Every source group is placed exactly once, so partitions stay disjoint.
        self.assertEqual(len(first), len({a["group"] for a in assets}))
        self.assertEqual(sorted(first.values()).count("calibration"), 4)
        self.assertEqual(sorted(first.values()).count("test"), 4)
        self.assertEqual(sorted(first.values()).count("train"), 12)

    def test_every_reference_group_is_training_only(self):
        assets = self.assets(20)
        references = {f"g{index:02d}" for index in range(10)}
        split = grouped_split(assets, references)
        self.assertTrue(all(split[group] == "train" for group in references))
        remainder = [group for group in split if group not in references]
        self.assertEqual(len(remainder), 10)
        self.assertEqual(sorted(split[group] for group in remainder).count("calibration"), 2)
        self.assertEqual(sorted(split[group] for group in remainder).count("test"), 2)

    def test_labelled_groups_are_stratified_but_unlabelled_ones_are_placed_too(self):
        assets = [{"group": f"g{index:02d}", "labels": {"hero": True} if index < 10 else {}}
                  for index in range(20)]
        split = grouped_split(assets, set())
        placed = {name: sum(1 for value in split.values() if value == name)
                  for name in ("train", "calibration", "test")}
        self.assertEqual(placed, {"train": 12, "calibration": 4, "test": 4})
        # An unlabelled group is still placed exactly once rather than dropped.
        self.assertEqual(len(split), 20)

    def test_very_rare_classes_are_not_special_cased(self):
        assets = [{"group": f"g{index:02d}", "labels": {"hero": True}} for index in range(10)]
        assets[0]["labels"]["rare"] = True
        split = grouped_split(assets, set())
        self.assertEqual(set(split), {a["group"] for a in assets})
        self.assertEqual(sorted(split.values()).count("test"), 2)


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture(self)
        self.fixture.asset("one", TARGET, label=True)

    def load(self, mutate):
        return classifier.load_manifest(self.fixture.write_manifest(mutate=mutate))

    def test_valid_manifest_is_accepted(self):
        data, declared = self.load(None)
        self.assertEqual(declared, fingerprint(data))
        self.assertEqual([a["id"] for a in data["assets"]], ["one"])

    def test_malformed_feature_file_fails_the_contract(self):
        content_hash = self.fixture.assets[0]["content_hash"]
        path = self.fixture.features / (content_hash + ".npz")
        boxes = np.zeros((1, 4), np.int64)
        # A missing contract field, wrong width, non-finite vectors, a zero vector and
        # a stale content hash must each be refused by the loader corpus uses.
        cases = [
            ({"content_hash": content_hash, "vectors": vector(TARGET), "boxes": boxes,
              "fallback": False}, KeyError),
            ({"content_hash": content_hash, "feature_id": feature_id(),
              "boxes": boxes, "fallback": False}, KeyError),
        ]
        for values, expected in cases:
            with self.subTest(keys=sorted(values)):
                np.savez_compressed(path, **values)
                with self.assertRaises(expected):
                    classifier.load_feature(path, content_hash)
        for vectors in (np.ones((1, 8), np.float32),
                        np.full((1, WIDTH), np.nan, np.float32),
                        np.zeros((1, WIDTH), np.float32),
                        np.ones((1, WIDTH), np.float64)):
            with self.subTest(dtype=vectors.dtype, shape=vectors.shape):
                np.savez_compressed(path, content_hash=content_hash, vectors=vectors,
                                    boxes=boxes, fallback=False, feature_id=feature_id())
                with self.assertRaises(ValueError):
                    classifier.load_feature(path, content_hash)
        np.savez_compressed(path, content_hash=digest("other"), vectors=vector(TARGET),
                            boxes=boxes, fallback=False, feature_id=feature_id())
        with self.assertRaises(ValueError):
            classifier.load_feature(path, content_hash)
        np.savez_compressed(path, content_hash=content_hash, vectors=vector(TARGET),
                            boxes=boxes, fallback=False, feature_id="stale")
        with self.assertRaises(ValueError):
            classifier.load_feature(path, content_hash)

    def test_missing_feature_file_is_refused(self):
        with self.assertRaises(FileNotFoundError):
            classifier.load_feature(self.fixture.features / "absent.npz", "a" * 64)

    def test_tampered_manifest_digest_is_rejected(self):
        path = self.fixture.write_manifest()
        envelope = json.loads(path.read_text(encoding="utf-8"))
        envelope["dataset"]["assets"][0]["original_name"] = "changed.png"
        path.write_text(json.dumps(envelope), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            classifier.load_manifest(path)

    def test_duplicate_assets_and_bad_digests_are_rejected(self):
        for mutate in (lambda data: data["assets"].append(dict(data["assets"][0])),
                       lambda data: data["assets"].append(
                           {**data["assets"][0], "id": "other"}),
                       lambda data: data["assets"][0].update({"content_hash": "not-a-digest"}),
                       lambda data: data["assets"][0].update({"content_hash": "A" * 64}),
                       lambda data: data["targets"].append(dict(data["targets"][0]))):
            with self.subTest(mutate=mutate):
                with self.assertRaises(ValueError):
                    self.load(mutate)

    def test_duplicate_source_digest_fails_the_manifest(self):
        def duplicate_content(data):
            clone = json.loads(json.dumps(data["assets"][0]))
            clone["id"] = "two"
            data["assets"].append(clone)
        with self.assertRaises(ValueError):
            self.load(duplicate_content)

    def test_label_scope_and_provenance_are_enforced(self):
        def out_of_scope(data):
            data["assets"][0]["labels"]["rival"] = True
            data["assets"][0]["label_provenance"]["rival"] = {
                "origin": "manual", "asset_hash": data["assets"][0]["content_hash"],
                "decision": "accepted"}

        def wrong_hash(data):
            data["assets"][0]["label_provenance"]["hero"]["asset_hash"] = digest("other")

        def automatic(data):
            data["assets"][0]["label_provenance"]["hero"]["origin"] = "automatic"

        def non_boolean(data):
            data["assets"][0]["labels"]["hero"] = 1

        def mismatched_decision(data):
            data["assets"][0]["label_provenance"]["hero"]["decision"] = "rejected"

        for mutate in (out_of_scope, wrong_hash, automatic, non_boolean, mismatched_decision):
            with self.subTest(mutate=mutate):
                with self.assertRaises(ValueError):
                    self.load(mutate)

    def test_reference_identity_is_enforced(self):
        self.fixture.references.append({"asset_id": "missing", "target_id": "hero",
                                        "asset_hash": digest("missing"), "role": "seed", "selection": None})
        with self.assertRaises(ValueError):
            self.load(None)


class PathGuardTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture(self)
        self.fixture.asset("one", TARGET, label=True)
        self.data = self.fixture.dataset()

    def test_source_escape_is_refused(self):
        outside = self.fixture.root / "outside.png"
        outside.write_bytes(b"image")
        (self.fixture.library / "nested").mkdir()
        for relative in ("../outside.png", "nested/../../outside.png", str(outside)):
            with self.subTest(relative=relative):
                self.data["assets"][0]["relative_path"] = relative
                with self.assertRaises(ValueError):
                    classifier.source_path(self.data, self.data["assets"][0])

    def test_escape_through_a_missing_directory_still_fails_closed(self):
        self.data["assets"][0]["relative_path"] = "absent/../../outside.png"
        with self.assertRaises((ValueError, FileNotFoundError)):
            classifier.source_path(self.data, self.data["assets"][0])
        # A plain missing file inside the library is also refused, not silently skipped.
        self.data["assets"][0]["relative_path"] = "absent/one.png"
        with self.assertRaises(FileNotFoundError):
            classifier.source_path(self.data, self.data["assets"][0])

    def test_source_inside_library_resolves(self):
        inside = self.fixture.library / "nested" / "one.png"
        inside.parent.mkdir()
        inside.write_bytes(b"image")
        self.data["assets"][0]["relative_path"] = "nested/one.png"
        self.assertEqual(classifier.source_path(self.data, self.data["assets"][0]), inside.resolve())

    def test_symlinks_are_resolved_before_the_library_boundary_check(self):
        outside = self.fixture.root / "outside.png"
        outside.write_bytes(b"image")
        inside = self.fixture.library / "inside.png"
        inside.write_bytes(b"image")
        escape = self.fixture.library / "escape.png"
        internal = self.fixture.library / "internal.png"
        try:
            os.symlink(outside, escape)
            os.symlink(inside, internal)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable on this host")
        self.data["assets"][0]["relative_path"] = "escape.png"
        with self.assertRaises(ValueError):
            classifier.source_path(self.data, self.data["assets"][0])
        # A link that stays inside the library is still a normal source.
        self.data["assets"][0]["relative_path"] = "internal.png"
        self.assertEqual(classifier.source_path(self.data, self.data["assets"][0]), inside.resolve())

    def test_source_hashes_are_read_through_the_resolved_path(self):
        inside = self.fixture.library / "one.png"
        inside.write_bytes(b"image")
        self.data["assets"][0]["relative_path"] = "one.png"
        path = classifier.source_path(self.data, self.data["assets"][0])
        self.assertEqual(path.read_bytes(), b"image")

    def test_missing_source_is_refused(self):
        self.data["assets"][0]["relative_path"] = "absent.png"
        with self.assertRaises(FileNotFoundError):
            classifier.source_path(self.data, self.data["assets"][0])

    def test_output_inside_a_source_library_is_refused(self):
        nested = self.fixture.library / "reports"
        nested.mkdir()
        for candidate in (nested, self.fixture.library):
            with self.subTest(candidate=candidate):
                with self.assertRaises(ValueError):
                    classifier.output_directory(candidate, [self.fixture.library])
        self.assertEqual(classifier.output_directory(self.fixture.output(), [self.fixture.library]),
                         self.fixture.output().resolve())

    def test_output_directories_must_already_exist(self):
        with self.assertRaises(FileNotFoundError):
            classifier.output_directory(self.fixture.root / "absent", [self.fixture.library])
        file = self.fixture.root / "file.txt"
        file.write_text("x", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "dedicated output directory"):
            classifier.output_directory(file, [self.fixture.library])

    def test_write_new_is_exclusive_and_blocks_library_destinations(self):
        target = self.fixture.root / "report.json"
        classifier.write_new(target, {"a": 1}, [self.fixture.library])
        self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"a": 1})
        with self.assertRaises(FileExistsError):
            classifier.write_new(target, {"a": 2}, [self.fixture.library])
        for inside in (self.fixture.library / "report.json", self.fixture.library):
            with self.subTest(inside=inside):
                with self.assertRaises(ValueError):
                    classifier.write_new(inside, {"a": 3}, [self.fixture.library])

    def test_output_directory_is_resolved_before_the_library_check(self):
        outside = self.fixture.output()
        escape = self.fixture.library / "out-link"
        inside_link = self.fixture.library / "inside-link"
        try:
            os.symlink(outside, escape, target_is_directory=True)
            os.symlink(self.fixture.library, inside_link, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable on this host")
        # A link to a directory outside the library is an acceptable destination.
        self.assertEqual(classifier.output_directory(escape, [self.fixture.library]), outside.resolve())
        # A link back into the library must not launder a protected destination.
        with self.assertRaises(ValueError):
            classifier.output_directory(inside_link, [self.fixture.library])

    def test_output_directory_inside_a_link_target_is_refused(self):
        link = self.fixture.root / "library-link"
        try:
            os.symlink(self.fixture.library, link, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable on this host")
        nested = self.fixture.library / "reports"
        nested.mkdir()
        # An alias path resolves back into the library, so it is still protected.
        with self.assertRaises(ValueError):
            classifier.output_directory(link / "reports", [self.fixture.library])
        # A genuinely separate directory reached the same way is allowed.
        separate = self.fixture.output()
        alias = self.fixture.root / "separate-link"
        os.symlink(separate, alias, target_is_directory=True)
        self.assertEqual(classifier.output_directory(alias, [self.fixture.library]), separate.resolve())

    def test_fit_refuses_an_output_inside_the_library(self):
        inside = self.fixture.library / "run"
        inside.mkdir()
        args = self.fixture.command(output=inside)
        with self.assertRaises(ValueError):
            with quiet():
                classifier.fit(args)
        self.assertEqual(list(inside.iterdir()), [])


class ModelPersistenceTests(unittest.TestCase):
    def build(self, count=24):
        fixture = Fixture(self)
        for index in range(count):
            axis = TARGET if index % 2 == 0 else COMPANION
            fixture.asset(f"a{index:02d}", axis, group=f"g{index:02d}", label=index % 2 == 0)
        return fixture

    def test_fit_persists_a_reloadable_bundle_and_freezes_the_split_first(self):
        fixture = self.build()
        output = fixture.fit()
        self.assertEqual(sorted(path.name for path in output.iterdir()), ["model.json", "split.json"])
        model, model_id = classifier.load_model(output / "model.json")
        self.assertEqual(model_id, fixture.model()["sha256"])
        self.assertEqual(model["version"], VERSION)
        self.assertIs(model["publication_allowed"], False)
        self.assertEqual(model["sources"], classifier.source_identity())
        self.assertEqual(model["feature_contract"], contract())
        self.assertEqual(model["feature_id"], feature_id())
        self.assertEqual(model["policy"], POLICY)
        self.assertEqual(model["protected_roots"], [str(fixture.library)])
        self.assertEqual(set(model["split"]), {a["group"] for a in fixture.assets})
        self.assertEqual(set(model["training"]), {"hero"})

    def test_split_json_records_the_frozen_decisions_before_fitting(self):
        fixture = self.build()
        output = fixture.fit()
        split = json.loads((output / "split.json").read_text(encoding="utf-8"))
        model = fixture.model()["model"]
        self.assertEqual(split["groups"], model["split"])
        self.assertEqual(split["manifest"], model["manifest"])
        self.assertEqual(split["policy"], POLICY)
        self.assertEqual(model["split_id"], fingerprint(split))
        self.assertIn("NOT fresh external validation", split["evaluation_status"])

    def test_training_output_must_start_empty(self):
        fixture = self.build()
        output = fixture.output()
        (output / "kept.json").write_text('{"keep": true}', encoding="utf-8")
        args = fixture.command(output=output)
        with self.assertRaises(ValueError):
            with quiet():
                classifier.fit(args)
        self.assertEqual((output / "kept.json").read_text(encoding="utf-8"), '{"keep": true}')
        self.assertFalse((output / "split.json").exists())

    def test_stale_or_tampered_bundles_are_refused(self):
        fixture = self.build()
        path = fixture.fit() / "model.json"
        envelope = json.loads(path.read_text(encoding="utf-8"))
        mutations = [lambda value: value["model"].update({"heads": {}}),
                     lambda value: value["model"].update({"version": VERSION + 1}),
                     lambda value: value["model"].update({"sources": {}}),
                     lambda value: value["model"].update({"feature_id": "0" * 64}),
                     lambda value: value["model"].update({"feature_contract": {}}),
                     lambda value: value["model"].update({"policy": {**POLICY, "epochs": 1}}),
                     lambda value: value["model"].update({"publication_allowed": True}),
                     lambda value: value.update({"sha256": "0" * 64})]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                changed = json.loads(json.dumps(envelope))
                mutate(changed)
                path.write_text(json.dumps(changed), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "Stale or incompatible"):
                    classifier.load_model(path)

    def test_untouched_bundle_still_reloads_after_the_tampering_attempts(self):
        fixture = self.build()
        path = fixture.fit() / "model.json"
        before = path.read_bytes()
        classifier.load_model(path)
        self.assertEqual(path.read_bytes(), before)

    def test_exposure_hashes_cover_every_non_test_source(self):
        fixture = self.build()
        fixture.fit()
        model = fixture.model()["model"]
        expected = {a["content_hash"] for a in fixture.assets if model["split"][a["group"]] != "test"}
        self.assertEqual(set(model["exposure_hashes"]), expected)
        self.assertTrue(expected)

    def test_evaluate_writes_a_report_over_the_frozen_test_partition(self):
        fixture = self.build()
        output = fixture.fit()
        model = classifier.load_model(output / "model.json")[0]
        args = fixture.command(output=output / "evaluation.json", manifest=fixture.write_manifest())
        args.model = output / "model.json"
        with quiet():
            classifier.evaluate(args)
        report = json.loads(Path(args.output).read_text(encoding="utf-8"))
        self.assertEqual(report["model_id"], fixture.model()["sha256"])
        self.assertEqual(report["manifest"], model["manifest"])
        self.assertIs(report["publication_allowed"], False)
        self.assertFalse(report["adoption"]["ready"])
        self.assertIn("previously_inspected_development_data", report["adoption"]["reasons"])
        self.assertIn("no_native_integration_acceptance", report["adoption"]["reasons"])
        evaluated = {a["id"] for a in fixture.assets if model["split"][a["group"]] == "test"}
        self.assertEqual({row["asset_id"] for row in report["rows"]}, evaluated)
        self.assertEqual(report["metrics"]["images"], len(evaluated))
        self.assertEqual(report["metrics"]["per_target"]["hero"]["positive"]
                         + report["metrics"]["per_target"]["hero"]["negative"], len(evaluated))
        for row in report["rows"]:
            self.assertNotIn(row["content_hash"], model["exposure_hashes"])

    def test_evaluate_refuses_a_different_manifest_or_changed_features(self):
        fixture = self.build()
        output = fixture.fit()
        other = Fixture(self)
        other.asset("only", TARGET, label=True)
        args = other.command(output=output / "evaluation.json")
        args.model = output / "model.json"
        with self.assertRaisesRegex(ValueError, "differs from frozen split"):
            with quiet():
                classifier.evaluate(args)
        self.assertFalse(Path(args.output).exists())

        changed = self.build()
        changed_output = changed.fit()
        # Corrupt one stored feature so the corpus hashes no longer match the bundle.
        target = changed.assets[0]
        changed.save_feature(target["content_hash"], vector(COMPANION))
        args = changed.command(output=changed_output / "evaluation.json")
        args.model = changed_output / "model.json"
        with self.assertRaisesRegex(ValueError, "features changed"):
            with quiet():
                classifier.evaluate(args)
        self.assertFalse(Path(args.output).exists())

    def test_evaluate_refuses_to_overwrite_an_existing_report(self):
        fixture = self.build()
        output = fixture.fit()
        existing = output / "evaluation.json"
        existing.write_text('{"keep": true}', encoding="utf-8")
        args = fixture.command(output=existing)
        args.model = output / "model.json"
        with self.assertRaises(FileExistsError):
            with quiet():
                classifier.evaluate(args)
        self.assertEqual(existing.read_text(encoding="utf-8"), '{"keep": true}')

    def test_corpus_reads_every_feature_file_and_hashes_it(self):
        fixture = self.build(count=4)
        args = fixture.command()
        data, _ = classifier.load_manifest(args.manifest)
        stored, digests = classifier.corpus(data, fixture.features)
        self.assertEqual(set(stored), {a["id"] for a in fixture.assets})
        self.assertEqual(set(digests), {a["content_hash"] for a in fixture.assets})
        self.assertTrue(all(len(value) == 64 for value in digests.values()))


class LabelledBagsTests(unittest.TestCase):
    def setUp(self):
        self.fixture = Fixture(self)
        self.split = {}

    def bags(self, target="hero", partition="train"):
        data = self.fixture.dataset()
        return classifier.labelled_bags(data, self.fixture.stored(), self.split, target, partition)

    def test_missing_label_is_ignored_and_never_counted_as_negative(self):
        self.fixture.asset("labelled", TARGET, group="g1", label=True)
        self.fixture.asset("unlabelled", COMPANION, group="g2")
        self.split.update({"g1": "train", "g2": "train"})
        training, labels, ids, skipped = self.bags()
        self.assertEqual((ids, labels), (["labelled"], [True]))
        self.assertEqual(len(training), 1)
        self.assertEqual(skipped, {})

    def test_manual_negative_overrides_a_seed_positive(self):
        self.fixture.asset("seed", TARGET, group="g1", label=False, seed=True)
        self.split["g1"] = "train"
        _, labels, ids, skipped = self.bags()
        self.assertEqual((ids, labels), (["seed"], [False]))
        self.assertEqual(skipped, {})

    def test_seed_without_a_manual_label_becomes_positive(self):
        selection = {"contentHash": digest("seed"), "baselineFingerprint": FINGERPRINT,
                     "bounds": [0, 0, 40, 40]}
        self.fixture.asset("seed", TARGET, group="g1", seed=True, selection=selection)
        self.split["g1"] = "train"
        training, labels, ids, _ = self.bags()
        self.assertEqual((ids, labels), (["seed"], [True]))
        self.assertEqual(len(training[0]), 1)

    def test_seed_region_projection_uses_the_selected_person_only(self):
        selection = {"contentHash": digest("seed"), "baselineFingerprint": FINGERPRINT,
                     "bounds": [0, 0, 40, 40]}
        asset = self.fixture.asset("seed", TARGET, group="g1", boxes=2, seed=True, selection=selection)
        asset["labels"]["hero"] = True
        asset["label_provenance"]["hero"] = {"origin": "manual", "asset_hash": asset["content_hash"],
                                             "decision": "accepted"}
        self.split["g1"] = "train"
        training, _, ids, _ = self.bags()
        self.assertEqual(ids, ["seed"])
        self.assertEqual(len(training[0]), 1)
        original = self.fixture.stored()["seed"]
        self.assertEqual(len(original.vectors), 2)
        self.assertEqual(len(original.boxes), 2)

    def test_stale_seed_region_is_skipped_instead_of_guessed(self):
        selection = {"contentHash": digest("seed"), "baselineFingerprint": FINGERPRINT,
                     "bounds": [5, 5, 45, 45]}
        self.fixture.asset("seed", TARGET, group="g1", seed=True, selection=selection)
        self.split["g1"] = "train"
        training, labels, ids, skipped = self.bags()
        self.assertEqual((training, labels, ids), ([], [], []))
        self.assertEqual(skipped, {"stale_manual_region": 1})

    def test_foreign_seed_region_content_hash_is_skipped(self):
        selection = {"contentHash": digest("other"), "baselineFingerprint": FINGERPRINT,
                     "bounds": [0, 0, 40, 40]}
        self.fixture.asset("seed", TARGET, group="g1", seed=True, selection=selection)
        self.split["g1"] = "train"
        self.assertEqual(self.bags()[3], {"stale_manual_region": 1})

    def test_conflicting_group_labels_are_quarantined(self):
        self.fixture.asset("first", TARGET, group="shared", label=True)
        self.fixture.asset("second", COMPANION, group="shared", label=False)
        self.fixture.asset("clean", TARGET, group="other", label=True)
        self.split.update({"shared": "train", "other": "train"})
        _, labels, ids, skipped = self.bags()
        self.assertEqual((ids, labels), (["clean"], [True]))
        self.assertEqual(skipped, {"conflicting_group_labels": 1})

    def test_duplicate_sources_in_one_group_supply_one_vote(self):
        self.fixture.asset("first", TARGET, group="shared", label=True)
        self.fixture.asset("second", TARGET, group="shared", label=True)
        self.split["shared"] = "train"
        training, _, _, skipped = self.bags()
        self.assertEqual(len(training), 1)
        self.assertEqual(skipped, {})

    def test_fallback_source_has_no_region_and_is_skipped(self):
        self.fixture.asset("whole", TARGET, group="g1", label=True, fallback=True)
        self.split["g1"] = "train"
        training, labels, ids, skipped = self.bags()
        self.assertEqual((training, labels, ids), ([], [], []))
        self.assertEqual(skipped, {"no_detected_region": 1})

    def test_other_partition_and_historical_probe_sources_do_not_leak(self):
        self.fixture.asset("train", TARGET, group="g1", label=True)
        self.fixture.asset("probe", TARGET, group="g2", label=True, partition="historical_probe")
        self.split.update({"g1": "train", "g2": "train"})
        self.assertEqual(self.bags()[2], ["train"])
        self.split["g1"] = "test"
        self.assertEqual(self.bags()[2], [])

    def test_other_target_has_no_effect(self):
        self.fixture.asset("one", TARGET, group="g1", label=True, target="rival")
        self.split["g1"] = "train"
        training, labels, ids, skipped = self.bags(target="hero")
        self.assertEqual((training, labels, ids, skipped), ([], [], [], {}))

    def test_reference_only_groups_stay_training_side(self):
        self.fixture.asset("seed", TARGET, group="reference-group", label=True, seed=True)
        self.split["reference-group"] = "train"
        self.assertEqual(self.bags()[2], ["seed"])

    def test_projection_helper_rejects_a_binding_from_another_baseline(self):
        selection = {"contentHash": digest("seed"), "baselineFingerprint": "0" * 64,
                     "bounds": [0, 0, 40, 40]}
        content_hash = digest("seed")
        self.fixture.save_feature(content_hash, vector(TARGET))
        feature = classifier.load_feature(self.fixture.features / (content_hash + ".npz"), content_hash)
        with self.assertRaises(ValueError):
            reference_regions.project_reference(feature, selection)


class PredictGuardTests(unittest.TestCase):
    """Predict needs real sessions; only its refusal paths run without models."""

    def test_predict_refuses_a_stale_bundle_before_touching_models(self):
        fixture = Fixture(self)
        fixture.asset("one", TARGET, label=True)
        model = fixture.root / "model.json"
        model.write_text(json.dumps({"sha256": "0" * 64, "model": {"version": VERSION}}),
                         encoding="utf-8")
        args = Arguments(model=model, output=fixture.output() / "prediction.json",
                         image=fixture.library / "one.png", candidate=None,
                         small_model=fixture.root / "missing.onnx",
                         detector_models=fixture.root / "models")
        with self.assertRaisesRegex(ValueError, "Stale or incompatible"):
            classifier.predict(args)
        self.assertFalse(args.output.exists())

    def test_predict_refuses_a_missing_bundle(self):
        fixture = Fixture(self)
        args = Arguments(model=fixture.root / "absent.json", output=fixture.output() / "prediction.json",
                         image=fixture.root / "absent.png", candidate=None,
                         small_model=fixture.root / "missing.onnx",
                         detector_models=fixture.root / "models")
        with self.assertRaises(FileNotFoundError):
            classifier.predict(args)
        self.assertFalse(args.output.exists())


if __name__ == "__main__":
    unittest.main()
