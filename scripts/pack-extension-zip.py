from pathlib import Path
import sys
import zipfile

stage = Path(sys.argv[1])
out = Path(sys.argv[2])

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for path in sorted(stage.rglob("*")):
        if path.is_file():
            arcname = path.relative_to(stage).as_posix()
            zf.write(path, arcname)
