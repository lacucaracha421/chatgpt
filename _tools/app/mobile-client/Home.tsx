import {startupMark} from './startupPerf';
import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {RectangleStackIcon} from '@heroicons/react/24/outline';
import {collectionCover, type CollectionSummary} from './collectionModel';
import {localToday} from './collectionReleasesModel';
import {Cover} from './CoverGroup';
import {daysAfter, shelfEntries, useHomeDashboard, useHomeMemos, useHomeRevisit, useHomeUpcoming, type HomeCover, type UpcomingHomeEntry} from './homeDashboard';
import type {CharacterIndex} from './characterModel';
import type {ExchangeSnapshot} from './exchangeModel';
import {api, native} from './transport';
import {mediaTicket} from './media';
import {BottomSheet} from './BottomSheet';
import {usePullToRefresh} from './usePullToRefresh';
import {usePrivacyMode} from './privacyMode';
import type {Asset, Ticket} from './types';
import {KIND_LABEL} from '../src/collections/collectionFormat';
import {ddayLabel, displayDate} from '../src/shared/displayDate';
import {Badge, EmptyState, Skeleton} from './ui';
import {BookmarkToggle} from '../src/shared/ui/BookmarkToggle';
import {HomeSection, HomeToday, type HomeReleaseCard} from '../src/home/HomeAttention';
import {HomeReleaseGrid} from '../src/home/HomeReleaseGrid';
import {HomePlayingShelf} from '../src/home/HomePlayingShelf';
import {HomeDay} from '../src/home/HomeRevisit';
import {LightCase} from '../src/collections/case/LightCase';
import {workCasePlatform} from '../src/collections/case/CollectionCase';
import {BusyLabel} from '../src/shared/ui/BusyLabel';
import {HomeAssetImage, useTabletHomeDaily} from './HomeMedia';
import {contentCross, EASE_STANDARD, reducedMotion} from '../src/shared/motion/curves';
import {attentionRows} from '../src/home/homeAttentionModel';
import {useHomeVisit} from '../src/home/useHomeVisit';
import {koreanReleases} from './collectionReleasesModel';
import {useLocalDayClock} from '../src/shared/useLocalDayClock';
import {StableImage} from '../src/shared/ui/StableImage';
import {useLaunchReady} from '../src/shared/launch/LaunchSplash';
import '../src/home/home.css';
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

function useHomeArtwork(item: CollectionSummary, revision: string, active: boolean, artworkId = collectionCover(item), assetId = item.coverAssetId) {
  const digest = artworkId ? item.artworkVersions?.[artworkId]?.thumbnail ?? revision : item.coverAssetId ?? revision;
  const source = JSON.stringify([item.id, artworkId ?? null, assetId ?? null, digest]);
  const [url, setUrl] = useState(() => {
    const hit = homeArtworkCache.get(source);
    return hit && hit.until > Date.now() ? hit.url : '';
  });
  useEffect(() => {
    if (!active || (!artworkId && !assetId)) return;
    const hit = homeArtworkCache.get(source);
    if (hit && hit.until > Date.now()) { setUrl(hit.url); return; }
    homeArtworkCache.delete(source);
    let load = homeArtworkLoads.get(source);
    if (!load) {
      const controller = new AbortController();
      const request = artworkId
        ? native<Ticket>('collectionArtwork', {collectionId: item.id, artworkId, variant: 'thumbnail', revision, digest: item.artworkVersions?.[artworkId]?.thumbnail ?? ''}, controller.signal)
        : mediaTicket({id: assetId!, kind: 'image'}, 'thumbnail', controller.signal);
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
  }, [active, artworkId, assetId, item, revision, source]);
  return url;
}

function HomeMangaCover({item, revision, label, active}: {item: CollectionSummary; revision: string; label: string; active: boolean}) {
  const url = useHomeArtwork(item, revision, active);
  return url ? <StableImage className="collection-art" src={url} alt={label} /> : <span className="home-cover-placeholder"><RectangleStackIcon aria-hidden="true" /></span>;
}

function HomePlayingCase({item, revision, active, privacy, selected}: {item: CollectionSummary; revision: string; active: boolean; privacy: boolean; selected: boolean}) {
  const front = useHomeArtwork(item, revision, active && !privacy);
  const spine = useHomeArtwork(item, revision, active && !privacy, item.spineArtworkId ?? null, null);
  return <LightCase selected={selected} frontPending={!privacy && !!(collectionCover(item) || item.coverAssetId) && !front} spinePending={!privacy && !!item.spineArtworkId && !spine}
    data={{title: item.name, author: item.author, publisher: item.publisher, developer: item.developer, platform: workCasePlatform(item.type, item.platforms, item.ownedPlatform), front: privacy ? null : front || null, spine: privacy ? null : spine || null, privacy}} />;
}

const upcomingKind: Record<UpcomingHomeEntry['kind'], string> = KIND_LABEL;

function UpcomingDetailSheet({entry, interested, privacy, onToggle, onClose}: {entry: UpcomingHomeEntry; interested: boolean; privacy: boolean; onToggle(): void; onClose(): void}) {
  const days = entry.date ? daysAfter(entry.date, localToday()) : null;
  return <BottomSheet title={entry.title} onClose={onClose}><div className="home-detail-sheet"><div className="home-detail-cover"><HomeCoverImage cover={entry.cover} alt={entry.title} privacy={privacy} /></div><Badge>{upcomingKind[entry.kind]}</Badge>{entry.originalTitle && <p className="home-detail-original">{entry.originalTitle}</p>}<p className="home-detail-meta">{entry.date ? displayDate(entry.date) : '발매일 미정'}{days !== null && ` · ${ddayLabel(days) ?? '발매됨'}`}</p>{entry.platforms?.length ? <p className="home-detail-meta">{entry.platforms.join(' · ')}</p> : null}{entry.description && <p className="home-detail-description">{entry.description}</p>}<BookmarkToggle className="home-detail-bookmark" bookmarked={interested} label={interested ? '관심 목록에서 빼기' : '관심 목록에 추가'} onClick={onToggle} /></div></BottomSheet>;
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
  const shelf = d.shelf;
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
    future.push({ key: `title:${entry.id}`, name: entry.title, date: entry.date, detail: upcomingKind[entry.kind], cover: <HomeCoverImage cover={entry.cover} alt="" privacy={privacy} />, onOpen: () => setDetail(entry) });
  }
  for (const work of shelf?.works ?? []) {
    if ((work.type !== 'game' && work.type !== 'movie') || !work.releaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(work.releaseDate)) continue;
    const days = daysAfter(work.releaseDate, today);
    if (days < 0 || days > 14 || future.some(row => row.name === work.name && row.date === work.releaseDate)) continue;
    future.push({key: `work:${work.id}`, name: work.name, date: work.releaseDate, detail: KIND_LABEL[work.type], cover: cover(work.id, work.name), onOpen: () => props.onWork(work.id)});
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
  const releaseCards: HomeReleaseCard[] = [
    ...visit.arrivals.map(e => ({key: e.key, name: e.name, date: e.date, detail: e.external ? upcomingKind[e.external.kind] : e.detail === '발매됨' ? KIND_LABEL[works.get(e.workId)?.type ?? 'game'] : e.detail, fresh: true,
      cover: e.external ? <HomeCoverImage cover={e.external.cover} alt="" privacy={privacy} /> : cover(e.workId, e.name),
      onOpen: () => {visit.opened(e.token); if (e.external) setDetail(e.external); else props.onWork(e.workId);}})),
    ...future.filter(row => !visit.arrivals.some(e => e.key === row.key && e.date === row.date)),
  ];
  const playing = (shelf?.works ?? []).filter(work => work.type === 'game' && work.status === 'playing' || work.type === 'movie' && work.status === 'watching');
  const attentionPending = !memos || reviewRows.some(row => row.count === null);
  const quiet = rows.length === 0 && !attentionPending;
  const daily = useTabletHomeDaily(!paused && revisit !== null && !dateGroup && quiet, props.scope, today, d.refreshKey);
  const dayPending = revisit === null || quiet && !dateGroup && !daily.value && !daily.failed;
  const layoutShown = useRef(false);
  if ((d.releasesReady && upcoming.ready || d.offline || d.serverProblem) && (!attentionPending || d.offline || d.serverProblem) && !dayPending) layoutShown.current = true;
  const firstLoad = !layoutShown.current;
  if(!firstLoad)startupMark('homeReadyMs');
  // On app start the launch splash covers this first load, then leaves with Home's first images.
  useLaunchReady(!firstLoad, homeScroll);
  useLayoutEffect(() => {
    if (firstLoad || reducedMotion()) return;
    const host = homeScroll.current?.querySelector<HTMLElement>('.home-tablet-layout');
    const animation = host?.animate?.([{opacity: 0}, {opacity: 1}], {duration: contentCross.enter, easing: EASE_STANDARD});
    return () => animation?.cancel();
  }, [firstLoad]);
  const nextDayData = revisit === null ? null : {playing: [], dailyAsset: daily.value?.asset ? {id: daily.value.asset.id, collectedAt: daily.value.asset.collected_at ?? '', favorite: true} : null,
    anniversary: dateGroup ? {id: 'date', kind: 'date' as const, title: dateGroup.title, reason: '', revision: 0, assetIds: dateGroup.items.map(asset => asset.id)} : null};
  const nextDay = {scope: props.scope, data: nextDayData, group: dateGroup, asset: daily.value?.asset, quiet: quiet && daily.value?.available === true};
  const keptDay = useRef(nextDay);
  if (keptDay.current.scope !== props.scope || !dayPending && (!daily.failed || daily.value || dateGroup || !quiet)) keptDay.current = nextDay;
  const day = keptDay.current;
  const image = (id: string, variant: 'thumbnail' | 'original', className?: string) => {
    const asset = day.asset?.id === id ? day.asset : day.group?.items.find(item => item.id === id);
    return asset ? className ? <HomeAssetImage key={id} asset={asset} variant={variant} className={className} paused={paused} /> : <Cover asset={asset} paused={paused} /> : null;
  };
  return <div className={`home-scroll home-attention-mobile${privacy ? ' is-private' : ''}`} ref={homeScroll} aria-label="홈">
    {pull}
    {firstLoad ? <div className="home-media-waiting" aria-busy="true"><Skeleton label="홈 미디어" /><BusyLabel busy>홈 불러오는 중</BusyLabel></div> : <div className="home-tablet-layout">
    <div className="home-tablet-day-column">
    {rows.length > 0 && <div className="home-tablet-today"><HomeToday rows={rows} animate={false} onOpen={row => {
      if (row.noteId) props.onNotes(row.noteId);
      else if (row.key === 'unsorted') props.onUnclassified();
      else if (row.key === 'similar') props.onSimilarity();
      else if (row.key === 'pending') props.onPending();
      else if (row.key === 'duplicates') props.onDuplicates();
      else if (row.key === 'connection:exchange') props.onExchange();
      else if (row.key.startsWith('connection:')) props.onSettings();
    }} /></div>}
    <div className="home-tablet-day"><HomeDay data={day.data} failed={daily.failed} quiet={day.quiet} privacyMode={privacy} image={image} emptyAnniversary anniversaryCount={day.group?.count}
      onOpenAsset={day.group && props.onRevisit ? () => props.onRevisit?.('date', day.group!.title) : undefined} />
      {daily.failed && <button className="home-interest-action" onClick={refreshHome}>다시 시도</button>}
    </div></div>
    <div className="home-tablet-media-column">
    <div className="home-tablet-playing"><HomePlayingShelf onOpen={props.onWork} works={playing.map(work => ({id: work.id, name: work.name, platform: work.ownedPlatform || work.platforms || KIND_LABEL[work.type], score: work.myScore ?? null,
      case: selected => <HomePlayingCase item={work} revision={shelf?.revision ?? ''} active={!paused} privacy={privacy} selected={selected} />}))} /></div>
    <div className="home-tablet-releases"><HomeSection title="2주 안에 발매" count={releaseCards.length} onOpen={props.onReleases}>
      {releaseCards.length ? <HomeReleaseGrid today={today} rows={releaseCards.slice(0, 14)} /> : <EmptyState inline className="home-attention-empty" title="2주 안에 예정된 발매가 없습니다" />}
    </HomeSection></div>
    </div></div>}
    {secondaryError && <p className="hint" role="status">{secondaryError}</p>}
    {detail && <UpcomingDetailSheet entry={detail} interested={upcoming.wishlist.has(detail.id)} privacy={privacy} onToggle={() => upcoming.toggle(detail.id)} onClose={() => setDetail(null)} />}
  </div>;
}
