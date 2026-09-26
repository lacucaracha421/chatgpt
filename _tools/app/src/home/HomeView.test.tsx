import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetReleaseDataForTests } from "../collections/releaseData";
import { EMPTY_EXCHANGE, ExchangeStore, type ExchangeSnapshot } from "../exchange/exchangeStore";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import type { AuthoritySyncHealth, CollectionSummary, HomeOverview, ReleaseBoardEntry, ReleaseInboxItem, ReleaseWishlistItem } from "../library/types";
import { NotesStore, type Note } from "../notes/store";
import { HomeView, type HomeViewProps } from "./HomeView";

const gateway = vi.hoisted(() => ({
  collectionTracking: { listInbox: vi.fn(), releaseBoard: vi.fn() },
  releaseCalendar: { calendar: vi.fn(), wishlist: vi.fn() },
  getHomeOverview: vi.fn(),
  getOnlineCatalogStatus: vi.fn(),
  listCatalogReview: vi.fn(),
  cloudBackfillProgress: vi.fn(),
  authoritySyncHealth: vi.fn(),
}));
vi.mock("../library/LibraryContext", () => ({ useLibrary: () => ({ gateway, library: { root: "fixture" } }) }));
const workload = vi.hoisted(() => ({ restricted: false }));
vi.mock("../app/workloadProfile", async (importOriginal) => ({ ...await importOriginal<typeof import("../app/workloadProfile")>(), useWorkloadProfile: () => ({ ...workload }) }));
type Scope = { id: string; name: string } | undefined;
vi.mock("../characters/ShadowReview", () => ({ ShadowReview: ({ onClose, series, target }: { onClose: () => void; series?: Scope; target?: Scope }) =>
  <div role="dialog" aria-label="S36 확인"><span>{`범위 ${series?.id ?? "-"}/${target?.id ?? "-"}`}</span><button type="button" onClick={onClose}>닫기</button></div> }));
vi.mock("../manga/CatalogReviewDialog", () => ({ CatalogReviewDialog: ({ onClose }: { onClose: () => void }) => <div role="dialog" aria-label="중복 후보 검토"><button type="button" onClick={onClose}>닫기</button></div> }));

// Saturday 2026-09-26 14:31 local.
const NOW = new Date(2026, 8, 26, 14, 31);
const iso = (hours: number, minutes = 0) => new Date(2026, 8, 26, hours, minutes).toISOString();

function work(id: string, name: string, extra: Partial<CollectionSummary> = {}): CollectionSummary {
  return { id, name, description: null, type: "manga", coverAssetId: null, selectedWorkArtworkId: null, selectedHeroArtworkId: null, selectedBackdropArtworkId: null,
    assetCount: 0, unreadReleaseCount: 0, year: null, originalTitle: null, runtimeMinutes: null, author: null, developer: null, publisher: null, platforms: null,
    productionCompany: null, releaseDate: null, director: null, externalScore: null, myScore: null, genres: null, overview: null, showcase: false, showcaseOrder: null,
    createdAt: "2026-01-01", updatedAt: "2026-01-01", ...extra };
}
function entry(collectionId: string, owned: number, volumes: { volumeNumber: number; date: string }[]): ReleaseBoardEntry {
  return { collectionId, releaseWatch: { enabled: true, available: true }, ownedVolumes: [{ editionIndex: 0, count: owned }],
    releaseSchedule: { kakao: { editionIndex: 0, checkedAt: null, volumes: volumes.map((volume) => ({ ...volume, status: null })) }, mangadex: null } };
}
function title(id: string, name: string, kind: "game" | "movie", date: string, extra: Partial<ReleaseWishlistItem> = {}): ReleaseWishlistItem {
  return { id, kind, provider: kind === "game" ? "igdb" : "tmdb", externalId: id, title: name, originalTitle: null, cover: null, platforms: kind === "game" ? ["PS5", "Switch"] : [],
    date, precision: "exact", region: null, popularity: 0, dates: [], source: "calendar", addedAt: "2026-09-01", muted: false, lastCheckedAt: null, nextCheckAt: null,
    released: false, unread: [], ...extra };
}
const overview = (assets: HomeOverview["assets"], server: Partial<HomeOverview["server"]> = {}): HomeOverview =>
  ({ assets, server: { configured: true, live: true, confirmedAt: iso(14, 30), capturesPending: 0, ...server } });
const healthy: AuthoritySyncHealth = {
  albums: { blockedCount: 0, waitingCount: 0, droppedCount: 0, lastDropReason: null, lastDroppedAt: null } as never,
  classifications: { blockedCount: 0, waitingCount: 0, droppedCount: 0, lastDropReason: null, lastDroppedAt: null } as never,
  assets: { rejectedCount: 0, rejectedReason: null, stopped: false },
  characterExclusions: { skippedCount: 0, lastSkipReason: null, lastSkippedAt: null },
  authorityPassFailure: null, assetLaneFailure: null,
};
const note = (id: string, fields: Partial<Note>): Note => ({ id, title: "", body: "", pinned: true, deleted: false, createdAt: iso(1), updatedAt: iso(1), localRevision: 1, pending: false, conflict: false, ...fields });

function exchangeWith(snapshot: Partial<ExchangeSnapshot>) {
  const value = { ...EMPTY_EXCHANGE, availability: { state: "ready" as const, message: null, needsToken: false }, devices: [{ deviceId: "tab", name: "Galaxy Tab S11", kind: "tablet" }], ...snapshot };
  return new ExchangeStore(async <T,>() => value as T, async () => () => undefined);
}
function notesWith(notes: Note[]) {
  return new NotesStore(async <T,>() => ({ unlocked: true, notes, lastSyncedAt: null }) as T);
}

type Candidate = { targetId: string; targetName: string };
type Setup = { props?: Partial<HomeViewProps>; exchange?: Partial<ExchangeSnapshot>; notes?: Note[]; characters?: number; candidates?: Candidate[] };
function renderHome({ props = {}, exchange = {}, notes = [], characters = 0, candidates = [] }: Setup = {}) {
  const onNavigate = vi.fn();
  const shadowApi = { page: vi.fn().mockResolvedValue({ items: candidates, nextOffset: null, policyVersion: null, summary: { automatic: { pending: Math.max(characters, candidates.length), accepted: 0, rejected: 0 }, recommended: { pending: 0, accepted: 0, rejected: 0 }, byOrigin: {} } }) };
  const view = render(<WorkspaceChromeProvider scope="home"><ChromeTarget name="navigation" />
    <HomeView collections={[]} reviewCount={0} unsortedCount={0} trashCount={0} onNavigate={onNavigate} exchange={exchangeWith(exchange)} notes={notesWith(notes)}
      shadowApi={shadowApi} now={() => NOW} {...props} />
  </WorkspaceChromeProvider>);
  return { onNavigate, shadowApi, view };
}
const section = (name: string) => screen.getByRole("region", { name });
const head = (name: string) => screen.getByRole("button", { name: `${name} 열기` });

beforeEach(() => {
  vi.clearAllMocks();
  workload.restricted = false;
  resetReleaseDataForTests();
  gateway.collectionTracking.listInbox.mockResolvedValue([]);
  gateway.collectionTracking.releaseBoard.mockResolvedValue([]);
  gateway.releaseCalendar.wishlist.mockResolvedValue([]);
  gateway.releaseCalendar.calendar.mockResolvedValue({ rangeStart: "2026-09-26", rangeEnd: "2027-03-26", entries: [], sources: [
    { provider: "igdb", fetchedAt: iso(12, 31), attemptedAt: null, errorCode: null, due: false }, { provider: "tmdb", fetchedAt: iso(12, 31), attemptedAt: null, errorCode: null, due: false }] });
  gateway.getHomeOverview.mockResolvedValue(overview({ total: 48213, today: 0, week: 41 }));
  gateway.getOnlineCatalogStatus.mockResolvedValue({ installed: true, workCount: 1, updateEnabled: true, updateIntervalSeconds: 3600, lastAttemptAt: iso(14, 19), lastSuccessAt: iso(14, 19), lastAdded: 0, lastError: null, streams: [] });
  gateway.listCatalogReview.mockResolvedValue({ rows: [], inspectedWorks: 0, comparisons: 0, skippedBuckets: 0 });
  gateway.cloudBackfillProgress.mockResolvedValue({ controlState: "idle", totalAssets: 1, queued: 0, preparing: 0, uploading: 0, committing: 0, completed: 1, failed: 0, activeWorkers: 0, lastError: null });
  gateway.authoritySyncHealth.mockResolvedValue(healthy);
});
afterEach(cleanup);

describe("HomeView", () => {
  it("collapses calm sections to one line each and reads the day's boundaries", async () => {
    const { shadowApi } = renderHome();
    await waitFor(() => expect(within(section("자산 현황")).getByText(/이번 주/)).toHaveTextContent("이번 주 41장 · 오늘 0 · 전체 48,213"));
    expect(within(section("확인할 것")).getByText("모두 확인함")).toBeInTheDocument();
    expect(within(section("신간")).getByText(/새 신간 없음/)).toBeInTheDocument();
    expect(within(section("발매 예정")).getByText(/30일 안에 없음/)).toBeInTheDocument();
    expect(within(section("전송")).getByText("받은 파일 · 보낼 파일 없음")).toBeInTheDocument();
    expect(within(section("메모")).getByText("고정한 메모 없음")).toBeInTheDocument();
    await waitFor(() => expect(within(section("연결")).getByText("모두 정상")).toBeInTheDocument());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/기준$/)).not.toBeInTheDocument();
    expect(gateway.getHomeOverview).toHaveBeenCalledWith(new Date(2026, 8, 26).toISOString(), new Date(2026, 8, 21).toISOString());
    expect(shadowApi.page).toHaveBeenCalledWith({ offset: 0, limit: 200 });
    // The index: connection rows even when nothing is pinned.
    const index = screen.getByRole("navigation", { name: "홈 인덱스" });
    await waitFor(() => expect(within(index).getAllByRole("button").map((button) => button.textContent)).toEqual(
      ["고정한 메모 없음", "서버연결됨", "태블릿Galaxy Tab S11", "클라우드동기화됨", "카탈로그12분 전", "발매 캘린더2시간 전"]));
  });

  it("lays out a busy day and sends every row to the screen that owns it", async () => {
    gateway.getHomeOverview.mockResolvedValue(overview({ total: 48213, today: 146, week: 812 }, { capturesPending: 23 }));
    gateway.listCatalogReview.mockResolvedValue({ rows: [{ state: "pending", actionable: true }, { state: "pending", actionable: true }, { state: "confirm", actionable: true }], inspectedWorks: 0, comparisons: 0, skippedBuckets: 0 });
    const sea = work("m1", "바다 건너 편지", { unreadReleaseCount: 1 });
    const star = work("m2", "별빛 식당");
    gateway.collectionTracking.releaseBoard.mockResolvedValue([entry("m1", 12, [{ volumeNumber: 13, date: "2026-09-24" }]), entry("m2", 7, [{ volumeNumber: 8, date: "2026-09-30" }])]);
    const inbox: ReleaseInboxItem[] = [{ collectionId: "m1", collectionName: "바다 건너 편지", provider: "kakao", event: { id: "e1", kind: "new_volume", volumeNumber: 13, previousValue: null, currentValue: "2026-09-24", detectedAt: iso(9) } }];
    gateway.collectionTracking.listInbox.mockResolvedValue(inbox);
    gateway.releaseCalendar.wishlist.mockResolvedValue([
      title("igdb:1", "들판의 기록 II", "game", "2026-09-25", { released: true, unread: [{ id: "w1", itemId: "igdb:1", kind: "released", previousValue: null, currentValue: "2026-09-25", detectedAt: iso(8), readAt: null }] }),
      title("tmdb:2", "여름의 끝", "movie", "2026-10-15", { unread: [{ id: "w2", itemId: "tmdb:2", kind: "date_changed", previousValue: "2026-10-22", currentValue: "2026-10-15", detectedAt: iso(7), readAt: null }] }),
    ]);
    const ledger = note("n2", { title: "가계부", type: "ledger", income: 500000, recurring: [], planned: [], updatedAt: iso(3) });
    const { onNavigate } = renderHome({
      props: { collections: [sea, star], reviewCount: 6, unsortedCount: 318, trashCount: 37 },
      exchange: { unseen: 3, received: [{ transferId: "r1", fileName: "a.png", sizeBytes: 1, fromName: "Galaxy Tab S11", receivedAt: iso(13), exists: true }],
        outgoing: [{ transferId: "o1", fileName: "스케치_0926.zip", sizeBytes: 100, toName: "Galaxy Tab S11", state: "uploading", done: 62, message: null, note: null, retryable: false, cancellable: true, createdAt: iso(14) }] },
      notes: [note("n1", { title: "장보기", type: "checklist", items: [{ id: "i1", text: "우유", checked: true, order: "a" }, { id: "i2", text: "빵", checked: false, order: "b" }] as never, updatedAt: iso(5) }), ledger],
      characters: 14,
    });
    const user = userEvent.setup();

    // 확인할 것: five cells in the product order.
    const todo = section("확인할 것");
    await waitFor(() => expect(within(todo).getAllByRole("button").map((button) => button.textContent?.replace(/\s+/g, ""))).toEqual([
      "23건처리대기태블릿수집요청·아직안받음", "14건캐릭터검토자동분류후보확인", "6쌍유사이미지같은그림일수있음", "2건중복판본카탈로그·같은작품", "318장미분류분류가없는새자산"]));
    await user.click(within(todo).getByRole("button", { name: /처리 대기/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "settings", section: "cloud" });
    await user.click(within(todo).getByRole("button", { name: /유사 이미지/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "similarity_review" });
    await user.click(within(todo).getByRole("button", { name: /미분류/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "unsorted" });
    await user.click(within(todo).getByRole("button", { name: /캐릭터 검토/ }));
    await user.click(await screen.findByRole("button", { name: "홈으로 돌아가기" }));
    await user.click(within(section("확인할 것")).getByRole("button", { name: /중복 판본/ }));
    expect(await screen.findByRole("dialog", { name: "중복 후보 검토" })).toBeInTheDocument();

    // 신간: the manga with an unread notice, then the wishlist events.
    const fresh = section("신간");
    await waitFor(() => expect(within(fresh).getByRole("button", { name: /바다 건너 편지/ })).toHaveTextContent("신간 13권 · 9.24"));
    await user.click(within(fresh).getByRole("button", { name: /바다 건너 편지/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "collection", collectionId: "m1" });
    expect(within(fresh).getByRole("button", { name: /들판의 기록 II/ })).toHaveTextContent("발매됨 · 관심 목록 · 9.25");
    await user.click(within(fresh).getByRole("button", { name: /여름의 끝/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "movie", showcase: false, releaseCalendar: true });
    await user.click(head("신간"));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "manga", showcase: false, releaseProvider: "kakao" });

    // 발매 예정: manga volume and the watched movie, filterable by kind.
    const upcoming = section("발매 예정");
    expect(within(upcoming).getByRole("button", { name: /별빛 식당/ })).toHaveTextContent("9.30수요일별빛 식당만화8권4일 후");
    expect(within(upcoming).getByRole("button", { name: /여름의 끝/ })).toHaveTextContent("극장 개봉 · 날짜 바뀜 · 관심");
    await user.click(within(upcoming).getByRole("radio", { name: "영화 1" }));
    expect(within(upcoming).queryByRole("button", { name: /별빛 식당/ })).not.toBeInTheDocument();
    await user.click(within(upcoming).getByRole("radio", { name: "전체 2" }));
    await user.click(within(upcoming).getByRole("button", { name: /별빛 식당/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "collection", collectionId: "m2" });
    await user.click(head("발매 예정"));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "game", showcase: false, releaseCalendar: true });

    // 전송, 자산 현황, 메모 (body and index).
    const transfer = section("전송");
    await waitFor(() => expect(within(transfer).getByRole("button", { name: /받은 파일/ })).toHaveTextContent("3개받은 파일Galaxy Tab S11에서 · 아직 안 봄"));
    expect(within(transfer).getByRole("button", { name: /보내는 중/ })).toHaveTextContent("62%보내는 중스케치_0926.zip › Galaxy Tab S11");
    await user.click(within(transfer).getByRole("button", { name: /보내는 중/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "exchange" });
    const assets = section("자산 현황");
    await waitFor(() => expect(within(assets).getByRole("button", { name: /오늘 추가/ })).toHaveTextContent("146장"));
    await user.click(within(assets).getByRole("button", { name: /전체/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "statistics" });
    await user.click(within(assets).getByRole("button", { name: /휴지통/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "trash" });
    await user.click(within(assets).getByRole("button", { name: /오늘 추가/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "classification", classificationId: null });
    const memo = section("메모");
    await waitFor(() => expect(within(memo).getByRole("button", { name: /장보기/ })).toHaveTextContent("1/2 완료"));
    expect(within(memo).getByRole("button", { name: /가계부/ })).toHaveTextContent("9월 쓸 수 있는 돈");
    await user.click(within(memo).getByRole("button", { name: /장보기/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "notes", noteId: "n1" });
    const index = screen.getByRole("navigation", { name: "홈 인덱스" });
    await user.click(within(index).getByRole("button", { name: /가계부/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "notes", noteId: "n2" });
    await user.click(within(index).getByRole("button", { name: /태블릿/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "exchange" });
    await user.click(within(index).getByRole("button", { name: /발매 캘린더/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "game", showcase: false, releaseCalendar: true });
    await user.click(within(index).getByRole("button", { name: /카탈로그/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "settings", section: "catalog" });
  });

  it("offline: one notice, the connection rows first on the right, and 기준 only on server-derived sections", async () => {
    gateway.authoritySyncHealth.mockResolvedValue({ ...healthy, authorityPassFailure: { code: "network", at: iso(14, 31) } });
    gateway.getHomeOverview.mockResolvedValue(overview({ total: 10, today: 2, week: 5 }, { live: false, confirmedAt: iso(14, 30), capturesPending: 4 }));
    const { onNavigate } = renderHome({ exchange: { unseen: 1, availability: { state: "offline", message: null, needsToken: false },
      outgoing: [{ transferId: "o1", fileName: "a.zip", sizeBytes: 10, toName: "Galaxy Tab S11", state: "waiting", done: 0, message: null, note: null, retryable: true, cancellable: true, createdAt: iso(14) }] } });
    expect(await screen.findByRole("status")).toHaveTextContent("서버에 닿지 않음14:31부터 — 이 PC의 라이브러리 · 확인할 것 · 메모는 그대로입니다.");
    const connections = section("연결");
    await waitFor(() => expect(connections).toHaveAttribute("data-alert", "true"));
    const side = connections.parentElement!;
    expect(side.firstElementChild).toBe(connections);
    expect(within(connections).getByRole("button", { name: /서버/ })).toHaveTextContent("서버연결 안 됨14:31부터");
    await user().click(within(connections).getByRole("button", { name: /서버/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "settings", section: "cloud" });
    expect(within(section("전송")).getByText("기준")).toHaveTextContent("14:31 기준");
    expect(within(section("전송")).getByRole("button", { name: /보내기 멈춤/ })).toBeInTheDocument();
    await waitFor(() => expect(within(section("확인할 것")).getByRole("button", { name: /처리 대기/ })).toHaveTextContent("14:31 기준"));
    expect(within(section("신간")).queryByText("기준")).not.toBeInTheDocument();
    expect(within(section("자산 현황")).queryByText("기준")).not.toBeInTheDocument();
  });
});

describe("HomeView 캐릭터 검토", () => {
  const targets = [
    { id: "lala", seriesClassificationId: "lily", displayName: "라라", thumbnailAssetId: "portrait-lala", references: [] },
    { id: "mari", seriesClassificationId: "lily", displayName: "마리", references: [{ assetId: "ref-mari", status: "ready" }] },
    { id: "geum", seriesClassificationId: "wuwa", displayName: "금희", references: [] },
  ] as never;
  const classifications = [{ id: "lily", name: "백합" }, { id: "wuwa", name: "명조" }, { id: "etc", name: "기타 시리즈" }] as never;
  const repeat = (targetId: string, targetName: string, count: number, verdict = "automatic") =>
    Array.from({ length: count }, (_, index) => ({ assetId: `${targetId}-${verdict}-${index}`, targetId, targetName, verdict }));
  /** Serves `items` in pages of the requested size, like the native list. */
  function pagedApi(items: ReturnType<typeof repeat>) {
    const summary = () => ({ automatic: { pending: items.filter((item) => item.verdict === "automatic").length, accepted: 0, rejected: 0 },
      recommended: { pending: items.filter((item) => item.verdict === "recommended").length, accepted: 0, rejected: 0 }, byOrigin: {} });
    return { page: vi.fn(async ({ offset, limit }: { offset: number; limit: number }) => ({ items: items.slice(offset, offset + limit) as never[],
      nextOffset: offset + limit < items.length ? offset + limit : null, policyVersion: null, summary: summary() as never })) };
  }
  const flat = (element: HTMLElement) => element.textContent?.replace(/\s+/g, "");

  it("shows the exact total on Home and opens an overview read in full", async () => {
    const items = [...repeat("mari", "마리", 150), ...repeat("geum", "금희", 120, "recommended"), ...repeat("lala", "라라", 180), ...repeat("lala", "라라", 20, "recommended")];
    const shadowApi = pagedApi(items);
    const { onNavigate } = renderHome({ props: { characters: targets, classifications, shadowApi } });
    const todo = section("확인할 것");
    const cell = await within(todo).findByRole("button", { name: /캐릭터 검토/ });
    // One page on Home: the total from the summary, the series seen so far as a hint.
    await waitFor(() => expect(flat(cell)).toBe("470건캐릭터검토백합·명조"));
    expect(shadowApi.page).toHaveBeenCalledTimes(1);
    expect(within(todo).queryByRole("group")).not.toBeInTheDocument();

    await user().click(cell);
    const lily = await screen.findByRole("region", { name: "백합" });
    // The overview read every page (200 at a time), so every count is exact.
    expect(shadowApi.page.mock.calls.slice(1).map(([query]) => query)).toEqual([
      { offset: 0, limit: 200 }, { offset: 200, limit: 200 }, { offset: 400, limit: 200 }]);
    expect(within(lily).getAllByRole("button").map(flat)).toEqual([
      "시리즈전체검토", "라라자동180·추천20200건", "마리자동150150건"]);
    expect(flat(screen.getByRole("region", { name: "명조" }))).toContain("금희추천120120건");
    expect(within(lily).getByRole("button", { name: "백합 › 라라 검토 200건" }).querySelector("img")?.getAttribute("src")).toContain("portrait-lala");
    expect(within(lily).getByRole("button", { name: "백합 › 마리 검토 150건" }).querySelector("img")?.getAttribute("src")).toContain("ref-mari");

    // The index: 전체 is current (slab); picking a series narrows the page to it.
    const index = screen.getByRole("navigation", { name: "캐릭터 검토 시리즈" });
    expect(within(index).getAllByRole("button").map(flat)).toEqual(["전체470", "백합350", "명조120"]);
    expect(within(index).getByRole("button", { name: /전체/ })).toHaveAttribute("aria-current", "page");
    await user().click(within(index).getByRole("button", { name: /명조/ }));
    expect(screen.queryByRole("region", { name: "백합" })).not.toBeInTheDocument();
    await user().click(within(index).getByRole("button", { name: /전체/ }));

    // A character opens its scoped review; closing it reads the counts again.
    await user().click(within(screen.getByRole("region", { name: "백합" })).getByRole("button", { name: "백합 › 마리 검토 150건" }));
    expect(await screen.findByRole("dialog", { name: "S36 확인" })).toHaveTextContent("범위 lily/mari");
    items.splice(0, 150);
    await user().click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /마리 검토/ })).not.toBeInTheDocument());
    expect(within(index).getAllByRole("button").map(flat)).toEqual(["전체320", "백합200", "명조120"]);
    await user().click(screen.getByRole("button", { name: "명조 전체 검토 120건" }));
    expect(await screen.findByRole("dialog", { name: "S36 확인" })).toHaveTextContent("범위 wuwa/-");
    await user().click(screen.getByRole("button", { name: "닫기" }));
    await user().click(screen.getByRole("button", { name: "전체 검토" }));
    expect(await screen.findByRole("dialog", { name: "S36 확인" })).toHaveTextContent("범위 -/-");
    await user().click(screen.getByRole("button", { name: "닫기" }));

    // Back returns to Home, which reads its total again.
    const calls = shadowApi.page.mock.calls.length;
    await user().click(screen.getByRole("button", { name: "홈으로 돌아가기" }));
    await waitFor(() => expect(flat(within(section("확인할 것")).getByRole("button", { name: /캐릭터 검토/ }))).toBe("320건캐릭터검토명조·백합"));
    expect(shadowApi.page.mock.calls.length).toBe(calls + 1);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("names the one waiting character on Home", async () => {
    renderHome({ props: { characters: targets, classifications, shadowApi: pagedApi(repeat("lala", "라라", 3)) } });
    const cell = await within(section("확인할 것")).findByRole("button", { name: /캐릭터 검토/ });
    await waitFor(() => expect(flat(cell)).toBe("3건캐릭터검토백합›라라"));
  });

  it("shows a reading state until the whole list is counted", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const characterSource = vi.fn(async (onProgress: (progress: { read: number; total: number | null }) => void) => {
      onProgress({ read: 200, total: 470 });
      await gate;
      return [{ targetId: "lala", targetName: "라라", automatic: 2, recommended: 0, other: 0 }];
    });
    renderHome({ props: { characters: targets, classifications, characterSource, shadowApi: pagedApi(repeat("lala", "라라", 2)) } });
    await user().click(await within(section("확인할 것")).findByRole("button", { name: /캐릭터 검토/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("후보 목록 읽는 중 · 200 / 470건");
    expect(screen.queryByRole("region", { name: "백합" })).not.toBeInTheDocument();
    release();
    expect(await screen.findByRole("region", { name: "백합" })).toHaveTextContent("라라");
  });

  it("skips the candidate reads in lightweight mode", async () => {
    workload.restricted = true;
    const shadowApi = pagedApi(repeat("lala", "라라", 3));
    const { view } = renderHome({ props: { characters: targets, classifications, shadowApi } });
    await waitFor(() => expect(within(section("자산 현황")).getByText(/이번 주/)).toBeInTheDocument());
    expect(shadowApi.page).not.toHaveBeenCalled();
    expect(within(section("확인할 것")).queryByRole("button", { name: /캐릭터 검토/ })).not.toBeInTheDocument();

    const rerender = () => view.rerender(<WorkspaceChromeProvider scope="home"><ChromeTarget name="navigation" />
      <HomeView collections={[]} reviewCount={0} unsortedCount={0} trashCount={0} onNavigate={vi.fn()} shadowApi={shadowApi} now={() => NOW}
        characters={targets} classifications={classifications} />
    </WorkspaceChromeProvider>);
    workload.restricted = false;
    rerender();
    await waitFor(() => expect(shadowApi.page).toHaveBeenCalledOnce());
    await user().click(await within(section("확인할 것")).findByRole("button", { name: /캐릭터 검토/ }));
    expect(await screen.findByRole("region", { name: "백합" })).toBeInTheDocument();

    // Turned on while the overview is open: a notice, no further reads.
    workload.restricted = true;
    rerender();
    expect(await screen.findByText("가벼운 모드")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "백합" })).not.toBeInTheDocument();
    await user().click(screen.getByRole("button", { name: "전체 후보 검토" }));
    expect(await screen.findByRole("dialog", { name: "S36 확인" })).toHaveTextContent("범위 -/-");
  });
});

const user = () => userEvent.setup();
