# Server Authority v2 — product decisions and migration inputs

Status: product decisions / current-state audit input, **not yet an implementation plan**.

Date: 2026-09-15. Current checkout: `/home/laku/chatgpt`.

This record captures the product decisions made after the catalog-bookmark server-authority pilot proved bidirectional automatic convergence in production. It also incorporates the 2026-09-15 Android/mobile source audit supplied during the discussion.

Current implementation facts remain owned by source, migrations and APIs. Active work status remains owned by `docs/roadmap/lakomics-backlog.md`. This document does not authorize deployment, production-data writes, Git writes, or a new full Cloud Library backfill.

Related references:
- [staged server authority ADR](../adr/0036-staged-server-authority.md)
- [Server Authority v2 replica/command ADR](../adr/0037-server-authority-v2-replica-and-command-contract.md)
- [2026-09-15 PC publication/recovery audit](server-authority-v2-pc-audit-20260915.md)
- [2026-09-13 server-authority audit](server-authority-model-audit-20260913.md)
- [mobile direction](../agents/mobile.md)
- [living backlog](../roadmap/lakomics-backlog.md)

## 1. Product target confirmed with the user

Lakomics should finish the transition from **PC authority with mobile publication** to **server authority with PC and Android clients**.

The server owns canonical shared state. PC and Android may keep durable local replicas/caches so normal interaction is immediate and temporary disconnection does not block use.

This is still a personal, single-user system. The expected concurrent clients are one main PC and the Android app. Supporting multiple simultaneously active PC workers is not a primary product requirement, although accidental second-PC use must not corrupt shared state.
## 2. Shared-state boundary

The following are intended to converge through server authority and be editable from both PC and Android where the UI exists:
- assets and canonical media identity;
- classifications/folders and hierarchy;
- albums and membership;
- tags and lightweight metadata;
- ratings, favorites and showcase state;
- character manual corrections/confirmations and durable automatic-analysis results;
- Works / Collection user state, including ownership/progress-like personal metadata where retained by the product;
- trash/tombstones and recovery state;
- recent-view history;
- ordinary encrypted notes.

Device presentation stays local: layout, card size, density, expanded UI state and similar per-device preferences must not be synchronized merely because shared content is synchronized.

`비밀` / external-vault data remains PC + USB only. It is excluded from server authority and Android visibility.

Ordinary notes remain end-to-end encrypted from the server's perspective. Pairing a new trusted client should transfer the note decryption key safely so a second password workflow is not required.

Reader/page/video resume position is not a shared domain. The intended product direction is to reopen from the beginning rather than maintain cross-device resume state. Recent-view history is still shared.
## 3. Client behavior and offline contract

Both PC and Android should render their last committed local state immediately on launch, then reconcile with the server in the background. Normal startup must not wait for a full remote refresh.

Both clients should allow ordinary user edits while temporarily offline. A user edit is applied locally immediately, stored durably as pending work, and retried automatically when connectivity returns. A failed send must not roll the visible edit back merely because the server was unavailable.

The practical offline target is roughly one to two days, not weeks of disconnected independent editing. Retention and reconciliation rules should be sized for that product expectation while remaining safe after longer accidental outages.

Pending changes should be visible only as a small passive count/status during normal use. Successful synchronization stays quiet. Important or prolonged failures surface clearly.

Conflict policy is intentionally mixed:
- lightweight personal values such as bookmarks/ratings may reconcile automatically under a deterministic server rule;
- structural or semantically important conflicting edits should surface a choice instead of silently discarding a user's intent;
- explicit user decisions outrank late automatic-analysis results.

PC and Android should normally converge within a few seconds while active. Five-second bookmark polling is an acceptable baseline; push/SSE is optional where it materially improves Android background freshness or reduces waste.
## 4. PC role after server authority

The PC remains the main workstation, but its database is no longer the irreplaceable canonical copy. Shared metadata should be rebuildable from the server. If the local replica becomes inconsistent, Lakomics may preserve unsent intents, rebuild the replica automatically, and notify the user only when safe recovery cannot complete.

A fresh PC install may require server pairing and need not offer a separate "create/select local library" flow. Pairing should use a short one-time code or QR-style enrollment rather than manual long-token entry.

The newly paired PC may automatically become the single main worker for heavy jobs. Heavy automatic work should pause while server connectivity is unavailable, then resume/claim pending work after reconciliation when connectivity returns.

PC-only state remains local, including:
- physical local file paths and current byte presence;
- download/cache state;
- FFmpeg/GPU temporary execution state;
- drag-out/native integration state;
- device UI preferences.

Direct PC file/folder import remains supported, including offline staging. Once connected, staged imports should become canonical server assets through the same identity/deduplication rules as extension ingest.
## 5. Media, cache and storage policy

R2/server storage remains the durable source for canonical media bytes. PC local media is a performance/workstation mirror, not the only surviving copy.

PC behavior:
- newly committed remote originals should download automatically while the main PC is available;
- metadata and thumbnails remain locally available even if an original is later evicted;
- under disk pressure Lakomics may automatically evict old local originals only after verifying durable cloud availability;
- reopening an evicted item may wait a few seconds while the original is fetched again.

Android behavior:
- keep the complete library metadata locally for offline navigation, search and filtering;
- keep a small thumbnail for every library asset locally so offline browsing does not degrade into empty placeholders;
- use roughly 10 GiB as the available budget for viewed/selected larger media, without proactive album/character prefetch for now;
- Picker/DocumentsProvider selection should fetch a missing original transparently when needed.

R2 capacity should be spent on immutable fitting derivatives. The server should be able to produce basic thumbnails/previews and immediately playable video representations without waiting for the PC. Heavy classification/similarity analysis may remain deferred to a capable client worker.
## 6. Ingest, visibility and duplicate policy

The browser extension is the normal collection entry point. PC direct import remains a secondary supported entry point.

Extension collection must work with the PC off. Target flow:
`extension -> server/R2 canonical commit -> immediate PC/Android visibility -> later enrichment`.

If the server is temporarily unavailable, the extension should retain a durable local upload/outbox queue, including media bytes where practical, and retry automatically later. Several GiB of temporary queued collection data is acceptable.

Base asset visibility must not wait for character classification, similarity checks or heavy video analysis. A successfully committed asset appears immediately; enrichment arrives progressively.

Exact duplicate bytes arriving from different ingest routes should resolve to one canonical asset while retaining useful provenance. For confidently equivalent near-duplicates that differ mainly in quality/recompression/resolution, automatic quality selection is desired; the displaced lower-quality candidate goes to the 30-day trash rather than being destroyed immediately. Ambiguous cases remain reviewable.
## 7. Durable jobs and automatic workers

The server should remember pending work and accepted results. The PC is not required to stay on merely so pending work can exist.

When the main PC comes online it should reconcile shared state first, then automatically claim eligible heavy work such as character classification, similarity processing and heavier FFmpeg tasks. A crash or shutdown must leave work resumable rather than requiring manual restart.

Analysis results worth preserving should live on the server so a new PC does not have to recompute the entire library. Results should retain enough version/input identity to reject stale automatic output after a later user edit.

Mobile compute is not prohibited by policy. A heavy task may be tried on the target Android device and kept there if performance, heat and battery behavior are acceptable; otherwise it falls back to the PC worker. The shared job/result contract should not assume that only one platform can ever execute work.

The product expects one automatic main PC worker. Full multi-PC worker scheduling is not a primary requirement, though the server must still prevent a stale or accidental second worker from double-applying results.

## 8. External providers and background server work

Game/manga/film catalog/provider access should move behind the Lakomics server rather than making PC and Android independently call providers. This centralizes provider credentials, caching, retries and normalized results.

The always-on server may refresh release/work metadata while the PC is off. Explicit user overrides always win over provider refreshes; provider updates must never silently replace a user-selected title, cover, metadata choice or other manual state.
## 9. Trash, history, backup and recovery

Global deletion is a server-authoritative trash operation, not immediate byte destruction.

Confirmed policy:
- trash retention: 30 days;
- restore should reconstruct the asset's prior relationships/state, not only resurrect the media bytes;
- purge after the grace period may remove canonical media according to the final storage policy;
- automatically displaced lower-quality duplicates use the same recovery window.

User-visible change history should cover recent history rather than indefinite archival. The current product preference is roughly 30 days of inspectable/reversible history.

Server backup policy should retain approximately the most recent month and copy recoverable server state to both the main PC and another cloud destination. Exact backup format/schedule is a later operational design decision.

A replacement PC should be able to pair with the server, rebuild its local replica, recover preserved analysis results and reconstruct local media opportunistically without treating an old PC SQLite file as the canonical restore source.

## 10. Status, repair and notifications

Normal synchronization should be quiet. Important events may produce both an in-app notification record and an Android system notification. Routine successful background work should not notify.

Important candidates include new releases the user follows, persistent synchronization failure, backup failure and significant server/job failure.

PC Settings should expand the existing cloud/server area into the detailed management surface: connection health, last reconciliation, pending intents/jobs, local media gaps, backup state and recent meaningful errors.

Android needs only a compact health state such as `정상 / 동기화 중 / 문제 있음` plus access to relevant important notifications.

Old directional actions such as `모바일 게시` should eventually disappear for migrated domains. Keep one neutral manual action such as `지금 동기화`, which may also run bounded diagnostics and safe self-repair. Automatic operation remains the normal path.
## 11. 2026-09-15 Android/mobile audit findings

The mobile audit found several independent stores for overlapping state:
- React memory caches for views, Catalog, Character and Collections;
- WebView `localStorage` for bookmark intents/confirmed revisions, catalog refresh state, reader position remnants, density and recent-folder remnants;
- encrypted `notes.sqlite` for the Notes synchronization domain;
- `picker-library.json` as a complete ≤96 MiB full-library metadata snapshot;
- a separate bounded `document-metadata` JSON cache;
- a shared 1 GiB / 7-day native media cache.

The same classification hierarchy is currently represented in multiple independent forms: app state, `PickerLibrary`, `LibraryDocumentsProvider`, and character/index models. Asset metadata likewise exists separately in app/API pages, Picker snapshot rows and document metadata files.

`PickerLibrary` currently obtains a complete library traversal and derives deletions by absence when merging a successful traversal. General library classification/asset reads do not expose an authority revision/change cursor equivalent to the bookmark domain, so there is no robust incremental replica contract yet.

Mobile source still contains explicit `PC -> publish -> mobile` assumptions in Collections, Catalog, CharacterBrowser, ClassificationIndex, App and Settings copy. `characterModel` also validates the legacy `authority:'pc'` / `authorityEpoch:0` envelope, which becomes a deliberate compatibility fence during character authority cutover.
The bookmark pilot is more mature than other mobile write domains, but the Android implementation still exposes two migration issues:
- bookmark durable intent/confirmed state lives in WebView `localStorage`, not the native durable database used by Notes;
- Android has no PC-equivalent always-running bookmark outbox flusher. Pending intent can remain until the relevant Catalog work is selected again.

The current bookmark localStorage keys are also not properly scoped by server/library identity. A connection change can therefore carry an old confirmed revision into a different authority epoch and cause an avoidable conflict/rebase.

The audit identified several likely retirement/consolidation candidates once a durable Android metadata replica exists:
- `PickerLibrary` / `PickerSnapshot` as an independent full-library JSON replica;
- `LibraryDocumentsProvider`'s independent document metadata cache;
- bookmark/refresh pending state in `localStorage`;
- separate publication-check loops where a common change contract becomes available;
- dead recent-folder and reader-position remnants already unused by the current product.

These are migration candidates, not immediate deletion instructions. Existing Picker/DocumentsProvider behavior must remain working until the replacement replica has equivalent native/device evidence.

## 12. Design constraints implied by the audit

A durable Android metadata database should not be implemented as another fifth copy of the library. It should become the shared local source for app browsing/search, offline state, pending intents and Picker/provider metadata where practical.

However, that client-side consolidation depends on a server change contract for the shared library. The current full-page asset/classification APIs are insufficient to prove incremental replica completeness because their cursors are pagination tokens, not authority change cursors.
The current PC source also demonstrates the transitional overlap directly: `LibraryWorkspace` runs legacy `useMobilePublications()` and the newer `useCatalogBookmarkSync()` side by side. The former retries due mobile publications every 10 seconds; the bookmark authority loop performs receive -> durable outbox flush -> optional receive every 5 seconds plus online/focus recovery.

This supports a migration principle: retire old snapshot/publication paths only after their shared domain has an equivalent server-owned baseline/change/write contract. Do not delete publication code merely because the product direction changed.

## 13. Working architecture recommendation — not yet approved as final design

The leading design direction is:

`server canonical state + ordered change/receipt contract`
`<-> PC durable local replica + outbox + workstation-local state`
`<-> Android durable local replica + outbox + bounded media cache`

The proven bookmark concepts — stable operation IDs, desired-state commands, expected revisions, receipts, ordered changes and durable cursors — are the starting pattern. The next design step must decide how much of that becomes a common cross-domain synchronization substrate versus domain-specific contracts sharing conventions.

A common substrate must not erase domain semantics. Character decisions, trash restore, Collection/provider data and simple ratings do not have identical conflict rules merely because they share operation/cursor machinery.

Likewise, server authority does **not** mean all computation moves to the VPS. The server owns canonical state and durable jobs; execution may live on the server, Android or the current main PC depending on cost and capability.

## 14. Items deliberately left for architecture design

The Grill did not fix these implementation choices:
- exact schema and granularity of server authority domains/change streams;
- whether one global cursor or multiple domain cursors are preferable;
- exact automatic conflict rule for lightweight scalar values;
- Android SQLite schema, transaction boundaries and migration strategy;
- server push vs foreground polling/background wake strategy;
- exact thumbnail/preview/video derivative sizes and codecs;
- worker lease duration, retry/backoff and main-PC handoff mechanics;
- 30-day history representation and undo command semantics;
- backup schedule/format and secondary-cloud provider;
- exact short-code/QR pairing protocol and encrypted Notes-key transfer;
- safe migration order for every existing PC publication path.

These must be resolved in the subsequent architecture design before implementation begins.
