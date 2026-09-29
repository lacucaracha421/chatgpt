import {useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {BookOpenIcon, ChevronRightIcon, InboxIcon, ListBulletIcon, RectangleStackIcon, Square2StackIcon, WalletIcon} from '@heroicons/react/24/outline';
import {collectionCover, type CollectionSummary} from './collectionModel';
import {koreanReleases, localToday} from './collectionReleases';
import {Cover} from './CoverGroup';
import {currentShelf, subscribeReleases} from './releaseStore';
import {addedToday, clockLabel, dateBlock, daysAfter, externalShelfRows, shelfEntries, useHomeArtists, useHomeAvPick, useHomeDashboard, useHomeMemos, useHomeRevisit, useHomeUpcoming, type HomeCover, type MemoRow, type RevisitGroup, type ShelfEntry, type UpcomingHomeEntry} from './homeDashboard';
import type {CharacterIndex} from './characterModel';
import type {ExchangeSnapshot} from './exchange';
import {api, native} from './transport';
import {mediaTicket} from './media';
import {BottomSheet} from './BottomSheet';
import {usePullToRefresh} from './usePullToRefresh';
import {usePrivacyMode} from './privacyMode';
import type {Asset, Ticket} from './types';
import {PlatformBadges} from '../src/collections/PlatformBadges';
import {ddayLabel, displayDate} from '../src/shared/displayDate';
import {Badge, Button, SectionLabel, Skeleton} from './ui';
import './home.css';

export interface HomeProps {
  items: Asset[]; hasMore: boolean; captures: Asset[] | null; busy: boolean; paused: boolean; secondaryError: string;
  scope: string; exchange: ExchangeSnapshot | null;
  /** Retained for compatibility with callers that still hold the character index. Home does not expose review. */
  characters?: CharacterIndex | null;
  /** Retained input shape; the tablet deliberately omits this review category. */
  review: {enabled: boolean; refreshKey: unknown}; similarityKey: unknown;
  onPending(): void; onReview(): void; onSimilarity(): void; onDuplicates(): void; onExchange(): void;
  onReleases(): void; onWork(id: string): void; onSettings(): void; onRecent(): void; onLibrary(): void;
  onRevisit?(key: string, title: string): void; onArtists?(): void; onNotes(id?: string): void; onRefresh?(): void;
}

const grouped = (amount: number) => `${amount < 0 ? '−' : ''}${String(Math.trunc(Math.abs(amount))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
function Progress({value, muted}: {value: number; muted?: boolean}) { return <span className={`home-progress${muted ? ' is-muted' : ''}`} aria-hidden="true"><i style={{width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`}} /></span>; }

function Section({title, onMore, className = '', children}: {title: string; onMore?(): void; className?: string; children: ReactNode}) {
  return <section className={`home-sec ${className}`} aria-label={title}><SectionLabel title={title} onOpen={onMore} /><div className="home-section-body">{children}</div></section>;
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
    const controller = new AbortController(); setUrl('');
    const request = window.LakomicsNative
      ? native<Ticket>('homeCover', {sha256}, controller.signal)
      : api<Ticket>(`/v1/home/covers/${encodeURIComponent(sha256)}/media-ticket`, controller.signal, undefined, 'POST');
    void request.then(reply => {
      if (!controller.signal.aborted && reply?.url && /^https:\/\//.test(reply.url)) setUrl(reply.url);
    }, () => {});
    return () => controller.abort();
  }, [cover?.url, cover?.sha256, privacy]);
  if (privacy) return <span className={`home-cover-placeholder is-private ${className}`} aria-label="비공개 모드로 이미지 숨김" />;
  return url ? <img className={`home-home-image ${className}`} src={url} alt={alt} /> : <span className={`home-cover-placeholder ${className}`} aria-label={`${alt} 표지 준비 중`} />;
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
  return url ? <img className="collection-art" src={url} alt={label} /> : <span className="home-cover-placeholder"><RectangleStackIcon aria-hidden="true" /></span>;
}

const upcomingKind: Record<UpcomingHomeEntry['kind'], string> = {game: '게임', movie: '영화', anime: '애니'};

function ShelfManga({entry, cover, today, privacy, onOpen}: {entry: ShelfEntry; cover: ReactNode; today: string; privacy: boolean; onOpen(): void}) {
  const fresh = entry.kind === 'new';
  const todayNew = fresh && (!entry.date || entry.date === today);
  const date = entry.date ?? today;
  const block = dateBlock(date, today);
  const days = daysAfter(date, today);
  const rail = <span className={`home-rail${todayNew ? ' is-new' : ''}`}><span className="home-rail-d numeric">{block?.day ?? '오늘'}</span>{ddayLabel(days) && <span className="home-rail-dd numeric">{ddayLabel(days)}</span>}</span>;
  const volumes = fresh ? entry.volumes : `${entry.volumeNumber}권`;
  const volume = volumes.match(/(\d+(?:[–-]\d+)?)권/)?.[1];
  return <button className="home-shelf-item" onClick={onOpen} aria-label={`${entry.name} ${volumes}`}><span>{rail}</span><span className="home-shelf-art">{privacy ? <span className="home-cover-placeholder is-private" aria-label="비공개 모드로 이미지 숨김" /> : cover}{fresh && <Badge className="home-newmark" variant="accent">NEW</Badge>}{volume && <Badge className="home-volume-badge" variant="scrim">{volume}</Badge>}</span><span className="home-shelf-title">{entry.name}</span><span className="home-shelf-sub" aria-hidden="true" /></button>;
}

function ShelfExternal({entry, fresh, today, privacy, onOpen}: {entry: UpcomingHomeEntry; fresh: boolean; today: string; privacy: boolean; onOpen(): void}) {
  const date = entry.date && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date : null;
  const days = date ? daysAfter(date, today) : null;
  const block = date ? dateBlock(date, today) : null;
  const hasGamePlatforms = entry.kind === 'game' && !!entry.platforms?.length;
  return <button className="home-shelf-item home-external-item" onClick={onOpen} aria-label={`${entry.title}${date ? ` · ${ddayLabel(days) ?? '발매됨'}` : ''}`}><span className="home-rail"><span className="home-rail-d numeric">{block?.day ?? '—'}</span>{block && <span className="home-rail-dd numeric">{ddayLabel(days)}</span>}</span><span className="home-shelf-art"><HomeCoverImage cover={entry.cover} alt={entry.title} privacy={privacy} />{fresh && <Badge className="home-newmark" variant="accent">NEW</Badge>}</span><span className="home-shelf-title">{entry.title}</span><span className="home-shelf-sub">{hasGamePlatforms ? <PlatformBadges platforms={entry.platforms!} port={entry.port === true} /> : null}</span></button>;
}

function MemoPanel({rows, memos, onOpen}: {rows: MemoRow[]; memos: ReturnType<typeof useHomeMemos>; onOpen(id?: string): void}) {
  if (!memos) return <Section title="메모" onMore={() => onOpen()}><div className="home-memo-grid is-loading" aria-busy="true"><Skeleton className="home-tall-memo is-loading" label="메모를 불러오는 중" /><Skeleton className="home-tall-memo is-loading" label="메모를 불러오는 중" /></div></Section>;
  const nonLedger = rows.filter((row): row is Exclude<MemoRow, {kind: 'ledger'}> => row.kind !== 'ledger');
  const pinned = nonLedger[0];
  const checklist = pinned?.kind === 'checklist' ? pinned : undefined;
  const ledger = rows.find((row): row is Extract<MemoRow, {kind: 'ledger'}> => row.kind === 'ledger');
  const renderNote = (note: Exclude<MemoRow, {kind: 'ledger'}>, key: string) => note.kind === 'checklist'
    ? <button key={key} className="home-tall-memo" onClick={() => onOpen(note.id)}><span className="home-memo-title"><ListBulletIcon className="home-icon" />{note.title || 'Todo'}</span><span className="home-checklist-lines">{note.items.map((item, index) => <span key={index}><i className={item.checked ? 'is-checked' : ''}>{item.checked ? '✓' : ''}</i>{item.text}</span>)}</span><span className="home-memo-foot"><span className="numeric">{note.done}/{note.total}</span> 완료<Progress value={note.total ? note.done / note.total : 0} muted /></span></button>
    : <button key={key} className="home-tall-memo" onClick={() => onOpen(note.id)}><span className="home-memo-title"><ListBulletIcon className="home-icon" />{note.title || '메모'}</span><span className="home-memo-snippet">{note.kind === 'text' ? note.snippet : '잠긴 메모'}</span></button>;
  const noteCard = pinned ? renderNote(pinned, pinned.id) : <button key="empty-note" className="home-tall-memo is-empty" onClick={() => onOpen()}><span className="home-memo-title"><ListBulletIcon className="home-icon" />메모</span><span>고정한 메모가 없습니다.</span></button>;
  const ledgerCard = ledger ? <button key={ledger.id} className="home-tall-memo" onClick={() => onOpen(ledger.id)}><span className="home-memo-title"><WalletIcon className="home-icon" />{ledger.title || '가계부'}</span><small className="home-ledger-month">{ledger.month}월 쓴 돈</small><strong className="home-ledger-total numeric">{grouped(ledger.amount)}원</strong>{ledger.categories.length > 0 ? <span className="home-ledger-bars">{ledger.categories.map(category => <span key={category.label}><span><b>{category.label}</b><em className="numeric">{grouped(category.amount)}원</em></span><Progress value={ledger.amount ? category.amount / ledger.amount : 0} /></span>)}</span> : <span className="home-ledger-latest"><small>최근 기록</small>{ledger.latest.map(entry => <span key={`${entry.label}:${entry.amount}`}><b>{entry.label}</b><em className="numeric">{grouped(entry.amount)}원</em></span>)}</span>}</button> : <button key="empty-ledger" className="home-tall-memo is-empty" onClick={() => onOpen()}><span className="home-memo-title"><WalletIcon className="home-icon" />가계부</span><span>고정한 가계부가 없습니다.</span></button>;
  return <Section title="메모" onMore={() => onOpen()}><div className="home-memo-grid">{noteCard}{ledgerCard}</div>{!checklist && !ledger && memos?.locked && <p className="home-memo-locked">메모가 잠겨 있습니다.</p>}</Section>;
}

function RevisitMosaic({group, paused, privacy, onOpen}: {group: RevisitGroup; paused: boolean; privacy: boolean; onOpen(): void}) {
  const items = group.items.slice(0, 7);
  const rows = items.length >= 5 ? [items.slice(0, 3), items.slice(3)] : [items];
  const ratio = (asset: Asset) => Number(asset.width) > 0 && Number(asset.height) > 0 ? Math.max(.4, Math.min(2.6, Number(asset.width) / Number(asset.height))) : 1;
  return <button className="home-revisit" onClick={onOpen} aria-label={`1년 전 오늘 ${group.count}장`}><span className="home-revisit-pics">{rows.map((row, index) => <span key={index} className="home-jrow">{row.map(asset => <span key={asset.id} className="home-jcell" style={{flexGrow: ratio(asset), aspectRatio: String(ratio(asset))}}>{privacy ? <span className="home-private-cell" aria-label="비공개 모드로 이미지 숨김" /> : <Cover asset={asset} paused={paused} />}</span>)}</span>)}</span><span className="home-caption"><span>1년 전 오늘</span><span className="numeric">{group.count}장</span></span></button>;
}

function ArtistStrip({group, paused, privacy, onOpen}: {group: RevisitGroup; paused: boolean; privacy: boolean; onOpen(): void}) {
  const items = group.items.slice(0, 6);
  // Only real images: an artist with 3 images shows 3 wider cells, not 3 empty slots.
  const cells: (typeof items[number] | undefined)[] = items.length ? items : [undefined];
  const name = group.name ?? group.title.replace(/^오늘의 작가\s*·\s*/, '');
  return <button className="home-artist-strip" onClick={onOpen} aria-label={group.title}><span className="home-artist-pics">{cells.map((asset, index) => <span key={asset?.id ?? `empty:${index}`} className="home-artist-cell">{asset && !privacy ? <Cover asset={asset} paused={paused} /> : <span className="home-private-cell" aria-label={privacy ? '비공개 모드로 이미지 숨김' : undefined} />}</span>)}</span><span className="home-caption"><span>{name}</span><span className="numeric">{group.count}장</span></span></button>;
}

function AssetTile({value, title, unit, onOpen, label}: {value: string; title: string; unit: string; onOpen(): void; label: string}) { return <button className="home-asset-tile" onClick={onOpen} aria-label={label}><strong className="numeric">{value}<small>{unit}</small></strong><span>{title}</span></button>; }
function CollectionCount({value, title}: {value: number; title: string}) { return <span className="home-asset-collection"><strong className="numeric">{grouped(value)}</strong><span>{title}</span></span>; }

type HomeSeriesRow = {work: CollectionSummary; owned: number; next: number; released: number};
/** Watched manga with a known owned count whose next Korean volumes are already out (PC 이어지는 시리즈). */
function unownedReleasedSeries(shelf: ReturnType<typeof currentShelf>, today: string): HomeSeriesRow[] {
  if (!shelf?.ready) return [];
  const watched = shelf.works.filter(work => work.type === 'manga' && !!work.releaseWatch?.enabled);
  const ownedOf = (work: CollectionSummary, edition: number) => work.ownedVolumes?.find(value => value.editionIndex === edition)?.count ?? null;
  return koreanReleases(watched, ownedOf, [], today).flatMap(row => {
    const released = row.volumes.filter(volume => volume.released);
    if (row.owned === null || !released.length) return [];
    const latest = released.map(volume => volume.date ?? '').sort().reverse()[0] ?? '';
    return [{row: {work: row.work, owned: row.owned, next: released[0]!.volumeNumber, released: released.length}, latest}];
  }).sort((a, b) => b.latest.localeCompare(a.latest) || a.row.work.name.localeCompare(b.row.work.name, 'ko')).map(entry => entry.row).slice(0, 3);
}

function ContinuingSeries({rows, revision, active, privacy, onOpen}: {rows: HomeSeriesRow[]; revision: string; active: boolean; privacy: boolean; onOpen(id: string): void}) {
  if (!rows.length) return null;
  return <Section title="이어지는 시리즈"><div className="home-series-grid">{rows.map(row => <button key={row.work.id} className="home-series-card" onClick={() => onOpen(row.work.id)} aria-label={`${row.work.name} ${row.next}권 발매`}><span className="home-series-pair"><span className="home-series-cover">{privacy ? <span className="home-cover-placeholder is-private" aria-label="비공개 모드로 이미지 숨김" /> : <HomeMangaCover item={row.work} revision={revision} active={active} label={row.work.name} />}{row.owned > 0 && <Badge className="home-volume-badge" variant="scrim">{row.owned}</Badge>}</span><span className="home-series-next"><b><span className="numeric">{row.next}</span><small>권</small></b><small>발매</small></span></span><strong className="home-series-title">{row.work.name}</strong><span className="home-series-meta">{row.owned > 0 ? <><span className="numeric">{row.owned}</span>권까지 소장</> : '소장 없음'}</span></button>)}</div></Section>;
}

/**
 * 오늘의 AV 배우: the performer face on the left and the published name data on the right.
 * The tablet response currently carries one cover, aliases, and an optional work count only.
 */
function AvCard({pick, privacy}: {pick: NonNullable<ReturnType<typeof useHomeAvPick>>; privacy: boolean}) {
  const cover = pick.latestWork?.cover ?? pick.cover ?? null;
  const initials = Array.from(pick.name.replace(/\s+/g, '')).slice(0, 2).join('') || 'AV';
  const originalName = pick.aliases?.[0];
  const workCount = typeof pick.workCount === 'number' && Number.isFinite(pick.workCount) ? pick.workCount : null;
  return <article className="home-av-card home-av-split">
    <span className="home-av-face">{cover ? <HomeCoverImage cover={cover} alt={pick.name} privacy={privacy} /> : <b>{initials}</b>}</span>
    <span className="home-av-side"><strong>{pick.name}</strong>{originalName && <small>{originalName}</small>}{workCount !== null && <span className="home-av-count"><b className="numeric">{workCount}</b> 출연</span>}</span>
  </article>;
}

function AvPlaceholder() {
  return <article className="home-av-card home-av-split is-loading" aria-label="오늘의 AV 배우 불러오는 중"><Skeleton className="home-av-face" label="오늘의 AV 배우 불러오는 중" /><span className="home-av-side"><Skeleton className="home-av-placeholder-line" label="오늘의 AV 배우 불러오는 중" /><Skeleton className="home-av-placeholder-line is-short" label="오늘의 AV 배우 불러오는 중" /></span></article>;
}

function UpcomingDetailSheet({entry, interested, privacy, onToggle, onClose}: {entry: UpcomingHomeEntry; interested: boolean; privacy: boolean; onToggle(): void; onClose(): void}) {
  const days = entry.date ? daysAfter(entry.date, localToday()) : null;
  return <BottomSheet title={entry.title} onClose={onClose}><div className="home-detail-sheet"><div className="home-detail-cover"><HomeCoverImage cover={entry.cover} alt={entry.title} privacy={privacy} /></div><Badge>{upcomingKind[entry.kind]}</Badge>{entry.originalTitle && <p className="home-detail-original">{entry.originalTitle}</p>}<p className="home-detail-meta">{entry.date ? displayDate(entry.date) : '발매일 미정'}{days !== null && ` · ${ddayLabel(days) ?? '발매됨'}`}</p>{entry.platforms?.length ? <p className="home-detail-meta">{entry.platforms.join(' · ')}</p> : null}{entry.description && <p className="home-detail-description">{entry.description}</p>}<button className="home-interest-action" onClick={onToggle}>{interested ? '관심 목록에서 빼기' : '관심 목록에 추가'}</button></div></BottomSheet>;
}

export function Home(props: HomeProps) {
  const {items, captures, paused, secondaryError} = props;
  const [privacy] = usePrivacyMode();
  const [reducedMotion] = useState(() => {
    try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false; } catch { return false; }
  });
  const pending = captures ? captures.length : null;
  const d = useHomeDashboard({enabled: !paused, scope: props.scope, pending, similarityKey: props.similarityKey, exchange: props.exchange});
  const memos = useHomeMemos(!paused, props.scope, d.refreshKey);
  const upcoming = useHomeUpcoming(!paused, props.scope, d.refreshKey);
  const avPick = useHomeAvPick(!paused && !privacy, props.scope, d.refreshKey);
  const artists = useHomeArtists(!paused, props.scope, d.refreshKey);
  const revisit = useHomeRevisit(!paused, props.scope, d.refreshKey);
  const homeScroll = useRef<HTMLDivElement>(null);
  const refreshHome = () => { d.retry(); props.onRefresh?.(); };
  const pull = usePullToRefresh(homeScroll, refreshHome, props.busy, paused);
  const [detail, setDetail] = useState<UpcomingHomeEntry | null>(null);
  const shelf = useSyncExternalStore(subscribeReleases, currentShelf);
  const works = useMemo(() => new Map((shelf?.works ?? []).map(work => [work.id, work])), [shelf]);
  const today = localToday();
  const stale = d.offline;
  const dateGroup = revisit.find(group => group.key === 'date');
  const fallbackArtist = revisit.find(group => group.key !== 'date');
  const publishedArtist = artists.find(artist => artist.main) ?? artists[0];
  const artistSource = publishedArtist?.coverAssetIds?.length ? revisit.find(group => group.items.some(asset => publishedArtist.coverAssetIds?.includes(asset.id))) : null;
  const artistAssets = publishedArtist?.coverAssetIds?.length ? items.filter(asset => publishedArtist.coverAssetIds?.includes(asset.id)) : [];
  const artistBase = artistSource ?? fallbackArtist ?? (publishedArtist ? {key: `artist:${publishedArtist.id}`, title: publishedArtist.displayName || publishedArtist.label, count: publishedArtist.assetCount ?? 0, items: artistAssets, label: ''} : null);
  const artistGroup = publishedArtist && artistBase ? {...artistBase, key: `artist:${publishedArtist.id}`, title: `오늘의 작가 · ${publishedArtist.displayName || publishedArtist.label}`, label: ''} : fallbackArtist ? {...fallbackArtist, title: `오늘의 작가 · ${fallbackArtist.name ?? fallbackArtist.title}`, label: ''} : null;

  const mangaEntries = shelfEntries(d.unreadWorks && d.unreadWorks > 0 ? d.releases ?? [] : [], d.upcoming ?? [], today);
  const externalEntries = externalShelfRows(upcoming.entries, upcoming.wishlistItems, upcoming.wishlist, today);
  const cover = (id: string, name: string) => { const work = works.get(id); return work ? <HomeMangaCover item={work} revision={shelf?.revision ?? ''} active={!paused} label={name} /> : <span className="home-cover-placeholder"><RectangleStackIcon aria-hidden="true" /></span>; };
  const summary = d.summary;
  const fallback = addedToday(items, props.hasMore);
  const total = summary ? grouped(summary.total) : '—';
  const unclassified = summary ? grouped(summary.unclassified) : '—';
  const todayAdded = summary ? grouped(summary.addedToday) : `${fallback.count}${fallback.more ? '+' : ''}`;
  const weekAdded = summary ? grouped(summary.addedThisWeek) : '—';
  const detailedSummary = summary?.images !== undefined && summary.videos !== undefined && summary.collections !== undefined ? summary : null;
  const seriesRows = useMemo(() => unownedReleasedSeries(shelf, today), [shelf, today]);
  const reviewRows = [
    {key: 'pending', label: '처리 대기', value: d.todos.pending, unit: '건', icon: InboxIcon, onOpen: props.onPending},
    {key: 'similar', label: '유사 이미지', value: d.todos.similar, unit: '쌍', icon: Square2StackIcon, onOpen: props.onSimilarity},
    {key: 'duplicates', label: '중복 판본', value: d.todos.duplicates, unit: '건', icon: BookOpenIcon, onOpen: props.onDuplicates},
  ].filter(row => row.value !== null && row.value > 0);

  const avLoading = !privacy && avPick === undefined;
  const shelfLoading = !paused && d.releases === null && d.upcoming === null && upcoming.entries.length === 0 && upcoming.wishlistItems.length === 0;
  const enterClass = reducedMotion ? '' : ' home-enter-block';
  const shelfCards = shelfLoading
    ? Array.from({length: 6}, (_, index) => <span className="home-shelf-item is-loading" key={`loading:${index}`} aria-hidden="true"><Skeleton className="home-rail" label="신간 정보를 불러오는 중" /><Skeleton className="home-shelf-art" label="신간 정보를 불러오는 중" /><Skeleton className="home-shelf-title" label="신간 정보를 불러오는 중" /><Skeleton className="home-shelf-sub" label="신간 정보를 불러오는 중" /></span>)
    : <>{mangaEntries.slice(0, 12).map(entry => <ShelfManga key={`manga:${entry.kind}:${entry.id}:${entry.kind === 'upcoming' ? entry.volumeNumber : ''}`} entry={entry} today={today} privacy={privacy} cover={cover(entry.id, entry.name)} onOpen={() => props.onWork(entry.id)} />)}{externalEntries.slice(0, 12).map(row => <ShelfExternal key={`${row.entry.kind}:${row.entry.id}`} entry={row.entry} fresh={row.fresh} today={today} privacy={privacy} onOpen={() => setDetail(row.entry)} />)}{mangaEntries.length + externalEntries.length === 0 && <p className="home-empty-shelf">신간이 없습니다.</p>}</>;
  return <div className={`home-scroll home-c${privacy ? ' is-private' : ''}${stale ? ' is-stale' : ''}`} ref={homeScroll} aria-label="홈">
    {pull}
    {stale && <div className="home-offline" role="status"><span>서버에 닿지 않음{d.since && <> · <span className="numeric">{clockLabel(d.since)}</span>부터</>}</span><Button variant="ghost" size="sm" onClick={refreshHome}>다시 시도</Button></div>}
    <div className="home-c-grid">
      <div className={`home-block home-release-block${enterClass}`}><Section title="캘린더" onMore={props.onReleases}><div className="home-shelf">{shelfCards}</div></Section></div>
      <div className={`home-block home-duo-block${enterClass}`}><div className="home-duo"><Section title="다시 보기" onMore={() => dateGroup ? props.onRevisit?.('date', dateGroup.title) : props.onRecent?.()}><>{dateGroup ? <RevisitMosaic group={dateGroup} paused={paused} privacy={privacy} onOpen={() => props.onRevisit?.('date', dateGroup.title)} /> : <div className="home-revisit is-empty"><span className="home-private-cell" /><span className="home-caption"><span>1년 전 오늘</span><span className="numeric">0장</span></span></div>}</></Section><Section title="작가" onMore={props.onArtists}><>{artistGroup ? <ArtistStrip group={artistGroup} paused={paused} privacy={privacy} onOpen={() => props.onArtists?.()} /> : <div className="home-artist-strip is-empty"><span className="home-artist-pics">{Array.from({length: 6}, (_, index) => <span className="home-private-cell" key={index} />)}</span><span className="home-caption"><span>오늘의 작가</span><span className="numeric">0장</span></span></div>}</></Section></div></div>
      <div className={`home-block home-duo-block${enterClass}`}><div className={`home-duo home-review-duo${!privacy && avPick !== null ? '' : ' is-review-wide'}`}>{!privacy && avPick !== null && <Section title="AV 배우"><div className="home-today-av">{avLoading ? <AvPlaceholder /> : <AvCard pick={avPick!} privacy={privacy} />}</div></Section>}<Section title="검토"><div className="home-review-list">{reviewRows.length ? reviewRows.map(row => { const Icon = row.icon; return <button key={row.key} className="home-review-row" onClick={row.onOpen}><Icon aria-hidden="true" /><span>{row.label}</span><strong className="home-review-row-count numeric">{row.value}<small>{row.unit}</small></strong><ChevronRightIcon aria-hidden="true" /></button>; }) : <div className="home-review-empty"><span className="home-review-ok" aria-hidden="true">✓</span><span>모두 확인함</span></div>}</div></Section></div></div>
      <div className={`home-block home-memo-block${enterClass}`}><MemoPanel rows={memos?.rows ?? []} memos={memos} onOpen={props.onNotes} /></div>
      <div className={`home-block home-assets-block${enterClass}`}><Section title="자산 현황"><div className="home-assets">{detailedSummary ? <><div className="home-assets-media"><AssetTile value={grouped(detailedSummary.images!)} unit="장" title="이미지" label={`이미지 ${grouped(detailedSummary.images!)}장`} onOpen={props.onRecent} /><AssetTile value={grouped(detailedSummary.videos!)} unit="장" title="영상" label={`영상 ${grouped(detailedSummary.videos!)}장`} onOpen={props.onRecent} /></div><div className={`home-assets-collections${privacy ? ' is-private' : ''}`}><CollectionCount value={detailedSummary.collections!.game} title="게임" /><CollectionCount value={detailedSummary.collections!.manga} title="만화" /><CollectionCount value={detailedSummary.collections!.movie} title="영화" />{!privacy && <CollectionCount value={detailedSummary.collections!.av} title="AV" />}</div></> : <div className="home-assets-cells"><AssetTile value={total} unit="장" title="전체" label={`전체 ${total}장`} onOpen={props.onRecent} /><AssetTile value={unclassified} unit="장" title="분류 안 됨" label={`분류 안 됨 ${unclassified}장`} onOpen={props.onLibrary} /></div>}<div className="home-assets-foot"><button onClick={props.onRecent}>오늘 <strong className="numeric">+{todayAdded}</strong></button><button onClick={props.onRecent}>이번 주 <strong className="numeric">+{weekAdded}</strong></button>{detailedSummary && <button onClick={props.onLibrary} aria-label={`분류 안 됨 ${unclassified}장`}>분류 안 됨 <strong className="numeric">{unclassified}</strong></button>}<span className={`home-server-status${stale ? ' is-offline' : ''}`}><i aria-hidden="true" />서버</span></div></div></Section></div>
      {seriesRows.length > 0 && <div className={`home-block home-series-block${enterClass}`}><ContinuingSeries rows={seriesRows} revision={shelf?.revision ?? ''} active={!paused} privacy={privacy} onOpen={props.onWork} /></div>}
    </div>
    {secondaryError && <p className="hint" role="status">{secondaryError}</p>}
    {detail && <UpcomingDetailSheet entry={detail} interested={upcoming.wishlist.has(detail.id)} privacy={privacy} onToggle={() => upcoming.toggle(detail.id)} onClose={() => setDetail(null)} />}
  </div>;
}
