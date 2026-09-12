import { useEffect } from "react";
import type { LibraryGateway } from "../library/types";

const DUE_CHECK_INTERVAL_MS = 3_600_000;

export function useOnlineCatalogUpdate(gateway: LibraryGateway, libraryRoot: string) {
  useEffect(() => {
    let active = true;
    let running = false;
    const run = async () => {
      if (!active || running) return;
      running = true;
      try {
        try {
          await gateway.runDueOnlineCatalogUpdate();
        } catch {
          // The catalog screen and settings expose persisted Korean update errors.
        }
        if (!active) return;
        try {
          await gateway.runDueOnlineCatalogUpdate("japanese");
        } catch {
          // The catalog screen and settings expose persisted Japanese update errors.
        }
      } finally {
        running = false;
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), DUE_CHECK_INTERVAL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [gateway, libraryRoot]);
}
