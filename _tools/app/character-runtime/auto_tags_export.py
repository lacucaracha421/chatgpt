"""Export PixAI tags and optional dual-tagger review signals to import SQLite.

Legacy v0.9: --backfill DIR --tags CSV --model pixai-v0.9 --out FILE
v1.0: --backfill ~/.cache/lakomics-oss/hfjob/out/pixai-lib \
      --tags ~/.cache/lakomics-oss/pixai10/v10_tags.csv --model pixai-v1.0 \
      --manifest ~/.cache/lakomics-oss/pixai10/manifest.json \
      --canary-backfill ~/.cache/lakomics-oss/hfjob/out/canary-lib \
      --canary-tags ~/.cache/lakomics-oss/canary/model/selected_tags.csv \
      --target-tags ~/.cache/lakomics-oss/hfjob/maps/target_tags.json --out FILE

Never opens the library. Import remains a full replacement, not an incremental merge:
include all retained chunks on later runs. v0.9 inputs and version-1 imports remain
supported. The optional tagger_review_version=1 extension carries raw character
scores, vocabulary, per-source completion coverage and library-specific target tags.
Missing sparse scores mean <0.1 ONLY for assets actually covered by that source.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import os
import sqlite3
import sys
from pathlib import Path

import numpy as np

FORMAT = "lakomics-auto-tags"
VERSION = "1"
DEFAULT_MIN_SCORE = 0.35
CATEGORIES = {0: "general", 1: "artist", 3: "copyright", 4: "character", 5: "meta", 9: "rating"}
IDENTITY_CATEGORIES = {"character", "copyright", "artist"}


def read_vocabulary(csv_path: Path) -> list[tuple[str, str] | None]:
    """Indices are CSV row positions, never the CSV's id/tag_id column."""
    vocabulary = []
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


def pack_asset_id(value, manifest: dict[str, str]) -> str:
    """Resolve pack names such as 000001 or 000001.jpg; unknown names fail closed."""
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    key = Path(str(value)).stem
    asset_id = manifest.get(key)
    if not isinstance(asset_id, str) or not asset_id.strip():
        raise ValueError(f"unknown pack index: {value!r}")
    return asset_id


def read_chunk(path: Path, vocabulary, manifest=None, direct_ids: bool = False):
    """`direct_ids`: chunks from the laptop's daily tagger store asset ids, not pack indices."""
    with np.load(path, allow_pickle=True) as chunk:
        if "ids" in chunk and direct_ids:
            ids = [value.decode("utf-8") if isinstance(value, bytes) else str(value) for value in chunk["ids"]]
        elif "ids" in chunk:
            if manifest is None:
                raise ValueError("pack-index chunks require --manifest")
            ids = [pack_asset_id(value, manifest) for value in chunk["ids"]]
        else:
            # v0.9 includes failed assets at the end; emb only covers successful ones.
            ids = [str(value) for value in chunk["asset_ids"][:len(chunk["emb"])]]
        rows, tags, scores = chunk["rows"], chunk["tags"], chunk["scores"].astype(np.float32)
    if not (len(rows) == len(tags) == len(scores)):
        raise ValueError(f"{path.name}: sparse arrays have different lengths")
    batch = []
    for row, tag, score in zip(rows, tags, scores):
        if int(row) != row or not 0 <= row < len(ids) or int(tag) != tag or not 0 <= tag < len(vocabulary):
            raise ValueError(f"{path.name}: invalid sparse index")
        if not np.isfinite(score) or not 0 <= score <= 1:
            raise ValueError(f"{path.name}: invalid score")
        entry = vocabulary[int(tag)]
        if entry is not None:
            # Compare decoded float16 values without rounding across a policy threshold.
            batch.append((ids[int(row)], entry[0], entry[1], float(score)))
    return ids, batch


def chunk_rows(chunk_path: Path, vocabulary, min_score: float):
    """Retained v0.9 helper."""
    _, batch = read_chunk(chunk_path, vocabulary)
    yield from ((asset, tag, score) for asset, tag, _, score in batch if score >= min_score)


def export(backfill: Path, tags_csv: Path, model: str, out: Path,
           min_score: float = DEFAULT_MIN_SCORE, limit_chunks: int | None = None, *,
           manifest_path: Path | None = None, canary_backfill: Path | None = None,
           canary_tags: Path | None = None, target_tags: Path | None = None,
           daily: Path | None = None, canary_daily: Path | None = None) -> dict:
    if not 0 < min_score <= 1 or (limit_chunks is not None and limit_chunks < 1):
        raise ValueError("invalid threshold or chunk limit")
    extension = any(p is not None for p in (canary_backfill, canary_tags, target_tags))
    if extension and not all(p is not None for p in (manifest_path, canary_backfill, canary_tags, target_tags)):
        raise ValueError("dual-tagger export requires manifest, canary inputs and target tags")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path else None
    if manifest is not None and not isinstance(manifest, dict):
        raise ValueError("manifest must map pack indices to asset ids")
    vocabulary = read_vocabulary(tags_csv)
    chunks = sorted(backfill.glob("chunk_*.npz"))[:limit_chunks]
    # Later daily runs add chunks keyed by asset id; an import always carries every chunk.
    daily_chunks = set(sorted(daily.glob("daily_*.npz"))) if daily else set()
    canary_daily_chunks = set(sorted(canary_daily.glob("daily_*.npz"))) if canary_daily else set()
    chunks += sorted(daily_chunks)
    if not chunks:
        raise ValueError(f"no chunk_*.npz files in {backfill}")
    partial = out.with_name(out.name + ".partial")
    if partial.exists():
        partial.unlink()
    connection = sqlite3.connect(partial)
    try:
        connection.executescript("""
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE vocabulary (tag TEXT PRIMARY KEY, category TEXT NOT NULL);
            CREATE TABLE asset_tags (asset_id TEXT NOT NULL, tag TEXT NOT NULL, score REAL NOT NULL,
                                     PRIMARY KEY (asset_id, tag)) WITHOUT ROWID;
        """)
        connection.executemany("INSERT INTO meta VALUES (?, ?)", [
            ("format", FORMAT), ("version", VERSION), ("model", model),
            ("created_at", dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")),
            ("min_score", str(min_score)),
        ])
        connection.executemany("INSERT OR IGNORE INTO vocabulary VALUES (?, ?)", [v for v in vocabulary if v])
        assets = set()
        for chunk_path in chunks:
            ids, batch = read_chunk(chunk_path, vocabulary, manifest, chunk_path in daily_chunks)
            assets.update(ids)
            connection.executemany(
                "INSERT INTO asset_tags VALUES (?, ?, ?) ON CONFLICT(asset_id, tag) DO UPDATE SET score=max(score,excluded.score)",
                [(a, t, s) for a, t, c, s in batch
                 if s >= (float(np.float16(0.1)) if manifest is not None and c in IDENTITY_CATEGORIES else min_score)],
            )
        if extension:
            connection.executescript("""
                CREATE TABLE character_scores(asset_id TEXT, source TEXT, tag TEXT, score REAL,
                    PRIMARY KEY(asset_id,source,tag)) WITHOUT ROWID;
                CREATE TABLE tagger_assets(asset_id TEXT, source TEXT, PRIMARY KEY(asset_id,source)) WITHOUT ROWID;
                CREATE TABLE tagger_vocabulary(source TEXT, tag TEXT, PRIMARY KEY(source,tag)) WITHOUT ROWID;
                CREATE TABLE target_tags(target_id TEXT, tag TEXT, PRIMARY KEY(target_id,tag)) WITHOUT ROWID;
            """)
            connection.execute("INSERT INTO meta VALUES ('tagger_review_version','1')")
            mapping = json.loads(target_tags.read_text(encoding="utf-8"))
            if not isinstance(mapping, dict):
                raise ValueError("target tags must be an object")
            for target, tags in mapping.items():
                if not isinstance(target, str) or not target or not isinstance(tags, list) or not all(isinstance(t, str) and t.strip() for t in tags):
                    raise ValueError("invalid target tag mapping")
                connection.executemany("INSERT OR IGNORE INTO target_tags VALUES (?,?)", [(target, t) for t in tags])
            for source, paths, vocab in [
                ("pixai", chunks, vocabulary),
                ("canary", sorted(canary_backfill.glob("chunk_*.npz"))[:limit_chunks] + sorted(canary_daily_chunks),
                 read_vocabulary(canary_tags)),
            ]:
                if not paths:
                    raise ValueError(f"no chunks for {source}")
                connection.executemany("INSERT OR IGNORE INTO tagger_vocabulary VALUES (?,?)",
                                       [(source, t) for t, c in (v for v in vocab if v) if c == "character"])
                for path in paths:
                    ids, batch = read_chunk(path, vocab, manifest, path in daily_chunks or path in canary_daily_chunks)
                    connection.executemany("INSERT OR IGNORE INTO tagger_assets VALUES (?,?)", [(a, source) for a in ids])
                    connection.executemany(
                        "INSERT INTO character_scores VALUES (?,?,?,?) ON CONFLICT(asset_id,source,tag) DO UPDATE SET score=max(score,excluded.score)",
                        [(a, source, t, s) for a, t, c, s in batch if c == "character" and s >= float(np.float16(0.1))],
                    )
        connection.commit()
        stored = connection.execute("SELECT COUNT(*) FROM asset_tags").fetchone()[0]
    finally:
        connection.close()
    os.replace(partial, out)
    return {"chunks": len(chunks), "assets": len(assets), "rows": stored,
            "vocabulary": sum(v is not None for v in vocabulary), "model": model, "out": str(out)}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("backfill", "tags", "out"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--model", required=True)
    for name in ("manifest", "canary-backfill", "canary-tags", "target-tags", "daily", "canary-daily"):
        parser.add_argument(f"--{name}", type=Path)
    parser.add_argument("--min-score", type=float, default=DEFAULT_MIN_SCORE)
    parser.add_argument("--limit-chunks", type=int)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    args.out = args.out.expanduser()
    if args.out.exists() and not args.force:
        parser.error(f"{args.out} exists; pass --force to overwrite")
    def path(value):
        return value.expanduser() if value is not None else None
    summary = export(path(args.backfill), path(args.tags), args.model, args.out,
                     args.min_score, args.limit_chunks, manifest_path=path(args.manifest),
                     canary_backfill=path(args.canary_backfill), canary_tags=path(args.canary_tags),
                     target_tags=path(args.target_tags), daily=path(args.daily),
                     canary_daily=path(args.canary_daily))
    for key, value in summary.items():
        print(f"{key}: {value}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
