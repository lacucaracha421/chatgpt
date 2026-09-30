import { BookOpenIcon, CheckCircleIcon, DocumentTextIcon, FilmIcon, FolderIcon, InboxIcon, ListBulletIcon, LockClosedIcon, Square2StackIcon, TagIcon, UserIcon, WalletIcon } from "@heroicons/react/24/outline";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAuthoritySyncHealth, useCloudSyncStatus } from "../app/useCloudProblems";
import { useWorkloadProfile } from "../app/workloadProfile";
import { igdbImagePreviewUrl, tmdbImagePreviewUrl, workArtworkThumbnailUrl } from "../assets/mediaUrl";
import { collectionCoverUrl } from "../collections/collectionCover";
import { PlatformBadges } from "../collections/PlatformBadges";
import { KIND_LABEL } from "../collections/collectionFormat";
import { useAvLinkPendingCount, type AvLinkApi } from "../collections/AvLinkInbox";
import { groupInbox, localDay } from "../collections/releaseCaption";
import { useReleaseData } from "../collections/releaseData";
import { ViewToolbar } from "../layout/ViewToolbar";
import { useLibrary } from "../library/LibraryContext";
import { ddayLabel } from "../shared/displayDate";
import type { AssetView, AvFavoritePerformer, ClassificationEntry, CollectionSummary, HomeOverview, ReleaseBoardEntry, ReleaseCalendar, ReleaseInboxItem, ReleaseWishlistItem } from "../library/types";
import { characterApi, type CharacterTarget } from "../characters/api";
import { TaggerReview } from "../characters/TaggerReview";
import { taggerDecisionApi, taggerReviewSource, type TaggerDecisionApi, type TaggerReviewItem, type TaggerReviewSource } from "../characters/taggerReviewClient";
import { notesStore, type NotesStore } from "../notes/store";
import { usePrivacy } from "../privacy/PrivacyContext";
import { AvPortrait } from "../collections/av/AvPortrait";
import { shadowReviewApi, type ShadowReviewApi, type ShadowReviewPendingTarget } from "../characters/shadowReviewApi";
import { localDateAndOffset, useArtistGateway, useArtistRead } from "../artists/artistStore";
import { useLocalDayClock } from "../shared/useLocalDayClock";
import { Skeleton } from "../shared/ui/Skeleton";
import { Button } from "../shared/ui/Button";
import { HomeReadState } from "./HomeReadState";
import { Badge } from "../shared/ui/Badge";
import { groupedNumber } from "../notes/ledger/model";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { ShelfScroller } from "../shared/ui/ShelfScroller";
import { avProfileLines, clockLabel, dateBlock, daysAfter, localBoundaries, memoRows, nextInSeriesRows, releaseRows, serverOutage, UPCOMING_DAYS, weekdayLabel, upcomingRows, type MemoRow, type NextInSeriesRow, type ReleaseRow, type UpcomingRow } from "./homeModel";
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
  const [shelfRetry, setShelfRetry] = useState(0);
  const [calendar, setCalendar] = useState<ReleaseCalendar | null>(null);
  useEffect(() => {
    if (!calendarApi) return;
    let live = true;
    void calendarApi.wishlist().then((items) => { if (live) { setWishlist(items ?? []); setWishlistReady(true); setWishlistError(false); } }, () => { if (live) setWishlistError(true); });
    void calendarApi.calendar().then((value) => { if (live) setCalendar(value ?? null); }, () => undefined);
    return () => { live = false; };
  }, [calendarApi, shelfRetry]);

  const [queueRead, setQueueRead] = useState(0);
  const [overview, setOverview] = useState<HomeOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(Boolean(gateway.getHomeOverview));
  const [overviewError, setOverviewError] = useState(false);
  const [avFavorites, setAvFavorites] = useState<AvFavoritePerformer[]>([]);
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
        avPerformer: value.failed.includes("avPerformer") ? previous.avPerformer : value.avPerformer,
      } : value);
      setOverviewError(false);
      setOverviewLoading(false);
    }, () => { if (live) { setOverviewError(true); setOverviewLoading(false); } });
    return () => { live = false; };
    // `now` is a test seam; only the local day, gateway and relevant changes repeat this read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, refreshVersion, trashCount, queueRead, today]);

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
  const retryOverview = () => setQueueRead(value => value + 1);
  const fieldFailed = (field: HomeOverview["failed"][number]) => overviewError || Boolean(overview?.failed.includes(field));
  const reviewUnknown = [
    {key: "character", label: "캐릭터", unknown: Boolean(shadowQueueApi) && !restricted && (characterQueue === null || characterError), failed: characterError},
    {key: "tagger", label: "태거", unknown: Boolean(gateway.getHomeOverview) && (!overview || fieldFailed("tagger")), failed: fieldFailed("tagger")},
    {key: "duplicates", label: "중복 판본", unknown: duplicateCount === null || duplicateError, failed: duplicateError},
    {key: "unsorted", label: "미분류", unknown: unsortedCount === null, failed: false},
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
    { key: "character", label: "캐릭터", count: characterQueue?.total ?? 0, Icon: UserIcon, open: () => setReviewOverview(true) },
    { key: "tagger", label: "태거", count: taggerQueueCounts?.total ?? 0, Icon: TagIcon, open: openTaggerReview },
    { key: "similar", label: "유사 이미지", count: reviewCount, unit: "쌍", Icon: Square2StackIcon, open: go({ kind: "similarity_review" }) },
    { key: "duplicates", label: "중복 판본", count: duplicateCount ?? 0, Icon: BookOpenIcon, open: () => setDialog({ kind: "duplicates" }) },
    { key: "unsorted", label: "미분류", count: unsortedCount ?? 0, Icon: FolderIcon, open: go({ kind: "unsorted" }) },
    { key: "av-link", label: "AV 품번", count: privacyMode ? 0 : avLinkCount ?? 0, Icon: FilmIcon, open: go({ kind: "collections", typeFilter: "av", showcase: false }) },
    { key: "pending", label: "처리 대기", count: overview?.server?.capturesPending ?? 0, Icon: InboxIcon, open: go({ kind: "settings", section: "connection" }) },
  ].filter((todo) => todo.count > 0);

  /* 발매 예정: released unread rows first, then the dated upcoming rows. */
  const releases = releaseRows(collections, board, inbox, wishlist, today);
  const upcomingAll = upcomingRows(collections, board, inbox, wishlist, today);
  const upcoming = upcomingAll.filter((row) => daysAfter(row.date, today) <= UPCOMING_DAYS);
  const seriesRows = useMemo(() => nextInSeriesRows<CollectionSummary, ReleaseInboxItem>(
    collections.filter((work) => work.type === "manga"),
    (work, editionIndex) => board.get(work.id)?.ownedVolumes.find((owned: ReleaseBoardEntry["ownedVolumes"][number]) => owned.editionIndex === editionIndex)?.count ?? null,
    (work) => {
      const entry = board.get(work.id);
      return entry?.releaseWatch.enabled ? entry.releaseSchedule.kakao : null;
    },
    [...inbox.values()].flat(),
    (event) => event.collectionId,
    today,
  ), [board, collections, inbox, today]);
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
    connectionRows={connectionRows} onNavigate={onNavigate} loading={overviewLoading} failed={overviewError} onRetry={retryOverview} />;
  const closeDialog = () => { setDialog(null); if (reviewOverview) setReviewRead((value) => value + 1); else setQueueRead((value) => value + 1); };
  const dialogs = dialog && <Suspense fallback={null}>
    {dialog.kind === "character"
      ? <ShadowReview onClose={closeDialog} onChanged={() => undefined} privacyMode={privacyMode} series={dialog.series} target={dialog.target} />
      : <CatalogReviewDialog onClose={closeDialog} onChange={() => undefined} />}
  </Suspense>;

  const artistRows = artistGateway && !artistTodayRead.error ? artistTodayRead.data : null;
  const calendarTarget = calendarApi ? calendarView() : releaseView;
  const shelfLoading = (Boolean(tracking) && !release.data && !release.error) || (!wishlistReady && !wishlistError);
  const shelfFailed = Boolean(release.error) || wishlistError;
  const retryShelf = () => { release.reload(); setShelfRetry(value => value + 1); };
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
            <HomeSection title="캘린더" onOpen={() => onNavigate(calendarTarget)} actions={shelfFailed && shelfRows.length > 0 ? <Button variant="quiet" onClick={retryShelf}>다시 시도</Button> : undefined}>
              <div className="home-shelf-frame" inert={(release.loading || shelfLoading || shelfFailed) && shelfRows.length > 0}>
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
                      <span className="home-shelf__platforms">{platforms.length > 0 && <PlatformBadges platforms={platforms} port={port} />}</span>
                    </button>;
                  })}
                </ShelfScroller>
                : <div className="home-shelf home-shelf--empty">
                  {shelfLoading ? <ShelfScroller>{Array.from({length: 3}, (_, index) => <span className="home-shelf__item" key={index}>
                    <Skeleton className="home-shelf__date" label="신간 정보" /><Skeleton className="home-shelf__art" label="신간 정보" /><Skeleton className="home-shelf__title" label="신간 정보" /><span className="home-shelf__platforms" />
                  </span>)}</ShelfScroller> : <HomeReadState failed={shelfFailed} empty="새 신간 없음" onRetry={retryShelf} />}
                </div>}
              </div>
            </HomeSection>
            <div className="home-grid__duo">
              <HomeSection title="다시 보기">
                <HomeRevisit gateway={gateway} localDate={localDate} privacyMode={privacyMode} onOpenAsset={onOpenAsset} />
              </HomeSection>
              <HomeSection title="작가" actions={<button type="button" className="home-header-action" onClick={() => setArtistSeed((value) => value + 1)}>다른 작가</button>} onOpen={() => onNavigate({ kind: "artists", section: "main" })}>
                <HomeArtist artist={artistRows?.[0] ?? null} privacyMode={privacyMode} onOpenAsset={onOpenAsset} onOpenArtist={(creatorKey) => onNavigate({ kind: "creator", creatorKey })} />
              </HomeSection>
            </div>
            {seriesRows.length > 0 && <HomeSeries rows={seriesRows} privacyMode={privacyMode} onOpen={() => onNavigate(releaseView)} onOpenCollection={(collectionId) => onNavigate({ kind: "collection", collectionId })} />}
          </div>
          <div className="home-grid__right">
            {!privacyMode && <HomeSection title="AV 배우" onOpen={() => onNavigate({ kind: "collections", typeFilter: "av", showcase: false })} actions={overview?.avPerformer && fieldFailed("avPerformer") ? <Button variant="quiet" onClick={retryOverview}>다시 시도</Button> : undefined}>
              <div className="home-av-performer" inert={Boolean(overview?.avPerformer) && (overviewLoading || fieldFailed("avPerformer"))}>
                {overview?.avPerformer ? <>
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
                </> : !overview && overviewLoading ? <><div className="home-av-performer__row"><Skeleton className="home-av-performer__portrait" label="AV 배우" /><Skeleton className="home-av-performer__identity" label="AV 배우" /></div><div className="home-av-performer__works">{Array.from({length: 3}, (_, index) => <Skeleton key={index} className="home-av-performer__jacket" label="AV 작품" />)}</div></> : <HomeReadState failed={fieldFailed("avPerformer")} onRetry={retryOverview} />}
              </div>
            </HomeSection>}
            <HomeSection title="검토">
              {(todos.length > 0 || reviewUnknown.length > 0)
                ? <div className="home-review-list">
                  {reviewUnknown.filter(row => !todos.some(todo => todo.key === row.key)).map(row => <div key={row.key} className="home-review-row" role="status" aria-label={`${row.label} 검토 수 ${row.failed ? "읽기 실패" : "세는 중"}`}>
                    <span>{row.label}</span>{row.failed ? <HomeReadState failed inline onRetry={retryOverview} /> : "settled" in row && row.settled ? <span className="home-review-row__count">—</span> : <Skeleton className="home-review-row__count" label={`${row.label} 검토 수`} />}
                  </div>)}
                  {todos.map(todo => {
                    const failed = reviewUnknown.some(row => row.key === todo.key && row.failed);
                    const body = <><todo.Icon className="home-review-row__icon" aria-hidden="true" /><span>{todo.label}</span><span className="home-review-row__count numeric">{todo.count.toLocaleString()}{todo.unit && <small>{todo.unit}</small>}</span></>;
                    return failed ? <div key={todo.key} className="home-review-row" role="status">{body}<Button variant="quiet" size="sm" onClick={retryOverview}>다시 시도</Button></div>
                      : <button key={todo.key} type="button" className="home-review-row" onClick={todo.open} disabled={overviewLoading && (todo.key === "tagger" || todo.key === "pending")}>{body}</button>;
                  })}
                </div>
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

function HomeIndex({ memos, locked, overview, trashCount, privacyMode, connectionRows, onNavigate, loading, failed, onRetry }: {
  memos: MemoRow[]; locked: boolean; overview: HomeOverview | null; trashCount: number; privacyMode: boolean;
  connectionRows: ConnectionRow[]; onNavigate: (view: AssetView) => void;
  loading: boolean; failed: boolean; onRetry(): void;
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
      <SectionLabel title="자산 현황" actions={overview && failed ? <Button variant="quiet" onClick={onRetry}>다시 시도</Button> : undefined} />
      <div className="home-assets" inert={Boolean(overview) && (loading || failed)}>
      {overview ? <>
        <div className="home-assets__media">
          <button type="button" onClick={() => onNavigate({ kind: "statistics" })}><b className="numeric">{overview.assets.images.toLocaleString()}</b><small>이미지</small></button>
          <button type="button" onClick={() => onNavigate({ kind: "statistics" })}><b className="numeric">{overview.assets.videos.toLocaleString()}</b><small>영상</small></button>
        </div>
        <div className="home-assets__collections" style={{ gridTemplateColumns: `repeat(${privacyMode ? 3 : 4}, minmax(0, 1fr))` }}>
          {(["game", "manga", "movie"] as const).map((type) => <button key={type} type="button" onClick={() => onNavigate({ kind: "collections", typeFilter: type, showcase: false })}>
            <b className="numeric">{overview.collections[type].toLocaleString()}</b><small>{KIND_LABEL[type]}</small>
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
      </> : failed ? <HomeReadState failed onRetry={onRetry} /> : <><div className="home-assets__media"><Skeleton label="이미지 수" /><Skeleton label="영상 수" /></div><div className="home-assets__collections" style={{ gridTemplateColumns: `repeat(${privacyMode ? 3 : 4}, minmax(0, 1fr))` }}>{Array.from({length: privacyMode ? 3 : 4}, (_, index) => <Skeleton key={index} label="작품 수" />)}</div><div className="home-assets__foot"><Skeleton label="오늘 수집 수" /></div></>}
      </div>
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

function HomeSeries({ rows, privacyMode, onOpen, onOpenCollection }: { rows: NextInSeriesRow<CollectionSummary>[]; privacyMode: boolean; onOpen: () => void; onOpenCollection: (collectionId: string) => void }) {
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

function shortDate(value: string): string {
  const [, month, day] = value.split("-");
  return month && day ? `${Number(month)}.${Number(day)}` : value;
}

function MemoTileBody({ memo }: { memo: MemoRow }) {
  if (memo.kind === "checklist") return <ul className="home-memo-checklist">
    {memo.items.map((item, index) => <li key={index} data-checked={item.checked ? "true" : undefined}><span className="home-memo-checklist__mark" aria-hidden="true" /><span>{item.text}</span></li>)}
  </ul>;
  if (memo.kind === "ledger") return <>
    <span className="home-memo-amount numeric">{groupedNumber(memo.amount)}<small>원</small></span>
    <span className="home-memo-ledger-rows">
      {memo.available !== null && <span><span>쓴 돈</span><b className="numeric">{groupedNumber(memo.spent)}</b></span>}
      {memo.scheduled > 0 && <span><span>예정</span><b className="numeric">{groupedNumber(memo.scheduled)}</b></span>}
      {memo.perDay !== null && <span><span>하루</span><b className="numeric">{groupedNumber(memo.perDay)}</b></span>}
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
