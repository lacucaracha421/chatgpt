/**
 * Sending durable similarity-review decisions (`similarityReviewOutbox.ts`). The protocol
 * follows `characterReviewDelivery.ts`:
 *
 * * only intents past their undo window (`notBefore`) are sent, oldest first;
 * * an intent is sent with the operation id minted when the user acted; a transport
 *   failure keeps it queued and ends the pass;
 * * an `operationConflict` retries once under a new id;
 * * a decision that can never succeed (the pair is gone or changed, another library) is
 *   dropped and reported; a pending decision elsewhere keeps it queued for a later pass;
 * * nothing is sent until the review queue reports `ready` (a PC adopted the feature).
 *
 * It never enqueues and never schedules itself.
 */

import {api, ApiError} from './transport';
import {confirmSimilarityIntent, readSimilarityIntents, reissueSimilarityIntent, type SimilarityChoice, type SimilarityIntent} from './similarityReviewOutbox';
import type {Asset} from './types';

export const SIMILARITY_PATH = '/v1/library/similarity/review';
export const SIMILARITY_DECISIONS_PATH = '/v1/library/similarity/review/decisions';

export type SimilarityCounts = {open: number; pendingPc: number; skipped: number};
export type SimilaritySide = {
  assetId: string; sha256: string; width: number | null; height: number | null; byteSize: number | null;
  format: string; sourceLabel: string | null; collectedAt: string | null; classifications: string[]; asset: Asset;
};
export type SimilarityItem = {
  reviewId: string; kind: 'historical'; distance: number;
  recommendedAssetId: string | null; recommendation: Exclude<SimilarityChoice, 'keep_both'> | null;
  a: SimilaritySide; b: SimilaritySide;
};
export type SimilarityFeed = {
  version: 1; ready: boolean; libraryId: string | null; revision: string | null; generatedAt: string | null;
  counts: SimilarityCounts; items: SimilarityItem[]; nextCursor: string | null; hasMore: boolean;
};

export function similarityPath(params: {cursor?: string | null; limit?: number}) {
  const query = new URLSearchParams({limit: String(params.limit ?? 20)});
  if (params.cursor) query.set('cursor', params.cursor);
  return `${SIMILARITY_PATH}?${query}`;
}

export type SimilarityOutcome = 'confirmed' | 'superseded' | 'deferred' | 'withheld' | 'rejected' | 'failed';
export type SimilarityReport = {
  outcomes: {key: string; outcome: SimilarityOutcome; message?: string}[];
  /** True when no PC has adopted similarity review yet, so everything waits. */
  unsupported: boolean;
  error?: unknown;
};

/** Why a decision that can never succeed was dropped. */
const REJECTED: Record<string, string> = {
  similarityReviewMissing: 'PC에서 이미 정리된 검토라 반영하지 못했습니다.',
  similarityAssetChanged: '이미지가 바뀌었거나 정리되어 검토를 반영하지 못했습니다.',
  similarityDecisionApplied: 'PC가 이미 반영했습니다. 휴지통에서 복원해 주세요.',
  libraryMismatch: '다른 라이브러리에 연결되어 검토를 반영하지 못했습니다.',
  invalidSimilarityReviewDecision: '서버가 이 검토를 받지 않았습니다.',
};
/** Already true on the server: nothing left to send. */
const SETTLED = new Set(['similarityDecisionWithdrawn']);
/** Waits for the PC to apply or for a withdrawal to arrive first. */
const DEFERRED = new Set(['pendingSimilarityDecision', 'similarityAssetPendingTrash']);

const inFlight = new Set<string>();
/** Whether this operation is being sent right now (its outcome is not known yet). */
export const isSimilarityInFlight = (operationId: string) => inFlight.has(operationId);

let running: Promise<SimilarityReport> | null = null;

/** One send pass over every due intent; concurrent callers share it. */
export function flushSimilarityReview(signal?: AbortSignal, now: () => number = Date.now): Promise<SimilarityReport> {
  if (!running) running = pass(signal, now).finally(() => { running = null; });
  return running;
}

async function pass(signal: AbortSignal | undefined, now: () => number): Promise<SimilarityReport> {
  const report: SimilarityReport = {outcomes: [], unsupported: false};
  const at = now();
  const pending = Object.entries(readSimilarityIntents()).filter(([, intent]) => intent.notBefore <= at)
    .sort(([, a], [, b]) => a.createdAt - b.createdAt || (a.decision === 'withdrawn' ? -1 : 1));
  if (!pending.length) return report;
  const feed = await api<SimilarityFeed>(similarityPath({limit: 1}), signal);
  if (feed?.ready !== true) {
    report.unsupported = true;
    report.outcomes = pending.map(([key]) => ({key, outcome: 'withheld' as const}));
    return report;
  }
  for (const [key] of pending) {
    if (signal?.aborted) break;
    const intent = readSimilarityIntents()[key];
    if (!intent || intent.notBefore > now()) continue;
    try {
      const outcome = await deliver(intent, 1, signal);
      report.outcomes.push(typeof outcome === 'string' ? {key, outcome} : {key, ...outcome});
    } catch (error) {
      if (!refusedByServer(error)) throw error;
      report.outcomes.push({key, outcome: 'failed'});
      report.error ??= error;
    }
  }
  return report;
}

/** A 4xx the server will refuse again on retry (not auth, timeout or rate limit). Shared with other outboxes. */
export function refusedByServer(error: unknown): boolean {
  return error instanceof ApiError && error.status !== null && error.status >= 400 && error.status < 500
    && ![401, 403, 408, 429].includes(error.status);
}

/** The `{detail: {code}}` error code of a refused request. */
export function codeOf(error: unknown): string | null {
  const value = error as {details?: {detail?: {code?: unknown}; code?: unknown}} | undefined;
  const code = value?.details?.detail?.code ?? value?.details?.code;
  return typeof code === 'string' ? code : null;
}

type Delivered = SimilarityOutcome | {outcome: 'rejected'; message: string};

async function deliver(intent: SimilarityIntent, attempt: number, signal?: AbortSignal): Promise<Delivered> {
  inFlight.add(intent.operationId);
  try {
    const receipt = await api<{operationId?: string}>(SIMILARITY_DECISIONS_PATH, signal, {
      version: 1,
      libraryId: intent.libraryId,
      operationId: intent.operationId,
      reviewId: intent.reviewId,
      decision: intent.decision,
      basis: intent.basis,
    });
    if (receipt?.operationId !== intent.operationId) throw new Error('검토 응답을 확인할 수 없습니다.');
    return confirmSimilarityIntent(intent) ? 'confirmed' : 'superseded';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const code = codeOf(error);
    if (code && SETTLED.has(code)) return confirmSimilarityIntent(intent) ? 'confirmed' : 'superseded';
    if (code && code in REJECTED) return confirmSimilarityIntent(intent) ? {outcome: 'rejected', message: REJECTED[code]} : 'superseded';
    if (code && DEFERRED.has(code)) return 'deferred';
    if (code === 'operationConflict') {
      const reissued = reissueSimilarityIntent(intent);
      if (!reissued) return 'superseded';
      if (attempt > 1) return 'deferred';
      inFlight.delete(intent.operationId);
      return deliver(reissued, attempt + 1, signal);
    }
    throw error;
  } finally {
    inFlight.delete(intent.operationId);
  }
}
