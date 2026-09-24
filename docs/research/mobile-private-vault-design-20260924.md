# Private Vault on Android — design

Status: design accepted 2026-09-24 (decisions below). Requires amending ADR-0039 to allow Android via OTG; the cloud copy (B) is not adopted.

## Evidence

- **Vault crypto is standard and portable to Java** (`private_vault/crypto.rs`):
  - PBKDF2-HMAC-SHA256 (600k–20M iterations, 16-byte salt).
  - Master key wrapped twice with AES-256-GCM, AAD `lakomics-vault/wrap/v1/<uuid>/{password|recovery}`.
  - Objects: `"LKVO"|v1|purpose|32-byte salt`, then 64 KiB chunks plus a 16-byte tag. Per-object HKDF key; nonce `7×0|u32 BE index|final`; AAD `lakomics-vault/chunk/v1|uuid|objid|header|index|final`.
  - The index is JSON sealed under object id `[0;16]`.
  - JCA covers AES-GCM and HMAC; HKDF and PBKDF2 are about 40 lines.
- **Android builds with plain `javac` (`android/build.py`)**: no Gradle, NDK or Rust. A Rust core over JNI would need a new build path. A Java port has precedent: `NotesCrypto.java` is wire-compatible with the PC Notes envelope, and `SecureSettings.java` already wraps secrets with an AndroidKeyStore AES-GCM key.
- **WebView:** `MainActivity` serves `https://app.lakomics.local` through `shouldInterceptRequest`. The existing `/media-cache/` responses are cacheable, so the vault needs its own `no-store` route.
- **Already set:** `allowBackup=false`. **Missing:** `FLAG_SECURE`.
- **The PC has no network-reachable server;** the extension API binds to `127.0.0.1` only.

## Options

- **(A) USB-C OTG + SAF, decrypt on the tablet — recommended.**
  - Same security as the PC: ciphertext on the USB, keys only on trusted devices, nothing new on any server. Works offline.
  - Effort: medium (Java crypto port ~300 lines, SAF reader, bridge, vault screen, media route).
  - Risks to verify on device: SAF random access on OTG, exFAT, PBKDF2 unlock time in Java, no atomic replace in SAF (writes are riskier).
- **(B) Encrypted cloud copy on R2.**
  - Works without the USB, but changes the threat model:
    - a server or R2 breach allows offline password guessing against `vault.json`;
    - it leaks object count, near-plaintext sizes, add times and per-view access timing.
  - Mitigation: upload only the recovery wrap plus device-enrolled wraps.
  - Tens of GB of upload; two-writer index conflicts. Effort high. A separate decision.
- **(C) Stream through the PC over Tailscale — rejected.** It needs a new remote decrypt listener on the desktop (new attack surface), and works only while the PC is on and unlocked.

## Recommended plan (A), staged

- **A1, read-only:**
  - pick the USB root once (`ACTION_OPEN_DOCUMENT_TREE` + persisted permission);
  - unlock with password or recovery key; list; view images and thumbnails; play videos with seeking; lock.
  - No writes to the USB at all (not even orphan cleanup), so a vault the PC created can't be corrupted.
- **A2:** "Remember on this tablet" (per-vault AndroidKeyStore key alias `lakomics.vault.<uuid>`, master key ciphertext in SharedPreferences with the UUID as AAD), optional biometric, auto-lock tuning.
- **A3:** writes (add, trash) with a SAF write protocol (temp document → rotate `index.prev.bin` → rename) and a UUID re-check before writes.

## Details

- **Format compatibility:**
  - New platform-free `VaultCrypto.java` (JVM-testable in `build.py` checks) matching every PC rule: header limits, AAD strings, HKDF info, nonce/AAD layout, final flag, length derivation, last-chunk authentication, recovery-key parsing, strict 32-hex object ids, unknown index versions rejected, unknown JSON fields tolerated.
  - Golden fixture vault emitted by a Rust test into `android/tests/fixtures/` and re-opened by both sides.
- **In memory:** the unlocked key is a native-side `byte[]` zeroed on lock and never passed to JavaScript.
  - Lock on `onStop` (optional grace period), screen off, OTG detach or I/O error, `onTrimMemory`, and manual 잠그기.
  - No auto-unlock until the vault reappears.
- **Media:** route `https://app.lakomics.local/vault/<session-nonce>/<objectId>`.
  - `no-store`, `nosniff`, MIME from the index.
  - Streaming chunk decryption with Range/206 support.
  - Never through ThumbnailCache, MediaTransfer, the DocumentsProvider, share, the clipboard or temp activities.
  - The decrypted index lives only in memory.
- **Screens:** `FLAG_SECURE` on vault screens; also `setRecentsScreenshotEnabled(false)` on API 33+.
- **Tests:**
  - JVM `VaultCryptoTest` against the golden fixture: rejections and range reads.
  - Route and object-id validation.
  - Mobile client: nothing persisted, lock clears the UI.
  - Device acceptance: OTG/SAF random access, unlock time, video seeking via 206, unplug locks, `FLAG_SECURE`, Keystore after reboot.

## User decisions (2026-09-24)

1. Android access via USB-C OTG on the tablet (option A). No cloud copy.
2. First slice is read-only (no writes to the USB from the tablet); add/delete later.
3. "Remember on this tablet" is off by default, with an optional fingerprint (biometric) unlock.
4. Auto-lock one minute after the app goes to the background; vault screens use `FLAG_SECURE` (no screenshots or recents preview).
