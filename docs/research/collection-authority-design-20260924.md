# Collections to server authority (+ mobile work-info lookup) — design

Status: design accepted 2026-09-24 with the §6 decisions. Goal: phone and PC are both owners of Collections (create, edit, delete works with the PC off), and the phone can look up work info (TMDB/IGDB/books) without the PC.

## 1. Current state

- The PC owns every Collection.
  - `cloud/collections.rs:258-407` builds a full snapshot, and the server deletes and reinserts every row (`mobile_collections.py:358-362`).
  - The personal-edit bridge replays its log over that snapshot (`collection_personal_edits.py`, PC `library/collection_personal_edits.rs`).
  - AV is never published.
  - Local writes mark Collections dirty through the 0074 triggers.
- Provider lookups are PC-only; the server holds no provider keys.
  - Providers: TMDB (Bearer token), IGDB (Twitch client credentials), MangaDex (no key), Kakao Books (REST key), Aladin (legacy key).
  - Credentials live in the OS credential store (`credential.rs:14-23`).
- The existing product direction (`server-authority-v2-product-decisions-20260915.md` §8) already says provider access should move behind the server.

## 2. Ownership model — one `collections` authority domain

The domain covers these entities, each with its own revision:
- **Work**: client UUID; type, name, `legacyKind`; editable metadata; personal fields (myScore, memo, showcase, showcaseOrder); `coverAssetId`; selected artwork per kind.
- **Binding**: `(work, provider)` with externalId, config and the provider snapshot (the fill-merge baseline).
- **Artwork**: immutable record with kind, provider ids, dimensions and original sha256/size/mime.
- **Volume** and volume sources; **Ownership** (edition tracking, physical/digital); **Membership** (work↔asset desired state).
- **AV** details, persons and relations, if AV is included (§6).

The domain keeps these invariants together:
- deleting a work cascades to its children;
- covers belong to their own work;
- a provider identity is unique;
- showcase order is kept per type.

**Merge moves to the server.** The provider merge (fill only empty fields or fields still equal to the previous provider snapshot; `tmdb_flow.rs:833`, IGDB `*_can_fill`) runs inside the server command. A stale or remote client can then never overwrite a user edit.

**Stays PC-local or derived:**
- source folders and local file paths;
- thumbnails and activity;
- update and release-watch worker state;
- computed values (assetCount, fallback cover, season ranges, unread releases).

The server projection computes assetCount from Membership combined with asset visibility.

## 3. Contract

- **Envelope:** ADR-0037 D2 / ADR-0038 §5 (library, epoch, contract version, operationId, commandType). Receipt, change, change-log row and cursor are written in one transaction.
- **Commands** (explicit desired state):
  - `createWork`, `deleteWork` (tombstone).
  - `updateWork` with field-level compare-and-set: accepted when the revision matches, or when every touched field still equals its `expected`. myScore and showcase rebase automatically; memo, name and text fields surface a conflict.
  - `setShowcaseOrder` (new reorder capability).
  - `bindProvider` / `unbindProvider`; `applyProviderSnapshot` (server merge; stale base → `providerSnapshotStale`).
  - `addArtwork` (the blob must already be confirmed in R2) and `selectArtwork`.
  - `upsertVolume`, `setVolumeOwnership`, `setMembership`, `saveAvDetails`.
- **Conflicts:** `providerIdentityTaken`, `nameConflict`, `workDeleted` (dropped, not retried).
- **Feed:** `GET /v1/collections/authority/{status,baseline,changes}`, with the full post-change entity state per row and a paged baseline.
- **PC replica:** `library/collection_authority.rs` plus a migration (Album/Classification pattern).
  - Every PC write path becomes an optimistic local write plus an outbox entry: collection, TMDB, IGDB, MangaDex, Aladin, artwork, volumes, tracking, AV, and the similarity membership merge.
  - Add a test guard that fails on any Collection-table write outside apply or the outbox.
- **Mobile:** reads stay on `/v1/collections` (served from the authority projection, so current APKs keep working); writes go through a generalised command outbox.
- **Artwork bytes:** R2 content-addressed `work-artwork/mobile/{sha256}` via the existing prepare/check receipts. Any device uploads before `addArtwork`. The PC materializes files locally in the background.
- **Deletion:** logical tombstone; the name and provider identity are freed; R2 is not deleted (GC deferred); the PC deletes local files only after acceptance, using the ADR-0038 §7a guards. Library Assets are never deleted.

## 4. Work-info lookup from the phone

Recommended: a server-side provider proxy, `server/lakomics-api/work_providers.py`.
- **Endpoints:** `GET /v1/works/providers|search|preview`, `POST /v1/works/apply|refresh|artwork`.
- **Server-side handling:**
  - SQLite cache (search ~24 h, detail ~7 d);
  - per-provider pacing carried over from the PC (IGDB 4/s, MangaDex 4/s, Kakao 100 ms; TMDB conservative), honoring Retry-After;
  - per-client search cap;
  - no query or URL logging.
- **Artwork:** the server fetches the chosen images into R2 (32 MB and 16 MP limits); candidate thumbnails come through a server image proxy, so the phone never contacts provider hosts.
- **Apply:** before the Collections cutover, through the log channel (PC replays with the stored snapshot, no refetch); after it, `applyProviderSnapshot` directly.
- **Mobile UX:**
  - "작품 정보 연결 / 정보 새로고침" in the detail screen and "새 작품" in the Collections tab.
  - A search sheet with provider chips by type, then a preview with poster/backdrop strips and read-only TV seasons.
  - Reconnect shows a diff; refresh is one tap.
  - Outbox with 대기/충돌 states; provider attribution in the sheet.
- **Secrets to copy to the server** (user approval required; server environment or secret file, never in the repo):
  - the TMDB read token;
  - the IGDB/Twitch client id and secret;
  - the Kakao REST key;
  - optionally Aladin (legacy).

## 5. Migration, cutover and slices

1. Server substrate with inactive fences in the replica PUT and personal-edit acceptance.
2. Staging:
   - the PC drains the personal-edit log;
   - uploads every in-scope artwork original, turning source-folder covers into real Artwork records;
   - stages a digest-bound baseline, which the server validates (ids/counts vs live rows, artwork ownership, memberships vs Assets, unique bindings, cursor).
3. Activation (separately authorized):
   - epoch 1;
   - fence the legacy replica PUT (`legacyWriterFenced`);
   - personal-edit POSTs become a compatibility shim onto `updateWork`, so the installed APK keeps working;
   - disable the collections publication lane.
4. Retirement: drop the 0074 triggers and the personal-edit tables after the retention window.

- **Older Windows build:** fenced after activation. On upgrade it adopts the server baseline and exports local-only differences as a salvage report (not auto-applied).
- **Rollback:**
  - Before activation: discard staging.
  - After activation: pause writes, restore the server authority backup, rebuild replicas. Never republish a PC snapshot.

| # | Slice | Effort | User gets |
|---|---|---|---|
| 0 | Server substrate | M | nothing visible |
| 1 | PC baseline export + artwork upload + read-only dry run against production | M | a confidence report |
| 2 | PC replica (apply, outbox for all write paths, artwork materialization) + activation | L | phone edits land without publication |
| 3 | Mobile create/edit/delete, covers, showcase reorder | M | full work management on the phone, PC off |
| 4 | Retire the publication bridge for Collections | S | fewer sync failures |
| 5 | Provider lookup proxy + phone apply | L | search TMDB/IGDB/books on the phone |
| 6 | Mobile membership, volume ownership, AV (if chosen) | M | remaining desktop-only edits |

**Risks:**
- write-path coverage;
- baseline upload volume;
- offline duplicate creation;
- release-watch and update workers must submit fenced commands (CLOUD-WORK-001);
- Rust-to-Python normalization drift (use shared fixtures);
- provider terms for server-side caching.

## 6. User decisions (2026-09-24)

1. AV stays PC-only (not part of the server domain; no phone access).
2. Deleting a work moves it to a restorable Collections trash for 30 days before the tombstone.
3. Upload only selected artwork (current cover/backdrop/hero and volume covers); other candidates are fetched again through the server lookup when the user changes artwork.
4. Names are unique per Collection type (a film and a game may share a title).

5. Activate without waiting for the Windows PC; it is updated later in its own environment (WIN-SYNC-001), accepting that edits made on its old build are not carried over (salvage report only).
6. Provider secrets (TMDB, IGDB/Twitch, Kakao) move to a server-side secret file placed by the user following instructions; the assistant never extracts or copies credentials.
