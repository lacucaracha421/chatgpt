import { useEffect, useRef } from "react";
import type { LibraryGateway } from "../library/types";

/** Native owns scheduling and probes the saved window preferences when display inputs change. */
export function useMobilePublications(gateway: LibraryGateway, libraryRoot: string, orderIds: string[], pinnedIds: string[] = [],
  folders: ReadonlyArray<{ id: string; name: string; parentId: string | null }> = []) {
  const orderKey = JSON.stringify(orderIds);
  const pinnedKey = JSON.stringify(pinnedIds);
  // The window probe resolves Korean name order for folders without explicit ranks.
  const folderKey = JSON.stringify(folders.map(({ id, name, parentId }) => [id, name, parentId]));
  const pending = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!gateway.runDueMobilePublications) return;
    let stopped = false;
    let running = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      if (stopped || running) return;
      if (retry) { clearTimeout(retry); retry = undefined; }
      running = true;
      try {
        const save = pending.current.catch(() => undefined).then(async () => {
          if (!stopped) await gateway.runDueMobilePublications!(JSON.parse(orderKey) as string[]);
        });
        pending.current = save;
        await save;
      }
      catch { if (!stopped) retry = setTimeout(() => void run(), 30_000); }
      finally { running = false; }
    };
    void run();
    window.addEventListener("online", run);
    return () => { stopped = true; if (retry) clearTimeout(retry); window.removeEventListener("online", run); };
  }, [gateway, libraryRoot, orderKey, pinnedKey, folderKey]);
}
