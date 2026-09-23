"""Chronological, CPU-only replay of cached character crop features (no inference)."""
from __future__ import annotations

# Set before importing numpy, including when the shell exports a larger value.
import os
for _variable in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[_variable] = "1"

import argparse
import ast
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import heapq
import io
import json
from pathlib import Path
import pickle
import re
from types import SimpleNamespace
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import numpy as np

from s36_scoring import distance, knn, score_crops as shared_score_crops, unit as normalized_vectors
from holdout_rules import current_policy, is_hash
from replay_dataset import HERE, canonical, load_dataset, outside_library, save_exclusive, source_hashes

SCORERS = ("rule6", "knn3", "contrast", "prior")
RATES = (0.01, 0.02, 0.05)
NS = 1_000_000_000
BASELINE = json.loads((HERE / "baseline.json").read_text())
FINGERPRINT = hashlib.sha256(json.dumps(BASELINE, sort_keys=True).encode()).hexdigest()


def time_ns(value):
    """Keep Rust's nanosecond timestamps; equal-time labels never feed each other."""
    if not isinstance(value, str):
        raise ValueError("Missing timestamp")
    match = re.fullmatch(r"(.+T\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)", value)
    if not match:
        raise ValueError(f"Expected ISO timestamp with timezone: {value!r}")
    whole = datetime.fromisoformat(match[1] + match[3].replace("Z", "+00:00"))
    return int(whole.timestamp()) * NS + int((match[2] or "").ljust(9, "0"))


def available_at(when, lag):
    if lag == 0:
        return when + 1
    day = datetime.fromtimestamp(when // NS, timezone.utc).replace(hour=0, minute=0, second=0)
    return int((day + timedelta(days=lag)).timestamp()) * NS


def day_name(when):
    return datetime.fromtimestamp(when // NS, timezone.utc).date().isoformat()


def unit(vectors):
    vectors = np.asarray(vectors, dtype=np.float32)
    if vectors.ndim != 2 or vectors.shape[1] != 768 or not 1 <= len(vectors) <= 8:
        raise ValueError("Expected 1..8 crop vectors of dimension 768")
    return normalized_vectors(vectors)

@dataclass
class Features:
    content_hash: str
    boxes: list
    vectors: np.ndarray
    fallback: bool


class CosineMetric:
    def run(self, outputs, inputs):
        vectors = inputs["input"]
        return [distance(vectors, vectors)]


def reference_resolver():
    """Execute the existing pure resolver unchanged, without importing ONNX/Pillow.

    reference_regions imports runtime for only Features/BASELINE/FINGERPRINT in
    these four functions. AST selection supplies those values locally instead of
    importing the inference stack or mutating sys.modules. Source hashes are in
    every report; missing/changed dependencies fail rather than use a copy.
    """
    source = HERE / "reference_regions.py"
    names = {"region_binding", "project_reference", "views", "resolve_references"}
    tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    if {n.name for n in nodes} != names:
        raise ValueError("Reference resolver interface changed")
    constants = [n for n in tree.body if isinstance(n, ast.Assign)
                 and all(isinstance(t, ast.Name) for t in n.targets)]
    namespace = dict(np=np, Features=Features, BASELINE=BASELINE, FINGERPRINT=FINGERPRINT)
    exec(compile(ast.Module(body=constants + nodes, type_ignores=[]), str(source), "exec"), namespace)
    return namespace["resolve_references"], namespace["VALID_STATUSES"]


RESOLVE, VALID_STATUSES = reference_resolver()


class NumpyUnpickler(pickle.Unpickler):
    """Only the ndarray reconstruction globals used by the optional legacy file."""
    def find_class(self, module, name):
        if (module, name) in {("numpy", "ndarray"), ("numpy", "dtype"),
                              ("numpy.core.multiarray", "_reconstruct"),
                              ("numpy._core.multiarray", "_reconstruct"),
                              ("numpy.core.numeric", "_frombuffer"),
                              ("numpy._core.numeric", "_frombuffer")}:
            return super().find_class(module, name)
        raise ValueError(f"Unsupported pickle global: {module}.{name}")


def read_features(paths, space, extra=None, box_paths=()):
    """Explicit namespaces, first listed wins. Never construct a cache writer."""
    features, manifest, counts = {}, [], Counter()
    for directory in paths:
        directory = Path(directory).resolve()
        if not directory.is_dir() or not is_hash(directory.name):
            raise ValueError("--features must name an existing 64-hex cache namespace")
        for path in sorted(directory.glob("*.npz")):
            raw = path.read_bytes()
            manifest.append([str(path), hashlib.sha256(raw).hexdigest()])
            with np.load(io.BytesIO(raw), allow_pickle=False) as saved:
                h = str(saved["content_hash"].item())
                if h != path.stem or not is_hash(h):
                    raise ValueError(f"Cache hash mismatch: {path}")
                if space == "b36" and "feature_id" in saved:
                    raise ValueError("S36 augmentation cache supplied as B36 features")
                if space == "s36" and ("feature_id" not in saved or
                                        str(saved["feature_id"].item()) != directory.name):
                    raise ValueError(f"S36 feature namespace mismatch: {path}")
                vectors = unit(saved["vectors"])
                boxes = np.asarray(saved["boxes"])
                fallback = bool(saved["fallback"].item())
                if boxes.shape != (0 if fallback else len(vectors), 4) or not np.issubdtype(boxes.dtype, np.integer):
                    raise ValueError(f"Invalid crop boxes: {path}")
                if h in features:
                    counts["duplicate_hash_first_namespace_wins"] += 1
                    continue
                features[h] = Features(h, [tuple(int(x) for x in b) for b in boxes], vectors, fallback)
                counts[str(directory)] += 1
    if extra:
        if space != "s36" or not box_paths:
            raise ValueError("Extra S36 vectors need --space s36 and --box-features B36 namespaces")
        boxes, box_info = read_features(box_paths, "b36")
        raw = Path(extra).read_bytes()
        supplied = NumpyUnpickler(io.BytesIO(raw)).load()
        if not isinstance(supplied, dict):
            raise ValueError("Extra S36 source must be a hash -> ndarray/None dictionary")
        manifest.append([str(Path(extra).resolve()), hashlib.sha256(raw).hexdigest()])
        for h, values in supplied.items():
            if not is_hash(h):
                raise ValueError("Invalid extra S36 content hash")
            if h in features or values is None:
                continue
            if h not in boxes:
                counts["extra_missing_B36_boxes"] += 1
                continue
            vectors = unit(values)
            base = boxes[h]
            if len(vectors) != len(base.vectors):
                raise ValueError("Extra S36/B36 crop count mismatch")
            features[h] = Features(h, base.boxes, vectors, base.fallback)
            counts["extra_loaded"] += 1
        manifest.append(["B36 box source manifest", box_info["sha256"]])
    return features, {"sha256": hashlib.sha256(canonical(manifest)).hexdigest(),
                      "files": manifest, "counts": dict(counts),
                      "extra_provenance": "Legacy extra has no encoder identity or boxes; user-supplied S36 assertion and B36 crop order assumed" if extra else None}


def post_key(url):
    if not url:
        return None
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower().removeprefix("www.")
    path = parsed.path.rstrip("/")
    if host in ("x.com", "twitter.com", "mobile.twitter.com"):
        match = re.search(r"/status/(\d+)", path)
        return "x/status/" + match[1] if match else None
    if not host or path in ("", "/home"):
        return None
    # Keep identity-bearing query parameters (e.g. board/view?id=...), remove
    # tracking only. Dropping all queries glues unrelated board posts together.
    query = sorted((k, v) for k, v in parse_qsl(parsed.query)
                   if not k.lower().startswith("utm_") and k not in ("s", "t", "fbclid"))
    if path.endswith(("/board/view", "/view")) and not query:
        return None
    return urlunsplit(("https", host, re.sub(r"/photo/\d+$", "", path), urlencode(query), ""))


def duplicate_groups(images, hashes=(), *, cancelled=None):
    """Transitive PDQ<=31 and post union, including uncached bridge images."""
    parent = {h: h for h in sorted(set(images) | set(hashes))}

    def find(h):
        while parent[h] != h:
            parent[h] = parent[parent[h]]
            h = parent[h]
        return h

    def union(a, b):
        a, b = find(a), find(b)
        if a != b:
            parent[max(a, b)] = min(a, b)

    posts, fingerprints = {}, []
    missing = 0
    for h, image in sorted(images.items()):
        if not image["pdq"]:
            missing += 1
        for pdq in image["pdq"]:
            if not re.fullmatch(r"[0-9a-f]{64}", pdq):
                raise ValueError("Invalid whole-image PDQ")
            fingerprints.append((h, int(pdq, 16)))
        for url in image["source_urls"]:
            key = post_key(url)
            if key:
                if key in posts:
                    union(h, posts[key])
                else:
                    posts[key] = h
    # Python int.bit_count avoids a quadratic matrix allocation. Bound the audit.
    if len(fingerprints) > 20000:
        raise ValueError("PDQ audit exceeds 20,000 fingerprints; export a narrower dataset")
    for i, (h, a) in enumerate(fingerprints):
        if cancelled is not None and cancelled():
            raise ValueError("Shadow scoring preempted")
        for other, b in fingerprints[i + 1:]:
            if (a ^ b).bit_count() <= 31:
                union(h, other)
    groups = {h: find(h) for h in parent}
    return groups, {"hashes": len(parent), "groups": len(set(groups.values())),
                    "missing_pdq": missing + len(set(parent) - set(images)),
                    "hamming_max": 31, "transitive_union_with_posts": True}


def prepare_labels(data):
    targets = {t["id"] for t in data["targets"]}
    assets = {a["id"]: a for a in data["assets"]}
    latest, automatic, events, excluded = {}, {}, [], Counter()
    for row in sorted(data["decisions"], key=lambda r: r["sequence"]):
        key = row["target_id"], row["asset_hash"]
        if row["origin"] == "automatic":
            automatic[key] = row
        if row["origin"] != "manual":
            continue
        latest[key] = row  # A manual clear invalidates manual truth, too.
        if row["target_id"] not in targets or not is_hash(row["asset_hash"]):
            excluded["invalid_manual_identity"] += 1
            continue
        event = dict(row)
        event["time"] = time_ns(row["created_at"])
        events.append(event)
    labels = []
    for key, row in latest.items():
        asset = assets.get(row["source_asset_id"])
        if row["decision"] not in ("accepted", "rejected"):
            excluded["latest_manual_cleared"] += 1
        elif row["target_id"] not in targets or not asset or asset["content_hash"] != row["asset_hash"] or asset["status"] != "normal" or asset["media_kind"] != "image":
            excluded["unavailable_or_changed_asset"] += 1
        else:
            labels.append({**row, "time": time_ns(row["created_at"]),
                           "label": int(row["decision"] == "accepted")})
    unreviewed = [r for k, r in automatic.items() if k not in latest]
    return sorted(labels, key=lambda r: (r["time"], r["sequence"])), sorted(
        events, key=lambda r: (r["time"], r["sequence"])), unreviewed, dict(excluded)


def stack(entries):
    return np.stack(list(entries)) if len(entries) else np.empty((0, 768), dtype=np.float32)


def score_crops(vectors, positive, negative, competitors, prior, policy):
    return shared_score_crops(vectors, positive, negative, competitors, prior, policy,
                             normalized=True)


class Replay:
    def __init__(self, data, features, groups, lag=1, *, witness="gallery", gallery_cap=None, policy=None):
        self.data, self.features, self.groups, self.lag = data, features, groups, lag
        if witness not in ("gallery", "references") or (gallery_cap is not None and gallery_cap < 0):
            raise ValueError("Invalid witness mode or gallery cap")
        self.witness_mode, self.gallery_cap = witness, gallery_cap
        self.targets = {t["id"]: t for t in data["targets"]}
        self.references = defaultdict(list)
        for r in data["references"]:
            self.references[r["target_id"]].append(r)
        self.regions = {(r["target_id"], r["asset_hash"]): r for r in data["regions"]}
        self.state = defaultdict(dict)
        self.pending, self.serial = [], 0
        self.resolved_cache = {}
        self.policy = current_policy() if policy is None else policy
        if self.policy["automatic_support"] != 6:
            raise ValueError("Native support changed; rule6 needs review")
        self.audit = Counter()

    def same_group(self, a, b):
        return self.groups.get(a, a) == self.groups.get(b, b)

    def release(self, now):
        while self.pending and self.pending[0][0] <= now:
            _, _, event, vector = heapq.heappop(self.pending)
            self.state[event["target_id"]][event["asset_hash"]] = (event, vector)

    def gallery(self, target, query_hash, now, *, references_only=False):
        created = self.targets[target].get("created_at")
        if created and time_ns(created) >= now:
            return {}, {}, [0, 0]
        refs, selections, key = [], [], []
        for ref in self.references[target]:
            h = ref["asset_hash"]
            if h not in self.features or self.same_group(h, query_hash):
                continue
            if ref.get("created_at") and time_ns(ref["created_at"]) >= now:
                continue
            if ref["kind"] == "learned" and not ref.get("created_at"):
                continue  # Unknown learned availability cannot establish a vote.
            old = self.state[target].get(h)
            if old and old[0]["decision"] in ("rejected", "cleared"):
                continue
            if h in key:
                continue
            region = self.regions.get((target, h))
            selection = None
            if region and (not region.get("created_at") or time_ns(region["created_at"]) < now):
                selection = {"contentHash": region["asset_hash"],
                             "baselineFingerprint": region["baseline_fingerprint"],
                             "bounds": region["bounds"]}
            refs.append(self.features[h])
            selections.append(selection)
            key.append(h)
        cache_key = target, tuple(key), canonical(selections)
        if cache_key not in self.resolved_cache:
            resolved = RESOLVE(SimpleNamespace(metric=CosineMetric(), max_metric_vectors=0), refs, selections) if refs else []
            self.resolved_cache[cache_key] = {view.content_hash: view.vectors[0] for view, status, _ in resolved if status in VALID_STATUSES}
        positive = dict(self.resolved_cache[cache_key])
        negative = {}
        counts = [0, 0]
        if references_only:
            return positive, negative, counts
        # Cap latest manual states separately for accepted and rejected images.
        # Clears/revisions were applied by release(); seeds remain independent.
        used = Counter()
        states = self.state[target].items()
        if self.gallery_cap is not None:
            states = sorted(states, key=lambda item: (item[1][0]["time"], item[1][0]["sequence"]), reverse=True)
        for h, (event, vector) in states:
            if self.same_group(h, query_hash):
                continue
            decision = event["decision"]
            if decision in ("accepted", "rejected"):
                counts[int(decision == "accepted")] += 1
                if self.gallery_cap is not None and used[decision] >= self.gallery_cap:
                    continue
                used[decision] += 1
                if vector is not None:
                    (positive if decision == "accepted" else negative).setdefault(h, vector)
        return positive, negative, counts

    def query(self, target, h, now):
        positives, negatives, counts = self.gallery(target, h, now)
        prior = counts[1] / sum(counts) if sum(counts) else 0.5
        feature = self.features.get(h)
        info = {"positive_votes": len(positives), "negative_votes": len(negatives),
                "prior_counts": counts, "recommended": False}
        if feature is None or feature.fallback:
            return {s: -prior if s == "prior" else None for s in SCORERS}, info
        competitor = {}
        series = self.targets[target]["series_id"]
        for other, meta in self.targets.items():
            if other != target and series is not None and meta["series_id"] == series and meta["enabled"]:
                other_positive, _, _ = self.gallery(other, h, now)
                # One vote per (competitor target, image), as in the review's
                # pooled same-series gallery. Different targets may select
                # different people in the same image.
                competitor.update({(other, key): v for key, v in other_positive.items()})
        scores, info["recommended"] = score_crops(feature.vectors, stack(list(positives.values())),
            stack(list(negatives.values())), stack(list(competitor.values())), prior, self.policy)
        return scores, info

    def witness(self, event, now):
        h, target = event["asset_hash"], event["target_id"]
        feature = self.features.get(h)
        if event["decision"] == "cleared" or feature is None or feature.fallback:
            return None
        positive, _, _ = self.gallery(target, h, now, references_only=self.witness_mode == "references")
        pool = stack(list(positive.values()))
        if len(feature.vectors) > 1 and not len(pool):
            self.audit["multi_person_feedback_without_prior_witness_basis"] += 1
            return None
        scores = (distance(feature.vectors, pool).min(axis=1) if len(pool) and (self.witness_mode == "references" or event["decision"] == "rejected")
                  else knn(feature.vectors, pool))
        # No gallery rebuilding with future labels: fix the witness now.
        return feature.vectors[int(np.argmin(scores))]

    def run(self, labels, events, *, cancelled=None):
        truth = {r["sequence"]: r for r in labels}
        result = []
        index = 0
        while index < len(events):
            if cancelled is not None and cancelled():
                raise ValueError("Shadow scoring preempted")
            now = events[index]["time"]
            self.release(now)
            end = index
            while end < len(events) and events[end]["time"] == now:
                end += 1
            batch = events[index:end]
            for event in batch:
                if event["sequence"] in truth:
                    row = truth[event["sequence"]]
                    scores, info = self.query(row["target_id"], row["asset_hash"], now)
                    feature = self.features.get(row["asset_hash"])
                    result.append({**row, "scores": scores, **info,
                                   "feature_status": "missing" if feature is None else "fallback" if feature.fallback else "available"})
            for event in batch:
                vector = self.witness(event, now)
                heapq.heappush(self.pending, (available_at(now, self.lag), self.serial, event, vector))
                self.serial += 1
            index = end
        return result


def auc(rows, scorer):
    # Missing gallery scores are abstentions, ranked last (ties receive 1/2).
    positives = sorted(r["scores"][scorer] if r["scores"][scorer] is not None else float("inf") for r in rows if r["label"])
    negatives = np.sort([r["scores"][scorer] if r["scores"][scorer] is not None else float("inf") for r in rows if not r["label"]])
    if not positives or not len(negatives):
        return None
    left = np.searchsorted(negatives, positives, side="left")
    right = np.searchsorted(negatives, positives, side="right")
    return float(np.mean((len(negatives) - right + 0.5 * (right - left)) / len(negatives)))


def threshold(negative_scores, rate):
    if not negative_scores:
        return None  # Abstain until at least one earlier negative exists.
    ordered = sorted(float("inf") if s is None else s for s in negative_scores)
    value = ordered[int(np.floor(rate * len(ordered)))]
    # Scores are strictly less than the boundary; ties cannot overspend FP budget.
    return value if np.isfinite(value) else 2.0


def passes(score, boundary):
    return score is not None and boundary is not None and score < boundary


def metrics(rows, scorer, lag, rates=RATES):
    rows = sorted(rows, key=lambda r: (r["time"], r["sequence"]))
    p = sum(r["label"] for r in rows)
    n = len(rows) - p
    result = {"pairs": len(rows), "positives": p, "negatives": n, "auc": auc(rows, scorer),
              "abstentions": sum(r["scores"][scorer] is None for r in rows),
              "walk_forward": {}, "oracle": {}}
    for rate in rates:
        history, pending = [], []
        tp = fp = cold = 0
        last = None
        boundaries = []
        for row in rows:
            while pending and pending[0][0] <= row["time"]:
                _, _, score = heapq.heappop(pending)
                history.append(score)
            boundary = threshold(history, rate)
            if boundary is None:
                cold += 1
            if boundary != last:
                boundaries.append({"at": row["created_at"], "threshold": boundary,
                                   "earlier_negatives": len(history)})
                last = boundary
            if passes(row["scores"][scorer], boundary):
                tp += row["label"]
                fp += 1 - row["label"]
            if not row["label"]:
                heapq.heappush(pending, (available_at(row["time"], lag), row["sequence"], row["scores"][scorer]))
        result["walk_forward"][str(rate)] = {
            "recall": tp / p if p else None, "observed_fpr": fp / n if n else None,
            "tp": tp, "fp": fp, "cold_start_abstentions": cold,
            "final_threshold": threshold(history, rate), "threshold_changes": boundaries}
        boundary = threshold([r["scores"][scorer] for r in rows if not r["label"]], rate)
        tp = sum(r["label"] for r in rows if passes(r["scores"][scorer], boundary))
        fp = sum(1 - r["label"] for r in rows if passes(r["scores"][scorer], boundary))
        result["oracle"][str(rate)] = {"threshold": boundary, "recall": tp / p if p else None,
                                      "observed_fpr": fp / n if n else None}
    by_target = defaultdict(list)
    for row in rows:
        by_target[row["target_id"]].append(row)
    eligible = {t: rs for t, rs in by_target.items() if sum(r["label"] for r in rs) >= 5 and sum(1-r["label"] for r in rs) >= 5}
    result["per_target_auc"] = {t: {"auc": auc(rs, scorer), "positives": sum(r["label"] for r in rs),
                                     "negatives": sum(1-r["label"] for r in rs)} for t, rs in eligible.items()}
    result["macro_auc"] = float(np.mean([r["auc"] for r in result["per_target_auc"].values()])) if eligible else None
    result["macro_targets"] = len(eligible)
    return result


def count_windows(rows):
    counts = Counter((r["origin"], day_name(time_ns(r["created_at"])), r["decision"]) for r in rows)
    return [{"origin": o, "utc_day": d, "decision": label, "count": count}
            for (o, d, label), count in sorted(counts.items())]


def stream_estimate(replay, data, labels, report, scorers, rates=RATES):
    # The last decision time is the replay horizon. Do not release later feedback.
    now = report["horizon_ns"]
    truth = {(r["target_id"], r["asset_hash"]) for r in labels}
    references = {(r["target_id"], r["asset_hash"]) for r in data["references"]}
    scoped = defaultdict(set)
    for asset in data["assets"]:
        for series in asset["series_scope"]:
            if is_hash(asset["content_hash"]):
                scoped[series].add(asset["content_hash"])
    targets = {}
    for target, meta in replay.targets.items():
        if not meta["enabled"] or meta.get("manual_only"):
            continue
        volume = {"name": meta["name"], "unlabeled_pairs": 0, "missing_features": 0,
                  "fallback": 0, "accepted_volume": {s: {str(r): 0 for r in rates} for s in scorers}}
        for h in sorted(scoped[meta["series_id"]]):
            if (target, h) in truth or (target, h) in references:
                continue
            volume["unlabeled_pairs"] += 1
            feature = replay.features.get(h)
            if feature is None:
                volume["missing_features"] += 1
            elif feature.fallback:
                volume["fallback"] += 1
            scores, _ = replay.query(target, h, now)
            for scorer in scorers:
                for rate in rates:
                    boundary = report["metrics"][scorer]["overall"]["walk_forward"][str(rate)]["final_threshold"]
                    volume["accepted_volume"][scorer][str(rate)] += int(passes(scores[scorer], boundary))
        targets[target] = volume
    return {"interpretation": "Unlabeled volume only, NOT precision or false-positive counts; includes unreviewed automatic pairs. Current series scope, references excluded, frozen final walk-forward thresholds; cached subset only for feature scorers.",
            "per_target": targets,
            "overall": {"unlabeled_pairs": sum(t["unlabeled_pairs"] for t in targets.values()),
                        "missing_features": sum(t["missing_features"] for t in targets.values()),
                        "accepted_volume": {s: {str(r): sum(t["accepted_volume"][s][str(r)] for t in targets.values()) for r in rates} for s in scorers}}}


def evaluate(envelope, features, *, lag=1, scorers=SCORERS, stream=False,
             witness="gallery", gallery_cap=None, rates=RATES):
    if not rates or any(not np.isfinite(rate) or not 0 <= rate < 1 for rate in rates):
        raise ValueError("Rates must be finite values in [0, 1)")
    data = envelope["dataset"]
    labels, events, unreviewed, excluded = prepare_labels(data)
    hashes = {r["asset_hash"] for r in data["references"] + data["decisions"]}
    groups, group_info = duplicate_groups(data["images"], hashes)
    replay = Replay(data, features, groups, lag, witness=witness, gallery_cap=gallery_cap)
    rows = replay.run(labels, events)
    eligible = [r for r in rows if r["feature_status"] == "available"]
    names = {t["id"]: t["name"] for t in data["targets"]}
    report = {"dataset_sha256": envelope["sha256"], "source_sha256": source_hashes(),
              "witness": witness, "gallery_cap": gallery_cap, "rates": list(rates),
              "feedback_lag_days": lag, "day_timezone": "UTC", "grouping": group_info,
              "horizon_ns": max((r["time"] for r in events), default=0),
              "policy": replay.policy, "targets": data["targets"], "excluded_labels": excluded,
              "coverage": {"labeled_pairs": len(rows), "feature_pairs": len(eligible),
                           "fraction": len(eligible) / len(rows) if rows else None,
                           "by_feature_status": dict(Counter(r["feature_status"] for r in rows)),
                           "by_label_and_feature_status": dict(Counter(f"{r['label']}:{r['feature_status']}" for r in rows))},
              "unreviewed_automatic": {"pairs": len(unreviewed), "counts": count_windows(unreviewed)},
              "counts_by_origin_time_window": count_windows(data["decisions"]),
              "labeled_counts_by_time_window": count_windows(labels),
              "audit": dict(replay.audit), "metrics": {}, "rows": rows,
              "limitations": data["limitations"] + [
                  "Selected historical labels, not prospective validation. Current untimestamped seeds/regions are an explicit initial-condition assumption.",
                  "Rule6 is the native sixth-distance/support component, not native geometry/competitor publication arbitration; S36 uses the same numeric thresholds for research only.",
                  "Witnesses are fixed at each historical manual event using only then-available, query-group-excluded positives (resolved references only in references mode). Multi-person feedback without a witness basis abstains.",
                  "Feature scorers skip missing/fallback queries; empty galleries abstain and rank last in AUC. Prior is unsmoothed positive rate (cold start 0.5), using earlier manual state including feature-missing pairs.",
                  "Contrast uses the union of enabled same-series competitor positive galleries; no rival/reject pool has distance 1.0. Same-crop contrast is minimized over query crops.",
                  "Walk-forward calibration uses frozen earlier prediction scores and the same feedback lag, not rescored training images. Measured FPR can exceed its calibration target under drift.",
                  "Oracle uses all evaluated labels to choose a threshold and is optimistic. Final walk-forward threshold is the one available at the last evaluated pair, not an oracle refit.",
              ]}
    for scorer in scorers:
        cohort = rows if scorer == "prior" else eligible
        report["metrics"][scorer] = {"overall": metrics(cohort, scorer, lag, rates),
            "anjo_excluded": metrics([r for r in cohort if names[r["target_id"]] != "안조"], scorer, lag, rates),
            "coverage": {"evaluated_pairs": len(cohort), "labeled_pairs": len(rows),
                         "fraction": len(cohort) / len(rows) if rows else None}}
        if scorer == "prior":
            report["metrics"][scorer]["feature_matched"] = metrics(eligible, scorer, lag, rates)
    if stream:
        report["stream"] = stream_estimate(replay, data, labels, report, scorers, rates)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    command = sub.add_parser("evaluate")
    command.add_argument("--dataset", type=Path, required=True)
    command.add_argument("--features", type=Path, action="append", required=True,
                         help="64-hex namespace; repeat in first-wins precedence order")
    command.add_argument("--box-features", type=Path, action="append", default=[])
    command.add_argument("--extra-s36", type=Path)
    command.add_argument("--space", choices=("b36", "s36"), required=True)
    command.add_argument("--scorers", nargs="+", choices=SCORERS, default=list(SCORERS))
    command.add_argument("--feedback-lag", type=int, default=1)
    command.add_argument("--witness", choices=("gallery", "references"), default="gallery")
    command.add_argument("--gallery-cap", type=int, help="Latest manual images per accepted/rejected pool; seeds uncapped")
    command.add_argument("--rates", type=float, nargs="+", default=list(RATES))
    command.add_argument("--stream", action="store_true")
    command.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.feedback_lag < 0:
            raise ValueError("Feedback lag must be nonnegative")
        envelope = load_dataset(args.dataset)
        outside_library(args.output, envelope["dataset"]["library_root"])
        if args.output.exists():
            raise FileExistsError(args.output)
        features, provenance = read_features(args.features, args.space, args.extra_s36, args.box_features)
        report = evaluate(envelope, features, lag=args.feedback_lag, scorers=args.scorers, stream=args.stream,
                          witness=args.witness, gallery_cap=args.gallery_cap, rates=args.rates)
        report.update(space=args.space, feature_sources=provenance)
        save_exclusive(report, args.output, envelope["dataset"]["library_root"])
        print(f"{args.space}: coverage {report['coverage']}; unreviewed automatic {report['unreviewed_automatic']['pairs']}")
        for scorer, results in report["metrics"].items():
            all_rows, without = results["overall"], results["anjo_excluded"]
            print(f"{scorer}: AUC={all_rows['auc']} / no-anjo={without['auc']}; macro={all_rows['macro_auc']}")
            for rate in args.rates:
                walk = all_rows["walk_forward"][str(rate)]
                print(f"  WF R@{rate:.1%}={walk['recall']} (observed FPR={walk['observed_fpr']}); oracle={all_rows['oracle'][str(rate)]['recall']}")
        print("Historical research only; see report limitations. No runtime acceptance claim.")
    except (OSError, ValueError, KeyError, pickle.UnpicklingError) as error:
        parser.exit(2, f"Evaluation failed: {error}\n")


if __name__ == "__main__":
    main()
