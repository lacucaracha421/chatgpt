"""Explicit, resumable S36 cache preparation. Dry-run is strictly read-only."""
from __future__ import annotations

import os
# ORT 1.29 otherwise creates a telemetry session file merely on import, even
# before InferenceSession construction. Set this before any runtime import.
os.environ["ORT_DISABLE_TELEMETRY"] = "1"
for _key in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[_key] = "1"

import argparse
from collections import Counter
import json
from pathlib import Path
import time
import zipfile

from character_augmentation import S36FeatureCache
from character_encoder import SmallEncoder, checked_image, feature_id, load_feature, validate
from feature_cache import FeatureCache, extraction_fingerprint
from holdout_rules import is_hash
from replay_dataset import load_dataset, locate
from runtime import sha256


def candidates(dataset=None, hashes=None):
    """Input list is JSON [{"content_hash": "<sha256>", "media_kind": "image"}]."""
    rows = load_dataset(dataset)["dataset"]["assets"] if dataset else json.loads(Path(hashes).read_text())
    if not isinstance(rows, list):
        raise ValueError("Expected a list of content hashes and media kinds")
    kinds = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Expected content_hash/media_kind objects")
        h, kind = row.get("content_hash"), row.get("media_kind")
        if not is_hash(h) or not isinstance(kind, str):
            raise ValueError("Every candidate needs a valid content_hash and media_kind")
        if h in kinds and kinds[h] != kind:
            raise ValueError("Conflicting media kinds for a content hash")
        kinds[h] = kind
    return kinds


def cache_path_guard(root, library):
    """Refuse symlinked cache directories, even links within the library."""
    relative = root.relative_to(library)
    current = library
    for part in relative.parts:
        current /= part
        if current.is_symlink():
            raise ValueError("Cache path must not contain symlinks")


def prepare(items, library, models, *, cpu_minutes, stop, limit=None,
            dry_run=False, expect_namespace=None, encoder_factory=SmallEncoder,
            clock=time.process_time):
    """Only S36FeatureCache publishes files; no B36 cache constructor is called.

    CPU budget is per invocation (all process threads), checked before each image
    and after each blocking hash/decode/ONNX call. One in-flight call can overrun;
    after that call no further extraction or publication occurs. No CPU ledger is
    written. Resume skips validated entries, with a fresh explicitly chosen budget.
    """
    import math
    if not math.isfinite(cpu_minutes) or cpu_minutes < 0 or (limit is not None and limit < 0):
        raise ValueError("CPU budget and limit must be finite and nonnegative")
    identity = feature_id()
    if not dry_run and expect_namespace != identity:
        raise ValueError("--expect-namespace must match the computed feature_id")
    if expect_namespace is not None and expect_namespace != identity:
        raise ValueError("Unexpected S36 feature namespace")
    if any(not is_hash(h) or not isinstance(kind, str) for h, kind in items.items()):
        raise ValueError("Invalid candidate identity")
    library = Path(library).resolve(strict=True)
    models, stop = Path(models), Path(stop)
    cache = S36FeatureCache(library / ".cache/characters", implementation=identity, cleanup=False)
    cache_path_guard(cache.root, library)
    b36_root = library / ".cache/characters" / extraction_fingerprint()
    cache_path_guard(b36_root, library)
    # _read is a pure validator; __init__ would mkdir and clean partials.
    b36_reader = FeatureCache.__new__(FeatureCache)
    report = {"feature_id": identity, "total_candidates": len(items),
              "already_cached": 0, "b36_box_hits": 0, "detector_needed": 0,
              "written": 0, "skipped_by_reason": {}, "dry_run": dry_run}
    skipped = Counter()
    start = clock()
    encoder = None
    attempted = crops = 0

    def halted():
        if stop.exists():
            report["stopped"] = "STOP"
            return True
        if clock() - start >= cpu_minutes * 60:
            report["stopped"] = "cpu_budget"
            return True
        return False

    for h, kind in sorted(items.items()):
        if halted():
            break
        if kind != "image":
            skipped["non_image"] += 1
            continue
        paths, errors = locate(library, [h])
        if errors:
            skipped[next(iter(errors.values()))] += 1
            continue
        path = paths[h]
        if halted():
            break
        destination = cache.path(h)
        if destination.is_symlink():
            raise ValueError("Cache entry must not be a symlink")
        try:
            saved = load_feature(destination, h)
        except (OSError, ValueError, KeyError, EOFError, zipfile.BadZipFile):
            saved = None
        if saved is not None and not saved.fallback:
            if sha256(path) != h:
                skipped["source_changed"] += 1
                continue
            report["already_cached"] += 1
            continue
        if limit is not None and attempted >= limit:
            report["stopped"] = "limit"
            break
        attempted += 1
        if (b36_root / (h + ".npz")).is_symlink():
            raise ValueError("B36 cache entry must not be a symlink")
        base = b36_reader._read(b36_root / (h + ".npz"), h)
        if base is not None and base.fallback:
            skipped["whole_fallback"] += 1
            continue
        boxes = base.boxes if base is not None else None
        if boxes is None:
            report["detector_needed"] += 1
        else:
            report["b36_box_hits"] += 1
            crops += len(boxes)
        if halted():
            break
        # Check decode safety and source hash before and after reading, including
        # detector-only fallbacks which deliberately never reach feature inference.
        path, _, image = checked_image(path, h)
        try:
            if sha256(path) != h:
                raise ValueError("Source changed while decoding")
            if halted():
                break
            if dry_run:
                continue
            if encoder is None:
                encoder = encoder_factory(models / "augmentation/model_feat.onnx",
                                          models / "character-detector.onnx")
            if halted():
                break
            if boxes is None:
                boxes = encoder.detect(image)
            if sha256(path) != h:
                raise ValueError("Source changed during detection")
            if halted():
                break
            if not boxes:
                skipped["whole_fallback"] += 1
                continue
        finally:
            image.close()
        feature = validate(encoder.extract(path, h, boxes))
        if (feature.content_hash != h or feature.fallback
                or list(map(tuple, feature.boxes)) != list(map(tuple, boxes))):
            raise ValueError("Encoder changed the source or B36 crop geometry")
        if sha256(path) != h:
            raise ValueError("Source changed during extraction")
        if halted():
            break
        cache_path_guard(cache.root, library)
        if feature_id() != identity:
            raise ValueError("S36 feature namespace changed during extraction")
        cache.write(feature)
        report["written"] += 1
    report["skipped_by_reason"] = dict(skipped)
    report["cpu_seconds"] = clock() - start
    # Planning range, not a benchmark. Unknown detector counts assume 1..8 crops.
    report["cpu_estimate"] = {
        "seconds_low": crops * .7 + report["detector_needed"] * 1.7,
        "seconds_high": crops * 1.0 + report["detector_needed"] * 11.0,
        "basis": "Planning assumption: 0.7..1.0 CPU s/crop, 1..3 CPU s/detection, 1..8 unknown crops; not measured by dry-run",
        "scope": "Inspected uncached candidates within --limit and budget; excludes hashing, decode, model startup"}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--dataset", type=Path)
    inputs.add_argument("--hashes", type=Path, help="JSON list of content_hash/media_kind objects")
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--cpu-minutes", type=float, required=True)
    parser.add_argument("--stop", type=Path, required=True, help="Stop when this file exists; never created by the tool")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--expect-namespace")
    args = parser.parse_args()
    try:
        result = prepare(candidates(args.dataset, args.hashes), args.library, args.models,
                         cpu_minutes=args.cpu_minutes, stop=args.stop, limit=args.limit,
                         dry_run=args.dry_run, expect_namespace=args.expect_namespace)
        print(json.dumps(result, sort_keys=True, allow_nan=False))
    except (OSError, ValueError, KeyError) as error:
        parser.exit(2, f"Cache preparation failed: {error}\n")


if __name__ == "__main__":
    main()
