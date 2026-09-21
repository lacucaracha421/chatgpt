"""Standalone local classifier: extract, fit once, evaluate once, predict to JSON.

No worker/native integration, database access, network, or membership publisher.
All destinations must be explicit and outside the frozen source library.
"""
from __future__ import annotations

import argparse
from collections import Counter
import json
from pathlib import Path
import re
import time

import numpy as np

from character_encoder import (SMALL_SHA256, SmallEncoder, checked_image, contract,
                               feature_id, load_feature, validate)
from character_head import (POLICY, VERSION, calibrate, decide, fingerprint, fit_head,
                            grouped_split)
from feature_cache import FeatureCache, compatible_feature_caches, extraction_fingerprint
from reference_regions import project_reference
from runtime import Features, sha256


SOURCE_FILES = ("character_head.py", "character_encoder.py", "character_classifier.py")


def source_identity():
    return {name: sha256(Path(__file__).with_name(name)) for name in SOURCE_FILES}


def write_new(path, value, protected):
    path = Path(path).resolve()
    for root in protected:
        root = Path(root).resolve()
        if path == root or root in path.parents:
            raise ValueError("Output must not be inside a source library")
    text = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    with path.open("x", encoding="utf-8") as stream:
        stream.write(text)


def load_manifest(path):
    envelope = json.loads(Path(path).read_text(encoding="utf-8"))
    data = envelope["dataset"]
    if fingerprint(data) != envelope["sha256"]:
        raise ValueError("Manifest hash mismatch")
    ids, hashes = set(), set()
    target_ids = {t["id"] for t in data["targets"]}
    if len(target_ids) != len(data["targets"]):
        raise ValueError("Duplicate target")
    for a in data["assets"]:
        if (a["id"] in ids or a["content_hash"] in hashes
                or not re.fullmatch(r"[0-9a-f]{64}", a["content_hash"])):
            raise ValueError("Duplicate source or invalid digest")
        ids.add(a["id"])
        hashes.add(a["content_hash"])
        if not set(a["candidate_ids"]) <= target_ids or not set(a["labels"]) <= set(a["candidate_ids"]):
            raise ValueError("Invalid candidate/label scope")
        for tid, value in a["labels"].items():
            p = a["label_provenance"][tid]
            if (type(value) is not bool or p["origin"] != "manual"
                    or p["asset_hash"] != a["content_hash"]
                    or p["decision"] != ("accepted" if value else "rejected")):
                raise ValueError("Labels require hash-matching manual provenance")
    by_id = {a["id"]: a for a in data["assets"]}
    for ref in data["references"]:
        if (ref["asset_id"] not in by_id or ref["target_id"] not in target_ids
                or by_id[ref["asset_id"]]["content_hash"] != ref["asset_hash"]):
            raise ValueError("Invalid reference identity")
    return data, envelope["sha256"]


def source_path(data, asset):
    library = Path(data["library"]).resolve(strict=True)
    path = (library / asset["relative_path"]).resolve(strict=True)
    if library not in path.parents:
        raise ValueError("Source escapes library")
    return path


def output_directory(path, protected):
    path = Path(path).resolve(strict=True)
    if not path.is_dir():
        raise ValueError("Create a dedicated output directory first")
    if any(path == Path(p).resolve() or Path(p).resolve() in path.parents for p in protected):
        raise ValueError("Output directory is inside source library")
    return path


def import_previous(path, asset, expected_manifest):
    # Only the inspected multi-character feature format is accepted, not arbitrary
    # cache names or a B36 vector with the same width as S36.
    with np.load(path, allow_pickle=False) as old:
        identity = json.loads(str(old["identity"].item()))
        if (identity["manifest"] != expected_manifest or identity["small_model"] != SMALL_SHA256
                or identity["baseline_features"] != extraction_fingerprint()
                or str(old["content_hash"].item()) != asset["content_hash"]):
            raise ValueError("Previous features are incompatible")
        boxes = old["boxes"]
        if boxes.ndim != 2 or boxes.shape[1] != 4 or not np.issubdtype(boxes.dtype, np.integer):
            raise ValueError("Invalid imported boxes")
        bounds = [(int(x0), int(y0), int(x1), int(y1)) for x0, y0, x1, y1 in boxes]
        return validate(Features(asset["content_hash"], bounds, old["s36"].copy(), bool(old["fallback"].item())))


def extract(args):
    data, digest = load_manifest(args.manifest)
    out = output_directory(args.output, [data["library"]])
    pending = []
    for a in data["assets"]:
        destination = out / (a["content_hash"] + ".npz")
        if destination.exists():
            load_feature(destination, a["content_hash"])
        else:
            pending.append(a)
    print(f"Pending {len(pending)}; batch {args.limit}", flush=True)
    encoder, reader = None, None
    for index, a in enumerate(pending[:args.limit]):
        started = time.perf_counter()
        source, digest_before, image = checked_image(source_path(data, a), a["content_hash"])
        old = args.reuse_features / (a["content_hash"] + ".npz") if args.reuse_features else None
        if old is not None and old.exists():
            f = import_previous(old, a, digest)
            reused = True
        else:
            if encoder is None:
                encoder = SmallEncoder(args.small_model, args.detector_models / "character-detector.onnx")
            if reader is None:
                cache_root = out / "cache-reader"
                if out not in (cache_root / extraction_fingerprint()).resolve().parents:
                    raise ValueError("Cache reader directory escapes isolated output")
                reader = FeatureCache(cache_root, None, extraction_fingerprint())
            boxes = None
            for ns in [extraction_fingerprint()] + compatible_feature_caches(args.detector_models, extraction_fingerprint()):
                path = (Path(data["library"]) / ".cache/characters" / ns / (a["content_hash"] + ".npz")).resolve()
                if Path(data["library"]).resolve() not in path.parents:
                    raise ValueError("Cache escapes library")
                baseline = reader._read(path, a["content_hash"])
                if baseline is not None:
                    boxes = baseline.boxes
                    break
            f = encoder.extract(source, a["content_hash"], boxes)
            reused = False
        if any(not (0 <= x0 < x1 <= image.width and 0 <= y0 < y1 <= image.height)
               for x0, y0, x1, y1 in f.boxes):
            raise ValueError("Cached crop outside source")
        if sha256(source) != digest_before:
            raise ValueError("Source changed during extraction")
        with (out / (a["content_hash"] + ".npz")).open("xb") as stream:
            np.savez_compressed(stream, content_hash=a["content_hash"], vectors=f.vectors,
                                boxes=np.asarray(f.boxes, dtype=np.int64).reshape(-1, 4), fallback=f.fallback,
                                feature_id=feature_id(), reused=reused, seconds=time.perf_counter() - started)
        print(f"{index + 1}/{min(len(pending), args.limit)} reused={reused} crops={len(f.vectors)}", flush=True)
    print("Remaining", max(0, len(pending) - args.limit), flush=True)


def corpus(data, features):
    result, digests = {}, {}
    for a in data["assets"]:
        path = features / (a["content_hash"] + ".npz")
        result[a["id"]] = load_feature(path, a["content_hash"])
        digests[a["content_hash"]] = sha256(path)
    return result, digests


def labelled_bags(data, stored, split, target, partition):
    seeds = {r["asset_id"]: r for r in data["references"] if r["role"] == "seed" and r["target_id"] == target}
    groups, skipped = {}, Counter()
    for a in sorted(data["assets"], key=lambda v: v["content_hash"]):
        if a["partition"] == "historical_probe" or split[a["group"]] != partition:
            continue
        label = a["labels"].get(target)
        seed = seeds.get(a["id"])
        if label is None and seed is not None:
            label = True
        if label is None:
            continue
        f = stored[a["id"]]
        if f.fallback:
            skipped["no_detected_region"] += 1
            continue
        vectors = f.vectors
        if seed is not None and label and seed["selection"] is not None:
            try:
                projected, _, _ = project_reference(f, seed["selection"])
            except ValueError:
                skipped["stale_manual_region"] += 1
                continue
            vectors = projected.vectors
        # Unselected multi-person positives remain bags. Never use the previous
        # model's inferred person as a hard positive annotation for this head.
        groups.setdefault(a["group"], []).append((vectors, label, a["id"]))
    bags, labels, ids = [], [], []
    for group, entries in sorted(groups.items()):
        if len({entry[1] for entry in entries}) > 1:
            skipped["conflicting_group_labels"] += 1
            continue
        vectors, label, aid = entries[0]
        bags.append(vectors)
        labels.append(label)
        ids.append(aid)
    return bags, labels, ids, dict(skipped)


def fit(args):
    data, digest = load_manifest(args.manifest)
    out = output_directory(args.output, [data["library"]])
    if any(out.iterdir()):
        raise ValueError("Training output must be empty; do not overwrite a model run")
    stored, features = corpus(data, args.features)
    reference_ids = {r["asset_id"] for r in data["references"]}
    reference_groups = {a["group"] for a in data["assets"]
                        if a["id"] in reference_ids or a["partition"] == "reference"}
    usable_assets = [a for a in data["assets"] if a["partition"] != "historical_probe"]
    split = grouped_split(usable_assets, reference_groups)
    split_value = {"manifest": digest, "groups": split, "policy": POLICY,
                   "evaluation_status": "Development split of previously inspected data, NOT fresh external validation."}
    # Persist the partition before any fitting or score-dependent selection.
    write_new(out / "split.json", split_value, [data["library"]])
    started, heads, training = time.perf_counter(), {}, {}
    for t in data["targets"]:
        tid = t["id"]
        train, labels, ids, skipped = labelled_bags(data, stored, split, tid, "train")
        calibration, cal_labels, cal_ids, cal_skipped = labelled_bags(data, stored, split, tid, "calibration")
        head = fit_head(train, labels) if train else {"state": "insufficient_training", "positive": 0, "negative": 0}
        heads[tid] = calibrate(head, calibration, cal_labels)
        training[tid] = {"train_ids": ids, "calibration_ids": cal_ids, "skipped_train": skipped,
                         "skipped_calibration": cal_skipped, "train_positive": sum(labels),
                         "train_negative": len(labels) - sum(labels), "calibration_positive": sum(cal_labels),
                         "calibration_negative": len(cal_labels) - sum(cal_labels)}
        print(t["display_name"], heads[tid]["state"], training[tid]["train_positive"], training[tid]["train_negative"], flush=True)
    model = {"version": VERSION, "sources": source_identity(), "manifest": digest,
             "feature_contract": contract(), "feature_id": feature_id(), "feature_files": features,
             "split": split, "split_id": fingerprint(split_value), "policy": POLICY,
             "targets": data["targets"], "heads": heads, "training": training,
             "protected_roots": [data["library"]], "training_seconds": time.perf_counter() - started,
             "exposure_hashes": [a["content_hash"] for a in usable_assets if split[a["group"]] != "test"],
             "publication_allowed": False, "evaluation_status": split_value["evaluation_status"]}
    write_new(out / "model.json", {"sha256": fingerprint(model), "model": model}, model["protected_roots"])


def load_model(path):
    envelope = json.loads(Path(path).read_text(encoding="utf-8"))
    model = envelope["model"]
    if (fingerprint(model) != envelope["sha256"] or model["version"] != VERSION
            or model["sources"] != source_identity() or model["feature_id"] != feature_id()
            or model["feature_contract"] != contract() or model["policy"] != POLICY
            or model["publication_allowed"] is not False):
        raise ValueError("Stale or incompatible classifier bundle")
    return model, envelope["sha256"]


def metrics(rows, targets):
    result = {}
    for tid in targets:
        counts = Counter()
        for row in rows:
            if tid not in row["candidate_ids"]:
                continue
            label, proposed = row["labels"].get(tid), tid in row["decision"]["accepted"]
            if label is True:
                counts["positive"] += 1
                counts["tp" if proposed else "fn"] += 1
            elif label is False:
                counts["negative"] += 1
                counts["fp" if proposed else "tn"] += 1
            elif proposed:
                counts["unknown_proposals"] += 1
        result[tid] = {k: counts[k] for k in ("positive", "negative", "tp", "fn", "fp", "tn", "unknown_proposals")}
    known_multi = [r for r in rows if sum(r["labels"].values()) >= 2]
    return {"per_target": result, "multi_known": {"images": len(known_multi),
            "all_found": sum(all(t in r["decision"]["accepted"] for t, v in r["labels"].items() if v) for r in known_multi)},
            "images": len(rows), "images_with_proposals": sum(bool(r["decision"]["accepted"]) for r in rows)}


def evaluate(args):
    data, digest = load_manifest(args.manifest)
    model, model_id = load_model(args.model)
    if digest != model["manifest"]:
        raise ValueError("Evaluation manifest differs from frozen split")
    stored, features = corpus(data, args.features)
    if features != model["feature_files"]:
        raise ValueError("Evaluation features changed")
    rows = []
    for a in data["assets"]:
        if a["partition"] == "historical_probe" or model["split"][a["group"]] != "test":
            continue
        if a["content_hash"] in model["exposure_hashes"]:
            raise ValueError("Train/calibration leakage")
        f = stored[a["id"]]
        decision = decide(model["heads"], f.vectors, a["candidate_ids"], f.fallback)
        rows.append({"asset_id": a["id"], "content_hash": a["content_hash"], "candidate_ids": a["candidate_ids"],
                     "labels": a["labels"], "original_name": a["original_name"], "decision": decision})
    summary = metrics(rows, model["heads"])
    totals = {k: sum(v[k] for v in summary["per_target"].values()) for k in ("positive", "negative", "tp", "fp", "unknown_proposals")}
    # A development result cannot authorize deployment, even with zero observed FP.
    reasons = ["previously_inspected_development_data", "no_native_integration_acceptance"]
    if any(h["state"] != "ready_shadow" for h in model["heads"].values()):
        reasons.append("some_targets_lack_train_or_calibration_evidence")
    if totals["fp"]:
        reasons.append("observed_false_positives")
    if totals["positive"] and totals["tp"] / totals["positive"] < 0.5:
        reasons.append("less_than_half_known_memberships_recovered")
    value = {"model_id": model_id, "manifest": digest, "evaluation_status": model["evaluation_status"],
             "metrics": summary, "totals": totals, "rows": rows,
             "adoption": {"ready": False, "reasons": reasons}, "publication_allowed": False}
    write_new(args.output, value, model["protected_roots"])
    print(json.dumps({"totals": totals, "multi_known": summary["multi_known"], "adoption": value["adoption"]}, indent=2))


def predict(args):
    model, model_id = load_model(args.model)
    requested = args.candidate or list(model["heads"])
    encoder = SmallEncoder(args.small_model, args.detector_models / "character-detector.onnx")
    started = time.perf_counter()
    f = encoder.extract(args.image)
    decision = decide(model["heads"], f.vectors, requested, f.fallback)
    if f.content_hash in model["exposure_hashes"]:
        decision["accepted"] = []
        decision["state"] = "held_training_or_calibration_source"
        for row in decision["regions"]:
            row["state"] = "held_training_or_calibration_source"
            row["candidates"] = []
    value = {"model_id": model_id, "content_hash": f.content_hash, "boxes": f.boxes,
             "decision": decision, "seconds": time.perf_counter() - started,
             "scope": "Local shadow proposal only. No user judgments are overwritten."}
    write_new(args.output, value, model["protected_roots"])
    print(json.dumps({"state": decision["state"], "accepted": decision["accepted"],
                      "seconds": value["seconds"]}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("extract", "fit", "evaluate", "predict"):
        p = sub.add_parser(name)
        p.add_argument("--output", type=Path, required=True)
        if name in ("extract", "fit", "evaluate"):
            p.add_argument("--manifest", type=Path, required=True)
        if name in ("fit", "evaluate"):
            p.add_argument("--features", type=Path, required=True)
        if name in ("evaluate", "predict"):
            p.add_argument("--model", type=Path, required=True)
        if name in ("extract", "predict"):
            p.add_argument("--small-model", type=Path, required=True)
            p.add_argument("--detector-models", type=Path, required=True)
        if name == "extract":
            p.add_argument("--reuse-features", type=Path)
            p.add_argument("--limit", type=int, default=30)
        if name == "predict":
            p.add_argument("--image", type=Path, required=True)
            p.add_argument("--candidate", action="append")
    args = parser.parse_args()
    if args.command == "extract" and args.limit < 1:
        parser.error("--limit must be positive")
    {"extract": extract, "fit": fit, "evaluate": evaluate, "predict": predict}[args.command](args)


if __name__ == "__main__":
    main()
