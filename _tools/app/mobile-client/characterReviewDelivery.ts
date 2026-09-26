/**
 * Sending durable character-review decisions (`characterReviewOutbox.ts`). The protocol
 * follows the Collection edit delivery (`collectionEditDelivery.ts`):
 *
 * * an intent is sent with the operation id minted when the user acted; a transport
 *   failure keeps it queued and the next pass resends the same id;
 * * an `operationConflict` (the id was used for another payload) retries once under a
 *   new id;
 * * a decision that can never succeed (the character or Asset is gone, a protected
 *   reference, another library) is dropped and reported; a pending manual exclusion of the
 *   same pair (`pendingCharacterCorrection`) keeps it queued for a later pass;
 * * a server refusal of one intent does not stop the others; a transport failure ends
 *   the pass, since every other send would fail too;
 * * nothing is sent until the review feed reports `ready` (a PC adopted the feature);
 * * only the current connection's queue is sent (`outboxConnection.ts`), and a decision made
 *   for another library than the one the feed reports (or refused as `libraryMismatch`) stays
 *   queued (`suspended`) instead of being sent or dropped.
 *
 * It never enqueues and never schedules itself.
 */

import {ApiError} from './transport';
import {apiOn, outboxConnection} from './outboxConnection';
import {confirmReviewIntent, readReviewIntents, reissueReviewIntent, type ReviewIntent} from './characterReviewOutbox';
import type {Asset} from './types';

export const REVIEW_PATH = '/v1/library/characters/review';
export const REVIEW_DECISIONS_PATH = '/v1/library/characters/review/decisions';

export type ReviewSource = 's36' | 'b36' | 'doubtful';
export type ReviewCounts = {total: number; s36: number; b36: number; doubtful: number; pendingPc: number; skipped: number};
export type ReviewItem = {targetId: string; assetId: string; sources: ReviewSource[]; verdict: string; knn3: number | null; basis: string; asset: Asset};
export type ReviewTarget = {name: string; seriesId: string; seriesName: string | null; references: Asset[]};
/** One character's exact waiting count (an upgraded server; `name`/`seriesName` only if it sends them). */
export type ReviewTargetCount = {targetId: string; seriesId: string; pending: number; name?: string; seriesName?: string | null};
export type ReviewFeed = {
  version: 1; ready: boolean; libraryId: string | null; revision: string | null; generatedAt: string | null;
  counts: ReviewCounts; items: ReviewItem[]; targets: Record<string, ReviewTarget>;
  nextCursor: string | null; hasMore: boolean;
  /** Exact per-character counts. Its presence also means the route accepts `series=`. */
  countsByTarget?: ReviewTargetCount[];
};
export type ReviewAssetTargets = {version: 1; ready: boolean; assetId: string; targets: {targetId: string; name: string; seriesId: string; seriesName: string | null}[]};

/** `series` only for a server that sends `countsByTarget`: an older one refuses unknown parameters. */
export function reviewPath(params: {target?: string | null; series?: string | null; cursor?: string | null; limit?: number}) {
  const query = new URLSearchParams({limit: String(params.limit ?? 20)});
  if (params.target) query.set('target', params.target);
  if (params.series) query.set('series', params.series);
  if (params.cursor) query.set('cursor', params.cursor);
  return `${REVIEW_PATH}?${query}`;
}

export type ReviewOutcome = 'confirmed' | 'superseded' | 'deferred' | 'withheld' | 'suspended' | 'rejected' | 'failed';
export type ReviewReport = {
  outcomes: {key: string; outcome: ReviewOutcome; message?: string}[];
  /** True when no PC has adopted review yet, so everything waits. */
  unsupported: boolean;
  error?: unknown;
};

/** Why a decision that can never succeed was dropped. */
const REJECTED: Record<string, string> = {
  characterReviewTargetMissing: '캐릭터가 PC에서 삭제되었거나 바뀌어 검토를 반영하지 못했습니다.',
  characterReviewAssetMissing: '자산이 삭제되었거나 아직 서버에 없어 검토를 반영하지 못했습니다.',
  characterReferenceProtected: '기준 이미지로 쓰이는 자산이라 검토를 반영하지 못했습니다.',
  characterReviewOutsideSeries: '이 자산의 시리즈에 속하지 않은 캐릭터라 추가하지 못했습니다.',
  invalidCharacterReviewDecision: '서버가 이 검토를 받지 않았습니다.',
};

const inFlight = new Set<string>();
/** Whether this operation is being sent right now (its outcome is not known yet). */
export const isReviewInFlight = (operationId: string) => inFlight.has(operationId);

let running: Promise<ReviewReport> | null = null;

/** One send pass over every durable intent, oldest first; concurrent callers share it. */
export function flushCharacterReview(signal?: AbortSignal): Promise<ReviewReport> {
  if (!running) running = pass(signal).finally(() => { running = null; });
  return running;
}

async function pass(signal?: AbortSignal): Promise<ReviewReport> {
  const report: ReviewReport = {outcomes: [], unsupported: false};
  const endpoint = outboxConnection();
  const pending = Object.entries(readReviewIntents()).sort(([, a], [, b]) => a.createdAt - b.createdAt);
  if (!endpoint || !pending.length) return report;
  const feed = await apiOn<ReviewFeed>(endpoint, reviewPath({limit: 1}), signal);
  if (feed?.ready !== true) {
    report.unsupported = true;
    report.outcomes = pending.map(([key]) => ({key, outcome: 'withheld' as const}));
    return report;
  }
  for (const [key] of pending) {
    // The connection changed under this pass: the rest belongs to the old server.
    if (signal?.aborted || outboxConnection() !== endpoint) break;
    const intent = readReviewIntents()[key];
    if (!intent) continue;
    if (feed.libraryId && intent.libraryId !== feed.libraryId) { report.outcomes.push({key, outcome: 'suspended'}); continue; }
    try {
      const outcome = await deliver(intent, endpoint, 1, signal);
      report.outcomes.push(typeof outcome === 'string' ? {key, outcome} : {key, ...outcome});
    } catch (error) {
      if (!refusedByServer(error)) throw error;
      report.outcomes.push({key, outcome: 'failed'});
      report.error ??= error;
    }
  }
  return report;
}

function refusedByServer(error: unknown): boolean {
  return error instanceof ApiError && error.status !== null && error.status >= 400 && error.status < 500
    && ![401, 403, 408, 429].includes(error.status);
}

function codeOf(error: unknown): string | null {
  const value = error as {details?: {detail?: {code?: unknown}; code?: unknown}} | undefined;
  const code = value?.details?.detail?.code ?? value?.details?.code;
  return typeof code === 'string' ? code : null;
}

type Delivered = ReviewOutcome | {outcome: 'rejected'; message: string};

async function deliver(intent: ReviewIntent, endpoint: string, attempt: number, signal?: AbortSignal): Promise<Delivered> {
  inFlight.add(intent.operationId);
  try {
    const receipt = await apiOn<{operationId?: string}>(endpoint, REVIEW_DECISIONS_PATH, signal, {
      version: 1,
      libraryId: intent.libraryId,
      operationId: intent.operationId,
      targetId: intent.targetId,
      assetId: intent.assetId,
      decision: intent.decision,
      origin: intent.origin,
      basis: intent.basis,
    });
    if (receipt?.operationId !== intent.operationId) throw new Error('검토 응답을 확인할 수 없습니다.');
    return confirmReviewIntent(intent) ? 'confirmed' : 'superseded';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const code = codeOf(error);
    if (code && code in REJECTED) return confirmReviewIntent(intent) ? {outcome: 'rejected', message: REJECTED[code]} : 'superseded';
    if (code === 'pendingCharacterCorrection') return 'deferred';
    // Another library than the decision's: kept for when the server reports it again.
    if (code === 'libraryMismatch') return 'suspended';
    if (code === 'operationConflict') {
      const reissued = reissueReviewIntent(intent);
      if (!reissued) return 'superseded';
      if (attempt > 1) return 'deferred';
      inFlight.delete(intent.operationId);
      return deliver(reissued, endpoint, attempt + 1, signal);
    }
    throw error;
  } finally {
    inFlight.delete(intent.operationId);
  }
}
