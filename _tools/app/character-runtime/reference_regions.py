"""Reference views select one detected person without changing cached extraction."""
from __future__ import annotations

import numpy as np

from learned_compare import compare_supported, compare_reference_delta, replay_reference_distances
from runtime import BASELINE, FINGERPRINT, Features

INELIGIBLE_DISTANCE = 1.0  # A withheld vote, identified by referenceStatuses.
VALID_STATUSES = {"single", "selected"}


def region_binding(feature, index):
    return {"contentHash": feature.content_hash, "baselineFingerprint": FINGERPRINT,
            "bounds": list(feature.boxes[index])}


def project_reference(feature, selection):
    if selection is not None:
        if not isinstance(selection, dict):
            raise ValueError("Invalid reference region")
        bounds = selection.get("bounds")
        if (selection.get("contentHash") != feature.content_hash
                or selection.get("baselineFingerprint") != FINGERPRINT
                or not isinstance(bounds, list) or len(bounds) != 4
                or any(type(v) is not int for v in bounds)
                or tuple(bounds) not in feature.boxes or feature.fallback):
            raise ValueError("Reference region no longer matches this image and detector")
        index = feature.boxes.index(tuple(bounds))
        return Features(feature.content_hash, [feature.boxes[index]],
                        feature.vectors[index:index+1], False), "selected", region_binding(feature, index)
    if feature.fallback:
        return feature, "no_region", None
    if len(feature.boxes) != 1:
        return feature, "needs_region", None
    return feature, "single", region_binding(feature, 0)


def views(references, selections):
    if len(references) != len(selections):
        raise ValueError("Reference selections do not match the reference set")
    result = []
    for ref, selection in zip(references, selections):
        try:
            result.append(project_reference(ref, selection))
        except ValueError:
            # A stale selection supplies no votes; never guess a replacement person.
            result.append((ref, "stale_region", None))
    return result


def apply_views(result, projected, selections, offset=0):
    distances = [list(row["referenceDistances"]) for row in result["evidence"]]
    for index, (_, status, _) in enumerate(projected, offset):
        if status not in VALID_STATUSES:
            for row in distances:
                row[index] = INELIGIBLE_DISTANCE
    result = replay_reference_distances(result, result["referenceHashes"], result["referenceBoxes"],
                                        result["referenceWholeFallback"], distances)
    return {**result,
            "referenceSelections": result.get("referenceSelections", [])[:offset] + list(selections),
            "referenceRegions": result.get("referenceRegions", [])[:offset] + [v[2] for v in projected],
            "referenceStatuses": result.get("referenceStatuses", [])[:offset] + [v[1] for v in projected]}


def compare_bound(engine, query, references, selections):
    projected = views(references, selections)
    result = compare_supported(engine, query, [v[0] for v in projected])
    return apply_views(result, projected, selections)


def compare_bound_delta(engine, query, old, additions, selections):
    count = len(old.get("referenceHashes", []))
    for key in ("referenceSelections", "referenceRegions", "referenceStatuses"):
        if len(old.get(key, [])) != count:
            raise ValueError("Delta requires region-aware evidence")
    projected = views(additions, selections)
    result = compare_reference_delta(engine, query, old, [v[0] for v in projected])
    return apply_views(result, projected, selections, count)


def inspect_references(engine, references, selections):
    projected = views(references, selections)
    trusted = [v[0] for v in projected if v[1] in VALID_STATUSES]
    result = []
    for source, (_, status, region) in zip(references, projected):
        selected = source.boxes.index(tuple(region["bounds"])) if region else None
        suggested = None
        peers = [f for f in trusted if f.content_hash != source.content_hash]
        if status == "needs_region" and len(peers) >= 2:
            distances = np.asarray(engine.reference_distances(source, peers[:20]), dtype=np.float64)
            support = np.sort(distances, axis=1)[:, 1]
            matches = np.flatnonzero(support <= BASELINE["threshold"]).tolist()
            if len(matches) == 1:
                suggested = matches[0]
        result.append({"contentHash": source.content_hash, "baselineFingerprint": FINGERPRINT,
                       "boxes": [list(b) for b in source.boxes], "selectedIndex": selected,
                       "suggestedIndex": suggested, "state": status})
    return result
