import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClassificationEntry } from "../library/types";

export type RecentFolderVisit = { id: string; lastUsed: number };
/** What a chip needs to draw itself; each client adds the destination it navigates to. */
export type RecentChipFolder = {
  id: string; name: string; parentName: string; path: string; group: boolean;
  folder: Pick<ClassificationEntry, "kind" | "iconKey" | "colorKey">;
};

/** Chips whose name repeats among the remembered folders get their parent's name in front. */
export function hasDuplicateRecentName(folders: readonly RecentChipFolder[], folder: RecentChipFolder): boolean {
  return folders.some(other => other.id !== folder.id && other.name === folder.name);
}

export function recordRecentFolder(visits: RecentFolderVisit[], id: string, now = Date.now()): RecentFolderVisit[] {
  if (visits.some(visit => visit.id === id)) return visits.map(visit => visit.id === id ? { id, lastUsed: now } : visit);
  const next = [...visits];
  if (next.length >= 8) {
    const oldest = next.reduce((a, b) => a.lastUsed < b.lastUsed ? a : b);
    next.splice(next.indexOf(oldest), 1);
  }
  return [{ id, lastUsed: now }, ...next];
}

export function readRecentVisits(key: string, storage: Storage = localStorage): RecentFolderVisit[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is RecentFolderVisit =>
      typeof item?.id === "string" && typeof item?.lastUsed === "number").slice(0, 8) : [];
  } catch { return []; }
}

export type RecentFoldersCore<T extends { id: string }> = {
  folders: T[]; currentId: string | null;
  open: (folder: T) => void; record: (id?: string | null) => void;
  remove: (id: string) => void; clear: () => void;
};

/**
 * The history both clients share: what counts (a 3 s stay, or an explicit record), the 8-entry
 * least-recently-used order, per-library storage, and pruning of folders that were deleted or
 * pinned. A client supplies what is current and what exists, and keeps its own navigation.
 * `isLateId` marks saved ids whose catalog may still be on its way, so they survive until it lands.
 */
export function useRecentFolderCore<T extends { id: string }>({ libraryRoot, storageKey, currentId, catalog, pinnedIds, ready, isLateId, onOpen }: {
  libraryRoot: string; storageKey: (libraryRoot: string) => string; currentId: string | null; catalog: Map<string, T>;
  pinnedIds: string[]; ready: boolean; isLateId: (id: string) => boolean; onOpen: (folder: T) => void;
}): RecentFoldersCore<T> {
  const latest = useRef({ storageKey, currentId, catalog, pinnedIds, ready, isLateId, onOpen });
  latest.current = { storageKey, currentId, catalog, pinnedIds, ready, isLateId, onOpen };
  const [stored, setStored] = useState(() => ({ root: libraryRoot, visits: readRecentVisits(storageKey(libraryRoot)) }));
  useEffect(() => {
    try { localStorage.setItem(latest.current.storageKey(stored.root), JSON.stringify(stored.visits)); } catch { /* storage unavailable: keep the in-memory list */ }
  }, [stored]);
  const dwellTimer = useRef<number | undefined>(undefined);
  const eligible = (id: string) => latest.current.catalog.has(id) && !latest.current.pinnedIds.includes(id);
  const update = useCallback((change: (visits: RecentFolderVisit[]) => RecentFolderVisit[]) => {
    setStored(current => {
      const visits = change(current.root === libraryRoot ? current.visits : readRecentVisits(latest.current.storageKey(libraryRoot)));
      return { root: libraryRoot, visits };
    });
  }, [libraryRoot]);
  const record = useCallback((destination?: string | null) => {
    const state = latest.current;
    const id = destination === undefined ? state.currentId : destination;
    if (state.ready && id && eligible(id)) update(visits => recordRecentFolder(visits, id));
  }, [update]);
  useEffect(() => {
    if (!ready || !currentId) return;
    dwellTimer.current = window.setTimeout(() => record(), 3000);
    return () => window.clearTimeout(dwellTimer.current);
  }, [currentId, ready, record]);
  useEffect(() => {
    if (!ready) return;
    const visits = stored.root === libraryRoot ? stored.visits : readRecentVisits(storageKey(libraryRoot));
    // The character hub's first read can land after classifications. Do not erase
    // persisted groups while that independent catalog has not arrived yet.
    const keep = (visit: RecentFolderVisit) => eligible(visit.id) || (!pinnedIds.includes(visit.id) && latest.current.isLateId(visit.id));
    if (stored.root !== libraryRoot || visits.some(visit => !keep(visit))) update(items => items.filter(keep));
  }, [catalog, pinnedIds, ready, libraryRoot, stored, update]);
  const visits = stored.root === libraryRoot ? stored.visits : readRecentVisits(storageKey(libraryRoot));
  const folders = useMemo(() => visits.flatMap(visit => catalog.has(visit.id) && !pinnedIds.includes(visit.id) ? [catalog.get(visit.id)!] : []), [visits, catalog, pinnedIds]);
  return {
    folders, currentId, record,
    open: folder => { record(folder.id); latest.current.onOpen(folder); },
    remove: id => { if (id === currentId) window.clearTimeout(dwellTimer.current); update(items => items.filter(visit => visit.id !== id)); },
    clear: () => { window.clearTimeout(dwellTimer.current); update(() => []); },
  };
}
