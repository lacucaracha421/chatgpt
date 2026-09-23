"""Shared NumPy-only CCIP scoring. Smaller distances/scores are better.

Normalize raw vectors once with unit(), then pass normalized=True to preserve
float32 replay arithmetic exactly. Galleries contain one witness per image.
Contrast per crop is knn3(positive) - min(knn3(rejections), knn3(competitors));
an empty negative/competitor pool has distance 1.0. Minimize only AFTER this
same-crop subtraction. An empty positive pool abstains.
"""
import numpy as np


def unit(vectors):
    vectors = np.asarray(vectors, dtype=np.float32)
    if vectors.ndim != 2 or vectors.shape[1] != 768:
        raise ValueError("Expected vectors of dimension 768")
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    if not np.isfinite(vectors).all() or np.any(norms <= 0) or not np.isfinite(norms).all():
        raise ValueError("Nonfinite or zero feature vector")
    return vectors / norms


def distance(left, right):
    """CCIP distance between already L2-normalized float32 rows."""
    return 0.5 * (1.0 - left @ right.T)


def cosine_distance(left, right):
    return distance(unit(left), unit(right))


def knn(vectors, pool):
    """Per-crop mean of up to three nearest normalized gallery vectors."""
    if not len(pool):
        return np.ones(len(vectors))
    d = distance(vectors, pool)
    k = min(3, len(pool))
    return np.partition(d, k - 1, axis=1)[:, :k].mean(axis=1)


def crop_scores(vectors, positive, negative, competitors, *, normalized=False):
    if not normalized:
        vectors, positive, negative, competitors = map(unit, (vectors, positive, negative, competitors))
    if not 1 <= len(vectors) <= 8:
        raise ValueError("Expected 1..8 query crops")
    own = knn(vectors, positive)
    contrast = own - np.minimum(knn(vectors, negative), knn(vectors, competitors))
    return {"knn3": own if len(positive) else None,
            "contrast": contrast if len(positive) else None}


def score_crops(vectors, positive, negative, competitors, prior, policy, *, normalized=False):
    """Replay-compatible aggregate scores and two-reference recommendation flag."""
    if not normalized:
        vectors, positive, negative, competitors = map(unit, (vectors, positive, negative, competitors))
    per_crop = crop_scores(vectors, positive, negative, competitors, normalized=True)
    ds = distance(vectors, positive)
    support = policy["automatic_support"]
    rule = float(np.partition(ds, support - 1, axis=1)[:, support - 1].min()) if len(positive) >= support else None
    scores = {"rule6": rule, **{name: float(values.min()) if values is not None else None
                               for name, values in per_crop.items()}, "prior": -prior}
    recommended = bool(((ds <= policy["recommendation_threshold"]).sum(axis=1) >= 2).any())
    return scores, recommended


def same_person(a, b):
    """Rust character_scan::same_person: intersection / smaller area >= 0.5.

    Native callers validate finite, positive-area rectangles before this test.
    Invalid rectangles fail closed here as well.
    """
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    if a.shape != (4,) or b.shape != (4,) or not np.isfinite([a, b]).all():
        return False
    if any(box[2] <= box[0] or box[3] <= box[1] for box in (a, b)):
        return False
    intersection = max(0.0, min(a[2], b[2]) - max(a[0], b[0])) * max(
        0.0, min(a[3], b[3]) - max(a[1], b[1]))
    smaller = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return bool(intersection / smaller >= 0.5)
