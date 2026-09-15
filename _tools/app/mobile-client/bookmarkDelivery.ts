/**
 * Sending and confirmation for durable mobile bookmark intents.
 *
 * This is the Android counterpart of the PC B6 flush loop, and it keeps the same
 * protocol decisions B6 proved against the real server:
 *
 * * an intent is sent with the operation id minted when the user acted, and a
 *   transport retry reuses it — a timeout may mean the server committed and only
 *   the response was lost;
 * * a `revisionConflict` never discards the intent. The authority's revision is
 *   recorded and the same intent is retried once under its own operation id, or
 *   completed outright when the authority already holds the desired state, so no
 *   duplicate mutation is issued;
 * * `changed: false` is a confirmation, not a failure.
 *
 * It never enqueues. Only `commitBookmarkIntent` does that, and only the user's
 * action calls it.
 */

import {native} from './transport';
import {
  BOOKMARK_CONTRACT_VERSION,
  type BookmarkAuthority,
  type BookmarkIntent,
  confirmBookmarkIntent,
  readIntents,
  rebaseBookmarkIntent,
} from './bookmarkOutbox';

/** How one intent settled. */
export type DeliveryOutcome = 'confirmed' | 'already-current' | 'superseded' | 'deferred' | 'withheld';

export type DeliveryReport = {
  outcomes: {providerWorkId: string; outcome: DeliveryOutcome}[];
  /** True when the server has not advertised the write capability. */
  authorityUnavailable: boolean;
};

type CommandResult = {
  entityRevision?: number;
  changed?: boolean;
  providerWorkId?: string;
  /** Present when the native bridge unwrapped a recoverable revision conflict. */
  conflict?: {revision?: number; desiredState?: boolean};
};

/**
 * The authority a command may be sent under, or null when no legal send exists.
 *
 * `/status` is the contract's own gate: while the server owns the domain but has
 * not advertised `bookmarkWrite`, nothing may be sent. "Not advertised" and "the
 * domain is still PC-owned" are the same answer here — no traffic — so a queued
 * intent waits rather than being discarded.
 */
async function resolveAuthority(signal?: AbortSignal): Promise<BookmarkAuthority | null> {
  const status = await native<{
    authorityLibraryId?: string | null;
    authorityEpoch?: number | null;
    authorityContractVersion?: number | null;
    capabilities?: {bookmarkWrite?: boolean};
  }>('api', {path: '/v1/mobile-catalog/status', method: 'GET'}, signal);
  if (!status.authorityLibraryId || status.capabilities?.bookmarkWrite !== true) return null;
  const epoch = status.authorityEpoch;
  if (typeof epoch !== 'number' || epoch < 1) return null;
  return {
    libraryId: status.authorityLibraryId,
    epoch,
    contractVersion: typeof status.authorityContractVersion === 'number' ? status.authorityContractVersion : BOOKMARK_CONTRACT_VERSION,
  };
}

/**
 * One send pass over every durable intent, oldest first.
 *
 * Ordering is deterministic so an interrupted pass resumes the same way, and a
 * failure leaves the intent — and everything behind it — durable for the next
 * attempt. The caller decides when to retry; this function never schedules itself.
 */
export async function flushBookmarkIntents(signal?: AbortSignal): Promise<DeliveryReport> {
  const report: DeliveryReport = {outcomes: [], authorityUnavailable: false};
  let authority: BookmarkAuthority | null = null;
  try {
    authority = await resolveAuthority(signal);
  } catch { authority = null; }
  const intents = Object.keys(readIntents())
    .map(key => readIntents()[key])
    .sort((left, right) => left.createdAt - right.createdAt);
  if (!authority) {
    // No legal send. Queued intents stay durable: the capability may be turned on
    // later, and discarding them would lose the user's decision.
    report.authorityUnavailable = true;
    report.outcomes = intents.map(intent => ({providerWorkId: intent.providerWorkId, outcome: 'withheld' as const}));
    return report;
  }
  for (const intent of intents) {
    if (signal?.aborted) break;
    report.outcomes.push({providerWorkId: intent.providerWorkId, outcome: await deliver(intent, authority, 1, signal)});
  }
  return report;
}

/**
 * Send one intent and interpret the answer.
 *
 * `attempt` bounds the conflict retry: a second consecutive conflict means another
 * writer is racing this entity, so the intent is left queued for a later pass
 * rather than thrashing here.
 */
async function deliver(intent: BookmarkIntent, authority: BookmarkAuthority, attempt: number, signal?: AbortSignal): Promise<DeliveryOutcome> {
  // An intent composed under another epoch cannot present a meaningful revision:
  // revisions are only comparable inside one epoch, so it starts at 0 and lets the
  // server's compare-and-set decide.
  const baseRevision = intent.epoch === authority.epoch ? intent.baseRevision : 0;
  try {
    const result = await native<CommandResult>('bookmarkCommand', {
      provider: intent.provider,
      providerWorkId: intent.providerWorkId,
      libraryId: authority.libraryId,
      epoch: authority.epoch,
      contractVersion: authority.contractVersion,
      operationId: intent.operationId,
      expectedRevision: baseRevision,
      desiredState: intent.desired,
    }, signal);
    // A `revisionConflict` is a recoverable state, not a failure: the native
    // bridge reports it as a resolved conflict carrying the authoritative
    // revision, so the same intent can be re-based instead of dropped.
    const reported = conflictOf(result);
    if (reported) return applyConflict(intent, authority, reported, attempt, signal);
    const revision = typeof result?.entityRevision === 'number' ? result.entityRevision : baseRevision;
    // A superseding action may have replaced this row while the request was in
    // flight; then the older response must not clear the newer intent.
    if (!confirmBookmarkIntent(intent, authority.epoch, revision)) return 'superseded';
    return result?.changed === false ? 'already-current' : 'confirmed';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    const conflict = conflictOf(error);
    if (!conflict) {
      // Every other failure — authorization, transport, timeout, rejection — keeps
      // the intent durable for the next pass. Only the surface text differs.
      throw error;
    }
    return applyConflict(intent, authority, conflict, attempt, signal);
  }
}

/**
 * Apply an authoritative revision conflict to a pending intent.
 *
 * When the authority already holds what the user asked for, the intent completes
 * and no second mutation is issued. Otherwise the same intent is re-based onto the
 * reported revision and retried once under its own operation id.
 */
async function applyConflict(
  intent: BookmarkIntent,
  authority: BookmarkAuthority,
  conflict: {revision: number; desiredState: boolean},
  attempt: number,
  signal?: AbortSignal,
): Promise<DeliveryOutcome> {
  if (conflict.desiredState === intent.desired) {
    return confirmBookmarkIntent(intent, authority.epoch, conflict.revision) ? 'already-current' : 'superseded';
  }
  const rebased = rebaseBookmarkIntent(intent, authority.epoch, conflict);
  if (!rebased) return 'superseded';
  // A second consecutive conflict means another writer is racing this entity. The
  // intent stays queued with its identity for a later pass instead of the client
  // thrashing here; nothing replaced it, so it is not reported as superseded.
  if (attempt > 1) return 'deferred';
  return deliver(rebased, authority, attempt + 1, signal);
}

/**
 * The authoritative state reported by a rejected command, from either carrier.
 *
 * The native bridge unwraps a recoverable conflict into `{conflict:{...}}` and
 * returns it as a resolved reply. The raw server body (`detail.code ===
 * "revisionConflict"` with `detail.current`) is also accepted, because an
 * `ApiError` may carry it unchanged. Anything else — a plain 409, an
 * authorization failure — is not a conflict and must stay a hard failure.
 */
function conflictOf(source: unknown): {revision: number; desiredState: boolean} | null {
  const value = source as {
    conflict?: {revision?: unknown; desiredState?: unknown};
    detail?: {code?: unknown; current?: {entityRevision?: unknown; desiredState?: unknown}};
    /** What `ApiError` carries: the native bridge's whole error body. */
    details?: {detail?: {code?: unknown; current?: {entityRevision?: unknown; desiredState?: unknown}}};
  } | undefined;
  const bridge = value?.conflict;
  if (bridge && typeof bridge.revision === 'number') {
    return {revision: bridge.revision, desiredState: bridge.desiredState === true};
  }
  // The body is nested one level deeper when it arrives wrapped in an ApiError.
  const detail = value?.details?.detail ?? value?.detail;
  if (detail?.code !== 'revisionConflict') return null;
  const current = detail.current;
  if (!current || typeof current.entityRevision !== 'number') return null;
  return {revision: current.entityRevision, desiredState: current.desiredState === true};
}
