"""Freeze explicitly reviewed pairs and their pre-feedback machine evidence."""
from __future__ import annotations
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
from holdout_rules import automatic_targets, current_policy, is_hash

SCHEMA_VERSION = 1
MAX_GROUP_HASHES = 12000


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def timestamp(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError("Expected an ISO timestamp with a timezone")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("A timezone is required")
    return parsed.astimezone(timezone.utc)


def iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")

@contextmanager
def open_readonly(path: Path):
    path = Path(path).resolve()
    if not path.is_file():
        raise FileNotFoundError(path)
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        yield connection
    finally:
        connection.rollback()
        connection.close()


def records(connection, sql, parameters=()):
    cursor = connection.execute(sql, parameters)
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row)) for row in cursor]


def verify_frozen(envelope: dict) -> dict:
    if not isinstance(envelope, dict) or not isinstance(envelope.get("dataset"), dict):
        raise ValueError("Not a frozen character dataset")
    data = envelope["dataset"]
    if data.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("Unsupported frozen dataset schema")
    if hashlib.sha256(canonical(data)).hexdigest() != envelope.get("sha256"):
        raise ValueError("Frozen dataset digest mismatch")
    return data

def load_frozen(path: Path) -> dict:
    with Path(path).open(encoding="utf-8") as stream:
        envelope = json.load(stream)
    verify_frozen(envelope)
    return envelope


def save_exclusive(value: dict, destination: Path, source_database: Path | None = None):
    destination = Path(destination).resolve()
    if source_database is not None:
        library = Path(source_database).resolve().parent
        if destination == library or library in destination.parents:
            raise ValueError("Evaluation output must be outside the source database directory")
    content = json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n"
    with destination.open("x", encoding="utf-8") as output:
        output.write(content)


def duplicate_groups(hashes, assets, near_distance, minimum_quality):
    hashes = sorted(hashes)
    if len(hashes) > MAX_GROUP_HASHES:
        raise ValueError("Too many hashes for a bounded audit; select one series")
    parent = {value: value for value in hashes}
    def find(value):
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = parent[value]
        return value
    fingerprints = {}
    for asset in sorted(assets.values(), key=lambda a: a["id"]):
        value, quality = asset["perceptual_hash"], asset["perceptual_hash_quality"]
        if (asset["content_hash"] in parent and isinstance(value, bytes) and len(value) == 32
                and type(quality) is int and quality >= minimum_quality):
            fingerprints.setdefault(asset["content_hash"], int.from_bytes(value, "big"))
    values = sorted(fingerprints.items())
    for index, (left, a) in enumerate(values):
        for right, b in values[index+1:]:
            if (a ^ b).bit_count() <= near_distance:
                x, y = find(left), find(right)
                if x != y:
                    parent[max(x, y)] = min(x, y)
    return {value: find(value) for value in hashes}, len(hashes) - len(fingerprints)


def build_dataset(connection, cutoff: str, *, near_distance: int = 30,
                  minimum_quality: int = 50, series_id: str | None = None) -> dict:
    if type(near_distance) is not int or not 0 <= near_distance <= 256:
        raise ValueError("PDQ distance must be an integer between 0 and 256")
    if type(minimum_quality) is not int or not 0 <= minimum_quality <= 100:
        raise ValueError("PDQ minimum quality must be between 0 and 100")
    boundary = timestamp(cutoff)
    policy = current_policy()
    assets = {row["id"]: row for row in records(connection,
        "SELECT id,content_hash,status,media_kind,perceptual_hash,perceptual_hash_quality FROM assets")}
    targets = {row["id"]: row for row in records(connection,
        "SELECT id,series_classification_id,display_name FROM character_targets")}
    decisions = records(connection, "SELECT sequence,target_id,source_asset_id,asset_hash,decision,origin,created_at FROM character_decisions ORDER BY sequence")
    latest, first_manual, histories = {}, {}, defaultdict(list)
    excluded = Counter()
    for row in decisions:
        pair = row["target_id"], row["source_asset_id"]
        latest[pair] = row  # Filter after taking the latest, including cleared.
        try:
            row["time"] = timestamp(row["created_at"])
        except (ValueError, TypeError):
            row["time"] = None
        histories[row["source_asset_id"]].append(row)
        if row["origin"] == "manual":
            first_manual.setdefault((*pair, row["asset_hash"]), row["time"])
    evidence = records(connection, """
        SELECT e.id,e.asset_id,e.content_hash,e.generation,e.runtime_fingerprint,e.created_at
        FROM character_autotag_evidence e
        JOIN character_autotag_jobs j ON j.asset_id=e.asset_id AND j.source_generation=e.source_generation
        WHERE j.state<>'superseded' ORDER BY e.asset_id,e.generation,e.id
    """)
    by_asset, bundles = defaultdict(list), defaultdict(list)
    for item in evidence:
        try:
            item["time"] = timestamp(item["created_at"])
        except (ValueError, TypeError):
            continue
        by_asset[item["asset_id"]].append(item)
    for row in records(connection, "SELECT evidence_id,target_id FROM character_autotag_predictions"):
        bundles[row["evidence_id"]].append(row)
    parsed, rows = {}, []
    for (target, asset_id), label in sorted(latest.items()):
        target_info = targets.get(target)
        if target_info is None or (series_id is not None and target_info["series_classification_id"] != series_id):
            continue
        if label["origin"] != "manual" or label["decision"] not in ("accepted", "rejected"):
            excluded["no_current_manual_label"] += 1
            continue
        asset = assets.get(asset_id)
        if (not asset or asset["status"] != "normal" or asset["media_kind"] != "image"
                or not is_hash(asset["content_hash"]) or asset["content_hash"] != label["asset_hash"]):
            excluded["unavailable_or_changed_content"] += 1
            continue
        feedback = first_manual.get((target, asset_id, label["asset_hash"]))
        if feedback is None or label["time"] is None:
            excluded["invalid_timestamp"] += 1
            continue
        candidates = [e for e in by_asset[asset_id] if e["content_hash"] == asset["content_hash"]
                      and e["time"] < feedback and any(p["target_id"] == target for p in bundles[e["id"]])]
        if not candidates:
            excluded["no_pre_feedback_evidence"] += 1
            continue
        chosen = max(candidates, key=lambda e: (e["time"], e["generation"], e["id"]))
        ident = chosen["id"]
        if ident not in parsed:
            try:
                bundle = {}
                selected_predictions = records(connection, "SELECT target_id,result_json FROM character_autotag_predictions WHERE evidence_id=? ORDER BY target_id", (ident,))
                for prediction in selected_predictions:
                    payload = json.loads(prediction["result_json"])
                    name = prediction["target_id"]
                    if (name in bundle or payload.get("assetId") != asset_id
                            or payload.get("contentHash") != asset["content_hash"]
                            or payload.get("state") not in ("recommended", "unmatched")):
                        raise ValueError("Invalid prediction identity")
                    bundle[name] = payload["evidence"]
                prior = {}
                for decision in histories[asset_id]:
                    if (decision["time"] is not None and decision["time"] < chosen["time"]
                            and decision["asset_hash"] == asset["content_hash"]):
                        prior[decision["target_id"]] = decision["decision"]
                automatic_targets(bundle, prior, asset["content_hash"], policy)
                parsed[ident] = bundle, prior
            except (ValueError, TypeError, KeyError, AttributeError):
                parsed[ident] = None
        if parsed[ident] is None:
            excluded["malformed_bundle"] += 1
            continue
        bundle, prior = parsed[ident]
        rows.append({
            "asset": asset_id, "content_hash": asset["content_hash"], "target": target,
            "target_name": target_info["display_name"], "series": target_info["series_classification_id"],
            "label": int(label["decision"] == "accepted"), "label_sequence": label["sequence"],
            "observed_at": iso(chosen["time"]), "labeled_at": iso(label["time"]),
            "evidence_id": ident, "runtime_fingerprint": chosen["runtime_fingerprint"],
            "bundle": bundle, "prior_decisions": prior,
        })
    reference_hashes = {h for row in rows for e in row["bundle"].values() for h in e["referenceHashes"]}
    hashes = reference_hashes | {row["content_hash"] for row in rows}
    groups, missing_pdq = duplicate_groups(hashes, assets, near_distance, minimum_quality)
    reference_groups = {groups[h] for h in reference_hashes}
    grouped = defaultdict(list)
    for row in rows:
        grouped[groups[row["content_hash"]]].append(row)
    included = []
    for group, members in sorted(grouped.items()):
        if group in reference_groups:
            excluded["reference_overlap"] += len(members)
            continue
        if all(timestamp(row["labeled_at"]) < boundary for row in members):
            partition = "calibration"
        elif all(timestamp(row["observed_at"]) >= boundary for row in members):
            partition = "holdout"
        else:
            excluded["crosses_cutoff"] += len(members)
            continue
        by_target = defaultdict(list)
        for row in members:
            by_target[row["target"]].append(row)
        for target_rows in by_target.values():
            if len({row["label"] for row in target_rows}) != 1:
                excluded["conflicting_duplicate_labels"] += len(target_rows)
                continue
            row = min(target_rows, key=lambda r: (r["observed_at"], r["label_sequence"], r["asset"]))
            included.append({**row, "partition": partition, "duplicate_group": group})
            excluded["duplicate_pairs"] += len(target_rows) - 1
    data = {
        "schema_version": SCHEMA_VERSION, "cutoff": iso(boundary), "series_scope": series_id,
        "policy": policy, "database_schema_version": connection.execute("PRAGMA user_version").fetchone()[0],
        "max_decision_sequence": max((d["sequence"] for d in decisions), default=0),
        "grouping": {"near_distance": near_distance, "minimum_quality": minimum_quality,
                     "missing_usable_pdq_hashes": missing_pdq, "hash_count": len(hashes),
                     "near_duplicate_check_complete": missing_pdq == 0},
        "evidence_identity": {
            "rows_without_baseline_fingerprint": sum(
                any("baselineFingerprint" not in e for e in row["bundle"].values()) for row in included),
        },
        "excluded": dict(sorted((key, count) for key, count in excluded.items() if count)),
        "rows": sorted(included, key=lambda r: (r["partition"], r["asset"], r["target"])),
        "warnings": [
            "Explicitly reviewed pairs are a selected sample, not the whole library.",
            "Historical replay does not establish prospective accuracy of a previously tuned policy.",
            "Near-duplicate screening covers stored 256-bit PDQ fingerprints meeting the quality floor.",
            "Native byte/scope fences and model extraction are not executed by this evaluator.",
        ],
    }
    return {"dataset": data, "sha256": hashlib.sha256(canonical(data)).hexdigest()}
