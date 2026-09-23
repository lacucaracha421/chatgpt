"""Read-only prospective S36 agreement report; never opens a library database."""
import argparse
from collections import defaultdict
import json
from pathlib import Path
import sqlite3

from replay_dataset import load_dataset, outside_library, save_exclusive
from replay_eval import time_ns

VERDICTS = ("automatic", "recommended", "none", "abstain")


def report(cache, dataset):
    data = load_dataset(dataset)["dataset"]
    # Only the named disposable database is accepted, even if another DB happens
    # to have a scores table. Derive the library root from its canonical location.
    cache = Path(cache).resolve(strict=True)
    if cache.name != "s36_shadow.sqlite" or cache.parent.name != "characters" or cache.parent.parent.name != ".cache":
        raise ValueError("Expected <library>/.cache/characters/s36_shadow.sqlite")
    library = cache.parent.parent.parent
    if library != Path(data["library_root"]).resolve():
        raise ValueError("Cache and export must describe the same library")
    assets = {row["id"]: row for row in data["assets"]}
    labels = defaultdict(list)
    for row in sorted(data["decisions"], key=lambda row: row["sequence"]):
        if row["origin"] == "manual":
            labels[(row["source_asset_id"], row["asset_hash"], row["target_id"])].append(row)
    connection = sqlite3.connect(cache.as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        rows = [dict(row) for row in connection.execute("SELECT * FROM scores")]
    finally:
        connection.close()
    policies = {}
    for row in rows:
        if row["verdict"] not in VERDICTS:
            raise ValueError("Unknown shadow verdict")
        key = row["policy_version"] + ":" + row["feature_id"]
        bucket = policies.setdefault(key, {"verdicts": {v: dict(recorded=0, accepted=0, rejected=0, unreviewed=0) for v in VERDICTS},
                                           "native_comparison": {}})
        label = "unreviewed"
        asset = assets.get(row["asset_id"])
        later = [event for event in labels[(row["asset_id"], row["content_hash"], row["target_id"])]
                 if time_ns(event["created_at"]) > time_ns(row["scored_at"])]
        if (asset and asset["content_hash"] == row["content_hash"] and asset["status"] == "normal"
                and asset["media_kind"] == "image" and later and later[-1]["decision"] in ("accepted", "rejected")):
            label = later[-1]["decision"]
        counts = bucket["verdicts"][row["verdict"]]
        counts["recorded"] += 1
        counts[label] += 1
        comparison = bucket["native_comparison"].setdefault(row["native_outcome"], {})
        counts = comparison.setdefault(row["verdict"], dict(recorded=0, accepted=0, rejected=0, unreviewed=0))
        counts["recorded"] += 1
        counts[label] += 1
    for bucket in policies.values():
        for verdict, metric in (("automatic", "automatic_precision"), ("recommended", "recommendation_acceptance_rate")):
            counts = bucket["verdicts"][verdict]
            reviewed = counts["accepted"] + counts["rejected"]
            bucket[metric] = counts["accepted"] / reviewed if reviewed else None
        comparable = agreed = 0
        native_verdict = {"accepted_automatic": "automatic", "recommended": "recommended", "none": "none"}
        for outcome, verdicts in bucket["native_comparison"].items():
            if outcome in native_verdict:
                for verdict, counts in verdicts.items():
                    if verdict != "abstain":
                        comparable += counts["recorded"]
                        if verdict == native_verdict[outcome]:
                            agreed += counts["recorded"]
        bucket["agreement"] = {"comparable": comparable, "agreed": agreed,
                               "rate": agreed / comparable if comparable else None}
    return {"policies": policies, "recorded": len(rows),
            "label_rule": "Latest later manual judgment of the same asset/hash/target; clears, stale assets and unreviewed automatic decisions are not labels.",
            "rate_denominator": "Later manually accepted plus rejected rows only; selected review evidence, not population accuracy."}, library


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    try:
        # Check before opening anything that could emit an output.
        data = load_dataset(args.dataset)["dataset"]
        if args.output:
            outside_library(args.output, data["library_root"])
        result, library = report(args.cache, args.dataset)
        if args.output:
            save_exclusive(result, args.output, library)
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        parser.exit(2, f"Shadow report failed: {error}\n")


if __name__ == "__main__":
    main()
