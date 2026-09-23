"""Read-only metadata snapshot for offline chronological feature replay."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3

from holdout_dataset import canonical, open_readonly, records
from holdout_rules import is_hash

SCHEMA = "lakomics-feature-replay-v1"
HERE = Path(__file__).resolve().parent


def locate(library, hashes):
    """Resolve unique canonical assets/<prefix>/<hash>.* paths and verify bytes.

    No database, recursive search, backups or thumbnails. Reject escapes and
    malformed hashes before opening source bytes; callers recheck after decoding.
    """
    library = Path(library).resolve(strict=True)
    paths, errors = {}, {}
    for h in sorted(hashes):
        if not is_hash(h):
            raise ValueError("Invalid source content hash")
        folder = library / "assets" / h[:2]
        if not folder.resolve().is_relative_to(library):
            raise ValueError("Source escapes library")
        matches = sorted(folder.glob(h + ".*"))
        if len(matches) != 1:
            errors[h] = f"canonical_asset_path_candidates={len(matches)}"
            continue
        try:
            path = matches[0].resolve(strict=True)
            if not path.is_relative_to(library):
                raise ValueError("Source escapes library")
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if digest != h:
                errors[h] = "source_hash_mismatch"
                continue
            paths[h] = path
        except OSError:
            errors[h] = "source_unavailable"
    return paths, errors


def outside_library(destination, library):
    destination, library = Path(destination).resolve(), Path(library).resolve()
    if destination == library or library in destination.parents:
        raise ValueError("Output must be outside the library (including symlink destinations)")
    return destination


def save_exclusive(value, destination, library):
    destination = outside_library(destination, library)
    content = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2,
                         allow_nan=False) + "\n"
    with destination.open("x", encoding="utf-8") as stream:
        stream.write(content)


def source_hashes():
    paths = [HERE / "replay_dataset.py", HERE / "replay_eval.py", HERE / "s36_scoring.py",
             HERE / "reference_regions.py", HERE / "holdout_rules.py",
             HERE.parent / "src-tauri/src/library/character_scope.rs",
             HERE.parent / "src-tauri/src/library/image_fingerprint.rs"]
    return {str(p.relative_to(HERE.parent)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in paths if p.exists()}


def resolve_scopes(entries, series, roles, excluded_folders, exclusions, memberships):
    """Snapshot equivalent of character_scope.rs, without runtime job fences."""
    parents = {r["id"]: r["parent_id"] for r in entries}
    registered = {r["classification_id"]: bool(r["auto_classify"]) for r in series}
    originals = {r["classification_id"] for r in roles if r["role"] == "originals"}
    excluded = {r["id"] for r in excluded_folders}
    asset_exclusions = {(r["series_id"], r["asset_id"]) for r in exclusions}

    def lineage(folder):
        result = []
        while folder is not None:
            if folder in result:
                raise ValueError("Classification hierarchy contains a cycle")
            result.append(folder)
            folder = parents.get(folder)
        return result

    lines = {folder: lineage(folder) for folder in parents}
    candidates = {}
    for folder, line in lines.items():
        if folder in excluded or originals.intersection(line):
            candidates[folder] = []
            continue
        nearest = next((f for f in line if f in registered), None)
        if nearest is not None:
            selected = [nearest] if registered[nearest] else []
        else:
            selected = [s for s, enabled in registered.items()
                        if enabled and folder in lines.get(s, []) and s not in excluded]
        candidates[folder] = sorted(s for s in selected
                                    if not originals.intersection(lines.get(s, [])))
    folders = defaultdict(list)
    for row in memberships:
        folders[row["asset_id"]].append(row["classification_id"])
    return {asset: [s for s in candidates.get(fs[0], [])
                    if (s, asset) not in asset_exclusions] if len(fs) == 1 else []
            for asset, fs in folders.items()}


def build_dataset(connection, library):
    targets = records(connection, """SELECT id,display_name AS name,
        series_classification_id AS series_id,enabled,manual_only,created_at
        FROM character_targets ORDER BY id""")
    anchors = records(connection, "SELECT * FROM character_references ORDER BY target_id,slot")
    learned = records(connection, "SELECT * FROM character_learned_references ORDER BY target_id,asset_hash")
    for row in anchors:
        row.update(kind="anchor", created_at=row.get("created_at"))
    for row in learned:
        row["kind"] = "learned"
    regions = records(connection, "SELECT * FROM character_reference_regions ORDER BY target_id,asset_id")
    for row in regions:
        row["bounds"] = json.loads(row.pop("bounds_json"))
    decisions = records(connection, """SELECT sequence,target_id,source_asset_id,
        asset_hash,decision,origin,created_at FROM character_decisions ORDER BY sequence""")
    scope = {
        "entries": records(connection, "SELECT id,parent_id FROM classification_entries ORDER BY id"),
        "series": records(connection, "SELECT classification_id,auto_classify FROM character_series ORDER BY classification_id"),
        "roles": records(connection, "SELECT role,classification_id FROM classification_roles ORDER BY role,classification_id"),
        "excluded_folders": records(connection, "SELECT id FROM character_excluded_folders ORDER BY id"),
        "exclusions": records(connection, "SELECT series_id,asset_id FROM character_series_asset_exclusions ORDER BY series_id,asset_id"),
        "memberships": records(connection, "SELECT asset_id,classification_id FROM asset_classifications ORDER BY asset_id,classification_id"),
    }
    resolved = resolve_scopes(**scope)
    assets = records(connection, """SELECT id,content_hash,status,media_kind,source_url,
        perceptual_hash,perceptual_hash_quality FROM assets ORDER BY id""")
    images, lengths = {}, Counter()
    for asset in assets:
        blob = asset.pop("perceptual_hash")
        lengths[str(len(blob)) if blob is not None else "null"] += 1
        pdq = bytes(blob[:32]).hex() if isinstance(blob, bytes) and len(blob) == 64 else None
        asset["pdq"] = pdq
        asset["series_scope"] = resolved.get(asset["id"], []) if (
            asset["status"] == "normal" and asset["media_kind"] == "image") else []
        h = asset["content_hash"]
        if not is_hash(h):
            continue
        image = images.setdefault(h, {"pdq": [], "source_urls": [], "asset_ids": []})
        image["asset_ids"].append(asset["id"])
        if pdq and pdq not in image["pdq"]:
            image["pdq"].append(pdq)
        if asset["source_url"] and asset["source_url"] not in image["source_urls"]:
            image["source_urls"].append(asset["source_url"])
    data = {
        "schema": SCHEMA, "library_root": str(Path(library).resolve()),
        "database_source": connection.execute("PRAGMA database_list").fetchone()[2],
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "database_schema_version": connection.execute("PRAGMA user_version").fetchone()[0],
        "targets": targets, "references": anchors + learned, "regions": regions,
        "decisions": decisions, "assets": assets, "images": images, "scope": scope,
        "source_sha256": source_hashes(),
        "pdq_policy": {"bytes": "first 32 bytes = whole-image PDQ; second 32 = cropped PDQ",
                       "stored_blob_lengths": dict(lengths), "hamming_max": 31,
                       "quality_filter": None,
                       "verification": "image_fingerprint.rs to_stored_bytes/from_stored_bytes; holdout_dataset.py only accepts len=32 and misses current len=64 blobs"},
        "limitations": [
            "Current anchors and region selections have no creation history: treated as fixed initial configuration, not proven historical availability.",
            "Current target roster, enabled flags, series hierarchy and memberships are snapshot metadata; historical scope changes cannot be reconstructed.",
            "Scope matches the static character_scope.rs resolver: one folder, nearest registered ancestor (opt-out blocks), otherwise eligible descendant series; originals and inherited folder/asset exclusions apply. Job readiness and publication fences are not simulated.",
            "PDQ uses all stored whole-image fingerprints regardless of quality, conservatively excluding neighbors; missing PDQ remains unknown.",
        ],
    }
    return {"sha256": hashlib.sha256(canonical(data)).hexdigest(), "dataset": data}


def load_dataset(path):
    with Path(path).open(encoding="utf-8") as stream:
        envelope = json.load(stream)
    data = envelope["dataset"]
    if data.get("schema") != SCHEMA or hashlib.sha256(canonical(data)).hexdigest() != envelope.get("sha256"):
        raise ValueError("Unsupported dataset or SHA256 mismatch")
    return envelope


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    export = sub.add_parser("export")
    export.add_argument("--database", type=Path, required=True)
    export.add_argument("--output", type=Path, required=True)
    export.add_argument("--library-root", type=Path,
                        help="Original library root when exporting an externally captured DB snapshot")
    args = parser.parse_args()
    try:
        library = args.library_root or args.database.resolve().parent
        outside_library(args.output, library)
        with open_readonly(args.database) as connection:
            result = build_dataset(connection, library)
        save_exclusive(result, args.output, library)
        print(f"Exported {len(result['dataset']['decisions'])} decisions; SHA256 {result['sha256']}")
    except (OSError, ValueError, sqlite3.Error) as error:
        parser.exit(2, f"Export failed: {error}\n")


if __name__ == "__main__":
    main()
