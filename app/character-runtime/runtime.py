"""Frozen character inference boundary. No database, network, or source writes."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

BASELINE = json.loads(Path(__file__).with_name("baseline.json").read_text())
FINGERPRINT = hashlib.sha256(json.dumps(BASELINE, sort_keys=True).encode()).hexdigest()


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def rgb(path: Path) -> Image.Image:
    with Image.open(path) as source:
        source.seek(0)
        rgba = ImageOps.exif_transpose(source).convert("RGBA")
        return Image.alpha_composite(Image.new("RGBA", rgba.size, "white"), rgba).convert("RGB")


def letterbox(image: Image.Image) -> tuple[np.ndarray, float]:
    width, height = image.size
    ratio = min(640 / height, 640 / width)
    resized = image.resize((max(1, int(width * ratio)), max(1, int(height * ratio))), Image.Resampling.BICUBIC)
    bgr = np.asarray(resized, dtype=np.uint8)[:, :, ::-1]
    padded = np.full((640, 640, 3), 114, dtype=np.uint8)
    padded[:bgr.shape[0], :bgr.shape[1]] = bgr
    return np.ascontiguousarray(padded.transpose(2, 0, 1), dtype=np.float32), ratio


def nms(boxes: np.ndarray, scores: np.ndarray) -> list[int]:
    if not len(boxes):
        return []
    x1, y1, x2, y2 = boxes.T
    areas = np.maximum(0, x2 - x1 + 1) * np.maximum(0, y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = int(order[0])
        keep.append(i)
        rest = order[1:]
        xx1, yy1 = np.maximum(x1[i], x1[rest]), np.maximum(y1[i], y1[rest])
        xx2, yy2 = np.minimum(x2[i], x2[rest]), np.minimum(y2[i], y2[rest])
        inter = np.maximum(0, xx2 - xx1 + 1) * np.maximum(0, yy2 - yy1 + 1)
        union = areas[i] + areas[rest] - inter
        order = rest[np.where(inter / np.maximum(union, 1e-9) <= BASELINE["nms"])[0]]
    return keep


def decode(output: np.ndarray, size: tuple[int, int], ratio: float) -> tuple[np.ndarray, np.ndarray]:
    grids, strides = [], []
    for stride in (8, 16, 32):
        y, x = 640 // stride, 640 // stride
        xv, yv = np.meshgrid(np.arange(x), np.arange(y))
        grid = np.stack((xv, yv), axis=2).reshape(1, -1, 2)
        grids.append(grid)
        strides.append(np.full((1, grid.shape[1], 1), stride))
    pred = output.copy()
    grid, stride = np.concatenate(grids, axis=1), np.concatenate(strides, axis=1)
    pred[..., :2] = (pred[..., :2] + grid) * stride
    pred[..., 2:4] = np.exp(pred[..., 2:4]) * stride
    boxes, scores = pred[0, :, :4], pred[0, :, 4] * pred[0, :, 5:].max(axis=1)
    mask = scores > BASELINE["detector_score"]
    boxes, scores = boxes[mask], scores[mask]
    if not len(boxes):
        return np.zeros((0, 4), dtype=np.float32), np.zeros(0, dtype=np.float32)
    xyxy = np.empty_like(boxes)
    xyxy[:, 0] = boxes[:, 0] - boxes[:, 2] / 2
    xyxy[:, 1] = boxes[:, 1] - boxes[:, 3] / 2
    xyxy[:, 2] = boxes[:, 0] + boxes[:, 2] / 2
    xyxy[:, 3] = boxes[:, 1] + boxes[:, 3] / 2
    xyxy /= ratio
    xyxy[:, [0, 2]] = np.clip(xyxy[:, [0, 2]], 0, size[0])
    xyxy[:, [1, 3]] = np.clip(xyxy[:, [1, 3]], 0, size[1])
    keep = nms(xyxy, scores)
    return xyxy[keep].astype(np.float32), scores[keep].astype(np.float32)


def expanded_box(box: np.ndarray, size: tuple[int, int]) -> tuple[int, int, int, int]:
    x0, y0, x1, y1 = map(float, box)
    dx, dy = (x1 - x0) * BASELINE["margin"], (y1 - y0) * BASELINE["margin"]
    return (max(0, int(np.floor(x0 - dx))), max(0, int(np.floor(y0 - dy))),
            min(size[0], int(np.ceil(x1 + dx))), min(size[1], int(np.ceil(y1 + dy))))


def ccip_input(image: Image.Image) -> np.ndarray:
    mean = np.array([.48145466, .4578275, .40821073], dtype=np.float32)[:, None, None]
    std = np.array([.26862954, .26130258, .27577711], dtype=np.float32)[:, None, None]
    arr = np.asarray(image.resize((384, 384), Image.Resampling.BILINEAR), dtype=np.float32)
    arr = arr.transpose(2, 0, 1) / 255.0
    return ((arr - mean) / std)[None].astype(np.float32)


@dataclass
class Features:
    content_hash: str
    boxes: list[tuple[int, int, int, int]]
    vectors: np.ndarray
    fallback: bool


def consensus(distances: np.ndarray, ref_sizes: list[int]) -> dict:
    count = BASELINE["reference_count"]
    if len(ref_sizes) != count or any(n < 1 or n > BASELINE["max_boxes"] for n in ref_sizes):
        raise ValueError("Exactly five nonempty reference image groups required")
    if distances.ndim != 2 or distances.shape[0] < 1 or distances.shape[1] != sum(ref_sizes) or not np.isfinite(distances).all():
        raise ValueError("Invalid metric distances")
    offsets = np.cumsum([0] + ref_sizes)
    # The experiment converts each float32 metric to Python float BEFORE
    # comparing it with the public float64 threshold. NumPy's weak scalar
    # promotion otherwise rounds that threshold up to float32 at the boundary.
    per_ref = np.stack([distances[:, offsets[i]:offsets[i+1]].min(axis=1) for i in range(count)], axis=1).astype(np.float64)
    second = np.sort(per_ref, axis=1)[:, BASELINE["required_references"] - 1]
    qi = int(np.argmin(second))
    per_query = [{"queryCrop": i, "distance": float(second[i]),
                  "matchedReferences": np.flatnonzero(row <= BASELINE["threshold"]).tolist(),
                  "referenceDistances": row.tolist()} for i, row in enumerate(per_ref)]
    return {"distance": float(second[qi]), "passed": bool(second[qi] <= BASELINE["threshold"]),
            "bestQueryCrop": qi, "evidence": per_query}


class Runtime:
    def __init__(self, model_dir: Path):
        for name, expected in BASELINE["sha256"].items():
            if sha256(model_dir / name) != expected:
                raise ValueError(f"Frozen model hash mismatch: {name}")
        opts = ort.SessionOptions()
        opts.intra_op_num_threads, opts.inter_op_num_threads = 6, 1
        def session(name):
            return ort.InferenceSession(str(model_dir / name), sess_options=opts, providers=["CPUExecutionProvider"])
        self.detector = session("character-detector.onnx")
        self.feature = session("model_feat.onnx")
        self.metric = session("model_metrics.onnx")
        self.max_metric_vectors = 0

    def extract(self, path: Path) -> Features:
        digest = sha256(path)
        image = rgb(path)
        blob, ratio = letterbox(image)
        raw = self.detector.run(None, {self.detector.get_inputs()[0].name: blob[None]})[0]
        if not np.isfinite(raw).all():
            raise ValueError("Non-finite detector output")
        boxes, scores = decode(raw, image.size, ratio)
        crops = []
        for i in np.argsort(scores)[::-1][:BASELINE["max_boxes"]]:
            box = expanded_box(boxes[int(i)], image.size)
            if box[2] - box[0] >= BASELINE["min_crop_side"] and box[3] - box[1] >= BASELINE["min_crop_side"]:
                crops.append(box)
        fallback = not crops
        images = [image] if fallback else [image.crop(box) for box in crops]
        vectors = np.stack([self.feature.run(["output"], {"input": ccip_input(im)})[0][0] for im in images]).astype(np.float32)
        if vectors.ndim != 2 or not np.isfinite(vectors).all():
            raise ValueError("Invalid CCIP feature output")
        if sha256(path) != digest:
            raise ValueError("Source changed during inference")
        return Features(digest, crops, vectors, fallback)

    def compare(self, query: Features, refs: list[Features]) -> dict:
        if len(refs) != BASELINE["reference_count"] or len({r.content_hash for r in refs}) != BASELINE["reference_count"]:
            raise ValueError("Exactly five distinct reference images required")
        sizes = [len(r.vectors) for r in refs]
        if not 1 <= len(query.vectors) <= BASELINE["max_boxes"] or any(not 1 <= size <= BASELINE["max_boxes"] for size in sizes):
            raise ValueError("Invalid crop group size")
        # The frozen metric accepts one stack and emits a square matrix. Keep it
        # bounded to one query + five refs (at most 48 vectors), never a series.
        stack = np.concatenate([query.vectors] + [r.vectors for r in refs])
        self.max_metric_vectors = max(self.max_metric_vectors, len(stack))
        raw = self.metric.run(["output"], {"input": stack})[0]
        if raw.shape != (len(stack), len(stack)):
            raise ValueError("Invalid metric output shape")
        result = consensus(raw[:len(query.vectors), len(query.vectors):], sizes)
        return {**result, "contentHash": query.content_hash, "queryBoxes": query.boxes,
                "wholeFallback": query.fallback, "referenceHashes": [r.content_hash for r in refs],
                "referenceBoxes": [r.boxes for r in refs], "referenceWholeFallback": [r.fallback for r in refs],
                "baselineFingerprint": FINGERPRINT}
