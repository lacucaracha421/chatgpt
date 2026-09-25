import {useEffect, useState} from 'react';
import {native} from './transport';
import {arrivalText, EXCHANGE_ARRIVED_EVENT, EXCHANGE_EVENT, type ExchangeArrival, type ExchangeSnapshot} from './exchange';

/**
 * App-level exchange state: the latest native snapshot (for the badge) and the arrival toast.
 * Native pushes snapshots and arrivals; nothing here polls.
 */
export function useExchange(configured: boolean, endpoint: string, open: boolean) {
  const [snapshot, setSnapshot] = useState<ExchangeSnapshot | null>(null);
  const [toast, setToast] = useState<{text: string; key: number} | null>(null);
  useEffect(() => {
    setSnapshot(null);
    if (!configured) return;
    let active = true;
    void native<ExchangeSnapshot>('exchangeState').then(value => { if (active) setSnapshot(value); }).catch(() => {});
    const onState = (event: Event) => { const detail = (event as CustomEvent<ExchangeSnapshot>).detail; if (detail) setSnapshot(detail); };
    const onArrived = (event: Event) => {
      const detail = (event as CustomEvent<ExchangeArrival>).detail;
      if (detail?.count) setToast({text: arrivalText(detail), key: Date.now()});
    };
    window.addEventListener(EXCHANGE_EVENT, onState);
    window.addEventListener(EXCHANGE_ARRIVED_EVENT, onArrived);
    return () => { active = false; window.removeEventListener(EXCHANGE_EVENT, onState); window.removeEventListener(EXCHANGE_ARRIVED_EVENT, onArrived); };
  }, [configured, endpoint]);
  // The open screen lists the arrivals itself.
  useEffect(() => { if (open) setToast(null); }, [open]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  return {snapshot, setSnapshot, toast: open ? null : toast, dismissToast: () => setToast(null), unseen: snapshot?.unseen ?? 0};
}
