# Mobile personal Collection edits — design (MOBILE-PARITY-001 slice 2)

Status: design accepted 2026-09-24 with the §6 decisions below. Implementation not started.

Goal: edit my rating, Showcase membership and the personal memo (Collection `description`) from Android. Edits must work with the PC off, survive offline retry and response loss, apply exactly once, and appear on the PC without a manual sync (MOBILE-WRITE-002 acceptance).

## 1. Current state

- The PC alone owns these fields; Collections have no server authority (CLOUD-POST-001 "PC-owned publication").
- PC columns on `collections`: `my_score` (REAL, null = 미평가, 0–5 in 0.5 steps, 0 is a real rating; `library/collection.rs` `validated_personal_rating`), `showcase` + `showcase_order` (on = append `MAX+1` per type; off clears order), `description` (trimmed, empty → null, ≤ 2000 chars; server model allows 10000, the PC limit is authoritative).
- `update_collection` rewrites the whole record, so a stale edit dialog can write old values back.
- TMDB connect/refresh never writes these three fields (`tmdb_flow.rs` tests); no change needed there.
- Publication: the PC sends a full snapshot (`cloud/collections.rs`) to `PUT /v1/collections/replica`; the server deletes and reinserts every row (`mobile_collections.py`). A mobile edit written only into those rows would be erased by the next publication.
- Pattern to reuse: the mobile Character exclusion channel (`server/lakomics-api/character_exclusions.py`, PC `library/character_exclusions.rs`, migration 0089). The server accepts the command, keeps receipts and an ordered log, and changes what mobile reads at once. A publication guard rejects snapshots built from an out-of-range cursor. The PC pulls the log before publishing and applies each page atomically with the cursor. Mobile retry rules come from `bookmarkOutbox.ts` / `bookmarkDelivery.ts`.

## 2. Server contract (new `collection_personal_edits.py`, registered by `mobile_collections`)

- Tables: `mobile_collection_edit_state(library_id, applied_cursor, last_sequence)`; `mobile_collection_edits(sequence PK, operation_id UNIQUE, payload_digest, collection_id, field, value_json, base_json, created_at, result_json)`.
- `POST /v1/collections/personal-edits` (client token, ≤ 32 KB — a 2000-character Hangul memo sent as both value and expected is ~12 KB, strict model): `{version:1, libraryId, operationId, collectionId, field:'myScore'|'showcase'|'memo', value, expected}`. One field per command. Values are validated exactly like the PC. Game/manga/movie only (AV is never published).
- Processing in one `BEGIN IMMEDIATE` transaction:
  1. Same operation id and digest → stored receipt. Same id, different payload → `operationConflict`.
  2. If current equals value → receipt with `changed:false` (stored in `mobile_collection_edit_noops`, never in the PC log).
  3. Else if current differs from expected → `409 collectionPersonalConflict {current}`, no receipt.
  4. Otherwise append a log row, patch the row payload (and `showcase`/`showcase_order`), and bump the replica revision.
  - Receipt: `{version, operationId, collectionId, field, value, sequence, revision, changed}`.
- `GET /v1/collections/personal-edits?libraryId&after&limit≤100` (publisher token) → `{nextCursor, hasMore, items[…]}`.
- Publication handshake: the replica carries `personalEditVersion:1, libraryId, personalEditCursor`. The server:
  - guards `applied ≤ cursor ≤ last_sequence`;
  - once the state row exists, rejects snapshots without the field;
  - after reinserting rows, re-applies log entries with `sequence > cursor`, so a stale publication cannot rewind an edit;
  - then sets `applied_cursor`.
- Conflicts (ADR-0037 "personal scalars may automatically rebase"):
  - Rating/Showcase: last server-accepted value wins per field. Mobile auto-rebases once on `collectionPersonalConflict`.
  - Memo: no silent rebase. Keep the draft and ask the user (overwrite / discard).

## 3. PC side

- Migration `0091_mobile_collection_personal_edits.sql`: sync cursor, receipts (with `previous_value` for audit), poll state; same shape as 0089.
- `library/collection_personal_edits.rs`: bootstrap → receive → `apply_page`.
  - Each page is applied in one transaction with the cursor and receipts, using targeted UPDATEs only.
  - The existing 0074 dirty triggers cause a republish.
  - Missing/AV collections get `skipped` receipts; PC deletion wins.
- Order: in `publish_due_mobile_kind` for `collections`, receive edits before publishing. Poll at most once a minute. The snapshot reads `received_cursor` in the same read transaction as the rows.
- Fix the edit-dialog race: `update_collection` takes the dialog's loaded `myScore`/`description` as a base and writes only fields the user changed.
- Refresh the PC UI after an applied page (verify the library-changed event path).
- All other Collection fields stay PC-owned.

## 4. Mobile side

- Collection detail:
  - editable `내 평점` (bottom sheet: 미평가, 0.0–5.0 in 0.5 steps);
  - Showcase toggle;
  - a separate `내 메모` section with an edit sheet and a 2000-character counter.
- `collectionEditOutbox.ts` + `collectionEditDelivery.ts` copied from the bookmark outbox:
  - one intent per `collectionId:field`;
  - a new action replaces the queued intent with a new operation id;
  - the intent is removed when its receipt arrives;
  - sends are skipped until `/v1/collections/status` advertises `collectionPersonalEdit`.
- The queued value shows immediately with the bookmark "전송 대기" look. Flush on start, on returning to the foreground, and after an edit.

## 5. Rollout and tests

- Order, each separately authorized:
  1. Server deploy. Commands get `collectionPersonalEditUnsupported` until an upgraded PC publishes.
  2. PC build. Its first publication creates the state row; older PC builds are then blocked from publishing Collections.
  3. APK.
- Risks:
  - Revision changes may interrupt in-flight artwork tickets; check whether the ticket route validates the revision.
  - Publication 409s retry after 60 s.
  - Keep the memo limit aligned at 2000.
- Tests:
  - Server: accept, replay, `operationConflict`, `changed:false`, conflict, overlay surviving a stale publication, publication guard, library mismatch.
  - PC: atomic apply with cursor, replay-safe, skipped missing, receive-before-publish, same-transaction cursor read, dialog base check, TMDB refresh preserving values.
  - Mobile: outbox persistence, replacement, lost-response retry, rebase, memo conflict sheet, validation.
  - Device: PC off → edit → kill app → offline → resend → PC on → value visible.

## 6. User decisions (2026-09-24)

1. A mobile edit wins over an unpublished PC edit of the same field (server-accepted order).
2. Memo conflicts prompt the user (overwrite / discard); rating and Showcase rebase automatically.
3. Mobile Showcase is membership only; reordering stays on the PC.

## Implementation notes (2026-09-24)

Server (`collection_personal_edits.py`) and mobile (`collectionEditOutbox.ts`, `collectionEditDelivery.ts`, `useCollectionEdits.ts`, `CollectionPersonal.tsx`) are implemented; the Android `NetworkPolicy` allows the POST and blocks the publisher-only feed. `/v1/collections/status` advertises `capabilities.collectionPersonalEdit` with `libraryId`, `personalEditCursor` and `appliedPersonalEditCursor`. The PC replica PUT must use the publisher token and send all of `personalEditVersion`, `libraryId`, `personalEditCursor`. Artwork tickets do not check the replica revision, so revision bumps do not break them. PC stage (§3) is pending.
