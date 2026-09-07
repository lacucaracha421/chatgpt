"""Automatic anime-character crop + CCIP A/B experiment.

Keeps the existing whole-image experiment untouched. It downloads a pinned
YOLOX-s anime character detector, extracts padded character crops, embeds them
with the existing CCIP model, and compares whole/crop/hybrid retrieval.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import time
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

import analyze

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PUBLIC = HERE / "public"
DETECTOR_COMMIT = "815aeced8ed86081f251e7383d2a50a5a6d29b54"
DETECTOR_URL = (
    "https://raw.githubusercontent.com/ksasao/anime-character-detector/"
    f"{DETECTOR_COMMIT}/python/character.onnx"
)
DETECTOR_SIZE = 35_791_102
DETECTOR_MODEL = HERE / "models" / "character-detector.onnx"
DETECTOR_MANIFEST = HERE / "models" / "character-detector-manifest.json"


def sha256(path: Path) -> str:
    return hashlib.file_digest(path.open("rb"), "sha256").hexdigest()


def download_detector() -> dict:
    DETECTOR_MODEL.parent.mkdir(exist_ok=True)
    if DETECTOR_MANIFEST.exists() and DETECTOR_MODEL.exists():
        manifest = json.loads(DETECTOR_MANIFEST.read_text(encoding="utf-8"))
        if (
            manifest.get("sha256") == sha256(DETECTOR_MODEL)
            and DETECTOR_MODEL.stat().st_size == manifest.get("sizeBytes")
        ):
            return manifest
    print("Downloading pinned anime character detector ...", flush=True)
    tmp = DETECTOR_MODEL.with_suffix(".onnx.part")
    request = urllib.request.Request(DETECTOR_URL, headers={"User-Agent": "LakomicsCropExperiment/1.0"})
    with urllib.request.urlopen(request, timeout=180) as response, tmp.open("wb") as out:
        while chunk := response.read(1024 * 1024):
            out.write(chunk)
    if tmp.stat().st_size != DETECTOR_SIZE:
        raise RuntimeError(f"Unexpected detector size: {tmp.stat().st_size}")
    tmp.replace(DETECTOR_MODEL)
    manifest = {
        "repo": "ksasao/anime-character-detector",
        "commit": DETECTOR_COMMIT,
        "path": "python/character.onnx",
        "sha256": sha256(DETECTOR_MODEL),
        "sizeBytes": DETECTOR_MODEL.stat().st_size,
        "architecture": "YOLOX-s, 640x640, single character class",
        "license": "Apache-2.0",
    }
    DETECTOR_MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def letterbox_bgr(image: Image.Image, size=(640, 640)) -> tuple[np.ndarray, float]:
    width, height = image.size
    ratio = min(size[0] / height, size[1] / width)
    resized = image.resize(
        (max(1, int(width * ratio)), max(1, int(height * ratio))),
        Image.Resampling.BICUBIC,
    )
    rgb = np.asarray(resized, dtype=np.uint8)
    bgr = rgb[:, :, ::-1]
    padded = np.full((size[0], size[1], 3), 114, dtype=np.uint8)
    padded[: bgr.shape[0], : bgr.shape[1]] = bgr
    return np.ascontiguousarray(padded.transpose(2, 0, 1), dtype=np.float32), ratio


def nms(boxes: np.ndarray, scores: np.ndarray, threshold: float) -> list[int]:
    if not len(boxes):
        return []
    x1, y1, x2, y2 = boxes.T
    areas = np.maximum(0, x2 - x1 + 1) * np.maximum(0, y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = int(order[0])
        keep.append(i)
        if order.size == 1:
            break
        rest = order[1:]
        xx1, yy1 = np.maximum(x1[i], x1[rest]), np.maximum(y1[i], y1[rest])
        xx2, yy2 = np.minimum(x2[i], x2[rest]), np.minimum(y2[i], y2[rest])
        inter = np.maximum(0, xx2 - xx1 + 1) * np.maximum(0, yy2 - yy1 + 1)
        union = areas[i] + areas[rest] - inter
        order = rest[np.where(inter / np.maximum(union, 1e-9) <= threshold)[0]]
    return keep


def decode_yolox(output: np.ndarray, image_size: tuple[int, int], ratio: float,
                 score_threshold: float, nms_threshold: float) -> tuple[np.ndarray, np.ndarray]:
    strides = (8, 16, 32)
    grids, expanded = [], []
    for stride in strides:
        h, w = 640 // stride, 640 // stride
        xv, yv = np.meshgrid(np.arange(w), np.arange(h))
        grid = np.stack((xv, yv), axis=2).reshape(1, -1, 2)
        grids.append(grid)
        expanded.append(np.full((1, grid.shape[1], 1), stride))
    predictions = output.copy()
    grid = np.concatenate(grids, axis=1)
    stride = np.concatenate(expanded, axis=1)
    predictions[..., :2] = (predictions[..., :2] + grid) * stride
    predictions[..., 2:4] = np.exp(predictions[..., 2:4]) * stride
    pred = predictions[0]
    boxes = pred[:, :4]
    scores = pred[:, 4] * pred[:, 5:].max(axis=1)
    mask = scores > score_threshold
    boxes, scores = boxes[mask], scores[mask]
    if not len(boxes):
        return np.zeros((0, 4), dtype=np.float32), np.zeros(0, dtype=np.float32)
    xyxy = np.empty_like(boxes)
    xyxy[:, 0] = boxes[:, 0] - boxes[:, 2] / 2
    xyxy[:, 1] = boxes[:, 1] - boxes[:, 3] / 2
    xyxy[:, 2] = boxes[:, 0] + boxes[:, 2] / 2
    xyxy[:, 3] = boxes[:, 1] + boxes[:, 3] / 2
    xyxy /= ratio
    width, height = image_size
    xyxy[:, [0, 2]] = np.clip(xyxy[:, [0, 2]], 0, width)
    xyxy[:, [1, 3]] = np.clip(xyxy[:, [1, 3]], 0, height)
    keep = nms(xyxy, scores, nms_threshold)
    return xyxy[keep].astype(np.float32), scores[keep].astype(np.float32)


def expanded_box(box: np.ndarray, size: tuple[int, int], margin: float) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = map(float, box)
    width, height = size
    dx, dy = (x1 - x0) * margin, (y1 - y0) * margin
    return (
        max(0, int(np.floor(x0 - dx))),
        max(0, int(np.floor(y0 - dy))),
        min(width, int(np.ceil(x1 + dx))),
        min(height, int(np.ceil(y1 + dy))),
    )


def ccip_input(image: Image.Image) -> np.ndarray:
    mean = np.array([.48145466, .4578275, .40821073], dtype=np.float32)[:, None, None]
    std = np.array([.26862954, .26130258, .27577711], dtype=np.float32)[:, None, None]
    arr = np.asarray(image.resize((384, 384), Image.Resampling.BILINEAR), dtype=np.float32)
    arr = arr.transpose(2, 0, 1) / 255.0
    return ((arr - mean) / std)[None].astype(np.float32)


def ccip_feature(session: ort.InferenceSession, image: Image.Image, cache: Path) -> np.ndarray:
    if cache.exists():
        feature = np.load(cache, allow_pickle=False)
    else:
        feature = session.run(["output"], {"input": ccip_input(image)})[0][0]
        if not np.isfinite(feature).all():
            raise RuntimeError("Non-finite crop feature")
        cache.parent.mkdir(exist_ok=True)
        np.save(cache, feature)
    return feature


def aggregate(raw: np.ndarray, groups: list[list[int]]) -> np.ndarray:
    result = np.zeros((len(groups), len(groups)), dtype=np.float32)
    for i, left in enumerate(groups):
        for j in range(i + 1):
            value = float(raw[np.ix_(left, groups[j])].min())
            result[i, j] = result[j, i] = value
    return result


def evaluate(matrix: np.ndarray, data: dict) -> list[dict]:
    items = data["items"]
    pool = data["referencePool"]
    used_groups = {items[i]["duplicateGroup"] for i in pool}
    held_out = [x["id"] for x in items if x["duplicateGroup"] not in used_groups]
    threshold = float(data["threshold"])
    reports = []
    for count in (1, 3, 5):
        refs = pool[:count]
        ranked = sorted(held_out, key=lambda i: float(matrix[i, refs].min()))
        retrieved = [i for i in ranked if float(matrix[i, refs].min()) <= threshold]
        true_total = sum(bool(items[i]["positive"]) for i in held_out)
        tp = sum(bool(items[i]["positive"]) for i in retrieved)
        ap = None
        if true_total:
            hits = 0
            precision_sum = 0.0
            for rank, i in enumerate(ranked, 1):
                if items[i]["positive"]:
                    hits += 1
                    precision_sum += hits / rank
            ap = precision_sum / true_total
        reports.append({
            "references": count,
            "heldOutPositives": true_total,
            "heldOutNegatives": len(held_out) - true_total,
            "top10Correct": sum(bool(items[i]["positive"]) for i in ranked[:10]),
            "retrieved": len(retrieved),
            "truePositive": tp,
            "falsePositive": len(retrieved) - tp,
            "missed": true_total - tp,
            "averagePrecision": ap,
            "rankedIds": ranked,
        })
    return reports


def exploratory_calibration(matrix: np.ndarray, data: dict) -> dict:
    refs = data["referencePool"][:5]
    used_groups = {data["items"][i]["duplicateGroup"] for i in data["referencePool"]}
    ids = [x["id"] for x in data["items"] if x["duplicateGroup"] not in used_groups]
    ranked = sorted((float(matrix[i, refs].min()), bool(data["items"][i]["positive"])) for i in ids)
    positives = sum(flag for _, flag in ranked)
    tp = fp = 0
    zero_fp = None
    best_f1 = None
    for distance, positive in ranked:
        tp += int(positive)
        fp += int(not positive)
        missed = positives - tp
        f1 = (2 * tp / (2 * tp + fp + missed)) if tp else 0.0
        snapshot = {"threshold": distance, "truePositive": tp, "falsePositive": fp, "missed": missed, "f1": f1}
        if fp == 0:
            zero_fp = snapshot
        if best_f1 is None or f1 > best_f1["f1"]:
            best_f1 = snapshot
    return {"references": 5, "sameDataExploratoryOnly": True, "zeroFalsePositive": zero_fp, "bestF1": best_f1}


def rounded(matrix: np.ndarray) -> list[list[float]]:
    return np.round(matrix, 7).tolist()


def run(score_threshold=0.30, nms_threshold=0.45, margin=0.18, max_boxes=8) -> dict:
    started = time.perf_counter()
    data = json.loads((PUBLIC / "data.json").read_text(encoding="utf-8"))
    ccip_manifest = json.loads((HERE / "models" / "manifest.json").read_text(encoding="utf-8"))
    detector_manifest = download_detector()
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    detector = ort.InferenceSession(str(DETECTOR_MODEL), sess_options=options, providers=["CPUExecutionProvider"])
    detector_input = detector.get_inputs()[0].name
    feature_session = ort.InferenceSession(
        str(HERE / "models" / "model_feat.onnx"), sess_options=options, providers=["CPUExecutionProvider"]
    )
    metric_session = ort.InferenceSession(
        str(HERE / "models" / "model_metrics.onnx"), sess_options=options, providers=["CPUExecutionProvider"]
    )
    ccip_identity = hashlib.sha256(json.dumps(ccip_manifest, sort_keys=True).encode()).hexdigest()[:16]
    detector_identity = detector_manifest["sha256"][:16]
    crop_dir = PUBLIC / "crops"
    crop_dir.mkdir(parents=True, exist_ok=True)
    detection_dir = HERE / "detection-cache"
    detection_dir.mkdir(parents=True, exist_ok=True)
    all_features: list[np.ndarray] = []
    whole_groups: list[list[int]] = []
    crop_groups: list[list[int]] = []
    hybrid_groups: list[list[int]] = []
    crop_items = []
    for position, item in enumerate(data["items"], 1):
        source = ROOT / item["path"]
        image = analyze.rgb(source)
        whole_cache = HERE / "cache" / f"{ccip_identity}-{item['sha256']}.npy"
        if not whole_cache.exists():
            raise RuntimeError(f"Missing existing whole-image feature: {item['path']}")
        whole_index = len(all_features)
        all_features.append(np.load(whole_cache, allow_pickle=False))
        whole_groups.append([whole_index])

        detect_key = (
            f"{detector_identity}-{item['sha256']}-"
            f"s{score_threshold:.3f}-n{nms_threshold:.3f}.json"
        )
        detect_cache = detection_dir / detect_key
        if detect_cache.exists():
            cached = json.loads(detect_cache.read_text(encoding="utf-8"))
            boxes = np.asarray(cached["boxes"], dtype=np.float32).reshape(-1, 4)
            scores = np.asarray(cached["scores"], dtype=np.float32)
        else:
            blob, ratio = letterbox_bgr(image)
            output = detector.run(None, {detector_input: blob[None]})[0]
            boxes, scores = decode_yolox(output, image.size, ratio, score_threshold, nms_threshold)
            detect_cache.write_text(json.dumps({"boxes": boxes.tolist(), "scores": scores.tolist()}), encoding="utf-8")
        order = np.argsort(scores)[::-1][:max_boxes]
        box_records = []
        crop_indices = []
        for crop_number, det_index in enumerate(order):
            box = boxes[int(det_index)]
            expanded = expanded_box(box, image.size, margin)
            x0, y0, x1, y1 = expanded
            if x1 - x0 < 24 or y1 - y0 < 24:
                continue
            crop = image.crop(expanded)
            coord_key = "-".join(map(str, expanded))
            cache = HERE / "crop-cache" / (
                f"{detector_identity}-{ccip_identity}-{item['sha256']}-{coord_key}.npy"
            )
            feature = ccip_feature(feature_session, crop, cache)
            feature_index = len(all_features)
            all_features.append(feature)
            crop_indices.append(feature_index)
            thumb_name = f"{item['sha256'][:16]}-{crop_number}.jpg"
            thumb_path = crop_dir / thumb_name
            if not thumb_path.exists():
                preview = crop.copy()
                preview.thumbnail((360, 360))
                preview.save(thumb_path, quality=88)
            box_records.append({
                "score": round(float(scores[int(det_index)]), 6),
                "box": [round(float(value), 2) for value in box.tolist()],
                "expandedBox": list(expanded),
                "thumbnail": f"crops/{thumb_name}",
            })
        crop_groups.append(crop_indices or [whole_index])
        hybrid_groups.append([whole_index, *crop_indices])
        crop_items.append({
            "id": item["id"],
            "detections": box_records,
            "fallbackToWhole": not bool(crop_indices),
        })
        print(
            f"Detector+CCIP {position}/{len(data['items'])}: {len(crop_indices)} crop(s)",
            flush=True,
        )

    feature_array = np.stack(all_features).astype(np.float32)
    print(f"Computing CCIP metric for {len(all_features)} variants ...", flush=True)
    raw = metric_session.run(["output"], {"input": feature_array})[0]
    if raw.shape != (len(all_features), len(all_features)) or not np.isfinite(raw).all():
        raise RuntimeError(f"Invalid CCIP metric output: {raw.shape}")
    whole = aggregate(raw, whole_groups)
    existing_whole = np.asarray(data["distances"], dtype=np.float32)
    whole_delta = float(np.max(np.abs(whole - existing_whole)))
    if whole_delta > 2e-5:
        raise RuntimeError(f"Whole-image invariant changed: max delta {whole_delta}")
    crop = aggregate(raw, crop_groups)
    hybrid = aggregate(raw, hybrid_groups)
    for item in data["items"]:
        if analyze.sha(ROOT / item["path"]) != item["sha256"]:
            raise RuntimeError(f"Source changed during crop experiment: {item['path']}")

    strategies = {
        "whole": evaluate(whole, data),
        "crop": evaluate(crop, data),
        "hybrid": evaluate(hybrid, data),
    }
    elapsed = round(time.perf_counter() - started, 2)
    summary = {
        "version": 1,
        "detector": detector_manifest,
        "ccipModel": ccip_manifest,
        "config": {
            "scoreThreshold": score_threshold,
            "nmsThreshold": nms_threshold,
            "margin": margin,
            "maxBoxes": max_boxes,
        },
        "imageCount": len(data["items"]),
        "detectedImages": sum(not x["fallbackToWhole"] for x in crop_items),
        "fallbackImages": sum(x["fallbackToWhole"] for x in crop_items),
        "multiCharacterImages": sum(len(x["detections"]) >= 2 for x in crop_items),
        "cropCount": sum(len(x["detections"]) for x in crop_items),
        "variantFeatureCount": len(all_features),
        "wholeInvariantMaxDelta": whole_delta,
        "elapsedSeconds": elapsed,
        "strategies": strategies,
        "exploratoryCalibration": {
            "whole": exploratory_calibration(whole, data),
            "crop": exploratory_calibration(crop, data),
            "hybrid": exploratory_calibration(hybrid, data),
        },
        "sourcesUnchanged": True,
    }
    payload = {
        **summary,
        "items": crop_items,
        "matrices": {
            "crop": rounded(crop),
            "hybrid": rounded(hybrid),
        },
    }
    (PUBLIC / "crop-data.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )
    (HERE / "crop-report.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    return payload


def main():
    parser = argparse.ArgumentParser(description="Automatic character crop + CCIP A/B experiment")
    parser.add_argument("--score", type=float, default=0.30)
    parser.add_argument("--nms", type=float, default=0.45)
    parser.add_argument("--margin", type=float, default=0.18)
    parser.add_argument("--max-boxes", type=int, default=8)
    args = parser.parse_args()
    run(args.score, args.nms, args.margin, args.max_boxes)


if __name__ == "__main__":
    main()
