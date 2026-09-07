"""Time-ordered evaluation of whole, crop-min, and 2-of-N crop consensus."""
import json
from pathlib import Path

import numpy as np

import crop_consensus as cc

HERE = Path(__file__).resolve().parent


def batch_stats(ids, scores, threshold):
    positives = {i for i in ids if cc.DATA["items"][i]["positive"]}
    predicted = {i for i in ids if scores[i] <= threshold}
    return {
        "count": len(ids), "positives": len(positives), "negatives": len(ids) - len(positives),
        "tp": len(predicted & positives), "fp": len(predicted - positives),
        "fn": len(positives - predicted), "predicted": sorted(predicted),
    }


def main():
    features, _, crop_groups = cc.load_features()
    raw = cc.raw_metric(features)
    threshold = float(cc.DATA["threshold"])
    refs = cc.DATA["referencePool"][:5]
    ref_groups = [crop_groups[i] for i in refs]
    whole = np.asarray(cc.DATA["distances"], dtype=np.float32)
    crop = np.asarray(cc.CROP["matrices"]["crop"], dtype=np.float32)
    scores = {
        "whole": {i: float(whole[i, refs].min()) for i in range(len(cc.DATA["items"]))},
        "cropMin": {i: float(crop[i, refs].min()) for i in range(len(cc.DATA["items"]))},
        "consensus2": {i: cc.consensus_score(raw, crop_groups[i], ref_groups, 2)
                       for i in range(len(cc.DATA["items"]))},
    }
    batches = {
        "initialHeldOut": [i for i in range(144) if i not in refs],
        "append55": list(range(144, 199)),
        "append4": list(range(199, 203)),
        "append9": list(range(203, 212)),
    }
    result = {"threshold": threshold, "refs": refs, "batches": {}}
    for batch, ids in batches.items():
        result["batches"][batch] = {name: batch_stats(ids, values, threshold)
                                      for name, values in scores.items()}
    (HERE / "crop-timeline-report.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__": main()
