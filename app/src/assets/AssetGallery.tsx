import { useVirtualizer } from "@tanstack/react-virtual";
import { PlusIcon } from "@heroicons/react/24/outline";
import { HeartIcon } from "@heroicons/react/24/solid";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AssetDateBucket, AssetSummary } from "../library/types";
import { assetDragIds, type InternalDragPayload } from "../shared/interaction/pointerDrag";
import type { SelectionGesture } from "./selection";
import { buildJustifiedRows, type JustifiedRow } from "./justifiedRows";
import { assetUrl, thumbnailUrl } from "./mediaUrl";
import { VideoTileMedia } from "../video/VideoTileMedia";
import "../styles/tokens.css";

const VIRTUAL_OVERSCAN_ROWS = 3;
const NEXT_PAGE_THRESHOLD_ROWS = 5;
const QUICK_PREVIEW_DELAY_MS = 150;
const QUICK_PREVIEW_GAP = 8;
const QUICK_PREVIEW_MARGIN = 12;

type QuickPreviewState = { asset: AssetSummary; anchor: DOMRect };

type GalleryJump = { date: string; ratio: number; token: number };

type AssetGalleryProps = {
  items: AssetSummary[];
  dateBuckets?: AssetDateBucket[];
  selectedAssetIds?: ReadonlySet<string>;
  focusAssetId?: string | null;
  targetRowHeight?: number;
  metadataVisible?: boolean;
  hasNextPage?: boolean;
  onLoadNextPage?: () => void;
  hasPreviousPage?: boolean;
  onLoadPrevPage?: () => void;
  jumpTarget?: GalleryJump | null;
  railInteractive?: boolean;
  onSelectionGesture?: (asset: AssetSummary, gesture: SelectionGesture) => void;
  onSelectAll?: () => void;
  onDeleteSelection?: () => void;
  onClearSelection?: () => void;
  onMoveFocus?: (delta: number, extend: boolean) => void;
  onOpen?: (asset: AssetSummary) => void;
  onRetryVideo?: (asset: AssetSummary) => void;
  onSelectDate?: (date: string, ratio: number) => void;
  onPointerDragStart?: (payload: InternalDragPayload, event: React.PointerEvent<HTMLElement>) => void;
  onPointerDragMove?: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerDragEnd?: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerDragCancel?: (event: React.PointerEvent<HTMLElement>) => void;
};

export function AssetGallery({ items, dateBuckets = [], selectedAssetIds = new Set(), focusAssetId = null, targetRowHeight = 180, metadataVisible = false, hasNextPage = false, onLoadNextPage, hasPreviousPage = false, onLoadPrevPage, jumpTarget = null, railInteractive = true, onSelectionGesture, onSelectAll, onDeleteSelection, onClearSelection, onMoveFocus, onOpen, onRetryVideo, onSelectDate, onPointerDragStart, onPointerDragMove, onPointerDragEnd, onPointerDragCancel }: AssetGalleryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusRequestedRef = useRef(false);
  const quickPreviewTimerRef = useRef<number | null>(null);
  const prependGuardRef = useRef({ pending: false, firstAssetId: null as string | null });
  const jumpedTokenRef = useRef<number | null>(null);
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const [quickPreview, setQuickPreview] = useState<QuickPreviewState | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [hoveredLine, setHoveredLine] = useState<{ key: string; index: number; top: number; label: string } | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [railExtent, setRailExtent] = useState(0);
  const { width, gap, height } = useGalleryMetrics(scrollRef);
  const rows = useMemo(() => buildJustifiedRows(items, width, targetRowHeight, gap), [gap, items, targetRowHeight, width]);
  const rowVirtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: (index) => rows[index]?.height ?? targetRowHeight, getItemKey: (index) => rows[index]?.items[0]?.id ?? index, gap, overscan: VIRTUAL_OVERSCAN_ROWS });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const rowOffsets = useMemo(() => {
    const offsets = new Float64Array(rows.length + 1);
    for (let index = 0; index < rows.length; index += 1) offsets[index + 1] = offsets[index] + rows[index].height + gap;
    return offsets;
  }, [gap, rows]);
  const totalSize = rows.length > 0 ? rowOffsets[rows.length] - gap : 0;
  const dateSummary = useMemo(() => dateBuckets.length > 0 ? buildDateSummaryFromBuckets(dateBuckets) : buildDateSummary(rows, gap, totalSize), [dateBuckets, gap, rows, totalSize]);
  const geometry = useMemo(() => railGeometry(dateSummary.length, railExtent), [dateSummary.length, railExtent]);
  const hasRail = dateSummary.length > 0;
  const centerRowIndex = useMemo(() => rows.length === 0 ? -1 : rowIndexAtOffset(rowOffsets, scrollTop + Math.max(1, height) / 2), [height, rowOffsets, rows.length, scrollTop]);
  const activeIndex = useMemo(() => {
    if (dateBuckets.length > 0) {
      const row = centerRowIndex >= 0 ? rows[centerRowIndex] : null;
      const centerItem = row?.items[Math.floor((row.items.length - 1) / 2)];
      const key = centerItem ? isoDayKey(centerItem.collectedAt) : null;
      if (!key) return null;
      const newer = newestBucketAtOrAfter(dateBuckets, key);
      return newer < 0 ? 0 : newer;
    }
    return findActiveIndex(scrollTop + height / 2, totalSize, dateSummary);
  }, [centerRowIndex, dateBuckets, dateSummary, height, rows, scrollTop, totalSize]);
  const activeIndicatorTop = useMemo(() => {
    if (!hasRail || geometry.extent <= 0 || dateBuckets.length < 2 || centerRowIndex < 0) return null;
    const row = rows[centerRowIndex];
    const centerItem = row.items[Math.floor((row.items.length - 1) / 2)];
    const key = isoDayKey(centerItem.collectedAt);
    if (!key) return null;
    const newer = newestBucketAtOrAfter(dateBuckets, key);
    let fraction: number;
    if (newer < 0) fraction = 0;
    else if (newer >= dateBuckets.length - 1) fraction = 1;
    else {
      const newerTime = Date.parse(`${dateBuckets[newer].date}T00:00:00Z`);
      const olderTime = Date.parse(`${dateBuckets[newer + 1].date}T00:00:00Z`);
      const keyTime = Date.parse(`${key}T00:00:00Z`);
      const span = olderTime - newerTime;
      const delta = span > 0 ? (keyTime - newerTime) / span : 0;
      fraction = (newer + Math.min(1, Math.max(0, delta))) / (dateBuckets.length - 1);
    }
    return RAIL_EDGE_INSET + fraction * (geometry.extent - RAIL_EDGE_INSET * 2);
  }, [centerRowIndex, dateBuckets, geometry.extent, hasRail, rows]);
  const tickIndexes = useMemo(() => selectTickIndexes(dateSummary, geometry.extent), [dateSummary, geometry.extent]);
  const dateLines = useMemo(() => buildDateLines(geometry, tickIndexes, dateSummary, activeIndex), [activeIndex, dateSummary, geometry, tickIndexes]);
  const cancelQuickPreview = () => {
    if (quickPreviewTimerRef.current !== null) window.clearTimeout(quickPreviewTimerRef.current);
    quickPreviewTimerRef.current = null;
    setQuickPreview(null);
  };
  const requestQuickPreview = (asset: AssetSummary, trigger: HTMLElement) => {
    const sourceAsset = items.find((item) => item.id === asset.id) ?? asset;
    if (quickPreviewTimerRef.current !== null) window.clearTimeout(quickPreviewTimerRef.current);
    quickPreviewTimerRef.current = window.setTimeout(() => {
      setQuickPreview({ asset: sourceAsset, anchor: trigger.getBoundingClientRect() });
      quickPreviewTimerRef.current = null;
    }, QUICK_PREVIEW_DELAY_MS);
  };
  const lastJumpEmitRef = useRef(0);
  const pendingJumpTimerRef = useRef<number | null>(null);
  const latestJumpRef = useRef<{ date: string; ratio: number } | null>(null);
  const flushDateJump = () => {
    pendingJumpTimerRef.current = null;
    const jump = latestJumpRef.current; if (!jump || !onSelectDate) return;
    lastJumpEmitRef.current = Date.now();
    onSelectDate(jump.date, jump.ratio);
  };
  const emitDateJump = (date: string, ratio: number) => {
    if (!onSelectDate) return;
    latestJumpRef.current = { date, ratio };
    const elapsed = Date.now() - lastJumpEmitRef.current;
    if (elapsed >= JUMP_EMIT_INTERVAL_MS) {
      if (pendingJumpTimerRef.current !== null) { window.clearTimeout(pendingJumpTimerRef.current); pendingJumpTimerRef.current = null; }
      flushDateJump();
    } else if (pendingJumpTimerRef.current === null) {
      pendingJumpTimerRef.current = window.setTimeout(flushDateJump, JUMP_EMIT_INTERVAL_MS - elapsed);
    }
  };
  useEffect(() => () => {
    if (pendingJumpTimerRef.current !== null) window.clearTimeout(pendingJumpTimerRef.current);
  }, []);
  const scrollToPointer = (clientY: number) => {
    if (!railInteractive) return;
    const element = scrollRef.current;
    const rail = railRef.current; if (!element) return;
    if (dateBuckets.length === 0) {
      const rect = element.getBoundingClientRect();
      if (rect.height <= 0) return;
      element.scrollTop = ((clientY - rect.top) / rect.height) * (element.scrollHeight - element.clientHeight);
      return;
    }
    if (!rail || railExtent <= 0) return;
    const progress = railProgressFromEvent(rail, clientY, railExtent);
    if (progress == null) return;
    const bucketIndex = dateBuckets.length <= 1 ? 0 : Math.round(progress * (dateBuckets.length - 1));
    const date = dateBuckets[bucketIndex]?.date;
    if (date) emitDateJump(date, progress);
  };
  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1];
    if (hasNextPage && onLoadNextPage && last && last.index >= rows.length - NEXT_PAGE_THRESHOLD_ROWS) onLoadNextPage();
  }, [hasNextPage, onLoadNextPage, rows.length, virtualRows]);
  useEffect(() => {
    const first = virtualRows[0];
    if (hasPreviousPage && onLoadPrevPage && first && first.index < NEXT_PAGE_THRESHOLD_ROWS) {
      prependGuardRef.current.pending = true;
      onLoadPrevPage();
    }
  }, [hasPreviousPage, onLoadPrevPage, virtualRows]);
  useEffect(() => {
    const element = railRef.current; if (!element) return;
    const update = () => setRailExtent(element.clientHeight);
    update();
    if (!window.ResizeObserver) return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasRail]);
  useEffect(() => () => {
    if (quickPreviewTimerRef.current !== null) window.clearTimeout(quickPreviewTimerRef.current);
  }, []);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const guard = prependGuardRef.current;
    if (element && guard.pending && guard.firstAssetId) {
      const oldIndex = items.findIndex((item) => item.id === guard.firstAssetId);
      if (oldIndex > 0) {
        let rowIndex = 0;
        let flat = 0;
        while (rowIndex < rows.length && flat + rows[rowIndex].items.length <= oldIndex) {
          flat += rows[rowIndex].items.length;
          rowIndex += 1;
        }
        let insertedHeight = 0;
        for (let index = 0; index < rowIndex; index += 1) insertedHeight += rows[index].height + gap;
        element.scrollTop += insertedHeight;
        setScrollTop(element.scrollTop);
      }
    }
    guard.pending = false;
    guard.firstAssetId = items[0]?.id ?? null;
  }, [gap, items, rows]);
  useLayoutEffect(() => {
    if (!jumpTarget || jumpedTokenRef.current === jumpTarget.token) return;
    const rowIndex = findRowIndexOfDate(rows, jumpTarget.date);
    if (rowIndex < 0) return;
    jumpedTokenRef.current = jumpTarget.token;
    const element = scrollRef.current; if (!element) return;
    let rowStart = 0;
    for (let index = 0; index < rowIndex; index += 1) rowStart += rows[index].height + gap;
    const viewport = element.clientHeight || height;
    const ratio = Math.max(0, Math.min(1, jumpTarget.ratio));
    const desired = rowStart + rows[rowIndex].height / 2 - ratio * viewport;
    element.scrollTop = Math.max(0, Math.min(element.scrollHeight - viewport, desired));
    setScrollTop(element.scrollTop);
  }, [gap, height, jumpTarget, rows]);
  useLayoutEffect(() => {
    if (scrollRef.current && scrollRef.current.scrollTop !== scrollTop) {
      setScrollTop(scrollRef.current.scrollTop);
    }
  }, [height, items]);
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
    {hasRail && <div ref={railRef} className="asset-gallery__scrollbar" aria-hidden="true" onPointerDown={(event) => { if (event.button === 0) { event.currentTarget.setPointerCapture(event.pointerId); scrollToPointer(event.clientY); } }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) scrollToPointer(event.clientY); }} onPointerLeave={() => setHoveredLine(null)} onWheel={(event) => { const element = scrollRef.current; if (!element || dateBuckets.length === 0) return; element.scrollTop += event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY; }}>
      {dateLines.map((line, index) => (
        <span
          key={line.key}
          className={lineClassName(hoveredLine, index, line)}
          style={{ top: `${line.top}px` }}
          onPointerEnter={() => setHoveredLine({ key: line.key, index, top: line.top, label: line.label })}
          onPointerLeave={() => setHoveredLine((current) => current?.key === line.key ? null : current)}
          onPointerDown={(event) => { if (event.button === 0 && railInteractive) { event.stopPropagation(); emitDateJump(line.key, line.progress); } }}
        />
      ))}
      {hoveredLine && <span className="asset-gallery__scrollbar-label" style={{ top: `${hoveredLine.top}px` }}>{hoveredLine.label}</span>}
      {activeIndicatorTop != null && <span className="asset-gallery__scrollbar-indicator" style={{ transform: `translateY(${activeIndicatorTop}px)` }} />}
    </div>}
    {quickPreview && <div className="asset-gallery__quick-preview" style={quickPreviewLayout(quickPreview)}><img src={assetUrl(quickPreview.asset.id)} alt={`${quickPreview.asset.title || quickPreview.asset.originalName} 빠른 미리보기`} draggable={false} onError={cancelQuickPreview} /></div>}
  </div>;
}

function AssetTile({ asset, height, selected, selectedAssetIds, focused, metadataVisible, activePreview, onRequestPreview, onReleasePreview, onRequestQuickPreview, onCancelQuickPreview, onRetryVideo, onSelectionGesture, onOpen, onPointerDragStart, onPointerDragMove, onPointerDragEnd, onPointerDragCancel }: { asset: AssetSummary; height: number; selected: boolean; selectedAssetIds: ReadonlySet<string>; focused: boolean; metadataVisible: boolean; activePreview: boolean; onRequestPreview(): void; onReleasePreview(): void; onRequestQuickPreview(asset: AssetSummary, trigger: HTMLElement): void; onCancelQuickPreview(): void; onRetryVideo?: AssetGalleryProps["onRetryVideo"]; onSelectionGesture?: (asset: AssetSummary, gesture: SelectionGesture) => void; onOpen?: (asset: AssetSummary) => void; onPointerDragStart?: AssetGalleryProps["onPointerDragStart"]; onPointerDragMove?: AssetGalleryProps["onPointerDragMove"]; onPointerDragEnd?: AssetGalleryProps["onPointerDragEnd"]; onPointerDragCancel?: AssetGalleryProps["onPointerDragCancel"] }) {
  const alt = asset.title || asset.originalName;
  return <div role="option" data-asset-id={asset.id} className="asset-gallery__asset" style={{ width: asset.width, height }} aria-label={alt} aria-selected={selected} tabIndex={focused ? 0 : -1} onClick={(event) => onSelectionGesture?.(asset, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey })} onDoubleClick={() => onOpen?.(asset)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onOpen?.(asset); } }} onPointerDown={(event) => { if (event.button === 0) onPointerDragStart?.({ kind: "assets", assetIds: assetDragIds(asset.id, selectedAssetIds) }, event); }} onPointerMove={onPointerDragMove} onPointerUp={onPointerDragEnd} onPointerCancel={onPointerDragCancel}>
    {asset.media.kind === "video" ? <VideoTileMedia asset={asset as AssetSummary & { media: Extract<AssetSummary["media"], { kind: "video" }> }} active={activePreview} onRequestActive={onRequestPreview} onReleaseActive={onReleasePreview} onRetry={() => onRetryVideo?.(asset)} /> : <img src={thumbnailUrl(asset.id)} alt={alt} width={asset.width} height={asset.height} loading="lazy" draggable={false} />}
    {asset.favorite && <span className="asset-gallery__favorite" aria-hidden="true"><HeartIcon /></span>}
    {metadataVisible && <span className="asset-gallery__metadata"><span>{sourceHost(asset.sourceUrl)}</span><span>{localDate(asset.collectedAt)}</span></span>}
    {asset.media.kind === "image" && <button type="button" className="asset-gallery__quick-preview-trigger" aria-label={`${alt} 빠른 확대 미리보기`} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onPointerEnter={(event) => onRequestQuickPreview(asset, event.currentTarget)} onPointerLeave={onCancelQuickPreview} onFocus={(event) => onRequestQuickPreview(asset, event.currentTarget)} onBlur={onCancelQuickPreview} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); onCancelQuickPreview(); } }}><PlusIcon aria-hidden="true" /></button>}
  </div>;
}

function sourceHost(sourceUrl: string | null) { if (!sourceUrl) return null; try { return new URL(sourceUrl).hostname || null; } catch { return null; } }
function localDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString(); }

type DateSpan = { key: string; label: string; count: number; min: number; max: number };
type DateLine = { key: string; top: number; progress: number; label: string; isMajor: boolean; isActive: boolean; density: number };
type RailGeometry = { start: number; extent: number };

const RAIL_MIN_TICK_GAP = 8;
const RAIL_EDGE_INSET = 4;
const JUMP_EMIT_INTERVAL_MS = 160;

function buildDateSummaryFromBuckets(buckets: AssetDateBucket[]): DateSpan[] {
  if (buckets.length === 0) return [];
  const count = buckets.length;
  return buckets.map((bucket, index) => {
    const ratio = count <= 1 ? 0 : index / (count - 1);
    const key = bucket.date;
    return { key, label: dateLabel(key), count: bucket.count, min: ratio, max: ratio };
  });
}

function buildDateSummary(rows: JustifiedRow<AssetSummary>[], gap: number, totalSize: number): DateSpan[] {
  if (totalSize <= 0 || rows.length === 0) return [];
  const byDate = new Map<string, { label: string; count: number; min: number; max: number }>();
  let offset = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const center = offset + row.height / 2;
    for (const item of row.items) {
      const key = dateKey(item.collectedAt);
      if (!key) continue;
      const span = byDate.get(key);
      if (span) {
        span.count += 1;
        if (center < span.min) span.min = center;
        if (center > span.max) span.max = center;
      } else {
        byDate.set(key, { label: dateLabel(key), count: 1, min: center, max: center });
      }
    }
    offset += row.height + (index < rows.length - 1 ? gap : 0);
  }
  return [...byDate.entries()].map(([key, span]) => ({ key, label: span.label, count: span.count, min: span.min / totalSize, max: span.max / totalSize })).sort((left, right) => left.min - right.min);
}

function railGeometry(bucketCount: number, availableExtent: number): RailGeometry {
  const safeExtent = Math.max(0, availableExtent);
  if (bucketCount <= 1 || safeExtent === 0) return { start: 0, extent: 0 };
  return { start: 0, extent: safeExtent };
}

function nearestBucketIndex(contentCenter: number, totalSize: number, dateSummary: DateSpan[]): number {
  if (dateSummary.length <= 1 || totalSize <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, contentCenter / totalSize));
  let low = 0;
  let high = dateSummary.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if ((dateSummary[mid].min + dateSummary[mid].max) / 2 / totalSize <= ratio) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

function findActiveIndex(contentCenter: number, totalSize: number, dateSummary: DateSpan[]): number | null {
  if (dateSummary.length === 0) return null;
  return nearestBucketIndex(contentCenter, totalSize, dateSummary);
}

function rowIndexAtOffset(offsets: Float64Array, offset: number): number {
  if (offsets.length <= 1) return 0;
  let low = 0;
  let high = offsets.length - 2;
  let index = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] <= offset) {
      index = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return index;
}

function railProgressFromEvent(rail: HTMLElement, clientY: number, extent: number): number | null {
  if (extent <= RAIL_EDGE_INSET * 2) return null;
  const rect = rail.getBoundingClientRect();
  if (rect.height <= RAIL_EDGE_INSET * 2) return null;
  return Math.max(0, Math.min(1, (clientY - rect.top - RAIL_EDGE_INSET) / (rect.height - RAIL_EDGE_INSET * 2)));
}

function newestBucketAtOrAfter(buckets: AssetDateBucket[], key: string): number {
  let low = 0;
  let high = buckets.length - 1;
  let newer = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (buckets[mid].date >= key) {
      newer = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return newer;
}

function selectTickIndexes(dateSummary: DateSpan[], extent: number): number[] {
  const count = dateSummary.length;
  if (count === 0) return [];
  const capacity = Math.max(2, Math.floor(extent / RAIL_MIN_TICK_GAP) + 1);
  if (count <= capacity) return Array.from({ length: count }, (_, index) => index);

  const mandatory = new Set([0, count - 1]);
  for (let index = 1; index < count; index += 1) {
    const previous = dateSummary[index - 1].key.split("-").map(Number);
    const current = dateSummary[index].key.split("-").map(Number);
    if (previous[0] !== current[0] || previous[1] !== current[1]) mandatory.add(index);
  }

  const selected = new Set(mandatory.size <= capacity ? mandatory : evenlySample([...mandatory].sort((a, b) => a - b), capacity));
  while (selected.size < capacity) {
    const ordered = [...selected].sort((a, b) => a - b);
    let largestGap = 0;
    let midpoint = -1;
    for (let index = 1; index < ordered.length; index += 1) {
      const gap = ordered[index] - ordered[index - 1];
      if (gap > largestGap) {
        largestGap = gap;
        midpoint = ordered[index - 1] + Math.floor(gap / 2);
      }
    }
    if (largestGap <= 1 || midpoint < 0) break;
    selected.add(midpoint);
  }

  return [...selected].sort((a, b) => a - b);
}

function evenlySample(indexes: number[], count: number): number[] {
  if (indexes.length <= count) return indexes;
  return Array.from({ length: count }, (_, slot) => indexes[Math.round((slot * (indexes.length - 1)) / (count - 1))]);
}

function buildDateLines(geometry: RailGeometry, tickIndexes: number[], dateSummary: DateSpan[], activeIndex: number | null): DateLine[] {
  if (geometry.extent <= 0 || tickIndexes.length === 0) return [];
  const usable = Math.max(0, geometry.extent - RAIL_EDGE_INSET * 2);
  const maxCount = Math.max(1, ...dateSummary.map((span) => span.count));
  return tickIndexes.map((index) => {
    const span = dateSummary[index];
    const previous = index === 0 ? null : dateSummary[index - 1];
    const currentParts = span.key.split("-").map(Number);
    const previousParts = previous?.key.split("-").map(Number);
    const isMajor = index === 0 || !previousParts || previousParts[0] !== currentParts[0] || previousParts[1] !== currentParts[1];
    const density = span.count / maxCount;
    const progress = dateSummary.length <= 1 ? 0 : index / (dateSummary.length - 1);
    return {
      key: span.key,
      top: geometry.start + RAIL_EDGE_INSET + progress * usable,
      progress,
      label: dateLabelText(span.label, span.count),
      isMajor,
      isActive: activeIndex === index,
      density,
    };
  });
}

function lineClassName(hoveredLine: { key: string; index: number } | null, lineIndex: number, line: DateLine): string {
  const base = "asset-gallery__scrollbar-line";
  const classes = [base];
  if (line.density >= 0.75) classes.push(`${base}--dense`);
  else if (line.density >= 0.35) classes.push(`${base}--medium`);
  if (line.isMajor) classes.push(`${base}--major`);
  if (hoveredLine?.key === line.key) {
    classes.push(`${base}--hovered`);
  } else if (hoveredLine != null) {
    const distance = Math.abs(hoveredLine.index - lineIndex);
    if (distance === 1) classes.push(`${base}--nearby-1`);
    else if (distance === 2) classes.push(`${base}--nearby-2`);
    else if (line.isActive) classes.push(`${base}--active`);
  } else if (line.isActive) {
    classes.push(`${base}--active`);
  }
  return classes.join(" ");
}

function dateKey(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function isoDayKey(value: string): string | null {
  const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
  return match ? match[0] : null;
}

function findRowIndexOfDate(rows: JustifiedRow<AssetSummary>[], date: string): number {
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].items.some((item) => isoDayKey(item.collectedAt) === date)) return index;
  }
  return -1;
}

function dateLabel(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  if (!year || !month || !day) return key;
  return `${year}. ${String(month).padStart(2, "0")}. ${String(day).padStart(2, "0")}`;
}

function dateLabelText(label: string, count: number): string {
  return `${label} · ${count.toLocaleString("ko-KR")}개`;
}

const METRICS_QUANTIZE = 16;

function useGalleryMetrics(ref: React.RefObject<HTMLElement | null>) {
  const [metrics, setMetrics] = useState({ width: 0, gap: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current; if (!element) return;
    const update = (measuredWidth: number, measuredHeight: number, includesPadding: boolean) => {
      const style = getComputedStyle(element);
      const gap = cssLength(style.getPropertyValue("--gallery-gap"));
      const horizontalPadding = cssLength(style.paddingLeft) + cssLength(style.paddingRight);
      setMetrics((current) => {
        const nextWidth = measuredWidth > 0 ? Math.max(0, measuredWidth - (includesPadding ? horizontalPadding : 0)) : current.width;
        const nextHeight = measuredHeight > 0 ? measuredHeight : current.height;
        const quantizedWidth = Math.round(nextWidth / METRICS_QUANTIZE) * METRICS_QUANTIZE;
        const quantizedHeight = Math.round(nextHeight / METRICS_QUANTIZE) * METRICS_QUANTIZE;
        if (quantizedWidth === current.width && quantizedHeight === current.height && gap === current.gap) return current;
        return { width: quantizedWidth, gap, height: quantizedHeight };
      });
    };
    update(element.clientWidth, element.clientHeight, true); if (!window.ResizeObserver) return;
    const observer = new ResizeObserver(([entry]) => entry ? update(entry.contentRect.width, entry.contentRect.height, false) : update(element.clientWidth, element.clientHeight, true)); observer.observe(element); return () => observer.disconnect();
  }, [ref]);
  return metrics;
}

function cssLength(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function quickPreviewLayout({ asset, anchor }: QuickPreviewState): React.CSSProperties {
  const maxWidth = window.innerWidth * 0.55;
  const maxHeight = window.innerHeight * 0.7;
  const sourceWidth = Math.max(1, asset.width);
  const sourceHeight = Math.max(1, asset.height);
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  const preferredRight = anchor.right + QUICK_PREVIEW_GAP;
  const left = preferredRight + width + QUICK_PREVIEW_MARGIN <= window.innerWidth
    ? preferredRight
    : Math.max(QUICK_PREVIEW_MARGIN, anchor.left - QUICK_PREVIEW_GAP - width);
  const top = Math.min(
    window.innerHeight - QUICK_PREVIEW_MARGIN - height,
    Math.max(QUICK_PREVIEW_MARGIN, anchor.top + anchor.height / 2 - height / 2),
  );
  return { left, top, width, height };
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
