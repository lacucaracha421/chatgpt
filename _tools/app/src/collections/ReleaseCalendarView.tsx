import { ArrowPathIcon, BookmarkIcon as BookmarkOutlineIcon, CalendarDaysIcon, CheckIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type SVGProps } from "react";
import { igdbImagePreviewUrl, tmdbImagePreviewUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { ReleaseCalendar, ReleaseTitle, ReleaseWishlistEvent, ReleaseWishlistItem, ServerCalendarStatus } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { daysUntil, displayDateTime } from "../shared/displayDate";
import { DDay } from "../shared/ui/DDay";
import { Badge } from "../shared/ui/Badge";
import { Button } from "../shared/ui/Button";
import { BookmarkToggle } from "../shared/ui/BookmarkToggle";
import { EmptyState } from "../shared/ui/EmptyState";
import { SegmentedControl } from "../shared/ui/SegmentedControl";
import { Skeleton } from "../shared/ui/Skeleton";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { PlatformBadges } from "./PlatformBadges";
import { groupReleaseDays, groupReleases, isVisibleCalendarRelease, RELEASE_SOURCE_PROBLEM, releaseDateLabel, releaseEventLine, releaseGroupHeading } from "./releaseCalendarFormat";
import "./releaseCalendar.css";
import { createKoreanMatcher } from "../shared/koreanSearch";

type KindFilter = "all" | ReleaseTitle["kind"];
type Tile = ReleaseTitle & { watched: boolean; unread: ReleaseWishlistEvent[]; released?: boolean };

const PROVIDER_LABEL = { igdb: "IGDB", tmdb: "TMDB", tmdb_tv: "TMDB" } as const;
const SERVER_POLLS = 10;
const SERVER_POLL_MS = 1500;

type Props = {
  query?: string;
  /** The wishlist changed (added, removed or acknowledged): the index badge re-reads. */
  onWishlistChange?: () => void;
  onOpenSettings?: () => void;
};

function coverUrl(title: ReleaseTitle): string | null {
  if (!title.cover) return null;
  return title.provider === "igdb" ? igdbImagePreviewUrl(title.cover, "cover") : tmdbImagePreviewUrl(title.cover, "poster");
}

function EmptyCalendarState({ title, icon: Icon }: { title: string; icon: ComponentType<SVGProps<SVGSVGElement>> }) {
  return <EmptyState className="release-calendar__empty" title={title} icon={Icon} />;
}

function LoadingCalendarState() {
  return <div className="release-calendar__skeletons" aria-label="발매 정보 불러오는 중" role="status">
    {Array.from({ length: 8 }, (_, index) => <div key={index} className="release-calendar__skeleton-tile">
      <div className="release-calendar__skeleton-date"><Skeleton label="발매 정보 불러오는 중" /><Skeleton label="발매 정보 불러오는 중" /><span /></div>
      <Skeleton className="release-calendar__skeleton-cover" label="발매 정보 불러오는 중" />
      <Skeleton className="release-calendar__skeleton-title" label="발매 정보 불러오는 중" />
      <Skeleton className="release-calendar__skeleton-badge" label="발매 정보 불러오는 중" />
    </div>)}
  </div>;
}

/**
 * The 발매 캘린더: upcoming games (IGDB) and Korean theatrical movies and Japanese anime seasons (TMDB) for the next six
 * months, month by month. Each title can be added to the 관심 목록 (wishlist), whose date changes
 * and releases are tracked like manga releases and shown here until 확인.
 */
/** A day block spans at most this many grid columns. */
const DAY_SPAN_MAX = 4;
// The last calendar and 관심 list, kept for the app session so reopening the calendar shows them at once
// while the fresh copy loads behind them.
const lastShown = new WeakMap<object, { calendar: ReleaseCalendar | null; wishlist: ReleaseWishlistItem[] | null }>();

export function ReleaseCalendarView({ query = "", onWishlistChange, onOpenSettings }: Props) {
  const { gateway } = useLibrary();
  const api = gateway.releaseCalendar;
  const { privacyMode } = usePrivacy();
  const [calendar, setCalendar] = useState<ReleaseCalendar | null>(() => (api && lastShown.get(api)?.calendar) ?? null);
  const [wishlist, setWishlist] = useState<ReleaseWishlistItem[] | null>(() => (api && lastShown.get(api)?.wishlist) ?? null);
  useEffect(() => { if (api) lastShown.set(api, { calendar, wishlist }); }, [api, calendar, wishlist]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [serverStatus, setServerStatus] = useState<ServerCalendarStatus | null>(null);
  const [serverOwned, setServerOwned] = useState(false);
  const [kind, setKind] = useState<KindFilter>("all");
  const [watchOnly, setWatchOnly] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const active = useRef(true);
  const generation = useRef(0);
  const mutationPending = useRef(false);
  const mutationVersion = useRef(0);
  const referenceYear = new Date().getFullYear();

  const loadWishlist = useCallback(async (afterEdit = false) => {
    if (!api || (mutationPending.current && !afterEdit)) return;
    const version = mutationVersion.current;
    const items = await api.wishlist();
    if (active.current && version === mutationVersion.current) setWishlist(items);
  }, [api]);

  useEffect(() => {
    active.current = true;
    const current = ++generation.current;
    const isCurrent = () => active.current && generation.current === current;
    if (!api) return;
    void (async () => {
      try {
        const [cached] = await Promise.all([api.calendar(), loadWishlist()]);
        if (!isCurrent()) return;
        setCalendar(cached);
        const serverEnabled = await api.serverEnabled?.();
        if (!isCurrent()) return;
        setServerOwned(Boolean(serverEnabled));
        if (serverEnabled) {
          const status = await api.serverStatus?.().catch(() => null);
          if (isCurrent()) setServerStatus(status ?? null);
        } else if (cached.sources.some(source => source.due)) {
          setRefreshing(true);
          const fresh = await api.refresh(false);
          if (isCurrent()) setCalendar(fresh);
        }
      } catch (err) {
        if (isCurrent()) setError(commandErrorMessage(err, "발매 캘린더를 불러오지 못했습니다."));
      } finally {
        if (isCurrent()) setRefreshing(false);
      }
    })();
    const stop = api.subscribeChanged?.(() => {
      void loadWishlist().then(() => { if (isCurrent() && !mutationPending.current) onWishlistChange?.(); }).catch(() => undefined);
      void api.calendar().then(value => { if (isCurrent()) setCalendar(value); }).catch(() => undefined);
      void api.serverStatus?.().then(value => { if (isCurrent()) setServerStatus(value); })
        .catch(() => { if (isCurrent()) setServerStatus(null); });
    });
    const stopErrors = api.subscribeWishlistError?.(err => {
      if (isCurrent()) setError(commandErrorMessage(err, "관심 목록을 서버와 동기화하지 못했습니다."));
    });
    return () => { stop?.(); stopErrors?.(); active.current = false; generation.current++; };
  }, [api, loadWishlist]);

  const wishById = useMemo(() => new Map((wishlist ?? []).map(item => [item.id, item])), [wishlist]);
  const needle = query.trim();
  const matchesQuery = createKoreanMatcher(needle);
  const matches = (title: ReleaseTitle) => isVisibleCalendarRelease(title) && (kind === "all" || title.kind === kind) && matchesQuery([title.title, title.originalTitle]);
  const currentEntries = (calendar?.entries ?? []).filter(entry => isVisibleCalendarRelease(entry) && matchesQuery([entry.title, entry.originalTitle]));
  const kindCounts = {
    all: currentEntries.length,
    game: currentEntries.filter(entry => entry.kind === "game").length,
    movie: currentEntries.filter(entry => entry.kind === "movie").length,
    anime: currentEntries.filter(entry => entry.kind === "anime").length,
  };
  const kindOptions = ([
    { value: "all", label: "전체", count: kindCounts.all },
    { value: "game", label: "게임", count: kindCounts.game },
    { value: "movie", label: "영화", count: kindCounts.movie },
    { value: "anime", label: "애니", count: kindCounts.anime },
  ] as const);
  const tiles: Tile[] = watchOnly
    ? (wishlist ?? []).filter(matches).map(item => ({ ...item, watched: true }))
    : (calendar?.entries ?? []).filter(matches).map(entry => ({ ...entry, watched: wishById.has(entry.id), unread: wishById.get(entry.id)?.unread ?? [] }));
  const groups = groupReleases(tiles);
  // The past week starts folded each visit (user 2026-10-06).
  const [recentOpen, setRecentOpen] = useState(false);
  const unreadTotal = (wishlist ?? []).reduce((sum, item) => sum + item.unread.length, 0);

  async function toggle(tile: Tile) {
    if (!api || pending) return;
    mutationPending.current = true; mutationVersion.current++;
    setPending(tile.id); setError(null);
    const previous = wishlist;
    setWishlist(items => tile.watched ? (items ?? []).filter(item => item.id !== tile.id)
      : [...(items ?? []), { ...tile, source: "calendar", addedAt: new Date().toISOString(), muted: false,
        lastCheckedAt: null, nextCheckAt: null, released: tile.released ?? false, unread: [] }]);
    try {
      if (tile.watched) await api.remove(tile.id);
      else await api.add(tile.id);
      await loadWishlist(true);
      onWishlistChange?.();
    } catch (err) {
      setWishlist(previous);
      setError(commandErrorMessage(err, tile.watched ? "관심 목록에서 빼지 못했습니다." : "관심 목록에 추가하지 못했습니다."));
    } finally { mutationPending.current = false; setPending(null); }
  }

  async function acknowledge(key: string, events: ReleaseWishlistEvent[]) {
    if (!api || pending || !events.length) return;
    mutationPending.current = true; mutationVersion.current++;
    setPending(key); setError(null);
    const previous = wishlist;
    const ids = new Set(events.map(event => event.id));
    setWishlist(items => (items ?? []).map(item => ({ ...item, unread: item.unread.filter(event => !ids.has(event.id)) })));
    try {
      await api.acknowledge(events.map(event => event.id));
      await loadWishlist(true);
      onWishlistChange?.();
    } catch (err) {
      setWishlist(previous);
      setError(commandErrorMessage(err, "알림을 확인 처리하지 못했습니다."));
    } finally { mutationPending.current = false; setPending(null); }
  }

  async function refreshNow() {
    if (!api || refreshing) return;
    const current = generation.current;
    const isCurrent = () => active.current && generation.current === current;
    setRefreshing(true); setError(null);
    try {
      const serverEnabled = await api.serverEnabled?.();
      if (!isCurrent()) return;
      setServerOwned(Boolean(serverEnabled));
      if (serverEnabled) {
        const before = await api.serverStatus?.().catch(() => null);
        if (!isCurrent()) return;
        setServerStatus(before ?? null);
        const result = await api.requestServerRun?.();
        if (!isCurrent()) return;
        if (result?.outcome === "rateLimited") {
          setError(result.retryAfterSeconds ? `잠시 후 다시 확인해 주세요. 약 ${result.retryAfterSeconds}초 뒤에 새로고침할 수 있습니다.` : "잠시 후 다시 확인해 주세요.");
          return;
        }
        if (result?.outcome === "local") {
          setServerOwned(false);
          const fresh = await api.refresh(true);
          if (isCurrent()) setCalendar(fresh);
          return;
        }
        if (!result || result.outcome === "unavailable") {
          setError("서버 발매 캘린더가 잠시 쉬고 있습니다. 잠시 후 다시 시도해 주세요.");
          return;
        }
        // A wake that has no due work may not change finishedAt. Two consecutive
        // idle reads with identical sources finish the bounded follow-up too.
        let idle = 0;
        let previousSources: string | null = null;
        for (let poll = 0; poll < SERVER_POLLS; poll++) {
          await new Promise(resolve => setTimeout(resolve, SERVER_POLL_MS));
          if (!isCurrent()) return;
          const status = await api.serverStatus?.().catch(() => null);
          if (!isCurrent()) return;
          setServerStatus(status ?? null);
          const sources = status ? JSON.stringify(status.sources) : null;
          idle = status && !status.busy ? (sources === previousSources ? idle + 1 : 1) : 0;
          previousSources = sources;
          if (!status || idle >= 2) break;
          if (status && !status.busy && status.finishedAt !== before?.finishedAt) break;
        }
        if (isCurrent()) {
          // The worker is idle (or status is unavailable); network revalidation
          // continues behind the current tiles without prolonging the spinner.
          setRefreshing(false);
          const fresh = await (api.revalidate?.() ?? api.calendar()).catch(() => null);
          if (!fresh) return;
          if (isCurrent()) setCalendar(fresh);
        }
      } else {
        const fresh = await api.refresh(true);
        if (isCurrent()) setCalendar(fresh);
      }
    }
    catch (err) { if (isCurrent()) setError(commandErrorMessage(err, "발매 캘린더를 새로고침하지 못했습니다.")); }
    finally { if (isCurrent()) setRefreshing(false); }
  }

  const sources = (serverOwned ? serverStatus?.sources : calendar?.sources) ?? [];
  const problems = sources.filter(source => source.errorCode);
  const latest = sources.map(source => source.fetchedAt).filter((value): value is string => Boolean(value)).sort().pop() ?? null;
  const allUnread = (wishlist ?? []).flatMap(item => item.unread);

  return <section className="release-calendar" aria-label="발매 캘린더">
    <div className="release-calendar__top-row">
      <SegmentedControl label="종류" options={kindOptions} value={kind} onChange={setKind} />
      <Button type="button" variant="quiet" size="sm" className={`release-calendar__filter${watchOnly ? " is-selected" : ""}`} aria-pressed={watchOnly} onClick={() => setWatchOnly(value => !value)}>
        <BookmarkOutlineIcon aria-hidden="true" />관심 <span className="release-calendar__filter-count">{(wishlist?.length ?? 0).toLocaleString()}</span>
      </Button>
      {unreadTotal > 0 && <Badge variant="accent">NEW {unreadTotal}</Badge>}
      <div className="release-calendar__actions">
        {(!refreshing || serverOwned) && latest && <span className="release-calendar__updated">갱신 {displayDateTime(latest)}</span>}
        {watchOnly && allUnread.length > 0 && <Button type="button" size="sm" variant="quiet" disabled={Boolean(pending)} onClick={() => void acknowledge("all", allUnread)}>모두 확인</Button>}
        <Button type="button" size="sm" variant="quiet" disabled={refreshing || !api} onClick={() => void refreshNow()}><ArrowPathIcon aria-hidden="true" />새로고침</Button>
      </div>
    </div>
    {problems.length > 0 && <div className="release-calendar__status" role="status">
      {problems.map(source => <div className="release-calendar__status-line" key={source.provider}>{source.provider === "igdb" ? "게임" : source.provider === "tmdb_tv" ? "애니" : "영화"} ({PROVIDER_LABEL[source.provider]}): {RELEASE_SOURCE_PROBLEM[source.errorCode!] ?? "불러오지 못했습니다."}
        {source.errorCode === "credential_not_configured" && onOpenSettings && <Button type="button" size="sm" variant="quiet" onClick={onOpenSettings}>외부 서비스 설정</Button>}</div>)}
    </div>}
    {error && <p className="release-calendar__error" role="alert">{error}</p>}
    <div className="release-calendar__body">
      {api && !calendar && !error && <LoadingCalendarState />}
      {calendar && groups.length === 0 && (watchOnly
        ? <EmptyCalendarState title="관심 목록 비어 있음" icon={BookmarkOutlineIcon} />
        : needle ? <EmptyCalendarState title="검색 결과 없음" icon={MagnifyingGlassIcon} /> : <EmptyCalendarState title="6개월 안의 발매 정보 없음" icon={CalendarDaysIcon} />)}
      {groups.map(group => { const folded = group.key === "recent" && !recentOpen; return <section key={group.key} className={`release-calendar__month${group.key === "recent" ? " is-recent" : ""}`} aria-label={group.label}>
        <SectionLabel as="h3" title={releaseGroupHeading(group.label, referenceYear)} count={group.items.length}
          actions={group.key === "recent" ? <Button size="sm" variant="ghost" aria-expanded={recentOpen} onClick={() => setRecentOpen(open => !open)}>{recentOpen ? "접기" : "펼치기"}</Button> : undefined} />
        {!folded && <div className="release-calendar__days">
          {groupReleaseDays(group.items).map(day => {
            // One heading per release day; the day's covers sit side by side under it (up to four).
            const first = day[0]!;
            const dDay = first.released === true || first.precision !== "exact" ? null : daysUntil(first.date);
            return <section key={`${first.date ?? "tbd"}:${first.precision}:${first.id}`} className="release-calendar__day" style={{ "--day-span": Math.min(day.length, DAY_SPAN_MAX) } as CSSProperties}
              aria-label={releaseDateLabel(first.date, first.precision, referenceYear)}>
              <div className="release-calendar__date-row">
                <span className="release-calendar__date">{releaseDateLabel(first.date, first.precision, referenceYear)}</span>
                <DDay as="text" days={dDay} />
              </div>
              <ul className="release-calendar__grid">
                {day.map(tile => {
                  const url = privacyMode ? null : coverUrl(tile);
                  return <li key={tile.id} className={`release-calendar__tile${tile.watched ? " is-watched" : ""}${tile.unread.length ? " is-new" : ""}`}>
                    <div className={`release-calendar__cover release-calendar__cover--${tile.kind}`}>
                      {url ? <img src={url} alt="" loading="lazy" decoding="async" draggable={false} /> : <span aria-hidden="true">{tile.kind === "game" ? "GAME" : tile.kind === "anime" ? "ANIME" : "MOVIE"}</span>}
                      {tile.unread.length > 0 && <Badge className="release-calendar__new-badge" variant="accent">NEW</Badge>}
                      <BookmarkToggle form="corner" className="release-calendar__watch" bookmarked={tile.watched} disabled={pending === tile.id}
                        label={tile.watched ? `${tile.title} 관심 목록에서 빼기` : `${tile.title} 관심 목록에 추가`}
                        onClick={() => void toggle(tile)} />
                    </div>
                    <strong className="release-calendar__title">{tile.title}</strong>
                    {tile.kind === "game" && tile.platforms.length > 0 && <PlatformBadges platforms={tile.platforms} port={tile.port} />}
                    {tile.unread.length > 0 && <div className="release-calendar__news">
                      {tile.unread.map(event => <div key={event.id} className="release-calendar__event">
                        <span>{releaseEventLine(event, referenceYear)}</span>
                        <Button type="button" size="icon" variant="quiet" className="release-calendar__confirm" disabled={Boolean(pending)} aria-label={`${tile.title} 알림 확인`} onClick={() => void acknowledge(tile.id, [event])}><CheckIcon aria-hidden="true" /></Button>
                      </div>)}
                    </div>}
                  </li>;
                })}
              </ul>
            </section>;
          })}
        </div>}
      </section>; })}
      <p className="release-calendar__attribution">게임 정보 IGDB · 영화·애니 정보 TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
    </div>
  </section>;
}
