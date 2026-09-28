"""Export Kaloscope2 pack features to a portable import SQLite; never opens a library.

python artist_style_export.py --out /tmp/artist-style.sqlite [--daily DIR]
Optional --preds and --manifest override the trial output paths. --daily adds every
`*.npz` in DIR written by the nightly style job (`ids` = asset ids, `feat` = N×2048), so a
nightly export is always a full one and the centring mean stays over the whole library.
The mean covers every input row, including rows later skipped by the app import.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import tempfile

import numpy as np

DIM = 2048


def daily_rows(folder: Path) -> tuple[list[str], np.ndarray]:
    """Rows from the nightly style job; later chunks win for a repeated asset id."""
    rows: dict[str, np.ndarray] = {}
    for chunk in sorted(folder.glob("*.npz")):
        with np.load(chunk, allow_pickle=False) as data:
            ids, feat = data["ids"], np.asarray(data["feat"], dtype=np.float32)
        if ids.ndim != 1 or feat.shape != (len(ids), DIM):
            raise ValueError(f"{chunk.name}: expected ids[N] and feat[N, {DIM}]")
        for value, vector in zip(ids, feat):
            rows[value.decode("utf-8") if isinstance(value, bytes) else str(value)] = vector
    return list(rows), (np.stack(list(rows.values())) if rows else np.zeros((0, DIM), np.float32))


def export(preds: Path, manifest_path: Path, output: Path, daily: Path | None = None) -> int:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("manifest must map pack indices to asset ids")
    with np.load(preds, allow_pickle=False) as data:
        ids = data["ids"]
        features = np.asarray(data["feat"], dtype=np.float32)
    if ids.ndim != 1 or features.shape != (len(ids), DIM) or len(ids) == 0:
        raise ValueError("expected nonempty ids[N] and feat[N, 2048]")
    if not np.isfinite(features).all():
        raise ValueError("features contain NaN or infinity")
    asset_ids = []
    for value in ids:
        if isinstance(value, bytes):
            value = value.decode("utf-8")
        key = Path(str(value)).stem
        asset_id = manifest.get(key)
        if not isinstance(asset_id, str) or not asset_id.strip():
            raise ValueError(f"unknown pack index: {value!r}")
        asset_ids.append(asset_id)
    if len(set(asset_ids)) != len(asset_ids):
        raise ValueError("multiple pack rows map to the same asset id")
    if daily is not None and daily.is_dir():
        extra_ids, extra = daily_rows(daily)
        known = {asset_id: n for n, asset_id in enumerate(asset_ids)}
        keep = [n for n, asset_id in enumerate(extra_ids) if asset_id not in known]
        for n, asset_id in enumerate(extra_ids):
            if asset_id in known:
                features[known[asset_id]] = extra[n]
        asset_ids += [extra_ids[n] for n in keep]
        features = np.concatenate([features, extra[keep]]) if keep else features
        if not np.isfinite(features).all():
            raise ValueError("daily features contain NaN or infinity")
    mean = features.mean(axis=0, dtype=np.float64).astype("<f4")
    with np.errstate(over="ignore"):
        packed = features.astype("<f2")
    if not np.isfinite(packed).all():
        raise ValueError("features exceed the finite f16 range")
    output = output.expanduser().resolve()
    if output in (preds.expanduser().resolve(), manifest_path.expanduser().resolve()):
        raise ValueError("output must not replace an input")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{output.name}.", dir=output.parent)
    os.close(fd)
    try:
        with closing(sqlite3.connect(name)) as conn, conn:
            conn.executescript("CREATE TABLE meta(key TEXT PRIMARY KEY, value);"
                               "CREATE TABLE features(asset_id TEXT PRIMARY KEY, vector BLOB NOT NULL);")
            conn.executemany("INSERT INTO meta VALUES (?, ?)",
                             [("model", "kaloscope2"), ("dim", str(DIM)), ("mean", mean.tobytes())])
            conn.executemany("INSERT INTO features VALUES (?, ?)",
                             ((asset_id, vector.tobytes()) for asset_id, vector in zip(asset_ids, packed)))
        os.replace(name, output)
    finally:
        Path(name).unlink(missing_ok=True)
    return len(asset_ids)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preds", type=Path, default=Path("~/.cache/lakomics-oss/kaloscope/out/preds.npz"))
    parser.add_argument("--manifest", type=Path, default=Path("~/.cache/lakomics-oss/pixai10/manifest.json"))
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--daily", type=Path, help="folder of nightly style chunks (asset ids)")
    args = parser.parse_args()
    try:
        count = export(args.preds.expanduser(), args.manifest.expanduser(), args.out,
                       args.daily.expanduser() if args.daily else None)
    except (ValueError, OSError, KeyError, sqlite3.Error) as error:
        parser.exit(1, f"artist style export failed: {error}\n")
    print(f"Exported {count} features (kaloscope2, {DIM} dimensions) to {args.out}")


if __name__ == "__main__":
    main()
