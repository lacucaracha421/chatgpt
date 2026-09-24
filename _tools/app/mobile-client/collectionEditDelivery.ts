/**
 * Sending durable personal Collection edits (`collectionEditOutbox.ts`).
 *
 * The protocol decisions are the bookmark delivery's (`bookmarkDelivery.ts`):
 *
 * * an intent is sent with the operation id minted when the user acted; a
 *   transport failure keeps it queued and the next pass resends the same id;
 * * `changed: false` is a confirmation, not a failure;
 * * a `collectionPersonalConflict` never silently drops an intent. Rating and
 *   Showcase adopt the server's `current` as `expected` and retry once under the
 *   same id; a memo is parked for the user unless `current` is already the draft
 *   or one of this device's own earlier values;
 * * nothing is sent until `/v1/collections/status` advertises
 *   `collectionPersonalEdit`.
 *
 * It never enqueues and never schedules itself.
 */

import {api} from './transport';
import {
  type CollectionEditIntent,
  type CollectionEditValue,
  confirmCollectionEdit,
  markCollectionEditConflict,
  readCollectionEdits,
  rebaseCollectionEdit,
} from './collectionEditOutbox';

export const PERSONAL_EDIT_PATH = '/v1/collections/personal-edits';

export type CollectionEditOutcome = 'confirmed' | 'already-current' | 'superseded' | 'deferred' | 'withheld' | 'conflict' | 'rejected';

export type CollectionEditReport = {
  outcomes: {key: string; outcome: CollectionEditOutcome}[];
  /** True when the server has not advertised the capability. */
  unsupported: boolean;
};

export type CollectionEditStatus = {
  revision?: string | null;
  libraryId?: string | null;
  capabilities?: {collectionPersonalEdit?: boolean};
};

/** The library id edits may be sent under, or null when no send is legal. */
export function personalEditLibrary(status: CollectionEditStatus | null | undefined): string | null {
  return status?.capabilities?.collectionPersonalEdit === true && typeof status.libraryId === 'string' && status.libraryId ? status.libraryId : null;
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
  const pending = Object.entries(readCollectionEdits()).sort(([, a], [, b]) => a.createdAt - b.createdAt);
  if (!pending.length) return report;
  const libraryId = personalEditLibrary(await api<CollectionEditStatus>('/v1/collections/status', signal));
  if (!libraryId) {
    // Queued edits wait: the server or PC may be upgraded later.
    report.unsupported = true;
    report.outcomes = pending.map(([key]) => ({key, outcome: 'withheld' as const}));
    return report;
  }
  for (const [key] of pending) {
    if (signal?.aborted) break;
    // Re-read: an earlier send or a user action may have changed this row.
    const intent = readCollectionEdits()[key];
    if (!intent) continue;
    if (intent.conflict) { report.outcomes.push({key, outcome: 'conflict'}); continue; }
    report.outcomes.push({key, outcome: await deliver(intent, libraryId, 1, signal)});
  }
  return report;
}

type Receipt = {operationId?: string; changed?: boolean};

async function deliver(intent: CollectionEditIntent, libraryId: string, attempt: number, signal?: AbortSignal): Promise<CollectionEditOutcome> {
  try {
    const receipt = await api<Receipt>(PERSONAL_EDIT_PATH, signal, {
      version: 1,
      libraryId,
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
      return conflict(intent, libraryId, detail.current as CollectionEditValue, attempt, signal);
    }
    // A deleted Collection or a malformed edit can never succeed: drop it rather
    // than retrying forever. Everything else stays queued for the next pass.
    if (detail?.code === 'collectionNotFound' || detail?.code === 'invalidCollectionPersonalEdit') {
      return confirmCollectionEdit(intent) ? 'rejected' : 'superseded';
    }
    throw error;
  }
}

async function conflict(intent: CollectionEditIntent, libraryId: string, current: CollectionEditValue, attempt: number, signal?: AbortSignal): Promise<CollectionEditOutcome> {
  if (current === intent.value) return confirmCollectionEdit(intent) ? 'already-current' : 'superseded';
  // A memo is only rebased when `current` is this device's own earlier value.
  if (intent.field === 'memo' && !intent.own.includes(current)) {
    return markCollectionEditConflict(intent, current) ? 'conflict' : 'superseded';
  }
  const rebased = rebaseCollectionEdit(intent, current);
  if (!rebased) return 'superseded';
  // A second consecutive conflict means another writer is racing; wait for a later pass.
  if (attempt > 1) return 'deferred';
  return deliver(rebased, libraryId, attempt + 1, signal);
}

/** The server's structured `detail`, from a raw body or an `ApiError` wrapper. */
function detailOf(source: unknown): {code?: unknown; current?: unknown} | null {
  const value = source as {detail?: unknown; details?: {detail?: unknown}} | undefined;
  const detail = value?.details?.detail ?? value?.detail;
  return detail && typeof detail === 'object' ? detail as {code?: unknown; current?: unknown} : null;
}
