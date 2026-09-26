import { CheckCircleIcon, ChevronRightIcon, DocumentTextIcon, ListBulletIcon, LockClosedIcon, SignalSlashIcon, WalletIcon } from "@heroicons/react/24/outline";
import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAuthoritySyncHealth, useCloudSyncStatus } from "../app/useCloudProblems";
import { useWorkloadProfile } from "../app/workloadProfile";
import { igdbImagePreviewUrl, tmdbImagePreviewUrl } from "../assets/mediaUrl";
import { collectionCoverUrl } from "../collections/collectionCover";
import { groupInbox, localDay } from "../collections/releaseCaption";
import { useReleaseData } from "../collections/releaseData";
import { exchangeStore as defaultExchangeStore, useExchangeSnapshot, type ExchangeStore } from "../exchange/exchangeStore";
import { ViewToolbar } from "../layout/ViewToolbar";
import { useLibrary } from "../library/LibraryContext";
import type { AssetView, CatalogStatus, ClassificationEntry, CollectionSummary, HomeOverview, ReleaseCalendar, ReleaseWishlistItem } from "../library/types";
import type { CharacterTarget } from "../characters/api";
import { notesStore, type NotesStore } from "../notes/store";
import { usePrivacy } from "../privacy/PrivacyContext";
import { shadowReviewApi, type ShadowReviewApi, type ShadowReviewItem } from "../characters/shadowReviewApi";
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
  /** Registered characters (series of each S36 target) and classifications (series names). */
  characters?: CharacterTarget[];
  classifications?: ClassificationEntry[];
  now?: () => Date;
};

/**
 * PC Home (HOME-DASH-001, layout B "priority ledger"): 확인할 것 across the top, 신간 and
 * 발매 예정 in the wide left column, 전송 · 자산 현황 · 메모 · 연결 in the narrow right one.
 * Every row opens the PC screen that owns it. Reads happen when Home opens (and the asset
 * counts again after imports); live parts follow the stores the app already keeps (exchange,
 * notes, cloud progress, server-sync health, the 신간 cache). No polling.
 */
export function HomeView({ collections, reviewCount, unsortedCount, trashCount, refreshVersion = 0, onNavigate, onQueuesRequested, exchange = defaultExchangeStore, notes, shadowApi, characterSource, characters = [], classifications = [], now = () => new Date() }: HomeViewProps) {
  const { gateway, library } = useLibrary();
  const root = library?.root ?? "";
  const { privacyMode } = usePrivacy();
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

  const [overview, setOverview] = useState<HomeOverview | null>(null);
  useEffect(() => {
    if (!gateway.getHomeOverview) return;
    let live = true;
    const { todayStart, weekStart } = localBoundaries(now());
    void gateway.getHomeOverview(todayStart, weekStart).then((value) => { if (live) setOverview(value ?? null); }, () => undefined);
    return () => { live = false; };
    // `now` is a test seam; the read follows the gateway, imports and trash changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, refreshVersion, trashCount]);

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
  const [reviewRead, setReviewRead] = useState(0);
  const [queueRead, setQueueRead] = useState(0);
  const [characterQueue, setCharacterQueue] = useState<CharacterQueue | null>(null);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const characterApi = shadowApi ?? (native() ? shadowReviewApi : null);
  // Lightweight mode skips the S36 candidate read (it scans the whole shadow list); the row
  // stays hidden until the mode ends, then the list is read once.
  const { restricted } = useWorkloadProfile();
  useEffect(() => {
    if (!characterApi || restricted) { setCharacterQueue(null); return; }
    let live = true;
    void characterApi.page({ offset: 0, limit: CHARACTER_PAGE }).then((page) => {
      if (!live || !page) return;
      const items = page.items ?? [];
      const total = page.summary ? page.summary.automatic.pending + page.summary.recommended.pending : 0;
      setCharacterQueue({ total: page.nextOffset === null ? Math.max(total, items.length) : total, items });
    }, () => undefined);
    return () => { live = false; };
  }, [characterApi, restricted, queueRead]);
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
  const source = useMemo(() => characterSource ?? (characterApi ? shadowPageSource(characterApi) : null), [characterSource, characterApi]);
  const todos = [
    { key: "pending", label: "처리 대기", unit: "건", note: staleAt ? `${staleAt} 기준 · 태블릿 수집 요청` : "태블릿 수집 요청 · 아직 안 받음", count: overview?.server.capturesPending ?? 0, open: go({ kind: "settings", section: "cloud" }) },
    { key: "character", label: "캐릭터 검토", unit: "건", note: characterHint ?? "자동 분류 후보 확인", count: characterQueue?.total ?? 0,
      open: () => setReviewOverview(true) },
    { key: "similar", label: "유사 이미지", unit: "쌍", note: "같은 그림일 수 있음", count: reviewCount, open: go({ kind: "similarity_review" }) },
    { key: "duplicates", label: "중복 판본", unit: "건", note: "카탈로그 · 같은 작품", count: duplicateCount, open: () => setDialog({ kind: "duplicates" }) },
    { key: "unsorted", label: "미분류", unit: "장", note: "분류가 없는 새 자산", count: unsortedCount ?? 0, open: go({ kind: "unsorted" }) },
  ].filter((todo) => todo.count > 0);

  /* 신간 · 발매 예정 */
  const releases = releaseRows(collections, board, inbox, wishlist, today);
  const watched = watchedMangaCount(board);
  const upcomingAll = upcomingRows(collections, board, inbox, wishlist, today);
  const upcoming = upcomingAll.filter((row) => daysAfter(row.date, today) <= UPCOMING_DAYS);
  const nextLater = upcomingAll.find((row) => daysAfter(row.date, today) > UPCOMING_DAYS) ?? null;
  const [kind, setKind] = useState<KindFilter>("all");
  const shownUpcoming = upcoming.filter((row) => kind === "all" || row.kind === kind);
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

  const cover = (row: ReleaseRow) => {
    if (privacyMode) return null;
    if (row.collection) return collectionCoverUrl(row.collection);
    const title = row.title;
    if (!title?.cover) return null;
    return title.provider === "igdb" ? igdbImagePreviewUrl(title.cover, "cover") : tmdbImagePreviewUrl(title.cover, "poster");
  };

  const index = <HomeIndex memos={memos} locked={Boolean(notesState.keyringLocked)} connections={connections} onNavigate={onNavigate} />;

  const connectionSection = connections.length > 0 && <Section key="connections" title="연결" alert={troubled} onOpen={go({ kind: "settings", section: "cloud" })}
    calm={troubled ? undefined : <><span className="home-dot" data-tone={busyConnections.length ? "busy" : "ok"} aria-hidden="true" /><span>{busyConnections.length ? busyConnections.map((row) => `${row.label} ${row.value}`).join(" · ") : "모두 정상"}</span></>}>
    {troubled && connections.map((row) => <button key={row.key} type="button" className="home-conn" onClick={() => onNavigate(row.view)}>
      <span className="home-dot" data-tone={row.tone} aria-hidden="true" /><em>{row.label}</em><span className="home-conn__value">{row.value}</span>
      <small className="numeric">{row.time}</small><Chevron /></button>)}
  </Section>;

  const closeDialog = () => { setDialog(null); if (reviewOverview) setReviewRead((value) => value + 1); else setQueueRead((value) => value + 1); };
  const dialogs = dialog && <Suspense fallback={null}>
    {dialog.kind === "character"
      ? <ShadowReview onClose={closeDialog} onChanged={() => undefined} privacyMode={privacyMode} series={dialog.series} target={dialog.target} />
      : <CatalogReviewDialog onClose={closeDialog} onChange={() => undefined} />}
  </Suspense>;

  if (reviewOverview && source) return <>
    <CharacterReviewOverview source={source} targets={characters} seriesName={seriesName} version={reviewRead} restricted={restricted} privacyMode={privacyMode}
      onBack={() => { setReviewOverview(false); setQueueRead((value) => value + 1); }} onOpen={(scope) => setDialog({ kind: "character", ...scope })} />
    {dialogs}
  </>;

  return <div className="home-view">
    <ViewToolbar title="홈" titleAccessory={<span className="home-title-date"><span className="numeric">{`${at.getMonth() + 1}.${at.getDate()}`}</span> {weekdayLabel(at)}</span>} chrome={{ navigation: index }} />
    <div className="home-scroll">
      <div className="home-ledger">
        {outage && <div className="home-offline" role="status">
          <SignalSlashIcon aria-hidden="true" />
          <span><b>서버에 닿지 않음</b>{outage.since && <><span className="numeric">{clockLabel(outage.since)}</span>부터 — </>}이 PC의 라이브러리 · 확인할 것 · 메모는 그대로입니다. 전송과 처리 대기만 마지막 값입니다.</span>
        </div>}

        <Section title="확인할 것" summary={todos.length ? <Sum value={todos.length} unit="가지" plain /> : undefined}
          calm={todos.length ? undefined : <Ok>모두 확인함</Ok>}>
          {todos.length > 0 && <div className="home-todo" style={{ gridTemplateColumns: `repeat(${todos.length}, minmax(0, 1fr))` }}>
            {todos.map((todo) => <button key={todo.key} type="button" className="home-row home-row--todo" onClick={todo.open}>
              <span className="home-row__n numeric">{todo.count.toLocaleString()}<small>{todo.unit}</small></span>
              <span className="home-row__t">{todo.label}<small>{todo.note}</small></span><Chevron />
            </button>)}
          </div>}
        </Section>

        <div className="home-columns">
          <div className="home-lane">
            <Section title="신간" hint="나온 권" onOpen={go(releaseView)}
              summary={releases.length ? <Sum value={releases.length} unit="편 안 읽음" /> : undefined}
              calm={releases.length ? undefined : <Ok>새 신간 없음{watched > 0 && <> · 만화 <b className="numeric">{watched}</b>편{wishlist.length > 0 && <> · 관심 <b className="numeric">{wishlist.length}</b>편</>} 지켜보는 중</>}{watched === 0 && wishlist.length > 0 && <> · 관심 <b className="numeric">{wishlist.length}</b>편 지켜보는 중</>}</Ok>}>
              {releases.length > 0 && <div className="home-releases">
                {releases.slice(0, 8).map((row) => {
                  const url = cover(row);
                  return <button key={row.key} type="button" className="home-release" onClick={() => openRelease(row)}>
                    <span className={`home-cover${row.kind === "manga" ? "" : " home-cover--title"}`} aria-hidden="true">{url && <img src={url} alt="" loading="lazy" decoding="async" />}</span>
                    <span className="home-release__t">
                      <b>{row.kind !== "manga" && <span className="home-kind">{KIND_LABEL[row.kind]}</span>}{row.name}</b>
                      <small className={row.caption.kind === "new" ? "is-new" : undefined}>{row.caption.text}{row.caption.date && <span className="numeric"> · {row.caption.date}</span>}</small>
                    </span><Chevron />
                  </button>;
                })}
              </div>}
            </Section>

            <Section title="발매 예정" hint="나올 권" onOpen={calendarApi ? go(calendarView()) : go(releaseView)}
              summary={upcoming.length ? <Sum value={upcoming.length} unit={`개 · ${UPCOMING_DAYS}일 안`} plain /> : undefined}
              calm={upcoming.length ? undefined : <span>{UPCOMING_DAYS}일 안에 없음{nextLater && <> · 다음 <b className="numeric">{dateBlock(nextLater.date, today).day}</b> {nextLater.name} {nextLater.kind === "manga" ? nextLater.detail : ""}</>}</span>}>
              {upcoming.length > 0 && <>
                <div className="home-chips" role="radiogroup" aria-label="종류">
                  {(["all", "manga", "game", "movie"] as const).map((value) => {
                    const count = value === "all" ? upcoming.length : upcoming.filter((row) => row.kind === value).length;
                    return <button key={value} type="button" role="radio" aria-checked={kind === value} className="home-chip" onClick={() => setKind(value)}>
                      {value === "all" ? "전체" : KIND_LABEL[value]} <span className="numeric">{count}</span></button>;
                  })}
                </div>
                {shownUpcoming.slice(0, 10).map((row) => {
                  const block = dateBlock(row.date, today);
                  const left = daysAfter(row.date, today);
                  return <button key={row.key} type="button" className="home-up" onClick={() => openUpcoming(row)}>
                    <span className="home-up__d numeric">{block.day}<small>{block.weekday}</small></span>
                    <span className="home-up__nm">{row.name}<small><span className="home-kind">{KIND_LABEL[row.kind]}</span>{row.detail}{row.watch && <> · <span className="home-watch">관심</span></>}</small></span>
                    <span className="home-up__left">{left === 0 ? "오늘" : left === 1 ? "내일" : `${left}일 후`}</span><Chevron />
                  </button>;
                })}
              </>}
            </Section>
          </div>

          <div className="home-lane home-lane--side">
            {outage && connectionSection}
            <Section title="전송" onOpen={go({ kind: "exchange" })} stale={staleAt}
              calm={transfer.unseen > 0 || sending ? undefined : <Ok>받은 파일 · 보낼 파일 없음</Ok>}>
              {transfer.unseen > 0 && <button type="button" className="home-row" onClick={go({ kind: "exchange" })}>
                <span className="home-row__n numeric">{transfer.unseen}<small>개</small></span>
                <span className="home-row__t">받은 파일<small>{from ? `${from}에서 · ` : ""}아직 안 봄</small></span><Chevron /></button>}
              {sending && (transferOffline || outage
                ? <button type="button" className="home-row" onClick={go({ kind: "exchange" })}>
                  <span className="home-row__n numeric">{sending.more + 1}<small>개</small></span>
                  <span className="home-row__t">보내기 멈춤<small>연결되면 이어서 보냄</small></span><Chevron /></button>
                : <button type="button" className="home-row" onClick={go({ kind: "exchange" })}>
                  <span className="home-row__n numeric">{sending.progress === null ? "…" : Math.round(sending.progress * 100)}<small>{sending.progress === null ? "" : "%"}</small></span>
                  <span className="home-row__t">보내는 중<small>{sending.name}{sending.more > 0 ? ` 외 ${sending.more}` : ""}{sending.peer ? ` › ${sending.peer}` : ""}</small>
                    {sending.progress !== null && <Progress value={sending.progress} />}</span><Chevron /></button>)}
            </Section>

            {overview && <Section title="자산 현황" onOpen={go({ kind: "statistics" })}
              calm={overview.assets.today > 0 ? undefined : <span>이번 주 <b className="numeric">{overview.assets.week.toLocaleString()}</b>장 · 오늘 <b className="numeric">0</b> · 전체 <b className="numeric">{overview.assets.total.toLocaleString()}</b>{trashCount > 0 && <> · 휴지통 <b className="numeric">{trashCount.toLocaleString()}</b></>}</span>}>
              {overview.assets.today > 0 && <>
                <StatRow value={overview.assets.today} unit="장" label="오늘 추가" note="오늘 0시부터" onClick={go({ kind: "classification", classificationId: null })} />
                <StatRow value={overview.assets.week} unit="장" label="이번 주 추가" note="월요일부터" onClick={go({ kind: "classification", classificationId: null })} />
                <StatRow value={overview.assets.total} unit="장" label="전체" note="통계에서 자세히" onClick={go({ kind: "statistics" })} />
                {trashCount > 0 && <StatRow value={trashCount} unit="장" label="휴지통" note="30일 뒤 비움" onClick={go({ kind: "trash" })} />}
              </>}
            </Section>}

            <Section title="메모" onOpen={go({ kind: "notes" })} summary={memos.length ? <Sum value={memos.length} unit="개 고정" plain /> : undefined}
              calm={memos.length ? undefined : <span>{notesState.keyringLocked ? "메모를 열어 잠금 해제" : "고정한 메모 없음"}</span>}>
              {memos.map((memo) => <button key={memo.id} type="button" className="home-memo" onClick={() => onNavigate({ kind: "notes", noteId: memo.id })}>
                <span className="home-memo__strip" style={memo.color ? { background: memo.color } : undefined} aria-hidden="true" />
                <MemoIcon memo={memo} />
                <span className="home-memo__t"><b>{memo.title || "제목 없음"}</b><small><MemoDetail memo={memo} /></small></span><Chevron />
              </button>)}
            </Section>
            {!outage && connectionSection}
            {/* 오늘의 AV 배우 waits for published AV Collection data (HOME-DASH-001); hidden until it exists. */}
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
function StatRow({ value, unit, label, note, onClick }: { value: number; unit: string; label: string; note: string; onClick: () => void }) {
  return <button type="button" className="home-row home-row--stat" onClick={onClick}>
    <span className="home-row__n numeric">{value.toLocaleString()}<small>{unit}</small></span>
    <span className="home-row__t">{label}<small>{note}</small></span><Chevron /></button>;
}

/**
 * One ledger section: a square-marked heading line, then rows between 1px rules. A section
 * with nothing to do collapses to its heading plus one calm line.
 */
function Section({ title, hint, summary, calm, stale, alert = false, onOpen, children }: {
  title: string; hint?: string; summary?: ReactNode; calm?: ReactNode; stale?: string | null; alert?: boolean; onOpen?: () => void; children?: ReactNode;
}) {
  const open = !calm;
  const head = <>
    <h2 className="home-section__title">{title}</h2>
    {hint && <span className="home-section__hint">· {hint}</span>}
    {summary}
    {calm && <span className="home-section__calm">{calm}</span>}
    <span className="home-section__space" />
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

/** The index while Home is open: pinned notes (open that note) and the connection rows. */
function HomeIndex({ memos, locked, connections, onNavigate }: { memos: MemoRow[]; locked: boolean; connections: Connection[]; onNavigate: (view: AssetView) => void }) {
  return <nav className="home-index" aria-label="홈 인덱스">
    <h2 className="workspace-section-label">고정 메모{memos.length > 0 && <span className="numeric home-index__count">{memos.length}</span>}</h2>
    {memos.length === 0 && <button type="button" className="workspace-index-link home-index__empty" onClick={() => onNavigate({ kind: "notes" })}>{locked ? "메모 잠금 해제" : "고정한 메모 없음"}</button>}
    {memos.map((memo) => <button key={memo.id} type="button" className="home-index__memo" onClick={() => onNavigate({ kind: "notes", noteId: memo.id })}>
      <span className="home-memo__strip" style={memo.color ? { background: memo.color } : undefined} aria-hidden="true" />
      <MemoIcon memo={memo} />
      <span className="home-memo__t"><b>{memo.title || "제목 없음"}</b><small><MemoDetail memo={memo} /></small></span>
    </button>)}
    {connections.length > 0 && <>
      <h2 className="workspace-section-label">연결</h2>
      {connections.map((row) => <button key={row.key} type="button" className="home-index__conn" onClick={() => onNavigate(row.view)}>
        <span className="home-dot" data-tone={row.tone} aria-hidden="true" /><em>{row.label}</em>
        <span className="home-index__conn-value">{row.tone === "off" || !row.time ? row.value : <span className="numeric">{row.time}</span>}</span>
      </button>)}
    </>}
  </nav>;
}
