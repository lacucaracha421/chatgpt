# Native check

Opens the real Lakomics window (WebKitGTK and the Rust core, not the browser preview) on a **test library** and drives it over WebDriver, so UI changes can be checked and captured without the user at the PC. Linux only.

## Run

```sh
# 1. Test library: a read-only copy of a real library, server settings removed, dev marker added.
python3 _tools/app/scripts/native-check/make_test_library.py "<real library root>"   # → ~/.cache/lakomics-native-check/library

# 2. The app with the frontend embedded, built into its own target folder (never src-tauri/target/debug).
cd _tools/app && CARGO_TARGET_DIR=$HOME/.cache/lakomics-native-check/target npx tauri build --debug --no-bundle

# 3. Steps → screenshots.
node _tools/app/scripts/native-check/run.mjs steps.json out/
```

Steps are a JSON list: `{"waitFor": css}`, `{"eval": "js returning a value"}`, `{"click": css}`, `{"dblclick": css}`, `{"key": "ArrowRight"}`, `{"resize": [w, h]}`, `{"wait": ms}`, `{"shot": "name"}`. Example: open 컬렉션 → 게임, wait for `.collection-light-case`, double-click it, shoot.

Needs `~/.cargo/bin/tauri-driver` and `~/.cargo/bin/WebKitWebDriver`, `dbus-daemon`, `sqlite3`, Node ≥ 24.

## What keeps it away from real data and the server

- **Test library only.** `make_test_library.py` reads the real `library.sqlite` through SQLite's online backup from a read-only connection and copies artwork/thumbnail folders (not `assets/` originals or videos). It checks the real database's size and mtime are unchanged afterwards. `run.mjs` refuses to start unless the test library has the dev marker and no server settings.
- **No server settings.** In the copy, `cloud_sync_enabled = 0`, `cloud_capture_enabled = 0`, `cloud_api_base_url = NULL`.
- **No credentials.** The app gets a private D-Bus session with no service directories, so the Secret Service (where the cloud tokens live) cannot be reached or started.
- **Own config.** `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` point under `~/.cache/lakomics-native-check/home/`, so the app's remembered library path and machine settings are not the user's; `run.mjs` sets the test library path itself.
- **Proxies to a closed port** for any HTTP the app might still try.
- **Evidence per run:** `out/connections.txt` lists every TCP connection of the app's process at the end (only `127.0.0.1` is expected).

Verified 2026-10-01: two runs; the real `library.sqlite` and `-wal` size/mtime unchanged; `~/.config/com.lakomics.desktop/` untouched; connections local only (the WebDriver link).

## Limits

The OS cannot enforce the isolation here (unprivileged namespaces are not allowed), so the guarantees are the layers above, not a sandbox. Screenshots cover the app's web content only (no OS dialogs, tray, drag between apps). Motion and feel still need a person. The window appears on the desktop while a run is active. The test library is a snapshot; rebuild it to pick up newer data.
