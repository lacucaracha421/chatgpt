r"""Build the slim runtime package of the Lakomics Companion extension.

Copies only what the browser loads (manifest, src, options page, icons and the
fonts the options CSS really uses) from extension-list/ into an unpacked folder
and a zip. Tests, docs, changelog and unused fonts stay out, which keeps the
reload on a tablet short.

    python scripts/build-extension-slim.py [--out DIR] [--no-zip]

DIR defaults to %LOCALAPPDATA%\Lakomics\ExtensionDev (or ~/.cache/lakomics-extension).
It receives unpacked/ (load this folder) and latest.zip, plus version.txt.
"""
import argparse
import json
import os
import re
import shutil
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SOURCE = REPO / "extension-list"
SKIP_SUFFIXES = {".md"}


def default_out() -> Path:
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "Lakomics" / "ExtensionDev"
    return Path.home() / ".cache" / "lakomics-extension"


def used_fonts() -> set[str]:
    """Font files referenced by the options CSS/HTML (url(...) targets)."""
    used: set[str] = set()
    for page in list((SOURCE / "options").glob("*.css")) + list((SOURCE / "options").glob("*.html")):
        for ref in re.findall(r"url\(\s*[\"']?([^\"')]+)", page.read_text(encoding="utf-8")):
            if "fonts/" in ref:
                used.add(ref.split("fonts/")[-1].split("?")[0])
    return used


def keep(path: Path, fonts: set[str]) -> bool:
    rel = path.relative_to(SOURCE).as_posix()
    if path.suffix in SKIP_SUFFIXES:
        return False
    if rel.startswith("options/fonts/"):
        name = path.name
        if name in fonts:
            return True
        # A licence file travels with the font family it covers, and only then.
        family = re.split(r"[-_]?(?:LICENSE|OFL)", path.stem, maxsplit=1)[0]
        return ("LICENSE" in name or "OFL" in name) and any(f.startswith(family) for f in fonts)
    return True


def collect() -> list[Path]:
    fonts = used_fonts()
    files = [SOURCE / "manifest.json", SOURCE / "THIRD_PARTY_NOTICES.txt"]
    for folder in ("src", "options", "icons"):
        files += [p for p in sorted((SOURCE / folder).rglob("*")) if p.is_file()]
    return [p for p in files if p.is_file() and keep(p, fonts)]


def manifest_references(manifest: dict) -> set[str]:
    refs = {manifest.get("background", {}).get("service_worker"), manifest.get("options_page")}
    refs |= set(manifest.get("icons", {}).values())
    refs |= set(manifest.get("action", {}).get("default_icon", {}).values())
    for script in manifest.get("content_scripts", []):
        refs |= set(script.get("js", [])) | set(script.get("css", []))
    for group in manifest.get("web_accessible_resources", []):
        refs |= set(group.get("resources", []))
    return {r for r in refs if r}


def html_references() -> set[str]:
    """Local script/link paths referenced by packaged HTML pages."""
    refs: set[str] = set()
    for folder in ("options", "src"):
        for page in (SOURCE / folder).rglob("*.html"):
            text = page.read_text(encoding="utf-8")
            for match in re.findall(r"""(?:src|href)\s*=\s*["']([^"']+)["']""", text):
                if match.startswith(("http://", "https://", "data:", "#", "mailto:")):
                    continue
                resolved = (page.parent / match.split("?")[0].split("#")[0]).resolve()
                try:
                    refs.add(resolved.relative_to(SOURCE).as_posix())
                except ValueError:
                    pass
    return refs


def bundle_background(sw_rel: str) -> tuple[str, set[str]]:
    """Inline top-level importScripts(...) into the service worker for faster cold starts."""
    sw_path = SOURCE / sw_rel
    sw_dir = sw_path.parent
    text = sw_path.read_text(encoding="utf-8")
    inlined: set[str] = set()

    def replace_import(match: re.Match[str]) -> str:
        parts: list[str] = []
        for rel in re.findall(r"""["']([^"']+)["']""", match.group(1)):
            target = (sw_dir / rel).resolve()
            rel_posix = target.relative_to(SOURCE).as_posix()
            inlined.add(rel_posix)
            content = target.read_text(encoding="utf-8").rstrip()
            parts.append(f"/* --- {rel_posix} --- */\n{content}\n;")
        return "\n".join(parts)

    bundled = re.sub(r"""^[ \t]*importScripts\(([^)]+)\);\s*$""", replace_import, text, flags=re.MULTILINE)
    return bundled, inlined


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=default_out())
    parser.add_argument("--no-zip", action="store_true")
    args = parser.parse_args()

    files = collect()
    manifest = json.loads((SOURCE / "manifest.json").read_text(encoding="utf-8"))
    sw_rel = manifest.get("background", {}).get("service_worker")
    bundled_sw: str | None = None
    inlined_sw: set[str] = set()
    if sw_rel:
        bundled_sw, inlined_sw = bundle_background(sw_rel)

    keep_refs = manifest_references(manifest) | html_references()
    omitted = inlined_sw - keep_refs
    files = [p for p in files if p.relative_to(SOURCE).as_posix() not in omitted]

    present = {p.relative_to(SOURCE).as_posix() for p in files}
    missing = sorted(manifest_references(manifest) - present)
    if missing:
        print("Manifest references files missing from the package:", *missing, sep="\n  ", file=sys.stderr)
        return 1

    stage = args.out / "unpacked"
    if stage.exists():
        shutil.rmtree(stage)
    for path in files:
        rel_posix = path.relative_to(SOURCE).as_posix()
        target = stage / path.relative_to(SOURCE)
        target.parent.mkdir(parents=True, exist_ok=True)
        if bundled_sw is not None and rel_posix == sw_rel:
            target.write_text(bundled_sw, encoding="utf-8")
        else:
            shutil.copy2(path, target)
    (args.out / "version.txt").write_text(manifest["version"] + "\n", encoding="utf-8")

    staged_files = [stage / p.relative_to(SOURCE) for p in files]
    total = sum(p.stat().st_size for p in staged_files)
    print(f"Slim package {manifest['version']}: {len(files)} files (inlined {len(inlined_sw)} worker scripts, omitted {len(omitted)}), {total / 1_048_576:.2f} MiB -> {stage}")
    if not args.no_zip:
        archive = args.out / "latest.zip"
        archive.unlink(missing_ok=True)
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            for path in files:
                rel_posix = path.relative_to(SOURCE).as_posix()
                zf.write(stage / path.relative_to(SOURCE), rel_posix)
        print(f"Zip: {archive} ({archive.stat().st_size / 1_048_576:.2f} MiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
