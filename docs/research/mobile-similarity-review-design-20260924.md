# Mobile similarity review — design (MOBILE-PARITY-001 slice 3)

Status: design accepted 2026-09-24 with the §5 decisions below.

## Summary

- v1 publishes **historical pairs only**. Incoming pairs come only from PC-local imports whose new image has no server bytes, and cloud captures skip the similarity check since lifecycle authority (`ingestion.rs:181`).
- The PC applies each phone decision through the existing `decide_similarity_review`.
- The image that is not kept always goes to Library Trash, never a hard delete. The trash reaches the server through the existing asset-lifecycle outbox.

## 1. Current state

- **Review listing** (`src-tauri/src/library/similarity.rs:72-202`):
  - open reviews only;
  - a recommendation exists only for historical pairs;
  - the DTO (`models.rs:537-545`) carries distance, historical flag, `recommendedAssetId`, and per-image dimensions, byte size, format and classifications;
  - no hashes or paths (`models.rs:1726` test).
- **Decisions** (`similarity.rs:209-250`):
  - Historical pairs: keep_existing trashes B, replace_existing trashes A (no metadata transfer, `:314-316`), keep_both moves nothing.
  - Incoming pairs: keep_existing permanently deletes the never-original new file; replace_existing trashes A and moves A's metadata to the new image.
  - Every trash queues a lifecycle command (`trash.rs:385-400`).
  - Repeating a decision is a no-op; a different decision on a resolved review is a conflict.
- **Staleness:** migration 0090 triggers mark an open historical pair `stale` when either asset is deleted, leaves `normal`, or changes content.
- **Server:** nothing about similarity is published; perceptual similarity stays PC analysis (`asset_authority.py:21`). Media tickets cover committed visible assets only.

## 2. Contract (mirrors the character review channel)

New server module `similarity_review.py`.

- **Feed:** `PUT /v1/library/similarity/review/feed`, publisher token only.
  - Shape: `{version, libraryId, baseRevision, decisionCursor, generatedAt, skipped[], items[{reviewId, kind:"historical", distance, recommendedAssetId?, recommendation, a:{assetId, sha256, width, height, byteSize, format, sourceLabel, collectedAt, classifications[]}, b:{…}}]}`.
  - Replaced atomically; the revision is the sha256 of the stored content; a stale base gets 409.
  - Limits: 5,000 items, 8 MiB.
  - The server drops pairs whose assets are not committed, normal and visible, or whose sha256 does not match.
  - On the PC, the export struct lives in `src-tauri/src/cloud/` so the no-hash DTO test stays valid.
- **Mobile read:** `GET …/similarity/review?limit≤50&cursor`.
  - Returns hydrated pairs and `counts{open, pendingPc, skipped}`.
  - The overlay hides pairs with a pending decision and pairs containing an asset that a pending decision will trash.
- **Decisions:** `POST …/similarity/review/decisions`.
  - Shape: `{version, libraryId, operationId, reviewId, decision: keep_existing|replace_existing|keep_both|withdrawn, basis:{feedRevision, aSha256, bSha256}}`.
  - Receipt-first idempotency and `operationConflict`, as in the character channel.
  - Refusals: `similarityReviewMissing`, `similarityAssetChanged`, `pendingSimilarityDecision`, `similarityAssetPendingTrash`.
  - Mobile Trash (slice 4) gets the mirror check.
- **PC log:** `GET …/decisions?after&limit≤100`, publisher only.
- **PC apply** (migration 0093: cursor, receipts, poll, feed state):
  - Look ahead in the page for `withdrawn`.
  - Verify the local sha256 values, then call `decide_similarity_review` as-is.
  - A crash between the decision and the receipt is safe, because the same decision is idempotent.
  - Skip outcomes advance the cursor: `resolvedOnPc`, `stale`, `changed`, `assetGone`, `withdrawn`.
- **Visibility:**
  - On tap: the pair leaves the queue, together with pairs sharing the asset to be trashed.
  - Until the PC applies: the gallery is unchanged.
  - After apply: the PC trashes the image, the lifecycle `trash` propagates with a revision check, and mobile views drop the image (ADR-0038). R2 is not deleted.
- **Incoming pairs (not v1):**
  - The phone shows "PC에서만 검토할 수 있는 새 이미지 N건".
  - A later option is PC-uploaded downscaled previews.
  - The phone must never trigger the incoming permanent delete.

## 3. Mobile UX

- **Entry:** a "유사 이미지 검토 N" row at the top of the Asset Library, shown only with the capability and N > 0.
- **Screen:** full-screen `SimilarityReview.tsx`, separate from the Viewer.
  - Landscape: A and B side by side with metadata strips; the higher resolution or larger file is accented.
  - Portrait: stacked, with a single-pane Compare mode.
- **Compare:**
  - synced zoom and pan in normalized coordinates, so different resolutions line up;
  - double-tap for 1:1; originals load on zoom;
  - hold to flicker (optional ~2 Hz auto), plus a wipe divider.
- **Buttons:** "A 유지 · B 휴지통", "B 유지 · A 휴지통", "둘 다 보관", with a "권장" badge. There are no swipe decisions because they would collide with pan.
- **Helper text:** "PC가 반영하기 전까지 원본은 바뀌지 않습니다. 버린 이미지는 휴지통으로 갑니다."
- **Undo:**
  - Up to 5 deep.
  - The outbox waits for the 5 s snackbar before sending.
  - After sending, undo posts `withdrawn`.
  - If the PC has already applied the decision, the phone points to Trash restore.
- **Other:**
  - progress "12 / 148 · PC 반영 대기 9 · 건너뜀 2";
  - empty states;
  - preload the next 2 pairs;
  - privacy masking;
  - Back closes zoom first;
  - the outbox reuses the character review pattern.

## 4. Rollout, risks, tests

- **Rollout:** server deploy (inactive until adoption) → PC build (the first feed PUT adopts) → APK (NetworkPolicy allows only the GET and the POST).
- **Risks:**
  - Overlapping pairs are handled by the overlay and the stale trigger.
  - A long-offline PC only delays application.
  - An older second-PC build must not publish a competing feed; restrict publishing to the adopting library.
  - Feed size after a large scan is bounded by the item cap and paging.
- **Tests:**
  - Server: replace/409, committed-only, sha/lifecycle checks, idempotency, pending-trash conflict, withdrawn, publisher-only log, limits.
  - Shared fixture `tests/fixtures/mobile-similarity-review-feed.json`.
  - Rust: export filter, trash plus outbox row per decision, idempotent re-delivery, skip outcomes, withdrawn look-ahead.
  - Mobile: synced zoom, flicker, wipe, buttons, undo window, outbox, Back.
  - Android: NetworkPolicy checks, plus a canary device check.

## 5. User decisions (2026-09-24)

1. v1 publishes historical pairs only; incoming pairs stay PC-only.
2. The PC automatically compares newly materialized Assets (including mobile/cloud saves) against the library and creates historical review pairs, so they get duplicate checking without a manual scan.
3. The image to be trashed stays visible in galleries until the PC applies the decision.
4. Undo after the PC applied points to Trash restore (slice 4).
5. A 5 s send delay for reliable undo is acceptable.

## Implementation notes (2026-09-24, server + mobile)

- **Server:** `server/lakomics-api/similarity_review.py`, registered from `mobile_characters.py` like `character_review`. Tests: `tests/test_similarity_review.py`. Shared fixture: `tests/fixtures/mobile-similarity-review-feed.json` (5 pairs; r4 and r5 are dropped on store).
- **Adoption:**
  - Requires an active authority domain whose libraryId matches.
  - Before adoption: the log GET returns 200 with empty items (the PC's probe; 404 means an old server), the mobile GET returns `ready:false`, and POST returns `similarityReviewUnsupported`.
  - The first feed PUT, with `baseRevision:null`, adopts. After that a different libraryId gets `libraryMismatch`.
- **Feed items:**
  - `recommendedAssetId` and `recommendation` are both null or consistent: a → `keep_existing`, b → `replace_existing`.
  - `a` is the existing asset and `b` the candidate.
  - Distance 0..1024; `format`, `sourceLabel` ≤300, classifications ≤64.
- **Extra refusal codes:** `similarityDecisionApplied` (nothing pending to withdraw; the phone points to Trash restore) and `similarityDecisionWithdrawn`.
- **Decision response:** includes `trashAssetId` and `withdraws`. The log items carry `aAssetId`, `bAssetId`, `trashAssetId`, `withdraws` (target sequence) and `basis`.
- **PC apply order:**
  1. Fetch a page.
  2. Skip entries targeted by a later `withdraws`.
  3. Verify the local sha256.
  4. Call `decide_similarity_review`.
  5. Write the receipt.
  6. Next feed PUT with `decisionCursor` = applied position and `skipped` (`resolvedOnPc`, `stale`, `changed`, `assetGone`, `withdrawn`); applied pairs are removed from the feed.
- **Known edge:** a `withdrawn` accepted after the PC fetched the decision is skipped; the image stays in Trash and can be restored.
- **Mirror check:** the server exposes `similarity_review.pending_trash_assets(db)`. Wiring the reverse check (mobile trash pending → refuse the similarity decision) is left for integration with slice 4.
- **Mobile privacy:** the mobile Viewer has no privacy masking, so none was added. No hashes or paths are shown.
