import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuthoritySyncHealth, useCloudSyncStatus } from "../app/useCloudProblems";
import { useWorkloadProfile } from "../app/workloadProfile";
import { igdbImagePreviewUrl, tmdbImagePreviewUrl } from "../assets/mediaUrl";
import { collectionCoverUrl } from "../collections/collectionCover";
import { useAvLinkPendingCount, type AvLinkApi } from "../collections/AvLinkInbox";
import { groupInbox, localDay } from "../collections/releaseCaption";
import { useReleaseData } from "../collections/releaseData";
import { ViewToolbar } from "../layout/ViewToolbar";
import { useLibrary } from "../library/LibraryContext";
import type { AssetView, ClassificationEntry, CollectionSummary, HomeOverview, ReleaseCalendar, ReleaseTitle, ReleaseWishlistItem } from "../library/types";
import { characterApi, type CharacterTarget } from "../characters/api";
import { TaggerReview } from "../characters/TaggerReview";
import { taggerDecisionApi, taggerReviewSource, type TaggerDecisionApi, type TaggerReviewItem, type TaggerReviewSource } from "../characters/taggerReviewClient";
import { notesStore, type NotesStore } from "../notes/store";
import { usePrivacy } from "../privacy/PrivacyContext";
import { shadowReviewApi, type ShadowReviewApi, type ShadowReviewPendingTarget } from "../characters/shadowReviewApi";
import { useLocalDayClock } from "../shared/useLocalDayClock";
import { Dialog as UiDialog } from "../shared/ui/Dialog";
import { displayDate } from "../shared/displayDate";
import { StableImage } from "../shared/ui/StableImage";
import { Skeleton } from "../shared/ui/Skeleton";
import { Button } from "../shared/ui/Button";
import { daysAfter, localBoundaries, newlyReleasedRows, weekdayLabel, upcomingRows, type ReleaseRow, type UpcomingRow } from "./homeModel";
import { attentionRows } from "./homeAttention";
import { HomeAttentionLayout, HomePresence, HomeReleaseList, HomeSection, HomeToday } from "./HomeAttention";
import { useHomeVisit } from "./useHomeVisit";
import { HomeRevisit } from "./HomeRevisit";
import { useConnectionRows } from "../layout/ConnectionStatusBlock";
import { CharacterReviewOverview, type CharacterReviewScope } from "./CharacterReviewOverview";
import { shadowPageSource, type CharacterReviewSource } from "./characterReviewSource";
import "./home.css";

const ShadowReview = lazy(() => import("../characters/ShadowReview").then((module) => ({ default: module.ShadowReview })));
const CatalogReviewDialog = lazy(() => import("../manga/CatalogReviewDialog").then((module) => ({ default: module.CatalogReviewDialog })));

const native = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
type Dialog = ({ kind: "character" } & CharacterReviewScope) | { kind: "duplicates" };
/** Compatibility fallback for injected clients that do not expose the narrow summary yet. */
const CHARACTER_PAGE = 200;
type CharacterQueue = { total: number; targets: ShadowReviewPendingTarget[] };

export type HomeViewProps = {
  collections: CollectionSummary[];
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
  shadowApi?: Pick<ShadowReviewApi, "page"> & Partial<Pick<ShadowReviewApi, "summary">>;
  /** Exact per-character counts for the 캐릭터 검토 overview; defaults to reading the whole S36 list. */
  characterSource?: CharacterReviewSource;
  /** Exact tagger queue read; injectable for browser tests. */
  taggerSource?: TaggerReviewSource;
  taggerApi?: TaggerDecisionApi;
  /** Registered characters (series of each S36 target) and classifications (series names). */
  characters?: CharacterTarget[];
  classifications?: ClassificationEntry[];
  now?: () => Date;
  avLinkApi?: AvLinkApi;
};

/** Attention-only Home: existing note, review, connection and cached release sources. */

export function HomeView({ collections, reviewCount, unsortedCount, trashCount, refreshVersion = 0, onNavigate, onQueuesRequested, notes, shadowApi, characterSource, taggerSource, taggerApi = taggerDecisionApi, characters = [], classifications = [], now = () => new Date(), avLinkApi, onOpenAsset }: HomeViewProps) {
  const { gateway, library } = useLibrary();
  const root = library?.root ?? "";
  const { privacyMode } = usePrivacy();
  const avLinkCount = useAvLinkPendingCount({ enabled: !privacyMode, refreshVersion, api: avLinkApi });
  const at = useLocalDayClock(now);
  const today = localDay(at);

  // 신간 board + inbox: the cache the Collections grid and the 신간 view share.
  const tracking = gateway.collectionTracking;
  const release = useReleaseData(tracking, collections, Boolean(tracking));
  const board = useMemo(() => release.data?.board ?? new Map(), [release.data]);
  const inbox = useMemo(() => groupInbox(release.data?.inbox ?? []), [release.data]);

  const calendarApi = gateway.releaseCalendar;
  const [wishlist, setWishlist] = useState<ReleaseWishlistItem[]>([]);
  const [wishlistReady, setWishlistReady] = useState(!calendarApi);
  const [wishlistError, setWishlistError] = useState(false);
  const [calendar, setCalendar] = useState<ReleaseCalendar | null>(null);
  const [releaseDetail, setReleaseDetail] = useState<ReleaseTitle | null>(null);
  const [shelfRetry, setShelfRetry] = useState(0);
  const [calendarRead, setCalendarRead] = useState<{ api: typeof calendarApi; root: string; retry: number } | null>(null);
  useEffect(() => {
    if (!calendarApi) return;
    let live = true;
    const wishlistRead = calendarApi.wishlist().then((items) => {
      if (live) { setWishlist(items ?? []); setWishlistReady(true); setWishlistError(false); }
      return true;
    }, () => { if (live) setWishlistError(true); return false; });
    const releaseRead = calendarApi.calendar().then(value => { if (live) setCalendar(value); return true; }, () => false);
    void Promise.all([wishlistRead, releaseRead]).then(results => {
      if (live && results.every(Boolean)) setCalendarRead({ api: calendarApi, root, retry: shelfRetry });
    });
    return () => { live = false; };
  }, [calendarApi, root, shelfRetry]);

  const [queueRead, setQueueRead] = useState(0);
  const [overview, setOverview] = useState<HomeOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(Boolean(gateway.getHomeOverview));
  const [overviewError, setOverviewError] = useState(false);
  useEffect(() => {
    if (!gateway.getHomeOverview) return;
    let live = true;
    setOverviewLoading(true);
    const { todayStart, weekStart } = localBoundaries(at);
    void gateway.getHomeOverview(todayStart, weekStart, today).then((value) => {
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
  }, [gateway, refreshVersion, trashCount, queueRead, today]);

  // 확인할 것 counts other screens own; read when Home opens and after their dialogs close.
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // 캐릭터 검토 overview replaces Home until its back; `reviewRead` moves when a review closes.
  const [reviewOverview, setReviewOverview] = useState(false);
  const [taggerOverview, setTaggerOverview] = useState(false);
  const [reviewRead, setReviewRead] = useState(0);
  const [characterQueue, setCharacterQueue] = useState<CharacterQueue | null>(null);
  const [taggerItems, setTaggerItems] = useState<TaggerReviewItem[] | null>(null);
  const [taggerLoading, setTaggerLoading] = useState(false);
  const [duplicateCount, setDuplicateCount] = useState<number | null>(null);
  const [duplicateError, setDuplicateError] = useState(false);
  const [characterError, setCharacterError] = useState(false);
  const shadowQueueApi = shadowApi ?? (native() ? shadowReviewApi : null);
  // Lightweight mode skips the S36 pending summary; the row stays hidden until the mode ends,
  // then the summary is read once.
  const { restricted } = useWorkloadProfile();
  useEffect(() => {
    if (!shadowQueueApi || restricted) { setCharacterQueue(null); return; }
    let live = true;
    const read = shadowQueueApi.summary
      ? shadowQueueApi.summary().then((summary) => ({ total: summary.automatic + summary.recommended, targets: summary.targets ?? [] }))
      : shadowQueueApi.page({ offset: 0, limit: CHARACTER_PAGE }).then((page) => {
        const total = page.summary ? page.summary.automatic.pending + page.summary.recommended.pending : 0;
        return { total: page.nextOffset === null ? Math.max(total, page.items?.length ?? 0) : total, targets: [] };
      });
    void read.then((queue) => {
      if (!live || !queue) return;
      setCharacterQueue(queue);
      setCharacterError(false);
    }, () => { if (live) setCharacterError(true); });
    return () => { live = false; };
  }, [shadowQueueApi, restricted, queueRead]);
  // Refresh only when the series set changes or a review closes; keep the last result meanwhile.
  const taggerSeriesKey = characters.map((target) => `${target.id}:${target.seriesClassificationId ?? ""}`).join("|");
  const charactersRef = useRef(characters);
  charactersRef.current = characters;
  const activeTaggerSource = useMemo(() => taggerSource ?? (native() ? taggerReviewSource(characterApi, charactersRef.current) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [taggerSource, taggerSeriesKey]);
  useEffect(() => {
    let live = true;
    onQueuesRequested?.();
    void Promise.resolve().then(() => gateway.listCatalogReview()).then((page) => {
      if (live) { setDuplicateCount((page?.rows ?? []).filter((row) => row.state === "pending" && row.actionable).length); setDuplicateError(false); }
    }, () => { if (live) setDuplicateError(true); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, queueRead]);

  const store = useMemo(() => notes ?? (root ? notesStore(root) : null), [notes, root]);
  const notesState = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.snapshot ?? emptyNotes);
  useEffect(() => { void store?.load(); }, [store]);
  const cloud = useCloudSyncStatus(gateway, root);
  const { health } = useAuthoritySyncHealth(gateway, root);
  const connectionRows = useConnectionRows({ gateway, cloud, authorityHealth: health });
  const go = (view: AssetView) => () => onNavigate(view);
  const releaseView: AssetView = { kind: "collections", typeFilter: "manga", showcase: false, releaseProvider: "kakao" };
  const calendarView = (type: "game" | "movie" = "game"): AssetView => ({ kind: "collections", typeFilter: type, showcase: false, releaseCalendar: true });

  /* 확인할 것; 캐릭터 검토 names its busiest series (from the first page) and opens the overview */
  const seriesNames = useMemo(() => new Map(classifications.map((entry) => [entry.id, entry.name])), [classifications]);
  const seriesName = useMemo(() => (id: string) => seriesNames.get(id), [seriesNames]);
  const source = useMemo(() => characterSource ?? (shadowQueueApi ? shadowPageSource(shadowQueueApi) : null), [characterSource, shadowQueueApi]);
  // The tagger count is one cheap COUNT in the overview, so it shows even in lightweight mode.
  const taggerQueueCounts = overview?.tagger ?? null;
  const retryOverview = () => setQueueRead(value => value + 1);
  const fieldFailed = (field: HomeOverview["failed"][number]) => overviewError || Boolean(overview?.failed.includes(field));
  const reviewUnknown = [
    {key: "character", label: "캐릭터", unknown: Boolean(shadowQueueApi) && !restricted && (characterQueue === null || characterError), failed: characterError},
    {key: "tagger", label: "태거", unknown: Boolean(gateway.getHomeOverview) && (!overview || fieldFailed("tagger")), failed: fieldFailed("tagger")},
    {key: "duplicates", label: "중복 판본", unknown: duplicateCount === null || duplicateError, failed: duplicateError},
    {key: "unsorted", label: "미분류 에셋", unknown: unsortedCount === null, failed: false},
    {key: "av-link", label: "AV 품번", unknown: !privacyMode && avLinkCount === null, failed: false},
    {key: "pending", label: "처리 대기", unknown: Boolean(gateway.getHomeOverview) && (!overview || fieldFailed("server") || (overview.server?.configured && overview.server.capturesPending === null)), failed: fieldFailed("server"), settled: Boolean(overview?.server) && !fieldFailed("server")},
  ].filter(row => row.unknown);
  const openTaggerReview = () => {
    if (!activeTaggerSource || taggerLoading) return;
    setTaggerLoading(true);
    void activeTaggerSource(() => undefined, () => true).then((items) => {
      if (!items) return;
      setTaggerItems(items);
      setTaggerOverview(true);
    }, (reason) => console.warn("tagger review read failed", reason)).finally(() => setTaggerLoading(false));
  };
  const todos = [
    { key: "character", label: "캐릭터", count: characterQueue?.total ?? 0, open: () => setReviewOverview(true) },
    { key: "tagger", label: "태거", count: taggerQueueCounts?.total ?? 0, open: openTaggerReview },
    { key: "similar", label: "유사 이미지 검토", count: reviewCount, unit: "쌍", open: go({ kind: "similarity_review" }) },
    { key: "duplicates", label: "중복 판본", count: duplicateCount ?? 0, open: () => setDialog({ kind: "duplicates" }) },
    { key: "unsorted", label: "미분류 에셋", count: unsortedCount ?? 0, open: go({ kind: "unsorted" }) },
    { key: "av-link", label: "AV 품번", count: privacyMode ? 0 : avLinkCount ?? 0, open: go({ kind: "collections", typeFilter: "av", showcase: false }) },
    { key: "pending", label: "처리 대기", count: overview?.server?.capturesPending ?? 0, open: go({ kind: "settings", section: "connection" }) },
  ].filter((todo) => todo.count > 0);

  const releases = newlyReleasedRows(collections, board, inbox, wishlist, today, calendar?.entries ?? []);
  const arrivalItems = releases.map(row => ({ ...row, date: row.date ?? null, token: `${row.key}:${row.date ?? ''}:${row.volume ?? ''}`, fresh: row.caption.kind === 'new' }));
  const arrivalsReady = (!tracking || Boolean(release.data && !release.loading && !release.error))
    && (!calendarApi || (calendarRead?.api === calendarApi && calendarRead.root === root && calendarRead.retry === shelfRetry));
  const visit = useHomeVisit(root, arrivalItems, today, true, at.toISOString(), arrivalsReady);
  const upcoming = upcomingRows(collections, board, inbox, wishlist, today).filter(row => daysAfter(row.date, today) <= 14);
  const openRelease = (row: ReleaseRow & { token: string }) => {
    visit.opened(row.token);
    if (row.collection) onNavigate({ kind: 'collection', collectionId: row.collection.id });
    else if (row.title) setReleaseDetail(row.title);
  };
  const openUpcoming = (row: UpcomingRow) => row.collectionId ? onNavigate({ kind: 'collection', collectionId: row.collectionId }) : onNavigate(calendarView(row.kind === 'movie' ? 'movie' : 'game'));
  const problems = connectionRows.filter(row => row.tone === 'off' || row.tone === 'idle');
  if (overview?.server?.configured && !overview.server.live && !problems.some(row => row.key === 'server')) problems.unshift({ key: 'server', label: '서버', value: '연결 안 됨', tone: 'off', view: { kind: 'settings', section: 'connection' } });
  const todayRows = attentionRows(notesState.notes, todos, problems, today).map(row => ({ ...row, disabled: row.key === 'tagger' ? taggerLoading || overviewLoading || fieldFailed('tagger') : row.key === 'pending' ? overviewLoading || fieldFailed('server') : false }));

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
    {dialog.kind === "character"
      ? <ShadowReview onClose={closeDialog} onChanged={() => undefined} privacyMode={privacyMode} series={dialog.series} target={dialog.target} />
      : <CatalogReviewDialog onClose={closeDialog} onChange={() => undefined} />}
  </Suspense>;

  const shelfLoading = (Boolean(tracking) && !release.data && !release.error) || (!wishlistReady && !wishlistError);
  const shelfFailed = Boolean(release.error) || wishlistError;
  const retryShelf = () => { release.reload(); setShelfRetry(value => value + 1); };

  if (reviewOverview && source) return <>
    <CharacterReviewOverview source={source} targets={characters} seriesName={seriesName} version={reviewRead} restricted={restricted} privacyMode={privacyMode}
      onBack={() => { setReviewOverview(false); setQueueRead((value) => value + 1); }} onOpen={(scope) => setDialog({ kind: "character", ...scope })} />
    {dialogs}
  </>;

  if (taggerOverview && taggerItems) return <TaggerReview items={taggerItems} targets={characters} classifications={classifications} privacyMode={privacyMode}
    api={taggerApi} onItemsChange={setTaggerItems} onBack={() => { setTaggerOverview(false); setQueueRead((value) => value + 1); }} />;

  const rightSections = [
    ...(visit.arrivals.length ? [{ key: 'new', content: <HomeSection title="새로 나옴 · 지난번 이후" onOpen={() => onNavigate(releaseView)}><HomeReleaseList today={today} rows={visit.arrivals.map(row => ({ key: row.key, name: row.name, date: row.date ?? null, detail: row.volume ? `${row.volume}권` : row.caption.text, fresh: true, cover: cover(row) ? <StableImage src={cover(row)!} alt="" loading="lazy" decoding="async" /> : undefined, onOpen: () => openRelease(row) }))} /></HomeSection> }] : []),
    ...(upcoming.length ? [{ key: 'upcoming', content: <HomeSection title="2주 안에 나오는 신간" onOpen={() => onNavigate(calendarApi ? calendarView() : releaseView)}><HomeReleaseList today={today} rows={upcoming.map(row => ({ key: row.key, name: row.name, date: row.date, detail: row.detail, cover: cover(row) ? <StableImage src={cover(row)!} alt="" loading="lazy" decoding="async" /> : undefined, onOpen: () => openUpcoming(row) }))} /></HomeSection> }] : []),
    ...((shelfLoading && !visit.arrivals.length && !upcoming.length) ? [{ key: 'loading', content: <Skeleton label="신간 정보" /> }] : []),
    ...(shelfFailed ? [{ key: 'release-error', content: <p role="status">신간을 확인할 수 없습니다 <Button variant="quiet" onClick={retryShelf}>다시 시도</Button></p> }] : []),
  ];
  return <div className="home-view">
    <ViewToolbar title="홈" titleContent={<span className="home-title-date"><span className="numeric">{`${at.getMonth() + 1}.${at.getDate()}`}</span> {weekdayLabel(at)}</span>} />
    <div className="home-scroll"><div className="home-content">
      <HomeAttentionLayout today={<HomeToday rows={todayRows} onOpen={row => {
        if (row.noteId) onNavigate({ kind: 'notes', noteId: row.noteId });
        else if (row.key.startsWith('connection:')) { const problem = problems.find(p => `connection:${p.key}` === row.key); if (problem) onNavigate(problem.view); }
        else todos.find(todo => todo.key === row.key)?.open();
      }} loading={reviewUnknown.length || (store && !notesState.ready) ? <>{reviewUnknown.some(r => r.failed) ? <p role="status">검토 수를 확인할 수 없습니다 <Button variant="quiet" onClick={retryOverview}>다시 시도</Button></p> : <Skeleton label="오늘 할 것" />}</> : undefined} />}
        // 1년 전 오늘 sits under 오늘 할 것 so a short to-do list does not leave the left column empty.
        leftAfter={<HomeRevisit gateway={gateway} localDate={today} privacyMode={privacyMode} onOpenAsset={onOpenAsset} />}
        right={<HomePresence items={rightSections} />} />
    </div></div>
    {dialogs}
    {releaseDetail && <UiDialog open title={releaseDetail.title} onClose={() => setReleaseDetail(null)}><div className="home-release-detail">
      <p>{releaseDetail.date ? displayDate(releaseDetail.date, at) : '발매됨'}</p>
      {releaseDetail.originalTitle && <p>{releaseDetail.originalTitle}</p>}
      {releaseDetail.platforms.length > 0 && <p>{releaseDetail.platforms.join(' · ')}</p>}
      <Button onClick={() => { const kind = releaseDetail.kind; setReleaseDetail(null); onNavigate(calendarView(kind === 'movie' ? 'movie' : 'game')); }}>발매 캘린더 열기</Button>
      <Button variant="quiet" onClick={() => setReleaseDetail(null)}>닫기</Button>
    </div></UiDialog>}
  </div>;
}

const noopSubscribe = () => () => undefined;
const EMPTY_NOTES = { notes: [], keyringLocked: false } as unknown as ReturnType<NotesStore["snapshot"]>;
const emptyNotes = () => EMPTY_NOTES;
