import { useCoalescedRefreshVersion } from "../shared/useCoalescedRefreshVersion";
import { libraryContextItems } from "./libraryContextItems";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderIcon } from "@heroicons/react/24/outline";
import { ASSET_PAGE_SIZE } from "../library/constants";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { AlbumEntry, AssetAspectFilter, AssetCursor, AssetDateBucket, AssetMediaFilter, AssetQuery, AssetSort, AssetSummary, AssetView, ClassificationEntry, CollectionSummary } from "../library/types";
import { Button } from "../shared/ui/Button";
import { ContextMenu, type ContextMenuItem } from "../shared/ui/ContextMenu";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import type { InternalDragPayload } from "../shared/interaction/pointerDrag";
import { useArtistGateway, useArtistRevision } from "../artists/artistStore";
import { AssignArtistDialog } from "../artists/AssignArtistDialog";
import { useArtistScopeChrome } from "../artists/ArtistPage";
import { isUnknownArtist } from "../artists/types";
import { faultSelectionItem, useFaultGame } from "../games/FaultGame";
import { AutoTagFilterBadges } from "../autotags/AutoTagFilterBadges";
import { clearAutoTagFilter, hasAutoTagFilter, useAutoTagFilter } from "../autotags/autoTagFilter";
import { useInfoPanelPreference } from "./useInfoPanelPreference";
import { AssetGallery } from "./AssetGallery";
import { AssetInfoPanel } from "./AssetInfoPanel";
import { AssetInspector } from "./AssetInspector";
import { AssetToolbar } from "./AssetToolbar";
import { AssetViewer } from "./AssetViewer";
import { SelectionBar } from "./SelectionBar";
import { thumbnailUrl } from "./mediaUrl";
import { CharacterAssignPicker } from "../characters/CharacterAssignPicker";
import { moveAssetsToCharacters, type CharacterTarget } from "../characters/api";
import { characterHubApi, type CharacterGroup, type CharacterHubApi } from "../characters/hubApi";
import { applySelectionGesture, emptySelection, focusAsset, moveSelectionFocus, reconcileSelection, selectAllLoaded, type SelectionGesture, type SelectionState } from "./selection";
import { FolderFilterControl, FolderShelf } from "./FolderShelf";

export type AssetBrowserStatus = { loadedCount: number; totalCount?: number; selectedAsset: AssetSummary | null; loading: boolean };
type Props = { navigationMemory?: AssetNavigationMemory; onReviewVideos?: (assetIds: string[]) => void; galleryLayout?: "masonry" | "justified"; onGalleryLayoutChange?: (layout: "masonry" | "justified") => void; view: AssetView; onViewChange?: (view: AssetView) => void; classifications: ClassificationEntry[]; characterTargets?: CharacterTarget[]; characterGroups?: CharacterGroup[]; onCharactersChanged?: () => void; albums?: AlbumEntry[]; collections?: CollectionSummary[]; onCollectionsChanged?: () => void; onMembershipChanged?: () => void; sort: AssetSort; metadataVisible: boolean; privacyMode: boolean; onPrivacyModeChange: (privacyMode: boolean) => void; thumbnailRowHeight?: number; refreshVersion: number; clearSelectionRequest?: number; requestedAsset?: AssetSummary | null; onRequestedAssetHandled?: () => void; onSortChange: (sort: AssetSort) => void; onMetadataVisibleChange: (visible: boolean) => void; onThumbnailRowHeightChange?: (height: number) => void; onStatusChange: (status: AssetBrowserStatus) => void; folderShelfApi?: Pick<CharacterHubApi, "seriesFolders">; onPointerDragStart?: (payload: InternalDragPayload, event: React.PointerEvent<HTMLElement>) => void; onPointerDragMove?: (event: React.PointerEvent<HTMLElement>) => void; onPointerDragEnd?: (event: React.PointerEvent<HTMLElement>) => void; onPointerDragCancel?: (event: React.PointerEvent<HTMLElement>) => void };
type PageState = { sort: AssetSort; queryKey: string; items: AssetSummary[]; headCursor: AssetCursor | null; tailCursor: AssetCursor | null; totalCount: number | null };
export type AssetNavigationMemory = Map<string, PageState>;
type QueryError = { queryKey: string; message: string };
const EMPTY_ASSETS: AssetSummary[] = [];
const ALL_DATE_BUCKETS = {
  startUtc: "0001-01-01T00:00:00.000Z",
  endUtc: "9999-12-31T23:59:59.999Z",
  offsetMinutes: -new Date().getTimezoneOffset(),
};

function useStyleSuggestionAssetIds(enabled: boolean) {
  const gateway = useArtistGateway();
  const revision = useArtistRevision();
  const [result, setResult] = useState<{ ids: Set<string>; totalImages: number } | null>(null);
  useEffect(() => {
    if (!enabled || !gateway) { setResult(null); return; }
    let active = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const status = await gateway.styleStatus();
        const ids: string[] = [];
        let offset = 0;
        let totalImages = 0;
        for (;;) {
          const page = await gateway.styleSuggestions(offset, 100);
          totalImages = page.totalImages;
          ids.push(...page.groups.flatMap((group) => group.candidates.map((candidate) => candidate.assetId)));
          offset += page.groups.length;
          if (page.groups.length === 0 || offset >= page.totalArtists) break;
        }
        if (active) setResult({ ids: new Set(ids), totalImages });
        if (active && status.computing) timer = window.setTimeout(() => { void load(); }, 1500);
      } catch {
        if (active) setResult({ ids: new Set(), totalImages: 0 });
      }
    };
    void load();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [enabled, gateway, revision]);
  return result;
}


export function AssetBrowser({ navigationMemory, onReviewVideos, galleryLayout = "masonry", onGalleryLayoutChange, view, onViewChange, classifications, characterTargets = [], characterGroups = [], onCharactersChanged = () => undefined, albums = [], collections = [], onCollectionsChanged = () => undefined, onMembershipChanged = () => undefined, sort, metadataVisible, privacyMode, onPrivacyModeChange, thumbnailRowHeight = 180, refreshVersion, clearSelectionRequest = 0, requestedAsset = null, onRequestedAssetHandled = () => undefined, onSortChange, onMetadataVisibleChange, onThumbnailRowHeightChange = () => undefined, onStatusChange, folderShelfApi = characterHubApi, onPointerDragStart, onPointerDragMove, onPointerDragEnd, onPointerDragCancel }: Props) {
  const { gateway } = useLibrary();
  const [assignOpen, setAssignOpen] = useState(false);
  const [directOnlyState, setDirectOnlyState] = useState<{ folderId: string | null; value: boolean }>({ folderId: null, value: true });
  const [mediaFilter, setMediaFilter] = useState<AssetMediaFilter>("all");
  const [aspectFilter, setAspectFilter] = useState<AssetAspectFilter>("all");
  const [page, setPage] = useState<PageState | null>(null);
  const [firstLoading, setFirstLoading] = useState(true);
  const [nextLoading, setNextLoading] = useState(false);
  const [prevLoading, setPrevLoading] = useState(false);
  const galleryRefreshVersion = useCoalescedRefreshVersion(refreshVersion, firstLoading || nextLoading || prevLoading);
  const [firstError, setFirstError] = useState<QueryError | null>(null);
  const [nextError, setNextError] = useState<QueryError | null>(null);
  const [prevError, setPrevError] = useState<QueryError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [newAssetsAvailable, setNewAssetsAvailable] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [randomVersion, setRandomVersion] = useState(0);
  const [selectedAsset, setSelectedAsset] = useState<AssetSummary | null>(null);
  const [selection, setSelection] = useState<SelectionState>(emptySelection);
  const [viewerAssetId, setViewerAssetId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useInfoPanelPreference();
  const [batchPending, setBatchPending] = useState(false);
  const [undoAssetIds, setUndoAssetIds] = useState<string[] | null>(null);
  const [characterOpen, setCharacterOpen] = useState(false);
  const [characterCounts, setCharacterCounts] = useState<Record<string, number>>({});
  const [characterNotice, setCharacterNotice] = useState<{ id: number; count: number; target: CharacterTarget } | null>(null);
  const [dateBuckets, setDateBuckets] = useState<AssetDateBucket[]>([]);
  const dismissMessage = useCallback((value: null) => { setMessage(value); setUndoAssetIds(null); }, []);
  useAutoDismiss(message, dismissMessage);
  const dismissCharacterNotice = useCallback((_value: null) => setCharacterNotice(null), []);
  useAutoDismiss(characterNotice ? String(characterNotice.id) : null, dismissCharacterNotice);
  const selectedViewKeyRef = useRef<string | null>(null);
  const viewerViewKeyRef = useRef<string | null>(null);
  const requestedAssetRef = useRef<AssetSummary | null>(requestedAsset);
  const clearSelectionRequestRef = useRef(clearSelectionRequest);
  requestedAssetRef.current = requestedAsset;
  const generationRef = useRef(0);
  const characterNoticeIdRef = useRef(0);
  const nextLoadingRef = useRef(false);
  const prevLoadingRef = useRef(false);
  const randomPivotRef = useRef<string | null>(null);
  const filterable = view.kind === "classification" || view.kind === "unsorted" || view.kind === "album" || view.kind === "creator";
  if (sort === "random" && !randomPivotRef.current) randomPivotRef.current = createRandomPivot();
  useEffect(() => { if (sort !== "random") randomPivotRef.current = null; }, [sort]);
  const plainFolderId = view.kind === "classification" && view.classificationId && !view.characterId && !view.characterGroupId ? view.classificationId : null;
  const folderChildren = useMemo(() => plainFolderId
    ? classifications.filter(entry => entry.parentId === plainFolderId).sort((a, b) => a.name.localeCompare(b.name, "ko"))
    : [], [classifications, plainFolderId]);
  const folderEntry = plainFolderId ? classifications.find(entry => entry.id === plainFolderId) : undefined;
  const directOnly = directOnlyState.folderId === plainFolderId ? directOnlyState.value : true;
  const folderChildrenKey = folderChildren.map(entry => entry.id).join(",");
  const [folderThumbnails, setFolderThumbnails] = useState<Record<string, string | null>>({});
  useEffect(() => {
    setDirectOnlyState(current => current.folderId === plainFolderId ? current : { folderId: plainFolderId, value: true });
  }, [plainFolderId]);
  useEffect(() => {
    if (!plainFolderId || folderChildren.length === 0) { setFolderThumbnails({}); return; }
    let active = true;
    setFolderThumbnails(current => Object.fromEntries(folderChildren
      .filter(child => child.id in current).map(child => [child.id, current[child.id]])));
    void folderShelfApi.seriesFolders(plainFolderId).catch(() => []).then(async result => {
      const thumbnails: Record<string, string | null> = Object.fromEntries((Array.isArray(result) ? result : []).map(item => [item.classificationId, item.thumbnailAssetId]));
      // seriesFolders skips series and character folders; give those the newest image below them.
      const missing = folderChildren.filter(child => !thumbnails[child.id]).slice(0, 40);
      const found = await Promise.all(missing.map(child => gateway.listAssets({ classificationId: child.id, albumId: null, collectionId: null, directOnly: false, unclassifiedOnly: false, mediaKind: "images", aspectRatio: null, sort: "newest", randomPivot: null, after: null, limit: 1 })
        .then(page => [child.id, page.items[0]?.id ?? null] as const, () => [child.id, null] as const)));
      if (active) setFolderThumbnails({ ...thumbnails, ...Object.fromEntries(found) });
    });
    return () => { active = false; };
    // folderChildren is keyed by folderChildrenKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderChildren.length, folderChildrenKey, folderShelfApi, gateway, plainFolderId, refreshVersion]);
  const creatorKey = view.kind === "creator" ? view.creatorKey : null;
  const styleSuggestionsOnly = view.kind === "creator" && isUnknownArtist(view.creatorKey) && view.styleSuggestionsOnly === true;
  const styleSuggestionAssets = useStyleSuggestionAssetIds(styleSuggestionsOnly);
  const autoTagFilter = useAutoTagFilter();
  const autoTagFiltered = hasAutoTagFilter(autoTagFilter);
  const queryBase = useMemo<Omit<AssetQuery, "after">>(() => ({ classificationId: view.kind === "classification" ? view.classificationId : null, albumId: view.kind === "album" ? view.albumId : null, collectionId: view.kind === "collection" ? view.collectionId : null, creatorKey, directOnly: view.kind === "classification" && Boolean(view.classificationId) && !view.characterId && !view.characterGroupId ? directOnly : false, unclassifiedOnly: view.kind === "unsorted", mediaKind: filterable && mediaFilter !== "all" ? mediaFilter : null, aspectRatio: filterable && aspectFilter !== "all" ? aspectFilter : null, sort, randomPivot: sort === "random" ? randomPivotRef.current : null, collectedRange: null, ...(autoTagFiltered ? { autoTags: autoTagFilter } : {}), limit: ASSET_PAGE_SIZE }), [aspectFilter, autoTagFilter, autoTagFiltered, creatorKey, directOnly, sort, filterable, mediaFilter, randomVersion, view]);
  const queryKey = JSON.stringify(queryBase);
  useEffect(() => setNewAssetsAvailable(false), [queryKey]);
  const viewKey = view.kind === "classification" ? `classification:${view.classificationId}` : view.kind === "album" ? `album:${view.albumId}` : view.kind === "collection" ? `collection:${view.collectionId}` : view.kind === "creator" ? `creator:${view.creatorKey}:${view.styleSuggestionsOnly ? "suggested" : "all"}` : view.kind;
  const activePage = page?.queryKey === queryKey ? page : null;
  const rawItems = activePage?.items ?? EMPTY_ASSETS;
  const items = styleSuggestionsOnly
    ? styleSuggestionAssets ? rawItems.filter((asset) => styleSuggestionAssets.ids.has(asset.id)) : EMPTY_ASSETS
    : rawItems;
  const itemIds = useMemo(() => items.map((asset) => asset.id), [items]);
  const pageRef = useRef(activePage);
  pageRef.current = activePage;
  const headCursor = activePage?.headCursor ?? null;
  const tailCursor = activePage?.tailCursor ?? null;
  const currentFirstError = firstError?.queryKey === queryKey ? firstError.message : null;
  const currentNextError = nextError?.queryKey === queryKey ? nextError.message : null;
  const currentPrevError = prevError?.queryKey === queryKey ? prevError.message : null;
  const refresh = useCallback(() => setRetryVersion((value) => value + 1), []);
  useEffect(() => {
    if (!page || !navigationMemory) return;
    // Display-only snapshots: mutations and paging always use a freshly read page.
    navigationMemory.delete(page.queryKey);
    navigationMemory.set(page.queryKey, { ...page, items: page.items.slice(0, 200) });
    while (navigationMemory.size > 8) navigationMemory.delete(navigationMemory.keys().next().value!);
  }, [page, navigationMemory]);
  useEffect(() => {
    nextLoadingRef.current = false; prevLoadingRef.current = false; setFirstLoading(true); setNextLoading(false); setPrevLoading(false); setFirstError(null); setNextError(null); setPrevError(null);
    const generation = ++generationRef.current;
    const request = { ...queryBase, after: null, aroundDate: null };
    const retained = pageRef.current;
    const load = async () => {
      if (!retained?.items.length || !gateway.refreshAssets) return gateway.listAssets(request);
      const first = retained.headCursor === null ? await gateway.listAssets(request) : null;
      const refreshed = new Map<string, AssetSummary>();
      for (let offset = 0; offset < retained.items.length; offset += 500) {
        if (generation !== generationRef.current) return null;
        const batch = await gateway.refreshAssets(request, retained.items.slice(offset, offset + 500).map(asset => asset.id));
        for (const asset of batch) refreshed.set(asset.id, asset);
      }
      let items = retained.items.flatMap(asset => { const fresh = refreshed.get(asset.id); return fresh ? [fresh] : []; });
      if (!items.length) return first ?? gateway.listAssets(request);
      if (generation !== generationRef.current) return null;
      if (first) {
        const overlap = first.items.some(asset => refreshed.has(asset.id));
        setNewAssetsAvailable(!overlap && first.items.length > 0);
        if (overlap) {
          const retainedIds = new Set(retained.items.map(asset => asset.id));
          const freshItems = first.items.filter(asset => !retainedIds.has(asset.id) || refreshed.has(asset.id))
            .map(asset => refreshed.get(asset.id) ?? asset);
          const freshIds = new Set(freshItems.map(asset => asset.id));
          items = [...freshItems, ...items.filter(asset => !freshIds.has(asset.id))];
        }
      }
      if (queryBase.sort !== "random") items.sort((a, b) => {
        if (queryBase.sort === "favorites" && a.favorite !== b.favorite) return Number(b.favorite) - Number(a.favorite);
        const order = a.collectedAt.localeCompare(b.collectedAt) || a.id.localeCompare(b.id);
        return queryBase.sort === "oldest" ? order : -order;
      });
      return { items, previousCursor: retained.headCursor, nextCursor: retained.tailCursor, totalCount: first?.totalCount ?? retained.totalCount };
    };
    void load().then((result) => {
      if (!result) return;
      if (generation !== generationRef.current) return;
      setPage({ sort: queryBase.sort, queryKey, items: result.items, headCursor: result.previousCursor ?? null, tailCursor: result.nextCursor, totalCount: result.totalCount ?? null });
      setSelectedAsset((selected) => reconcileAsset(selected, selectedViewKeyRef.current, viewKey, result.items));
      setViewerAssetId((assetId) => requestedAssetRef.current?.id === assetId ? assetId : reconcileAssetId(assetId, viewerViewKeyRef.current, viewKey, result.items));
    }).catch((error: unknown) => { if (generation === generationRef.current) setFirstError({ queryKey, message: commandErrorMessage(error, "자산을 불러오지 못했습니다.") }); }).finally(() => { if (generation === generationRef.current) setFirstLoading(false); });
    return () => { ++generationRef.current; };
  }, [gateway, queryKey, galleryRefreshVersion, retryVersion, view.kind, viewKey]);
  useEffect(() => {
    let cancelled = false;
    void gateway.listAssetDateBuckets(ALL_DATE_BUCKETS).then((result) => {
      if (!cancelled) setDateBuckets(result);
    }).catch(() => { if (!cancelled) setDateBuckets([]); });
    return () => { cancelled = true; };
  }, [gateway, refreshVersion]);
  const totalAssets = useMemo(() => dateBuckets.reduce((sum, bucket) => sum + bucket.count, 0), [dateBuckets]);
  useEffect(() => onStatusChange({ loadedCount: items.length, totalCount: totalAssets, selectedAsset, loading: firstLoading || nextLoading || prevLoading }), [firstLoading, items.length, nextLoading, onStatusChange, prevLoading, selectedAsset, totalAssets]);
  useEffect(() => {
    setSelection((current) => reconcileSelection(current, itemIds));
  }, [itemIds]);
  useEffect(() => {
    setSelection(emptySelection());
    setSelectedAsset(null);
  }, [viewKey]);
  useEffect(() => {
    if (!requestedAsset) return;
    viewerViewKeyRef.current = null;
    setViewerAssetId(requestedAsset.id);
  }, [requestedAsset]);
  useEffect(() => {
    if (selection.ids.size === 0) setCharacterOpen(false);
  }, [selection.ids.size]);
  useEffect(() => {
    if (!characterOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".asset-selection-bar__character")) setCharacterOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [characterOpen]);
  const loadNextPage = useCallback((retry = false) => {
    if (!activePage || !tailCursor || nextLoadingRef.current || (currentNextError && !retry)) return;
    const generation = generationRef.current; const cursor = tailCursor; nextLoadingRef.current = true; setNextLoading(true); setNextError(null);
    void gateway.listAssets({ ...queryBase, after: cursor, aroundDate: null }).then((result) => {
      if (generation !== generationRef.current) return;
      setPage((current) => {
        if (current?.queryKey !== queryKey) return current;
        const existing = new Set(current.items.map((asset) => asset.id));
        const fresh = result.items.filter((asset) => !existing.has(asset.id));
        // A terminal page can contain only overlap; it still ends pagination.
        if (fresh.length === 0) return result.nextCursor === null ? { ...current, tailCursor: null } : current;
        return { sort: queryBase.sort, queryKey, items: [...current.items, ...fresh], headCursor: current.headCursor, tailCursor: result.nextCursor, totalCount: result.totalCount ?? current.totalCount };
      });
    }).catch((error: unknown) => { if (generation === generationRef.current) setNextError({ queryKey, message: commandErrorMessage(error, "다음 자산을 불러오지 못했습니다.") }); }).finally(() => { if (generation === generationRef.current) { nextLoadingRef.current = false; setNextLoading(false); } });
  }, [activePage, currentNextError, gateway, queryBase, queryKey, tailCursor]);
  const loadPrevPage = useCallback((retry = false) => {
    if (!activePage || !headCursor || prevLoadingRef.current || (currentPrevError && !retry)) return;
    const generation = generationRef.current; const cursor = headCursor; prevLoadingRef.current = true; setPrevLoading(true); setPrevError(null);
    void gateway.listAssets({ ...queryBase, after: null, before: cursor, aroundDate: null }).then((result) => { if (generation !== generationRef.current) return; setPage((current) => { if (current?.queryKey !== queryKey) return current; const existing = new Set(current.items.map((asset) => asset.id)); const fresh = result.items.filter((asset) => !existing.has(asset.id)); if (fresh.length === 0) return current; return { sort: queryBase.sort, queryKey, items: [...fresh, ...current.items], headCursor: result.previousCursor ?? null, tailCursor: current.tailCursor, totalCount: result.totalCount ?? current.totalCount }; }); }).catch((error: unknown) => { if (generation === generationRef.current) setPrevError({ queryKey, message: commandErrorMessage(error, "이전 자산을 불러오지 못했습니다.") }); }).finally(() => { if (generation === generationRef.current) { prevLoadingRef.current = false; setPrevLoading(false); } });
  }, [activePage, currentPrevError, gateway, queryBase, queryKey, headCursor]);
  useEffect(() => {
    if (!styleSuggestionsOnly || !styleSuggestionAssets || !activePage || items.length > 0 || !tailCursor || nextLoadingRef.current) return;
    loadNextPage();
  }, [activePage, items.length, loadNextPage, styleSuggestionAssets, styleSuggestionsOnly, tailCursor]);
  const reshuffle = () => { randomPivotRef.current = createRandomPivot(); setRandomVersion((value) => value + 1); };
  const selectWithGesture = (asset: AssetSummary, gesture: SelectionGesture) => {
    const next = applySelectionGesture(selection, itemIds, asset.id, gesture);
    setSelection(next);
    selectedViewKeyRef.current = next.ids.size > 0 ? viewKey : null;
    setSelectedAsset(next.ids.has(asset.id) ? asset : items.find((item) => next.ids.has(item.id)) ?? null);
  };
  const focusAssetOnly = (asset: AssetSummary) => {
    const next = focusAsset(selection, itemIds, asset.id);
    setSelection(next);
    selectedViewKeyRef.current = null;
    setSelectedAsset(null);
    // A click only picks the asset; 정보 stays as the user left it (i or 보기 › 정보) and follows the pick (user, 2026-09-29).
  };
  const clearSelection = () => {
    setSelection(emptySelection());
    selectedViewKeyRef.current = null;
    setSelectedAsset(null);
  };
  useEffect(() => {
    if (clearSelectionRequestRef.current === clearSelectionRequest) return;
    clearSelectionRequestRef.current = clearSelectionRequest;
    clearSelection();
  }, [clearSelectionRequest]);
  const resetFilterNavigation = () => {
    clearSelection();
  };
  const changeMediaFilter = (next: AssetMediaFilter) => {
    resetFilterNavigation();
    setMediaFilter(next);
  };
  const changeAspectFilter = (next: AssetAspectFilter) => {
    resetFilterNavigation();
    setAspectFilter(next);
  };
  const selectAll = () => {
    const next = selectAllLoaded(selection, itemIds);
    setSelection(next);
    selectedViewKeyRef.current = next.ids.size > 0 ? viewKey : null;
    setSelectedAsset((current) => current && next.ids.has(current.id) ? current : items[0] ?? null);
  };
  const moveFocus = (delta: number, extend: boolean) => {
    const next = moveSelectionFocus(selection, itemIds, delta, extend);
    setSelection(next);
    selectedViewKeyRef.current = next.ids.size > 0 ? viewKey : null;
    setSelectedAsset(items.find((item) => item.id === next.focusId) ?? null);
  };
  const selectedIds = itemIds.filter((id) => selection.ids.has(id));
  const selectedAssets = items.filter((asset) => selection.ids.has(asset.id));
  const focusedAsset = selection.focusId ? items.find((asset) => asset.id === selection.focusId) ?? null : null;
  const inspectorAssets = selectedAssets.length > 0 ? selectedAssets : focusedAsset ? [focusedAsset] : EMPTY_ASSETS;
  const openCharacterPicker = (asset?: AssetSummary) => {
    if (characterOpen) return;
    if (selectedIds.length === 0 && asset) selectWithGesture(asset, { toggle: false, range: false });
    if (gateway.characterSidebarCounts) void gateway.characterSidebarCounts().then(result => setCharacterCounts(result.targets)).catch(() => setCharacterCounts({}));
    setCharacterOpen(true);
  };
  const toggleCharacterPicker = () => characterOpen ? setCharacterOpen(false) : openCharacterPicker();
  const updateAssetSummary = (updated: AssetSummary) => {
    setPage((current) => current ? {
      ...current,
      items: current.items.map((item) => item.id === updated.id ? updated : item),
    } : current);
    setSelectedAsset((current) => current?.id === updated.id ? updated : current);
  };
  const runBatch = async (operation: () => Promise<void>, failureMessage: string, targetIds = selectedIds) => {
    if (batchPending || targetIds.length === 0) return false;
    setBatchPending(true);
    setUndoAssetIds(null);
    try {
      await operation();
      refresh();
      return true;
    } catch (error) {
      setMessage(commandErrorMessage(error, failureMessage));
      return false;
    } finally {
      setBatchPending(false);
    }
  };
  const changeMembership = (operation: () => Promise<void>) => void (async () => {
    if (await runBatch(operation, "분류를 변경하지 못했습니다.")) onMembershipChanged();
  })();
  const toggleFavorite = (asset: AssetSummary) => void (async () => {
    try {
      await gateway.setAssetFavorite(asset.id, !asset.favorite);
      refresh();
      onMembershipChanged();
    } catch (error) {
      setMessage(commandErrorMessage(error, "좋아요를 변경하지 못했습니다."));
    }
  })();
  const toggleFocusedFavorite = (asset: AssetSummary) => {
    if (selectedIds.length > 0) {
      const favorite = !selectedAssets.every((selected) => selected.favorite);
      void runBatch(() => gateway.setAssetsFavorite(selectedIds, favorite), "좋아요를 변경하지 못했습니다.").then(changed => { if (changed) onMembershipChanged(); });
      return;
    }
    toggleFavorite(asset);
  };
  const setSelectionFavorite = (favorite: boolean) => void runBatch(() => gateway.setAssetsFavorite(selectedIds, favorite), "좋아요를 변경하지 못했습니다.").then(changed => { if (changed) onMembershipChanged(); });
  const removeFromCollection = () => void (async () => {
    if (view.kind !== "collection") return;
    await runBatch(() => gateway.patchAssetCollections({
      assetIds: selectedIds,
      addCollectionIds: [],
      removeCollectionIds: [view.collectionId],
    }), "컬렉션에서 제거하지 못했습니다.");
  })();
  const setCover = (assetId: string) => void (async () => {
    if (view.kind !== "collection") return;
    try {
      await gateway.setCollectionCover(view.collectionId, assetId);
      onCollectionsChanged();
    } catch (error) {
      setMessage(commandErrorMessage(error, "대표 이미지를 지정하지 못했습니다."));
    }
  })();
  const trashSelection = () => void (async () => {
    const assetIds = selectedIds.length > 0 ? [...selectedIds] : focusedAsset ? [focusedAsset.id] : [];
    const succeeded = await runBatch(() => gateway.trashAssets(assetIds), "자산을 휴지통으로 이동하지 못했습니다.", assetIds);
    if (succeeded) {
      setUndoAssetIds(assetIds);
      setMessage(`${assetIds.length}개 자산을 휴지통으로 이동했습니다.`);
      onMembershipChanged();
    }
  })();
  const assignCharactersToAssets = async (assetIds: string[], targets: CharacterTarget[], clearCurrentSelection = false) => {
    if (batchPending || assetIds.length === 0 || targets.length === 0) return;
    setBatchPending(true); setUndoAssetIds(null); setMessage(null);
    try {
      const moved = await moveAssetsToCharacters(targets.map(target => ({ targetId: target.id, expectedFingerprint: target.fingerprint })), assetIds);
      const first = targets[0]!;
      markAssignedTiles(assetIds, first.displayName);
      setCharacterNotice({ id: ++characterNoticeIdRef.current, count: moved, target: first });
      if (clearCurrentSelection) {
        setCharacterOpen(false);
        clearSelection();
      }
      refresh();
      onCharactersChanged();
    } catch (error) {
      setMessage(commandErrorMessage(error, "캐릭터에 넣지 못했습니다."));
      throw error;
    } finally {
      setBatchPending(false);
    }
  };
  const assignCharacters = (targets: CharacterTarget[]) => assignCharactersToAssets([...selectedIds], targets, true);
  const undoTrash = () => void (async () => {
    const assetIds = undoAssetIds;
    if (!assetIds || batchPending) return;
    setBatchPending(true);
    try {
      await gateway.restoreAssets(assetIds);
      setUndoAssetIds(null);
      setMessage("휴지통 이동을 취소했습니다.");
      refresh();
      onMembershipChanged();
    } catch (error) {
      setMessage(commandErrorMessage(error, "휴지통 이동을 취소하지 못했습니다."));
    } finally {
      setBatchPending(false);
    }
  })();
  // "기존 자산 열기"로 요청된 자산이 현재 페이지에 없으면 뷰어는 그 한 장만 보여 준다.
  const viewerItems = requestedAsset && !items.some((item) => item.id === requestedAsset.id) ? [requestedAsset] : items;
  const viewerFolders = useMemo(() => classifications.filter(isMovableViewerFolder), [classifications]);
  const addViewerAssetToAlbum = (asset: AssetSummary, albumId: string) => void (async () => {
    try {
      await gateway.patchAssetAlbums({ assetIds: [asset.id], addAlbumIds: [albumId], removeAlbumIds: [] });
      refresh();
      onMembershipChanged();
      setMessage("앨범에 추가했습니다.");
    } catch (error) {
      setMessage(commandErrorMessage(error, "앨범에 추가하지 못했습니다."));
    }
  })();
  const moveViewerAssetToFolder = (asset: AssetSummary, classificationId: string) => void (async () => {
    try {
      await gateway.setAssetClassification({ assetIds: [asset.id], classificationId });
      refresh();
      onMembershipChanged();
      setMessage("폴더로 이동했습니다.");
    } catch (error) {
      setMessage(commandErrorMessage(error, "폴더로 이동하지 못했습니다."));
    }
  })();
  const trashViewerAsset = (asset: AssetSummary) => void (async () => {
    const index = viewerItems.findIndex((item) => item.id === asset.id);
    const next = index < 0 ? undefined : viewerItems[index + 1] ?? viewerItems[index - 1];
    try {
      await gateway.trashAssets([asset.id]);
      setUndoAssetIds([asset.id]);
      setMessage("휴지통으로 이동했습니다.");
      setViewerAssetId(next?.id ?? null);
      // 휴지통으로 간 요청 자산이 남아 있으면 이후 갤러리 열기와 시리즈 뷰어가 그 자산에 묶인다.
      if (requestedAssetRef.current?.id === asset.id) onRequestedAssetHandled();
      refresh();
      onMembershipChanged();
    } catch (error) {
      setMessage(commandErrorMessage(error, "자산을 휴지통으로 이동하지 못했습니다."));
    }
  })();
  const hasActiveFilters = filterable && (mediaFilter !== "all" || aspectFilter !== "all");
  const resetFilters = () => { changeMediaFilter("all"); changeAspectFilter("all"); };
  const resetStyleSuggestionFilter = () => {
    if (view.kind === "creator") onViewChange?.({ kind: "creator", creatorKey: view.creatorKey });
  };
  const visiblePage = activePage ?? (!currentFirstError ? navigationMemory?.get(queryKey) ?? page : null);
  const viewerTotalCount = styleSuggestionsOnly ? styleSuggestionAssets?.totalImages ?? null : visiblePage?.totalCount ?? null;
  // 이미지 · 영상 switch at once: while the filtered query loads, narrow the loaded 전체 page in place.
  const narrowingLoadedPage = !activePage && visiblePage === page && page !== null && mediaFilter !== "all" && page.queryKey === JSON.stringify({ ...queryBase, mediaKind: null });
  const rawVisibleItems = narrowingLoadedPage ? page.items.filter((asset) => (asset.media.kind === "video") === (mediaFilter === "videos")) : visiblePage?.items ?? [];
  const visibleItems = styleSuggestionsOnly
    ? styleSuggestionAssets ? rawVisibleItems.filter((asset) => styleSuggestionAssets.ids.has(asset.id)) : EMPTY_ASSETS
    : rawVisibleItems;
  const artistScope = useArtistScopeChrome(view, { onNavigate: onViewChange, privacyMode, onPlay: () => {
    const first = visibleItems[0];
    if (first) { viewerViewKeyRef.current = viewKey; setViewerAssetId(first.id); }
  } });
  // FAULT: any gallery offers its selection.
  const playFault = useFaultGame();
  const contextItems: ContextMenuItem[] = [
    ...(onReviewVideos && selectedAssets.length >= 2 && selectedAssets.length <= 100 && selectedAssets.every(asset => asset.media.kind === "video")
      ? [{ id: "video-similarity", label: "선택한 영상 비교", disabled: batchPending, onSelect: () => onReviewVideos([...selectedIds]) }]
      : []),
    ...libraryContextItems({ count: selectedIds.length, busy: batchPending, albums,
      sourceUrls: selectedAssets.map(asset => asset.sourceUrl),
      onMessage: message => { setUndoAssetIds(null); setMessage(message); },
      onAlbum: id => changeMembership(() => gateway.patchAssetAlbums({ assetIds: selectedIds, addAlbumIds: [id], removeAlbumIds: [] })),
    }),
    ...(view.kind === "album" ? [{ id: "remove-album", label: "이 앨범에서 제외", disabled: batchPending, onSelect: () => changeMembership(() => gateway.patchAssetAlbums({ assetIds: selectedIds, addAlbumIds: [], removeAlbumIds: [view.albumId] })) }] : []),
    ...(view.kind === "collection" ? [{ id: "remove", label: "이 컬렉션에서 제거", disabled: batchPending, onSelect: removeFromCollection }] : []),
    ...(view.kind === "collection" && selectedIds.length === 1 ? [{ id: "cover", label: "대표 이미지로 지정", disabled: batchPending, onSelect: () => setCover(selectedIds[0]!) }] : []),
    ...faultSelectionItem(playFault, selectedAssets),
    ...(gateway.artists ? [{ id: "assign-artist", label: "작가 지정", disabled: batchPending, onSelect: () => setAssignOpen(true) }] : []),
    { id: "info", label: "정보 열기", onSelect: () => setInspectorOpen(true) },
    { id: "trash", label: "휴지통으로 이동", destructive: true, disabled: batchPending, onSelect: trashSelection },
  ];
  const showNewest = () => { setPage(null); pageRef.current = null; setNewAssetsAvailable(false); refresh(); }; // no-flash-ok: 처음부터 보기 is an explicit restart
  const folderShelfIntro = plainFolderId && directOnly && folderChildren.length > 0 ? <>
    <FolderShelf
      label={`폴더 ${folderChildren.length.toLocaleString()}`}
      ariaLabel="하위 폴더"
      cards={folderChildren.map(child => <article className="folder-shelf__card" key={child.id}>
        <button type="button" className="folder-shelf__card-open" aria-label={`${child.name} 폴더 열기`} onClick={() => onViewChange?.({ kind: "classification", classificationId: child.id })}>
          {folderThumbnails[child.id] && !privacyMode
            ? <img draggable={false} loading="lazy" src={thumbnailUrl(folderThumbnails[child.id]!)} alt="" />
            : <span className="folder-shelf__placeholder"><FolderIcon aria-hidden="true" />{privacyMode ? "비공개 폴더" : "폴더 이미지 없음"}</span>}
          <strong><FolderIcon className="folder-shelf__icon" aria-hidden="true" /><span className="folder-shelf__name">{child.name}</span></strong>
          {(child.totalAssetCount ?? child.assetCount) !== undefined && <small>{(child.totalAssetCount ?? child.assetCount)!.toLocaleString("ko-KR")}장</small>}
        </button>
      </article>)}
    />
  </> : null;
  const folderFilterControl = plainFolderId && folderChildren.length > 0 ? <FolderFilterControl
      label="폴더 이미지 필터"
      options={[{ value: "direct", label: "미분류", count: folderEntry?.assetCount }, { value: "all", label: "전체", count: folderEntry?.totalAssetCount }]}
      value={directOnly ? "direct" : "all"}
      onChange={value => setDirectOnlyState({ folderId: plainFolderId, value: value === "direct" })}
    /> : null;
  // Outside the gallery (loading, empty, error) the shelf needs the gallery's own side padding.
  // Same padding as the gallery scroll area (layout-dependent gap + scrollbar lane), so the shelf does
  // not shift when the view moves between a loading/empty state and the gallery.
  const folderHead = folderShelfIntro && <div className={`asset-browser__folder-head${galleryLayout === "masonry" ? " asset-gallery--masonry" : ""}`}>{folderShelfIntro}</div>;
  const directOnlyEmpty = plainFolderId !== null && folderChildren.length > 0 && directOnly;
  const assetResults = (firstLoading && visibleItems.length === 0 && !visiblePage) || (!visiblePage && !currentFirstError)
    ? <>{folderHead}<Skeleton className="asset-browser__skeleton" label="자산을 불러오는 중" /></>
    : currentFirstError && !activePage
      ? <>{folderHead}<EmptyState title="자산을 불러오지 못했습니다"><Button onClick={refresh}>다시 시도</Button></EmptyState></>
      : visibleItems.length === 0 && (hasActiveFilters || autoTagFiltered || styleSuggestionsOnly)
        ? <>{folderHead}<EmptyState title={styleSuggestionsOnly ? "추천이 있는 자산이 없습니다." : "조건에 맞는 자산이 없습니다."}><Button onClick={() => { resetFilters(); clearAutoTagFilter(); resetStyleSuggestionFilter(); }}>필터 초기화</Button></EmptyState></>
      : visibleItems.length === 0
        ? directOnlyEmpty
          ? <>{folderHead}<EmptyState title="이 폴더에 바로 들어 있는 이미지가 없습니다">하위 폴더와 캐릭터의 이미지는 전체에서 볼 수 있어요.<Button onClick={() => setDirectOnlyState({ folderId: plainFolderId, value: false })}>전체 보기</Button></EmptyState></>
          : <>{folderHead}<EmptyState title={view.kind === "album" ? "이 앨범에 자산이 없습니다." : view.kind === "collection" ? "이 컬렉션에 자산이 없습니다." : "자산이 없습니다"}>{view.kind === "album" ? "원하는 자산을 이 앨범에 추가하세요." : view.kind === "collection" ? "원하는 자산을 이 컬렉션에 추가하세요." : "여기에 이미지와 영상 파일을 놓아 추가하세요."}</EmptyState></>
      : <ContextMenu items={contextItems}><div onContextMenu={(event) => {
          const id = (event.target as HTMLElement).closest<HTMLElement>("[data-asset-id]")?.dataset.assetId;
          const target = items.find((item) => item.id === id);
          if (!target || (batchPending && !selection.ids.has(target.id))) { event.preventDefault(); return; }
          if (!selection.ids.has(target.id)) selectWithGesture(target, { toggle: false, range: false });
        }} className="asset-browser__results" aria-busy={firstLoading} inert={!activePage ? true : undefined}><AssetGallery scrubberHidden={viewerAssetId !== null} layout={galleryLayout} intro={<>{artistScope?.intro}{folderShelfIntro}</>} infoOpen={inspectorOpen} favoritesView={sort === "favorites"} groupDates={!folderShelfIntro && (visiblePage?.sort === "newest" || visiblePage?.sort === "oldest")} items={visibleItems} scopeKey={visiblePage?.queryKey} totalCount={styleSuggestionsOnly ? styleSuggestionAssets?.totalImages ?? null : visiblePage?.totalCount ?? null} selectedAssetIds={selection.ids} focusAssetId={selection.focusId} targetRowHeight={thumbnailRowHeight} metadataVisible={metadataVisible} privacyMode={privacyMode} hasNextPage={Boolean(activePage && tailCursor !== null)} onLoadNextPage={loadNextPage} hasPreviousPage={Boolean(activePage && headCursor !== null)} onLoadPrevPage={loadPrevPage} onSelectionGesture={selectWithGesture} onFocusAsset={focusAssetOnly} onSelectAll={selectAll} onDeleteSelection={trashSelection} onClearSelection={clearSelection} onAssignCharacter={openCharacterPicker} onToggleFavorite={toggleFocusedFavorite} onToggleInfo={() => setInspectorOpen((open) => !open)} onEscape={() => { if (inspectorOpen) setInspectorOpen(false); else clearSelection(); }} onMoveFocus={moveFocus} onOpen={(asset) => { viewerViewKeyRef.current = viewKey; setViewerAssetId(asset.id); }} onRetryVideo={(asset) => void gateway.retryVideoPreparation(asset.id).then(() => gateway.preparePendingVideos(1)).then(refresh).catch((error) => setMessage(commandErrorMessage(error, "미리보기 준비를 다시 시작하지 못했습니다.")))} onPointerDragStart={onPointerDragStart} onPointerDragMove={onPointerDragMove} onPointerDragEnd={onPointerDragEnd} onPointerDragCancel={onPointerDragCancel} /></div></ContextMenu>;
  return <section className="asset-browser" aria-label="저장소" onKeyDown={event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.key.toLowerCase() !== "i" || (event.target as HTMLElement).closest("input, textarea, select, [contenteditable='true']")) return;
    event.preventDefault(); setInspectorOpen(open => !open);
  }}>
    {<AssetToolbar title={artistScope?.title} scopeControl={folderFilterControl} titleAccessory={<>{artistScope?.accessory}<AutoTagFilterBadges resultCount={activePage?.totalCount ?? null} /></>} galleryLayout={galleryLayout} onGalleryLayoutChange={onGalleryLayoutChange} view={view} classifications={classifications} albums={albums} collections={collections} sort={sort} mediaFilter={mediaFilter} aspectFilter={aspectFilter} metadataVisible={metadataVisible} privacyMode={privacyMode} onPrivacyModeChange={onPrivacyModeChange} thumbnailRowHeight={thumbnailRowHeight} onSortChange={onSortChange} onMediaFilterChange={changeMediaFilter} onAspectFilterChange={changeAspectFilter} onMetadataVisibleChange={onMetadataVisibleChange} onThumbnailRowHeightChange={onThumbnailRowHeightChange} onReshuffle={reshuffle} inspectorOpen={inspectorOpen} inspectorAvailable onInspectorOpenChange={setInspectorOpen} />}
    {newAssetsAvailable && <div role="status">새 자료가 있습니다. <Button size="sm" onClick={showNewest}>처음부터 보기</Button></div>}
    {message && <Toast actionLabel={undoAssetIds ? "실행 취소" : undefined} onAction={undoAssetIds ? undoTrash : undefined} actionDisabled={batchPending} onDismiss={() => dismissMessage(null)}>{message}</Toast>}
    {characterNotice && <Toast secondaryActionLabel="열기" onSecondaryAction={() => {
      const target = characterNotice.target;
      if (target.seriesClassificationId) onViewChange?.({ kind: "classification", classificationId: target.seriesClassificationId, characterId: target.id });
      setCharacterNotice(null);
    }} actionDisabled={batchPending} onDismiss={() => setCharacterNotice(null)}><span className="character-assign-notice">
      {privacyMode ? <span className="character-assign-notice__thumbnail character-assign-notice__thumbnail--private" aria-hidden="true" /> : <CharacterNoticeThumbnail target={characterNotice.target} />}
      <span><strong>{characterNotice.count.toLocaleString("ko-KR")}장</strong> → {characterNotice.target.displayName}</span>
    </span></Toast>}
    {currentFirstError && <Toast tone="error">{currentFirstError}</Toast>}
    <div className="asset-browser__workspace" data-info-open={inspectorOpen}>
      <div className="asset-browser__gallery">
        {assetResults}
        {artistScope?.panel}
        <SelectionBar view={view} onAssignArtist={gateway.artists ? () => setAssignOpen(true) : undefined} selectedCount={selectedIds.length} batchPending={batchPending} characterOpen={characterOpen} onCharacterToggle={toggleCharacterPicker} characterPicker={<CharacterAssignPicker assetIds={[...selectedIds]} targets={characterTargets} groups={characterGroups} classifications={classifications} counts={characterCounts} privacyMode={privacyMode} busy={batchPending} onAssign={assignCharacters} onClose={() => setCharacterOpen(false)} />} onFavorite={setSelectionFavorite} onRemoveFromCollection={removeFromCollection} onSetCover={() => selectedIds[0] && setCover(selectedIds[0])} onTrash={trashSelection} onClearSelection={clearSelection} />
        {currentNextError && <div className="asset-browser__next-error"><Toast tone="error">{currentNextError}</Toast><Button onClick={() => loadNextPage(true)}>다시 시도</Button></div>}
        {currentPrevError && <div className="asset-browser__next-error"><Toast tone="error">{currentPrevError}</Toast><Button onClick={() => loadPrevPage(true)}>다시 시도</Button></div>}
      </div>
      <AssetInspector presentation="docked" assets={inspectorAssets} classifications={classifications} currentCollection={view.kind === "collection" ? collections.find((entry) => entry.id === view.collectionId) ?? null : null} open={inspectorOpen} onOpenChange={setInspectorOpen} onOpenAsset={(asset) => { viewerViewKeyRef.current = viewKey; setViewerAssetId(asset.id); }} onOpenArtist={(artistId) => onViewChange?.({ kind: "creator", creatorKey: artistId })} onAssetUpdated={updateAssetSummary} privacyMode={privacyMode} />
    </div>
    {assignOpen && selectedIds.length > 0 && <AssignArtistDialog assetIds={[...selectedIds]} privacyMode={privacyMode} onClose={() => setAssignOpen(false)}
      onAssigned={(_artistId, label) => { setAssignOpen(false); setUndoAssetIds(null); setMessage(`${selectedIds.length.toLocaleString("ko-KR")}장을 ${label}에 붙였어요`); clearSelection(); refresh(); }} />}
    <AssetViewer
      items={viewerItems}
      activeId={viewerAssetId}
      onActiveIdChange={setViewerAssetId}
      onClose={() => { setViewerAssetId(null); onRequestedAssetHandled(); }}
      onAssetOpened={(asset) => gateway.recordAssetOpened(asset.id, new Date().toISOString())}
      onToggleFavorite={toggleFavorite}
      onTrash={trashViewerAsset}
      privacyMode={privacyMode}
      totalCount={viewerTotalCount}
      classifications={classifications}
      albums={albums}
      onAddToAlbum={addViewerAssetToAlbum}
      folders={viewerFolders}
      onMoveToFolder={moveViewerAssetToFolder}
      renderCharacterPicker={(asset, close) => <CharacterAssignPicker assetIds={[asset.id]} targets={characterTargets} groups={characterGroups} classifications={classifications} counts={characterCounts} privacyMode={privacyMode} busy={batchPending} onAssign={(targets) => assignCharactersToAssets([asset.id], targets)} onClose={close} />}
      renderInfo={(asset) => <AssetInfoPanel assets={[asset]} classifications={classifications} onOpenArtist={(artistId) => onViewChange?.({ kind: "creator", creatorKey: artistId })} onAssetUpdated={updateAssetSummary} privacyMode={privacyMode} />}
      onNearEnd={activePage && tailCursor !== null ? loadNextPage : undefined}
    />
  </section>;
}

function isMovableViewerFolder(entry: ClassificationEntry): boolean {
  return !(entry.parentId === null && (entry.id === "lakomics-originals" || entry.name === "오리지널"));
}

function CharacterNoticeThumbnail({ target }: { target: CharacterTarget }) {
  const assetId = target.thumbnailAssetId ?? target.references.find(reference => reference.status === "ready")?.assetId;
  return assetId
    ? <img className="character-assign-notice__thumbnail" src={thumbnailUrl(assetId)} alt="" />
    : <span className="character-assign-notice__thumbnail" aria-hidden="true" />;
}

function markAssignedTiles(assetIds: string[], characterName: string) {
  const selected = new Set(assetIds);
  document.querySelectorAll<HTMLElement>(".asset-gallery__asset[data-asset-id]").forEach(tile => {
    if (!tile.dataset.assetId || !selected.has(tile.dataset.assetId)) return;
    tile.querySelector(".asset-gallery__character-assigned")?.remove();
    const marker = document.createElement("span");
    marker.className = "asset-gallery__character-assigned";
    marker.textContent = `✓ ${characterName}`;
    tile.append(marker);
    window.setTimeout(() => marker.remove(), 2_000);
  });
}

function reconcileAsset(current: AssetSummary | null, currentViewKey: string | null, viewKey: string, items: AssetSummary[]) {
  if (!current || currentViewKey !== viewKey) return null;
  return items.find((asset) => asset.id === current.id) ?? null;
}

function reconcileAssetId(current: string | null, currentViewKey: string | null, viewKey: string, items: AssetSummary[]) {
  if (!current || currentViewKey !== viewKey) return null;
  return items.some((asset) => asset.id === current) ? current : null;
}

function createRandomPivot() {
  return (crypto.randomUUID() as unknown as { replaceAll(search: string, replacement: string): string }).replaceAll("-", "");
}
