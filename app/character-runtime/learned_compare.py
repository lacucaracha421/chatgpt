"""Bounded comparison against five anchors plus up to twenty human-approved examples."""
import numpy as np
from runtime import BASELINE


def compare_supported(engine, query, references):
    if not 5 <= len(references) <= 25 or len({r.content_hash for r in references}) != len(references):
        raise ValueError("Expected five anchors and at most twenty distinct approved examples")
    base = engine.compare(query, references[:5])
    if len(references) == 5:
        return {**base, "learnedReferenceCount": 0}
    distances = [list(row["referenceDistances"]) for row in base["evidence"]]
    # Reuse the frozen five-reference metric boundary (at most 48 vectors).
    for offset in range(5, len(references), 5):
        group = references[offset:offset + 5]
        padded = group + references[:5 - len(group)]
        result = engine.compare(query, padded)
        for row, extra in zip(distances, result["evidence"]):
            row.extend(extra["referenceDistances"][:len(group)])
    values = np.asarray(distances, dtype=np.float64)
    second = np.sort(values, axis=1)[:, 1]
    best = int(np.argmin(second))
    evidence = [{"queryCrop": i, "distance": float(second[i]),
                 "matchedReferences": np.flatnonzero(row <= BASELINE["threshold"]).tolist(),
                 "referenceDistances": row.tolist()} for i, row in enumerate(values)]
    return {**base, "distance": float(second[best]), "passed": bool(second[best] <= BASELINE["threshold"]),
            "bestQueryCrop": best, "evidence": evidence,
            "referenceHashes": [r.content_hash for r in references],
            "referenceBoxes": [r.boxes for r in references],
            "referenceWholeFallback": [r.fallback for r in references],
            "learnedReferenceCount": len(references) - 5}
