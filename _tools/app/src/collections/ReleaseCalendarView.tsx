import { BookmarkIcon as BookmarkOutlineIcon } from "@heroicons/react/24/outline";
import { BookmarkIcon } from "@heroicons/react/24/solid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { igdbImagePreviewUrl, tmdbImagePreviewUrl } from "../assets/mediaUrl";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { ReleaseCalendar, ReleaseTitle, ReleaseWishlistEvent, ReleaseWishlistItem } from "../library/types";
import { usePrivacy } from "../privacy/PrivacyContext";
import { Button } from "../shared/ui/Button";
import { EmptyState } from "../shared/ui/EmptyState";
import { groupReleases, RELEASE_SOURCE_PROBLEM, releaseDateLabel, releaseEventLine } from "./releaseCalendarFormat";
import "./releaseCalendar.css";
import { createKoreanMatcher } from "../shared/koreanSearch";

type KindFilter = "all" | "game" | "movie";
type Tile = ReleaseTitle & { watched: boolean; unread: ReleaseWishlistEvent[]; released?: boolean };

const PROVIDER_LABEL = { igdb: "IGDB", tmdb: "TMDB" } as const;

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

function ago(value: string | null): string | null {
  if (!value) return null;
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (!Number.isFinite(minutes)) return null;
  if (minutes < 60) return minutes < 1 ? "방금" : `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}시간 전` : `${Math.round(hours / 24)}일 전`;
}

/**
 * The 발매 캘린더: upcoming games (IGDB) and Korean theatrical movies (TMDB) for the next six
 * months, month by month. Each title can be added to the 관심 목록 (wishlist), whose date changes
 * and releases are tracked like manga releases and shown here until 확인.
 */
export function ReleaseCalendarView({ query = "", onWishlistChange, onOpenSettings }: Props) {
  const { gateway } = useLibrary();
  const api = gateway.releaseCalendar;
  const { privacyMode } = usePrivacy();
  const [calendar, setCalendar] = useState<ReleaseCalendar | null>(null);
  const [wishlist, setWishlist] = useState<ReleaseWishlistItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [kind, setKind] = useState<KindFilter>("all");
  const [watchOnly, setWatchOnly] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const active = useRef(true);
  const referenceYear = new Date().getFullYear();

  const loadWishlist = useCallback(async () => {
    if (!api) return;
    const items = await api.wishlist();
    if (active.current) setWishlist(items);
  }, [api]);

  useEffect(() => {
    active.current = true;
    if (!api) return;
    void (async () => {
      try {
        const [cached] = await Promise.all([api.calendar(), loadWishlist()]);
        if (!active.current) return;
        setCalendar(cached);
        if (cached.sources.some(source => source.due)) {
          setRefreshing(true);
          const fresh = await api.refresh(false);
          if (active.current) setCalendar(fresh);
        }
      } catch (err) {
        if (active.current) setError(commandErrorMessage(err, "발매 캘린더를 불러오지 못했습니다."));
      } finally {
        if (active.current) setRefreshing(false);
      }
    })();
    return () => { active.current = false; };
  }, [api, loadWishlist]);

  const wishById = useMemo(() => new Map((wishlist ?? []).map(item => [item.id, item])), [wishlist]);
  const needle = query.trim();
  const matchesQuery = createKoreanMatcher(needle);
  const matches = (title: ReleaseTitle) => (kind === "all" || title.kind === kind) && matchesQuery([title.title, title.originalTitle]);
  const tiles: Tile[] = watchOnly
    ? (wishlist ?? []).filter(matches).map(item => ({ ...item, watched: true }))
    : (calendar?.entries ?? []).filter(matches).map(entry => ({ ...entry, watched: wishById.has(entry.id), unread: wishById.get(entry.id)?.unread ?? [] }));
  const groups = groupReleases(tiles);
  const unreadTotal = (wishlist ?? []).reduce((sum, item) => sum + item.unread.length, 0);

  async function toggle(tile: Tile) {
    if (!api || pending) return;
    setPending(tile.id); setError(null);
    try {
      if (tile.watched) await api.remove(tile.id);
      else await api.add(tile.id);
      await loadWishlist();
      onWishlistChange?.();
    } catch (err) {
      setError(commandErrorMessage(err, tile.watched ? "관심 목록에서 빼지 못했습니다." : "관심 목록에 추가하지 못했습니다."));
    } finally { setPending(null); }
  }

  async function acknowledge(key: string, events: ReleaseWishlistEvent[]) {
    if (!api || pending || !events.length) return;
    setPending(key); setError(null);
    try {
      await api.acknowledge(events.map(event => event.id));
      await loadWishlist();
      onWishlistChange?.();
    } catch (err) {
      setError(commandErrorMessage(err, "알림을 확인 처리하지 못했습니다."));
    } finally { setPending(null); }
  }

  async function refreshNow() {
    if (!api || refreshing) return;
    setRefreshing(true); setError(null);
    try { const fresh = await api.refresh(true); if (active.current) setCalendar(fresh); }
    catch (err) { setError(commandErrorMessage(err, "발매 캘린더를 새로 고치지 못했습니다.")); }
    finally { if (active.current) setRefreshing(false); }
  }

  const sources = calendar?.sources ?? [];
  const problems = sources.filter(source => source.errorCode);
  const latest = sources.map(source => source.fetchedAt).filter((value): value is string => Boolean(value)).sort()[0] ?? null;
  const allUnread = (wishlist ?? []).flatMap(item => item.unread);

  return <section className="release-calendar" aria-label="발매 캘린더">
    <div className="release-calendar__bar">
      <div className="release-calendar__segments" role="radiogroup" aria-label="종류">
        {([["all", "전체"], ["game", "게임"], ["movie", "영화"]] as const).map(([value, label]) =>
          <button key={value} type="button" role="radio" aria-checked={kind === value} className="release-calendar__segment" onClick={() => setKind(value)}>{label}</button>)}
      </div>
      <button type="button" className="release-calendar__filter" aria-pressed={watchOnly} onClick={() => setWatchOnly(value => !value)}>
        <BookmarkIcon aria-hidden="true" />관심 목록<span className="release-calendar__filter-count">{(wishlist?.length ?? 0).toLocaleString()}</span>
        {unreadTotal > 0 && <span className="release-calendar__new" aria-label={`새 알림 ${unreadTotal}개`}>NEW {unreadTotal}</span>}
      </button>
      <div className="release-calendar__actions">
        <span className="release-calendar__updated" role="status">{refreshing ? "갱신 중…" : latest ? `갱신 ${ago(latest)}` : calendar ? "아직 불러오지 않음" : ""}</span>
        {watchOnly && allUnread.length > 0 && <Button size="sm" disabled={Boolean(pending)} onClick={() => void acknowledge("all", allUnread)}>모두 확인</Button>}
        <Button size="sm" variant="ghost" disabled={refreshing || !api} onClick={() => void refreshNow()}>새로 고침</Button>
      </div>
    </div>
    {problems.length > 0 && <div className="release-calendar__status" role="status">
      {problems.map(source => <span key={source.provider}>{source.provider === "igdb" ? "게임" : "영화"} ({PROVIDER_LABEL[source.provider]}): {RELEASE_SOURCE_PROBLEM[source.errorCode!] ?? "불러오지 못했습니다."}
        {source.errorCode === "credential_not_configured" && onOpenSettings && <Button size="sm" variant="ghost" onClick={onOpenSettings}>외부 서비스 설정</Button>}</span>)}
    </div>}
    {error && <p className="release-calendar__error" role="alert">{error}</p>}
    <div className="release-calendar__body">
      {!calendar && !error && <p className="release-calendar__hint" role="status">발매 캘린더를 불러오는 중…</p>}
      {calendar && groups.length === 0 && (watchOnly
        ? <EmptyState title="관심 목록이 비어 있습니다."><p>캘린더에서 책갈피를 눌러 기다리는 게임과 영화를 모아 보세요. 발매일이 바뀌거나 발매되면 여기에서 알려 드립니다.</p></EmptyState>
        : <EmptyState title={needle ? "조건에 맞는 작품이 없습니다." : "앞으로 6개월 동안의 발매 정보가 없습니다."}><p>{needle ? "검색어를 바꿔 보세요." : "IGDB·TMDB 연결을 확인한 뒤 새로 고침을 눌러 주세요."}</p></EmptyState>)}
      {groups.map(group => <section key={group.key} className="release-calendar__month" aria-label={group.label}>
        <h3 className="release-calendar__month-title">{group.label}<span className="release-calendar__month-count">{group.items.length.toLocaleString()}</span></h3>
        <ul className="release-calendar__grid">
          {group.items.map(tile => {
            const url = privacyMode ? null : coverUrl(tile);
            const detail = tile.kind === "game" ? tile.platforms.join(" · ") || "게임" : tile.region === "korea" ? "국내 개봉" : "개봉 (해외 기준)";
            return <li key={tile.id} className={`release-calendar__tile${tile.watched ? " is-watched" : ""}${tile.unread.length ? " is-new" : ""}`}>
              <div className={`release-calendar__cover release-calendar__cover--${tile.kind}`}>
                {url ? <img src={url} alt="" loading="lazy" decoding="async" draggable={false} /> : <span aria-hidden="true">{tile.kind === "game" ? "GAME" : "MOVIE"}</span>}
                <button type="button" className="release-calendar__watch" aria-pressed={tile.watched} disabled={pending === tile.id}
                  aria-label={tile.watched ? `${tile.title} 관심 목록에서 빼기` : `${tile.title} 관심 목록에 추가`} title={tile.watched ? "관심 목록에서 빼기" : "관심 목록에 추가"}
                  onClick={() => void toggle(tile)}>
                  {tile.watched ? <BookmarkIcon aria-hidden="true" /> : <BookmarkOutlineIcon aria-hidden="true" />}
                </button>
              </div>
              <div className="release-calendar__meta">
                <strong title={tile.originalTitle ?? tile.title}>{tile.title}</strong>
                <span className="release-calendar__date">{releaseDateLabel(tile.date, tile.precision, referenceYear)}{tile.released ? " · 발매됨" : ""}</span>
                <span className="release-calendar__detail"><span className="release-calendar__kind">{tile.kind === "game" ? "게임" : "영화"}</span>{detail}</span>
                {tile.unread.length > 0 && <div className="release-calendar__news">
                  <span className="release-calendar__events">{tile.unread.map(event => <span key={event.id} className="release-calendar__event">{releaseEventLine(event, referenceYear)}</span>)}</span>
                  <Button size="sm" variant="ghost" className="release-calendar__confirm" disabled={Boolean(pending)} aria-label={`${tile.title} 알림 확인`} onClick={() => void acknowledge(tile.id, tile.unread)}>확인</Button>
                </div>}
              </div>
            </li>;
          })}
        </ul>
      </section>)}
      <p className="release-calendar__attribution">게임 정보 IGDB · 영화 정보 TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p>
    </div>
  </section>;
}
