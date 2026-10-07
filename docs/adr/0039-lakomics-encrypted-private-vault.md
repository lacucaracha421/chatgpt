# Lakomics encrypts the Private Vault itself

Status: Accepted; amended 2026-09-24 (Android access via OTG, see the amendment at the end)

Supersedes: the "Lakomics does not encrypt or unlock containers" rule of `docs/superpowers/specs/2026-09-13-private-vault-design.md` (LONG-003). The rest of that spec (desktop-only, never in the main library, cloud or Android) still applies unless changed below.

2026-09-24 user decision: stop using VeraCrypt for the Private Vault USB and let Lakomics encrypt the vault contents itself. Threat model: **someone who plugs the USB into another computer must not be able to see its contents.** The user's own PC is trusted.

## Threat model

Protects: file contents, thumbnails, file names, folder structure, titles and every other vault metadata on a lost or borrowed USB.

Does not protect: the existence of a Lakomics vault, its approximate total size and object count, the size of each encrypted object (close to the original file size) and file timestamps, malware or memory inspection on an unlocked trusted PC, OS-level traces outside Lakomics' control, or deniability.

## Format

- A vault is a folder (normally the root of an exFAT USB) containing `.lakomics-vault/`:
  - `vault.json` (plaintext): format version, vault UUID, KDF parameters and salt, and the master key wrapped twice — once by the password-derived key and once by the recovery key. Nothing else.
  - `index.bin`: the encrypted vault index (items, original names, relative paths, titles, thumbnail references, content hashes, trash state). Written atomically (temporary file, flush, rename); before each save the current `index.bin` is copied (itself atomically) to `index.prev.bin`, and unlock falls back to `index.prev.bin` when `index.bin` does not decrypt.
  - `objects/<random id>`: one encrypted object per original file, thumbnail, poster or custom thumbnail. Object ids are random and reveal nothing.
- Keys:
  - A random 256-bit master key encrypts everything. Changing the password rewraps only the master key.
  - Password key: PBKDF2-HMAC-SHA256 through the existing `ring` dependency, at least 600,000 iterations, 128-bit random salt. (Argon2id would be stronger against GPU guessing but needs a new dependency; it can replace PBKDF2 later through the format version.)
  - Recovery key: 256-bit random, shown once as 64 hex characters at creation, with an explicit "I stored it" confirmation, like ADR-0035 notes.
- Encryption: AES-256-GCM (as ADR-0035). Objects are split into 64 KiB chunks, each sealed with a nonce derived from a per-object random prefix and the chunk counter, and AAD binding vault UUID, object id, chunk index and a final-chunk flag. This allows seeking inside videos and detects reordering or truncation.

## Unlock and lock

- When a vault USB appears, the 비밀 view asks for the password or recovery key.
- "Remember on this PC" is on by default: the master key is stored in the OS credential store (Windows Credential Manager, Linux Secret Service) keyed by the vault UUID, like ADR-0035. On that PC the vault then opens without a prompt. Another PC asks for the password.
- The unlocked master key lives only in process memory (zeroized on lock). Locking happens on USB removal, app exit and a manual 잠그기 action.

## Behaviour

- Decryption happens in memory and is served only through the app media protocol with `Cache-Control: no-store` for every vault response (images, thumbnails, video ranges). No plaintext temporary files are written to the PC or the USB.
- Files are managed only inside Lakomics: add files/folders from the PC (encrypted on write), export back to a chosen PC folder, and delete to a vault trash that the user empties explicitly (ADR-0011 spirit).
- Vault trash (2026-09-24): trashing sets `trashed_at`; trashed items leave the gallery and its counts and appear only in the 휴지통 view, where they can be restored. Nothing is purged automatically. 영구 삭제 (selected trashed items) and 휴지통 비우기 save the index without the items first, then delete only the objects no remaining item references (objects can be shared, e.g. a sidecar image kept as a video thumbnail). Permanent deletion is refused while an import runs. A session opened from `index.prev.bin` is read-only as a whole: import, trash, restore, title changes and permanent deletion are all refused, because saving the older index would make it current and a later unlock would treat the newer generation's objects as orphans. Trashed items do not count as already present when the same file is added again.
- Export writes decrypted originals under their original file names (`_2`, `_3`… on collision) into a PC folder chosen by the user, streaming through a hidden temporary file in that folder; any folder inside the vault root is refused. Add files (individual files, not only folders) uses the import pipeline with each file keyed by its file name. Import and export each run as an app-level job with progress.
- Import from a plaintext folder keeps the existing vault's titles and custom thumbnails when that folder contains the old `.lakomics/index.sqlite`. Plaintext is never written to the USB during migration: the user copies the VeraCrypt contents to the trusted PC, formats the USB, then imports.
- Video plays in the in-app player through ranged decryption. External mpv playback is not carried over unless it can stream without plaintext files.
- The old plaintext vault format is supported only as an import source.
- A crash during import or deletion may leave orphan objects; they are removed after the next successful unlock by comparing `objects/` with the index. Objects and temporary files modified in the last 10 minutes are kept (they may belong to an import still running in another app runtime), and a session opened from `index.prev.bin` deletes nothing.
- Every write first re-checks the vault UUID in `vault.json`, so a USB swapped under an unlocked session is locked, never written. A resumed import skips a file only when an item with the same relative path, size and SHA-256 content hash is already in the vault.

## Boundaries

Vault data still never enters the main library database or the cloud. Android is excluded except through the 2026-09-24 amendment below (direct USB-C OTG access on the tablet). The main library keeps only the vault UUID and last root path. Native Windows/Linux credential storage, real USB removal and large-video playback are native acceptance items; fixture tests do not prove them.

## Amendment (2026-09-24): Android access via OTG

User decision (2026-09-24), following the accepted design in [`docs/research/mobile-private-vault-design-20260924.md`](../research/mobile-private-vault-design-20260924.md) (option A): the Android tablet may open the vault USB directly over USB-C OTG and decrypt on the tablet. The encrypted cloud copy (option B) is not adopted, and streaming through the PC (option C) stays rejected. Every PC rule above is unchanged.

### Scope

- Android tablet only, reading the vault USB through the Storage Access Framework (the user picks the USB root once; the tree permission is persisted).
- First slice A1 is **read-only**: unlock with password or recovery key, list, view images and thumbnails, play videos with seeking, lock. The tablet writes nothing to the USB, not even orphan cleanup.
- Writes (add, trash) are allowed only in a later slice A3, using a SAF write protocol (temporary document, rotate `index.prev.bin`, then rename) with the vault UUID re-checked in `vault.json` before every write, matching the PC write rules.

### Still forbidden on Android

- No cloud copy of the vault, its objects, its index or any key wrap.
- No decrypted data at rest on the tablet: no plaintext temporary files, and the decrypted index lives only in memory.
- The unlocked master key stays in native (Java) memory, is zeroed on lock, and is never passed to JavaScript.
- Vault thumbnails and originals never go through the normal media cache or transfer paths (ThumbnailCache, MediaTransfer), the DocumentsProvider, share, the clipboard or temporary activities. Vault media is served only through a dedicated WebView route with `Cache-Control: no-store` and `nosniff`, with Range/206 support.

### Unlock and remember

- The tablet asks for the password or recovery key.
- "Remember on this tablet" is **off by default**. When enabled, the master key is wrapped with a per-vault AndroidKeyStore key and stored only in that wrapped form, bound to the vault UUID. Optional biometric (fingerprint) unlock may gate the remembered key.
- No automatic unlock until the vault USB is present again.

### Auto-lock

The vault locks, clearing the key and the vault UI, when:

- the app has been in the background for 1 minute;
- the screen turns off;
- the OTG USB is detached;
- a USB read or write fails with an I/O error;
- the user chooses 잠그기.

### Screens

Vault screens set `FLAG_SECURE` (no screenshots or recents preview); on API 33+ recents screenshots are also disabled.

### Format compatibility

- Android follows the same format rules as the PC, with no Android-specific variant: header limits, AAD strings, HKDF info, nonce and AAD layout, final-chunk flag, length derivation, last-chunk authentication, recovery-key parsing, strict object ids, rejection of unknown index versions and tolerance of unknown JSON fields.
- A golden fixture vault produced by the PC implementation is opened by both the PC and Android tests; any format change must keep both passing.
- Real OTG/SAF random access, exFAT, unlock time, video seeking, unplug-to-lock, `FLAG_SECURE` and Keystore behaviour after reboot are device acceptance items; JVM and fixture tests do not prove them.

## Amendment (2026-10-07): User folders

The PC vault view gets user folders, managed like Assets folders (ADR-0013/0030), in its previously empty index column.

### Model

- Folders exist only inside the encrypted index: `VaultIndex.folders` holds `{ id, name, parentId, createdAt }` and an item names at most one folder with `folderId`. Folder names are vault metadata like titles; they never reach `vault.json`, the main library database or the cloud.
- Folders nest through `parentId`. Sibling names are unique ignoring case; names are 1–100 characters without control characters. A folder lists its own items and those of its descendants. Moving a folder into itself or a descendant is refused.
- Deleting a folder is refused while it has child folders; its items move to its parent folder, or become unfiled at the top level. No item is deleted. Existing items start unfiled; the import's original relative path does not create folders.
- Trash and restore keep an item's folder. The trash view is not scoped by folders.
- Folder changes follow the title rules: write lock, refused in a session opened from `index.prev.bin`, and the previous folders are restored when the save fails.

### Index format version 2

- An index is saved as version 2 only while it holds a folder or a `folderId`; otherwise it stays version 1, so a vault that never used folders still opens in older builds.
- Version 1 readers reject version 2 (`UnsupportedFormat`) instead of opening it and silently dropping folders on their next save. Every PC and tablet build that may open a vault with folders must be updated first.
- Loading checks that folder ids are unique, parents exist, there is no cycle and every `folderId` names a folder; a version 1 index carrying folders is corrupt. Saving refuses an inconsistent index.
- The tablet reader accepts versions 1 and 2 and keeps its flat list, ignoring folders, until the tablet screen follows the PC design.

## Amendment (2026-10-07): Video thumbnail from a viewer frame

- "이 프레임을 썸네일로" in the shared viewer makes the current frame a vault video's custom thumbnail (`thumbnailObjectId`, `thumbnailSha256`). ffmpeg reads the frame from the existing loopback vault-playback stream, which decrypts ranges in memory; no plaintext file is written. The frame is re-encoded like other vault thumbnails and stored as a new encrypted object.
- The viewer captures the frame itself first: a hidden player of its own reads `/vault-playback/<id>` with CORS, which the media protocol grants only to the app's own origins and only for vault video responses, and the frame bytes are sent to the backend as an image. When the WebView cannot read the frame, FFmpeg takes it instead through a private loopback stream that exists only for that run.
- The generated poster is kept. The replaced custom thumbnail object is deleted unless another item still references it; anything left behind is removed by orphan cleanup. The action is refused while an import runs and in a session opened from the backup index. No format change: the tablet already prefers `thumbnailObjectId`.

## Amendment (2026-10-07): Video length

- Vault items gain an optional `durationMs`, recorded by FFprobe when a video is imported. Videos imported earlier are measured in the background while the vault is open on the PC: a few at a time, FFprobe reads each through the loopback vault-playback stream (no plaintext file), and the lengths found are stored with one index save. A video that cannot be probed is not tried again until the next unlock, and a session opened from the backup index measures nothing.
- No format change: the field is optional, older PC builds and the tablet ignore it, and an older PC build that saves the index only drops lengths that are measured again later. Tiles show "—" instead of "0:00" while a length is unknown.

## Amendment (2026-10-07): Thumbnails kept in memory

- The vault view keeps decrypted thumbnails in memory (object URLs) while it is open, so moving between folders does not decrypt every thumbnail again. The media protocol still serves them with `no-store`, so they never reach the WebView's disk cache; the memory copy is dropped when the vault view closes or locks. The view reads them with `fetch`, which the media protocol allows only for the app's own origins on `/vault-thumbnail/`.
