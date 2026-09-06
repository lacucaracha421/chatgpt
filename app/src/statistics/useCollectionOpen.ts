import { useEffect, useRef } from "react";
import type { LibraryGateway } from "../library/types";

/** A detail-view session ends on return to another area or library. StrictMode
 * effect replay and revisiting a collection within that session are not opens. */
export function useCollectionOpen(gateway: LibraryGateway, libraryRoot: string | null, collectionId: string | null) {
  const session = useRef<{ root: string | null; ids: Set<string> }>({ root: libraryRoot, ids: new Set() });
  useEffect(() => {
    if (session.current.root !== libraryRoot || !collectionId) {
      session.current = { root: libraryRoot, ids: new Set() };
    }
    if (!libraryRoot || !collectionId || !gateway.recordCollectionOpened || session.current.ids.has(collectionId)) return;
    session.current.ids.add(collectionId);
    void Promise.resolve().then(() => gateway.recordCollectionOpened?.(collectionId, new Date().toISOString())).catch(() => {
      // Recording failure must not interrupt viewing or manufacture a retry open.
    });
  }, [gateway, libraryRoot, collectionId]);
}
