"""Disposable content-addressed features. Never part of a recovery snapshot."""
from collections import OrderedDict
import ast
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import zipfile

import numpy as np
import onnxruntime
import PIL
from PIL import Image

from runtime import BASELINE, FINGERPRINT, Features, sha256

MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_PIXELS = 50_000_000
MAX_CACHE_BYTES = 2 * 1024 * 1024


def runtime_fingerprint():
    here = Path(__file__).parent
    identity = {"baseline": FINGERPRINT, "python": sys.version,
                "numpy": np.__version__, "onnxruntime": onnxruntime.__version__,
                "pillow": PIL.__version__, "sources": {
                    name: sha256(here / name) for name in
                    ("runtime.py", "baseline.json", "feature_cache.py", "scan_worker.py", "learned_compare.py")}}
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()



def extraction_fingerprint(source=None, baseline=None):
    """Feature identity excludes the worker, storage implementation and matching policy."""
    baseline = BASELINE if baseline is None else baseline
    source = Path(__file__).with_name("runtime.py").read_text() if source is None else source
    tree = ast.parse(source)
    functions = {"sha256", "rgb", "letterbox", "nms", "decode", "expanded_box", "ccip_input"}
    extraction = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in functions:
            extraction.append(ast.dump(node, include_attributes=False))
        elif isinstance(node, ast.ClassDef) and node.name == "Runtime":
            extraction.extend(ast.dump(method, include_attributes=False) for method in node.body
                              if isinstance(method, ast.FunctionDef) and method.name in {"__init__", "extract"})
    identity = {"format": 1, "python": sys.version, "numpy": np.__version__,
                "onnxruntime": onnxruntime.__version__, "pillow": PIL.__version__,
                "extraction": extraction,
                "policy": {key: baseline[key] for key in ("detector_score", "nms", "margin", "max_boxes", "min_crop_side", "fallback", "preprocessing")},
                "models": {key: baseline["sha256"][key] for key in ("model_feat.onnx", "character-detector.onnx")}}
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def compatible_feature_caches(model_dir, fingerprint):
    # Machine-local upgrade receipt. Never discover compatibility from cache names alone.
    try:
        receipt = json.loads((Path(model_dir) / "cache-compatibility.json").read_text())
        names = receipt.get(fingerprint, [])
        return [name for name in names if isinstance(name, str) and len(name) == 64
                and all(c in "0123456789abcdef" for c in name) and name != fingerprint][:8]
    except (OSError, ValueError, TypeError, AttributeError):
        return []


def input_digest(path):
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("Image exceeds byte limit")
    return sha256(path)


class FeatureCache:
    def __init__(self, root, engine, fingerprint, compatible=()):
        self.legacy_roots = [Path(root) / name for name in compatible]
        self.root = Path(root) / fingerprint
        self.root.mkdir(parents=True, exist_ok=True)
        # One native worker owns this library. A killed writer can leave only a
        # disposable temporary file; completed .npz entries are never removed here.
        for partial in self.root.glob("*.part"):
            partial.unlink(missing_ok=True)
        self.engine = engine
        self.hits = self.misses = 0

    def extract(self, path, expected_hash):
        path = Path(path)
        digest = input_digest(path)
        if digest != expected_hash:
            raise ValueError("Source content differs from library metadata")
        destination = self.root / (digest + ".npz")
        feature = self._read(destination, digest)
        if feature is None:
            for legacy in self.legacy_roots:
                feature = self._read(legacy / (digest + ".npz"), digest)
                if feature is not None:
                    break
        if feature is None:
            with Image.open(path) as image:
                if image.width * image.height > MAX_PIXELS:
                    raise ValueError("Image exceeds pixel limit")
            feature = self.engine.extract(path)
            if feature.content_hash != digest:
                raise ValueError("Source changed during extraction")
            self._write(destination, feature)
            self.misses += 1
        else:
            self.hits += 1
        if input_digest(path) != digest:
            raise ValueError("Source changed while reading features")
        return feature

    def _read(self, path, digest):
        try:
            if path.stat().st_size > MAX_CACHE_BYTES:
                return None
            with zipfile.ZipFile(path) as archive:
                if sum(i.file_size for i in archive.infolist()) > MAX_CACHE_BYTES:
                    return None
            with np.load(path, allow_pickle=False) as data:
                vectors, boxes = data["vectors"], data["boxes"]
                fallback = bool(data["fallback"].item())
                if (str(data["content_hash"].item()) != digest
                        or vectors.dtype != np.float32 or vectors.ndim != 2
                        or not 1 <= len(vectors) <= BASELINE["max_boxes"]
                        or not 1 <= vectors.shape[1] <= 4096
                        or not np.isfinite(vectors).all()
                        or boxes.ndim != 2 or boxes.shape[1] != 4
                        or not np.issubdtype(boxes.dtype, np.integer)
                        or (fallback and (len(boxes) != 0 or len(vectors) != 1))
                        or (not fallback and len(boxes) != len(vectors))
                        or (boxes < 0).any()):
                    return None
                return Features(digest, [tuple(map(int, row)) for row in boxes], vectors, fallback)
        except (OSError, ValueError, KeyError, EOFError, zipfile.BadZipFile):
            return None

    def _write(self, destination, feature):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.root, suffix=".part", delete=False) as output:
                temporary = Path(output.name)
                np.savez(output, content_hash=feature.content_hash, vectors=feature.vectors,
                         boxes=np.asarray(feature.boxes, dtype=np.int64).reshape(-1, 4),
                         fallback=feature.fallback)
            os.replace(temporary, destination)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


class ReferenceBundles:
    """Bound reference residency by memory, rather than evicting at 32 characters.

    Native ownership verifies source snapshots before committing a decision.
    Keys have the same content identity as the previous worker-local cache.
    """
    def __init__(self, cache, max_bytes=64 * 1024 * 1024):
        self.cache = cache
        self.max_bytes = max_bytes
        self.bytes = 0
        self.entries = OrderedDict()

    def prepare(self, items):
        key = tuple(item["hash"] for item in items)
        cached = self.entries.pop(key, None)
        if cached is not None:
            self.entries[key] = cached
            return cached[0]
        refs = [self.cache.extract(Path(item["path"]), item["hash"]) for item in items]
        # Include a conservative allowance for Python containers and box/hash objects.
        size = 256 + sum(ref.vectors.nbytes + len(ref.boxes) * 256 + 1024 for ref in refs)
        if size <= self.max_bytes:
            while self.entries and (self.bytes + size > self.max_bytes or len(self.entries) >= 1024):
                _, (_, removed) = self.entries.popitem(last=False)
                self.bytes -= removed
            self.entries[key] = (refs, size)
            self.bytes += size
        return refs
