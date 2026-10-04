import { useEffect, useMemo, useRef, useState } from 'react';
import { newHomeArrivals, readHomeVisit, writeHomeVisit, type HomeArrival } from './homeAttentionModel';

export function useHomeVisit<T extends HomeArrival>(scope: string, items: T[], today: string, active = true, visitedAt?: string, readReady = true) {
  const [state, setState] = useState(() => ({ scope, visit: readHomeVisit(scope), session: 0 }));
  const started = useRef(false);
  const session = useRef(0);
  const previousScope = useRef(scope);
  const enteredAt = useRef(visitedAt ?? new Date().toISOString());
  useEffect(() => {
    if (!active) { started.current = false; return; }
    if (started.current && previousScope.current === scope) return;
    started.current = true;
    previousScope.current = scope;
    session.current += 1;
    enteredAt.current = visitedAt ?? new Date().toISOString();
    const saved = readHomeVisit(scope);
    setState({ scope, visit: saved, session: session.current });
  }, [scope, active, visitedAt]);
  const visit = state.scope === scope ? state.visit : readHomeVisit(scope);
  const arrivals = useMemo(() => newHomeArrivals(items, visit, today), [items, visit, today]);
  const pendingKey = arrivals.map(i => i.token).join('\n');
  useEffect(() => {
    // A resumed visit or a changed connection must adopt its own stored state before writing.
    if (!active || state.scope !== scope || state.session !== session.current) return;
    const saved = readHomeVisit(scope);
    const pending = [...new Set([...saved.pending, ...visit.pending, ...arrivals.map(i => i.token)])].filter(token => !visit.opened.includes(token));
    // Preserve discoveries from partial reads, but acknowledge the visit only after all sources succeeded.
    writeHomeVisit(scope, { ...visit, pending, lastVisit: readReady ? enteredAt.current : saved.lastVisit });
    // Retain discoveries in memory too, including when localStorage is unavailable.
    if (pending.some(token => !visit.pending.includes(token))) setState(previous => ({ ...previous, visit: { ...previous.visit, pending } }));
    // Arrival content can change independently; only its tokens affect persistence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, active, readReady, pendingKey, state]);
  const opened = (token: string) => {
    const next = { ...visit, pending: visit.pending.filter(t => t !== token), opened: [...new Set([...visit.opened, token])] };
    writeHomeVisit(scope, { ...next, lastVisit: readHomeVisit(scope).lastVisit });
    setState(previous => ({ ...previous, visit: next }));
  };
  return { arrivals, opened };
}
