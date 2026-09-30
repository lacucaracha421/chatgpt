import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetReleaseDataForTests } from "../collections/releaseData";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import type { AuthoritySyncHealth, CollectionSummary, HomeOverview, ReleaseBoardEntry, ReleaseWishlistItem } from "../library/types";
import { NotesStore, type Note } from "../notes/store";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import type { AvLinkApi } from "../collections/AvLinkInbox";
import { HomeView, type HomeViewProps } from "./HomeView";

const gateway = vi.hoisted(() => ({
  collectionTracking: { listInbox: vi.fn(), releaseBoard: vi.fn() },
  releaseCalendar: { calendar: vi.fn(), wishlist: vi.fn() },
  getHomeOverview: vi.fn(),
  getOnlineCatalogStatus: vi.fn(),
  listCatalogReview: vi.fn(),
  cloudBackfillProgress: vi.fn(),
  authoritySyncHealth: vi.fn(),
  getRevisitSlate: vi.fn(),
  listContinueItems: vi.fn(),
  listAvFavorites: vi.fn(),
}));
vi.mock("../library/LibraryContext", () => ({ useLibrary: () => ({ gateway, library: { root: "fixture" } }) }));
const artistFixture = vi.hoisted(() => ({ gateway: null as unknown, rows: null as unknown }));
vi.mock("../artists/artistStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../artists/artistStore")>();
  return {
    ...actual,
    useArtistGateway: () => artistFixture.gateway,
    useArtistRead: () => ({ data: artistFixture.gateway ? artistFixture.rows : null, error: null }),
  };
});
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
const overview = (assets: Pick<HomeOverview["assets"], "total" | "today" | "week"> & Partial<HomeOverview["assets"]>, server: Partial<NonNullable<HomeOverview["server"]>> = {}, extra: Partial<HomeOverview> = {}): HomeOverview =>
  ({ failed: [], assets: { images: assets.total, videos: 0, ...assets }, collections: { game: 0, manga: 0, movie: 0, av: 0 },
    tagger: { total: 0, recommendation: 0, veto: 0 }, avPerformer: null,
    server: { configured: true, live: true, confirmedAt: iso(14, 30), capturesPending: 0, ...server }, ...extra });
const healthy: AuthoritySyncHealth = {
  albums: { blockedCount: 0, waitingCount: 0, droppedCount: 0, lastDropReason: null, lastDroppedAt: null } as never,
  classifications: { blockedCount: 0, waitingCount: 0, droppedCount: 0, lastDropReason: null, lastDroppedAt: null } as never,
  assets: { rejectedCount: 0, rejectedReason: null, stopped: false },
  characterExclusions: { skippedCount: 0, lastSkipReason: null, lastSkippedAt: null },
  authorityPassFailure: null, assetLaneFailure: null,
};
const note = (id: string, fields: Partial<Note>): Note => ({ id, title: "", body: "", pinned: true, deleted: false, createdAt: iso(1), updatedAt: iso(1), localRevision: 1, pending: false, conflict: false, ...fields });

function notesWith(notes: Note[]) {
  return new NotesStore(async <T,>() => ({ unlocked: true, notes, lastSyncedAt: null }) as T);
}

type Candidate = { targetId: string; targetName: string };
type Setup = { props?: Partial<HomeViewProps>; notes?: Note[]; characters?: number; candidates?: Candidate[]; privacy?: boolean };
function renderHome({ props = {}, notes = [], characters = 0, candidates = [], privacy = false }: Setup = {}) {
  const onNavigate = vi.fn();
  const shadowApi = { page: vi.fn().mockResolvedValue({ items: candidates, nextOffset: null, policyVersion: null, summary: { automatic: { pending: Math.max(characters, candidates.length), accepted: 0, rejected: 0 }, recommended: { pending: 0, accepted: 0, rejected: 0 }, byOrigin: {} } }) };
  const view = render(<PrivacyProvider privacyMode={privacy} setPrivacyMode={vi.fn()}><WorkspaceChromeProvider scope="home"><ChromeTarget name="navigation" />
    <HomeView collections={[]} reviewCount={0} unsortedCount={0} trashCount={0} onNavigate={onNavigate} notes={notesWith(notes)}
      shadowApi={shadowApi} now={() => NOW} {...props} />
  </WorkspaceChromeProvider></PrivacyProvider>);
  return { onNavigate, shadowApi, view };
}
const section = (name: string) => screen.getByRole("region", { name });

beforeEach(() => {
  vi.clearAllMocks();
  workload.restricted = false;
  resetReleaseDataForTests();
  gateway.collectionTracking.listInbox.mockResolvedValue([]);
  gateway.collectionTracking.releaseBoard.mockResolvedValue([]);
  gateway.releaseCalendar.wishlist.mockResolvedValue([]);
  gateway.getRevisitSlate.mockResolvedValue({ localDate: "2026-09-26", createdAt: "", revision: 1, bundles: [{ id: "b1", kind: "date", title: "과거 수집함", reason: "이맘때 수집한 오래된 자료", assetIds: ["d1", "d2"], revision: 1 }] });
  gateway.releaseCalendar.calendar.mockResolvedValue({ rangeStart: "2026-09-26", rangeEnd: "2027-03-26", entries: [], sources: [
    { provider: "igdb", fetchedAt: iso(12, 31), attemptedAt: null, errorCode: null, due: false }, { provider: "tmdb", fetchedAt: iso(12, 31), attemptedAt: null, errorCode: null, due: false }] });
  gateway.getHomeOverview.mockResolvedValue(overview({ total: 48213, today: 0, week: 41 }));
  gateway.getOnlineCatalogStatus.mockResolvedValue({ installed: true, workCount: 1, updateEnabled: true, updateIntervalSeconds: 3600, lastAttemptAt: iso(14, 19), lastSuccessAt: iso(14, 19), lastAdded: 0, lastError: null, streams: [] });
  gateway.listCatalogReview.mockResolvedValue({ rows: [], inspectedWorks: 0, comparisons: 0, skippedBuckets: 0 });
  gateway.cloudBackfillProgress.mockResolvedValue({ controlState: "idle", totalAssets: 1, queued: 0, preparing: 0, uploading: 0, committing: 0, completed: 1, failed: 0, activeWorkers: 0, lastError: null });
  gateway.authoritySyncHealth.mockResolvedValue(healthy);
  gateway.listContinueItems.mockResolvedValue([]);
  gateway.listAvFavorites.mockResolvedValue([]);
});
afterEach(() => {
  artistFixture.gateway = null;
  artistFixture.rows = null;
  cleanup();
});

describe("HomeView", () => {
  it("omits resume content and its read even when legacy progress is available", async () => {
    gateway.listContinueItems.mockResolvedValue([{ kind: "manga", id: "manga-1", provider: null, title: "던전밥", thumbnailRevision: null, position: 112, total: 196, updatedAt: iso(13) }]);
    const series = work("m1", "던전밥");
    gateway.collectionTracking.releaseBoard.mockResolvedValue([entry("m1", 3, [{ volumeNumber: 4, date: "2026-09-20" }])]);
    renderHome({ props: { collections: [series] } });

    const section = await screen.findByRole("region", { name: "이어지는 시리즈" });
    expect(section.parentElement).toHaveClass("home-grid__left");
    expect(section.previousElementSibling).toHaveClass("home-grid__duo");
    expect(screen.queryByRole("region", { name: "이어 보기" })).toBeNull();
    expect(document.querySelector('[class*="home-continue"]')).toBeNull();
    expect(gateway.listContinueItems).not.toHaveBeenCalled();
  });

  it("renders 이어지는 시리즈 rows and opens the collection", async () => {
    const series = work("m1", "던전밥");
    gateway.collectionTracking.releaseBoard.mockResolvedValue([entry("m1", 3, [{ volumeNumber: 4, date: "2026-09-20" }])]);
    const { onNavigate } = renderHome({ props: { collections: [series] } });

    const seriesSection = await screen.findByRole("region", { name: "이어지는 시리즈" });
    expect(seriesSection).toHaveTextContent("던전밥3권까지 소장다음 9.20");
    await user().click(within(seriesSection).getByRole("button", { name: "던전밥 이어지는 시리즈" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "collection", collectionId: "m1" });
  });

  it("renders favourite performers and hides them in privacy mode", async () => {
    gateway.listAvFavorites.mockResolvedValue([{ id: "person-1", displayName: "미카미 유아", originalName: null, portrait: null, ownedWorkCount: 4, recentOwnedCount: 2, createdAt: iso(12) }]);
    const { onNavigate } = renderHome();

    const favorites = await screen.findByRole("region", { name: "즐겨찾는 배우" });
    expect(favorites).toHaveTextContent("미카미 유아");
    await user().click(within(favorites).getByRole("button", { name: "미카미 유아 배우 페이지" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "av", showcase: false });

    cleanup();
    renderHome({ privacy: true });
    await waitFor(() => expect(screen.queryByRole("region", { name: "즐겨찾는 배우" })).not.toBeInTheDocument());
  });

  it("renders up to two memo blocks with checklist details and the quiet add row", async () => {
    const items = ["**우유**", "- [ ] 커피 원두", "[세제 리필](https://example.test)", "건전지 AA", "택배 상자", "여섯 번째"].map((text, index) => ({ id: `i${index}`, text, checked: index < 2, order: String.fromCharCode(97 + index) }));
    const { onNavigate } = renderHome({ notes: [
      note("n1", { title: "장보기", type: "checklist", items, updatedAt: iso(5) }),
      note("n2", { title: "가계부", type: "ledger", income: 500000, recurring: [], planned: [], updatedAt: iso(4) }),
      note("n3", { title: "세 번째 메모", body: "보이면 안 되는 세 번째 메모", updatedAt: iso(3) }),
    ] });
    const index = screen.getByRole("navigation", { name: "홈 인덱스" });
    await waitFor(() => expect(within(index).getByRole("button", { name: /장보기/ })).toBeInTheDocument());
    expect(index.querySelectorAll(".home-memo-tile")).toHaveLength(2);
    expect(within(index).getByRole("button", { name: /장보기/ })).toHaveTextContent("우유커피 원두세제 리필건전지 AA택배 상자");
    expect(within(index).queryByText("여섯 번째")).not.toBeInTheDocument();
    expect(within(index).getByRole("button", { name: /가계부/ })).toHaveTextContent("500,000원쓴 돈0하루100,000");
    expect(within(index).queryByText("세 번째 메모")).not.toBeInTheDocument();
    await user().click(within(index).getByRole("button", { name: "메모 전체" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "notes" });
    await user().click(within(index).getByRole("button", { name: "새 메모" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "notes" });
  });

  it("orders the D index, renders status rows from the shared hook, and hides zero review rows", async () => {
    gateway.getHomeOverview.mockResolvedValue(overview({ total: 48213, today: 146, week: 812, images: 41230, videos: 1204 }, { capturesPending: 23 }, { collections: { game: 84, manga: 212, movie: 57, av: 31 }, tagger: { total: 3, recommendation: 2, veto: 1 } }));
    gateway.listCatalogReview.mockResolvedValue({ rows: [{ state: "pending", actionable: true }, { state: "pending", actionable: true }], inspectedWorks: 0, comparisons: 0, skippedBuckets: 0 });
    const avLinkApi = { pendingCount: vi.fn().mockResolvedValue(4) } as unknown as AvLinkApi;
    const { onNavigate } = renderHome({ props: { reviewCount: 6, unsortedCount: 318, trashCount: 37, avLinkApi }, characters: 14 });
    const index = screen.getByRole("navigation", { name: "홈 인덱스" });
    await waitFor(() => expect(within(index).getByRole("button", { name: /41,230이미지/ })).toBeInTheDocument());
    expect([...index.querySelectorAll("[aria-label]")].map((element) => element.getAttribute("aria-label")).filter((label) => ["메모", "자산 현황", "상태"].includes(label ?? ""))).toEqual(["메모", "자산 현황", "상태"]);
    const todo = section("검토");
    await waitFor(() => expect(within(todo).getAllByRole("button").map((button) => button.textContent?.replace(/\s+/g, ""))).toEqual([
      "캐릭터14", "태거3", "유사이미지6쌍", "중복판본2", "미분류318", "AV품번4", "처리대기23"]));
    expect(within(todo).queryByText("같은 그림일 수 있음")).not.toBeInTheDocument();
    await user().click(within(todo).getByRole("button", { name: /유사 이미지/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "similarity_review" });
    await user().click(within(todo).getByRole("button", { name: /처리 대기/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "settings", section: "connection" });
    expect(within(index).getByRole("button", { name: "서버 연결됨" })).toBeInTheDocument();
    expect(within(index).getByRole("button", { name: /카탈로그/ })).toBeInTheDocument();
    expect(within(index).getByRole("button", { name: /발매 캘린더/ })).toBeInTheDocument();

    cleanup();
    gateway.getHomeOverview.mockResolvedValue(overview({ total: 0, today: 0, week: 0 }));
    gateway.listCatalogReview.mockResolvedValue({ rows: [], inspectedWorks: 0, comparisons: 0, skippedBuckets: 0 });
    renderHome();
    // The character count is read first (a reading row), then the section settles.
    expect(await within(section("검토")).findByText("모두 확인함")).toBeInTheDocument();
    expect(within(section("검토")).queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps all calendar rows, drops the old chips and navigates from the section chevron", async () => {
    const sea = work("m1", "바다 건너 편지", { unreadReleaseCount: 1 });
    const star = work("m2", "별빛 식당");
    gateway.collectionTracking.releaseBoard.mockResolvedValue([entry("m1", 12, [{ volumeNumber: 13, date: "2026-09-24" }]), entry("m2", 7, [{ volumeNumber: 8, date: "2026-09-30" }])]);
    gateway.collectionTracking.listInbox.mockResolvedValue([{ collectionId: "m1", collectionName: "바다 건너 편지", provider: "kakao", event: { id: "e1", kind: "new_volume", volumeNumber: 13, previousValue: null, currentValue: "2026-09-24", detectedAt: iso(9) } }]);
    gateway.releaseCalendar.wishlist.mockResolvedValue([
      title("igdb:1", "들판의 기록 II", "game", "2026-09-25", { released: true, unread: [{ id: "w1", itemId: "igdb:1", kind: "released", previousValue: null, currentValue: "2026-09-25", detectedAt: iso(8), readAt: null }] }),
      title("tmdb:2", "여름의 끝", "movie", "2026-10-15", { unread: [{ id: "w2", itemId: "tmdb:2", kind: "date_changed", previousValue: "2026-10-22", currentValue: "2026-10-15", detectedAt: iso(7), readAt: null }] }),
    ]);
    const { onNavigate } = renderHome({ props: { collections: [sea, star] } });
    const shelf = section("캘린더");
    await waitFor(() => expect(within(shelf).getByRole("button", { name: /바다 건너 편지/ })).toBeInTheDocument());
    expect(within(shelf).queryByRole("radio")).not.toBeInTheDocument();
    expect(within(shelf).queryByText("날짜 바뀜")).not.toBeInTheDocument();
    await user().click(within(shelf).getByRole("button", { name: "캘린더 전체" }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "collections", typeFilter: "game", showcase: false, releaseCalendar: true });
  });

  it("renders the revisit mosaic, today's artist strip, and the compact AV block", async () => {
    artistFixture.gateway = {};
    artistFixture.rows = [{ artist: { id: "artist:moon", label: "달그림자", assetCount: 42, coverAssetIds: ["portrait"], pinned: false }, kind: "unseen", reason: "숨겨야 하는 이유", assetIds: ["a1", "a2"] }];
    const latest = { collectionId: "av-1", productCode: "MOCK-417", title: "여름 끝의 약속", releaseDate: "2026-09-12", frontArtworkId: "cover-1" };
    gateway.getHomeOverview.mockResolvedValue(overview({ total: 48213, today: 0, week: 41 }, {}, { collections: { game: 0, manga: 0, movie: 0, av: 9 }, avPerformer: { id: "person-1", displayName: "하야세 미오", originalName: "早瀬みお", knownWorks: 24, ownedWorks: 9, latestWork: latest, recentOwnedWorks: [latest, { ...latest, collectionId: "av-2", frontArtworkId: "cover-2" }, { ...latest, collectionId: "av-3", frontArtworkId: "cover-3" }], portrait: null } }));
    const { onNavigate } = renderHome({ privacy: true });
    const revisit = await screen.findByRole("region", { name: "1년 전 오늘" });
    expect(revisit).toHaveTextContent("1년 전 오늘2장");
    expect(revisit.querySelectorAll("img")).toHaveLength(0);
    const artist = screen.getByRole("region", { name: "작가" });
    expect(artist).toHaveTextContent("달그림자42장");
    expect(artist).not.toHaveTextContent("숨겨야 하는 이유");
    await user().click(within(artist).getByRole("button", { name: /달그림자/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: "creator", creatorKey: "artist:moon" });
    cleanup();

    renderHome();
    expect(screen.getByRole("region", { name: "AV 배우" })).toBeInTheDocument();
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

  it("uses the narrow pending summary for the Home count", async () => {
    const shadowApi = {
      page: vi.fn(),
      summary: vi.fn().mockResolvedValue({
        automatic: 310,
        recommended: 160,
        targets: [{ targetId: "lala", targetName: "라라", automatic: 180, recommended: 20 }],
      }),
    };
    renderHome({ props: { characters: targets, classifications, shadowApi } });
    const cell = await within(section("검토")).findByRole("button", { name: /캐릭터/ });
    await waitFor(() => expect(flat(cell)).toBe("캐릭터470"));
    expect(shadowApi.summary).toHaveBeenCalledOnce();
    expect(shadowApi.page).not.toHaveBeenCalled();
  });

  it("shows the exact total on Home and opens an overview read in full", async () => {
    const items = [...repeat("mari", "마리", 150), ...repeat("geum", "금희", 120, "recommended"), ...repeat("lala", "라라", 180), ...repeat("lala", "라라", 20, "recommended")];
    const shadowApi = pagedApi(items);
    const { onNavigate } = renderHome({ props: { characters: targets, classifications, shadowApi } });
    const todo = section("검토");
    const cell = await within(todo).findByRole("button", { name: /캐릭터/ });
    // One page on Home: the total from the summary, the series seen so far as a hint.
    await waitFor(() => expect(flat(cell)).toBe("캐릭터470"));
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
    await waitFor(() => expect(flat(within(section("검토")).getByRole("button", { name: /캐릭터/ }))).toBe("캐릭터320"));
    expect(shadowApi.page.mock.calls.length).toBe(calls + 1);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("names the one waiting character on Home", async () => {
    renderHome({ props: { characters: targets, classifications, shadowApi: pagedApi(repeat("lala", "라라", 3)) } });
    const cell = await within(section("검토")).findByRole("button", { name: /캐릭터/ });
    await waitFor(() => expect(flat(cell)).toBe("캐릭터3"));
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
    await user().click(await within(section("검토")).findByRole("button", { name: /캐릭터/ }));
    expect(await screen.findByRole("status")).toHaveTextContent("후보 목록 읽는 중 · 200 / 470건");
    expect(screen.queryByRole("region", { name: "백합" })).not.toBeInTheDocument();
    release();
    expect(await screen.findByRole("region", { name: "백합" })).toHaveTextContent("라라");
  });

  it("skips the candidate reads in lightweight mode", async () => {
    workload.restricted = true;
    const shadowApi = pagedApi(repeat("lala", "라라", 3));
    const { view } = renderHome({ props: { characters: targets, classifications, shadowApi } });
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "홈 인덱스" })).getByText(/이번 주/)).toBeInTheDocument());
    expect(shadowApi.page).not.toHaveBeenCalled();
    expect(within(section("검토")).queryByRole("button", { name: /캐릭터/ })).not.toBeInTheDocument();

    const rerender = () => view.rerender(<WorkspaceChromeProvider scope="home"><ChromeTarget name="navigation" />
      <HomeView collections={[]} reviewCount={0} unsortedCount={0} trashCount={0} onNavigate={vi.fn()} shadowApi={shadowApi} now={() => NOW}
        characters={targets} classifications={classifications} />
    </WorkspaceChromeProvider>);
    workload.restricted = false;
    rerender();
    await waitFor(() => expect(shadowApi.page).toHaveBeenCalledOnce());
    await user().click(await within(section("검토")).findByRole("button", { name: /캐릭터/ }));
    expect(await screen.findByRole("region", { name: "백합" })).toBeInTheDocument();

    // Turned on while the overview is open: a notice, no further reads.
    workload.restricted = true;
    rerender();
    expect(await screen.findByText("절약 모드")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "백합" })).not.toBeInTheDocument();
    await user().click(screen.getByRole("button", { name: "전체 후보 검토" }));
    expect(await screen.findByRole("dialog", { name: "S36 확인" })).toHaveTextContent("범위 -/-");
  });
});

const user = () => userEvent.setup();

describe("avProfileLines", () => {
  it("writes birth date with age, body and career in short lines", async () => {
    const { avProfileLines } = await import("./homeModel");
    expect(avProfileLines({ birthDate: "1998-03-02", heightCm: 158, bandIn: 32.7, waistIn: 22.4, hipIn: 33.5, cup: "D", careerStart: 2019, careerEnd: null }, new Date(2026, 8, 29)))
      .toEqual(["1998.3.2 · 28세", "158cm · B83(D) W57 H85", "2019– · 7년차"]);
    expect(avProfileLines({ birthDate: null, heightCm: null, bandIn: null, waistIn: null, hipIn: null, cup: null, careerStart: null, careerEnd: null }, new Date())).toEqual([]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

describe("Home failure and loading regressions", () => {
  it("reserves AV and asset sections and waits for both shelf sources before empty wording", async () => {
    const read = deferred<HomeOverview>();
    const wishlist = deferred<ReleaseWishlistItem[]>();
    gateway.getHomeOverview.mockReturnValue(read.promise);
    gateway.releaseCalendar.wishlist.mockReturnValue(wishlist.promise);
    renderHome();
    expect(section("AV 배우").querySelector(".home-av-performer")).toBeTruthy();
    expect(section("자산 현황").querySelector(".home-assets")).toBeTruthy();
    expect(within(section("캘린더")).queryByText("새 신간 없음")).toBeNull();
    await act(async () => { read.resolve(overview({total: 10, today: 1, week: 4})); });
    expect(within(section("캘린더")).queryByText("새 신간 없음")).toBeNull();
    await act(async () => { wishlist.resolve([]); });
    expect(await within(section("캘린더")).findByText("새 신간 없음")).toBeTruthy();
    expect(section("AV 배우").querySelector(".home-av-performer")).toBeTruthy();
  });

  it("reports an overview failure in place and recovers through retry", async () => {
    gateway.getHomeOverview.mockRejectedValueOnce(new Error("unavailable"));
    renderHome();
    const assets = section("자산 현황");
    const retry = await within(assets).findByRole("button", {name: "다시 시도"});
    expect(section("AV 배우")).toBeTruthy();
    expect(section("검토")).not.toHaveTextContent("모두 확인함");
    await user().click(retry);
    expect(await within(assets).findByRole("button", {name: /48,213이미지/})).toBeTruthy();
  });

  it("keeps successful counts when optional overview reads fail and retries", async () => {
    gateway.getHomeOverview.mockResolvedValueOnce(overview({total: 10, today: 1, week: 4}, {}, {
      tagger: null, server: null, avPerformer: null, failed: ["tagger", "server", "avPerformer"],
    } as unknown as Partial<HomeOverview>));
    renderHome();
    expect(await within(section("자산 현황")).findByRole("button", {name: /10이미지/})).toBeTruthy();
    expect(await within(section("AV 배우")).findByRole("button", {name: "다시 시도"})).toBeTruthy();
    expect(section("검토")).not.toHaveTextContent("모두 확인함");
    await user().click(within(section("검토")).getAllByRole("button", {name: "다시 시도"})[0]);
    expect(await within(section("검토")).findByText("모두 확인함")).toBeTruthy();
  });

  it("does not claim all clear while overview or duplicate counts are pending", async () => {
    const read = deferred<HomeOverview>();
    const duplicates = deferred<{rows: {state: string; actionable: boolean}[]}>();
    gateway.getHomeOverview.mockReturnValue(read.promise);
    gateway.listCatalogReview.mockReturnValue(duplicates.promise);
    renderHome({props: {avLinkApi: {pendingCount: vi.fn().mockResolvedValue(0)} as unknown as AvLinkApi}});
    await act(async () => {});
    expect(section("검토")).not.toHaveTextContent("모두 확인함");
    await act(async () => { read.resolve(overview({total: 0, today: 0, week: 0})); });
    expect(section("검토")).not.toHaveTextContent("모두 확인함");
    await act(async () => { duplicates.resolve({rows: [{state: "pending", actionable: true}]}); });
    expect(await within(section("검토")).findByRole("button", {name: /중복 판본/})).toBeTruthy();
    expect(section("검토")).not.toHaveTextContent("모두 확인함");
  });

  it("updates the date, D-day and today's count at midnight without reloading the shelf", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 8, 26, 23, 59, 59));
      gateway.releaseCalendar.wishlist.mockResolvedValue([title("game", "내일 게임", "game", "2026-09-27")]);
      gateway.getHomeOverview.mockResolvedValueOnce(overview({total: 10, today: 5, week: 8}))
        .mockResolvedValue(overview({total: 10, today: 0, week: 8}));
      renderHome({props: {now: () => new Date()}});
      await act(async () => {});
      expect(screen.getByText("D-1")).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(document.querySelector(".home-title-date")).toHaveTextContent("9.27");
      expect(screen.queryByText("D-1")).toBeNull();
      expect(within(section("자산 현황")).getByRole("button", {name: "오늘 +0"})).toBeTruthy();
      expect(gateway.getHomeOverview).toHaveBeenCalledTimes(2);
      expect(gateway.collectionTracking.releaseBoard).toHaveBeenCalledOnce();
      expect(gateway.releaseCalendar.wishlist).toHaveBeenCalledOnce();
      cleanup();
    } finally { vi.useRealTimers(); }
  });
});

it("keeps shown overview content during refresh and optional failure", async () => {
  const latest = {collectionId: "av", productCode: null, title: "소장 작품", releaseDate: null, frontArtworkId: null};
  const pick: NonNullable<HomeOverview["avPerformer"]> = {id: "person", displayName: "보이는 배우", originalName: null, knownWorks: 4, ownedWorks: 2, latestWork: latest, recentOwnedWorks: [], portrait: null};
  gateway.getHomeOverview.mockResolvedValueOnce(overview({total: 10, today: 1, week: 4}, {}, {avPerformer: pick, tagger: {total: 3, recommendation: 3, veto: 0}}));
  const {view} = renderHome();
  expect(await within(section("AV 배우")).findByText("보이는 배우")).toBeTruthy();
  const read = deferred<HomeOverview>();
  gateway.getHomeOverview.mockReturnValueOnce(read.promise);
  view.rerender(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><WorkspaceChromeProvider scope="home"><ChromeTarget name="navigation" /><HomeView collections={[]} reviewCount={0} unsortedCount={0} trashCount={0} refreshVersion={1} onNavigate={vi.fn()} now={() => NOW} /></WorkspaceChromeProvider></PrivacyProvider>);
  expect(section("AV 배우")).toHaveTextContent("보이는 배우");
  expect(section("AV 배우").querySelector(".home-av-performer")).toHaveAttribute("inert");
  expect(within(section("자산 현황")).getByRole("button", {name: /10이미지/})).toBeTruthy();
  await act(async () => { read.resolve(overview({total: 11, today: 2, week: 5}, {}, {tagger: null, avPerformer: null, failed: ["tagger", "avPerformer"]})); });
  expect(section("AV 배우")).toHaveTextContent("보이는 배우");
  expect(await within(section("AV 배우")).findByRole("button", {name: "다시 시도"})).toBeTruthy();
  expect(section("검토").textContent?.match(/태거/g)).toHaveLength(1);
  expect(section("검토")).toHaveTextContent("태거3");
});

it("does not show all clear while the AV count is still pending", async () => {
  const count = deferred<number>();
  renderHome({props: {avLinkApi: {pendingCount: () => count.promise} as unknown as AvLinkApi}});
  await act(async () => {});
  expect(section("검토")).not.toHaveTextContent("모두 확인함");
  await act(async () => { count.resolve(4); });
  expect(await within(section("검토")).findByRole("button", {name: /AV 품번/})).toHaveTextContent("4");
});
