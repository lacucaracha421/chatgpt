"""Incremental shadow scoring on the existing worker; no database access.

Only the queued query may extract features. Gallery features are validated cache
reads, never a historical extraction sweep. Replay fixes each manual witness at
its event time using references, then exposes it immediately after that event.
"""
from pathlib import Path
import json
import hashlib
import zipfile
from collections import OrderedDict

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


def score(data, features, query_hash, now, cancelled=lambda: False, groups=None):
    # The calibration's group, reference resolution and witness implementation,
    # not a second approximate scorer. Import lazily: baseline never depends on it.
    from replay_eval import Replay, duplicate_groups, time_ns
    if groups is None:
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


def cached_feature(cache, h):
    path = cache.path(h)
    if any(p.is_symlink() for p in [path, *path.parents]):
        raise ValueError("S36 cache path must not contain symlinks")
    try:
        feature = load_feature(path, h)
    except (OSError, ValueError, KeyError, EOFError, zipfile.BadZipFile):
        return None
    return None if feature.fallback else feature


def handle(model, request, cancelled=lambda: False):
    if "queries" in request:
        return handle_batch(model, request, cancelled)
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
        feature = cached_feature(cache, h)
        if feature is not None:
            feature.vectors = unit(feature.vectors)
            features[h] = feature
    if request.get("cachedOnly", False):
        # Pure cache read: no image decode, detector, encoder or cache writes.
        query = cached_feature(cache, request["hash"])
    else:
        query = extract_query(model, request, cancelled)
    if query is not None:
        query.vectors = unit(query.vectors)
        features[request["hash"]] = query
    # A fallback/missing query must not inherit a gallery copy of itself.
    else:
        features.pop(request["hash"], None)
    # One bounded cache per resident worker. Metadata changes invalidate it,
    # including uncached bridge images; target/decision changes do not.
    from replay_eval import duplicate_groups
    group_key = hashlib.sha256(json.dumps(data["images"], sort_keys=True).encode()).hexdigest()
    saved = getattr(model, "shadow_groups", None)
    if not isinstance(saved, tuple) or saved[0] != group_key:
        groups, _ = duplicate_groups(data["images"], cancelled=cancelled)
        model.shadow_groups = (group_key, groups)
    else:
        groups = saved[1]
    return {"type": "s36_shadow_result", "assetId": request["assetId"],
            "queryAvailable": query is not None and not query.fallback,
            "contentHash": request["hash"], "featureId": feature_id(),
            "scores": score(data, features, request["hash"], time_ns(request["scoredAt"]), cancelled, groups=groups)}


MAX_BATCH_QUERIES = 32
MAX_RESIDENT_FEATURES = 8192
MAX_RESIDENT_BYTES = 128 * 1024 * 1024


class GalleryFeatures:
    """Bounded raw-cache views; metadata is always replayed from the new snapshot.

    Root/feature identity changes discard all entries. File replacement, removal,
    or modification invalidates individual entries, including previously missing
    ones. Keep the original unit() arithmetic exactly once per loaded feature.
    """
    def __init__(self, cache):
        self.root = cache.root
        self.entries = OrderedDict()
        self.bytes = 0

    def read(self, cache, h):
        path = cache.path(h)
        if any(p.is_symlink() for p in [path, *path.parents]):
            raise ValueError("S36 cache path must not contain symlinks")
        try:
            stat = path.stat()
            signature = (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        except OSError:
            signature = None
        saved = self.entries.pop(h, None)
        if saved is not None:
            self.bytes -= saved[2]
        if saved is not None and saved[0] == signature:
            entry = saved
        else:
            feature = cached_feature(cache, h)
            if feature is not None:
                feature.vectors = unit(feature.vectors)
            entry = (signature, feature, 0 if feature is None else feature.vectors.nbytes)
        self.entries[h] = entry
        self.bytes += entry[2]
        while len(self.entries) > MAX_RESIDENT_FEATURES or self.bytes > MAX_RESIDENT_BYTES:
            self.bytes -= self.entries.popitem(last=False)[1][2]
        return entry[1]


def score_batch(data, features, query_hashes, now, cancelled=lambda: False, groups=None):
    """Replay once, retaining query-dependent reference resolution and float order."""
    from replay_eval import Replay, duplicate_groups, time_ns
    check_cancel(cancelled)
    if groups is None:
        groups, _ = duplicate_groups(data["images"], features, cancelled=cancelled)
    replay = Replay(data, features, groups, lag=0, witness="references", policy=data.get("policy"))
    events = [{**row, "time": time_ns(row["created_at"])} for row in data["decisions"]
              if row["origin"] == "manual" and time_ns(row["created_at"]) < now]
    replay.run([], sorted(events, key=lambda row: (row["time"], row["sequence"])), cancelled=cancelled)
    replay.release(now)
    positives, reference_groups = {}, {}
    for target in data["targets"]:
        check_cancel(cancelled)
        t = target["id"]
        reference_groups[t] = {groups.get(r["asset_hash"], r["asset_hash"])
                               for r in data["references"] if r["target_id"] == t}
    results = []
    for h in query_hashes:
        check_cancel(cancelled)
        query, result = features.get(h), {}
        group = groups.get(h, h)
        for target in data["targets"]:
            check_cancel(cancelled)
            t = target["id"]
            if group in reference_groups[t]:
                # Excluding an anchor can change automatic multi-person choices.
                # Reuse Replay's resolved-reference cache, never replay events.
                positive = replay.gallery(t, h, now)[0]
            else:
                if t not in positives:
                    # None cannot equal a hash/group in the snapshot.
                    positives[t] = replay.gallery(t, None, now)[0]
                positive = {key: v for key, v in positives[t].items()
                            if groups.get(key, key) != group}
            result[t] = (float(knn(query.vectors, np.stack(list(positive.values()))).min())
                         if query is not None and not query.fallback and positive else None)
        results.append(result)
    return results


def handle_batch(model, request, cancelled=lambda: False):
    from holdout_rules import is_hash
    from replay_eval import duplicate_groups, time_ns
    check_cancel(cancelled)
    identity = feature_id()
    if request["featureId"] != identity:
        raise ValueError("Shadow S36 feature identity mismatch")
    queries = request["queries"]
    if (request.get("cachedOnly") is not True or not isinstance(queries, list)
            or not 1 <= len(queries) <= MAX_BATCH_QUERIES
            or any(not is_hash(q["hash"]) for q in queries)
            or len({q["assetId"] for q in queries}) != len(queries)):
        raise ValueError("Invalid shadow batch")
    snapshot = Path(request["snapshotPath"])
    if snapshot.stat().st_size > 32 * 1024 * 1024:
        raise ValueError("Shadow metadata exceeds budget")
    data = json.loads(snapshot.read_text(encoding="utf-8"))
    ids = [row["id"] for row in data["targets"]]
    if ids != request["targets"] or len(set(ids)) != len(ids) or not ids:
        raise ValueError("Shadow target roster mismatch")
    cache = S36FeatureCache(model.cache_root, cleanup=False)
    resident = getattr(model, "shadow_features", None)
    if not isinstance(resident, GalleryFeatures) or resident.root != cache.root:
        resident = model.shadow_features = GalleryFeatures(cache)
    hashes = {row["asset_hash"] for row in data["references"]}
    hashes.update(row["asset_hash"] for row in data["decisions"])
    hashes.update(q["hash"] for q in queries)
    features = {}
    for h in sorted(hashes):
        check_cancel(cancelled)
        if is_hash(h):
            feature = resident.read(cache, h)
            if feature is not None:
                features[h] = feature
    group_key = hashlib.sha256(json.dumps(data["images"], sort_keys=True).encode()).hexdigest()
    saved = getattr(model, "shadow_groups", None)
    if not isinstance(saved, tuple) or saved[0] != group_key:
        groups, _ = duplicate_groups(data["images"], cancelled=cancelled)
        model.shadow_groups = (group_key, groups)
    else:
        groups = saved[1]
    scores = score_batch(data, features, [q["hash"] for q in queries],
                         time_ns(request["scoredAt"]), cancelled, groups)
    check_cancel(cancelled)
    return {"type": "s36_shadow_batch_result", "results": [
        {"type": "s36_shadow_result", "assetId": q["assetId"], "contentHash": q["hash"],
         "featureId": identity, "queryAvailable": q["hash"] in features, "scores": value}
        for q, value in zip(queries, scores)]}
