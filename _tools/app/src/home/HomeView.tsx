import { BookmarkIcon } from "@heroicons/react/24/solid";
import { CheckCircleIcon, ChevronRightIcon, DocumentTextIcon, ListBulletIcon, LockClosedIcon, SignalSlashIcon, WalletIcon } from "@heroicons/react/24/outline";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useAuthoritySyncHealth, useCloudSyncStatus } from "../app/useCloudProblems";
import { useWorkloadProfile } from "../app/workloadProfile";
import { igdbImagePreviewUrl, tmdbImagePreviewUrl, workArtworkThumbnailUrl } from "../assets/mediaUrl";
import { collectionCoverUrl } from "../collections/collectionCover";
import { PlatformBadges } from "../collections/PlatformBadges";
import { useAvLinkPendingCount, type AvLinkApi } from "../collections/AvLinkInbox";
import { groupInbox, localDay } from "../collections/releaseCaption";
import { useReleaseData } from "../collections/releaseData";
import { exchangeStore as defaultExchangeStore, useExchangeSnapshot, type ExchangeSnapshot, type ExchangeStore } from "../exchange/exchangeStore";
import { ViewToolbar } from "../layout/ViewToolbar";
import { useLibrary } from "../library/LibraryContext";
import type { AssetView, ClassificationEntry, CollectionSummary, HomeOverview, ReleaseCalendar, ReleaseWishlistItem } from "../library/types";
import { characterApi, type CharacterTarget } from "../characters/api";
import { TaggerReview } from "../characters/TaggerReview";
import { taggerDecisionApi, taggerReviewSource, type TaggerDecisionApi, type TaggerReviewItem, type TaggerReviewSource } from "../characters/taggerReviewClient";
import { notesStore, type NotesStore } from "../notes/store";
import { usePrivacy } from "../privacy/PrivacyContext";
import { AvPortrait } from "../collections/av/AvPortrait";
import { shadowReviewApi, type ShadowReviewApi, type ShadowReviewItem } from "../characters/shadowReviewApi";
import { localDateAndOffset, useArtistGateway, useArtistRead } from "../artists/artistStore";
import { displayDate } from "../shared/displayDate";
import { characterReviewGroups, clockLabel, dateBlock, daysAfter, localBoundaries, memoRows, receivedFrom, releaseRows, sendingSummary, serverOutage, tallyCandidates, UPCOMING_DAYS, weekdayLabel, upcomingRows, watchedMangaCount, type MemoRow, type ReleaseKind, type ReleaseRow, type UpcomingRow } from "./homeModel";
import { HomeRevisit } from "./HomeRevisit";
import { CharacterReviewOverview, type CharacterReviewScope } from "./CharacterReviewOverview";
import { shadowPageSource, type CharacterReviewSource } from "./characterReviewSource";
import "./home.css";

const ShadowReview = lazy(() => import("../characters/ShadowReview").then((module) => ({ default: module.ShadowReview })));
const CatalogReviewDialog = lazy(() => import("../manga/CatalogReviewDialog").then((module) => ({ default: module.CatalogReviewDialog })));

const native = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const KIND_LABEL: Record<ReleaseKind, string> = { manga: "만화", game: "게임", movie: "영화", anime: "애니" };
type KindFilter = "all" | ReleaseKind;
type Dialog = ({ kind: "character" } & CharacterReviewScope) | { kind: "duplicates" };
type HomeShelfRow = { source: "release"; row: ReleaseRow } | { source: "upcoming"; row: UpcomingRow };
/** Home reads one page of S36 candidates: the exact total (page summary) and a series hint. */
const CHARACTER_PAGE = 200;
type CharacterQueue = { total: number; items: Pick<ShadowReviewItem, "targetId" | "targetName" | "verdict">[] };

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
  exchange?: ExchangeStore;
  notes?: NotesStore;
  shadowApi?: Pick<ShadowReviewApi, "page">;
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
 * PC Home (HOME-DASH-001, layout B "priority ledger"): the index holds nearby state, while
 * the content keeps the release shelf and the image-first artist revisit list beside the queue.
 * Every row opens the PC screen that owns it. Reads happen when Home opens (and the asset
 * counts again after imports); live parts follow the stores the app already keeps (exchange,
 * notes, cloud progress, server-sync health, the 신간 cache). No polling.
 */
/** Covers on the 발매 예정 shelf; the rest are in the 발매 캘린더. */
const SHELF_MAX = 40;

export function HomeView({ collections, reviewCount, unsortedCount, trashCount, refreshVersion = 0, onNavigate, onQueuesRequested, exchange = defaultExchangeStore, notes, shadowApi, characterSource, taggerSource, taggerApi = taggerDecisionApi, characters = [], classifications = [], now = () => new Date(), avLinkApi, onOpenAsset }: HomeViewProps) {
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
  useEffect(() => {
    if (!gateway.getHomeOverview) return;
    let live = true;
    const { todayStart, weekStart } = localBoundaries(now());
    void gateway.getHomeOverview(todayStart, weekStart, localDay(now())).then((value) => { if (live) setOverview(value ?? null); }, () => undefined);
    return () => { live = false; };
    // `now` is a test seam; the read follows the gateway, imports and trash changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, refreshVersion, trashCount, queueRead]);

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
  // Lightweight mode skips the S36 candidate read (it scans the whole shadow list); the row
  // stays hidden until the mode ends, then the list is read once.
  const { restricted } = useWorkloadProfile();
  useEffect(() => {
    if (!shadowQueueApi || restricted) { setCharacterQueue(null); return; }
    let live = true;
    void shadowQueueApi.page({ offset: 0, limit: CHARACTER_PAGE }).then((page) => {
      if (!live || !page) return;
      const items = page.items ?? [];
      const total = page.summary ? page.summary.automatic.pending + page.summary.recommended.pending : 0;
      setCharacterQueue({ total: page.nextOffset === null ? Math.max(total, items.length) : total, items });
    }, () => undefined);
    return () => { live = false; };
  }, [shadowQueueApi, restricted, queueRead]);
  // The read takes seconds on a real library, so it restarts only when the set of series changes
  // (not on every render) or after a review closes; the last result stays visible meanwhile.
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

  const transfer = useExchangeSnapshot(exchange);
  const store = useMemo(() => notes ?? (root ? notesStore(root) : null), [notes, root]);
  const notesState = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.snapshot ?? emptyNotes);
  useEffect(() => { void store?.load(); }, [store]);
  const cloud = useCloudSyncStatus(gateway, root);
  const { health } = useAuthoritySyncHealth(gateway, root);
  const artistGateway = useArtistGateway();
  const [artistSeed, setArtistSeed] = useState(0);
  const { localDate, offsetMinutes } = localDateAndOffset(at);
  const artistTodayRead = useArtistRead((artist) => artist.today(localDate, offsetMinutes, artistSeed, []), `today:${localDate}:${artistSeed}:`);

  const outage = serverOutage(health, cloud.progress);
  const staleAt = outage ? clockLabel(outage.since ?? overview?.server.confirmedAt ?? at) : null;

  const go = (view: AssetView) => () => onNavigate(view);
  const releaseView: AssetView = { kind: "collections", typeFilter: "manga", showcase: false, releaseProvider: "kakao" };
  const calendarView = (type: "game" | "movie" = "game"): AssetView => ({ kind: "collections", typeFilter: type, showcase: false, releaseCalendar: true });

  /* 확인할 것; 캐릭터 검토 names its busiest series (from the first page) and opens the overview */
  const seriesNames = useMemo(() => new Map(classifications.map((entry) => [entry.id, entry.name])), [classifications]);
  const seriesName = useMemo(() => (id: string) => seriesNames.get(id), [seriesNames]);
  const characterHint = useMemo(() => {
    if (!characterQueue) return null;
    const groups = characterReviewGroups(tallyCandidates(characterQueue.items), characters, seriesName);
    const complete = characterQueue.items.length >= characterQueue.total;
    if (groups.length === 0) return null;
    if (complete && groups.length === 1 && groups[0].characters.length === 1) return `${groups[0].seriesName} › ${groups[0].characters[0].name}`;
    return groups.slice(0, 2).map((group) => group.seriesName).join(" · ") + (groups.length > 2 ? " 외" : "");
  }, [characterQueue, characters, seriesName]);
  const source = useMemo(() => characterSource ?? (shadowQueueApi ? shadowPageSource(shadowQueueApi) : null), [characterSource, shadowQueueApi]);
  const taggerQueueCounts = restricted ? null : overview?.tagger ?? null;
  const openTaggerReview = () => {
    if (!activeTaggerSource || restricted || taggerLoading) return;
    setTaggerLoading(true);
    void activeTaggerSource(() => undefined, () => true).then((items) => {
      if (!items) return;
      setTaggerItems(items);
      setTaggerOverview(true);
    }, (reason) => console.warn("tagger review read failed", reason)).finally(() => setTaggerLoading(false));
  };
  const todos = [
    { key: "pending", label: "처리 대기", unit: "건", note: staleAt ? `${staleAt} 기준 · 태블릿 수집 요청` : "태블릿 수집 요청 · 아직 안 받음", count: overview?.server.capturesPending ?? 0, open: go({ kind: "settings", section: "cloud" }) },
    { key: "character", label: "캐릭터 검토", unit: "건", note: characterHint ?? "자동 분류 후보 확인", count: characterQueue?.total ?? 0,
      open: () => setReviewOverview(true) },
    { key: "tagger", label: "태거 검토", unit: "건", note: taggerLoading ? "목록 불러오는 중" : taggerQueueCounts ? `태거 추천 ${taggerQueueCounts.recommendation.toLocaleString()} · 검토로 돌림 ${taggerQueueCounts.veto.toLocaleString()}` : null,
      count: taggerQueueCounts?.total ?? 0, open: openTaggerReview },
    { key: "similar", label: "유사 이미지", unit: "쌍", note: "같은 그림일 수 있음", count: reviewCount, open: go({ kind: "similarity_review" }) },
    { key: "duplicates", label: "중복 판본", unit: "건", note: "카탈로그 · 같은 작품", count: duplicateCount, open: () => setDialog({ kind: "duplicates" }) },
    { key: "unsorted", label: "미분류", unit: "장", note: "분류가 없는 새 자산", count: unsortedCount ?? 0, open: go({ kind: "unsorted" }) },
    { key: "av-link", label: "AV 품번", unit: "건", note: null, count: avLinkCount, open: go({ kind: "collections", typeFilter: "av", showcase: false }) },
  ].filter((todo) => todo.count > 0);

  /* 발매 예정: released unread rows first, then the dated upcoming rows. */
  const releases = releaseRows(collections, board, inbox, wishlist, today);
  const upcomingAll = upcomingRows(collections, board, inbox, wishlist, today);
  const upcoming = upcomingAll.filter((row) => daysAfter(row.date, today) <= UPCOMING_DAYS);
  const nextLater = upcomingAll.find((row) => daysAfter(row.date, today) > UPCOMING_DAYS) ?? null;
  const [kind, setKind] = useState<KindFilter>("all");
  const shelfAll: HomeShelfRow[] = [...releases.map((row) => ({ source: "release" as const, row })), ...upcoming.map((row) => ({ source: "upcoming" as const, row }))];
  const shelfRows = shelfAll.filter(({ row }) => kind === "all" || row.kind === kind);
  const openRelease = (row: ReleaseRow) => row.collection ? onNavigate({ kind: "collection", collectionId: row.collection.id }) : onNavigate(calendarView(row.kind === "movie" ? "movie" : "game"));
  const openUpcoming = (row: UpcomingRow) => row.collectionId ? onNavigate({ kind: "collection", collectionId: row.collectionId }) : onNavigate(calendarView(row.kind === "movie" ? "movie" : "game"));

  /* 전송 */
  const sending = sendingSummary(transfer);
  const transferOffline = transfer.availability.state === "offline";
  const from = receivedFrom(transfer);

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

  const index = <HomeIndex memos={memos} locked={Boolean(notesState.keyringLocked)} transfer={transfer} sending={sending} transferOffline={transferOffline} outage={outage} from={from}
    overview={overview} trashCount={trashCount} privacyMode={privacyMode} onNavigate={onNavigate} />;
  const closeDialog = () => { setDialog(null); if (reviewOverview) setReviewRead((value) => value + 1); else setQueueRead((value) => value + 1); };
  const dialogs = dialog && <Suspense fallback={null}>
    {dialog.kind === "character"
      ? <ShadowReview onClose={closeDialog} onChanged={() => undefined} privacyMode={privacyMode} series={dialog.series} target={dialog.target} />
      : <CatalogReviewDialog onClose={closeDialog} onChange={() => undefined} />}
  </Suspense>;

  const artistRows = artistGateway && !artistTodayRead.error ? artistTodayRead.data : null;
  const watched = watchedMangaCount(board);
  const shelfCalm = shelfAll.length ? undefined : <span>새 신간 없음{watched > 0 && <> · 만화 <b className="numeric">{watched}</b>편 지켜보는 중</>}{nextLater && <> · 다음 <b className="numeric">{dateBlock(nextLater.date, today).day}</b> {nextLater.name}</>}</span>;
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
      <div className="home-ledger">
        {outage && <div className="home-offline" role="status">
          <SignalSlashIcon aria-hidden="true" />
          <span><b>서버에 닿지 않음</b>{outage.since && <><span className="numeric">{clockLabel(outage.since)}</span>부터 — </>}이 PC의 라이브러리 · 검토 · 메모는 그대로입니다. 전송과 처리 대기만 마지막 값입니다.</span>
        </div>}

        <div className="home-columns">
          <div className="home-lane">
            <Section title="발매 예정"
              actions={<>
                <div className="home-chips" role="radiogroup" aria-label="종류">
                  {(["all", "manga", "game", "movie", "anime"] as const).map((value) => {
                    const count = value === "all" ? shelfAll.length : shelfAll.filter(({ row }) => row.kind === value).length;
                    return <button key={value} type="button" role="radio" aria-checked={kind === value} className="home-chip" onClick={() => setKind(value)}>
                      {value === "all" ? "전체" : KIND_LABEL[value]} <span className="numeric">{count}</span></button>;
                  })}
                </div>
                <button type="button" className="home-header-action" onClick={go(calendarTarget)}>발매 캘린더 <Chevron /></button>
              </>}
              calm={shelfCalm}>
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
                    return <button key={`${item.source}:${row.key}`} type="button" className="home-shelf__item" onClick={() => release ? openRelease(release) : openUpcoming(upcomingRow!)}
                      aria-label={`${row.name} ${released ? "발매됨" : `${block.day} ${upcomingRow!.detail}`}`}>
                      <span className="home-shelf__date">
                        {released && !row.date ? <span>새 권</span> : <span className="numeric">{block.day}</span>}
                        {released ? row.date && <span>나옴</span> : <><span>{block.weekday.slice(0, 1)}</span><span className="home-shelf__days numeric">D-{left}</span></>}
                      </span>
                      <span className={`home-shelf__art${!url ? " home-cover--title" : ""}`} aria-hidden="true">
                        {url && <img src={url} alt="" loading="lazy" decoding="async" draggable={false} />}
                        {released && <span className="home-shelf__new">NEW</span>}
                        {row.watch && <span className="home-shelf__watch" title="관심 목록"><BookmarkIcon aria-hidden="true" /></span>}
                        {volume !== null && <span className="home-shelf__volume numeric">{volume}</span>}
                      </span>
                      <span className="home-shelf__title">{row.name}</span>
                      {upcomingRow?.platforms?.length
                        ? <span className="home-shelf__detail home-shelf__detail--badges"><PlatformBadges platforms={upcomingRow.platforms} port={calendarPorts.has(upcomingRow.key.replace(/^title:/, ""))} />{upcomingRow.moved && <span className="home-shelf__moved">날짜 바뀜</span>}</span>
                        : <span className="home-shelf__detail"><span className="home-kind">{KIND_LABEL[row.kind]}</span>{released ? release?.caption.text : upcomingRow?.detail}</span>}
                    </button>;
                  })}
                </ShelfScroller>
                : <div className="home-shelf home-shelf--empty">
                  {/* An invisible tile keeps the shelf's height, so switching kinds never moves the sections below. */}
                  <div className="home-shelf__track" aria-hidden="true"><span className="home-shelf__item home-shelf__ghost">
                    <span className="home-shelf__date" /><span className="home-shelf__art" /><span className="home-shelf__title">&nbsp;</span><span className="home-shelf__detail">&nbsp;</span>
                  </span></div>
                  <p className="home-shelf__empty">이 종류의 발매 항목 없음</p>
                </div>}
            </Section>
            <Section title="다시 보기"
              actions={<>
                <button type="button" className="home-header-action" onClick={() => setArtistSeed((value) => value + 1)}>다른 작가</button>
                <button type="button" className="home-header-action" onClick={go({ kind: "artists", section: "main" })}>작가 전체 <Chevron /></button>
              </>}>
              <HomeRevisit gateway={gateway} localDate={localDate} artist={artistRows?.[0] ?? null} privacyMode={privacyMode}
                onOpenAsset={onOpenAsset} onOpenArtist={(creatorKey) => onNavigate({ kind: "creator", creatorKey })} />
            </Section>
          </div>
          <div className="home-lane home-lane--side">
            <Section title="검토"
              calm={todos.length ? undefined : <Ok>모두 확인함</Ok>}>
              {todos.length > 0 && <div className="home-queue-list">
                {todos.map((todo) => <button key={todo.key} type="button" className="home-row home-row--todo" onClick={todo.open}>
                  <span className="home-row__n numeric">{todo.count.toLocaleString()}<small>{todo.unit}</small></span>
                  <span className="home-row__t">{todo.label}{todo.note && <small>{todo.note}</small>}</span><Chevron />
                </button>)}
              </div>}
            </Section>
            {!privacyMode && overview?.avPerformer && <Section title="오늘의 AV 배우"
              actions={<button type="button" className="home-header-action" onClick={go({ kind: "collections", typeFilter: "av", showcase: false })}>AV <Chevron /></button>}>
              <div className="home-av-performer">
                <span className="home-av-performer__portrait">
                  {overview.avPerformer.portrait ? <AvPortrait portrait={overview.avPerformer.portrait} name={overview.avPerformer.displayName} size="home" /> : overview.avPerformer.latestWork.frontArtworkId && <img src={workArtworkThumbnailUrl(overview.avPerformer.latestWork.frontArtworkId)} alt="" loading="lazy" decoding="async" />}
                </span>
                <div className="home-av-performer__identity">
                  <b>{overview.avPerformer.displayName}</b>
                  {overview.avPerformer.originalName && <small>{overview.avPerformer.originalName}</small>}
                  <div className="home-av-performer__facts">
                    <span><strong className="numeric">{overview.avPerformer.knownWorks.toLocaleString()}</strong>출연작</span>
                    <span><strong className="numeric">{overview.avPerformer.ownedWorks.toLocaleString()}</strong>소장</span>
                  </div>
                  <div className="home-av-performer__latest">
                    <small>최근작{overview.avPerformer.latestWork.releaseDate && <> · <span className="numeric">{displayDate(overview.avPerformer.latestWork.releaseDate, at)}</span></>}</small>
                    <b>{overview.avPerformer.latestWork.title}</b>
                    {overview.avPerformer.latestWork.productCode && <span>{overview.avPerformer.latestWork.productCode}</span>}
                  </div>
                </div>
                <div className="home-av-performer__works">
                  <span>소장 최근 <span className="numeric">{overview.avPerformer.recentOwnedWorks.length}</span>편</span>
                  <div>
                    {overview.avPerformer.recentOwnedWorks.map((work) => <span key={work.collectionId} className="home-av-performer__jacket">
                      {work.frontArtworkId && <img src={workArtworkThumbnailUrl(work.frontArtworkId)} alt={`${work.title} 앞표지`} loading="lazy" decoding="async" />}
                    </span>)}
                  </div>
                </div>
              </div>
            </Section>}
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

function Chevron() { return <ChevronRightIcon className="home-chevron" aria-hidden="true" />; }
function Ok({ children }: { children: ReactNode }) { return <><CheckCircleIcon className="home-ok" aria-hidden="true" /><span>{children}</span></>; }
function Progress({ value }: { value: number }) {
  return <span className="home-progress" aria-hidden="true"><i style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} /></span>;
}
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
    if (!state.moved) { state.moved = true; setDragging(true); node.setPointerCapture(event.pointerId); }
    const dt = Math.max(1, event.timeStamp - state.lastT);
    state.velocity = 0.8 * ((event.clientX - state.lastX) / dt) + 0.2 * state.velocity;
    state.lastX = event.clientX; state.lastT = event.timeStamp;
    node.scrollLeft = state.left - dx;
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const node = track.current;
    const state = drag.current;
    if (node?.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
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

/**
 * One ledger section: a square-marked heading line, then rows between 1px rules. A section
 * with nothing to do collapses to its heading plus one calm line.
 */
function Section({ title, hint, summary, calm, stale, alert = false, onOpen, actions, children }: {
  title: string; hint?: string; summary?: ReactNode; calm?: ReactNode; stale?: string | null; alert?: boolean; onOpen?: () => void; actions?: ReactNode; children?: ReactNode;
}) {
  const open = !calm;
  const head = <>
    <h2 className="home-section__title">{title}</h2>
    {hint && <span className="home-section__hint">· {hint}</span>}
    {summary}
    {calm && <span className="home-section__calm">{calm}</span>}
    <span className="home-section__space" />
    {actions && <div className="home-section__actions">{actions}</div>}
    {stale && <span className="home-stale"><span className="numeric">{stale}</span> 기준</span>}
    {onOpen && <Chevron />}
  </>;
  return <section className="home-section" data-open={open ? "true" : undefined} data-alert={alert ? "true" : undefined} aria-label={title}>
    {onOpen
      ? <button type="button" className="home-section__head" onClick={onOpen} aria-label={`${title} 열기`}>{head}</button>
      : <div className="home-section__head">{head}</div>}
    {open && children && <div className="home-section__body">{children}</div>}
  </section>;
}

function MemoIcon({ memo }: { memo: MemoRow }) {
  const Icon = memo.kind === "checklist" ? ListBulletIcon : memo.kind === "ledger" ? WalletIcon : memo.kind === "secret" ? LockClosedIcon : DocumentTextIcon;
  return <Icon className="home-memo__icon" aria-hidden="true" />;
}
/** The index while Home is open: asset totals, pinned notes as tiles, then transfers (연결 lives in 상태). */
function HomeIndex({ memos, locked, transfer, sending, transferOffline, outage, from, overview, trashCount, privacyMode, onNavigate }: {
  memos: MemoRow[]; locked: boolean;
  transfer: ExchangeSnapshot; sending: ReturnType<typeof sendingSummary>; transferOffline: boolean; outage: { since: string | null } | null;
  from: string | null; overview: HomeOverview | null; trashCount: number; privacyMode: boolean; onNavigate: (view: AssetView) => void;
}) {
  const openExchange = () => onNavigate({ kind: "exchange" });
  const paused = transferOffline || Boolean(outage);
  return <nav className="home-index" aria-label="홈 인덱스">
    <IndexLabel title="자산 현황" />
    {overview && <div className="home-index__stats">
      <div className="home-index__stat-media">
        <button type="button" onClick={() => onNavigate({ kind: "statistics" })}><b className="numeric">{overview.assets.images.toLocaleString()}</b><small>이미지</small></button>
        <button type="button" onClick={() => onNavigate({ kind: "statistics" })}><b className="numeric">{overview.assets.videos.toLocaleString()}</b><small>영상</small></button>
      </div>
      <div className="home-index__stat-collections" style={{ gridTemplateColumns: `repeat(${privacyMode ? 3 : 4}, minmax(0, 1fr))` }}>
        {(["game", "manga", "movie"] as const).map((type) => <button key={type} type="button" onClick={() => onNavigate({ kind: "collections", typeFilter: type, showcase: false })}>
          <b className="numeric">{overview.collections[type].toLocaleString()}</b><small>{{ game: "게임", manga: "만화", movie: "영화" }[type]}</small>
        </button>)}
        {!privacyMode && <button type="button" onClick={() => onNavigate({ kind: "collections", typeFilter: "av", showcase: false })}>
          <b className="numeric">{overview.collections.av.toLocaleString()}</b><small>AV</small>
        </button>}
      </div>
      <div className="home-index__stats-foot">
        <button type="button" onClick={() => onNavigate({ kind: "classification", classificationId: null })}>오늘 <span className="numeric">+{overview.assets.today.toLocaleString()}</span></button>
        <button type="button" onClick={() => onNavigate({ kind: "classification", classificationId: null })}>이번 주 <span className="numeric">+{overview.assets.week.toLocaleString()}</span></button>
        {trashCount > 0 && <button type="button" onClick={() => onNavigate({ kind: "trash" })}>휴지통 <span className="numeric">{trashCount.toLocaleString()}</span></button>}
      </div>
    </div>}

    <IndexLabel title="메모" count={memos.length} />
    <div className="home-index__memo-grid">
      {memos.map((memo) => <button key={memo.id} type="button" className={`home-memo-tile home-memo-tile--${memo.kind}`} onClick={() => onNavigate({ kind: "notes", noteId: memo.id })}
        style={memo.color ? { borderTopColor: memo.color } : undefined}>
        <span className="home-memo-tile__head"><MemoIcon memo={memo} /><b>{memo.title || "제목 없음"}</b></span>
        <MemoTileBody memo={memo} />
      </button>)}
      <button type="button" className="home-memo-tile home-memo-tile--new" onClick={() => onNavigate({ kind: "notes" })} aria-label="새 메모">
        <span aria-hidden="true">＋</span><small>{memos.length === 0 && locked ? "메모 잠금 해제" : "새 메모"}</small>
      </button>
    </div>

    <IndexLabel title="전송" />
    <div className="home-index__transfer-grid">
      <button type="button" className="home-transfer-tile" onClick={openExchange} aria-label={`받은 파일 ${transfer.unseen}개`}>
        <small>받은 파일</small>
        <b className="numeric">{transfer.unseen}<span>개</span></b>
        <em>{transfer.unseen > 0 ? `${from ? `${from}에서 · ` : ""}아직 안 봄` : "새 파일 없음"}</em>
      </button>
      <button type="button" className="home-transfer-tile" onClick={openExchange} aria-label={sending ? `${paused ? "보내기 멈춤" : "보내는 중"} ${sending.name}` : "보낼 파일 없음"}>
        <small>{sending && paused ? "보내기 멈춤" : "보내는 중"}</small>
        <b className="numeric">{sending ? paused ? <>{sending.more + 1}<span>개</span></> : sending.progress === null ? "…" : <>{Math.round(sending.progress * 100)}<span>%</span></> : "—"}</b>
        <em>{sending ? paused ? "연결되면 이어서 보냄" : `${sending.name}${sending.more > 0 ? ` 외 ${sending.more}` : ""}` : "보낼 파일 없음"}</em>
      </button>
    </div>
  </nav>;
}

function MemoTileBody({ memo }: { memo: MemoRow }) {
  if (memo.kind === "checklist") return <span className="home-memo-tile__body">
    <b className="numeric">{memo.done}<span>/{memo.total}</span></b><small>완료</small>{memo.total > 0 && <Progress value={memo.done / memo.total} />}
  </span>;
  if (memo.kind === "ledger") return <span className="home-memo-tile__body"><small>{memo.month}월 {memo.label}</small><b className="numeric">{memo.amount.toLocaleString()}<span>원</span></b></span>;
  if (memo.kind === "secret") return <span className="home-memo-tile__body"><small>암호 메모</small></span>;
  return <span className="home-memo-tile__body home-memo-tile__snippet">{memo.snippet || "내용 없음"}</span>;
}

function IndexLabel({ title, count }: { title: string; count?: number }) {
  return <h2 className="home-index__label">{title}{count !== undefined && <span className="numeric">{count}</span>}</h2>;
}
