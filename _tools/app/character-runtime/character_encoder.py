"""Pinned local S36 extraction for the standalone classifier; no network or DB."""
from __future__ import annotations
import ast
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

from character_head import fingerprint
from feature_cache import MAX_FILE_BYTES, MAX_PIXELS, extraction_fingerprint
from runtime import (BASELINE, Features, ccip_input, decode, expanded_box,
                     letterbox, rgb, sha256)

SMALL_SHA256 = "484ad463f569ab95308cf47e91ba358b01c40bc53289b90b950b94fcde7f2628"


def extraction_digest(source=None):
    """Hash only vector-producing code; storage and comments do not expire vectors."""
    source = Path(__file__).read_text() if source is None else source
    tree = ast.parse(source)
    names = {"contract", "checked_image", "validate"}
    methods = {"__init__", "detect", "extract"}
    selected = []
    found = set()
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in names:
            selected.append(ast.dump(node, include_attributes=False))
            found.add(node.name)
        elif isinstance(node, ast.ClassDef) and node.name == "SmallEncoder":
            for method in node.body:
                if isinstance(method, ast.FunctionDef) and method.name in methods:
                    selected.append(ast.dump(method, include_attributes=False))
                    found.add(method.name)
    if found != names | methods:
        raise ValueError("S36 extraction contract functions missing")
    return fingerprint(selected)


def contract(source=None):
    return {"format": 1, "encoder": SMALL_SHA256, "width": 768,
            "baseline_extraction": extraction_fingerprint(),
            "implementation": extraction_digest(source)}


def feature_id():
    return fingerprint(contract())


def checked_image(path, expected_hash=None):
    path = Path(path).resolve(strict=True)
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("Source exceeds byte limit")
    digest = sha256(path)
    if expected_hash is not None and digest != expected_hash:
        raise ValueError("Source hash changed")
    with Image.open(path) as source:
        if source.width * source.height > MAX_PIXELS:
            raise ValueError("Source exceeds pixel limit")
    return path, digest, rgb(path)


def validate(feature):
    vectors = feature.vectors
    if (vectors.dtype != np.float32 or vectors.ndim != 2 or vectors.shape[1] != 768
            or not 1 <= len(vectors) <= 8 or not np.isfinite(vectors).all()
            or (np.linalg.norm(vectors, axis=1) <= 1e-12).any()):
        raise ValueError("Invalid S36 vectors")
    if (feature.fallback and (feature.boxes or len(vectors) != 1)) or (
            not feature.fallback and len(feature.boxes) != len(vectors)):
        raise ValueError("Invalid region alignment")
    if any(not (0 <= x0 < x1 and 0 <= y0 < y1) for x0, y0, x1, y1 in feature.boxes):
        raise ValueError("Invalid region bounds")
    return feature


def load_feature(path, expected_hash):
    if Path(path).stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Feature file exceeds budget")
    import zipfile
    with zipfile.ZipFile(path) as archive:
        if sum(info.file_size for info in archive.infolist()) > 2 * 1024 * 1024:
            raise ValueError("Expanded feature file exceeds budget")
    with np.load(path, allow_pickle=False) as f:
        if str(f["feature_id"].item()) != feature_id() or str(f["content_hash"].item()) != expected_hash:
            raise ValueError("Stale feature contract or source hash")
        boxes = f["boxes"]
        if boxes.ndim != 2 or boxes.shape[1] != 4 or not np.issubdtype(boxes.dtype, np.integer):
            raise ValueError("Invalid box array")
        bounds = [(int(x0), int(y0), int(x1), int(y1)) for x0, y0, x1, y1 in boxes]
        return validate(Features(expected_hash, bounds, f["vectors"].copy(), bool(f["fallback"].item())))


class SmallEncoder:
    def __init__(self, small_model, detector_model):
        if sha256(Path(small_model)) != SMALL_SHA256:
            raise ValueError("Unexpected S36 model")
        if sha256(Path(detector_model)) != BASELINE["sha256"]["character-detector.onnx"]:
            raise ValueError("Unexpected detector")
        opts = ort.SessionOptions()
        opts.intra_op_num_threads, opts.inter_op_num_threads = 2, 1
        opts.add_session_config_entry("session.intra_op.allow_spinning", "0")
        self.feature = ort.InferenceSession(str(small_model), sess_options=opts, providers=["CPUExecutionProvider"])
        self.detector_path, self.options, self.detector = detector_model, opts, None

    def detect(self, image):
        """Current B36 crop policy, without B36 or S36 feature inference."""
        if self.detector is None:
            self.detector = ort.InferenceSession(str(self.detector_path), sess_options=self.options,
                                                 providers=["CPUExecutionProvider"])
        blob, ratio = letterbox(image)
        raw = self.detector.run(None, {self.detector.get_inputs()[0].name: blob[None]})[0]
        if not np.isfinite(raw).all():
            raise ValueError("Non-finite detector output")
        detected, scores = decode(raw, image.size, ratio)
        boxes = []
        for i in np.argsort(scores)[::-1][:BASELINE["max_boxes"]]:
            box = expanded_box(detected[int(i)], image.size)
            if min(box[2] - box[0], box[3] - box[1]) >= BASELINE["min_crop_side"]:
                boxes.append(box)
        return boxes

    def extract(self, path, expected_hash=None, boxes=None):
        path, digest, image = checked_image(path, expected_hash)
        if boxes is None:
            boxes = self.detect(image)
        if len(boxes) > 8 or any(not (0 <= x0 < x1 <= image.width and 0 <= y0 < y1 <= image.height)
                                for x0, y0, x1, y1 in boxes):
            raise ValueError("Crop outside source")
        views = [image.crop(b) for b in boxes] if boxes else [image]
        vectors = np.stack([self.feature.run(["output"], {"input": ccip_input(view)})[0][0]
                            for view in views]).astype(np.float32)
        if sha256(path) != digest:
            raise ValueError("Source changed during extraction")
        return validate(Features(digest, boxes, vectors, not boxes))
