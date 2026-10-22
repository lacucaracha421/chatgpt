# Private Vault (`비밀`) Design

## Purpose

Add a portable external media vault to Lakomics that can point at an already-unlocked encrypted filesystem such as a VeraCrypt or Cryptomator volume.

Lakomics does not unlock encrypted containers, store encryption passwords, or depend on a specific encryption provider. It only works with the readable filesystem that another tool exposes.

The product-facing name is `비밀`. It appears only while a registered vault is currently available.

## Scope

The first version is desktop-only and supports one registered vault in the UI, while using a stable `vault_id` internally so the model can later support more than one vault.

Supported first-version behavior:
- register a mounted vault root from Settings > Data
- recognize the vault by stable identity instead of mount path
- scan image and supported video files recursively without copying originals
- browse media in a dedicated `비밀` view
- open images and play videos with existing Lakomics viewer/player behavior
- keep derivatives and portable index data inside the vault
- exclude vault media from normal cloud sync and normal viewing-history persistence
- handle disconnect/reconnect without modifying user media

Android access is future work. The desktop design must avoid assumptions that permanently bind a vault to one absolute path.
## On-disk Vault Layout

A registered vault root contains user media plus Lakomics-owned metadata:

```text
<Vault Root>/
├── .lakomics/
│   ├── vault.json
│   ├── index.sqlite
│   ├── thumbnails/
│   └── media/
├── Telegram/
├── Videos/
├── Images/
└── any other user folders
```

`.lakomics/` is excluded from media scanning. User folders and filenames remain untouched.

`vault.json` contains only provider-independent identity/version metadata, for example:

```json
{
  "version": 1,
  "vaultId": "<uuid>"
}
```

The main Lakomics library stores the registered `vault_id` and the last known root as reconnect hints. The vault asset catalog itself lives in `.lakomics/index.sqlite` so metadata travels with the portable volume.
## Registration and Discovery

Registration reuses the existing Tauri directory picker from Settings > Data.

On first registration Lakomics validates that the selected root is a directory, creates `.lakomics/`, writes `vault.json`, initializes `index.sqlite`, and remembers the stable `vault_id` plus the current root.

On startup and when the app regains focus, Lakomics checks vault availability:
1. verify the last-known root and matching `vault_id`
2. if missing, search appropriate mounted-volume roots for the same `vault_id`
3. update the last-known path when the same vault is found elsewhere
4. expose `비밀` only while a matching vault is readable

The discovery logic must be platform-aware for Windows and Linux. It must not invoke VeraCrypt, inspect `Private.hc`, or store an encryption password.

If the vault disappears while `비밀` is open, Lakomics returns to the normal asset-library view, removes the `비밀` navigation item, and shows a brief non-blocking disconnect message.

## Vault Index

`index.sqlite` stores lightweight browse/playback metadata rather than normal Lakomics `assets` rows. A vault asset has a stable UUID, relative path, media kind, original name, byte size, modified time, dimensions, optional video metadata, and derivative paths.

Identity inside the vault is `vault_id + relative_path`; absolute mount paths are runtime state only.

The first version does not implement classifications, albums, collections, favorites, trash, similarity review, character analysis, or normal ingestion semantics for vault assets.
## Scanning and Derivatives

A full scan runs when the vault is first registered. Reconnects and manual refreshes run an incremental recursive scan.

Unchanged files are recognized using relative path, file size, and modified time. The first version does not hash every media file during routine scans.

The scanner supports the image formats already handled by Lakomics and initially limits video indexing to the formats already accepted by the normal desktop ingest path: MP4, WebM, and MOV.

Image thumbnails are generated into `.lakomics/thumbnails/` using existing thumbnail-generation behavior where practical.

Video probing reuses Lakomics FFprobe logic. Video derivatives live under `.lakomics/media/<asset-id>/`:
- `poster.webp`
- `scrub/`
- `playback.mp4` only when a compatibility proxy is required

Directly playable video uses the original vault file. Compatibility proxies remain inside the vault.

Missing user files are removed from the vault index during a successful scan, with stale generated derivatives cleaned up. Lakomics never moves or deletes user media from the vault in this version.

## Media Serving and UI Reuse

Vault media reuses the existing ID-resolved local media routes. When `/asset/<asset-id>`, `/thumbnail/<asset-id>`, or `/playback/<asset-id>` does not resolve to a normal library asset, Lakomics may resolve the UUID against the currently available registered vault. This keeps `AssetGallery`, `AssetViewer`, and `VideoPlayer` unchanged while still keeping vault rows outside the main `assets` table.

Vault fallback resolution validates the registered vault identity, resolves only IDs present in `.lakomics/index.sqlite`, rejects unsafe relative paths, and reuses the existing external-root canonical containment boundary before opening bytes.

Playback continues to use bounded HTTP range responses for video. The first desktop UI does not expose vault scrub-frame seeking; it passes a zero scrub-frame count even though portable derivatives may contain generated scrub frames for future reuse.

The `비밀` screen follows the current asset browsing language: date-grouped masonry, image/video filtering, existing viewer interactions, and manual refresh. It is a dedicated view rather than a normal Asset Library query.

The main workspace rail shows `비밀` directly below `메모`, only while the registered vault is available.

## Privacy and Sync Boundaries

Vault rows never enter the main `assets` table in the first version. This keeps them outside normal ingestion side effects such as cloud replication, character automation, similarity review, trash, and backfill.

The `비밀` browser does not call `record_asset_opened` or `record_assets_exposed`, so vault viewing does not feed normal Lakomics revisit/history data. Playback progress is not persisted for vault video.

This is ordinary application-level privacy. The feature does not attempt secure deletion, anti-forensics, memory-only playback, swap control, or operating-system trace suppression.

## Settings and Removal

Settings > Data contains a small `비밀 보관함` control with registration/reconnect and unregister actions.

Unregistering only removes Lakomics' remembered registration. It does not delete `.lakomics/`, the vault index, generated derivatives, or user media from the external volume.
## Error and Recovery Behavior

A single unreadable/corrupt media file is isolated so the rest of the vault remains browsable.

If `.lakomics/index.sqlite` cannot be opened, Lakomics offers to rebuild the generated index and derivatives from the user media. Rebuild must not alter originals.

If the vault is mounted read-only, existing indexed media can still be viewed when possible. Operations that require writing index or derivative state report a focused error instead of failing the whole view.

All media resolution must reject traversal and symlink/path escapes outside the currently verified vault root.

## Provider Independence and Future Android Work

The core vault model is a readable storage root plus stable `vault_id`. VeraCrypt is only the current way the user exposes that root.

Moving the vault contents, including `.lakomics/`, into a Cryptomator vault should preserve the same identity and portable metadata once the new decrypted root is registered or discovered.

A future Android implementation may expose the same logical vault through SAF/document-provider URIs. Desktop code should keep path resolution behind a small vault-storage boundary so the product model and UI do not depend on desktop absolute paths.

## Verification Focus

Tests should cover registration identity, path portability, recursive/incremental scanning, disconnect/reconnect, safe path containment, media range playback, history exclusion, and cloud-sync isolation.

Native verification should exercise a temporary mounted-style directory on Linux and retain Windows-compatible path behavior in unit tests. The active user library and current VeraCrypt media must not be modified for automated tests.
