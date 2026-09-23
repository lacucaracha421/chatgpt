"""Offline crop-policy research. No database writer, downloads or product changes.

Run with the installed runtime Python, -B, from the scratch output directory.
All inference and contact sheets are content-hash checked. Resume uses atomic
per-image caches identified by models, preprocessing, policy code and versions.
The unchanged replay_eval.evaluate consumes a dict of its own Features objects.
Create OUTPUT/STOP for a cooperative stop at an image boundary; remove it to
resume. The CPU budget is cumulative across resumed extraction runs.
"""
from __future__ import annotations

import os
for _key in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ[_key] = "1"

import argparse
import ast
from collections import Counter
from dataclasses import asdict, dataclass
import hashlib
import heapq
import json
from pathlib import Path
import random
import time

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, __version__ as pillow_version

import replay_eval as replay
from character_encoder import SMALL_SHA256, checked_image, feature_id, load_feature
from replay_dataset import canonical, load_dataset, locate, outside_library
from runtime import BASELINE, ccip_input, decode, expanded_box, letterbox, nms, sha256


@dataclass(frozen=True)
class Policy:
    name: str
    score: float = .30
    short: float = 0
    merge: bool = False
    head: bool = False
    prominence: float = 0


POLICIES = [Policy("P0")]
POLICIES += [Policy(f"P1_s{s}_f{f:02}", s / 100, f / 100, True)
             for s, f in ((40, 8), (40, 12), (50, 8), (50, 12))]
POLICIES += [Policy("P2_s40_f08", .40, .08, True, True),
             Policy("P2_s50_f12", .50, .12, True, True)]
POLICIES += [Policy(f"P3_r{r}", .40, .08, True, True, r / 100)
             for r in (25, 35, 50)]


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".part")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2,
                                    allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def area(box):
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])


def intersection(a, b):
    return max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(
        0, min(a[3], b[3]) - max(a[1], b[1]))


def containment_merge(boxes, ids):
    """After production NMS, retain larger >=80%-containing boxes.

    Exception: a parent covering two substantial disjoint children is treated as
    a group box and removed. Each child must be 12..80% of parent area, pair IoU
    <=.10, and centers separated horizontally >=30% of parent width. Children
    already passed the policy's score/short-side checks. This is geometry only:
    it cannot reliably distinguish mascots, heads, overlapping people or objects.
    """
    groups = set()
    for large in ids:
        children = [i for i in ids if i != large and area(boxes[large]) > 0
                    and .12 <= area(boxes[i]) / area(boxes[large]) <= .8
                    and intersection(boxes[i], boxes[large]) >= .8 * area(boxes[i])]
        for pos, left in enumerate(children):
            for right in children[pos + 1:]:
                a, b, parent = boxes[left], boxes[right], boxes[large]
                inter = intersection(a, b)
                union = area(a) + area(b) - inter
                if (inter <= .1 * union and
                        abs((a[0] + a[2] - b[0] - b[2]) / 2) >= .3 * (parent[2] - parent[0])):
                    groups.add(large)
    kept = []
    for small in ids:
        if small in groups:
            continue
        if any(large not in groups and area(boxes[large]) > area(boxes[small])
               and intersection(boxes[small], boxes[large]) >= .8 * area(boxes[small])
               for large in ids):
            continue
        kept.append(small)
    return kept


def expand(box, size, head=False):
    if not head:
        return expanded_box(np.asarray(box), size)
    x0, y0, x1, y1 = map(float, box)
    width, height = x1 - x0, y1 - y0
    return (max(0, int(np.floor(x0 - .18 * width))),
            max(0, int(np.floor(y0 - .30 * height))),
            min(size[0], int(np.ceil(x1 + .18 * width))),
            min(size[1], int(np.ceil(y1 + .10 * height))))


def derive(boxes, scores, size, policy):
    boxes, scores = np.asarray(boxes, np.float32).reshape(-1, 4), np.asarray(scores, np.float32)
    eligible = np.flatnonzero(scores > policy.score)
    local = nms(boxes[eligible], scores[eligible])
    # Reproduce runtime.extract's second argsort, including float32 score ties.
    ranked = np.argsort(scores[eligible[local]])[::-1]
    ids = [int(eligible[local[i]]) for i in ranked]
    if policy.merge:
        ids = [i for i in ids if min(boxes[i, 2] - boxes[i, 0],
                                    boxes[i, 3] - boxes[i, 1]) >= policy.short * min(size)]
        ids = containment_merge(boxes, ids)
    before_prominence = list(ids)
    if ids and policy.prominence:
        biggest = max(area(boxes[i]) for i in ids)
        ids = [i for i in ids if area(boxes[i]) >= policy.prominence * biggest]
    crops = [(i, expand(boxes[i], size, policy.head)) for i in ids[:8]]
    crops = [(i, b) for i, b in crops if min(b[2] - b[0], b[3] - b[1]) >= 24]
    return {"ids": [i for i, _ in crops], "boxes": [list(b) for _, b in crops],
            "fallback": not crops,
            "prominence_dropped": [i for i in before_prominence if i not in ids]}


def decode_raw(output, size, ratio, floor=.15):
    """runtime.decode's exact float32 decoding, without NMS or a box cap."""
    grids, strides = [], []
    for stride in (8, 16, 32):
        xv, yv = np.meshgrid(np.arange(640 // stride), np.arange(640 // stride))
        grid = np.stack((xv, yv), axis=2).reshape(1, -1, 2)
        grids.append(grid)
        strides.append(np.full((1, grid.shape[1], 1), stride))
    pred = output.copy()
    grid, stride = np.concatenate(grids, axis=1), np.concatenate(strides, axis=1)
    pred[..., :2] = (pred[..., :2] + grid) * stride
    pred[..., 2:4] = np.exp(pred[..., 2:4]) * stride
    boxes = pred[0, :, :4]
    scores = pred[0, :, 4] * pred[0, :, 5:].max(axis=1)
    mask = scores > floor
    boxes, scores = boxes[mask], scores[mask]
    xyxy = np.empty_like(boxes)
    xyxy[:, :2] = boxes[:, :2] - boxes[:, 2:] / 2
    xyxy[:, 2:] = boxes[:, :2] + boxes[:, 2:] / 2
    xyxy /= ratio
    xyxy[:, [0, 2]] = np.clip(xyxy[:, [0, 2]], 0, size[0])
    xyxy[:, [1, 3]] = np.clip(xyxy[:, [1, 3]], 0, size[1])
    return xyxy.astype(np.float32), scores.astype(np.float32)


def extract_all(args, envelope):
    library = args.library.resolve(strict=True)
    out = outside_library(args.output, library)
    outside_library(out, args.models)
    out.mkdir(parents=True, exist_ok=True)
    model_hashes = {"detector": sha256(args.models / "character-detector.onnx"),
                    "s36": sha256(args.models / "augmentation/model_feat.onnx")}
    if model_hashes != {"detector": BASELINE["sha256"]["character-detector.onnx"], "s36": SMALL_SHA256}:
        raise ValueError("Unexpected model hashes")
    identity = {"models": model_hashes, "raw_floor": .15,
                "versions": [np.__version__, ort.__version__, pillow_version],
                "policy_grid": [asdict(p) for p in POLICIES],
                "extraction_contract": 1,
                "runtime_sha256": sha256(Path(__file__).with_name("runtime.py"))}
    tree = ast.parse(Path(__file__).read_text())
    identity["extraction_ast"] = hashlib.sha256(canonical([
        ast.dump(n, include_attributes=False) for n in tree.body
        if isinstance(n, ast.FunctionDef) and n.name in {
            "area", "intersection", "containment_merge", "expand", "derive", "decode_raw"}
    ])).hexdigest()
    namespace = hashlib.sha256(canonical(identity)).hexdigest()
    cache = out / "cache" / namespace
    (cache / "raw").mkdir(parents=True, exist_ok=True)
    (cache / "union").mkdir(exist_ok=True)
    atomic_json(cache / "identity.json", identity)
    data = envelope["dataset"]
    labels, events, _, _ = replay.prepare_labels(data)
    requested = {r["asset_hash"] for r in events + data["references"]}
    kinds = {a["content_hash"]: a["media_kind"] for a in data["assets"]}
    non_images = {h: kinds[h] for h in requested if h in kinds and kinds[h] != "image"}
    hashes = requested - set(non_images)
    atomic_json(out / "non-image-events.json", non_images)
    paths, errors = locate(library, hashes)
    atomic_json(out / "paths.json", {h: str(p.relative_to(library)) for h, p in paths.items()})
    options = ort.SessionOptions()
    options.intra_op_num_threads, options.inter_op_num_threads = 1, 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    ort.disable_telemetry_events()
    detector = encoder = None
    records = {}
    features = {p.name: {} for p in POLICIES}
    started, cpu_start = time.monotonic(), time.process_time()
    ledger_path = out / ("feature-cpu-ledger.json" if args.require_raw else "cpu-ledger.json")
    previous_cpu = json.loads(ledger_path.read_text())["cpu_seconds"] if ledger_path.exists() else 0
    cpu_origin = previous_cpu
    reuse_root = library / ".cache/characters/s36-augmentation-v1" / feature_id()
    reused = {}
    for index, (h, path) in enumerate(sorted(paths.items())):
        if (out / "STOP").exists():
            print("STOP requested; finished image caches retained", flush=True)
            break
        if args.limit and index >= args.limit:
            break
        used = cpu_origin + time.process_time() - cpu_start
        if used >= args.cpu_minutes * 60:
            print("CPU extraction budget reached; caches are resumable", flush=True)
            break
        raw_path, union_path = cache / "raw" / (h + ".json"), cache / "union" / (h + ".npz")
        if args.require_raw and not raw_path.exists():
            deadline = time.monotonic() + 120
            while not raw_path.exists() and time.monotonic() < deadline:
                if (out / "STOP").exists():
                    break
                time.sleep(.25)
            if not raw_path.exists():
                print("Raw detection not ready; resume after detector finishes", flush=True)
                break
        try:
            path, _, image = checked_image(path, h)
            if raw_path.exists():
                raw = json.loads(raw_path.read_text())
                if raw["content_hash"] != h or raw["size"] != list(image.size):
                    raise ValueError("Stale raw cache")
            else:
                if detector is None:
                    detector = ort.InferenceSession(str(args.models / "character-detector.onnx"),
                        sess_options=options, providers=["CPUExecutionProvider"])
                blob, ratio = letterbox(image)
                output = detector.run(None, {detector.get_inputs()[0].name: blob[None]})[0]
                if not np.isfinite(output).all():
                    raise ValueError("Non-finite raw detections")
                boxes, scores = decode_raw(output, image.size, ratio)
                raw = {"content_hash": h, "size": list(image.size), "boxes": boxes.tolist(),
                       "scores": scores.tolist()}
                # Real-image parity against the untouched production decoder.
                prod_boxes, prod_scores = decode(output, image.size, ratio)
                expected = [expanded_box(prod_boxes[int(i)], image.size)
                            for i in np.argsort(prod_scores)[::-1][:8]]
                expected = [b for b in expected if min(b[2]-b[0], b[3]-b[1]) >= 24]
                if derive(boxes, scores, image.size, POLICIES[0])["boxes"] != [list(b) for b in expected]:
                    raise ValueError("P0 production parity failure")
                raw["p0_parity"] = True
                if sha256(path) != h:
                    raise ValueError("Source changed during detection")
                atomic_json(raw_path, raw)
            if args.detect_only:
                records[h] = raw
                if (index + 1) % 100 == 0:
                    used = cpu_origin + time.process_time() - cpu_start
                    atomic_json(ledger_path, {"cpu_seconds": used})
                    print(json.dumps({"detected": index + 1, "total": len(paths),
                                      "cpu_seconds": round(used, 1)}), flush=True)
                image.close()
                continue
            policies = {p.name: derive(raw["boxes"], raw["scores"], image.size, p) for p in POLICIES}
            union = sorted({tuple(b) for v in policies.values() for b in v["boxes"]} |
                           ({(0, 0, *image.size)} if any(v["fallback"] for v in policies.values()) else set()))
            saved = {}
            if union_path.exists():
                with np.load(union_path, allow_pickle=False) as f:
                    if str(f["content_hash"].item()) != h:
                        raise ValueError("Union cache identity mismatch")
                    saved = {tuple(map(int, b)): v for b, v in zip(f["boxes"], f["vectors"])}
            dirty = False
            # Only current, self-identifying production S36 caches are accepted.
            # Legacy pickle features have neither encoder identity nor geometry.
            existing = reuse_root / (h + ".npz")
            if existing.exists():
                try:
                    cached = load_feature(existing, h)
                except (OSError, ValueError, KeyError):
                    cached = None
                expected = policies["P0"]["boxes"]
                if cached is not None and cached.boxes == [tuple(b) for b in expected] and cached.fallback == policies["P0"]["fallback"]:
                    copied = 0
                    for box, vector in zip(cached.boxes or [(0, 0, *image.size)], cached.vectors):
                        box = tuple(box)
                        if box in union and box not in saved:
                            saved[box] = vector
                            copied += 1
                            dirty = True
                    if copied:
                        reused[h] = {"crops": copied, "cache_sha256": sha256(existing)}
            for box in union:
                if box not in saved:
                    if encoder is None:
                        encoder = ort.InferenceSession(str(args.models / "augmentation/model_feat.onnx"),
                            sess_options=options, providers=["CPUExecutionProvider"])
                    vector = encoder.run(["output"], {"input": ccip_input(image.crop(box))})[0][0]
                    replay.unit(np.asarray(vector, np.float32)[None])
                    saved[box] = np.asarray(vector, np.float32)
                    dirty = True
            if sha256(path) != h:
                raise ValueError("Source changed during extraction")
            if dirty:
                with union_path.with_suffix(".part").open("wb") as stream:
                    np.savez(stream, content_hash=h, boxes=np.array(list(saved), np.int64),
                             vectors=np.stack(list(saved.values())))
                union_path.with_suffix(".part").replace(union_path)
            for p in POLICIES:
                value = policies[p.name]
                boxes = [tuple(b) for b in value["boxes"]]
                vectors = replay.unit(np.stack([saved[b] for b in boxes or [(0, 0, *image.size)]]))
                features[p.name][h] = replay.Features(h, boxes, vectors, value["fallback"])
            raw["policies"] = policies
            records[h] = raw
            image.close()
        except (OSError, ValueError) as error:
            errors[h] = str(error)
        if (index + 1) % 10 == 0:
            used = cpu_origin + time.process_time() - cpu_start
            atomic_json(ledger_path, {"cpu_seconds": used})
            print(json.dumps({"processed": index + 1, "total": len(paths), "errors": len(errors),
                              "cpu_seconds": round(used, 1), "wall_seconds": round(time.monotonic()-started, 1)}), flush=True)
    atomic_json(ledger_path, {"cpu_seconds": cpu_origin + time.process_time() - cpu_start})
    atomic_json(out / "extraction.json", {"namespace": namespace, "identity": identity,
        "dataset_sha256": envelope["sha256"], "requested_hashes": len(hashes),
        "non_image_event_hashes_excluded_from_extraction": len(non_images),
        "completed": len(records), "errors": errors,
        "p0_parity_images": sum(bool(r.get("p0_parity")) for r in records.values()),
        "cpu_seconds": cpu_origin + time.process_time() - cpu_start})
    if reused:
        atomic_json(out / "verified-cache-reuse.json", {"namespace": feature_id(), "images": reused})
    if not args.detect_only:
        atomic_json(cache / "policies.json", {h: r["policies"] for h, r in records.items()})
    return features, records, paths, errors, cache


def dropped_match(base_ids, kept_ids, base_scores, kept_scores, boundary):
    """Include newly admitted crops when pruning frees a slot under the cap."""
    kept = set(kept_ids)
    removed_matches = any(i not in kept and replay.passes(float(s), boundary)
                          for i, s in zip(base_ids, base_scores))
    return removed_matches and not any(replay.passes(float(s), boundary) for s in kept_scores)


def walk_forward_acceptances(rows):
    """Recover the unchanged 2% walk-forward decisions for paired diagnostics."""
    history, pending, accepted = [], [], set()
    eligible = sorted((r for r in rows if r["feature_status"] == "available"),
                      key=lambda r: (r["time"], r["sequence"]))
    for row in eligible:
        while pending and pending[0][0] <= row["time"]:
            _, _, score = heapq.heappop(pending)
            history.append(score)
        score = row["scores"]["knn3"]
        if replay.passes(score, replay.threshold(history, .02)):
            accepted.add(row["sequence"])
        if not row["label"]:
            heapq.heappush(pending, (replay.available_at(row["time"], 1), row["sequence"], score))
    return accepted


def paired_acceptance_changes(rows, base_rows):
    own, base = walk_forward_acceptances(rows), walk_forward_acceptances(base_rows)
    positives = {r["sequence"]: r for r in rows if r["label"]}
    lost, gained = sorted((base - own) & positives.keys()), sorted((own - base) & positives.keys())
    return {"lost": len(lost), "gained": len(gained),
            "lost_examples": [{k: positives[s][k] for k in
                               ("source_asset_id", "target_id", "asset_hash", "sequence")} for s in lost]}


def prominence_cost(envelope, feature_sets, records):
    """Freeze P2 galleries/thresholds; vary only query crops, never infer truth.

    A loss means P2 passes its earlier-negative walk-forward 2% boundary, a
    removed crop passes, and no retained crop passes that same boundary. This is
    an operational identity-match proxy, not an annotated person localization.
    Also count lost best witnesses, including below-threshold ones, separately.
    """
    features = feature_sets["P2_s40_f08"]
    data = envelope["dataset"]
    labels, events, _, _ = replay.prepare_labels(data)
    groups, _ = replay.duplicate_groups(data["images"],
        {r["asset_hash"] for r in data["references"] + data["decisions"]})
    engine = replay.Replay(data, features, groups, 1)
    truth = {r["sequence"]: r for r in labels}
    costs = {p.name: {"lost": [], "lost_best_witness": [], "matched_acceptances": 0,
                     "all_acceptances": sum(r["label"] for r in labels),
                     "unassessable_acceptances": 0} for p in POLICIES if p.prominence}
    negatives, pending = [], []
    for now in sorted({e["time"] for e in events}):
        engine.release(now)
        while pending and pending[0][0] <= now:
            _, _, score = heapq.heappop(pending)
            negatives.append(score)
        boundary = replay.threshold(negatives, .02)
        batch = [e for e in events if e["time"] == now]
        for event in batch:
            if event["sequence"] not in truth:
                continue
            row, h = truth[event["sequence"]], event["asset_hash"]
            f = features.get(h)
            pool, _, _ = engine.gallery(event["target_id"], h, now)
            pool_vectors = replay.stack(list(pool.values()))
            ds = replay.knn(f.vectors, pool_vectors) if f and not f.fallback and pool else None
            score = float(ds.min()) if ds is not None else None
            if not row["label"]:
                if f is not None and not f.fallback:
                    heapq.heappush(pending, (replay.available_at(now, 1), event["sequence"], score))
                continue
            for name, value in costs.items():
                if ds is None or boundary is None:
                    value["unassessable_acceptances"] += 1
                    continue
                base = records[h]["policies"]["P2_s40_f08"]["ids"]
                kept = records[h]["policies"][name]["ids"]
                view = feature_sets[name][h]
                base_scores = dict(zip(base, ds))
                # Reuse frozen scores for identical crops; also score new crops
                # promoted from beyond the original eight-box cap.
                kept_scores = [float(base_scores[i]) if i in base_scores else
                               float(replay.knn(view.vectors[j:j+1], pool_vectors)[0])
                               for j, i in enumerate(kept)]
                example = {"asset_id": row["source_asset_id"], "target_id": row["target_id"],
                           "content_hash": h, "sequence": row["sequence"],
                           "score": score, "threshold": boundary,
                           "best_kept_score": min(kept_scores) if kept_scores else None,
                           "removed_raw_ids": [i for i in base if i not in kept]}
                if base[int(np.argmin(ds))] not in kept:
                    value["lost_best_witness"].append(example)
                if replay.passes(score, boundary):
                    value["matched_acceptances"] += 1
                    if dropped_match(base, kept, ds, kept_scores, boundary):
                        value["lost"].append(example)
        for event in batch:
            vector = engine.witness(event, now)
            heapq.heappush(engine.pending, (replay.available_at(now, 1), engine.serial, event, vector))
            engine.serial += 1
    for value in costs.values():
        value["lost_count"] = len(value["lost"])
        value["lost_share_all_acceptances"] = len(value["lost"]) / value["all_acceptances"]
        value["lost_share_matched"] = len(value["lost"]) / value["matched_acceptances"] if value["matched_acceptances"] else None
    return costs


def contact_sheet(destination, entries, paths, slots, columns=10):
    # Never show these source images in tool output; scratch PNGs only.
    width, height = 170, 210
    sheet = Image.new("RGB", (columns * width, ((slots + columns - 1) // columns) * height), "#202024")
    draw = ImageDraw.Draw(sheet)
    manifest = []
    for i, (h, box, caption) in enumerate(entries[:slots]):
        _, _, source = checked_image(paths[h], h)
        crop = source.crop(tuple(box))
        crop.thumbnail((width - 8, height - 38))
        x, y = (i % columns) * width, (i // columns) * height
        sheet.paste(crop, (x + (width - crop.width) // 2, y))
        draw.text((x + 4, y + height - 35), f"{i+1}: {h[:10]}\n{caption}", fill="white")
        manifest.append({"slot": i+1, "content_hash": h, "box": box, "caption": caption})
        source.close()
    sheet.save(destination)
    atomic_json(destination.with_suffix(".json"), {"requested_slots": slots, "actual": len(manifest), "entries": manifest})


def inspection(out, envelope, records, paths):
    labels, _, _, _ = replay.prepare_labels(envelope["dataset"])
    population = sorted({r["asset_hash"] for r in labels})
    sample = random.Random(20260923).sample(population, min(200, len(population)))
    atomic_json(out / "inspection-sample.json", {"seed": 20260923, "hashes": sample,
        "asset_ids": {h: envelope["dataset"]["images"][h]["asset_ids"] for h in sample},
        "missing_images": [h for h in sample if h not in records]})
    counts = {}
    for policy in POLICIES[1:]:
        removed, kept = [], []
        for h in sample:
            if h not in records:
                continue
            raw = records[h]
            p0, candidate = raw["policies"]["P0"], raw["policies"][policy.name]
            retained = set(candidate["ids"])
            removed += [(h, b, f"raw {i} removed") for i, b in zip(p0["ids"], p0["boxes"]) if i not in retained]
            kept += [(h, b, f"raw {i} kept") for i, b in zip(candidate["ids"], candidate["boxes"])]
        counts[policy.name] = {"p0_crops_removed": len(removed), "candidate_crops_kept": len(kept),
                               "removed_sheet_count": min(60, len(removed)), "kept_sheet_count": min(60, len(kept))}
        random.Random(20260923).shuffle(removed)
        random.Random(20260923).shuffle(kept)
        contact_sheet(out / f"{policy.name}-removed.png", removed, paths, 60)
        contact_sheet(out / f"{policy.name}-kept.png", kept, paths, 60)
    pairs = []
    for h in sample:
        if h not in records:
            continue
        raw = records[h]
        p0, p2 = raw["policies"]["P0"], raw["policies"]["P2_s40_f08"]
        for i, b in zip(p0["ids"], p0["boxes"]):
            if i in p2["ids"]:
                pairs.append([(h, b, f"raw {i} P0"),
                              (h, p2["boxes"][p2["ids"].index(i)], f"raw {i} P2")])
    random.Random(20260923).shuffle(pairs)
    contact_sheet(out / "P0-vs-P2-head-pairs.png", [e for pair in pairs[:40] for e in pair], paths, 80)
    return counts


def evaluate_all(args, envelope, features, records, errors, cache):
    out = args.output
    result = {"dataset_sha256": envelope["sha256"], "dataset_exported_at": envelope["dataset"]["exported_at"],
              "space": "s36", "scorer": "knn3", "feedback_lag_days": 1,
              "cache": str(cache), "extraction": json.loads((out / "extraction.json").read_text()),
              "policies": {}, "errors": errors, "source_sha256": replay.source_hashes(),
              "research_script_sha256": sha256(Path(__file__)),
              "limitations": [
                  "Fixed exported metadata; live SQLite read failed in sandbox. No database copy or library writes.",
                  "Paths reconstructed from canonical ingestion.rs assets/hash-prefix/hash.extension, then content SHA256 checked.",
                  "No localization ground truth: removed crops and prominence costs are geometric/model proxies, not verified mascot or identity labels.",
                  "No human visual adjudication of private contact sheets performed by this script.",
                  "Replay semantics unchanged, including stale explicit reference region abstention after crop bounds change; no guessed remapping.",
                  "AUC/recall exclude missing or fallback queries per replay_eval; compare coverage and common-cohort metrics to expose selection effects.",
                  "Prominence costs freeze P2 historical gallery and threshold to isolate query-box deletion; best-witness losses also include below-threshold cases.",
                  "Variants compared on these historical labels; recommendation needs prospective validation, not a tuning-independent holdout.",
                  "Head-border proxy cannot establish that a face is complete; top expansion adds context but cannot recover pixels outside the original image."]}
    rows_by_policy = {}
    for policy in POLICIES:
        print("Evaluating " + policy.name, flush=True)
        report = replay.evaluate(envelope, features[policy.name], lag=1, scorers=("knn3", "prior"))
        atomic_json(out / (policy.name + "-replay.json"), report)
        rows_by_policy[policy.name] = report["rows"]
        crops = [r["policies"][policy.name] for r in records.values()]
        top_border = sum(raw["boxes"][i][1] <= 0 and b[1] == 0 for raw in records.values()
                         for i, b in zip(raw["policies"][policy.name]["ids"], raw["policies"][policy.name]["boxes"]))
        regions = envelope["dataset"]["regions"]
        stale = sum(r["asset_hash"] in features[policy.name] and
                    tuple(r["bounds"]) not in features[policy.name][r["asset_hash"]].boxes for r in regions)
        result["policies"][policy.name] = {"definition": asdict(policy),
            "metrics": report["metrics"]["knn3"], "prior": report["metrics"]["prior"],
            "coverage": report["coverage"], "images": len(crops),
            "average_crops_per_image": sum(len(c["boxes"]) for c in crops) / len(crops),
            "no_crop_images": sum(c["fallback"] for c in crops),
            "no_crop_share": sum(c["fallback"] for c in crops) / len(crops),
            "top_border_no_margin_crops": int(top_border),
            "stale_explicit_region_bounds": stale}
        atomic_json(out / "report.json", result)
    common = set.intersection(*[{r["sequence"] for r in rows if r["feature_status"] == "available"}
                               for rows in rows_by_policy.values()])
    for name, rows in rows_by_policy.items():
        result["policies"][name]["common_cohort"] = replay.metrics(
            [r for r in rows if r["sequence"] in common], "knn3", 1)
        # Supplemental operational recall counts missing/fallback as abstentions.
        result["policies"][name]["all_label_abstention_metrics"] = replay.metrics(rows, "knn3", 1)
        base_rows = {r["sequence"]: r for r in rows_by_policy["P0"]}
        lost_coverage = [r for r in rows if r["label"] and r["feature_status"] != "available"
                         and base_rows[r["sequence"]]["feature_status"] == "available"]
        result["policies"][name]["manual_acceptance_coverage_lost_vs_p0"] = {
            "count": len(lost_coverage),
            "examples": [{k: r[k] for k in ("source_asset_id", "target_id", "asset_hash")}
                         for r in lost_coverage]}
        result["policies"][name]["manual_acceptance_prediction_changes_vs_p0"] = paired_acceptance_changes(
            rows, rows_by_policy["P0"])
        if name.startswith("P3_"):
            result["policies"][name]["manual_acceptance_prediction_changes_vs_p2"] = paired_acceptance_changes(
                rows, rows_by_policy["P2_s40_f08"])
    # Store policy views as tiny indexes into the union cache, without duplicating vectors.
    result["feature_cache_layout"] = "cache/<namespace>/union/<hash>.npz holds box-aligned S36 vectors; policies.json selects boxes per image and policy; raw/<hash>.json retains all detections >0.15."
    result["containment_heuristic"] = containment_merge.__doc__
    result["relative_short_side"] = "Unexpanded detection short side / original image short side; absolute 24px minimum is tested after expansion."
    result["prominence_cost"] = prominence_cost(envelope, features, records)
    atomic_json(out / "report.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--library", type=Path, required=True)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cpu-minutes", type=float, default=55)
    parser.add_argument("--limit", type=int, help="Bounded extraction pilot; skips evaluation and sheets")
    parser.add_argument("--detect-only", action="store_true", help="Populate all raw detections before feature extraction")
    parser.add_argument("--require-raw", action="store_true", help="Consume existing raw detections only; wait at most 120 seconds per image")
    args = parser.parse_args()
    envelope = load_dataset(args.dataset)
    features, records, paths, errors, cache = extract_all(args, envelope)
    if (args.output / "STOP").exists():
        return
    if args.limit or args.detect_only:
        return
    if not records:
        raise ValueError("No usable sources")
    result = evaluate_all(args, envelope, features, records, errors, cache)
    result["inspection"] = inspection(args.output, envelope, records, paths)
    result["cpu_accounting"] = {"extraction_cpu_seconds_cumulative": result["extraction"]["cpu_seconds"],
                                "current_process_cpu_seconds": time.process_time(),
                                "note": "Extraction ledger spans resumed runs; current process overlaps that ledger. Standalone tests and the thread benchmark are additional small overhead."}
    atomic_json(args.output / "report.json", result)
    lines = ["# Crop policy chronological replay", "",
             "S36 / knn3 / next-UTC-day feedback / walk-forward 2% FP target.", "",
             "| Policy | AUC all / no Anjo | Recall | Realized FP | Coverage | Crops/image | No crop |",
             "|---|---:|---:|---:|---:|---:|---:|"]
    for name, value in result["policies"].items():
        overall, excluded = value["metrics"]["overall"], value["metrics"]["anjo_excluded"]
        walk = overall["walk_forward"]["0.02"]
        lines.append(f"| {name} | {overall['auc']:.4f} / {excluded['auc']:.4f} | "
                     f"{walk['recall']:.2%} | {walk['observed_fpr']:.2%} | {value['coverage']['fraction']:.2%} | "
                     f"{value['average_crops_per_image']:.3f} | {value['no_crop_share']:.2%} |")
    lines += ["", "## Limits", ""] + ["- " + s for s in result["limitations"]]
    (args.output / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("Complete: " + str(args.output / "report.json"), flush=True)


if __name__ == "__main__":
    main()
