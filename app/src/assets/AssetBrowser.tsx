import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ASSET_PAGE_SIZE } from "../library/constants";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { AssetCursor, AssetQuery, AssetSort, AssetSummary, AssetView, ClassificationEntry } from "../library/types";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { AssetDetailDialog } from "./AssetDetailDialog";
import { AssetGallery } from "./AssetGallery";
import { AssetToolbar } from "./AssetToolbar";

export type AssetBrowserStatus = { loadedCount: number; selectedAsset: AssetSummary | null; loading: boolean };
type Props = { view: AssetView; classifications: ClassificationEntry[]; sort: AssetSort; metadataVisible: boolean; refreshVersion: number; onSortChange: (sort: AssetSort) => void; onMetadataVisibleChange: (visible: boolean) => void; onStatusChange: (status: AssetBrowserStatus) => void };
type PageState = { queryKey: string; items: AssetSummary[]; nextCursor: AssetCursor | null };
type QueryError = { queryKey: string; message: string };

export function AssetBrowser({ view, classifications, sort, metadataVisible, refreshVersion, onSortChange, onMetadataVisibleChange, onStatusChange }: Props) {
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
  const [detailAsset, setDetailAsset] = useState<AssetSummary | null>(null);
  const selectedViewKeyRef = useRef<string | null>(null);
  const detailViewKeyRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const nextLoadingRef = useRef(false);
  const randomPivotRef = useRef<string | null>(null);
  const effectiveSort = view.kind === "recent" ? "newest" : sort;
  if (effectiveSort === "random" && !randomPivotRef.current) randomPivotRef.current = createRandomPivot();
  useEffect(() => { if (effectiveSort !== "random") randomPivotRef.current = null; }, [effectiveSort]);
  useEffect(() => { if (view.kind !== "classification") setDirectOnly(false); }, [view.kind]);
  const queryBase = useMemo<Omit<AssetQuery, "after">>(() => ({ classificationId: view.kind === "classification" ? view.classificationId : null, directOnly: view.kind === "classification" ? directOnly : false, favoriteOnly: view.kind === "favorites", sort: effectiveSort, randomPivot: effectiveSort === "random" ? randomPivotRef.current : null, limit: ASSET_PAGE_SIZE }), [directOnly, effectiveSort, randomVersion, view]);
  const queryKey = JSON.stringify(queryBase);
  const viewKey = view.kind === "classification" ? `classification:${view.classificationId}` : view.kind;
  const activePage = page?.queryKey === queryKey ? page : null;
  const items = activePage?.items ?? [];
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
      setDetailAsset((detail) => reconcileAsset(detail, detailViewKeyRef.current, viewKey, result.items));
    }).catch((error: unknown) => { if (generation === generationRef.current) setFirstError({ queryKey, message: commandErrorMessage(error, "자산을 불러오지 못했습니다.") }); }).finally(() => { if (generation === generationRef.current) setFirstLoading(false); });
    return () => { if (generation === generationRef.current) generationRef.current += 1; };
  }, [gateway, queryBase, queryKey, refreshVersion, retryVersion, viewKey]);
  useEffect(() => onStatusChange({ loadedCount: items.length, selectedAsset, loading: firstLoading || nextLoading }), [firstLoading, items.length, nextLoading, onStatusChange, selectedAsset]);
  const loadNextPage = useCallback((retry = false) => {
    if (!activePage || !nextCursor || nextLoadingRef.current || (currentNextError && !retry)) return;
    const generation = generationRef.current; const cursor = nextCursor; nextLoadingRef.current = true; setNextLoading(true); setNextError(null);
    void gateway.listAssets({ ...queryBase, after: cursor }).then((result) => { if (generation !== generationRef.current) return; setPage((current) => current?.queryKey === queryKey ? { queryKey, items: [...current.items, ...result.items], nextCursor: result.nextCursor } : current); }).catch((error: unknown) => { if (generation === generationRef.current) setNextError({ queryKey, message: commandErrorMessage(error, "다음 자산을 불러오지 못했습니다.") }); }).finally(() => { if (generation === generationRef.current) { nextLoadingRef.current = false; setNextLoading(false); } });
  }, [activePage, currentNextError, gateway, nextCursor, queryBase, queryKey]);
  const toggleFavorite = useCallback(async () => {
    if (!selectedAsset) return;
    const target = selectedAsset; const favorite = !target.favorite;
    const update = (asset: AssetSummary) => asset.id === target.id ? { ...asset, favorite } : asset;
    setPage((current) => current?.queryKey === queryKey ? { ...current, items: current.items.map(update) } : current); setSelectedAsset(update(target)); if (detailAsset?.id === target.id) setDetailAsset(update(target));
    try { await gateway.setAssetFavorite(target.id, favorite); if (view.kind === "favorites" || effectiveSort === "favorites") refresh(); }
    catch (error) { const rollback = (asset: AssetSummary) => asset.id === target.id ? target : asset; setPage((current) => current?.queryKey === queryKey ? { ...current, items: current.items.map(rollback) } : current); setSelectedAsset(target); if (detailAsset?.id === target.id) setDetailAsset(target); setFirstError({ queryKey, message: commandErrorMessage(error, "좋아요를 변경하지 못했습니다.") }); }
  }, [detailAsset, effectiveSort, gateway, queryKey, refresh, selectedAsset, view.kind]);
  const trashSelected = useCallback(async () => {
    if (!selectedAsset) return;
    try {
      await gateway.trashAsset(selectedAsset.id);
      setSelectedAsset(null);
      setDetailAsset(null);
      setMessage("휴지통으로 이동했습니다.");
      refresh();
    } catch (error) {
      setMessage(commandErrorMessage(error, "자산을 휴지통으로 이동하지 못했습니다."));
    }
  }, [gateway, refresh, selectedAsset]);
  const trashDetail = useCallback(() => {
    setSelectedAsset(null);
    setDetailAsset(null);
    setMessage("휴지통으로 이동했습니다.");
    refresh();
  }, [refresh]);
  const reshuffle = () => { randomPivotRef.current = createRandomPivot(); setRandomVersion((value) => value + 1); };
  return <section className="asset-browser" aria-label="전체 자산">
    <AssetToolbar view={view} classifications={classifications} sort={sort} directOnly={directOnly} metadataVisible={metadataVisible} selectedAsset={selectedAsset} onSortChange={onSortChange} onDirectOnlyChange={setDirectOnly} onMetadataVisibleChange={onMetadataVisibleChange} onFavorite={() => void toggleFavorite()} onTrash={() => void trashSelected()} onReshuffle={reshuffle} />
    {message && <Toast>{message}</Toast>}
    {currentFirstError && <Toast>{currentFirstError}</Toast>}
    {firstLoading || !activePage && !currentFirstError ? <Skeleton className="asset-browser__skeleton" label="자산을 불러오는 중" /> : currentFirstError && items.length === 0 ? <EmptyState title="자산을 불러오지 못했습니다"><Button onClick={refresh}>다시 시도</Button></EmptyState> : items.length === 0 ? <EmptyState title="자산이 없습니다">여기에 이미지를 놓아 추가하세요.</EmptyState> : <AssetGallery items={items} selectedAssetId={selectedAsset?.id} metadataVisible={metadataVisible} hasNextPage={nextCursor !== null} onLoadNextPage={loadNextPage} onSelect={(asset) => { selectedViewKeyRef.current = asset ? viewKey : null; setSelectedAsset(asset); }} onOpen={(asset) => { detailViewKeyRef.current = viewKey; setDetailAsset(asset); }} />}
    {nextLoading && <Skeleton label="자산을 더 불러오는 중" />}{currentNextError && <div className="asset-browser__next-error"><Toast>{currentNextError}</Toast><Button onClick={() => loadNextPage(true)}>다시 시도</Button></div>}
    <AssetDetailDialog asset={detailAsset} classifications={classifications} onClose={() => setDetailAsset(null)} onTrashed={trashDetail} />
  </section>;
}

function reconcileAsset(current: AssetSummary | null, currentViewKey: string | null, viewKey: string, items: AssetSummary[]) {
  if (!current || currentViewKey !== viewKey) return null;
  return items.find((asset) => asset.id === current.id) ?? null;
}

function createRandomPivot() {
  return (crypto.randomUUID() as unknown as { replaceAll(search: string, replacement: string): string }).replaceAll("-", "");
}
