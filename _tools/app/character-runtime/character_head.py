"""Small, local multiple-instance heads. No model downloads or durable judgments."""
from __future__ import annotations

import hashlib
import json

import numpy as np

VERSION = 1
POLICY = {"epochs": 400, "learning_rate": 0.5, "l2": 0.01,
          "minimum_train_per_class": 2, "minimum_calibration_per_class": 2,
          "minimum_calibration_recovered": 2, "split_seed": "character-head-v1"}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     allow_nan=False).encode()).hexdigest()


def normalize(vectors):
    x = np.asarray(vectors, dtype=np.float64)
    if (x.ndim != 2 or not 1 <= len(x) <= 8 or not 1 <= x.shape[1] <= 4096
            or not np.isfinite(x).all()):
        raise ValueError("Invalid crop features")
    norms = np.linalg.norm(x, axis=1, keepdims=True)
    if (norms <= 1e-12).any():
        raise ValueError("Zero crop vector")
    return x / norms


def sigmoid(x):
    x = np.asarray(x, dtype=np.float64)
    return np.exp(-np.logaddexp(0, -x))


def fit_head(bags, labels):
    """One bag gets one vote; a positive bag never labels all people positive.

    The most positive instance is a latent witness, not a trusted annotation.
    For a negative bag the largest logit is the hardest negative; minimizing it
    penalizes any high-scoring crop. Recompute witnesses every step. Fixed L2
    regularization and iterations avoid an evaluation-driven hyperparameter loop.
    """
    x = [normalize(b) for b in bags]
    y = np.asarray(labels, dtype=np.float64)
    if (not x or y.shape != (len(x),) or not np.isin(y, [0, 1]).all()
            or any(b.shape[1] != x[0].shape[1] for b in x)):
        raise ValueError("Invalid supervised bags")
    counts = [int((y == c).sum()) for c in (0, 1)]
    if min(counts) < POLICY["minimum_train_per_class"]:
        return {"state": "insufficient_training", "negative": counts[0], "positive": counts[1]}
    # Balanced source weights, not crop counts. Initialization also uses train only.
    means = np.stack([b.mean(axis=0) for b in x])
    w = means[y == 1].mean(axis=0) - means[y == 0].mean(axis=0)
    bias = 0.0
    weights = np.where(y == 1, 0.5 / counts[1], 0.5 / counts[0])
    for _ in range(POLICY["epochs"]):
        witnesses = np.stack([b[int(np.argmax(b @ w))] for b in x])
        logits = witnesses @ w + bias
        residual = weights * (sigmoid(logits) - y)
        w -= POLICY["learning_rate"] * (witnesses.T @ residual + POLICY["l2"] * w)
        bias -= POLICY["learning_rate"] * float(residual.sum())
    if not np.isfinite(w).all() or not np.isfinite(bias):
        raise ValueError("Non-finite fitted head")
    return {"state": "uncalibrated", "weights": w.tolist(), "bias": bias,
            "positive": counts[1], "negative": counts[0]}


def probabilities(head, vectors):
    x = normalize(vectors)
    w = np.asarray(head["weights"], dtype=np.float64)
    if w.shape != (x.shape[1],) or not np.isfinite(w).all() or not np.isfinite(head["bias"]):
        raise ValueError("Incompatible head")
    # Logistic scores are not calibrated probabilities of identity correctness.
    return sigmoid(x @ w + head["bias"])


def calibrate(head, bags, labels):
    result = dict(head)
    if "weights" not in head:
        return result
    y = np.asarray(labels, dtype=bool)
    if len(bags) != len(y) or any(type(v) is not bool for v in labels):
        raise ValueError("Invalid calibration labels")
    counts = {"positive": int(y.sum()), "negative": int((~y).sum())}
    result["calibration"] = counts
    if min(counts.values()) < POLICY["minimum_calibration_per_class"]:
        result["state"] = "insufficient_calibration"
        return result
    scores = np.array([float(probabilities(head, b).max()) for b in bags])
    # Boundary is learned ONLY from calibration. Ties with negatives must abstain.
    valid = [float(t) for t in np.unique(scores[y]) if not (scores[~y] >= t).any()]
    if not valid:
        result["state"] = "calibration_not_separable"
        return result
    threshold = min(valid)
    recovered = int((scores[y] >= threshold).sum())
    result["calibration"].update({"recovered": recovered, "false_positive": 0})
    if recovered < POLICY["minimum_calibration_recovered"]:
        result["state"] = "insufficient_calibration_recovery"
        return result
    result.update({"state": "ready_shadow", "threshold": threshold})
    return result


def decide(heads, vectors, candidates, fallback=False):
    """Independent region decisions, partial successes, and explicit holds.

    'accepted' is a shadow proposal, never permission to publish. No whole-image
    fallback authorizes a match. A collision only withholds that particular crop;
    overlapping boxes are not assumed to be the same person.
    """
    x = normalize(vectors)
    if len(candidates) != len(set(candidates)) or any(t not in heads for t in candidates):
        raise ValueError("Unknown or duplicate candidate")
    scores = {t: probabilities(heads[t], x).tolist() for t in candidates if "weights" in heads[t]}
    unavailable = {t: heads[t]["state"] for t in candidates if heads[t]["state"] != "ready_shadow"}
    regions, accepted = [], set()
    for i in range(len(x)):
        matches = [t for t in candidates if heads[t]["state"] == "ready_shadow"
                   and scores[t][i] >= heads[t]["threshold"]] if not fallback else []
        if len(matches) == 1:
            accepted.update(matches)
            state = "accepted_shadow"
        elif len(matches) > 1:
            state = "competing_characters"
        else:
            state = "no_detected_region" if fallback else "below_threshold_or_unavailable"
        regions.append({"index": i, "state": state, "candidates": matches,
                        "scores": {t: s[i] for t, s in scores.items()}})
    return {"accepted": sorted(accepted), "regions": regions, "unavailable_heads": unavailable,
            "state": "partially_resolved" if accepted and any(r["state"] != "accepted_shadow" for r in regions)
            else "resolved_shadow" if accepted else "held",
            "publication_allowed": False}


def grouped_split(assets, reference_groups):
    """Deterministic 60/20/20 multi-label stratification of source groups.

    Split identity is frozen before fitting. Reference/near-reference groups are
    training-only. Label presence may stratify splits, but no features or scores
    participate. Very rare classes cannot be made sufficiently supported by a split.
    """
    groups = {}
    for a in assets:
        groups.setdefault(a["group"], set()).update((t, bool(v)) for t, v in a["labels"].items())
    result = {g: "train" for g in groups if g in reference_groups}
    pending = set(groups) - set(result)
    labels = sorted(set().union(*(groups[g] for g in pending)))
    desired = {label: np.array([0.6, 0.2, 0.2]) * sum(label in groups[g] for g in pending)
               for label in labels}
    counts = {label: np.zeros(3) for label in labels}
    sizes = np.zeros(3)
    desired_sizes = np.array([0.6, 0.2, 0.2]) * len(pending)
    order = lambda g: hashlib.sha256((POLICY["split_seed"] + g).encode()).hexdigest()
    while pending:
        remaining = {label: sum(label in groups[g] for g in pending) for label in labels}
        available = [label for label in labels if remaining[label]]
        label = min(available, key=lambda k: (remaining[k], k)) if available else None
        group = min((g for g in pending if label is None or label in groups[g]), key=order)
        deficits = desired[label] - counts[label] if label is not None else desired_sizes - sizes
        slot = max(range(3), key=lambda i: (deficits[i], desired_sizes[i] - sizes[i], -i))
        result[group] = ("train", "calibration", "test")[slot]
        sizes[slot] += 1
        for k in groups[group]:
            if k in counts:
                counts[k][slot] += 1
        pending.remove(group)
    return result
