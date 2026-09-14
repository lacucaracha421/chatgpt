"""Offline character benchmark CLI: freeze once, replay the same evidence."""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
from holdout_dataset import build_dataset, load_frozen, open_readonly, save_exclusive, verify_frozen
from holdout_rules import automatic_targets, current_policy, recommendation


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def metrics(rows, key):
    counts = Counter("tp" if row[key] and row["label"] else
                     "fp" if row[key] else "fn" if row["label"] else "tn" for row in rows)
    tp, fp, fn, tn = (counts[name] for name in ("tp", "fp", "fn", "tn"))
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn,
            "precision": ratio(tp, tp+fp), "recall": ratio(tp, tp+fn),
            "f1": ratio(2*tp, 2*tp+fp+fn),
            "accepted_labeled_pair_fraction": ratio(tp+fp, len(rows)),
            "false_positives_per_1000_labeled_pairs": ratio(1000*fp, len(rows))}


def summarize(rows):
    return {"labeled_pairs": len(rows), "automatic": metrics(rows, "auto"),
            "recommendation": metrics(rows, "recommended")}

def evaluate(envelope: dict, partition: str = "holdout", policy: dict | None = None) -> dict:
    data = verify_frozen(envelope)
    if partition not in ("calibration", "holdout"):
        raise ValueError("Choose calibration or holdout")
    policy = policy or data["policy"]
    # Compatibility follows semantic baseline identity, not platform line endings.
    if policy["baseline_fingerprint"] != data["policy"]["baseline_fingerprint"]:
        raise ValueError("Extraction/recommendation baseline changed; old evidence is incompatible")
    scored, targets, series, slices = [], defaultdict(list), defaultdict(list), defaultdict(list)
    for row in data["rows"]:
        if row["partition"] != partition:
            continue
        if type(row["label"]) is not int or row["label"] not in (0, 1):
            raise ValueError("Ground truth must be an explicit binary label")
        e = row["bundle"][row["target"]]
        accepted = automatic_targets(row["bundle"], row["prior_decisions"], row["content_hash"], policy)
        result = {**row, "auto": row["target"] in accepted, "recommended": recommendation(e, policy)}
        scored.append(result)
        targets[row["target"]].append(result)
        series[row["series"] or "unassigned"].append(result)
        count = len(e["referenceHashes"])
        labels = ["whole_fallback" if e["wholeFallback"] else
                  "multiple_people" if len(e["queryBoxes"]) > 1 else "single_person",
                  "references_5" if count == 5 else "references_6_to_10" if count <= 10 else "references_11_to_25",
                  "runtime:" + row["runtime_fingerprint"]]
        for label in labels:
            slices[label].append(result)
    per_target = {key: {"name": values[0]["target_name"], **summarize(values)}
                  for key, values in sorted(targets.items())}
    macro = {}
    for metric in ("precision", "recall", "f1"):
        supported = [result["automatic"][metric] for result in per_target.values()
                     if result["automatic"][metric] is not None]
        macro[metric] = ratio(sum(supported), len(supported))
        macro[metric + "_targets"] = len(supported)
    sources = ["character_holdout.py", "holdout_dataset.py", "holdout_rules.py"]
    source_hashes = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                     for name in sources}
    return {
        "dataset_sha256": envelope["sha256"], "partition": partition, "cutoff": data["cutoff"],
        "policy": policy, "evaluator_sources": source_hashes, **summarize(scored),
        "distinct_assets": len({row["asset"] for row in scored}), "per_target": per_target,
        "per_series": {key: summarize(values) for key, values in sorted(series.items())},
        "slices": {key: summarize(values) for key, values in sorted(slices.items())},
        "macro_automatic": macro, "excluded": data["excluded"], "grouping": data["grouping"],
        "warnings": data["warnings"], "evidence_identity": data["evidence_identity"],
        "denominator": "Explicit manually labeled pairs with eligible pre-feedback evidence, after duplicate/reference exclusions.",
        "whole_library_coverage": None,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    freeze = commands.add_parser("freeze", help="Export a read-only database snapshot")
    freeze.add_argument("--database", type=Path, required=True)
    freeze.add_argument("--output", type=Path, required=True)
    freeze.add_argument("--cutoff", required=True, help="ISO timestamp including timezone")
    freeze.add_argument("--near-distance", type=int, default=30)
    freeze.add_argument("--minimum-quality", type=int, default=50)
    freeze.add_argument("--series-id", help="Optional bounded series scope")
    replay = commands.add_parser("evaluate", help="Replay immutable evidence without opening SQLite")
    replay.add_argument("--dataset", type=Path, required=True)
    replay.add_argument("--partition", choices=("calibration", "holdout"), default="holdout")
    replay.add_argument("--policy", choices=("frozen", "current"), default="frozen")
    replay.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "freeze":
            with open_readonly(args.database) as connection:
                frozen = build_dataset(connection, args.cutoff, near_distance=args.near_distance,
                                       minimum_quality=args.minimum_quality, series_id=args.series_id)
            save_exclusive(frozen, args.output, args.database)
            print(json.dumps({"sha256": frozen["sha256"],
                              "pairs": len(frozen["dataset"]["rows"]),
                              "excluded": frozen["dataset"]["excluded"]}, indent=2))
        else:
            frozen = load_frozen(args.dataset)
            report = evaluate(frozen, args.partition, current_policy() if args.policy == "current" else None)
            if args.output:
                save_exclusive(report, args.output)
            else:
                print(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False))
        return 0
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error) as error:
        print(f"Character evaluation failed: {error}", file=sys.stderr)
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
