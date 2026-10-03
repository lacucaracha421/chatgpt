import {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {RectangleStackIcon} from '@heroicons/react/24/outline';
import {collectionCover, type CollectionSummary} from './collectionModel';
import {localToday} from './collectionReleases';
import {Cover} from './CoverGroup';
import {currentShelf, subscribeReleases} from './releaseStore';
import {daysAfter, shelfEntries, useHomeDashboard, useHomeMemos, useHomeRevisit, useHomeUpcoming, type HomeCover, type RevisitGroup, type UpcomingHomeEntry} from './homeDashboard';
import type {CharacterIndex} from './characterModel';
import type {ExchangeSnapshot} from './exchange';
import {api, native} from './transport';
import {mediaTicket} from './media';
import {BottomSheet} from './BottomSheet';
import {usePullToRefresh} from './usePullToRefresh';
import {usePrivacyMode} from './privacyMode';
import type {Asset, Ticket} from './types';
import {KIND_LABEL} from '../src/collections/collectionFormat';
import {ddayLabel, displayDate} from '../src/shared/displayDate';
import {Badge, Skeleton} from './ui';
import {HomeAttentionLayout, HomePresence, HomeReleaseList, HomeSection, HomeToday, type HomeReleaseCard} from '../src/home/HomeAttention';
import {attentionRows} from '../src/home/homeAttention';
import {useHomeVisit} from '../src/home/useHomeVisit';
import {koreanReleases} from './collectionReleases';
import {useLocalDayClock} from '../src/shared/useLocalDayClock';
import {StableImage} from '../src/shared/ui/StableImage';
import './home.css';

export interface HomeProps {
  items: Asset[]; hasMore: boolean; captures: Asset[] | null; busy: boolean; paused: boolean; secondaryError: string;
  scope: string; exchange: ExchangeSnapshot | null;
  /** Retained for compatibility with callers that still hold the character index. Home does not expose review. */
  characters?: CharacterIndex | null;
  /** Retained input shape; the tablet deliberately omits this review category. */
  review: {enabled: boolean; refreshKey: unknown}; similarityKey: unknown;
  onPending(): void; onReview(): void; onSimilarity(): void; onDuplicates(): void; onExchange(): void;
  onReleases(): void; onWork(id: string): void; onSettings(): void; onRecent(): void; onLibrary(): void; onUnclassified(): void;
  onRevisit?(key: string, title: string): void; onArtists?(): void; onNotes(id?: string): void; onRefresh?(): void;
}

function HomeCoverImage({cover, alt, privacy = false, className = ''}: {cover?: HomeCover | null; alt: string; privacy?: boolean; className?: string}) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (privacy || !cover) { setUrl(''); return; }
    const sha256 = cover.sha256;
    if (!sha256) {
      if (cover.url && /^https:\/\//.test(cover.url)) { setUrl(cover.url); return; }
      setUrl(''); return;
    }
    const controller = new AbortController();
    const request = window.LakomicsNative
      ? native<Ticket>('homeCover', {sha256}, controller.signal)
      : api<Ticket>(`/v1/home/covers/${encodeURIComponent(sha256)}/media-ticket`, controller.signal, undefined, 'POST');
    void request.then(reply => {
      if (!controller.signal.aborted && reply?.url && /^https:\/\//.test(reply.url)) setUrl(reply.url);
    }, () => {});
    return () => controller.abort();
  }, [cover?.url, cover?.sha256, privacy]);
  if (privacy) return <span className={`home-cover-placeholder is-private ${className}`} aria-label="비공개 모드로 이미지 숨김" />;
  return url ? <StableImage className={`home-home-image ${className}`} src={url} alt={alt} /> : <span className={`home-cover-placeholder ${className}`} aria-label={`${alt} 표지 준비 중`} />;
}

type HomeArtworkCacheEntry = {url: string; until: number};
const HOME_ARTWORK_KEEP_MS = 4 * 60_000;
const homeArtworkCache = new Map<string, HomeArtworkCacheEntry>();
const homeArtworkLoads = new Map<string, Promise<string>>();

function homeArtworkUrl(value: string) { return /^https:\/\//.test(value) || (import.meta.env.DEV && value.startsWith('data:image/')); }
async function decodeHomeArtwork(url: string) {
  if (typeof Image === 'undefined') return;
  const image = new Image(); image.src = url;
  try { await image.decode?.(); } catch { /* The img element reports the failed decode. */ }
}

function HomeMangaCover({item, revision, label, active}: {item: CollectionSummary; revision: string; label: string; active: boolean}) {
  const artworkId = collectionCover(item);
  const digest = artworkId ? item.artworkVersions?.[artworkId]?.thumbnail ?? revision : item.coverAssetId ?? revision;
  const source = JSON.stringify([item.id, artworkId ?? null, item.coverAssetId ?? null, digest]);
  const [url, setUrl] = useState(() => {
    const hit = homeArtworkCache.get(source);
    return hit && hit.until > Date.now() ? hit.url : '';
  });
  useEffect(() => {
    if (!active || (!artworkId && !item.coverAssetId)) return;
    const hit = homeArtworkCache.get(source);
    if (hit && hit.until > Date.now()) { setUrl(hit.url); return; }
    homeArtworkCache.delete(source);
    let load = homeArtworkLoads.get(source);
    if (!load) {
      const controller = new AbortController();
      const request = artworkId
        ? native<Ticket>('collectionArtwork', {collectionId: item.id, artworkId, variant: 'thumbnail', revision, digest: item.artworkVersions?.[artworkId]?.thumbnail ?? ''}, controller.signal)
        : mediaTicket({id: item.coverAssetId!, kind: 'image'}, 'thumbnail', controller.signal);
      load = request.then(async ticket => {
        if (!ticket?.url || !homeArtworkUrl(ticket.url)) throw new Error('Invalid artwork');
        await decodeHomeArtwork(ticket.url);
        homeArtworkCache.set(source, {url: ticket.url, until: Date.now() + (ticket.expires_in ? ticket.expires_in * 1000 : HOME_ARTWORK_KEEP_MS)});
        return ticket.url;
      }).finally(() => { if (homeArtworkLoads.get(source) === load) homeArtworkLoads.delete(source); });
      homeArtworkLoads.set(source, load);
    }
    let live = true;
    void load.then(next => { if (live) setUrl(next); }, () => {});
    return () => { live = false; };
  }, [active, artworkId, item, revision, source]);
  return url ? <StableImage className="collection-art" src={url} alt={label} /> : <span className="home-cover-placeholder"><RectangleStackIcon aria-hidden="true" /></span>;
}

const upcomingKind: Record<UpcomingHomeEntry['kind'], string> = KIND_LABEL;

function RevisitMosaic({group, paused, privacy, onOpen}: {group: RevisitGroup; paused: boolean; privacy: boolean; onOpen(): void}) {
  const items = group.items.slice(0, 7);
  const rows = items.length >= 5 ? [items.slice(0, 3), items.slice(3)] : [items];
  const ratio = (asset: Asset) => Number(asset.width) > 0 && Number(asset.height) > 0 ? Math.max(.4, Math.min(2.6, Number(asset.width) / Number(asset.height))) : 1;
  return <button className="home-revisit" onClick={onOpen} aria-label={`1년 전 오늘 ${group.count}장`}><span className="home-revisit-pics">{rows.map((row, index) => <span key={index} className="home-jrow">{row.map(asset => <span key={asset.id} className="home-jcell" style={{flexGrow: ratio(asset), aspectRatio: String(ratio(asset))}}>{privacy ? <span className="home-private-cell" aria-label="비공개 모드로 이미지 숨김" /> : <Cover asset={asset} paused={paused} />}</span>)}</span>)}</span><span className="home-caption"><span>1년 전 오늘</span><span className="numeric">{group.count}장</span></span></button>;
}

function UpcomingDetailSheet({entry, interested, privacy, onToggle, onClose}: {entry: UpcomingHomeEntry; interested: boolean; privacy: boolean; onToggle(): void; onClose(): void}) {
  const days = entry.date ? daysAfter(entry.date, localToday()) : null;
  return <BottomSheet title={entry.title} onClose={onClose}><div className="home-detail-sheet"><div className="home-detail-cover"><HomeCoverImage cover={entry.cover} alt={entry.title} privacy={privacy} /></div><Badge>{upcomingKind[entry.kind]}</Badge>{entry.originalTitle && <p className="home-detail-original">{entry.originalTitle}</p>}<p className="home-detail-meta">{entry.date ? displayDate(entry.date) : '발매일 미정'}{days !== null && ` · ${ddayLabel(days) ?? '발매됨'}`}</p>{entry.platforms?.length ? <p className="home-detail-meta">{entry.platforms.join(' · ')}</p> : null}{entry.description && <p className="home-detail-description">{entry.description}</p>}<button className="home-interest-action" onClick={onToggle}>{interested ? '관심 목록에서 빼기' : '관심 목록에 추가'}</button></div></BottomSheet>;
}

export function Home(props: HomeProps) {
  const {captures, paused, secondaryError} = props;
  const [privacy] = usePrivacyMode();
  const at = useLocalDayClock();
  const today = localToday(at);
  const d = useHomeDashboard({enabled: !paused, scope: props.scope, pending: captures?.length ?? null, similarityKey: props.similarityKey, exchange: props.exchange});
  const memos = useHomeMemos(!paused, props.scope, d.refreshKey);
  const upcoming = useHomeUpcoming(!paused, props.scope, d.refreshKey);
  const revisit = useHomeRevisit(!paused, props.scope, d.refreshKey);
  const homeScroll = useRef<HTMLDivElement>(null);
  const refreshHome = () => { d.retry(); props.onRefresh?.(); };
  const pull = usePullToRefresh(homeScroll, refreshHome, props.busy, paused);
  const [detail, setDetail] = useState<UpcomingHomeEntry | null>(null);
  const shelf = useSyncExternalStore(subscribeReleases, currentShelf);
  const works = useMemo(() => new Map((shelf?.works ?? []).map(work => [work.id, work])), [shelf]);
  const cover = (id: string, name: string) => {
    const work = works.get(id);
    return !privacy && work ? <HomeMangaCover item={work} revision={shelf?.revision ?? ''} active={!paused} label={name} /> : undefined;
  };
  const manga = shelfEntries(d.releases ?? [], d.upcoming ?? [], today, 14);
  const arrivals = new Map(manga.filter(e => e.kind === 'new').map(e => [e.id, { key: `manga:${e.id}`, token: `manga:${e.id}:${e.date ?? ''}:${e.volumes}`, date: e.date, fresh: true, name: e.name, detail: e.volumes, workId: e.id, external: null as UpcomingHomeEntry | null }]));
  if (shelf) for (const row of koreanReleases(shelf.works.filter(w => w.type === 'manga' && w.releaseWatch?.enabled), (work, edition) => work.ownedVolumes?.find(o => o.editionIndex === edition)?.count ?? null, [], today)) {
    const volume = row.volumes.filter(v => v.released && v.date && v.date <= today).sort((a,b) => b.date!.localeCompare(a.date!) || b.volumeNumber - a.volumeNumber)[0];
    if (volume && !arrivals.has(row.work.id)) arrivals.set(row.work.id, { key: `manga:${row.work.id}`, token: `manga:${row.work.id}:${volume.date}:${volume.volumeNumber}권`, date: volume.date, fresh: false, name: row.work.name, detail: `${volume.volumeNumber}권`, workId: row.work.id, external: null });
  }
  const muted = new Set(upcoming.wishlistItems.filter(entry => entry.muted).map(entry => entry.id));
  for (const entry of [...upcoming.wishlistItems, ...upcoming.entries]) {
    if (!upcoming.wishlist.has(entry.id) || muted.has(entry.id) || arrivals.has(`title:${entry.id}`)) continue;
    const event = (upcoming.wishlistItems.find(wish => wish.id === entry.id)?.events ?? []).filter(e => e.kind === 'released' && !e.readAt).sort((a,b) => b.detectedAt.localeCompare(a.detectedAt))[0];
    if (event || (entry.precision === 'exact' && entry.date && entry.date <= today)) arrivals.set(`title:${entry.id}`, { key: `title:${entry.id}`, token: `title:${entry.id}:${entry.date ?? event?.id ?? ''}`, date: entry.date ?? null, fresh: !!event, name: entry.title, detail: '발매됨', workId: '', external: entry });
  }
  // Published collection dates are already in the shelf; no extra detail reads.
  for (const work of shelf?.works ?? []) {
    if (work.type === 'av' || work.type === 'manga' || !work.releaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(work.releaseDate) || work.releaseDate > today) continue;
    if ([...arrivals.values()].some(e => e.name === work.name && e.date === work.releaseDate)) continue;
    arrivals.set(`work:${work.id}`, { key: `work:${work.id}`, token: `work:${work.id}:${work.releaseDate}`, date: work.releaseDate, fresh: false, name: work.name, detail: '발매됨', workId: work.id, external: null });
  }
  const visit = useHomeVisit(props.scope, [...arrivals.values()], today, !paused, at.toISOString(), d.releasesReady && upcoming.ready);
  const future: HomeReleaseCard[] = manga.filter(e => e.kind === 'upcoming').map(e => ({ key: `manga:${e.id}:${e.volumeNumber}`, name: e.name, date: e.date, detail: `${e.volumeNumber}권`, cover: cover(e.id, e.name), onOpen: () => props.onWork(e.id) }));
  const futureTitles = new Map(upcoming.wishlistItems.map(entry => [entry.id, entry as UpcomingHomeEntry & { muted?: boolean }]));
  for (const entry of upcoming.entries) if (upcoming.wishlist.has(entry.id) && !futureTitles.has(entry.id)) futureTitles.set(entry.id, entry);
  for (const entry of futureTitles.values()) {
    if (entry.muted || !upcoming.wishlist.has(entry.id) || entry.precision !== 'exact' || !entry.date) continue;
    const days = daysAfter(entry.date, today);
    if (days < 0 || days > 14) continue;
    future.push({ key: `title:${entry.id}`, name: entry.title, date: entry.date, cover: <HomeCoverImage cover={entry.cover} alt="" privacy={privacy} />, onOpen: () => setDetail(entry) });
  }
  future.sort((a,b) => (a.date ?? '').localeCompare(b.date ?? '') || a.name.localeCompare(b.name, 'ko'));
  const reviewRows = [
    { key: 'unsorted', label: '미분류 에셋', count: d.summary?.unclassified ?? null },
    { key: 'similar', label: '유사 이미지 검토', count: d.todos.similar, unit: '쌍' },
    { key: 'pending', label: '처리 대기', count: d.todos.pending },
    { key: 'duplicates', label: '중복 판본', count: d.todos.duplicates },
  ];
  const connections = [
    ...(d.offline || d.serverProblem ? [{ key: 'server', label: '서버', value: d.offline ? '연결 안 됨' : '요청을 처리할 수 없음', tone: 'off' }] : []),
    ...(props.exchange?.configured && props.exchange.code ? [{ key: 'exchange', label: 'PC 연결', value: '전송을 확인해 주세요', tone: 'off' }] : []),
    ...(d.catalogJob?.state === 'failed' ? [{ key: 'catalog', label: '카탈로그', value: '갱신 실패', tone: 'off' }] : []),
  ];
  const rows = attentionRows(memos?.notes ?? [], reviewRows, connections, today);
  const dateGroup = revisit?.find(group => group.key === 'date' && group.count > 0);
  const right = [
    ...(visit.arrivals.length ? [{ key: 'new', content: <HomeSection title="새로 나옴 · 지난번 이후" onOpen={props.onReleases}><HomeReleaseList today={today} rows={visit.arrivals.map(e => ({ key: e.key, name: e.name, date: e.date, detail: e.detail, fresh: true, cover: e.external ? <HomeCoverImage cover={e.external.cover} alt="" privacy={privacy} /> : cover(e.workId, e.name), onOpen: () => { visit.opened(e.token); if (e.external) setDetail(e.external); else props.onWork(e.workId); } }))} /></HomeSection> }] : []),
    ...(future.length ? [{ key: 'upcoming', content: <HomeSection title="2주 안에 나오는 신간" onOpen={props.onReleases}><HomeReleaseList rows={future} today={today} /></HomeSection> }] : []),
  ];
  // Same order as the PC: 1년 전 오늘 follows 오늘 할 것, before 새로 나옴 and 신간.
  const revisitSection = dateGroup ? <HomePresence items={[{ key: 'revisit', content: <HomeSection title={`1년 전 오늘 · ${dateGroup.count.toLocaleString()}장`}><RevisitMosaic group={dateGroup} paused={paused} privacy={privacy} onOpen={() => props.onRevisit?.('date', dateGroup.title)} /></HomeSection> }]} /> : revisit === null ? <HomeSection title="1년 전 오늘"><div className="home-revisit"><Skeleton label="1년 전 오늘" /></div></HomeSection> : null;
  return <div className={`home-scroll home-attention-mobile${privacy ? ' is-private' : ''}`} ref={homeScroll} aria-label="홈">
    {pull}
    <HomeAttentionLayout tablet today={<HomeToday rows={rows} loading={!memos || reviewRows.some(r => r.count === null) ? <Skeleton label="오늘 할 것" /> : undefined} onOpen={row => {
      if (row.noteId) props.onNotes(row.noteId);
      else if (row.key === 'unsorted') props.onUnclassified();
      else if (row.key === 'similar') props.onSimilarity();
      else if (row.key === 'pending') props.onPending();
      else if (row.key === 'duplicates') props.onDuplicates();
      else if (row.key === 'connection:exchange') props.onExchange();
      else if (row.key.startsWith('connection:')) props.onSettings();
    }} />} leftAfter={revisitSection} right={<HomePresence items={revisit === null ? [] : right} />} />
    {secondaryError && <p className="hint" role="status">{secondaryError}</p>}
    {detail && <UpcomingDetailSheet entry={detail} interested={upcoming.wishlist.has(detail.id)} privacy={privacy} onToggle={() => upcoming.toggle(detail.id)} onClose={() => setDetail(null)} />}
  </div>;
}
