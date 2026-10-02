#!/usr/bin/env bash
# Preview by default. Only --apply permits deletion.
set -euo pipefail
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
exec python3 - "$repo_root" "$@" <<'PY'
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description="Preview regenerable Rust caches (old = untouched for 7 days).")
parser.add_argument("repo", help=argparse.SUPPRESS)
parser.add_argument("--apply", action="store_true", help="delete the reported caches")
args = parser.parse_args()

def refuse_active_build():
    processes = subprocess.check_output(["ps", "-A", "-o", "comm="], text=True)
    if any(Path(name.strip()).name in {"cargo", "rustc", "cargo.exe", "rustc.exe"}
           for name in processes.splitlines()):
        sys.exit("Refusing cleanup: cargo or rustc is running.")

refuse_active_build()
target = Path(args.repo) / "_tools/app/src-tauri/target"
native = Path.home() / ".cache/lakomics-native-check/target"
cutoff = time.time() - 7 * 24 * 60 * 60
protected = {".git", "node_modules", "keystores"}

def walk_error(error):
    raise error

def safe_tree(path):
    # Reject redirected ancestors, symlinks and mounted subtrees, even in dry-run.
    if path.resolve() != path.absolute() or path.is_symlink() or path.name in protected:
        return False
    for root, dirs, files in os.walk(path, followlinks=False, onerror=walk_error):
        for name in [*dirs, *files]:
            child = Path(root) / name
            if (child.is_symlink() or os.path.ismount(child) or name in protected
                    or child.suffix.lower() in {".apk", ".aab", ".jks", ".keystore"}):
                return False
    return not os.path.ismount(path)

def old_tree(path):
    return all(Path(root, name).stat().st_mtime <= cutoff
               for root, dirs, files in os.walk(path, onerror=walk_error)
               for name in [".", *dirs, *files])

candidates = [(target / "debug/incremental", False)]
if target.is_dir() and target.resolve() == target.absolute():
    candidates.extend((p, True) for p in sorted(target.iterdir())
                      if p.is_dir() and p.name not in {"debug", "release"})
# Cargo's native-check layout is target/<profile>/incremental (including triples).
if native.is_dir() and native.resolve() == native.absolute():
    for root, dirs, _ in os.walk(native, followlinks=False, onerror=walk_error):
        dirs[:] = [name for name in dirs if name not in protected
                   and not (Path(root) / name).is_symlink()
                   and not os.path.ismount(Path(root) / name)]
        if "incremental" in dirs:
            candidates.append((Path(root) / "incremental", True))
            dirs.remove("incremental")

selected = []
for path, stale_only in candidates:
    if not path.exists():
        continue
    if not safe_tree(path):
        print(f"SKIP unsafe or protected tree: {path}")
        continue
    if stale_only and not old_tree(path):
        print(f"SKIP touched within 7 days: {path}")
        continue
    kib = int(subprocess.check_output(["du", "-sk", "--", str(path)], text=True).split()[0])
    selected.append((path, stale_only, kib))
    print(f"{kib / 1024:.1f} MiB  {path}")

total_kib = sum(kib for _, _, kib in selected)
print(f"{'APPLY' if args.apply else 'DRY RUN'}: {len(selected)} directories, {total_kib / 1024:.1f} MiB")
if args.apply:
    for path, stale_only, _ in selected:
        refuse_active_build()
        if not safe_tree(path) or (stale_only and not old_tree(path)):
            sys.exit(f"Refusing changed candidate: {path}")
        shutil.rmtree(path)
else:
    print("No files deleted. Run with --apply to delete; keep Cargo stopped throughout cleanup.")
PY
