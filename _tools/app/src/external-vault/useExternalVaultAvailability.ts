import { useCallback, useEffect, useRef, useState } from "react";
import type { AssetView, LibraryGateway, PrivateVaultStatus } from "../library/types";

type Options = {
  gateway: Pick<LibraryGateway, "getPrivateVaultStatus">;
  view: AssetView;
  onDisconnect: () => void;
};

export function useExternalVaultAvailability({ gateway, view, onDisconnect }: Options) {
  const [status, setStatus] = useState<PrivateVaultStatus | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const getter = gateway.getPrivateVaultStatus;
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

  useEffect(() => {
    void refresh();
    const handleFocus = () => { void refresh(); };
    window.addEventListener("focus", handleFocus);
    return () => {
      requestId.current += 1;
      window.removeEventListener("focus", handleFocus);
    };
  }, [refresh]);

  useEffect(() => {
    if (view.kind === "private_vault" && status?.available === false) onDisconnect();
  }, [onDisconnect, status?.available, view.kind]);

  return { status, refresh };
}
