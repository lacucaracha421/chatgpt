import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ASSET_PAGE_SIZE } from "../library/constants";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { AlbumEntry, AssetCursor, AssetDateBucket, AssetQuery, AssetSort, AssetSummary, AssetView, ClassificationEntry, CollectionSummary } from "../library/types";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import type { InternalDragPayload } from "../shared/interaction/pointerDrag";
import { AssetGallery } from "./AssetGallery";
import { AssetInspector } from "./AssetInspector";
import { AssetToolbar } from "./AssetToolbar";
import { AssetViewer } from "./AssetViewer";
import { applySelectionGesture, emptySelection, moveSelectionFocus, reconcileSelection, selectAllLoaded, type SelectionGesture, type SelectionState } from "./selection";

export type AssetBrowserStatus = { loadedCount: number; selectedAsset: AssetSummary | null; loading: boolean };
type Props = { view: AssetView; classifications: ClassificationEntry[]; albums?: AlbumEntry[]; collections?: CollectionSummary[]; onCollectionsChanged?: () => void; sort: AssetSort; metadataVisible: boolean; thumbnailRowHeight?: number; refreshVersion: number; requestedAsset?: AssetSummary | null; onRequestedAssetHandled?: () => void; onSortChange: (sort: AssetSort) => void; onMetadataVisibleChange: (visible: boolean) => void; onThumbnailRowHeightChange?: (height: number) => void; onStatusChange: (status: AssetBrowserStatus) => void; onPointerDragStart?: (payload: InternalDragPayload, event: React.PointerEvent<HTMLElement>) => void; onPointerDragMove?: (event: React.PointerEvent<HTMLElement>) => void; onPointerDragEnd?: (event: React.PointerEvent<HTMLElement>) => void; onPointerDragCancel?: (event: React.PointerEvent<HTMLElement>) => void };
type PageState = { queryKey: string; items: AssetSummary[]; nextCursor: AssetCursor | null };
type QueryError = { queryKey: string; message: string };
const EMPTY_ASSETS: AssetSummary[] = [];

export function AssetBrowser({ view, classifications, albums = [], collections = [], onCollectionsChanged = () => undefined, sort, metadataVisible, thumbnailRowHeight = 180, refreshVersion, requestedAsset = null, onRequestedAssetHandled = () => undefined, onSortChange, onMetadataVisibleChange, onThumbnailRowHeightChange = () => undefined, onStatusChange, onPointerDragStart, onPointerDragMove, onPointerDragEnd, onPointerDragCancel }: Props) {
  const { gateway } = useLibrary();
  const [directOnly, setDirectOnly] = useState(false);
  const [page, setPage] = useState<PageState | null>(null);
  const [firstLoading, setFirstLoading] = useState(true);
  const [nextLoading, setNextLoading] = useState(false);
  const [firstError, setFirstError] = useState<QueryError | null>(null);
  const [nextError, setNextError] = useState<QueryError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const [randomVersion, setRandomVersion] = useState(0);
  const [selectedAsset, setSelectedAsset] = useState<AssetSummary | null>(null);
  const [selection, setSelection] = useState<SelectionState>(emptySelection);
  const [viewerAssetId, setViewerAssetId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [batchPending, setBatchPending] = useState(false);
  const [membershipVersion, setMembershipVersion] = useState(0);
  const [undoAssetIds, setUndoAssetIds] = useState<string[] | null>(null);
  const [dateBuckets, setDateBuckets] = useState<AssetDateBucket[]>([]);
  const [collectedFrom, setCollectedFrom] = useState<string | null>(null);
  const dismissMessage = useCallback((value: null) => { setMessage(value); setUndoAssetIds(null); }, []);
  useAutoDismiss(message, dismissMessage);
  const selectedViewKeyRef = useRef<string | null>(null);
  const viewerViewKeyRef = useRef<string | null>(null);
  const requestedAssetRef = useRef<AssetSummary | null>(requestedAsset);
  requestedAssetRef.current = requestedAsset;
  const generationRef = useRef(0);
  const nextLoadingRef = useRef(false);
  const randomPivotRef = useRef<string | null>(null);
  const effectiveSort = collectedFrom != null ? "oldest" : view.kind === "recent" ? "newest" : sort;
  if (effectiveSort === "random" && !randomPivotRef.current) randomPivotRef.current = createRandomPivot();
  useEffect(() => { if (effectiveSort !== "random") randomPivotRef.current = null; }, [effectiveSort]);
  useEffect(() => { if (view.kind !== "classification") setDirectOnly(false); }, [view.kind]);
  const queryBase = useMemo<Omit<AssetQuery, "after">>(() => ({ classificationId: view.kind === "classification" ? view.classificationId : null, albumId: view.kind === "album" ? view.albumId : null, collectionId: view.kind === "collection" ? view.collectionId : null, directOnly: view.kind === "classification" ? directOnly : false, favoriteOnly: view.kind === "favorites", unclassifiedOnly: view.kind === "unsorted", sort: effectiveSort, randomPivot: effectiveSort === "random" ? randomPivotRef.current : null, limit: ASSET_PAGE_SIZE, collectedFrom }), [collectedFrom, directOnly, effectiveSort, randomVersion, view]);
  const queryKey = JSON.stringify(queryBase);
  const viewKey = view.kind === "classification" ? `classification:${view.classificationId}` : view.kind === "album" ? `album:${view.albumId}` : view.kind === "collection" ? `collection:${view.collectionId}` : view.kind;
  const activePage = page?.queryKey === queryKey ? page : null;
  const items = activePage?.items ?? EMPTY_ASSETS;
  const itemIds = useMemo(() => items.map((asset) => asset.id), [items]);
  const nextCursor = activePage?.nextCursor ?? null;
  const currentFirstError = firstError?.queryKey === queryKey ? firstError.message : null;
  const currentNextError = nextError?.queryKey === queryKey ? nextError.message : null;
  const refresh = useCallback(() => setRetryVersion((value) => value + 1), []);
  useEffect(() => {
    const generation = ++generationRef.current;
    nextLoadingRef.current = false; setFirstLoading(true); setNextLoading(false); setFirstError(null); setNextError(null);
    void gateway.listAssets({ ...queryBase, after: null }).then((result) => {
      if (generation !== generationRef.current) return;
      setPage({ queryKey, items: result.items, nextCursor: result.nextCursor });
      setSelectedAsset((selected) => reconcileAsset(selected, selectedViewKeyRef.current, viewKey, result.items));
      setViewerAssetId((assetId) => requestedAssetRef.current?.id === assetId ? assetId : reconcileAssetId(assetId, viewerViewKeyRef.current, viewKey, result.items));
    }).catch((error: unknown) => { if (generation === generationRef.current) setFirstError({ queryKey, message: commandErrorMessage(error, "자산을 불러오지 못했습니다.") }); }).finally(() => { if (generation === generationRef.current) setFirstLoading(false); });
    return () => { if (generation === generationRef.current) generationRef.current += 1; };
  }, [gateway, queryBase, queryKey, refreshVersion, retryVersion, viewKey]);
  useEffect(() => {
    let cancelled = false;
    void gateway.listAssetDateBuckets({ ...queryBase, collectedFrom: null, after: null }).then((result) => {
      if (!cancelled) setDateBuckets(result);
    }).catch(() => { if (!cancelled) setDateBuckets([]); });
    return () => { cancelled = true; };
  }, [gateway, queryBase, queryKey, refreshVersion]);
  useEffect(() => onStatusChange({ loadedCount: items.length, selectedAsset, loading: firstLoading || nextLoading }), [firstLoading, items.length, nextLoading, onStatusChange, selectedAsset]);
  useEffect(() => {
    setSelection((current) => reconcileSelection(current, itemIds));
  }, [itemIds]);
  useEffect(() => {
    setSelection(emptySelection());
    setSelectedAsset(null);
    setCollectedFrom(null);
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
    if (!activePage || !nextCursor || nextLoadingRef.current || (currentNextError && !retry)) return;
    const generation = generationRef.current; const cursor = nextCursor; nextLoadingRef.current = true; setNextLoading(true); setNextError(null);
    void gateway.listAssets({ ...queryBase, after: cursor }).then((result) => { if (generation !== generationRef.current) return; setPage((current) => current?.queryKey === queryKey ? { queryKey, items: [...current.items, ...result.items], nextCursor: result.nextCursor } : current); }).catch((error: unknown) => { if (generation === generationRef.current) setNextError({ queryKey, message: commandErrorMessage(error, "다음 자산을 불러오지 못했습니다.") }); }).finally(() => { if (generation === generationRef.current) { nextLoadingRef.current = false; setNextLoading(false); } });
  }, [activePage, currentNextError, gateway, nextCursor, queryBase, queryKey]);
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
  const moveBatchToFolder = (classificationId: string | null) => void (async () => {
    if (await runBatch(() => gateway.setAssetClassification({ assetIds: selectedIds, classificationId }), "폴더를 변경하지 못했습니다.")) {
      setMembershipVersion((version) => version + 1);
    }
  })();
  const patchBatchAlbum = (albumId: string, operation: "add" | "remove") => void (async () => {
    if (await runBatch(() => gateway.patchAssetAlbums({
      assetIds: selectedIds,
      addAlbumIds: operation === "add" ? [albumId] : [],
      removeAlbumIds: operation === "remove" ? [albumId] : [],
    }), "앨범을 변경하지 못했습니다.")) {
      setMembershipVersion((version) => version + 1);
    }
  })();
  const patchBatchCollection = (collectionId: string, operation: "add" | "remove") => void (async () => {
    if (await runBatch(() => gateway.patchAssetCollections({
      assetIds: selectedIds,
      addCollectionIds: operation === "add" ? [collectionId] : [],
      removeCollectionIds: operation === "remove" ? [collectionId] : [],
    }), "컬렉션을 변경하지 못했습니다.")) {
      setMembershipVersion((version) => version + 1);
      onCollectionsChanged();
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
    } catch (error) {
      setMessage(commandErrorMessage(error, "자산을 휴지통으로 이동하지 못했습니다."));
    }
  })();
  return <section className="asset-browser" aria-label="저장소">
    <AssetToolbar view={view} classifications={classifications} albums={albums} collections={collections} sort={sort} directOnly={directOnly} metadataVisible={metadataVisible} thumbnailRowHeight={thumbnailRowHeight} selectedCount={selectedIds.length} inspectorOpen={inspectorOpen} onInspectorToggle={() => setInspectorOpen((open) => !open)} onSortChange={(next) => { setCollectedFrom(null); onSortChange(next); }} onDirectOnlyChange={setDirectOnly} onMetadataVisibleChange={onMetadataVisibleChange} onThumbnailRowHeightChange={onThumbnailRowHeightChange} onFavorite={setBatchFavorite} onMoveToFolder={moveBatchToFolder} onAlbum={patchBatchAlbum} onRemoveFromCollection={removeFromCollection} onSetCover={selectedIds.length === 1 ? () => setCover(selectedIds[0]!) : undefined} onTrash={trashSelection} onClearSelection={clearSelection} batchPending={batchPending} onReshuffle={reshuffle} />
    {message && <Toast actionLabel={undoAssetIds ? "실행 취소" : undefined} onAction={undoAssetIds ? undoTrash : undefined} actionDisabled={batchPending} onDismiss={() => dismissMessage(null)}>{message}</Toast>}
    {currentFirstError && <Toast>{currentFirstError}</Toast>}
    <div className={`asset-browser__workspace${inspectorOpen ? " asset-browser__workspace--inspector" : ""}`}>
      <div className="asset-browser__gallery">
        {firstLoading || !activePage && !currentFirstError ? <Skeleton className="asset-browser__skeleton" label="자산을 불러오는 중" /> : currentFirstError && items.length === 0 ? <EmptyState title="자산을 불러오지 못했습니다"><Button onClick={refresh}>다시 시도</Button></EmptyState> : items.length === 0 ? <EmptyState title={view.kind === "album" ? "이 앨범에 자산이 없습니다." : view.kind === "collection" ? "이 컬렉션에 자산이 없습니다." : "자산이 없습니다"}>{view.kind === "album" ? "원하는 자산을 이 앨범에 추가하세요." : view.kind === "collection" ? "원하는 자산을 이 컬렉션에 추가하세요." : "여기에 이미지와 영상 파일을 놓아 추가하세요."}</EmptyState>         : <AssetGallery items={items} dateBuckets={dateBuckets} onSelectDate={(date) => setCollectedFrom(date || null)} selectedAssetIds={selection.ids} focusAssetId={selection.focusId} targetRowHeight={thumbnailRowHeight} metadataVisible={metadataVisible} hasNextPage={nextCursor !== null} onLoadNextPage={loadNextPage} onSelectionGesture={selectWithGesture} onSelectAll={selectAll} onDeleteSelection={trashSelection} onClearSelection={clearSelection} onMoveFocus={moveFocus} onOpen={(asset) => { viewerViewKeyRef.current = viewKey; setViewerAssetId(asset.id); }} onRetryVideo={(asset) => void gateway.retryVideoPreparation(asset.id).then(() => gateway.preparePendingVideos(1)).then(refresh).catch((error) => setMessage(commandErrorMessage(error, "미리보기 준비를 다시 시작하지 못했습니다.")))} onPointerDragStart={onPointerDragStart} onPointerDragMove={onPointerDragMove} onPointerDragEnd={onPointerDragEnd} onPointerDragCancel={onPointerDragCancel} />}
        {nextLoading && <Skeleton label="자산을 더 불러오는 중" />}{currentNextError && <div className="asset-browser__next-error"><Toast>{currentNextError}</Toast><Button onClick={() => loadNextPage(true)}>다시 시도</Button></div>}
      </div>
      <AssetInspector assets={selectedAssets} classifications={classifications} albums={albums} collections={collections} currentCollection={view.kind === "collection" ? collections.find((entry) => entry.id === view.collectionId) ?? null : null} open={inspectorOpen} membershipVersion={membershipVersion} onOpenChange={setInspectorOpen} onMoveToFolder={moveBatchToFolder} onPatchAlbum={patchBatchAlbum} onPatchCollection={patchBatchCollection} onAssetUpdated={updateAssetSummary} />
    </div>
    <AssetViewer items={requestedAsset && !items.some((item) => item.id === requestedAsset.id) ? [requestedAsset] : items} activeId={viewerAssetId} onActiveIdChange={setViewerAssetId} onClose={() => { setViewerAssetId(null); onRequestedAssetHandled(); }} onToggleFavorite={toggleFavorite} onTrash={trashViewerAsset} />
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
