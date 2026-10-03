"""Verify machine-local feature equivalence without writing library data or caches."""
from __future__ import annotations

import os
# ORT can otherwise create telemetry files merely on import.
os.environ["ORT_DISABLE_TELEMETRY"] = "1"
for _key in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[_key] = "1"

import argparse
import json
from pathlib import Path
import random
import tempfile

import numpy as np

from character_augmentation import S36_NAMESPACE
from character_encoder import (SmallEncoder, checked_image, feature_id, load_feature,
                               pinned_feature_id, s36_compatibility)
from feature_cache import FeatureCache, extraction_fingerprint
from holdout_dataset import open_readonly
from holdout_rules import is_hash
from runtime import Runtime, sha256

MIN_SAMPLE = 20


def cache_entries(root):
    return sorted(path for path in root.glob("*.npz") if is_hash(path.stem))


def old_namespace(cache_root, kind, from_id):
    if kind == "s36":
        identity = pinned_feature_id()
        return identity, cache_root / S36_NAMESPACE / identity
    if from_id is not None:
        if not is_hash(from_id):
            raise ValueError("--from must be a full B36 feature id")
        return from_id, cache_root / from_id
    newest = []
    for root in cache_root.iterdir():
        if root.is_dir() and is_hash(root.name):
            entries = cache_entries(root)
            if entries:
                newest.append((max(path.stat().st_mtime_ns for path in entries), root.name))
    if not newest:
        raise ValueError("No B36 cache namespace with entries")
    identity = max(newest)[1]
    return identity, cache_root / identity


def source_path(db, library, content_hash):
    rows = db.execute("SELECT relative_path FROM assets WHERE content_hash = ? "
                      "AND status = 'normal' AND media_kind = 'image' ORDER BY relative_path",
                      (content_hash,)).fetchall()
    if not rows:
        raise ValueError("No normal image source in library DB")
    for (relative,) in rows:
        if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
            raise ValueError("Invalid source relative_path")
        path = (library / relative).resolve()
        if not path.is_relative_to(library):
            raise ValueError("Source escapes library")
        if path.is_file():
            return path
    raise ValueError("Source file missing")


def compare(saved, current, content_hash):
    reasons = []
    if current.content_hash != content_hash:
        reasons.append("content_hash")
    if list(map(tuple, saved.boxes)) != list(map(tuple, current.boxes)):
        reasons.append("boxes")
    if saved.fallback != current.fallback:
        reasons.append("fallback")
    a, b = saved.vectors, current.vectors
    difference = None
    if a.shape != b.shape or a.dtype != b.dtype:
        reasons.append("vector_shape_or_dtype")
    elif not np.isfinite(a).all() or not np.isfinite(b).all():
        reasons.append("nonfinite_vectors")
    else:
        difference = float(np.max(np.abs(a.astype(np.float64) - b.astype(np.float64))))
        if difference != 0:
            reasons.append("vectors")
    return reasons, difference


def verify_kind(db, library, models, kind, sample, from_id, encoder_factory, runtime_factory):
    report = {"computed_id": feature_id() if kind == "s36" else extraction_fingerprint(),
              "old_id": None, "sample_size": 0, "mismatches": [], "max_diff": 0.0,
              "resolvable_entries": 0, "skipped_unresolvable": 0,
              "errors": [], "equivalent": False}
    try:
        old_id, root = old_namespace(library / ".cache/characters", kind, from_id)
        report["old_id"] = old_id
        entries = cache_entries(root)
        normal_images = {row[0] for row in db.execute(
            "SELECT DISTINCT content_hash FROM assets WHERE status = 'normal' AND media_kind = 'image'")}
        resolvable = [entry for entry in entries if entry.stem in normal_images]
        report["resolvable_entries"] = len(resolvable)
        report["skipped_unresolvable"] = len(entries) - len(resolvable)
        if len(resolvable) < MIN_SAMPLE:
            raise ValueError(f"Require at least {MIN_SAMPLE} resolvable cached entries, only {len(resolvable)} available")
        selected = random.sample(resolvable, min(sample, len(resolvable)))
        engine = (encoder_factory(models / "augmentation/model_feat.onnx", models / "character-detector.onnx")
                  if kind == "s36" else runtime_factory(models))
        reader = FeatureCache.__new__(FeatureCache)  # Pure reader, no mkdir/cleanup.
        for entry in selected:
            h = entry.stem
            report["sample_size"] += 1
            try:
                saved = (load_feature(entry, h, expected_feature_id=old_id) if kind == "s36"
                         else reader._read(entry, h))
                if saved is None:
                    raise ValueError("Invalid cached feature")
                path = source_path(db, library, h)
                path, _, image = checked_image(path, h)
                image.close()
                # No cache wrapper and no supplied boxes: detection must also agree.
                current = engine.extract(path, h) if kind == "s36" else engine.extract(path)
                if sha256(path) != h:
                    raise ValueError("Source changed during extraction")
                reasons, difference = compare(saved, current, h)
                if difference is not None:
                    report["max_diff"] = max(report["max_diff"], difference)
                if reasons:
                    report["mismatches"].append({"content_hash": h, "reasons": reasons,
                                                  "max_diff": difference})
            except Exception as error:
                report["mismatches"].append({"content_hash": h, "error": str(error)})
        report["equivalent"] = not report["mismatches"]
    except Exception as error:
        report["errors"].append(str(error))
    return report


def merged_receipts(models, results):
    updates = []
    for kind, result in results.items():
        current, old = result["computed_id"], result["old_id"]
        if kind == "s36":
            receipt = s36_compatibility(models)
            receipt[current] = old
            path = models / "s36-compatibility.json"
        else:
            path = models / "cache-compatibility.json"
            try:
                receipt = json.loads(path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                receipt = {}
            if not isinstance(receipt, dict) or not all(
                    is_hash(key) and isinstance(value, list) and all(is_hash(v) for v in value)
                    for key, value in receipt.items()):
                raise ValueError("Invalid B36 compatibility receipt; refusing to overwrite")
            # The runtime consumes at most eight names. Keep the verified one first.
            receipt[current] = ([old] if old != current else []) + [
                value for value in receipt.get(current, []) if value not in (current, old)]
        updates.append((path, json.dumps(receipt, indent=2, sort_keys=True, allow_nan=False) + "\n"))
    return updates


def write_receipts(models, library, results):
    if models.is_relative_to(library):
        raise ValueError("Receipt directory must be outside the library")
    updates = merged_receipts(models, results)
    temporary = []
    try:
        for path, text in updates:
            if path.is_symlink():
                raise ValueError("Receipt must not be a symlink")
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=models,
                                             suffix=".part", delete=False) as stream:
                temporary.append((Path(stream.name), path))
                stream.write(text)
                stream.flush()
                os.fsync(stream.fileno())
        for source, destination in temporary:
            os.replace(source, destination)
    finally:
        for source, _ in temporary:
            source.unlink(missing_ok=True)


def verify(library, models, *, sample=60, kind="both", from_id=None, write=False,
           encoder_factory=SmallEncoder, runtime_factory=Runtime):
    report = {"requested_sample": sample, "dry_run": not write, "results": {},
              "equivalent": False, "written": False, "errors": []}
    try:
        if type(sample) is not int or sample < MIN_SAMPLE:
            raise ValueError(f"--sample must be an integer of at least {MIN_SAMPLE}")
        if kind not in ("s36", "b36", "both") or (kind == "s36" and from_id is not None):
            raise ValueError("--from selects B36 only; S36 always uses the pinned policy id")
        library, models = Path(library).resolve(strict=True), Path(models).resolve(strict=True)
        with open_readonly(library / "library.sqlite") as db:
            for selected_kind in (("s36", "b36") if kind == "both" else (kind,)):
                report["results"][selected_kind] = verify_kind(
                    db, library, models, selected_kind, sample, from_id, encoder_factory, runtime_factory)
        report["equivalent"] = all(result["equivalent"] for result in report["results"].values())
        if write and report["equivalent"]:
            write_receipts(models, library, report["results"])
            report["written"] = True
    except Exception as error:
        report["errors"].append(str(error))
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--sample", type=int, default=60,
                        help=f"Maximum samples per kind (minimum {MIN_SAMPLE}; default 60)")
    parser.add_argument("--kind", choices=("s36", "b36", "both"), default="both")
    parser.add_argument("--from", dest="from_id", help="Explicit old B36 namespace (full id)")
    parser.add_argument("--write", action="store_true", help="Write receipts only if every requested check passes")
    report = verify(**vars(parser.parse_args(argv)))
    print(json.dumps(report, sort_keys=True, allow_nan=False))
    return 0 if report["equivalent"] and not report["errors"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
