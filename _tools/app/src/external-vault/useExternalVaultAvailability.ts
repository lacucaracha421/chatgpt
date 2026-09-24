import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetView, EncryptedVaultState, EncryptedVaultStatus, LibraryGateway } from "../library/types";

/** The status call is cheap (ADR-0039 stage 2a), so the rail follows USB insertion quickly. */
export const VAULT_STATUS_POLL_MS = 3_000;

export type VaultLeaveReason = "disconnected" | "locked";

type Options = {
  gateway: Pick<LibraryGateway, "getEncryptedVaultStatus">;
  view: AssetView;
  /** Called when the open 비밀 view must close: the USB disappeared or the vault was locked. */
  onLeave: (reason: VaultLeaveReason) => void;
};

/** Tracks the encrypted Private Vault: on start, on focus and every few seconds while visible. */
export function useExternalVaultAvailability({ gateway, view, onLeave }: Options) {
  const [status, setStatus] = useState<EncryptedVaultStatus | null>(null);
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
  }, [gateway]);

  const update = useCallback((next: EncryptedVaultStatus) => {
    requestId.current += 1;
    setStatus(next);
  }, []);

  useEffect(() => {
    void refresh();
    const refreshVisible = () => { if (document.visibilityState !== "hidden") void refresh(); };
    const timer = window.setInterval(refreshVisible, VAULT_STATUS_POLL_MS);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      requestId.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [refresh]);

  const previousState = useRef<EncryptedVaultState | null>(null);
  const inVault = view.kind === "private_vault";
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
