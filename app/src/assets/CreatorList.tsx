import { useEffect, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { AssetCreatorSummary } from "../library/types";
import { thumbnailUrl } from "./mediaUrl";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";

const CELL_GAP = 20;
const OVERSCAN_ROWS = 6;
const MIN_SHOWN_COUNT = 3;

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("ko-KR");
}

function useContainerWidth() {
  const [width, setWidth] = useState(0);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const ref = useMemo(() => (node: HTMLElement | null) => setElement(node), []);
  useEffect(() => {
    if (!element) return;
    setWidth(element.clientWidth);
    if (!window.ResizeObserver) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [width, ref, element] as const;
}

export function CreatorList({ onSelect, privacyMode, cellSize = 200 }: { onSelect: (creatorKey: string) => void; privacyMode: boolean; cellSize?: number }) {
  const { gateway } = useLibrary();
  const [creators, setCreators] = useState<AssetCreatorSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMinor, setShowMinor] = useState(false);

  useEffect(() => {
    let cancelled = false;
    gateway.listAssetCreators({
      classificationId: null,
      albumId: null,
      collectionId: null,
      directOnly: false,
      unclassifiedOnly: false,
      mediaKind: null,
      aspectRatio: null,
      sort: "newest",
      randomPivot: null,
      after: null,
      limit: 1,
    }).then((result) => {
      if (!cancelled) setCreators(result);
    }).catch((err: unknown) => {
      if (!cancelled) setError(commandErrorMessage(err, "작가 목록을 불러오지 못했습니다."));
    });
    return () => { cancelled = true; };
  }, [gateway]);

  const visible = useMemo(
    () => (creators ?? []).filter((creator) => showMinor || creator.assetCount >= MIN_SHOWN_COUNT),
    [creators, showMinor],
  );
  const hiddenCount = useMemo(
    () => (creators ?? []).filter((creator) => creator.assetCount < MIN_SHOWN_COUNT).length,
    [creators],
  );
  const [hoveredCreator, setHoveredCreator] = useState<string | null>(null);
  const [width, scrollRef, scrollElement] = useContainerWidth();
  const cellWidth = Math.max(140, Math.min(320, cellSize));
  const cellHeight = Math.round(cellWidth * 0.89) + 30;
  const columns = Math.max(1, Math.floor((width - CELL_GAP) / (cellWidth + CELL_GAP)));
  const rowCount = Math.ceil(visible.length / columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElement,
    estimateSize: () => cellHeight,
    overscan: OVERSCAN_ROWS,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  if (error) return <EmptyState title={error} />;
  if (creators === null) return <Skeleton className="creator-list__skeleton" label="작가 목록을 불러오는 중" />;
  if (creators.length === 0) return <EmptyState title="작가 정보가 있는 자산이 없습니다">출처가 있는 이미지를 수집하면 작가별로 모아집니다.</EmptyState>;

  return <div className="creator-list" aria-label="작가 목록">
    <div className="creator-list__scroll" ref={scrollRef}>
      <div style={{ height: totalSize, position: "relative" }}>
        {virtualRows.map((virtualRow) => (
          <div key={virtualRow.index} className="creator-list__gridrow" style={{ transform: `translateY(${virtualRow.start}px)`, height: cellHeight }}>
            {visible.slice(virtualRow.index * columns, (virtualRow.index + 1) * columns).map((creator) => (
              <button
                key={creator.key}
                type="button"
                className={`creator-list__card${hoveredCreator === creator.key ? " creator-list__card--preview" : ""}`}
                style={{ width: cellWidth, height: cellHeight - 30, ["--card-w" as string]: `${cellWidth}px` }}
                onClick={() => onSelect(creator.key)}
                onMouseEnter={() => setHoveredCreator(creator.key)}
                onMouseLeave={() => setHoveredCreator((current) => current === creator.key ? null : current)}
                onFocus={() => setHoveredCreator(creator.key)}
                onBlur={() => setHoveredCreator((current) => current === creator.key ? null : current)}
              >
                {!privacyMode && <span className="creator-list__stack" aria-hidden="true">
                  {creator.coverAssetIds.slice(0, 3).map((assetId, index) => (
                    <img key={assetId} className="creator-list__cover" data-slot={index} src={thumbnailUrl(assetId)} alt="" loading="lazy" decoding="async" draggable={false} />
                  ))}
                </span>}
                <div className="creator-list__preview" aria-hidden="true">
                  {creator.coverAssetIds.slice(3, 6).map((assetId) => (
                    <img key={assetId} className="creator-list__preview-thumb" src={thumbnailUrl(assetId)} alt="" loading="lazy" decoding="async" draggable={false} />
                  ))}
                </div>
                <span className="creator-list__text">
                  <span className="creator-list__label">{creator.creatorName || creator.creatorHandle || creator.creatorUrl || creator.key}</span>
                  <span className="creator-list__meta">마지막 수집 {formatDate(creator.lastCollectedAt) ?? "—"}</span>
                </span>
                <span className="creator-list__count">{creator.assetCount.toLocaleString("ko-KR")}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
    {hiddenCount > 0 && <footer className="creator-list__footer">
      <Button variant="ghost" onClick={() => setShowMinor((current) => !current)}>
        {showMinor ? `작은 작가 ${hiddenCount}명 숨기기` : `작은 작가 ${hiddenCount}명 더 보기`}
      </Button>
    </footer>}
  </div>;
}