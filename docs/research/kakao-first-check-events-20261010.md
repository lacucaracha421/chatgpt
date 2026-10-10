# Kakao first-check false release events — 2026-10-10

Scope: offline investigation and fixes in `server/lakomics-api/` and the defective PC
path under `_tools/app/src-tauri/src/library/`. No network/provider/production access,
dependency installs, Git writes, deployment, or production-data changes. Concurrent
roadmap and other worker changes are excluded. New/changed task files use LF.

## Evidence and root cause

The controller supplied these production observations; this investigation did not
independently query production:

- Work A, `마법소녀를 동경해서`, ID prefix `d26ec53f`: live volumes 1–13, sourced
  from MangaDex, existed since authority adoption at `2026-10-06T13:46:52Z`.
  Its Kakao binding had `snapshot_values='{}'`. The first server check at
  `2026-10-09T11:49:12Z` emitted six `new_volume` events for 1–6.
- Work B, `신부이야기`, ID prefix `306573cc`: local live volumes 1–15 existed
  since 2026-10-06. Its Kakao binding also had `snapshot_values='{}'`.
  Ten events for 1,2,4,5,7,8,9,12,13,14 were emitted at
  `2026-10-09T08:35:13Z`, before the server checker; all ten were unread.

Both paths confuse **a newly stored Kakao source** with **a newly discovered volume
of the work**. Neither originally required provider baseline history or excluded
numbers already present on the shelf. Adoption is a trigger, not the underlying
event-classification defect.

### Server path

- `collection_release_checks.py:271` (`pending_release_changes`) immediately returns
  `new_volume` when the previous Kakao source is absent; the previous check time does
  not guard that branch.
- Before this fix, `reconcile` gated that call only on subscription and ownership
  (`HEAD` lines 387–402). `existing_slots` was used only to create missing edition-0
  slots (`HEAD` line 405), not to filter notifications.
- `Worker.apply`, now `collection_release_checks.py:820`, reloads Kakao-only source
  rows at `:850`; an existing MangaDex/local slot cannot satisfy that source lookup.
  The later-of-state-and-binding check timestamp at `:849` likewise is not baseline
  evidence. An adoption timestamp can exist without Kakao source history.
- Authority adoption preserves supplied binding snapshots/values/timestamps in
  `collection_authority.py:3791` (`insert_staging`), and imports volume sources as a
  separate baseline section. It does not turn generic ownership or slots into Kakao
  seen-source history. `{}` in `snapshot_values` alone proves nothing: Kakao refresh
  deliberately writes `{}` there even after successful checks. The fix does not use
  empty values as its baseline test.
- Event recording through `collection_authority.py:2634` is idempotent/content-deduped
  storage, not a detection baseline. It accepts the detector's new-volume conclusion.

### PC-era path

- `collection_updates.rs:245` invokes provider refresh and `:250` compares event
  counts before/after. Detection itself belongs to `aladin_flow.rs`.
- `aladin_flow.rs:771` queries the existing source by work, volume and provider.
  MangaDex/local slots do not satisfy a missing Kakao source.
- `release_watch.rs:23` (`pending_release_changes`) returns `NewVolume` when the
  source is absent (`:29`), regardless of the previous check timestamp.
- Before this fix, `aladin_flow.rs` gated detection on an existing subscription row
  and ownership (`HEAD` lines 612–650). `Option<Option<String>>` distinguishes an
  existing row with a NULL timestamp from no subscription: the former still entered
  event detection. Even a non-NULL adoption-era timestamp is not Kakao history.
- `reconcile_source` writes a slot before returning the old provider source. The fix
  must inspect existing slots **before** calling it; otherwise even genuine arrivals
  would be suppressed. Current checks are at `aladin_flow.rs:636` and `:644`.
- Under active authority, `aladin_flow.rs:674` calls
  `collection_authority.rs:834` (`enqueue_release_event`), which queues
  `recordReleaseEvent`. This explains the PC-era route into the shared server store.
  When authority is inactive, the same detector writes local `release_watch_events`.

The production evidence did not include complete pre-check Kakao source rows or
candidate snapshots. Their precise migration contents cannot be confirmed offline.
The missing-source hypothesis is reproduced with real authority/SQLite bodies: loading
the original `HEAD` server definitions in memory made both new A/B-shaped regression
tests fail at the quiet-first-check assertion. No worktree rollback was used.
The PC defect is established from source; its native test execution is unavailable.

## Change and justification

Decision §8.1, `docs/research/server-kakao-binds-20261009.md:148`, requires initial
binding and rebinding to establish a quiet baseline. No inspected design reference
requires alerts for already-existing live volume numbers. The defensive rule applies
across editions and providers; ownership counts alone do not invent a live slot.

- A first refresh without live Kakao source history records sources, slots, config,
  snapshot and normal check state, with no release events. A timestamp alone never
  enables events. Subsequent successful checks use the persisted source baseline.
- Server commit-time planning also requires the retained snapshot to match the current
  binding identity and selected group fingerprints. A raw rebind may keep old sources
  and a snapshot as a merge base (`collection_authority.py:2091`); those do not establish
  a baseline for a different identity/group set. Same-anchor group changes are covered.
  The server bind planner remains quiet as before.
- PC strict apply and delayed-request apply now explicitly select quiet bind/rebind
  reconciliation. Ordinary refresh requires pre-existing provider source history.
- Both detectors suppress only `new_volume` for an already-live slot number at
  detection time. Server checks reload every edition under `BEGIN IMMEDIATE`; tombstones
  are excluded. The PC replica physically removes deleted slots
  (`collection_authority.rs:2177`), so its live `collection_volumes` table is sufficient.
  Edition-0 slot creation remains independent from this all-edition notification rule.
- Genuine later arrivals still notify. Date/status changes of baseline-known volumes
  retain their existing subscription, ownership, range and deduplication rules.
- No new schema, baseline migration, recovery job or production repair was added.

Changed files:

1. `server/lakomics-api/collection_release_checks.py` — baseline and live-slot gates.
2. `server/lakomics-api/tests/test_kakao_first_check.py` — eight offline regression cases.
3. `server/lakomics-api/tests/test_collection_release_checks.py` — HTTP suite expectations
   and event-limit/range fixtures updated to test post-baseline arrivals.
4. `_tools/app/src-tauri/src/library/aladin_flow.rs` — equivalent PC fix and A/B/rebind tests.
5. `_tools/app/src-tauri/src/library/release_watch.rs` — two old first-observation
   expectations changed from an alert to a quiet successful check.
6. `_tools/app/src-tauri/src/library/fixtures/kakao_refresh.json` — quiet unnumbered first
   check; range case given an existing source so it still exercises range filtering.
7. This findings file.

## Verification

From `server/lakomics-api`:

```text
python -m unittest tests.test_kakao_first_check tests.test_kakao_bind_core
```

**26 passed**. Eight new tests exercise A (1–13 live / first result 1–6 / later only 14
alerts), B (1–15 live / ten sparse first products / later only 16 alerts), a first check
without slots, other live editions vs tombstones, rebind, same-anchor group change,
a slot added during provider fetch, and date/status changes for a known slot.
The existing 18 bind-core tests include shared refresh-fixture parity.
These execute real planner/storage/authority bodies using the existing AST loader;
HTTP/Pydantic model validation and mobile projection validation use identity adapters.

`python -m unittest tests.test_collection_release_checks` from the owning server package
could not import FastAPI (`ModuleNotFoundError`). No packages were installed. The full
HTTP suite, including its updated expectations, remains unexecuted on this host.

From the repository root, the prescribed targeted Rust command was attempted:

```text
CARGO_TARGET_DIR=_tools/app/src-tauri/target-worker bash scripts/cargo-test.sh --timeout 1500 -- -- aladin_flow kakao_refresh release_watch collection_updates
```

It failed before running the wrapper/tests: Git Bash `CreateFileMapping ... Win32 error 5`.
No Cargo test or compilation success is claimed. Read-only Rust syntax parsing succeeded
for both changed Rust files with `rustfmt --edition 2021 --config skip_children=true
--emit stdout <file>` (output discarded, no write-mode formatter).
Task diff review was inline; `git diff --check` passed for task files. Native Windows,
Linux, device, live provider and production/deployment verification remain unperformed.

## Existing false events: recommendation and safe human operation

**Recommend marking the confirmed false events read, especially B's ten unread events,
after separate user approval.** Do not delete events or change source/binding baseline
data. A code fix does not retract existing events. A's unread status was not provided;
inspect it before deciding whether any read acknowledgement is needed.

Read-only verification query for B (prefixes are used because full IDs were not supplied):

```sql
WITH target_work AS (
  SELECT library_id, work_id
  FROM collection_authority_works
  WHERE work_id LIKE '306573cc%' AND name = '신부이야기' AND type = 'manga'
)
SELECT e.event_id, e.collection_id, e.volume_number, e.detected_at, e.read_at
FROM collection_release_events AS e
JOIN target_work AS w ON w.work_id = e.collection_id
WHERE (SELECT COUNT(*) FROM target_work) = 1
  AND e.provider = 'kakao' AND e.kind = 'new_volume'
  AND julianday(e.detected_at) = julianday('2026-10-09T08:35:13Z')
  AND e.volume_number IN (1,2,4,5,7,8,9,12,13,14)
  AND EXISTS (
    SELECT 1 FROM collection_authority_volumes AS v
    WHERE v.library_id = w.library_id AND v.work_id = w.work_id
      AND v.volume_number = e.volume_number AND v.deleted = 0
      AND julianday(v.created_at) <= julianday(e.detected_at)
  )
ORDER BY e.volume_number, e.event_id;
```

Require the ten expected distinct volume numbers and inspect their exact IDs. If the
count, identity or timestamps differ, stop and investigate; do not widen the filter.
For A, use the same read-only query with prefix `d26ec53f`, name `마법소녀를 동경해서`,
timestamp `2026-10-09T11:49:12Z`, and volume list `(1,2,3,4,5,6)`; expect six rows.

After approval, send **only the inspected unread event IDs** to the existing route,
using the configured endpoint and an authorized client credential:

```http
POST /v1/collections/releases/acknowledge
Authorization: Bearer <existing authorized client credential>
Content-Type: application/json

{"version":1,"operationId":"<fresh UUID>","eventIds":["<exact inspected event ID>"]}
```

The array contains all ten approved unread B IDs, not a collection-wide selector;
A's approved unread IDs may be acknowledged separately. Replace placeholders, retain
the operation UUID and identical body when retrying an unknown outcome. Verify
`acknowledged`/`alreadyRead` and reread the scoped query afterward. This route delegates
to `acknowledge_release_shim` under active authority (`collection_releases.py:519`,
`:526`), updating authority projection/feed and the PC read log transactionally.
Direct `UPDATE read_at` would bypass those surfaces and is not recommended.
No acknowledgement, SQL write or production query above was executed in this task.
