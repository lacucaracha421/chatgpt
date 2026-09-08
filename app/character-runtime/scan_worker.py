"""Private native scan protocol. Source paths are resolved by the Rust owner."""
import argparse
import json
import os
from pathlib import Path
import queue
import sys
import threading

from feature_cache import FeatureCache, runtime_fingerprint
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
        cache = FeatureCache(args.cache, engine, fingerprint)
    except Exception as error:
        emit({"type": "startup_error", "error": str(error)})
        return 1
    emit({"type": "ready", "baselineFingerprint": FINGERPRINT,
          "runtimeFingerprint": fingerprint})
    refs = None
    while True:
        line = inbox.get()
        request = {}
        try:
            request = json.loads(line)
            if request["type"] == "prepare":
                refs = None
                items = request["references"]
                if len(items) != 5 or len({i["hash"] for i in items}) != 5:
                    raise ValueError("Exactly five distinct refs required")
                refs = [cache.extract(Path(i["path"]), i["hash"]) for i in items]
                emit({"type": "prepared", "referenceHashes": [r.content_hash for r in refs],
                      "cacheHits": cache.hits, "extractions": cache.misses})
            elif request["type"] == "query" and refs is not None:
                query = cache.extract(Path(request["path"]), request["hash"])
                result = engine.compare(query, refs)
                emit({"type": "result", "assetId": request["assetId"], **result,
                      "cacheHits": cache.hits, "extractions": cache.misses})
            else:
                raise ValueError("Prepare references before querying")
        except Exception as error:
            emit({"type": "asset_error" if request.get("type") == "query" else "request_error",
                  "assetId": request.get("assetId"), "error": str(error),
                  "cacheHits": cache.hits, "extractions": cache.misses})
    return 0


if __name__ == "__main__":
    sys.exit(main())
