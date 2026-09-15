/**
 * Durable mobile bookmark intents — the Android half of the write pilot.
 *
 * Direction: `mobile bookmark mutation → durable intent → B4 command → confirmed`.
 *
 * The protocol semantics are the ones B6 proved on the PC; only the storage is
 * different. Android has no SQLite database, so an intent lives in the same
 * `localStorage` store the catalog refresh already uses for its durable request,
 * and the same durability rules apply:
 *
 * 1. **One logical intent per work, minted once.** The operation id is created
 *    when the user's mutation is accepted and is reused on every transport
 *    retry. A timeout may mean the server committed and only the response was
 *    lost, so generating a new id on retry would duplicate a logical write.
 * 2. **The visible intent and its durable record commit together.** Both are
 *    written before any HTTP attempt, so a crash cannot leave the user's action
 *    visible with nothing queued, nor queue work for an action that never landed.
 * 3. **Confirmation is durable.** A completed intent is removed from storage in
 *    the same step that records the authoritative revision, so a restart cannot
 *    revive it.
 *
 * Nothing here enqueues from a replica read or a reconciliation pass. Only
 * {@link commitBookmarkIntent} writes an intent, and only user actions call it.
 */

export type BookmarkIntent = {
  provider: 'kHentai';
  providerWorkId: string;
  desired: boolean;
  operationId: string;
  /** `expectedRevision`, composed from the authoritative revision last observed. */
  baseRevision: number;
  epoch: number;
  libraryId: string;
  contractVersion: number;
  createdAt: number;
};

/** The authoritative revision/state this client last observed for one work. */
export type ConfirmedBookmark = { revision: number; desired: boolean; epoch: number };

/** Authority identity a command is composed against. */
export type BookmarkAuthority = { libraryId: string; epoch: number; contractVersion: number };

const INTENTS_KEY = 'lakomics.catalog.bookmarks.outbox.v1';
const CONFIRMED_KEY = 'lakomics.catalog.bookmarks.confirmed.v1';
export const BOOKMARK_CONTRACT_VERSION = 1;

/** Provider-qualified key: two providers must not collide on the same id text. */
export function bookmarkEntityKey(provider: string, providerWorkId: string): string {
  return `${provider}:${providerWorkId}`;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null ? fallback : parsed as T;
  } catch { return fallback; }
}

function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage may be unavailable; the caller keeps the change in memory. */ }
}

/**
 * Every unresolved intent, keyed by provider-qualified work identity.
 *
 * The server keys receipts by operation id and rejects an id reused with a
 * different payload, so a superseding user action must take a fresh operation id.
 * One row per entity is what makes "supersede" well defined.
 */
export function readIntents(): Record<string, BookmarkIntent> {
  const stored = readJson<Record<string, BookmarkIntent>>(INTENTS_KEY, {});
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

/** The unresolved intent for one work, or null. */
export function readIntent(provider: string, providerWorkId: string): BookmarkIntent | null {
  return readIntents()[bookmarkEntityKey(provider, providerWorkId)] ?? null;
}

/** Authoritative revisions this client has observed, keyed by work identity. */
export function readConfirmed(): Record<string, ConfirmedBookmark> {
  const stored = readJson<Record<string, ConfirmedBookmark>>(CONFIRMED_KEY, {});
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

/**
 * Record the authoritative revision/state this client just observed.
 *
 * Called only from server-owned data (a work detail read, a command result), so
 * the next local mutation composes its `expectedRevision` from truth. A later
 * observation inside the same epoch never rewinds it: an older replica read must
 * not lower the revision a queued intent will present.
 */
export function recordConfirmed(provider: string, providerWorkId: string, epoch: number, revision: number, desired: boolean): void {
  if (!Number.isInteger(revision) || revision < 0 || !Number.isInteger(epoch) || epoch < 1) return;
  const all = readConfirmed();
  const key = bookmarkEntityKey(provider, providerWorkId);
  const existing = all[key];
  // A revision only means anything inside one epoch, so an observation from a
  // different epoch replaces it and an older observation in the same epoch is
  // ignored. Either way an older replica read cannot lower the base a queued
  // intent will present.
  if (existing && existing.epoch === epoch && existing.revision > revision) return;
  all[key] = { revision, desired, epoch };
  writeJson(CONFIRMED_KEY, all);
}

/**
 * Commit a user bookmark action: the durable intent and the visible state are the
 * same write, so they cannot diverge.
 *
 * A repeated action asking for the state the user already asked for is not a new
 * intent — it keeps the existing operation id, because re-sending the same
 * logical mutation must stay idempotent. Asking for the *opposite* state is a new
 * logical intent, which supersedes the old one with a fresh operation id; the old
 * operation's late response can then no longer match the row and is discarded.
 */
export function commitBookmarkIntent(
  provider: 'kHentai',
  providerWorkId: string,
  desired: boolean,
  authority: BookmarkAuthority,
  operationId: () => string = () => crypto.randomUUID(),
): BookmarkIntent {
  const intents = readIntents();
  const key = bookmarkEntityKey(provider, providerWorkId);
  const previous = intents[key] ?? null;
  const sameIntent = previous !== null
    && previous.desired === desired
    && previous.libraryId === authority.libraryId
    && previous.epoch === authority.epoch;
  // A base revision is only meaningful inside one epoch. Within the epoch, the
  // base is the newest authoritative revision this client knows: a superseding
  // action must not re-present the base its superseded intent was composed
  // against, because the authority may have advanced since. Another epoch's row
  // or observation is unrelated, so the intent starts at 0 and lets the server's
  // compare-and-set decide.
  const confirmed = readConfirmed()[key];
  const knownBase = Math.max(
    previous !== null && previous.epoch === authority.epoch ? previous.baseRevision : -1,
    confirmed !== undefined && confirmed.epoch === authority.epoch ? confirmed.revision : -1,
  );
  const carried = sameIntent ? previous.baseRevision : Math.max(0, knownBase);
  const intent: BookmarkIntent = {
    provider,
    providerWorkId,
    desired,
    operationId: sameIntent ? previous.operationId : operationId(),
    baseRevision: carried,
    epoch: authority.epoch,
    libraryId: authority.libraryId,
    contractVersion: authority.contractVersion,
    createdAt: sameIntent ? previous.createdAt : Date.now(),
  };
  intents[key] = intent;
  writeJson(INTENTS_KEY, intents);
  return intent;
}

/**
 * Complete an intent the authority has confirmed.
 *
 * `expected` is the identity the caller started with. When the stored row is no
 * longer that identity a newer user action has superseded it, and the older
 * response must not clear the newer intent or overwrite its authoritative
 * revision. That is the stale-response race, resolved by identity rather than by
 * arrival order.
 *
 * Returns whether this call completed the intent.
 */
export function confirmBookmarkIntent(expected: BookmarkIntent, epoch: number, authoritativeRevision: number): boolean {
  const intents = readIntents();
  const key = bookmarkEntityKey(expected.provider, expected.providerWorkId);
  const stored = intents[key];
  if (!stored || stored.operationId !== expected.operationId) return false;
  delete intents[key];
  writeJson(INTENTS_KEY, intents);
  recordConfirmed(expected.provider, expected.providerWorkId, epoch, authoritativeRevision, expected.desired);
  return true;
}

/**
 * Apply a `revisionConflict` to a pending intent.
 *
 * The intent is never discarded. It is re-pointed at the authoritative revision
 * the server reported and keeps its operation id: the server looks up a receipt
 * *before* it compares revisions, and records acceptance and receipt atomically,
 * so a revision conflict proves no receipt exists for this operation id. Reusing
 * the id therefore cannot collide with a recorded payload and cannot duplicate a
 * logical write, while preserving the identity keeps a later lost response
 * idempotent.
 *
 * Returns the re-based intent, or null when a superseding action replaced it.
 */
export function rebaseBookmarkIntent(
  expected: BookmarkIntent,
  epoch: number,
  current: {revision: number; desiredState: boolean},
): BookmarkIntent | null {
  const intents = readIntents();
  const key = bookmarkEntityKey(expected.provider, expected.providerWorkId);
  const stored = intents[key];
  if (!stored || stored.operationId !== expected.operationId) return null;
  stored.baseRevision = current.revision;
  stored.epoch = epoch;
  intents[key] = stored;
  writeJson(INTENTS_KEY, intents);
  recordConfirmed(expected.provider, expected.providerWorkId, epoch, current.revision, current.desiredState);
  return stored;
}

/**
 * The visible bookmark state for one work.
 *
 * `authoritative state + unresolved local intent = the user's intended state`,
 * which is exactly the overlay a replica refresh must respect: a refresh carries
 * older authority data, and it must not silently revert an action the user has
 * already taken but this device has not delivered.
 *
 * `observedRevision` is the revision `authoritative` was read at, when the caller
 * knows it. Revisions are comparable inside one epoch, so a recorded confirmation
 * that is newer than the caller's observation outranks it — otherwise a screen
 * holding a pre-write read would revert a write the authority already accepted.
 * Without a revision there is nothing to compare, so the caller's value is the
 * baseline and the confirmed record only fills in an unknown state.
 */
export function visibleBookmark(
  provider: string,
  providerWorkId: string,
  authoritative: boolean | null,
  observedRevision?: number,
): { desired: boolean; pending: boolean } {
  const intent = readIntent(provider, providerWorkId);
  if (intent) return { desired: intent.desired, pending: true };
  const confirmed = readConfirmed()[bookmarkEntityKey(provider, providerWorkId)];
  if (confirmed && observedRevision !== undefined && confirmed.revision > observedRevision) {
    return { desired: confirmed.desired, pending: false };
  }
  if (authoritative !== null) return { desired: authoritative, pending: false };
  return { desired: confirmed ? confirmed.desired : false, pending: false };
}
