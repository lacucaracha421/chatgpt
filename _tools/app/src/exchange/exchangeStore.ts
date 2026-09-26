import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** PC ↔ tablet file exchange (보내기/받기). The native side owns every transfer; this store mirrors its snapshot. */
export type ExchangeAvailability = { state: "starting" | "ready" | "offline" | "unavailable"; message: string | null; needsToken: boolean };
export type ExchangeDevice = { deviceId: string; name: string; kind: string };
export type OutgoingState = "queued" | "zipping" | "hashing" | "uploading" | "waiting" | "delivered" | "expired" | "cancelled" | "interrupted" | "failed";
export type ExchangeOutgoing = {
  transferId: string; fileName: string; sizeBytes: number; toName: string | null; state: OutgoingState;
  done: number; message: string | null; note: string | null; retryable: boolean; cancellable: boolean; createdAt: string | null;
  /** Files sent together share it; the receiving device. */
  batchId?: string | null; toDevice?: string | null;
};
export type ExchangeIncoming = {
  transferId: string; fileName: string; sizeBytes: number; fromName: string | null; state: "downloading" | "failed"; done: number; message: string | null;
  batchId?: string | null; fromDevice?: string | null; createdAt?: string | null;
};
export type ExchangeReceived = {
  transferId: string; fileName: string; sizeBytes: number; fromName: string | null; receivedAt: string; exists: boolean;
  batchId?: string | null; fromDevice?: string | null;
};
export type ExchangeSnapshot = {
  availability: ExchangeAvailability;
  selfName: string | null;
  devices: ExchangeDevice[];
  outgoing: ExchangeOutgoing[];
  incoming: ExchangeIncoming[];
  received: ExchangeReceived[];
  unseen: number;
  folder: string | null;
  tokenConfigured: boolean;
};

export type ExchangeRequest = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type ExchangeSubscribe = (handler: (snapshot: ExchangeSnapshot) => void) => Promise<() => void>;

export const EMPTY_EXCHANGE: ExchangeSnapshot = {
  availability: { state: "starting", message: null, needsToken: false },
  selfName: null, devices: [], outgoing: [], incoming: [], received: [], unseen: 0, folder: null, tokenConfigured: false,
};

export class ExchangeStore {
  private value: ExchangeSnapshot = EMPTY_EXCHANGE;
  private listeners = new Set<() => void>();
  private started = false;
  constructor(readonly request: ExchangeRequest, private readonly listenChanges: ExchangeSubscribe) {}
  snapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: ExchangeSnapshot) { this.value = next; this.listeners.forEach((listener) => listener()); }
  async start() {
    if (this.started) return;
    this.started = true;
    let received = false;
    try {
      await this.listenChanges((next) => { received = true; this.publish(next); });
      const initial = await this.request<ExchangeSnapshot>("exchange_snapshot");
      if (!received) this.publish(initial);
    } catch { this.started = false; }
  }
  send(paths: string[], toDevice: string | null) { return this.request<number>("exchange_send", { paths, toDevice }); }
  cancel(transferId: string) { return this.request<void>("exchange_cancel", { transferId }); }
  retry(transferId: string) { return this.request<void>("exchange_retry", { transferId }); }
  open(transferId: string) { return this.request<void>("exchange_open", { transferId }); }
  reveal(transferId: string) { return this.request<void>("exchange_reveal", { transferId }); }
  openFolder() { return this.request<void>("exchange_open_folder"); }
  markSeen() { return this.request<void>("exchange_mark_seen"); }
  refresh() { return this.request<void>("exchange_refresh"); }
  setToken(token: string | null) { return this.request<void>("exchange_set_token", { token }); }
  /** JPEG bytes of a sent or saved image's local thumbnail (empty when there is none). */
  thumbnail(transferId: string) { return this.request<ArrayBuffer | number[]>("exchange_thumbnail", { transferId }); }
}

const nativeExchange = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const exchangeStore = new ExchangeStore(
  (command, args) => invoke(command, args),
  (handler) => listen<ExchangeSnapshot>("exchange://changed", ({ payload }) => handler(payload)),
);

export function useExchangeSnapshot(store: ExchangeStore = exchangeStore) {
  const value = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => { if (store !== exchangeStore || nativeExchange()) void store.start(); }, [store]);
  return value;
}
