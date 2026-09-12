import numpy as np
from runtime import BASELINE, FINGERPRINT


def _box_rows(boxes):
    return [list(box) for box in boxes]


def _distance_matrix(distances, reference_count):
    values = np.asarray(distances, dtype=np.float64)
    if (values.ndim != 2 or values.shape[0] < 1
            or values.shape[1] != reference_count
            or not np.isfinite(values).all()):
        raise ValueError("Invalid old evidence reference distances")
    return values


def replay_reference_distances(base, reference_hashes, reference_boxes,
                               reference_fallbacks, distances):
    count = len(reference_hashes)
    if not 5 <= count <= 25:
        raise ValueError("Expected five anchors and at most twenty approved examples")
    if len(reference_boxes) != count or len(reference_fallbacks) != count:
        raise ValueError("Invalid reference metadata")
    values = _distance_matrix(distances, count)
    rank = BASELINE["required_references"] - 1
    support = np.sort(values, axis=1)[:, rank]
    best = int(np.argmin(support))
    evidence = [{
        "queryCrop": index,
        "distance": float(support[index]),
        "matchedReferences": np.flatnonzero(row <= BASELINE["threshold"]).tolist(),
        "referenceDistances": row.tolist(),
    } for index, row in enumerate(values)]
    return {
        **base,
        "distance": float(support[best]),
        "passed": bool(support[best] <= BASELINE["threshold"]),
        "bestQueryCrop": best,
        "evidence": evidence,
        "referenceHashes": list(reference_hashes),
        "referenceBoxes": list(reference_boxes),
        "referenceWholeFallback": list(reference_fallbacks),
        "learnedReferenceCount": count - 5,
    }


def compare_supported(engine, query, references):
    if not 5 <= len(references) <= 25 or len({r.content_hash for r in references}) != len(references):
        raise ValueError("Expected five anchors and at most twenty distinct approved examples")
    base = engine.compare(query, references[:5])
    if len(references) == 5:
        return {**base, "learnedReferenceCount": 0}
    distances = [list(row["referenceDistances"]) for row in base["evidence"]]
    # Preserve the frozen five-reference comparison boundary for the full path.
    for offset in range(5, len(references), 5):
        group = references[offset:offset + 5]
        padded = group + references[:5 - len(group)]
        result = engine.compare(query, padded)
        for row, extra in zip(distances, result["evidence"]):
            row.extend(extra["referenceDistances"][:len(group)])
    return replay_reference_distances(
        base,
        [reference.content_hash for reference in references],
        [reference.boxes for reference in references],
        [reference.fallback for reference in references],
        distances,
    )


def compare_reference_delta(engine, query, old, added_references):
    added = list(added_references)
    if not 1 <= len(added) <= 20:
        raise ValueError("Delta requires one to twenty strict additions")
    old_hashes = list(old.get("referenceHashes") or [])
    if not 5 <= len(old_hashes) < 25 or len(old_hashes) + len(added) > 25:
        raise ValueError("Delta requires reusable old evidence")
    added_hashes = [reference.content_hash for reference in added]
    if (len(set(old_hashes)) != len(old_hashes)
            or len(set(added_hashes)) != len(added_hashes)
            or set(old_hashes).intersection(added_hashes)):
        raise ValueError("Delta requires a strict addition of distinct references")
    if (old.get("contentHash") != query.content_hash
            or _box_rows(old.get("queryBoxes") or []) != _box_rows(query.boxes)
            or bool(old.get("wholeFallback")) != bool(query.fallback)
            or old.get("baselineFingerprint") != FINGERPRINT):
        raise ValueError("Delta query identity does not match old evidence")
    old_boxes = list(old.get("referenceBoxes") or [])
    old_fallbacks = list(old.get("referenceWholeFallback") or [])
    if len(old_boxes) != len(old_hashes) or len(old_fallbacks) != len(old_hashes):
        raise ValueError("Invalid old evidence reference metadata")
    evidence = old.get("evidence") or []
    if len(evidence) != len(query.vectors):
        raise ValueError("Invalid old evidence query crops")
    old_distances = [row.get("referenceDistances") for row in evidence]
    _distance_matrix(old_distances, len(old_hashes))

    new_distances = engine.reference_distances(query, added)
    values = _distance_matrix(new_distances, len(added))
    merged = [list(prior) + extra.tolist()
              for prior, extra in zip(old_distances, values)]
    return replay_reference_distances(
        old,
        old_hashes + added_hashes,
        old_boxes + [reference.boxes for reference in added],
        old_fallbacks + [reference.fallback for reference in added],
        merged,
    )
