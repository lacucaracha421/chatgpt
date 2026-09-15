import { useEffect } from "react";
import type { LibraryGateway } from "../library/types";

export const CATALOG_BOOKMARKS_CHANGED_EVENT = "lakomics-catalog-bookmarks-changed";
const BOOKMARK_SYNC_INTERVAL_MS = 5_000;

export function useCatalogBookmarkSync(gateway: LibraryGateway, libraryRoot: string) {
  useEffect(() => {
    if (!gateway.reconcileCatalogBookmarks || !gateway.flushCatalogBookmarkOutbox) return;
    let active = true;
    let running = false;
    const announce = () => window.dispatchEvent(new Event(CATALOG_BOOKMARKS_CHANGED_EVENT));
    const receive = async () => {
      const result = await gateway.reconcileCatalogBookmarks!();
      if (active && (result.appliedChanges > 0 || result.adoptedBaseline)) announce();
      return result;
    };
    const run = async () => {
      if (!active || running) return;
      running = true;
      try {
        await receive();
        const flushed = await gateway.flushCatalogBookmarkOutbox!();
        if (flushed.sent > 0 || flushed.alreadyCurrent > 0 || flushed.rebased) await receive();
      } catch {
        // Durable cursors/outbox survive; retry on the next tick/foreground event.
      } finally {
        running = false;
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), BOOKMARK_SYNC_INTERVAL_MS);
    window.addEventListener("online", run);
    window.addEventListener("focus", run);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("online", run);
      window.removeEventListener("focus", run);
    };
  }, [gateway, libraryRoot]);
}
