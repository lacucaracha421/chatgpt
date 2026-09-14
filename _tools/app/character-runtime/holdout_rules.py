"""Replay the native character publication predicate over frozen evidence.

No model sessions, database access, or mutation. Distances are not probabilities.
"""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import re


def current_policy() -> dict:
    here = Path(__file__).resolve().parent
    baseline_bytes = (here / "baseline.json").read_bytes()
    baseline = json.loads(baseline_bytes)
    native = (here.parent / "src-tauri/src/library/character_scan.rs").read_bytes()
    text = native.decode("utf-8")
    def constant(name):
        match = re.search(r"const\s+" + name + r"\s*:\s*\w+\s*=\s*([0-9.]+)\s*;", text)
        if not match:
            raise ValueError(f"Cannot locate native policy constant: {name}")
        return float(match.group(1))
    return {
        "logic_version": 1,
        "recommendation_threshold": baseline["threshold"],
        "automatic_support": int(constant("AUTOMATIC_REFERENCE_SUPPORT")),
        "automatic_max_distance": constant("AUTOMATIC_MAX_SIXTH_DISTANCE"),
        "baseline_fingerprint": hashlib.sha256(json.dumps(baseline, sort_keys=True).encode()).hexdigest(),
        "baseline_sha256": hashlib.sha256(baseline_bytes).hexdigest(),
        "arbitration_source_sha256": hashlib.sha256(
            (here.parent / "src-tauri/src/library/character_incremental.rs").read_bytes()).hexdigest(),
        "native_source_sha256": hashlib.sha256(native).hexdigest(),
        "model_sha256": baseline["sha256"],
    }


def is_hash(value) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def number(value) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def validate_evidence(e: dict, policy: dict) -> None:
    if not isinstance(e, dict) or type(e.get("passed")) is not bool or type(e.get("wholeFallback")) is not bool:
        raise ValueError("Missing character evidence flags")
    if e.get("baselineFingerprint", policy["baseline_fingerprint"]) != policy["baseline_fingerprint"]:
        raise ValueError("Evidence belongs to a different extraction/model baseline")
    hashes, boxes, rows = e.get("referenceHashes"), e.get("queryBoxes"), e.get("evidence")
    if (not isinstance(hashes, list) or not 5 <= len(hashes) <= 25
            or not all(is_hash(h) for h in hashes) or len(set(hashes)) != len(hashes)):
        raise ValueError("References must contain 5 to 25 distinct content hashes")
    if not isinstance(boxes, list) or not isinstance(rows, list):
        raise ValueError("Missing crop evidence")
    if e["wholeFallback"]:
        if boxes or len(rows) != 1:
            raise ValueError("Invalid whole-image fallback")
    elif not 1 <= len(boxes) <= 8 or len(rows) != len(boxes):
        raise ValueError("Invalid query crop count")
    for box in boxes:
        if (not isinstance(box, list) or len(box) != 4 or not all(number(v) for v in box)
                or box[2] <= box[0] or box[3] <= box[1]):
            raise ValueError("Invalid query region")
    threshold = policy["recommendation_threshold"]
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Invalid crop row")
        values, matches = row.get("referenceDistances"), row.get("matchedReferences")
        if (not isinstance(values, list) or len(values) != len(hashes)
                or not all(number(v) for v in values)):
            raise ValueError("Invalid reference distances")
        expected = [i for i, value in enumerate(values) if value <= threshold]
        if (not isinstance(matches, list) or not all(type(i) is int for i in matches)
                or matches != expected):
            raise ValueError("Reference votes do not match stored distances")
    if e["passed"] != any(len(row["matchedReferences"]) >= 2 for row in rows):
        raise ValueError("Recommendation flag does not match evidence")


def recommendation(e: dict, policy: dict) -> bool:
    validate_evidence(e, policy)
    return e["passed"]


def same_person(a: list, b: list) -> bool:
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    smaller = min((a[2]-a[0])*(a[3]-a[1]), (b[2]-b[0])*(b[3]-b[1]))
    return intersection / smaller >= 0.5


def automatic_targets(bundle: dict, prior: dict, query_hash: str, policy: dict) -> set[str]:
    """Match finalize_incremental including competitors, geometry and prior decisions.

    Source-byte/scope/revision fences and model extraction remain native concerns.
    The exporter validates the stored bundle's content and generation identities.
    """
    if policy.get("logic_version") != 1:
        raise ValueError("Unsupported publication policy version")
    support, maximum = policy["automatic_support"], policy["automatic_max_distance"]
    if type(support) is not int or not 2 <= support <= 25 or not number(maximum):
        raise ValueError("Invalid automatic policy")
    if not bundle:
        return set()
    for e in bundle.values():
        validate_evidence(e, policy)
    first = next(iter(bundle.values()))
    if any(e["queryBoxes"] != first["queryBoxes"] or e["wholeFallback"] != first["wholeFallback"] for e in bundle.values()):
        raise ValueError("Competitors must describe the same query regions")
    references = {target for target, e in bundle.items() if query_hash in e["referenceHashes"]}
    candidates = {t: e for t, e in bundle.items() if prior.get(t) not in ("rejected", "cleared")}
    known = bool(references) or "accepted" in prior.values()
    accepted = set()
    for target, e in candidates.items():
        if target in references or target in prior or e["wholeFallback"] or not e["passed"]:
            continue
        if known and len(e["queryBoxes"]) == 1:
            continue
        for region, row in zip(e["queryBoxes"], e["evidence"]):
            values = row["referenceDistances"]
            if len(row["matchedReferences"]) < support or sorted(values)[support - 1] > maximum:
                continue
            ambiguous = any(
                other["wholeFallback"] or any(
                    len(other_row["matchedReferences"]) >= 2 and same_person(region, other_region)
                    for other_region, other_row in zip(other["queryBoxes"], other["evidence"])
                ) for name, other in candidates.items() if name != target
            )
            if not ambiguous:
                accepted.add(target)
                break
    return accepted
