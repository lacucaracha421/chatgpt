import { Scrubber } from "../shared/ui/scrubber/Scrubber";
import type { ScrubberSort } from "../shared/ui/scrubber/scrubberModel";
import { EllipsisHorizontalIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useWorkspaceChrome } from "../layout/WorkspaceChromeContext";
import { SearchSurface } from "../layout/SearchSurface";
import { ChromeQueryBadge } from "../layout/ChromeSearch";
import { Menu } from "../shared/ui/Menu";
import { useLibrary } from "../library/LibraryContext";
import { CATALOG_BOOKMARKS_CHANGED_EVENT } from "../app/useCatalogBookmarkSync";
import { catalogStreamStatus, latestCatalogUpdate } from "../library/catalogStreams";
import { commandErrorMessage } from "../library/errorMessage";
import { nativeMediaUrl } from "../assets/mediaUrl";
import { useCatalogMasked } from "../privacy/catalogMask";
import type {
  CatalogLanguage,
  CatalogGroupedPage,
  CatalogGroupedSearchEvent,
  CatalogGroupedWork,
  CatalogGroupEditionsPage,
  CatalogGroupEditionsQuery,
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
import { MangaDetail } from "./MangaDetail";
import { OverlayPanel } from "../shared/ui/OverlayPanel";
import { catalogIdentityKey, catalogIdentityOf } from "./catalogIdentity";
import { MangaSkeletonGrid } from "./MangaCard";
import { MangaToolbar, MangaChoiceMenu, type MangaSource } from "./MangaToolbar";
import { MangaIndexToken } from "./MangaIndex";
import { mangaIndexQuery, withMangaIndexQuery } from "./mangaIndexModel";
import type { MangaIndexIdentity } from "../library/types";
import { displayDateTime } from "../shared/displayDate";

const CATALOG_PAGE_SIZE = 48;

type CatalogView = { indexQuery: string; text: string; sort: CatalogSort; scope: CatalogScope; revealBlocked: boolean; language: CatalogLanguage };
/** Every page loaded so far for one view, in order, without repeating a group. */
type CatalogList = { works: CatalogGroupedWork[]; pages: number; complete: boolean };
type PageStream = { first: Promise<CatalogGroupedPage | null>; done: Promise<void> };

function viewKey(view: CatalogView | null): string {
  return view ? JSON.stringify([view.text, view.indexQuery, view.sort, view.scope, view.revealBlocked, view.language]) : "";
}

function appendWorks(current: CatalogGroupedWork[], next: CatalogGroupedWork[]): CatalogGroupedWork[] {
  // Rows can shift between page requests (new uploads, bookmark removals); a group is shown once.
  const seen = new Set(current.map(work => `${work.provider}:${work.groupId}`));
  return [...current, ...next.filter(work => !seen.has(`${work.provider}:${work.groupId}`))];
}

type OnlineCatalogBrowserProps = {
  indexFilter?: MangaIndexIdentity | null;
  onClearIndexFilter?: () => void;
  onBookmarksChanged?: () => void;
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

export function OnlineCatalogBrowser({ indexFilter = null, onClearIndexFilter, onBookmarksChanged, onSwitchLocal, initialScope = "all", requestedSource, active = true, onSourceChange, onReady, localCount, bookmarkCount, onBookmarkCount }: OnlineCatalogBrowserProps) {
  const { gateway } = useLibrary();
  const privacyMode = useCatalogMasked();
  const workspace = useWorkspaceChrome();
  const [searchOpen, setSearchOpen] = useState(false);
  const [appliedQuery, setAppliedQuery] = useState("");
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [results, setResults] = useState<CatalogList | null>(null);
  const gridScroll = useRef<HTMLDivElement>(null);
  const moreSentinel = useRef<HTMLDivElement>(null);
  const displayedView = useRef<CatalogView | null>(null);
  const loadedPages = useRef(0);
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
  // Any search (quiet refresh included) still fetching its pages; appending waits for it.
  const [searchPending, setSearchPending] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [openingWorkKey, setOpeningWorkKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<CatalogWorkDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailGroup, setDetailGroup] = useState<CatalogGroupedWork | null>(null);
  const [detailEditions, setDetailEditions] = useState<CatalogGroupEditionsPage | null>(null);
  const [editionsLoading, setEditionsLoading] = useState(false);
  const [editionsError, setEditionsError] = useState(false);
  const editionQuery = useRef<CatalogGroupEditionsQuery | null>(null);
  const editionRequest = useRef(0);
  const detailReturnFocus = useRef<HTMLElement | null>(null);
  const panelHost = useRef<HTMLDivElement>(null);
  const [bookmarkPendingKeys, setBookmarkPendingKeys] = useState<Set<string>>(() => new Set());
  const [reading, setReading] = useState(false);
  const [viewer, setViewer] = useState<{
    title: string;
    provider: CatalogWorkIdentity["provider"];
    providerWorkId: string;
    pageCount: number;
    pageUrls: string[];
    initialPage: number;
    artist: string | null;
  } | null>(null);
  const searchRequest = useRef(0);
  const activeSearchId = useRef<string | null>(null);
  const suggestionRequest = useRef(0);
  const detailRequest = useRef(0);
  const readRequest = useRef(0);
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
      if (activeSearchId.current) void gateway.cancelCatalogSearch?.(activeSearchId.current);
      activeSearchId.current = null;
      detailRequest.current += 1;
      editionRequest.current += 1;
      readRequest.current += 1;
    };
  }, [gateway]);

  function applyCount(event: Extract<CatalogGroupedSearchEvent, { type: "count" | "countError" }>, view: CatalogView) {
    if (event.type === "countError") { setTotalCount(null); setCountError(event.message); return; }
    setTotalCount(event.totalCount); setCountError(null);
    if (view.scope === "bookmarked" && !view.text && !view.revealBlocked) { setKnownBookmarkCount(event.totalCount); onBookmarkCount?.(event.totalCount); }
  }

  /** `first` follows page delivery; `done` follows command completion, which can precede delivery. */
  function streamPage(view: CatalogView, page: number, request: number): PageStream {
    let deliver: (page: CatalogGroupedPage | null) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const delivered = new Promise<CatalogGroupedPage | null>((resolve, rejectPage) => { deliver = resolve; reject = rejectPage; });
    const searchId = crypto.randomUUID();
    activeSearchId.current = searchId;
    const done = gateway.searchCatalogGroups({
      provider: "kHentai",
      language: view.language,
      revealBlocked: view.revealBlocked,
      text: withMangaIndexQuery(view.text, view.indexQuery),
      sort: view.sort,
      scope: view.scope,
      page,
      pageSize: CATALOG_PAGE_SIZE,
    }, (event) => {
      if (event.type === "end") {
        deliver(null);
        if (activeSearchId.current === searchId) activeSearchId.current = null;
        return;
      }
      if (request !== searchRequest.current) return;
      if (event.type === "page") deliver(event.page);
      else applyCount(event, view);
    }, searchId);
    // Tauri fetches large channel payloads asynchronously. A successful invocation
    // does not mean its page has arrived; end settles a stream with no page.
    void done.catch(reject);
    return { first: delivered, done };
  }

  /** Load a view from its first page. A refresh passes the number of pages shown, so appended cards keep their place. */
  async function search(text: string, nextSort = sort, nextScope = scope, nextRevealBlocked = revealBlocked, nextLanguage = language, quiet = false, pages = 1) {
    if (!mounted.current) return false;
    setAppliedQuery(text);
    setSearchOpen(false);
    const request = ++searchRequest.current;
    const view: CatalogView = { indexQuery: mangaIndexQuery(indexFilter), text, sort: nextSort, scope: nextScope, revealBlocked: nextRevealBlocked, language: nextLanguage };
    setLoading(!quiet);
    setSearchPending(true);
    setLoadingMore(false);
    setLoadMoreFailed(false);
    if (!quiet) setTotalCount(null);
    setCountError(null);
    refreshSearch.current = (quiet = false) => search(text, nextSort, nextScope, nextRevealBlocked, nextLanguage, quiet, Math.max(1, loadedPages.current));
    suggestionRequest.current += 1;
    setSuggestions([]);
    setActiveSuggestionIndex(-1);
    let committed = false;
    try {
      let works: CatalogGroupedWork[] = [];
      let loaded = 0;
      let complete = false;
      let stream: PageStream | null = null;
      // Each next request supersedes the previous page's count natively; only the last count matters.
      for (let page = 0; page < pages && !complete; page += 1) {
        stream = streamPage(view, page, request);
        const next = await stream.first;
        if (request !== searchRequest.current) return false;
        if (!next) break;
        works = appendWorks(works, next.works);
        loaded = page + 1;
        complete = next.works.length < next.pageSize;
      }
      if (loaded > 0) {
        // The old cards stay (inert) until this moment, then the whole list swaps at once; a new view
        // or a shorter reload starts at the top, a refresh in place keeps the scroll position.
        resetGridScroll.current = !quiet && (viewKey(displayedView.current) !== viewKey(view) || loaded < loadedPages.current);
        displayedView.current = view;
        loadedPages.current = loaded;
        setResults({ works, pages: loaded, complete });
        setLoading(false); setSearchPending(false); setLoadError(false);
        committed = true;
        onReady?.(nextScope);
      }
      await stream?.done;
      return committed;
    } catch (error) {
      if (request === searchRequest.current) { setMessage(commandErrorMessage(error, "온라인 카탈로그 검색에 실패했습니다")); setCountError("결과 수를 불러오지 못했습니다"); setLoadError(true); onReady?.(nextScope); }
      return false;
    } finally {
      if (request === searchRequest.current) { setLoading(false); setSearchPending(false); }
    }
  }

  /** Append the next page of the shown view. Its stream also carries the view's count. */
  async function loadMore() {
    const view = displayedView.current;
    if (!mounted.current || !view || !results || results.complete || searchPending || loadingMore) return;
    const request = ++searchRequest.current;
    const page = results.pages;
    let appended = false;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    try {
      const stream = streamPage(view, page, request);
      const next = await stream.first;
      if (request !== searchRequest.current) return;
      if (next) {
        appended = true;
        loadedPages.current = page + 1;
        setResults(current => current && { works: appendWorks(current.works, next.works), pages: page + 1, complete: next.works.length < next.pageSize });
      }
      setLoadingMore(false);
      await stream.done;
    } catch (error) {
      if (!mounted.current || request !== searchRequest.current) return;
      setLoadingMore(false);
      // Automatic loading stops after a failure; the quiet button at the end retries.
      if (!appended) setLoadMoreFailed(true);
      setMessage(commandErrorMessage(error, "다음 결과를 불러오지 못했습니다"));
      if (totalCount === null) setCountError("결과 수를 불러오지 못했습니다");
    }
  }

  const indexQuery = mangaIndexQuery(indexFilter);
  const previousIndexQuery = useRef(indexQuery);
  useEffect(() => {
    if (previousIndexQuery.current === indexQuery) return;
    previousIndexQuery.current = indexQuery;
    if (status?.installed) void search(appliedQuery);
    // The applied typed search remains separate; an index pick adds a single AND clause.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexQuery, status?.installed]);

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
      // A pending card switch owns the next detail; never replace it with the old work.
      if (!detail || !detailOpen || openingWorkKey) return;
      const request = ++detailRequest.current;
      const identity = catalogIdentityOf(detail);
      void gateway.getOnlineCatalogWorkDetail(identity).then((next) => {
        if (mounted.current && request === detailRequest.current) setDetail(next);
      }).catch(() => undefined);
    };
    window.addEventListener(CATALOG_BOOKMARKS_CHANGED_EVENT, refreshBookmarks);
    return () => window.removeEventListener(CATALOG_BOOKMARKS_CHANGED_EVENT, refreshBookmarks);
  }, [gateway, detail, detailOpen, openingWorkKey, onBookmarkCount]);

  useEffect(() => {
    if (!detailOpen || viewer || editions) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (panelHost.current?.contains(event.target) || event.target.closest(".ui-menu, [role='dialog']")) return;
      // Opening another card swaps the same panel, without an exit/entry cycle.
      if (gridScroll.current?.contains(event.target) && event.target.closest(".manga-card__body")) return;
      closeDetail();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeDetail();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [detailOpen, viewer, editions]);

  useEffect(() => {
    if (!active) closeDetail();
  }, [active]);

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

  /** Commit the detail and its edition row together, retaining the previous body meanwhile. */
  async function openDetail(work: CatalogWork, group: CatalogGroupedWork | null = null, opener?: HTMLButtonElement) {
    const request = ++detailRequest.current;
    editionRequest.current += 1;
    readRequest.current += 1;
    setReading(false);
    setEditionsLoading(false);
    const identity = catalogIdentityOf(work);
    setOpeningWorkKey(catalogIdentityKey(identity));
    const reuseEditions = Boolean(detailOpen && group && group.versionCount >= 2 && editionQuery.current
      && group.provider === detailGroup?.provider && group.groupId === detailGroup.groupId);
    const nextEditionQuery: CatalogGroupEditionsQuery | null = group && group.versionCount >= 2
      ? reuseEditions ? editionQuery.current : { provider: group.provider, groupId: group.groupId, language, revealBlocked, page: 0, pageSize: 40 }
      : null;
    try {
      const [nextDetail, editionResult] = await Promise.all([
        gateway.getOnlineCatalogWorkDetail(identity),
        nextEditionQuery && !reuseEditions
          ? gateway.getCatalogGroupEditions(nextEditionQuery).then(page => ({ page, error: null })).catch(error => ({ page: null, error }))
          : Promise.resolve({ page: reuseEditions ? detailEditions : null, error: null }),
      ]);
      if (!mounted.current || request !== detailRequest.current) return;
      setDetail(nextDetail);
      setDetailGroup(group);
      setDetailEditions(editionResult.page);
      setEditionsError(Boolean(editionResult.error) || (reuseEditions && editionsError));
      editionQuery.current = nextEditionQuery;
      if (editionResult.error) setMessage(commandErrorMessage(editionResult.error, "판본을 불러오지 못했습니다"));
      if (opener) detailReturnFocus.current = opener;
      setDetailOpen(true);
      // The panel itself stays mounted, so a card switch explicitly moves focus back in.
      if (detailOpen) panelHost.current?.querySelector<HTMLElement>(".ui-overlay-panel__header button:not(:disabled)")?.focus({ preventScroll: true });
    } catch (error) {
      if (mounted.current && request === detailRequest.current) {
        setMessage(commandErrorMessage(error, "작품 정보를 불러오지 못했습니다"));
      }
    } finally {
      if (mounted.current && request === detailRequest.current) setOpeningWorkKey(null);
    }
  }

  async function loadMoreDetailEditions() {
    if (!editionQuery.current || editionsLoading) return;
    const request = ++editionRequest.current;
    const query = { ...editionQuery.current, page: detailEditions ? detailEditions.page + 1 : 0 };
    setEditionsLoading(true);
    setEditionsError(false);
    try {
      const next = await gateway.getCatalogGroupEditions(query);
      if (!mounted.current || request !== editionRequest.current) return;
      setDetailEditions(current => ({ ...next, works: [...(current?.works ?? []), ...next.works] }));
    } catch (error) {
      if (mounted.current && request === editionRequest.current) {
        setEditionsError(true);
        setMessage(commandErrorMessage(error, "판본을 불러오지 못했습니다"));
      }
    } finally {
      if (mounted.current && request === editionRequest.current) setEditionsLoading(false);
    }
  }

  function toggleRevealBlocked() {
    const next = !revealBlocked;
    setRevealBlocked(next);
    void search(query.trim(), sort, scope, next);
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
      onBookmarksChanged?.();
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
    if (!detail || !detailOpen || openingWorkKey) return;
    await bookmarkWork(catalogIdentityOf(detail), bookmarked);
  }

  async function readDetail() {
    if (!detail || !detailOpen || openingWorkKey || reading) return;
    const request = ++readRequest.current;
    const selectedDetail = detail;
    setReading(true);
    try {
      const gallery = await gateway.resolveOnlineCatalogWork(catalogIdentityOf(selectedDetail));
      if (!mounted.current || request !== readRequest.current) return;
      const artist = selectedDetail.tagGroups.find(group => group.namespace === "artist")?.values.join(" · ") || null;
      setDetailOpen(false);
      setViewer({ title: selectedDetail.title, ...gallery, initialPage: 1, artist });
    } catch (error) {
      if (mounted.current && request === readRequest.current) {
        setMessage(commandErrorMessage(error, "온라인 작품을 열지 못했습니다"));
      }
    } finally {
      if (mounted.current && request === readRequest.current) setReading(false);
    }
  }

  function closeDetail() {
    detailRequest.current += 1;
    editionRequest.current += 1;
    readRequest.current += 1;
    setOpeningWorkKey(null);
    setReading(false);
    setDetailOpen(false);
    // Retain the body during the shared panel's single exit animation.
  }

  function searchTag(nextQuery: string) {
    closeDetail();
    setQuery(nextQuery);
    void search(nextQuery, sort, scope);
  }

  function closeViewer() {
    setViewer(null);
    // The read button leaves with the panel; return to the work that opened it after the
    // reader dialog has finished its own focus cleanup.
    requestAnimationFrame(() => detailReturnFocus.current?.focus({ preventScroll: true }));
  }

  // The reader's bookmark follows the same state the detail panel shows; the detail row is the reader's own work.
  const viewerIdentity: CatalogWorkIdentity | null = viewer ? { provider: viewer.provider, providerWorkId: viewer.providerWorkId } : null;
  const viewerKey = viewerIdentity ? catalogIdentityKey(viewerIdentity) : null;
  const viewerBookmark = viewerIdentity && viewerKey ? {
    bookmarked: Boolean(detail && catalogIdentityKey(detail) === viewerKey && detail.bookmarked),
    disabled: bookmarkPendingKeys.has(viewerKey) || !detail || catalogIdentityKey(detail) !== viewerKey,
    onToggle: () => { if (detail) void bookmarkWork(viewerIdentity, !detail.bookmarked); },
  } : undefined;

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
        await search(query.trim(), sort, scope, revealBlocked, updateLanguage);
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
    void search(query.trim(), nextSort, next);
  }
  const catalogControls = status?.installed ? <>
    <MangaChoiceMenu label="언어" value={language} options={[{ value: "korean", label: "한국어" }, { value: "japanese", label: "일본어" }]} onChange={nextLanguage => {
      languageRef.current = nextLanguage; setLanguage(nextLanguage);
      setKnownBookmarkCount(undefined); onBookmarkCount?.(undefined);
      void search(query.trim(), sort, scope, revealBlocked, nextLanguage);
    }} />
    <MangaChoiceMenu label="정렬" value={sort} options={[
      { value: "latest", label: "최신순" }, { value: "views", label: "조회순" }, { value: "hotDay", label: "오늘 인기" }, { value: "hotWeek", label: "주간 인기" }, { value: "hotMonth", label: "월간 인기" },
    ]} onChange={nextSort => { setSort(nextSort); void search(appliedQuery, nextSort, scope); }} />
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
  const moreAvailable = Boolean(results && !results.complete && (totalCount === null || results.pages * CATALOG_PAGE_SIZE < totalCount));
  const autoLoadSupported = typeof IntersectionObserver !== "undefined";
  const canAutoLoad = moreAvailable && autoLoadSupported && active && requestedSource !== "local" && !loading && !searchPending && !loadingMore && !loadMoreFailed;
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  useEffect(() => {
    // Re-created after every append, so a sentinel still in reach keeps loading until the view is filled.
    const target = moreSentinel.current;
    if (!canAutoLoad || !target) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void loadMoreRef.current();
    }, { root: gridScroll.current, rootMargin: "0px 0px 600px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [canAutoLoad, results]);
  const scrubberSort = useMemo<ScrubberSort>(() => results && displayedView.current?.sort === "latest"
    ? {kind: "date", values: results.works.map(work => work.posted)} : {kind: "fallback"}, [results]);
  return <section className="manga-browser online-catalog" aria-label="온라인 망가">
    {active && <MangaToolbar source={requestedSource ?? scope} onSourceChange={selectSource} localCount={localCount} bookmarkCount={bookmarkCount ?? knownBookmarkCount}
      filterToken={<MangaIndexToken filter={indexFilter} onClear={() => onClearIndexFilter?.()} />}
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
    <div className="online-catalog__workspace">
    <div ref={gridScroll} tabIndex={0} className="manga-browser__content online-catalog__content">
      <div className="online-catalog__frame" style={{ display: "contents" }} inert={loading || requestedSource === "local"}>
      {loadError && !results ? <EmptyState title="온라인 카탈로그를 불러오지 못했습니다" />
        : !status ? <MangaSkeletonGrid />
        : !status.installed ? <EmptyState title="온라인 카탈로그가 없습니다">
          <p>기존 VCK 폴더의 데이터를 한 번 가져오면 Lakomics에서 독립적으로 사용할 수 있습니다.</p>
          <Button onClick={() => void importCatalog()} disabled={loading}>VCK 데이터 가져오기</Button>
        </EmptyState>
        : loading && !results ? <MangaSkeletonGrid />
        : results?.works.length === 0 ? <EmptyState title="검색 결과가 없습니다">다른 제목이나 태그로 검색하세요.</EmptyState>
        : results && <>
          <div className="manga-grid">
            {results.works.map((work) => <OnlineCatalogCard
              key={`${work.provider}:${work.groupId}`}
              work={work}
              opening={openingWorkKey === catalogIdentityKey(work)}
              selected={detailOpen && detailGroup?.provider === work.provider && detailGroup.groupId === work.groupId}
              bookmarkPending={bookmarkPendingKeys.has(catalogIdentityKey(work))}
              onOpen={(selected, opener) => void openDetail(selected, work, opener)}
              onBookmark={(identity, bookmarked) => void bookmarkWork(identity, bookmarked)}
            />)}
          </div>
          {loadingMore && <MangaSkeletonGrid more />}
          <div ref={moreSentinel} className="online-catalog__more-sentinel" aria-hidden="true" />
          <footer className="online-catalog__list-end" aria-busy={loadingMore || totalCount === null}>
            <span>{totalCount === null ? `${results.works.length.toLocaleString()}개` : `${results.works.length.toLocaleString()} / ${totalCount.toLocaleString()}`}</span>
            {moreAvailable && !loadingMore && (loadMoreFailed || !autoLoadSupported) && <Button size="sm" variant="quiet" disabled={searchPending} onClick={() => void loadMore()}>더 불러오기</Button>}
          </footer>
        </>}
      </div>
    </div>
    <Scrubber input="pointer" scrollRef={gridScroll} total={results?.works.length ?? 0} sort={scrubberSort} hidden={!active || loading || requestedSource === "local" || detailOpen || !!viewer} onEndReached={moreAvailable ? () => { void loadMoreRef.current(); } : undefined} />
    <div ref={panelHost} className="online-catalog__panel-host">
      {!viewer && active && <OverlayPanel open={detailOpen} title="상세" ariaLabel="망가 상세" closeLabel="상세 닫기" width={380} returnFocusRef={detailReturnFocus}
        onOpenChange={(open) => { if (!open) closeDetail(); }} actions={detailGroup && detailGroup.versionCount >= 2 && <span onKeyDown={(event) => {
          // Escape belongs to the portalled menu before the panel beneath it.
          if (event.key === "Escape" && event.target instanceof Element && event.target.closest("[role='menu']")) event.stopPropagation();
        }}><Menu label="상세 더보기" align="end"
          disabled={Boolean(openingWorkKey)} trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={[
            { id: "representative", label: "대표 판본 바꾸기", onSelect: () => setEditions(detailGroup) },
          ]} /></span>}>
        {detail && <div inert={Boolean(openingWorkKey) || !detailOpen} aria-busy={Boolean(openingWorkKey)}>
          <MangaDetail detail={{ ...detail, thumbnailUrl: detail.thumbnailUrl ? nativeMediaUrl(detail.thumbnailUrl) : null }} privacyMode={privacyMode}
            bookmarkPending={bookmarkPendingKeys.has(catalogIdentityKey(detail))} reading={reading}
            onBookmark={(bookmarked) => void bookmarkDetail(bookmarked)} onTagSearch={searchTag} onRead={() => void readDetail()}
            editionCount={detailGroup?.versionCount ?? 0} editions={(detailEditions?.works ?? []).map(edition => ({ ...edition,
              thumbnailUrl: edition.thumbnailUrl ? nativeMediaUrl(edition.thumbnailUrl) : null, language: editionQuery.current?.language ?? language }))}
            editionsLoading={editionsLoading} editionsError={editionsError}
            hasMoreEditions={Boolean(detailEditions && (detailEditions.page + 1) * detailEditions.pageSize < detailEditions.totalCount)}
            onEdition={(edition) => void openDetail(edition, detailGroup)} onMoreEditions={() => void loadMoreDetailEditions()} />
        </div>}
      </OverlayPanel>}
    </div>
    </div>
    {editions && <CatalogEditionsDialog work={editions} language={language} revealBlocked={revealBlocked}
      onClose={() => setEditions(null)} onOpen={(work) => { const group = editions; setEditions(null); void openDetail(work, group); }}
      onRepresentativeChange={async () => { await refreshSearch.current(); }} />}
    {viewer && <PageViewer
      title={viewer.title}
      pageUrls={viewer.pageUrls}
      initialPage={viewer.initialPage}
      sourceLabel="카탈로그"
      artist={viewer.artist}
      bookmark={viewerBookmark}
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
