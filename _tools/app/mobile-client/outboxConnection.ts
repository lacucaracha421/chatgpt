/**
 * Which connection a durable mobile outbox belongs to.
 *
 * Every WebView outbox (bookmarks, personal Collection edits, character / similarity review,
 * Catalog duplicate review) keeps its intents in one storage bucket **per connection**, named
 * by the server endpoint the app is configured with. An intent is only read, shown and sent
 * while the app is connected to the endpoint it was queued on; the buckets of other
 * connections stay stored untouched (suspended) and are sent when the user connects to that
 * server again. This follows the native Album / Classification outboxes, which are scoped to
 * their connection too; the WebView only sees the endpoint (never the token), so the endpoint
 * is the connection identity here. Library identity is checked per intent by each delivery.
 *
 * Sends go through {@link apiOn}: native refuses the request unless it is still connected to
 * the endpoint the intent belongs to, so a reconfiguration racing a send pass cannot deliver
 * one server's intent to another.
 *
 * Upgrade: outboxes used to store one unscoped bucket (the `base` key itself). The first time
 * a connection is known after the upgrade, each such legacy bucket moves into that
 * connection's bucket. That is the realistic owner — the edits were queued against the server
 * the app is still configured for — and it happens once: the legacy key is removed after the
 * move. Intents that lack a library identity are bound by their own delivery (see there).
 */

import {api} from './transport';

let current: string | null = null;
const registered = new Set<string>();

/** The configured server endpoint, or null while unknown or disconnected. */
export function outboxConnection(): string | null { return current; }

/** Called with the app's connection status whenever it is read or changed. */
export function setOutboxConnection(endpoint: string | null | undefined): void {
  current = typeof endpoint === 'string' && endpoint ? endpoint : null;
  if (current) for (const base of registered) adoptLegacy(base, current);
}

/**
 * Declare an outbox stored under `base` (its pre-connection key). Returns `base`. Declared
 * once at module load, so a legacy bucket moves on the first known connection.
 */
export function connectionOutbox(base: string): string {
  registered.add(base);
  if (current) adoptLegacy(base, current);
  return base;
}

/** The storage key of `base`'s bucket for `endpoint` (default: the current connection), or null. */
export function outboxKey(base: string, endpoint: string | null = current): string | null {
  return endpoint ? `${base}.${encodeURIComponent(endpoint)}` : null;
}

function adoptLegacy(base: string, endpoint: string): void {
  try {
    const raw = localStorage.getItem(base);
    if (raw === null) return;
    const legacy = JSON.parse(raw) as unknown;
    const target = outboxKey(base, endpoint)!;
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
      const existing = JSON.parse(localStorage.getItem(target) ?? 'null') as unknown;
      // Rows already in the connection's bucket are newer than the legacy copy.
      const merged = existing && typeof existing === 'object' && !Array.isArray(existing) ? {...legacy, ...existing} : legacy;
      localStorage.setItem(target, JSON.stringify(merged));
    }
    localStorage.removeItem(base);
  } catch { /* Storage refused: the legacy bucket stays and moves on the next attempt. */ }
}

/** An API call native refuses unless the app is still connected to `endpoint`. */
export function apiOn<T>(endpoint: string, path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
  return api<T>(path, signal, body, undefined, false, endpoint);
}
