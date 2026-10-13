# Lakomics

Lakomics is a personal media library for collecting, classifying, rediscovering,
and viewing images, videos, and Works such as games, manga, and movies.
The desktop library owns managed media and metadata. Optional cloud replication
makes published content available to the independent Android client while the PC
is offline.

## Applications

| Component | Role | Start here |
| --- | --- | --- |
| Desktop | React/TypeScript + Vite UI and Tauri/Rust library management on Windows (main PC since 2026-10-04) and Linux | [Desktop setup and behavior](_tools/app/README.md) |
| Android | Independent Java/WebView client with Home, Library, Collections, Manga Catalog/reader, character 확인 list, media cache and Android picker integration | [Android setup and current scope](android/README.md) |
| Browser collector | Lakomics Companion (Chromium MV3): collection to PC/cloud; X/page/image-text/right-click translation; YouTube Korean subtitles with optional [local PC Kotoba ASR](_tools/asr/README.md); Arca Live post-editor picker (desktop Chromium and tablet Helium) | [Collector README](extension-list/README.md) |
| Cloud API | Capture transport, library/Collection replicas and shared catalog reads; server-owned calendar/wishlist, Kakao/MangaDex binds and picker relay | [Cloud architecture](docs/agents/cloud-capture.md) |

Works are modeled as typed Collections. Online Catalog is a separate browsing
area. [Product vocabulary](CONTEXT.md) defines these boundaries.

## Development

Desktop prerequisites are pinned by [.node-version](.node-version),
[_tools/app/package.json](_tools/app/package.json), and
[_tools/app/rust-toolchain.toml](_tools/app/rust-toolchain.toml). Follow the
[desktop README](_tools/app/README.md), [Windows guide](docs/operations/windows-desktop.md)
and [Linux guide](docs/operations/linux-desktop.md) for platform setup and limitations.

After platform setup, run from `_tools/app/` on either Windows or Linux:

```sh
npm ci
npm run tauri -- dev
```

The current desktop package and shared mobile frontend are under `_tools/app/`.
From the repository root, use `bash scripts/check-project.sh` for the full check
and `bash scripts/cargo-test.sh -- <filter>` for targeted Rust tests; on Windows,
`pwsh -NoProfile -File scripts/cargo-test.ps1 -- <filter>` is the sandbox alternative.

Use a disposable library for development verification. Read [AGENTS.md](AGENTS.md)
for repository workflow and production-library boundaries. Android uses its own
[build and connection procedure](android/README.md#build).

## Implementation and acceptance

Documentation reconciled on 2026-10-13 against `main` at `6c524cc3`.
This is a source/documentation checkpoint, not a new deployment or device test.

- Windows and Linux desktop implementations exist; Linux packaging, codec parity,
  native external drag acceptance, and Windows regression evidence have separate
  verification limits documented in the Linux guide.
- Android source is 0.9.89 (`android/AndroidManifest.xml`); Lakomics Companion source
  is 3.5.40 (`extension-list/manifest.json`). These do not identify installed clients.
  The Arca picker on tablet runs in the Helium extension, separate from the Android app.
- Initial full-library backfill is recorded complete. Repeating it is a separately
  authorized recovery operation.
- The [living backlog](docs/roadmap/lakomics-backlog.md) owns remaining work and
  acceptance gates. Dated test and deployment notes establish only their recorded scope.

## Documentation

- [Document map](docs/README.md)
- [Product definitions](CONTEXT.md) and [design rules](DESIGN.md)
- [Architecture decisions and their current status](docs/adr/README.md)
- [Implementation and review guidelines](docs/agents/implementation.md)
- [Backup and PC migration](docs/operations/pc-migration.md)
- [Windows desktop operations](docs/operations/windows-desktop.md)
- [Completed and historical work](docs/roadmap/lakomics-completed.md)
