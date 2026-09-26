# Fold idle pollers into `/v1/sync/status` + server long-poll — design (2026-09-26)

Status: proposed (PERF-ALL-001, PC-POLL-002, BIND-POLL-001). Read-only design by an Opus planner at `a1cb720`; line numbers refer to that commit.

## 0. Findings
- Status route: sync `def` at `server/lakomics-api/sync_status.py:48-71`, per-principal `exchange` block (`:57-59,69-70`), ETag from body (`conditional.py:46-53`); `require_client` returns only a principal id (`api_auth.py:88-100`).
- Every polled log route is publisher-only and read with the PC publisher token; each log has a cheap singleton head: character exclusions `mobile_character_exclusion_state.last_sequence`; review decisions `mobile_character_review_state.last_sequence`; similarity `mobile_similarity_review_state.last_sequence`; catalog duplicates `catalog_duplicate_state.decision_sequence`; release reads `collection_release_state.read_sequence` (+`pruned_through`); bindings `collection_binding_state.sequence`, `logEpoch`, oldest pending; personal edits `mobile_collection_edit_state.last_sequence`; captures: pending count + `MAX(rowid)` (ids are UUID4).
- Bookmarks: PC reads `/v1/mobile-catalog/status` every pass (`authority_pass.rs:315`) though the same `catalog-bookmarks` authority row is already in `/v1/sync/status`.
- `get_db()` (`app.py:50-58`) sees every write that goes through it (bypass: image-thumbnail worker, catalog DB files, CLI tools).
- One uvicorn process on 1 vCPU: a sync long-poll would hold an AnyIO threadpool slot → handler must be `async`.
- Proxy: Tailscale Serve :8443 → socat `lakomics-local-proxy` → uvicorn; socat `-T` and Serve timeouts unverified.
- Client timeouts: PC `CloudClient` 30 s, PC exchange agent 120 s, tablet `setReadTimeout(20000)`.
- Tablet trap: `SyncStatusPass.libraryStatus` strips only `exchange`; any other body change triggers a full Picker walk.
- `NetworkPolicy.api` strips the query, so `?wait=…&signals=1` is already allowed on the tablet.
- ADR-0037 allows an aggregate wake as an optimization only; per-domain cursors stay the contract; nothing new may enter `domains[]` (strict `SyncStatus::is_consistent` / restore guard).

## 1. Server payload (S1, additive, protocolVersion stays 1)
1. `api_auth.principal_role(db, principal)`.
2. `publisherLogs` block only for role `publisher`, from per-module `status_head(db)` injected like `exchange_status`: characterExclusions, characterReviewDecisions, similarityDecisions, catalogDuplicateDecisions, releaseReads{last,prunedThrough}, bindings{logEpoch,last,oldestPending}, personalEdits, captures{pending,latest}.
3. `signals` block only with `?signals=1` (any client principal): listGeneration, characters, collections (+personalEditCursor), releases, catalog, bindingRequests, optional notes. Opt-in keeps deployed tablet builds byte-identical.
4. Golden test: legacy/client/device tokens without `signals` → byte-identical body and ETag.

## 2. Server long-poll (S2)
- `change_signal.py` `WriteSignal`: generation under a lock + `(loop, future)` waiters; `bump()` thread-safe via `call_soon_threadsafe`; `wait_beyond(gen, timeout)` returns at once if already moved.
- Bump in `get_db()` `finally` when `conn.total_changes > 0` (hint only).
- `async def` handler; auth/compute via `run_in_threadpool`; `wait` clamped 0..50 s, honoured only when `If-None-Match` matches; loop: compute → differ → 200, else wait (15 s recheck) + 100 ms debounce; 304 at deadline. A change invisible to this principal keeps waiting.
- Memo `(generation, principal, role, signals)` → `(body, etag)`.
- Disconnect detection; deregister in `finally`; caps 64 total / 4 per principal.
- `Lakomics-Status-Wait: <MAX_WAIT>` header on every status response (capability detection).
- **[VPS, needs approval]** `--timeout-graceful-shutdown 5`; confirm single worker, no `--limit-concurrency`, socat `-T`, Serve timeouts.

## 3. Desktop
D1 fold (works against S1, falls back on older servers):
- `SyncStatus` gains lenient `publisher_logs: Option<LogHeads>`; domain validation unchanged.
- Status read with the publisher token when configured (401 → fall back to client token, invalidate `CloudPublisher`).
- New `cloud/status_watch.rs` hub with one `log_due(kind, local_cursor, last_checked, now)` helper: head moved past cursor OR 30 min safety; no trusted head → today's 60 s.
- Lanes gated: exclusions (`auto_publication.rs:198-221`), review (`character_review_sync.rs:247-266`), similarity (`similarity_review_sync.rs:302-321`), collections status + personal edits (`collection_personal_edits.rs:365-402`), duplicates (`catalog_duplicate_sync.rs:795-825`), release reads (`collection_release_sync.rs:196`), bindings (`collection_binding_sync.rs:51,379`).
- Bookmark authority from the status document instead of `/v1/mobile-catalog/status`.
- Captures: hub emits `cloud://captures-pending`; `useCloudCaptureSync.ts` polls on event, 15 min fallback; drop the second full-list read (`captures.rs:373-376`).
- `PUBLICATION_WAKE` flag so the 1 s loop (`workload.rs:525-535`) dispatches lanes immediately.
D2 long-poll:
- Watcher thread (pure `WatchState`), `GET /v1/sync/status?wait=50`, own agent with recv timeout wait+20 s; 200 → hub + wakes; 304 → re-issue with jitter; errors 5/15/60 s; no header → dormant, re-probe every 30 min; hot-loop guard.
- Authority pass uses hub status; idle delay 300 s while the watcher is live (failures keep 5→60 s).
- Exchange receiver sends `?wait=50` when the header is present (separate device principal; stays a second held connection).

## 4. Tablet (T1)
- Native `StatusWatcher.java` owned by `AlbumReplicaService`, only while an activity is resumed (`ForegroundSchedule.start/stop`); `onPause` disconnects.
- `?wait=50&signals=1`, new `CloudClient.longPollStatus` with wait+20 s read timeout, own ETag.
- Library change → `schedule.wake()`; exchange → `ExchangeService.observeStatus`; signals → `emit("lakomics-sync-signals")`.
- Trap fix: `libraryStatus` also strips `signals` and `publisherLogs`.
- `refreshListGeneration` uses `signals.listGeneration`; `usePublicationCheck.ts`, `CollectionBindings.tsx:61`, `Notes.tsx:119` react to signals; intervals become 10 min fallbacks; exchange screen's 5 s poll unneeded while live.

## 5. Rollout
1. S1+S2 server (golden-ETag gate) → **[VPS deploy, needs approval]**.
2. D1+D2 desktop release (falls back on older servers).
3. T1 tablet build.
4. ADR-0037 checkpoint; update PC-POLL-002 / BIND-POLL-001.

## 6. Gates
- Server: role matrix, opt-in signals, golden ETag, each head moves on its command, `WriteSignal` lost-wakeup test, async waiter release < 250 ms, publisher-only write does not release a client waiter, disconnect deregisters, cap, 20 waiters use 0 threadpool slots.
- Desktop (fake server + clock): G1 idle 15 min ≤ 25 requests (≤ 45 with exchange token), log-route GETs 0, mobile-catalog status 0; G2 bind pickup ≤ 2 s with long-poll, ≤ 61 s against older server; parse leniency; publisher 401 fallback; watcher dormant/hot-loop; exchange ≤ 19 per 15 min; captures vitest 0 polls/15 min with signals.
- Tablet: `libraryStatus` ignores new blocks; watcher foreground-only; NetworkPolicy allows the query and still refuses publisher logs; Collections idle hour 120 → ≤ 12; list-generation 0/h.

## 7. Estimates
PC per 15 idle min: today 185–245 (+180 with exchange token) → D1 20–35 → D1+D2 ~22–26 (~40–44 with exchange token). Tablet per foreground hour: Home 180→~78, Collections/Catalog 240→~84, exchange screen 1,440→~72. Latency: bind pickup 0–70 s → ~1–2 s (end-to-end still +30 s publication debounce); captures and tablet↔PC changes 5–60 s → ~1 s.

## 8. Risks
Tablet trap (role gating + opt-in + golden ETag); restore-guard strictness; missed/spurious wakes (15 s recheck, client safety intervals); multi-worker future degrades to 15 s; proxy/NAT idle cuts < 50 s (adaptive wait); restart stall without graceful-shutdown timeout; publisher-token failure (fallbacks); per-lane head semantics (epoch/prune fields); watcher lifecycle on library switch/cloud disable/pause; long-held `ureq` requests across laptop sleep and Tailscale/socat behavior unverified.
