/**
 * Durable mobile character-review decisions ("맞음" / "아님" / undo), modeled on the
 * personal Collection edit outbox (`collectionEditOutbox.ts`):
 *
 * 1. **One intent per `targetId:assetId` pair, minted once.** The operation id is created
 *    when the user acts and reused on every transport retry, because a timeout may mean the
 *    server recorded the decision and only the response was lost.
 * 2. **A new action on the same pair replaces the queued intent under a new id.**
 * 3. **Removed on a matching receipt.** A receipt for a replaced id is ignored.
 * 4. **Undo:** an intent that was never sent is simply removed; a decision the server may
 *    already hold is followed by a `cleared` intent under a new operation id.
 *
 * At most {@link REVIEW_OUTBOX_LIMIT} pairs wait at once. Committing throws when the device
 * cannot store the decision, so the screen never shows an unsaved decision as queued.
 */

export type ReviewDecision = 'accepted' | 'rejected' | 'cleared';
export type ReviewOrigin = 'feed' | 'viewer';

export type ReviewIntent = {
  libraryId: string;
  targetId: string;
  assetId: string;
  decision: ReviewDecision;
  origin: ReviewOrigin;
  /** The PC's opaque basis for a feed item (echoed to the PC), or null. */
  basis: string | null;
  operationId: string;
  createdAt: number;
};

const INTENTS_KEY = 'lakomics.characters.review.outbox.v1';
export const REVIEW_OUTBOX_LIMIT = 500;
export const REVIEW_SAVE_FAILED = '기기에 저장하지 못했습니다.';
export const REVIEW_OUTBOX_FULL = '전송을 기다리는 검토가 너무 많습니다. 연결된 뒤 다시 시도해 주세요.';
/** Fired after the durable queue changes, so every screen re-reads it. */
export const CHARACTER_REVIEW_EVENT = 'lakomics-character-review';

export const reviewPairKey = (targetId: string, assetId: string) => `${targetId}:${assetId}`;

function valid(value: unknown): value is ReviewIntent {
  const intent = value as ReviewIntent | null;
  return !!intent && typeof intent === 'object' && typeof intent.libraryId === 'string' && typeof intent.targetId === 'string'
    && typeof intent.assetId === 'string' && typeof intent.operationId === 'string' && typeof intent.createdAt === 'number'
    && (intent.decision === 'accepted' || intent.decision === 'rejected' || intent.decision === 'cleared')
    && (intent.origin === 'feed' || intent.origin === 'viewer') && (intent.basis === null || typeof intent.basis === 'string');
}

export function readReviewIntents(): Record<string, ReviewIntent> {
  try {
    const raw = localStorage.getItem(INTENTS_KEY);
    const parsed = raw === null ? null : JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, intent]) => valid(intent))) as Record<string, ReviewIntent>;
  } catch { return {}; }
}

/** Persist the queue; false when storage refused it (the stored queue is unchanged). */
function write(intents: Record<string, ReviewIntent>): boolean {
  try { localStorage.setItem(INTENTS_KEY, JSON.stringify(intents)); } catch { return false; }
  try { window.dispatchEvent(new Event(CHARACTER_REVIEW_EVENT)); } catch { /* No window outside the app. */ }
  return true;
}

/**
 * Queue the user's decision for one pair. Throws {@link REVIEW_SAVE_FAILED} when storage
 * refused it and {@link REVIEW_OUTBOX_FULL} when too many pairs already wait.
 */
export function commitReviewDecision(
  decision: Omit<ReviewIntent, 'operationId' | 'createdAt'>,
  operationId: () => string = () => crypto.randomUUID(),
): ReviewIntent {
  const intents = readReviewIntents();
  const key = reviewPairKey(decision.targetId, decision.assetId);
  if (!intents[key] && Object.keys(intents).length >= REVIEW_OUTBOX_LIMIT) throw new Error(REVIEW_OUTBOX_FULL);
  const intent: ReviewIntent = {...decision, operationId: operationId(), createdAt: intents[key]?.createdAt ?? Date.now()};
  intents[key] = intent;
  if (!write(intents)) throw new Error(REVIEW_SAVE_FAILED);
  return intent;
}

/** Remove an intent the server confirmed (or refused for good), unless a newer action replaced it. */
export function confirmReviewIntent(expected: ReviewIntent): boolean {
  const intents = readReviewIntents();
  const key = reviewPairKey(expected.targetId, expected.assetId);
  if (intents[key]?.operationId !== expected.operationId) return false;
  delete intents[key];
  write(intents);
  return true;
}

/** A new operation id for an unchanged payload, after the server refused the old id. */
export function reissueReviewIntent(expected: ReviewIntent, operationId: () => string = () => crypto.randomUUID()): ReviewIntent | null {
  const intents = readReviewIntents();
  const key = reviewPairKey(expected.targetId, expected.assetId);
  const stored = intents[key];
  if (!stored || stored.operationId !== expected.operationId) return null;
  stored.operationId = operationId();
  return write(intents) ? stored : null;
}

/**
 * Undo one decision the user made. `inFlight` says whether that operation is being sent
 * right now (its outcome is unknown, so it must be treated as possibly recorded).
 * Returns `removed` when nothing ever left the device, `cleared` when a `cleared` intent
 * was queued. Throws like {@link commitReviewDecision}.
 */
export function undoReviewDecision(
  made: Pick<ReviewIntent, 'libraryId' | 'targetId' | 'assetId' | 'operationId' | 'origin'>,
  inFlight: (operationId: string) => boolean = () => false,
  operationId: () => string = () => crypto.randomUUID(),
): 'removed' | 'cleared' {
  const intents = readReviewIntents();
  const key = reviewPairKey(made.targetId, made.assetId);
  if (intents[key]?.operationId === made.operationId && !inFlight(made.operationId)) {
    delete intents[key];
    if (!write(intents)) throw new Error(REVIEW_SAVE_FAILED);
    return 'removed';
  }
  commitReviewDecision({libraryId: made.libraryId, targetId: made.targetId, assetId: made.assetId,
    decision: 'cleared', origin: made.origin, basis: null}, operationId);
  return 'cleared';
}

/** Pairs this device decided but the server has not confirmed yet ("cleared" does not hide). */
export function queuedReviewPairs(intents: Record<string, ReviewIntent> = readReviewIntents()): Set<string> {
  return new Set(Object.entries(intents).filter(([, intent]) => intent.decision !== 'cleared').map(([key]) => key));
}
