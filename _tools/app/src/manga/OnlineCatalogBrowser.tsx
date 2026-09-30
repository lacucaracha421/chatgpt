import { EllipsisHorizontalIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useWorkspaceChrome } from "../layout/WorkspaceChromeContext";
import { SearchSurface } from "../layout/SearchSurface";
import { ChromeQueryBadge } from "../layout/ChromeSearch";
import { Menu } from "../shared/ui/Menu";
import { useLibrary } from "../library/LibraryContext";
import { CATALOG_BOOKMARKS_CHANGED_EVENT } from "../app/useCatalogBookmarkSync";
import { catalogStreamStatus, latestCatalogUpdate } from "../library/catalogStreams";
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
} from "../library/types";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { PageViewer } from "./PageViewer";
import { CatalogEditionsDialog } from "./CatalogEditionsDialog";
import { CatalogReviewDialog } from "./CatalogReviewDialog";
import { OnlineCatalogCard } from "./OnlineCatalogCard";
import { OnlineCatalogDetailDialog } from "./OnlineCatalogDetailDialog";
import { catalogIdentityKey, catalogIdentityOf } from "./catalogIdentity";
import { MangaSkeletonGrid } from "./MangaCard";
import { MangaToolbar, MangaChoiceMenu, type MangaSource } from "./MangaToolbar";
import { displayDateTime } from "../shared/displayDate";

const CATALOG_PAGE_SIZE = 48;

type OnlineCatalogBrowserProps = {
  onSwitchLocal: () => void;
  initialScope?: CatalogScope;
  requestedSource?: MangaSource;
  active?: boolean;
  onSourceChange?: (source: MangaSource) => void;
  onReady?: (scope: CatalogScope) => void;
  localCount?: number;
  bookmarkCount?: number;
  onBookmarkCount?: (count: number | undefined) => void;
};

export function OnlineCatalogBrowser({ onSwitchLocal, initialScope = "all", requestedSource, active = true, onSourceChange, onReady, localCount, bookmarkCount, onBookmarkCount }: OnlineCatalogBrowserProps) {
  const { gateway } = useLibrary();
  const workspace = useWorkspaceChrome();
  const [searchOpen, setSearchOpen] = useState(false);
  const [appliedQuery, setAppliedQuery] = useState("");
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [results, setResults] = useState<CatalogGroupedPage | null>(null);
  const gridScroll = useRef<HTMLDivElement>(null);
  const displayedOrder = useRef<{ page: number; sort: CatalogSort } | null>(null);
  const resetGridScroll = useRef(false);
  useLayoutEffect(() => {
    if (resetGridScroll.current && gridScroll.current) gridScroll.current.scrollTop = 0;
    resetGridScroll.current = false;
  }, [results]);
  const [knownBookmarkCount, setKnownBookmarkCount] = useState<number | undefined>();
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [editions, setEditions] = useState<CatalogGroupedWork | null>(null);
  const mounted = useRef(true);
  const refreshSearch = useRef<(quiet?: boolean) => Promise<boolean>>(async () => false);
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState<CatalogLanguage>("korean");
  const languageRef = useRef<CatalogLanguage>("korean");
  const [sort, setSort] = useState<CatalogSort>(initialScope === "bookmarked" ? "latest" : "hotDay");
  const [scope, setScope] = useState<CatalogScope>(initialScope);
  const [revealBlocked, setRevealBlocked] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<CatalogSuggestion[]>([]);
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1);
  const suggestionsListboxId = useId();
  const [loading, setLoading] = useState(false);
  const [quietRefresh, setQuietRefresh] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [openingWorkKey, setOpeningWorkKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<CatalogWorkDetail | null>(null);
  const [detailGroup, setDetailGroup] = useState<CatalogGroupedWork | null>(null);
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
  const searchRequest = useRef(0);
  const suggestionRequest = useRef(0);
  const detailRequest = useRef(0);
  const bookmarkRequests = useRef(new Set<string>());
  const [message, setMessage] = useState<string | null>(null);
  useAutoDismiss(message, setMessage);
  const latestUpdate = status?.installed ? latestCatalogUpdate(status) : null;
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    if (status && !status.installed) onReady?.(scope);
  }, [status, scope, onReady]);
  useEffect(() => {
    if (!requestedSource || requestedSource === "local" || requestedSource === scope) return;
    const nextSort = requestedSource === "bookmarked" ? "latest" : sort;
    setScope(requestedSource); setSort(nextSort);
    if (status?.installed) void search(query.trim(), nextSort, requestedSource);
    // The selected source owns scope; all accepted pages report their own scope back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedSource]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      searchRequest.current += 1;
      void gateway.cancelCatalogSearch?.();
      detailRequest.current += 1;
    };
  }, [gateway]);

  async function search(text: string, nextSort = sort, nextScope = scope, nextPage = 0, nextRevealBlocked = revealBlocked, nextLanguage = language, quiet = false) {
    if (!mounted.current) return false;
    setAppliedQuery(text);
    setSearchOpen(false);
    const request = ++searchRequest.current;
    setLoading(!quiet);
    setQuietRefresh(quiet);
    if (!quiet) setTotalCount(null);
    setCountError(null);
    refreshSearch.current = (quiet = false) => search(text, nextSort, nextScope, nextPage, nextRevealBlocked, nextLanguage, quiet);
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
        if (event.type === "page") {
          const previous = displayedOrder.current;
          resetGridScroll.current = !quiet && (!previous || previous.page !== event.page.page || previous.sort !== nextSort);
          displayedOrder.current = { page: event.page.page, sort: nextSort };
          setResults(event.page); setLoading(false); setLoadError(false);
          onReady?.(nextScope);
        }
        else if (event.type === "count") {
          if (nextPage > 0 && nextPage * CATALOG_PAGE_SIZE >= event.totalCount) {
            void search(text, nextSort, nextScope, Math.max(0, Math.ceil(event.totalCount / CATALOG_PAGE_SIZE) - 1), nextRevealBlocked, nextLanguage, quiet);
            return;
          }
          setTotalCount(event.totalCount); setCountError(null);
          if (nextScope === "bookmarked" && !text && !nextRevealBlocked) { setKnownBookmarkCount(event.totalCount); onBookmarkCount?.(event.totalCount); }
        }
        else { setTotalCount(null); setCountError(event.message); }
      });
      return request === searchRequest.current;
    } catch (error) {
      if (request === searchRequest.current) { setMessage(commandErrorMessage(error, "온라인 카탈로그 검색에 실패했습니다")); setCountError("결과 수를 불러오지 못했습니다"); setLoadError(true); onReady?.(nextScope); }
      return false;
    } finally {
      if (request === searchRequest.current) setLoading(false);
    }
  }

  const initialSearch = useRef(() => search(""));
  initialSearch.current = () => search("");
  useEffect(() => {
    let active = true;
    void gateway.getOnlineCatalogStatus().then((next) => {
      if (!active) return;
      setStatus(next);
      if (next.installed) void initialSearch.current();
    }).catch(() => { if (active) { setMessage("온라인 카탈로그 상태를 불러오지 못했습니다"); setLoadError(true); onReady?.(requestedSource === "bookmarked" ? "bookmarked" : "all"); } });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway]);

  useEffect(() => {
    const refreshBookmarks = () => {
      setKnownBookmarkCount(undefined); onBookmarkCount?.(undefined);
      void refreshSearch.current(true);
      if (!detail) return;
      const request = ++detailRequest.current;
      const identity = catalogIdentityOf(detail);
      void gateway.getOnlineCatalogWorkDetail(identity).then((next) => {
        if (mounted.current && request === detailRequest.current) setDetail(next);
      }).catch(() => undefined);
    };
    window.addEventListener(CATALOG_BOOKMARKS_CHANGED_EVENT, refreshBookmarks);
    return () => window.removeEventListener(CATALOG_BOOKMARKS_CHANGED_EVENT, refreshBookmarks);
  }, [gateway, detail, onBookmarkCount]);

  useEffect(() => {
    const request = ++suggestionRequest.current;
    const text = query.trim();
    // `artist:asa` and the short `a:asa` are suggested too; the library matches the
    // namespace:value text and expands the short namespace.
    if (!status?.installed || text.length < 1) {
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

  useEffect(() => {
    // The list shows about four rows; arrow keys keep the active option in view.
    if (activeSuggestionIndex < 0) return;
    document.getElementById(`${suggestionsListboxId}-option-${activeSuggestionIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeSuggestionIndex, suggestionsListboxId]);

  async function importCatalog() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    setLoading(true);
    try {
      const next = await gateway.importVckCatalog(selected);
      setStatus(next);
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

  /** `group` is the search result the work came from; its edition count shows in the detail. */
  async function openDetail(work: CatalogWork, group: CatalogGroupedWork | null = null) {
    const request = ++detailRequest.current;
    setDetailGroup(group);
    const identity = catalogIdentityOf(work);
    setOpeningWorkKey(catalogIdentityKey(identity));
    try {
      const nextDetail = await gateway.getOnlineCatalogWorkDetail(identity);
      if (request === detailRequest.current) setDetail(nextDetail);
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
    setCountError(null);
    bookmarkRequests.current.add(identityKey);
    setBookmarkPendingKeys(new Set(bookmarkRequests.current));
    setKnownBookmarkCount(undefined); onBookmarkCount?.(undefined);
    try {
      await gateway.setOnlineCatalogBookmark(identity, bookmarked);
      if (!mounted.current) return false;
      // Group bookmark flags must arrive together from the authoritative page.
      // Updating only the representative briefly invents a saved-other-edition state.
      setDetail((current) => current && catalogIdentityKey(current) === identityKey ? { ...current, bookmarked } : current);
      await refreshSearch.current(true);
      return true;
    } catch {
      if (!mounted.current) return false;
      setMessage("북마크를 변경하지 못했습니다");
      await refreshSearch.current(true);
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
    setReading(true);
    try {
      const gallery = await gateway.resolveOnlineCatalogWork(catalogIdentityOf(selectedDetail));
      if (request !== detailRequest.current) return;
      setViewer({ title: selectedDetail.title, ...gallery, initialPage: 1 });
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
  }

  function searchTag(nextQuery: string) {
    closeDetail();
    setQuery(nextQuery);
    void search(nextQuery, sort, scope, 0);
  }

  function closeViewer() { setViewer(null); }

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
      if (result.reason !== "rateLimited" && result.reason !== "alreadyRunning") setRefreshedAt(new Date().toISOString());
      if (result.reason === "alreadyRunning") setMessage("카탈로그 갱신이 이미 진행 중입니다");
      if (result.reason === "rateLimited") setMessage("요청이 제한되었습니다. 잠시 후 다시 시도하세요");
    } catch (error) {
      setMessage(commandErrorMessage(error, "온라인 카탈로그를 갱신하지 못했습니다"));
    } finally {
      setUpdating(false);
    }
  }

  function selectSource(next: MangaSource) {
    if (next === "local") { closeDetail(); closeViewer(); onSwitchLocal(); return; }
    onSourceChange?.(next);
    if (next === scope) return;
    const nextSort = next === "bookmarked" ? "latest" : sort;
    setScope(next); setSort(nextSort);
    void search(query.trim(), nextSort, next, 0);
  }
  const catalogControls = status?.installed ? <>
    <MangaChoiceMenu label="언어" value={language} options={[{ value: "korean", label: "한국어" }, { value: "japanese", label: "일본어" }]} onChange={nextLanguage => {
      languageRef.current = nextLanguage; setLanguage(nextLanguage);
      setKnownBookmarkCount(undefined); onBookmarkCount?.(undefined);
      void search(query.trim(), sort, scope, 0, revealBlocked, nextLanguage);
    }} />
    <MangaChoiceMenu label="정렬" value={sort} options={[
      { value: "latest", label: "최신순" }, { value: "views", label: "조회순" }, { value: "hotDay", label: "오늘 인기" }, { value: "hotWeek", label: "주간 인기" }, { value: "hotMonth", label: "월간 인기" },
    ]} onChange={nextSort => { setSort(nextSort); void search(appliedQuery, nextSort, scope, 0); }} />
  </> : undefined;
  // Rarely used catalog actions share one overflow menu in the top bar; the catalog also refreshes hourly on its own.
  const catalogMenu = status?.installed ? <Menu label="카탈로그 더보기" trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={[
    { id: "reveal", label: "숨긴 결과 표시", checked: revealBlocked, disabled: loading, onSelect: toggleRevealBlocked },
    { id: "update", label: updating ? "갱신 중…" : "신규 작품 갱신", disabled: updating, onSelect: () => void updateCatalog() },
    { id: "review", label: "중복 후보 검토", onSelect: () => setReviewOpen(true) },
  ]} /> : undefined;
  const searchForm = (status?.installed && <form className="manga-browser__search online-catalog__search" role="search" onSubmit={submit}>
          <MagnifyingGlassIcon aria-hidden="true" />
          <input
            type="search"
            autoFocus={Boolean(workspace)}
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
        </form>);

  const searchScope = scope === "bookmarked" ? "망가 북마크" : "온라인 카탈로그";
  return <section className="manga-browser online-catalog" aria-label="온라인 망가">
    {active && <MangaToolbar source={requestedSource ?? scope} onSourceChange={selectSource} localCount={localCount} bookmarkCount={bookmarkCount ?? knownBookmarkCount}
      countLabel={totalCount !== null ? `${totalCount.toLocaleString()}개 결과` : status?.installed ? countError ? "결과 수 확인 실패" : "결과 수 계산 중…" : undefined}
      controls={catalogControls} refreshedAt={refreshedAt ?? latestUpdate} refreshing={loading} onRefresh={status?.installed ? () => { void refreshSearch.current().then(success => { if (success) setRefreshedAt(new Date().toISOString()); }); } : undefined}
      ariaLabel="온라인 망가 도구" actions={catalogMenu} chrome={{
        summary: `${catalogSortLabel(sort)} · ${language === "korean" ? "한국어" : "일본어"}${revealBlocked ? " · 숨김 포함" : ""}`,
        status: <ChromeQueryBadge search={{ scope: "온라인 카탈로그", label: "온라인 만화 검색", query: appliedQuery, onApply: (text) => { setQuery(text); void search(text); } }} />,
        searchSurface: status?.installed ? {
          scope: searchScope, label: "온라인 만화 검색", query: appliedQuery, onApply: (text) => { setQuery(text); void search(text); },
          // The 찾기 palette passes what the user typed there as the starting draft.
          open: (draft) => { setQuery(draft.trim() || appliedQuery); setSearchOpen(true); },
          content: <SearchSurface label="온라인 만화 검색" scope={searchScope} active={Boolean(appliedQuery)} open={searchOpen}
            onOpen={() => { setQuery(appliedQuery); setSearchOpen(true); }} onClose={() => { setSearchOpen(false); setQuery(appliedQuery); closeSuggestions(); }}>
            {searchForm}<div className="ui-dialog__actions"><Button type="button" variant="ghost" onClick={() => { setSearchOpen(false); setQuery(appliedQuery); closeSuggestions(); }}>취소</Button><Button type="button" variant="primary" onClick={() => { closeSuggestions(); void search(query.trim()); }}>검색</Button></div>
          </SearchSurface>,
        } : undefined,
      }}
    />}
    {status?.installed && <div className="online-catalog__sync-summary">
      {reviewOpen && <CatalogReviewDialog onClose={() => setReviewOpen(false)} onChange={async () => { await refreshSearch.current(); }} />}
      {revealBlocked && <span className="online-catalog__visibility-status" role="status">숨긴 분류와 차단 태그를 표시 중입니다</span>}
      {catalogStreamStatus(status, language).lastError ? <span className="online-catalog__sync-status" role="alert">마지막 갱신 실패 — {catalogStreamStatus(status, language).lastError}</span>
        : !workspace && catalogStreamStatus(status, language).lastProgressAt ? <span className="online-catalog__sync-status">마지막 갱신 {displayDateTime(catalogStreamStatus(status, language).lastProgressAt!)}{catalogStreamStatus(status, language).lastAdded > 0 ? ` · 신규 ${catalogStreamStatus(status, language).lastAdded.toLocaleString()}개` : ""}</span>
        : !workspace && <span className="online-catalog__sync-status">아직 갱신 기록이 없습니다</span>}
    </div>}
    {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
    <div ref={gridScroll} className="manga-browser__content online-catalog__content" inert={loading || requestedSource === "local"}>
      {loadError && !results ? <EmptyState title="온라인 카탈로그를 불러오지 못했습니다" />
        : !status ? <MangaSkeletonGrid />
        : !status.installed ? <EmptyState title="온라인 카탈로그가 없습니다">
          <p>기존 VCK 폴더의 데이터를 한 번 가져오면 Lakomics에서 독립적으로 사용할 수 있습니다.</p>
          <Button onClick={() => void importCatalog()} disabled={loading}>VCK 데이터 가져오기</Button>
        </EmptyState>
        : loading && !results ? <MangaSkeletonGrid />
        : results?.works.length === 0 ? <EmptyState title="검색 결과가 없습니다">다른 제목이나 태그로 검색하세요.</EmptyState>
        : <div className="manga-grid">
          {results?.works.map((work) => <OnlineCatalogCard
            key={`${work.provider}:${work.groupId}`}
            work={work}
            opening={openingWorkKey === catalogIdentityKey(work)}
            bookmarkPending={bookmarkPendingKeys.has(catalogIdentityKey(work))}
            onOpen={(selected) => void openDetail(selected, work)}
            onBookmark={(identity, bookmarked) => void bookmarkWork(identity, bookmarked)}
          />)}
        </div>}
    </div>
    {results && <footer className="online-catalog__pagination" aria-busy={loading || totalCount === null}>
      <span>{totalCount === null ? countError ? "결과 수를 확인하지 못했습니다" : "페이지 표시 중" : totalCount === 0 ? "0 / 0" : `${(results.page * results.pageSize + 1).toLocaleString()}–${Math.min(totalCount, (results.page + 1) * results.pageSize).toLocaleString()} / ${totalCount.toLocaleString()}`}{loading && !quietRefresh && <em className="online-catalog__pagination-loading" role="status"> · 불러오는 중…</em>}</span>
      <div>
        <Button size="sm" disabled={loading || totalCount === null || results.page === 0} onClick={() => void search(query.trim(), sort, scope, results.page - 1)}>이전 결과</Button>
        <Button size="sm" disabled={loading || totalCount === null || (results.page + 1) * results.pageSize >= totalCount} onClick={() => void search(query.trim(), sort, scope, results.page + 1)}>다음 결과</Button>
      </div>
    </footer>}
    {editions && <CatalogEditionsDialog work={editions} language={language} revealBlocked={revealBlocked}
      onClose={() => setEditions(null)} onOpen={(work) => { const group = editions; setEditions(null); void openDetail(work, group); }}
      onRepresentativeChange={async () => { await refreshSearch.current(); }} />}
    {detail && <OnlineCatalogDetailDialog
      detail={detail}
      bookmarkPending={bookmarkPendingKeys.has(catalogIdentityKey(detail))}
      reading={reading}
      onBookmark={(bookmarked) => void bookmarkDetail(bookmarked)}
      onTagSearch={searchTag}
      onRead={() => void readDetail()}
      editionCount={detailGroup?.versionCount ?? 0}
      onEditions={() => { const group = detailGroup; closeDetail(); if (group) setEditions(group); }}
      onClose={closeDetail}
    />}
    {viewer && <PageViewer
      title={viewer.title}
      pageUrls={viewer.pageUrls}
      initialPage={viewer.initialPage}
      sourceLabel="K-Hentai"
      onRetryPage={async () => {
        const owner = viewer;
        const gallery = await gateway.resolveOnlineCatalogWork({ provider: owner.provider, providerWorkId: owner.providerWorkId });
        setViewer(current => current === owner ? { ...current, pageUrls: gallery.pageUrls } : current);
      }}
      onClose={closeViewer}
    />}
  </section>;
}

function catalogSortLabel(sort: CatalogSort): string {
  return sort === "views" ? "조회순" : sort === "hotDay" ? "오늘 인기" : sort === "hotWeek" ? "주간 인기" : sort === "hotMonth" ? "월간 인기" : "최신순";
}
