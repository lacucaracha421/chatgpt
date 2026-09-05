import { ArrowDownTrayIcon, ArrowPathIcon, BarsArrowDownIcon, ClockIcon, EyeIcon, EyeSlashIcon, FireIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ViewToolbar } from "../layout/ViewToolbar";
import { useLibrary } from "../library/LibraryContext";
import { catalogStreamStatus } from "../library/catalogStreams";
import { commandErrorMessage } from "../library/errorMessage";
import type {
  CatalogLanguage,
  CatalogGroupedPage,
  CatalogGroupedWork,
  CatalogScope,
  CatalogSort,
  CatalogStatus,
  CatalogSuggestion,
  CatalogWork,
  CatalogWorkDetail,
  CatalogWorkIdentity,
  RemoteReadingProgress,
} from "../library/types";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Menu } from "../shared/ui/Menu";
import { Select } from "../shared/ui/Select";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { PageViewer } from "./PageViewer";
import { CatalogEditionsDialog } from "./CatalogEditionsDialog";
import { OnlineCatalogCard } from "./OnlineCatalogCard";
import { OnlineCatalogDetailDialog } from "./OnlineCatalogDetailDialog";
import { catalogIdentityKey, catalogIdentityOf } from "./catalogIdentity";

const CATALOG_PAGE_SIZE = 48;

type OnlineCatalogBrowserProps = {
  onSwitchLocal: () => void;
};

export function MangaSourceTabs({ source, onlineScope = "all", onLocal, onOnline }: {
  source: "local" | "online";
  onlineScope?: CatalogScope;
  onLocal: () => void;
  onOnline: () => void;
}) {
  const onlineLabel = source === "online" && onlineScope === "bookmarked" ? "북마크" : "카탈로그";
  return <div className="manga-source-tabs" aria-label="망가 출처">
    <button type="button" aria-pressed={source === "online"} onClick={onOnline}>{onlineLabel}</button>
    <button type="button" aria-pressed={source === "local"} onClick={onLocal}>로컬</button>
  </div>;
}

export function OnlineCatalogBrowser({ onSwitchLocal }: OnlineCatalogBrowserProps) {
  const { gateway } = useLibrary();
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [results, setResults] = useState<CatalogGroupedPage | null>(null);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [editions, setEditions] = useState<CatalogGroupedWork | null>(null);
  const mounted = useRef(true);
  const refreshSearch = useRef<() => void>(() => {});
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState<CatalogLanguage>("korean");
  const languageRef = useRef<CatalogLanguage>("korean");
  const [sort, setSort] = useState<CatalogSort>("latest");
  const [scope, setScope] = useState<CatalogScope>("all");
  const [revealBlocked, setRevealBlocked] = useState(false);
  const [suggestions, setSuggestions] = useState<CatalogSuggestion[]>([]);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const suggestionsListboxId = useId();
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [openingWorkKey, setOpeningWorkKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<CatalogWorkDetail | null>(null);
  const [detailProgress, setDetailProgress] = useState<RemoteReadingProgress | null>(null);
  const [bookmarkPendingKeys, setBookmarkPendingKeys] = useState<Set<string>>(() => new Set());
  const [reading, setReading] = useState(false);
  const [viewer, setViewer] = useState<{
    title: string;
    provider: CatalogWorkIdentity["provider"];
    providerWorkId: string;
    pageCount: number;
    pageUrls: string[];
    initialPage: number;
  } | null>(null);
  const progressTimer = useRef<number | null>(null);
  const pendingProgress = useRef<RemoteReadingProgress | null>(null);
  const searchRequest = useRef(0);
  const suggestionRequest = useRef(0);
  const detailRequest = useRef(0);
  const bookmarkRequests = useRef(new Set<string>());
  const [message, setMessage] = useState<string | null>(null);
  useAutoDismiss(message, setMessage);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      searchRequest.current += 1;
      detailRequest.current += 1;
      if (progressTimer.current !== null) window.clearTimeout(progressTimer.current);
      if (pendingProgress.current) void gateway.saveRemoteReadingProgress(pendingProgress.current);
    };
  }, [gateway]);

  async function search(text: string, nextSort = sort, nextScope = scope, nextPage = 0, nextRevealBlocked = revealBlocked, nextLanguage = language) {
    if (!mounted.current) return;
    const request = ++searchRequest.current;
    setLoading(true);
    setTotalCount(null);
    setCountError(null);
    refreshSearch.current = () => { void search(text, nextSort, nextScope, nextPage, nextRevealBlocked, nextLanguage); };
    suggestionRequest.current += 1;
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
    try {
      await gateway.searchCatalogGroups({
        provider: "kHentai",
        language: nextLanguage,
        revealBlocked: nextRevealBlocked,
        text,
        sort: nextSort,
        scope: nextScope,
        page: nextPage,
        pageSize: CATALOG_PAGE_SIZE,
      }, (event) => {
        if (request !== searchRequest.current) return;
        if (event.type === "page") { setResults(event.page); setLoading(false); }
        else if (event.type === "count") {
          if (nextPage > 0 && nextPage * CATALOG_PAGE_SIZE >= event.totalCount) {
            void search(text, nextSort, nextScope, Math.max(0, Math.ceil(event.totalCount / CATALOG_PAGE_SIZE) - 1), nextRevealBlocked, nextLanguage);
            return;
          }
          setTotalCount(event.totalCount); setCountError(null);
        }
        else { setTotalCount(null); setCountError(event.message); }
      });
    } catch (error) {
      if (request === searchRequest.current) { setMessage(commandErrorMessage(error, "온라인 카탈로그 검색에 실패했습니다")); setCountError("결과 수를 불러오지 못했습니다"); }
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
    const request = ++suggestionRequest.current;
    const text = query.trim();
    if (!status?.installed || text.length < 1 || text.includes(":")) {
      setSuggestions([]);
      setActiveSuggestionIndex(-1);
      return;
    }
    const timer = window.setTimeout(() => {
      void gateway.suggestOnlineCatalog(text, 10).then((nextSuggestions) => {
        if (request !== suggestionRequest.current) return;
        setSuggestions(nextSuggestions);
        setActiveSuggestionIndex(-1);
      }).catch(() => {
        if (request !== suggestionRequest.current) return;
        setSuggestions([]);
        setActiveSuggestionIndex(-1);
      });
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

  function closeSuggestions() {
    suggestionRequest.current += 1;
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
  }

  function selectSuggestion(suggestion: CatalogSuggestion) {
    setQuery(suggestion.value);
    closeSuggestions();
    void search(suggestion.value);
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (suggestions.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestionIndex((current) => current >= suggestions.length - 1 ? 0 : current + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestionIndex((current) => current <= 0 ? suggestions.length - 1 : current - 1);
    } else if (event.key === "Enter" && activeSuggestionIndex >= 0) {
      event.preventDefault();
      selectSuggestion(suggestions[activeSuggestionIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSuggestions();
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    closeSuggestions();
    void search(query.trim());
  }

  async function openDetail(work: CatalogWork) {
    const request = ++detailRequest.current;
    const identity = catalogIdentityOf(work);
    setOpeningWorkKey(catalogIdentityKey(identity));
    try {
      const [nextDetail, progress] = await Promise.all([
        gateway.getOnlineCatalogWorkDetail(identity),
        gateway.getRemoteReadingProgress(identity),
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
      if (request === detailRequest.current) setOpeningWorkKey(null);
    }
  }

  function toggleRevealBlocked() {
    const next = !revealBlocked;
    setRevealBlocked(next);
    void search(query.trim(), sort, scope, 0, next);
  }

  async function bookmarkWork(identity: CatalogWorkIdentity, bookmarked: boolean) {
    const identityKey = catalogIdentityKey(identity);
    if (bookmarkRequests.current.has(identityKey)) return false;
    searchRequest.current += 1;
    setTotalCount(null);
    setCountError(null);
    bookmarkRequests.current.add(identityKey);
    setBookmarkPendingKeys(new Set(bookmarkRequests.current));
    try {
      await gateway.setOnlineCatalogBookmark(identity, bookmarked);
      if (!mounted.current) return false;
      setResults((current) => current && ({
        ...current,
        works: current.works.map((work) => catalogIdentityKey(work) === identityKey ? { ...work, bookmarked } : work),
      }));
      setDetail((current) => current && catalogIdentityKey(current) === identityKey ? { ...current, bookmarked } : current);
      refreshSearch.current();
      return true;
    } catch {
      if (!mounted.current) return false;
      setMessage("북마크를 변경하지 못했습니다");
      refreshSearch.current();
      return false;
    } finally {
      bookmarkRequests.current.delete(identityKey);
      if (mounted.current) setBookmarkPendingKeys(new Set(bookmarkRequests.current));
    }
  }

  async function bookmarkDetail(bookmarked: boolean) {
    if (!detail) return;
    await bookmarkWork(catalogIdentityOf(detail), bookmarked);
  }

  async function readDetail() {
    if (!detail || reading) return;
    const request = ++detailRequest.current;
    const selectedDetail = detail;
    const selectedProgress = detailProgress;
    setReading(true);
    try {
      const gallery = await gateway.resolveOnlineCatalogWork(catalogIdentityOf(selectedDetail));
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
    setOpeningWorkKey(null);
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
      providerWorkId: viewer.providerWorkId,
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
    const updateLanguage = language;
    setUpdating(true);
    try {
      const currentStream = status ? catalogStreamStatus(status, updateLanguage) : null;
      const result = updateLanguage === "korean"
        ? await gateway.updateOnlineCatalog()
        : await gateway.updateOnlineCatalog("japanese", currentStream?.initialComplete ? 40 : 1);
      const next = await gateway.getOnlineCatalogStatus();
      setStatus(next);
      if (result.added > 0 && languageRef.current === updateLanguage) {
        await search(query.trim(), sort, scope, 0, revealBlocked, updateLanguage);
      }
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
        <MangaSourceTabs
          source="online"
          onlineScope={scope}
          onLocal={() => { closeDetail(); closeViewer(); onSwitchLocal(); }}
          onOnline={() => {
            const nextScope: CatalogScope = scope === "all" ? "bookmarked" : "all";
            setScope(nextScope);
            void search(query.trim(), sort, nextScope, 0);
          }}
        />
        <Select
          label="카탈로그 언어"
          value={language}
          disabled={loading}
          onChange={(event) => {
            const nextLanguage = event.target.value as CatalogLanguage;
            languageRef.current = nextLanguage;
            setLanguage(nextLanguage);
            setResults(null);
            void search(query.trim(), sort, scope, 0, revealBlocked, nextLanguage);
          }}
        >
          <option value="korean">한국어</option>
          <option value="japanese">일본어</option>
        </Select>
        <span className="manga-browser__count">{totalCount !== null ? `${totalCount.toLocaleString()}개 결과` : status?.installed ? countError ? "결과 수 확인 실패" : "결과 수 계산 중…" : ""}</span>
        {status?.installed && <form className="manga-browser__search online-catalog__search" role="search" onSubmit={submit}>
          <MagnifyingGlassIcon aria-hidden="true" />
          <input
            type="search"
            role="combobox"
            aria-label="온라인 만화 검색"
            aria-autocomplete="list"
            aria-expanded={suggestions.length > 0}
            aria-controls={suggestions.length > 0 ? suggestionsListboxId : undefined}
            aria-activedescendant={activeSuggestionIndex >= 0 ? `${suggestionsListboxId}-option-${activeSuggestionIndex}` : undefined}
            placeholder={`제목 또는 ${language === "korean" ? "한국어" : "일본어"} 태그 검색`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSuggestions([]);
              setActiveSuggestionIndex(-1);
            }}
            onKeyDown={handleSearchKeyDown}
            onBlur={closeSuggestions}
          />
          {suggestions.length > 0 && <div id={suggestionsListboxId} className="online-catalog__suggestions" role="listbox" aria-label="검색 제안">
            {suggestions.map((suggestion, index) => <button
              id={`${suggestionsListboxId}-option-${index}`}
              key={suggestion.value}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={activeSuggestionIndex === index}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveSuggestionIndex(index)}
              onClick={() => selectSuggestion(suggestion)}
            >
              <span>{suggestion.label}</span><small>{suggestion.value} · {suggestion.count.toLocaleString()}</small>
            </button>)}
          </div>}
        </form>}
      </>}
      actions={status?.installed ? <>
        <Button size="icon" variant={revealBlocked ? "primary" : "ghost"} title="숨긴 결과 표시" aria-label="숨긴 결과 표시" aria-pressed={revealBlocked} disabled={loading} onClick={toggleRevealBlocked}><EyeSlashIcon aria-hidden="true" /></Button>
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
        <Button size="icon" variant="ghost" title="새로고침" aria-label="새로고침" disabled={loading} onClick={() => refreshSearch.current()}><ArrowPathIcon aria-hidden="true" /></Button>
      </> : undefined}
    />
    {status?.installed && <div className="online-catalog__sync-summary">
      {revealBlocked && <span className="online-catalog__visibility-status" role="status">숨긴 분류와 차단 태그를 표시 중입니다</span>}
      {catalogStreamStatus(status, language).lastError ? <span className="online-catalog__sync-status" role="alert">마지막 갱신 실패 — {catalogStreamStatus(status, language).lastError}</span>
        : catalogStreamStatus(status, language).lastProgressAt ? <span className="online-catalog__sync-status">마지막 갱신 {localDateTime(catalogStreamStatus(status, language).lastProgressAt!)}{catalogStreamStatus(status, language).lastAdded > 0 ? ` · 신규 ${catalogStreamStatus(status, language).lastAdded.toLocaleString()}개` : ""}</span>
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
            key={`${work.provider}:${work.groupId}`}
            work={work}
            opening={openingWorkKey === catalogIdentityKey(work)}
            bookmarkPending={bookmarkPendingKeys.has(catalogIdentityKey(work))}
            onEditions={setEditions}
            onOpen={(selected) => void openDetail(selected)}
            onBookmark={(identity, bookmarked) => void bookmarkWork(identity, bookmarked)}
          />)}
        </div>}
    </div>
    {results && <footer className="online-catalog__pagination" aria-busy={loading || totalCount === null}>
      <span>{totalCount === null ? countError ? "결과 수를 확인하지 못했습니다" : "페이지 표시 중" : totalCount === 0 ? "0 / 0" : `${(results.page * results.pageSize + 1).toLocaleString()}–${Math.min(totalCount, (results.page + 1) * results.pageSize).toLocaleString()} / ${totalCount.toLocaleString()}`}{loading && <em className="online-catalog__pagination-loading" role="status"> · 불러오는 중…</em>}</span>
      <div>
        <Button size="sm" disabled={loading || totalCount === null || results.page === 0} onClick={() => void search(query.trim(), sort, scope, results.page - 1)}>이전 결과</Button>
        <Button size="sm" disabled={loading || totalCount === null || (results.page + 1) * results.pageSize >= totalCount} onClick={() => void search(query.trim(), sort, scope, results.page + 1)}>다음 결과</Button>
      </div>
    </footer>}
    {editions && <CatalogEditionsDialog work={editions} language={language} revealBlocked={revealBlocked}
      onClose={() => setEditions(null)} onOpen={(work) => { setEditions(null); void openDetail(work); }}
      onRepresentativeChange={() => refreshSearch.current()} />}
    {detail && <OnlineCatalogDetailDialog
      detail={detail}
      progress={detailProgress}
      bookmarkPending={bookmarkPendingKeys.has(catalogIdentityKey(detail))}
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

function catalogSortLabel(sort: CatalogSort): string {
  return sort === "views" ? "조회순" : sort === "hotDay" ? "오늘 인기" : sort === "hotWeek" ? "주간 인기" : sort === "hotMonth" ? "월간 인기" : "최신순";
}

function localDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR");
}
