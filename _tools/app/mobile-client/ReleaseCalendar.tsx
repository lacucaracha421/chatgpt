import {BookmarkIcon as BookmarkOutlineIcon, CalendarDaysIcon, CheckIcon} from '@heroicons/react/24/outline';
import {BookmarkIcon as BookmarkSolidIcon} from '@heroicons/react/24/solid';
import {useEffect, useMemo, useRef, useState, type MutableRefObject} from 'react';
import {TopBar} from './TopBar';
import {Badge, Button, SegmentedControl} from './ui';
import {api, ApiError, errorText, native} from './transport';
import {usePrivacyMode} from './privacyMode';
import {commitUpcomingWishlist, flushUpcomingWishlist, readUpcomingWishlistIntents, reconcileUpcomingWishlist, visibleUpcomingWishlist} from './upcomingWishlistOutbox';
import {PlatformBadges} from '../src/collections/PlatformBadges';
import type {Ticket} from './types';
import {filterReleaseEntries, groupReleaseEntries, normalizeReleaseCalendarReply, releaseDateLabel, releaseDaysUntil, releaseEventLine, visibleWishlistIds, wishlistIds, type KindFilter, type ReleaseCalendarEntry, type ReleaseCalendarEvent, type ReleaseCalendarReply} from './releaseCalendarModel';
import {Scrubber} from './Scrubber';
import './releaseCalendar.css';

type ScreenState = 'loading' | 'ready' | 'empty' | 'error';

function HomeCoverImage({cover, alt, privacy}: {cover: ReleaseCalendarEntry['cover']; alt: string; privacy: boolean}) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (privacy || !cover) { setUrl(''); return; }
    const sha256 = cover.sha256;
    if (!sha256) {
      if (cover.url && /^https:\/\//.test(cover.url)) { setUrl(cover.url); return; }
      setUrl(''); return;
    }
    const controller = new AbortController();
    setUrl('');
    const request = window.LakomicsNative
      ? native<Ticket>('homeCover', {sha256}, controller.signal)
      : api<Ticket>(`/v1/home/covers/${encodeURIComponent(sha256)}/media-ticket`, controller.signal, undefined, 'POST');
    void request.then(reply => {
      if (!controller.signal.aborted && reply?.url && /^https:\/\//.test(reply.url)) setUrl(reply.url);
    }, () => {});
    return () => controller.abort();
  }, [cover?.url, cover?.sha256, privacy]);
  if (privacy) return <span className="release-calendar-cover-placeholder is-private" aria-label="비공개 모드로 이미지 숨김" />;
  return url ? <img src={url} alt="" loading="lazy" decoding="async" draggable={false} /> : <span className="release-calendar-cover-placeholder" aria-label={`${alt} 표지 준비 중`} />;
}
function EmptyCalendar({wishlistOnly}: {wishlistOnly: boolean}) {
  const Icon = wishlistOnly ? BookmarkOutlineIcon : CalendarDaysIcon;
  return <div className="release-calendar-empty" role="status">
    <Icon aria-hidden="true" />
    <p>{wishlistOnly ? '관심 목록 비어 있음' : '6개월 안의 발매 정보 없음'}</p>
  </div>;
}

function ReleaseCard({entry, watched, pending, privacy, referenceYear, acknowledging, onToggle, onAcknowledge}: {entry: ReleaseCalendarEntry; watched: boolean; pending: boolean; privacy: boolean; referenceYear: number; acknowledging: string | null; onToggle(): void; onAcknowledge(event: ReleaseCalendarEvent): void}) {
  const days = releaseDaysUntil(entry.date);
  return <li className={`release-calendar-card${watched ? ' is-watched' : ''}${pending ? ' is-pending' : ''}`}>
    <div className="release-calendar-date-row">
      <span className="release-calendar-date numeric">{releaseDateLabel(entry.date, entry.precision, referenceYear)}</span>
      {days !== null && days > 0 && <span className="release-calendar-dday numeric">D-{days}</span>}
      <Button type="button" size="icon" variant="quiet" className="release-calendar-watch" aria-pressed={watched} aria-busy={pending} disabled={pending} aria-label={watched ? `${entry.title} 관심 목록에서 빼기${pending ? ' · 동기화 대기' : ''}` : `${entry.title} 관심 목록에 추가${pending ? ' · 동기화 대기' : ''}`} onClick={onToggle}>
        {watched ? <BookmarkSolidIcon aria-hidden="true" /> : <BookmarkOutlineIcon aria-hidden="true" />}
      </Button>
    </div>
    <div className="release-calendar-cover">
      <HomeCoverImage cover={entry.cover} alt={entry.title} privacy={privacy} />
      {entry.unread.length > 0 && <Badge className="release-calendar-new-badge" variant="accent">NEW</Badge>}
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
    {groups.map(month => <section key={month.key} className="release-calendar-month" aria-label={month.label}>
      <div className="release-calendar-month-heading"><h2>{month.label}</h2><span className="numeric">{month.items.toLocaleString('ko-KR')}</span></div>
      <ul className="release-calendar-card-grid">
        {month.days.flatMap(day => day.items).map(entry => {
          const visible = visibleUpcomingWishlist(entry.id, visibleIds.has(entry.id));
          return <ReleaseCard key={entry.id} entry={entry} watched={visible.value} pending={visible.pending} privacy={privacy} referenceYear={referenceYear} acknowledging={acknowledging} onToggle={() => onToggle(entry)} onAcknowledge={event => onAcknowledge(entry, event)} />;
        })}
      </ul>
    </section>)}
  </div>;
}

export type ReleaseCalendarProps = {
  onClose: () => void;
  backRef?: MutableRefObject<(() => boolean) | null>;
  initialKind?: Extract<KindFilter, 'game' | 'movie'>;
};

export function ReleaseCalendar({onClose, backRef, initialKind}: ReleaseCalendarProps) {
  const [privateMode] = usePrivacyMode();
  const [reply, setReply] = useState<ReleaseCalendarReply | null>(null);
  const [state, setState] = useState<ScreenState>('loading');
  const [error, setError] = useState('');
  const [kind, setKind] = useState<KindFilter>(initialKind ?? 'all');
  const [wishlistOnly, setWishlistOnly] = useState(false);
  const [tick, setTick] = useState(0);
  const [retry, setRetry] = useState(0);
  const [acknowledging, setAcknowledging] = useState<string | null>(null);
  const referenceYear = new Date().getFullYear();

  useEffect(() => { setKind(initialKind ?? 'all'); }, [initialKind]);

  useEffect(() => {
    if (!backRef) return;
    backRef.current = () => { onClose(); return true; };
    return () => { backRef.current = null; };
  }, [backRef, onClose]);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    setError('');
    void flushUpcomingWishlist(controller.signal).then(() => api<unknown>('/v1/home/upcoming', controller.signal)).then(value => {
      if (controller.signal.aborted) return;
      const next = normalizeReleaseCalendarReply(value);
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
  const calendarEntries = useMemo(() => reply ? filterReleaseEntries(wishlistOnly ? reply.wishlist : reply.entries, kind, wishlistOnly, visibleIds) : [], [reply, kind, wishlistOnly, visibleIds]);
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
    const entries = reply?.entries ?? [];
    return {all: entries.length, game: entries.filter(entry => entry.kind === 'game').length, movie: entries.filter(entry => entry.kind === 'movie').length, anime: entries.filter(entry => entry.kind === 'anime').length};
  }, [reply]);
  const kindOptions = ([
    {value: 'all', label: '전체', count: kindCounts.all},
    {value: 'game', label: '게임', count: kindCounts.game},
    {value: 'movie', label: '영화', count: kindCounts.movie},
    {value: 'anime', label: '애니', count: kindCounts.anime},
  ] as const);
  const unreadTotal = reply?.wishlist.reduce((sum, entry) => sum + entry.unread.length, 0) ?? 0;

  const header = <TopBar back={{label: '홈으로', onClick: onClose}} crumbs={<span className="top-bar__crumbs">홈 ›</span>} title="발매 캘린더" count={reply && reply.entries.length ? reply.entries.length.toLocaleString('ko-KR') : undefined} />;
  return <div className="release-calendar-screen">
    {header}
    <div className="release-calendar-controls">
      <SegmentedControl className="release-calendar-segments" label="종류" options={kindOptions} value={kind} onChange={setKind} />
      <Button type="button" size="sm" variant="quiet" className={`release-calendar-interest${wishlistOnly ? ' is-selected' : ''}`} aria-label={`관심 목록 ${count.toLocaleString('ko-KR')}`} aria-pressed={wishlistOnly} onClick={() => setWishlistOnly(value => !value)}><BookmarkOutlineIcon aria-hidden="true" />관심 <span className="numeric">{count.toLocaleString('ko-KR')}</span></Button>
      {unreadTotal > 0 && <Badge variant="accent">NEW {unreadTotal.toLocaleString('ko-KR')}</Badge>}
    </div>
    {error && <div className="release-calendar-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>}
    <main ref={scroller} className="release-calendar-scroll" aria-label="발매 캘린더 목록">
      {state === 'loading' && <div className="release-calendar-loading" role="status">발매 캘린더를 불러오는 중입니다</div>}
      {state === 'empty' && <EmptyCalendar wishlistOnly={wishlistOnly} />}
      {state === 'ready' && reply && <CalendarBody reply={reply} kind={kind} wishlistOnly={wishlistOnly} visibleIds={visibleIds} privacy={privateMode} referenceYear={referenceYear} acknowledging={acknowledging} onToggle={toggle} onAcknowledge={acknowledge} />}
      <Scrubber scrollRef={scroller} total={calendarEntries.length} sort={scrubberSort} hidden={state!=='ready'} />
    </main>
  </div>;
}
