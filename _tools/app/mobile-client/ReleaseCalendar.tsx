import {useHorizontalWheel} from '../src/shared/ui/useHorizontalWheel';
import {BookmarkIcon as BookmarkOutlineIcon, CalendarDaysIcon, CheckIcon} from '@heroicons/react/24/outline';
import {useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject} from 'react';
import {TopBar} from './TopBar';
import {Badge, Button, DDay, EmptyState, SegmentedControl, SectionLabel, Skeleton} from './ui';
import {api, ApiError, errorText, native} from './transport';
import {usePrivacyMode} from './privacyMode';
import {commitUpcomingWishlist, flushUpcomingWishlist, readUpcomingWishlistIntents, reconcileUpcomingWishlist, visibleUpcomingWishlist} from './upcomingWishlistOutbox';
import {PlatformBadges} from '../src/collections/PlatformBadges';
import type {Ticket} from './types';
import {filterReleaseEntries, groupReleaseEntries, normalizeReleaseCalendarReply, releaseDateLabel, releaseDaysUntil, releaseEventLine, visibleWishlistIds, wishlistIds, type KindFilter, type ReleaseCalendarEntry, type ReleaseCalendarEvent, type ReleaseCalendarReply} from './releaseCalendarModel';
import {Scrubber} from './Scrubber';
import {releaseGroupHeading} from '../src/collections/releaseCalendarFormat';
import {cancelSegmentSwap, swapSegment} from '../src/shared/motion/viewSwap';
import {useFirstAppearance} from '../src/shared/motion/useFirstAppearance';
import {BookmarkToggle} from '../src/shared/ui/BookmarkToggle';
import {IMAGE_READY_CAP_MS} from '../src/shared/motion/viewportImages';
import {decodeImage} from './media';
import './releaseCalendar.css';

type ScreenState = 'loading' | 'ready' | 'empty' | 'error';

type Cover = ReleaseCalendarEntry['cover'];
/** Cover tickets this screen resolved, kept briefly so a prepared list's covers paint in their first frame. */
const coverTickets = new Map<string, {url: string; until: number}>();
const COVER_KEEP_MS = 4 * 60_000;
const FIRST_SCREEN_COVERS = 12;
const httpsUrl = (url: string | undefined | null) => url && /^https:\/\//.test(url) ? url : '';
function knownCover(cover: Cover) {
  if (!cover) return '';
  if (!cover.sha256) return httpsUrl(cover.url);
  const hit = coverTickets.get(cover.sha256);
  if (hit && hit.until > Date.now()) return hit.url;
  coverTickets.delete(cover.sha256);
  return '';
}
async function coverUrl(cover: Cover, signal: AbortSignal) {
  const known = knownCover(cover);
  if (known || !cover?.sha256) return known;
  const sha256 = cover.sha256;
  const reply = await (window.LakomicsNative
    ? native<Ticket>('homeCover', {sha256}, signal)
    : api<Ticket>(`/v1/home/covers/${encodeURIComponent(sha256)}/media-ticket`, signal, undefined, 'POST'));
  const url = httpsUrl(reply?.url);
  if (url && !signal.aborted) {
    coverTickets.set(sha256, {url, until: Date.now() + (reply.expires_in ? reply.expires_in * 1000 : COVER_KEEP_MS)});
    while (coverTickets.size > 200) coverTickets.delete(coverTickets.keys().next().value!);
  }
  return url;
}
/**
 * No flash on change: a list's first screen of covers is resolved and decoded before it is shown,
 * capped like the gallery's first viewport; whatever is not ready by then loads in place.
 */
function prepareCovers(entries: ReleaseCalendarEntry[], privacy: boolean, signal: AbortSignal) {
  if (privacy) return Promise.resolve();
  const work = Promise.all(entries.slice(0, FIRST_SCREEN_COVERS).map(entry => coverUrl(entry.cover, signal)
    .then(url => url ? decodeImage(url, signal) : undefined).catch(() => undefined)));
  return Promise.race([work, new Promise(resolve => window.setTimeout(resolve, IMAGE_READY_CAP_MS))]).then(() => undefined);
}

function HomeCoverImage({cover, alt, privacy}: {cover: Cover; alt: string; privacy: boolean}) {
  const [url, setUrl] = useState(() => privacy ? '' : knownCover(cover));
  useEffect(() => {
    if (privacy || !cover) { setUrl(''); return; }
    const known = knownCover(cover);
    if (known || !cover.sha256) { setUrl(known); return; }
    const controller = new AbortController();
    setUrl('');
    void coverUrl(cover, controller.signal).then(next => { if (!controller.signal.aborted && next) setUrl(next); }, () => {});
    return () => controller.abort();
  }, [cover?.url, cover?.sha256, privacy]);
  if (privacy) return <span className="release-calendar-cover-placeholder is-private" aria-label="비공개 모드로 이미지 숨김" />;
  return url ? <img src={url} alt="" loading="lazy" decoding="async" draggable={false} /> : <span className="release-calendar-cover-placeholder" aria-label={`${alt} 표지 준비 중`} />;
}
function EmptyCalendar({wishlistOnly}: {wishlistOnly: boolean}) {
  const Icon = wishlistOnly ? BookmarkOutlineIcon : CalendarDaysIcon;
  return <EmptyState icon={Icon} title={wishlistOnly ? '관심 목록 비어 있음' : '6개월 안의 발매 정보 없음'} />;
}

function LoadingCalendar() {
  return <div className="release-calendar-skeletons" aria-label="발매 정보 불러오는 중" role="status">
    {Array.from({length: 8}, (_, index) => <div key={index} className="release-calendar-skeleton-tile">
      <div className="release-calendar-skeleton-date"><Skeleton label="발매 정보 불러오는 중" /><Skeleton label="발매 정보 불러오는 중" /><span /></div>
      <Skeleton className="release-calendar-skeleton-cover" label="발매 정보 불러오는 중" />
      <Skeleton className="release-calendar-skeleton-title" label="발매 정보 불러오는 중" />
      <Skeleton className="release-calendar-skeleton-badge" label="발매 정보 불러오는 중" />
    </div>)}
  </div>;
}

/** A day block spans at most this many of the four portrait columns. */
const DAY_SPAN_MAX = 4;

function ReleaseCard({entry, watched, pending, privacy, referenceYear, acknowledging, onToggle, onAcknowledge}: {entry: ReleaseCalendarEntry; watched: boolean; pending: boolean; privacy: boolean; referenceYear: number; acknowledging: string | null; onToggle(): void; onAcknowledge(event: ReleaseCalendarEvent): void}) {
  return <li className={`release-calendar-card${watched ? ' is-watched' : ''}${pending ? ' is-pending' : ''}`}>
    <div className="release-calendar-cover">
      <HomeCoverImage cover={entry.cover} alt={entry.title} privacy={privacy} />
      {entry.unread.length > 0 && <Badge className="release-calendar-new-badge" variant="accent">NEW</Badge>}
      <BookmarkToggle form="corner" className="release-calendar-watch" bookmarked={watched} aria-busy={pending} disabled={pending} label={watched ? `${entry.title} 관심 목록에서 빼기${pending ? ' · 동기화 대기' : ''}` : `${entry.title} 관심 목록에 추가${pending ? ' · 동기화 대기' : ''}`} onClick={onToggle} />
    </div>
    <strong className="release-calendar-title">{entry.title}</strong>
    {entry.kind === 'game' && entry.platforms.length > 0 && <PlatformBadges platforms={entry.platforms} port={entry.port} />}
    {pending && <span className="release-calendar-pending" role="status">동기화 대기</span>}
    {entry.unread.length > 0 && <div className="release-calendar-events">
      {entry.unread.map(event => <div key={event.id} className="release-calendar-event">
        <span>{releaseEventLine(event, referenceYear)}</span>
        <Button type="button" size="icon" variant="quiet" className="release-calendar-confirm" disabled={acknowledging !== null} aria-busy={acknowledging === event.id} aria-label={`${entry.title} 알림 확인`} onClick={() => onAcknowledge(event)}><CheckIcon aria-hidden="true" /></Button>
      </div>)}
    </div>}
  </li>;
}

function CalendarBody({reply, kind, wishlistOnly, visibleIds, privacy, referenceYear, acknowledging, onToggle, onAcknowledge}: {reply: ReleaseCalendarReply; kind: KindFilter; wishlistOnly: boolean; visibleIds: Set<string>; privacy: boolean; referenceYear: number; acknowledging: string | null; onToggle(entry: ReleaseCalendarEntry): void; onAcknowledge(entry: ReleaseCalendarEntry, event: ReleaseCalendarEvent): void}) {
  const source = wishlistOnly ? reply.wishlist : reply.entries;
  const wishlistById = new Map(reply.wishlist.map(entry => [entry.id, entry]));
  const entries = filterReleaseEntries(source, kind, wishlistOnly, visibleIds).map(entry => ({...entry, unread: wishlistById.get(entry.id)?.unread ?? entry.unread}));
  const groups = groupReleaseEntries(entries);
  if (!entries.length) return <EmptyCalendar wishlistOnly={wishlistOnly} />;
  return <div className="release-calendar-groups">
    {groups.map(month => <section key={month.key} className={`release-calendar-month${month.key === 'recent' ? ' is-recent' : ''}`} aria-label={month.label}>
      <SectionLabel as="h2" className="release-calendar-month-heading" title={releaseGroupHeading(month.label, referenceYear)} count={month.items} />
      <div className="release-calendar-days">
        {month.days.map(day => {
          // One heading per release day; the day's covers sit side by side under it (up to a row).
          const first = day.items[0]!;
          const days = first.precision === 'exact' ? releaseDaysUntil(first.date) : null;
          const span = Math.min(day.items.length, DAY_SPAN_MAX);
          return <section key={day.key} className="release-calendar-day" style={{'--day-span': span} as CSSProperties} aria-label={day.label}>
            <div className="release-calendar-day-head">
              <span className="release-calendar-date numeric">{releaseDateLabel(first.date, first.precision, referenceYear)}</span>
              <DDay as="text" days={days} />
            </div>
            <ul className="release-calendar-card-grid">
              {day.items.map(entry => {
                const visible = visibleUpcomingWishlist(entry.id, visibleIds.has(entry.id));
                return <ReleaseCard key={entry.id} entry={entry} watched={visible.value} pending={visible.pending} privacy={privacy} referenceYear={referenceYear} acknowledging={acknowledging} onToggle={() => onToggle(entry)} onAcknowledge={event => onAcknowledge(entry, event)} />;
              })}
            </ul>
          </section>;
        })}
      </div>
    </section>)}
  </div>;
}

export type ReleaseCalendarProps = {
  onClose: () => void;
  /** Collections supplies the overlay header and Back handling. */
  embedded?: boolean;
  /** Keeps the owning shortcut count current after loading or confirming calendar news. */
  onSnapshot?: (reply: ReleaseCalendarReply) => void;
  backRef?: MutableRefObject<(() => boolean) | null>;
  initialKind?: Extract<KindFilter, 'game' | 'movie'>;
};

export function ReleaseCalendar({onClose, backRef, initialKind, embedded=false, onSnapshot}: ReleaseCalendarProps) {
  const stripWheel=useHorizontalWheel();
  const [privateMode] = usePrivacyMode();
  const [reply, setReply] = useState<ReleaseCalendarReply | null>(null);
  const [state, setState] = useState<ScreenState>('loading');
  const [error, setError] = useState('');
  // The chosen kind and 관심 answer the controls at once; the shown pair changes with the list.
  const [kind, setKind] = useState<KindFilter>(initialKind ?? 'all');
  const [wishlistOnly, setWishlistOnly] = useState(false);
  const [shown, setShown] = useState<{kind: KindFilter; wishlistOnly: boolean}>(() => ({kind: initialKind ?? 'all', wishlistOnly: false}));
  const latest = useRef({kind: shown.kind, wishlistOnly: shown.wishlistOnly, privacy: privateMode});
  latest.current = {kind: shown.kind, wishlistOnly: shown.wishlistOnly, privacy: privateMode};
  const [tick, setTick] = useState(0);
  const [retry, setRetry] = useState(0);
  const [acknowledging, setAcknowledging] = useState<string | null>(null);
  const referenceYear = new Date().getFullYear();

  useEffect(() => { setKind(initialKind ?? 'all'); }, [initialKind]);
  useEffect(() => { if (reply) onSnapshot?.(reply); }, [reply, onSnapshot]);

  useEffect(() => {
    if (!backRef) return;
    backRef.current = () => { onClose(); return true; };
    return () => { backRef.current = null; };
  }, [backRef, onClose]);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    setError('');
    void flushUpcomingWishlist(controller.signal).then(() => api<unknown>('/v1/home/upcoming', controller.signal)).then(async value => {
      if (controller.signal.aborted) return;
      const next = normalizeReleaseCalendarReply(value);
      const view = latest.current;
      await prepareCovers(filterReleaseEntries(view.wishlistOnly ? next.wishlist : next.entries, view.kind, view.wishlistOnly, visibleWishlistIds(wishlistIds(next), readUpcomingWishlistIntents())), view.privacy, controller.signal);
      if (controller.signal.aborted) return;
      reconcileUpcomingWishlist(wishlistIds(next));
      setReply(next);
      setState(next.entries.length || next.wishlist.length || next.publishedAt ? 'ready' : 'empty');
      setTick(value => value + 1);
    }, reason => {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && reason.status === 404 || (reason as {status?: number})?.status === 404) {
        setReply({publishedAt: null, rangeStart: null, rangeEnd: null, entries: [], wishlist: [], pending: []});
        setState('empty');
      } else {
        setState('error');
        setError(errorText(reason) || '발매 캘린더를 불러오지 못했습니다.');
      }
    });
    return () => controller.abort();
  }, [retry]);

  const authoritativeIds = useMemo(() => reply ? wishlistIds(reply) : new Set<string>(), [reply]);
  const localIntents = readUpcomingWishlistIntents();
  const visibleIds = useMemo(() => visibleWishlistIds(authoritativeIds, localIntents), [authoritativeIds, tick]);
  const scroller = useRef<HTMLElement>(null);
  const calendarEntries = useMemo(() => reply ? filterReleaseEntries(shown.wishlistOnly ? reply.wishlist : reply.entries, shown.kind, shown.wishlistOnly, visibleIds) : [], [reply, shown, visibleIds]);
  // The scrubber walks the entries in the order the screen shows them (grouped by month).
  const scrubberSort=useMemo(()=>({kind:'date' as const,values:groupReleaseEntries(calendarEntries).flatMap(month=>month.days.flatMap(day=>day.items.map(entry=>entry.date)))}),[calendarEntries]);
  const count = visibleIds.size;

  function toggle(entry: ReleaseCalendarEntry) {
    const current = visibleUpcomingWishlist(entry.id, authoritativeIds.has(entry.id)).value;
    commitUpcomingWishlist(entry.id, !current);
    setTick(value => value + 1);
    const controller = new AbortController();
    void flushUpcomingWishlist(controller.signal).finally(() => controller.abort());
  }

  async function acknowledge(entry: ReleaseCalendarEntry, event: ReleaseCalendarEvent) {
    if (acknowledging) return;
    setAcknowledging(event.id);
    setError('');
    const controller = new AbortController();
    try {
      await api('/v1/home/upcoming/wishlist', controller.signal, {
        version: 1,
        operationId: crypto.randomUUID(),
        action: 'acknowledge',
        itemId: entry.id,
        eventIds: [event.id],
      }, 'POST');
      setReply(current => current ? {
        ...current,
        wishlist: current.wishlist.map(item => item.id === entry.id ? {...item, unread: item.unread.filter(candidate => candidate.id !== event.id)} : item),
        entries: current.entries.map(item => item.id === entry.id ? {...item, unread: item.unread.filter(candidate => candidate.id !== event.id)} : item),
      } : current);
    } catch (reason) {
      setError(errorText(reason) || '알림을 확인 처리하지 못했습니다.');
    } finally {
      controller.abort();
      setAcknowledging(null);
    }
  }

  const kindCounts = useMemo(() => {
    const entries = filterReleaseEntries(reply?.entries ?? [], 'all', false, visibleIds);
    return {all: entries.length, game: entries.filter(entry => entry.kind === 'game').length, movie: entries.filter(entry => entry.kind === 'movie').length, anime: entries.filter(entry => entry.kind === 'anime').length};
  }, [reply]);
  const kindOptions = ([
    {value: 'all', label: '전체', count: kindCounts.all},
    {value: 'game', label: '게임', count: kindCounts.game},
    {value: 'movie', label: '영화', count: kindCounts.movie},
    {value: 'anime', label: '애니', count: kindCounts.anime},
  ] as const);
  // A kind or 관심 switch is a category switch: the shown list stays until the chosen one's first
  // covers are decoded (capped), then the shared view swap moves it in from the side of travel.
  const order = (value: {kind: KindFilter; wishlistOnly: boolean}) => kindOptions.findIndex(option => option.value === value.kind) + (value.wishlistOnly ? kindOptions.length : 0);
  const swapOwner = useRef({}).current;
  useEffect(() => {
    if (kind === shown.kind && wishlistOnly === shown.wishlistOnly) { cancelSegmentSwap(swapOwner); return; }
    const next = {kind, wishlistOnly};
    if (state !== 'ready' || !reply) { setShown(next); return; }
    const controller = new AbortController();
    void prepareCovers(filterReleaseEntries(wishlistOnly ? reply.wishlist : reply.entries, kind, wishlistOnly, visibleIds), privateMode, controller.signal).then(() => {
      if (controller.signal.aborted) return;
      const host = scroller.current;
      swapSegment(swapOwner, {forward: order(next) >= order(shown), target: host, still: host?.querySelector<HTMLElement>(':scope > .mobile-scrubber'), commit: () => setShown(next)});
    });
    return () => controller.abort();
  }, [kind, wishlistOnly, shown, state]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => cancelSegmentSwap(swapOwner), [swapOwner]);
  // The first covers rise in like the gallery's first batch.
  useFirstAppearance(scroller, calendarEntries.length, state === 'ready', 'release-calendar', '.release-calendar-card');
  const unreadTotal = reply?.wishlist.reduce((sum, entry) => sum + entry.unread.length, 0) ?? 0;

  const header = <TopBar back={{label: '홈으로', onClick: onClose}} crumbs={<span className="top-bar__crumbs">홈 ›</span>} title="발매 캘린더" count={reply && reply.entries.length ? reply.entries.length.toLocaleString('ko-KR') : undefined} />;
  return <div className="release-calendar-screen">
    {!embedded&&header}
    <div ref={stripWheel} className="release-calendar-controls">
      <SegmentedControl className="release-calendar-segments" label="종류" options={kindOptions} value={kind} onChange={setKind} />
      <Button type="button" size="sm" variant="quiet" className={`release-calendar-interest${wishlistOnly ? ' is-selected' : ''}`} aria-label={`관심 목록 ${count.toLocaleString('ko-KR')}`} aria-pressed={wishlistOnly} onClick={() => setWishlistOnly(value => !value)}><BookmarkOutlineIcon aria-hidden="true" />관심 <span className="numeric">{count.toLocaleString('ko-KR')}</span></Button>
      {unreadTotal > 0 && <Badge variant="accent">NEW {unreadTotal.toLocaleString('ko-KR')}</Badge>}
    </div>
    {error && <div className="release-calendar-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>}
    <main ref={scroller} className="release-calendar-scroll" aria-label="발매 캘린더 목록">
      {state === 'loading' && <LoadingCalendar />}
      {state === 'empty' && <EmptyCalendar wishlistOnly={shown.wishlistOnly} />}
      {state === 'ready' && reply && <CalendarBody reply={reply} kind={shown.kind} wishlistOnly={shown.wishlistOnly} visibleIds={visibleIds} privacy={privateMode} referenceYear={referenceYear} acknowledging={acknowledging} onToggle={toggle} onAcknowledge={acknowledge} />}
      <Scrubber scrollRef={scroller} total={calendarEntries.length} sort={scrubberSort} hidden={state!=='ready'} />
    </main>
  </div>;
}
