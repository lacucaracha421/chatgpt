import { CheckCircleIcon, ChevronRightIcon, DocumentTextIcon, ListBulletIcon, LockClosedIcon, SignalSlashIcon, WalletIcon } from "@heroicons/react/24/outline";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAuthoritySyncHealth, useCloudSyncStatus } from "../app/useCloudProblems";
import { useWorkloadProfile } from "../app/workloadProfile";
import { igdbImagePreviewUrl, tmdbImagePreviewUrl, workArtworkThumbnailUrl } from "../assets/mediaUrl";
import { collectionCoverUrl } from "../collections/collectionCover";
import { useAvLinkPendingCount, type AvLinkApi } from "../collections/AvLinkInbox";
import { groupInbox, localDay } from "../collections/releaseCaption";
import { useReleaseData } from "../collections/releaseData";
import { exchangeStore as defaultExchangeStore, useExchangeSnapshot, type ExchangeSnapshot, type ExchangeStore } from "../exchange/exchangeStore";
import { ViewToolbar } from "../layout/ViewToolbar";
import { useLibrary } from "../library/LibraryContext";
import type { AssetView, CatalogStatus, ClassificationEntry, CollectionSummary, HomeOverview, ReleaseCalendar, ReleaseWishlistItem } from "../library/types";
import { characterApi, type CharacterTarget } from "../characters/api";
import { TaggerReview } from "../characters/TaggerReview";
import { taggerDecisionApi, taggerReviewSource, type TaggerDecisionApi, type TaggerReviewItem, type TaggerReviewSource } from "../characters/taggerReviewClient";
import { notesStore, type NotesStore } from "../notes/store";
import { usePrivacy } from "../privacy/PrivacyContext";
import { shadowReviewApi, type ShadowReviewApi, type ShadowReviewItem } from "../characters/shadowReviewApi";
import { ArtistThumb, ThumbStrip } from "../artists/ArtistHub";
import { localDateAndOffset, useArtistGateway, useArtistRead } from "../artists/artistStore";
import { displayDate } from "../shared/displayDate";
import { agoLabel, characterReviewGroups, clockLabel, cloudLine, dateBlock, daysAfter, localBoundaries, memoRows, receivedFrom, releaseRows, sendingSummary, serverOutage, tallyCandidates, UPCOMING_DAYS, weekdayLabel, upcomingRows, watchedMangaCount, type MemoRow, type ReleaseKind, type ReleaseRow, type UpcomingRow } from "./homeModel";
import { CharacterReviewOverview, type CharacterReviewScope } from "./CharacterReviewOverview";
import { shadowPageSource, type CharacterReviewSource } from "./characterReviewSource";
import "./home.css";

const ShadowReview = lazy(() => import("../characters/ShadowReview").then((module) => ({ default: module.ShadowReview })));
const CatalogReviewDialog = lazy(() => import("../manga/CatalogReviewDialog").then((module) => ({ default: module.CatalogReviewDialog })));

const native = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const KIND_LABEL: Record<ReleaseKind, string> = { manga: "만화", game: "게임", movie: "영화" };
type KindFilter = "all" | ReleaseKind;
type Tone = "ok" | "busy" | "idle" | "off";
type Connection = { key: string; label: string; value: string; time?: string; tone: Tone; view: AssetView };
type Dialog = ({ kind: "character" } & CharacterReviewScope) | { kind: "duplicates" };
type HomeShelfRow = { source: "release"; row: ReleaseRow } | { source: "upcoming"; row: UpcomingRow };
/** Home reads one page of S36 candidates: the exact total (page summary) and a series hint. */
const CHARACTER_PAGE = 200;
type CharacterQueue = { total: number; items: Pick<ShadowReviewItem, "targetId" | "targetName" | "verdict">[] };

export type HomeViewProps = {
  collections: CollectionSummary[];
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
export function HomeView({ collections, reviewCount, unsortedCount, trashCount, refreshVersion = 0, onNavigate, onQueuesRequested, exchange = defaultExchangeStore, notes, shadowApi, characterSource, taggerSource, taggerApi = taggerDecisionApi, characters = [], classifications = [], now = () => new Date(), avLinkApi }: HomeViewProps) {
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

  const [catalog, setCatalog] = useState<CatalogStatus | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => gateway.getOnlineCatalogStatus()).then((value) => { if (live) setCatalog(value ?? null); }, () => undefined);
    return () => { live = false; };
  }, [gateway]);

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

  /* 연결 */
  const connections: Connection[] = [];
  if (overview?.server.configured) {
    connections.push(outage
      ? { key: "server", label: "서버", value: "연결 안 됨", time: outage.since ? `${clockLabel(outage.since)}부터` : undefined, tone: "off", view: { kind: "settings", section: "cloud" } }
      : { key: "server", label: "서버", value: "연결됨", time: overview.server.confirmedAt && !overview.server.live ? agoLabel(overview.server.confirmedAt, at) : undefined, tone: "ok", view: { kind: "settings", section: "cloud" } });
  }
  if (transfer.availability.state !== "unavailable") {
    const peer = transfer.devices[0]?.name ?? "연결된 기기 없음";
    const tone: Tone = transfer.availability.state === "ready" ? "ok" : transfer.availability.state === "starting" ? "busy" : outage ? "idle" : "off";
    connections.push({ key: "tablet", label: "태블릿", value: peer, time: transfer.availability.state === "offline" ? "연결 안 됨" : undefined, tone, view: { kind: "exchange" } });
  }
  const cloudState = cloudLine(cloud.progress, cloud.problemCount);
  if (cloudState) connections.push({ key: "cloud", label: "클라우드", value: cloudState.text, tone: outage && cloudState.tone !== "ok" ? "idle" : cloudState.tone, view: { kind: "settings", section: "cloud" } });
  if (catalog?.installed) {
    const time = catalog.lastSuccessAt ? agoLabel(catalog.lastSuccessAt, at) : undefined;
    connections.push(catalog.lastError
      ? { key: "catalog", label: "카탈로그", value: "갱신 실패", time, tone: "off", view: { kind: "settings", section: "catalog" } }
      : { key: "catalog", label: "카탈로그", value: "갱신 완료", time, tone: "ok", view: { kind: "settings", section: "catalog" } });
  }
  if (calendar) {
    const fetched = calendar.sources.map((source) => source.fetchedAt).filter((value): value is string => Boolean(value)).sort().reverse()[0];
    const failed = calendar.sources.some((source) => source.errorCode);
    connections.push({ key: "calendar", label: "발매 캘린더", value: failed ? "가져올 수 없음" : calendar.sources.map((source) => source.provider.toUpperCase()).join(" · ") || "IGDB · TMDB",
      time: fetched ? (failed ? `${clockLabel(fetched)} 기준` : agoLabel(fetched, at)) : undefined, tone: failed ? "off" : "ok", view: calendarView() });
  }
  const troubled = connections.some((row) => row.tone === "off");
  const busyConnections = connections.filter((row) => row.tone === "busy");

  const cover = (row: ReleaseRow | UpcomingRow) => {
    if (privacyMode) return null;
    const collection = "collection" in row ? (row as ReleaseRow).collection : "collectionId" in row ? (row as UpcomingRow).collectionId ? collections.find((item) => item.id === (row as UpcomingRow).collectionId) : undefined : undefined;
    if (collection) return collectionCoverUrl(collection);
    const title = "title" in row ? row.title : wishlist.find((item) => item.id === row.key.replace(/^title:/, ""));
    if (!title?.cover) return null;
    return title.provider === "igdb" ? igdbImagePreviewUrl(title.cover, "cover") : tmdbImagePreviewUrl(title.cover, "poster");
  };

  const index = <HomeIndex memos={memos} locked={Boolean(notesState.keyringLocked)} connections={connections} busyConnections={busyConnections}
    troubled={troubled} transfer={transfer} sending={sending} transferOffline={transferOffline} outage={outage} from={from}
    overview={overview} trashCount={trashCount} privacyMode={privacyMode} onNavigate={onNavigate} />;
  const closeDialog = () => { setDialog(null); if (reviewOverview) setReviewRead((value) => value + 1); else setQueueRead((value) => value + 1); };
  const dialogs = dialog && <Suspense fallback={null}>
    {dialog.kind === "character"
      ? <ShadowReview onClose={closeDialog} onChanged={() => undefined} privacyMode={privacyMode} series={dialog.series} target={dialog.target} />
      : <CatalogReviewDialog onClose={closeDialog} onChange={() => undefined} />}
  </Suspense>;

  const artistRows = artistGateway && !artistTodayRead.error ? artistTodayRead.data : null;
  const [, artistMonth, artistDay] = localDate.split("-");
  const watched = watchedMangaCount(board);
  const shelfCalm = shelfAll.length ? undefined : <span>새 신간 없음{watched > 0 && <> · 만화 <b className="numeric">{watched}</b>편 지켜보는 중</>}{nextLater && <> · 다음 <b className="numeric">{dateBlock(nextLater.date, today).day}</b> {nextLater.name}</>}</span>;
  const calendarTarget = calendarApi ? calendarView() : releaseView;

  if (reviewOverview && source) return <>
    <CharacterReviewOverview source={source} targets={characters} seriesName={seriesName} version={reviewRead} restricted={restricted} privacyMode={privacyMode}
      onBack={() => { setReviewOverview(false); setQueueRead((value) => value + 1); }} onOpen={(scope) => setDialog({ kind: "character", ...scope })} />
    {dialogs}
  </>;

  if (taggerOverview && taggerItems) return <TaggerReview items={taggerItems} targets={characters} classifications={classifications} privacyMode={privacyMode}
    api={taggerApi} onItemsChange={setTaggerItems} onBack={() => { setTaggerOverview(false); setQueueRead((value) => value + 1); }} />;

  return <div className="home-view">
    <ViewToolbar title="홈" titleAccessory={<span className="home-title-date"><span className="numeric">{`${at.getMonth() + 1}.${at.getDate()}`}</span> {weekdayLabel(at)}</span>} chrome={{ navigation: index }} />
    <div className="home-scroll">
      <div className="home-ledger">
        {outage && <div className="home-offline" role="status">
          <SignalSlashIcon aria-hidden="true" />
          <span><b>서버에 닿지 않음</b>{outage.since && <><span className="numeric">{clockLabel(outage.since)}</span>부터 — </>}이 PC의 라이브러리 · 확인할 것 · 메모는 그대로입니다. 전송과 처리 대기만 마지막 값입니다.</span>
        </div>}

        <div className="home-columns">
          <div className="home-lane">
            <Section title="발매 예정"
              summary={<span className="home-release-summary">새 권 <span className="numeric">{releases.length}</span> · {UPCOMING_DAYS}일 안 <span className="numeric">{upcoming.length}</span> · 관심 <span className="numeric">{wishlist.filter((item) => !item.muted).length}</span></span>}
              actions={<>
                <div className="home-chips" role="radiogroup" aria-label="종류">
                  {(["all", "manga", "game", "movie"] as const).map((value) => {
                    const count = value === "all" ? shelfAll.length : shelfAll.filter(({ row }) => row.kind === value).length;
                    return <button key={value} type="button" role="radio" aria-checked={kind === value} className="home-chip" onClick={() => setKind(value)}>
                      {value === "all" ? "전체" : KIND_LABEL[value]} <span className="numeric">{count}</span></button>;
                  })}
                </div>
                <button type="button" className="home-header-action" onClick={go(calendarTarget)}>발매 캘린더 <Chevron /></button>
              </>}
              calm={shelfCalm}>
              {shelfRows.length > 0
                ? <div className="home-shelf">
                  {shelfRows.slice(0, 4).map((item) => {
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
                      <span className={`home-shelf__art${row.kind === "game" ? " home-shelf__art--game" : ""}${!url ? " home-cover--title" : ""}`} aria-hidden="true">
                        {url && <img src={url} alt="" loading="lazy" decoding="async" />}
                        {released && <span className="home-shelf__new">NEW</span>}
                        {row.watch && <span className="home-shelf__watch">관심</span>}
                        {volume !== null && <span className="home-shelf__volume numeric">{volume}</span>}
                      </span>
                      <span className="home-shelf__title">{row.name}</span>
                      <span className="home-shelf__detail"><span className="home-kind">{KIND_LABEL[row.kind]}</span>{released ? release?.caption.text : upcomingRow?.detail}{row.watch && !released && <> · <span className="home-watch">관심</span></>}</span>
                    </button>;
                  })}
                  {shelfRows.length > 4 && <button type="button" className="home-shelf__more" onClick={go(calendarTarget)}>
                    <span className="numeric">+{shelfRows.length - 4}</span><span>더 보기</span>
                  </button>}
                </div>
                : <p className="home-shelf__empty">이 종류의 발매 항목 없음</p>}
            </Section>
            {artistRows && artistRows.length > 0 && <Section title="작가 다시 보기" hint={`오늘 · ${Number(artistMonth)}월 ${Number(artistDay)}일`}
              actions={<>
                <button type="button" className="home-header-action" onClick={() => setArtistSeed((value) => value + 1)}>다시 고르기</button>
                <button type="button" className="home-header-action" onClick={go({ kind: "artists", section: "main" })}>작가 <Chevron /></button>
              </>}>
              <div className="home-artists">
                {artistRows.map((row) => <button key={row.artist.id} type="button" className="home-artist__row" onClick={() => onNavigate({ kind: "creator", creatorKey: row.artist.id })}
                  aria-label={`${row.artist.label} · ${row.reason}`}>
                  <span className="home-artist__who">
                    <ArtistThumb assetId={row.artist.coverAssetIds[0]} privacyMode={privacyMode} className="home-artist__avatar" />
                    <span className="home-artist__copy"><b>{row.artist.label}</b><small className={`home-artist__reason home-artist__reason--${row.kind}`}>{row.reason}</small><small>소장 <span className="numeric">{row.artist.assetCount}</span>장</small></span>
                  </span>
                  <ThumbStrip assetIds={row.assetIds} privacyMode={privacyMode} label={row.artist.label} />
                  <Chevron />
                </button>)}
              </div>
            </Section>}
          </div>
          <div className="home-lane home-lane--side">
            <Section title="확인할 것" summary={todos.length ? <Sum value={todos.length} unit="가지" plain /> : undefined}
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
                  {overview.avPerformer.latestWork.frontArtworkId && <img src={workArtworkThumbnailUrl(overview.avPerformer.latestWork.frontArtworkId)} alt="" loading="lazy" decoding="async" />}
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
function Sum({ value, unit, plain = false }: { value: number; unit: string; plain?: boolean }) {
  return <span className={`home-sum numeric${plain ? " home-sum--plain" : ""}`}>{value.toLocaleString()}<small>{unit}</small></span>;
}
function Progress({ value }: { value: number }) {
  return <span className="home-progress" aria-hidden="true"><i style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} /></span>;
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
function MemoDetail({ memo }: { memo: MemoRow }) {
  if (memo.kind === "checklist") return <><span className="numeric">{memo.done}/{memo.total}</span> 완료{memo.total > 0 && <Progress value={memo.done / memo.total} />}</>;
  if (memo.kind === "ledger") return <>{memo.month}월 {memo.label} <span className="numeric">{memo.amount.toLocaleString()}</span>원</>;
  if (memo.kind === "secret") return <>암호 메모</>;
  return <>{memo.snippet || "내용 없음"}</>;
}

/** The index while Home is open: nearby notes, connections, transfers, and asset totals. */
function HomeIndex({ memos, locked, connections, busyConnections, troubled, transfer, sending, transferOffline, outage, from, overview, trashCount, privacyMode, onNavigate }: {
  memos: MemoRow[]; locked: boolean; connections: Connection[]; busyConnections: Connection[]; troubled: boolean;
  transfer: ExchangeSnapshot; sending: ReturnType<typeof sendingSummary>; transferOffline: boolean; outage: { since: string | null } | null;
  from: string | null; overview: HomeOverview | null; trashCount: number; privacyMode: boolean; onNavigate: (view: AssetView) => void;
}) {
  const detail = troubled
    ? (() => { const row = connections.find((item) => item.tone === "off"); return row ? `${row.label} · ${row.value}${row.time ? ` · ${row.time}` : ""}` : "문제 확인 필요"; })()
    : busyConnections.length ? busyConnections.map((row) => `${row.label} ${row.value}`).join(" · ") : "모두 정상";
  const openExchange = () => onNavigate({ kind: "exchange" });
  return <nav className="home-index" aria-label="홈 인덱스">
    <IndexLabel title="메모" count={memos.length} />
    {memos.length === 0 && <span className="home-index__empty">{locked ? "메모 잠금 해제" : "고정한 메모 없음"}</span>}
    {memos.map((memo) => <button key={memo.id} type="button" className="home-index__memo" onClick={() => onNavigate({ kind: "notes", noteId: memo.id })}>
      <span className="home-memo__strip" style={memo.color ? { background: memo.color } : undefined} aria-hidden="true" />
      <MemoIcon memo={memo} />
      <span className="home-memo__t"><b>{memo.title || "제목 없음"}</b><small><MemoDetail memo={memo} /></small></span>
    </button>)}
    <button type="button" className="home-index__new" onClick={() => onNavigate({ kind: "notes" })}>＋ <span>새 메모</span></button>

    <IndexLabel title="연결" />
    {connections.length > 0 && <>
      <div className="home-index__connection-list">
        {connections.map((row) => <button key={row.key} type="button" className="home-index__connection" onClick={() => onNavigate(row.view)} aria-label={`${row.label} 열기`}>
          <span className="home-dot" data-tone={row.tone} aria-hidden="true" /><span>{row.label}</span>
        </button>)}
      </div>
    </>}
    <p className={`home-index__connection-detail${troubled ? " home-index__connection-detail--alert" : ""}`}>{detail}</p>

    <IndexLabel title="전송" />
    {transfer.unseen > 0 && <button type="button" className="home-index__transfer" onClick={openExchange}>
      <span className="home-index__transfer-text"><b>받은 파일</b><small>{from ? `${from}에서 · ` : ""}아직 안 봄</small></span>
      <span className="home-index__transfer-count numeric">{transfer.unseen}</span>
    </button>}
    {sending && <button type="button" className="home-index__transfer" onClick={openExchange}>
      <span className="home-index__transfer-text"><b>{transferOffline || outage ? "보내기 멈춤" : "보내는 중"}</b><small>{transferOffline || outage ? "연결되면 이어서 보냄" : `${sending.name}${sending.more > 0 ? ` 외 ${sending.more}` : ""}${sending.peer ? ` › ${sending.peer}` : ""}`}</small>{sending.progress !== null && !(transferOffline || outage) && <Progress value={sending.progress} />}</span>
      <span className="home-index__transfer-count numeric">{transferOffline || outage ? sending.more + 1 : sending.progress === null ? "…" : `${Math.round(sending.progress * 100)}%`}</span>
    </button>}
    {!transfer.unseen && !sending && <button type="button" className="home-index__quiet" onClick={openExchange}>받은 파일 · 보낼 파일 없음</button>}

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
  </nav>;
}

function IndexLabel({ title, count }: { title: string; count?: number }) {
  return <h2 className="home-index__label">{title}{count !== undefined && <span className="numeric">{count}</span>}</h2>;
}
