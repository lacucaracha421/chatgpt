# Lakomics

Lakomics is a personal media library for collecting, classifying, rediscovering,
and viewing images, videos, and Works such as games, manga, and movies.
The desktop library owns managed media and metadata. Optional cloud replication
makes published content available to the independent Android client while the PC
is offline.

## Applications

| Component | Role | Start here |
| --- | --- | --- |
| Desktop | React/TypeScript + Vite UI and Tauri/Rust library management on Windows and Linux | [Desktop setup and behavior](app/README.md) |
| Android | Independent Java/WebView client with Home, Library, Collections, Manga Catalog and reader, media cache, and Android picker integration | [Android setup and current scope](android/README.md) |
| Browser collector | Chromium extension for media collection and X translation; direct PC and optional Cloud Capture routes | [Collector README](extension/README.md) and [operation guide](docs/edge-extension.md) |
| Cloud API | Optional capture transport, library/Collection replicas, and shared catalog reads | [Cloud architecture](docs/agents/cloud-capture.md) |

Works are modeled as typed Collections. Online Catalog is a separate browsing
area. [Product vocabulary](CONTEXT.md) defines these boundaries.

## Development

Desktop prerequisites are pinned by [.node-version](.node-version),
[app/package.json](app/package.json), and
[app/rust-toolchain.toml](app/rust-toolchain.toml). Follow the
[desktop README](app/README.md) for Windows setup or the
[Linux guide](docs/operations/linux-desktop.md) for GTK/WebKitGTK, media tools,
filesystem requirements, and remaining platform limitations.

After platform setup, run from `app/` on either Windows or Linux:

```sh
npm ci
npm run tauri -- dev
```

Use a disposable library for development verification. Read [AGENTS.md](AGENTS.md)
for repository workflow and production-library boundaries. Android uses its own
[build and connection procedure](android/README.md#build).

## Implementation and acceptance

Documentation reconciled on 2026-09-09 against source commit `0c61206`.
This is a source/documentation checkpoint, not a new deployment or device test.

- Windows and Linux desktop implementations exist; Linux packaging, codec parity,
  native external drag acceptance, and Windows regression evidence have separate
  verification limits documented in the Linux guide.
- Android source declares version 0.4.3 (14), including the single-page manga reader,
  pinch zoom, and video autoplay/loop defaults. The recorded 0.4.3 install and native
  reader acceptance remain pending; source version does not identify the installed APK.
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
