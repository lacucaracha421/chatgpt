import {useEffect, useRef, useState} from 'react';
import {native} from './transport';

/**
 * The status long-poll's signals (PERF-ALL-001 T1).
 *
 * While the app is resumed, native holds `/v1/sync/status?wait=50&signals=1` and reports
 * `lakomics-sync-signals` `{live, signals}` whenever a signal moves (and `live: false` when the
 * watcher fails or the server is too old). While live, a status check runs when its own signal
 * moves, and its timer relaxes to {@link SIGNAL_FALLBACK_MS}; otherwise every timer is as before.
 */
export const SIGNAL_FALLBACK_MS = 10 * 60_000;

type Signals = Record<string, unknown>;
let live = false, signals: Signals | null = null, reports = 0, asked = false;
const listeners = new Set<() => void>();

function receive(detail: unknown) {
  reports++;
  const value = detail as {live?: unknown; signals?: unknown} | null;
  const next = value && value.live === true && value.signals && typeof value.signals === 'object' ? value.signals as Signals : null;
  live = next !== null;
  signals = next;
  Array.from(listeners).forEach(listener => listener());
}

// Attached at load so a report that arrives before any subscriber is kept.
if (typeof window !== 'undefined') window.addEventListener('lakomics-sync-signals', event => receive((event as CustomEvent).detail));

/** Listen for signal reports. The first subscriber also asks native for the current one. */
export function subscribeSyncSignals(listener: () => void) {
  listeners.add(listener);
  if (!asked && typeof window !== 'undefined' && window.LakomicsNative) {
    asked = true;
    const before = reports;
    // A page loaded after the watcher's last report; a newer event wins over this answer.
    void native<unknown>('syncSignals').then(detail => { if (reports === before) receive(detail); }, () => {});
  }
  return () => { listeners.delete(listener); };
}

export function syncSignalsLive() { return live; }

/** One signal as a comparable string, or undefined when not live or not reported. */
export function syncSignal(key: string): string | undefined {
  if (!live || !signals || !Object.prototype.hasOwnProperty.call(signals, key)) return undefined;
  return JSON.stringify(signals[key]);
}

/**
 * Calls `onMoved` when the named signal moves while `enabled`, and returns whether the watcher
 * is live (so the caller can relax its own timer).
 */
export function useSyncSignal(key: string, onMoved: () => void, enabled = true): boolean {
  const [isLive, setLive] = useState(syncSignalsLive);
  const latest = useRef(onMoved); latest.current = onMoved;
  useEffect(() => {
    setLive(syncSignalsLive());
    if (!enabled) return subscribeSyncSignals(() => setLive(syncSignalsLive()));
    let seen = syncSignal(key);
    return subscribeSyncSignals(() => {
      setLive(syncSignalsLive());
      const next = syncSignal(key);
      if (next === undefined) return;
      const moved = next !== seen;
      seen = next;
      if (moved) latest.current();
    });
  }, [key, enabled]);
  return isLive;
}
