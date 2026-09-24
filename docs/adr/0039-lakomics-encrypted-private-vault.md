# Lakomics encrypts the Private Vault itself

Status: Accepted

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
- Import from a plaintext folder keeps the existing vault's titles and custom thumbnails when that folder contains the old `.lakomics/index.sqlite`. Plaintext is never written to the USB during migration: the user copies the VeraCrypt contents to the trusted PC, formats the USB, then imports.
- Video plays in the in-app player through ranged decryption. External mpv playback is not carried over unless it can stream without plaintext files.
- The old plaintext vault format is supported only as an import source.
- A crash during import or deletion may leave orphan objects; they are removed after the next successful unlock by comparing `objects/` with the index. Objects and temporary files modified in the last 10 minutes are kept (they may belong to an import still running in another app runtime), and a session opened from `index.prev.bin` deletes nothing.
- Every write first re-checks the vault UUID in `vault.json`, so a USB swapped under an unlocked session is locked, never written. A resumed import skips a file only when an item with the same relative path, size and SHA-256 content hash is already in the vault.

## Boundaries

Vault data still never enters the main library database, the cloud or Android. The main library keeps only the vault UUID and last root path. Native Windows/Linux credential storage, real USB removal and large-video playback are native acceptance items; fixture tests do not prove them.
