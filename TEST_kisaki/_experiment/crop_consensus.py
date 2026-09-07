"""Analyze same-crop multi-reference consensus without changing the review dataset."""
import hashlib
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = json.loads((HERE / "public" / "data.json").read_text(encoding="utf-8"))
CROP = json.loads((HERE / "public" / "crop-data.json").read_text(encoding="utf-8"))


def identities():
    ccip = hashlib.sha256(json.dumps(DATA["model"], sort_keys=True).encode()).hexdigest()[:16]
    detector = CROP["detector"]["sha256"][:16]
    return detector, ccip


def load_features():
    detector, ccip = identities()
    features, whole_groups, crop_groups = [], [], []
    for item, crop_item in zip(DATA["items"], CROP["items"]):
        whole = HERE / "cache" / f"{ccip}-{item['sha256']}.npy"
        wi = len(features); features.append(np.load(whole, allow_pickle=False)); whole_groups.append([wi])
        group = []
        for det in crop_item["detections"]:
            coord = "-".join(map(str, det["expandedBox"]))
            path = HERE / "crop-cache" / f"{detector}-{ccip}-{item['sha256']}-{coord}.npy"
            if not path.exists(): raise RuntimeError(f"Missing crop cache: {path.name}")
            group.append(len(features)); features.append(np.load(path, allow_pickle=False))
        crop_groups.append(group or [wi])
    return np.stack(features).astype(np.float32), whole_groups, crop_groups


def raw_metric(features):
    options = ort.SessionOptions(); options.intra_op_num_threads = 4; options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(HERE / "models" / "model_metrics.onnx"), sess_options=options,
                                   providers=["CPUExecutionProvider"])
    return session.run(["output"], {"input": features})[0]


def consensus_score(raw, query_group, ref_groups, required):
    required = min(required, len(ref_groups))
    scores = []
    for qi in query_group:
        per_ref = [float(raw[qi, group].min()) for group in ref_groups]
        scores.append(sorted(per_ref)[required - 1])
    return min(scores)


def simple_min_score(matrix, item_id, refs):
    return float(matrix[item_id, refs].min())


def stats(scores, ids, threshold):
    predicted = {i for i in ids if scores[i] <= threshold}
    positives = {i for i in ids if DATA["items"][i]["positive"]}
    tp = len(predicted & positives); fp = len(predicted - positives); fn = len(positives - predicted)
    return {"tp": tp, "fp": fp, "fn": fn, "predicted": sorted(predicted)}


def average_precision(scores, ids):
    ranked = sorted(ids, key=lambda i: scores[i])
    positives = sum(bool(DATA["items"][i]["positive"]) for i in ids)
    if not positives: return None
    hits = 0; total = 0.0
    for rank, item_id in enumerate(ranked, 1):
        if DATA["items"][item_id]["positive"]:
            hits += 1; total += hits / rank
    return total / positives


def main():
    features, whole_groups, crop_groups = load_features()
    raw = raw_metric(features)
    threshold = float(DATA["threshold"])
    whole = np.asarray(DATA["distances"], dtype=np.float32)
    crop_matrix = np.asarray(CROP["matrices"]["crop"], dtype=np.float32)
    used_groups = {DATA["items"][i]["duplicateGroup"] for i in DATA["referencePool"]}
    held = [x["id"] for x in DATA["items"] if x["duplicateGroup"] not in used_groups]
    latest = list(DATA.get("latestAppend", {}).get("newIds", []))
    result = {"threshold": threshold, "latestIds": latest, "strategies": {}}
    for count in (1, 3, 5):
        refs = DATA["referencePool"][:count]
        ref_groups = [crop_groups[i] for i in refs]
        strategies = {
            "wholeMin": {i: simple_min_score(whole, i, refs) for i in held},
            "cropMin": {i: simple_min_score(crop_matrix, i, refs) for i in held},
            "sameCropConsensus1": {i: consensus_score(raw, crop_groups[i], ref_groups, 1) for i in held},
        }
        if count >= 2:
            strategies["sameCropConsensus2"] = {
                i: consensus_score(raw, crop_groups[i], ref_groups, 2) for i in held
            }
        if count >= 3:
            strategies["sameCropConsensus3"] = {
                i: consensus_score(raw, crop_groups[i], ref_groups, 3) for i in held
            }
        result["strategies"][str(count)] = {}
        for name, scores in strategies.items():
            current = stats(scores, held, threshold)
            current["averagePrecision"] = average_precision(scores, held)
            current["latest"] = stats(scores, [i for i in latest if i in scores], threshold)
            result["strategies"][str(count)][name] = current
    path = HERE / "crop-consensus-report.json"
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
