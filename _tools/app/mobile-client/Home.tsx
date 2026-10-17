import {catalogPerfEnabled} from './catalogPerf';
import {startupMark} from './startupPerf';
import {useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {RectangleStackIcon} from '@heroicons/react/24/outline';
import {artworkVariant, collectionCover, type CollectionSummary} from './collectionModel';
import {localToday} from './collectionReleasesModel';
import {daysAfter, shelfEntries, useHomeDashboard, useHomeMemos, useHomeUpcoming, type HomeCover, type UpcomingHomeEntry, type UpcomingRow} from './homeDashboard';
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
import {Badge, Skeleton} from './ui';
import {BookmarkToggle} from '../src/shared/ui/BookmarkToggle';
import {TabletHomeToday} from './HomeToday';
import {BusyLabel} from '../src/shared/ui/BusyLabel';
import {HomeQuickMemo} from '../src/home/HomeQuickMemo';
import {paymentEvents} from '../src/home/homeCalendarModel';
import {gridDates, homeLedger, monthDays, monthOf, monthTotals, type MonthRelease} from '../src/home/homeMonthModel';
import {dayMemos, dayMemoTitle, isDayMemoNote} from '../src/notes/dayMemo';
import {ledgerEntries, monthNotesOf} from '../src/notes/ledger/summary';
import type {LedgerEntry} from '../src/notes/ledger/model';
import type {Note, NotesStore} from '../src/notes/store';
import {TabletDailyCard} from './cards/TabletDailyCard';
import {TabletTransfer} from './homeTablet/TabletTransfer';
import {TabletMonth} from './homeTablet/TabletMonth';
import {TabletDaySheet} from './homeTablet/TabletDaySheet';
import {useSavedDays} from './homeTablet/useSavedDays';
import {plainReleaseRows, type TabletReleaseTarget} from './homeTablet/tabletMonthModel';
import {tabletHomeNotes} from './homeTablet/notesStore';
import {contentCross, EASE_STANDARD, reducedMotion} from '../src/shared/motion/curves';
import {attentionRows} from '../src/home/homeAttentionModel';
import {useHomeVisit} from '../src/home/useHomeVisit';
import type {ReleaseKind} from '../src/home/homeModel';
import {koreanReleases} from './collectionReleasesModel';
import {useLocalDayClock} from '../src/shared/useLocalDayClock';
import {StableImage} from '../src/shared/ui/StableImage';
import {useLaunchReady} from '../src/shared/launch/LaunchSplash';
import {deletedTrashNotes} from '../src/safety/trashSections';
import {setTabletTrashCount} from './trashCounts';
import '../src/home/home.css';
import './home.css';
import './homeTablet/homeTablet.css';

export interface HomeProps {
  onUnsortedCount?(count: number | null): void;
  items: Asset[]; hasMore: boolean; captures: Asset[] | null; busy: boolean; paused: boolean; secondaryError: string;
  scope: string; exchange: ExchangeSnapshot | null;
  /** Retained for callers that still hold the character index. */
  characters?: CharacterIndex | null;
  /** The 확인 list (only when the PC has published one) and the key that re-reads its count. */
  review: {enabled: boolean; refreshKey: unknown}; similarityKey: unknown;
  onPending(): void; onReview(): void; onSimilarity(): void; onDuplicates(): void; onExchange(): void;
  onReleases(): void; onWork(id: string): void; onSettings(): void; onRecent(): void; onLibrary(): void; onUnclassified(): void;
  /** No longer used: Home has no 다시 보기 section. */
  onRevisit?(key: string, title: string): void; onArtists?(): void; onNotes(id?: string): void; onRefresh?(): void;
  /** Opens the card album from 오늘의 카드. */
  onAlbum?(): void;
  /** The notes store 빠른 메모 and 링크 보관 write through; Home keeps its own per server when absent. */
  notes?: NotesStore;
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
  return url ? <StableImage className={`home-home-image ${className}`} src={url} alt={alt} /> : <span data-cover-pending={cover?.sha256||cover?.url?"true":undefined} data-perf-image-pending={catalogPerfEnabled()&&!!(cover?.sha256||cover?.url)?"true":undefined} className={`home-cover-placeholder ${className}`} aria-label={`${alt} 표지 준비 중`} />;
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
  const variant = artworkVariant(item, artworkId);
  const digest = artworkId ? item.artworkVersions?.[artworkId]?.[variant] ?? revision : item.coverAssetId ?? revision;
  const source = JSON.stringify([item.id, artworkId ?? null, assetId ?? null, variant, digest]);
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
        ? native<Ticket>('collectionArtwork', {collectionId: item.id, artworkId, variant, revision, digest: item.artworkVersions?.[artworkId]?.[variant] ?? ''}, controller.signal)
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
  return url ? <StableImage className="collection-art" src={url} alt={label} /> : <span data-cover-pending={collectionCover(item)||item.coverAssetId?"true":undefined} data-perf-image-pending={catalogPerfEnabled()&&!!(collectionCover(item)||item.coverAssetId)?"true":undefined} className="home-cover-placeholder"><RectangleStackIcon aria-hidden="true" /></span>;
}

const upcomingKind: Record<UpcomingHomeEntry['kind'], string> = KIND_LABEL;

function UpcomingDetailSheet({entry, interested, privacy, noticeError, onToggle, onClose}: {entry: UpcomingHomeEntry; interested: boolean; privacy: boolean; noticeError: boolean; onToggle(): void; onClose(): void}) {
  const days = entry.date ? daysAfter(entry.date, localToday()) : null;
  return <BottomSheet title={entry.title} onClose={onClose}><div className="home-detail-sheet">{noticeError && <p role="alert">알림을 확인 처리하지 못했습니다. 발매 캘린더에서 다시 확인해 주세요.</p>}<div className="home-detail-cover"><HomeCoverImage cover={entry.cover} alt={entry.title} privacy={privacy} /></div><Badge>{upcomingKind[entry.kind]}</Badge>{entry.originalTitle && <p className="home-detail-original">{entry.originalTitle}</p>}<p className="home-detail-meta">{entry.date ? displayDate(entry.date) : '발매일 미정'}{days !== null && ` · ${ddayLabel(days) ?? '발매됨'}`}</p>{entry.platforms?.length ? <p className="home-detail-meta">{entry.platforms.join(' · ')}</p> : null}{entry.description && <p className="home-detail-description">{entry.description}</p>}<BookmarkToggle className="home-detail-bookmark" bookmarked={interested} label={interested ? '관심 목록에서 빼기' : '관심 목록에 추가'} onClick={onToggle} /></div></BottomSheet>;
}

export function Home(props: HomeProps) {
  const {captures, paused, secondaryError} = props;
  const [privacy] = usePrivacyMode();
  const at = useLocalDayClock();
  const today = localToday(at);
  const [shelfScope, setShelfScope] = useState<string | null>(null);
  const d = useHomeDashboard({enabled: !paused, scope: props.scope, pending: captures?.length ?? null, similarityKey: props.similarityKey, review: props.review, exchange: props.exchange, shelfEnabled: shelfScope === props.scope});
  useEffect(() => {props.onUnsortedCount?.(d.summary?.unclassified ?? null);}, [props.onUnsortedCount, d.summary?.unclassified]);
  const notesStore = useMemo(() => props.notes ?? tabletHomeNotes(props.scope), [props.notes, props.scope]);
  // The dedicated 빠른 메모 / 링크 보관 notes load with Home and re-read when the notes change elsewhere.
  useEffect(() => {
    if (paused) return;
    void (notesStore.snapshot().ready ? notesStore.refresh() : notesStore.load());
  }, [notesStore, paused, d.refreshKey]);
  const memos = useHomeMemos(!paused, props.scope, d.refreshKey);
  useEffect(() => {if (memos && !memos.locked) setTabletTrashCount(props.scope, 'notes', deletedTrashNotes(memos.notes).length);}, [props.scope, memos]);
  const upcoming = useHomeUpcoming(!paused, props.scope, d.refreshKey);
  const [releaseNoticeError, setReleaseNoticeError] = useState<string | null>(null);
  const openTitle = (entry: UpcomingHomeEntry) => {
    setDetail(entry);
    setReleaseNoticeError(null);
    const events = (upcoming.wishlistItems.find(item => item.id === entry.id)?.events ?? []).filter(event => !event.readAt);
    if (!events.length) return;
    const controller = new AbortController();
    void api('/v1/home/upcoming/wishlist', controller.signal, {
      version: 1, operationId: crypto.randomUUID(), action: 'acknowledge', itemId: entry.id,
      eventIds: events.map(event => event.id),
    }, 'POST', false, props.scope).catch(() => setReleaseNoticeError(entry.id)).finally(() => controller.abort());
  };
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
  const arrivals = new Map(manga.filter(e => e.kind === 'new').map(e => [e.id, { key: `manga:${e.id}`, token: `manga:${e.id}:${e.date ?? ''}:${e.volumes}`, date: e.date, fresh: true, name: e.name, detail: e.volumes, workId: e.id, external: null as UpcomingHomeEntry | null, kind: 'manga' as ReleaseKind }]));
  if (shelf) for (const row of koreanReleases(shelf.works.filter(w => w.type === 'manga' && w.releaseWatch?.enabled), (work, edition) => work.ownedVolumes?.find(o => o.editionIndex === edition)?.count ?? null, [], today)) {
    const volume = row.volumes.filter(v => v.released && v.date && v.date <= today).sort((a,b) => b.date!.localeCompare(a.date!) || b.volumeNumber - a.volumeNumber)[0];
    if (volume && !arrivals.has(row.work.id)) arrivals.set(row.work.id, { key: `manga:${row.work.id}`, token: `manga:${row.work.id}:${volume.date}:${volume.volumeNumber}권`, date: volume.date, fresh: false, name: row.work.name, detail: `${volume.volumeNumber}권`, workId: row.work.id, external: null, kind: 'manga' });
  }
  const muted = new Set(upcoming.wishlistItems.filter(entry => entry.muted).map(entry => entry.id));
  for (const entry of [...upcoming.wishlistItems, ...upcoming.entries]) {
    if (!upcoming.wishlist.has(entry.id) || muted.has(entry.id) || arrivals.has(`title:${entry.id}`)) continue;
    const event = (upcoming.wishlistItems.find(wish => wish.id === entry.id)?.events ?? []).filter(e => e.kind === 'released' && !e.readAt).sort((a,b) => b.detectedAt.localeCompare(a.detectedAt))[0];
    if (event || (entry.precision === 'exact' && entry.date && entry.date <= today)) arrivals.set(`title:${entry.id}`, { key: `title:${entry.id}`, token: `title:${entry.id}:${entry.date ?? event?.id ?? ''}`, date: entry.date ?? null, fresh: !!event, name: entry.title, detail: '발매됨', workId: '', external: entry, kind: entry.kind });
  }
  // Published collection dates are already in the shelf; no extra detail reads.
  for (const work of shelf?.works ?? []) {
    if (work.type === 'av' || work.type === 'manga' || !work.releaseDate || !/^\d{4}-\d{2}-\d{2}$/.test(work.releaseDate) || work.releaseDate > today) continue;
    if ([...arrivals.values()].some(e => e.name === work.name && e.date === work.releaseDate)) continue;
    arrivals.set(`work:${work.id}`, { key: `work:${work.id}`, token: `work:${work.id}:${work.releaseDate}`, date: work.releaseDate, fresh: false, name: work.name, detail: '발매됨', workId: work.id, external: null, kind: work.type });
  }
  const visit = useHomeVisit(props.scope, [...arrivals.values()], today, !paused, at.toISOString(), d.releasesReady && upcoming.ready);
  const futureTitles = new Map(upcoming.wishlistItems.map(entry => [entry.id, entry as UpcomingHomeEntry & { muted?: boolean }]));
  for (const entry of upcoming.entries) if (upcoming.wishlist.has(entry.id) && !futureTitles.has(entry.id)) futureTitles.set(entry.id, entry);
  const reviewRows = [
    { key: 'unsorted', label: '미분류 에셋', count: d.summary?.unclassified ?? null, unit: '장' },
    { key: 'similar', label: '유사 이미지 검토', count: d.todos.similar, unit: '쌍' },
    { key: 'pending', label: '처리 대기', count: d.todos.pending, unit: '건' },
    // The kept count (the last one read) shows at once; only a first-ever launch waits for the read.
    ...(props.review.enabled ? [{ key: 'confirm', label: '확인', count: d.todos.character ?? (d.characterSettled ? 0 : null), unit: '건' }] : []),
  ];
  const connections = [
    ...(d.offline || d.serverProblem ? [{ key: 'server', label: '서버', value: d.offline ? '연결 안 됨' : '요청을 처리할 수 없음', tone: 'off' }] : []),
    ...(props.exchange?.configured && props.exchange.code ? [{ key: 'exchange', label: 'PC 연결', value: '전송을 확인해 주세요', tone: 'off' }] : []),
    ...(d.catalogJob?.state === 'failed' ? [{ key: 'catalog', label: '카탈로그', value: '갱신 실패', tone: 'off' }] : []),
  ];
  const rows = attentionRows(memos?.notes ?? [], reviewRows, connections, today);
  const attentionPending = !memos || reviewRows.some(row => row.count === null);
  // Full publication paging can occupy the bridge for many pages. Let the small
  // first-screen reads finish first, while keeping the existing first-load and
  // persisted-shelf display rules (including an uncached launch's complete shelf).
  useEffect(() => {
    if (!paused && !attentionPending && upcoming.ready && d.shelfPrerequisitesReady) setShelfScope(props.scope);
  }, [paused, attentionPending, upcoming.ready, d.shelfPrerequisitesReady, props.scope]);
  const layoutShown = useRef(false);
  if ((d.releasesReady && upcoming.ready || d.offline || d.serverProblem) && (!attentionPending || d.offline || d.serverProblem)) layoutShown.current = true;
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
  // ---- Month calendar (HOME-CAL-001): the PC's month model over what Home already holds; paging reads nothing. ----
  // The shown month and the chosen day; `null` follows today (also past midnight). A tapped day opens as a sheet.
  const [shown, setShown] = useState<{month: string | null; selected: string | null}>({month: null, selected: null});
  const [daySheet, setDaySheet] = useState<string | null>(null);
  const selected = shown.selected ?? today;
  const month = shown.month ?? monthOf(selected);
  const notesState = useSyncExternalStore(notesStore.subscribe, notesStore.snapshot);
  const grid = gridDates(month);
  const gridStart = grid[0]!, gridEnd = grid[grid.length - 1]!;
  const ledgerNotes = notesState.keyringLocked ? NO_NOTES : notesState.notes;
  const notesUnavailable = !notesState.ready || !notesState.unlocked || !!notesState.keyringLocked;
  const ledger = useMemo(() => homeLedger(ledgerNotes), [ledgerNotes]);
  const ledgerRecords = useMemo(() => ledger ? ledgerEntries(monthNotesOf(ledgerNotes, ledger.id)) : NO_ENTRIES, [ledger, ledgerNotes]);
  const payments = useMemo(() => paymentEvents(ledgerNotes, gridStart, gridEnd), [ledgerNotes, gridStart, gridEnd]);
  const memosByDate = useMemo(() => dayMemos(ledgerNotes, [...new Set(grid.map(monthOf))]), [ledgerNotes, month]); // eslint-disable-line react-hooks/exhaustive-deps
  const openTarget = (target: TabletReleaseTarget) => {
    if (target.kind === 'title') openTitle(target.entry);
    else { setDaySheet(null); props.onWork(target.id); }
  };
  const detailOf = (e: {external: UpcomingHomeEntry | null; detail: string; workId: string}) => e.external ? upcomingKind[e.external.kind] : e.detail === '발매됨' ? KIND_LABEL[works.get(e.workId)?.type ?? 'game'] : e.detail;
  const arrivalRelease = (e: (typeof visit.arrivals)[number]): MonthRelease => ({key: e.key, kind: e.kind, date: e.date ?? '', name: e.name, detail: detailOf(e), fresh: true, token: e.token,
    cover: e.external ? <HomeCoverImage cover={e.external.cover} alt="" privacy={privacy} /> : cover(e.workId, e.name),
    onOpen: () => {visit.opened(e.token); if (e.external) openTitle(e.external); else { setDaySheet(null); props.onWork(e.workId); }}});
  const plain = plainReleaseRows({works: shelf?.works ?? NO_WORKS, mangaUpcoming: d.upcoming ?? NO_UPCOMING, titles: [...futureTitles.values()].filter(entry => upcoming.wishlist.has(entry.id)), today, start: gridStart, end: gridEnd})
    .filter(row => !visit.arrivals.some(e => e.date === row.date && (e.key === row.key || e.name === row.name)))
    .map((row): MonthRelease => ({key: row.key, kind: row.kind, date: row.date, name: row.name, detail: row.detail, fresh: false,
      cover: row.target.kind === 'title' ? <HomeCoverImage cover={row.target.entry.cover} alt="" privacy={privacy} /> : cover(row.target.id, row.name),
      onOpen: () => openTarget(row.target)}));
  const placed = visit.arrivals.filter(e => e.date && e.date >= gridStart && e.date <= gridEnd).map(arrivalRelease);
  // NEW releases the six weeks cannot place (undated or outside them) stay reachable from the header.
  const unplaced = visit.arrivals.filter(e => !e.date || e.date < gridStart || e.date > gridEnd).map(arrivalRelease);
  const monthReleases = [...placed, ...plain];
  // Saved-image counts per day: one read per shown month; a server without the route leaves the cells without a heat strip.
  const saved = useSavedDays({month, scope: props.scope, enabled: !paused && !firstLoad, version: `${d.summary?.listGeneration ?? ''}|${d.refreshKey}`});
  const days = monthDays(month, today, {releases: monthReleases, payments, entries: ledgerRecords, memos: memosByDate, saved});
  const totals = ledger && !notesUnavailable ? monthTotals(month, ledgerRecords, payments) : null;
  const sheetDate = daySheet;
  const sheetMonth = sheetDate ? monthOf(sheetDate) : '';
  const memoNote = sheetDate ? ledgerNotes.find(note => isDayMemoNote(note) && note.title === dayMemoTitle(sheetMonth) && !note.deleted) ?? null : null;
  return <div className={`home-scroll home-attention-mobile${privacy ? ' is-private' : ''}`} ref={homeScroll} aria-label="홈">
    {pull}
    {firstLoad ? <div className="home-media-waiting" aria-busy="true"><Skeleton label="홈 미디어" /><BusyLabel busy>홈 불러오는 중</BusyLabel></div> : <div className="home-tablet-layout">
    <TabletMonth month={month} today={today} at={at} selected={selected} days={days} totals={totals} hideAmounts={privacy} earlier={unplaced}
      onMonth={next => setShown(previous => ({month: next, selected: previous.selected}))}
      onSelect={date => setShown(previous => ({month: previous.month ?? month, selected: date}))}
      onOpenDay={date => { setShown(previous => ({month: previous.month ?? month, selected: date})); setDaySheet(date); }}
      onToday={() => setShown({month: null, selected: null})} onOpenCalendar={props.onReleases} />
    {/* Always two halves (user 2026-10-16): the card never takes the whole row; an empty 오늘 할 것 shows its empty line. */}
    <div className="home-tablet-pair">
      <div className="home-tablet-card"><TabletDailyCard privacy={privacy} root={props.scope} active={!paused} onOpenAlbum={() => props.onAlbum?.()} /></div>
      <div className="home-tablet-today"><TabletHomeToday rows={rows} onOpen={row => {
        if (row.noteId) props.onNotes(row.noteId);
        else if (row.key === 'unsorted') props.onUnclassified();
        else if (row.key === 'similar') props.onSimilarity();
        else if (row.key === 'pending') props.onPending();
        else if (row.key === 'confirm') props.onReview();
        else if (row.key === 'duplicates') props.onDuplicates();
        else if (row.key === 'connection:exchange') props.onExchange();
        else if (row.key.startsWith('connection:')) props.onSettings();
      }} /></div>
    </div>
    <div className="home-tablet-pair">
      <TabletTransfer exchange={props.exchange} onOpenDetail={props.onExchange} />
      <HomeQuickMemo store={notesStore} root={props.scope} onOpenNotes={() => props.onNotes()} />
    </div>
    </div>}
    {sheetDate && <TabletDaySheet key={sheetDate} date={sheetDate} today={today} savedCount={sheetDate <= today ? saved.find(bucket => bucket.date === sheetDate)?.count ?? 0 : 0} onOpenSaved={() => { setDaySheet(null); props.onLibrary(); }} releases={monthReleases.filter(row => row.date === sheetDate)} hideAmounts={privacy} store={notesStore} ledger={ledger}
      notesUnavailable={notesUnavailable} syncing={notesState.syncing} memo={memosByDate.get(sheetDate) ?? ''} memoNote={memoNote} entries={ledgerRecords.filter(entry => entry.date === sheetDate)} allEntries={ledgerRecords}
      payments={payments.filter(payment => payment.date === sheetDate)} onOpenNotes={() => { setDaySheet(null); props.onNotes(); }} onClose={() => setDaySheet(null)} />}
    {secondaryError && <p className="hint" role="status">{secondaryError}</p>}
    {detail && <UpcomingDetailSheet entry={detail} interested={upcoming.wishlist.has(detail.id)} privacy={privacy} noticeError={releaseNoticeError === detail.id} onToggle={() => upcoming.toggle(detail.id)} onClose={() => setDetail(null)} />}
  </div>;
}

const NO_NOTES: Note[] = [];
const NO_ENTRIES: LedgerEntry[] = [];
const NO_WORKS: CollectionSummary[] = [];
const NO_UPCOMING: UpcomingRow[] = [];
