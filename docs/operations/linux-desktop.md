# Linux desktop bring-up

Linux desktop development uses the existing React/Vite + Tauri application:

```sh
cd app
npm ci
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri -- dev
```

Install the Tauri v2 Linux build prerequisites for the distribution (including
GTK 3 and WebKitGTK 4.1 development packages), Rust, and the Node/npm versions
specified by `app/package.json`. The supported scope of this bring-up is modern
Linux desktop, alongside the existing Windows implementation; other targets
remain explicitly blocked.

## Media and packaging

Windows FFmpeg sidecars, DLLs, and their notices live in
`app/src-tauri/tauri.windows.conf.json`. Tauri v2 automatically merges this into
the common configuration on Windows. Linux must not contain placeholder DLLs,
FFmpeg symlinks, or copies of system executables in the bundle.

Linux resolves `ffmpeg` and `ffprobe` through absolute PATH entries and requires
executable files. Ubuntu's system FFmpeg with `libx264`, AAC, and `libwebp` is
suitable. Linux proxies use H.264/yuv420p; Windows retains h264_mf/nv12. Linux
media processes have null stdin, capped captured output, a 30-minute deadline,
and termination/reaping on failure. Missing tools/codecs return media errors.
This does not establish codec playback parity between WebKitGTK and WebView2.

## Filesystem safety

Linux requires `renameat2(RENAME_NOREPLACE)` and `openat2` (Linux 5.6+) plus
`/proc/self/fd`. Unsupported kernels/filesystems fail closed. Device/inode
identity protects ingestion cleanup; managed deletion pins directory descriptors,
rejects symlinks and mount crossings below the library, and claims each target
in a private sibling quarantine before verifying identity and unlinking it.
On failure, restoration never overwrites a replacement. A conflicting restoration
can leave a `.UUID.delete` quarantine for manual recovery; the asset DB record
is retained. Do not delete recovery quarantines indiscriminately.

Library leases use a nonblocking exclusive `flock`, held until close. This is
advisory: other programs do not have to honor it. As with the existing ingestion
model, safety checks are defense in depth, not protection against a hostile
process with the same user's full filesystem privileges. Do not externally edit
managed library files while the application is using them.

## Remaining platform limitations

- Linux native drag-out uses GTK `text/uri-list` with COPY semantics. File preparation runs off the UI thread; GTK starts on the main thread while button 1 remains held. URI encoding supports spaces, Korean names, and reserved characters. Recipients receive independent staging copies, not hard links to originals. Successful staging remains until the library is next opened because file managers may acknowledge the drop before asynchronous copying finishes; cancellation/start failure cleans staging immediately. Native Wayland/X11 file-manager acceptance is still pending.
- Linux credentials use the desktop Secret Service default persistent collection
  (GNOME Keyring on Ubuntu) with an encrypted DH session. The login keyring must
  be unlocked. Missing credentials are reported as unconfigured; a locked keyring
  has a separate actionable error. Missing Secret Service still fails closed.
  There is no plaintext or session-only fallback, and operations have a 10-second
  deadline, including any authorization prompt.
- Credentials from Windows Credential Manager do not travel with the library.
  Enter the Cloud/provider tokens again in Settings on Linux. Existing encrypted
  Notes require the original recovery key, entered in the Notes unlock screen.
  Each OS keeps its own secure credential store; the Notes ciphertext format and
  Windows backend are unchanged.
- Native playback, external application integration, packaging/distribution,
  and Windows regression acceptance need their own device verification.

For isolated manual verification, use an empty test library and separate
`XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_CACHE_HOME` directories. This prevents
loading a previously remembered production library. Never use production data
for bring-up tests. Launch with `npm run tauri -- dev`, not a debug executable.

Focused checks:

```sh
cargo test --manifest-path app/src-tauri/Cargo.toml --lib linux_
cargo test --manifest-path app/src-tauri/Cargo.toml --lib library::ingestion::tests
cargo test --manifest-path app/src-tauri/Cargo.toml --lib library::trash::tests
cargo test --manifest-path app/src-tauri/Cargo.toml --lib linux_system_video_tools -- --ignored
```

## Bring-up verification, 2026-09-08

Base: `b3ab9ba28be4a6c5bcae4c0be3ea6c1a1b008483`, branch `main`.
No commit, staging, push, production-library access, or deployment was performed.

| Check | Result |
| --- | --- |
| `npm ci` (app) | Pass; 165 packages, 0 vulnerabilities |
| `npm run build` (app), final source | Pass; existing dynamic-import/chunk-size warnings |
| `cargo check --manifest-path app/src-tauri/Cargo.toml` | Pass; warnings remain |
| `cargo test --manifest-path app/src-tauri/Cargo.toml --lib linux_` | 6 passed, 1 opt-in media test ignored |
| Rust ingestion / trash / similarity keep-existing focused tests | 32 / 3 / 2 passed |
| Revisit / manga numeric-tie regression checks | 9 / 1 passed |
| `cargo test --manifest-path app/src-tauri/Cargo.toml --lib` | Final: 775 passed, 0 failed, 18 ignored |
| `cargo test --manifest-path app/src-tauri/Cargo.toml --test foundation_flow trash` | 10 passed, including unsafe paths, partial failure/retry and video purge |
| Opt-in `linux_system_video_tools` / `native_similarity_tool_timeout_and_cancellation` | 1 / 1 passed using installed FFmpeg |
| `npm test -- src/assets/mediaUrl.test.ts src/library/LibrarySetup.test.tsx src/settings/SettingsView.test.tsx` (app) | 3 files, 38 tests passed |
| Windows config merge / Linux bundle checks | Windows sidecar/resource entries exactly match baseline; Linux has no binary resource requirements or placeholder symlinks |
| `git diff --check` | Pass |

The first full Rust run had 12 failures: two remaining Windows-only similarity
cleanup gates, nine prematurely dropped temporary-directory fixtures in Revisit,
and one filesystem-dependent manga filename tie. These were corrected and the
full suite rerun successfully.

Native `npm run tauri -- dev` compiled and launched with isolated XDG directories.
The user reported that navigation worked after being asked to select the named
empty test library and check Settings/Notes. A read-only check confirmed zero
assets in that test library. User-driven close was followed by disappearance of
the native process; the same command launched a new native process successfully.
Native window interaction was user-assisted because this session's native UI
control was unavailable. Initial frontend rendering and absence of console errors
were independently checked in a browser; this is not native WebKit evidence.
Native drag-error interaction, secure credentials, Windows execution, installed
Linux bundles, and codec playback parity are not accepted by these checks.
The final native development instance was left running for review.

Second-pass review was performed inline, not by an independent reviewer. It
covered filesystem containment/identity/rollback, Windows cfg branches, credential
failure behavior, platform bundle merging, dummy artifacts, machine-specific paths,
and FFmpeg resolution/encoding. No plaintext credential fallback or production
path was introduced.

Files in this batch:

- `app/package.json`
- `app/src-tauri/Cargo.toml`, `app/src-tauri/Cargo.lock`
- `app/src-tauri/tauri.conf.json`, `app/src-tauri/tauri.windows.conf.json` (new)
- `app/src-tauri/src/lib.rs`, `app/src-tauri/src/commands.rs`
- `app/src-tauri/src/library/linux_fs.rs` (new)
- `app/src-tauri/src/library/credential.rs`, `app/src-tauri/src/library/notes.rs`
- `app/src-tauri/src/library/ingestion.rs`, `app/src-tauri/src/library/lock.rs`
- `app/src-tauri/src/library/mod.rs`, `app/src-tauri/src/library/trash.rs`
- `app/src-tauri/src/library/similarity.rs`, `app/src-tauri/src/library/video_media.rs`
- `app/src-tauri/src/library/manga.rs`, `app/src-tauri/src/library/revisit.rs`
- `app/src/assets/mediaUrl.ts`, `app/src/assets/mediaUrl.test.ts`
- `docs/README.md`, `docs/operations/linux-desktop.md` (new)


## Linux credential follow-up

The original bring-up verification above records the initial unavailable backend.
The subsequent Secret Service integration adds secure read/write/replace/delete
for Notes, Cloud, Kakao, Aladin, IGDB, and TMDB through the existing credential
interface. It uses the maintained `secret-service` Rust client, encrypted DH
sessions, application/target attributes, and the desktop default collection.
Background reads do not unlock collections or create credentials. Test entries
use unique targets and are removed after native verification; real tokens are
never printed or copied into the repository.

References: [Secret Service API](https://specifications.freedesktop.org/secret-service/latest-single/),
[secret-service Rust client](https://docs.rs/secret-service/5.2.0/secret_service/).

Credential follow-up verification: `cargo check` passed; credential unit tests
9 passed, Notes tests 4 passed, and command tests 17 passed. The opt-in native
keyring roundtrip and Notes reopen/wrong-key integration tests both passed using
isolated synthetic secrets. The Windows native backend body was compared with
the preceding commit and is unchanged. Real account tokens and the user's Notes
recovery key were not read, imported, or tested; they must be entered in the app.


## Linux drag-out follow-up, 2026-09-09

The previous unsupported-platform guard now routes Linux to a GTK source adapter.
The Windows OLE implementation is preserved. The adapter serves file URIs until
GTK `drag-end`, rather than disconnecting at `drop-performed` before a recipient
has requested the data. It sends the existing `asset-drag://ended` event so the
frontend can clear native-drag state and suppress accidental re-ingestion.

Verification uses synthetic temporary libraries: URI roundtrips, original-name
preservation/collisions, cancellation cleanup, retained-copy independence, and
cleanup on library reopen. Real drag to a file manager or external editor still
requires user-assisted native acceptance on Wayland/X11; Windows execution is
also unavailable in this Linux session. A successful compilation is not a native
drop acceptance result.

Focused follow-up results: `cargo test --lib drag` passed 6 tests; the frontend
native-drag/invoke selection passed 4 tests (42 unrelated tests skipped). The
Linux dev binary rebuilt and launched through `npm run tauri -- dev`. Changes
were reviewed inline for GTK main-thread use, button numbering, URI escaping,
source-copy independence, drag-end data lifetime, cleanup, and Windows cfg
isolation. Native drop confirmation remains user-assisted and pending.
