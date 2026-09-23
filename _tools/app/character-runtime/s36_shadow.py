"""Incremental shadow scoring on the existing worker; no database access.

Only the queued query may extract features. Gallery features are validated cache
reads, never a historical extraction sweep. Replay fixes each manual witness at
its event time using references, then exposes it immediately after that event.
"""
from pathlib import Path
import json
import zipfile

import numpy as np

from character_augmentation import S36FeatureCache
from character_encoder import feature_id, load_feature, validate
from feature_cache import extraction_fingerprint, FeatureCache
from runtime import sha256
from s36_scoring import knn, unit


def check_cancel(cancelled):
    if cancelled():
        raise ValueError("Shadow scoring preempted")


def extract_query(model, request, cancelled=lambda: False):
    """Reuse S36 cache and the existing B36 geometry; never run another detector."""
    check_cancel(cancelled)
    h, path = request["hash"], Path(request["path"])
    if request["mediaKind"] != "image":
        return None
    if sha256(path) != h:
        raise ValueError("Shadow source hash changed")
    # Native queue has already extracted this image. Pure read: a missing B36
    # checkpoint abstains, it does not rerun detection or populate B36 caches.
    reader = FeatureCache.__new__(FeatureCache)
    base = reader._read(Path(model.cache_root) / extraction_fingerprint() / (h + ".npz"), h)
    if base is None or base.fallback:
        return None
    cache = S36FeatureCache(model.cache_root, cleanup=False)
    # Refuse redirected cache writes, including same-library symlinks.
    for directory in [Path(model.cache_root), *Path(model.cache_root).parents, cache.root.parent, cache.root, cache.path(h)]:
        if directory.is_symlink():
            raise ValueError("S36 cache path must not contain symlinks")
    feature = cache.read(h, base.boxes)
    if feature is None:
        feature = validate(model.encoder_for().extract(path, h, base.boxes))
        if feature.content_hash != h or feature.fallback or list(feature.boxes) != list(base.boxes):
            raise ValueError("S36 geometry differs from native query")
        if sha256(path) != h:
            raise ValueError("Shadow source changed during extraction")
        check_cancel(cancelled)
        cache.write(feature)
    return feature


def score(data, features, query_hash, now, cancelled=lambda: False):
    # The calibration's group, reference resolution and witness implementation,
    # not a second approximate scorer. Import lazily: baseline never depends on it.
    from replay_eval import Replay, duplicate_groups, time_ns
    groups, _ = duplicate_groups(data["images"], features, cancelled=cancelled)
    replay = Replay(data, features, groups, lag=0, witness="references", policy=data.get("policy"))
    events = []
    for row in data["decisions"]:
        if row["origin"] == "manual" and time_ns(row["created_at"]) < now:
            events.append({**row, "time": time_ns(row["created_at"])})
    # Replay.run handles simultaneous labels without feeding them into each other.
    replay.run([], sorted(events, key=lambda row: (row["time"], row["sequence"])), cancelled=cancelled)
    replay.release(now)
    query = features.get(query_hash)
    result = {}
    for target in data["targets"]:
        check_cancel(cancelled)
        positive, _, _ = replay.gallery(target["id"], query_hash, now)
        result[target["id"]] = (float(knn(query.vectors, np.stack(list(positive.values()))).min())
                                 if query is not None and not query.fallback and positive else None)
    return result


def handle(model, request, cancelled=lambda: False):
    from replay_eval import time_ns
    check_cancel(cancelled)
    if request["featureId"] != feature_id():
        raise ValueError("Shadow S36 feature identity mismatch")
    snapshot = Path(request["snapshotPath"])
    if snapshot.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Shadow metadata exceeds budget")
    data = json.loads(snapshot.read_text(encoding="utf-8"))
    ids = [row["id"] for row in data["targets"]]
    if ids != request["targets"] or len(set(ids)) != len(ids) or not ids:
        raise ValueError("Shadow target roster mismatch")
    from holdout_rules import is_hash
    if not is_hash(request["hash"]):
        raise ValueError("Invalid query hash")
    features = {}
    cache = S36FeatureCache(model.cache_root, cleanup=False)
    hashes = {row["asset_hash"] for row in data["references"]}
    hashes.update(row["asset_hash"] for row in data["decisions"])
    # No automatic labels or other targets are included in the native snapshot.
    for h in sorted(hashes):
        check_cancel(cancelled)
        if not is_hash(h):
            continue
        try:
            feature = load_feature(cache.path(h), h)
        except (OSError, ValueError, KeyError, EOFError, zipfile.BadZipFile):
            continue
        if not feature.fallback:
            feature.vectors = unit(feature.vectors)
            features[h] = feature
    query = extract_query(model, request, cancelled)
    if query is not None:
        query.vectors = unit(query.vectors)
        features[request["hash"]] = query
    # A fallback/missing query must not inherit a gallery copy of itself.
    else:
        features.pop(request["hash"], None)
    return {"type": "s36_shadow_result", "assetId": request["assetId"],
            "contentHash": request["hash"], "featureId": feature_id(),
            "scores": score(data, features, request["hash"], time_ns(request["scoredAt"]), cancelled)}
