"""Read-only offline replay of character rule variants over stored predictions.

Never writes the library. Recomputes the decision predicate from the reference
distances already stored in character_autotag_predictions, so no model inference,
no cache invalidation and no re-extraction are involved.

Usage:
    python shadow_rule_replay.py --database <library.sqlite> [--folds 5] [--seed 7]
"""
from __future__ import annotations

import argparse
import json
import random
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--database", type=Path, required=True)
    p.add_argument("--folds", type=int, default=5)
    p.add_argument("--seed", type=int, default=7)
    return p.parse_args()


# ---------------------------------------------------------------- evidence load

def load(connection):
    """Latest non-superseded prediction per (target, asset), joined to human labels."""
    sql = """
    WITH latest AS (
      SELECT p.target_id, e.asset_id, p.result_json,
             ROW_NUMBER() OVER (
               PARTITION BY p.target_id, e.asset_id
               ORDER BY e.generation DESC, e.id DESC) AS rank
      FROM character_autotag_predictions p
      JOIN character_autotag_evidence e ON e.id = p.evidence_id
      JOIN character_autotag_jobs j
        ON j.asset_id = e.asset_id AND j.source_generation = e.source_generation
      WHERE j.state <> 'superseded'
    ), label AS (
      SELECT d.target_id, d.source_asset_id, d.decision,
             ROW_NUMBER() OVER (
               PARTITION BY d.target_id, d.source_asset_id
               ORDER BY d.sequence DESC) AS rank
      FROM character_decisions d
      WHERE d.origin = 'manual' AND d.decision IN ('accepted', 'rejected')
    )
    SELECT l.target_id, l.source_asset_id, l.decision, latest.result_json
    FROM label l JOIN latest
      ON latest.target_id = l.target_id AND latest.asset_id = l.source_asset_id
    WHERE l.rank = 1 AND latest.rank = 1
    """
    rows = []
    for target_id, asset_id, decision, raw in connection.execute(sql):
        try:
            payload = json.loads(raw)
        except ValueError:
            continue
        evidence = payload.get("evidence")
        if not isinstance(evidence, dict):
            continue
        crops = evidence.get("evidence")
        if not isinstance(crops, list) or not crops:
            continue
        distances = []
        for crop in crops:
            values = crop.get("referenceDistances") if isinstance(crop, dict) else None
            if isinstance(values, list) and len(values) >= 2:
                distances.append([float(v) for v in values])
        if not distances:
            continue
        rows.append({
            "target": target_id,
            "asset": asset_id,
            "label": 1 if decision == "accepted" else 0,
            "crops": distances,
            "stored_state": payload.get("state"),
        })
    return rows


# ------------------------------------------------------------------- predicates

def best_two(distances):
    """Per-reference minimum across crops, then the two closest references."""
    width = min(len(row) for row in distances)
    per_reference = [min(row[i] for row in distances) for i in range(width)]
    ordered = sorted(per_reference)
    return ordered[0], ordered[1]


def score(rows, rule):
    """Return (tp, fp, fn, tn) for a rule callable(row) -> bool (auto-accept)."""
    tp = fp = fn = tn = 0
    for row in rows:
        accept = rule(row)
        if accept and row["label"] == 1:
            tp += 1
        elif accept and row["label"] == 0:
            fp += 1
        elif not accept and row["label"] == 1:
            fn += 1
        else:
            tn += 1
    return tp, fp, fn, tn


def prf(tp, fp, fn):
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return precision, recall, f1


def fmt(name, tp, fp, fn, tn):
    precision, recall, f1 = prf(tp, fp, fn)
    return (f"{name:<38} {precision:>6.3f} {recall:>6.3f} {f1:>6.3f}"
            f"   {tp:>4}/{fp:>4}/{fn:>4}/{tn:>4}")


# ---------------------------------------------------------------- rule families

def rule_second_min(t, k=2):
    return lambda row: best_two(row["crops"])[1] <= t


def rule_first_min(t):
    return lambda row: best_two(row["crops"])[0] <= t


def rule_support(t, minimum):
    """Fraction-of-references form: how many references are within t."""
    def decide(row):
        width = min(len(r) for r in row["crops"])
        per_reference = [min(r[i] for r in row["crops"]) for i in range(width)]
        return sum(1 for v in per_reference if v <= t) >= minimum
    return decide


def rule_mean(t):
    def decide(row):
        width = min(len(r) for r in row["crops"])
        per_reference = [min(r[i] for r in row["crops"]) for i in range(width)]
        return sum(per_reference) / len(per_reference) <= t
    return decide


def tune(rows, factory, grid, folds, seed):
    """Honest k-fold: pick the grid point on train, score on held-out."""
    rng = random.Random(seed)
    index = list(range(len(rows)))
    rng.shuffle(index)
    buckets = [index[i::folds] for i in range(folds)]
    tp = fp = fn = tn = 0
    chosen = Counter()
    for k in range(folds):
        held = set(buckets[k])
        train = [rows[i] for i in range(len(rows)) if i not in held]
        holdout = [rows[i] for i in buckets[k]]
        best = None
        for params in grid:
            rule = factory(*params) if isinstance(params, tuple) else factory(params)
            got = score(train, rule)
            _, _, f1 = prf(*got[:3])
            if best is None or f1 > best[0]:
                best = (f1, params)
        chosen[best[1]] += 1
        rule = factory(*best[1]) if isinstance(best[1], tuple) else factory(best[1])
        got = score(holdout, rule)
        tp += got[0]; fp += got[1]; fn += got[2]; tn += got[3]
    return tp, fp, fn, tn, chosen


def main():
    args = parse_args()
    connection = sqlite3.connect(f"file:{args.database}?mode=ro", uri=True)
    rows = load(connection)
    connection.close()

    positives = sum(r["label"] for r in rows)
    print(f"labeled pairs with replayable evidence: {len(rows)}"
          f"  (accepted={positives}, rejected={len(rows) - positives})")
    print(f"targets: {len({r['target'] for r in rows})}")
    print(f"folds={args.folds} seed={args.seed}\n")

    print(f"{'rule':<38} {'prec':>6} {'rec':>6} {'F1':>6}   {'TP/FP/FN/TN'}")
    print("-" * 78)

    # 1. Current stored threshold, in-sample (this is what production does today).
    got = score(rows, rule_second_min(0.21323118981474148))
    print(fmt("current T=0.2132 (in-sample)", *got))

    # 2. Per-target grid sweep, in-sample (upper bound, overfits).
    grid = [round(0.04 + 0.002 * i, 4) for i in range(120)]
    best = None
    for t in grid:
        got = score(rows, rule_second_min(t))
        _, _, f1 = prf(*got[:3])
        if best is None or f1 > best[0]:
            best = (f1, t, got)
    f1, t, got = best
    print(fmt(f"global T={t} (in-sample oracle)", *got))

    # 3. Honest cross-validation for the three rule families.
    print()
    for name, factory, space in (
        ("global T (5-fold CV)", rule_second_min, grid),
        ("support>=k of 5 (5-fold CV)", None, None),
    ):
        if name.startswith("support"):
            space = [(t, k) for t in grid for k in (1, 2, 3, 4)]
            tp, fp, fn, tn, chosen = tune(rows, rule_support, space, args.folds, args.seed)
            top = ", ".join(f"T={p[0]},k={p[1]}" for p, _ in chosen.most_common(3))
        else:
            tp, fp, fn, tn, chosen = tune(rows, factory, space, args.folds, args.seed)
            top = ", ".join(f"T={p}" for p, _ in chosen.most_common(3))
        print(fmt(name, tp, fp, fn, tn))
        print(f"{'  chosen per fold: ' + top:<38}")

    # 4. Per-target thresholds, honest CV.
    by_target = defaultdict(list)
    for i, row in enumerate(rows):
        by_target[row["target"]].append(i)
    rng = random.Random(args.seed)
    assignment = {}
    for target, indices in by_target.items():
        rng.shuffle(indices)
        for pos, i in enumerate(indices):
            assignment[i] = pos % args.folds
    tp = fp = fn = tn = 0
    fallback = 0
    for k in range(args.folds):
        train = [rows[i] for i in range(len(rows)) if assignment[i] != k]
        holdout = [rows[i] for i in range(len(rows)) if assignment[i] == k]
        per_target = {}
        for target in {r["target"] for r in train}:
            items = [r for r in train if r["target"] == target]
            if len(items) < 8:
                continue
            local = None
            for t in grid:
                got = score(items, rule_second_min(t))
                _, _, f1 = prf(*got[:3])
                if local is None or f1 > local[0]:
                    local = (f1, t)
            if local:
                per_target[target] = local[1]
        for row in holdout:
            t = per_target.get(row["target"])
            if t is None:
                fallback += 1
                t = 0.21323118981474148
            accept = best_two(row["crops"])[1] <= t
            if accept and row["label"] == 1:
                tp += 1
            elif accept:
                fp += 1
            elif row["label"] == 1:
                fn += 1
            else:
                tn += 1
    print(fmt("per-target T (5-fold CV)", tp, fp, fn, tn))
    print(f"{'  targets falling back to global: ' + str(fallback):<38}")


if __name__ == "__main__":
    main()
