"""Disposable content-addressed features. Never part of a recovery snapshot."""
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
                    ("runtime.py", "baseline.json", "feature_cache.py", "scan_worker.py")}}
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


def input_digest(path):
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("Image exceeds byte limit")
    return sha256(path)


class FeatureCache:
    def __init__(self, root, engine, fingerprint):
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
