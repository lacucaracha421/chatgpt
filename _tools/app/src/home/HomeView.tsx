import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AreaPainted, AreaRequested, AreaVisible } from "../shared/motion/AreaSwitch";
import { useAuthoritySyncHealth, useCloudSyncStatus } from "../app/useCloudProblems";
import { useWorkloadProfile } from "../app/workloadProfile";
import { igdbImagePreviewUrl, tmdbImagePreviewUrl } from "../assets/mediaUrl";
import { collectionCoverUrl } from "../collections/collectionCover";
import { useAvLinkPendingCount, type AvLinkApi } from "../collections/AvLinkInbox";
import { groupInbox, localDay } from "../collections/releaseCaption";
import { useReleaseData } from "../collections/releaseData";
import { ViewToolbar } from "../layout/ViewToolbar";
import { useLibrary } from "../library/LibraryContext";
import type { AssetDateBucket, AssetView, ClassificationEntry, CollectionSummary, HomeOverview, ReleaseCalendar, ReleaseTitle, ReleaseWishlistItem } from "../library/types";
import type { CharacterTarget } from "../characters/api";
import { confirmSources, confirmTotal, type ConfirmScope, type ConfirmSources } from "../characters/confirmClient";
import { ConfirmOverview } from "../characters/ConfirmOverview";
import { taggerDecisionApi, type TaggerDecisionApi } from "../characters/taggerReviewClient";
import { notesStore, type NotesStore } from "../notes/store";
import { usePrivacy } from "../privacy/PrivacyContext";
import { useLocalDayClock } from "../shared/useLocalDayClock";
import { Dialog as UiDialog } from "../shared/ui/Dialog";
import { displayDate } from "../shared/displayDate";
import { AssetStableImage as StableImage } from "../privacy/AssetImage";
import { Skeleton } from "../shared/ui/Skeleton";
import { Button } from "../shared/ui/Button";
import { localBoundaries, newlyReleasedRows, weekdayLabel, upcomingRows, type ReleaseRow, type UpcomingRow } from "./homeModel";
import { attentionRows } from "./homeAttentionModel";
import { HomeToday, type HomeReleaseCard } from "./HomeAttention";
import { useHomeVisit } from "./useHomeVisit";
import { HomeCalendar } from "./HomeCalendar";
import { calendarPayments, calendarSavedQuery, releaseCalendarModel } from "./homeCalendarModel";
import { HomeTransfer, type PickFiles, type TransferRoute } from "./HomeTransfer";
import { HomeQuickMemo } from "./HomeQuickMemo";
import { HomeDailyCard, HomeLinkVault } from "./HomeSlots";
import { CardAlbum } from "../cards/CardAlbum";
import type { ExchangeStore } from "../exchange/exchangeStore";
import type { DropSubscriber } from "../ingestion/useFileDrop";
import { BusyLabel } from "../shared/ui/BusyLabel";
import { useLaunchReady } from "../shared/launch/LaunchSplash";
import { useConnectionRows } from "../layout/ConnectionStatusBlock";
import { readDuplicateCount } from "./duplicateCount";
import { pcStartupInput, pcStartupRead } from "../shared/pcPerfLog";
import { readCalendarSourcesCache, readWishlistCache, writeCalendarSourcesCache, writeWishlistCache } from "./homeReleaseCache";
import "./home.css";

const ConfirmList = lazy(() => import("../characters/ConfirmList").then((module) => ({ default: module.ConfirmList })));
const CatalogReviewDialog = lazy(() => import("../manga/CatalogReviewDialog").then((module) => ({ default: module.CatalogReviewDialog })));

const native = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
type Dialog = ({ kind: "confirm" } & ConfirmScope) | { kind: "duplicates" };
/** Every pending item of the 확인 list, each pair once. */
type ConfirmQueue = { total: number };

export type HomeViewProps = {
  collections: CollectionSummary[];
  collectionsReady?: boolean;
  /** The initial trash count has arrived; later count changes still refresh the overview. */
  overviewReady?: boolean;
  /** Opens one asset in the library viewer (다시 보기 thumbnails). */
  onOpenAsset?: (assetId: string) => void;
  /** Similarity review groups waiting (the app's count). */
  reviewCount: number;
  /** Null until read; Home asks for a read when it opens. */
  unsortedCount: number | null;
  trashCount: number;
  /** Moves after imports and membership changes; the asset counts are read again. */
  refreshVersion?: number;
  onNavigate: (view: AssetView) => void;
  onQueuesRequested?: () => void;
  notes?: NotesStore;
  /** The three 확인 lists and their counts; injectable for browser tests. Defaults to the native reads. */
  confirmSource?: ConfirmSources;
  confirmApi?: TaggerDecisionApi;
  /** Registered characters (series of each target) and classifications (series names). */
  characters?: CharacterTarget[];
  classifications?: ClassificationEntry[];
  now?: () => Date;
  avLinkApi?: AvLinkApi;
  /** The 전송 tile's exchange state, drop source and file picker; injectable for browser tests. */
  exchange?: ExchangeStore;
  subscribeDrops?: DropSubscriber;
  pickFiles?: PickFiles;
  /** How the 전송 tile's files travel; the direct network route comes later. */
  transferRoute?: TransferRoute;
};

/** PC Home (layout A): the release calendar and the tools on the left, today's card and attention on the right. */

export function HomeView({ collections, collectionsReady = true, overviewReady = true, reviewCount, unsortedCount, trashCount, refreshVersion = 0, onNavigate, onOpenAsset, onQueuesRequested, notes, confirmSource, confirmApi = taggerDecisionApi, characters = [], classifications = [], now = () => new Date(), avLinkApi, exchange, subscribeDrops, pickFiles, transferRoute }: HomeViewProps) {
  const [cardAlbum, setCardAlbum] = useState(false);
  const { gateway, library } = useLibrary();
  const root = library?.root ?? "";
  const requested = useContext(AreaRequested);
  const painted = useContext(AreaPainted);
  const visible = useContext(AreaVisible);
  const active = requested || painted;
  const visitSession = useRef({active, number: 0});
  if (visitSession.current.active !== active) visitSession.current = {active, number: visitSession.current.number + (active ? 1 : 0)};
  const visitNumber = visitSession.current.number;
  const { privacyMode } = usePrivacy();
  const avLinkRead = useAvLinkPendingCount({ enabled: active && !privacyMode, refreshVersion, api: avLinkApi });
  const lastAvLinkCount = useRef(avLinkRead);
  if (active) lastAvLinkCount.current = avLinkRead;
  const avLinkCount = active ? avLinkRead : lastAvLinkCount.current;
  const at = useLocalDayClock(now);
  const today = localDay(at);

  // 신간 board + inbox: the cache the Collections grid and the 신간 view share.
  const tracking = gateway.collectionTracking;
  const release = useReleaseData(tracking, collections, Boolean(tracking));
  const board = useMemo(() => release.data?.board ?? new Map(), [release.data]);
  const inbox = useMemo(() => groupInbox(release.data?.inbox ?? []), [release.data]);

  const calendarApi = gateway.releaseCalendar;
  // The last server reply Home read is kept on disk (homeReleaseCache) and shown at once; the
  // read of the current one runs after the first load and swaps in without a flash.
  const releaseCache = useRef<{ root: string | null; wishlist: ReleaseWishlistItem[] | null; calendar: ReleaseCalendar | null }>({ root: null, wishlist: null, calendar: null });
  if (releaseCache.current.root !== root) releaseCache.current = { root, wishlist: calendarApi ? readWishlistCache(root) : null, calendar: calendarApi ? readCalendarSourcesCache(root) : null };
  const [wishlistFresh, setWishlistFresh] = useState<{ root: string; items: ReleaseWishlistItem[] } | null>(null);
  const [calendarFresh, setCalendarFresh] = useState<{ root: string; value: ReleaseCalendar } | null>(null);
  const wishlist = wishlistFresh?.root === root ? wishlistFresh.items : releaseCache.current.wishlist ?? NO_WISHLIST;
  const calendarSnapshot = calendarFresh?.root === root ? calendarFresh.value : releaseCache.current.calendar;
  const shownWishlist = useRef(wishlist);
  shownWishlist.current = wishlist;
  const shownCalendar = useRef(calendarSnapshot);
  shownCalendar.current = calendarSnapshot;
  const wishlistReady = !calendarApi || wishlistFresh?.root === root || releaseCache.current.wishlist !== null;
  const [wishlistError, setWishlistError] = useState(false);
  const [startupSettled, setStartupSettled] = useState(false);
  const [releaseDetail, setReleaseDetail] = useState<ReleaseTitle | null>(null);
  const [releaseNoticeError, setReleaseNoticeError] = useState<string | null>(null);
  const [shelfRetry, setShelfRetry] = useState(0);
  // Wait for the already-pending first collection read. Later refreshes keep the old
  // snapshot active until the changed collection key arrives.
  const initialReads = useRef({ gateway, root, collections: false, overview: false });
  if (initialReads.current.gateway !== gateway || initialReads.current.root !== root) {
    initialReads.current = { gateway, root, collections: false, overview: false };
  }
  if (collectionsReady) initialReads.current.collections = true;
  if (overviewReady) initialReads.current.overview = true;
  const readsActive = active && initialReads.current.collections;
  const overviewActive = readsActive && initialReads.current.overview;
  const collectionVersion = useMemo(() => JSON.stringify(
    collections.map(work => [work.id, work.updatedAt]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ), [collections]);
  const [calendarRead, setCalendarRead] = useState<{ api: typeof calendarApi; root: string; retry: number; visit: number } | null>(null);
  // With a saved wishlist, the first load shows it and the library connection stays free for the
  // reads the first load needs; the reads start once Home is shown (or after a few seconds).
  const deferReleaseReads = !startupSettled && releaseCache.current.wishlist !== null;
  useEffect(() => {
    if (startupSettled || !active) return;
    const timer = window.setTimeout(() => setStartupSettled(true), 4000);
    return () => window.clearTimeout(timer);
  }, [startupSettled, active]);
  useEffect(() => {
    if (!calendarApi || !active || deferReleaseReads) return;
    let live = true;
    const acceptWishlist = (items: ReleaseWishlistItem[]) => {
      if (!live) return;
      // Same content keeps the shown array (no re-render churn); the saved copy is always renewed.
      const same = JSON.stringify(shownWishlist.current) === JSON.stringify(items);
      writeWishlistCache(root, items);
      setWishlistFresh(previous => previous?.root === root && same ? previous : { root, items: same ? shownWishlist.current : items });
    };
    const acceptCalendar = (value: ReleaseCalendar | null) => {
      if (!live || !value) return;
      const next = { rangeStart: value.rangeStart, rangeEnd: value.rangeEnd, entries: [], sources: value.sources ?? [] };
      const same = JSON.stringify(shownCalendar.current?.sources) === JSON.stringify(next.sources);
      writeCalendarSourcesCache(root, next);
      setCalendarFresh(previous => previous?.root === root && same ? previous : { root, value: same && shownCalendar.current ? shownCalendar.current : next });
    };
    const wishlistRead = pcStartupRead("home.wishlist", () => calendarApi.wishlist()).then((items) => {
      acceptWishlist(items ?? []);
      if (live) setWishlistError(false);
      return true;
    }, () => { if (live) setWishlistError(true); return false; });
    const releaseRead = pcStartupRead("home.calendar", () => calendarApi.calendar()).then(value => { acceptCalendar(value); return true; }, () => false);
    void Promise.all([wishlistRead, releaseRead]).then(results => {
      if (live && results.every(Boolean)) setCalendarRead({ api: calendarApi, root, retry: shelfRetry, visit: visitNumber });
    });
    // The native reads answer from disk and revalidate with the server behind them; a change
    // they find arrives here as an event.
    const stop = calendarApi.subscribeChanged?.(() => {
      void calendarApi.calendar().then(acceptCalendar).catch(() => undefined);
      void calendarApi.wishlist().then(items => acceptWishlist(items ?? [])).catch(() => undefined);
    });
    return () => { stop?.(); live = false; };
  }, [calendarApi, root, shelfRetry, active, visitNumber, deferReleaseReads]);

  const [queueRead, setQueueRead] = useState(0);
  const [savedDays, setSavedDays] = useState<{ root: string; days: AssetDateBucket[] } | null>(null);
  const [savedDaysSettled, setSavedDaysSettled] = useState<string | null>(null);
  const [savedDaysError, setSavedDaysError] = useState(false);
  const [savedDaysRetry, setSavedDaysRetry] = useState(0);
  useEffect(() => {
    if (!overviewActive || !gateway.listAssetDateBuckets) return;
    let live = true;
    void gateway.listAssetDateBuckets(calendarSavedQuery(today)).then(days => {
      if (!live) return;
      setSavedDays({ root, days });
      setSavedDaysError(false);
    }, () => { if (live) setSavedDaysError(true); }).finally(() => { if (live) setSavedDaysSettled(root); });
    return () => { live = false; };
  }, [gateway, root, today, refreshVersion, trashCount, overviewActive, savedDaysRetry]);
  const [overview, setOverview] = useState<HomeOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(Boolean(gateway.getHomeOverview));
  const [overviewError, setOverviewError] = useState(false);
  useEffect(() => {
    if (!gateway.getHomeOverview || !overviewActive) return;
    let live = true;
    setOverviewLoading(true);
    const { todayStart, weekStart } = localBoundaries(at);
    void pcStartupRead("home.overview", () => gateway.getHomeOverview!(todayStart, weekStart, today)).then((value) => {
      if (!live) return;
      setOverview(previous => previous && value ? {
        ...value,
        tagger: value.failed.includes("tagger") ? previous.tagger : value.tagger,
        server: value.failed.includes("server") ? previous.server : value.server,
      } : value);
      setOverviewError(false);
      setOverviewLoading(false);
    }, () => { if (live) { setOverviewError(true); setOverviewLoading(false); } });
    return () => { live = false; };
    // `now` is a test seam; only the local day, gateway and relevant changes repeat this read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, root, collectionVersion, refreshVersion, trashCount, queueRead, today, overviewActive]);

  // 확인할 것 counts other screens own; read when Home opens and after their dialogs close.
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // The 확인 overview replaces Home until its back; `reviewRead` moves when a list closes.
  const [reviewOverview, setReviewOverview] = useState(false);
  const [reviewRead, setReviewRead] = useState(0);
  const [confirmQueue, setConfirmQueue] = useState<ConfirmQueue | null>(null);
  const [duplicateCount, setDuplicateCount] = useState<number | null>(null);
  const [duplicateError, setDuplicateError] = useState(false);
  const [confirmError, setConfirmError] = useState(false);
  const sources = useMemo<ConfirmSources | null>(() => confirmSource ?? (native() ? confirmSources : null), [confirmSource]);
  // Lightweight mode skips the exact count (it reads the recognition lists); the tag count of the Home
  // overview stands in for the total until the mode ends, then the exact count is read once.
  const { restricted } = useWorkloadProfile();
  useEffect(() => {
    if (!active) return;
    if (!sources || restricted) { setConfirmQueue(null); return; }
    let live = true;
    void sources.counts().then(confirmTotal).then((total) => {
      if (!live) return;
      setConfirmQueue({ total });
      setConfirmError(false);
    }).catch(() => { if (live) setConfirmError(true); });
    return () => { live = false; };
  }, [sources, restricted, queueRead, active]);
  useEffect(() => {
    if (!active) return;
    let live = true;
    onQueuesRequested?.();
    void readDuplicateCount(gateway).then((count) => {
      if (live) { setDuplicateCount(count); setDuplicateError(false); }
    }, () => { if (live) setDuplicateError(true); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, queueRead, refreshVersion, active]);

  const store = useMemo(() => notes ?? (root ? notesStore(root) : null), [notes, root]);
  const notesState = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.snapshot ?? emptyNotes);
  useEffect(() => { void store?.load(); }, [store]);
  const cloud = useCloudSyncStatus(gateway, root);
  const { health } = useAuthoritySyncHealth(gateway, root);
  const connectionRows = useConnectionRows({ gateway, cloud, authorityHealth: health, active, calendar: calendarSnapshot });
  const go = (view: AssetView) => () => onNavigate(view);
  const calendarView = (type: "game" | "movie" = "game"): AssetView => ({ kind: "collections", typeFilter: type, showcase: false, releaseCalendar: true });

  /* 확인할 것; one total for the three kinds, opening the overview */
  const seriesNames = useMemo(() => new Map(classifications.map((entry) => [entry.id, entry.name])), [classifications]);
  const seriesName = useMemo(() => (id: string) => seriesNames.get(id), [seriesNames]);
  // The tag count is one cheap COUNT in the overview, so it shows even in lightweight mode.
  const taggerQueueCounts = overview?.tagger ?? null;
  // The exact 확인 total, each pair once; in lightweight mode (or while the exact count is out) only the tag pairs are counted, by the overview read.
  const confirmExact = Boolean(sources) && !restricted;
  const confirmTotalNow = confirmExact && confirmQueue ? confirmQueue.total : taggerQueueCounts?.total ?? 0;
  const retryOverview = () => setQueueRead(value => value + 1);
  const fieldFailed = (field: HomeOverview["failed"][number]) => overviewError || Boolean(overview?.failed.includes(field));
  const reviewUnknown = [
    {key: "confirm", label: "확인", unknown: confirmExact ? confirmQueue === null || confirmError : Boolean(gateway.getHomeOverview) && (!overview || fieldFailed("tagger")), failed: confirmExact ? confirmError : fieldFailed("tagger")},
    {key: "duplicates", label: "중복 판본", unknown: duplicateCount === null || duplicateError, failed: duplicateError},
    {key: "unsorted", label: "미분류 에셋", unknown: unsortedCount === null, failed: false},
    {key: "av-link", label: "AV 품번", unknown: !privacyMode && avLinkCount === null, failed: false},
    {key: "pending", label: "처리 대기", unknown: Boolean(gateway.getHomeOverview) && (!overview || fieldFailed("server") || (overview.server?.configured && overview.server.capturesPending === null)), failed: fieldFailed("server"), settled: Boolean(overview?.server) && !fieldFailed("server")},
  ].filter(row => row.unknown);
  const todos = [
    { key: "confirm", label: "확인", count: confirmTotalNow, open: () => setReviewOverview(true) },
    { key: "similar", label: "유사 이미지 검토", count: reviewCount, unit: "쌍", open: go({ kind: "similarity_review" }) },
    { key: "duplicates", label: "중복 판본", count: duplicateCount ?? 0, open: () => setDialog({ kind: "duplicates" }) },
    { key: "unsorted", label: "미분류 에셋", count: unsortedCount ?? 0, open: go({ kind: "unsorted" }) },
    { key: "av-link", label: "AV 품번", count: privacyMode ? 0 : avLinkCount ?? 0, open: go({ kind: "collections", typeFilter: "av", showcase: false }) },
    { key: "pending", label: "처리 대기", count: overview?.server?.capturesPending ?? 0, open: go({ kind: "settings", section: "connection" }) },
  ].filter((todo) => todo.count > 0);

  const releases = newlyReleasedRows(collections, board, inbox, wishlist, today);
  const arrivalItems = releases.map(row => ({ ...row, date: row.date ?? null, token: `${row.key}:${row.date ?? ''}:${row.volume ?? ''}`, fresh: row.caption.kind === 'new' }));
  const arrivalsReady = collectionsReady && (!tracking || Boolean(release.data && !release.loading && !release.error))
    && (!calendarApi || (calendarRead?.api === calendarApi && calendarRead.root === root && calendarRead.retry === shelfRetry && calendarRead.visit === visitNumber));
  const visit = useHomeVisit(root, arrivalItems, today, visible, at.toISOString(), arrivalsReady);
  const upcoming = upcomingRows(collections, board, inbox, wishlist, today);
  const openRelease = (row: ReleaseRow & { token: string }) => {
    visit.opened(row.token);
    setReleaseNoticeError(null);
    if (row.collection) onNavigate({ kind: 'collection', collectionId: row.collection.id });
    else if (row.title) {
      const title = row.title;
      setReleaseDetail(title);
      const events = wishlist.find(item => item.id === title.id)?.unread ?? [];
      // Opening Home's title also confirms the notices used by the calendar.
      if (events.length && calendarApi) {
        void calendarApi.acknowledge(events.map(event => event.id)).catch(() => setReleaseNoticeError(title.id));
      }
    }
  };
  const openUpcoming = (row: UpcomingRow) => row.collectionId ? onNavigate({ kind: 'collection', collectionId: row.collectionId }) : onNavigate(calendarView(row.kind === 'movie' ? 'movie' : 'game'));
  const problems = connectionRows.filter(row => row.tone === 'off' || row.tone === 'idle');
  // Where the client reports sync health, the connection rows above already follow the live state the
  // status center shows. The overview's one-shot reading of the server watch is only the fallback: it
  // can predate the first watch result and would keep "연결 안 됨" until the next overview read.
  if (!gateway.authoritySyncHealth && overview?.server?.configured && !overview.server.live && !problems.some(row => row.key === 'server')) problems.unshift({ key: 'server', label: '서버', value: '연결 안 됨', tone: 'off', view: { kind: 'settings', section: 'connection' } });
  // Keep a late count's row in place for this visit, including a zero result.
  const duplicateSlot = useRef(false);
  const reservedTodos = duplicateSlot.current || duplicateCount === null
    ? [...todos.filter(todo => todo.key !== 'duplicates'), { key: 'duplicates', label: '중복 판본', count: 1 }]
    : todos;
  const todayRows = attentionRows(notesState.notes, reservedTodos, problems, today).map(row => ({ ...row,
    value: row.key === 'duplicates' ? duplicateCount === null ? ' ' : duplicateCount.toLocaleString() : row.value,
    disabled: row.key === 'duplicates' ? duplicateCount === null : row.key === 'pending' ? overviewLoading || fieldFailed('server') : false }));

  const cover = (row: ReleaseRow | UpcomingRow) => {
    if (privacyMode) return null;
    const collection = "collection" in row ? (row as ReleaseRow).collection : "collectionId" in row ? (row as UpcomingRow).collectionId ? collections.find((item) => item.id === (row as UpcomingRow).collectionId) : undefined : undefined;
    if (collection) return collectionCoverUrl(collection);
    const title = "title" in row ? row.title : wishlist.find((item) => item.id === row.key.replace(/^title:/, ""));
    if (!title?.cover) return null;
    return title.provider === "igdb" ? igdbImagePreviewUrl(title.cover, "cover") : tmdbImagePreviewUrl(title.cover, "poster");
  };

  const closeDialog = () => { setDialog(null); if (reviewOverview) setReviewRead((value) => value + 1); else setQueueRead((value) => value + 1); };
  const dialogs = dialog && <Suspense fallback={null}>
    {dialog.kind === "confirm"
      ? <ConfirmList onClose={closeDialog} privacyMode={privacyMode} scope={dialog} targets={characters} classifications={classifications} sources={sources ?? confirmSources} decisions={confirmApi} />
      : <CatalogReviewDialog onClose={closeDialog} onChange={() => setQueueRead((value) => value + 1)} />}
  </Suspense>;

  const shelfLoading = (Boolean(tracking) && !release.data && !release.error) || (!wishlistReady && !wishlistError);
  const shelfFailed = Boolean(release.error) || wishlistError;
  const retryShelf = () => { release.reload(); setShelfRetry(value => value + 1); };
  const attentionPending = (Boolean(gateway.getHomeOverview) && !overview && !overviewError)
    || confirmExact && confirmQueue === null && !confirmError || Boolean(store && !notesState.ready)
    || Boolean(gateway.listAssetDateBuckets) && savedDaysSettled !== root;
  // Opt-in timing log: which first-load input arrives last (no effect when the log is off).
  if (collectionsReady) pcStartupInput("home.collections");
  if (!shelfLoading) pcStartupInput("home.shelf");
  if (!(Boolean(gateway.getHomeOverview) && !overview && !overviewError)) pcStartupInput("home.overview");
  if (!(confirmExact && confirmQueue === null && !confirmError)) pcStartupInput("home.characterQueue");
  if (!(store && !notesState.ready)) pcStartupInput("home.notes");
  if (!tracking || release.data || release.error) pcStartupInput("home.releases");
  if (wishlistReady || wishlistError) pcStartupInput("home.wishlist");
  // Resolve the initial block arrangement together; subsequent reads leave it mounted.
  const layoutShown = useRef(false);
  if (collectionsReady && !shelfLoading && !attentionPending) {
    if (!layoutShown.current && duplicateCount === null) duplicateSlot.current = true;
    layoutShown.current = true;
  }
  const firstLoad = !layoutShown.current;
  useEffect(() => { if (!firstLoad) setStartupSettled(true); }, [firstLoad]);
  // On app start the launch splash covers this first load, then leaves with Home's first images.
  const launchHost = useRef<HTMLDivElement>(null);
  useLaunchReady(!firstLoad, launchHost);

  if (cardAlbum) return <CardAlbum onBack={() => setCardAlbum(false)} onOpenAsset={onOpenAsset} onCharacter={id => {
    const target = characters.find(character => character.id === id);
    setCardAlbum(false);
    onNavigate({ kind: "classification", classificationId: target?.seriesClassificationId ?? null, characterId: id });
  }} />;

  if (reviewOverview) return <>
    <ConfirmOverview sources={sources ?? confirmSources} targets={characters} seriesName={seriesName} version={reviewRead} restricted={restricted} privacyMode={privacyMode}
      onBack={() => { setReviewOverview(false); setQueueRead((value) => value + 1); }} onOpen={(scope) => setDialog({ kind: "confirm", ...scope })} />
    {dialogs}
  </>;

  const releaseKind = (kind: ReleaseRow['kind'], volume?: number | null) => volume ? `${volume}권` : ({ game: '게임', movie: '영화', anime: '애니', manga: '만화' })[kind];
  const releaseCover = (row: ReleaseRow | UpcomingRow) => { const src = cover(row); return src ? <StableImage src={src} alt="" loading="lazy" decoding="async" /> : undefined; };
  const releaseCards: HomeReleaseCard[] = [
    ...visit.arrivals.map(row => ({ key: row.key, name: row.name, date: row.date ?? null, detail: releaseKind(row.kind, row.volume), fresh: true, cover: releaseCover(row), onOpen: () => openRelease(row) })),
    ...upcoming.filter(row => !visit.arrivals.some(arrival => arrival.date === row.date && (arrival.volume ?? null) === (row.volume ?? null) && (arrival.key === row.key || arrival.collection?.id === row.collectionId && !!row.collectionId)))
      .map(row => ({ key: row.key, name: row.name, date: row.date, detail: releaseKind(row.kind, row.volume), cover: releaseCover(row), onOpen: () => openUpcoming(row) })),
  ];
  const calendar = releaseCalendarModel(releaseCards, today, 2, {
    payments: calendarPayments(notesState.keyringLocked ? [] : notesState.notes, today),
    saved: savedDays?.root === root ? savedDays.days : [],
  });
  return <div className="home-view" ref={launchHost}>
    <ViewToolbar title="홈" titleContent={<span className="home-title-date"><span className="numeric">{displayDate(at, at)}</span> {weekdayLabel(at)}</span>} />
    <div className="home-scroll"><div className="home-content home-pc-layout" aria-busy={firstLoad}>
      <div className="home-media-column">
        {firstLoad ? <div className="home-media-waiting"><Skeleton label="홈 미디어" /><BusyLabel busy>홈 불러오는 중</BusyLabel></div> : <>
          <HomeCalendar model={calendar} at={at} onOpenCalendar={() => onNavigate(calendarView())} onOpenNote={noteId => onNavigate({ kind: 'notes', noteId })} />
          {savedDaysError && <p role="status">저장한 이미지 수를 확인할 수 없습니다 <Button variant="quiet" onClick={() => setSavedDaysRetry(value => value + 1)}>다시 시도</Button></p>}
          {shelfFailed && <p role="status">신간을 확인할 수 없습니다 <Button variant="quiet" onClick={retryShelf}>다시 시도</Button></p>}
          <div className="home-tools">
            <HomeTransfer at={at} enabled={active && visible} route={transferRoute} store={exchange} subscribeDrops={subscribeDrops} pickFiles={pickFiles} onOpenDetail={() => onNavigate({ kind: 'exchange' })} />
            <HomeQuickMemo store={store} root={root} onOpenNotes={() => onNavigate({ kind: 'notes' })} />
            <HomeLinkVault />
          </div>
        </>}
      </div>
      <div className="home-day-column">
      {!firstLoad && <HomeDailyCard key={root} root={root} active={active} onAlbum={() => setCardAlbum(true)} />}
      {!firstLoad && todayRows.length > 0 && <HomeToday rows={todayRows} animate={false} onOpen={row => {
        if (row.noteId) onNavigate({ kind: 'notes', noteId: row.noteId });
        else if (row.key.startsWith('connection:')) { const problem = problems.find(p => `connection:${p.key}` === row.key); if (problem) onNavigate(problem.view); }
        else if (row.key === 'duplicates') setDialog({ kind: 'duplicates' });
        else todos.find(todo => todo.key === row.key)?.open();
      }} />}
      {reviewUnknown.some(row => row.failed) && <p role="status">검토 수를 확인할 수 없습니다 <Button variant="quiet" onClick={retryOverview}>다시 시도</Button></p>}
      </div>
    </div></div>
    {dialogs}
    {releaseDetail && <UiDialog open title={releaseDetail.title} onClose={() => setReleaseDetail(null)}><div className="home-release-detail">
      {releaseNoticeError === releaseDetail.id && <p role="alert">알림을 확인 처리하지 못했습니다. 발매 캘린더에서 다시 확인해 주세요.</p>}
      <p>{releaseDetail.date ? displayDate(releaseDetail.date, at) : '발매됨'}</p>
      {releaseDetail.originalTitle && <p>{releaseDetail.originalTitle}</p>}
      {releaseDetail.platforms.length > 0 && <p>{releaseDetail.platforms.join(' · ')}</p>}
      <Button onClick={() => { const kind = releaseDetail.kind; setReleaseDetail(null); onNavigate(calendarView(kind === 'movie' ? 'movie' : 'game')); }}>발매 캘린더 열기</Button>
      <Button variant="quiet" onClick={() => setReleaseDetail(null)}>닫기</Button>
    </div></UiDialog>}
  </div>;
}

const NO_WISHLIST: ReleaseWishlistItem[] = [];
const noopSubscribe = () => () => undefined;
const EMPTY_NOTES = { notes: [], keyringLocked: false } as unknown as ReturnType<NotesStore["snapshot"]>;
const emptyNotes = () => EMPTY_NOTES;
