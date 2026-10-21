import { useCallback, useEffect, useState } from "react";
import { characterApi, type CharacterTarget } from "../../characters/api";
import { characterHubApi, type CharacterBrowsePage } from "../../characters/hubApi";
import type { ClassificationEntry, FavoriteEntry, LibraryGateway } from "../../library/types";
import { commandErrorMessage } from "../../library/errorMessage";
import { subscribeWindowFocus } from "../../app/windowFocus";

type Catalog = { targets: CharacterTarget[]; classifications: ClassificationEntry[]; counts: Record<string, number>; firstAssets: Record<string, string>; unavailableAssets: Set<string> };
const cache = new WeakMap<LibraryGateway, Map<string, Catalog>>();

export function browseFavoriteAssets(target: CharacterTarget, after: string | null = null): Promise<CharacterBrowsePage> {
  return characterHubApi.browse({ seriesId: target.seriesClassificationId!, targetId: target.id, after, limit: 100, all: true });
}

export function useFavoriteCatalog(gateway: LibraryGateway, root: string, entries: FavoriteEntry[] = [], enabled = true) {
  const [snapshot, setSnapshot] = useState(() => ({ root, data: cache.get(gateway)?.get(root) ?? null }));
  const data = snapshot.root === root ? snapshot.data : cache.get(gateway)?.get(root) ?? null;
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const coverKey = JSON.stringify(entries.map(entry => [entry.characterId, entry.coverAssetId]));
  const load = useCallback(async () => {
    const [targets, classifications, counts] = await Promise.all([
      characterApi.targets(), gateway.listClassifications(), gateway.characterSidebarCounts?.(),
    ]);
    const favoriteCovers = JSON.parse(coverKey) as [string, string | null][];
    const favoriteIds = new Set(favoriteCovers.map(([id]) => id));
    const imageIds = [...new Set([...favoriteCovers.flatMap(([, id]) => id ? [id] : []), ...targets.flatMap(target => favoriteIds.has(target.id) && target.thumbnailAssetId ? [target.thumbnailAssetId] : [])])];
    const unavailableAssets = new Set<string>();
    if (imageIds.length && gateway.refreshAssets) {
      const activeIds = new Set<string>();
      for (let offset = 0; offset < imageIds.length; offset += 500) {
        const found = await gateway.refreshAssets({ classificationId: null, albumId: null, collectionId: null, directOnly: false, unclassifiedOnly: false, mediaKind: null, aspectRatio: null, sort: "newest", randomPivot: null, after: null, limit: 500 }, imageIds.slice(offset, offset + 500));
        found.forEach(asset => activeIds.add(asset.id));
      }
      imageIds.filter(id => !activeIds.has(id)).forEach(id => unavailableAssets.add(id));
    }
    const existing = targets.filter(target => target.role !== "extras" && target.seriesClassificationId
      && classifications.some(folder => folder.id === target.seriesClassificationId));
    const available = existing.map(target => unavailableAssets.has(target.thumbnailAssetId ?? "") ? { ...target, thumbnailAssetId: null } : target);
    const firstAssets: Record<string, string> = {};
    // Only displayed favourites without a thumbnail need a first-asset read.
    const missing = available.filter(target => favoriteIds.has(target.id) && !target.thumbnailAssetId);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
      while (index < missing.length) {
        const target = missing[index++];
        const page = await characterHubApi.browse({ seriesId: target.seriesClassificationId!, targetId: target.id, after: null, limit: 1, all: true });
        if (page.items[0]) firstAssets[target.id] = page.items[0].id;
      }
    }));
    return { targets: available, classifications, counts: counts?.targets ?? {}, firstAssets, unavailableAssets };
  }, [gateway, coverKey]);
  useEffect(() => {
    // Collections mounts this for the 캐릭터 button; the catalog is read only while that view is open.
    if (!root || !enabled) return;
    let active = true, running = false;
    const refresh = () => {
      if (running) return;
      running = true;
      void load().then(next => {
        if (!active) return;
        let byRoot = cache.get(gateway);
        if (!byRoot) { byRoot = new Map(); cache.set(gateway, byRoot); }
        byRoot.set(root, next); setSnapshot({ root, data: next }); setError(null);
      }, reason => { if (active) setError(commandErrorMessage(reason, "캐릭터 폴더를 불러오지 못했습니다.")); }).finally(() => { running = false; });
    };
    refresh();
    const stop = subscribeWindowFocus(() => { if (document.hasFocus()) refresh(); });
    const timer = setInterval(refresh, 60_000);
    return () => { active = false; stop(); clearInterval(timer); };
  }, [gateway, root, load, revision, enabled]);
  return { data, error, refresh: () => setRevision(value => value + 1) };
}

export type FavoriteCatalog = Catalog;
