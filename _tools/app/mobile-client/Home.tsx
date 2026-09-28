import {useEffect, useMemo, useState, useSyncExternalStore, type ReactNode} from 'react';
import {ArrowsUpDownIcon, ChevronRightIcon, ListBulletIcon, RectangleStackIcon, SignalSlashIcon, WalletIcon} from '@heroicons/react/24/outline';
import {Artwork} from './Collections';
import {collectionCover} from './collectionModel';
import {localToday} from './collectionReleases';
import {Cover} from './CoverGroup';
import {currentShelf, subscribeReleases} from './releaseStore';
import {addedToday, clockLabel, dateBlock, daysAfter, PENDING_LIMIT, shelfEntries, TODO_LABELS, useHomeArtists, useHomeAvPick, useHomeDashboard, useHomeMemos, useHomeRevisit, useHomeUpcoming, type HomeCover, type MemoRow, type RevisitGroup, type ShelfEntry, type TodoKey, type UpcomingHomeEntry} from './homeDashboard';
import type {CharacterIndex} from './characterModel';
import type {ExchangeSnapshot} from './exchange';
import {useExchangeThumbnail} from './useExchange';
import {api} from './transport';
import {BottomSheet} from './BottomSheet';
import {usePrivacyMode} from './privacyMode';
import type {Asset} from './types';
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
const count = (value: number) => value.toLocaleString('ko-KR');

function Stale({at}: {at: number | null | undefined}) { return at ? <span className="home-stale numeric">{clockLabel(at)} 기준</span> : null; }
function Progress({value, muted}: {value: number; muted?: boolean}) { return <span className={`home-progress${muted ? ' is-muted' : ''}`} aria-hidden="true"><i style={{width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`}} /></span>; }

function Section({title, meta, onMore, moreLabel, className = '', children}: {title: string; meta?: ReactNode; onMore?(): void; moreLabel?: string; className?: string; children: ReactNode}) {
  return <section className={`home-sec ${className}`} aria-label={title}><div className="home-sh"><h2>{title}</h2>{meta && <span className="home-sh-meta">{meta}</span>}<span className="home-sh-rule" aria-hidden="true" />{onMore && <button className="home-sh-more" onClick={onMore} aria-label={moreLabel ?? `${title} 전체`}>전체<ChevronRightIcon aria-hidden="true" /></button>}</div>{children}</section>;
}

function HomeCoverImage({cover, alt, privacy = false, className = ''}: {cover?: HomeCover | null; alt: string; privacy?: boolean; className?: string}) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (privacy || !cover) { setUrl(''); return; }
    if (cover.url && /^https:\/\//.test(cover.url)) { setUrl(cover.url); return; }
    if (!cover.sha256) { setUrl(''); return; }
    const controller = new AbortController(); setUrl('');
    void api<{url?: string}>(`/v1/home/covers/${encodeURIComponent(cover.sha256)}/media-ticket`, controller.signal, undefined, 'POST').then(reply => {
      if (!controller.signal.aborted && reply?.url && /^https:\/\//.test(reply.url)) setUrl(reply.url);
    }, () => {});
    return () => controller.abort();
  }, [cover?.url, cover?.sha256, privacy]);
  if (privacy) return <span className={`home-cover-placeholder is-private ${className}`} aria-label="비공개 모드로 이미지 숨김" />;
  return url ? <img className={`home-home-image ${className}`} src={url} alt={alt} /> : <span className={`home-cover-placeholder ${className}`} aria-label={`${alt} 표지 준비 중`} />;
}

const upcomingKind: Record<UpcomingHomeEntry['kind'], string> = {game: '게임', movie: '영화', anime: '애니'};

function ShelfManga({entry, cover, today, privacy, onOpen}: {entry: ShelfEntry; cover: ReactNode; today: string; privacy: boolean; onOpen(): void}) {
  const fresh = entry.kind === 'new';
  const todayNew = fresh && (!entry.date || entry.date === today);
  const block = entry.date ? dateBlock(entry.date, today) : null;
  const rail = fresh ? <span className="home-rail is-new"><span className="home-rail-d">{todayNew ? '새 권 · 오늘' : <><span className="numeric">{block!.day}</span> 나옴</>}</span></span> : <span className="home-rail"><span className="home-rail-d numeric">{block!.day}</span><span className="home-rail-w">{block!.weekday.slice(0, 1)}</span><span className="home-rail-dd numeric">{entry.days === 0 ? '오늘' : `D-${entry.days}`}</span></span>;
  const volumes = fresh ? entry.volumes : `${entry.volumeNumber}권`;
  return <button className="home-shelf-item" onClick={onOpen} aria-label={`${entry.name} ${volumes} · ${fresh ? todayNew ? '새 권' : `${block!.day} 나옴` : `${block!.day} 발매`}`}><span>{rail}</span><span className="home-shelf-art">{privacy ? <span className="home-cover-placeholder is-private" aria-label="비공개 모드로 이미지 숨김" /> : cover}{todayNew && <span className="home-newmark">NEW</span>}</span><span className="home-shelf-title">{entry.name}</span><span className="home-shelf-sub"><span className="home-kind">만화</span><span className="numeric">{volumes}</span></span></button>;
}

function ShelfExternal({entry, today, interested, privacy, onOpen}: {entry: UpcomingHomeEntry; today: string; interested: boolean; privacy: boolean; onOpen(): void}) {
  const date = entry.date && /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? entry.date : null;
  const days = date ? daysAfter(date, today) : null;
  const block = date ? dateBlock(date, today) : null;
  const hasGamePlatforms = entry.kind === 'game' && !!entry.platforms?.length;
  return <button className="home-shelf-item home-external-item" onClick={onOpen} aria-label={`${entry.title}${date ? ` · ${days === 0 ? '오늘' : `D-${days}`}` : ''}`}><span className="home-rail"><span className="home-rail-d">{block?.day ?? '발매 예정'}</span>{block && <><span className="home-rail-w">{block.weekday.slice(0, 1)}</span><span className="home-rail-dd numeric">{days === 0 ? '오늘' : days !== null && days > 0 ? `D-${days}` : '일정 미정'}</span></>}</span><span className="home-shelf-art"><HomeCoverImage cover={entry.cover} alt={entry.title} privacy={privacy} /><span className="home-interest" aria-label={interested ? '관심 목록에 있음' : '관심 목록에 없음'}>{interested ? '♥' : '♡'}</span></span><span className="home-shelf-title">{entry.title}</span><span className="home-shelf-sub">{hasGamePlatforms ? <PlatformBadges platforms={entry.platforms!} port={entry.port === true} /> : <><span className="home-kind">{upcomingKind[entry.kind]}</span><span>{entry.platforms?.slice(0, 2).join(' · ') || entry.releaseType || '발매 예정'}</span></>}</span></button>;
}

function ExchangeThumb({transferId, enabled, privacy, name}: {transferId: string; enabled: boolean; privacy: boolean; name: string}) {
  const url = useExchangeThumbnail(transferId, enabled && !privacy);
  return <span className="home-transfer-thumb">{url ? <img src={url} alt={name} /> : <RectangleStackIcon aria-hidden="true" />}</span>;
}

function TransferPanel({sending, exchange, privacy, onOpen}: {sending: ReturnType<typeof useHomeDashboard>['sending']; exchange: ExchangeSnapshot | null; privacy: boolean; onOpen(): void}) {
  const received = (exchange?.incoming ?? []).filter(row => row.state === 'saved' || row.state === 'downloading' || row.state === 'saving').slice(0, 2);
  return <Section title="전송" onMore={onOpen} moreLabel="보내기 · 받기 전체"><div className="home-transfer-grid"><button className="home-transfer-card" onClick={onOpen} aria-label={sending ? `보내는 중 ${sending.name}` : '보낼 파일 없음'}><span className="home-transfer-label"><ArrowsUpDownIcon className="home-icon" />보내는 중</span>{sending ? <><strong>{sending.name}</strong><span className="home-transfer-meta">{sending.peer}{sending.more ? ` · 외 ${sending.more}개` : ''}</span><Progress value={sending.progress ?? 0} muted={!sending.progress} />{sending.progress !== null && <span className="numeric home-transfer-percent">{Math.round(sending.progress * 100)}%</span>}</> : <span className="home-transfer-empty">보낼 파일이 없습니다.</span>}</button><button className="home-transfer-card" onClick={onOpen} aria-label={`받은 파일 ${exchange?.unseen ?? 0}개`}><span className="home-transfer-label"><RectangleStackIcon className="home-icon" />받은 파일 <span className="numeric">{exchange?.unseen ?? 0}</span></span><span className="home-transfer-thumbs">{received.map(row => <ExchangeThumb key={row.transferId} transferId={row.transferId} enabled={row.state === 'saved'} privacy={privacy} name={row.fileName} />)}{received.length === 0 && <span className="home-transfer-empty">최근 받은 파일이 없습니다.</span>}</span></button></div></Section>;
}

function MemoPanel({rows, memos, onOpen}: {rows: MemoRow[]; memos: ReturnType<typeof useHomeMemos>; onOpen(id?: string): void}) {
  // The left card is the newest pinned note that is not a 가계부 (checklist, text or secret).
  const pinned = rows.find(row => row.kind !== 'ledger');
  const checklist = pinned?.kind === 'checklist' ? pinned : undefined;
  const ledger = rows.find((row): row is Extract<MemoRow, {kind: 'ledger'}> => row.kind === 'ledger');
  return <Section title="메모" onMore={() => onOpen()} moreLabel="메모 전체"><div className="home-memo-grid">{checklist ? <button className="home-tall-memo" onClick={() => onOpen(checklist.id)}><span className="home-memo-title"><ListBulletIcon className="home-icon" />{checklist.title || 'Todo'}</span><span className="home-checklist-lines">{checklist.items.map((item, index) => <span key={index}><i className={item.checked ? 'is-checked' : ''}>{item.checked ? '✓' : ''}</i>{item.text}</span>)}</span><span className="home-memo-foot"><span className="numeric">{checklist.done}/{checklist.total}</span> 완료<Progress value={checklist.total ? checklist.done / checklist.total : 0} muted /></span></button> : pinned ? <button className="home-tall-memo" onClick={() => onOpen(pinned.id)}><span className="home-memo-title"><ListBulletIcon className="home-icon" />{pinned.title || '메모'}</span><span className="home-memo-snippet">{pinned.kind === 'text' ? pinned.snippet : '잠긴 메모'}</span></button> : <button className="home-tall-memo is-empty" onClick={() => onOpen()}><span className="home-memo-title"><ListBulletIcon className="home-icon" />메모</span><span>고정한 메모가 없습니다.</span></button>}{ledger ? <button className="home-tall-memo" onClick={() => onOpen(ledger.id)}><span className="home-memo-title"><WalletIcon className="home-icon" />{ledger.title || '가계부'}</span><small className="home-ledger-month">{ledger.month}월 쓴 돈</small><strong className="home-ledger-total numeric">{grouped(ledger.amount)}원</strong>{ledger.categories.length > 0 ? <span className="home-ledger-bars">{ledger.categories.map(category => <span key={category.label}><span><b>{category.label}</b><em className="numeric">{grouped(category.amount)}원</em></span><Progress value={ledger.amount ? category.amount / ledger.amount : 0} /></span>)}</span> : <span className="home-ledger-latest"><small>최근 기록</small>{ledger.latest.map(entry => <span key={`${entry.label}:${entry.amount}`}><b>{entry.label}</b><em className="numeric">{grouped(entry.amount)}원</em></span>)}</span>}</button> : <button className="home-tall-memo is-empty" onClick={() => onOpen()}><span className="home-memo-title"><WalletIcon className="home-icon" />가계부</span><span>고정한 가계부가 없습니다.</span></button>}</div>{!checklist && !ledger && memos?.locked && <p className="home-memo-locked">메모가 잠겨 있습니다.</p>}</Section>;
}

function RevisitCard({group, paused, privacy, noChevron, onOpen}: {group: RevisitGroup; paused: boolean; privacy: boolean; noChevron?: boolean; onOpen(): void}) {
  const items = group.items.slice(0, 7);
  const rows = items.length >= 5 ? [items.slice(0, 3), items.slice(3)] : [items];
  const ratio = (asset: Asset) => Number(asset.width) > 0 && Number(asset.height) > 0 ? Math.max(.4, Math.min(2.6, Number(asset.width) / Number(asset.height))) : 1;
  return <button className="home-revisit" onClick={onOpen} aria-label={`${group.title}, ${group.label}`}><span className="home-revisit-pics">{rows.map((row, index) => <span key={index} className="home-jrow">{row.map(asset => <span key={asset.id} className="home-jcell" style={{flexGrow: ratio(asset), aspectRatio: String(ratio(asset))}}>{privacy ? <span className="home-private-cell" aria-label="비공개 모드로 이미지 숨김" /> : <Cover asset={asset} paused={paused} />}</span>)}</span>)}</span><span className="home-revisit-cap"><span className="home-revisit-text"><strong>{group.title}</strong><small>{group.label}</small></span>{!noChevron && <ChevronRightIcon className="home-chev" aria-hidden="true" />}</span></button>;
}

function EmptyRevisit({title, onOpen}: {title: string; onOpen?(): void}) {
  const content = <><span className="home-private-cell" /><span className="home-revisit-cap"><span className="home-revisit-text"><strong>{title}</strong><small>아직 표시할 항목이 없습니다.</small></span></span></>;
  return onOpen ? <button className="home-revisit is-empty" onClick={() => onOpen()} aria-label={`${title}, 아직 표시할 항목이 없습니다.`}>{content}</button> : <div className="home-revisit is-empty">{content}</div>;
}

function TodoTile({keyName, value, stale, onOpen}: {keyName: Exclude<TodoKey, 'character'>; value: number | null; stale: boolean; onOpen(): void}) {
  const info = TODO_LABELS[keyName];
  const shown = value === null ? '—' : `${count(value)}${keyName === 'pending' && value >= PENDING_LIMIT ? '+' : ''}`;
  return <button className="home-todo-tile" onClick={onOpen} aria-label={`${info.label} ${value === null ? '확인 중' : `${shown}${info.unit}`}`}><strong className="numeric">{shown}<small>{info.unit}</small></strong><span>{info.label}</span><em>{stale ? '마지막 값' : info.note}</em></button>;
}

function AssetTile({value, title, unit, onOpen, label}: {value: string; title: string; unit: string; onOpen(): void; label: string}) { return <button className="home-asset-tile" onClick={onOpen} aria-label={label}><strong className="numeric">{value}<small>{unit}</small></strong><span>{title}</span></button>; }

function AvCard({pick, privacy}: {pick: NonNullable<ReturnType<typeof useHomeAvPick>>; privacy: boolean}) {
  const initials = Array.from(pick.name.replace(/\s+/g, '')).slice(0, 2).join('') || 'AV';
  return <article className="home-av-card"><div className="home-av-head"><span className="home-av-portrait"><b>{initials}</b></span><span><small>오늘의 AV 배우</small><strong>{pick.name}</strong><em>{pick.workCount ? `작품 ${count(pick.workCount)}개` : '최근 기록'}</em></span></div>{pick.latestWork && <div className="home-av-work"><span className="home-av-mini"><HomeCoverImage cover={pick.latestWork.cover ?? pick.cover} alt={pick.latestWork.title ?? pick.latestWork.code ?? '최근 작품'} privacy={privacy} /></span><span><small>최근 작품</small><strong>{pick.latestWork.title ?? pick.latestWork.label ?? pick.latestWork.code ?? '작품 정보 없음'}</strong><em>{[pick.latestWork.series, pick.latestWork.date].filter(Boolean).join(' · ')}</em></span></div>}</article>;
}

function UpcomingDetailSheet({entry, interested, privacy, onToggle, onClose}: {entry: UpcomingHomeEntry; interested: boolean; privacy: boolean; onToggle(): void; onClose(): void}) {
  const days = entry.date ? daysAfter(entry.date, localToday()) : null;
  return <BottomSheet title={entry.title} onClose={onClose}><div className="home-detail-sheet"><div className="home-detail-cover"><HomeCoverImage cover={entry.cover} alt={entry.title} privacy={privacy} /></div><span className="home-kind">{upcomingKind[entry.kind]}</span>{entry.originalTitle && <p className="home-detail-original">{entry.originalTitle}</p>}<p className="home-detail-meta">{entry.date ?? '발매일 미정'}{days !== null && ` · ${days === 0 ? '오늘' : days > 0 ? `D-${days}` : '발매됨'}`}</p>{entry.platforms?.length ? <p className="home-detail-meta">{entry.platforms.join(' · ')}</p> : null}{entry.description && <p className="home-detail-description">{entry.description}</p>}<button className="home-interest-action" onClick={onToggle}>{interested ? '관심 목록에서 빼기' : '관심 목록에 추가'}</button></div></BottomSheet>;
}

export function Home(props: HomeProps) {
  const {items, captures, paused, secondaryError} = props;
  const [privacy] = usePrivacyMode();
  const pending = captures ? captures.length : null;
  const d = useHomeDashboard({enabled: !paused, scope: props.scope, pending, similarityKey: props.similarityKey, exchange: props.exchange});
  const memos = useHomeMemos(!paused, d.probe);
  const upcoming = useHomeUpcoming(!paused, props.scope, d.probe);
  const avPick = useHomeAvPick(!paused && !privacy, d.probe);
  const artists = useHomeArtists(!paused, d.probe);
  const [retries, setRetries] = useState(0);
  const revisit = useHomeRevisit(!paused, `${d.offline}:${retries}`);
  const [detail, setDetail] = useState<UpcomingHomeEntry | null>(null);
  const shelf = useSyncExternalStore(subscribeReleases, currentShelf);
  const works = useMemo(() => new Map((shelf?.works ?? []).map(work => [work.id, work])), [shelf]);
  const today = localToday();
  const stale = d.offline;
  const openTodo: Record<Exclude<TodoKey, 'character'>, () => void> = {pending: props.onPending, similar: props.onSimilarity, duplicates: props.onDuplicates};
  const todoKeys: Exclude<TodoKey, 'character'>[] = ['pending', 'similar', 'duplicates'];
  const dateGroup = revisit.find(group => group.key === 'date');
  const fallbackArtist = revisit.find(group => group.key !== 'date');
  const publishedArtist = artists.find(artist => artist.main) ?? artists[0];
  const artistSource = publishedArtist?.coverAssetIds?.length ? revisit.find(group => group.items.some(asset => publishedArtist.coverAssetIds?.includes(asset.id))) : null;
  const artistAssets = publishedArtist?.coverAssetIds?.length ? items.filter(asset => publishedArtist.coverAssetIds?.includes(asset.id)) : [];
  const artistBase = artistSource ?? fallbackArtist ?? (publishedArtist ? {key: `artist:${publishedArtist.id}`, title: publishedArtist.displayName || publishedArtist.label, count: publishedArtist.assetCount ?? 0, items: artistAssets, label: ''} : null);
  const artistGroup = publishedArtist && artistBase ? {...artistBase, key: `artist:${publishedArtist.id}`, title: `오늘의 작가 · ${publishedArtist.displayName || publishedArtist.label}`, label: `${count(publishedArtist.assetCount ?? fallbackArtist?.count ?? 0)}장 소장`} : fallbackArtist ? {...fallbackArtist, title: `오늘의 작가 · ${fallbackArtist.name ?? fallbackArtist.title}`} : null;

  const mangaEntries = shelfEntries(d.unreadWorks && d.unreadWorks > 0 ? d.releases ?? [] : [], d.upcoming ?? [], today);
  // Home lists only games/movies/anime on the 관심 목록 (user, 2026-09-27); the 발매 캘린더 shows everything.
  const externalEntries = upcoming.entries.filter(entry => (entry.kind === 'game' || entry.kind === 'movie' || entry.kind === 'anime') && upcoming.wishlist.has(entry.id) && entry.precision !== 'year').filter(entry => !entry.date || daysAfter(entry.date, today) >= 0).sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  const cover = (id: string, name: string) => { const work = works.get(id); return work ? <Artwork item={work} id={collectionCover(work)} revision={shelf?.revision ?? ''} active={!paused} label={name} /> : <span className="home-cover-placeholder"><RectangleStackIcon aria-hidden="true" /></span>; };
  const summary = d.summary;
  const fallback = addedToday(items, props.hasMore);
  const statValues = summary ? [String(summary.addedToday), String(summary.addedThisWeek), String(summary.total), String(summary.unclassified)] : [`${fallback.count}${fallback.more ? '+' : ''}`, '—', '—', '—'];
  const statLabels = ['오늘 추가', '이번 주', '전체', '분류 안 됨'];
  const statUnits = ['장', '장', '장', '장'];
  const statActions = [props.onRecent, props.onRecent, props.onRecent, props.onLibrary];
  const statAria = summary ? [`오늘 추가 ${summary.addedToday}장`, `이번 주 추가 ${summary.addedThisWeek}장`, `전체 ${summary.total}장`, `분류 안 됨 ${summary.unclassified}장`] : [`오늘 추가 ${statValues[0]}장`, '이번 주 —장', '전체 —장', '분류 안 됨 —장'];

  return <div className={`home-scroll home-c${privacy ? ' is-private' : ''}${stale ? ' is-stale' : ''}`} aria-label="홈">
    {stale && <div className="home-offline" role="status"><SignalSlashIcon aria-hidden="true" /><div><strong>오프라인 — 서버에 닿지 않습니다</strong><p>{d.since ? <>숫자와 목록은 <span className="numeric">{clockLabel(d.since)}</span> 기준으로 남겨 둔 값입니다. 메모는 그대로 쓸 수 있습니다.</> : '연결되면 다시 불러옵니다. 메모는 그대로 쓸 수 있습니다.'}</p></div><button className="home-retry" onClick={() => { d.retry(); setRetries(value => value + 1); props.onRefresh?.(); }}>다시 연결</button></div>}
    <div className="home-c-top"><TransferPanel sending={d.sending} exchange={props.exchange} privacy={privacy} onOpen={props.onExchange} /><MemoPanel rows={memos?.rows ?? []} memos={memos} onOpen={props.onNotes} /></div>
    <Section title="신간 · 발매 예정" meta={<><span className="numeric">{mangaEntries.length + externalEntries.length}</span>개<Stale at={stale ? d.releasesAt ?? d.upcomingAt : null} /></>} onMore={props.onReleases} moreLabel="신간 · 발매 예정 전체"><div className="home-shelf">{mangaEntries.slice(0, 12).map(entry => <ShelfManga key={`manga:${entry.kind}:${entry.id}:${entry.kind === 'upcoming' ? entry.volumeNumber : ''}`} entry={entry} today={today} privacy={privacy} cover={cover(entry.id, entry.name)} onOpen={() => props.onWork(entry.id)} />)}{externalEntries.slice(0, 12).map(entry => <ShelfExternal key={`${entry.kind}:${entry.id}`} entry={entry} today={today} interested={upcoming.wishlist.has(entry.id)} privacy={privacy} onOpen={() => setDetail(entry)} />)}{mangaEntries.length + externalEntries.length === 0 && <p className="home-empty-shelf">발매 예정 작품이 없습니다.</p>}</div></Section>
    <div className={`home-c-middle${!avPick || privacy ? ' is-wide' : ''}`}>{!privacy && avPick && <Section title="오늘의 AV 배우"><AvCard pick={avPick} privacy={privacy} /></Section>}<Section title="확인할 것" meta={<Stale at={d.todosAt} />}><div className="home-todo-cards">{todoKeys.map(key => <TodoTile key={key} keyName={key} value={d.todos[key]} stale={stale} onOpen={openTodo[key]} />)}</div></Section></div>
    <div className="home-c-bottom"><Section title="다시 보기" meta="예전에 모은 것" onMore={props.onArtists} moreLabel="작가 전체"><div className="home-revisits home-c-revisits">{dateGroup ? <RevisitCard group={{...dateGroup, title: '1년 전 오늘'}} paused={paused} privacy={privacy} onOpen={() => props.onRevisit?.('date', dateGroup.title)} /> : <EmptyRevisit title="1년 전 오늘" />}{artistGroup ? <RevisitCard group={artistGroup} paused={paused} privacy={privacy} noChevron onOpen={() => props.onArtists?.()} /> : <EmptyRevisit title="오늘의 작가" onOpen={props.onArtists} />}</div></Section><Section title="자산 현황" meta={<Stale at={summary ? d.summaryAt : null} />}><div className="home-asset-grid">{statValues.map((value, index) => <AssetTile key={statLabels[index]} value={value} unit={statUnits[index]!} title={statLabels[index]!} label={statAria[index]!} onOpen={statActions[index]!} />)}</div></Section></div>
    {secondaryError && <p className="hint" role="status">{secondaryError}</p>}
    {detail && <UpcomingDetailSheet entry={detail} interested={upcoming.wishlist.has(detail.id)} privacy={privacy} onToggle={() => upcoming.toggle(detail.id)} onClose={() => setDetail(null)} />}
  </div>;
}
