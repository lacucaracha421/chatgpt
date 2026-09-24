# Cloud API review and hardening — 2026-09-24

> Status: code review, synthetic measurements and fixes on branch `claude/focused-turing-nj2pbh`.
> No deployment, no production access, no production data. Every number below comes from
> an in-process synthetic dataset; production latency was never measured (the access log
> has no timings). Deployment of these changes needs separate operational authorization.

Scope: `server/lakomics-api/` (FastAPI + SQLite, single-process uvicorn) as instructed by the
review brief. Inputs were the brief's read-only production summary (1 vCPU, 1.6 GB RAM, 52 GB
disk at 82 %, `data/` 17 GB, seven-day request mix and error counts) and the repository at
`bbf8502`. The clone is shallow (history starts at `c9c3528`, 2026-09-23), which limits what
git history can prove.

## 1. Bugs

### 1.1 `PUT /v1/saved-x-media` → 500 ×4, 11 tracebacks in `bound_saved_x_media_snapshot_body`

**Root cause.** `bound_saved_x_media_snapshot_body` was an application-wide
`@app.middleware("http")` (Starlette `BaseHTTPMiddleware`) that wrapped *every* request and,
for the snapshot upload, buffered the entire body with `await request.body()` before checking
its size. When the PC dropped the connection mid-upload, Starlette raised `ClientDisconnect`
out of that `await`; nothing handled it, so uvicorn logged "Exception in ASGI application"
with the middleware frame and wrote a 500. Reproduced in
`tests/test_server_hardening.py::test_disconnect_mid_upload_is_not_a_server_error` by
driving the raw ASGI app with an `http.disconnect` after the first body chunk: before the fix
the application raised `ClientDisconnect` after sending a 500.

Because the middleware wrapped every route, any other unhandled exception on any route also
carried this frame in its traceback. That is why "11 tracebacks all inside
`bound_saved_x_media_snapshot_body`" is consistent with 4 + 3 + a few disconnect-only
tracebacks: the frame name identifies the middleware, not the failing route.

**Fix** (`app.py`).
- The middleware is removed. The upload route streams its body against the 1 MiB cap itself
  (`read_bounded_body`), the same pattern the album/classification/asset command routes
  already use. A declared `Content-Length` over the cap is refused before any byte is read;
  a chunked body is refused on the first chunk that crosses the cap, so at most one chunk
  beyond the cap is ever held. Pydantic validation is applied to the streamed bytes and
  returns the same 422 document FastAPI produces for a declared body parameter.
- A `ClientDisconnect` exception handler answers 400 without a traceback. The status only
  lands in the access log; the peer is gone.
- Side effect: every other request no longer pays for `BaseHTTPMiddleware` (its task group
  and response streaming wrapper), which is the ~0.2 ms drop in the framework floor below.

### 1.2 `GET /v1/sync/status` → 500 ×3

**Diagnosis.** The route only does `BEGIN; SELECT … FROM authority_domains; ROLLBACK` plus
the credential lookup. The one failure that produces a 500 there is
`sqlite3.OperationalError: database is locked`: the control database ran in the default
rollback-journal mode (`PRAGMA journal_mode` → `delete`; nothing in the code ever set WAL),
where a reader must wait for a writer's commit phase and fails once the 5-second default
busy timeout expires. Long writers exist on this server (catalog publication and refresh
materialization, thumbnail job bookkeeping, classification snapshot staging), and at
~16 status polls per minute a handful of collisions per week is the expected rate. The same
mechanism is a plausible contributor to some of the upload 500s (the snapshot `INSERT` waits
on the same lock). The tracebacks themselves were not available to this review, so this is
the strongest inference from the code, not a confirmed stack.

**Fix** (`app.py`).
- `startup()` runs `PRAGMA journal_mode=WAL` once; the mode is persistent in the file. Under
  WAL, readers never block on writers and writers never block on readers.
- `get_db()` opens with an explicit 10-second busy timeout (`DB_BUSY_TIMEOUT_SECONDS`) for the
  remaining writer-on-writer waits.
- Regression: `test_status_read_is_not_blocked_by_a_writer_holding_the_lock` holds
  `BEGIN IMMEDIATE` on one connection and asserts the status read answers 200 well inside the
  timeout; `test_startup_switches_the_control_database_to_wal` pins the mode.

**Operational notes for the deploy.** WAL adds `lakomics.sqlite3-wal` and `-shm` next to the
database. File-copy backups must copy all three or use the SQLite backup API
(`repair_asset_metadata.py` already uses `db.backup`). The `mode=ro` URI opens used by the
operator tools keep working as long as the directory is writable by the same user. No
`synchronous` change is made here (a `synchronous=NORMAL` proposal is listed in §5).

### 1.3 `GET /v1/library/list-generation` → 404 ×553

Not a server bug. The route exists (`app.py`, `asset_list_generation`) and returns 200 for
any authorized caller; FastAPI answers 404 only when no route matches, so those 553 answers
came from a server process that did not yet have the route. The mobile client treats exactly
this 404 as "server predates list generation" (`_tools/app/mobile-client/listGeneration.ts`)
and falls back to always-fresh page reads, so the visible cost of that window was extra
`/v1/library/assets` fetches, not an error on screen. 553 of ~14,500 calls (3.8 %) fits a
deployment that happened early in the seven-day window. The shallow clone cannot show the
commit that added the route; the deployment record should confirm the date.

## 2. Polling load

### 2.1 Method

`server/lakomics-api/tools/poll_benchmark.py` boots the real application against a throwaway
data directory, fills it with a synthetic library and measures each polling endpoint through
FastAPI's `TestClient` (in-process ASGI; no network, no TLS). Dataset: 9,200 Assets (all
committed, 2 % in trash), 549 Collections with artwork rows, 667 character-review items,
3,000 catalog works × 12 tags (36,000 tags) published as a real mobile-catalog replica,
600 classifications with 8,800 assignments, 300 Albums with ~6,000 memberships, 3,000
change rows per authority domain, 400 bookmarks with 1,000 change rows, 5,012 captures.
Device polls use a provisioned `client` token (two connections per request: the credential
lookup and the read), which is the worse case; the legacy shared token skips the lookup.

```
cd server/lakomics-api
.venv/bin/python tools/poll_benchmark.py --runs 200 --warmup 20 --json /tmp/after.json
```

"Before" numbers were taken with the same script against a copy of the pre-change modules
(`git show HEAD:…`). Both runs on the same container; absolute values are container-relative
and roughly 2–3× optimistic for a 1 vCPU VPS. The `noop` row is a route that touches nothing
and gives the framework floor.

### 2.2 Results (200 runs, milliseconds)

| Endpoint | before p50 | before p95 | after p50 | after p95 |
| --- | ---: | ---: | ---: | ---: |
| `GET /_bench/noop (framework floor)` | 1.221 | 1.553 | 0.973 | 1.272 |
| `GET /v1/sync/status` | 3.515 | 4.910 | 3.292 | 4.448 |
| `GET /v1/sync/status (304)` | — | — | 3.428 | 4.635 |
| `GET /v1/sync/status (shared token)` | 2.323 | 2.600 | 2.409 | 3.671 |
| `GET /v1/mobile-catalog/status` | 4.517 | 6.839 | 3.281 | 3.718 |
| `GET /v1/mobile-catalog/status (304)` | — | — | 3.316 | 5.470 |
| `GET /v1/albums/changes (caught up)` | 3.725 | 4.249 | 3.404 | 4.080 |
| `GET /v1/albums/changes (caught up, 304)` | — | — | 3.541 | 4.837 |
| `GET /v1/albums/changes (100 items)` | 5.796 | 7.437 | 4.278 | 5.527 |
| `GET /v1/classifications/authority/changes (caught up)` | 3.960 | 5.773 | 3.632 | 4.878 |
| `GET /v1/classifications/authority/changes (100 items)` | 5.906 | 8.039 | 4.470 | 5.682 |
| `GET /v1/assets/authority/changes (caught up)` | 3.935 | 5.918 | 3.594 | 5.000 |
| `GET /v1/assets/authority/changes (200 items)` | 8.010 | 11.044 | 5.136 | 6.560 |
| `GET /v1/mobile-catalog/bookmarks/changes (caught up)` | 3.617 | 4.740 | 3.526 | 4.358 |
| `GET /v1/library/assets` | 5.717 | 6.823 | 5.736 | 7.803 |
| `GET /v1/library/assets?classification_id` | **36.866** | **42.132** | **5.437** | **6.705** |
| `GET /v1/library/list-generation` | 2.669 | 3.338 | 2.211 | 2.757 |
| `GET /v1/captures/pending` | 2.844 | 3.856 | 2.547 | 3.034 |
| `POST /v1/library/media-tickets (3 assets)` | 6.159 | 9.094 | 5.030 | 5.853 |
| `GET /v1/library/characters/exclusions` | 3.478 | 3.880 | 3.354 | 3.841 |
| `POST /v1/collections/artworks/check (50)` | 3.064 | 3.648 | 2.625 | 3.435 |

Where the time goes on a caught-up poll (measured separately on the same dataset): opening a
connection is ~0.03 ms, but the first statement on it costs ~0.6 ms because the control
schema (162 objects) is parsed per connection, and installing the `visible_assets` temp view
adds ~0.15 ms. The status/feed query itself is ≤0.1 ms. So a device-token poll is roughly
1.0 ms framework + 0.8 ms credential connection + 0.8 ms read connection + serialization.

### 2.3 What changed

1. **`GET /v1/library/assets?classification_id=…` (21k/week): 37 ms → 5 ms.** The
   classification filter was a correlated `EXISTS` against the assignment table. SQLite chose
   to walk the whole library in sort order through `idx_assets_mobile_order` and probe the
   assignment index once per Asset — 9,200 probes for a 16-Asset classification, and
   `ANALYZE` did not change the plan. The clause is now `asset.id IN (SELECT asset_id … WHERE
   library_id=? AND classification_id=?)`, which reads the classification's ids from the
   covering `classification_authority_assignments_by_classification` index and sorts only
   those. Measured across classification sizes 16 → 8,000 the new form stays at 0.9–2 ms;
   the old form ranged 31 ms (sparse) to 0.25 ms (a classification holding almost everything),
   so the trade is one pathological dense case for every ordinary one. The legacy
   `asset_classifications` branch gets the same rewrite (its index is
   `idx_asset_classifications_classification(classification_id, asset_id)`). Result sets and
   cursors are unchanged; existing filter and pagination tests pass.
2. **`GET /v1/mobile-catalog/status` (96k/week): 4.5 → 3.3 ms, and no longer proportional to
   the bookmark count.** It called `catalog_bookmarks.load`, which opens its own connection
   and loads *every* live bookmark row, then opened a second connection for the publication.
   It now reads the authority identity (`catalog_bookmarks.authority_summary`, same ambiguity
   and contract checks, no rows) and the publication in one read transaction.
3. **`ETag` / `If-None-Match` → 304** on `GET /v1/sync/status`, `GET /v1/mobile-catalog/status`
   and the four change feeds (`/v1/albums/changes`, `/v1/classifications/authority/changes`,
   `/v1/assets/authority/changes`, `/v1/mobile-catalog/bookmarks/changes`), via the new
   `conditional.py`. The tag is a hash of the serialized body, so it is correct for any
   document; the body bytes are identical to FastAPI's own encoding, and a client that ignores
   the header sees no difference (all existing tests pass unchanged). Honest limit: the server
   still authenticates and runs the query for a 304, so the *server* saving is the response
   encoding and bytes only (the table shows equal p50 for 200 and 304). The real reduction
   this enables is on the client: a device that polls `/v1/sync/status` conditionally and
   only walks the per-domain feeds when the aggregate's tag changes turns four caught-up feed
   polls per cycle into zero. That is a client change (Android/PC) and is listed in §5.
4. **`GET /v1/albums/changes` and `GET /v1/mobile-catalog/bookmarks/changes` now read
   identity, cursor, retention floor and rows inside one `BEGIN` snapshot**, as the
   classification and asset feeds already did. Without it a command committing between the
   statements could advertise an older cursor with newer rows. Correctness, not speed.
5. **Removing the application-wide middleware** (§1.1) lowered the floor for every request.
6. **Indexes for every `…/changes?after=` query were verified, not added.** `EXPLAIN QUERY
   PLAN` on the synthetic database shows each feed doing
   `SEARCH … USING INDEX sqlite_autoindex_*_changes_1 (library_id=? AND epoch=? AND sequence>?)`
   on the composite primary key, the retention lookups using their primary keys, and the
   credential lookup using the unique `token_hash` index. No full-table work remained in a
   caught-up poll after items 1–2.

### 2.4 Considered and not done

- **Credential cache** for provisioned tokens (skip the ~0.8 ms lookup connection). Cheap, but
  it delays revocation by the cache TTL and revocation is an offline CLI operation with no
  way to notify the process. Left as a proposal.
- **Per-thread connection reuse** (skip the ~0.7 ms schema parse per connection). Largest
  remaining per-request cost, but several routes rely on connection close to end a
  transaction and the temp view is installed per connection; it needs its own careful change
  with tests. Left as a proposal.
- **A combined cursor response**: `/v1/sync/status` already carries every domain cursor, so
  the combined document exists; what is missing is the client using it (item 3 above).

## 3. Correctness review of the 2026-09-24 modules

Reviewed: `collection_personal_edits.py`, `character_review.py`, `similarity_review.py`,
`mobile_catalog_suggestions.py`, the Library Trash paths in `asset_authority.py`, and their
tests and design notes. `collection_authority.py` does not exist in this checkout; its design
(`docs/research/collection-authority-design-20260924.md`) has no server implementation yet.
A delegated read-only reviewer produced the candidate list; the items below were re-read and
confirmed against the source by the controller. Line numbers refer to the pre-change files.

**Confirmed sound (coverage).** Every mutation in the four modules runs inside
`BEGIN IMMEDIATE` with receipt, effect and cursor advance in one transaction; receipt lookup
precedes the state checks so a response-lost retry is resolved from the receipt; operation
ids are globally unique and library-checked first; change feeds are `after`-exclusive,
`LIMIT limit+1`, capped at 100 and served from `INTEGER PRIMARY KEY` scans; feed PUTs and log
reads require the publisher role and device routes the client role; bodies are streamed
against byte caps (32 KB personal edits, 8 KB review commands, 8 MiB feeds with item caps,
16 KB asset commands) before parsing; all models are `extra="forbid", strict=True`; the only
f-string SQL interpolations are closed literals; the suggestion cache is revision-keyed.

**Fixed.**
- `collection_personal_edits.current_value` compared the *published* memo unstripped
  against a stripped `expected`. A PC that published a description with surrounding
  whitespace would make every memo edit answer `collectionPersonalConflict` with
  `current` equal to the padded text, and the client's rebase (which sends it back trimmed)
  would conflict forever. The published value is now normalized by the same rule
  (`test_published_memo_with_surrounding_whitespace_does_not_conflict_forever`).

**Judgment calls (not changed; for the backlog).**
1. `character_review.py:515` applies the series restriction only to `origin == "viewer"`. A
   `feed`-origin decision for a pair that is neither in the published feed nor in the
   target's series is accepted (the test at `tests/test_character_review.py:258` relies on a
   feed decision needing no feed row). If feed decisions are meant to answer published
   candidates only, require a feed row for `feed` origin.
2. `similarity_review.py:380-409` stores `basis.feedRevision` but never compares it with the
   current feed revision; only the two sha256 values are checked. Either compare it (409
   `similarityReviewChanged`) or document it as informational.
3. The Library Trash ↔ similarity-review mirror check (`similarity_review.pending_trash_assets`)
   has no caller outside tests; a client `trashAsset` on an Asset that a pending similarity
   decision keeps is accepted. Both design notes acknowledge the gap for "slice 4".
4. `asset_authority.trash_page` orders and pages the trash on `updated_at`, which the
   replication upsert also bumps for metadata changes; a re-replicated trashed Asset moves
   in the listing and bumps `entity_revision` (the phone's queued restore then rebases on
   `revisionConflict`). A dedicated `lifecycle_changed_at` would make the trash order stable.
   Also, `asset_authority_by_lifecycle` does not cover that sort; fine while trash is small.
5. `collection_personal_edits.apply` validates `expected` with a 10,000-character limit, so a
   legacy memo longer than that yields 422 instead of a conflict. Unreachable unless legacy
   data exceeds the historical server limit.
6. Append-only tables with no retention: `mobile_collection_edits`,
   `mobile_collection_edit_noops`, `mobile_character_review_decisions`,
   `mobile_similarity_review_decisions`. Bounded only by the PC publishing regularly.
7. Auth surface: `/v1/library/trash` accepts a device (`client`) token but the media-ticket
   routes it needs are shared-token only (`require_auth`), so a provisioned client token can
   list the trash and not fetch its thumbnails. Pre-existing for every media ticket.
8. The shared legacy token, being a `client` credential, may now send `trashAsset` /
   `restoreAsset`. Matches the design's "any signed-in client"; noted because the legacy PC
   paths also carry that token.
9. `asset_authority.py:1248` parses the body before deciding whether the publisher role is
   required, so a client-role caller learns 422 vs 401 for a structural command; the
   classification route has the same order. Cosmetic.

## 4. Disk growth under `data/`

From the code (a delegated read-only trace, spot-checked by the controller against
`mobile_catalog_replica.py`, `catalog_refresh_content.py` and `mobile_catalog.py`). Actual
file counts, sizes, link counts and the presence of stale temp files on the server could not
be determined from the repository; the operator should list `data/mobile-catalog/` before
acting.

| Artifact | Created by | Deleted by | Still read by |
| --- | --- | --- | --- |
| `data/mobile-catalog/<digest>.sqlite` — immutable catalog content (est. ~160 MiB each at production scale; almost certainly the 17 GB) | PC upload `PUT /replicas/{digest}` (`mobile_catalog_replica.import_content`), and **a full `shutil.copyfile` of the current artifact on every refresh that adds at least one work** (`catalog_refresh_content.materialize:120`, hard-linked as a new digest at :148; hourly per language, PC publish, manual refresh, display-policy sync) | nothing | the current publication; any revision embedded in a signed search/count token for 24 h (`mobile_catalog.TTL`); PC publish/rollback to a base digest; the next materialization |
| `data/mobile-catalog/<revision>-users-v2.sqlite` (est. ~17 MiB each) | `prepare_users` per new publication revision | nothing | `open_publication` for the current revision and token revisions |
| `upload-*.ndjson`, `catalog-*.sqlite`, `users-*.sqlite`, `refresh-content-*.sqlite` temp files (up to 512 MiB each) | the same paths, unlinked in `finally` | only on the normal path; a SIGKILL/OOM mid-operation leaves them and no startup sweep exists | nothing (random names) |
| main DB tables that only grow: `mobile_catalog_artifacts`, `mobile_catalog_users` (≤8 MiB payload per publication), `mobile_catalog_publications`, `mobile_catalog_server_additions` (ledger, by design), `mobile_catalog_refresh_jobs` / `_receipts`, `image_thumbnail_jobs`, `captures`, review decision logs | — | `catalog_bookmarks.prune` (180 d) only via `prune_bookmarks.py`; `album_authority.prune`, `classification_authority.prune`, `asset_authority.prune` exist and have **no caller outside tests** | change feeds need rows above `pruned_through`; `cursorExpired` handling already exists |

All artifacts are created with `os.link`, and the recorded operator backups under
`~/lakomics-api/backups/<tag>/` also hard-link them, so deleting under `data/` frees space only
for files with no other link (`find data/mobile-catalog -links +1`).

**PROPOSALS (nothing implemented; each deletes something a recovery path may want).**
- P1. Content-artifact GC: keep the current publication's digest, every publication
  published within the last 48 h (2× token TTL), the previous two publications (rollback),
  and the newest PC-uploaded artifact (`ready_at` numeric; server-derived artifacts carry
  `ready_at='server-refresh'` with no time, so age them by file mtime or by the publication
  they belong to). Delete the rest with their `mobile_catalog_artifacts` rows. Risks: a PC
  rollback to a pruned digest gets 409 and must re-upload (~160 MiB); a still-valid token
  older than the window returns 503 instead of 409. Run as an operator CLI beside
  `prune_bookmarks.py`, which is the project's stance on pruning.
- P2. Users-projection GC with the same retained set.
- P3. Startup and periodic sweep of the four temp-file prefixes older than one hour (leases
  coordinate multiple processes; a fresh file may belong to another process).
- P4. Schedule `prune_bookmarks.py` on the host and add the same CLI for the album,
  classification and asset `prune()` functions (180-day change window, receipts kept
  longer). Trim `mobile_catalog_refresh_jobs`/`_receipts` older than 30 days except the
  latest per language. Keep the two rows the bookmark activation baseline references.
- P5. The copy-per-refresh is inherent to the immutable-artifact design; widening
  `REFRESH_INTERVAL_SECONDS` or batching small additions reduces the *rate* only. GC alone
  bounds disk use.
- P6. WAL follow-up: `PRAGMA synchronous=NORMAL` would cut fsyncs per commit on the VPS at
  the cost of possibly losing the last commits after a power loss (never corruption). Not
  applied; durability semantics should be an explicit decision.

## 5. Client-side follow-ups (not in this branch; `_tools/`, `android/` untouched)

- Poll `/v1/sync/status` with `If-None-Match` and skip the per-domain feed polls while it
  answers 304. Same for `/v1/mobile-catalog/status`. Existing clients keep working unchanged.
- The PC's saved-X-media publisher retries on network errors; nothing changes for it, but a
  dropped upload is now logged as a 400 rather than a 500.

## 6. Verification

- `cd server/lakomics-api && python -m unittest discover -s tests`: see the branch's final
  commit message for the run on the delivered tree. In this container the suite has one
  pre-existing failure unrelated to this work,
  `test_media_thumbnail_encode.FailClosedTests.test_no_kind_leaves_a_partial_file_behind_on_an_unsupported_source`
  (the encoder reports `EXIT_TOOL_UNAVAILABLE` because FFmpeg/FFprobe are not installed here);
  it fails identically on the untouched baseline.
- New tests: `tests/test_server_hardening.py` (11 cases: disconnect, chunked over-limit,
  declared over-limit, invalid length, auth-before-body, 422 shape, no middleware, WAL,
  reader-under-writer, ETag/304 on `/v1/sync/status`, `If-None-Match` matching rules),
  plus ETag/304 cases in `test_album_authority.py` and `test_mobile_catalog.py`, and the memo
  whitespace case in `test_collection_personal_edits.py`.
- Benchmark: `tools/poll_benchmark.py` as described in §2; JSON outputs were kept outside the
  repository.
- Not verified: production tracebacks (unavailable), the deployed server's journal mode and
  Starlette version, actual `data/` contents, and any native or device behavior.
- Dependencies: none added. The container installed `fastapi`, `httpx`, `boto3`, `pydantic`,
  `uvicorn`, `Pillow` into a local `.venv` (git-ignored) to run the suite.
