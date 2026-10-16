"""One pause switch shared by the desktop, tablet and standalone NL jobs."""
import json
from pathlib import Path


def enabled():
    return json.loads(Path(__file__).with_name('enabled.json').read_text(encoding='utf-8')) is True


def exit_if_paused():
    if not enabled():
        print('Natural-language search is paused; no analysis started.')
        raise SystemExit(0)
