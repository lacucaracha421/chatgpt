"""Operator-only backfill: medium (768 px) copies of the spine artwork shown on the tablet 책장.

Dry-run is the default and writes nothing (the database is opened read-only, no storage client is created);
``--apply`` makes the copies. The spines are those of every game and AV work that ``/v1/collections`` serves. For each
original without a copy:

* the original is streamed from R2 (size and digest checked), encoded by the thumbnail encoder's bounded child process
  at 768 px, and stored as a new immutable object ``derived/collection-medium/v1/<sha256>.webp``;
* ``collection_artwork_medium`` records it. Nothing else is written: no publication, no existing object is replaced, and
  nothing is ever deleted.

Idempotent and resumable: finished originals are skipped, so a stopped or failed run is simply run again. Copies are made
one at a time, ``--delay`` seconds apart, at the encoder's low priority. The tablet starts using a copy when it next reads
its list (the list then names the copy's digest); until then, and for any spine without a copy, it keeps the thumbnail.

    python collection_artwork_medium_backfill.py --database data/lakomics.sqlite3            # dry run
    python collection_artwork_medium_backfill.py --database data/lakomics.sqlite3 --apply    # make copies

``--apply`` needs the service's R2 environment (R2_ENDPOINT, R2_ACCESS_KEY_ID, ...).
"""
import argparse
from contextlib import closing
import json
import signal
import sqlite3
import time
from collections import Counter
from pathlib import Path

import collection_artwork_medium as medium
import collection_authority


def connect(path, readonly):
    db = sqlite3.connect(Path(path).resolve().as_uri() + ("?mode=ro" if readonly else "?mode=rw"),
                         uri=True, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=30000")
    return db


def plan(db):
    """What is left to do, read-only. Sizes are of the originals to download and a stored-copy estimate."""
    sources = medium.wanted(db, medium.source_table(collection_authority.served_state(db)))
    sorted_sources = medium.classify(db, sources)
    todo = sorted_sources["todo"]
    return {"spines": len(sources), "ready": len(sorted_sources["ready"]), "todo": len(todo),
            "unsupported": len(sorted_sources["unsupported"]),
            "downloadBytes": sum(row["size_bytes"] for row in todo),
            "estimatedStoredBytes": len(todo) * medium.ESTIMATED_BYTES}, todo


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--database", default=str(Path(__file__).resolve().parent / "data" / "lakomics.sqlite3"))
    parser.add_argument("--apply", action="store_true", help="make the copies; the default is a read-only dry run")
    parser.add_argument("--limit", type=int, help="stop after this many attempts")
    parser.add_argument("--delay", type=float, default=1.0, help="seconds between copies")
    parser.add_argument("--max-seconds", type=float, default=7200)
    args = parser.parse_args(argv)
    if args.delay < 0 or args.max_seconds <= 0 or (args.limit is not None and args.limit < 1):
        parser.error("Use a non-negative --delay, a positive --limit and a positive --max-seconds")

    with closing(connect(args.database, readonly=not args.apply)) as db:
        summary, todo = plan(db)
        if not args.apply:
            print(json.dumps({"dryRun": True, **summary}, ensure_ascii=False), flush=True)
            return summary
        stopped = False

        def on_term(signum, frame):
            nonlocal stopped
            stopped = True

        signal.signal(signal.SIGTERM, on_term)
        signal.signal(signal.SIGINT, on_term)
        import r2
        s3, bucket = r2.thumbnail_storage_client(), r2.R2_BUCKET
        medium.install(db)
        db.commit()
        deadline = time.monotonic() + args.max_seconds
        outcome = Counter()
        for row in todo[:args.limit]:
            if stopped or time.monotonic() >= deadline:
                outcome["notReached"] += 1
                continue
            try:
                digest, size, key = medium.make(s3, bucket, row)
            except medium.MediumError as error:
                outcome["failed:" + error.code] += 1
                continue
            medium.record(db, row, digest, size, key)
            outcome["made"] += 1
            time.sleep(args.delay)
        result = {"dryRun": False, **summary, "outcome": dict(outcome)}
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return result


if __name__ == "__main__":
    main()
