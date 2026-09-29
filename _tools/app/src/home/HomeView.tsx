import { BookOpenIcon, CheckCircleIcon, ChevronRightIcon, DocumentTextIcon, FilmIcon, FolderIcon, InboxIcon, ListBulletIcon, LockClosedIcon, Square2StackIcon, TagIcon, UserIcon, WalletIcon } from "@heroicons/react/24/outline";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useAuthoritySyncHealth, useCloudSyncStatus } from "../app/useCloudProblems";
import { useWorkloadProfile } from "../app/workloadProfile";
import { igdbImagePreviewUrl, nativeMediaUrl, thumbnailUrl, tmdbImagePreviewUrl, workArtworkThumbnailUrl, mangaCoverUrl } from "../assets/mediaUrl";
import { collectionCoverUrl } from "../collections/collectionCover";
import { PlatformBadges } from "../collections/PlatformBadges";
import { useAvLinkPendingCount, type AvLinkApi } from "../collections/AvLinkInbox";
import { groupInbox, localDay } from "../collections/releaseCaption";
import { useReleaseData } from "../collections/releaseData";
import { ViewToolbar } from "../layout/ViewToolbar";
import { useLibrary } from "../library/LibraryContext";
import { ddayLabel } from "../shared/displayDate";
import type { AssetView, AvFavoritePerformer, ClassificationEntry, CollectionSummary, ContinueItem, HomeOverview, ReleaseCalendar, ReleaseWishlistItem } from "../library/types";
import { characterApi, type CharacterTarget } from "../characters/api";
import { TaggerReview } from "../characters/TaggerReview";
import { taggerDecisionApi, taggerReviewSource, type TaggerDecisionApi, type TaggerReviewItem, type TaggerReviewSource } from "../characters/taggerReviewClient";
import { notesStore, type NotesStore } from "../notes/store";
import { usePrivacy } from "../privacy/PrivacyContext";
import { AvPortrait } from "../collections/av/AvPortrait";
import { shadowReviewApi, type ShadowReviewApi, type ShadowReviewPendingTarget } from "../characters/shadowReviewApi";
import { localDateAndOffset, useArtistGateway, useArtistRead } from "../artists/artistStore";
import { Badge } from "../shared/ui/Badge";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { avProfileLines, clockLabel, dateBlock, daysAfter, localBoundaries, memoRows, nextInSeriesRows, releaseRows, serverOutage, UPCOMING_DAYS, weekdayLabel, upcomingRows, type MemoRow, type ReleaseRow, type UpcomingRow } from "./homeModel";
import { HomeArtist, HomeRevisit } from "./HomeRevisit";
import { useConnectionRows, type ConnectionRow } from "../layout/ConnectionStatusBlock";
import { CharacterReviewOverview, type CharacterReviewScope } from "./CharacterReviewOverview";
import { shadowPageSource, type CharacterReviewSource } from "./characterReviewSource";
import { avGateway } from "../collections/avClient";
import type { AvPerformerProfile } from "../collections/avTypes";
import "./home.css";

const ShadowReview = lazy(() => import("../characters/ShadowReview").then((module) => ({ default: module.ShadowReview })));
const CatalogReviewDialog = lazy(() => import("../manga/CatalogReviewDialog").then((module) => ({ default: module.CatalogReviewDialog })));

const native = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
type Dialog = ({ kind: "character" } & CharacterReviewScope) | { kind: "duplicates" };
type HomeShelfRow = { source: "release"; row: ReleaseRow } | { source: "upcoming"; row: UpcomingRow };
/** Compatibility fallback for injected clients that do not expose the narrow summary yet. */
const CHARACTER_PAGE = 200;
type CharacterQueue = { total: number; targets: ShadowReviewPendingTarget[] };

export type HomeViewProps = {
  collections: CollectionSummary[];
  /** Opens one asset in the library viewer (다시 보기 thumbnails). */
  onOpenAsset?: (assetId: string) => void;
  /** Opens a reading or playback item at its saved position. */
  onOpenContinue?: (item: ContinueItem) => void;
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

/**
 * PC Home (HOME-DASH-001, layout E): the index holds nearby state, while one page scroll contains
 * the release shelf, image-first revisit/artist blocks, review queue and the below-fold sections.
 * Every row opens the PC screen that owns it. Reads happen when Home opens (and the asset
 * counts again after imports); live parts follow the stores the app already keeps (exchange,
 * notes, cloud progress, server-sync health, the 신간 cache). No polling.
 */
/** Covers on the 발매 예정 shelf; the rest are in the 발매 캘린더. */
const SHELF_MAX = 40;

export function HomeView({ collections, reviewCount, unsortedCount, trashCount, refreshVersion = 0, onNavigate, onQueuesRequested, notes, shadowApi, characterSource, taggerSource, taggerApi = taggerDecisionApi, characters = [], classifications = [], now = () => new Date(), avLinkApi, onOpenAsset, onOpenContinue }: HomeViewProps) {
  const { gateway, library } = useLibrary();
  const root = library?.root ?? "";
  const { privacyMode } = usePrivacy();
  const avLinkCount = useAvLinkPendingCount({ enabled: !privacyMode, refreshVersion, api: avLinkApi });
  const at = now();
  const today = localDay(at);

  // 신간 board + inbox: the cache the Collections grid and the 신간 view share.
  const tracking = gateway.collectionTracking;
  const release = useReleaseData(tracking, collections, Boolean(tracking));
  const board = useMemo(() => release.data?.board ?? new Map(), [release.data]);
  const inbox = useMemo(() => groupInbox(release.data?.inbox ?? []), [release.data]);

  const calendarApi = gateway.releaseCalendar;
  const [wishlist, setWishlist] = useState<ReleaseWishlistItem[]>([]);
  const [calendar, setCalendar] = useState<ReleaseCalendar | null>(null);
  useEffect(() => {
    if (!calendarApi) return;
    let live = true;
    void calendarApi.wishlist().then((items) => { if (live) setWishlist(items ?? []); }, () => undefined);
    void calendarApi.calendar().then((value) => { if (live) setCalendar(value ?? null); }, () => undefined);
    return () => { live = false; };
  }, [calendarApi]);

  const [queueRead, setQueueRead] = useState(0);
  const [overview, setOverview] = useState<HomeOverview | null>(null);
  const [continueItems, setContinueItems] = useState<ContinueItem[]>([]);
  const [avFavorites, setAvFavorites] = useState<AvFavoritePerformer[]>([]);
  useEffect(() => {
    if (!gateway.getHomeOverview) return;
    let live = true;
    const { todayStart, weekStart } = localBoundaries(now());
    void gateway.getHomeOverview(todayStart, weekStart, localDay(now())).then((value) => { if (live) setOverview(value ?? null); }, () => undefined);
    return () => { live = false; };
    // `now` is a test seam; the read follows the gateway, imports and trash changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, refreshVersion, trashCount, queueRead]);

  useEffect(() => {
    if (!gateway.listContinueItems) { setContinueItems([]); return; }
    let live = true;
    void gateway.listContinueItems(6).then((items) => { if (live) setContinueItems((items ?? []).slice(0, 6)); }, () => { if (live) setContinueItems([]); });
    return () => { live = false; };
  }, [gateway, refreshVersion]);

  useEffect(() => {
    if (!gateway.listAvFavorites) { setAvFavorites([]); return; }
    let live = true;
    void gateway.listAvFavorites().then((items) => { if (live) setAvFavorites(items ?? []); }, () => { if (live) setAvFavorites([]); });
    return () => { live = false; };
  }, [gateway, refreshVersion]);

  // 확인할 것 counts other screens own; read when Home opens and after their dialogs close.
  const [dialog, setDialog] = useState<Dialog | null>(null);
  // 캐릭터 검토 overview replaces Home until its back; `reviewRead` moves when a review closes.
  const [reviewOverview, setReviewOverview] = useState(false);
  const [taggerOverview, setTaggerOverview] = useState(false);
  const [reviewRead, setReviewRead] = useState(0);
  const [characterQueue, setCharacterQueue] = useState<CharacterQueue | null>(null);
  const [taggerItems, setTaggerItems] = useState<TaggerReviewItem[] | null>(null);
  const [taggerLoading, setTaggerLoading] = useState(false);
  const [duplicateCount, setDuplicateCount] = useState(0);
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
    }, () => undefined);
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
      if (live) setDuplicateCount((page?.rows ?? []).filter((row) => row.state === "pending" && row.actionable).length);
    }, () => undefined);
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, queueRead]);

  const store = useMemo(() => notes ?? (root ? notesStore(root) : null), [notes, root]);
  const notesState = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.snapshot ?? emptyNotes);
  useEffect(() => { void store?.load(); }, [store]);
  const cloud = useCloudSyncStatus(gateway, root);
  const { health } = useAuthoritySyncHealth(gateway, root);
  const connectionRows = useConnectionRows({ gateway, cloud, authorityHealth: health });
  const artistGateway = useArtistGateway();
  const [artistSeed, setArtistSeed] = useState(0);
  const { localDate, offsetMinutes } = localDateAndOffset(at);
  const artistTodayRead = useArtistRead((artist) => artist.today(localDate, offsetMinutes, artistSeed, []), `today:${localDate}:${artistSeed}:`);

  const outage = serverOutage(health, cloud.progress);

  const go = (view: AssetView) => () => onNavigate(view);
  const releaseView: AssetView = { kind: "collections", typeFilter: "manga", showcase: false, releaseProvider: "kakao" };
  const calendarView = (type: "game" | "movie" = "game"): AssetView => ({ kind: "collections", typeFilter: type, showcase: false, releaseCalendar: true });

  /* 확인할 것; 캐릭터 검토 names its busiest series (from the first page) and opens the overview */
  const seriesNames = useMemo(() => new Map(classifications.map((entry) => [entry.id, entry.name])), [classifications]);
  const seriesName = useMemo(() => (id: string) => seriesNames.get(id), [seriesNames]);
  const source = useMemo(() => characterSource ?? (shadowQueueApi ? shadowPageSource(shadowQueueApi) : null), [characterSource, shadowQueueApi]);
  // The tagger count is one cheap COUNT in the overview, so it shows even in lightweight mode.
  const taggerQueueCounts = overview?.tagger ?? null;
  const characterReading = Boolean(shadowQueueApi) && !restricted && characterQueue === null;
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
    { key: "character", label: "캐릭터", count: characterQueue?.total ?? 0, Icon: UserIcon, open: () => setReviewOverview(true) },
    { key: "tagger", label: "태거", count: taggerQueueCounts?.total ?? 0, Icon: TagIcon, open: openTaggerReview },
    { key: "similar", label: "유사 이미지", count: reviewCount, unit: "쌍", Icon: Square2StackIcon, open: go({ kind: "similarity_review" }) },
    { key: "duplicates", label: "중복 판본", count: duplicateCount, Icon: BookOpenIcon, open: () => setDialog({ kind: "duplicates" }) },
    { key: "unsorted", label: "미분류", count: unsortedCount ?? 0, Icon: FolderIcon, open: go({ kind: "unsorted" }) },
    { key: "av-link", label: "AV 품번", count: avLinkCount, Icon: FilmIcon, open: go({ kind: "collections", typeFilter: "av", showcase: false }) },
    { key: "pending", label: "처리 대기", count: overview?.server.capturesPending ?? 0, Icon: InboxIcon, open: go({ kind: "settings", section: "connection" }) },
  ].filter((todo) => todo.count > 0);

  /* 발매 예정: released unread rows first, then the dated upcoming rows. */
  const releases = releaseRows(collections, board, inbox, wishlist, today);
  const upcomingAll = upcomingRows(collections, board, inbox, wishlist, today);
  const upcoming = upcomingAll.filter((row) => daysAfter(row.date, today) <= UPCOMING_DAYS);
  const seriesRows = useMemo(() => nextInSeriesRows(collections, board, inbox, today), [board, collections, inbox, today]);
  const shelfAll: HomeShelfRow[] = [...releases.map((row) => ({ source: "release" as const, row })), ...upcoming.map((row) => ({ source: "upcoming" as const, row }))];
  const shelfRows = shelfAll;
  const openRelease = (row: ReleaseRow) => row.collection ? onNavigate({ kind: "collection", collectionId: row.collection.id }) : onNavigate(calendarView(row.kind === "movie" ? "movie" : "game"));
  const openUpcoming = (row: UpcomingRow) => row.collectionId ? onNavigate({ kind: "collection", collectionId: row.collectionId }) : onNavigate(calendarView(row.kind === "movie" ? "movie" : "game"));

  /* 메모 */
  const memos = memoRows(notesState.notes, today);

  const cover = (row: ReleaseRow | UpcomingRow) => {
    if (privacyMode) return null;
    const collection = "collection" in row ? (row as ReleaseRow).collection : "collectionId" in row ? (row as UpcomingRow).collectionId ? collections.find((item) => item.id === (row as UpcomingRow).collectionId) : undefined : undefined;
    if (collection) return collectionCoverUrl(collection);
    const title = "title" in row ? row.title : wishlist.find((item) => item.id === row.key.replace(/^title:/, ""));
    if (!title?.cover) return null;
    return title.provider === "igdb" ? igdbImagePreviewUrl(title.cover, "cover") : tmdbImagePreviewUrl(title.cover, "poster");
  };

  const index = <HomeIndex memos={memos} locked={Boolean(notesState.keyringLocked)} overview={overview} trashCount={trashCount} privacyMode={privacyMode}
    connectionRows={connectionRows} onNavigate={onNavigate} />;
  const closeDialog = () => { setDialog(null); if (reviewOverview) setReviewRead((value) => value + 1); else setQueueRead((value) => value + 1); };
  const dialogs = dialog && <Suspense fallback={null}>
    {dialog.kind === "character"
      ? <ShadowReview onClose={closeDialog} onChanged={() => undefined} privacyMode={privacyMode} series={dialog.series} target={dialog.target} />
      : <CatalogReviewDialog onClose={closeDialog} onChange={() => undefined} />}
  </Suspense>;

  const artistRows = artistGateway && !artistTodayRead.error ? artistTodayRead.data : null;
  const calendarTarget = calendarApi ? calendarView() : releaseView;
  const calendarPorts = useMemo(() => new Set((calendar?.entries ?? []).filter((entry) => entry.port).map((entry) => entry.id)), [calendar]);

  if (reviewOverview && source) return <>
    <CharacterReviewOverview source={source} targets={characters} seriesName={seriesName} version={reviewRead} restricted={restricted} privacyMode={privacyMode}
      onBack={() => { setReviewOverview(false); setQueueRead((value) => value + 1); }} onOpen={(scope) => setDialog({ kind: "character", ...scope })} />
    {dialogs}
  </>;

  if (taggerOverview && taggerItems) return <TaggerReview items={taggerItems} targets={characters} classifications={classifications} privacyMode={privacyMode}
    api={taggerApi} onItemsChange={setTaggerItems} onBack={() => { setTaggerOverview(false); setQueueRead((value) => value + 1); }} />;

  return <div className="home-view">
    <ViewToolbar title="홈" titleContent={<span className="home-title-date"><span className="numeric">{`${at.getMonth() + 1}.${at.getDate()}`}</span> {weekdayLabel(at)}</span>} chrome={{ navigation: index }} />
    <div className="home-scroll">
      <div className="home-content">
        {outage && <div className="home-offline" role="status">서버에 닿지 않음{outage.since && <> · <span className="numeric">{clockLabel(outage.since)}</span>부터</>}</div>}
        <div className="home-grid">
          <div className="home-grid__left">
            <HomeSection title="캘린더" onOpen={() => onNavigate(calendarTarget)}>
              {shelfRows.length > 0
                ? <ShelfScroller>
                  {shelfRows.slice(0, SHELF_MAX).map((item) => {
                    const release = item.source === "release" ? item.row : null;
                    const upcomingRow = item.source === "upcoming" ? item.row : null;
                    const row = release ?? upcomingRow!;
                    const released = Boolean(release);
                    const rowDate = row.date ?? today;
                    const block = dateBlock(rowDate, today);
                    const left = !released ? daysAfter(rowDate, today) : null;
                    const url = cover(row);
                    const volume = row.volume ?? null;
                    const platforms = row.kind === "game" ? upcomingRow?.platforms ?? release?.title?.platforms ?? [] : [];
                    const port = calendarPorts.has(row.key.replace(/^title:/, ""));
                    return <button key={`${item.source}:${row.key}`} type="button" className="home-shelf__item" onClick={() => release ? openRelease(release) : openUpcoming(upcomingRow!)}
                      aria-label={`${row.name} ${released ? "발매됨" : `${block.day} ${ddayLabel(left) ?? ""}`}`}>
                      <span className="home-shelf__date">
                        {released ? (row.date ? <span className="numeric">{block.day}</span> : <span>새 권</span>) : <span className="numeric">{block.day}</span>}
                        {!released && ddayLabel(left) && <span className="home-shelf__days numeric">{ddayLabel(left)}</span>}
                      </span>
                      <span className={`home-shelf__art${!url ? " home-cover--title" : ""}`} aria-hidden="true">
                        {url && <img src={url} alt="" loading="lazy" decoding="async" draggable={false} />}
                        {released && <span className="home-shelf__badge home-shelf__badge--new"><Badge variant="accent">NEW</Badge></span>}
                        {volume !== null && <span className="home-shelf__badge home-shelf__badge--volume"><Badge variant="scrim">{volume}</Badge></span>}
                      </span>
                      <span className="home-shelf__title">{row.name}</span>
                      {platforms.length > 0 && <span className="home-shelf__platforms"><PlatformBadges platforms={platforms} port={port} /></span>}
                    </button>;
                  })}
                </ShelfScroller>
                : <div className="home-shelf home-shelf--empty">
                  <div className="home-shelf__track" aria-hidden="true"><span className="home-shelf__item home-shelf__ghost">
                    <span className="home-shelf__date" /><span className="home-shelf__art" /><span className="home-shelf__title">&nbsp;</span>
                  </span></div>
                  <p className="home-shelf__empty">새 신간 없음</p>
                </div>}
            </HomeSection>
            <div className="home-grid__duo">
              <HomeSection title="다시 보기">
                <HomeRevisit gateway={gateway} localDate={localDate} privacyMode={privacyMode} onOpenAsset={onOpenAsset} />
              </HomeSection>
              <HomeSection title="작가" actions={<button type="button" className="home-header-action" onClick={() => setArtistSeed((value) => value + 1)}>다른 작가</button>} onOpen={() => onNavigate({ kind: "artists", section: "main" })}>
                <HomeArtist artist={artistRows?.[0] ?? null} privacyMode={privacyMode} onOpenAsset={onOpenAsset} onOpenArtist={(creatorKey) => onNavigate({ kind: "creator", creatorKey })} />
              </HomeSection>
            </div>
            {continueItems.length > 0 && <HomeContinue items={continueItems} privacyMode={privacyMode} onOpen={onOpenContinue} />}
            {seriesRows.length > 0 && <HomeSeries rows={seriesRows} privacyMode={privacyMode} onOpen={() => onNavigate(releaseView)} onOpenCollection={(collectionId) => onNavigate({ kind: "collection", collectionId })} />}
          </div>
          <div className="home-grid__right">
            {!privacyMode && overview?.avPerformer && <HomeSection title="AV 배우" onOpen={() => onNavigate({ kind: "collections", typeFilter: "av", showcase: false })}>
              <div className="home-av-performer">
                <div className="home-av-performer__row">
                  <span className="home-av-performer__portrait">
                    {overview.avPerformer.portrait
                      ? <AvPortrait portrait={overview.avPerformer.portrait} name={overview.avPerformer.displayName} size="home" />
                      : overview.avPerformer.latestWork.frontArtworkId && <img src={workArtworkThumbnailUrl(overview.avPerformer.latestWork.frontArtworkId)} alt="" loading="lazy" decoding="async" />}
                  </span>
                  <div className="home-av-performer__identity">
                    <b>{overview.avPerformer.displayName}</b>
                    {overview.avPerformer.originalName && <small>{overview.avPerformer.originalName}</small>}
                    <div className="home-av-performer__facts">
                      <span><strong className="numeric">{overview.avPerformer.knownWorks.toLocaleString()}</strong> 출연</span>
                      <span><strong className="numeric">{overview.avPerformer.ownedWorks.toLocaleString()}</strong> 소장</span>
                    </div>
                    <AvProfileBrief personId={overview.avPerformer.id} today={at} />
                  </div>
                </div>
                <div className="home-av-performer__works">
                  {overview.avPerformer.recentOwnedWorks.slice(0, 3).map((work) => <button key={work.collectionId} type="button" className="home-av-performer__work" title={work.title}
                    onClick={() => onNavigate({ kind: "collection", collectionId: work.collectionId })}>
                    <span className="home-av-performer__jacket">{work.frontArtworkId && <img src={workArtworkThumbnailUrl(work.frontArtworkId)} alt={`${work.title} 앞표지`} loading="lazy" decoding="async" />}</span>
                    {work.productCode && <small className="numeric">{work.productCode}</small>}
                  </button>)}
                </div>
              </div>
            </HomeSection>}
            <HomeSection title="검토">
              {(todos.length > 0 || characterReading)
                ? <div className="home-review-list">{characterReading && <div className="home-review-row home-review-row--reading" role="status" aria-label="캐릭터 검토 수 세는 중">
                  <UserIcon className="home-review-row__icon" aria-hidden="true" /><span>캐릭터</span><span className="home-review-row__count home-review-row__skeleton" aria-hidden="true" />
                </div>}{todos.map((todo) => <button key={todo.key} type="button" className="home-review-row" onClick={todo.open}>
                  <todo.Icon className="home-review-row__icon" aria-hidden="true" />
                  <span>{todo.label}</span>
                  <span className="home-review-row__count numeric">{todo.count.toLocaleString()}{todo.unit && <small>{todo.unit}</small>}</span>
                </button>)}</div>
                : !restricted && <div className="home-review-empty"><CheckCircleIcon aria-hidden="true" /><span>모두 확인함</span></div>}
            </HomeSection>
            {!privacyMode && avFavorites.length > 0 && <HomeFavoritePerformers performers={avFavorites} onOpen={() => onNavigate({ kind: "collections", typeFilter: "av", showcase: false })} onOpenPerformer={() => onNavigate({ kind: "collections", typeFilter: "av", showcase: false })} />}
          </div>
        </div>
      </div>
    </div>
    {dialogs}
  </div>;
}

const noopSubscribe = () => () => undefined;
const EMPTY_NOTES = { notes: [], keyringLocked: false } as unknown as ReturnType<NotesStore["snapshot"]>;
const emptyNotes = () => EMPTY_NOTES;

/** A horizontally scrolling shelf (like the tablet's swipe): mouse wheel and drag move it
 * smoothly, a released drag glides, and arrow buttons page while there is more to either side. */
function ShelfScroller({ children }: { children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const measure = () => {
    const node = track.current;
    if (!node) return;
    setEdges({ start: node.scrollLeft <= 2, end: node.scrollLeft + node.clientWidth >= node.scrollWidth - 2 });
  };
  useEffect(() => {
    measure();
    const node = track.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [children]);

  // One animation drives wheel, glide and arrows: it eases scrollLeft toward `target`.
  const target = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const stop = () => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; target.current = null; };
  const easeTo = (left: number) => {
    const node = track.current;
    if (!node) return;
    target.current = Math.max(0, Math.min(node.scrollWidth - node.clientWidth, left));
    if (frame.current !== null) return;
    const step = () => {
      const goal = target.current;
      if (goal === null || !track.current) { frame.current = null; return; }
      const distance = goal - track.current.scrollLeft;
      if (Math.abs(distance) < 0.5) { track.current.scrollLeft = goal; frame.current = null; target.current = null; return; }
      track.current.scrollLeft += distance * 0.22;
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  };
  useEffect(() => stop, []);

  // A vertical wheel moves the shelf sideways until it reaches an end; then the page scrolls.
  useEffect(() => {
    const node = track.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      const vertical = Math.abs(event.deltaY) > Math.abs(event.deltaX);
      const raw = vertical ? event.deltaY : event.deltaX;
      const delta = event.deltaMode === 1 ? raw * 40 : event.deltaMode === 2 ? raw * node.clientWidth : raw;
      const from = target.current ?? node.scrollLeft;
      const max = node.scrollWidth - node.clientWidth;
      if ((delta < 0 && from <= 0) || (delta > 0 && from >= max - 1)) return;
      event.preventDefault();
      easeTo(from + delta * 1.6);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);

  // Mouse drag pans 1:1 and glides on release; a drag never also opens the cover it started on.
  const drag = useRef<{ x: number; left: number; moved: boolean; lastX: number; lastT: number; velocity: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "mouse" || event.button !== 0 || !track.current) return;
    stop();
    drag.current = { x: event.clientX, left: track.current.scrollLeft, moved: false, lastX: event.clientX, lastT: event.timeStamp, velocity: 0 };
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    const node = track.current;
    if (!state || !node) return;
    const dx = event.clientX - state.x;
    if (!state.moved && Math.abs(dx) < 4) return;
    if (!state.moved) { state.moved = true; setDragging(true); node.setPointerCapture?.(event.pointerId); }
    const dt = Math.max(1, event.timeStamp - state.lastT);
    state.velocity = 0.8 * ((event.clientX - state.lastX) / dt) + 0.2 * state.velocity;
    state.lastX = event.clientX; state.lastT = event.timeStamp;
    node.scrollLeft = state.left - dx;
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const node = track.current;
    const state = drag.current;
    if (node?.hasPointerCapture?.(event.pointerId)) node.releasePointerCapture(event.pointerId);
    if (!state?.moved) { drag.current = null; return; }
    if (node && Math.abs(state.velocity) > 0.2) easeTo(node.scrollLeft - state.velocity * 260);
    window.setTimeout(() => { setDragging(false); drag.current = null; }, 0);
  };
  const clickCapture = (event: ReactMouseEvent) => {
    if (drag.current?.moved) { event.preventDefault(); event.stopPropagation(); }
    drag.current = null;
  };
  const page = (direction: 1 | -1) => {
    const node = track.current;
    if (node) easeTo((target.current ?? node.scrollLeft) + direction * node.clientWidth * 0.9);
  };
  return <div className="home-shelf">
    <div ref={track} className={`home-shelf__track${dragging ? " is-dragging" : ""}`} onScroll={measure}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}
      onClickCapture={clickCapture} onDragStart={(event) => event.preventDefault()}>{children}</div>
    {!edges.start && <button type="button" className="home-shelf__arrow home-shelf__arrow--prev" aria-label="이전 발매 예정" onClick={() => page(-1)}><ChevronRightIcon aria-hidden="true" /></button>}
    {!edges.end && <button type="button" className="home-shelf__arrow home-shelf__arrow--next" aria-label="다음 발매 예정" onClick={() => page(1)}><ChevronRightIcon aria-hidden="true" /></button>}
  </div>;
}

function MemoIcon({ memo }: { memo: MemoRow }) {
  const Icon = memo.kind === "checklist" ? ListBulletIcon : memo.kind === "ledger" ? WalletIcon : memo.kind === "secret" ? LockClosedIcon : DocumentTextIcon;
  return <Icon className="home-memo__icon" aria-hidden="true" />;
}
function HomeSection({ title, onOpen, actions, children }: { title: string; onOpen?: () => void; actions?: ReactNode; children: ReactNode }) {
  return <section className="home-section" aria-label={title}>
    <SectionLabel title={title} onOpen={onOpen} actions={actions} />
    <div className="home-section__body">{children}</div>
  </section>;
}

function HomeIndex({ memos, locked, overview, trashCount, privacyMode, connectionRows, onNavigate }: {
  memos: MemoRow[]; locked: boolean; overview: HomeOverview | null; trashCount: number; privacyMode: boolean;
  connectionRows: ConnectionRow[]; onNavigate: (view: AssetView) => void;
}) {
  return <nav className="home-index" aria-label="홈 인덱스">
    <section className="home-index__section" aria-label="메모">
      <SectionLabel title="메모" onOpen={() => onNavigate({ kind: "notes" })} />
      <div className="home-index__memo-stack">
        {memos.slice(0, 2).map((memo) => <button key={memo.id} type="button" className="home-memo-tile" onClick={() => onNavigate({ kind: "notes", noteId: memo.id })}>
          <span className="home-memo-tile__head"><MemoIcon memo={memo} /><b>{memo.title || "제목 없음"}</b>{memo.kind === "checklist" && <em className="numeric">{memo.done}/{memo.total}</em>}{memo.kind === "ledger" && <em>{memo.month}월</em>}</span>
          <MemoTileBody memo={memo} />
        </button>)}
        <button type="button" className="home-memo-add" onClick={() => onNavigate({ kind: "notes" })} aria-label={memos.length === 0 && locked ? "메모 잠금 해제" : "새 메모"}>
          ＋ {memos.length === 0 && locked ? "메모 잠금 해제" : "새 메모"}
        </button>
      </div>
    </section>

    <section className="home-index__section" aria-label="자산 현황">
      <SectionLabel title="자산 현황" />
      {overview && <div className="home-assets">
        <div className="home-assets__media">
          <button type="button" onClick={() => onNavigate({ kind: "statistics" })}><b className="numeric">{overview.assets.images.toLocaleString()}</b><small>이미지</small></button>
          <button type="button" onClick={() => onNavigate({ kind: "statistics" })}><b className="numeric">{overview.assets.videos.toLocaleString()}</b><small>영상</small></button>
        </div>
        <div className="home-assets__collections" style={{ gridTemplateColumns: `repeat(${privacyMode ? 3 : 4}, minmax(0, 1fr))` }}>
          {(["game", "manga", "movie"] as const).map((type) => <button key={type} type="button" onClick={() => onNavigate({ kind: "collections", typeFilter: type, showcase: false })}>
            <b className="numeric">{overview.collections[type].toLocaleString()}</b><small>{{ game: "게임", manga: "만화", movie: "영화" }[type]}</small>
          </button>)}
          {!privacyMode && <button type="button" onClick={() => onNavigate({ kind: "collections", typeFilter: "av", showcase: false })}>
            <b className="numeric">{overview.collections.av.toLocaleString()}</b><small>AV</small>
          </button>}
        </div>
        <div className="home-assets__foot">
          <button type="button" onClick={() => onNavigate({ kind: "classification", classificationId: null })}>오늘 <span className="numeric">+{overview.assets.today.toLocaleString()}</span></button>
          <button type="button" onClick={() => onNavigate({ kind: "classification", classificationId: null })}>이번 주 <span className="numeric">+{overview.assets.week.toLocaleString()}</span></button>
          {trashCount > 0 && <button type="button" onClick={() => onNavigate({ kind: "trash" })}>휴지통 <span className="numeric">{trashCount.toLocaleString()}</span></button>}
        </div>
      </div>}
    </section>

    <section className="home-index__section" aria-label="상태">
      <SectionLabel title="상태" />
      <div className="home-status">
        {connectionRows.map((row) => <button key={row.key} type="button" className="home-status__row" data-tone={row.tone} onClick={() => onNavigate(row.view)} aria-label={`${row.label} ${row.time ?? row.value}`}>
          <span className="home-status__dot" aria-hidden="true" /><span>{row.label}</span><span className="home-status__value">{row.time ?? row.value}</span>
        </button>)}
      </div>
    </section>
  </nav>;
}

function HomeContinue({ items, privacyMode, onOpen }: { items: ContinueItem[]; privacyMode: boolean; onOpen?: (item: ContinueItem) => void }) {
  return <HomeSection title="이어 보기">
    <div className="home-continue-grid">
      {items.map((item) => {
        const title = item.title?.trim() || "제목 없음";
        const progress = item.total > 0 ? Math.max(0, Math.min(100, (item.position / item.total) * 100)) : 0;
        const thumbnail = continueThumbnailUrl(item);
        const kind = item.kind === "video" ? "영상" : "망가";
        return <button key={`${item.kind}:${item.provider ?? "local"}:${item.id}`} type="button" className="home-continue-card" aria-label={`${title} 이어 보기`} onClick={() => onOpen?.(item)}>
          <span className="home-continue-card__cover">
            {!privacyMode && thumbnail && <img src={thumbnail} alt="" loading="lazy" decoding="async" draggable={false} onError={(event) => { event.currentTarget.style.display = "none"; }} />}
          </span>
          <span className="home-continue-card__progress" aria-hidden="true"><i style={{ width: `${progress}%` }} /></span>
          <span className="home-continue-card__title">{title}</span>
          <span className="home-continue-card__meta">
            <span>{kind}</span>
            {item.kind === "video" ? <span className="numeric">{formatPlaybackTime(item.position)} / {formatPlaybackTime(item.total)}</span> : <span className="numeric">{item.position}/{item.total}</span>}
          </span>
        </button>;
      })}
    </div>
  </HomeSection>;
}

function HomeSeries({ rows, privacyMode, onOpen, onOpenCollection }: { rows: ReturnType<typeof nextInSeriesRows>; privacyMode: boolean; onOpen: () => void; onOpenCollection: (collectionId: string) => void }) {
  return <HomeSection title="이어지는 시리즈" onOpen={onOpen}>
    <div className="home-series-grid">
      {rows.slice(0, 4).map((row) => {
        const title = row.work.name || "제목 없음";
        const thumbnail = collectionCoverUrl(row.work);
        return <button key={row.work.id} type="button" className="home-series-card" aria-label={`${title} 이어지는 시리즈`} onClick={() => onOpenCollection(row.work.id)}>
          <span className="home-series-card__pair">
            <span className="home-series-card__owned">
              {!privacyMode && thumbnail && <img src={thumbnail} alt="" loading="lazy" decoding="async" draggable={false} onError={(event) => { event.currentTarget.style.display = "none"; }} />}
              <span className="home-shelf__badge home-shelf__badge--volume"><Badge variant="scrim">{row.ownedCount}</Badge></span>
            </span>
            <span className="home-series-card__next"><b><span className="numeric">{row.nextVolume.number}</span><small>권</small></b><small>발매</small></span>
          </span>
          <span className="home-series-card__title">{title}</span>
          <span className="home-series-card__meta"><span><span className="numeric">{row.ownedCount}</span>권까지 소장</span>{row.nextVolume.date && <span>다음 <span className="numeric">{shortDate(row.nextVolume.date)}</span></span>}</span>
        </button>;
      })}
    </div>
  </HomeSection>;
}

function HomeFavoritePerformers({ performers, onOpen, onOpenPerformer }: { performers: AvFavoritePerformer[]; onOpen: () => void; onOpenPerformer: (id: string) => void }) {
  return <HomeSection title="즐겨찾는 배우" onOpen={onOpen}>
    <div className="home-av-favorites">
      {performers.map((performer) => <button key={performer.id} type="button" className="home-av-favorite" aria-label={`${performer.displayName} 배우 페이지`} onClick={() => onOpenPerformer(performer.id)}>
        <span className="home-av-favorite__portrait">
          <AvPortrait portrait={performer.portrait} name={performer.displayName} size={72} />
          {performer.recentOwnedCount > 0 && <span className="home-shelf__badge home-av-favorite__count"><Badge variant="scrim">{performer.recentOwnedCount}</Badge></span>}
        </span>
        <span className="home-av-favorite__name">{performer.displayName}</span>
      </button>)}
    </div>
  </HomeSection>;
}

function continueThumbnailUrl(item: ContinueItem): string | null {
  if (item.kind === "manga") return mangaCoverUrl(item.id);
  if (item.kind === "video") return thumbnailUrl(item.id, item.thumbnailRevision ?? undefined);
  if (!item.provider) return null;
  return nativeMediaUrl(`http://lakomics.localhost/remote-catalog-thumbnail/${encodeURIComponent(item.provider)}/${encodeURIComponent(item.id)}`);
}

function formatPlaybackTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function shortDate(value: string): string {
  const [, month, day] = value.split("-");
  return month && day ? `${Number(month)}.${Number(day)}` : value;
}

function MemoTileBody({ memo }: { memo: MemoRow }) {
  if (memo.kind === "checklist") return <ul className="home-memo-checklist">
    {memo.items.map((item, index) => <li key={index} data-checked={item.checked ? "true" : undefined}><span className="home-memo-checklist__mark" aria-hidden="true" /><span>{item.text}</span></li>)}
  </ul>;
  if (memo.kind === "ledger") return <>
    <span className="home-memo-amount numeric">{memo.amount.toLocaleString()}<small>원</small></span>
    <span className="home-memo-ledger-rows">
      {memo.available !== null && <span><span>쓴 돈</span><b className="numeric">{memo.spent.toLocaleString()}</b></span>}
      {memo.scheduled > 0 && <span><span>예정</span><b className="numeric">{memo.scheduled.toLocaleString()}</b></span>}
      {memo.perDay !== null && <span><span>하루</span><b className="numeric">{memo.perDay.toLocaleString()}</b></span>}
    </span>
  </>;
  if (memo.kind === "secret") return <span className="home-memo-secret">암호 메모</span>;
  return <span className="home-memo-text">{memo.snippet || "내용 없음"}</span>;
}

/** A few StashDB facts under the performer's name, from the profile the PC already cached (no fetch). */
function AvProfileBrief({ personId, today }: { personId: string; today: Date }) {
  const [profile, setProfile] = useState<AvPerformerProfile | null>(null);
  useEffect(() => {
    if (!native()) return;
    let live = true;
    setProfile(null);
    void avGateway.getPerformerProfile(personId).then((value) => { if (live) setProfile(value?.status === "matched" ? value : null); }, () => undefined);
    return () => { live = false; };
  }, [personId]);
  if (!profile) return null;
  const lines = avProfileLines(profile, today);
  if (!lines.length) return null;
  return <div className="home-av-performer__profile">{lines.map((line) => <span key={line}>{line}</span>)}</div>;
}
