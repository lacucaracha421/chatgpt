import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ASSET_PAGE_SIZE } from "../library/constants";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { AlbumEntry, AssetAspectFilter, AssetCursor, AssetDateBucket, AssetMediaFilter, AssetQuery, AssetSort, AssetSummary, AssetView, ClassificationEntry, CollectionSummary } from "../library/types";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import type { InternalDragPayload } from "../shared/interaction/pointerDrag";
import { RevisitBrowser } from "../revisit/RevisitBrowser";
import { toUtcDateRange } from "../revisit/revisitDate";
import { AssetGallery } from "./AssetGallery";
import { AssetInspector } from "./AssetInspector";
import { AssetToolbar } from "./AssetToolbar";
import { AssetViewer } from "./AssetViewer";
import { SelectionBar } from "./SelectionBar";
import { applySelectionGesture, emptySelection, moveSelectionFocus, reconcileSelection, selectAllLoaded, type SelectionGesture, type SelectionState } from "./selection";

export type AssetBrowserStatus = { loadedCount: number; totalCount?: number; selectedAsset: AssetSummary | null; loading: boolean };
type Props = { view: AssetView; onViewChange?: (view: AssetView) => void; classifications: ClassificationEntry[]; albums?: AlbumEntry[]; collections?: CollectionSummary[]; onCollectionsChanged?: () => void; onMembershipChanged?: () => void; sort: AssetSort; metadataVisible: boolean; privacyMode: boolean; onPrivacyModeChange: (privacyMode: boolean) => void; thumbnailRowHeight?: number; refreshVersion: number; clearSelectionRequest?: number; requestedAsset?: AssetSummary | null; onRequestedAssetHandled?: () => void; onSortChange: (sort: AssetSort) => void; onMetadataVisibleChange: (visible: boolean) => void; onThumbnailRowHeightChange?: (height: number) => void; onStatusChange: (status: AssetBrowserStatus) => void; onPointerDragStart?: (payload: InternalDragPayload, event: React.PointerEvent<HTMLElement>) => void; onPointerDragMove?: (event: React.PointerEvent<HTMLElement>) => void; onPointerDragEnd?: (event: React.PointerEvent<HTMLElement>) => void; onPointerDragCancel?: (event: React.PointerEvent<HTMLElement>) => void };
type PageState = { queryKey: string; items: AssetSummary[]; headCursor: AssetCursor | null; tailCursor: AssetCursor | null };
type QueryError = { queryKey: string; message: string };
export type GalleryJump = { date: string; ratio: number; token: number };
const EMPTY_ASSETS: AssetSummary[] = [];
const EMPTY_BUCKETS: AssetDateBucket[] = [];
const ALL_DATE_BUCKETS = {
  startUtc: "0001-01-01T00:00:00.000Z",
  endUtc: "9999-12-31T23:59:59.999Z",
  offsetMinutes: -new Date().getTimezoneOffset(),
};

export function AssetBrowser({ view, onViewChange, classifications, albums = [], collections = [], onCollectionsChanged = () => undefined, onMembershipChanged = () => undefined, sort, metadataVisible, privacyMode, onPrivacyModeChange, thumbnailRowHeight = 180, refreshVersion, clearSelectionRequest = 0, requestedAsset = null, onRequestedAssetHandled = () => undefined, onSortChange, onMetadataVisibleChange, onThumbnailRowHeightChange = () => undefined, onStatusChange, onPointerDragStart, onPointerDragMove, onPointerDragEnd, onPointerDragCancel }: Props) {
  const { gateway } = useLibrary();
  const [revisitDate, setRevisitDate] = useState<string | null>(null);
  const [directOnly, setDirectOnly] = useState(false);
  const [mediaFilter, setMediaFilter] = useState<AssetMediaFilter>("all");
  const [aspectFilter, setAspectFilter] = useState<AssetAspectFilter>("all");
  const [page, setPage] = useState<PageState | null>(null);
  const [firstLoading, setFirstLoading] = useState(true);
  const [nextLoading, setNextLoading] = useState(false);
  const [prevLoading, setPrevLoading] = useState(false);
  const [firstError, setFirstError] = useState<QueryError | null>(null);
  const [nextError, setNextError] = useState<QueryError | null>(null);
  const [prevError, setPrevError] = useState<QueryError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const [randomVersion, setRandomVersion] = useState(0);
  const [selectedAsset, setSelectedAsset] = useState<AssetSummary | null>(null);
  const [selection, setSelection] = useState<SelectionState>(emptySelection);
  const [viewerAssetId, setViewerAssetId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [batchPending, setBatchPending] = useState(false);
  const [undoAssetIds, setUndoAssetIds] = useState<string[] | null>(null);
  const [dateBuckets, setDateBuckets] = useState<{ queryKey: string; buckets: AssetDateBucket[] }>({ queryKey: "", buckets: [] });
  const [anchor, setAnchor] = useState<string | null>(null);
  const [jumpTarget, setJumpTarget] = useState<GalleryJump | null>(null);
  const dismissMessage = useCallback((value: null) => { setMessage(value); setUndoAssetIds(null); }, []);
  useAutoDismiss(message, dismissMessage);
  const selectedViewKeyRef = useRef<string | null>(null);
  const viewerViewKeyRef = useRef<string | null>(null);
  const requestedAssetRef = useRef<AssetSummary | null>(requestedAsset);
  const clearSelectionRequestRef = useRef(clearSelectionRequest);
  requestedAssetRef.current = requestedAsset;
  const generationRef = useRef(0);
  const nextLoadingRef = useRef(false);
  const prevLoadingRef = useRef(false);
  const randomPivotRef = useRef<string | null>(null);
  const [anchorViewKey, setAnchorViewKey] = useState<string | null>(null);
  const filterable = view.kind === "classification" || view.kind === "unsorted" || view.kind === "album" || view.kind === "creator";
  const chronological = sort === "newest" || sort === "oldest";
  if (sort === "random" && !randomPivotRef.current) randomPivotRef.current = createRandomPivot();
  useEffect(() => { if (sort !== "random") randomPivotRef.current = null; }, [sort]);
  useEffect(() => { if (view.kind !== "classification") setDirectOnly(false); }, [view.kind]);
  const creatorKey = view.kind === "creator" ? view.creatorKey : null;
  const queryBase = useMemo<Omit<AssetQuery, "after">>(() => ({ classificationId: view.kind === "classification" ? view.classificationId : null, albumId: view.kind === "album" ? view.albumId : null, collectionId: view.kind === "collection" ? view.collectionId : null, creatorKey, directOnly: view.kind === "classification" ? directOnly : false, unclassifiedOnly: view.kind === "unsorted", mediaKind: filterable && mediaFilter !== "all" ? mediaFilter : null, aspectRatio: filterable && aspectFilter !== "all" ? aspectFilter : null, sort, randomPivot: sort === "random" ? randomPivotRef.current : null, collectedRange: view.kind === "revisit" && revisitDate ? toUtcDateRange(revisitDate) : null, limit: ASSET_PAGE_SIZE }), [aspectFilter, creatorKey, directOnly, sort, filterable, mediaFilter, randomVersion, revisitDate, view]);
  const queryKey = JSON.stringify(queryBase);
  const viewKey = view.kind === "classification" ? `classification:${view.classificationId}` : view.kind === "album" ? `album:${view.albumId}` : view.kind === "collection" ? `collection:${view.collectionId}` : view.kind === "creator" ? `creator:${view.creatorKey}` : view.kind === "revisit" ? `revisit:${revisitDate ?? "index"}` : view.kind;
  const effectiveAnchor = anchor !== null && anchorViewKey === viewKey ? anchor : null;
  const anchorRef = useRef<string | null>(effectiveAnchor);
  anchorRef.current = effectiveAnchor;
  const activePage = page?.queryKey === queryKey ? page : null;
  const items = activePage?.items ?? EMPTY_ASSETS;
  const itemIds = useMemo(() => items.map((asset) => asset.id), [items]);
  const headCursor = activePage?.headCursor ?? null;
  const tailCursor = activePage?.tailCursor ?? null;
  const currentFirstError = firstError?.queryKey === queryKey ? firstError.message : null;
  const currentNextError = nextError?.queryKey === queryKey ? nextError.message : null;
  const currentPrevError = prevError?.queryKey === queryKey ? prevError.message : null;
  const refresh = useCallback(() => setRetryVersion((value) => value + 1), []);
  useEffect(() => {
    if (view.kind === "revisit" && !revisitDate) { ++generationRef.current; nextLoadingRef.current = false; prevLoadingRef.current = false; setFirstLoading(false); setNextLoading(false); setPrevLoading(false); setFirstError(null); setNextError(null); setPrevError(null); return; }
    nextLoadingRef.current = false; prevLoadingRef.current = false; setFirstLoading(true); setNextLoading(false); setPrevLoading(false); setFirstError(null); setNextError(null); setPrevError(null);
    const generation = ++generationRef.current;
    const anchorDate = anchorRef.current;
    const request = anchorDate ? { ...queryBase, after: null, aroundDate: anchorDate } : { ...queryBase, after: null, aroundDate: null };
    void gateway.listAssets(request).then((result) => {
      if (generation !== generationRef.current) return;
      setPage({ queryKey, items: result.items, headCursor: result.previousCursor ?? null, tailCursor: result.nextCursor });
      setSelectedAsset((selected) => reconcileAsset(selected, selectedViewKeyRef.current, viewKey, result.items));
      setViewerAssetId((assetId) => requestedAssetRef.current?.id === assetId ? assetId : reconcileAssetId(assetId, viewerViewKeyRef.current, viewKey, result.items));
    }).catch((error: unknown) => { if (generation === generationRef.current) setFirstError({ queryKey, message: commandErrorMessage(error, "자산을 불러오지 못했습니다.") }); }).finally(() => { if (generation === generationRef.current) setFirstLoading(false); });
    return () => { if (generation === generationRef.current) generationRef.current += 1; };
  }, [gateway, queryBase, queryKey, refreshVersion, retryVersion, revisitDate, view.kind, viewKey]);
  useEffect(() => {
    if (view.kind === "revisit") { setDateBuckets({ queryKey, buckets: [] }); return; }
    let cancelled = false;
    void gateway.listAssetDateBuckets(ALL_DATE_BUCKETS).then((result) => {
      if (!cancelled) setDateBuckets({ queryKey, buckets: result });
    }).catch(() => { if (!cancelled) setDateBuckets({ queryKey, buckets: [] }); });
    return () => { cancelled = true; };
  }, [gateway, queryBase, queryKey, refreshVersion]);
  const activeBuckets = dateBuckets.queryKey === queryKey ? dateBuckets.buckets : EMPTY_BUCKETS;
  const totalAssets = useMemo(() => activeBuckets.reduce((sum, bucket) => sum + bucket.count, 0), [activeBuckets]);
  useEffect(() => onStatusChange({ loadedCount: items.length, totalCount: totalAssets, selectedAsset, loading: firstLoading || nextLoading || prevLoading }), [firstLoading, items.length, nextLoading, onStatusChange, prevLoading, selectedAsset, totalAssets]);
  useEffect(() => {
    setSelection((current) => reconcileSelection(current, itemIds));
  }, [itemIds]);
  useEffect(() => {
    setSelection(emptySelection());
    setSelectedAsset(null);
    setAnchor(null);
    setAnchorViewKey(null);
    setJumpTarget(null);
  }, [viewKey]);
  useEffect(() => {
    if (!requestedAsset) return;
    viewerViewKeyRef.current = null;
    setViewerAssetId(requestedAsset.id);
  }, [requestedAsset]);
  useEffect(() => {
    if (selection.ids.size === 0) setInspectorOpen(false);
  }, [selection.ids.size]);
  const loadNextPage = useCallback((retry = false) => {
    if (!activePage || !tailCursor || nextLoadingRef.current || (currentNextError && !retry)) return;
    const generation = generationRef.current; const cursor = tailCursor; nextLoadingRef.current = true; setNextLoading(true); setNextError(null);
    void gateway.listAssets({ ...queryBase, after: cursor, aroundDate: null }).then((result) => { if (generation !== generationRef.current) return; setPage((current) => current?.queryKey === queryKey ? { queryKey, items: [...current.items, ...result.items], headCursor: current.headCursor, tailCursor: result.nextCursor } : current); }).catch((error: unknown) => { if (generation === generationRef.current) setNextError({ queryKey, message: commandErrorMessage(error, "다음 자산을 불러오지 못했습니다.") }); }).finally(() => { if (generation === generationRef.current) { nextLoadingRef.current = false; setNextLoading(false); } });
  }, [activePage, currentNextError, gateway, queryBase, queryKey, tailCursor]);
  const loadPrevPage = useCallback((retry = false) => {
    if (!activePage || !headCursor || prevLoadingRef.current || (currentPrevError && !retry)) return;
    const generation = generationRef.current; const cursor = headCursor; prevLoadingRef.current = true; setPrevLoading(true); setPrevError(null);
    void gateway.listAssets({ ...queryBase, after: null, before: cursor, aroundDate: null }).then((result) => { if (generation !== generationRef.current) return; setPage((current) => current?.queryKey === queryKey ? { queryKey, items: [...result.items, ...current.items], headCursor: result.previousCursor ?? null, tailCursor: current.tailCursor } : current); }).catch((error: unknown) => { if (generation === generationRef.current) setPrevError({ queryKey, message: commandErrorMessage(error, "이전 자산을 불러오지 못했습니다.") }); }).finally(() => { if (generation === generationRef.current) { prevLoadingRef.current = false; setPrevLoading(false); } });
  }, [activePage, currentPrevError, gateway, queryBase, queryKey, headCursor]);
  const jumpToDate = useCallback((date: string, ratio: number) => {
    if (!chronological || !date) return;
    const generation = ++generationRef.current;
    nextLoadingRef.current = false; prevLoadingRef.current = false; setNextLoading(false); setPrevLoading(false); setFirstError(null); setNextError(null); setPrevError(null);
    setAnchor(date);
    setAnchorViewKey(viewKey);
    setJumpTarget({ date, ratio, token: generation });
    void gateway.listAssets({ ...queryBase, after: null, aroundDate: date }).then((result) => {
      if (generation !== generationRef.current) return;
      setPage({ queryKey, items: result.items, headCursor: result.previousCursor ?? null, tailCursor: result.nextCursor });
      setSelectedAsset((selected) => reconcileAsset(selected, selectedViewKeyRef.current, viewKey, result.items));
      setViewerAssetId((assetId) => requestedAssetRef.current?.id === assetId ? assetId : reconcileAssetId(assetId, viewerViewKeyRef.current, viewKey, result.items));
    }).catch((error: unknown) => { if (generation === generationRef.current) setFirstError({ queryKey, message: commandErrorMessage(error, "해당 날짜로 이동하지 못했습니다.") }); });
  }, [chronological, gateway, queryBase, queryKey, viewKey]);
  const reshuffle = () => { randomPivotRef.current = createRandomPivot(); setRandomVersion((value) => value + 1); };
  const selectWithGesture = (asset: AssetSummary, gesture: SelectionGesture) => {
    const next = applySelectionGesture(selection, itemIds, asset.id, gesture);
    setSelection(next);
    selectedViewKeyRef.current = next.ids.size > 0 ? viewKey : null;
    setSelectedAsset(next.ids.has(asset.id) ? asset : items.find((item) => next.ids.has(item.id)) ?? null);
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
    setAnchor(null);
    setAnchorViewKey(null);
    setJumpTarget(null);
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
  const updateAssetSummary = (updated: AssetSummary) => {
    setPage((current) => current ? {
      ...current,
      items: current.items.map((item) => item.id === updated.id ? updated : item),
    } : current);
    setSelectedAsset((current) => current?.id === updated.id ? updated : current);
  };
  const runBatch = async (operation: () => Promise<void>, failureMessage: string) => {
    if (batchPending || selectedIds.length === 0) return false;
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
  const setBatchFavorite = (favorite: boolean) => void runBatch(
    () => gateway.setAssetsFavorite(selectedIds, favorite),
    "즐겨찾기를 변경하지 못했습니다.",
  );
  const toggleFavorite = (asset: AssetSummary) => void (async () => {
    try {
      await gateway.setAssetFavorite(asset.id, !asset.favorite);
      refresh();
    } catch (error) {
      setMessage(commandErrorMessage(error, "즐겨찾기를 변경하지 못했습니다."));
    }
  })();
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
    const assetIds = [...selectedIds];
    const succeeded = await runBatch(() => gateway.trashAssets(assetIds), "자산을 휴지통으로 이동하지 못했습니다.");
    if (succeeded) {
      setUndoAssetIds(assetIds);
      setMessage(`${assetIds.length}개 자산을 휴지통으로 이동했습니다.`);
      onMembershipChanged();
    }
  })();
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
  const trashViewerAsset = (asset: AssetSummary) => void (async () => {
    const index = items.findIndex((item) => item.id === asset.id);
    const next = items[index + 1] ?? items[index - 1];
    try {
      await gateway.trashAssets([asset.id]);
      setUndoAssetIds([asset.id]);
      setMessage("휴지통으로 이동했습니다.");
      setViewerAssetId(next?.id ?? null);
      refresh();
      onMembershipChanged();
    } catch (error) {
      setMessage(commandErrorMessage(error, "자산을 휴지통으로 이동하지 못했습니다."));
    }
  })();
  const openBundle = (bundleId: string) => void (async () => {
    try {
      const now = new Date();
      const pad = (value: number) => String(value).padStart(2, "0");
      const localDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const slate = await gateway.getRevisitSlate(localDate, now.toISOString());
      const bundle = slate.bundles.find((entry) => entry.id === bundleId);
      if (!bundle || bundle.assetIds.length === 0) return;
      onViewChange?.({ kind: "revisited-bundle", bundleId: bundle.id, title: bundle.title, assetIds: bundle.assetIds });
    } catch (error) {
      setMessage(commandErrorMessage(error, "묶음을 열지 못했습니다."));
    }
  })();
  const assetResults = firstLoading || !activePage && !currentFirstError
    ? <Skeleton className="asset-browser__skeleton" label="자산을 불러오는 중" />
    : currentFirstError && items.length === 0
      ? <EmptyState title="자산을 불러오지 못했습니다"><Button onClick={refresh}>다시 시도</Button></EmptyState>
      : items.length === 0
        ? <EmptyState title={view.kind === "album" ? "이 앨범에 자산이 없습니다." : view.kind === "collection" ? "이 컬렉션에 자산이 없습니다." : "자산이 없습니다"}>{view.kind === "album" ? "원하는 자산을 이 앨범에 추가하세요." : view.kind === "collection" ? "원하는 자산을 이 컬렉션에 추가하세요." : "여기에 이미지와 영상 파일을 놓아 추가하세요."}</EmptyState>
        : <AssetGallery items={items} dateBuckets={activeBuckets} onSelectDate={jumpToDate} railInteractive={chronological} jumpTarget={jumpTarget} selectedAssetIds={selection.ids} focusAssetId={selection.focusId} targetRowHeight={thumbnailRowHeight} metadataVisible={metadataVisible} privacyMode={privacyMode} hasNextPage={tailCursor !== null} onLoadNextPage={loadNextPage} hasPreviousPage={headCursor !== null} onLoadPrevPage={loadPrevPage} onSelectionGesture={selectWithGesture} onSelectAll={selectAll} onDeleteSelection={trashSelection} onClearSelection={clearSelection} onMoveFocus={moveFocus} onOpen={(asset) => { viewerViewKeyRef.current = viewKey; setViewerAssetId(asset.id); }} onRetryVideo={(asset) => void gateway.retryVideoPreparation(asset.id).then(() => gateway.preparePendingVideos(1)).then(refresh).catch((error) => setMessage(commandErrorMessage(error, "미리보기 준비를 다시 시작하지 못했습니다.")))} onPointerDragStart={onPointerDragStart} onPointerDragMove={onPointerDragMove} onPointerDragEnd={onPointerDragEnd} onPointerDragCancel={onPointerDragCancel} />;
  return <section className="asset-browser" aria-label="저장소">
    <AssetToolbar view={view} classifications={classifications} albums={albums} collections={collections} sort={sort} mediaFilter={mediaFilter} aspectFilter={aspectFilter} directOnly={directOnly} metadataVisible={metadataVisible} privacyMode={privacyMode} onPrivacyModeChange={onPrivacyModeChange} thumbnailRowHeight={thumbnailRowHeight} onSortChange={(next) => { setAnchor(null); setAnchorViewKey(null); setJumpTarget(null); onSortChange(next); }} onMediaFilterChange={changeMediaFilter} onAspectFilterChange={changeAspectFilter} onDirectOnlyChange={setDirectOnly} onMetadataVisibleChange={onMetadataVisibleChange} onThumbnailRowHeightChange={onThumbnailRowHeightChange} onReshuffle={reshuffle} />
    {message && <Toast actionLabel={undoAssetIds ? "실행 취소" : undefined} onAction={undoAssetIds ? undoTrash : undefined} actionDisabled={batchPending} onDismiss={() => dismissMessage(null)}>{message}</Toast>}
    {currentFirstError && <Toast>{currentFirstError}</Toast>}
    <div className={`asset-browser__workspace${inspectorOpen ? " asset-browser__workspace--inspector" : ""}`}>
      <div className="asset-browser__gallery">
        {view.kind === "revisit" ? <RevisitBrowser
          onSelectedDateChange={setRevisitDate}
          renderDay={() => assetResults}
          onOpenCreator={(creatorKey) => onViewChange?.({ kind: "creator", creatorKey })}
          onOpenBundle={openBundle}
          privacyMode={privacyMode}
          cellSize={thumbnailRowHeight}
        /> : assetResults}
        {currentNextError && <div className="asset-browser__next-error"><Toast>{currentNextError}</Toast><Button onClick={() => loadNextPage(true)}>다시 시도</Button></div>}
        {currentPrevError && <div className="asset-browser__next-error"><Toast>{currentPrevError}</Toast><Button onClick={() => loadPrevPage(true)}>다시 시도</Button></div>}
        {(view.kind !== "revisit" || revisitDate) && <SelectionBar
          view={view}
          selectedCount={selectedIds.length}
          inspectorOpen={inspectorOpen}
          batchPending={batchPending}
          onInspectorToggle={() => setInspectorOpen((open) => !open)}
          onFavorite={setBatchFavorite}
          onRemoveFromCollection={removeFromCollection}
          onSetCover={selectedIds.length === 1 ? () => setCover(selectedIds[0]!) : undefined}
          onTrash={trashSelection}
          onClearSelection={clearSelection}
        />}
      </div>
      <AssetInspector assets={selectedAssets} currentCollection={view.kind === "collection" ? collections.find((entry) => entry.id === view.collectionId) ?? null : null} open={inspectorOpen} onOpenChange={setInspectorOpen} onOpenAsset={(asset) => { viewerViewKeyRef.current = viewKey; setViewerAssetId(asset.id); }} onAssetUpdated={updateAssetSummary} />
    </div>
    <AssetViewer items={requestedAsset && !items.some((item) => item.id === requestedAsset.id) ? [requestedAsset] : items} activeId={viewerAssetId} onActiveIdChange={setViewerAssetId} onClose={() => { setViewerAssetId(null); onRequestedAssetHandled(); }} onToggleFavorite={toggleFavorite} onTrash={trashViewerAsset} privacyMode={privacyMode} />
  </section>;
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
