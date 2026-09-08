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

- Native drag-out returns `unsupported_platform` on Linux.
- Secure credential operations return `CredentialStoreUnavailable`; no plaintext
  fallback is provided. Notes unlock and credential-backed providers/cloud
  operations are unavailable until a secure Linux credential backend is added.
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
