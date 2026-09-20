"""Reference views select one detected person without changing cached extraction."""
from __future__ import annotations

import numpy as np

from learned_compare import compare_supported, compare_reference_delta, replay_reference_distances
from runtime import BASELINE, FINGERPRINT, Features

INELIGIBLE_DISTANCE = 1.0  # A withheld vote, identified by referenceStatuses.
VALID_STATUSES = {"single", "selected", "automatic"}
STABLE_STATUSES = {"single", "selected", "no_region"}
METRIC_BLOCK = 24


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


def resolve_references(engine, references, selections):
    """Infer one common person per image, without replacing manual choices.

    An explicit/single-person anchor is required. A matching triangle with two
    other source images can bootstrap a choice; later synchronous rounds require
    two selected sources. Tied candidates abstain, and queries never participate.
    """
    if not 1 <= len(references) <= 25 or len({r.content_hash for r in references}) != len(references):
        raise ValueError("Expected one to twenty-five distinct reference images")
    projected = views(references, selections)
    if not any(v[1] == "needs_region" for v in projected) or not any(v[1] in VALID_STATUSES for v in projected):
        return projected

    groups, vectors, fixed = {}, [], {}
    for source, (view, status, _) in enumerate(projected):
        if status not in VALID_STATUSES and status != "needs_region":
            continue
        if not 1 <= len(view.vectors) <= BASELINE["max_boxes"] or len(view.boxes) != len(view.vectors):
            raise ValueError("Invalid reference crop group size")
        groups[source] = list(range(len(vectors), len(vectors) + len(view.vectors)))
        vectors.extend(view.vectors)
        if status in VALID_STATUSES:
            fixed[source] = groups[source][0]

    stack = np.asarray(vectors, dtype=np.float32)
    distances = np.zeros((len(stack), len(stack)), dtype=np.float64)
    # The frozen metric returns a square matrix. Never feed the whole reference
    # set at once (25 images can contain 200 crops); each call stays <=48 vectors.
    for a in range(0, len(stack), METRIC_BLOCK):
        left = stack[a:a + METRIC_BLOCK]
        for b in range(a, len(stack), METRIC_BLOCK):
            right = stack[b:b + METRIC_BLOCK]
            batch = left if a == b else np.concatenate([left, right])
            engine.max_metric_vectors = max(engine.max_metric_vectors, len(batch))
            raw = engine.metric.run(["output"], {"input": batch})[0]
            if raw.shape != (len(batch), len(batch)) or not np.isfinite(raw).all():
                raise ValueError("Invalid common-person metric output")
            symmetric = np.maximum(raw, raw.T)
            block = symmetric if a == b else symmetric[:len(left), len(left):]
            distances[a:a + len(left), b:b + len(right)] = block
            distances[b:b + len(right), a:a + len(left)] = block.T
    matches = distances <= BASELINE["threshold"]

    def unique_best(scores):
        best = max(scores.values(), default=0)
        winners = [index for index, score in scores.items() if score == best]
        return winners[0] if best > 0 and len(winners) == 1 else None

    selected = dict(fixed)
    proposals = {}
    for source, candidates in groups.items():
        if source in fixed:
            continue
        scores = {}
        for candidate in candidates:
            supporters = set()
            for anchor_source, anchor in fixed.items():
                if not matches[candidate, anchor]:
                    continue
                for peer_source, peers in groups.items():
                    if peer_source in (source, anchor_source):
                        continue
                    if any(matches[candidate, peer] and matches[anchor, peer] for peer in peers):
                        supporters.add(peer_source)
            scores[candidate] = len(supporters)
        winner = unique_best(scores)
        if winner is not None:
            proposals[source] = winner
    selected.update(proposals)

    for _ in range(len(groups)):
        proposals = {}
        for source, candidates in groups.items():
            if source in selected:
                continue
            scores = {candidate: sum(bool(matches[candidate, peer]) for peer in selected.values())
                      for candidate in candidates}
            winner = unique_best({candidate: count if count >= 2 else 0 for candidate, count in scores.items()})
            if winner is not None:
                proposals[source] = winner
        if not proposals:
            break
        selected.update(proposals)

    for source, node in selected.items():
        if source in fixed:
            continue
        index = groups[source].index(node)
        reference = references[source]
        region = region_binding(reference, index)
        view, _, _ = project_reference(reference, region)
        projected[source] = (view, "automatic", region)
    return projected


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


def compare_bound(engine, query, references, selections, projected=None):
    if projected is None:
        projected = resolve_references(engine, references, selections)
    result = compare_supported(engine, query, [v[0] for v in projected])
    return apply_views(result, projected, selections)


def compare_bound_delta(engine, query, old, additions, selections):
    count = len(old.get("referenceHashes", []))
    for key in ("referenceSelections", "referenceRegions", "referenceStatuses"):
        if len(old.get(key, [])) != count:
            raise ValueError("Delta requires region-aware evidence")
    projected = views(additions, selections)
    # Additions can change earlier inferred choices. The native owner catches this
    # refusal and prepares the complete set instead of appending stale votes.
    if (any(status not in STABLE_STATUSES for status in old["referenceStatuses"])
            or any(v[1] not in STABLE_STATUSES for v in projected)):
        raise ValueError("Common-person references require a full comparison")
    result = compare_reference_delta(engine, query, old, [v[0] for v in projected])
    return apply_views(result, projected, selections, count)


def inspect_references(engine, references, selections):
    projected = resolve_references(engine, references, selections)
    result = []
    for source, (_, status, region) in zip(references, projected):
        index = source.boxes.index(tuple(region["bounds"])) if region else None
        automatic = index if status == "automatic" else None
        result.append({"contentHash": source.content_hash, "baselineFingerprint": FINGERPRINT,
                       "boxes": [list(b) for b in source.boxes],
                       "selectedIndex": index if status in {"single", "selected"} else None,
                       "automaticIndex": automatic, "suggestedIndex": automatic, "state": status})
    return result
