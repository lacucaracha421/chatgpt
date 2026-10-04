import { useDelayedBusy } from "../shared/useDelayedBusy";
import { createPortal } from "react-dom";
import { useWorkspaceChrome } from "../layout/WorkspaceChromeContext";
import { MangaIndex } from "./MangaIndex";
import { EllipsisHorizontalIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { CatalogScope, MangaCatalogRecoveryPreview, MangaSeries, MangaIndexIdentity, MangaLocalIndex } from "../library/types";
import { mangaCoverUrl } from "../assets/mediaUrl";
import { useCatalogMasked } from "../privacy/catalogMask";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Scrubber } from "../shared/ui/scrubber/Scrubber";
import type { ScrubberSort } from "../shared/ui/scrubber/scrubberModel";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { Menu } from "../shared/ui/Menu";
import { OnlineCatalogBrowser } from "./OnlineCatalogBrowser";
import { MangaCard, MangaSkeletonGrid } from "./MangaCard";
import { MangaToolbar, MangaChoiceMenu, type MangaSource } from "./MangaToolbar";
import { createKoreanMatcher } from "../shared/koreanSearch";
import { cancelSegmentSwap, swapSegment } from "../shared/motion/viewSwap";

type MangaSort = "recent" | "title_asc" | "author_asc" | "pages_desc";

type MangaBrowserProps = {
  onOpenSeries?: (series: MangaSeries) => void;
};

function initialMangaSource(): "local" | "online" {
  return __LAKOMICS_PREVIEW__ && new URLSearchParams(window.location.search).get("view") === "manga" ? "local" : "online";
}

export function MangaBrowser({ onOpenSeries }: MangaBrowserProps) {
  const { gateway } = useLibrary();
  const workspace = useWorkspaceChrome();
  const [bookmarkRevision, setBookmarkRevision] = useState(0);
  const [indexFilter, setIndexFilter] = useState<MangaIndexIdentity | null>(null);
  const [localFolder, setLocalFolder] = useState<string | null>(null);
  const [localIndex, setLocalIndex] = useState<MangaLocalIndex | null>(null);
  const receiveLocalIndex = useCallback((index: MangaLocalIndex) => setLocalIndex(index), []);
  const { privacyMode, nsfwFilter } = usePrivacy();
  const catalogMasked = useCatalogMasked();
  const [root, setRoot] = useState<string | null | undefined>(undefined);
  const [series, setSeries] = useState<MangaSeries[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [query, setQuery] = useState("");
  const gridScroll = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<MangaSort>("recent");
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<MangaCatalogRecoveryPreview | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [source, setSource] = useState<"local" | "online">(initialMangaSource);
  const scanStatusVisible = useDelayedBusy(scanning && source === "local");
  const [onlineScope, setOnlineScope] = useState<CatalogScope>("all");
  const [displayedSource, setDisplayedSource] = useState(source);
  const [localVisited, setLocalVisited] = useState(source === "local");
  const [onlineVisited, setOnlineVisited] = useState(source === "online");
  const [onlineReadyScope, setOnlineReadyScope] = useState<CatalogScope | null>(null);
  const [bookmarkCount, setBookmarkCount] = useState<number | undefined>();
  const onlineReady = useCallback((scope: CatalogScope) => setOnlineReadyScope(scope), []);
  function selectSource(next: MangaSource) {
    if (next === "local") { setLocalVisited(true); setSource("local"); }
    else { setOnlineScope(next); setOnlineVisited(true); setSource("online"); }
  }
  // Local and online are one segment switch: the shown screen stays until the other is ready, then the
  // shared view swap moves it in from the side of the chosen source, with the source bar still.
  const onlineScreen = useRef<HTMLDivElement>(null), localScreen = useRef<HTMLElement>(null);
  const displayedRef = useRef(displayedSource); displayedRef.current = displayedSource;
  const sourceSwap = useRef({}).current;
  useEffect(() => () => cancelSegmentSwap(sourceSwap), [sourceSwap]);
  useEffect(() => {
    const next = source === "local" && (root === null || series !== null || loadError) ? "local"
      : source === "online" && onlineReadyScope === onlineScope ? "online" : null;
    if (!next) return;
    if (next === displayedRef.current) { cancelSegmentSwap(sourceSwap); setDisplayedSource(next); return; }
    const screens = [onlineScreen.current, localScreen.current];
    swapSegment(sourceSwap, { forward: next === "online", target: screens,
      still: screens.flatMap(screen => screen ? [...screen.querySelectorAll<HTMLElement>(".manga-section-bar.ui-section-bar--inline")] : []),
      commit: () => setDisplayedSource(next) });
  }, [source, root, series, loadError, onlineReadyScope, onlineScope, sourceSwap]);
  const previousSource = useRef(displayedSource);
  useLayoutEffect(() => {
    if (previousSource.current !== displayedSource) {
      document.querySelector<HTMLButtonElement>('.manga-section-bar [role="radio"][aria-checked="true"]')?.focus();
      previousSource.current = displayedSource;
    }
  }, [displayedSource]);
  useAutoDismiss(message, setMessage);

  const visibleSeries = useMemo(() => {
    if (!series) return [];
    const matches = createKoreanMatcher(query);
    const folderIds = localFolder ? new Set(localIndex?.folders.find(folder => folder.relativePath === localFolder)?.seriesIds ?? []) : null;
    const filtered = series.filter(entry => (!folderIds || folderIds.has(entry.id)) && (!query.trim() || matches([entry.title, entry.author])));
    if (sort === "recent") return filtered;
    return [...filtered].sort((left, right) => {
      if (sort === "pages_desc") return right.pageCount - left.pageCount;
      const leftValue = sort === "author_asc" ? left.author : left.title;
      const rightValue = sort === "author_asc" ? right.author : right.title;
      return leftValue.localeCompare(rightValue, "ko", { numeric: true, sensitivity: "base" });
    });
  }, [query, series, sort, localFolder, localIndex]);

  const scrubberSort = useMemo<ScrubberSort>(() => sort === "title_asc" || sort === "author_asc"
    ? {kind: "name", values: visibleSeries.map(entry => sort === "author_asc" ? entry.author : entry.title)}
    : {kind: "fallback"}, [sort, visibleSeries]);

  async function refreshSeries(active = () => true) {
    if (!active()) return;
    setScanning(true);
    try {
      await gateway.scanManga();
      if (!active()) return;
      const next = await gateway.listMangaSeries();
      if (active()) { setSeries(next); setRefreshedAt(new Date().toISOString()); setLoadError(false); }
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
      if (result.attemptedCount > 0 && result.importedCount === 0 && result.notFoundCount > 0) {
        setMessage(`원격에서도 ${result.notFoundCount}개 ID를 찾지 못했습니다. 로컬/자체번역 작품일 수 있습니다`);
      }
      setRecovery(await gateway.previewMangaCatalogRecovery());
    } catch {
      setMessage("원격 카탈로그 확인에 실패했습니다");
    } finally { setRecoveryBusy(false); }
  }

  async function applyRecovery() {
    if (!gateway.applyMangaCatalogRecovery || !gateway.previewMangaCatalogRecovery) return;
    setRecoveryBusy(true);
    try {
      await gateway.applyMangaCatalogRecovery();
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
      await gateway.applyMangaCatalogRecoverySelection([{ mangaId, workId }]);
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
        if (active) { setMessage("망가 목록을 불러오지 못했습니다"); setLoadError(true); }
      }
    })();
    return () => { active = false; setScanning(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, source]);

  const countLabel = (query.trim() || localFolder) && visibleSeries.length !== series?.length
    ? `${visibleSeries.length} / ${series?.length ?? 0}개 작품`
    : `${series?.length ?? 0}개 작품`;

  const localActive = displayedSource === "local";
  const index = <MangaIndex source={source === "local" ? "local" : onlineScope} filter={indexFilter} onFilter={setIndexFilter}
    folder={localFolder} onFolder={setLocalFolder} localCount={series?.length ?? 0} revision={`${refreshedAt}:${bookmarkRevision}`}
    onLocalIndex={receiveLocalIndex} onPurge={async () => {
      // Folder metadata and the grid swap together after cleanup; a removed active
      // folder must not briefly empty the old grid while its replacement is loading.
      const [nextSeries, nextIndex] = await Promise.all([gateway.listMangaSeries(), gateway.getMangaLocalIndex?.()]);
      setSeries(nextSeries);
      if (nextIndex) {
        setLocalIndex(nextIndex);
        if (localFolder && !nextIndex.folders.some(folder => folder.relativePath === localFolder)) setLocalFolder(null);
      }
      setRefreshedAt(new Date().toISOString());
    }} />;
  return <>
    {workspace?.targets.navigation && createPortal(index, workspace.targets.navigation)}
    {onlineVisited && <div ref={onlineScreen} className="manga-browser__screen" style={{ display: displayedSource === "online" ? undefined : "none" }}>
      <OnlineCatalogBrowser initialScope={onlineScope} requestedSource={source === "local" ? "local" : onlineScope}
        onBookmarksChanged={() => setBookmarkRevision(n => n + 1)} indexFilter={indexFilter} onClearIndexFilter={() => setIndexFilter(null)}
        active={displayedSource === "online"} onSourceChange={selectSource} onSwitchLocal={() => selectSource("local")}
        onReady={onlineReady} localCount={series?.length} bookmarkCount={bookmarkCount} onBookmarkCount={setBookmarkCount} />
    </div>}
    {localVisited && <section ref={localScreen} className="manga-browser manga-browser__screen" aria-label="망가" style={{ display: localActive ? undefined : "none" }}>
    {localActive && <MangaToolbar source={source === "local" ? "local" : onlineScope} onSourceChange={selectSource}
      localCount={series?.length} bookmarkCount={bookmarkCount} countLabel={series ? countLabel : undefined}
      refreshedAt={refreshedAt} refreshing={scanning} onRefresh={root ? () => void refreshSeries() : undefined}
      controls={<MangaChoiceMenu label="정렬" value={sort} onChange={setSort} options={[
        { value: "recent", label: "최근 변경순" }, { value: "title_asc", label: "제목순" }, { value: "author_asc", label: "작가순" }, { value: "pages_desc", label: "페이지 많은 순" },
      ]} />}
      actions={root && gateway.previewMangaCatalogRecovery ? <Menu label="망가 관리" trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={[
        { id: "recovery", label: "카탈로그로 복구", disabled: recoveryBusy, onSelect: () => void previewRecovery() },
      ]} /> : undefined}
      chrome={{
        status: scanStatusVisible && source === "local" ? <span role="status">폴더 스캔 중</span> : undefined,
        summary: `${mangaSortLabel(sort)}${privacyMode ? " · 비공개" : ""}${nsfwFilter ? " · NSFW 필터" : ""}`,
        search: { scope: "로컬 망가", label: "망가 검색", placeholder: "제목 또는 작가 검색", query, onApply: setQuery },
      }} />}
    {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
    {recovery && <MangaRecoveryPanel preview={recovery} busy={recoveryBusy} onRemoteLookup={gateway.refreshMangaCatalogRecoveryRemote ? () => void refreshRecoveryRemote() : undefined} onApply={() => void applyRecovery()} onApplySelection={(mangaId, workId) => void applyRecoverySelection(mangaId, workId)} onClose={() => setRecovery(null)} />}
    <div ref={gridScroll} tabIndex={0} data-search-results="" className="manga-browser__content" inert={source !== "local"}>
      {loadError && !series ? <EmptyState title="망가 목록을 불러오지 못했습니다" />
        : root === null ? <EmptyState title="망가 폴더가 설정되지 않았습니다">설정에서 망가 폴더를 선택하면 여기에 표시됩니다.</EmptyState>
        : !series ? <MangaSkeletonGrid /> : series.length === 0 ? (
        <EmptyState title="망가가 없습니다">망가 폴더에 시리즈 폴더를 추가하세요.</EmptyState>
      ) : visibleSeries.length === 0 ? (
        <EmptyState title="검색 결과가 없습니다">다른 제목이나 작가 이름으로 검색하세요.</EmptyState>
      ) : <div className="manga-grid">{visibleSeries.map(entry => <MangaCard key={entry.id} title={entry.title} artist={entry.author} pageCount={entry.pageCount} coverUrl={mangaCoverUrl(entry.id)} privacyMode={catalogMasked} onOpen={() => onOpenSeries?.(entry)} />)}</div>}
    </div>
    <Scrubber input="pointer" scrollRef={gridScroll} total={visibleSeries.length} sort={scrubberSort} hidden={source !== "local" || displayedSource !== "local"} />
  </section>}</>;
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
