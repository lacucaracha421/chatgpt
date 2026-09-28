import {useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {ChevronRightIcon, ListBulletIcon, RectangleStackIcon, SignalSlashIcon, WalletIcon} from '@heroicons/react/24/outline';
import {collectionCover, type CollectionSummary} from './collectionModel';
import {localToday} from './collectionReleases';
import {Cover} from './CoverGroup';
import {currentShelf, subscribeReleases} from './releaseStore';
import {addedToday, clockLabel, dateBlock, daysAfter, shelfEntries, useHomeArtists, useHomeAvPick, useHomeDashboard, useHomeMemos, useHomeRevisit, useHomeUpcoming, type HomeCover, type MemoRow, type RevisitGroup, type ShelfEntry, type UpcomingHomeEntry} from './homeDashboard';
import type {CharacterIndex} from './characterModel';
import type {ExchangeSnapshot} from './exchange';
import {api, native} from './transport';
import {mediaTicket} from './media';
import {BottomSheet} from './BottomSheet';
import {usePullToRefresh} from './usePullToRefresh';
import {usePrivacyMode} from './privacyMode';
import type {Asset, Ticket} from './types';
import {PlatformBadges} from '../src/collections/PlatformBadges';
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

function Section({title, onMore, moreLabel, className = '', children}: {title: string; onMore?(): void; moreLabel?: string; className?: string; children: ReactNode}) {
  return <section className={`home-sec ${className}`} aria-label={title}><div className="home-sh"><h2>{title}</h2>{onMore && <button className="home-sh-more" onClick={onMore} aria-label={moreLabel ?? `${title} 전체`}><ChevronRightIcon aria-hidden="true" /></button>}</div>{children}</section>;
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
  const rail = <span className={`home-rail${todayNew ? ' is-new' : ''}`}><span className="home-rail-d numeric">{block?.day ?? '오늘'}</span>{days !== null && <span className="home-rail-dd numeric">{days === 0 ? '오늘' : days > 0 ? `D-${days}` : '지난'}</span>}</span>;
  const volumes = fresh ? entry.volumes : `${entry.volumeNumber}권`;
  return <button className="home-shelf-item" onClick={onOpen} aria-label={`${entry.name} ${volumes}`}><span>{rail}</span><span className="home-shelf-art">{privacy ? <span className="home-cover-placeholder is-private" aria-label="비공개 모드로 이미지 숨김" /> : cover}{todayNew && <span className="home-newmark">NEW</span>}</span><span className="home-shelf-title">{entry.name}</span><span className="home-shelf-sub" aria-hidden="true" /></button>;
}

function ShelfExternal({entry, today, privacy, onOpen}: {entry: UpcomingHomeEntry; today: string; privacy: boolean; onOpen(): void}) {
  const date = entry.date && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date : null;
  const days = date ? daysAfter(date, today) : null;
  const block = date ? dateBlock(date, today) : null;
  const hasGamePlatforms = entry.kind === 'game' && !!entry.platforms?.length;
  return <button className="home-shelf-item home-external-item" onClick={onOpen} aria-label={`${entry.title}${date ? ` · ${days === 0 ? '오늘' : `D-${days}`}` : ''}`}><span className="home-rail"><span className="home-rail-d numeric">{block?.day ?? '—'}</span>{block && <span className="home-rail-dd numeric">{days === 0 ? '오늘' : days !== null && days > 0 ? `D-${days}` : '지난'}</span>}</span><span className="home-shelf-art"><HomeCoverImage cover={entry.cover} alt={entry.title} privacy={privacy} /></span><span className="home-shelf-title">{entry.title}</span><span className="home-shelf-sub">{hasGamePlatforms ? <PlatformBadges platforms={entry.platforms!} port={entry.port === true} /> : null}</span></button>;
}

function MemoPanel({rows, memos, onOpen}: {rows: MemoRow[]; memos: ReturnType<typeof useHomeMemos>; onOpen(id?: string): void}) {
  if (!memos) return <Section title="메모" onMore={() => onOpen()} moreLabel="메모 전체"><div className="home-memo-grid is-loading" aria-busy="true"><span className="home-tall-memo is-loading" /><span className="home-tall-memo is-loading" /></div></Section>;
  const nonLedger = rows.filter((row): row is Exclude<MemoRow, {kind: 'ledger'}> => row.kind !== 'ledger');
  const pinned = nonLedger[0];
  const second = nonLedger[1];
  const checklist = pinned?.kind === 'checklist' ? pinned : undefined;
  const ledger = rows.find((row): row is Extract<MemoRow, {kind: 'ledger'}> => row.kind === 'ledger');
  const renderNote = (note: Exclude<MemoRow, {kind: 'ledger'}>, key: string) => note.kind === 'checklist'
    ? <button key={key} className="home-tall-memo" onClick={() => onOpen(note.id)}><span className="home-memo-title"><ListBulletIcon className="home-icon" />{note.title || 'Todo'}</span><span className="home-checklist-lines">{note.items.map((item, index) => <span key={index}><i className={item.checked ? 'is-checked' : ''}>{item.checked ? '✓' : ''}</i>{item.text}</span>)}</span><span className="home-memo-foot"><span className="numeric">{note.done}/{note.total}</span> 완료<Progress value={note.total ? note.done / note.total : 0} muted /></span></button>
    : <button key={key} className="home-tall-memo" onClick={() => onOpen(note.id)}><span className="home-memo-title"><ListBulletIcon className="home-icon" />{note.title || '메모'}</span><span className="home-memo-snippet">{note.kind === 'text' ? note.snippet : '잠긴 메모'}</span></button>;
  const noteCard = pinned ? renderNote(pinned, pinned.id) : <button key="empty-note" className="home-tall-memo is-empty" onClick={() => onOpen()}><span className="home-memo-title"><ListBulletIcon className="home-icon" />메모</span><span>고정한 메모가 없습니다.</span></button>;
  const ledgerCard = ledger ? <button key={ledger.id} className="home-tall-memo" onClick={() => onOpen(ledger.id)}><span className="home-memo-title"><WalletIcon className="home-icon" />{ledger.title || '가계부'}</span><small className="home-ledger-month">{ledger.month}월 쓴 돈</small><strong className="home-ledger-total numeric">{grouped(ledger.amount)}원</strong>{ledger.categories.length > 0 ? <span className="home-ledger-bars">{ledger.categories.map(category => <span key={category.label}><span><b>{category.label}</b><em className="numeric">{grouped(category.amount)}원</em></span><Progress value={ledger.amount ? category.amount / ledger.amount : 0} /></span>)}</span> : <span className="home-ledger-latest"><small>최근 기록</small>{ledger.latest.map(entry => <span key={`${entry.label}:${entry.amount}`}><b>{entry.label}</b><em className="numeric">{grouped(entry.amount)}원</em></span>)}</span>}</button> : <button key="empty-ledger" className="home-tall-memo is-empty" onClick={() => onOpen()}><span className="home-memo-title"><WalletIcon className="home-icon" />가계부</span><span>고정한 가계부가 없습니다.</span></button>;
  const cards = [noteCard, ledgerCard, ...(second ? [renderNote(second, second.id)] : [])];
  return <Section title="메모" onMore={() => onOpen()} moreLabel="메모 전체"><div className={`home-memo-grid${second ? ' is-three' : ''}`}>{cards}</div>{!checklist && !ledger && memos?.locked && <p className="home-memo-locked">메모가 잠겨 있습니다.</p>}</Section>;
}

function RevisitMosaic({group, paused, privacy, onOpen}: {group: RevisitGroup; paused: boolean; privacy: boolean; onOpen(): void}) {
  const items = group.items.slice(0, 7);
  const rows = items.length >= 5 ? [items.slice(0, 3), items.slice(3)] : [items];
  const ratio = (asset: Asset) => Number(asset.width) > 0 && Number(asset.height) > 0 ? Math.max(.4, Math.min(2.6, Number(asset.width) / Number(asset.height))) : 1;
  return <button className="home-revisit" onClick={onOpen} aria-label="1년 전 오늘"><span className="home-revisit-pics">{rows.map((row, index) => <span key={index} className="home-jrow">{row.map(asset => <span key={asset.id} className="home-jcell" style={{flexGrow: ratio(asset), aspectRatio: String(ratio(asset))}}>{privacy ? <span className="home-private-cell" aria-label="비공개 모드로 이미지 숨김" /> : <Cover asset={asset} paused={paused} />}</span>)}</span>)}</span><span className="home-caption">1년 전 오늘</span></button>;
}

function ArtistStrip({group, paused, privacy, onOpen}: {group: RevisitGroup; paused: boolean; privacy: boolean; onOpen(): void}) {
  const items = group.items.slice(0, 6);
  // Only real images: an artist with 3 images shows 3 wider cells, not 3 empty slots.
  const cells: (typeof items[number] | undefined)[] = items.length ? items : [undefined];
  return <button className="home-artist-strip" onClick={onOpen} aria-label={group.title}><span className="home-artist-pics">{cells.map((asset, index) => <span key={asset?.id ?? `empty:${index}`} className="home-artist-cell">{asset && !privacy ? <Cover asset={asset} paused={paused} /> : <span className="home-private-cell" aria-label={privacy ? '비공개 모드로 이미지 숨김' : undefined} />}</span>)}</span><span className="home-caption">{group.title}</span></button>;
}

function AssetTile({value, title, unit, onOpen, label}: {value: string; title: string; unit: string; onOpen(): void; label: string}) { return <button className="home-asset-tile" onClick={onOpen} aria-label={label}><strong className="numeric">{value}<small>{unit}</small></strong><span>{title}</span></button>; }

/**
 * 오늘의 AV 배우 as two columns (2026-09-28): the performer's face on the left — cropped from the
 * right half of the latest front cover, where the jacket shows her — and her name on the right.
 * The right column leaves room for performer details later; no work covers or titles.
 */
function AvCard({pick, privacy}: {pick: NonNullable<ReturnType<typeof useHomeAvPick>>; privacy: boolean}) {
  const cover = pick.latestWork?.cover ?? pick.cover ?? null;
  const initials = Array.from(pick.name.replace(/\s+/g, '')).slice(0, 2).join('') || 'AV';
  return <article className="home-av-card home-av-split">
    <span className="home-av-face">{cover ? <HomeCoverImage cover={cover} alt={pick.name} privacy={privacy} /> : <b>{initials}</b>}</span>
    <span className="home-av-side">
      <strong>{pick.name}</strong>
    </span>
  </article>;
}

function AvPlaceholder() {
  return <article className="home-av-card home-av-split is-loading" aria-label="오늘의 AV 배우 불러오는 중"><span className="home-av-face" /><span className="home-av-side"><span className="home-av-placeholder-line" /><span className="home-av-placeholder-line is-short" /></span></article>;
}

function UpcomingDetailSheet({entry, interested, privacy, onToggle, onClose}: {entry: UpcomingHomeEntry; interested: boolean; privacy: boolean; onToggle(): void; onClose(): void}) {
  const days = entry.date ? daysAfter(entry.date, localToday()) : null;
  return <BottomSheet title={entry.title} onClose={onClose}><div className="home-detail-sheet"><div className="home-detail-cover"><HomeCoverImage cover={entry.cover} alt={entry.title} privacy={privacy} /></div><span className="home-kind">{upcomingKind[entry.kind]}</span>{entry.originalTitle && <p className="home-detail-original">{entry.originalTitle}</p>}<p className="home-detail-meta">{entry.date ?? '발매일 미정'}{days !== null && ` · ${days === 0 ? '오늘' : days > 0 ? `D-${days}` : '발매됨'}`}</p>{entry.platforms?.length ? <p className="home-detail-meta">{entry.platforms.join(' · ')}</p> : null}{entry.description && <p className="home-detail-description">{entry.description}</p>}<button className="home-interest-action" onClick={onToggle}>{interested ? '관심 목록에서 빼기' : '관심 목록에 추가'}</button></div></BottomSheet>;
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
  // Home lists only games/movies/anime on the 관심 목록 (user, 2026-09-27); the 발매 캘린더 shows everything.
  const externalEntries = upcoming.entries.filter(entry => (entry.kind === 'game' || entry.kind === 'movie' || entry.kind === 'anime') && upcoming.wishlist.has(entry.id) && entry.precision !== 'year').filter(entry => !entry.date || daysAfter(entry.date, today) >= 0).sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  const cover = (id: string, name: string) => { const work = works.get(id); return work ? <HomeMangaCover item={work} revision={shelf?.revision ?? ''} active={!paused} label={name} /> : <span className="home-cover-placeholder"><RectangleStackIcon aria-hidden="true" /></span>; };
  const summary = d.summary;
  const fallback = addedToday(items, props.hasMore);
  const statValues = summary ? [String(summary.addedToday), String(summary.addedThisWeek), String(summary.total), String(summary.unclassified)] : [`${fallback.count}${fallback.more ? '+' : ''}`, '—', '—', '—'];
  const statLabels = ['오늘', '이번 주', '전체', '분류 안 됨'];
  const statUnits = ['장', '장', '장', '장'];
  const statActions = [props.onRecent, props.onRecent, props.onRecent, props.onLibrary];
  const statAria = summary ? [`오늘 ${summary.addedToday}장`, `이번 주 ${summary.addedThisWeek}장`, `전체 ${summary.total}장`, `분류 안 됨 ${summary.unclassified}장`] : [`오늘 ${statValues[0]}장`, '이번 주 —장', '전체 —장', '분류 안 됨 —장'];

  const avLoading = !privacy && avPick === undefined;
  const shelfLoading = !paused && d.releases === null && d.upcoming === null && upcoming.entries.length === 0;
  const enterClass = reducedMotion ? '' : ' home-enter-block';
  const shelfCards = shelfLoading
    ? Array.from({length: 6}, (_, index) => <span className="home-shelf-item is-loading" key={`loading:${index}`} aria-hidden="true"><span className="home-rail" /><span className="home-shelf-art" /><span className="home-shelf-title" /><span className="home-shelf-sub" /></span>)
    : <>{mangaEntries.slice(0, 12).map(entry => <ShelfManga key={`manga:${entry.kind}:${entry.id}:${entry.kind === 'upcoming' ? entry.volumeNumber : ''}`} entry={entry} today={today} privacy={privacy} cover={cover(entry.id, entry.name)} onOpen={() => props.onWork(entry.id)} />)}{externalEntries.slice(0, 12).map(entry => <ShelfExternal key={`${entry.kind}:${entry.id}`} entry={entry} today={today} privacy={privacy} onOpen={() => setDetail(entry)} />)}{mangaEntries.length + externalEntries.length === 0 && <p className="home-empty-shelf">신간이 없습니다.</p>}</>;
  return <div className={`home-scroll home-c${privacy ? ' is-private' : ''}${stale ? ' is-stale' : ''}`} ref={homeScroll} aria-label="홈">
    {pull}
    {stale && <div className="home-offline" role="status"><SignalSlashIcon aria-hidden="true" /><div><strong>오프라인 — 서버에 닿지 않습니다</strong><p>{d.since ? <>숫자와 목록은 <span className="numeric">{clockLabel(d.since)}</span> 기준으로 남겨 둔 값입니다. 메모는 그대로 쓸 수 있습니다.</> : '연결되면 다시 불러옵니다. 메모는 그대로 쓸 수 있습니다.'}</p></div><button className="home-retry" onClick={refreshHome}>다시 연결</button></div>}
    <div className="home-c-grid">
      <div className={`home-block home-memo-block${enterClass}`}><MemoPanel rows={memos?.rows ?? []} memos={memos} onOpen={props.onNotes} /></div>
      <div className={`home-block home-release-block${enterClass}`}><Section title="신간" onMore={props.onReleases} moreLabel="신간 전체"><div className="home-shelf">{shelfCards}</div></Section></div>
      <div className={`home-block home-today-block${enterClass}`}><Section title="오늘" onMore={() => dateGroup ? props.onRevisit?.('date', dateGroup.title) : props.onRecent?.()} moreLabel="오늘 전체"><div className={`home-today-grid${privacy || avPick === null ? ' is-wide' : ''}`}>{!privacy && avPick !== null && <div className="home-today-av">{avLoading ? <AvPlaceholder /> : <AvCard pick={avPick!} privacy={privacy} />}</div>}{dateGroup ? <RevisitMosaic group={dateGroup} paused={paused} privacy={privacy} onOpen={() => props.onRevisit?.('date', dateGroup.title)} /> : <div className="home-revisit is-empty"><span className="home-private-cell" /><span className="home-caption">1년 전 오늘</span></div>}</div></Section></div>
      <div className={`home-block home-record-block${enterClass}`}><Section title="기록" onMore={props.onArtists} moreLabel="작가 전체"><div className="home-record-content">{artistGroup ? <ArtistStrip group={artistGroup} paused={paused} privacy={privacy} onOpen={() => props.onArtists?.()} /> : <div className="home-artist-strip is-empty"><span className="home-artist-pics">{Array.from({length: 6}, (_, index) => <span className="home-private-cell" key={index} />)}</span><span className="home-caption">오늘의 작가</span></div>}<div className="home-asset-grid">{statValues.map((value, index) => <AssetTile key={statLabels[index]} value={value} unit={statUnits[index]!} title={statLabels[index]!} label={statAria[index]!} onOpen={statActions[index]!} />)}</div></div></Section></div>
    </div>
    {secondaryError && <p className="hint" role="status">{secondaryError}</p>}
    {detail && <UpcomingDetailSheet entry={detail} interested={upcoming.wishlist.has(detail.id)} privacy={privacy} onToggle={() => upcoming.toggle(detail.id)} onClose={() => setDetail(null)} />}
  </div>;
}
