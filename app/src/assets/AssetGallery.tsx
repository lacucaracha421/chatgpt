import { useVirtualizer } from "@tanstack/react-virtual";
import { PlusIcon } from "@heroicons/react/24/outline";
import { HeartIcon } from "@heroicons/react/24/solid";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AssetSummary } from "../library/types";
import { assetDragIds, type InternalDragPayload } from "../shared/interaction/pointerDrag";
import type { SelectionGesture } from "./selection";
import { buildJustifiedRows, type JustifiedRow } from "./justifiedRows";
import { assetUrl, thumbnailUrl } from "./mediaUrl";
import { VideoTileMedia } from "../video/VideoTileMedia";
import "../styles/tokens.css";

const VIRTUAL_OVERSCAN_ROWS = 3;
const NEXT_PAGE_THRESHOLD_ROWS = 5;
const DATE_LINE_HEIGHT = 2;
const SPARSE_DATE_LINE_COUNT = 4;
const QUICK_PREVIEW_DELAY_MS = 150;

type QuickPreviewState = { asset: AssetSummary; anchor: DOMRect };

type AssetGalleryProps = {
  items: AssetSummary[];
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
  onRetryVideo?: (asset: AssetSummary) => void;
  onPointerDragStart?: (payload: InternalDragPayload, event: React.PointerEvent<HTMLElement>) => void;
  onPointerDragMove?: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerDragEnd?: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerDragCancel?: (event: React.PointerEvent<HTMLElement>) => void;
};

export function AssetGallery({ items, selectedAssetIds = new Set(), focusAssetId = null, targetRowHeight = 180, metadataVisible = false, hasNextPage = false, onLoadNextPage, onSelectionGesture, onSelectAll, onDeleteSelection, onClearSelection, onMoveFocus, onOpen, onRetryVideo, onPointerDragStart, onPointerDragMove, onPointerDragEnd, onPointerDragCancel }: AssetGalleryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusRequestedRef = useRef(false);
  const quickPreviewTimerRef = useRef<number | null>(null);
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const [quickPreview, setQuickPreview] = useState<QuickPreviewState | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const { width, gap, height } = useGalleryMetrics(scrollRef);
  const rows = useMemo(() => buildJustifiedRows(items, width, targetRowHeight, gap), [gap, items, targetRowHeight, width]);
  const rowVirtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: (index) => rows[index]?.height ?? targetRowHeight, getItemKey: (index) => rows[index]?.items[0]?.id ?? index, gap, overscan: VIRTUAL_OVERSCAN_ROWS });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rows.length > 0 ? rows.reduce((sum, row) => sum + row.height, 0) + gap * (rows.length - 1) : 0;
  const dateLines = useMemo(() => buildDateLines(rows, gap, totalSize, height), [gap, height, rows, totalSize]);
  const visibleStart = scrollTop;
  const visibleEnd = scrollTop + height;
  const activeLineKeys = new Set(dateLines.filter((line) => line.contentCenter >= visibleStart && line.contentCenter <= visibleEnd).map((line) => line.key));
  const cancelQuickPreview = () => {
    if (quickPreviewTimerRef.current !== null) window.clearTimeout(quickPreviewTimerRef.current);
    quickPreviewTimerRef.current = null;
    setQuickPreview(null);
  };
  const requestQuickPreview = (asset: AssetSummary, trigger: HTMLElement) => {
    if (quickPreviewTimerRef.current !== null) window.clearTimeout(quickPreviewTimerRef.current);
    quickPreviewTimerRef.current = window.setTimeout(() => {
      setQuickPreview({ asset, anchor: trigger.getBoundingClientRect() });
      quickPreviewTimerRef.current = null;
    }, QUICK_PREVIEW_DELAY_MS);
  };
  const scrollToPointer = (clientY: number) => {
    const element = scrollRef.current; if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.height <= 0) return;
    element.scrollTop = ((clientY - rect.top) / rect.height) * (element.scrollHeight - element.clientHeight);
  };
  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    if (hasNextPage && onLoadNextPage && last && last.index >= rows.length - NEXT_PAGE_THRESHOLD_ROWS) onLoadNextPage();
  }, [hasNextPage, onLoadNextPage, rows.length, virtualRows]);
  useEffect(() => () => {
    if (quickPreviewTimerRef.current !== null) window.clearTimeout(quickPreviewTimerRef.current);
  }, []);
  useLayoutEffect(() => {
    if (!focusRequestedRef.current || !focusAssetId) return;
    [...(scrollRef.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])]
      .find((element) => element.dataset.assetId === focusAssetId)
      ?.focus();
    focusRequestedRef.current = false;
  }, [focusAssetId]);
  return <div className="asset-gallery">
    <div
      ref={scrollRef}
      className="asset-gallery__scroll"
      role="listbox"
      aria-label="자산"
      aria-multiselectable="true"
      onScroll={(event) => { cancelQuickPreview(); setScrollTop(event.currentTarget.scrollTop); }}
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
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            if (focusAssetId) {
              const delta = rowMoveDelta(rows, gap, items, focusAssetId, event.key === "ArrowDown" ? 1 : -1);
              if (delta !== 0) onMoveFocus?.(delta, event.shiftKey);
            }
          } else {
            onMoveFocus?.(event.key === "ArrowRight" ? 1 : -1, event.shiftKey);
          }
        }
      }}
    >
      <div className="asset-gallery__virtual-space" style={{ height: rowVirtualizer.getTotalSize() }}>
        {virtualRows.map((virtualRow) => {
          const row = rows[virtualRow.index]; if (!row) return null;
          return <div key={virtualRow.key} className="asset-gallery__row" style={{ gap, height: row.height, transform: `translateY(${virtualRow.start}px)` }}>
            {row.items.map((asset, index) => <AssetTile key={asset.id} asset={asset} height={row.height} selected={selectedAssetIds.has(asset.id)} selectedAssetIds={selectedAssetIds} focused={focusAssetId ? focusAssetId === asset.id : virtualRow.index === 0 && index === 0} metadataVisible={metadataVisible} activePreview={activePreviewId === asset.id} onRequestPreview={() => setActivePreviewId(asset.id)} onReleasePreview={() => setActivePreviewId((current) => current === asset.id ? null : current)} onRequestQuickPreview={requestQuickPreview} onCancelQuickPreview={cancelQuickPreview} onRetryVideo={onRetryVideo} onSelectionGesture={onSelectionGesture} onOpen={onOpen} onPointerDragStart={onPointerDragStart} onPointerDragMove={onPointerDragMove} onPointerDragEnd={onPointerDragEnd} onPointerDragCancel={onPointerDragCancel} />)}
          </div>;
        })}
      </div>
    </div>
    {dateLines.length > 0 && <div className="asset-gallery__scrollbar" aria-hidden="true" onPointerDown={(event) => { if (event.button === 0) { event.currentTarget.setPointerCapture(event.pointerId); scrollToPointer(event.clientY); } }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) scrollToPointer(event.clientY); }}>
      {dateLines.map((line) => <span key={line.key} className={activeLineKeys.has(line.key) ? "asset-gallery__scrollbar-line asset-gallery__scrollbar-line--active" : "asset-gallery__scrollbar-line"} style={{ top: `${line.top}px`, height: `${line.height}px` }} />)}
    </div>}
    {quickPreview && <div className="asset-gallery__quick-preview"><img src={assetUrl(quickPreview.asset.id)} alt={`${quickPreview.asset.title || quickPreview.asset.originalName} 빠른 미리보기`} draggable={false} onError={cancelQuickPreview} /></div>}
  </div>;
}

function AssetTile({ asset, height, selected, selectedAssetIds, focused, metadataVisible, activePreview, onRequestPreview, onReleasePreview, onRequestQuickPreview, onCancelQuickPreview, onRetryVideo, onSelectionGesture, onOpen, onPointerDragStart, onPointerDragMove, onPointerDragEnd, onPointerDragCancel }: { asset: AssetSummary; height: number; selected: boolean; selectedAssetIds: ReadonlySet<string>; focused: boolean; metadataVisible: boolean; activePreview: boolean; onRequestPreview(): void; onReleasePreview(): void; onRequestQuickPreview(asset: AssetSummary, trigger: HTMLElement): void; onCancelQuickPreview(): void; onRetryVideo?: AssetGalleryProps["onRetryVideo"]; onSelectionGesture?: (asset: AssetSummary, gesture: SelectionGesture) => void; onOpen?: (asset: AssetSummary) => void; onPointerDragStart?: AssetGalleryProps["onPointerDragStart"]; onPointerDragMove?: AssetGalleryProps["onPointerDragMove"]; onPointerDragEnd?: AssetGalleryProps["onPointerDragEnd"]; onPointerDragCancel?: AssetGalleryProps["onPointerDragCancel"] }) {
  const alt = asset.title || asset.originalName;
  return <div role="option" data-asset-id={asset.id} className="asset-gallery__asset" style={{ width: asset.width, height }} aria-label={alt} aria-selected={selected} tabIndex={focused ? 0 : -1} onClick={(event) => onSelectionGesture?.(asset, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey })} onDoubleClick={() => onOpen?.(asset)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onOpen?.(asset); } }} onPointerDown={(event) => { if (event.button === 0) onPointerDragStart?.({ kind: "assets", assetIds: assetDragIds(asset.id, selectedAssetIds) }, event); }} onPointerMove={onPointerDragMove} onPointerUp={onPointerDragEnd} onPointerCancel={onPointerDragCancel}>
    {asset.media.kind === "video" ? <VideoTileMedia asset={asset as AssetSummary & { media: Extract<AssetSummary["media"], { kind: "video" }> }} active={activePreview} onRequestActive={onRequestPreview} onReleaseActive={onReleasePreview} onRetry={() => onRetryVideo?.(asset)} /> : <img src={thumbnailUrl(asset.id)} alt={alt} width={asset.width} height={asset.height} loading="lazy" draggable={false} />}
    {asset.favorite && <span className="asset-gallery__favorite" aria-hidden="true"><HeartIcon /></span>}
    {metadataVisible && <span className="asset-gallery__metadata"><span>{sourceHost(asset.sourceUrl)}</span><span>{localDate(asset.collectedAt)}</span></span>}
    {asset.media.kind === "image" && <button type="button" className="asset-gallery__quick-preview-trigger" aria-label={`${alt} 빠른 확대 미리보기`} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onPointerEnter={(event) => onRequestQuickPreview(asset, event.currentTarget)} onPointerLeave={onCancelQuickPreview} onFocus={(event) => onRequestQuickPreview(asset, event.currentTarget)} onBlur={onCancelQuickPreview} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancelQuickPreview(); } }}><PlusIcon aria-hidden="true" /></button>}
  </div>;
}

function sourceHost(sourceUrl: string | null) { if (!sourceUrl) return null; try { return new URL(sourceUrl).hostname || null; } catch { return null; } }
function localDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(); }

type DateLine = { key: string; top: number; height: number; contentCenter: number };

function buildDateLines(rows: JustifiedRow<AssetSummary>[], gap: number, totalSize: number, trackHeight: number): DateLine[] {
  if (trackHeight <= 0 || totalSize <= 0 || rows.length === 0) return [];
  const byDate = new Map<string, { min: number; max: number }>();
  let offset = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const center = offset + row.height / 2;
    for (const item of row.items) {
      const key = dateKey(item.collectedAt);
      if (!key) continue;
      const span = byDate.get(key);
      if (span) {
        if (center < span.min) span.min = center;
        if (center > span.max) span.max = center;
      } else {
        byDate.set(key, { min: center, max: center });
      }
    }
    offset += row.height + (index < rows.length - 1 ? gap : 0);
  }
  const scale = trackHeight / totalSize;
  const lines = [...byDate.entries()].map(([key, span]) => ({
    key,
    contentCenter: (span.min + span.max) / 2,
  }));
  if (lines.length <= SPARSE_DATE_LINE_COUNT) {
    const bandTop = trackHeight * 0.3;
    const bandBottom = trackHeight * 0.7;
    const step = lines.length === 1 ? 0 : (bandBottom - bandTop) / (lines.length - 1);
    return lines.map((line, index) => ({
      key: line.key,
      top: bandTop + step * index,
      height: DATE_LINE_HEIGHT,
      contentCenter: line.contentCenter,
    }));
  }
  return lines.map((line) => ({
    key: line.key,
    top: line.contentCenter * scale,
    height: DATE_LINE_HEIGHT,
    contentCenter: line.contentCenter,
  }));
}

function dateKey(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function useGalleryMetrics(ref: React.RefObject<HTMLElement | null>) {
  const [metrics, setMetrics] = useState({ width: 0, gap: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current; if (!element) return;
    const update = (measuredWidth: number, includesPadding: boolean) => {
      const style = getComputedStyle(element);
      const gap = cssLength(style.getPropertyValue("--gallery-gap"));
      const horizontalPadding = cssLength(style.paddingLeft) + cssLength(style.paddingRight);
      setMetrics({ width: Math.max(0, measuredWidth - (includesPadding ? horizontalPadding : 0)), gap, height: element.clientHeight });
    };
    update(element.clientWidth, true); if (!window.ResizeObserver) return;
    const observer = new ResizeObserver(([entry]) => entry ? update(entry.contentRect.width, false) : update(element.clientWidth, true)); observer.observe(element); return () => observer.disconnect();
  }, [ref]);
  return metrics;
}

function cssLength(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowMoveDelta(rows: ReturnType<typeof buildJustifiedRows<AssetSummary>>, gap: number, items: AssetSummary[], currentId: string, direction: 1 | -1): number {
  const currentIndex = items.findIndex((item) => item.id === currentId);
  if (currentIndex < 0) return 0;
  let currentRowIndex = -1;
  let currentColumn = -1;
  let flatOffset = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const column = row.items.findIndex((item) => item.id === currentId);
    if (column >= 0) {
      currentRowIndex = rowIndex;
      currentColumn = column;
      break;
    }
    flatOffset += row.items.length;
  }
  if (currentRowIndex < 0) return 0;
  const targetRowIndex = currentRowIndex + direction;
  if (targetRowIndex < 0 || targetRowIndex >= rows.length) return 0;
  const currentRow = rows[currentRowIndex];
  const targetRow = rows[targetRowIndex];
  const center = rowCenterX(currentRow, currentColumn, gap);
  const targetColumn = nearestColumn(center, targetRow, gap);
  const targetFlatOffset = targetRowIndex === 0 ? 0 : rows.slice(0, targetRowIndex).reduce((sum, row) => sum + row.items.length, 0);
  return targetFlatOffset + targetColumn - currentIndex;
}

function rowCenterX(row: { items: Array<{ width: number }> }, column: number, gap: number): number {
  let x = 0;
  for (let index = 0; index < column; index += 1) x += row.items[index].width + gap;
  return x + row.items[column].width / 2;
}

function nearestColumn(center: number, row: { items: Array<{ width: number }> }, gap: number): number {
  let bestColumn = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  let x = 0;
  row.items.forEach((item, column) => {
    const itemCenter = x + item.width / 2;
    const distance = Math.abs(itemCenter - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestColumn = column;
    }
    x += item.width + gap;
  });
  return bestColumn;
}
