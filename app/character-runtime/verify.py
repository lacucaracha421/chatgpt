"""Cold subprocess parity gate. Original fixtures/reports are read-only."""
import argparse
import json
from pathlib import Path
import platform
import subprocess
import sys
import time

import numpy as np
import onnxruntime as ort
import PIL

from runtime import BASELINE, FINGERPRINT, sha256

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
EXT = {".jpg", ".jpeg", ".jfif", ".png", ".webp", ".bmp", ".gif"}


def fixture(folder):
    root = ROOT / folder
    files = {name: sorted([p for p in (root/name).iterdir() if p.is_file() and p.suffix.lower() in EXT], key=lambda p: p.name.casefold())
             for name in ("refs", "target", "others")}
    baseline_path = root / "verification-fixed-report.json"
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    if folder == "test_3":
        provenance = root / "verification-generic-check.json"
        generic = json.loads(provenance.read_text(encoding="utf-8"))
        if generic["scores"].keys() != baseline["scores"].keys():
            raise ValueError("test_3 provenance score set differs")
        for name, value in generic["scores"].items():
            if abs(value["consensus2"] - baseline["scores"][name]["consensus2"]) > 1e-6:
                raise ValueError("test_3 selected-ref report differs from original")
        refs = [root / "refs" / name for name in generic["selectedReferenceFiles"]]
    else:
        provenance = baseline_path
        refs = files["refs"]
    if len(refs) != 5:
        raise ValueError("Unresolved reference selection")
    queries = [(label, path) for label in ("target", "others") for path in files[label]]
    if len({p.name for _, p in queries}) != len(queries):
        raise ValueError("Ambiguous report basename")
    paths = [p for group in files.values() for p in group] + [baseline_path, provenance]
    before = {str(p.relative_to(ROOT)): sha256(p) for p in paths}
    return {"folder": folder, "refs": refs, "queries": queries, "baseline": baseline,
            "hashes": before, "provenance": str(provenance.relative_to(ROOT))}


def classification_counts(rows, baseline):
    # Labels belong to the fixture, not the host's path separator conventions.
    def label(row):
        name = row["assetId"].replace("\\", "/").rsplit("/", 1)[-1]
        return baseline["scores"][name]["label"]
    tp = sum(row["passed"] and label(row) == "target" for row in rows)
    fp = sum(row["passed"] and label(row) == "other" for row in rows)
    fn = sum(value["label"] == "target" for value in baseline["scores"].values()) - tp
    return {"tp": tp, "fp": fp, "fn": fn}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    # Verification owns only the repository's ignored acceptance directory.
    output = args.output.resolve()
    if not output.is_relative_to(ROOT / ".acceptance"):
        raise ValueError("Output must be under .acceptance")
    output.parent.mkdir(parents=True, exist_ok=True)
    fixtures = [fixture(name) for name in ("TEST_HINA", "test_3")]
    source_hashes = {str(p.relative_to(ROOT)): sha256(p) for p in HERE.iterdir() if p.is_file()}
    report = {"baseline": BASELINE, "baselineFingerprint": FINGERPRINT,
              "runtime": {"python": sys.version, "os": platform.platform(), "numpy": np.__version__, "pillow": PIL.__version__, "onnxruntime": ort.__version__},
              "sourceHashes": source_hashes, "datasets": [], "coldInference": True}
    command = [sys.executable, "-B", str(HERE/"worker.py"), "--models", str(ROOT/"TEST_kisaki/_experiment/models")]
    started = time.perf_counter()
    with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8") as worker:
        try:
            ready = json.loads(worker.stdout.readline())
            if ready.get("type") != "ready" or ready.get("baselineFingerprint") != FINGERPRINT:
                raise ValueError("Worker did not initialize frozen baseline")
            for data in fixtures:
                request = {"id": data["folder"], "references": [str(p) for p in data["refs"]],
                           "queries": [{"id": p.relative_to(ROOT/data["folder"]).as_posix(), "path": str(p)} for _, p in data["queries"]]}
                # A failure between valid items must not discard later results.
                request["queries"].insert(1, {"id": "missing-fixture", "path": str(output.parent/"intentionally-missing-image.png")})
                worker.stdin.write(json.dumps(request)+"\n"); worker.stdin.flush()
                rows, errors = [], []
                run_started = time.perf_counter()
                while True:
                    line = worker.stdout.readline()
                    if not line:
                        raise RuntimeError(f"Worker exited before done: {worker.poll()}")
                    event = json.loads(line)
                    if event["type"] == "done":
                        done = event; break
                    if event["type"] == "asset_error":
                        errors.append(event); continue
                    if event["type"] != "result":
                        raise RuntimeError(event)
                    rows.append(event)
                    print(f"{data['folder']}: {len(rows)}/{len(data['queries'])}", flush=True)
                deltas, mismatches = [], []
                for row in rows:
                    expected = data["baseline"]["scores"][Path(row["assetId"]).name]
                    delta = abs(row["distance"] - expected["consensus2"])
                    deltas.append(delta)
                    if delta > 1e-6 or row["passed"] != expected["consensusPass"]:
                        mismatches.append({"assetId": row["assetId"], "delta": delta, "expected": expected, "actual": row})
                counts = classification_counts(rows, data["baseline"])
                expected_counts = {key: data["baseline"]["strategies"]["consensus2"][key] for key in counts}
                expected_ids = {p.relative_to(ROOT/data["folder"]).as_posix() for _, p in data["queries"]}
                intact = all(sha256(ROOT/p) == h for p, h in data["hashes"].items())
                passed = (len(rows) == len(data["queries"]) and not mismatches and intact
                          and {row["assetId"] for row in rows} == expected_ids and counts == expected_counts
                          and len(errors) == 1 and errors[0]["assetId"] == "missing-fixture"
                          and done["failures"] == 1 and done["maxMetricVectors"] <= 48)
                result = {"dataset": data["folder"], "passed": passed, "referenceProvenance": data["provenance"],
                          "references": [str(p.relative_to(ROOT)) for p in data["refs"]], "inputHashes": data["hashes"],
                          "count": len(rows), "maxAbsDistanceDelta": max(deltas, default=0), "mismatches": mismatches,
                          "originalLabels": counts, "sourceFilesUnchanged": intact,
                          "wholeFallbackQueries": sum(row["wholeFallback"] for row in rows),
                          "maxMetricVectors": done["maxMetricVectors"], "expectedErrors": errors,
                          "elapsedSeconds": time.perf_counter()-run_started, "results": rows}
                report["datasets"].append(result)
                output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
                print(json.dumps({k:result[k] for k in ["dataset", "passed", "maxAbsDistanceDelta", "originalLabels"]}), flush=True)
            worker.stdin.write(json.dumps({"id": "invalid-refs", "references": [], "queries": []})+"\n"); worker.stdin.flush()
            report["invalidReferencesRejected"] = json.loads(worker.stdout.readline()).get("type") == "request_error"
            worker.stdin.close()
            report["workerExitCode"] = worker.wait(timeout=30)
        finally:
            if worker.poll() is None:
                worker.kill(); worker.wait()
    report["sourceCodeUnchanged"] = all(sha256(ROOT/p) == h for p, h in source_hashes.items())
    report["elapsedSeconds"] = time.perf_counter()-started
    report["passed"] = all(r["passed"] for r in report["datasets"]) and report["sourceCodeUnchanged"] and report["invalidReferencesRejected"] and report["workerExitCode"] == 0
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "output": str(output), "elapsedSeconds": report["elapsedSeconds"]}), flush=True)
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
