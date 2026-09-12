"""Private JSON-lines worker; the future native owner supplies scoped paths.

Batch 1 has no DB access, download, persistent cache, or automatic approval.
"""
import argparse
import json
from pathlib import Path
import sys

from runtime import BASELINE, FINGERPRINT, Runtime, sha256


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, required=True)
    args = parser.parse_args()
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    engine = Runtime(args.models)
    emit({"type": "ready", "baselineFingerprint": FINGERPRINT})
    for line in sys.stdin:
        request_id = None
        try:
            request = json.loads(line)
            request_id = request["id"]
            paths = [Path(p) for p in request["references"]]
            if len(paths) != BASELINE["reference_count"] or len({sha256(p) for p in paths}) != BASELINE["reference_count"]:
                raise ValueError("Exactly five distinct reference images required")
            refs = [engine.extract(p) for p in paths]
            failures = 0
            for item in request["queries"]:
                try:
                    result = engine.compare(engine.extract(Path(item["path"])), refs)
                    emit({"type": "result", "requestId": request_id, "assetId": item["id"], **result})
                except Exception as exc:
                    failures += 1
                    emit({"type": "asset_error", "requestId": request_id, "assetId": item["id"], "error": str(exc)})
            emit({"type": "done", "requestId": request_id, "failures": failures,
                  "maxMetricVectors": engine.max_metric_vectors})
        except Exception as exc:
            emit({"type": "request_error", "requestId": request_id, "error": str(exc)})


if __name__ == "__main__":
    main()
