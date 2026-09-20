# Lakomics Backlog

Living source of truth for **active** Lakomics work only. Completed, superseded, applied, and incident-only records live in [lakomics-completed.md](lakomics-completed.md).

Reconciled 2026-09-15 after the production server-authority/bookmark pilot completed end-to-end and the first real-use automatic-convergence follow-up landed. This incorporates current source inspection and the user's current product acceptance; it is not a new Windows full-system audit.

## Current priority

1. **CLOUD-POST-001** — continue simplifying PC/Android around the now-proven server-authority model.
2. **MEDIA-R2-001** — spend available R2 capacity on fitting immutable image/video derivatives instead of repeatedly moving oversized originals.
3. **CHAR-AUTO-001** — calibrate the remaining character-classification accuracy annoyance using representative mistakes.
4. **SIMILARITY-004** — discover near-duplicates that already coexist in the library.
5. **WORKS-001** — small Film polish: cast/director, release information, and related works.

Verification-only, close opportunistically through normal use: `CHAR-AUTO-006`, `EXT-011`, `EXT-012`.

Later / optional: AV source-and-candidate selection (`LONG-001`), image mirror/rotation matching (`SIMILARITY-002B`), Artist hub (`ARTIST-001`), optional provider work (`CATALOG-002B`), Jev decision-model evaluation (`AI-JEV-001`), and Zed IDE workflow evaluation (`DEV-ZED-001`). Similar-video calibration stays deferred until representative samples naturally appear.

## Status legend

- `IN_PROGRESS` — active implementation lane.
- `PARTIAL` — useful implementation exists; a material current-product gap remains.
- `TODO` — executable work not yet implemented.
- `VERIFY` — implementation exists; only targeted acceptance remains.
- `MERGE CANDIDATE` — fold into another active item rather than build separately.
- `HOLD` — intentionally deferred or gated.

`DONE`, `APPLIED`, and `OBSOLETE` items are archived in [lakomics-completed.md](lakomics-completed.md) and should not be selected from this file.

## Repository-wide execution rules

- Preserve existing user data and provider bindings; prefer additive/reversible changes.
- Do not rerun the completed full Cloud Library backfill unless a separately approved recovery operation requires it.
- Do not replace `kdata.db` wholesale for catalog work.
- Keep count/pagination correctness in Rust/SQLite rather than frontend-only filtering.
- Native Android is the production mobile architecture; do not revive the browser-extension prototype as the client architecture.
- Reuse the existing Collection presentation renderer rather than creating parallel renderers.
- Before each implementation batch, re-check Git status/diff and concurrent ownership.
- Production data writes, deployments, device installation, and Git writes still require their own explicit authorization.

# Cloud / Mobile authority

## CLOUD-POST-001 — 서버 원천화 이후 클라이언트 구조 정리

Status: `IN_PROGRESS` — the first post-authority client slice landed on 2026-09-15 after real use exposed that B5/B6 existed but had no automatic runtime orchestration. Broader domain migration/simplification has not started yet.

Goal: once shared domains are genuinely server-authoritative, stop treating the server as a mobile publication target. PC and Android become clients with local replicas/caches; the server owns canonical shared state.

2026-09-15 product-direction checkpoint: the user confirmed a broader Server Authority v2 target covering near-parity PC/Android shared editing, short offline operation with durable local intent, server-native extension ingest, rebuildable PC/Android replicas, server-owned durable jobs with one automatic main PC worker, 30-day trash/history, server-side provider refresh/important notifications, and encrypted Notes sync while the USB-backed private vault stays local-only. The Android source audit and exact product decisions are recorded in [Server Authority v2 product decisions](../research/server-authority-v2-product-decisions-20260915.md). This checkpoint records requirements and migration inputs, not an approved implementation sequence.

2026-09-15 architecture checkpoint: the follow-up PC audit is recorded in [Server Authority v2 PC audit](../research/server-authority-v2-pc-audit-20260915.md), and [ADR-0037](../adr/0037-server-authority-v2-replica-and-command-contract.md) proposes per-domain authority cursors/epochs, a small aggregate sync-status/wakeup layer, durable PC/Android replicas/outboxes, server-state recovery instead of whole-PC SQLite rollback, and a fence-first migration. The first implementation batch is safety substrate only; it must not activate another authority domain or mutate production data.

2026-09-15 Album authority 2A (server only): `server/lakomics-api/album_authority.py` adds the `albums` domain — typed `album_authority_state`/`album_authority_members`/receipts/changes/retention tables, a **paginated frozen** baseline (first page establishes `snapshotCursor`; a mutation in between returns `baselineChanged`; only the last membership page sets `complete`), a publisher-only activation that derives canonical state from the stored staged snapshot and fences the legacy writer in the same transaction, self-contained replayable change rows, `GET /v1/albums/{baseline,changes}` with explicit `cursorExpired`, and `PUT /v1/albums/commands` with the ADR-0037 envelope plus per-command compare-and-set. Album entity and membership revisions are separate lineages; a sibling-name collision returns `duplicateAlbumName`, not `revisionConflict`. The legacy snapshot gained an explicit camelCase `snapshotVersion`: 1 is the old display shape, 2 adds per-Album appearance, and 3 adds the canonical `memberships` collection built from every `asset_albums` relation regardless of Asset display status (trash preserves membership, so activation must see it). Only version 3 is authority-ready, and the PC publisher sends 3. A version-3 snapshot must state `memberships` explicitly. Activation retains trusted canonical relations whose Asset is not yet materialized on the server (notably local-trash membership); Album Asset reads continue to hide them through the committed-Asset join, while ordinary new membership adds still require a committed Asset. The baseline now also carries membership tombstone revisions, and the staging upload bound is 96 MiB, measured against the documented maxima. `PUT /v1/library/album-snapshot` calls the Safety Batch 0 fence inside its replacing transaction. Album authority is **not active**, no client adopts it, and PC/Android behavior is unchanged. Domain boundary: Album identity/name/hierarchy/appearance and Asset↔Album membership are authority; asset dimensions/dates/media metadata are not. Remaining: PC 2B outbox+receive and Android 2C. Exact scope and evidence: [ADR-0037](../adr/0037-server-authority-v2-replica-and-command-contract.md).

2026-09-15 Album authority PC 2B (client only; Album authority is still **not active** anywhere and the legacy publication path remains in charge): `library/album_authority.rs` adds the PC's durable Album replica state — `album_authority_sync` (adopted identity/epoch/contract/cursor), `album_authority_revisions` (confirmed Album entity revisions including tombstones), `album_authority_membership_revisions` (confirmed relation revisions, separately keyed so a rename cannot satisfy a membership compare-and-set) and `album_authority_outbox` (migration 0082). `library/album_reconciliation.rs` adds baseline adoption and ordered change replay; `cloud/client.rs` gains the `/v1/albums/{baseline,changes}` and `/v1/albums/commands` transport with coded 409 decoding. Two design differences from the bookmark pilot are deliberate: sync order is **flush-first** (`flush -> only when clean, receive`), because a received structural page must never overwrite a local edit the server has not accepted or rejected; and the queue is **strict FIFO with no coalescing**, because `create A -> rename A -> move A` are ordered dependent operations. Confirmed revisions and pending intent are kept apart — speculative revisions live only inside queued payloads. A remote apply never enqueues. Every local Album mutation now commits its intent in the same transaction as the effect, so a library that never adopts the authority is byte-identical to before. The restore guard covers the new domain, and the frontend runs the loop every 5 seconds with an immediate flush after each local Album mutation. A relation to an Asset this PC has not materialized still converges: the confirmed revision is always recorded and only the visible `asset_albums` row waits for its Asset, because failing such a page would stop the domain cursor forever on a correct relation. 2026-09-15 Album authority PC 2B.1 (review fixes, client only): multi-page change catch-up now measures progress against the cursor each page was *requested* from, so a catch-up longer than 100 changes converges instead of being rejected as a protocol error; withheld memberships whose Asset appears later are completed by an idempotent local projection on every clean cycle instead of waiting for a baseline that may never come; the `albums` metadata publication lane consumes its legacy generation locally after adoption instead of retrying the now-fenced `/v1/library/album-snapshot` forever (triggers, tables and route retained); and Album command acceptance is validated field-by-field against the stored payload while coded rejections are mapped by code rather than HTTP status, with an explicit protocol-integrity error for malformed or mismatched 200s.

Windows/Linux native and Android device verification of the Album contract remain unperformed.

2026-09-16 Album authority Android 2C-2 domain-boundary correction (documentation only; no code change, no active Album authority): the earlier 2C-2 framing — cutting Photo Picker, `LibraryDocumentsProvider` and the WebView Library from a classification-backed Album model to the Album replica — was wrong and is withdrawn. Classification and Album are **separate canonical domains**: `classification_entries` (migration 0001, `kind IN ('root','work','tag')`) and `albums` (migration 0008) are different tables with different schemas, hierarchies and ids; the desktop UI distinguishes `앨범에 추가` from `폴더로 이동`; and the WebView sidebar additionally renders Character/Group navigation that has no Album equivalent. The existing `class:<classification-id>` Photo Picker collections and DocumentsProvider directories are therefore the Classification domain exposed through Android collection/folder APIs, **not** a second canonical Album source. Album Authority governs only Albums and Album↔Asset membership, its readers are additive under their own `album:<album-id>` namespace, and Classification/Character navigation is never removed, replaced, renamed or retired by Album Authority work. When Album authority is inactive or unadopted, only Album-specific surfaces are absent. Also recorded: `/v1/library/album-media` reads the legacy display-oriented `album_replica` snapshot and is not the new authority read source, and Album membership alone cannot render Asset rows because the replica stores no content type/size/dates — Asset metadata keeps coming from the Asset projection and must not be duplicated into `library-replica.sqlite`.

2026-09-16 Album authority Android 2C-2 (device-accepted on isolated test server; no production activation): landed the authority-backed Album contents read `GET /v1/albums/assets` (active-authority gated, `desired_state=1` membership joined to committed Assets, deleted Album is `404 albumNotFound` not empty, strict deterministic cursor with the Album id bound in, Asset display metadata joined from the Asset domain rather than copied into the replica) and the additive Android Album readers — `AlbumCollections` (`album:` beside the untouched `class:`), Photo Picker membership merged onto already-eligible Assets, a separate `Albums` directory in `DocumentsProvider`, and a distinct WebView Albums section that renders nothing while authority is unadopted. `/v1/albums/assets` was added to `NetworkPolicy` only once a consumer existed; `/v1/albums/commands` is still not reachable from Android. Galaxy Tab acceptance against the isolated authority fixture covered WebView 40+5 pagination, Classification+Album coexistence, nested Album membership filtering, the main `com.lakomics.mobile.cloud` Photo Picker provider, a real HTTPS PNG selected and uploaded through Photo Picker, and SAF `Albums` navigation plus thumbnail and original-byte delivery (8,090 bytes, expected SHA-256) to a temporary receiver app. Device testing also found and fixed camelCase continuation decoding, constrained Album-dialog scrolling, and the portrait drawer's incorrect paused state. No production Album authority or production data was touched. Android Album writes and their outbox remain 2C-3; the legacy `album_replica` publication path is still unretired.

2026-09-16 Album authority Android 2C-3 (implementation complete locally; production authority/data unchanged): adds **membership-only** mobile Album editing from Viewer — single Asset ↔ existing Album add/remove, with no mobile structural Album editing yet. `library-replica.sqlite` v3 owns a durable FIFO `album_authority_outbox`; each real toggle commits optimistic membership state and its immutable `setAlbumMembership` intent atomically, same-state repeats enqueue nothing, lost responses retry the same stored payload/operation id, and semantic conflicts become durable `blocked` rows without silently reversing the user's choice. Each row also binds `libraryId`/epoch/contract: baseline/change replay only re-projects intents for the exact current authority, and a replacement authority blocks stale rows in the same transaction before they can appear in the new library. The unreleased intermediate v2 schema upgrades conservatively to v3 with non-sendable identity sentinels instead of guessing or deleting queued intent; unknown future schemas fail closed without deleting the outbox. Sync is flush-first and receives only with a clean queue; same-identity fresh baselines still replay pending desired states so cursor recovery cannot erase offline intent. Android `NetworkPolicy` opens exactly `PUT /v1/albums/commands`; Viewer exposes a hierarchical checkbox dialog with immediate optimistic state, `저장 대기`/`동기화 충돌`, and ~5 s local-status refresh; accepted writes trigger Photo Picker snapshot refresh. Galaxy Tab native write acceptance passed again on the final v3 code through an isolated `/data/local/tmp` Android SQLite/app-process harness plus a temporary PC test server: one identity-bound membership command was PUT once, accepted, removed from the outbox, and left confirmed revision 4; the main app/production Album data were not used as the fixture. The actual installed app also migrated its intermediate v2 database to v3 and cold-started without SQLite/missing-column errors. Remaining after 2C-3: structural Album editing on Android, conflict-resolution actions, legacy `album_replica` publication retirement, and optional manual Viewer-UI acceptance against a future isolated full-app fixture. Exact invariants/evidence: [ADR-0037](../adr/0037-server-authority-v2-replica-and-command-contract.md).

2026-09-16 Album authority Android 2C-4 (implementation + production device acceptance complete): blocked membership conflicts expose two explicit user actions. `서버 상태 사용` atomically discards the oldest blocker for that relation, restores confirmed authoritative membership and replays later pending immutable FIFO intents for local presentation. `내 선택 다시 적용` removes the blocker and creates a brand-new operation id/payload at the same FIFO position using the current authority identity and current confirmed membership revision; the rejected payload is never mutated or reused. Identity replacement and malformed conflict details fail closed. Verification before device acceptance: `AlbumReplicaTest` 301 checks, Viewer conflict frontend 7/7, full mobile frontend 154/154, Android release build/signing passed. The signed APK was then installed in place on the Galaxy Tab and both actions passed a real production stale-revision exercise: `서버 상태 사용` consumed a `409 revisionConflict` without issuing a replacement command or advancing cursor 7, while `내 선택 다시 적용` created a fresh command after a second conflict and advanced authority to cursor/revision 10 with the tablet's remove choice; PC reconciled it with outbox 0. The user restored the relation normally, leaving server and PC at cursor 11 / live membership revision 11 / outbox 0. Frontend actions were performed by the user; server logs and authoritative/PC state supplied backend evidence.

2026-09-16 Album authority production activation/canary: production was backed up with SQLite online backup (`quick_check=ok`), server Album authority code deployed, and a version-3 snapshot staged with 3 Albums / 39 canonical memberships / 31 display media rows. Activation initially exposed a real contract edge: 7 memberships referenced local-trash Assets intentionally absent from the committed server Asset replica. The activation guard was corrected to preserve trusted staged relations while display remains gated by committed Assets; focused server authority/Album-asset coverage passed 111 tests before deployment. Production activation then succeeded at epoch 1 / contract 1 / cursor 0. PC adopted the baseline (3 Album revisions, 39 membership revisions, outbox 0) and consumed the now-fenced legacy Album publication generation locally without post-activation snapshot PUTs. Android adopted the same authority through Tailscale Serve. A reversible real-production membership canary used one normal Asset in the `임시` Album: PC remove/add advanced cursor 0→2 and Android followed; Android remove/add advanced cursor 2→4 and PC followed. That initial canary restored the relation at revision 5 with 39 baseline memberships. Later 2C-4 production conflict acceptance advanced the same relation through revision 11 and restored it live again with PC outbox 0; server and PC now agree on 40 live canonical memberships because a separate `업로드용` relation was added independently at sequence 5. Frontend toggles were performed by the user; backend/server validation was read from authoritative state and logs. Legacy publication **retirement/removal** is still deferred even though its writer is fenced.


2026-09-16 Album authority Android 2C-1.3 (client only; no active Album authority, no Android Album writes): closes the remaining Scope H read-isolation gap. `adopted(scope)` already hid another connection's authority, but `status()`, `albums()` and `memberships()` were scope-unaware and returned the stored rows anyway, so a connection told "not adopted" could still read the previous connection's Albums, memberships and counts; an old in-flight baseline walk completing after a replacement made that observable. Every read now requires the scope explicitly — `State.status(scope)`, `State.albums(scope, liveOnly)`, `State.memberships(scope, liveOnly)`, plus `AlbumAuthoritySync.status(scope)`/`liveAlbums(scope)`/`liveMemberships(scope)` — with a private `owns(scope)` check performed inside the same lock as the row read it guards, so a replacement cannot land between the ownership check and the rows. A mismatched scope returns no rows and zero counts while the durable rows, tombstones included, stay in place; only an explicit replacement/reset clears them. `AlbumReplicaService.status()` resolves the configured scope once for both identity and counters. Verification: 190 AlbumReplicaTest checks (33 new Scope H checks), 39 AlbumReplicaScheduleTest checks, NetworkPolicy 266, DocumentTreePolicy 19, ThumbnailCache 19, MediaTransfer 22, TemporaryImagePolicy 23, NotesCrypto 4, PickerSnapshot unchanged, native compilation against android-35, `d8 --release` DEX, `git diff --check`; all four scope checks mutation-tested. Device verification remains unperformed.

2026-09-16 Album authority Android 2C-1.2 (client only; no active Album authority, no Android Album writes): three corrections to the 2C-1 substrate. (1) Arm generations are now real — tracking only "is polling armed" let a repeating task from a cancelled arm run after a re-arm, because the flag was true again for the newer arm; each armed timer carries a generation, validated under the same monitor that arms and disarms, with the callback also inside that monitor so the boundary is atomic rather than a narrowed window. (2) `ForegroundSchedule.restartAfter(invalidate)` invalidates *before* arming, because arming runs the immediate pass synchronously and arming first let the replacement connection's own reconciliation be invalidated by the clear that followed it — and since it had started, nothing was owed, so the new connection waited an interval. (3) A refused immediate pass is now owed rather than dropped: the immediate callback reports whether it started and `passFinished()` starts it when single-flight frees, so a resume or replacement connection reconciles as soon as possible. Separately, a successful changes page is bounded by the advertised authority cursor (the server returns 409 `cursorAhead` for `after > cursor`), closing an impossible 200 where an empty page claimed to continue past the authority and satisfied the `hasMore` rule because both sides were false. Verification: 157 AlbumReplicaTest checks, 39 AlbumReplicaScheduleTest checks, NetworkPolicy 266, DocumentTreePolicy 19, ThumbnailCache 19, MediaTransfer 22, TemporaryImagePolicy 23, NotesCrypto 4, PickerSnapshot unchanged, 137 mobile frontend tests, server album suite 63 passed, native compilation, `d8 --release` DEX, `git diff --check`; all rules mutation-tested. Device verification remains unperformed.

2026-09-16 Album authority Android 2C-1.1 (client only; no active Album authority, no Android Album writes): fixes a lifecycle defect in the 2C-1 foreground loop — `configure` called `AlbumReplicaService.reset()`, which stops polling, and configuring never pauses the activity, so Album reconciliation stayed stopped until the user backgrounded and resumed the app. Foreground state now lives in `ForegroundSchedule` (foregrounded, armed, cancel handle), `configure` uses `replaceConnection()` which restarts the schedule *without* an intervening stop (a stop means "left the foreground" and would leave the loop disarmed), `disconnect` still uses `reset()`, and a tick already dequeued after a cancellation is ignored by the state machine. Connection-race, scope-isolation, replica-clearing and single-flight behavior are unchanged. The changes page is also tightened: `nextAfter` must equal the last change's `sequence` (or the requested cursor when empty) and `hasMore` must equal `nextAfter < cursor`, matching the server's own derivation, so a page whose continuation disagrees with its rows cannot be committed; the engine keeps its separate progress guard for an empty page that claims more work without advancing. Verification: 137 AlbumReplicaTest checks, 27 new AlbumReplicaScheduleTest checks, NetworkPolicy 266, DocumentTreePolicy 19, ThumbnailCache 19, MediaTransfer 22, TemporaryImagePolicy 23, NotesCrypto 4, PickerSnapshot unchanged, 137 mobile frontend tests, native Java compilation, `d8 --release` DEX packaging and `git diff --check`. Device verification remains unperformed.

2026-09-16 Album authority Android 2C-1 (client only; Album authority is still **not active** anywhere, Android Album writes are still disabled, and no production data was touched): Android gains the first general-purpose **durable read-only Library replica** and uses Albums as its first domain. `library-replica.sqlite` is a separate app-private database (`notes.sqlite` is untouched) whose `PRAGMA user_version` 1 holds `album_authority` (the singleton adoption row; its presence *is* the adoption marker, so an unadopted install carries no row), `album_state` and `album_membership_state`. Both state tables retain tombstones — `deleted` and `desired_state=0` — because a later command must present the revision it observed rather than a fabricated one, and `desiredState=false` rows carry their own `entity_revision`. `AndroidReplicaDb` executes the shipped `ReplicaSchema` and owns the file location; `LibraryReplicaStore` owns every rule about what the replica holds (which rows are written, which are tombstoned, when the cursor moves, what one transaction contains) over a semantic `ReplicaDb` seam, so those rules run unchanged on a device and in the JVM check harness. `AlbumAuthoritySync` walks the **frozen paginated baseline** through `GET /v1/albums/baseline`, accumulating every page outside the live replica and installing it in one transaction only after the final membership page reports `complete`; it then applies ordered changes from `GET /v1/albums/changes`, checking strict contiguity against the stored cursor inside the same transaction that writes the page and advances the cursor. `GET /v1/sync/status` is validated before any domain is trusted (exact protocol version, `active == !domains.isEmpty()`, one library per server, unique domain names, positive epoch/contract and non-negative cursor). Recovery is by coded state, never by status: `cursorExpired`/`cursorAhead`/`baselineChanged` re-adopt a fresh baseline (safe here because 2C-1 has no write queue, so there is no unaccepted intent a baseline could overwrite), while `authorityInactive` and `authorityContractUnsupported` write nothing and `authorityLibraryMismatch` re-adopts on identity or epoch change. `NetworkPolicy` allows exactly three read-only paths — `GET /v1/sync/status`, `GET /v1/albums/baseline`, `GET /v1/albums/changes` — and `PUT /v1/albums/commands` stays blocked, so this build cannot issue an Album mutation even by mistake; the generic 4 MiB response limit is unchanged. `AlbumReplicaService` polls only while the app is foregrounded (immediate on resume, then ~5 s as the PC authority loops use), is single-flight, holds no wake lock and schedules no WorkManager job; a pass in flight when the connection changes is invalidated so it cannot report the replaced account's state. The replica is scoped by an opaque hash of endpoint+token following the existing native cache convention, and a connection/account change clears it without touching user media. The bridge gains one read-only `albumStatus` operation (adopted, libraryId, epoch, contractVersion, cursor, live/tombstone Album and membership counts, last reconciliation) and **no** Album mutation operation. **Picker, DocumentsProvider and the WebView Library still consume their previous sources**: `class:<classification-id>` Photo Picker albums, provider metadata caching and server-direct WebView reads are unchanged, and `album:<album-id>` is deliberately not added yet. Verification: 124 new native checks (`AlbumReplicaTest`, driven through a real local HTTP fixture and a real SQLite engine, including a mutation-tested atomicity and contiguity suite), NetworkPolicy 266, DocumentTreePolicy 19, ThumbnailCache 19, MediaTransfer 22, TemporaryImagePolicy 23, NotesCrypto 4, PickerSnapshot unchanged, 137 mobile frontend tests, and the shipped server's own `test_album_authority.py` (63 passed). As a cross-language contract check, the real server's baseline and change documents were fed through the shipped Java parser and engine validation. Android device/runtime verification, and every other mobile consumer cutover, remain unperformed.

2026-09-15 safety substrate landed: `server/lakomics-api/authority.py` reads the shipped `authority_domains` registry and provides the reusable legacy-write fence; `GET /v1/sync/status` reports active domains with per-domain epoch/contract/cursor and no global cursor; coded authority errors are defined for future routes; and the PC whole-database restore now refuses before any destructive step when a domain is active or its authority status cannot be read. Follow-up pass (2026-09-15): the guard covers **both** whole-database restore paths — the server-driven one and `Library::restore_backup` — through the shared `restore_snapshot_locked` plus the extensible `library/restore_guard.rs` probe list, and `sync_status` parsing now requires the exact supported protocol version and a self-consistent envelope instead of accepting any `protocolVersion >= 1`. No domain was activated, no legacy route was fenced, and the production bookmark authority schema/state is unchanged. Exact scope and evidence: [ADR-0037](../adr/0037-server-authority-v2-replica-and-command-contract.md). Album is the first structure domain to have its server contract and fence staged (2A above); classifications and asset membership follow the same shape.

First landed slice — Catalog bookmarks (`e3a5fb2`):
- PC now runs receive -> durable outbox flush -> optional receive automatically while a library is open, every 5 seconds plus online/focus recovery. A local PC bookmark mutation also attempts an immediate flush; failure leaves the durable intent queued for the background loop.
- Android Catalog watches the independent authority cursor every 5 seconds while active. A bookmark-only change refreshes list/detail bookmark state even when the immutable Catalog publication revision did not move.
- Real-use follow-up reproduced both missing directions before the fix: an Android removal existed on server sequence 4 while PC stayed at cursor 3, and a PC bookmark remained in a one-row outbox with no server row. With the fix live, normal runtime converged without manual operator commands to server/PC cursor 5, PC outbox 0, 264 live bookmarks and `quick_check=ok` on both databases; the user observed the tablet update.
- Five-second polling is the accepted baseline for this personal-state domain. SSE/WebSocket remains optional only if later domains show a concrete need for lower latency.

Next scope:
- Remove the product-level `PC -> publish -> mobile` mental model for domains that have moved to server authority. Existing `useMobilePublications`, manual `모바일 ... 업데이트/게시` controls, and one-way publication state should be retired or repurposed only after an equivalent server-owned live domain exists.
- Keep the PC SQLite/library instead of turning every screen into a remote REST query. It becomes a fast materialized replica plus workstation-only state: filesystem integration, drag-out, local paths, GPU/FFmpeg work, bulk ingest and recovery.
- Generalize the proven cursor + revision + durable outbox + idempotent operation pattern beyond catalog bookmarks so each new shared domain does not invent its own synchronization protocol. Publication revision and authority cursor are separate clocks and must not be conflated.
- Device-only presentation/preferences remain local; shared user data and domain state converge through the server authority.

Acceptance: normal use no longer exposes a manual "publish to mobile" concept for migrated domains; PC and Android can render cached state immediately, work through temporary disconnection where supported, and deterministically converge to the same server state.

## MOBILE-CACHE-001 — Android durable metadata replica

Status: `HOLD` — post-authority optimization.

Current mobile binary caching (`MediaRepository` / `ThumbnailCache`) is useful, but much of the browsing metadata is still held in React `Map` caches or `localStorage`. Add a small durable Android metadata database once the server change contracts are stable.

- Persist browse metadata, revisions/cursors and durable outgoing intents in a local database rather than relying on process-memory caches for normal startup.
- Startup should render the last committed local state first, then fetch/apply server changes in the background.
- Keep binary media in the existing bounded media cache; metadata replica and media cache are separate concerns.
- Revisit `PickerLibrary`'s independent JSON snapshot after this exists. Prefer deriving Picker/album views from the durable replica rather than maintaining another full-library metadata copy.
- Preserve explicit cache invalidation when the configured server/library identity changes.

Acceptance: after one successful sync, relaunching the Android app can show the previous library view without waiting for a full remote page load; later server changes update it incrementally without losing pending local intent.

## CLOUD-INGEST-002 — Cloud Capture를 server-native ingest로 전환

Status: `HOLD` — only after asset authority/fencing is proven.

Today Cloud Capture still reflects the older path where the server holds a pending capture, the PC imports it into the local canonical library, and cloud replication later republishes the resulting asset. Under full server authority, remove that PC-off gap.

- Extension capture should be able to finalize a canonical server asset and R2 media while the PC is off.
- The committed asset becomes visible to Android immediately and reaches PC later through the normal change/reconciliation path.
- Preserve stable capture/asset identity, idempotent retries, content validation and any review/quarantine rules needed before canonical visibility.
- Character classification, similarity, video analysis and other heavy enrichment must not gate base asset visibility; they are follow-up jobs.
- Do not delete the old PC import path until server-native ingest has recovery and rollback evidence.

Acceptance: save from the extension while every PC is off; the asset becomes a canonical, viewable mobile item exactly once, and a PC started later adopts the same asset without re-ingesting or duplicating it.

## CLOUD-WORK-001 — Server-owned durable jobs with PC workers

Status: `HOLD` — post-authority worker architecture.

The server should own what work is pending and what result is current, while heavy compute can stay on the PC. Generalize the durable lease/restart pattern already used by `mobile_catalog_refresh_jobs` instead of making the VPS perform every expensive task.

- Server owns job identity/state (`queued/running/completed/failed`), lease owner/expiry, retry state and accepted result revision.
- PC startup order for worker-backed domains: reconcile server changes -> preserve/flush local intents -> only then claim new work. A worker must not blindly calculate from a stale local snapshot.
- A job/result carries enough identity to prove what was analyzed: `asset_id`, content hash, input/entity revision, model version, reference-set version and relevant classifier/config version.
- Result commit is compare-and-set/fenced: if the canonical asset or relevant classification state changed after the job input was captured, reject the stale automatic result or retain it only as a non-authoritative suggestion.
- Manual/user-confirmed classification outranks automatic classification. A late model result must never silently overwrite a user decision made from mobile or another PC.
- Job/result submission is idempotent by stable job/operation ID. If a PC dies mid-job, the lease expires and another worker may retry; duplicate late completions must not apply twice.
- Multiple PCs may participate later, but only the current lease holder may commit ordinary work; recovery from an expired lease remains deterministic.
- Keep light network/provider jobs on the server where convenient, while CLIP/embedding, FFmpeg/video and other expensive processing can be leased to a capable PC.

Acceptance includes: PC-off queueing; mobile/manual edit while PC is off; stale result rejection after that edit; worker crash and lease recovery; lost response/idempotent resubmit; and two-PC contention without a double commit or manual-state overwrite.

## MEDIA-R2-001 — Aggressive R2 derived-media cache

Status: `TODO` — post-authority performance/capacity tradeoff; storage is intentionally spent to reduce transfer/decode latency.

The current replicated asset shape is essentially `library/{asset_id}/original` plus `thumbnail`. R2 capacity is available, so add immutable derived variants instead of repeatedly fetching/decoding oversized originals.

Suggested image variants (measure before fixing exact encodes):
- small thumbnail around 256 px for picker/very dense lists;
- normal thumbnail around 512 px for mobile masonry;
- preview around 1280 px for detail/quick viewing;
- preview around 2048 px for tablet full-screen viewing;
- original only for deep zoom, export or explicit original access;
- optional analysis-sized derivative for repeated CLIP/classifier input when it is demonstrably useful.

Suggested video/GIF variants:
- poster image for grids;
- bounded low-resolution preview (for example 480p) for lightweight motion preview;
- optional 720p viewing derivative where original files are disproportionately heavy;
- retain the original as the canonical media object.
Implementation constraints:
- Derivatives are caches/materializations, never independent authority. Regenerate them from the canonical object and metadata.
- Prefer immutable/versioned or content-hash-derived object keys so a new encode does not require risky in-place cache invalidation.
- Mobile chooses the smallest variant that fits the surface; do not fetch original-size media for a masonry tile or ordinary tablet preview.
- Preserve authenticated/private access. Do not make the personal R2 bucket public merely to gain CDN caching; edge-cache work is a separate optional layer.
- Track derivative version/digest and clean orphaned variants after source replacement or format-version retirement with a bounded lifecycle policy.
- Generate derivatives asynchronously after canonical asset commit; failure of a preview job must not hide the valid original asset.

Acceptance: common mobile browsing and full-screen viewing normally use a fitting derivative instead of the original, image/video cache misses remain recoverable, and deleting/replacing an asset cannot leave an unbounded set of orphaned R2 variants.

## MOBILE-WRITE-002 — 서버 원천화 이후 모바일 편집 확대

Status: `HOLD` — the production proof gate was satisfied by the 2026-09-15 bookmark pilot; keep this deferred until the user chooses the next mobile write domain.

Once bookmark convergence is boring and reliable, expand mobile writes only where the interaction benefits from a tablet/phone. Reuse the same stable identity, expected-revision, durable intent, receipt and conflict model rather than adding ad-hoc endpoints.

Preferred early domains:
- ratings/favorites/showcase state;
- album membership and lightweight organization;
- character-classification confirm/correct actions;
- tags and small metadata edits where bulk desktop tooling is unnecessary;
- Collection/read-state style personal metadata where cross-device continuity matters.

Keep destructive global media deletion under `MOBILE-003`; do not use this item to bypass tombstone/grace/recovery requirements. Bulk filesystem reorganization, GPU work and large maintenance operations remain PC-oriented even though their committed shared results converge through the server.

Acceptance: a supported edit can be made with PC off, survives offline retry/response loss, becomes authoritative exactly once, and appears later on PC without a manual publish/sync step.

## MOBILE-008 — Catalog update requests and status

Status: `IN_PROGRESS` — server refresh worker and Android request/status UI already exist.

Remaining is bounded live-source/native acceptance and fuller PC/server grouping reconciliation. This is a server operation lane, not an expansion of normal mobile editing. Keep it behind the authority/reconciliation rules proven by the archived `CLOUD-AUTH-001` contract where domains overlap.

## MOBILE-003 — Safe global deletion / tombstone protocol

Status: `HOLD`
Risk: HIGH.

Global cross-device deletion remains intentionally deferred. Require tombstones, grace period, acknowledgement/reconciliation, explicit purge, conflict handling, and recovery before activation.

# Mobile portrait usability feedback

## MOBILE-UX-001 — Portrait real-use follow-up

Status: `PARTIAL` — the first portrait APK and server image thumbnails are delivered and user-confirmed. The next Catalog/sidebar/settings/Collection bundle is now deployed, with the client updated to APK 0.6.5 (21) after the icon cleanup below; live API and device startup checks are recorded below; portrait rendering/touch acceptance for this new build remains pending. Video/GIF thumbnails, dimensions rollout, duplicate-check evaluation and the separate 3D/classification-capacity investigations remain open.

2026-09-19 Galaxy Tab feedback after the first portrait UI pass. These are user-reported observations and requested improvements, not independently reproduced defects or confirmed root causes. Keep portrait as the priority; landscape redesign remains later.

- **New-asset thumbnails missing on mobile, including after PC startup:** the initial report associated missing thumbnails with the PC app being off, but the user subsequently reports that starting the PC app still does not make new-asset thumbnails appear on mobile. This supersedes the assumption that running PC resolves the symptom; the initial report alone did not establish a root cause. The affected-asset trace and subsequent image-only server fix are recorded below. Verify real tablet rendering separately from server generation and delivery. Coordinate with `MEDIA-R2-001` and, if ingest or worker dependencies are involved, `CLOUD-INGEST-002` / `CLOUD-WORK-001`; this report does not authorize those broader migrations.
- **Asset Viewer information-panel design:** reorganize the panel for compact portrait use, reducing wasted space and redundant text while keeping the asset visually primary.
- **Asset Viewer information parity and copying:** the panel exposes less information than PC. Compare the actual PC/mobile fields and make useful missing information available on mobile. The first implementation copies creator text, the source URL, and a file-information summary; binary asset copying is not included.
- **Asset dimensions on the server:** include the asset's pixel width and height in server-backed metadata so mobile can display dimensions consistently with PC, including when the PC app is not running after synchronization. Trace existing extraction, synchronization, API and mobile presentation fields before deciding what is missing; no missing schema or confirmed transport defect is asserted yet. Coordinate with the Viewer information-parity item. Any production metadata backfill requires separate approval.
- **Sidebar folder-type icons:** add distinct icons for Character folders and Group folders so their types are recognizable at a glance.
- **Nested-folder selection highlight:** the user reports that the white selected-state highlight overlaps the line below the folder's `>` marker. The proposed direction is to limit the highlight to the folder-icon area so it does not overlap the hierarchy line; confirm the exact visual bounds against the current UI or a screenshot before implementation.

- **Character-folder thumbnail cropping:** the user reports that Character-folder thumbnails are too wide and appear cropped. Inspect the portrait container aspect ratio and image-fit behavior, then adjust the presentation to keep the character recognizable without distortion. The exact crop/container cause has not been verified.
- **Character-folder Back destination:** after entering a Character folder and going back, the user lands in a category labeled Series, whose purpose is unclear and which the user considers unnecessary. Reproduce the entry/return path and identify whether Series is an intentional parent screen, an exposed internal grouping, or an incorrect navigation fallback. Check both in-app and Android Back because the reported Back mechanism is unspecified. Prefer returning to the actual prior browsing context without an unnecessary intermediate screen; do not remove underlying classification data based on this UI report. Cause and intended destination remain to be verified.
- **Catalog hidden-tag controls:** place PC-style excluded-tag entry in a dedicated Catalog settings panel opened from a top-bar icon. A namespaced entry such as `female:scat` hides works carrying that tag; it is not a title substring exclusion or an ordinary search term. Trace PC matching/normalization and shared-policy ownership before adding writes, preserving namespace semantics and avoiding PC/mobile overwrite conflicts.
- **Catalog category controls:** replace the first-pass single-category selector with a checklist in the same Catalog settings panel, using existing PC categories. The user can include several categories at once, such as Doujinshi, Manga and Artist CG; selected categories combine with OR, then intersect with the search and exclusion policy. Do not require category query syntax or leave a separate category-filter row in the gallery. Preserve the chosen settings across searches. Define all/none selection and storage/sync behavior explicitly during implementation.
- **Catalog automatic refresh cadence (question):** confirm whether automatic refresh is enabled and its actual interval/triggers. Distinguish upstream Catalog collection/server refresh from mobile detection and display of updated results, and check PC-off and app-background behavior. Coordinate with `MOBILE-008`; do not mistake bookmark-state polling for Catalog content refresh. No interval or scheduling change has been requested or verified yet.
- **Catalog duplicate checking (evaluation):** the user asks whether the PC's duplicate-check feature can be brought to mobile and suspects it may depend on a running PC. Trace the existing Catalog duplicate-check data and execution dependencies, distinguish already-known results from newly computed checks, and assess PC-off support before choosing an implementation. Neither the dependency nor mobile feasibility is confirmed; do not conflate this with general near-duplicate similarity scanning.

### 2026-09-20 next portrait pass: requested scope

The following records the requested scope; the implementation checkpoint below
identifies delivered source versus still-open investigations. The user's attached
PC sidebar screenshot is the visual reference. Keep artwork
primary, controls compact, and landscape redesign deferred.

1. **Catalog settings and search:** use the top-bar settings icon and category/hidden-tag contracts above. Make ordinary space-separated input find the same relevant indexed names/tags as underscore-separated input; reproduce the failing query path before changing parsing. Preserve explicit namespaces, quoted expressions and operators rather than blindly replacing all spaces with underscores. Verify category inclusion, excluded tags, pagination/counts and search together, not just the first visible page.
2. **PC-aligned mobile sidebar:** use the screenshot's compact hierarchy, separators, folder rows and consistent icon language as a reference without mechanically shrinking desktop hit targets. Remove the Recent saved tab and make All the default destination, retaining chronological access through the existing All ordering rather than deleting recent assets or metadata. Reproduce and correct malformed Album icons. Reuse the PC icons and corresponding semantics for expanding only the selected folder, collapsing all folders and related tree controls; inspect the PC actions instead of guessing from glyphs. Preserve the earlier selection-fill and direct Character Back fixes.
3. **Collection long-text balance (design):** titles and creator/studio names that exceed two lines currently disturb the visual balance, per the user. Inspect actual card layouts and representative long Korean/Japanese/Latin values. Evaluate a consistent reserved title area (for example, two lines), a bounded secondary creator line and full text on the existing detail surface. Do not shrink text per item, introduce hover-only disclosure or change cover proportions merely to accommodate a long name. The exact layout remains a design decision, not accepted implementation.
4. **3D feasibility (investigation):** assess the intended use before choosing a renderer: displaying actual 3D model assets and giving Collection covers a 3D presentation are different scopes. Evaluate Android WebView/device GPU compatibility, memory, battery, loading and a usable static fallback. No engine dependency, per-card live 3D contexts, asset conversion pipeline or server rendering is approved by this record.
5. **Character classification server load (investigation):** locate where current inference, reference embeddings, matching and result synchronization actually execute; do not assume all classification runs on the VPS. Separately estimate/measure whether server-side execution is viable on the existing small server, including model residency, CPU/GPU needs, concurrent work and impact on the API. Thumbnail-generation success does not establish classification capacity. Do not migrate inference or run a production classification/backfill workload merely to evaluate it.
6. **Settings-window cleanup:** audit the mobile settings window end to end and retain settings for currently used, functioning features. Consolidate duplicates, remove obsolete or nonfunctional placeholder controls, reduce redundant explanation, and keep context-specific Catalog options in Catalog settings rather than duplicating them globally. Trace actual consumers before removing an apparently unused option. Preserve necessary connection/authentication, security, data-safety and recovery controls in an appropriately compact secondary section; do not delete saved configuration or user data as part of UI cleanup. This is a mobile cleanup request, not blanket permission to remove PC settings or their underlying capabilities.

Suggested implementation order: Catalog settings/search, sidebar and global settings
cleanup, then Collection typography. Keep the 3D and classification-capacity questions
as bounded investigations rather than coupling them to these UI changes. Previously
open dimensions, duplicate-check evaluation, video/GIF thumbnails and real-device
interaction acceptance remain tracked; this pass does not mark them complete.

### 2026-09-20 next portrait bundle: source checkpoint

- **Catalog settings:** a single contextual top-bar button opens the shared dialog. Category checkboxes combine with OR; unrestricted/all is the default, an empty selection returns no works, and several categories can be included together. A single `namespace:value` input, such as `female:scat`, adds exact namespaced avoidance tags. Apply commits the draft once; opening, cancelling or applying unchanged settings preserves browsing state and unsent search text.
- **Ownership:** display preferences are stored on this device, scoped to the configured endpoint. They do not write `/visibility` or synchronize settings back to PC. The published PC policy still applies unless the existing explicit reveal option is used; device exclusions still apply when revealing that policy. New additive read parameters are advertised by `capabilities.displayPreferencesVersion:1`. An unsupported server keeps legacy browsing when no local filter is active; saved filters are never silently ignored, and capability-check failure has a retry action.
- **Server query:** categories and avoidance tags constrain eligibility before grouping, counts, pagination, detail, editions and reader access. Filtered queries bypass baked pages/counts and retain the conditions in signed tokens. JSON filter, normalized-query and native-path bounds prevent oversized preferences from breaking page navigation. No new write authority, catalog replacement or production backfill is introduced.
- **Search:** opt-in `searchMode=mobile` allows a whole plain phrase such as `john doe` to match exact tags stored as `john_doe` or `john doe`, with the same convenience for `artist:john doe`. The existing title-word branch remains; underscores and percent signs do not become SQL wildcards. Explicit operators/quotes retain their grammar, with separator aliases only on exact tag values. Clients omitting the mode retain the previous parser.
- **Sidebar/global settings:** Library starts at All; the redundant Recent saved sidebar entry is removed (the separate Home destination remains). Nested indentation and selection stay outside the expander/connector; Album appearance uses PC icon/color mappings. Collapse-all and current-path actions use the PC glyphs. Connection editing is collapsed when configured, while authentication, private-network security, media-cache operations and picker recovery remain available.
- **Collection/Viewer:** cards reserve a two-line title area and keep creator/studio text on one ellipsized line. The existing detail view exposes full names. Viewer information avoids a duplicate section/row heading while retaining values, copy actions and nested Back behavior. Cover proportions are unchanged.

Verification on the local checkout: the full mobile suite passed **293 tests / 26 files**; two subsequent publication-check regression tests were added, and that focused file passed **3 tests**. Mobile TypeScript/Vite production build passed. The real SQLite query suite passed **30 tests**, including the shared PC fixture, exact tag aliases, literal wildcard characters, prepared/fallback eligibility, counts and editions. The final HTTP/cursor suite could not import because local Python lacks `fastapi`; syntax checks passed, but HTTP acceptance is **not** claimed. Earlier worker results do not establish acceptance of the final rewritten query implementation.

Rendered fixture checks covered 390x844 and 800x1280 portrait and 1280x800 landscape. Final Catalog-dialog checks confirmed 11 initially checked categories, one tag input, visible Apply actions, no horizontal overflow and no runtime exceptions. Collection long-text and nested-sidebar screenshots were also inspected. These are browser fixtures, not Galaxy Tab, live Catalog or native acceptance. No new server deployment, APK build/install, Git commit/push or production-library write was performed for this bundle. Next operational step: separately authorize final server API verification/deployment and APK delivery, then accept the portrait interactions on the tablet.

### 2026-09-20 authorized API rollout and APK delivery

This operational checkpoint supersedes the source checkpoint's pending deployment/build/install and missing-FastAPI verification gaps, not its remaining real-device interaction gaps.

- **Server tests:** 71 final Catalog/filter/search/replica/refresh tests passed in 4.669 seconds in an isolated remote stage, using the existing production venv and live dependency modules. No production configuration, database or startup was loaded by those tests.
- **Deployment:** only `mobile_catalog.py`, `mobile_catalog_query.py` and `mobile_catalog_replica.py` were replaced after baseline/candidate SHA-256 verification. Rollback source copies and a SQLite online main-database backup (`quick_check=ok`) remain at `/home/linuxuser/lakomics-catalog-release-20260920/rollback-064`. Existing thumbnail code and `app.py` stayed unchanged; dimensions were not deployed. The API and existing HTTPS local proxy ended active/running with `NRestarts=0`.
- **Read-only live acceptance:** public tailnet HTTPS health/status returned 200 and advertised `displayPreferencesVersion:1`. Legacy browsing and pre-deployment cursors/detail contexts still worked. Empty categories returned zero items/count; multiple categories plus avoidance tags supported list/count/pagination/detail/editions. Empty-category detail access returned 404; unauthenticated status returned 401. A real artist query returned identical nonempty results for underscore and space spellings. Representative filtered pages took 2.0–2.2 seconds, count about 1.0 second and alias searches about 1.0 second; no sustained capacity claim follows. Publication `ba0e4c2bc7558bee67db0b386a0cfc90108ea5437c39e83510124e76629a1795`, its policy revision and publication count remained unchanged by these checks. No refresh, catalog backfill or production-library write was performed.
- **APK:** 0.6.4 (20), 1,246,628 bytes, SHA-256 `79619ce24f82f6fceca652b96f9402a7720d507d3117ef617a0aeccc4fc53279`. Mobile TypeScript/Vite and native release build passed, including existing native regression checks; alignment and v2/v3 signatures matched the existing installation identity. Settings version checks passed 8 tests.
- **Galaxy Tab S11:** target `SM-X730` was verified, in-place `adb install -r` succeeded, package metadata confirmed 0.6.4 (20), and `am start -W` reported `Status: ok` with the process alive afterward. No uninstall, data/cache reset or credential replacement occurred. Another app was foregrounded during subsequent inspection, so no further UI manipulation was attempted. This confirms installation/startup only, not the new portrait controls' visual/touch acceptance or end-to-end authenticated browsing.
- **Still open:** tablet acceptance of the Catalog dialog/search, nested sidebar controls, Settings and Collection/Viewer polish; the separately tracked dimensions, duplicate-check, video/GIF, 3D and classification-capacity work. No Git commit/push was performed for this bundle.

### 2026-09-20 icon cleanup delivered as 0.6.5

Following device feedback, Catalog settings uses a funnel instead of the global settings sliders. The Album heading's decorative folder icon and the expand-all folder control are removed; individual expansion, collapse-all and current-path expansion remain. App/Albums/Catalog tests passed 71 cases, and Settings passed 8 cases after the version bump. TypeScript/Vite and native APK build/checks passed, including alignment and existing-signer v2/v3 verification. APK SHA-256: `eddedb3266781d6dfed7ad46fd3774dccae9e1d099732124207e7e68b357d03e`. Authorized in-place installation on Galaxy Tab S11 succeeded; installed version 0.6.5 (21) and cold startup `Status: ok` were verified without uninstall or data reset. Visual/touch acceptance remains separate. No additional server deployment or Git write occurred.

### 2026-09-19 implementation and investigation checkpoint

- **Thumbnail refresh:** reproduced a client-side failure in both Home and Gallery: a mounted asset initially marked `thumbnail_available:false` did not reload when fresh metadata changed that flag to `true`. Both effects now observe availability/pending transitions; two regression cases failed before the fix and passed afterward, with pause behavior retained. This client regression is separate from the live publication failure confirmed below; fixing refresh cannot supply an unregistered thumbnail. No queue repair, retry expansion or full backfill was run.
- **Affected-asset investigation (`x.com/hbd_bday/status/2101294431509057626/photo/1`):** after user-assisted SSH authentication, read-only inspection of the service-configured server database confirmed capture `70a9b791-5688-44da-bd9a-8090f1a6784b` was promoted at `2026-09-19T13:45:17.738847+00:00` to Asset `0846fbe5-7578-5562-9195-88dd93342926`. The Asset is normal and committed, retains the capture inbox original key, and has `thumbnail_key=NULL`. The live `/v1/library/media-tickets` response independently returned thumbnail `ok:false,error:unavailable` and original `ok:true,content_type:image/jpeg,size_bytes:723518`; signed URLs and credentials were not printed. Deployed `asset_authority.promote_capture` inserts new Assets without thumbnail metadata, confirming the affected ingestion path. PC source tracing shows local image thumbnails can be generated during authority materialization, but server-owned Assets are excluded from legacy outbound upserts. Thus this case has a server-side thumbnail publication gap, not merely stale mobile rendering; physical absence of all possible orphan thumbnail objects was not audited. The running Linux desktop holds its library lock under `before-linux-backup/New_lakomics_assets`; its data was not queried and local materialization for this Asset remains unverified. At that read-only investigation checkpoint no production writes, cache reset, queue reconciliation or backfill were performed. The user subsequently authorized deployment and recent missing-image-thumbnail repair, recorded below.
- **Portrait UI:** Character and Group sidebar icons are distinct; the selection fill is confined to the folder button, outside the expander/hierarchy line. Portrait Character cards use a 3:4 contain frame. Direct Character entry now returns to the previous committed browsing context/scroll instead of the synthetic Series overview, while in-browser drill-down retains parent navigation. Entry-state timing and filter-only Back regressions are covered.
- **Viewer:** compact information dialog shows available creator name/handle, source, source publication date, collection date, dimensions, duration, format and size. Publication date is not inferred from storage dates. Explicit text-copy actions use a bounded Android clipboard bridge that acknowledges the actual write; no clipboard read or file copy is added. Back/Escape closes information before the Viewer; failures have separate feedback.
- **Dimensions:** confirmed that general Asset replication omitted local width/height/duration and that server projections returned null. Added optional strict integer fields, nullable additive columns, legacy-omission preservation and mobile projection reads. Existing rows remain unknown until a separately authorized metadata update. No production migration, deployment or publication was performed.
- **Catalog category selector:** reuses the PC's category IDs/labels. The selector is independent of the user's search expression and composes a parenthesized expression through the existing `text` API; no unknown query parameter or new write authority. Typed advanced expressions are not rewritten.
- **Refresh cadence, source evidence:** PC upstream collection defaults to 3,600 seconds while the PC app is open; the actual configured library interval was not read. Server refresh is request-driven, not periodic, and accepted work can finish with PC/mobile closed. Foreground mobile checks publication changes every five seconds; this is not upstream collection. Refresh-job status uses two seconds while active and thirty seconds while idle. No schedule was changed.
- **Hidden tags and duplicates remain open:** the server applies published visibility policy, but Android has no policy-write allowlist/replica contract. Shared editing must account for PC publication overwrites; no ad-hoc whole-policy write was opened. New Catalog duplicate candidate generation currently runs in PC-local Rust over the Catalog database. Published grouping remains readable with PC off, but there is no mobile review/candidate API. This is distinct from general Asset similarity scanning.

Verification: full mobile suite passed 251 tests with two workers; after the final filter-only Back correction and information-dialog accessibility adjustment, 91 affected tests passed. Mobile TypeScript/Vite build passed. Browser fixtures covered 800x1280 and 390x844 portrait plus a 1280x800 landscape preservation check: 18 states, zero page horizontal overflow/runtime exceptions; these are not device acceptance. Android native policy/cache/replica checks, including eight clipboard-policy checks, and APK v2/v3 signing passed. Rust cloud coverage passed 134 tests (one ignored), including the dimension payload test. The Python API suite could not import because this host lacks `botocore` (and the server runtime dependencies); syntax checks passed, not API acceptance. Some Viewer tests retain React `act(...)` warnings.

Device delivery: built `android/build/lakomics-mobile-0.6.3-release.apk` with the existing signing identity (version unchanged), SHA-256 `8f80189d0d830d696a70890c29f75556f9d6fd477fef7e667b7027676c8f51a6`. Installed in place on the Galaxy Tab S11 (`SM-X730`) without uninstalling or clearing data; activity cold-start returned `Status: ok`. Installation/startup is not touch, clipboard, or live-thumbnail acceptance.

### Server image-thumbnail deployment and repair

The user authorized applying server image generation and initially repairing the latest 16 images, then expanded repair to all recent images missing thumbnails. Deployed only the thumbnail startup/shutdown hooks, `r2.py`'s bounded background client, `image_thumbnails.py`, `image_thumbnail_encode.py`, and the pinned Pillow 12.3.0 requirement. Existing local dimension/schema changes were excluded from the deployed artifact and remain undeployed. The previous runtime sources matched repository HEAD before patching; rollback code and a consistent read-only SQLite backup were retained privately on the server before restart.

New promoted image Assets enqueue durably in their creation transaction. A single lock-protected worker generates static JPEG/PNG/WebP thumbnails without a PC, with bounded downloads, child CPU/memory/time/pixel limits, safe retries, and visibility/digest-checked publication. No original is replaced, no lifecycle revision is changed, and no historical scan runs at startup. GIF/video and animated image formats are outside this worker's scope.

Verification: 313 targeted tests passed in an isolated release directory using the server Python environment, synthetic databases and fake storage (`test_image_thumbnails`, `test_image_thumbnail_api`, `test_capture_api`, `test_asset_authority`, `test_mobile_library_api`, and the deployed-baseline replication tests plus startup cleanup). These checks exercise real child encoding, promotion-to-mobile API delivery, queue/retry/visibility limits and lifecycle shutdown. A pre-existing httpx/Starlette deprecation warning remains. Review caught and corrected unsafe threaded `preexec_fn`, pre-decode pixel checking, alpha handling and worker restart semantics; controller verification also corrected thread-unsafe/timing-dependent test code and missing fixture shutdown.

During preparation two new images arrived, so the repair selection was rechecked and frozen at execution rather than silently changing an already-written batch. The latest 16 missing images completed; the expanded request added the one remaining recent missing image. All 17 jobs finished on their first attempt. Live verification returned 34 successful original/thumbnail tickets and downloaded/decoded all 17 WebP thumbnails (584,732 bytes total). The reported `hbd_bday` Asset now serves a 410x512, 44,688-byte WebP thumbnail. Original object keys, digests, sizes, media types and canonical authority-row fingerprints remained unchanged for all 17. At the final audit there were zero visible committed image Assets with `thumbnail_key=NULL`. This is not an audit of every pre-existing thumbnail object's storage health.

The API restarted successfully, health returned HTTP 200 and the worker lock was held; final service memory accounting was approximately 98 MiB (not a peak-load measurement). No full Cloud backfill, catalog/dimension deployment, mobile cache reset or APK rebuild was performed. The user subsequently confirmed that the repaired thumbnails are visible on Galaxy Tab. This accepts post-repair device rendering; future live capture with the PC off remains separate from verified server delivery and synthetic automatic-enqueue tests.

Remaining acceptance: verify a new live capture with the PC off; verify real tablet copy, nested Back, icons, framing and category filtering. Server dimension API execution and rollout, and any existing-row metadata update, are separate gates. Browser fixtures and successful packaging do not prove live synchronization.

# Character classification

The character UI/management workflow is accepted for the current product scope and archived. Two current concerns remain: **accuracy** and **visibility while a batch is still classifying**.

## CHAR-AUTO-001 — Character classification accuracy calibration

Status: `PARTIAL`

Incremental classification, quiet workflow, explicit references, support=6 automatic confirmation, and user-driven historical refresh are already implemented and in daily use.

Current remaining scope:

- collect representative false-positive / false-negative examples from normal use;
- measure per-character and same-series confusion rather than changing global thresholds from anecdotes;
- evaluate reference quality/count and arbitration behavior against a holdout set;
- preserve conservative automatic confirmation and manual recovery;
- only pursue CPU/GPU/performance work if it is separately shown to affect normal interaction.

2026-09-14 stage 1: a read-only frozen evidence evaluator is implemented in
`_tools/app/character-runtime/character_holdout.py`. It preserves pre-feedback
predictions and explicit labels, screens content/PDQ/reference leakage, and reports
per-character/series metrics. This is historical evidence replay; real-library
accuracy and candidate model/crop evaluation remain separate work. Usage and limits:
[HOLDOUT.md](../../_tools/app/character-runtime/HOLDOUT.md).

Do not restart the old routine review inbox/global-progress UX. Do not initiate a full production backfill as an accuracy experiment.

## CHAR-AUTO-006 — Show ingested assets before batch character classification finishes

Status: `VERIFY`

User-visible problem (2026-09-13): when many images arrive together, they can remain absent from normal browsing until character classification for the batch finishes.

Desired contract:
- successful ingestion shows each normal asset in its ordinary series/folder gallery immediately;
- character analysis runs in the background and must not gate base-gallery publication;
- character-folder membership appears progressively as results commit;
- a slow or failed character job never hides an otherwise-valid ingested asset.

Implemented 2026-09-14: ordinary/series galleries coalesce same-scope refreshes
instead of discarding every in-flight read. Each completed read can publish while
classification continues; navigation and explicit mutations still invalidate old work.
Cloud capture ingestion now sends a native channel update after each local commit,
before acknowledgement and later downloads. Closed/stale UI listeners do not fail
an import or populate another library.

Regression coverage includes slow overlapping gallery reads, an app-level multi-file
import, a held/failed native character claim, and a fake-server assertion that local
publication precedes a failed ACK. Remaining acceptance is the real desktop browsing
experience on the user's library and native Windows verification.

## CHAR-AUTO-003 — Cluster-based character candidate research

Status: `HOLD`

Keep clustering/re-identification research deferred while explicit-reference classification remains usable. Reopen only if real-world accuracy evidence shows it solves a recurring gap better than reference/arbitration tuning.

# Similarity / media identity

## SIMILARITY-004 — Existing-library similarity discovery

Status: `TODO`

Current gap confirmed 2026-09-13: `index_missing_similarity_hashes()` backfills PDQ for existing normal image/GIF assets, making them candidates for future ingestion, but it does not compare already-stored assets against one another or create historical `similarity_reviews`.

Goal:
- add an explicit bounded `기존 보관함 유사 이미지 찾기` operation;
- reuse current PDQ quality/aspect/distance policy and the existing Similarity Review UI;
- discover historical pairs without forcing fingerprint reindex;
- skip already reviewed/decided pairs and remain idempotent across retry/restart;
- run in resumable batches without blocking normal browsing or ingestion;
- keep originals unchanged until the user makes an existing explicit similarity decision.

Acceptance: two pre-existing near-duplicates produce exactly one review; rerun/restart does not duplicate it; unrelated or incompatible candidates stay excluded. Measure the current ~8k–10k scale before considering a metric index.

## SIMILARITY-002B — PDQ geometric-invariance candidates

Status: `TODO`

After historical discovery is useful, evaluate mirror/flip and 90/180/270-degree transformed reposts. Prefer query-time transform candidates over unconditional full reindex, preserve the existing PDQ final gate, and benchmark false positives on real artwork before enabling by default.

## SIMILARITY-003 — Similar-video fingerprinting and review

Status: `PARTIAL` — implementation exists; verification is deferred because representative duplicate/variant videos have not naturally appeared yet.

Do not redesign the architecture without evidence. When suitable samples exist, validate re-encode/resolution positives plus trim/crop/watermark hard cases in the existing Similarity Review surface. Audio remains optional.

Reference: [video similarity execution record](../research/video-similarity-execution-plan-20260908.md).

## PERF-SIMILARITY — Metric index / BK-tree gate

Status: `HOLD`

Linear PDQ candidate scanning remains the default. Reopen only if historical discovery or representative 100k+/250k+ measurements show it is a material bottleneck.

# Works / Collections

## WORKS-001 — Film / TV Works polish

Status: `PARTIAL`

The Film/TV foundation is already implemented: TMDB Film/Series identity, posters/backdrops, season/episode structure, season posters and cached details exist. Do not restart that foundation.

Current remaining scope is deliberately small and Film-focused:
- clearer cast/director presentation;
- useful release-history / release-info presentation;
- related/connected works rail where provider semantics are trustworthy;
- keep provider scores visually secondary to personal state.

TV/anime season and episode structure is sufficient for now unless new concrete friction is reported.

## LONG-001 — AV metadata/cover acquisition and candidate selection

Status: `PARTIAL`

Current manual AV Collection, people/roles, front/spine/back surfaces, and focused viewing remain usable. The remaining inconvenience is acquisition, especially manual number entry and manual cover setup.

Future direction:
1. one or more external sources fetch metadata and cover candidates;
2. Lakomics presents those candidates separately from acquisition;
3. the user explicitly chooses which candidate becomes front / spine / back, or rejects all;
4. provider refresh never silently overwrites manual choices;
5. fetching and applying stay separate so a source can be replaced without redesigning the chooser.

Do not couple this to Private Vault or create a second Collection artwork lifecycle.

# Catalog / optional providers

## CATALOG-002B — Optional Heliotrope coexistence

Status: `TODO` — low priority / optional.

Keep VCK/kHentai as the default provider. If Heliotrope is revisited, isolate its cache and never assume metadata availability implies a valid page resolver. Provider disable/cache clear must preserve bookmarks/progress.

# Desktop verification / low-priority exploration

## STATS-001 — Personal statistics

Status: `PARTIAL`

Inventory and recorded-era activity statistics are implemented. Remaining work is targeted native acceptance/metric-definition cleanup only; do not infer historical activity from file timestamps.

## ARTIST-001 — Replace Revisit tab with an Artist hub

Status: `TODO` — low priority / product direction.

The current Revisit tab is rarely used. Prefer replacing that top-level destination with an `작가` hub rather than adding another navigation item. Preserve useful rediscovery behavior by folding it into the artist experience instead of keeping Revisit as a separate destination.

Initial direction:
- artist landing view: recently collected artists, most-collected artists, and long-unseen artists;
- artist home: representative images, library asset count, first/recent collected dates, frequently associated works/series and characters;
- same-artist continuous browsing / artist radio using existing library data;
- later, evaluate style-nearby artists using existing CLIP/embedding infrastructure without making similarity metadata mandatory;
- avoid new required manual metadata where existing artist/source information can be reused.

This is primarily a browsing/rediscovery surface, not a new organization workflow. Reuse any valuable Revisit logic as `오랜만에 보는 작가`, `오늘의 작가`, or similar modules inside the artist hub.

## IDEA-002 — Asset date timeline exploration

Status: `HOLD`

Keep the timeline idea deferred until there is a concrete browsing need beyond the current date-grouped library and Revisit flows.

# Optional AI / development tooling experiments

## AI-JEV-001 — Jev decision-model evaluation

Status: `HOLD` — invite/API access gated; evaluate before integration.

Evaluate TypeSafe Jev as an optional **decision/arbitration layer**, not as a replacement for Lakomics' local vision pipeline. The first useful experiment is `CHAR-AUTO-001`: feed existing detector/CCIP candidate evidence into a small typed `accept / review / reject` decision and compare it against the current deterministic baseline on representative holdout mistakes. If that is useful, later evaluate similarity relation labeling and ingest routing. Preserve manual decisions and conservative deterministic gates; never delegate server authority/revision/outbox logic, destructive deletion, or other correctness invariants to Jev. Do not add a production dependency until invite access exists and measured accuracy/calibration provides a concrete benefit.

## DEV-ZED-001 — Zed IDE workflow evaluation

Status: `HOLD` — optional developer-experience experiment.

Evaluate Zed on the Linux Lakomics checkout only as an editor/agent workflow improvement: fast native editing, integrated diff/terminal, and ACP-hosted agents such as Codex may reduce context switching. Treat Codex-in-Zed as the same Codex resource budget, **not** a way to bypass or reduce Codex quota. Keep Zed entirely optional: no repository/runtime dependency, toolchain migration, or workflow lock-in is justified unless a hands-on trial is clearly better than the current setup.

# Extension follow-up

## EXT-011 — 반원 수집 메뉴와 PC 브라우저 연결

Status: `VERIFY`

Implementation exists. Keep only real-browser/Titanium/PC integration acceptance for the current menu direction; do not revive older radial/list-only designs.

## EXT-012 — X 번역 단순화·공유 게시물 저장·PC 임시저장

Status: `VERIFY`

Implementation exists. Remaining scope is targeted real X/Titanium/Galaxy acceptance and concrete regressions only.

# Current execution order

This is guidance, not authorization to start or mutate production data.

1. `CLOUD-POST-001` continue post-authority PC/Android simplification beyond the proven bookmark slice.
2. `MEDIA-R2-001` add fitting immutable derived-media variants while R2 capacity is available.
3. `CHAR-AUTO-001` measured accuracy calibration.
4. `SIMILARITY-004` existing-library discovery.
5. `WORKS-001` small Film polish.
6. `LONG-001` AV external-source / candidate chooser when AV entry friction is worth tackling.
7. `SIMILARITY-002B` transform matching when useful.

Verification-only items (`CHAR-AUTO-006`, `CLOUD-UI-001`, `EXT-011`, `EXT-012`) may be closed opportunistically when the user naturally exercises them. HOLD items should not be promoted without a new product reason.
