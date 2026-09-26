import { useWorkloadProfile } from "../app/workloadProfile";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetView, EncryptedVaultState, EncryptedVaultStatus, LibraryGateway } from "../library/types";

/** Emitted by the native mount watcher (`src-tauri/src/library/private_vault/watch.rs`) when drives are mounted or removed. */
export const VAULT_MOUNTS_CHANGED_EVENT = "external-vault-changed";

/**
 * Status poll only while the 비밀 view shows an unlocked vault: a safety net for a USB whose mount lingers after
 * removal. In that state the status call only re-reads the open vault's id; it does not scan mount roots.
 */
export const VAULT_OPEN_POLL_MS = 3_000;

export type VaultMountSubscription = (handler: () => void) => () => void;

/** Subscribes to native mount changes; a no-op outside the Tauri app. */
export const subscribeVaultMountChanges: VaultMountSubscription = (handler) => {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};
  let stopped = false;
  let unlisten: (() => void) | undefined;
  void listen(VAULT_MOUNTS_CHANGED_EVENT, () => handler())
    .then((stop) => { if (stopped) stop(); else unlisten = stop; })
    .catch(() => {});
  return () => { stopped = true; unlisten?.(); };
};

export type VaultLeaveReason = "disconnected" | "locked";

/** Every status read returns a fresh object; keep the current one when no field changed so repeated reads do not re-render the app. */
function sameStatus(left: EncryptedVaultStatus | null, right: EncryptedVaultStatus | null) {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = Object.keys(left) as (keyof EncryptedVaultStatus)[];
  return keys.length === Object.keys(right).length && keys.every(key => Object.is(left[key], right[key]));
}

type Options = {
  gateway: Pick<LibraryGateway, "getEncryptedVaultStatus">;
  view: AssetView;
  /** Called when the open 비밀 view must close: the USB disappeared or the vault was locked. */
  onLeave: (reason: VaultLeaveReason) => void;
  /** Mount-change source; tests inject one. */
  subscribeMountChanges?: VaultMountSubscription;
};

/** Tracks the encrypted Private Vault: on start, on focus/visibility and when drives are mounted or removed. */
export function useExternalVaultAvailability({ gateway, view, onLeave, subscribeMountChanges = subscribeVaultMountChanges }: Options) {
  const [status, setRawStatus] = useState<EncryptedVaultStatus | null>(null);
  const setStatus = useCallback((next: EncryptedVaultStatus | null) => {
    setRawStatus(current => sameStatus(current, next) ? current : next);
  }, []);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const getter = gateway.getEncryptedVaultStatus;
    const currentRequest = ++requestId.current;
    if (!getter) {
      setStatus(null);
      return null;
    }
    try {
      const next = await getter();
      if (requestId.current === currentRequest) setStatus(next);
      return next;
    } catch {
      if (requestId.current === currentRequest) setStatus(null);
      return null;
    }
  }, [gateway, setStatus]);

  const update = useCallback((next: EncryptedVaultStatus) => {
    requestId.current += 1;
    setStatus(next);
  }, [setStatus]);

  const { restricted, hidden } = useWorkloadProfile();
  useEffect(() => {
    if (hidden) {
      requestId.current += 1;
      setRawStatus(current => current?.state === "unlocked" ? { ...current, state: "locked", itemCount: null } : current);
      return;
    }
    void refresh();
    const refreshVisible = () => { if (document.visibilityState !== "hidden") void refresh(); };
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    const unsubscribe = subscribeMountChanges(refreshVisible);
    return () => {
      requestId.current += 1;
      unsubscribe();
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [refresh, hidden, subscribeMountChanges]);

  const previousState = useRef<EncryptedVaultState | null>(null);
  const inVault = view.kind === "private_vault";
  const watchOpenVault = inVault && !hidden && status?.state === "unlocked";
  useEffect(() => {
    if (!watchOpenVault) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh();
    }, restricted ? 60_000 : VAULT_OPEN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [watchOpenVault, refresh, restricted]);
  useEffect(() => {
    const previous = previousState.current;
    const state = status?.state ?? null;
    previousState.current = state;
    if (!inVault || previous === state) return;
    if (state === null || state === "absent") onLeave("disconnected");
    else if (state === "locked" && previous === "unlocked") onLeave("locked");
  }, [inVault, onLeave, status?.state]);

  return { status, refresh, update };
}
