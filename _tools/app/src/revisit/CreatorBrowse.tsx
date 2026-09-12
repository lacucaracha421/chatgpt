import { useEffect, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { AssetCreatorSummary } from "../library/types";
import { thumbnailUrl } from "../assets/mediaUrl";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { Select } from "../shared/ui/Select";

export type CreatorSort = "recommended" | "count" | "recent" | "unseen" | "name";

const CELL_GAP = 20;
const OVERSCAN_ROWS = 6;
const MIN_SHOWN_COUNT = 3;

function searchableCreatorText(creator: AssetCreatorSummary): string {
  return `${creator.creatorName ?? ""}\n${creator.creatorHandle ?? ""}\n${creator.creatorUrl ?? ""}`.toLowerCase();
}

function creatorComparator(sort: CreatorSort) {
  return (a: AssetCreatorSummary, b: AssetCreatorSummary): number => {
    if (sort === "recommended" || sort === "unseen") {
      if (a.recommendationScore !== b.recommendationScore) return b.recommendationScore - a.recommendationScore;
    }
    if (sort === "count") {
      if (a.assetCount !== b.assetCount) return b.assetCount - a.assetCount;
    }
    if (sort === "recent") {
      const aTime = a.lastCollectedAt ?? "";
      const bTime = b.lastCollectedAt ?? "";
      if (aTime !== bTime) return aTime < bTime ? 1 : -1;
    }
    const aName = a.creatorName || a.creatorHandle || a.creatorUrl || a.key;
    const bName = b.creatorName || b.creatorHandle || b.creatorUrl || b.key;
    return aName.localeCompare(bName, "ko");
  };
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

export function CreatorBrowse({ onOpenCreator, privacyMode, cellSize = 200 }: { onOpenCreator: (creatorKey: string) => void; privacyMode: boolean; cellSize?: number }) {
  const { gateway } = useLibrary();
  const [creators, setCreators] = useState<AssetCreatorSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeMinor, setIncludeMinor] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<CreatorSort>("recommended");

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
      collectedRange: null,
      after: null,
      limit: 1,
    }).then((result) => {
      if (!cancelled) setCreators(result);
    }).catch((err: unknown) => {
      if (!cancelled) setError(commandErrorMessage(err, "작가 목록을 불러오지 못했습니다."));
    });
    return () => { cancelled = true; };
  }, [gateway]);

  const shown = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (creators ?? [])
      .filter((creator) => normalizedQuery.length > 0 || includeMinor || creator.assetCount >= MIN_SHOWN_COUNT)
      .filter((creator) => searchableCreatorText(creator).includes(normalizedQuery))
      .slice().sort(creatorComparator(sort));
  }, [creators, includeMinor, query, sort]);
  const hiddenCount = useMemo(
    () => (creators ?? []).filter((creator) => creator.assetCount < MIN_SHOWN_COUNT).length,
    [creators],
  );
  const [width, scrollRef, scrollElement] = useContainerWidth();
  const cellWidth = Math.max(140, Math.min(320, cellSize));
  const cellHeight = Math.round(cellWidth * 0.89) + 30;
  const columns = Math.max(1, Math.floor((width - CELL_GAP) / (cellWidth + CELL_GAP)));
  const rowCount = Math.ceil(shown.length / columns);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollElement,
    estimateSize: () => cellHeight,
    overscan: OVERSCAN_ROWS,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  return <div className="creator-browse" aria-label="작가 탐색">
    <div className="creator-browse__controls">
      <input type="search" role="searchbox" aria-label="작가 검색" placeholder="작가 검색" value={query} onChange={(event) => setQuery(event.target.value)} />
      <Select label="정렬" value={sort} onChange={(event) => setSort(event.target.value as CreatorSort)}>
        <option value="recommended">추천순</option>
        <option value="count">자산 수</option>
        <option value="recent">최근 수집</option>
        <option value="unseen">오래 보지 않음</option>
        <option value="name">이름</option>
      </Select>
    </div>
    {error && <EmptyState title={error} />}
    {creators === null && !error && <Skeleton className="creator-browse__skeleton" label="작가 목록을 불러오는 중" />}
    {creators !== null && !error && creators.length === 0 && <EmptyState title="작가 정보가 있는 자산이 없습니다">출처가 있는 이미지를 수집하면 작가별로 모아집니다.</EmptyState>}
    {creators !== null && !error && creators.length > 0 && <div className="creator-browse__scroll" ref={scrollRef}>
      <div style={{ height: totalSize, position: "relative" }}>
        {virtualRows.map((virtualRow) => (
          <div key={virtualRow.index} className="creator-browse__gridrow" style={{ transform: `translateY(${virtualRow.start}px)`, height: cellHeight }}>
            {shown.slice(virtualRow.index * columns, (virtualRow.index + 1) * columns).map((creator: AssetCreatorSummary) => (
              <CreatorCard key={creator.key} creator={creator} privacyMode={privacyMode} cellWidth={cellWidth} cellHeight={cellHeight - 30} onOpen={() => onOpenCreator(creator.key)} />
            ))}
          </div>
        ))}
      </div>
    </div>}
    {creators !== null && !error && creators.length > 0 && hiddenCount > 0 && <footer className="creator-browse__footer">
      <Button variant="ghost" onClick={() => setIncludeMinor((current) => !current)}>
        {includeMinor ? `소규모 작가 ${hiddenCount}명 숨기기` : `소규모 작가 ${hiddenCount}명 포함`}
      </Button>
    </footer>}
  </div>;
}

function relativeTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days < 1) return "오늘";
  if (days < 30) return `${days}일 전`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}개월 전`;
  return `${Math.floor(months / 12)}년 전`;
}

function CreatorCard({ creator, privacyMode, cellWidth, cellHeight, onOpen }: { creator: AssetCreatorSummary; privacyMode: boolean; cellWidth: number; cellHeight: number; onOpen: () => void }) {
  const covers = privacyMode ? [] : creator.coverAssetIds.slice(0, 5);
  const label = creator.creatorName || creator.creatorHandle || creator.creatorUrl || creator.key;
  const opened = relativeTime(creator.lastOpenedAt);
  const collected = relativeTime(creator.lastCollectedAt);
  const meta = opened ? `마지막 열람 ${opened}` : collected ? `최근 수집 ${collected}` : null;
  return <button
    type="button"
    className="creator-browse__card"
    style={{ width: cellWidth, height: cellHeight, ["--card-w" as string]: `${cellWidth}px` }}
    onClick={onOpen}
  >
    <span className="creator-browse__collage" aria-hidden="true">
      {covers.map((assetId, index) => (
        <img key={assetId} className={`creator-browse__media${index === 0 ? " creator-browse__media--hero" : ""}`} src={thumbnailUrl(assetId)} alt="" loading="lazy" decoding="async" draggable={false} />
      ))}
    </span>
    <span className="creator-browse__copy">
      <span className="creator-browse__label">{label}</span>
      <span className="creator-browse__count">{creator.assetCount.toLocaleString("ko-KR")}</span>
      {meta && <span className="creator-browse__meta">{meta}</span>}
    </span>
  </button>;
}