import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AssetView, ClassificationEntry } from "../library/types";
import type { CharacterGroup } from "../characters/hubApi";
import type { CharacterTarget } from "../characters/api";
import { UI_PREFERENCES_KEY } from "../preferences/uiPreferences";

export type RecentFolderVisit = { id: string; lastUsed: number };
export type RecentFolder = {
  id: string; name: string; parentName: string; path: string;
  folder: ClassificationEntry; group: boolean; view: AssetView;
};

export function recordRecentFolder(visits: RecentFolderVisit[], id: string, now = Date.now()): RecentFolderVisit[] {
  if (visits.some(visit => visit.id === id)) return visits.map(visit => visit.id === id ? { id, lastUsed: now } : visit);
  const next = [...visits];
  if (next.length >= 8) {
    const oldest = next.reduce((a, b) => a.lastUsed < b.lastUsed ? a : b);
    next.splice(next.indexOf(oldest), 1);
  }
  return [{ id, lastUsed: now }, ...next];
}

// A sibling of the expanded-folder preference, scoped to this device's library.
export function recentFoldersStorageKey(libraryRoot: string): string {
  return `${UI_PREFERENCES_KEY}.recentFolders:${encodeURIComponent(libraryRoot)}`;
}

export function loadRecentFolders(libraryRoot: string, storage: Storage = localStorage): RecentFolderVisit[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(recentFoldersStorageKey(libraryRoot)) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is RecentFolderVisit =>
      typeof item?.id === "string" && typeof item?.lastUsed === "number").slice(0, 8) : [];
  } catch { return []; }
}

export function recentFolderCatalog(classifications: ClassificationEntry[], groups: CharacterGroup[], targets: CharacterTarget[]): Map<string, RecentFolder> {
  const catalog = new Map<string, RecentFolder>();
  const byId = new Map(classifications.map(folder => [folder.id, folder]));
  const pathFor = (folder: ClassificationEntry) => {
    const names: string[] = [];
    let entry: ClassificationEntry | undefined = folder;
    while (entry) { names.unshift(entry.name); entry = entry.parentId ? byId.get(entry.parentId) : undefined; }
    return names.join(" › ");
  };
  for (const folder of classifications) {
    catalog.set(folder.id, { id: folder.id, name: folder.name,
      parentName: folder.parentId ? byId.get(folder.parentId)?.name ?? "" : "",
      path: pathFor(folder), folder, group: false,
      view: { kind: "classification", classificationId: folder.id } });
  }
  for (const group of groups) {
    const folder = byId.get(group.seriesId);
    if (!folder) continue;
    const id = `character-group:${group.id}`;
    catalog.set(id, { id, name: group.name, parentName: folder.name,
      path: `${pathFor(folder)} › ${group.name}`, folder, group: true,
      view: { kind: "classification", classificationId: group.seriesId, characterGroupId: group.id } });
  }
  for (const target of targets) {
    if (groups.some(group => group.targetIds.includes(target.id) || group.extrasTargetId === target.id || group.id === target.extrasGroupId)) continue;
    const folder = target.linkedClassificationId ? byId.get(target.linkedClassificationId) : undefined;
    const series = target.seriesClassificationId ? byId.get(target.seriesClassificationId) : undefined;
    if (!series) continue;
    const id = folder?.id ?? `character:${target.id}`;
    const name = target.role === "extras" ? "기타" : folder?.name ?? target.displayName;
    catalog.set(id, { id, name, parentName: series.name,
      path: folder ? pathFor(folder) : `${pathFor(series)} › ${name}`,
      folder: folder ?? series, group: false,
      view: { kind: "classification", classificationId: series.id, characterId: target.id } });
  }
  return catalog;
}

export function recentFolderId(view: AssetView, groups: CharacterGroup[], targets: CharacterTarget[]): string | null {
  if (view.kind !== "classification" || !view.classificationId) return null;
  if (view.characterGroupId) return `character-group:${view.characterGroupId}`;
  const target = targets.find(entry => entry.id === view.characterId || (!view.characterId && entry.linkedClassificationId === view.classificationId));
  if (view.characterId && !target) return null;
  const group = target && groups.find(entry => entry.targetIds.includes(target.id) || entry.extrasTargetId === target.id || entry.id === target.extrasGroupId);
  if (group) return `character-group:${group.id}`;
  if (target) return target.linkedClassificationId ?? `character:${target.id}`;
  return view.classificationId;
}

export type RecentFoldersState = {
  folders: RecentFolder[]; currentId: string | null;
  open: (folder: RecentFolder) => void; record: (view?: AssetView) => void;
  remove: (id: string) => void; clear: () => void;
};
export const RecentFoldersContext = createContext<RecentFoldersState | null>(null);
export const useRecentFolders = () => useContext(RecentFoldersContext);

export function useRecentFolderHistory({ libraryRoot, view, classifications, groups, targets, pinnedIds, ready, onOpen }: {
  libraryRoot: string; view: AssetView; classifications: ClassificationEntry[]; groups: CharacterGroup[];
  targets: CharacterTarget[]; pinnedIds: string[]; ready: boolean; onOpen: (view: AssetView) => void;
}): RecentFoldersState {
  const [stored, setStored] = useState(() => ({ root: libraryRoot, visits: loadRecentFolders(libraryRoot) }));
  useEffect(() => {
    try { localStorage.setItem(recentFoldersStorageKey(stored.root), JSON.stringify(stored.visits)); } catch { /* storage unavailable: keep the in-memory list */ }
  }, [stored]);
  const catalog = useMemo(() => recentFolderCatalog(classifications, groups, targets), [classifications, groups, targets]);
  const currentId = recentFolderId(view, groups, targets);
  const latest = useRef({ view, catalog, groups, targets, pinnedIds, ready, onOpen });
  const dwellTimer = useRef<number | undefined>(undefined);
  const charactersLoaded = useRef(false);
  if (groups.length || targets.length) charactersLoaded.current = true;
  latest.current = { view, catalog, groups, targets, pinnedIds, ready, onOpen };
  const eligible = (id: string) => latest.current.catalog.has(id) && !latest.current.pinnedIds.includes(id);
  const update = useCallback((change: (visits: RecentFolderVisit[]) => RecentFolderVisit[]) => {
    setStored(current => {
      const visits = change(current.root === libraryRoot ? current.visits : loadRecentFolders(libraryRoot));
      return { root: libraryRoot, visits };
    });
  }, [libraryRoot]);
  const record = useCallback((destination?: AssetView) => {
    const state = latest.current;
    const id = recentFolderId(destination ?? state.view, state.groups, state.targets);
    if (state.ready && id && eligible(id)) update(visits => recordRecentFolder(visits, id));
  }, [update]);
  useEffect(() => {
    if (!ready || !currentId) return;
    dwellTimer.current = window.setTimeout(() => record(), 3000);
    return () => window.clearTimeout(dwellTimer.current);
  }, [currentId, ready, record]);
  useEffect(() => {
    if (!ready) return;
    const visits = stored.root === libraryRoot ? stored.visits : loadRecentFolders(libraryRoot);
    // The character hub's first read can land after classifications. Do not erase
    // persisted groups while that independent catalog has not arrived yet.
    const keep = (visit: RecentFolderVisit) => eligible(visit.id) || (!charactersLoaded.current &&
      !pinnedIds.includes(visit.id) && (visit.id.startsWith("character-group:") || visit.id.startsWith("character:")));
    if (stored.root !== libraryRoot || visits.some(visit => !keep(visit))) update(items => items.filter(keep));
  }, [catalog, pinnedIds, ready, libraryRoot, stored, update]);
  const visits = stored.root === libraryRoot ? stored.visits : loadRecentFolders(libraryRoot);
  const folders = useMemo(() => visits.flatMap(visit => catalog.has(visit.id) && !pinnedIds.includes(visit.id) ? [catalog.get(visit.id)!] : []), [visits, catalog, pinnedIds]);
  return {
    folders, currentId, record,
    open: folder => { record(folder.view); latest.current.onOpen(folder.view); },
    remove: id => { if (id === currentId) window.clearTimeout(dwellTimer.current); update(items => items.filter(visit => visit.id !== id)); },
    clear: () => { window.clearTimeout(dwellTimer.current); update(() => []); },
  };
}
