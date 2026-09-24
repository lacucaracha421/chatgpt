/**
 * Durable mobile edits of personal Collection fields: my rating, Showcase
 * membership and the memo. The rules are the bookmark outbox's
 * (`bookmarkOutbox.ts`), with storage in the same `localStorage`:
 *
 * 1. **One intent per `collectionId:field`, minted once.** The operation id is
 *    created when the user acts and reused on every transport retry, because a
 *    timeout may mean the server applied the edit and only the response was lost.
 *    **A changed payload always gets a new id**: the server refuses a reused id
 *    with a different payload (`operationConflict`).
 * 2. **A new user action replaces the queued intent with a new operation id.** It
 *    keeps the queued intent's `expected` (the server value it was composed
 *    against) and remembers the replaced value as this device's own, so a late
 *    acceptance of the replaced edit is not mistaken for someone else's change.
 * 3. **Removed on receipt.** A receipt for a replaced operation id is ignored.
 *
 * Only {@link commitCollectionEdit} enqueues, and only user actions call it. It
 * throws when the device cannot store the edit, so the UI never shows an unsaved
 * edit as queued.
 */

export type CollectionEditField = 'myScore' | 'showcase' | 'memo';
export type CollectionEditValue = number | boolean | string | null;

export type CollectionEditIntent = {
  collectionId: string;
  field: CollectionEditField;
  value: CollectionEditValue;
  /** The server value this edit replaces; the server refuses it when that moved. */
  expected: CollectionEditValue;
  operationId: string;
  createdAt: number;
  /** Values this device queued earlier for the same field (newest last). */
  own: CollectionEditValue[];
  /** A memo the PC changed meanwhile: the user decides (overwrite / discard). */
  conflict?: {current: CollectionEditValue};
};

const INTENTS_KEY = 'lakomics.collections.edits.outbox.v1';
export const SAVE_FAILED = '기기에 저장하지 못했습니다.';
export const MEMO_LIMIT = 2000;
/** Fired after the durable queue changes, so every screen re-reads it. */
export const COLLECTION_EDITS_EVENT = 'lakomics-collection-edits';

export function collectionEditKey(collectionId: string, field: CollectionEditField): string {
  return `${collectionId}:${field}`;
}

/** Characters as the PC and server count them (code points, not UTF-16 units). */
export const memoLength = (value: string) => [...value].length;

/** The PC's own validation. Returns the value to send, or throws a user-facing message. */
export function normalizeCollectionEdit(field: CollectionEditField, value: CollectionEditValue): CollectionEditValue {
  if (field === 'myScore') {
    if (value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 5 || !Number.isInteger(value * 2)) throw new Error('평점은 0.0–5.0 사이 0.5 단위입니다.');
    return value;
  }
  if (field === 'showcase') {
    if (typeof value !== 'boolean') throw new Error('쇼케이스 값을 확인할 수 없습니다.');
    return value;
  }
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('메모를 확인할 수 없습니다.');
  const trimmed = value.trim();
  if (memoLength(trimmed) > MEMO_LIMIT) throw new Error(`메모는 ${MEMO_LIMIT.toLocaleString()}자까지 쓸 수 있습니다.`);
  return trimmed || null;
}

function valid(intent: unknown): intent is CollectionEditIntent {
  const value = intent as CollectionEditIntent | null;
  return !!value && typeof value === 'object' && typeof value.collectionId === 'string' && typeof value.operationId === 'string'
    && (value.field === 'myScore' || value.field === 'showcase' || value.field === 'memo') && Array.isArray(value.own);
}

export function readCollectionEdits(): Record<string, CollectionEditIntent> {
  try {
    const raw = localStorage.getItem(INTENTS_KEY);
    const parsed = raw === null ? null : JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, intent]) => valid(intent))) as Record<string, CollectionEditIntent>;
  } catch { return {}; }
}

/** Persist the queue; false when storage refused it (the stored queue is unchanged). */
function write(intents: Record<string, CollectionEditIntent>): boolean {
  try { localStorage.setItem(INTENTS_KEY, JSON.stringify(intents)); } catch { return false; }
  try { window.dispatchEvent(new Event(COLLECTION_EDITS_EVENT)); } catch { /* No window outside the app. */ }
  return true;
}

export function readCollectionEdit(collectionId: string, field: CollectionEditField): CollectionEditIntent | null {
  return readCollectionEdits()[collectionEditKey(collectionId, field)] ?? null;
}

/**
 * Commit the user's edit. `authoritative` is the server value the screen shows.
 * Returns the queued intent, or null when nothing needs sending (the value is
 * already the server's and no earlier edit is queued). Throws {@link SAVE_FAILED}
 * when the device could not store it.
 */
export function commitCollectionEdit(
  collectionId: string,
  field: CollectionEditField,
  value: CollectionEditValue,
  authoritative: CollectionEditValue,
  operationId: () => string = () => crypto.randomUUID(),
): CollectionEditIntent | null {
  const next = normalizeCollectionEdit(field, value);
  const intents = readCollectionEdits();
  const key = collectionEditKey(collectionId, field);
  const previous = intents[key] ?? null;
  if (!previous && next === authoritative) return null;
  if (previous && previous.value === next && !previous.conflict) return previous;
  const intent: CollectionEditIntent = {
    collectionId,
    field,
    value: next,
    expected: previous ? previous.expected : authoritative,
    operationId: operationId(),
    createdAt: previous ? previous.createdAt : Date.now(),
    own: previous ? [...previous.own, previous.value].slice(-5) : [],
  };
  intents[key] = intent;
  if (!write(intents)) throw new Error(SAVE_FAILED);
  return intent;
}

/** Remove an intent the server confirmed, unless a newer action replaced it. */
export function confirmCollectionEdit(expected: CollectionEditIntent): boolean {
  const intents = readCollectionEdits();
  const key = collectionEditKey(expected.collectionId, expected.field);
  if (intents[key]?.operationId !== expected.operationId) return false;
  delete intents[key];
  write(intents);
  return true;
}

/**
 * Re-point an intent at the server's current value under a new operation id: the
 * payload changes, and a `collectionPersonalConflict` proves the server stored no
 * receipt for the old id, so retiring it is safe.
 */
export function rebaseCollectionEdit(
  expected: CollectionEditIntent,
  current: CollectionEditValue,
  operationId: () => string = () => crypto.randomUUID(),
): CollectionEditIntent | null {
  return replace(expected, stored => { stored.expected = current; delete stored.conflict; stored.operationId = operationId(); });
}

/** A new operation id for an unchanged payload, after the server refused the old id. */
export function reissueCollectionEdit(expected: CollectionEditIntent, operationId: () => string = () => crypto.randomUUID()): CollectionEditIntent | null {
  return replace(expected, stored => { stored.operationId = operationId(); });
}

/** Change the stored intent if it is still `expected`; null when replaced or not saved. */
function replace(expected: CollectionEditIntent, change: (stored: CollectionEditIntent) => void): CollectionEditIntent | null {
  const intents = readCollectionEdits();
  const key = collectionEditKey(expected.collectionId, expected.field);
  const stored = intents[key];
  if (!stored || stored.operationId !== expected.operationId) return null;
  change(stored);
  return write(intents) ? stored : null;
}

/** Park a memo intent until the user chooses; it is not sent meanwhile. */
export function markCollectionEditConflict(expected: CollectionEditIntent, current: CollectionEditValue): boolean {
  const intents = readCollectionEdits();
  const key = collectionEditKey(expected.collectionId, expected.field);
  const stored = intents[key];
  if (!stored || stored.operationId !== expected.operationId) return false;
  stored.conflict = {current};
  return write(intents);
}

/** The user's answer to a memo conflict. */
export function resolveCollectionEditConflict(collectionId: string, field: CollectionEditField, choice: 'overwrite' | 'discard'): CollectionEditIntent | null {
  const intents = readCollectionEdits();
  const key = collectionEditKey(collectionId, field);
  const stored = intents[key];
  if (!stored?.conflict) return null;
  if (choice === 'discard') {
    delete intents[key];
    write(intents);
    return null;
  }
  return rebaseCollectionEdit(stored, stored.conflict.current);
}

/** The value a screen shows: the queued value over the server's, marked pending. */
export function visibleCollectionEdit<T extends CollectionEditValue>(
  collectionId: string,
  field: CollectionEditField,
  authoritative: T,
): {value: T; pending: boolean; conflict: boolean} {
  const intent = readCollectionEdit(collectionId, field);
  if (!intent) return {value: authoritative, pending: false, conflict: false};
  return {value: intent.value as T, pending: true, conflict: !!intent.conflict};
}
