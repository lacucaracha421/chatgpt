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

/** Local thumbnails of sent and saved images, kept for the session ('' = none). */
const thumbnails = new Map<string, string>();
const loading = new Map<string, Promise<string>>();

/**
 * A small local thumbnail for an image row: made on the device from the sent original or the
 * saved copy (nothing is fetched from the server). `enabled` waits until such a file exists.
 */
export function useExchangeThumbnail(transferId: string, enabled: boolean): string {
  const [url, setUrl] = useState(() => thumbnails.get(transferId) ?? '');
  useEffect(() => {
    if (!enabled) return;
    const known = thumbnails.get(transferId);
    if (known !== undefined) { setUrl(known); return; }
    let active = true;
    let request = loading.get(transferId);
    if (!request) {
      request = native<{url?: string}>('exchangeThumbnail', {transferId}).then(value => value?.url ?? '', () => '')
        .then(value => { if (value) thumbnails.set(transferId, value); loading.delete(transferId); return value; });
      loading.set(transferId, request);
    }
    void request.then(value => { if (active) setUrl(value); });
    return () => { active = false; };
  }, [transferId, enabled]);
  return enabled ? url : '';
}
