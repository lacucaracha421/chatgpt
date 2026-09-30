#!/usr/bin/env python3
"""Turn a mockup under docs/prototypes/ into one self-contained page.

The mockups link the app's real stylesheets (tokens.css, controls.css) by relative path so they
never drift from the app. A page published for review cannot load those files, so this script
inlines every linked stylesheet, its @imports and the font files it references.

    python3 docs/prototypes/inline-mockup.py <mockup>/index.html <out.html> [--fragment]

--fragment drops the <html>/<head>/<body> wrapper (for hosts that add their own).
"""
import base64
import mimetypes
import re
import sys
from pathlib import Path


def css_text(path: Path) -> str:
    text = path.read_text(encoding="utf-8")

    def embed(match: re.Match) -> str:
        target = (path.parent / match.group(1)).resolve()
        kind = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        return f'url("data:{kind};base64,{base64.b64encode(target.read_bytes()).decode()}")'

    text = re.sub(r'@import\s+"([^"]+)";', lambda m: css_text((path.parent / m.group(1)).resolve()), text)
    # One file listed twice with different format() hints would be embedded twice.
    text = re.sub(r'(url\("([^"]+)"\) format\("[^"]+"\)),\s*url\("\2"\) format\("[^"]+"\)', r"\1", text)
    return re.sub(r'url\("(\.{1,2}/[^"]+)"\)', embed, text)


def main() -> None:
    source, output = Path(sys.argv[1]).resolve(), Path(sys.argv[2])
    html = source.read_text(encoding="utf-8")
    html = re.sub(
        r'<link rel="stylesheet" href="([^"]+)">',
        # Remote stylesheets (web fonts) stay as links; only local files are inlined.
        lambda m: m.group(0) if m.group(1).startswith(("http://", "https://")) else f"<style>\n{css_text((source.parent / m.group(1)).resolve())}\n</style>",
        html,
    )
    if "--fragment" in sys.argv:
        head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
        body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
        head = re.sub(r"<meta[^>]*>\s*", "", head)
        html = head.strip() + "\n" + body.strip() + "\n"
    output.write_text(html, encoding="utf-8")


if __name__ == "__main__":
    main()
