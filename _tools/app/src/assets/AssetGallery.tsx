import { useVirtualizer } from "@tanstack/react-virtual";
import { MagnifyingGlassPlusIcon } from "@heroicons/react/24/outline";
import { HeartIcon } from "@heroicons/react/24/solid";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AssetSummary } from "../library/types";
import { assetDragIds, type InternalDragPayload } from "../shared/interaction/pointerDrag";
import { Skeleton } from "../shared/ui/Skeleton";
import type { SelectionGesture } from "./selection";
import { buildJustifiedRows } from "./justifiedRows";
import { buildMasonryLayout, collectedDate, masonryMove, CAPTION_HEIGHT, type GalleryLayout } from "./masonryLayout";
import { assetUrl, thumbnailUrl } from "./mediaUrl";
import { AssetGalleryScrollbar } from "./AssetGalleryScrollbar";
import { VideoTileMedia } from "../video/VideoTileMedia";
import "../styles/tokens.css";

const VIRTUAL_OVERSCAN_ROWS = 3;
const NEXT_PAGE_THRESHOLD_ROWS = 5;
const NEXT_PAGE_PREFETCH_VIEWPORTS = 1.5;
const QUICK_PREVIEW_DELAY_MS = 150;
const QUICK_PREVIEW_GAP = 8;
const QUICK_PREVIEW_MARGIN = 12;

type QuickPreviewState = { asset: AssetSummary; anchor: DOMRect; boundary: DOMRect | null };

type AssetGalleryProps = {
  intro?: ReactNode;
  items: AssetSummary[];
  layout?: GalleryLayout;
  groupDates?: boolean;
  scopeKey?: string;
  totalCount?: number | null;
  selectedAssetIds?: ReadonlySet<string>;
  focusAssetId?: string | null;
  targetRowHeight?: number;
  metadataVisible?: boolean;
  privacyMode?: boolean;
  hasNextPage?: boolean;
  onLoadNextPage?: () => void;
  hasPreviousPage?: boolean;
  onLoadPrevPage?: () => void;
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
export function AssetGallery({ intro, items, layout = "justified", groupDates = true, scopeKey, totalCount = null, selectedAssetIds = new Set(), focusAssetId = null, targetRowHeight = 180, metadataVisible = false, privacyMode = false, hasNextPage = false, onLoadNextPage, hasPreviousPage = false, onLoadPrevPage, onSelectionGesture, onSelectAll, onDeleteSelection, onClearSelection, onMoveFocus, onOpen, onRetryVideo, onPointerDragStart, onPointerDragMove, onPointerDragEnd, onPointerDragCancel }: AssetGalleryProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const introRef = useRef<HTMLDivElement>(null);
  const [introHeight, setIntroHeight] = useState(0);
  useLayoutEffect(() => {
    const element = introRef.current;
    if (!element) { setIntroHeight(0); return; }
    const measure = () => setIntroHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [Boolean(intro)]);
  const focusRequestedRef = useRef(false);
  const quickPreviewTimerRef = useRef<number | null>(null);
  const quickPreviewRequestRef = useRef(0);
  const prependGuardRef = useRef({ pending: false, firstAssetId: null as string | null });
  const [activePreviewId, setActivePreviewId] = useState<string | null>(null);
  const [quickPreview, setQuickPreview] = useState<QuickPreviewState | null>(null);
  const { width, gap, height: viewportHeight } = useGalleryMetrics(scrollRef, layout);
  const [scrollTop, setScrollTop] = useState(0);
  const masonry = useMemo(() => buildMasonryLayout(layout === "masonry" ? items : [], width, targetRowHeight, gap, metadataVisible, groupDates), [layout, items, width, targetRowHeight, gap, metadataVisible, groupDates]);
  const rows = useMemo(() => buildJustifiedRows(layout === "justified" ? items : [], width, targetRowHeight, gap), [layout, gap, items, targetRowHeight, width]);
  const rowVirtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: (index) => rows[index]?.height ?? targetRowHeight, getItemKey: (index) => rows[index]?.items[0]?.id ?? index, gap, scrollMargin: introHeight, overscan: VIRTUAL_OVERSCAN_ROWS });
  const lastScopeKeyRef = useRef<string | null>(scopeKey ?? null);
  const scrollMemoryRef = useRef(new Map<string, number>());
  const pendingRestoreRef = useRef<{ scopeKey: string | null; offset: number } | null>(null);
  useLayoutEffect(() => {
    const currentScopeKey = scopeKey ?? null;
    if (lastScopeKeyRef.current === currentScopeKey) return;
    const previousScopeKey = lastScopeKeyRef.current;
    const element = scrollRef.current;
    if (previousScopeKey !== null && element) scrollMemoryRef.current.set(previousScopeKey, element.scrollTop);
    lastScopeKeyRef.current = currentScopeKey;
    if (!element) return;
    const remembered = currentScopeKey !== null ? scrollMemoryRef.current.get(currentScopeKey) ?? 0 : 0;
    element.scrollTop = remembered;
    pendingRestoreRef.current = remembered > 0 ? { scopeKey: currentScopeKey, offset: remembered } : null;
    rowVirtualizer.measure();
    rowVirtualizer.scrollToOffset(0);
    if (remembered > 0) element.scrollTop = remembered;
  }, [scopeKey, rowVirtualizer]);
  const virtualRows = rowVirtualizer.getVirtualItems();
  const layoutUnits = layout === "masonry" ? masonry.tiles.length : rows.length;
  const measuredTotal = layout === "masonry" ? masonry.height : rowVirtualizer.getTotalSize();
  const previousMasonryRef = useRef({ masonry, scopeKey, layout });
  useLayoutEffect(() => {
    const previous = previousMasonryRef.current;
    const element = scrollRef.current;
    if (element && layout === "masonry" && previous.layout === layout && previous.scopeKey === scopeKey && previous.masonry !== masonry) {
      const anchor = previous.masonry.tiles.find((tile) => tile.top + tile.height > element.scrollTop - introHeight);
      const next = anchor && masonry.tiles.find((tile) => tile.asset.id === anchor.asset.id);
      if (anchor && next) element.scrollTop += next.top - anchor.top;
    }
    previousMasonryRef.current = { masonry, scopeKey, layout };
    if (element) setScrollTop(Math.max(0, element.scrollTop - introHeight));
  }, [masonry, scopeKey, layout, introHeight]);
  // Freeze the estimation base on the first measured rows so appended pages
  // never shift the reserved range (which would yank the scrollbar thumb).
  // The base is scoped: a new scope re-samples instead of reusing stale
  // aspect data. The estimate changes only when the backend total changes.
  const [estimateBase, setEstimateBase] = useState<{
    scopeKey: string | null;
    geometryKey: string;
    avgItemsPerRow: number;
    avgRowHeight: number;
  } | null>(null);
  const geometryKey = `${layout}:${width}:${targetRowHeight}:${metadataVisible}`;
  useLayoutEffect(() => {
    const currentScopeKey = scopeKey ?? null;
    if (layoutUnits === 0) {
      if (estimateBase) setEstimateBase(null);
    } else if (
      (!estimateBase || estimateBase.scopeKey !== currentScopeKey || estimateBase.geometryKey !== geometryKey) &&
      measuredTotal > 0 &&
      items.length > 0
    ) {
      setEstimateBase({
        scopeKey: currentScopeKey,
        geometryKey,
        avgItemsPerRow: items.length / layoutUnits,
        avgRowHeight: measuredTotal / layoutUnits,
      });
    }
  }, [estimateBase, items.length, measuredTotal, layoutUnits, scopeKey, geometryKey]);
  // Reserve the full filtered range up front so appended pages stop growing
  // the scroll range (which yanks the scrollbar thumb upward mid-drag).
  // Once everything is loaded the measured size is exact again.
  let reservedTotal = measuredTotal;
  if (
    hasNextPage &&
    totalCount != null &&
    Number.isFinite(totalCount) &&
    totalCount >= 0 &&
    estimateBase
  ) {
    reservedTotal = Math.max(
      measuredTotal,
      Math.ceil(totalCount / estimateBase.avgItemsPerRow) * estimateBase.avgRowHeight,
    );
  }
  useLayoutEffect(() => {
    const pending = pendingRestoreRef.current;
    if (!pending || pending.scopeKey !== scopeKey || layoutUnits === 0) return;
    const element = scrollRef.current;
    if (!element) return;
    if (element.scrollTop < pending.offset - 1) {
      element.scrollTop = pending.offset;
      // Still clamped (range not reserved yet): keep pending and retry when
      // rows or the reserved total grow instead of losing the position.
      if (element.scrollTop < pending.offset - 1) return;
    }
    pendingRestoreRef.current = null;
  }, [layoutUnits, scopeKey, reservedTotal]);
  const cancelQuickPreview = () => {
    quickPreviewRequestRef.current += 1;
    if (quickPreviewTimerRef.current !== null) window.clearTimeout(quickPreviewTimerRef.current);
    quickPreviewTimerRef.current = null;
    setQuickPreview(null);
  };
  const requestQuickPreview = (asset: AssetSummary, trigger: HTMLElement) => {
    const request = ++quickPreviewRequestRef.current;
    const sourceAsset = items.find((item) => item.id === asset.id) ?? asset;
    if (quickPreviewTimerRef.current !== null) window.clearTimeout(quickPreviewTimerRef.current);
    quickPreviewTimerRef.current = window.setTimeout(() => {
      quickPreviewTimerRef.current = null;
      const preview = new Image();
      const reveal = () => {
        if (request === quickPreviewRequestRef.current) {
          setQuickPreview({
            asset: sourceAsset,
            anchor: trigger.getBoundingClientRect(),
            boundary: trigger.closest<HTMLElement>(".asset-gallery")?.getBoundingClientRect() ?? null,
          });
        }
      };
      preview.src = assetUrl(sourceAsset.id);
      if (typeof preview.decode === "function") void preview.decode().then(reveal, () => undefined);
      else reveal();
    }, QUICK_PREVIEW_DELAY_MS);
  };
  useEffect(() => {
    if (!hasNextPage || !onLoadNextPage || layoutUnits === 0) return;
    const last = virtualRows[virtualRows.length - 1];
    if (layout === "justified" && last && last.index >= rows.length - NEXT_PAGE_THRESHOLD_ROWS) {
      onLoadNextPage();
      return;
    }
    const element = scrollRef.current;
    if (element && element.clientHeight > 0
      && measuredTotal + introHeight - (element.scrollTop + element.clientHeight)
        <= element.clientHeight * NEXT_PAGE_PREFETCH_VIEWPORTS) {
      onLoadNextPage();
    }
  }, [hasNextPage, onLoadNextPage, rows.length, layoutUnits, virtualRows, measuredTotal, layout, scrollTop, introHeight]);
  useEffect(() => {
    const first = virtualRows[0];
    if (hasPreviousPage && onLoadPrevPage && (layout === "masonry" ? scrollTop < 500 : first && first.index < NEXT_PAGE_THRESHOLD_ROWS)) {
      prependGuardRef.current.pending = true;
      onLoadPrevPage();
    }
  }, [hasPreviousPage, onLoadPrevPage, virtualRows, layout, scrollTop]);
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
        if (layout !== "masonry") element.scrollTop += insertedHeight;
      }
    }
    guard.pending = false;
    guard.firstAssetId = items[0]?.id ?? null;
  }, [gap, items, rows, layout]);
  useLayoutEffect(() => {
    if (!focusRequestedRef.current || !focusAssetId) return;
    const tile = layout === "masonry" ? masonry.tiles.find((entry) => entry.asset.id === focusAssetId) : null;
    const element = scrollRef.current;
    if (tile && element && (tile.top + introHeight < element.scrollTop || tile.top + introHeight + tile.height > element.scrollTop + viewportHeight)) {
      element.scrollTop = introHeight + (tile.top + introHeight < element.scrollTop ? tile.top : Math.max(tile.top, tile.top + tile.height - viewportHeight));
      setScrollTop(Math.max(0, element.scrollTop - introHeight));
    }
    [...(scrollRef.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])]
      .find((element) => element.dataset.assetId === focusAssetId)
      ?.focus();
    if ([...(scrollRef.current?.querySelectorAll<HTMLElement>("[data-asset-id]") ?? [])].some((entry) => entry.dataset.assetId === focusAssetId)) focusRequestedRef.current = false;
  }, [focusAssetId, scrollTop, layout, masonry, viewportHeight, introHeight]);
  return <div className={`asset-gallery asset-gallery--${layout}`}>
    <div
      ref={scrollRef}
      className="asset-gallery__scroll"
      data-native-scrollbar="true"
      role={intro ? undefined : "listbox"}
      aria-label={intro ? undefined : "자산"}
      aria-multiselectable={intro ? undefined : true}
      onScroll={(event) => {
        cancelQuickPreview();
        if (layoutUnits === 0) return;
        const element = event.currentTarget;
        if (layout === "masonry") setScrollTop(Math.max(0, element.scrollTop - introHeight));
        if (hasNextPage && onLoadNextPage && element.clientHeight > 0
          && measuredTotal + introHeight - (element.scrollTop + element.clientHeight)
            <= element.clientHeight * NEXT_PAGE_PREFETCH_VIEWPORTS) {
          onLoadNextPage();
        }
      }}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        const surface = event.currentTarget;
        const bounds = surface.getBoundingClientRect();
        const clickedVerticalScrollbar = target === surface
          && surface.offsetWidth > surface.clientWidth
          && event.clientX >= bounds.left + surface.clientWidth;
        const clickedHorizontalScrollbar = target === surface
          && surface.offsetHeight > surface.clientHeight
          && event.clientY >= bounds.top + surface.clientHeight;
        if (clickedVerticalScrollbar || clickedHorizontalScrollbar) return;
        if (!target.closest(".asset-gallery__asset, button, a, input, select, textarea, [contenteditable='true']")) onClearSelection?.();
      }}
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
              const delta = layout === "masonry" ? masonryMove(masonry.tiles, focusAssetId, event.key === "ArrowDown" ? 1 : -1) : rowMoveDelta(rows, gap, items, focusAssetId, event.key === "ArrowDown" ? 1 : -1);
              if (delta !== 0) onMoveFocus?.(delta, event.shiftKey);
            }
          } else {
            onMoveFocus?.(event.key === "ArrowRight" ? 1 : -1, event.shiftKey);
          }
        }
      }}
    >
      {intro && <div ref={introRef} className="asset-gallery__intro" onKeyDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>{intro}</div>}
      <div className="asset-gallery__virtual-space" role={intro ? "listbox" : undefined} aria-label={intro ? "자산" : undefined} aria-multiselectable={intro ? true : undefined} style={{ height: reservedTotal }}>
        {layout === "masonry" && masonry.headings.filter((heading) => heading.top >= scrollTop - 500 && heading.top < scrollTop + viewportHeight + 500).map((heading) => <div key={heading.key} className="asset-gallery__date" role="presentation" style={{ left: heading.left, width: heading.width, transform: `translateY(${heading.top}px)` }}>{heading.label}</div>)}
        {layout === "masonry" && masonry.tiles.filter((tile) => tile.top + tile.height >= scrollTop - 400 && tile.top < scrollTop + viewportHeight + 400).map((tile) => <div key={tile.asset.id} className="asset-gallery__masonry-cell" style={{ left: tile.left, top: tile.top, width: tile.width, height: tile.height }}>
          <AssetTile asset={{ ...tile.asset, width: tile.width }} height={tile.imageHeight} captionBelow selected={selectedAssetIds.has(tile.asset.id)} selectedAssetIds={selectedAssetIds} focused={focusAssetId ? focusAssetId === tile.asset.id : tile.index === 0} metadataVisible={metadataVisible} privacyMode={privacyMode} activePreview={activePreviewId === tile.asset.id} onRequestPreview={() => setActivePreviewId(tile.asset.id)} onReleasePreview={() => setActivePreviewId((current) => current === tile.asset.id ? null : current)} onRequestQuickPreview={requestQuickPreview} onCancelQuickPreview={cancelQuickPreview} onRetryVideo={onRetryVideo} onSelectionGesture={onSelectionGesture} onOpen={onOpen} onPointerDragStart={onPointerDragStart} onPointerDragMove={onPointerDragMove} onPointerDragEnd={onPointerDragEnd} onPointerDragCancel={onPointerDragCancel} />
        </div>)}
        {layout === "justified" && virtualRows.map((virtualRow) => {
          const row = rows[virtualRow.index]; if (!row) return null;
          return <div key={virtualRow.key} className="asset-gallery__row" style={{ gap, height: row.height + gap, backgroundColor: "var(--color-bg)", transform: `translateY(${virtualRow.start - introHeight}px)` }}>
            {row.items.map((asset, index) => <AssetTile key={asset.id} asset={asset} height={row.height} selected={selectedAssetIds.has(asset.id)} selectedAssetIds={selectedAssetIds} focused={focusAssetId ? focusAssetId === asset.id : virtualRow.index === 0 && index === 0} metadataVisible={metadataVisible} privacyMode={privacyMode} activePreview={activePreviewId === asset.id} onRequestPreview={() => setActivePreviewId(asset.id)} onReleasePreview={() => setActivePreviewId((current) => current === asset.id ? null : current)} onRequestQuickPreview={requestQuickPreview} onCancelQuickPreview={cancelQuickPreview} onRetryVideo={onRetryVideo} onSelectionGesture={onSelectionGesture} onOpen={onOpen} onPointerDragStart={onPointerDragStart} onPointerDragMove={onPointerDragMove} onPointerDragEnd={onPointerDragEnd} onPointerDragCancel={onPointerDragCancel} />)}
          </div>;
        })}
      </div>
    </div>
    {quickPreview && !privacyMode && <div className="asset-gallery__quick-preview" style={quickPreviewLayout(quickPreview)}><img src={assetUrl(quickPreview.asset.id)} alt={`${quickPreview.asset.title || quickPreview.asset.originalName} 빠른 미리보기`} draggable={false} onError={cancelQuickPreview} /></div>}
    <AssetGalleryScrollbar scrollRef={scrollRef} totalHeight={reservedTotal + introHeight} />
  </div>;
}

function AssetTile({ asset, height, captionBelow = false, selected, selectedAssetIds, focused, metadataVisible, privacyMode, activePreview, onRequestPreview, onReleasePreview, onRequestQuickPreview, onCancelQuickPreview, onRetryVideo, onSelectionGesture, onOpen, onPointerDragStart, onPointerDragMove, onPointerDragEnd, onPointerDragCancel }: { asset: AssetSummary; height: number; captionBelow?: boolean; selected: boolean; selectedAssetIds: ReadonlySet<string>; focused: boolean; metadataVisible: boolean; privacyMode: boolean; activePreview: boolean; onRequestPreview(): void; onReleasePreview(): void; onRequestQuickPreview(asset: AssetSummary, trigger: HTMLElement): void; onCancelQuickPreview(): void; onRetryVideo?: AssetGalleryProps["onRetryVideo"]; onSelectionGesture?: (asset: AssetSummary, gesture: SelectionGesture) => void; onOpen?: (asset: AssetSummary) => void; onPointerDragStart?: AssetGalleryProps["onPointerDragStart"]; onPointerDragMove?: AssetGalleryProps["onPointerDragMove"]; onPointerDragEnd?: AssetGalleryProps["onPointerDragEnd"]; onPointerDragCancel?: AssetGalleryProps["onPointerDragCancel"] }) {
  const alt = asset.title || asset.originalName;
  return <div role="option" data-asset-id={asset.id} className={`asset-gallery__asset${captionBelow ? " asset-gallery__asset--caption" : ""}`} style={{ width: asset.width, height: height + (captionBelow && metadataVisible ? CAPTION_HEIGHT : 0) }} aria-label={alt} aria-description={metadataVisible ? `${asset.creatorName || asset.creatorHandle || "작가 미상"} · ${collectedDate(asset.collectedAt).full}` : undefined} aria-selected={selected} tabIndex={focused ? 0 : -1} onClick={(event) => onSelectionGesture?.(asset, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey })} onDoubleClick={() => onOpen?.(asset)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onOpen?.(asset); } else if (event.key === " ") { event.preventDefault(); onSelectionGesture?.(asset, { toggle: true, range: event.shiftKey }); } }} onPointerDown={(event) => { if (event.button === 0) onPointerDragStart?.({ kind: "assets", assetIds: assetDragIds(asset.id, selectedAssetIds) }, event); }} onPointerMove={onPointerDragMove} onPointerUp={onPointerDragEnd} onPointerCancel={onPointerDragCancel}>
    <div className="asset-gallery__image" style={{ height }}>
    {privacyMode ? <Skeleton className="privacy-mask asset-gallery__media-mask" label="비공개 모드" /> : asset.media.kind === "video" ? <VideoTileMedia asset={asset as AssetSummary & { media: Extract<AssetSummary["media"], { kind: "video" }> }} active={activePreview} onRequestActive={onRequestPreview} onReleaseActive={onReleasePreview} onRetry={() => onRetryVideo?.(asset)} /> : <img src={thumbnailUrl(asset.id)} alt={alt} width={asset.width} height={asset.height} loading="lazy" decoding="async" draggable={false} />}
    {asset.media.kind === "image" && !privacyMode && <button type="button" className="asset-gallery__quick-preview-trigger" aria-label={`${alt} 빠른 확대 미리보기`} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onPointerEnter={(event) => onRequestQuickPreview(asset, event.currentTarget)} onPointerLeave={onCancelQuickPreview} onFocus={(event) => onRequestQuickPreview(asset, event.currentTarget)} onBlur={onCancelQuickPreview} onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); onCancelQuickPreview(); } }}><MagnifyingGlassPlusIcon aria-hidden="true" /></button>}
    </div>
    {selected && <span className="asset-gallery__selection-indicator" aria-hidden="true" />}
    {asset.favorite && <span className="asset-gallery__favorite" aria-hidden="true"><HeartIcon /></span>}
    {metadataVisible && <span className="asset-gallery__metadata"><span aria-description={asset.creatorName || asset.creatorHandle || "작가 미상"}>{asset.creatorName || asset.creatorHandle || "작가 미상"}</span><time aria-description={collectedDate(asset.collectedAt).full} dateTime={asset.collectedAt}>{collectedDate(asset.collectedAt).time}</time></span>}
  </div>;
}


const METRICS_QUANTIZE = 16;

function useGalleryMetrics(ref: React.RefObject<HTMLElement | null>, layout: GalleryLayout) {
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
  }, [ref, layout]);
  return metrics;
}

function cssLength(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function quickPreviewLayout({ asset, anchor, boundary }: QuickPreviewState): React.CSSProperties {
  const boundaryLeft = boundary && boundary.width > 0 ? Math.max(0, boundary.left) : 0;
  const boundaryRight = boundary && boundary.width > 0 ? Math.min(window.innerWidth, boundary.right) : window.innerWidth;
  const boundaryTop = boundary && boundary.height > 0 ? Math.max(0, boundary.top) : 0;
  const boundaryBottom = boundary && boundary.height > 0 ? Math.min(window.innerHeight, boundary.bottom) : window.innerHeight;
  const availableWidth = Math.max(1, boundaryRight - boundaryLeft - QUICK_PREVIEW_MARGIN * 2);
  const availableHeight = Math.max(1, boundaryBottom - boundaryTop - QUICK_PREVIEW_MARGIN * 2);
  const maxWidth = Math.min(window.innerWidth * 0.55, availableWidth);
  const maxHeight = Math.min(window.innerHeight * 0.7, availableHeight);
  const sourceWidth = Math.max(1, asset.width);
  const sourceHeight = Math.max(1, asset.height);
  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  const preferredRight = anchor.right + QUICK_PREVIEW_GAP;
  const left = preferredRight + width + QUICK_PREVIEW_MARGIN <= boundaryRight
    ? preferredRight
    : Math.max(boundaryLeft + QUICK_PREVIEW_MARGIN, anchor.left - QUICK_PREVIEW_GAP - width);
  const top = Math.min(
    boundaryBottom - QUICK_PREVIEW_MARGIN - height,
    Math.max(boundaryTop + QUICK_PREVIEW_MARGIN, anchor.top + anchor.height / 2 - height / 2),
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
