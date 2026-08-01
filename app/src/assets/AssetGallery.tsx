import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AssetSummary, ClassificationEntry } from "../library/types";
import { buildJustifiedRows } from "./justifiedRows";
import { thumbnailUrl } from "./mediaUrl";
import "../styles/tokens.css";

const VIRTUAL_OVERSCAN_ROWS = 3;
const NEXT_PAGE_THRESHOLD_ROWS = 5;

type AssetGalleryProps = {
  items: AssetSummary[];
  classifications?: ClassificationEntry[];
  selectedAssetId?: string | null;
  metadataVisible?: boolean;
  hasNextPage?: boolean;
  onLoadNextPage?: () => void;
  onSelect?: (asset: AssetSummary | null) => void;
  onOpen?: (asset: AssetSummary) => void;
  // Transitional compatibility for existing gallery consumers; toolbar ownership is AssetToolbar.
  directOnly?: boolean;
  onDirectOnlyChange?: (directOnly: boolean) => void;
};

export function AssetGallery({ items, selectedAssetId = null, metadataVisible = false, hasNextPage = false, onLoadNextPage, onSelect, onOpen }: AssetGalleryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { width, gap, targetRowHeight } = useGalleryMetrics(scrollRef);
  const rows = useMemo(() => buildJustifiedRows(items, width, targetRowHeight, gap), [gap, items, targetRowHeight, width]);
  const rowVirtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: (index) => rows[index]?.height ?? targetRowHeight, getItemKey: (index) => rows[index]?.items[0]?.id ?? index, gap, overscan: VIRTUAL_OVERSCAN_ROWS });
  const virtualRows = rowVirtualizer.getVirtualItems();
  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    if (hasNextPage && onLoadNextPage && last && last.index >= rows.length - NEXT_PAGE_THRESHOLD_ROWS) onLoadNextPage();
  }, [hasNextPage, onLoadNextPage, rows.length, virtualRows]);
  return <div ref={scrollRef} className="asset-gallery__scroll" onClick={(event) => { if (!(event.target as HTMLElement).closest(".asset-gallery__asset")) onSelect?.(null); }}>
    <div className="asset-gallery__virtual-space" style={{ height: rowVirtualizer.getTotalSize() }}>
      {virtualRows.map((virtualRow) => {
        const row = rows[virtualRow.index]; if (!row) return null;
        return <div key={virtualRow.key} className="asset-gallery__row" style={{ gap, height: row.height, transform: `translateY(${virtualRow.start}px)` }}>
          {row.items.map((asset) => <AssetTile key={asset.id} asset={asset} height={row.height} selected={selectedAssetId === asset.id} metadataVisible={metadataVisible} onSelect={onSelect} onOpen={onOpen} />)}
        </div>;
      })}
    </div>
  </div>;
}

function AssetTile({ asset, height, selected, metadataVisible, onSelect, onOpen }: { asset: AssetSummary; height: number; selected: boolean; metadataVisible: boolean; onSelect?: (asset: AssetSummary) => void; onOpen?: (asset: AssetSummary) => void }) {
  const alt = asset.title || asset.originalName;
  return <button type="button" className="asset-gallery__asset" style={{ width: asset.width, height }} aria-label={alt} aria-selected={selected} onClick={() => onSelect?.(asset)} onDoubleClick={() => onOpen?.(asset)} onKeyDown={(event) => { if (event.key === "Enter") onOpen?.(asset); }}>
    <img src={thumbnailUrl(asset.id)} alt={alt} />
    {metadataVisible && <span className="asset-gallery__metadata"><span>{sourceHost(asset.sourceUrl)}</span><span>{localDate(asset.collectedAt)}</span></span>}
  </button>;
}

function sourceHost(sourceUrl: string | null) { if (!sourceUrl) return null; try { return new URL(sourceUrl).hostname || null; } catch { return null; } }
function localDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(); }

function useGalleryMetrics(ref: React.RefObject<HTMLElement | null>) {
  const [metrics, setMetrics] = useState({ width: 0, gap: 0, targetRowHeight: 1 });
  useLayoutEffect(() => {
    const element = ref.current; if (!element) return;
    const update = (width: number) => { const style = getComputedStyle(element); const gap = Number.parseFloat(style.getPropertyValue("--space-2")); const targetRowHeight = Number.parseFloat(style.getPropertyValue("--gallery-target-row-height")); setMetrics({ width, gap: Number.isFinite(gap) ? gap : 0, targetRowHeight: Number.isFinite(targetRowHeight) && targetRowHeight > 0 ? targetRowHeight : element.clientHeight * 0.3 }); };
    update(element.clientWidth); if (!window.ResizeObserver) return;
    const observer = new ResizeObserver(([entry]) => update(entry?.contentRect.width ?? element.clientWidth)); observer.observe(element); return () => observer.disconnect();
  }, [ref]);
  return metrics;
}
