import { useCallback, useEffect, useRef, useState } from "react";
import { cardsApi, displayCover, type CardsApi, type CardState } from "./api";
import type { PackCover } from "./types";

export function useCardState(api: CardsApi = cardsApi, active = true) {
  const [snapshot, setSnapshot] = useState<{ state: CardState; cover: PackCover } | null>(null);
  const [error, setError] = useState(false), [pending, setPending] = useState(false);
  const [retry, setRetry] = useState(0);
  const refreshRef = useRef<() => void>(() => undefined);
  const refresh = useCallback(() => refreshRef.current(), []);
  const resetFired = useRef("");
  useEffect(() => {
    if (!active) return;
    let live = true, running = false, again = false;
    const read = async () => {
      if (running) { again = true; return; }
      running = true; setPending(true);
      do {
        again = false;
        try {
          const state = await api.state(), cover = await displayCover(api, state);
          if (live) { setSnapshot({ state, cover }); setError(false); }
        } catch { if (live) setError(true); }
      } while (live && again);
      running = false; if (live) setPending(false);
    };
    refreshRef.current = () => { void read(); };
    const stop = api.subscribe(refreshRef.current);
    void read();
    return () => { live = false; stop(); refreshRef.current = () => undefined; };
  }, [api, active, retry]);
  useEffect(() => {
    const next = snapshot?.state.nextResetAt;
    if (!active || !next || resetFired.current === next) return;
    const delay = Date.parse(next) - Date.now();
    if (!Number.isFinite(delay)) return;
    const timer = window.setTimeout(() => { resetFired.current = next; refresh(); }, Math.max(0, Math.min(delay, 2_147_483_647)));
    return () => window.clearTimeout(timer);
  }, [snapshot?.state.nextResetAt, active, refresh]);
  return { snapshot, error, pending, refresh, retry: () => setRetry(value => value + 1) };
}
