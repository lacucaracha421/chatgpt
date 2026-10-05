import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readHomeVisit, writeHomeVisit } from "./homeAttentionModel";
import { resetReleaseDataForTests } from "../collections/releaseData";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import type { AuthoritySyncHealth, HomeOverview, ReleaseWishlistItem } from "../library/types";
import { NotesStore, type Note } from "../notes/store";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { HomeView, type HomeViewProps } from "./HomeView";
import { AreaPainted, AreaRequested, AreaVisible } from "../shared/motion/AreaSwitch";
import { LaunchSplash, resetLaunchSplashForTests } from "../shared/launch/LaunchSplash";

const gateway = vi.hoisted(() => ({
  collectionTracking: { listInbox: vi.fn(), releaseBoard: vi.fn() },
  releaseCalendar: { calendar: vi.fn(), wishlist: vi.fn() },
  getHomeOverview: vi.fn(),
  getHomeMedia: vi.fn(),
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
vi.mock("../manga/CatalogReviewDialog", () => ({ CatalogReviewDialog: ({ onClose, onChange }: { onClose: () => void; onChange: () => void }) => <div role="dialog" aria-label="중복 후보 검토"><button type="button" onClick={onChange}>Save duplicate decision</button><button type="button" onClick={onClose}>닫기</button></div> }));

// Saturday 2026-09-26 14:31 local.
const NOW = new Date(2026, 8, 26, 14, 31);
const iso = (hours: number, minutes = 0) => new Date(2026, 8, 26, hours, minutes).toISOString();

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

beforeEach(() => {
  localStorage.clear();
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
  gateway.getHomeMedia.mockResolvedValue({ playing: [], dailyAsset: null });
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

describe('Home attention', () => {
  it('counts the actionable pending dialog queue and refreshes after a duplicate decision', async () => {
    const rows = Array.from({ length: 95 }, (_, id) => ({ leftAnchor: `${id}:left`, rightAnchor: `${id}:right`, state: 'pending', actionable: true }));
    gateway.listCatalogReview.mockResolvedValue({ rows: [...rows, { state: 'confirm', actionable: true }, { state: 'pending', actionable: false }], inspectedWorks: 0, comparisons: 0, skippedBuckets: 0 });
    renderHome();
    await userEvent.click(await screen.findByRole('button', { name: /중복 판본95/ }));
    const dialog = await screen.findByRole('dialog', { name: '중복 후보 검토' });
    gateway.listCatalogReview.mockResolvedValue({ rows: rows.slice(1), inspectedWorks: 0, comparisons: 0, skippedBuckets: 0 });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save duplicate decision' }));
    expect(await screen.findByRole('button', { name: /중복 판본94/ })).toBeVisible();
    await userEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '중복 후보 검토' })).toBeNull());
    expect(screen.getByRole('button', { name: /중복 판본94/ })).toBeVisible();
  });
  it('shows the existing shelf cases only for playing works and opens their work or Collections', async () => {
    const works = [
      { id: 'game', name: '진행 중 게임', type: 'game', platforms: 'PC', updatedAt: '1' },
      { id: 'movie', name: '진행 중 영화', type: 'movie', updatedAt: '1' },
      { id: 'done', name: '끝난 게임', type: 'game', updatedAt: '1' },
    ] as HomeViewProps['collections'];
    gateway.getHomeMedia.mockResolvedValue({ playing: [{ collectionId: 'game', ownedPlatform: 'PS5', myScore: 4.5 }, { collectionId: 'movie', ownedPlatform: null, myScore: 3 }], dailyAsset: null });
    const { onNavigate, view } = renderHome({ props: { collections: works } });
    const section = await screen.findByRole('region', { name: '지금 하는 중 · 2' });
    expect(within(section).getByText('PS5')).toBeTruthy();
    expect(within(section).getByRole('img', { name: '별점 4.5' })).toBeTruthy();
    expect(within(section).queryByText('끝난 게임')).toBeNull();
    expect(view.container.querySelectorAll('.collection-light-case')).toHaveLength(2);
    const game = within(section).getByRole('button', { name: '진행 중 게임 열기' });
    fireEvent.mouseEnter(game);
    expect(game.querySelector('.collection-light-case')?.hasAttribute('data-front')).toBe(true);
    fireEvent.click(game);
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'collection', collectionId: 'game' });
    fireEvent.click(within(section).getByRole('button', { name: '지금 하는 중 · 2 전체' }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'collections', typeFilter: 'game', showcase: false });
  });
  it('reserves the first layout until media arrives, then shows at most fourteen covers and opens the calendar', async () => {
    let finish!: (value: unknown) => void;
    gateway.getHomeMedia.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    gateway.releaseCalendar.wishlist.mockResolvedValue(Array.from({ length: 16 }, (_, i) => title(String(i), `발매 ${i}`, 'game', '2026-09-26')));
    const { view, onNavigate } = renderHome();
    await act(async () => {});
    expect(view.container.querySelector('.home-pc-layout')?.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('region', { name: /2주 안에 발매/ })).toBeNull();
    await act(async () => finish({ playing: [], dailyAsset: null }));
    const releases = await screen.findByRole('region', { name: '2주 안에 발매 · 16' });
    expect(view.container.querySelectorAll('.home-release-tile')).toHaveLength(14);
    expect(screen.queryByRole('region', { name: /지금 하는 중/ })).toBeNull();
    expect(view.container.querySelector('.home-pc-layout')?.getAttribute('aria-busy')).toBe('false');
    expect(view.container.querySelectorAll('.home-release-tile__when .ui-badge--accent')).toHaveLength(14);
    fireEvent.click(within(releases).getByRole('button', { name: '2주 안에 발매 · 16 전체' }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'collections', typeFilter: 'game', showcase: false, releaseCalendar: true });
  });
  it('orders nonzero reviews, routes them, and removes the old Home sections', async () => {
    gateway.getHomeOverview.mockResolvedValue(overview({ total: 48213, today: 10, week: 41 }, { capturesPending: 3 }, { tagger: { total: 7, recommendation: 7, veto: 0 } }));
    const { onNavigate } = renderHome({ props: { unsortedCount: 27, reviewCount: 2 } });
    const today = await screen.findByRole('region', { name: '오늘 할 것 · 4' });
    await waitFor(() => expect(within(today).getAllByRole('button').map(b => b.textContent)).toEqual(['□미분류 에셋27', '□유사 이미지 검토2쌍', '□처리 대기3', '□태거7']));
    fireEvent.click(within(today).getByRole('button', { name: /미분류 에셋/ }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'unsorted' });
    fireEvent.click(within(today).getByRole('button', { name: /유사 이미지 검토/ }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'similarity_review' });
    for (const label of ['자산 현황', '작가', 'AV 배우', '메모', '상태', '이어지는 시리즈', '즐겨찾는 배우']) expect(screen.queryByRole('region', { name: label })).toBeNull();
    expect(gateway.listAvFavorites).not.toHaveBeenCalled();
  });
  it('shows a quiet empty state and hides an empty revisit', async () => {
    gateway.getRevisitSlate.mockResolvedValue({ bundles: [] });
    renderHome();
    expect(await screen.findByText('즐겨찾는 이미지가 생기면 여기에 보여 드립니다')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /오늘 할 것/ })).toBeNull();
    expect(screen.queryByRole('region', { name: /1년 전 오늘/ })).toBeNull();
    expect(screen.queryByRole('region', { name: /새로 나옴/ })).toBeNull();
  });
  it('puts the monthly subscriptions and reminder before reviews and pinned text-body tasks', async () => {
    const subscription = { id: 'sub', name: 'Netflix', amount: 17000, every: 1, unit: 'month' as const, start: '2026-09-28', trial: true, until: null, remindDays: 3, memo: '', order: 'a' };
    const { onNavigate } = renderHome({ notes: [note('ledger', { type: 'ledger', pinned: false, recurring: [subscription] }), note('todo', { title: '피드백', type: 'text', body: '- [ ] 수정\n- [x] 완료' }), note('plain', { title: '글', body: '일반 글' })], props: { unsortedCount: 1 } });
    const today = await screen.findByRole('region', { name: '오늘 할 것 · 4' });
    await waitFor(() => expect(within(today).getAllByRole('button')).toHaveLength(4));
    const buttons = within(today).getAllByRole('button');
    expect(buttons.map(b => b.textContent)).toEqual(['○구독 이번 달 ₩17,000다음 결제 2일 후 · Netflix1개', '○Netflix 무료 끝남9.28 · ₩17,000부터 결제D-2', '□미분류 에셋1', '○피드백남은 항목 1개1']);
    fireEvent.click(buttons[3]!); expect(onNavigate).toHaveBeenCalledWith({ kind: 'notes', noteId: 'todo' });
  });
  it('shows connection failures only, using the problem wording rather than a last-success time', async () => {
    gateway.getOnlineCatalogStatus.mockResolvedValue({ installed: true, lastSuccessAt: iso(12), lastError: 'offline' });
    const { onNavigate } = renderHome();
    const button = await screen.findByRole('button', { name: /카탈로그갱신 실패/ });
    fireEvent.click(button); expect(onNavigate).toHaveBeenCalledWith({ kind: 'settings', section: 'catalog' });
    expect(screen.queryByText('동기화됨')).toBeNull();
    expect(screen.queryByText('연결됨')).toBeNull();
  });
  it('keeps NEW through refresh and a device revisit until opened', async () => {
    localStorage.setItem('lakomics.home.visit.v1:fixture', JSON.stringify({ lastVisit: '2026-09-24T00:00:00Z', pending: [], opened: [] }));
    gateway.releaseCalendar.wishlist.mockResolvedValue([title('game', '새 게임', 'game', '2026-09-25', { released: true })]);
    const { view, onNavigate } = renderHome();
    const card = await screen.findByRole('button', { name: /새 게임/ });
    expect(within(card).getByText('NEW')).toBeTruthy();
    view.unmount();
    const next = renderHome();
    const nextCard = await screen.findByRole('button', { name: /새 게임/ });
    expect(within(nextCard).getByText('NEW')).toBeTruthy();
    fireEvent.click(nextCard);
    expect(await screen.findByRole('dialog', {name:'새 게임'})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name:'발매 캘린더 열기'}));
    expect(next.onNavigate).toHaveBeenCalledWith({ kind: 'collections', typeFilter: 'game', showcase: false, releaseCalendar: true });
    await waitFor(() => expect(screen.queryByRole('button', { name: /새 게임/ })).toBeNull());
    expect(onNavigate).not.toHaveBeenCalled();
    next.view.unmount(); renderHome();
    await screen.findByRole('region', { name: '2주 안에 발매 · 0' });
    expect(screen.queryByRole('button', { name: /새 게임/ })).toBeNull();
  });
  it('lists only the next fourteen days, including today, across the month boundary', async () => {
    gateway.releaseCalendar.wishlist.mockResolvedValue([title('today', '오늘 작품', 'game', '2026-09-26'), title('edge', '경계 작품', 'game', '2026-10-10'), title('late', '나중 작품', 'game', '2026-10-11')]);
    renderHome();
    const region = await screen.findByRole('region', { name: '2주 안에 발매 · 2' });
    expect(within(region).getByText('오늘')).toBeTruthy();
    expect(within(region).getByText('D-14')).toBeTruthy();
    expect(screen.queryByText('나중 작품')).toBeNull();
  });
  it('keeps shown counts during an overview refresh and a failed read', async () => {
    gateway.getHomeOverview.mockResolvedValue(overview({total: 0, today: 0, week: 0}, {capturesPending: 3}));
    const store = notesWith([]);
    const props = { collections: [], reviewCount: 0, unsortedCount: 0, trashCount: 0, notes: store, onNavigate: vi.fn(), now: () => NOW };
    const view = render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><HomeView {...props}/></PrivacyProvider>);
    await screen.findByRole('button', {name: /처리 대기3/});
    let resolve!: (value: HomeOverview) => void;
    gateway.getHomeOverview.mockReturnValue(new Promise<HomeOverview>(r => {resolve = r;}));
    view.rerender(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><HomeView {...props} refreshVersion={1}/></PrivacyProvider>);
    expect(screen.getByRole('button', {name: /처리 대기3/})).toBeTruthy();
    await act(async () => resolve(overview({total: 0,today: 0,week: 0}, {capturesPending: 0})));
    await waitFor(() => expect(screen.queryByRole('button', {name: /처리 대기/})).toBeNull());
  });
  it('still opens and returns from the character review overview', async () => {
    const user = userEvent.setup();
    const { shadowApi } = renderHome({ characters: 2, candidates: [{targetId:'lara',targetName:'라라'}, {targetId:'lara',targetName:'라라'}] });
    await user.click(await screen.findByRole('button', {name:/캐릭터2/}));
    expect(await screen.findByRole('button', {name:'홈으로 돌아가기'})).toBeTruthy();
    await user.click(screen.getByRole('button', {name:'홈으로 돌아가기'}));
    expect(await screen.findByRole('button', {name:/캐릭터2/})).toBeTruthy();
    expect(shadowApi.page).toHaveBeenCalled();
  });
});

describe("Home visit read acknowledgement", () => {
  const previous = new Date(2026, 8, 24, 12).toISOString();
  const seedVisit = () => writeHomeVisit("fixture", { lastVisit: previous, pending: [], opened: [] });

  it("retains arrivals on re-entry and acknowledges only the new visit's completed reads", async () => {
    seedVisit();
    gateway.releaseCalendar.wishlist.mockResolvedValue([title("cached", "Cached release", "game", "2026-09-25")]);
    const notes = notesWith([]);
    const avLinkApi = {pendingCount: vi.fn().mockResolvedValue(3)} as unknown as HomeViewProps["avLinkApi"];
    const props = { collections: [], reviewCount: 0, unsortedCount: 0, trashCount: 0, notes, avLinkApi, onNavigate: vi.fn(), now: () => NOW };
    const tree = (active: boolean) => <AreaRequested.Provider value={active}><AreaPainted.Provider value={active}><AreaVisible.Provider value={active}>
      <PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><HomeView {...props} /></PrivacyProvider>
    </AreaVisible.Provider></AreaPainted.Provider></AreaRequested.Provider>;
    const view = render(tree(true));
    await screen.findByText("Cached release");
    const avRow = await screen.findByRole("button", {name: /AV 품번3/});
    await waitFor(() => expect(readHomeVisit("fixture").lastVisit).toBe(NOW.toISOString()));
    view.rerender(tree(false));
    const saved = readHomeVisit("fixture");
    writeHomeVisit("fixture", {...saved, lastVisit: previous});
    let finish!: (items: ReleaseWishlistItem[]) => void;
    gateway.releaseCalendar.wishlist.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    view.rerender(tree(true));
    expect(screen.getByRole("button", {name: /AV 품번3/})).toBe(avRow);
    expect(screen.getByText("Cached release")).toBeVisible();
    expect(readHomeVisit("fixture").lastVisit).toBe(previous);
    await act(async () => { finish([title("cached", "Cached release", "game", "2026-09-25"), title("fresh", "Fresh release", "game", "2026-09-26")]); });
    await within(screen.getByRole("region", {name: /2주 안에 발매/})).findByText("Fresh release");
    await waitFor(() => expect(readHomeVisit("fixture").lastVisit).toBe(NOW.toISOString()));
    expect(readHomeVisit("fixture").pending).toContain("title:fresh:2026-09-26:");
  });

  it("keeps the previous visit when leaving before release data arrives", async () => {
    seedVisit();
    gateway.releaseCalendar.wishlist.mockReturnValueOnce(new Promise(() => {}));
    const first = renderHome();
    await act(async () => {});
    expect(readHomeVisit("fixture").lastVisit).toBe(previous);
    first.view.unmount();
    gateway.releaseCalendar.wishlist.mockResolvedValue([title("late", "Late release", "game", "2026-09-25")]);
    renderHome();
    await screen.findByText("Late release");
    await waitFor(() => expect(readHomeVisit("fixture").pending).toContain("title:late:2026-09-25:"));
    expect(readHomeVisit("fixture").lastVisit).toBe(NOW.toISOString());
  });

  it.each(["wishlist", "calendar", "board"])("does not advance a visit after a failed %s read", async source => {
    seedVisit();
    const read = source === "board" ? gateway.collectionTracking.releaseBoard : gateway.releaseCalendar[source as "wishlist" | "calendar"];
    read.mockRejectedValueOnce(new Error("offline"));
    const first = renderHome();
    await act(async () => {});
    expect(readHomeVisit("fixture").lastVisit).toBe(previous);
    first.view.unmount();
    gateway.releaseCalendar.wishlist.mockResolvedValue([title("retry", "Recovered release", "game", "2026-09-25")]);
    renderHome();
    await screen.findByText("Recovered release");
    await waitFor(() => expect(readHomeVisit("fixture").lastVisit).toBe(NOW.toISOString()));
    expect(readHomeVisit("fixture").pending).toContain("title:retry:2026-09-25:");
  });
});

describe("Home wishlist arrivals", () => {
  it.each(["2026-09-25", "2026-09-26"])("never marks an unwished calendar movie NEW on %s, including a saved pending arrival", async date => {
    writeHomeVisit("fixture", { lastVisit: new Date(2026, 8, 24).toISOString(), pending: [`title:digger:${date}:`], opened: [] });
    gateway.releaseCalendar.calendar.mockResolvedValue({ entries: [title("digger", "디거", "movie", date, { region: "korea" })], sources: [] });
    renderHome();
    await waitFor(() => expect(readHomeVisit("fixture").lastVisit).toBe(NOW.toISOString()));
    expect(screen.queryByText("디거")).toBeNull();
    expect(screen.queryByText("NEW")).toBeNull();
  });

  it("keeps a wished movie's unread release NEW even before the previous visit, unless muted", async () => {
    writeHomeVisit("fixture", { lastVisit: NOW.toISOString(), pending: [], opened: [] });
    const watched = title("wish", "관심 영화", "movie", "2026-09-23", { released: true, unread: [{ id: "event", itemId: "wish", kind: "released", previousValue: null, currentValue: "2026-09-23", detectedAt: iso(12), readAt: null }] });
    gateway.releaseCalendar.wishlist.mockResolvedValue([watched, { ...watched, id: "muted", title: "조용한 영화", muted: true }]);
    renderHome();
    const row = await screen.findByRole("button", { name: /관심 영화/ });
    expect(within(row).getByText("NEW")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /조용한 영화/ })).toBeNull();
  });
});

it('keeps the saved visit until collections have successfully loaded and their arrivals are displayed', async () => {
  const previous = new Date(2026,8,24).toISOString();
  writeHomeVisit('fixture', {lastVisit: previous, pending: [], opened: []});
  const store=notesWith([]);
  const props={collections: [], collectionsReady: false, reviewCount: 0, unsortedCount: 0, trashCount: 0, notes: store, onNavigate: vi.fn(), now: () => NOW};
  const view=render(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><HomeView {...props}/></PrivacyProvider>);
  await act(async () => {});
  expect(view.container.querySelector('.home-pc-layout')?.getAttribute('aria-busy')).toBe('true');
  expect(readHomeVisit('fixture').lastVisit).toBe(previous);
  view.rerender(<PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><HomeView {...props} collectionsReady collections={[{id:'owned',name:'늦게 읽은 게임',type:'game',releaseDate:'2026-09-25'} as HomeViewProps['collections'][number]]}/></PrivacyProvider>);
  const card=await screen.findByRole('button',{name:/늦게 읽은 게임/});
  expect(within(card).getByText('NEW')).toBeTruthy();
  await waitFor(()=>expect(readHomeVisit('fixture').lastVisit).toBe(NOW.toISOString()));
});

it("covers Home's first load on app start with the launch splash, leaves when Home is ready, and never returns", async () => {
  resetLaunchSplashForTests();
  let finish!: (value: unknown) => void;
  gateway.getHomeMedia.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const splash = render(<LaunchSplash elapsed={() => 0} />);
  const first = renderHome();
  await act(async () => {});
  expect(screen.getByRole("status", { name: "Lakomics 여는 중" })).not.toHaveAttribute("data-state");
  expect(first.view.container.querySelector(".home-pc-layout")?.getAttribute("aria-busy")).toBe("true");
  await act(async () => finish({ playing: [], dailyAsset: null }));
  await waitFor(() => expect(document.querySelector(".launch-splash")).toBeNull());
  // A later first load (e.g. after switching library) shows the usual skeleton, not the splash.
  first.view.unmount();
  gateway.getHomeMedia.mockReturnValueOnce(new Promise(() => undefined));
  const later = renderHome();
  await act(async () => {});
  expect(later.view.container.querySelector(".home-pc-layout")?.getAttribute("aria-busy")).toBe("true");
  expect(document.querySelector(".launch-splash")).toBeNull();
  splash.unmount();
});
