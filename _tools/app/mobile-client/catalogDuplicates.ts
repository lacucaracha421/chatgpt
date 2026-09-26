/**
 * Manga Catalog duplicate-edition review: wire types, the durable decision outbox and its
 * delivery (`server/lakomics-api/catalog_duplicates.py`). Modeled on the similarity review
 * outbox, reduced to what the two review actions need:
 *
 * * **One intent per candidate, minted once.** The operation id is created when the user
 *   acts and reused on every transport retry; the server dedups by it.
 * * **A short send delay** (`notBefore`) keeps the snackbar's undo reliable: an intent that
 *   never left the device is simply removed.
 * * **A new action on a queued candidate replaces the intent** and keeps its
 *   `expectedRevision` (the server has not seen the old one). Returning to the decision the
 *   server already holds removes the intent instead.
 * * **Delivery** sends due intents oldest first. A transport failure keeps the intent and
 *   ends the pass; `operationConflict` retries once under a new id; any other refusal
 *   (another device decided first, the candidate is gone) drops it and is reported.
 *
 * The PC applies decisions when it next republishes the catalog; nothing changes locally.
 *
 * The queue is stored per connection (`outboxConnection.ts`): only the current server's
 * decisions are shown and sent, and another server's stay queued until the app connects to
 * it again. The duplicates contract carries no library identity (a candidate is checked by
 * its `expectedRevision` on the server that listed it), so the connection is the scope.
 */

import {apiOn, connectionOutbox, outboxConnection, outboxKey} from './outboxConnection';
import {codeOf, refusedByServer} from './similarityReviewDelivery';

export const DUPLICATES_PATH = '/v1/mobile-catalog/duplicates';
export const DUPLICATE_DECISIONS_PATH = '/v1/mobile-catalog/duplicates/decisions';

/** `keepBoth` = "같은 작품으로 묶기" (the PC merges the editions), `notDuplicate` = "다른 작품". */
export type DuplicateChoice = 'keepBoth' | 'notDuplicate';
export type DuplicateState = 'undecided' | 'decided';
export type DuplicateWork = {
  workId: string; groupId: string | null; title: string; titleJpn: string | null;
  pages: number; category: number; creators: string[]; languages: string[];
};
export type DuplicateCandidate = {
  candidateId: string; provider: string; leftWorkId: string; rightWorkId: string;
  source: 'pc' | 'server'; reason: string; pageGap: number; reasonText: string;
  left: DuplicateWork; right: DuplicateWork; removed: boolean; revision: number;
  decision: {decision: string; hiddenWorkId: string | null} | null;
  decisionRevision: number;
};
export type DuplicateFeed = {
  version: 1; revision: number; pcGeneration: string | null;
  counts: {undecided: number; decided: number};
  items: DuplicateCandidate[]; nextCursor: string | null; hasMore: boolean;
};

export function duplicatesPath(state: DuplicateState, cursor: string | null = null, limit = 20) {
  const query = new URLSearchParams({state, limit: String(limit)});
  if (cursor) query.set('cursor', cursor);
  return `${DUPLICATES_PATH}?${query}`;
}

export type DuplicateIntent = {
  candidateId: string;
  decision: DuplicateChoice;
  /** The decision the server held when the user acted (`null` = undecided). */
  base: string | null;
  expectedRevision: number;
  operationId: string;
  createdAt: number;
  notBefore: number;
};

const INTENTS_KEY = connectionOutbox('lakomics.catalog.duplicates.outbox.v1');
export const DUPLICATE_OUTBOX_LIMIT = 500;
export const DUPLICATE_SEND_DELAY_MS = 4000;
export const DUPLICATE_SAVE_FAILED = '기기에 저장하지 못했습니다.';
export const DUPLICATE_OUTBOX_FULL = '전송을 기다리는 검토가 너무 많아요. 연결된 뒤 다시 시도해 주세요.';
export const DUPLICATE_IN_FLIGHT = '전송 중이에요. 잠시 후 다시 시도해 주세요.';
/** Fired after the durable queue changes, so every screen re-reads it. */
export const DUPLICATE_REVIEW_EVENT = 'lakomics-catalog-duplicates';
/** Fired after the server confirmed or refused a decision (`detail` is the outcome), so an open list re-reads. */
export const DUPLICATE_SETTLED_EVENT = 'lakomics-catalog-duplicates-settled';

function valid(value: unknown): value is DuplicateIntent {
  const intent = value as DuplicateIntent | null;
  return !!intent && typeof intent === 'object' && typeof intent.candidateId === 'string'
    && (intent.decision === 'keepBoth' || intent.decision === 'notDuplicate')
    && (intent.base === null || typeof intent.base === 'string')
    && Number.isSafeInteger(intent.expectedRevision) && typeof intent.operationId === 'string'
    && typeof intent.createdAt === 'number' && typeof intent.notBefore === 'number';
}

/** The current connection's queue (empty while no connection is known). */
export function readDuplicateIntents(): Record<string, DuplicateIntent> {
  try {
    const key = outboxKey(INTENTS_KEY);
    const raw = key === null ? null : localStorage.getItem(key);
    const parsed = raw === null ? null : JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, intent]) => valid(intent))) as Record<string, DuplicateIntent>;
  } catch { return {}; }
}

function write(intents: Record<string, DuplicateIntent>): boolean {
  const key = outboxKey(INTENTS_KEY);
  if (key === null) return false;
  try { localStorage.setItem(key, JSON.stringify(intents)); } catch { return false; }
  try { window.dispatchEvent(new Event(DUPLICATE_REVIEW_EVENT)); } catch { /* No window outside the app. */ }
  return true;
}

const inFlight = new Set<string>();

/**
 * Queue a decision for one candidate, sent after the undo window. Returns the intent, or
 * `null` when the choice equals what the server already holds (any queued change is
 * dropped). Throws {@link DUPLICATE_SAVE_FAILED}, {@link DUPLICATE_OUTBOX_FULL} or
 * {@link DUPLICATE_IN_FLIGHT}.
 */
export function commitDuplicateDecision(candidate: Pick<DuplicateCandidate, 'candidateId' | 'decision' | 'decisionRevision'>,
  decision: DuplicateChoice, operationId: () => string = () => crypto.randomUUID(), now = Date.now()): DuplicateIntent | null {
  const intents = readDuplicateIntents();
  const queued = intents[candidate.candidateId];
  if (queued && inFlight.has(queued.operationId)) throw new Error(DUPLICATE_IN_FLIGHT);
  // A queued change was never seen by the server, so its basis stays the server's state.
  const base = queued ? queued.base : candidate.decision?.decision ?? null;
  const expectedRevision = queued ? queued.expectedRevision : candidate.decisionRevision;
  if (base === decision) {
    if (!queued) return null;
    delete intents[candidate.candidateId];
    if (!write(intents)) throw new Error(DUPLICATE_SAVE_FAILED);
    return null;
  }
  if (!queued && Object.keys(intents).length >= DUPLICATE_OUTBOX_LIMIT) throw new Error(DUPLICATE_OUTBOX_FULL);
  const intent: DuplicateIntent = {candidateId: candidate.candidateId, decision, base, expectedRevision,
    operationId: operationId(), createdAt: now, notBefore: now + DUPLICATE_SEND_DELAY_MS};
  intents[candidate.candidateId] = intent;
  if (!write(intents)) throw new Error(DUPLICATE_SAVE_FAILED);
  return intent;
}

/** Remove a queued intent that has not been sent. False when it was sent or is being sent. */
export function undoDuplicateDecision(made: DuplicateIntent): boolean {
  const intents = readDuplicateIntents();
  if (intents[made.candidateId]?.operationId !== made.operationId || inFlight.has(made.operationId)) return false;
  delete intents[made.candidateId];
  return write(intents);
}

function settle(expected: DuplicateIntent): boolean {
  const intents = readDuplicateIntents();
  if (intents[expected.candidateId]?.operationId !== expected.operationId) return false;
  delete intents[expected.candidateId];
  write(intents);
  return true;
}

/** The earliest time a queued intent becomes due, or null when nothing waits. */
export function nextDuplicateDue(intents: Record<string, DuplicateIntent> = readDuplicateIntents()): number | null {
  const times = Object.values(intents).map(intent => intent.notBefore);
  return times.length ? Math.min(...times) : null;
}

export type DuplicateOutcome = {candidateId: string; outcome: 'confirmed' | 'superseded' | 'rejected'; message?: string};

let running: Promise<DuplicateOutcome[]> | null = null;

/** One send pass over every due intent; concurrent callers share it. Throws on a transport failure. */
export function flushDuplicateDecisions(now: () => number = Date.now): Promise<DuplicateOutcome[]> {
  if (!running) running = pass(now).finally(() => { running = null; });
  return running;
}

async function pass(now: () => number): Promise<DuplicateOutcome[]> {
  const outcomes: DuplicateOutcome[] = [];
  const endpoint = outboxConnection();
  if (!endpoint) return outcomes;
  const due = Object.values(readDuplicateIntents()).filter(intent => intent.notBefore <= now())
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const {candidateId} of due) {
    // The connection changed under this pass: the rest belongs to the old server.
    if (outboxConnection() !== endpoint) break;
    const intent = readDuplicateIntents()[candidateId];
    if (!intent || intent.notBefore > now()) continue;
    const outcome = await deliver(intent, endpoint, 1);
    outcomes.push(outcome);
    try { window.dispatchEvent(new CustomEvent(DUPLICATE_SETTLED_EVENT, {detail: outcome})); } catch { /* No window outside the app. */ }
  }
  return outcomes;
}

function messageOf(error: unknown): string {
  const details = (error as {details?: {detail?: {message?: unknown}}})?.details;
  const message = details?.detail?.message;
  return typeof message === 'string' && message.length <= 180 ? message : '서버가 이 검토를 받지 않았어요.';
}

async function deliver(intent: DuplicateIntent, endpoint: string, attempt: number): Promise<DuplicateOutcome> {
  const candidateId = intent.candidateId;
  inFlight.add(intent.operationId);
  try {
    const receipt = await apiOn<{operationId?: string}>(endpoint, DUPLICATE_DECISIONS_PATH, undefined, {
      version: 1, operationId: intent.operationId, candidateId, decision: intent.decision,
      expectedRevision: intent.expectedRevision,
    });
    if (receipt?.operationId !== intent.operationId) throw new Error('검토 응답을 확인할 수 없어요.');
    return {candidateId, outcome: settle(intent) ? 'confirmed' : 'superseded'};
  } catch (error) {
    if (!refusedByServer(error)) throw error;
    if (codeOf(error) === 'operationConflict' && attempt === 1) {
      const intents = readDuplicateIntents();
      const stored = intents[candidateId];
      if (stored?.operationId !== intent.operationId) return {candidateId, outcome: 'superseded'};
      stored.operationId = crypto.randomUUID();
      if (!write(intents)) throw error;
      inFlight.delete(intent.operationId);
      return deliver(stored, endpoint, attempt + 1);
    }
    // Another device decided first, the candidate is gone, or the request is invalid:
    // resending cannot succeed, so the intent is dropped and the list is re-read.
    return settle(intent) ? {candidateId, outcome: 'rejected', message: messageOf(error)} : {candidateId, outcome: 'superseded'};
  } finally {
    inFlight.delete(intent.operationId);
  }
}
