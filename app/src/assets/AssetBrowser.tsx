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

export function AssetBrowser({ view, classifications, sort, metadataVisible, refreshVersion, onSortChange, onMetadataVisibleChange, onStatusChange }: Props) {
  const { gateway } = useLibrary();
  const [directOnly, setDirectOnly] = useState(false);
  const [items, setItems] = useState<AssetSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<AssetCursor | null>(null);
  const [firstLoading, setFirstLoading] = useState(true);
  const [nextLoading, setNextLoading] = useState(false);
  const [firstError, setFirstError] = useState<string | null>(null);
  const [nextError, setNextError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const [randomVersion, setRandomVersion] = useState(0);
  const [selectedAsset, setSelectedAsset] = useState<AssetSummary | null>(null);
  const [detailAsset, setDetailAsset] = useState<AssetSummary | null>(null);
  const generationRef = useRef(0);
  const nextLoadingRef = useRef(false);
  const randomPivotRef = useRef<string | null>(null);
  const effectiveSort = view.kind === "recent" ? "newest" : sort;
  if (effectiveSort === "random" && !randomPivotRef.current) randomPivotRef.current = createRandomPivot();
  useEffect(() => { if (effectiveSort !== "random") randomPivotRef.current = null; }, [effectiveSort]);
  useEffect(() => { if (view.kind !== "classification") setDirectOnly(false); }, [view.kind]);
  const queryBase = useMemo<Omit<AssetQuery, "after">>(() => ({ classificationId: view.kind === "classification" ? view.classificationId : null, directOnly: view.kind === "classification" ? directOnly : false, favoriteOnly: view.kind === "favorites", sort: effectiveSort, randomPivot: effectiveSort === "random" ? randomPivotRef.current : null, limit: ASSET_PAGE_SIZE }), [directOnly, effectiveSort, randomVersion, view]);
  const refresh = useCallback(() => setRetryVersion((value) => value + 1), []);
  useEffect(() => {
    const generation = ++generationRef.current;
    nextLoadingRef.current = false; setFirstLoading(true); setNextLoading(false); setItems([]); setNextCursor(null); setFirstError(null); setNextError(null); setSelectedAsset(null); setDetailAsset(null);
    void gateway.listAssets({ ...queryBase, after: null }).then((page) => { if (generation !== generationRef.current) return; setItems(page.items); setNextCursor(page.nextCursor); }).catch((error: unknown) => { if (generation === generationRef.current) setFirstError(commandErrorMessage(error, "Could not load assets.")); }).finally(() => { if (generation === generationRef.current) setFirstLoading(false); });
    return () => { if (generation === generationRef.current) generationRef.current += 1; };
  }, [gateway, queryBase, refreshVersion, retryVersion]);
  useEffect(() => { if (selectedAsset && !items.some((asset) => asset.id === selectedAsset.id)) setSelectedAsset(null); if (detailAsset && !items.some((asset) => asset.id === detailAsset.id)) setDetailAsset(null); }, [detailAsset, items, selectedAsset]);
  useEffect(() => onStatusChange({ loadedCount: items.length, selectedAsset, loading: firstLoading || nextLoading }), [firstLoading, items.length, nextLoading, onStatusChange, selectedAsset]);
  const loadNextPage = useCallback((retry = false) => {
    if (!nextCursor || nextLoadingRef.current || (nextError && !retry)) return;
    const generation = generationRef.current; const cursor = nextCursor; nextLoadingRef.current = true; setNextLoading(true); setNextError(null);
    void gateway.listAssets({ ...queryBase, after: cursor }).then((page) => { if (generation !== generationRef.current) return; setItems((current) => [...current, ...page.items]); setNextCursor(page.nextCursor); }).catch((error: unknown) => { if (generation === generationRef.current) setNextError(commandErrorMessage(error, "Could not load the next page.")); }).finally(() => { if (generation === generationRef.current) { nextLoadingRef.current = false; setNextLoading(false); } });
  }, [gateway, nextCursor, nextError, queryBase]);
  const toggleFavorite = useCallback(async () => {
    if (!selectedAsset) return;
    const target = selectedAsset; const favorite = !target.favorite;
    const update = (asset: AssetSummary) => asset.id === target.id ? { ...asset, favorite } : asset;
    setItems((current) => current.map(update)); setSelectedAsset(update(target)); if (detailAsset?.id === target.id) setDetailAsset(update(target));
    try { await gateway.setAssetFavorite(target.id, favorite); if (view.kind === "favorites" || effectiveSort === "favorites") refresh(); }
    catch (error) { const rollback = (asset: AssetSummary) => asset.id === target.id ? target : asset; setItems((current) => current.map(rollback)); setSelectedAsset(target); if (detailAsset?.id === target.id) setDetailAsset(target); setFirstError(commandErrorMessage(error, "Could not update favorite.")); }
  }, [detailAsset, effectiveSort, gateway, refresh, selectedAsset, view.kind]);
  const reshuffle = () => { randomPivotRef.current = createRandomPivot(); setRandomVersion((value) => value + 1); };
  return <section className="asset-browser" aria-label="Assets">
    <AssetToolbar view={view} classifications={classifications} sort={sort} directOnly={directOnly} metadataVisible={metadataVisible} selectedAsset={selectedAsset} onSortChange={onSortChange} onDirectOnlyChange={setDirectOnly} onMetadataVisibleChange={onMetadataVisibleChange} onFavorite={() => void toggleFavorite()} onReshuffle={reshuffle} />
    {firstError && <Toast>{firstError}</Toast>}
    {firstLoading ? <Skeleton className="asset-browser__skeleton" label="Loading assets" /> : firstError && items.length === 0 ? <EmptyState title="Could not load assets"><Button onClick={refresh}>Retry</Button></EmptyState> : items.length === 0 ? <EmptyState title="No assets">Drop images here to add them.</EmptyState> : <AssetGallery items={items} selectedAssetId={selectedAsset?.id} metadataVisible={metadataVisible} hasNextPage={nextCursor !== null} onLoadNextPage={loadNextPage} onSelect={setSelectedAsset} onOpen={setDetailAsset} />}
    {nextLoading && <Skeleton label="Loading more assets" />}{nextError && <div className="asset-browser__next-error"><Toast>{nextError}</Toast><Button onClick={() => loadNextPage(true)}>Retry</Button></div>}
    <AssetDetailDialog asset={detailAsset} classifications={classifications} onClose={() => setDetailAsset(null)} />
  </section>;
}

function createRandomPivot() {
  return (crypto.randomUUID() as unknown as { replaceAll(search: string, replacement: string): string }).replaceAll("-", "");
}
