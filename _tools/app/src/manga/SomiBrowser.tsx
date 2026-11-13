import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { EllipsisHorizontalIcon } from "@heroicons/react/24/outline";
import { useLibrary } from "../library/LibraryContext";
import type { SomiOpenedPost, SomiPost, SomiSearchPage, SomiSort, SomiStatus } from "../library/types";
import { nativeMediaUrl } from "../assets/mediaUrl";
import { useCatalogMasked } from "../privacy/catalogMask";
import { ChromeQueryBadge } from "../layout/ChromeSearch";
import { SearchSurface, SearchSurfaceField } from "../layout/SearchSurface";
import { BookmarkToggle } from "../shared/ui/BookmarkToggle";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { Menu } from "../shared/ui/Menu";
import { Toast } from "../shared/ui/Toast";
import { useAutoDismiss } from "../shared/ui/useAutoDismiss";
import { useDelayedBusy } from "../shared/useDelayedBusy";
import { waitForViewportImages, revealTogether } from "../shared/motion/viewportImages";
import { Scrubber } from "../shared/ui/scrubber/Scrubber";
import { MangaCover, MangaSkeletonGrid } from "./MangaCard";
import { MangaToolbar, MangaViewMenu, type MangaSource } from "./MangaToolbar";
import { PageViewer } from "./PageViewer";

const sorts = [
  { value: "new", label: "최신순" }, { value: "old", label: "오래된순" },
  { value: "votes", label: "추천순" }, { value: "views", label: "조회순" }, { value: "comments", label: "댓글순" },
];
const periods = [
  { value: "all", label: "전체" }, { value: "7", label: "1주" }, { value: "30", label: "1개월" },
  { value: "90", label: "3개월" }, { value: "365", label: "1년" },
];
function errorText(error: unknown) {
  const value = String(error);
  if (value.includes("SOMI_LOGIN_REQUIRED")) return "코네 로그인이 필요합니다";
  if (value.includes("SOMI_POST_GONE")) return "사라졌거나 열 수 없는 게시글입니다";
  if (value.includes("SOMI_NO_IMAGES")) return "이미지가 없는 게시글입니다";
  return "소미를 불러오지 못했습니다";
}
type View = { request: number; fillIds: string[]; result: SomiSearchPage; query: string; sort: SomiSort; days: number | null; bookmarked: boolean; page: number };
export function SomiBrowser({ active, requested, onReady, onSourceChange, bookmarked = false, source = bookmarked ? "bookmarked" : "somi", bookmarkSwitch }: {
  bookmarked?: boolean; source?: MangaSource; bookmarkSwitch?: ReactNode;
  active: boolean; requested: boolean; onReady(): void; onSourceChange(source: MangaSource): void;
}) {
  const { gateway } = useLibrary();
  const masked = useCatalogMasked();
  const [status, setStatus] = useState<SomiStatus | null>(null);
  const statusRef = useRef(status); statusRef.current = status;
  const [options, setOptions] = useState([{ query: "", sort: "new" as SomiSort, days: null as number | null }, { query: "", sort: "added" as SomiSort, days: null as number | null }]);
  const mode = bookmarked ? 1 : 0;
  const { query, sort, days } = options[mode];
  const cachedSlots = useRef<(number | null)[]>([null, null]);
  const scrollPositions = useRef([0, 0]);
  const restoreScroll = useRef<number | null>(null);
  const previousMode = useRef(bookmarked);
  const bookmarkBusy = useRef(new Set<string>());
  const [bookmarkPending, setBookmarkPending] = useState(new Set<string>());
  const [draft, setDraft] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [slots, setSlots] = useState<(View | null)[]>([null, null, null, null]);
  const [shown, setShown] = useState(0);
  const shownRef = useRef(shown); shownRef.current = shown;
  const [pending, setPending] = useState<number | null>(null);
  const current = slots[shown];
  const currentRef = useRef(current); currentRef.current = current;
  const grids = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)];
  const gridScroll = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const sessionEpoch = useRef(0);
  const loggingOut = useRef(false);
  const busy = useRef(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [viewer, setViewer] = useState<(SomiOpenedPost & { id: string; bookmarked: boolean }) | null>(null);
  const [opening, setOpening] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);
  const openingRef = useRef(false);
  const alive = useRef(true);
  const readyRef = useRef(onReady); readyRef.current = onReady;
  const requestedRef = useRef(requested); requestedRef.current = requested;
  const releaseImages = useRef<(() => void) | null>(null);
  const showCollecting = useDelayedBusy(Boolean(status?.loggedIn && status.syncing && !status.complete));
  const optionsRef = useRef({ query, sort, days, bookmarked }); optionsRef.current = { query, sort, days, bookmarked };
  useAutoDismiss(message, setMessage);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; releaseImages.current?.(); }; }, []);
  useEffect(() => { if (!requested) setViewer(null); }, [requested]);
  useLayoutEffect(() => {
    if (requested && currentRef.current?.bookmarked === bookmarked) readyRef.current();
  }, [requested, bookmarked]);

  const clearSession = useCallback(() => {
    sessionEpoch.current++;
    generation.current++; busy.current = false; setLoading(false); setPending(null);
    cachedSlots.current = [null, null]; setSlots([null, null, null, null]); setViewer(null); setStatus(previous => previous ? { ...previous, loggedIn: false } : { loggedIn: false, handle: null, displayName: null, collected: 0, total: null, complete: false, syncing: false });
    statusRef.current = null;
  }, []);
  const load = useCallback(async (text: string, order: SomiSort, period: number | null, more = false, bookmarks = optionsRef.current.bookmarked) => {
    if (!gateway.somiSearch || !requestedRef.current || bookmarks !== optionsRef.current.bookmarked || (more && busy.current)) return;
    const request = ++generation.current; busy.current = true; setLoading(true); setPending(null); setLoadError(false); setMoreFailed(false);
    const previous = currentRef.current;
    const page = more && previous ? previous.page + 1 : 1;
    try {
      const result = await gateway.somiSearch(text, order, page, period, bookmarks);
      if (!alive.current || generation.current !== request) return;
      const items = more && previous ? [...previous.result.items, ...result.items.filter(p => !previous.result.items.some(old => old.id === p.id))] : result.items;
      const base = bookmarks ? 2 : 0;
      const slot = shownRef.current === base ? base + 1 : base;
      setSlots(old => { const next = [...old]; next[slot] = { request, fillIds: result.items.filter(post => post.cover === null && Boolean(post.coverKey)).map(post => post.id), result: { ...result, items }, query: text, sort: order, days: period, bookmarked: bookmarks, page }; return next; });
      setPending(slot);
    } catch (error) {
      if (!alive.current || generation.current !== request) return;
      if (String(error).includes("SOMI_LOGIN_REQUIRED")) { clearSession(); readyRef.current(); }
      else { setLoadError(true); setMoreFailed(more); setMessage(errorText(error)); readyRef.current(); }
      busy.current = false; setLoading(false);
    }
  }, [gateway, clearSession]);
  useLayoutEffect(() => {
    if (pending === null) return;
    const host = grids[pending].current;
    if (!host) return;
    releaseImages.current?.();
    const cancel = waitForViewportImages(host, () => {
      const view = slots[pending]!;
      const priorMode = currentRef.current?.bookmarked ? 1 : 0;
      if (gridScroll.current && view.bookmarked !== currentRef.current?.bookmarked) { scrollPositions.current[priorMode] = gridScroll.current.scrollTop; restoreScroll.current = scrollPositions.current[view.bookmarked ? 1 : 0]; }
      cachedSlots.current[view.bookmarked ? 1 : 0] = pending;
      setShown(pending); setPending(null); busy.current = false; setLoading(false); readyRef.current();
    }, 250, late => { releaseImages.current = revealTogether(late, 1500); });
    return cancel;
  // Each slot keeps the actual decoded image elements when it becomes visible.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, slots]);

  useLayoutEffect(() => {
    const changed = previousMode.current !== bookmarked;
    previousMode.current = bookmarked;
    if (changed) {
      generation.current++; busy.current = false; setLoading(false); setPending(null); setSearchOpen(false); setViewer(null);
    }
    if (!requested) return;
    if (statusRef.current?.loggedIn === false) { readyRef.current(); return; }
    if (!changed && currentRef.current?.bookmarked === bookmarked) return;
    const cached = cachedSlots.current[mode];
    if (cached !== null) {
      if (gridScroll.current && currentRef.current?.bookmarked !== bookmarked) { scrollPositions.current[1 - mode] = gridScroll.current.scrollTop; restoreScroll.current = scrollPositions.current[mode]; }
      const request = ++generation.current;
      setSlots(old => old.map((view, slot) => slot === cached && view ? { ...view, request, fillIds: view.result.items.filter(post => !post.cover && post.coverKey).map(post => post.id) } : view));
      setShown(cached); readyRef.current();
    } else if (statusRef.current?.loggedIn && !busy.current) void load(query, sort, days, false, bookmarked);
  }, [bookmarked, requested, load]);
  useLayoutEffect(() => {
    if (restoreScroll.current !== null && gridScroll.current) { gridScroll.current.scrollTop = restoreScroll.current; restoreScroll.current = null; }
  }, [shown]);

  const filledRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!requested || loading || !current || current.request !== generation.current
      || filledRequest.current === current.request || !gateway.somiFillCovers) return;
    filledRequest.current = current.request;
    if (!current.fillIds.length) return;
    const request = current.request;
    const slot = shown;
    void gateway.somiFillCovers(current.fillIds).then(covers => {
      if (!alive.current || !requestedRef.current || generation.current !== request) return;
      const resolved = new Map(covers.map(cover => [cover.id, cover.cover]));
      setSlots(old => {
        const view = old[slot];
        if (!view || view.request !== request) return old;
        const next = [...old];
        next[slot] = { ...view, result: { ...view.result, items: view.result.items.map(post =>
          post.cover === null && resolved.has(post.id) ? { ...post, cover: resolved.get(post.id)! } : post) } };
        return next;
      });
    }).catch(() => { /* A missing cover keeps its placeholder without disturbing the list. */ });
  }, [current, gateway, loading, requested, shown]);

  useEffect(() => {
    if (!requested || !gateway.somiStatus) return;
    let cancelled = false, polling = false, collect = true;
    const refresh = async () => {
      if (polling || loggingOut.current) return; polling = true;
      const epoch = sessionEpoch.current;
      try {
        const next = await gateway.somiStatus!(collect); collect = !next.loggedIn;
        if (cancelled || epoch !== sessionEpoch.current) return;
        const previous = statusRef.current;
        const { query, sort, days, bookmarked } = optionsRef.current;
        statusRef.current = next; setStatus(next); setLoadError(false);
        if (!next.loggedIn) { clearSession(); setStatus(next); statusRef.current = next; readyRef.current(); }
        else if (!previous?.loggedIn || !currentRef.current || ((previous.collected !== next.collected || (previous.syncing && !next.syncing)) && currentRef.current.result.items.length <= 60)) {
          if (!busy.current) void load(query, sort, days);
        } else if (previous.collected !== next.collected && !busy.current && gateway.somiSearch) {
          const request = generation.current;
          const result = await gateway.somiSearch(query, sort, 1, days, bookmarked);
          if (!cancelled && request === generation.current && epoch === sessionEpoch.current) {
            setSlots(old => old.map(view => view && view.query === query && view.sort === sort && view.days === days && view.bookmarked === bookmarked ? { ...view, result: { ...view.result, total: result.total } } : view));
          }
        }
        if (next.loggedIn && currentRef.current && !busy.current) readyRef.current();
      } catch (error) {
        if (!cancelled && epoch === sessionEpoch.current) {
          if (String(error).includes("SOMI_LOGIN_REQUIRED")) clearSession();
          if (!currentRef.current) { setLoadError(true); setMessage(errorText(error)); }
          readyRef.current();
        }
      } finally { polling = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    const onFocus = () => { collect = true; void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [requested, gateway, load, clearSession]);

  function apply(text: string, order = sort, period = days) {
    setOptions(old => old.map((value, index) => index === mode ? { query: text, sort: order, days: period } : value)); setDraft(text); setSearchOpen(false); void load(text, order, period, false, bookmarked);
  }
  const more = Boolean(current && current.result.items.length < current.result.total);
  const loadMore = useCallback(() => {
    const view = currentRef.current;
    if (requestedRef.current && view && view.bookmarked === optionsRef.current.bookmarked && view.result.items.length < view.result.total) void load(view.query, view.sort, view.days, true, view.bookmarked);
  }, [load]);
  useEffect(() => {
    if (!active || !requested || !more || moreFailed || loading || !sentinel.current || typeof IntersectionObserver !== "function") return;
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) loadMore(); }, { root: gridScroll.current, rootMargin: "600px" });
    observer.observe(sentinel.current); return () => observer.disconnect();
  }, [active, requested, more, moreFailed, loading, loadMore, current]);

  async function read(post: SomiPost) {
    if (!gateway.somiOpenPost || openingRef.current) return;
    const request = sessionEpoch.current, readingBookmarks = bookmarked;
    openingRef.current = true; setOpening(true);
    try {
      const result = await gateway.somiOpenPost(post.id);
      if (alive.current && requestedRef.current && sessionEpoch.current === request && optionsRef.current.bookmarked === readingBookmarks && statusRef.current?.loggedIn) setViewer({ ...result, id: post.id, bookmarked: post.bookmarked });
    } catch (error) {
      if (alive.current) {
        if (String(error).includes("SOMI_LOGIN_REQUIRED")) clearSession();
        if (String(error).includes("SOMI_POST_GONE")) void load(query, sort, days);
        setMessage(errorText(error));
      }
    } finally { openingRef.current = false; if (alive.current) setOpening(false); }
  }
  async function logout() {
    loggingOut.current = true;
    clearSession();
    try { await gateway.somiLogout?.(); } catch { setMessage("코네 로그아웃을 완료하지 못했습니다"); }
    finally { loggingOut.current = false; }
  }
  async function syncNow() {
    if (statusRef.current?.syncing) return;
    try {
      await gateway.somiSyncNow?.();
      if (!alive.current || !statusRef.current?.loggedIn) return;
      setStatus(previous => previous ? { ...previous, syncing: true, syncError: null } : previous);
      statusRef.current = { ...statusRef.current, syncing: true, syncError: null };
    } catch (error) {
      if (String(error).includes("SOMI_LOGIN_REQUIRED")) clearSession();
      else setMessage("목차를 모으지 못했습니다");
    }
  }
  async function toggleBookmark(id: string, wasBookmarked: boolean) {
    if (!gateway.somiToggleBookmark || bookmarkBusy.current.has(id)) return;
    const epoch = sessionEpoch.current;
    bookmarkBusy.current.add(id); setBookmarkPending(new Set(bookmarkBusy.current));
    const update = (value: boolean) => {
      setSlots(old => old.map(view => view ? { ...view, result: { ...view.result, items: view.result.items.map(post => post.id === id ? { ...post, bookmarked: value } : post) } } : view));
      setViewer(old => old?.id === id ? { ...old, bookmarked: value } : old);
    };
    if (!bookmarked) cachedSlots.current[1] = null;
    update(!wasBookmarked);
    try {
      const winner = await gateway.somiToggleBookmark(id);
      if (alive.current && epoch === sessionEpoch.current) update(winner);
    } catch (error) {
      if (alive.current && epoch === sessionEpoch.current) {
        update(wasBookmarked);
        if (String(error).includes("SOMI_LOGIN_REQUIRED")) clearSession();
        else setMessage("북마크를 저장하지 못했습니다");
      }
    } finally { bookmarkBusy.current.delete(id); if (alive.current) setBookmarkPending(new Set(bookmarkBusy.current)); }
  }
  const closeViewer = useCallback(() => { setViewer(null); void gateway.somiSyncState?.(true).catch(() => {}); }, [gateway]);
  const loggedIn = Boolean(status?.loggedIn);
  useEffect(() => {
    if (!requested || !loggedIn || !gateway.somiSyncState) return;
    let cancelled = false;
    const sync = () => {
      const request = generation.current;
      void gateway.somiSyncState!().then(() => {
        if (cancelled || !alive.current || !statusRef.current?.loggedIn || generation.current !== request || busy.current) return;
        const { query, sort, days, bookmarked } = optionsRef.current;
        void load(query, sort, days, false, bookmarked);
      }).catch(() => {});
    };
    sync(); window.addEventListener("focus", sync);
    return () => { cancelled = true; window.removeEventListener("focus", sync); void gateway.somiSyncState?.(true).catch(() => {}); };
  }, [requested, loggedIn, gateway, load]);
  const countLabel = loggedIn ? !status!.complete && showCollecting ? `목차 모으는 중 ${status!.collected.toLocaleString()} / ${status!.total?.toLocaleString() ?? "…"}` : `${(current?.result.total ?? status!.collected).toLocaleString()}개 작품` : undefined;
  const search = { scope: "소미", label: "소미 검색", query, onApply: (text: string) => apply(text) };
  return <section className="manga-browser online-catalog" aria-label="소미 망가">
    {active && <MangaToolbar source={source} onSourceChange={onSourceChange} countLabel={countLabel}
      controls={(bookmarkSwitch || loggedIn) && <>{bookmarkSwitch}{loggedIn && <MangaViewMenu choices={[
        { label: "정렬", value: sort, options: bookmarked ? [{ value: "added", label: "추가순" }, ...sorts] : sorts, onChange: value => apply(query, value as SomiSort) },
        { label: "기간", value: String(days ?? "all"), options: periods, onChange: value => { if (value === "all") apply(query, sort, null); else apply(query, "votes", Number(value)); } },
      ]} />}</>}
      actions={loggedIn && <Menu label="소미 더보기" trigger={<EllipsisHorizontalIcon aria-hidden="true" />} items={[
        { id: "account", label: `@${status!.handle}`, disabled: true, onSelect: () => {} },
        { id: "sync", label: "새 글 확인", disabled: status!.syncing, onSelect: () => void syncNow() },
        { id: "logout", label: "로그아웃", onSelect: () => void logout() },
      ]} />}
      chrome={{ status: loggedIn ? <ChromeQueryBadge search={search} /> : undefined,
        searchSurface: loggedIn ? { ...search, open: text => { setDraft(text || query); setSearchOpen(true); },
          content: <SearchSurface label="소미 검색" scope="소미" active={Boolean(query)} open={searchOpen} onOpen={() => { setDraft(query); setSearchOpen(true); }} onClose={() => setSearchOpen(false)}>
            <form className="chrome-search-editor__form" role="search" onSubmit={event => { event.preventDefault(); apply(draft.trim()); }}>
              <SearchSurfaceField aria-label="소미 검색어" placeholder="제목 또는 작가" value={draft} onChange={e => setDraft(e.target.value)} onClear={() => setDraft("")} autoFocus />
              <div className="ui-dialog__actions chrome-search-editor__foot"><Button type="button" variant="ghost" onClick={() => setSearchOpen(false)}>취소</Button><Button type="submit" variant="primary">검색</Button></div>
            </form>
          </SearchSurface> } : undefined }} />}
    {message && <Toast onDismiss={() => setMessage(null)}>{message}</Toast>}
    <div ref={gridScroll} className="manga-browser__content online-catalog__content" tabIndex={0} style={{ position: "relative" }}>
      {status && !loggedIn ? <EmptyState title="코네 로그인이 필요합니다" hint="코네에 로그인하면 소미소프트 동인 게시글을 볼 수 있습니다." action={<Button onClick={() => { void gateway.somiOpenLogin?.().catch(() => setMessage("코네 로그인 창을 열 수 없습니다")); }}>코네 로그인</Button>} />
        : loggedIn && loadError && !current ? <EmptyState title="소미 목록을 불러오지 못했습니다" action={<Button onClick={() => void load(query, sort, days)}>다시 시도</Button>} />
        : !status || (!current && loading) || (loggedIn && !bookmarked && status.collected === 0 && status.syncing && !query) ? <MangaSkeletonGrid /> : null}
      {loggedIn && slots.map((view, slot) => view && <div key={slot} ref={grids[slot]} inert={slot !== shown || loading || !requested || current?.bookmarked !== bookmarked}
        style={slot === shown ? undefined : { position: "absolute", inset: 0, visibility: "hidden", pointerEvents: "none" }}>
        {view.result.items.length ? <div className="manga-grid">{view.result.items.map(post => <SomiCard key={post.id} post={post} masked={masked} disabled={opening || loading || !requested || slot !== shown || current?.bookmarked !== bookmarked} bookmarkPending={bookmarkPending.has(post.id)} onBookmark={() => void toggleBookmark(post.id, post.bookmarked)} onRead={() => void read(post)} />)}</div>
          : (query || !status?.syncing || status.collected > 0) && <EmptyState title="검색 결과 없음" hint="다른 제목이나 작가 이름으로 검색하세요." />}
      </div>)}
      {loggedIn && current && <>
        <div ref={sentinel} className="online-catalog__more-sentinel" aria-hidden="true" />
        {more && <Button variant="quiet" disabled={loading} onClick={loadMore}>{moreFailed ? "다시 시도" : "더 불러오기"}</Button>}
        {loadError && !moreFailed && <Button onClick={() => void load(query, sort, days)}>다시 시도</Button>}
      </>}
      {loggedIn && status?.syncError && <EmptyState inline title="목차 수집이 멈췄습니다" />}
      {loggedIn && status?.syncError && <Button disabled={status.syncing} onClick={() => void syncNow()}>다시 시도</Button>}
    </div>
    <Scrubber input="pointer" scrollRef={gridScroll} total={current?.result.items.length ?? 0} sort={{ kind: "fallback" }} hidden={!active || !loggedIn || Boolean(viewer)} onEndReached={more && !moreFailed ? loadMore : undefined} />
    {viewer && <PageViewer title={viewer.title} artist={viewer.writer} pageUrls={viewer.pageUrls} initialPage={viewer.initialPage}
      bookmark={{ bookmarked: viewer.bookmarked, disabled: bookmarkPending.has(viewer.id), onToggle: () => void toggleBookmark(viewer.id, viewer.bookmarked) }}
      onClose={closeViewer} onPageChange={page => { void gateway.somiSavePage?.(viewer.id, page).catch(() => setMessage("읽던 위치를 저장하지 못했습니다")); }}
      onRetryPage={async () => {
        try { const next = await gateway.somiOpenPost!(viewer.id); if (statusRef.current?.loggedIn) setViewer(old => old?.id === viewer.id ? { ...next, id: viewer.id, bookmarked: old.bookmarked } : old); }
        catch (error) { if (String(error).includes("SOMI_LOGIN_REQUIRED")) clearSession(); setMessage(errorText(error)); throw error; }
      }} />}
  </section>;
}
function SomiCard({ post, masked, disabled, bookmarkPending, onBookmark, onRead }: { post: SomiPost; masked: boolean; disabled: boolean; bookmarkPending: boolean; onBookmark(): void; onRead(): void }) {
  return <article className="manga-card"><button type="button" className="manga-card__body" aria-label={`${post.title} 읽기`} disabled={disabled} onClick={onRead}>
    <span className="manga-card__frame"><MangaCover className="manga-card__cover" src={post.cover ? nativeMediaUrl(post.cover) : null} title={post.title} privacyMode={masked} reportBusy={false} /></span>
    <strong className="manga-card__title">{post.title}</strong>
    <span className="manga-card__artist">{post.writerName || post.writerHandle}</span>
    <span className="manga-card__artist">조회 {post.views.toLocaleString()} · 추천 {post.votes.toLocaleString()}</span>
  </button><BookmarkToggle form="corner" className="manga-card__bookmark" bookmarked={post.bookmarked} label={`${post.title} ${post.bookmarked ? "북마크 해제" : "북마크"}`} disabled={disabled || bookmarkPending} onClick={onBookmark} /></article>;
}
