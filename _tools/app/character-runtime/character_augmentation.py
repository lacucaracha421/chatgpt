"""Optional native-ready augmentation. Never a replacement for native decisions.

The Rust owner supplies a snapshot of library metadata and drives this module
one source at a time. Two rules keep the layer auditable and safe:

* Geometry comes only from the *resident* B36 extraction. The snapshot carries
  no boxes, fallback flag, or native evidence, and a caller-supplied bundle can
  never introduce a crop the native worker did not detect.
* A target changes behaviour only when separate calibration groups show
  positive recall utility within a bounded explicit-negative error budget.

Nothing here writes to a library, opens a database, downloads a model, or runs
a detector.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import zipfile

import numpy as np

from character_head import decide, fingerprint, fit_head, grouped_split, probabilities
from feature_cache import MAX_CACHE_BYTES
from holdout_rules import same_person, validate_evidence
from reference_regions import compare_bound, project_reference, resolve_references
from runtime import BASELINE, FINGERPRINT

VERSION = 1
MAX_LABEL_TARGETS = 8
MAX_ASSETS = 256
MAX_TARGETS = 8
MINIMUM_QUALITY = 50
RECALL_POLICY = "recall-tp-minus-2fp-v1"
# Two 32-byte halves per PDQ; a near-duplicate is within this Hamming distance
# of ANY pairing of the stored whole-image and cropped variants.
PDQ_HEX = 128
HALF_HEX = 64
DUPLICATE_HAMMING = 30
# S36 features live in their own contract namespace inside the shared cache.
S36_NAMESPACE = "s36-augmentation-v1"


def policy_contract(native_policy):
    """The exact, finite slice of native policy this module may depend on."""
    threshold = native_policy["recommendation_threshold"]
    support = native_policy["automatic_support"]
    maximum = native_policy["automatic_max_distance"]
    margin = native_policy["automatic_competitor_margin"]
    if (native_policy["logic_version"] != 2
            or native_policy["baseline_fingerprint"] != FINGERPRINT
            or type(threshold) is not float or not np.isfinite(threshold)
            or type(support) is not int or not 2 <= support <= 25
            or type(maximum) is not float or not np.isfinite(maximum) or not 0 < maximum <= 1
            or type(margin) is not float or not np.isfinite(margin) or margin <= 0):
        raise ValueError("Invalid snapshot policy")
    return {"logic_version": 2, "recommendation_threshold": threshold,
            "automatic_support": support, "automatic_max_distance": maximum,
            "automatic_competitor_margin": margin, "baseline_fingerprint": FINGERPRINT}


def calibrate_recall(head, bags, labels):
    """Select a recall boundary using only held-apart calibration groups.

    Logistic scores are not identity probabilities. One false positive costs
    two recovered positives; ties prefer fewer errors, then a higher boundary.
    """
    result = {key: value for key, value in head.items()
              if key not in ("threshold", "calibration")}
    if "weights" not in head:
        return result
    if len(bags) != len(labels) or any(type(label) is not bool for label in labels):
        raise ValueError("Invalid calibration labels")
    scores = [float(probabilities(head, bag).max()) for bag in bags]
    if not np.isfinite(scores).all():
        raise ValueError("Nonfinite calibration score")
    positive, negative = sum(labels), len(labels) - sum(labels)
    result["calibration"] = {"positive": positive, "negative": negative}
    if positive < 1 or negative < 2:
        result["state"] = "insufficient_calibration"
        return result
    budget = max(1, negative // 10)
    candidates = []
    for threshold in sorted({0.5, *(score for score in scores if score >= 0.5)}):
        tp = sum(label and score >= threshold for score, label in zip(scores, labels))
        fp = sum(not label and score >= threshold for score, label in zip(scores, labels))
        utility = tp - 2 * fp
        if fp <= budget and tp > 0 and utility > 0:
            candidates.append((utility, -fp, threshold, tp, fp))
    if not candidates:
        result["state"] = "no_positive_calibration_utility"
        return result
    utility, _, threshold, tp, fp = max(candidates)
    result.update(state="ready_shadow", threshold=threshold)
    result["calibration"].update(recovered=tp, false_positive=fp,
                                 utility=utility, error_budget=budget)
    return result


def potential_additions(native_accepted, bundle, head_decision, policy):
    """A ready head may rescue a crop even with zero B36 reference votes.

    Local copy of the frozen experiment rule, kept here so no experiment module
    is imported at runtime. It receives no labels, and existing native
    acceptances are immutable. A native-accepted or ready-head competitor on the
    same person blocks extras; unavailable heads never authorize any.
    """
    existing = set(native_accepted)
    additions = {}
    if not bundle or next(iter(bundle.values()))["wholeFallback"]:
        return additions
    boxes = next(iter(bundle.values()))["queryBoxes"]
    if len(boxes) != len(head_decision["regions"]):
        raise ValueError("Candidate regions do not match the resident query")
    support = policy["automatic_support"]
    for index, region in enumerate(head_decision["regions"]):
        if region["state"] != "accepted_shadow" or len(region["candidates"]) != 1:
            continue
        target = region["candidates"][0]
        if target in existing or target in head_decision["unavailable_heads"]:
            continue

        strong_competitor = any(
            same_person(boxes[index], box) and len(other_row["matchedReferences"]) >= support
            and sorted(other_row["referenceDistances"])[support - 1] <= policy["automatic_max_distance"]
            for other in existing if other != target
            for box, other_row in zip(bundle[other]["queryBoxes"], bundle[other]["evidence"]))
        competing_head = any(
            peer_index != index and same_person(boxes[index], boxes[peer_index])
            and any(other != target for other in peer["candidates"])
            for peer_index, peer in enumerate(head_decision["regions"]))
        if not strong_competitor and not competing_head:
            additions.setdefault(target, []).append(index)
    return additions


def feature_identity():
    """Identity of the S36 feature contract (never of a model file on disk)."""
    from character_encoder import contract
    return fingerprint(contract())


def _sha256(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def _source_identity():
    here = Path(__file__).parent
    return {name: _sha256(here / name) for name in (
        "character_augmentation.py", "character_head.py", "character_encoder.py",
        "feature_cache.py", "holdout_rules.py", "reference_regions.py", "runtime.py")}


def s36_availability(small_model):
    """True only for the exact pinned S36 weights. A missing path is simply off."""
    try:
        from character_encoder import SMALL_SHA256
        return _sha256(small_model) == SMALL_SHA256
    except (OSError, ValueError, TypeError):
        return False


def augmentation_available(models, augmentation_model):
    """Cheap opt-in probe. Never raises and never touches the native baseline."""
    if augmentation_model is None:
        return False
    if not s36_availability(augmentation_model):
        return False
    try:
        return (Path(models) / "character-detector.onnx").is_file()
    except (OSError, TypeError):
        return False


class S36FeatureCache:
    """Atomic S36 features in the caller's cache, namespaced away from B36."""

    def __init__(self, root, implementation=None):
        self.root = (Path(root) / S36_NAMESPACE
                     / (feature_identity() if implementation is None else implementation))

    def path(self, content_hash):
        return self.root / (content_hash + ".npz")

    def read(self, content_hash, boxes):
        from character_encoder import load_feature
        path = self.path(content_hash)
        try:
            if path.stat().st_size > MAX_CACHE_BYTES:
                return None
            with zipfile.ZipFile(path) as archive:
                if sum(info.file_size for info in archive.infolist()) > MAX_CACHE_BYTES:
                    return None
            feature = load_feature(path, content_hash)
        except (OSError, ValueError, KeyError, EOFError, zipfile.BadZipFile):
            return None
        if [tuple(box) for box in feature.boxes] != [tuple(box) for box in boxes] or feature.fallback:
            return None
        return feature

    def write(self, feature):
        from character_encoder import feature_id
        self.root.mkdir(parents=True, exist_ok=True)
        destination = self.path(feature.content_hash)
        temporary = destination.with_suffix(".part")
        try:
            with temporary.open("wb") as stream:
                np.savez(stream, content_hash=feature.content_hash, vectors=feature.vectors,
                         boxes=np.asarray(feature.boxes, dtype=np.int64).reshape(-1, 4),
                         fallback=feature.fallback, feature_id=feature_id())
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)


class Unavailable:
    """A disabled optional feature. Answers every message without extraction."""

    def __init__(self, reason):
        self.reason = reason

    def handle(self, request, resident=None):
        return {"type": "augmentation_unavailable",
                "snapshotId": str(request.get("snapshotId", "")), "reason": self.reason}


class Session:
    """One prepared snapshot: frozen split, resident B36 geometry, one model."""

    def __init__(self, request, engine, b36_cache, s36_cache, encoder_factory):
        self.snapshot_id = str(request.get("snapshotId", ""))
        if not self.snapshot_id:
            raise ValueError("Snapshot id required")
        self.snapshot = _snapshot(request)
        self.targets = _targets(self.snapshot)
        self.assets = connect_references(_assets(self.snapshot, set(self.targets)), self.targets)
        assign_groups(self.assets)
        self.references = [ref for target in self.targets.values() for ref in target["references"]]
        self.reference_groups = {self.assets[ref["assetId"]]["group"] for ref in self.references}
        self.policy = policy_contract(self.snapshot.get("policy") or {})
        self.engine, self.b36_cache = engine, b36_cache
        self.s36_cache, self.encoder_factory, self.encoder = s36_cache, encoder_factory, None
        # A reference is positive for its target whether or not it is selected;
        # the seed's manual region, when present, is the only crop projection.
        self.seeds = {}
        for target_id, target in self.targets.items():
            for reference in target["references"]:
                if reference["role"] == "seed":
                    self.seeds.setdefault(reference["assetId"], {})[target_id] = reference["region"]
        # A group is one person: it may only ever occupy one partition.
        self.split = grouped_split(
            [{"group": asset["group"], "labels": asset["labels"]} for asset in self.assets.values()],
            self.reference_groups)
        self.refresh_exposure()
        self.loaded = set()
        self.model = None
        self.gates = {}
        self.resident = {}
        self.identity = fingerprint(self._metadata())

    def refresh_exposure(self):
        """Exposures are every member of every training or calibration group,
        including unlabelled near-duplicates, plus every reference group.

        Test groups are held out for offline audit and never exposed here.
        """
        self.exposure_hashes = {asset["hash"] for asset in self.assets.values()
                                if self.split[asset["group"]] in ("train", "calibration")}
        self.exposure_pdq = {asset["hash"]: asset["pdq"] for asset in self.assets.values()
                             if asset["hash"] in self.exposure_hashes}
        return self.exposure_hashes

    def _metadata(self):
        return {"version": VERSION, "runtime": self.snapshot["runtime"],
                "targets": sorted(self.targets), "policy": self.policy,
                "references": sorted(self.references_key()),
                "snapshot": self.snapshot_id, "snapshot_fingerprint": self.snapshot_fingerprint(),
                "split": self.split, "exposures": sorted(self.exposure_hashes),
                "sources": _source_identity(), "s36": feature_identity()}

    def references_key(self):
        return ((target_id, reference["assetId"], reference["hash"], reference["role"])
                for target_id, target in self.targets.items() for reference in target["references"])

    def snapshot_fingerprint(self):
        """Fingerprint of the snapshot minus absolute temporary extraction paths."""
        stripped = {
            "targets": sorted((
                {"id": target["id"], "references": sorted((
                    {"assetId": ref["assetId"], "hash": ref["hash"], "role": ref["role"],
                     "region": ref["region"]} for ref in target["references"]),
                    key=lambda ref: ref["assetId"])} for target in self.targets.values()),
                key=lambda target: target["id"]),
            "assets": sorted((
                {"id": asset["assetId"], "hash": asset["hash"], "group": asset["group"],
                 "pdq": asset["pdq"], "quality": asset["quality"], "labels": asset["labels"],
                 "labelSequences": asset["labelSequences"]} for asset in self.assets.values()),
                key=lambda asset: asset["id"]),
        }
        return fingerprint(stripped)

    def model_id(self):
        """Identity of the fitted model, including weights, thresholds and gates."""
        if self.model is None:
            raise ValueError("Model is not fitted")
        return fingerprint({**self._metadata(), "heads": self.model["heads"], "gates": self.gates})

    # --- one source per request -------------------------------------------------

    def pending(self):
        return sorted((asset for asset in self.assets.values() if asset["assetId"] not in self.loaded),
                      key=lambda asset: asset["assetId"])

    def ready_assets(self):
        return [asset for asset in self.assets.values()
                if asset.get("feature") is not None and asset["quality"] >= MINIMUM_QUALITY]

    def load(self, asset):
        """Extract one source: resident B36 geometry first, then S36 on those boxes."""
        b36 = self.b36_cache.extract(Path(asset["path"]), asset["hash"])
        if b36.content_hash != asset["hash"]:
            raise ValueError("B36 extraction does not match the snapshot hash")
        asset["b36"] = b36
        asset["boxes"] = [tuple(box) for box in b36.boxes]
        asset["fallback"] = bool(b36.fallback)
        if not b36.fallback and asset["quality"] >= MINIMUM_QUALITY:
            asset["feature"] = self._s36(asset)
        self.loaded.add(asset["assetId"])

    def _s36(self, asset):
        boxes = list(asset["boxes"])
        cached = self.s36_cache.read(asset["hash"], boxes)
        if cached is not None:
            return cached
        if self.encoder is None:
            self.encoder = self.encoder_factory()
        feature = self.encoder.extract(asset["path"], asset["hash"], boxes)
        if (feature.content_hash != asset["hash"] or feature.fallback
                or [tuple(box) for box in feature.boxes] != boxes):
            raise ValueError("S36 extraction did not match the resident native regions")
        self.s36_cache.write(feature)
        return feature

    # --- labels, bags and calibration ------------------------------------------

    def resolved_labels(self, target_id, asset):
        """Seeds are positive even unselected. Unknown stays unknown."""
        label = asset["labels"].get(target_id)
        if type(label) is bool:
            return label
        if target_id in self.seeds.get(asset["assetId"], {}):
            return True
        return None

    def group_labels(self, target_id, members):
        """A group is labelled only when its known members agree.

        Unknown members are ignored, never treated as a contradiction. Two
        different *known* boolean labels inside one group mean the annotation is
        untrustworthy, so the whole group is withheld.
        """
        labels = {self.resolved_labels(target_id, member) for member in members}
        known = labels - {None}
        if len(known) > 1:
            return None
        return known.pop() if known else None

    def bags(self, target_id):
        """(vectors, label, group) per duplicate group; conflicting groups withheld."""
        groups = {}
        for asset in self.assets.values():
            groups.setdefault(asset["group"], []).append(asset)
        bags = []
        for group in sorted(groups):
            members = groups[group]
            label = self.group_labels(target_id, members)
            if label is None:
                continue
            # Use a labelled witness, preferring the user's selected seed.
            witnesses = [member for member in members if member.get("feature") is not None
                         and self.resolved_labels(target_id, member) is label]
            if not witnesses:
                continue
            witnesses.sort(key=lambda member: (target_id not in self.seeds.get(member["assetId"], {}), member["assetId"]))
            vectors = (self._project(target_id, witnesses[0]) if label
                       else witnesses[0]["feature"].vectors)
            if vectors is None:
                continue
            bags.append((vectors, label, group))
        return bags

    def _project(self, target_id, asset):
        """Only a seed's manual region projects; a stale region supplies no bag."""
        region = self.seeds.get(asset["assetId"], {}).get(target_id)
        if region is None:
            return asset["feature"].vectors
        try:
            projected, status, _ = project_reference(asset["feature"], region)
        except ValueError:
            return None
        return None if status == "stale_region" else projected.vectors

    def reference_views(self):
        """Resolve one person per reference image, using only resident B36."""
        views = {}
        for target_id, target in self.targets.items():
            features = [self.assets[ref["assetId"]]["b36"] for ref in target["references"]]
            selections = [ref["region"] for ref in target["references"]]
            views[target_id] = (features, selections,
                                resolve_references(self.engine, features, selections))
        return views

    def bundle(self, asset, views):
        """Build current B36 evidence for every target under the resident regions.

        The result is normalized to JSON-native types, exactly as the frozen
        experiment did, so the replay and the wire share one representation.
        """
        raw = {target_id: compare_bound(self.engine, asset["b36"], features, selections, projected)
               for target_id, (features, selections, projected) in views.items()}
        return json.loads(json.dumps(raw, allow_nan=False))

    def split_bags(self, target_id):
        """Train and calibration bags from separate partitions only.

        Test groups never provide training or calibration evidence.
        """
        trains, calibrations = [], []
        for bag, label, group in self.bags(target_id):
            partition = self.split[group]
            if partition == "train":
                trains.append((bag, label))
            elif partition == "calibration":
                calibrations.append((bag, label))
            # "test" groups never feed training or calibration.
        return trains, calibrations

    def fit(self):
        if self.model is not None:
            return
        heads = {}
        for target_id in sorted(self.targets):
            trains, calibrations = self.split_bags(target_id)
            heads[target_id] = calibrate_recall(_fit(trains), [bag for bag, _ in calibrations],
                                                [label for _, label in calibrations])
        self.gates = {
            target: {"enabled": head["state"] == "ready_shadow",
                     "positive": head.get("calibration", {}).get("positive", 0),
                     "negative": head.get("calibration", {}).get("negative", 0),
                     "recovered": head.get("calibration", {}).get("recovered", 0),
                     "false_positive": head.get("calibration", {}).get("false_positive", 0),
                     "threshold": head.get("threshold")}
            for target, head in heads.items()
        }
        self.model = {"heads": heads, "enabled": sorted(tid for tid, gate in self.gates.items()
                                                        if gate["enabled"])}


    # --- queries ----------------------------------------------------------------

    def query(self, request):
        """Validate a resident query and return the data needed to decide it."""
        asset_id, content_hash, path = request["assetId"], request["hash"], request["path"]
        if self.model is None:
            raise ValueError("Augmentation model is not ready")
        identity = request.get("queryIdentity") or {}
        pdq_value, quality = identity.get("pdq"), identity.get("quality")
        if (not isinstance(pdq_value, str) or len(pdq_value) != PDQ_HEX
                or any(c not in "0123456789abcdef" for c in pdq_value)
                or type(quality) is not int or quality < MINIMUM_QUALITY):
            return {"state": "skipped", "reason": "invalid_query_identity"}
        resident = self.resident.get(str(asset_id))
        if resident is None or resident[0] != content_hash:
            # The resident B36 query is the sole source of crop geometry.
            return {"state": "skipped", "reason": "not_resident_query"}
        boxes, fallback = list(resident[1]), bool(resident[2])
        if fallback:
            return {"state": "skipped", "reason": "whole_fallback"}
        if content_hash in self.exposure_hashes or any(
                halves_hamming(pdq_value, exposed) <= DUPLICATE_HAMMING
                for exposed in self.exposure_pdq.values()):
            return {"state": "skipped", "reason": "exposure"}
        bundle = self._validated_bundle(request.get("bundle") or {}, content_hash, boxes, fallback)
        if bundle is None:
            return {"state": "skipped", "reason": "invalid_bundle"}
        accepted = set(request.get("nativeAccepted") or [])
        if not any(gate["enabled"] and target not in accepted
                   and self.model["heads"][target]["state"] == "ready_shadow"
                   for target, gate in self.gates.items()):
            return {"state": "skipped", "reason": "nothing_to_augment"}
        feature = self._s36({"assetId": asset_id, "hash": content_hash, "path": path,
                             "boxes": boxes, "quality": quality})
        return {"state": "ready", "feature": feature, "boxes": boxes, "bundle": bundle}

    def _validated_bundle(self, bundle, content_hash, boxes, fallback):
        """The bundle must cover every target and echo the resident query exactly."""
        if set(bundle) != set(self.targets):
            return None
        for target_id, target in self.targets.items():
            evidence = bundle[target_id]
            if (not isinstance(evidence, dict) or evidence.get("contentHash") != content_hash
                    or [list(box) for box in evidence.get("queryBoxes") or []]
                    != [list(box) for box in boxes]
                    or bool(evidence.get("wholeFallback")) != fallback
                    or evidence.get("referenceHashes") != [ref["hash"] for ref in target["references"]]):
                return None
            try:
                validate_evidence(evidence, self.policy)
            except ValueError:
                return None
        return bundle


class Model:
    """Resident owner: one prepared snapshot, one fitted model, one encoder."""

    def __init__(self, models, augmentation_model, cache_root, engine, b36_cache,
                 encoder_factory=None):
        self.models = Path(models)
        self.augmentation_model = augmentation_model
        self.cache_root, self.engine, self.b36_cache = cache_root, engine, b36_cache
        self.encoder_factory = encoder_factory or self._default_encoder
        self.session = None
        self.encoder = None

    def _default_encoder(self):
        from character_encoder import SmallEncoder
        return SmallEncoder(self.augmentation_model, self.models / "character-detector.onnx")

    def encoder_for(self):
        if self.encoder is None:
            self.encoder = self.encoder_factory()
        return self.encoder

    def handle(self, request, resident=None):
        kind = request["type"]
        if kind == "augmentation_prepare":
            return self._prepare(request)
        if kind == "augmentation_step":
            session = self._require(request)
            pending = session.pending()
            if not pending:
                session.fit()
                return {"type": "augmentation_prepared", "snapshotId": session.snapshot_id,
                        "state": "ready", "modelId": session.model_id()}
            session.load(pending[0])  # exactly one source per request
            if session.pending():
                return {"type": "augmentation_prepared", "snapshotId": session.snapshot_id,
                        "state": "building"}
            session.fit()
            return {"type": "augmentation_prepared", "snapshotId": session.snapshot_id,
                    "state": "ready", "modelId": session.model_id()}
        if kind == "augment_query":
            session = self._require(request)
            if resident is not None:
                session.resident = resident
            outcome = session.query(request)
            if outcome["state"] != "ready":
                return {"type": "augmentation_result", "snapshotId": session.snapshot_id,
                        "modelId": session.model_id(), "assetId": request["assetId"],
                        "contentHash": request["hash"], "queryBoxes": [],
                        "headDecision": None, "state": "skipped", "reason": outcome["reason"],
                        "gates": self._gates(session), "policyId": RECALL_POLICY}
            decision = decide(session.model["heads"], outcome["feature"].vectors,
                              sorted(session.targets), False)
            return {"type": "augmentation_result", "snapshotId": session.snapshot_id,
                    "modelId": session.model_id(), "assetId": request["assetId"],
                    "contentHash": request["hash"], "queryBoxes": outcome["boxes"],
                    "headDecision": decision, "state": "ready", "gates": self._gates(session),
                    "policyId": RECALL_POLICY}
        raise ValueError("Unsupported augmentation message")

    def _prepare(self, request):
        candidate = Session(request, self.engine, self.b36_cache,
                            S36FeatureCache(self.cache_root), self.encoder_for)
        resident = self.session
        if (resident is not None and resident.snapshot_id == candidate.snapshot_id
                and resident.identity == candidate.identity):
            # Keep both completed models and bounded, in-progress preparation.
            return {"type": "augmentation_prepared", "snapshotId": resident.snapshot_id,
                    "state": "ready" if resident.model is not None else "building",
                    "modelId": resident.model_id() if resident.model is not None else None}
        self.session = candidate
        return {"type": "augmentation_prepared", "snapshotId": candidate.snapshot_id,
                "state": "building"}

    @staticmethod
    def _gates(session):
        return {tid: dict(gate) for tid, gate in session.gates.items()}

    def _require(self, request):
        if self.session is None or self.session.snapshot_id != str(request.get("snapshotId", "")):
            raise ValueError("Augmentation snapshot was not prepared")
        return self.session


def _fit(trains):
    if not trains:
        return {"state": "insufficient_training", "positive": 0, "negative": 0}
    return fit_head([bag for bag, _ in trains], [label for _, label in trains])


def _snapshot(request):
    """The inline snapshot body, or the private snapshot file the owner wrote."""
    if isinstance(request.get("snapshot"), dict):
        return request["snapshot"]
    path = request.get("snapshotPath")
    if not isinstance(path, (str, Path)):
        raise ValueError("Snapshot body or path required")
    path = Path(path)
    if path.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Snapshot file exceeds budget")
    return json.loads(path.read_text(encoding="utf-8"))


def _targets(snapshot):
    if snapshot.get("version") != VERSION or not isinstance(snapshot.get("runtime"), str):
        raise ValueError("Unsupported snapshot identity")
    items = snapshot.get("targets")
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_TARGETS:
        raise ValueError("One to eight targets required")
    targets = {}
    for item in items:
        if (not isinstance(item, dict) or not isinstance(item.get("id"), str)
                or not item["id"] or item["id"] in targets):
            raise ValueError("Distinct target ids required")
        references = item.get("references")
        if not isinstance(references, list) or not references:
            raise ValueError("Every target needs references")
        targets[item["id"]] = {"id": item["id"], "references": references}
    return targets


def _assets(snapshot, target_ids):
    items = snapshot.get("assets")
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_ASSETS:
        raise ValueError("One to 256 assets required")
    assets = {}
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or item["id"] in assets:
            raise ValueError("Distinct asset ids required")
        labels, sequences = item.get("labels"), item.get("labelSequences")
        hash_value, pdq_value, quality = item.get("hash"), item.get("pdq"), item.get("quality")
        # A null label is simply unknown; the key is dropped, never coerced.
        if isinstance(labels, dict):
            labels = {tid: flag for tid, flag in labels.items() if flag is not None}
        if (not _is_hash(hash_value) or not isinstance(item.get("path"), str) or not item["path"]
                or not _is_pdq(pdq_value) or type(quality) is not int or not MINIMUM_QUALITY <= quality <= 100
                or not isinstance(labels, dict) or len(labels) > MAX_LABEL_TARGETS
                or not isinstance(sequences, dict) or set(sequences) != set(labels)
                or not all(type(flag) is bool for flag in labels.values())
                or not all(type(value) is int and value >= 0 for value in sequences.values())):
            raise ValueError("Invalid snapshot asset")
        assets[item["id"]] = {"assetId": item["id"], "hash": hash_value, "path": item["path"],
                              "pdq": pdq_value, "quality": quality,
                              "labels": {tid: bool(flag) for tid, flag in labels.items()
                                         if tid in target_ids},
                              "labelSequences": dict(sequences)}
    return assets


def connect_references(assets, targets):
    """Fail closed when a reference names an asset the snapshot did not supply."""
    for target in targets.values():
        for reference in target["references"]:
            region = reference.get("region") if isinstance(reference, dict) else None
            if (not isinstance(reference, dict) or reference.get("assetId") not in assets
                    or reference.get("role") not in ("seed", "support")
                    or reference.get("hash") != assets[reference["assetId"]]["hash"]
                    or (region is not None and not isinstance(region, dict))):
                raise ValueError("References must name snapshot assets")
    return assets


def assign_groups(assets):
    """Near-duplicate groups: exact hash or close whole/cropped PDQ variants."""
    parent = {asset_id: asset_id for asset_id in assets}

    def find(node):
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def union(left, right):
        left, right = find(left), find(right)
        if left != right:
            parent[max(left, right)] = min(left, right)

    by_hash, by_pdq = {}, {}
    for asset_id, asset in assets.items():
        by_hash.setdefault(asset["hash"], []).append(asset_id)
        by_pdq.setdefault(asset["pdq"], []).append(asset_id)
    for members in list(by_hash.values()) + list(by_pdq.values()):
        for member in members[1:]:
            union(members[0], member)
    values = list(by_pdq)
    for left_index, left in enumerate(values):
        for right in values[left_index + 1:]:
            if halves_hamming(left, right) <= DUPLICATE_HAMMING:
                union(by_pdq[left][0], by_pdq[right][0])
    members = {}
    for asset_id in assets:
        members.setdefault(find(asset_id), []).append(asset_id)
    for grouped in members.values():
        key = min(assets[asset_id]["hash"] for asset_id in grouped)
        for asset_id in grouped:
            assets[asset_id]["group"] = key
    return assets


def halves_hamming(left, right):
    """Minimum Hamming distance over every pairing of the two 32-byte PDQ halves."""
    left_halves = [int(left[:HALF_HEX], 16), int(left[HALF_HEX:], 16)]
    right_halves = [int(right[:HALF_HEX], 16), int(right[HALF_HEX:], 16)]
    return min((a ^ b).bit_count() for a in left_halves for b in right_halves)


def _is_hash(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def _is_pdq(value):
    return isinstance(value, str) and len(value) == PDQ_HEX and all(c in "0123456789abcdef" for c in value)


def augmenter(models, augmentation_model, cache_root, engine, b36_cache, encoder_factory=None):
    """Build the resident augmentation owner, or report why it is unavailable."""
    if not augmentation_available(models, augmentation_model):
        return None, "model_unavailable"
    try:
        return Model(models, augmentation_model, cache_root, engine, b36_cache, encoder_factory), None
    except Exception as error:  # native stays alive; the caller reports the reason
        return None, str(error)


def same_crop(left, right):
    return same_person(list(left), list(right))
