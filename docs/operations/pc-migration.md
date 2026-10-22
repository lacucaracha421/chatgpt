# Lakomics PC migration and recovery

Reconciled 2026-10-22 at `2e8db984`. This guide covers Windows/Linux portability
and recovery boundaries, not a newly verified restore procedure.

## What is portable

- Preserve intentional source changes through the user's authorized Git workflow; a migration does not authorize commit/push or branch changes.
- A closed library-folder copy preserves local metadata and media. Collection source folders stored relative to the library follow it; external manga/source folders must be copied or remounted separately. Older internal absolute paths can resolve relative to the current library when the old location is unavailable and the corresponding folder exists; reads do not rewrite the DB.
- Server-owned domains recover through their supported replica/bootstrap contracts. After authority adoption, both local and server whole-database snapshot restore are refused. Do not replace `library.sqlite` to bypass that fence.
- Existing Cloud Library media can reconstruct supported managed originals/thumbnails through the available recovery controls; metadata alone cannot recreate missing source files. Video derivatives can be regenerated from originals. Never rerun the completed full backfill or replace the catalog DB as a migration check.
- Companion uses pairing, portable profiles and supported settings synchronization; the old Collector-token AES-GCM `/v1/extension-backup` envelope was removed and is not the current restore path.

## Device-local setup

Credentials, device identity and external paths are separate from shared library state.
Re-enter secrets through application settings and the platform credential backend
(Windows Credential Manager or the configured Linux backend). Reattach external
manga/source folders and set their paths on the new machine. Keep tokens and keys
out of Git and migration notes. Tailscale identity is configured on the new machine,
not copied from the old device.

Current checkout examples are `V:\chatgpt` on Windows and `/home/laku/chatgpt` on
Linux. Follow the [Windows](windows-desktop.md) or [Linux](linux-desktop.md) guide
for pinned tools and native prerequisites; run npm from `_tools/app/`.

## Migration sequence

1. Close the old app before making a library-folder copy. Preserve originals, metadata and any external sources that must survive.
2. Prepare the new machine from the intended source revision and the applicable platform guide. Do not infer a library from old exports or fixtures.
3. Open the intended library, configure connection/device credentials and check connectivity. Use supported authority replica/bootstrap recovery for shared domains; if unavailable, stop and define a separately authorized recovery operation.
4. Use only media recovery/replication controls available for that library. Inspect missing/server-unavailable files before calling recovery complete. Recovery writes require explicit scope; this documentation pass performs none.
5. Reattach external manga/source folders, verify representative local images/videos and check regenerated video derivatives where relevant.

## Restore the browser profile

Load the current [Lakomics Companion](../../extension-list/README.md), pair with
the same Lakomics server/library, and allow supported profile/settings refresh.
Check folder order, pins, hidden destinations and translation preferences; reload
collecting pages so the current content scripts are active. Provider credentials
and device connection secrets follow their own settings/pairing controls; do not
assume an old encrypted backup restores them. Explicit temporary downloads are
independent of permanent server capture.

## Verification limits

Check the expected library and authority status, representative media, shared
Collections/Albums and the extension's paired connection. A test capture is a
production write unless a disposable library is explicitly in scope. Installed
versions, device acceptance and production sync are separate evidence levels.

For authorized development verification, follow the
[server test guide](../../server/lakomics-api/tests/README.md), owning-package
frontend checks and the repository-root Rust wrapper:
`bash scripts/cargo-test.sh -- <filter>` or
`powershell -NoProfile -File scripts/cargo-test.ps1 -- <filter>` on Windows.
Use `bash scripts/check-project.sh` for the full pre-commit check when required.
