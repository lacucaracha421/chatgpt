import {api} from './transport';
import {connectionOutbox, outboxKey} from './outboxConnection';

export type UpcomingWishlistAction = 'add' | 'remove';
export type UpcomingWishlistIntent = {
  itemId: string;
  action: UpcomingWishlistAction;
  operationId: string;
  createdAt: number;
};

const INTENTS_KEY = connectionOutbox('lakomics.home.upcoming.wishlist.outbox.v1');

function read(): Record<string, UpcomingWishlistIntent> {
  try {
    const key = outboxKey(INTENTS_KEY);
    const value = key ? JSON.parse(localStorage.getItem(key) ?? '{}') : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, UpcomingWishlistIntent> : {};
  } catch { return {}; }
}

function write(value: Record<string, UpcomingWishlistIntent>): void {
  const key = outboxKey(INTENTS_KEY);
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* the in-memory UI still shows the action */ }
}

export function readUpcomingWishlistIntents(): Record<string, UpcomingWishlistIntent> { return read(); }

/** One operation id survives retries; a later opposite click supersedes it. */
export function commitUpcomingWishlist(itemId: string, desired: boolean, operationId: () => string = () => crypto.randomUUID()): UpcomingWishlistIntent {
  const all = read();
  const previous = all[itemId];
  const action: UpcomingWishlistAction = desired ? 'add' : 'remove';
  const intent = previous?.action === action ? previous : {itemId, action, operationId: operationId(), createdAt: Date.now()};
  all[itemId] = intent;
  write(all);
  return intent;
}

/** Do not clear an intent until a later GET contains the requested state. */
export function reconcileUpcomingWishlist(authoritative: Set<string>): void {
  const all = read();
  let changed = false;
  for (const [itemId, intent] of Object.entries(all)) {
    const desired = intent.action === 'add';
    if (authoritative.has(itemId) === desired) { delete all[itemId]; changed = true; }
  }
  if (changed) write(all);
}

export function visibleUpcomingWishlist(itemId: string, authoritative: boolean): {value: boolean; pending: boolean} {
  const intent = read()[itemId];
  return intent ? {value: intent.action === 'add', pending: true} : {value: authoritative, pending: false};
}

/** Sends queued intents with the server's versioned, idempotent wishlist contract. */
export async function flushUpcomingWishlist(signal: AbortSignal, endpoint?: string): Promise<void> {
  const target = endpoint ?? undefined;
  for (const intent of Object.values(read())) {
    if (signal.aborted) return;
    await api('/v1/home/upcoming/wishlist', signal, {
      version: 1,
      operationId: intent.operationId,
      action: intent.action,
      itemId: intent.itemId,
    }, 'POST', false, target).catch(() => undefined);
  }
}
