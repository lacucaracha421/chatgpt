import { ArrowPathIcon, ArrowsPointingOutIcon, Bars3BottomLeftIcon, BarsArrowDownIcon, ClockIcon, DocumentTextIcon, LifebuoyIcon, MagnifyingGlassIcon, UserIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { MangaCatalogRecoveryPreview, MangaSeries } from "../library/types";
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
  const [recovery, setRecovery] = useState<MangaCatalogRecoveryPreview | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [source, setSource] = useState<"local" | "online">("online");
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

  async function previewRecovery() {
    if (!gateway.previewMangaCatalogRecovery) return;
    setRecoveryBusy(true);
    try {
      setRecovery(await gateway.previewMangaCatalogRecovery());
    } catch {
      setMessage("카탈로그 복구 분석을 불러오지 못했습니다");
    } finally { setRecoveryBusy(false); }
  }

  async function refreshRecoveryRemote() {
    if (!gateway.refreshMangaCatalogRecoveryRemote || !gateway.previewMangaCatalogRecovery) return;
    setRecoveryBusy(true);
    try {
      const result = await gateway.refreshMangaCatalogRecoveryRemote();
      setMessage(result.importedCount > 0
        ? `원격 카탈로그에서 정확한 ID ${result.importedCount}개를 보강했습니다`
        : result.attemptedCount > 0
          ? `원격에서도 ${result.notFoundCount}개 ID를 찾지 못했습니다. 로컬/자체번역 작품일 수 있습니다`
          : "원격 확인이 필요한 숫자 ID가 없습니다");
      setRecovery(await gateway.previewMangaCatalogRecovery());
    } catch {
      setMessage("원격 카탈로그 확인에 실패했습니다");
    } finally { setRecoveryBusy(false); }
  }

  async function applyRecovery() {
    if (!gateway.applyMangaCatalogRecovery || !gateway.previewMangaCatalogRecovery) return;
    setRecoveryBusy(true);
    try {
      const result = await gateway.applyMangaCatalogRecovery();
      setMessage(`카탈로그 북마크 ${result.createdBookmarks}개를 복구했습니다`);
      setSeries(await gateway.listMangaSeries());
      setRecovery(await gateway.previewMangaCatalogRecovery());
    } catch {
      setMessage("카탈로그 북마크 복구에 실패했습니다");
    } finally { setRecoveryBusy(false); }
  }

  async function applyRecoverySelection(mangaId: string, workId: number) {
    if (!gateway.applyMangaCatalogRecoverySelection || !gateway.previewMangaCatalogRecovery) return;
    setRecoveryBusy(true);
    try {
      const result = await gateway.applyMangaCatalogRecoverySelection([{ mangaId, workId }]);
      setMessage(result.createdBookmarks > 0 ? "선택한 작품을 북마크에 등록했습니다" : "이미 등록된 북마크입니다");
      setSeries(await gateway.listMangaSeries());
      setRecovery(await gateway.previewMangaCatalogRecovery());
    } catch {
      setMessage("선택한 작품 등록에 실패했습니다");
    } finally { setRecoveryBusy(false); }
  }

  useEffect(() => {
    if (source !== "local") return;
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
  }, [gateway, source]);

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
            { id: "recent", label: "최근 변경순", icon: <ClockIcon />, group: "sort", selected: sort === "recent", onSelect: () => setSort("recent") },
            { id: "title_asc", label: "제목순", icon: <Bars3BottomLeftIcon />, group: "sort", selected: sort === "title_asc", onSelect: () => setSort("title_asc") },
            { id: "author_asc", label: "작가순", icon: <UserIcon />, group: "sort", selected: sort === "author_asc", onSelect: () => setSort("author_asc") },
            { id: "pages_desc", label: "페이지 많은 순", icon: <DocumentTextIcon />, group: "sort", selected: sort === "pages_desc", onSelect: () => setSort("pages_desc") },
          ]} />
        </span>
        <span className="manga-browser__size-control" title="카드 크기"><ArrowsPointingOutIcon aria-hidden="true" /><Slider label="카드 크기" min={112} max={220} step={8} value={cardWidth} onChange={(event) => setCardWidth(Number(event.target.value))} /></span>
        {gateway.previewMangaCatalogRecovery && <Button size="icon" variant="ghost" title="카탈로그로 복구" aria-label="카탈로그로 복구" disabled={recoveryBusy} onClick={() => void previewRecovery()}><LifebuoyIcon aria-hidden="true" /></Button>}
        <Button size="icon" variant="ghost" title={scanning ? "스캔 중" : "새로고침"} aria-label={scanning ? "스캔 중" : "새로고침"} disabled={scanning} onClick={() => void refreshSeries()}><ArrowPathIcon aria-hidden="true" /></Button>
      </>}
    />
    {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
    {recovery && <MangaRecoveryPanel preview={recovery} busy={recoveryBusy} onRemoteLookup={gateway.refreshMangaCatalogRecoveryRemote ? () => void refreshRecoveryRemote() : undefined} onApply={() => void applyRecovery()} onApplySelection={(mangaId, workId) => void applyRecoverySelection(mangaId, workId)} onClose={() => setRecovery(null)} />}
    <div className="manga-browser__content">
      {!series ? <Skeleton className="manga-browser__skeleton" label="망가를 불러오는 중" /> : series.length === 0 ? (
        <EmptyState title="망가가 없습니다">망가 폴더에 시리즈 폴더를 추가하세요.</EmptyState>
      ) : visibleSeries.length === 0 ? (
        <EmptyState title="검색 결과가 없습니다">다른 제목이나 작가 이름으로 검색하세요.</EmptyState>
      ) : <MangaCoverGrid series={visibleSeries} cardWidth={cardWidth} onOpenSeries={onOpenSeries} />}
    </div>
  </section>;
}

function MangaRecoveryPanel({ preview, busy, onRemoteLookup, onApply, onApplySelection, onClose }: { preview: MangaCatalogRecoveryPreview; busy: boolean; onRemoteLookup?: () => void; onApply(): void; onApplySelection(mangaId: string, workId: number): void; onClose(): void }) {
  const exactPending = preview.items.filter((item) => item.status === "exact_active" && !item.bookmarked).length;
  const historicalItems = preview.items.filter((item) => item.status === "historical");
  const fallbackItems = preview.items.filter((item) => item.status === "fallback");
  const remoteIdCount = fallbackItems.filter((item) => /^\d+$/.test(item.galleryId?.trim() ?? "")).length;
  return <div className="manga-browser__recovery" role="region" aria-label="카탈로그 복구 미리보기">
    <div className="manga-browser__recovery-summary">
      <strong>카탈로그 복구 미리보기</strong>
      <span>전체 {preview.totalCount}개</span>
      <span>정확한 현행 작품 {preview.exactActiveCount}개</span>
      <span>과거/삭제 작품 {preview.historicalCount}개</span>
      <span>검토 필요 {preview.fallbackCount}개</span>
    </div>
    <p>정확한 ID로 현재 카탈로그에 존재하는 작품만 일괄 등록합니다. 나머지는 자동으로 변경하지 않습니다.</p>
    <div className="manga-browser__recovery-actions">
      <Button size="sm" disabled={busy || exactPending === 0} onClick={onApply}>확정 {exactPending}개 북마크 등록</Button>
      {onRemoteLookup && <Button size="sm" variant="ghost" disabled={busy || remoteIdCount === 0} onClick={onRemoteLookup}>원격 ID 확인 {remoteIdCount}개</Button>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>닫기</Button>
    </div>
    {historicalItems.length > 0 && <div className="manga-browser__recovery-list" aria-label="과거 작품 계보 제안">
      <strong>과거 작품 계보 제안 (자동 등록 안 함)</strong>
      {historicalItems.map((item) => <div key={item.mangaId} className="manga-browser__recovery-item">
        <span>{item.title} · {item.author} · {item.pageCount}페이지 · ID {item.galleryId ?? "없음"}</span>
        {item.suggestedWorkId != null
          ? <span>→ {item.suggestionReason} {item.suggestionTitle} (ID {item.suggestedWorkId})</span>
          : <span>연결 가능한 현행 작품이 없어 검토 전용으로 남습니다</span>}
        {item.suggestedWorkId != null && <div className="manga-browser__recovery-actions">
          <Button size="sm" disabled={busy || item.bookmarked} onClick={() => onApplySelection(item.mangaId, item.suggestedWorkId!)}>이 작품으로 등록</Button>
        </div>}
      </div>)}
    </div>}
    {fallbackItems.length > 0 && <div className="manga-browser__recovery-list" aria-label="검토 필요 후보">
      <strong>검토 필요 (자동 등록 안 함)</strong>
      {fallbackItems.map((item) => <div key={item.mangaId} className="manga-browser__recovery-item">
        <span>{item.title} · {item.author} · {item.pageCount}페이지 · ID {item.galleryId ?? "없음"}</span>
        {(item.candidates ?? []).length === 0 && <span>후보가 없습니다 · 카탈로그에 없는 로컬/자체번역 작품일 수 있습니다</span>}
        {(item.candidates ?? []).map((candidate) => <div key={candidate.workId} className="manga-browser__recovery-candidate">
          <span>{candidate.title}{candidate.artist ? ` · ${candidate.artist}` : ""}{candidate.fileCount != null ? ` · ${candidate.fileCount}페이지` : ""} (ID {candidate.workId})</span>
          <span>{candidate.reasons.join(" · ")}{candidate.confidence === "suggested" ? " · 제안" : " · 검토용"}</span>
          <div className="manga-browser__recovery-actions">
            <Button size="sm" disabled={busy} onClick={() => onApplySelection(item.mangaId, candidate.workId)}>이 작품으로 등록</Button>
          </div>
        </div>)}
      </div>)}
    </div>}
  </div>;
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
            : <img src={mangaCoverUrl(entry.id)} alt="" loading="lazy" draggable={false} onError={() => setFailedCovers((current) => new Set(current).add(entry.id))} />}
        <span className="manga-browser__cover-title" title={entry.title}>{entry.title}</span>
        <span className="manga-browser__cover-author" title={`${entry.author} · ${entry.pageCount}페이지`}>{entry.author} · {entry.pageCount}페이지</span>
      </button>
    ))}
  </div>;
}
