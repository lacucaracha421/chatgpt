"""Fixed-rule independent validation for refs/target/others datasets."""
from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

import analyze
import crop_ccip

HERE = Path(__file__).resolve().parent
THRESHOLD = json.loads((HERE / "models" / "metrics.json").read_text())["threshold"]
SCORE = 0.30
NMS = 0.45
MARGIN = 0.18
MAX_BOXES = 8


def sha(path: Path) -> str:
    return hashlib.file_digest(path.open("rb"), "sha256").hexdigest()


def image_files(root: Path, folder: str) -> list[Path]:
    return sorted(
        [p for p in (root / folder).iterdir() if p.is_file() and p.suffix.lower() in analyze.EXT],
        key=lambda p: p.name.casefold(),
    )

def metric_stats(predicted: set[str], target_keys: list[str], other_keys: list[str]) -> dict:
    target_set = set(target_keys)
    other_set = set(other_keys)
    tp = len(predicted & target_set)
    fp = len(predicted & other_set)
    fn = len(target_keys) - tp
    precision = tp / (tp + fp) if tp + fp else 1.0
    recall = tp / len(target_keys) if target_keys else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "precision": precision, "recall": recall, "f1": f1}


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Run the frozen CCIP crop-consensus validation rule")
    p.add_argument("dataset_root", type=Path, help="Folder containing refs/, target/, and others/")
    p.add_argument("--reference-count", type=int, default=5)
    p.add_argument("--output", type=Path, default=None)
    return p


def main() -> None:
    args = parser().parse_args()
    root = args.dataset_root.resolve()
    folders = {name: image_files(root, name) for name in ("refs", "target", "others")}
    if args.reference_count != 5:
        raise RuntimeError("This frozen rule is defined for exactly 5 references")
    if len(folders["refs"]) < 5:
        raise RuntimeError(f"Expected at least 5 refs, got {len(folders['refs'])}")
    selected_refs = folders["refs"][:5]
    ignored_refs = folders["refs"][5:]
    started = time.perf_counter()
    before = {str(p): sha(p) for group in folders.values() for p in group}
    by_hash: dict[str, list[tuple[str, str]]] = {}
    for folder, group in folders.items():
        for p in group:
            by_hash.setdefault(before[str(p)], []).append((folder, p.name))
    duplicate_leaks = {h: v for h, v in by_hash.items() if len({x[0] for x in v}) > 1}

    manifest = json.loads((HERE / "models" / "manifest.json").read_text())
    detector_manifest = crop_ccip.download_detector()
    identity = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()[:16]
    detector_id = detector_manifest["sha256"][:16]
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 4
    opts.inter_op_num_threads = 1
    feat_session = ort.InferenceSession(
        str(HERE / "models" / "model_feat.onnx"), sess_options=opts, providers=["CPUExecutionProvider"]
    )
    detector = ort.InferenceSession(
        str(crop_ccip.DETECTOR_MODEL), sess_options=opts, providers=["CPUExecutionProvider"]
    )
    metric_session = ort.InferenceSession(
        str(HERE / "models" / "model_metrics.onnx"), sess_options=opts, providers=["CPUExecutionProvider"]
    )
    detector_input = detector.get_inputs()[0].name

    all_features: list[np.ndarray] = []
    whole_idx: dict[str, int] = {}
    crop_groups: dict[str, list[int]] = {}
    records: list[dict] = []
    ordered = [(folder, p) for folder in ("refs", "target", "others") for p in folders[folder]]
    for n, (folder, p) in enumerate(ordered, 1):
        image = analyze.rgb(p)
        digest = before[str(p)]
        whole_cache = HERE / "cache" / f"{identity}-{digest}.npy"
        wi = len(all_features)
        all_features.append(crop_ccip.ccip_feature(feat_session, image, whole_cache))
        whole_idx[str(p)] = wi

        detect_key = f"{detector_id}-{digest}-s{SCORE:.3f}-n{NMS:.3f}.json"
        detect_cache = HERE / "detection-cache" / detect_key
        if detect_cache.exists():
            cached = json.loads(detect_cache.read_text())
            boxes = np.asarray(cached["boxes"], dtype=np.float32).reshape(-1, 4)
            scores = np.asarray(cached["scores"], dtype=np.float32)
        else:
            blob, ratio = crop_ccip.letterbox_bgr(image)
            output = detector.run(None, {detector_input: blob[None]})[0]
            boxes, scores = crop_ccip.decode_yolox(output, image.size, ratio, SCORE, NMS)
            detect_cache.parent.mkdir(exist_ok=True)
            detect_cache.write_text(json.dumps({"boxes": boxes.tolist(), "scores": scores.tolist()}))

        group: list[int] = []
        for di in np.argsort(scores)[::-1][:MAX_BOXES]:
            box = crop_ccip.expanded_box(boxes[int(di)], image.size, MARGIN)
            x0, y0, x1, y1 = box
            if x1 - x0 < 24 or y1 - y0 < 24:
                continue
            cache = HERE / "crop-cache" / f"{detector_id}-{identity}-{digest}-{'-'.join(map(str, box))}.npy"
            group.append(len(all_features))
            all_features.append(crop_ccip.ccip_feature(feat_session, image.crop(box), cache))
        crop_groups[str(p)] = group or [wi]
        records.append({"folder": folder, "name": p.name, "detections": len(group)})
        print(f"{n}/{len(ordered)} {folder}: {len(group)} crop(s)", flush=True)
    stack = np.stack(all_features).astype(np.float32)
    raw = metric_session.run(["output"], {"input": stack})[0]
    if raw.shape != (len(stack), len(stack)) or not np.isfinite(raw).all():
        raise RuntimeError("Invalid metric output")

    refs = [str(p) for p in selected_refs]
    ref_whole = [whole_idx[p] for p in refs]
    ref_groups = [crop_groups[p] for p in refs]
    score_rows: dict[str, dict] = {}
    for folder in ("target", "others"):
        for p in folders[folder]:
            key = str(p)
            qgroup = crop_groups[key]
            whole = float(raw[whole_idx[key], ref_whole].min())
            per_query = []
            for qi in qgroup:
                per_ref = [float(raw[qi, rg].min()) for rg in ref_groups]
                per_query.append((min(per_ref), sorted(per_ref)[1]))
            crop_min = min(x[0] for x in per_query)
            consensus2 = min(x[1] for x in per_query)
            score_rows[key] = {
                "whole": whole,
                "cropMin": crop_min,
                "consensus2": consensus2,
                "guardedScore": min(whole, consensus2),
                "wholePass": whole <= THRESHOLD,
                "consensusPass": consensus2 <= THRESHOLD,
                "guardedPass": whole <= THRESHOLD or consensus2 <= THRESHOLD,
            }

    target_keys = [str(p) for p in folders["target"]]
    other_keys = [str(p) for p in folders["others"]]
    strategies = {}
    predicates = {
        "whole": lambda s: s["wholePass"],
        "cropMin": lambda s: s["cropMin"] <= THRESHOLD,
        "consensus2": lambda s: s["consensusPass"],
        "guardedHybrid": lambda s: s["guardedPass"],
    }
    for name, predicate in predicates.items():
        predicted = {k for k, value in score_rows.items() if predicate(value)}
        strategies[name] = {
            **metric_stats(predicted, target_keys, other_keys),
            "targetFound": [Path(k).name for k in target_keys if k in predicted],
            "targetMissed": [Path(k).name for k in target_keys if k not in predicted],
            "falsePositives": [Path(k).name for k in other_keys if k in predicted],
        }

    ranked = sorted(target_keys + other_keys, key=lambda k: score_rows[k]["consensus2"])
    hits = 0
    consensus_ap = 0.0
    for rank, key in enumerate(ranked, 1):
        if key in target_keys:
            hits += 1
            consensus_ap += hits / rank
    consensus_ap = consensus_ap / len(target_keys) if target_keys else 0.0

    if any(sha(Path(path)) != digest for path, digest in before.items()):
        raise RuntimeError("Source changed during validation")
    report = {
        "datasetRoot": str(root),
        "refs": len(selected_refs),
        "selectedReferenceFiles": [p.name for p in selected_refs],
        "ignoredReferenceFiles": [p.name for p in ignored_refs],
        "target": len(target_keys),
        "othersImages": len(other_keys),
        "threshold": THRESHOLD,
        "fixedConfig": {
            "detectorScore": SCORE,
            "nms": NMS,
            "cropMargin": MARGIN,
            "maxBoxes": MAX_BOXES,
            "rule": "same query crop matches >=2 of 5 reference images within threshold",
        },
        "model": manifest,
        "detector": detector_manifest,
        "crossFolderExactDuplicates": duplicate_leaks,
        "strategies": strategies,
        "consensusAveragePrecision": consensus_ap,
        "detectedImages": sum(r["detections"] > 0 for r in records),
        "multiCharacterImages": sum(r["detections"] >= 2 for r in records),
        "totalCrops": sum(r["detections"] for r in records),
        "elapsedSeconds": round(time.perf_counter() - started, 2),
        "sourcesUnchanged": True,
        "scores": {
            Path(key).name: {**value, "label": "target" if key in target_keys else "other"}
            for key, value in score_rows.items()
        },
    }
    output = args.output.resolve() if args.output else root / "verification-fixed-report.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print("=== FIXED VALIDATION SUMMARY ===")
    print(json.dumps({"strategies": strategies, "consensusAP": consensus_ap,
                      "output": str(output)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
