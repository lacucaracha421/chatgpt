"""Private native scan protocol. Source paths are resolved by the Rust owner."""
import argparse
import json
import os
from pathlib import Path
import queue
import sys
import threading
from collections import OrderedDict

from learned_compare import compare_supported
from feature_cache import FeatureCache, runtime_fingerprint, extraction_fingerprint, compatible_feature_caches
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
    emit({"type": "ready", "baselineFingerprint": FINGERPRINT,
          "runtimeFingerprint": fingerprint})
    timings = None
    if os.environ.get("LAKOMICS_CHARACTER_PROFILE") == "1":
        import feature_cache, runtime
        from profiling import Timings, instrument
        timings = Timings()
        instrument(engine, feature_cache, runtime, timings)
        cache.extract = timings.wrap("cache_extract_total", cache.extract)
    refs = None
    bundles = OrderedDict()
    resident = None
    while True:
        line = inbox.get()
        request = {}
        try:
            request = json.loads(line)
            if request["type"] == "prepare":
                refs = None
                items = request["references"]
                if not 5 <= len(items) <= 25 or len({i["hash"] for i in items}) != len(items):
                    raise ValueError("Five anchors and at most twenty distinct approved examples required")
                key = tuple(i["hash"] for i in items)
                refs = bundles.pop(key, None)
                if refs is None:
                    refs = [cache.extract(Path(i["path"]), i["hash"]) for i in items]
                bundles[key] = refs
                while len(bundles) > 32:
                    bundles.popitem(last=False)
                emit({"type": "prepared", "referenceHashes": [r.content_hash for r in refs],
                      "cacheHits": cache.hits, "extractions": cache.misses})
            elif request["type"] == "load_query":
                resident = None
                query = cache.extract(Path(request["path"]), request["hash"])
                resident = (request["assetId"], request["hash"], query)
                emit({"type": "query_loaded", "assetId": request["assetId"],
                      "contentHash": query.content_hash, "cacheHits": cache.hits, "extractions": cache.misses})
            elif request["type"] in ("query", "compare_query") and refs is not None:
                if request["type"] == "compare_query":
                    if resident is None or resident[:2] != (request["assetId"], request["hash"]):
                        raise ValueError("Resident query identity mismatch")
                    query = resident[2]
                else:
                    query = cache.extract(Path(request["path"]), request["hash"])
                if timings is None:
                    result = compare_supported(engine, query, refs)
                else:
                    with timings.measure("comparison_total"):
                        result = compare_supported(engine, query, refs)
                emit({"type": "result", "assetId": request["assetId"], **result,
                      "cacheHits": cache.hits, "extractions": cache.misses})
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
