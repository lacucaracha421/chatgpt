"""Convert tagger backfill output into a Lakomics 자동 태그 import file.

The desktop app imports the result from Settings > 라이브러리 > 자동 태그. This script
never opens a Lakomics library: it reads the tagger's `.npz` chunks and tag CSV and
writes a small, self-describing SQLite file:

    meta(key, value)            format=lakomics-auto-tags, version=1, model, created_at, min_score
    vocabulary(tag, category)   every tag the model can emit (Danbooru name, category name)
    asset_tags(asset_id, tag, score)

Chunk layout (PixAI tagger backfill): `asset_ids` (object array; the first `len(emb)`
entries are tagged assets, trailing ones failed), `rows` (index into asset_ids), `tags`
(index into the tag CSV rows), `scores` (float16). The CSV has `name` and a Danbooru
`category` number. Standard library plus numpy only.

Example:
    python auto_tags_export.py --model pixai-v0.9 \
        --backfill ~/.cache/lakomics-oss/pixai/backfill \
        --tags ~/.cache/lakomics-oss/pixai/models/v09_selected_tags.csv \
        --out ~/lakomics-auto-tags-pixai-v0.9.sqlite
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import os
import sqlite3
import sys
from pathlib import Path

import numpy as np

FORMAT = "lakomics-auto-tags"
VERSION = "1"
DEFAULT_MIN_SCORE = 0.35
# Danbooru tag categories.
CATEGORIES = {0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta", 9: "rating"}


def read_vocabulary(csv_path: Path) -> list[tuple[str, str] | None]:
    """Tag CSV rows in file order as (name, category name); None for placeholder rows
    (empty name), which keep their index so model outputs still line up."""
    vocabulary: list[tuple[str, str] | None] = []
    with csv_path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            name = row["name"].strip()
            if not name:
                vocabulary.append(None)
                continue
            category = CATEGORIES.get(int(row["category"]))
            if category is None:
                raise ValueError(f"unsupported tag category: {row!r}")
            vocabulary.append((name, category))
    return vocabulary


def chunk_rows(chunk_path: Path, vocabulary: list[tuple[str, str] | None], min_score: float):
    """Yield (asset_id, tag, score) for one backfill chunk, keeping scores >= min_score.
    Placeholder vocabulary rows are dropped."""
    with np.load(chunk_path, allow_pickle=True) as chunk:
        asset_ids = chunk["asset_ids"]
        tagged = len(chunk["emb"])
        rows = chunk["rows"]
        tags = chunk["tags"]
        scores = chunk["scores"].astype(np.float32)
    keep = scores >= min_score
    for row, tag, score in zip(rows[keep], tags[keep], scores[keep]):
        if row >= tagged:
            raise ValueError(f"{chunk_path.name}: row {row} points at an untagged asset")
        entry = vocabulary[int(tag)]
        if entry is not None:
            yield str(asset_ids[row]), entry[0], round(float(min(score, 1.0)), 4)


def export(backfill: Path, tags_csv: Path, model: str, out: Path, min_score: float = DEFAULT_MIN_SCORE,
           limit_chunks: int | None = None) -> dict:
    vocabulary = read_vocabulary(tags_csv)
    chunks = sorted(backfill.glob("chunk_*.npz"))
    if limit_chunks is not None:
        chunks = chunks[:limit_chunks]
    if not chunks:
        raise ValueError(f"no chunk_*.npz files in {backfill}")
    partial = out.with_name(out.name + ".partial")
    if partial.exists():
        partial.unlink()
    connection = sqlite3.connect(partial)
    try:
        connection.executescript(
            """
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE vocabulary (tag TEXT PRIMARY KEY, category TEXT NOT NULL);
            CREATE TABLE asset_tags (asset_id TEXT NOT NULL, tag TEXT NOT NULL, score REAL NOT NULL,
                                     PRIMARY KEY (asset_id, tag)) WITHOUT ROWID;
            """
        )
        created_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        connection.executemany("INSERT INTO meta VALUES (?, ?)", [
            ("format", FORMAT), ("version", VERSION), ("model", model),
            ("created_at", created_at), ("min_score", str(min_score)),
        ])
        # Duplicate names keep the first category.
        connection.executemany("INSERT OR IGNORE INTO vocabulary VALUES (?, ?)", [entry for entry in vocabulary if entry])
        assets: set[str] = set()
        rows = 0
        for chunk_path in chunks:
            batch = list(chunk_rows(chunk_path, vocabulary, min_score))
            # A tag repeated for one asset keeps its highest score.
            connection.executemany(
                "INSERT INTO asset_tags VALUES (?, ?, ?) ON CONFLICT(asset_id, tag) DO UPDATE SET score = max(score, excluded.score)",
                batch,
            )
            assets.update(asset for asset, _, _ in batch)
            rows += len(batch)
        connection.commit()
        stored = connection.execute("SELECT COUNT(*) FROM asset_tags").fetchone()[0]
    finally:
        connection.close()
    os.replace(partial, out)
    return {"chunks": len(chunks), "assets": len(assets), "rows": stored, "read_rows": rows,
            "vocabulary": sum(1 for entry in vocabulary if entry), "model": model, "out": str(out)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--backfill", type=Path, required=True, help="folder with chunk_*.npz")
    parser.add_argument("--tags", type=Path, required=True, help="tagger tag CSV (name, category)")
    parser.add_argument("--model", required=True, help="model label stored in the library, e.g. pixai-v0.9")
    parser.add_argument("--out", type=Path, required=True, help="import file to write (.sqlite)")
    parser.add_argument("--min-score", type=float, default=DEFAULT_MIN_SCORE)
    parser.add_argument("--limit-chunks", type=int, default=None, help="only the first N chunks (testing)")
    parser.add_argument("--force", action="store_true", help="overwrite an existing output file")
    args = parser.parse_args(argv)
    if args.out.exists() and not args.force:
        parser.error(f"{args.out} exists; pass --force to overwrite")
    if not 0.0 < args.min_score <= 1.0:
        parser.error("--min-score must be in (0, 1]")
    summary = export(args.backfill.expanduser(), args.tags.expanduser(), args.model, args.out.expanduser(),
                     args.min_score, args.limit_chunks)
    for key, value in summary.items():
        print(f"{key}: {value}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
