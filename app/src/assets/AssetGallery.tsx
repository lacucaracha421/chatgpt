import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AssetSummary, ClassificationEntry } from "../library/types";
import type { SelectionGesture } from "./selection";
import { buildJustifiedRows } from "./justifiedRows";
import { thumbnailUrl } from "./mediaUrl";
import "../styles/tokens.css";

const VIRTUAL_OVERSCAN_ROWS = 3;
const NEXT_PAGE_THRESHOLD_ROWS = 5;

type AssetGalleryProps = {
  items: AssetSummary[];
  classifications?: ClassificationEntry[];
  selectedAssetIds?: ReadonlySet<string>;
  focusAssetId?: string | null;
  targetRowHeight?: number;
  metadataVisible?: boolean;
  hasNextPage?: boolean;
  onLoadNextPage?: () => void;
  onSelectionGesture?: (asset: AssetSummary, gesture: SelectionGesture) => void;
  onSelectAll?: () => void;
  onDeleteSelection?: () => void;
  onClearSelection?: () => void;
  onMoveFocus?: (delta: number, extend: boolean) => void;
  onOpen?: (asset: AssetSummary) => void;
  // Transitional compatibility for existing gallery consumers; toolbar ownership is AssetToolbar.
  directOnly?: boolean;
  onDirectOnlyChange?: (directOnly: boolean) => void;
};

export function AssetGallery({ items, selectedAssetIds = new Set(), focusAssetId = null, targetRowHeight = 180, metadataVisible = false, hasNextPage = false, onLoadNextPage, onSelectionGesture, onSelectAll, onDeleteSelection, onClearSelection, onMoveFocus, onOpen }: AssetGalleryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusRequestedRef = useRef(false);
  const { width, gap } = useGalleryMetrics(scrollRef);
  const rows = useMemo(() => buildJustifiedRows(items, width, targetRowHeight, gap), [gap, items, targetRowHeight, width]);
  const rowVirtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: (index) => rows[index]?.height ?? targetRowHeight, getItemKey: (index) => rows[index]?.items[0]?.id ?? index, gap, overscan: VIRTUAL_OVERSCAN_ROWS });
  const virtualRows = rowVirtualizer.getVirtualItems();
  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    if (hasNextPage && onLoadNextPage && last && last.index >= rows.length - NEXT_PAGE_THRESHOLD_ROWS) onLoadNextPage();
  }, [hasNextPage, onLoadNextPage, rows.length, virtualRows]);
  useLayoutEffect(() => {
    if (!focusRequestedRef.current || !focusAssetId) return;
    [...(scrollRef.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])]
      .find((element) => element.dataset.assetId === focusAssetId)
      ?.focus();
    focusRequestedRef.current = false;
  }, [focusAssetId]);
  return <div
    ref={scrollRef}
    className="asset-gallery__scroll"
    role="listbox"
    aria-label="자산"
    aria-multiselectable="true"
    onClick={(event) => { if (!(event.target as HTMLElement).closest(".asset-gallery__asset")) onClearSelection?.(); }}
    onKeyDown={(event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        onSelectAll?.();
      } else if (event.key === "Delete") {
        event.preventDefault();
        onDeleteSelection?.();
      } else if (event.key === "Escape") {
        event.preventDefault();
        onClearSelection?.();
      } else if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        focusRequestedRef.current = true;
        onMoveFocus?.(event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1, event.shiftKey);
      }
    }}
  >
    <div className="asset-gallery__virtual-space" style={{ height: rowVirtualizer.getTotalSize() }}>
      {virtualRows.map((virtualRow) => {
        const row = rows[virtualRow.index]; if (!row) return null;
        return <div key={virtualRow.key} className="asset-gallery__row" style={{ gap, height: row.height, transform: `translateY(${virtualRow.start}px)` }}>
          {row.items.map((asset, index) => <AssetTile key={asset.id} asset={asset} height={row.height} selected={selectedAssetIds.has(asset.id)} focused={focusAssetId ? focusAssetId === asset.id : virtualRow.index === 0 && index === 0} metadataVisible={metadataVisible} onSelectionGesture={onSelectionGesture} onOpen={onOpen} />)}
        </div>;
      })}
    </div>
  </div>;
}

function AssetTile({ asset, height, selected, focused, metadataVisible, onSelectionGesture, onOpen }: { asset: AssetSummary; height: number; selected: boolean; focused: boolean; metadataVisible: boolean; onSelectionGesture?: (asset: AssetSummary, gesture: SelectionGesture) => void; onOpen?: (asset: AssetSummary) => void }) {
  const alt = asset.title || asset.originalName;
  return <button type="button" role="option" data-asset-id={asset.id} className="asset-gallery__asset" style={{ width: asset.width, height }} aria-label={alt} aria-selected={selected} tabIndex={focused ? 0 : -1} onClick={(event) => onSelectionGesture?.(asset, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey })} onDoubleClick={() => onOpen?.(asset)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onOpen?.(asset); } }}>
    <img src={thumbnailUrl(asset.id)} alt={alt} width={asset.width} height={asset.height} loading="lazy" />
    {metadataVisible && <span className="asset-gallery__metadata"><span>{sourceHost(asset.sourceUrl)}</span><span>{localDate(asset.collectedAt)}</span></span>}
  </button>;
}

function sourceHost(sourceUrl: string | null) { if (!sourceUrl) return null; try { return new URL(sourceUrl).hostname || null; } catch { return null; } }
function localDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(); }

function useGalleryMetrics(ref: React.RefObject<HTMLElement | null>) {
  const [metrics, setMetrics] = useState({ width: 0, gap: 0 });
  useLayoutEffect(() => {
    const element = ref.current; if (!element) return;
    const update = (width: number) => { const style = getComputedStyle(element); const gap = Number.parseFloat(style.getPropertyValue("--space-2")); setMetrics({ width, gap: Number.isFinite(gap) ? gap : 0 }); };
    update(element.clientWidth); if (!window.ResizeObserver) return;
    const observer = new ResizeObserver(([entry]) => update(entry?.contentRect.width ?? element.clientWidth)); observer.observe(element); return () => observer.disconnect();
  }, [ref]);
  return metrics;
}
