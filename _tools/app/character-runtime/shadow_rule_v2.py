"""Read-only shadow evaluator for Lakomics character rule v2.

This tool never writes the library. It compares the current flat positive-support
rule with an experimental compact-positive-mode rule over latest human labels.
Production geometry arbitration is intentionally not reproduced here, so results
are comparative score evidence rather than production precision estimates.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from pathlib import Path
import sqlite3

import numpy as np
import onnxruntime as ort

from runtime import BASELINE


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--database", type=Path, required=True)
    p.add_argument("--cache", type=Path, required=True)
    p.add_argument("--models", type=Path, required=True)
    p.add_argument("--target", default=None, help="optional target display name")
    p.add_argument("--mode-eps", type=float, default=0.14)
    p.add_argument("--auto-distance", type=float, default=0.15)
    return p.parse_args()


class Evaluator:
    def __init__(self, database: Path, cache: Path, models: Path):
        self.database = database
        roots = [p for p in cache.iterdir() if p.is_dir() and len(p.name) == 64]
        roots.sort(key=lambda p: sum(1 for _ in p.glob("*.npz")), reverse=True)
        self.cache_index = {}
        for root in roots[:8]:
            for path in root.glob("*.npz"):
                self.cache_index.setdefault(path.stem, path)
        opts = ort.SessionOptions()
        opts.intra_op_num_threads, opts.inter_op_num_threads = 6, 1
        self.metric = ort.InferenceSession(
            str(models / "model_metrics.onnx"), sess_options=opts,
            providers=["CPUExecutionProvider"],
        )
        self.input_name = self.metric.get_inputs()[0].name
        self.features = {}
        self.pair_distances = {}

    def feature(self, digest: str):
        if digest in self.features:
            return self.features[digest]
        path = self.cache_index.get(digest)
        if path is None:
            self.features[digest] = None
            return None
        try:
            with np.load(path, allow_pickle=False) as data:
                value = data["vectors"].astype(np.float32)
            if value.ndim != 2 or not len(value) or not np.isfinite(value).all():
                value = None
        except (OSError, ValueError, KeyError, EOFError):
            value = None
        self.features[digest] = value
        return value

    def distance(self, left: str, right: str):
        if left == right:
            return 0.0
        key = tuple(sorted((left, right)))
        if key in self.pair_distances:
            return self.pair_distances[key]
        a, b = self.feature(left), self.feature(right)
        if a is None or b is None:
            return None
        stack = np.concatenate([a, b])
        raw = self.metric.run(["output"], {self.input_name: stack})[0]
        value = float(raw[: len(a), len(a) :].min())
        self.pair_distances[key] = value
        return value

    def modes(self, hashes: list[str], eps: float):
        """Complete-link agglomeration prevents one bridge from merging distant modes."""
        clusters = [[i] for i in range(len(hashes))]
        while True:
            best = None
            for a in range(len(clusters)):
                for b in range(a + 1, len(clusters)):
                    values = []
                    valid = True
                    for i in clusters[a]:
                        for j in clusters[b]:
                            d = self.distance(hashes[i], hashes[j])
                            if d is None:
                                valid = False
                                break
                            values.append(d)
                        if not valid:
                            break
                    if not valid or not values:
                        continue
                    maximum = max(values)
                    if maximum <= eps and (best is None or maximum < best[0]):
                        best = (maximum, a, b)
            if best is None:
                return clusters
            _, a, b = best
            clusters[a].extend(clusters[b])
            del clusters[b]

    @staticmethod
    def labels(connection, target_id):
        sql = """SELECT d.source_asset_id,d.decision,a.content_hash
            FROM character_decisions d JOIN assets a ON a.id=d.source_asset_id
            WHERE d.target_id=?1 AND d.origin='manual'
              AND a.status='normal' AND a.media_kind='image'
              AND d.decision IN ('accepted','rejected')
              AND NOT EXISTS(SELECT 1 FROM character_decisions newer
                WHERE newer.target_id=d.target_id
                  AND newer.source_asset_id=d.source_asset_id
                  AND newer.sequence>d.sequence)"""
        return [dict(asset=r[0], label=r[1], hash=r[2])
                for r in connection.execute(sql, (target_id,))]

    @staticmethod
    def references(connection, target_id):
        return [(r[0], r[1]) for r in connection.execute(
            "SELECT asset_id,asset_hash FROM character_references "
            "WHERE target_id=?1 AND asset_id IS NOT NULL ORDER BY slot", (target_id,))]

    @staticmethod
    def learned(connection, target_id):
        return [(r[0], r[1]) for r in connection.execute(
            "SELECT l.asset_id,l.asset_hash FROM character_learned_references l "
            "JOIN assets a ON a.id=l.asset_id "
            "WHERE l.target_id=?1 AND a.status='normal' AND a.media_kind='image' "
            "AND a.content_hash=l.asset_hash ORDER BY l.created_at,l.asset_id",
            (target_id,),
        )]

    def evaluate(self, target_name: str | None, mode_eps: float, auto_distance: float):
        uri = f"file:{self.database}?mode=ro"
        connection = sqlite3.connect(uri, uri=True)
        query = "SELECT id,display_name FROM character_targets WHERE enabled=1"
        args = []
        if target_name:
            query += " AND display_name=?1"
            args.append(target_name)
        targets = list(connection.execute(query, args))
        total = Counter()
        per_target = defaultdict(Counter)
        threshold = float(BASELINE["threshold"])
        for target_id, name in targets:
            anchors = self.references(connection, target_id)
            if len(anchors) != 5:
                continue
            refs, seen = [], set()
            for asset_id, digest in anchors + self.learned(connection, target_id):
                if digest not in seen and self.feature(digest) is not None:
                    refs.append((asset_id, digest))
                    seen.add(digest)
            labels = self.labels(connection, target_id)
            negatives = [row for row in labels
                         if row["label"] == "rejected" and self.feature(row["hash"]) is not None]
            for row in labels:
                if self.feature(row["hash"]) is None:
                    continue
                usable = [ref for ref in refs if ref[1] != row["hash"]]
                if len(usable) < 3:
                    continue
                hashes = [digest for _, digest in usable]
                distances = [self.distance(row["hash"], digest) for digest in hashes]
                if any(value is None for value in distances):
                    continue
                distances = [float(value) for value in distances]
                support = sum(value <= threshold for value in distances)
                mode_support = max(
                    (sum(distances[index] <= threshold for index in mode)
                     for mode in self.modes(hashes, mode_eps)), default=0,
                )
                second_positive = sorted(distances)[1]
                negative_distances = sorted(
                    value for negative in negatives if negative["hash"] != row["hash"]
                    for value in [self.distance(row["hash"], negative["hash"])]
                    if value is not None
                )
                second_negative = negative_distances[1] if len(negative_distances) >= 2 else None
                v1 = support >= 3
                shadow = support >= 3 and mode_support >= 2 and second_positive <= auto_distance
                negative_risk = second_negative is not None and second_negative < second_positive
                for rule, value in (("v1", v1), ("shadow", shadow), ("negativeRisk", negative_risk)):
                    total[(rule, row["label"], bool(value))] += 1
                    per_target[name][(rule, row["label"], bool(value))] += 1
        connection.close()
        return total, per_target


def metrics(counter, rule):
    tp = counter[(rule, "accepted", True)]
    fp = counter[(rule, "rejected", True)]
    fn = counter[(rule, "accepted", False)]
    tn = counter[(rule, "rejected", False)]
    precision = tp / (tp + fp) if tp + fp else 0.0
    return dict(tp=tp, fp=fp, fn=fn, tn=tn, precision=round(precision, 4))


def main():
    args = parse_args()
    evaluator = Evaluator(args.database, args.cache, args.models)
    total, per_target = evaluator.evaluate(args.target, args.mode_eps, args.auto_distance)
    print("v1", metrics(total, "v1"))
    print("shadow", metrics(total, "shadow"))
    print("negativeRisk", {
        "accepted": total[("negativeRisk", "accepted", True)],
        "rejected": total[("negativeRisk", "rejected", True)],
    })
    for name in sorted(per_target):
        print(name, "v1", metrics(per_target[name], "v1"),
              "shadow", metrics(per_target[name], "shadow"))


if __name__ == "__main__":
    main()
