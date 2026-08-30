from pathlib import Path

root = Path(r"C:\chatgpt\extension\src")
source = (root / "background.js").read_text(encoding="utf-8").replace("\r\n", "\n")
layout = (root / "layout.js").read_text(encoding="utf-8").replace("\r\n", "\n").rstrip()
defaults = (root / "defaults.js").read_text(encoding="utf-8").replace("\r\n", "\n").rstrip()
import_block = '''  if (typeof importScripts === "function") {
    if (!globalThis.LakomicsRadial) importScripts("layout.js");
    if (!globalThis.LakomicsDefaults) importScripts("defaults.js");
  }

'''
header = '''// Generated classic MV3 service worker bundle for Android Chromium/Quetta.
// Keep in sync with layout.js + defaults.js + background.js; tests verify this exactly.

'''
assert import_block in source
worker = header + layout + "\n\n" + defaults + "\n\n" + source.replace(import_block, "", 1)
(root / "background-worker.js").write_text(worker, encoding="utf-8")
print("background-worker rebuilt")