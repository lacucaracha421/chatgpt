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
vi.mock("../characters/ShadowReview", () => ({ ShadowReview: ({ onClose }: { onClose: () => void }) => <div role="dialog" aria-label="S36 확인"><button type="button" onClick={onClose}>닫기</button></div> }));
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

type Setup = { props?: Partial<HomeViewProps>; exchange?: Partial<ExchangeSnapshot>; notes?: Note[]; characters?: number };
function renderHome({ props = {}, exchange = {}, notes = [], characters = 0 }: Setup = {}) {
  const onNavigate = vi.fn();
  const shadowApi = { page: vi.fn().mockResolvedValue({ items: [], nextOffset: null, policyVersion: null, summary: { automatic: { pending: characters, accepted: 0, rejected: 0 }, recommended: { pending: 0, accepted: 0, rejected: 0 }, byOrigin: {} } }) };
  render(<WorkspaceChromeProvider scope="home"><ChromeTarget name="navigation" />
    <HomeView collections={[]} reviewCount={0} unsortedCount={0} trashCount={0} onNavigate={onNavigate} exchange={exchangeWith(exchange)} notes={notesWith(notes)}
      shadowApi={shadowApi} now={() => NOW} {...props} />
  </WorkspaceChromeProvider>);
  return { onNavigate, shadowApi };
}
const section = (name: string) => screen.getByRole("region", { name });
const head = (name: string) => screen.getByRole("button", { name: `${name} 열기` });

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(shadowApi.page).toHaveBeenCalledWith({ offset: 0, limit: 1 });
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
    await user.click(within(await screen.findByRole("dialog", { name: "S36 확인" })).getByRole("button", { name: "닫기" }));
    await user.click(within(todo).getByRole("button", { name: /중복 판본/ }));
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

const user = () => userEvent.setup();
