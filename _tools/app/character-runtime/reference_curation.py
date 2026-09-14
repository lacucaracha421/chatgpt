"""Bounded CCIP reference curation. Only human-confirmed inputs reach this module."""
from __future__ import annotations
from collections import Counter
from pathlib import Path
import numpy as np
from reference_regions import project_reference, VALID_STATUSES
from runtime import BASELINE

MAX_CANDIDATES = 64
METRIC_BLOCK = 24


def metric_distances(engine, features):
    n = len(features)
    if not 1 <= n <= MAX_CANDIDATES + 25:
        raise ValueError("Reference curation exceeds its bounded sample limit")
    result = np.zeros((n, n), dtype=np.float64)
    for a in range(0, n, METRIC_BLOCK):
        left = features[a:a+METRIC_BLOCK]
        for b in range(a, n, METRIC_BLOCK):
            right = features[b:b+METRIC_BLOCK]
            batch = left if a == b else left + right
            if any(len(f.vectors) != 1 for f in batch):
                raise ValueError("Curation requires one selected person per image")
            stack = np.concatenate([f.vectors for f in batch]).astype(np.float32)
            matrix = engine.metric.run(["output"], {"input": stack})[0]
            if matrix.shape != (len(batch), len(batch)) or not np.isfinite(matrix).all():
                raise ValueError("Invalid reference metric output")
            block = matrix if a == b else matrix[:len(left), len(left):]
            result[a:a+len(left), b:b+len(right)] = block
            result[b:b+len(right), a:a+len(left)] = block.T
    return result


def select_core_references(distances, anchor_count, limit):
    d = np.asarray(distances, dtype=np.float64)
    if (d.ndim != 2 or d.shape[0] != d.shape[1] or not np.isfinite(d).all()
            or not 0 <= anchor_count <= len(d) or not 0 <= limit <= 20):
        raise ValueError("Invalid curation distances or limits")
    candidates = list(range(anchor_count, len(d)))
    if not candidates or not limit:
        return []
    threshold = BASELINE["threshold"]
    # Two independent known references constrain a new candidate. With fewer
    # anchors, use the locally representative core of the manually labeled set.
    if anchor_count >= 2:
        eligible = [i for i in candidates if np.count_nonzero(d[i, :anchor_count] <= threshold) >= 2]
        core = list(range(anchor_count))
    else:
        counts = [(sum(d[i, j] <= threshold for j in candidates if j != i), i) for i in candidates]
        count, center = max(counts, key=lambda row: (row[0], -float(np.median(d[row[1], candidates])), -row[1]))
        if count < 2:
            return []
        eligible = [i for i in candidates if d[center, i] <= threshold
                    and sum(d[i, j] <= threshold for j in candidates if j != i) >= 2]
        core = []
    if not eligible:
        return []
    selected = []
    # Fill the initial supporting core before seeking additional visual spread.
    central = sorted(eligible, key=lambda i: (float(np.median(d[i, core or eligible])), i))
    initial_count = min(limit, max(0, 6 - anchor_count))
    selected.extend(central[:initial_count])
    while len(selected) < min(limit, len(eligible)):
        remaining = [i for i in eligible if i not in selected]
        known = core + selected
        best = max(remaining, key=lambda i: (float(np.min(d[i, known])) if known else 0,
                                             -float(np.median(d[i, core or eligible])), -i))
        selected.append(best)
    return selected


def curate_references(engine, cache, candidates, anchors, limit):
    if len(candidates) > MAX_CANDIDATES or len(anchors) > 25:
        raise ValueError("Too many reference candidates")
    selected_features, metadata = [], []
    excluded = Counter()
    anchor_count = 0
    for is_anchor, items in ((True, anchors), (False, candidates)):
        for item in items:
            try:
                f = cache.extract(Path(item["path"]), item["hash"])
                view, status, region = project_reference(f, item.get("region"))
                if status not in VALID_STATUSES:
                    excluded[status] += 1
                    continue
                if not is_anchor and len(f.boxes) != 1:
                    excluded["multiple_people"] += 1
                    continue
                selected_features.append(view)
                metadata.append({"assetId": item["assetId"], "region": region})
                anchor_count += int(is_anchor)
            except (OSError, ValueError):
                excluded["unavailable"] += 1
    if len(selected_features) <= anchor_count:
        return {"selected": [], "excluded": dict(excluded)}
    indices = select_core_references(metric_distances(engine, selected_features), anchor_count, limit)
    excluded["outside_core"] += len(selected_features) - anchor_count - len(indices)
    return {"selected": [metadata[i] for i in indices], "excluded": dict(excluded)}
