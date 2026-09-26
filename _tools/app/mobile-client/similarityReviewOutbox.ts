/**
 * Durable mobile similarity-review decisions, modeled on `characterReviewOutbox.ts`:
 *
 * 1. **One decision intent per review, minted once.** The operation id is created when the
 *    user acts and reused on every transport retry.
 * 2. **A 5 s send delay** (`notBefore`) keeps the snackbar's undo reliable: an intent that
 *    was never sent is simply removed.
 * 3. **Undo after sending** queues a `withdrawn` intent under its own key, so a new decision
 *    on the same review cannot replace the withdrawal. Delivery sends oldest first, so the
 *    withdrawal reaches the server before the new decision.
 * 4. **Removed on a matching receipt.** A receipt for a replaced id is ignored.
 *
 * At most {@link SIMILARITY_OUTBOX_LIMIT} intents wait at once. Committing throws when the
 * device cannot store the decision, so the screen never shows an unsaved decision as queued.
 *
 * The queue is stored per connection (`outboxConnection.ts`) and each intent names its library:
 * only the current server's intents are shown and sent, and only while it reports that library.
 */

import {connectionOutbox, outboxKey} from './outboxConnection';

export type SimilarityChoice = 'keep_existing' | 'replace_existing' | 'keep_both';
export type SimilarityDecision = SimilarityChoice | 'withdrawn';
export type SimilarityBasis = {feedRevision: string; aSha256: string; bSha256: string};

export type SimilarityIntent = {
  libraryId: string;
  reviewId: string;
  decision: SimilarityDecision;
  basis: SimilarityBasis;
  /** The pair's Assets, kept so queued decisions can hide overlapping pairs locally. */
  aAssetId: string;
  bAssetId: string;
  operationId: string;
  createdAt: number;
  /** Not sent before this time (the undo window). */
  notBefore: number;
};

const INTENTS_KEY = connectionOutbox('lakomics.similarity.review.outbox.v1');
export const SIMILARITY_OUTBOX_LIMIT = 500;
export const SIMILARITY_SEND_DELAY_MS = 5000;
export const SIMILARITY_SAVE_FAILED = '기기에 저장하지 못했습니다.';
export const SIMILARITY_OUTBOX_FULL = '전송을 기다리는 검토가 너무 많습니다. 연결된 뒤 다시 시도해 주세요.';
/** Fired after the durable queue changes, so every screen re-reads it. */
export const SIMILARITY_REVIEW_EVENT = 'lakomics-similarity-review';

export const intentKey = (reviewId: string, decision: SimilarityDecision) => decision === 'withdrawn' ? `${reviewId}:withdrawn` : reviewId;

/** The image a decision sends to Library Trash once the PC applies it. */
export function trashedBy(decision: SimilarityDecision, aAssetId: string, bAssetId: string): string | null {
  return decision === 'keep_existing' ? bAssetId : decision === 'replace_existing' ? aAssetId : null;
}

const DIGEST = /^[a-f0-9]{64}$/;
function valid(value: unknown): value is SimilarityIntent {
  const intent = value as SimilarityIntent | null;
  return !!intent && typeof intent === 'object' && typeof intent.libraryId === 'string' && typeof intent.reviewId === 'string'
    && typeof intent.operationId === 'string' && typeof intent.createdAt === 'number' && typeof intent.notBefore === 'number'
    && typeof intent.aAssetId === 'string' && typeof intent.bAssetId === 'string'
    && ['keep_existing', 'replace_existing', 'keep_both', 'withdrawn'].includes(intent.decision)
    && !!intent.basis && DIGEST.test(intent.basis.feedRevision) && DIGEST.test(intent.basis.aSha256) && DIGEST.test(intent.basis.bSha256);
}

/** The current connection's queue (empty while no connection is known). */
export function readSimilarityIntents(): Record<string, SimilarityIntent> {
  try {
    const key = outboxKey(INTENTS_KEY);
    const raw = key === null ? null : localStorage.getItem(key);
    const parsed = raw === null ? null : JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, intent]) => valid(intent))) as Record<string, SimilarityIntent>;
  } catch { return {}; }
}

function write(intents: Record<string, SimilarityIntent>): boolean {
  const key = outboxKey(INTENTS_KEY);
  if (key === null) return false;
  try { localStorage.setItem(key, JSON.stringify(intents)); } catch { return false; }
  try { window.dispatchEvent(new Event(SIMILARITY_REVIEW_EVENT)); } catch { /* No window outside the app. */ }
  return true;
}

type Made = Omit<SimilarityIntent, 'operationId' | 'createdAt' | 'notBefore'>;

function put(decision: Made, delay: number, operationId: () => string, now: number): SimilarityIntent {
  const intents = readSimilarityIntents();
  const key = intentKey(decision.reviewId, decision.decision);
  if (!intents[key] && Object.keys(intents).length >= SIMILARITY_OUTBOX_LIMIT) throw new Error(SIMILARITY_OUTBOX_FULL);
  const intent: SimilarityIntent = {...decision, operationId: operationId(), createdAt: now, notBefore: now + delay};
  intents[key] = intent;
  if (!write(intents)) throw new Error(SIMILARITY_SAVE_FAILED);
  return intent;
}

/**
 * Queue the user's decision for one review; it is sent after the undo window. Throws
 * {@link SIMILARITY_SAVE_FAILED} or {@link SIMILARITY_OUTBOX_FULL}.
 */
export function commitSimilarityDecision(decision: Omit<Made, 'decision'> & {decision: SimilarityChoice},
  operationId: () => string = () => crypto.randomUUID(), now = Date.now()): SimilarityIntent {
  return put(decision, SIMILARITY_SEND_DELAY_MS, operationId, now);
}

/** Remove an intent the server confirmed (or refused for good), unless a newer action replaced it. */
export function confirmSimilarityIntent(expected: SimilarityIntent): boolean {
  const intents = readSimilarityIntents();
  const key = intentKey(expected.reviewId, expected.decision);
  if (intents[key]?.operationId !== expected.operationId) return false;
  delete intents[key];
  write(intents);
  return true;
}

/** A new operation id for an unchanged payload, after the server refused the old id. */
export function reissueSimilarityIntent(expected: SimilarityIntent, operationId: () => string = () => crypto.randomUUID()): SimilarityIntent | null {
  const intents = readSimilarityIntents();
  const key = intentKey(expected.reviewId, expected.decision);
  const stored = intents[key];
  if (!stored || stored.operationId !== expected.operationId) return null;
  stored.operationId = operationId();
  return write(intents) ? stored : null;
}

/**
 * Undo one decision. An intent that never left the device is removed (`removed`); one the
 * server may already hold (sent, or being sent right now) is followed by a `withdrawn`
 * intent that is sent at once (`withdrawn`). Throws like {@link commitSimilarityDecision}.
 */
export function undoSimilarityDecision(made: SimilarityIntent, inFlight: (operationId: string) => boolean = () => false,
  operationId: () => string = () => crypto.randomUUID(), now = Date.now()): 'removed' | 'withdrawn' {
  const intents = readSimilarityIntents();
  const key = intentKey(made.reviewId, made.decision);
  const queued = intents[key]?.operationId === made.operationId;
  if (queued && !inFlight(made.operationId)) {
    delete intents[key];
    if (!write(intents)) throw new Error(SIMILARITY_SAVE_FAILED);
    return 'removed';
  }
  if (queued) {
    // Its outcome is unknown: never resend it, and withdraw whatever the server recorded.
    delete intents[key];
    if (!write(intents)) throw new Error(SIMILARITY_SAVE_FAILED);
  }
  put({libraryId: made.libraryId, reviewId: made.reviewId, decision: 'withdrawn', basis: made.basis,
    aAssetId: made.aAssetId, bAssetId: made.bAssetId}, 0, operationId, now);
  return 'withdrawn';
}

/** Reviews this device decided and the images those decisions will trash (hidden locally). */
export function queuedSimilarity(intents: Record<string, SimilarityIntent> = readSimilarityIntents()) {
  const reviews = new Set<string>(), trashed = new Set<string>();
  for (const intent of Object.values(intents)) {
    if (intent.decision === 'withdrawn') continue;
    reviews.add(intent.reviewId);
    const trash = trashedBy(intent.decision, intent.aAssetId, intent.bAssetId);
    if (trash) trashed.add(trash);
  }
  return {reviews, trashed};
}

/** The earliest time a queued intent becomes due, or null when nothing waits. */
export function nextSimilarityDue(intents: Record<string, SimilarityIntent> = readSimilarityIntents()): number | null {
  const times = Object.values(intents).map(intent => intent.notBefore);
  return times.length ? Math.min(...times) : null;
}
