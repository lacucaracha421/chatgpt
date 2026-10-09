# Server-owned manga new-volume checks (SERVER-INDEP-001)

Status: proposal, 2026-10-09; user decision the same day: check each work once a day (read-only survey at `69805f82`; Plan subagent, reviewed by the controller). Open product questions in §5 await the user.

## 1. Today

- Only **MangaDex and Kakao** are checked automatically, by a PC frontend hook (`_tools/app/src/app/useReleaseWatchCheck.ts`: at start, then hourly; skipped in 절약 모드), so nothing runs while the PC app is closed. **Aladin is manual** (key only on the PC; the server has none).
- Loop `src-tauri/src/library/collection_updates.rs`: every bound manga work whose binding `last_synced_at` is ≥ 1 day old (subscriptions only gate events); batches of 8 works / 15 s; per-work errors defer 24 h; transport/quota errors back off provider-wide (5 s, 30 s, 2 min, 10 min; 429: 1/2/5/15 min; `Retry-After` ≤ 24 h; auth 1 h).
- Kakao refresh: `aladin_flow.rs` `refresh_aladin` → `refind_group` → `reconcile_aladin_at` (config v1/v2, snapshot, volume merge, dismissal carry-over, events via `release_watch::pending_release_changes` gated by subscription, Kakao ownership tracking and volume range). MangaDex: `mangadex_flow.rs` + `reconcile_mangadex_volumes` with a monotonic local seen-volume baseline.
- With the Collections authority active the PC sends ordinary commands (`upsertVolumeSource`, `upsertVolume`, `bindProvider`, `applyProviderSnapshot`, `recordReleaseEvent` with random event ids).
- Worker state (`collection_update_status`, `collection_update_attempts`, subscription `last_checked_at`, MangaDex seen sets) is PC-local by the batch 4 contract.
- Tablet 신간: `GET /v1/collections/releases` from the server release store, which `recordReleaseEvent` writes directly. No OS notifications exist.

## 2. Server pieces already present

Kakao key and crawler (`collection_bindings.py` `search_kakao_items`, 50×50 pages, one 60 s deadline, punctuation retry), Kakao parsing/grouping pinned to the PC by `src-tauri/src/library/fixtures/kakao_grouping.json` and `product_titles.json`; in-process `apply_command` / `apply_command_batch`; the fetch-outside-lock then CAS-under-`BEGIN IMMEDIATE` pattern (`work_providers.apply_provider`); daemon worker lifecycle (`av_inbox.Worker`, `app_lifecycle`); server-side MangaDex merge parity (`9d55123e`). Missing: the refresh half of the Kakao rules, MangaDex detail/cover parsing and slot rules, worker state, a feature flag. `kakao_item` lacks `itemUrl` and the raw document needed for source parity.

## 3. Design

- **Worker:** `collection_release_checks.py`, one daemon thread, env kill switch `LAKOMICS_RELEASE_CHECKS` (default off), runs only while the authority is active. Each (work, provider) at most once per 24 h; wakes every 10 min or on demand; ≤ 4 works or 90 s per wake; one request at a time; background Kakao pages capped at 120 of the shared 300 pages/min; MangaDex spacing as today. Backoff table ported exactly. State in plain server tables `collection_release_check_state` and `collection_release_check_status`.
- **Writes are authority commands from an in-process server principal:** read-only preflight → fetch without locks → under `BEGIN IMMEDIATE` reload the binding (abort on revision/digest change), run the ported reconcile, apply one `apply_command_batch` with deterministic ids (batch per work/provider/day; events `uuid5(work, provider, kind, volume, prev, curr)`), so replays and duplicate runs change nothing.
- **Event gating** identical to the PC, from server state (`derived.releaseWatch`, `ownedVolumes` for Kakao, `volumeRange`; first `last_checked_at` seeded from the binding).
- **Conflicts:** PC commands carry expected revisions and already handle conflicts / stale snapshots. Old PCs may still check locally; add content de-duplication to `_record_release` (same work/provider/kind/volume/prev/curr within 30 days → unchanged receipt).
- **Visibility:** existing long-poll + change feed carry results to PC and tablet unchanged. New `GET /v1/collections/release-checks/status` and `POST /v1/collections/release-checks/run` (client role, rate-limited) power 새로고침 on PC and tablet.
- **Parity:** Python port of refind/config/snapshot/merge/event rules pinned by a new shared fixture `fixtures/kakao_refresh.json` read by Rust and Python; MangaDex later with `mangadex_refresh.json`. MangaDex baseline seeded from all server `source_provider='mangadex'` volume rows incl. deleted ones.
- **Handover:** server advertises `serverReleaseChecks:kakao` (later `:mangadex`); a PC build seeing it skips local checks in Rust and routes 새로고침 to the server; the per-work refresh in the overlay stays local. Rollback = unset env + restart (PC resumes; one catch-up pass).

## 4. Slices

| # | Deliverable | Size / risk | Deploy |
|---|---|---|---|
| 1 | Dormant server Kakao checker: reconcile port, `kakao_item` fields, state tables, worker (env off), status/run routes, `_record_release` content de-dup, `kakao_refresh.json` | M / medium | yes |
| 2 | PC handover (Rust gate, 새로고침 via server, optional tablet button), then activate Kakao and watch one day | S-M / low-medium | env flip |
| 3 | MangaDex on the server (parser, slots, seen-set seeding, values), `mangadex_refresh.json` | M-L / medium-high | yes |
| 4 (optional) | Server-side MangaDex volume covers through the artwork pipeline | M / medium | yes |

## 5. Open product questions (recommended defaults)

1. Cadence: **decided (user 2026-10-09): once a day per work**, spread over the day.
2. Providers: Kakao and MangaDex on the server; Aladin stays a manual PC refresh; no Aladin key on the server.
3. 새로고침 on PC and tablet asks the server; the single-work overlay refresh stays on the PC.
4. Keep "Kakao alerts only for works with owned-volume tracking".
5. Accept at most one spurious MangaDex "new volume" per slot the PC had seen outside the range at switch-over.
6. Background share of Kakao pages: 120 of 300 per minute.

## 6. Not confirmed

Kakao's real daily quota; the number of MangaDex-bound works and production page counts; live server env; whether duplicates already exist in the production release store.

## 7. Related: the release calendar

The game/movie/anime release calendar (IGDB, TMDB) is also PC-owned today: `release_calendar.rs` refreshes it at most once per 24 h (`REFRESH_INTERVAL_HOURS`) from the same PC hook and publishes a snapshot to `home_upcoming.py`, which never fetches by itself. The server already holds the TMDB/IGDB keys (`providers.conf`, slice 2 relay in `work_providers.py`), so moving it is the backlog's last SERVER-INDEP item and can reuse this worker.

## 8. Review notes (2026-10-09) that gate slice 2

- The PC does NOT yet recover from a second writer: a `revisionConflict` on queued `bindProvider`, `upsertVolumeSource` or `upsertVolume` marks the outbox row `blocked` and stops all PC Collections sync (`collection_authority.rs` ~3426-3432); only `applyProviderSnapshot` + `providerSnapshotStale` is adopted and retried. Before the switch is turned on, slice 2 must make these provider commands adopt the current entity, drop the row and refetch once (like `providerSnapshotStale`), and route the overlay's per-work Kakao refresh to the server or make it conflict-safe.
- Slice 1 was changed after review: content de-dup keys on the latest event per (work, provider, kind, volume) so real flips survive; no snapshot/bind write when nothing changed (no daily churn); the feature is advertised only with the switch on, a server Kakao key and a live worker; previous-check time is `max(state, binding.last_synced_at)`; faster wake while works remain due.
