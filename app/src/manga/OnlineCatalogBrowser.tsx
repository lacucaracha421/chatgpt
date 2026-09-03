import { ArrowDownTrayIcon, ArrowPathIcon, BarsArrowDownIcon, BookmarkIcon, ClockIcon, EyeIcon, FireIcon, MagnifyingGlassIcon, RectangleStackIcon } from "@heroicons/react/24/outline";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ViewToolbar } from "../layout/ViewToolbar";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type {
  CatalogSearchPage,
  CatalogScope,
  CatalogSort,
  CatalogStatus,
  CatalogSuggestion,
  CatalogWorkDetail,
  RemoteReadingProgress,
} from "../library/types";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Menu } from "../shared/ui/Menu";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { PageViewer } from "./PageViewer";
import { OnlineCatalogCard } from "./OnlineCatalogCard";
import { OnlineCatalogDetailDialog } from "./OnlineCatalogDetailDialog";

type OnlineCatalogBrowserProps = {
  onSwitchLocal: () => void;
};

export function MangaSourceTabs({ source, onLocal, onOnline }: {
  source: "local" | "online";
  onLocal: () => void;
  onOnline: () => void;
}) {
  return <div className="manga-source-tabs" aria-label="망가 출처">
    <button type="button" aria-pressed={source === "local"} onClick={onLocal}>폴더</button>
    <button type="button" aria-pressed={source === "online"} onClick={onOnline}>카탈로그</button>
  </div>;
}

export function OnlineCatalogBrowser({ onSwitchLocal }: OnlineCatalogBrowserProps) {
  const { gateway } = useLibrary();
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [results, setResults] = useState<CatalogSearchPage | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<CatalogSort>("latest");
  const [scope, setScope] = useState<CatalogScope>("all");
  const [page, setPage] = useState(0);
  const [suggestions, setSuggestions] = useState<CatalogSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [openingWorkId, setOpeningWorkId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CatalogWorkDetail | null>(null);
  const [detailProgress, setDetailProgress] = useState<RemoteReadingProgress | null>(null);
  const [bookmarkPendingIds, setBookmarkPendingIds] = useState<Set<number>>(() => new Set());
  const [reading, setReading] = useState(false);
  const [viewer, setViewer] = useState<{
    title: string;
    provider: "kHentai";
    workId: string;
    pageCount: number;
    pageUrls: string[];
    initialPage: number;
  } | null>(null);
  const progressTimer = useRef<number | null>(null);
  const pendingProgress = useRef<RemoteReadingProgress | null>(null);
  const searchRequest = useRef(0);
  const detailRequest = useRef(0);
  const bookmarkRequests = useRef(new Set<number>());
  const [message, setMessage] = useState<string | null>(null);
  useAutoDismiss(message, setMessage);

  useEffect(() => () => {
    if (progressTimer.current !== null) window.clearTimeout(progressTimer.current);
    if (pendingProgress.current) void gateway.saveRemoteReadingProgress(pendingProgress.current);
  }, [gateway]);

  async function search(text: string, nextSort = sort, nextScope = scope, nextPage = 0) {
    const request = ++searchRequest.current;
    setLoading(true);
    setPage(nextPage);
    setSuggestions([]);
    try {
      const nextResults = await gateway.searchOnlineCatalog({
        text,
        sort: nextSort,
        scope: nextScope,
        page: nextPage,
        pageSize: 48,
      });
      if (request === searchRequest.current) setResults(nextResults);
    } catch (error) {
      if (request === searchRequest.current) setMessage(commandErrorMessage(error, "온라인 카탈로그 검색에 실패했습니다"));
    } finally {
      if (request === searchRequest.current) setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void gateway.getOnlineCatalogStatus().then((next) => {
      if (!active) return;
      setStatus(next);
      if (next.installed) void search("");
    }).catch(() => active && setMessage("온라인 카탈로그 상태를 불러오지 못했습니다"));
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway]);

  useEffect(() => {
    const text = query.trim();
    if (!status?.installed || text.length < 1 || text.includes(":")) {
      setSuggestions([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void gateway.suggestOnlineCatalog(text, 10).then(setSuggestions).catch(() => setSuggestions([]));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [gateway, query, status?.installed]);

  async function importCatalog() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    setLoading(true);
    try {
      const next = await gateway.importVckCatalog(selected);
      setStatus(next);
      setMessage(`${next.workCount.toLocaleString()}개 작품을 가져왔습니다`);
      await search("");
    } catch {
      setMessage("VCK 데이터를 가져오지 못했습니다");
      setLoading(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void search(query.trim());
  }

  async function openDetail(workId: number) {
    const request = ++detailRequest.current;
    setOpeningWorkId(workId);
    try {
      const [nextDetail, progress] = await Promise.all([
        gateway.getOnlineCatalogWorkDetail(workId),
        gateway.getRemoteReadingProgress("kHentai", String(workId)),
      ]);
      if (request === detailRequest.current) {
        setDetail(nextDetail);
        setDetailProgress(progress);
      }
    } catch (error) {
      if (request === detailRequest.current) {
        setMessage(commandErrorMessage(error, "작품 정보를 불러오지 못했습니다"));
      }
    } finally {
      if (request === detailRequest.current) setOpeningWorkId(null);
    }
  }

  async function bookmarkWork(workId: number, bookmarked: boolean) {
    if (bookmarkRequests.current.has(workId)) return false;
    const searchVersion = searchRequest.current;
    bookmarkRequests.current.add(workId);
    setBookmarkPendingIds(new Set(bookmarkRequests.current));
    try {
      await gateway.setOnlineCatalogBookmark(workId, bookmarked);
      setResults((current) => current && ({
        ...current,
        works: current.works.map((work) => work.id === workId ? { ...work, bookmarked } : work),
      }));
      setDetail((current) => current?.id === workId ? { ...current, bookmarked } : current);
      if (!bookmarked && scope === "bookmarked" && searchRequest.current === searchVersion) {
        const targetPage = page > 0 && results?.works.length === 1 ? page - 1 : page;
        setResults((current) => current && ({
          ...current,
          works: current.works.filter((work) => work.id !== workId),
        }));
        await search(query.trim(), sort, scope, targetPage);
      }
      return true;
    } catch {
      setMessage("북마크를 변경하지 못했습니다");
      return false;
    } finally {
      bookmarkRequests.current.delete(workId);
      setBookmarkPendingIds(new Set(bookmarkRequests.current));
    }
  }

  async function bookmarkDetail(bookmarked: boolean) {
    if (!detail) return;
    await bookmarkWork(detail.id, bookmarked);
  }

  async function readDetail() {
    if (!detail || reading) return;
    const request = ++detailRequest.current;
    const selectedDetail = detail;
    const selectedProgress = detailProgress;
    setReading(true);
    try {
      const gallery = await gateway.resolveOnlineCatalogWork(selectedDetail.id);
      if (request !== detailRequest.current) return;
      const initialPage = selectedProgress?.pageCount === gallery.pageCount
        ? Math.min(selectedProgress.lastPage, gallery.pageCount)
        : 1;
      setViewer({ title: selectedDetail.title, ...gallery, initialPage });
    } catch (error) {
      if (request === detailRequest.current) {
        setMessage(commandErrorMessage(error, "온라인 작품을 열지 못했습니다"));
      }
    } finally {
      if (request === detailRequest.current) setReading(false);
    }
  }

  function closeDetail() {
    detailRequest.current += 1;
    setOpeningWorkId(null);
    setReading(false);
    setDetail(null);
    setDetailProgress(null);
  }

  function searchTag(nextQuery: string) {
    closeDetail();
    setQuery(nextQuery);
    void search(nextQuery, sort, scope, 0);
  }

  function saveProgress(page: number) {
    if (!viewer) return;
    if (progressTimer.current !== null) window.clearTimeout(progressTimer.current);
    pendingProgress.current = {
      provider: viewer.provider,
      workId: viewer.workId,
      lastPage: page,
      pageCount: viewer.pageCount,
      lastReadAt: "",
    };
    progressTimer.current = window.setTimeout(() => {
      const pending = pendingProgress.current;
      pendingProgress.current = null;
      progressTimer.current = null;
      if (pending) void gateway.saveRemoteReadingProgress(pending);
    }, 250);
  }

  function closeViewer() {
    if (progressTimer.current !== null) window.clearTimeout(progressTimer.current);
    progressTimer.current = null;
    const pending = pendingProgress.current;
    pendingProgress.current = null;
    if (pending) void gateway.saveRemoteReadingProgress(pending);
    setViewer(null);
  }

  async function updateCatalog() {
    if (updating) return;
    setUpdating(true);
    try {
      const result = await gateway.updateOnlineCatalog();
      const next = await gateway.getOnlineCatalogStatus();
      setStatus(next);
      if (result.added > 0) await search(query.trim(), sort, scope, 0);
      setMessage(result.reason === "alreadyRunning"
        ? "카탈로그 갱신이 이미 진행 중입니다"
        : result.reason === "upToDate"
          ? "온라인 카탈로그가 이미 최신입니다"
          : result.reason === "rateLimited"
            ? "요청이 제한되었습니다. 잠시 후 다시 시도하세요"
            : `${result.added.toLocaleString()}개 작품을 갱신했습니다`);
    } catch (error) {
      setMessage(commandErrorMessage(error, "온라인 카탈로그를 갱신하지 못했습니다"));
    } finally {
      setUpdating(false);
    }
  }

  return <section className="manga-browser online-catalog" aria-label="온라인 망가">
    <ViewToolbar
      title="망가"
      ariaLabel="온라인 망가 도구"
      children={<>
        <MangaSourceTabs source="online" onLocal={() => { closeDetail(); closeViewer(); onSwitchLocal(); }} onOnline={() => undefined} />
        <span className="manga-browser__count">{results ? `${results.totalCount.toLocaleString()}개 결과` : status?.installed ? `${status.workCount.toLocaleString()}개 작품` : ""}</span>
        {status?.installed && <form className="manga-browser__search online-catalog__search" role="search" onSubmit={submit}>
          <MagnifyingGlassIcon aria-hidden="true" />
          <input type="search" aria-label="온라인 만화 검색" placeholder="제목 또는 한국어 태그 검색" value={query} onChange={(event) => setQuery(event.target.value)} />
          {suggestions.length > 0 && <div className="online-catalog__suggestions" role="listbox" aria-label="검색 제안">
            {suggestions.map((suggestion) => <button
              key={suggestion.value}
              type="button"
              role="option"
              aria-selected="false"
              onClick={() => { setQuery(suggestion.value); void search(suggestion.value); }}
            >
              <span>{suggestion.label}</span><small>{suggestion.value} · {suggestion.count.toLocaleString()}</small>
            </button>)}
          </div>}
        </form>}
      </>}
      actions={status?.installed ? <>
        <span className="manga-browser__icon-control" title={`결과 범위: ${scopeLabel(scope)}`}>
          <Menu label={`결과 범위: ${scopeLabel(scope)}`} trigger={scope === "bookmarked" ? <BookmarkIcon aria-hidden="true" /> : <RectangleStackIcon aria-hidden="true" />} items={[
            { id: "all", label: "전체 보기", icon: <RectangleStackIcon />, selected: scope === "all", onSelect: () => { setScope("all"); void search(query.trim(), sort, "all", 0); } },
            { id: "bookmarked", label: "북마크만 보기", icon: <BookmarkIcon />, selected: scope === "bookmarked", onSelect: () => { setScope("bookmarked"); void search(query.trim(), sort, "bookmarked", 0); } },
          ]} />
        </span>
        <span className="manga-browser__icon-control" title={`정렬: ${catalogSortLabel(sort)}`}>
          <Menu label={`정렬: ${catalogSortLabel(sort)}`} trigger={<BarsArrowDownIcon aria-hidden="true" />} items={[
            { id: "latest", label: "최신순", icon: <ClockIcon />, selected: sort === "latest", onSelect: () => { setSort("latest"); void search(query.trim(), "latest", scope, 0); } },
            { id: "views", label: "조회순", icon: <EyeIcon />, selected: sort === "views", onSelect: () => { setSort("views"); void search(query.trim(), "views", scope, 0); } },
            { id: "hotDay", label: "오늘 인기", icon: <FireIcon />, selected: sort === "hotDay", onSelect: () => { setSort("hotDay"); void search(query.trim(), "hotDay", scope, 0); } },
            { id: "hotWeek", label: "주간 인기", icon: <FireIcon />, selected: sort === "hotWeek", onSelect: () => { setSort("hotWeek"); void search(query.trim(), "hotWeek", scope, 0); } },
            { id: "hotMonth", label: "월간 인기", icon: <FireIcon />, selected: sort === "hotMonth", onSelect: () => { setSort("hotMonth"); void search(query.trim(), "hotMonth", scope, 0); } },
          ]} />
        </span>
        <Button size="icon" variant="ghost" title={updating ? "갱신 중…" : "신규 작품 갱신"} aria-label="신규 작품 갱신" disabled={updating} onClick={() => void updateCatalog()}><ArrowDownTrayIcon aria-hidden="true" /></Button>
        <Button size="icon" variant="ghost" title="새로고침" aria-label="새로고침" disabled={loading} onClick={() => void search(query.trim(), sort, scope, page)}><ArrowPathIcon aria-hidden="true" /></Button>
      </> : undefined}
    />
    {status?.installed && <div className="online-catalog__sync-summary">
      {status?.lastError ? <span className="online-catalog__sync-status" role="alert">마지막 갱신 실패 — {status.lastError}</span>
        : status?.lastSuccessAt ? <span className="online-catalog__sync-status">마지막 갱신 {localDateTime(status.lastSuccessAt)}{status.lastAdded > 0 ? ` · 신규 ${status.lastAdded.toLocaleString()}개` : ""}</span>
        : <span className="online-catalog__sync-status">아직 갱신 기록이 없습니다</span>}
    </div>}
    {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
    <div className="manga-browser__content online-catalog__content">
      {!status ? <Skeleton className="manga-browser__skeleton" label="온라인 카탈로그를 불러오는 중" />
        : !status.installed ? <EmptyState title="온라인 카탈로그가 없습니다">
          <p>기존 VCK 폴더의 데이터를 한 번 가져오면 Lakomics에서 독립적으로 사용할 수 있습니다.</p>
          <Button onClick={() => void importCatalog()} disabled={loading}>VCK 데이터 가져오기</Button>
        </EmptyState>
        : loading && !results ? <Skeleton className="manga-browser__skeleton" label="온라인 작품을 검색하는 중" />
        : results?.works.length === 0 ? <EmptyState title="검색 결과가 없습니다">다른 제목이나 태그로 검색하세요.</EmptyState>
        : <div className="online-catalog__grid">
          {results?.works.map((work) => <OnlineCatalogCard
            key={work.id}
            work={work}
            opening={openingWorkId === work.id}
            bookmarkPending={bookmarkPendingIds.has(work.id)}
            onOpen={(selected) => void openDetail(selected.id)}
            onBookmark={(workId, bookmarked) => void bookmarkWork(workId, bookmarked)}
          />)}
        </div>}
    </div>
    {results && results.totalCount > 0 && <footer className="online-catalog__pagination">
      <span>{(results.page * results.pageSize + 1).toLocaleString()}–{Math.min(results.totalCount, (results.page + 1) * results.pageSize).toLocaleString()} / {results.totalCount.toLocaleString()}</span>
      <div>
        <Button size="sm" disabled={loading || results.page === 0} onClick={() => void search(query.trim(), sort, scope, results.page - 1)}>이전 결과</Button>
        <Button size="sm" disabled={loading || (results.page + 1) * results.pageSize >= results.totalCount} onClick={() => void search(query.trim(), sort, scope, results.page + 1)}>다음 결과</Button>
      </div>
    </footer>}
    {detail && <OnlineCatalogDetailDialog
      detail={detail}
      progress={detailProgress}
      bookmarkPending={bookmarkPendingIds.has(detail.id)}
      reading={reading}
      onBookmark={(bookmarked) => void bookmarkDetail(bookmarked)}
      onTagSearch={searchTag}
      onRead={() => void readDetail()}
      onClose={closeDetail}
    />}
    {viewer && <PageViewer
      title={viewer.title}
      pageUrls={viewer.pageUrls}
      initialPage={viewer.initialPage}
      sourceLabel="K-Hentai"
      onPageChange={saveProgress}
      onClose={closeViewer}
    />}
  </section>;
}

function scopeLabel(scope: CatalogScope): string {
  return scope === "bookmarked" ? "북마크만 보기" : "전체 보기";
}

function catalogSortLabel(sort: CatalogSort): string {
  return sort === "views" ? "조회순" : sort === "hotDay" ? "오늘 인기" : sort === "hotWeek" ? "주간 인기" : sort === "hotMonth" ? "월간 인기" : "최신순";
}

function localDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR");
}
