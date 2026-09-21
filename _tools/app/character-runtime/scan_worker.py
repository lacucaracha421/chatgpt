"""Private native scan protocol. Source paths are resolved by the Rust owner."""
import argparse
import json
import os
from pathlib import Path
import queue
import sys
import threading

from reference_regions import compare_bound, compare_bound_delta, inspect_references, resolve_references
from reference_curation import curate_references
from runtime import rgb
from feature_cache import ReferenceBundles, FeatureCache, runtime_fingerprint, extraction_fingerprint, compatible_feature_caches
from runtime import BASELINE, FINGERPRINT, Runtime

MAX_REQUEST_BYTES = 128 * 1024


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def read_requests(inbox):
    # The native owner keeps stdin open for the entire session. EOF is ownership
    # loss/cancellation, including a crashed parent, even while ONNX is running.
    while True:
        line = sys.stdin.readline(MAX_REQUEST_BYTES + 1)
        if not line:
            os._exit(0)
        if len(line.encode("utf-8")) > MAX_REQUEST_BYTES or not line.endswith("\n"):
            os._exit(2)
        inbox.put(line)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    # Optional native-ready augmentation. No flag means no import at all.
    parser.add_argument("--augmentation-model", type=Path)
    args = parser.parse_args()
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    inbox = queue.Queue(maxsize=1)
    threading.Thread(target=read_requests, args=(inbox,), daemon=True).start()
    try:
        engine = Runtime(args.models)
        fingerprint = runtime_fingerprint()
        feature_fingerprint = extraction_fingerprint()
        cache = FeatureCache(args.cache, engine, feature_fingerprint, compatible_feature_caches(args.models, feature_fingerprint))
    except Exception as error:
        emit({"type": "startup_error", "error": str(error)})
        return 1
    # Imported lazily and only on an explicit opt-in, so a disabled or broken
    # augmentation never affects startup. No event is ever emitted before ready.
    augmenter = None
    augmentation_available = False
    if args.augmentation_model is not None:
        try:
            import character_augmentation
            augmenter, _ = character_augmentation.augmenter(args.models, args.augmentation_model,
                                                            args.cache, engine, cache)
            augmentation_available = augmenter is not None
            if augmenter is None:
                augmenter = character_augmentation.Unavailable("model_unavailable")
        except Exception:
            augmenter = None
    emit({"type": "ready", "baselineFingerprint": FINGERPRINT,
          "runtimeFingerprint": fingerprint, "augmentationAvailable": augmentation_available})
    timings = None
    if os.environ.get("LAKOMICS_CHARACTER_PROFILE") == "1":
        import feature_cache, runtime
        from profiling import Timings, instrument
        timings = Timings()
        instrument(engine, feature_cache, runtime, timings)
        cache.extract = timings.wrap("cache_extract_total", cache.extract)
    refs = None
    projected = None
    selections = []
    bundles = ReferenceBundles(cache)
    resident = None
    resident_path = None
    while True:
        line = inbox.get()
        request = {}
        try:
            request = json.loads(line)
            if request["type"] == "prepare":
                refs = None
                projected = None
                items = request["references"]
                if not 5 <= len(items) <= 25 or len({i["hash"] for i in items}) != len(items):
                    raise ValueError("Five anchors and at most twenty distinct approved examples required")
                prepared = bundles.prepare(items)
                selections = [item.get("region") for item in items]
                projected = resolve_references(engine, prepared, selections)
                refs = prepared
                emit({"type": "prepared", "referenceHashes": [r.content_hash for r in refs],
                      "cacheHits": cache.hits, "extractions": cache.misses})
            elif request["type"] == "inspect_references":
                items = request["references"]
                if not 1 <= len(items) <= 25 or len({i["hash"] for i in items}) != len(items):
                    raise ValueError("Inspect one to twenty-five distinct references")
                inspected = bundles.prepare(items)
                result = inspect_references(engine, inspected, [i.get("region") for i in items])
                for item, row in zip(items, result):
                    row["assetId"] = item["assetId"]
                    row["width"], row["height"] = rgb(Path(item["path"])).size
                emit({"type": "references_inspected", "items": result})
            elif request["type"] == "curate_references":
                result = curate_references(engine, cache, request["candidates"],
                                           request["anchors"], request["limit"])
                emit({"type": "references_curated", **result})
            elif request["type"] == "load_query":
                resident = None
                query = cache.extract(Path(request["path"]), request["hash"])
                resident = (request["assetId"], request["hash"], query)
                # Keep the resident source path so an augmentation query need not
                # re-derive it; the path is never part of a decision identity.
                resident_path = (request["assetId"], Path(request["path"]))
                emit({"type": "query_loaded", "assetId": request["assetId"],
                      "contentHash": query.content_hash, "cacheHits": cache.hits, "extractions": cache.misses})
            elif request["type"] == "compare_delta":
                if resident is None or resident[:2] != (request["assetId"], request["hash"]):
                    raise ValueError("Resident query identity mismatch")
                items = request["addedReferences"]
                if not 1 <= len(items) <= 20 or len({item["hash"] for item in items}) != len(items):
                    raise ValueError("One to twenty distinct added references required")
                added = bundles.prepare(items)
                if timings is None:
                    result = compare_bound_delta(engine, resident[2], request["oldEvidence"], added, [i.get("region") for i in items])
                else:
                    with timings.measure("comparison_total"):
                        result = compare_bound_delta(engine, resident[2], request["oldEvidence"], added, [i.get("region") for i in items])
                emit({"type": "result", "assetId": request["assetId"], **result,
                      "cacheHits": cache.hits, "extractions": cache.misses})
            elif request["type"] in ("query", "compare_query") and refs is not None:
                if request["type"] == "compare_query":
                    if resident is None or resident[:2] != (request["assetId"], request["hash"]):
                        raise ValueError("Resident query identity mismatch")
                    query = resident[2]
                else:
                    query = cache.extract(Path(request["path"]), request["hash"])
                if timings is None:
                    result = compare_bound(engine, query, refs, selections, projected)
                else:
                    with timings.measure("comparison_total"):
                        result = compare_bound(engine, query, refs, selections, projected)
                emit({"type": "result", "assetId": request["assetId"], **result,
                      "cacheHits": cache.hits, "extractions": cache.misses})
            elif request["type"] in ("augmentation_prepare", "augmentation_step", "augment_query"):
                # The resident query identity, never the caller bundle, is the source of truth.
                resident_binding = {}
                if resident is not None:
                    resident_binding[resident[0]] = (resident[1], resident[2].boxes, resident[2].fallback)
                if ("path" not in request and resident_path is not None
                        and request.get("assetId") == resident_path[0]):
                    request = {**request, "path": str(resident_path[1])}
                if augmenter is None:
                    emit({"type": "augmentation_unavailable",
                          "snapshotId": str(request.get("snapshotId", "")),
                          "reason": "runtime_unavailable"})
                else:
                    try:
                        emit(augmenter.handle(request, resident_binding))
                    except Exception as error:
                        # Optional failures never propagate; the baseline stays intact.
                        emit({"type": "augmentation_unavailable",
                              "snapshotId": str(request.get("snapshotId", "")), "reason": str(error)})
            else:
                raise ValueError("Prepare references before querying")
        except Exception as error:
            emit({"type": "asset_error" if request.get("type") == "query" else "request_error",
                  "assetId": request.get("assetId"), "error": str(error),
                  "cacheHits": cache.hits, "extractions": cache.misses})
        finally:
            if timings is not None:
                print(json.dumps({"characterProfile": timings.snapshot(), "operation": request.get("type"),
                                  "cacheHits": cache.hits, "extractions": cache.misses}), file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
