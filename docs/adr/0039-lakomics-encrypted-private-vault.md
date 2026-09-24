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
  - `index.bin`: the encrypted vault index (items, original names, relative paths, titles, thumbnail references, content hashes, trash state). Written atomically (temporary file, flush, rename); the replaced generation is kept as `index.prev.bin`, and unlock falls back to it when `index.bin` does not decrypt.
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
- Vault trash (2026-09-24): trashing sets `trashed_at`; trashed items leave the gallery and its counts and appear only in the 휴지통 view, where they can be restored. Nothing is purged automatically. 영구 삭제 (selected trashed items) and 휴지통 비우기 save the index without the items first, then delete only the objects no remaining item references (objects can be shared, e.g. a sidecar image kept as a video thumbnail). Permanent deletion is refused while an import runs and in a session opened from `index.prev.bin`. Trashed items do not count as already present when the same file is added again.
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
