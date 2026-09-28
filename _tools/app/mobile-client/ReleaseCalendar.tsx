import {BookmarkIcon as BookmarkOutlineIcon} from '@heroicons/react/24/outline';
import {BookmarkIcon} from '@heroicons/react/24/solid';
import {useEffect, useMemo, useRef, useState, type MutableRefObject} from 'react';
import {TopBar} from './TopBar';
import {api, ApiError, errorText, native} from './transport';
import {usePrivacyMode} from './privacyMode';
import {commitUpcomingWishlist, flushUpcomingWishlist, readUpcomingWishlistIntents, reconcileUpcomingWishlist, visibleUpcomingWishlist} from './upcomingWishlistOutbox';
import {PlatformBadges} from '../src/collections/PlatformBadges';
import type {Ticket} from './types';
import {detailLabel, filterReleaseEntries, groupReleaseEntries, kindLabel, normalizeReleaseCalendarReply, releaseDateLabel, visibleWishlistIds, wishlistIds, type KindFilter, type ReleaseCalendarEntry, type ReleaseCalendarReply} from './releaseCalendarModel';
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
  return <div className="release-calendar-empty" role="status">
    <span className="release-calendar-empty-mark" aria-hidden="true">—</span>
    <h2>{wishlistOnly ? '관심 목록이 비어 있습니다' : 'PC 앱이 발매 캘린더를 아직 보내지 않았습니다'}</h2>
    <p>{wishlistOnly ? '캘린더에서 책갈피를 눌러 기다리는 작품을 모아 보세요.' : 'PC 앱에서 발매 캘린더를 게시하면 이곳에 표시됩니다.'}</p>
  </div>;
}

function ReleaseCard({entry, watched, pending, privacy, referenceYear, onToggle}: {entry: ReleaseCalendarEntry; watched: boolean; pending: boolean; privacy: boolean; referenceYear: number; onToggle(): void}) {
  return <li className={`release-calendar-card${watched ? ' is-watched' : ''}${pending ? ' is-pending' : ''}`}>
    <div className={`release-calendar-cover release-calendar-cover--${entry.kind}`}>
      <HomeCoverImage cover={entry.cover} alt={entry.title} privacy={privacy} />
      <button type="button" className="release-calendar-watch" aria-pressed={watched} aria-busy={pending} aria-label={watched ? `${entry.title} 관심 목록에서 빼기${pending ? ' · 동기화 대기' : ''}` : `${entry.title} 관심 목록에 추가${pending ? ' · 동기화 대기' : ''}`} onClick={onToggle}>
        {watched ? <BookmarkIcon aria-hidden="true" /> : <BookmarkOutlineIcon aria-hidden="true" />}
      </button>
    </div>
    <div className="release-calendar-card-meta">
      <strong>{entry.title}</strong>
      {entry.originalTitle && entry.originalTitle !== entry.title && <span className="release-calendar-original">{entry.originalTitle}</span>}
      <span className="release-calendar-date">{releaseDateLabel(entry.date, entry.precision, referenceYear)}</span>
      {entry.kind === 'game' && entry.platforms.length > 0
        ? <span className="release-calendar-detail"><PlatformBadges platforms={entry.platforms} port={entry.port} /></span>
        : <span className="release-calendar-detail"><span className="release-calendar-kind">{kindLabel(entry.kind)}</span><span>{detailLabel(entry)}</span></span>}
      {pending && <span className="release-calendar-pending" role="status">동기화 대기</span>}
    </div>
  </li>;
}

function CalendarBody({reply, kind, wishlistOnly, visibleIds, privacy, referenceYear, onToggle}: {reply: ReleaseCalendarReply; kind: KindFilter; wishlistOnly: boolean; visibleIds: Set<string>; privacy: boolean; referenceYear: number; onToggle(entry: ReleaseCalendarEntry): void}) {
  const source = wishlistOnly ? reply.wishlist : reply.entries;
  const entries = filterReleaseEntries(source, kind, wishlistOnly, visibleIds);
  const groups = groupReleaseEntries(entries);
  if (!entries.length) return <EmptyCalendar wishlistOnly={wishlistOnly} />;
  return <div className="release-calendar-groups">
    {groups.map(month => <section key={month.key} className="release-calendar-month" aria-label={month.label}>
      <div className="release-calendar-month-heading"><h2>{month.label}</h2><span className="numeric">{month.items.toLocaleString('ko-KR')}</span></div>
      {month.days.map(day => <section key={day.key} className="release-calendar-day" aria-label={day.label}>
        <h3>{day.label}</h3>
        <ul className="release-calendar-card-grid">
          {day.items.map(entry => {
            const visible = visibleUpcomingWishlist(entry.id, visibleIds.has(entry.id));
            return <ReleaseCard key={entry.id} entry={entry} watched={visible.value} pending={visible.pending} privacy={privacy} referenceYear={referenceYear} onToggle={() => onToggle(entry)} />;
          })}
        </ul>
      </section>)}
    </section>)}
  </div>;
}

export type ReleaseCalendarProps = {
  onClose: () => void;
  backRef?: MutableRefObject<(() => boolean) | null>;
};

export function ReleaseCalendar({onClose, backRef}: ReleaseCalendarProps) {
  const [privateMode] = usePrivacyMode();
  const [reply, setReply] = useState<ReleaseCalendarReply | null>(null);
  const [state, setState] = useState<ScreenState>('loading');
  const [error, setError] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [wishlistOnly, setWishlistOnly] = useState(false);
  const [tick, setTick] = useState(0);
  const [retry, setRetry] = useState(0);
  const referenceYear = new Date().getFullYear();

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
  const scrubberSort=useMemo(()=>({kind:'date' as const,values:calendarEntries.map(entry=>entry.date)}),[calendarEntries]);
  const count = visibleIds.size;

  function toggle(entry: ReleaseCalendarEntry) {
    const current = visibleUpcomingWishlist(entry.id, authoritativeIds.has(entry.id)).value;
    commitUpcomingWishlist(entry.id, !current);
    setTick(value => value + 1);
    const controller = new AbortController();
    void flushUpcomingWishlist(controller.signal).finally(() => controller.abort());
  }

  const header = <TopBar back={{label: '홈으로', onClick: onClose}} crumbs={<span className="top-bar__crumbs">홈 ›</span>} title="발매 캘린더" count={reply && reply.entries.length ? reply.entries.length.toLocaleString('ko-KR') : undefined} />;
  return <div className="release-calendar-screen">
    {header}
    <div className="release-calendar-controls">
      <div className="release-calendar-segments" role="radiogroup" aria-label="종류">
        {([['all', '전체'], ['game', '게임'], ['movie', '영화'], ['anime', '애니']] as const).map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={kind === value} onClick={() => setKind(value)}>{label}</button>)}
      </div>
      <button type="button" className="release-calendar-interest" aria-pressed={wishlistOnly} onClick={() => setWishlistOnly(value => !value)}><BookmarkIcon aria-hidden="true" />관심 목록 <span className="numeric">{count.toLocaleString('ko-KR')}</span></button>
    </div>
    {error && <div className="release-calendar-error" role="alert"><span>{error}</span><button type="button" onClick={() => setRetry(value => value + 1)}>다시 시도</button></div>}
    <main ref={scroller} className="release-calendar-scroll" aria-label="발매 캘린더 목록">
      {state === 'loading' && <div className="release-calendar-loading" role="status">발매 캘린더를 불러오는 중입니다</div>}
      {state === 'empty' && <EmptyCalendar wishlistOnly={false} />}
      {state === 'ready' && reply && <CalendarBody reply={reply} kind={kind} wishlistOnly={wishlistOnly} visibleIds={visibleIds} privacy={privateMode} referenceYear={referenceYear} onToggle={toggle} />}
      <Scrubber scrollRef={scroller} total={calendarEntries.length} sort={scrubberSort} hidden={state!=='ready'} />
    </main>
  </div>;
}
