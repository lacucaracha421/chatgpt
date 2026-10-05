import { assetQueryBase } from "../assets/AssetBrowser";
import { assetFolderFilters, prefetchRead } from "../assets/folderPrefetch";
import { getAutoTagFilter, hasAutoTagFilter } from "../autotags/autoTagFilter";
import { opensAsSeries } from "../characters/CharacterFolderContent";
import type { CharacterSeries } from "../characters/hubApi";
import { prefetchSeriesOverview } from "../characters/SeriesBrowser";
import type { AssetSort, AssetView, ClassificationEntry, LibraryGateway } from "../library/types";

/**
 * The first-page reads a switch from `current` to the folder `target` would make, started now
 * (read-only). Null when the target is the open folder or its request cannot be known exactly.
 */
export function planFolderPrefetch(target: AssetView, { current, gateway, series, classifications, sort }: {
  current: AssetView; gateway: LibraryGateway; series: CharacterSeries[]; classifications: ClassificationEntry[]; sort: AssetSort;
}): Promise<unknown>[] | null {
  if (target.kind !== "classification" || !target.classificationId || target.characterId || target.characterGroupId) return null;
  const id = target.classificationId;
  if (current.kind === "classification" && current.classificationId === id && !current.characterId && !current.characterGroupId) return null;
  if (opensAsSeries(id, series, classifications)) return prefetchSeriesOverview(id);
  // A plain folder: the mounted browser keeps its filters across folders; a fresh one starts unfiltered.
  const filters = assetFolderFilters() ?? { mediaFilter: "all" as const, aspectFilter: "all" as const, randomPivot: null };
  if (sort === "random" && !filters.randomPivot) return null;
  const autoTags = getAutoTagFilter();
  const request = { ...assetQueryBase(target, { directOnly: true, ...filters, sort, autoTags: hasAutoTagFilter(autoTags) ? autoTags : null }), after: null, aroundDate: null };
  return [prefetchRead(gateway, "listAssets", request, () => gateway.listAssets(request))];
}
