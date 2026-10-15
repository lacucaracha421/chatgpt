import {useCallback, useEffect, useRef, useState} from 'react';
import type {PackCover} from '../../src/cards/types';
import {visibleInterval} from '../useVisibleInterval';
import {SIGNAL_FALLBACK_MS, useSyncSignal} from '../syncSignals';
import {displayCover, type CardState, type TabletCardsApi} from './cardsClient';

/** Without the status watcher the state is still re-read now and then (and always on resume). */
export const CARD_POLL_MS = 5 * 60_000;

/**
 * Today's card state and its pack cover.
 *
 * It is read on mount, when the app comes back, when the server's `cards` status signal moves and
 * at the daily reset (05:00); while the status watcher is live the safety timer relaxes to
 * {@link SIGNAL_FALLBACK_MS}, otherwise it runs every {@link CARD_POLL_MS}. Reads never overlap:
 * a refresh asked for during a read runs once after it.
 */
export function useTabletCardState(api: TabletCardsApi, active = true) {
  const [snapshot, setSnapshot] = useState<{state: CardState; cover: PackCover} | null>(null);
  const [error, setError] = useState(false), [pending, setPending] = useState(false);
  const [retry, setRetry] = useState(0);
  const refreshRef = useRef<() => void>(() => undefined);
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let live = true, running = false, again = false;
    const read = async () => {
      if (running) { again = true; return; }
      running = true; setPending(true);
      do {
        again = false;
        try {
          const state = await api.state(controller.signal), cover = await displayCover(api, state);
          if (live) { setSnapshot({state, cover}); setError(false); }
        } catch (reason) { if (live && !(reason instanceof DOMException && reason.name === 'AbortError')) setError(true); }
      } while (live && again);
      running = false; if (live) setPending(false);
    };
    refreshRef.current = () => { void read(); };
    void read();
    return () => { live = false; controller.abort(); refreshRef.current = () => undefined; };
  }, [api, active, retry]);
  const watching = useSyncSignal('cards', refresh, active);
  useEffect(() => {
    if (!active) return;
    return visibleInterval(refresh, watching ? SIGNAL_FALLBACK_MS : CARD_POLL_MS);
  }, [active, watching, refresh]);
  const resetFired = useRef('');
  useEffect(() => {
    const next = snapshot?.state.nextResetAt;
    if (!active || !next || resetFired.current === next) return;
    const delay = Date.parse(next) - Date.now();
    if (!Number.isFinite(delay)) return;
    const timer = window.setTimeout(() => { resetFired.current = next; refresh(); }, Math.max(0, Math.min(delay, 2_147_483_647)));
    return () => window.clearTimeout(timer);
  }, [snapshot?.state.nextResetAt, active, refresh]);
  return {snapshot, error, pending, refresh, retry: () => setRetry(value => value + 1)};
}
