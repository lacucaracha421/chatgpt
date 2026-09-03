import { ArrowPathIcon, ArrowsPointingOutIcon, Bars3BottomLeftIcon, BarsArrowDownIcon, ClockIcon, DocumentTextIcon, MagnifyingGlassIcon, UserIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { MangaSeries } from "../library/types";
import { mangaCoverUrl } from "../assets/mediaUrl";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { ViewToolbar } from "../layout/ViewToolbar";
import { Menu } from "../shared/ui/Menu";
import { Slider } from "../shared/ui/Slider";
import { MangaSourceTabs, OnlineCatalogBrowser } from "./OnlineCatalogBrowser";

type MangaSort = "recent" | "title_asc" | "author_asc" | "pages_desc";

type MangaBrowserProps = {
  onOpenSeries?: (series: MangaSeries) => void;
};
export function MangaBrowser({ onOpenSeries }: MangaBrowserProps) {
  const { gateway } = useLibrary();
  const [root, setRoot] = useState<string | null | undefined>(undefined);
  const [series, setSeries] = useState<MangaSeries[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<MangaSort>("recent");
  const [cardWidth, setCardWidth] = useState(152);
  const [message, setMessage] = useState<string | null>(null);
  const [source, setSource] = useState<"local" | "online">("local");
  useAutoDismiss(message, setMessage);

  const visibleSeries = useMemo(() => {
    if (!series) return [];
    const normalized = query.trim().toLocaleLowerCase();
    const filtered = normalized
      ? series.filter((entry) => `${entry.title}\n${entry.author}`.toLocaleLowerCase().includes(normalized))
      : series;
    if (sort === "recent") return filtered;
    return [...filtered].sort((left, right) => {
      if (sort === "pages_desc") return right.pageCount - left.pageCount;
      const leftValue = sort === "author_asc" ? left.author : left.title;
      const rightValue = sort === "author_asc" ? right.author : right.title;
      return leftValue.localeCompare(rightValue, "ko", { numeric: true, sensitivity: "base" });
    });
  }, [query, series, sort]);

  async function refreshSeries(active = () => true) {
    if (!active()) return;
    setScanning(true);
    try {
      const scanned = await gateway.scanManga();
      if (!active()) return;
      setMessage(scanned > 0 ? `망가 ${scanned}개를 새로고침했습니다` : "새로 변경된 망가가 없습니다");
      const next = await gateway.listMangaSeries();
      if (active()) setSeries(next);
    } catch {
      if (active()) setMessage("망가 목록을 불러오지 못했습니다");
    } finally {
      if (active()) setScanning(false);
    }
  }

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const currentRoot = await gateway.getMangaRoot();
        if (!active) return;
        setRoot(currentRoot);
        if (currentRoot) {
          const cached = await gateway.listMangaSeries();
          if (!active) return;
          setSeries(cached);
          void refreshSeries(() => active);
        }
      } catch {
        if (active) setMessage("망가 목록을 불러오지 못했습니다");
      }
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway]);

  if (source === "online") {
    return <OnlineCatalogBrowser onSwitchLocal={() => setSource("local")} />;
  }

  if (root === undefined) {
    return <section className="manga-browser" aria-label="망가">
      <ViewToolbar title="망가" ariaLabel="망가 도구" children={<MangaSourceTabs source="local" onLocal={() => undefined} onOnline={() => setSource("online")} />} />
      <div className="manga-browser__content"><Skeleton className="manga-browser__skeleton" label="망가를 불러오는 중" /></div>
    </section>;
  }

  if (!root) {
    return <section className="manga-browser" aria-label="망가">
      <ViewToolbar title="망가" ariaLabel="망가 도구" children={<MangaSourceTabs source="local" onLocal={() => undefined} onOnline={() => setSource("online")} />} />
      <div className="manga-browser__content"><EmptyState title="망가 폴더가 설정되지 않았습니다">설정에서 망가 폴더를 선택하면 여기에 표시됩니다.</EmptyState></div>
    </section>;
  }

  const countLabel = query.trim() && visibleSeries.length !== series?.length
    ? `${visibleSeries.length} / ${series?.length ?? 0}개 작품`
    : `${series?.length ?? 0}개 작품`;

  return <section className="manga-browser" aria-label="망가">
    <ViewToolbar
      title="망가"
      ariaLabel="망가 도구"
      children={<>
        <MangaSourceTabs source="local" onLocal={() => undefined} onOnline={() => setSource("online")} />
        <span className="manga-browser__count">{countLabel}</span>
        {scanning && <span className="manga-browser__scan-status" role="status">폴더 스캔 중</span>}
        <label className="manga-browser__search">
          <MagnifyingGlassIcon aria-hidden="true" />
          <input type="search" aria-label="망가 검색" placeholder="제목 또는 작가 검색" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
      </>}
      actions={<>
        <span className="manga-browser__icon-control" title={`정렬: ${mangaSortLabel(sort)}`}>
          <Menu label={`정렬: ${mangaSortLabel(sort)}`} trigger={<BarsArrowDownIcon aria-hidden="true" />} items={[
            { id: "recent", label: "최근 변경순", icon: <ClockIcon />, selected: sort === "recent", onSelect: () => setSort("recent") },
            { id: "title_asc", label: "제목순", icon: <Bars3BottomLeftIcon />, selected: sort === "title_asc", onSelect: () => setSort("title_asc") },
            { id: "author_asc", label: "작가순", icon: <UserIcon />, selected: sort === "author_asc", onSelect: () => setSort("author_asc") },
            { id: "pages_desc", label: "페이지 많은 순", icon: <DocumentTextIcon />, selected: sort === "pages_desc", onSelect: () => setSort("pages_desc") },
          ]} />
        </span>
        <span className="manga-browser__size-control" title="카드 크기"><ArrowsPointingOutIcon aria-hidden="true" /><Slider label="카드 크기" min={112} max={220} step={8} value={cardWidth} onChange={(event) => setCardWidth(Number(event.target.value))} /></span>
        <Button size="icon" variant="ghost" title={scanning ? "스캔 중" : "새로고침"} aria-label={scanning ? "스캔 중" : "새로고침"} disabled={scanning} onClick={() => void refreshSeries()}><ArrowPathIcon aria-hidden="true" /></Button>
      </>}
    />
    {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
    <div className="manga-browser__content">
      {!series ? <Skeleton className="manga-browser__skeleton" label="망가를 불러오는 중" /> : series.length === 0 ? (
        <EmptyState title="망가가 없습니다">망가 폴더에 시리즈 폴더를 추가하세요.</EmptyState>
      ) : visibleSeries.length === 0 ? (
        <EmptyState title="검색 결과가 없습니다">다른 제목이나 작가 이름으로 검색하세요.</EmptyState>
      ) : <MangaCoverGrid series={visibleSeries} cardWidth={cardWidth} onOpenSeries={onOpenSeries} />}
    </div>
  </section>;
}

function mangaSortLabel(sort: MangaSort): string {
  return sort === "title_asc" ? "제목순" : sort === "author_asc" ? "작가순" : sort === "pages_desc" ? "페이지 많은 순" : "최근 변경순";
}

function MangaCoverGrid({ series, cardWidth, onOpenSeries }: { series: MangaSeries[]; cardWidth: number; onOpenSeries?: (series: MangaSeries) => void }) {
  const { privacyMode } = usePrivacy();
  const [failedCovers, setFailedCovers] = useState<ReadonlySet<string>>(new Set());
  return <div className="manga-browser__grid" style={{ "--manga-card-width": `${cardWidth}px` } as CSSProperties}>
    {series.map((entry) => (
      <button key={entry.id} type="button" className="manga-browser__cover" onClick={() => onOpenSeries?.(entry)}>
        {privacyMode ? <Skeleton className="privacy-mask manga-browser__cover-mask" label="비공개 모드" />
          : failedCovers.has(entry.id)
            ? <span className="manga-browser__cover-fallback catalog-thumbnail__fallback"><strong>{entry.pageCount}페이지</strong></span>
            : <img src={mangaCoverUrl(entry.id)} alt={entry.title} loading="lazy" draggable={false} onError={() => setFailedCovers((current) => new Set(current).add(entry.id))} />}
        <span className="manga-browser__cover-title">{entry.title}</span>
        <span className="manga-browser__cover-author">{entry.author} · {entry.pageCount}페이지</span>
      </button>
    ))}
  </div>;
}
