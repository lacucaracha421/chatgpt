# Windows desktop development

The main development PC runs Windows 11 since the 2026-10-04 move from Linux. This page records how
work is done there; the application itself is the same React/Vite + Tauri app as on Linux
(`linux-desktop.md`).

## Paths

- Checkout: `V:\chatgpt` on a ReFS Dev Drive (`V:` is a dynamic VHDX remounted at boot). The older
  copy at `C:\laku\chatgpt` is a migration backup; do not work there.
- Active production library: `C:\laku\New_lakomics_assets`. The application resolves the configured
  library at runtime; never hard-code this path.

## Shells and Git

- Use Git Bash for Git, commit messages (heredocs) and POSIX scripts. Global `core.autocrlf=false`,
  `core.eol=lf`, and the repository's `.gitattributes` (`* text=auto eol=lf`, `.bat`/`.cmd` CRLF) keep
  the working tree LF. Tools that write CRLF (some editors, agents) must be normalized before commit.
- PowerShell is for Windows administration. Windows PowerShell 5.1 writes a BOM and mangles
  here-strings passed to native executables; prefer Git Bash for anything that feeds files or
  multi-line text to a program.
- `ssh` to the Cloud API host works from Windows OpenSSH (PowerShell); Git Bash's `ssh` has no known
  host entry for it. Tailscale SSH periodically asks for a browser check, which the user approves in
  their own terminal.

## Desktop app

- Dev run: `npm run tauri -- dev` from `_tools/app/`. Never launch `target\debug\lakomics.exe`
  directly.
- Release build: the user builds pushed `main` with the desktop shortcut "라쿠믹스 릴리즈 빌드"; the
  running release (`target\release\lakomics.exe`) does not pick up source changes. Rebuild only when
  asked.
- Rust formatting rules from `AGENTS.md` apply unchanged (`rustfmt` per changed file, never write-mode
  `cargo fmt`).

## Server tests (WSL)

The Cloud API suite runs in WSL (`Ubuntu-26.04`) with a dedicated virtual environment:

```sh
wsl -d Ubuntu-26.04 -- bash -lc 'cd /mnt/v/chatgpt/server/lakomics-api && ~/venvs/lakomics-api/bin/python -m unittest discover -s tests'
```

Known Windows-only failure: `test_media_thumbnail_encode … test_no_kind_leaves_a_partial_file_behind_on_an_unsupported_source`
(Pillow/codec environment; exit 7 instead of 4). The Windows Python has no server packages by design.
Codex workers cannot start WSL or Vitest's worker processes inside their sandbox (`spawn EPERM`); the
controller runs those suites.

## Android builds

`ANDROID_SDK_ROOT`/`JAVA_HOME` are not set globally and `adb` is not on PATH; pass paths explicitly.
Always rebuild the bundled frontend first — `android/build.py` packs whatever is in `android/assets`,
and a stale bundle once shipped an APK with the previous version's screens:

```sh
cd _tools/app && npm run mobile:build && cd ../..
PYTHON="$(cygpath -w "$(which python)")" python android/build.py \
  --sdk-root C:/Users/laku/AppData/Local/Android/Sdk \
  --java-home "C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot"
```

`PYTHON` must point at the real interpreter because host tests call `python3`, which is only a Store
stub on Windows. The signing keystore is the ignored `android/build/debug.keystore`. Install over
Tailscale with `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe` (`adb connect <tablet>:<port>`; the
wireless-debugging port changes, ask the user). In Git Bash, prefix adb calls that take device paths
with `MSYS_NO_PATHCONV=1`.
