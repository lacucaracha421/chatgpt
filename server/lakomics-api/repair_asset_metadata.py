"""Explicit operator-only metadata repair; never uploads media or starts API services.

Preview is the default. --apply requires an operator-owned output directory; each
run retains a checked online DB backup, target manifest and per-Asset results.
Snapshot imports need exact content identity. Remaining originals are processed
sequentially with the deployed bounded encoder; its temporary thumbnails are discarded.
"""
import argparse
import json
import os
import shlex
import sqlite3
import tempfile
import time
from contextlib import closing
from pathlib import Path

import asset_metadata_repair as repair


def connect(path, readonly=False):
    db = sqlite3.connect(Path(path).resolve().as_uri() + ("?mode=ro" if readonly else "?mode=rw"),
                         uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    repair.install(db)
    return db


def missing(db):
    return [dict(row) for row in db.execute("""SELECT * FROM visible_assets
        WHERE committed=1 AND kind IN ('image','gif','video') AND
        (width IS NULL OR height IS NULL OR (kind='video' AND duration_ms IS NULL))
        ORDER BY id""")]


def snapshot_records(db, path):
    db.execute("ATTACH DATABASE ? AS pc", [Path(path).resolve().as_uri() + "?mode=ro"])
    try:
        return [dict(row) for row in db.execute("""SELECT a.id,a.sha256,a.size_bytes,a.kind,
            p.status,p.width,p.height,v.duration_ms
            FROM visible_assets a JOIN pc.assets p ON p.id=a.id
              AND p.content_hash=a.sha256 AND p.byte_size=a.size_bytes AND p.media_kind=a.kind
            LEFT JOIN pc.video_assets v ON v.asset_id=p.id
            WHERE a.committed=1 AND p.status='normal' AND a.kind IN ('image','gif','video')
              AND (a.width IS NULL OR a.height IS NULL OR (a.kind='video' AND a.duration_ms IS NULL))
            ORDER BY a.id""")]
    finally:
        db.execute("DETACH DATABASE pc")


def store(path, value):
    with open(path, "x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)


def prepare_run(db, root, candidates):
    directory = Path(tempfile.mkdtemp(prefix="apply-", dir=root))
    with closing(sqlite3.connect(directory / "before.sqlite3")) as backup:
        db.backup(backup)
        if backup.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise RuntimeError("backup verification failed")
    before = {row["id"]: dict(row) for row in db.execute("SELECT * FROM assets")}
    store(directory / "targets.json", candidates)
    store(directory / "before-rows.json", [before[row["id"]] for row in candidates])
    return directory, before


def verify_preserved(db, before, ids):
    ignored = {"width", "height", "duration_ms"}
    changed = 0
    for asset_id in ids:
        old = before[asset_id]
        row = db.execute("SELECT * FROM assets WHERE id=?", [asset_id]).fetchone()
        if row is None:
            changed += 1
            continue
        if any(row[key] != value for key, value in old.items() if key not in ignored):
            changed += 1
    return changed


def originals(db, args, directory, targets):
    # Load only storage configuration; never import app.py or run its startup hooks.
    for line in Path(args.env_file).read_text().splitlines():
        words = shlex.split(line, comments=True)
        if len(words) == 1 and "=" in words[0]:
            key, value = words[0].split("=", 1)
            if key.startswith("R2_"):
                os.environ[key] = value
    import r2
    from image_thumbnails import ImageThumbnailWorker, MAX_SOURCE_BYTES
    worker = ImageThumbnailWorker(args.database, r2.thumbnail_storage_client(), r2.R2_BUCKET,
                                  encoder_script=args.encoder)
    os.nice(15)
    results = []
    deadline = time.monotonic() + 240
    for row in targets:
        if time.monotonic() >= deadline:
            break
        try:
            with tempfile.TemporaryDirectory(prefix="metadata-source-") as temporary:
                source = str(Path(temporary) / "source")
                output = str(Path(temporary) / "discard.webp")
                worker._download(row["object_key"], source, row["size_bytes"], row["sha256"], MAX_SOURCE_BYTES)
                worker._encode(row["id"], source, output, row["kind"])
                metadata = worker._read_metadata(output + ".json", row["kind"])
            candidate = {key: row[key] for key in ("id", "sha256", "size_bytes", "kind")}
            candidate.update(status="normal", **metadata)
            outcome = repair.apply(db, [candidate])
            result = {"id": row["id"], "metadata": metadata, "result": outcome}
        except Exception as error:
            result = {"id": row["id"], "errorType": type(error).__name__}
        results.append(result)
        with open(directory / "results.jsonl", "a", encoding="utf-8") as handle:
            handle.write(json.dumps(result) + "\n")
        time.sleep(0.15)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("snapshot", "originals", "status"))
    parser.add_argument("--database", required=True)
    parser.add_argument("--snapshot")
    parser.add_argument("--output-dir")
    parser.add_argument("--env-file")
    parser.add_argument("--encoder")
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.limit <= 50:
        parser.error("limit must be between 1 and 50")
    if args.apply and (not args.output_dir or not Path(args.output_dir).is_dir()):
        parser.error("apply requires an existing output directory")
    if args.mode == "snapshot" and not args.snapshot:
        parser.error("snapshot mode requires --snapshot")
    if args.apply and args.mode == "originals" and not (args.env_file and args.encoder):
        parser.error("originals apply requires --env-file and --encoder")
    os.umask(0o077)
    with closing(connect(args.database, readonly=not args.apply)) as db:
        targets = missing(db)
        counts = {kind: sum(row["kind"] == kind for row in targets) for kind in ("image", "gif", "video")}
        print(json.dumps({"missing": counts, "total": len(targets)}), flush=True)
        if args.mode == "status":
            return
        if args.mode == "snapshot":
            records = snapshot_records(db, args.snapshot)
            validated = repair.parse_records(records)
            print(json.dumps({"exactSnapshotCandidates": len(validated)}), flush=True)
            if not args.apply:
                return
            directory, before = prepare_run(db, args.output_dir, records)
            result = repair.apply(db, validated)
            store(directory / "results.json", result)
            print(repair.report(result), flush=True)
            ids = [row["id"] for row in records]
        else:
            targets = targets[:args.limit]
            if not args.apply:
                print(json.dumps({"nextBatch": len(targets), "bytes": sum(row["size_bytes"] for row in targets)}))
                return
            directory, before = prepare_run(db, args.output_dir, targets)
            results = originals(db, args, directory, targets)
            ids = [row["id"] for row in results]
            print(json.dumps({"attempted": len(results), "errors": sum("errorType" in row for row in results)}), flush=True)
        drift = verify_preserved(db, before, ids)
        store(directory / "verification.json", {"otherColumnDrift": drift, "remaining": len(missing(db))})
        print(json.dumps({"run": str(directory), "otherColumnDrift": drift, "remaining": len(missing(db))}), flush=True)
        if drift:
            raise RuntimeError("concurrent non-metadata changes detected; inspect retained manifests")


if __name__ == "__main__":
    main()
