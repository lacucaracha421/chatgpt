/**
 * Sending durable personal Collection edits (`collectionEditOutbox.ts`).
 *
 * The protocol decisions are the bookmark delivery's (`bookmarkDelivery.ts`):
 *
 * * an intent is sent with the operation id minted when the user acted; a
 *   transport failure keeps it queued and the next pass resends the same id;
 * * `changed: false` is a confirmation, not a failure;
 * * a `collectionPersonalConflict` never silently drops an intent. Rating and
 *   Showcase adopt the server's `current` as `expected` and retry once under a
 *   new id (the payload changed); a memo is parked for the user unless `current`
 *   is already the draft or one of this device's own earlier values;
 * * an `operationConflict` (the id was used for another payload) retries once
 *   under a new id;
 * * a server refusal of one intent does not stop the others in the same pass; a
 *   transport failure ends the pass, since every other send would fail too;
 * * nothing is sent until `/v1/collections/status` advertises
 *   `collectionPersonalEdit`; 신간 알림 and owned-volume edits also wait for
 *   `collectionTrackingEdit` (a PC that publishes personal-edit version 2);
 * * 신간 알림 / owned volumes resolve a `collectionPersonalConflict` like a rating
 *   (adopt `current`, retry once); a Collection that cannot be tracked, or 신간 알림
 *   without an Aladin/Kakao binding, is dropped with a short message;
 * * only the current connection's queue is sent (`outboxConnection.ts`), each intent
 *   under the library it was composed against — never the server's current one. An
 *   intent for another library stays queued (`suspended`) until the server reports its
 *   library again. An intent queued before library identity was recorded is bound once to
 *   the library its own connection reports on the first pass after the upgrade.
 *
 * It never enqueues and never schedules itself.
 */

import {ApiError} from './transport';
import {apiOn, outboxConnection} from './outboxConnection';
import {
  type CollectionEditIntent,
  type CollectionEditValue,
  bindCollectionEditLibrary,
  confirmCollectionEdit,
  markCollectionEditConflict,
  sameEditValue,
  TRACKING_FIELDS,
  readCollectionEdits,
  rebaseCollectionEdit,
  reissueCollectionEdit,
} from './collectionEditOutbox';

export const PERSONAL_EDIT_PATH = '/v1/collections/personal-edits';

export type CollectionEditOutcome = 'confirmed' | 'already-current' | 'superseded' | 'deferred' | 'withheld' | 'suspended' | 'conflict' | 'rejected' | 'failed';

export type CollectionEditReport = {
  /** `message` explains a `rejected` (dropped) edit to the user. */
  outcomes: {key: string; outcome: CollectionEditOutcome; message?: string}[];
  /** True when the server has not advertised the capability. */
  unsupported: boolean;
  /** The first server refusal that kept an intent queued (`failed`), if any. */
  error?: unknown;
};

/** Why an edit that can never succeed was dropped. */
const REJECTED = new Map<unknown, string>([
  ['collectionNotFound', 'PC에서 삭제되었거나 게시되지 않은 작품이라 변경을 반영하지 못했습니다.'],
  ['invalidCollectionPersonalEdit', '서버가 이 변경을 받지 않아 되돌렸습니다.'],
  ['collectionTrackingUnavailable', '이 작품은 신간 알림과 소장 권수를 바꿀 수 없어 되돌렸습니다.'],
  ['releaseWatchUnavailable', '알라딘이나 카카오와 연결된 만화만 신간 알림을 켤 수 있어 되돌렸습니다.'],
]);

export type CollectionEditStatus = {
  revision?: string | null;
  libraryId?: string | null;
  capabilities?: {collectionPersonalEdit?: boolean; collectionTrackingEdit?: boolean};
};

/** The library id edits may be sent under, or null when no send is legal. */
export function personalEditLibrary(status: CollectionEditStatus | null | undefined): string | null {
  return status?.capabilities?.collectionPersonalEdit === true && typeof status.libraryId === 'string' && status.libraryId ? status.libraryId : null;
}

/** Whether 신간 알림 / owned-volume edits may be sent (a version-2 PC published). */
export function trackingEditAllowed(status: CollectionEditStatus | null | undefined): boolean {
  return personalEditLibrary(status) !== null && status?.capabilities?.collectionTrackingEdit === true;
}

let running: Promise<CollectionEditReport> | null = null;

/**
 * One send pass over every durable intent, oldest first. Concurrent callers share
 * the pass in flight, so the app-level and Collection-screen triggers never send
 * the same intent twice at once.
 */
export function flushCollectionEdits(signal?: AbortSignal): Promise<CollectionEditReport> {
  if (!running) running = pass(signal).finally(() => { running = null; });
  return running;
}

async function pass(signal?: AbortSignal): Promise<CollectionEditReport> {
  const report: CollectionEditReport = {outcomes: [], unsupported: false};
  const endpoint = outboxConnection();
  const pending = Object.entries(readCollectionEdits()).sort(([, a], [, b]) => a.createdAt - b.createdAt);
  if (!endpoint || !pending.length) return report;
  const status = await apiOn<CollectionEditStatus>(endpoint, '/v1/collections/status', signal);
  const libraryId = personalEditLibrary(status);
  const tracking = trackingEditAllowed(status);
  if (!libraryId) {
    // Queued edits wait: the server or PC may be upgraded later.
    report.unsupported = true;
    report.outcomes = pending.map(([key]) => ({key, outcome: 'withheld' as const}));
    return report;
  }
  for (const [key] of pending) {
    // The connection changed under this pass: the rest belongs to the old server.
    if (signal?.aborted || outboxConnection() !== endpoint) break;
    // Re-read: an earlier send or a user action may have changed this row.
    let intent: CollectionEditIntent | null | undefined = readCollectionEdits()[key];
    if (!intent) continue;
    if (intent.libraryId === null) intent = bindCollectionEditLibrary(intent, libraryId);
    if (!intent) continue;
    // Composed against another library: kept, never re-pointed at this one.
    if (intent.libraryId !== libraryId) { report.outcomes.push({key, outcome: 'suspended'}); continue; }
    if (intent.conflict) { report.outcomes.push({key, outcome: 'conflict'}); continue; }
    // A tracking edit waits, still queued, until the PC is upgraded again.
    if (!tracking && TRACKING_FIELDS.includes(intent.field)) { report.outcomes.push({key, outcome: 'withheld'}); continue; }
    try {
      const outcome = await deliver(intent, endpoint, 1, signal);
      report.outcomes.push(typeof outcome === 'string' ? {key, outcome} : {key, ...outcome});
    } catch (error) {
      if (!refusedByServer(error)) throw error;
      // This intent stays queued; the others still get their send.
      report.outcomes.push({key, outcome: 'failed'});
      report.error ??= error;
    }
  }
  return report;
}

/**
 * A server answer about this one command. Transport failures, timeouts and
 * account-wide answers (401/403/408/429, 5xx) end the pass instead.
 */
function refusedByServer(error: unknown): boolean {
  return error instanceof ApiError && error.status !== null && error.status >= 400 && error.status < 500
    && ![401, 403, 408, 429].includes(error.status);
}

type Receipt = {operationId?: string; changed?: boolean};

type Delivered = CollectionEditOutcome | {outcome: 'rejected'; message: string};

async function deliver(intent: CollectionEditIntent, endpoint: string, attempt: number, signal?: AbortSignal): Promise<Delivered> {
  try {
    const receipt = await apiOn<Receipt>(endpoint, PERSONAL_EDIT_PATH, signal, {
      version: 1,
      libraryId: intent.libraryId,
      operationId: intent.operationId,
      collectionId: intent.collectionId,
      field: intent.field,
      value: intent.value,
      expected: intent.expected,
    });
    if (!confirmCollectionEdit(intent)) return 'superseded';
    return receipt?.changed === false ? 'already-current' : 'confirmed';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const detail = detailOf(error);
    if (detail?.code === 'collectionPersonalConflict' && 'current' in detail) {
      return conflict(intent, endpoint, detail.current as CollectionEditValue, attempt, signal);
    }
    // A deleted Collection or a malformed edit can never succeed: drop it rather
    // than retrying forever. Everything else stays queued for the next pass.
    const rejected = REJECTED.get(detail?.code);
    if (rejected) return confirmCollectionEdit(intent) ? {outcome: 'rejected', message: rejected} : 'superseded';
    if (detail?.code === 'operationConflict') {
      const reissued = reissueCollectionEdit(intent);
      if (!reissued) return 'superseded';
      if (attempt > 1) return 'deferred';
      return deliver(reissued, endpoint, attempt + 1, signal);
    }
    throw error;
  }
}

async function conflict(intent: CollectionEditIntent, endpoint: string, current: CollectionEditValue, attempt: number, signal?: AbortSignal): Promise<Delivered> {
  if (sameEditValue(current, intent.value)) return confirmCollectionEdit(intent) ? 'already-current' : 'superseded';
  // A memo is only rebased when `current` is this device's own earlier value.
  if (intent.field === 'memo' && !intent.own.includes(current)) {
    return markCollectionEditConflict(intent, current) ? 'conflict' : 'superseded';
  }
  const rebased = rebaseCollectionEdit(intent, current);
  if (!rebased) return 'superseded';
  // A second consecutive conflict means another writer is racing; wait for a later pass.
  if (attempt > 1) return 'deferred';
  return deliver(rebased, endpoint, attempt + 1, signal);
}

/** The server's structured `detail`, from a raw body or an `ApiError` wrapper. */
function detailOf(source: unknown): {code?: unknown; current?: unknown} | null {
  const value = source as {detail?: unknown; details?: {detail?: unknown}} | undefined;
  const detail = value?.details?.detail ?? value?.detail;
  return detail && typeof detail === 'object' ? detail as {code?: unknown; current?: unknown} : null;
}
