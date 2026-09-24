# Mobile character-candidate review — design

Status: design accepted 2026-09-24 with the §6 decisions below.

Goal: review character candidates on Android without running models on the phone:
- S36 candidates and "doubtful" existing acceptances;
- B36 recommendations;
- a manual "캐릭터에 추가" from the viewer.

The PC applies every decision.

## Current state (verified)

- **Candidates are PC-local.**
  - S36 shadow scores live in `<library>/.cache/characters/s36_shadow.sqlite`. `character_shadow_review.rs` handles verdict filters, hides pairs already decided after `scored_at`, and returns at most 4 reference ids.
  - B36 recommendations are `character_autotag_predictions` rows with `state='recommended'` for the current `target_fingerprint` (`character_review.rs`).
- **Decisions** go through `record_character_decision_batch` / `write_character_decisions` (`characters.rs` ~879-1000).
  - A fingerprint mismatch returns `Stale`; a batch holds at most 200 pairs.
  - Accept checks folder eligibility; `cleared` is hash-only.
  - Inbound rejections use `write_inbound_character_rejection` (`characters.rs` ~1025).
  - Manual decisions feed S36 scoring automatically (`character_shadow.rs`).
- **The exclusion log cannot carry accepts.**
  - The PC's `ExclusionEntry` ignores unknown fields, so an un-upgraded PC would store an `accepted` entry as a rejection.
  - The server exclusion POST only accepts current published members.
  - Therefore use a sibling module and leave `/exclusions` and existing APKs untouched.

## 1. Candidate feed (server `character_review.py`, registered like exclusions)

- **PC → server:** `PUT /v1/library/characters/review/feed`, publisher token only.
  - Top level: `{version, libraryId, baseRevision, decisionCursor, policyVersion, generatedAt, skipped[], targets{id:{name, seriesId, fingerprint, referenceAssetIds≤4}}, items[{assetId, targetId, sources[s36|b36|doubtful], verdict, knn3?, basis}]}`.
  - `(targetId, assetId)` is the key.
  - Replaced atomically with a digest revision; a stale base gets 409.
  - Only committed visible assets are kept.
  - Limits: 5,000 items, 8 MiB, 1,000 targets.
- **Mobile read:** `GET /v1/library/characters/review?source&target&limit≤50&cursor`.
  - Returns hydrated rows, reference metadata and `counts{s36, b36, doubtful, pendingPc}`.
  - A server overlay hides pairs with a newer pending accept/reject; a pending `cleared` shows the pair again.
- **PC export:**
  - Extract `shadow_review_items(mode)` from the page function so the full scan is not repeated per page.
  - Add an all-targets B36 query.
  - Republish on the `characters` lane at most every 5 minutes, sooner when decisions or `MAX(scored_at)` change, using a durable digest state.

## 2. Decision channel

- **Command:** `POST /v1/library/characters/review/decisions` with `{version, libraryId, operationId, targetId, assetId, decision: accepted|rejected|cleared, origin: feed|viewer, basis}`, at most 8 KiB.
  - Receipt: `{sequence, revision, pendingPc}`.
  - Idempotency follows exclusions: the receipt is looked up first, and a reused id with different content gets `operationConflict`.
- **Checks:**
  - active library;
  - target is in the published index;
  - asset is committed and visible;
  - accept/reject is refused for protected references.
- **Cross-channel conflict:** 409 `pendingCharacterCorrection` while a pending exclusion exists for the pair. The exclusion POST gets the mirror check.
- **PC log:** `GET …/review/decisions?libraryId&after&limit≤100`, publisher only.
- **Adoption:**
  1. The PC probes the log route; only a 404 means an older server.
  2. The first feed PUT carries `decisionCursor`.
  3. The index then advertises `capabilities.characterReview`, `reviewDecisionCursor` and `appliedReviewDecisionCursor`.
  4. The navigation snapshot carries `reviewDecisionCursor` under a floor/ceiling guard, and hidden members union both logs.
  5. A legacy navigation PUT after adoption is refused.
- **Staleness:**
  - Decisions ignore the target fingerprint and are recorded against the current one.
  - An entry is `superseded` when a newer local decision (not from this channel) exists after `basis`.
  - Deterministic failures give `skipped:<reason>` and still advance the cursor. Only transport or DB errors hold the cursor.

## 3. PC apply

- **Migration 0092:** tables for sync cursor, receipts (outcome, decision_sequence), poll and feed state.
- **Apply one page per transaction:**
  - accepted/cleared → `write_character_decisions` with the current fingerprint read in the same transaction;
  - rejected → `write_inbound_character_rejection`;
  - then receipts, cursor, and a bump of the `characters` generation.
- **Tick and publish order:**
  1. exclusions
  2. review decisions
  3. navigation snapshot
  4. feed (its PUT carries `skipped` for the newly acknowledged range)
- **Scoring feedback** needs nothing new: S36 picks decisions up on the next scoring pass, and the existing trigger re-queues B36.
- **Desktop `ShadowReview.tsx`** reloads on window focus and when an inbound-applied counter changes.

## 4. Mobile UX

- **Entry points** (no new top-level tab):
  - a "캐릭터 검토 N" row at the top of Library → 분류, shown only with the capability and N > 0;
  - a "검토 N" chip in a character page header that filters the feed.
- **Screen:** full-screen `CharacterReview.tsx`, separate from the Viewer because the Viewer already uses horizontal swipes.
  - The candidate is shown large, with character name, series and a source chip.
  - Up to 4 reference thumbnails: a side column in landscape, a strip in portrait. Tap to zoom.
- **Gestures:**
  - right = 맞음, left = 아님 (30% width or a fling, with a tilt and color hint);
  - up = 건너뛰기 (local only);
  - 아님 · 건너뛰기 · 맞음 buttons are always visible;
  - Back closes zoom first, then the screen.
- **Undo:** "되돌리기" snackbar, 5 deep. An unsent intent is removed; a sent one queues `cleared` with a new operation id.
- **Outbox:** `characterReviewOutbox.ts` / `characterReviewDelivery.ts`, modeled on the Collection edit outbox.
  - One intent per pair, at most 500.
  - Sends on resume and when the network returns, only when the capability is advertised.
  - Queued pairs are hidden locally.
- **Progress:** "12 / 148 · PC 반영 대기 9", plus the count of items the PC skipped.
- **Empty states:** PC needs update / feed never published / all reviewed / offline with N saved.
- **Viewer "캐릭터에 추가":** a sheet of characters in the asset's own series; protected or existing members are hidden; sends `origin:"viewer"`.
- **Preload:** warm the next 3 candidates' thumbnails.

## 5. Rollout and tests

- **Rollout order,** each step separately authorized:
  1. Server deploy — inactive until adoption; old APKs and old PCs unaffected.
  2. PC build — the first feed PUT enables the capability.
  3. APK — `NetworkPolicy` allows only the review GET and the decisions POST.
- **Tests:**
  - Server: atomic replace/409, committed-only, overlay hide/show, idempotency, cross-channel 409, publisher-only log, cursor guard, limits.
  - Shared fixture `tests/fixtures/mobile-character-review-feed.json` for Rust and Python.
  - Rust: export parity, apply accepted/rejected/cleared, superseded vs undo, skip reasons advance the cursor, receive-before-snapshot.
  - Mobile: swipe, buttons, undo, Back, outbox and delivery.
  - Android: NetworkPolicy checks.

## 6. User decisions (2026-09-24)

1. "맞음" hides the candidate at once, but the asset appears in the character gallery only after the PC applies it (no membership overlay).
2. For series switched to S36, the feed shows only recommended, B36 and doubtful items (not S36 automatic acceptances).
3. Decisions still apply after the character's references changed.
4. Viewer "캐릭터에 추가" offers only characters from the asset's own series.

## Implementation notes (2026-09-24, server + mobile)

Implemented in `server/lakomics-api/character_review.py` (registered by `mobile_characters.py`; `character_exclusions.py` gained the mirror conflict check and unions pending review rejections into hidden members), mobile `CharacterReview.tsx`, `CharacterAddSheet.tsx`, `characterReviewOutbox.ts`, `characterReviewDelivery.ts`, `useCharacterReview.ts`, and Android `NetworkPolicy` (GET review, POST decisions only). Shared fixture: `tests/fixtures/mobile-character-review-feed.json`.

Deviations and details the PC stage must follow:

- **Feed PUT:**
  - Strict model: tokens `^[A-Za-z0-9._:+-]{1,128}$`, ids `^[A-Za-z0-9_-]{1,128}$`, `skipped.reason` ≤ 64 characters.
  - The first PUT is adoption. It requires an earlier character publication with manual-exclusion support.
  - Guards: `feed_cursor ≤ decisionCursor ≤ last sequence`, and every `skipped.sequence ≤ decisionCursor`.
  - The revision is the sha256 of the stored content, so `generatedAt` changes it.
- **Mobile read, "add" mode:** `GET …/review?asset=<id>` returns the characters in that asset's series (by server `series:X` membership), minus existing members, protected references and pending accepts. This avoids adding a network path.
- **Decisions POST:** also rejects viewer-origin non-cleared decisions outside the target's series (`characterReviewOutsideSeries`).
- **Navigation snapshot:** `reviewDecisionCursor` requires `manualExclusionVersion`, is 0 only before adoption, and is mandatory after it. Without the field, the revision is unchanged for old PCs.
- **PC order:** exclusions → review decisions → navigation snapshot (`reviewDecisionCursor` = applied position) → feed PUT (`decisionCursor` = same position, `skipped` = the newly acknowledged range).
- **Open for the PC stage:** an undo sends `cleared`, which could remove an older manual decision. Apply `superseded` / same-channel undo rules carefully.
