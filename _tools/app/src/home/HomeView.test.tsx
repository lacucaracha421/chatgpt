import { confirmSourceFor, shadowItem } from "../characters/confirmTestKit";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readHomeVisit, writeHomeVisit } from "./homeAttentionModel";
import { readWishlistCache, writeWishlistCache } from "./homeReleaseCache";
import { resetReleaseDataForTests } from "../collections/releaseData";
import { ChromeTarget, WorkspaceChromeProvider } from "../layout/WorkspaceChrome";
import type { AuthoritySyncHealth, HomeOverview, ReleaseWishlistItem } from "../library/types";
import { NotesStore, type Note } from "../notes/store";
import { PrivacyProvider } from "../privacy/PrivacyContext";
import { HomeView, type HomeViewProps } from "./HomeView";
import { AreaPainted, AreaRequested, AreaVisible } from "../shared/motion/AreaSwitch";
import { LaunchSplash, resetLaunchSplashForTests } from "../shared/launch/LaunchSplash";

vi.mock("../cards/packCover", () => ({ composePackCover: async () => "" }));

const gateway = vi.hoisted(() => ({
  collectionTracking: { listInbox: vi.fn(), releaseBoard: vi.fn() },
  releaseCalendar: { calendar: vi.fn(), wishlist: vi.fn(), acknowledge: vi.fn() },
  getHomeOverview: vi.fn(),
  listAssetDateBuckets: vi.fn(),
  getHomeMedia: vi.fn(),
  getOnlineCatalogStatus: vi.fn(),
  listCatalogReview: vi.fn(),
  getCatalogReviewCount: undefined as undefined | ReturnType<typeof vi.fn>,
  cloudBackfillProgress: vi.fn(),
  authoritySyncHealth: vi.fn(),
  getRevisitSlate: vi.fn(),
  listContinueItems: vi.fn(),
  listAvFavorites: vi.fn(),
}));
vi.mock("../library/LibraryContext", () => ({ useLibrary: () => ({ gateway, library: { root: "fixture" } }), useOptionalLibrary: () => null }));
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
vi.mock("../characters/ConfirmList", () => ({ ConfirmList: ({ onClose, scope }: { onClose: () => void; scope?: { series?: Scope; target?: Scope } }) =>
  <div role="dialog" aria-label="확인 목록"><span>{`범위 ${scope?.series?.id ?? "-"}/${scope?.target?.id ?? "-"}`}</span><button type="button" onClick={onClose}>닫기</button></div> }));
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
  const confirmSource = confirmSourceFor({ counts: { recognition: Math.max(characters, candidates.length) }, candidates: candidates.map((item, index) => shadowItem(`asset-${index}`, item.targetId, item.targetName)) });
  const view = render(<PrivacyProvider privacyMode={privacy} setPrivacyMode={vi.fn()}><WorkspaceChromeProvider scope="home"><ChromeTarget name="navigation" />
    <HomeView collections={[]} reviewCount={0} unsortedCount={0} trashCount={0} onNavigate={onNavigate} notes={notesWith(notes)}
      confirmSource={confirmSource} now={() => NOW} {...props} />
  </WorkspaceChromeProvider></PrivacyProvider>);
  return { onNavigate, confirmSource, view };
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
  gateway.listAssetDateBuckets.mockResolvedValue([]);
  gateway.getOnlineCatalogStatus.mockResolvedValue({ installed: true, workCount: 1, updateEnabled: true, updateIntervalSeconds: 3600, lastAttemptAt: iso(14, 19), lastSuccessAt: iso(14, 19), lastAdded: 0, lastError: null, streams: [] });
  gateway.listCatalogReview.mockResolvedValue({ rows: [], inspectedWorks: 0, comparisons: 0, skippedBuckets: 0 });
  gateway.getCatalogReviewCount = undefined;
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
  it('loads saved counts with the initial layout, keeps them through refresh and reuses the loaded ledger', async () => {
    let finish!: (value: { date: string; count: number }[]) => void;
    gateway.listAssetDateBuckets.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const recurring = [{ id: 'netflix', name: '넷플릭스', amount: 13500, every: 1, unit: 'month' as const, start: '2026-01-26', until: null, trial: false, memo: '', order: 'a', remindDays: 1 }];
    const store = notesWith([note('ledger', { type: 'ledger', recurring })]);
    const load = vi.spyOn(store, 'load');
    const { view, onNavigate } = renderHome({ props: { notes: store }, privacy: true });
    await act(async () => {});
    expect(screen.queryByRole('region', { name: '발매 캘린더' })).toBeNull();
    await act(async () => finish([{ date: '2026-09-26', count: 12 }]));
    const calendar = await screen.findByRole('region', { name: '발매 캘린더' });
    expect(within(calendar).getByLabelText('저장한 이미지 12장')).toHaveTextContent('12장');
    fireEvent.click(within(calendar).getByRole('button', { name: '넷플릭스 13,500원' }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'notes', noteId: 'ledger' });
    expect(load).toHaveBeenCalledOnce();
    expect(gateway.listAssetDateBuckets).toHaveBeenCalledOnce();
    expect(gateway.listAssetDateBuckets.mock.calls[0]![0]).toMatchObject({ imagesOnly: true, localDays: expect.any(Array) });

    gateway.listAssetDateBuckets.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const props = { collections: [], reviewCount: 0, unsortedCount: 0, trashCount: 0, notes: store, now: () => NOW, onNavigate };
    view.rerender(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}><WorkspaceChromeProvider scope="home"><ChromeTarget name="navigation" />
      <HomeView {...props} refreshVersion={1} />
    </WorkspaceChromeProvider></PrivacyProvider>);
    await waitFor(() => expect(gateway.listAssetDateBuckets).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('region', { name: '발매 캘린더' })).toBe(calendar);
    expect(within(calendar).getByLabelText('저장한 이미지 12장')).toBeTruthy();
    await act(async () => finish([{ date: '2026-09-26', count: 15 }]));
    expect(within(calendar).getByLabelText('저장한 이미지 15장')).toHaveTextContent('15장');
    expect(load).toHaveBeenCalledOnce();
  });

  it('hides ledger names while the keyring is locked even if stale note data remains', async () => {
    const store = new NotesStore(async <T,>() => ({ unlocked: false, keyringLocked: true, lastSyncedAt: null,
      notes: [note('locked', { type: 'ledger', recurring: [{ id: 'r', name: '숨긴 결제명', amount: 1000, every: 1, unit: 'month', start: '2026-01-26', until: null, trial: false, memo: '', order: 'a' }] })] }) as T);
    renderHome({ props: { notes: store } });
    const calendar = await screen.findByRole('region', { name: '발매 캘린더' });
    expect(within(calendar).queryByText(/숨긴 결제명/)).toBeNull();
  });

  it('finishes Home on a saved-count error and retries only that bounded read', async () => {
    gateway.listAssetDateBuckets.mockRejectedValueOnce(new Error('unavailable'));
    renderHome();
    await screen.findByRole('region', { name: '발매 캘린더' });
    const error = screen.getByText('저장한 이미지 수를 확인할 수 없습니다');
    const overviewReads = gateway.getHomeOverview.mock.calls.length;
    fireEvent.click(within(error).getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(gateway.listAssetDateBuckets).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('저장한 이미지 수를 확인할 수 없습니다')).toBeNull());
    expect(gateway.getHomeOverview).toHaveBeenCalledTimes(overviewReads);
  });

  it('no longer reads or lists 중복 판본 on Home (user 2026-10-16)', async () => {
    gateway.getCatalogReviewCount = vi.fn().mockResolvedValue(14);
    const { view } = renderHome();
    await waitFor(() => expect(view.container.querySelector('.home-pc-layout')).toHaveAttribute('aria-busy', 'false'));
    expect(screen.queryByRole('button', { name: /중복 판본/ })).toBeNull();
    expect(gateway.getCatalogReviewCount).not.toHaveBeenCalled();
  });
  it('holds the first layout until the first reads arrive, then shows the calendar, tools and card place, and opens the release calendar', async () => {
    let finish!: (value: HomeOverview) => void;
    gateway.getHomeOverview.mockReturnValueOnce(new Promise<HomeOverview>(resolve => { finish = resolve; }));
    gateway.releaseCalendar.wishlist.mockResolvedValue([title('a', '오늘 발매', 'game', '2026-09-26'), title('b', '내일 발매', 'game', '2026-09-27')]);
    const { view, onNavigate } = renderHome();
    await act(async () => {});
    expect(view.container.querySelector('.home-pc-layout')?.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('region', { name: '발매 캘린더' })).toBeNull();
    await act(async () => finish(overview({ total: 1, today: 0, week: 0 })));
    const calendar = await screen.findByRole('region', { name: '발매 캘린더' });
    expect(view.container.querySelector('.home-pc-layout')?.getAttribute('aria-busy')).toBe('false');
    for (const name of ['전송', '빠른 메모', '링크 보관', '오늘의 카드']) expect(screen.getByRole('region', { name })).toBeTruthy();
    expect(screen.getByRole('button', { name: '앨범' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: '링크 보관' })).getByRole('textbox', { name: 'URL 붙여넣기' })).toBeTruthy();
    // 지금 하는 중, 오늘의 그림 and 1년 전 오늘 are no longer on Home, and their reads are not made.
    for (const name of [/지금 하는 중/, /오늘의 그림/, /1년 전 오늘/]) expect(screen.queryByRole('region', { name })).toBeNull();
    expect(gateway.getHomeMedia).not.toHaveBeenCalled();
    expect(gateway.getRevisitSlate).not.toHaveBeenCalled();
    expect(within(calendar).getByText('오늘 발매')).toBeTruthy();
    expect(within(calendar).getByText('내일 발매')).toBeTruthy();
    fireEvent.click(within(calendar).getByRole('button', { name: '발매 캘린더 전체' }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'collections', typeFilter: 'game', showcase: false, releaseCalendar: true });
    fireEvent.click(screen.getByRole('button', { name: /상세/ }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'exchange' });
  });
  it('orders nonzero reviews, routes them, and removes the old Home sections', async () => {
    gateway.getHomeOverview.mockResolvedValue(overview({ total: 48213, today: 10, week: 41 }, { capturesPending: 3 }, { tagger: { total: 7, recommendation: 7, veto: 0 } }));
    const { onNavigate } = renderHome({ characters: 7, props: { unsortedCount: 27, reviewCount: 2 } });
    const today = await screen.findByRole('region', { name: '오늘 할 것' });
    await waitFor(() => expect(within(today).getAllByRole('button').map(b => b.textContent)).toEqual(['□미분류 에셋27', '□유사 이미지 검토2쌍', '□처리 대기3', '□확인7']));
    fireEvent.click(within(today).getByRole('button', { name: /미분류 에셋/ }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'unsorted' });
    fireEvent.click(within(today).getByRole('button', { name: /유사 이미지 검토/ }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'similarity_review' });
    for (const label of ['자산 현황', '작가', 'AV 배우', '메모', '상태', '이어지는 시리즈', '즐겨찾는 배우']) expect(screen.queryByRole('region', { name: label })).toBeNull();
    expect(gateway.listAvFavorites).not.toHaveBeenCalled();
  });
  it('hides an empty 오늘 할 것 and draws an empty calendar without a placeholder line', async () => {
    renderHome();
    await screen.findByRole('region', { name: '발매 캘린더' });
    expect(screen.queryByRole('region', { name: /오늘 할 것/ })).toBeNull();
    expect(document.querySelectorAll('.home-cal__day')).toHaveLength(14);
    expect(document.querySelectorAll('.home-cal__item')).toHaveLength(0);
  });
  it('puts the monthly subscriptions and reminder before reviews and pinned text-body tasks', async () => {
    const subscription = { id: 'sub', name: 'Netflix', amount: 17000, every: 1, unit: 'month' as const, start: '2026-09-28', trial: true, until: null, remindDays: 3, memo: '', order: 'a' };
    const { onNavigate } = renderHome({ notes: [note('ledger', { type: 'ledger', pinned: false, recurring: [subscription] }), note('todo', { title: '피드백', type: 'text', body: '- [ ] 수정\n- [x] 완료' }), note('plain', { title: '글', body: '일반 글' })], props: { unsortedCount: 1 } });
    const today = await screen.findByRole('region', { name: '오늘 할 것' });
    await waitFor(() => expect(within(today).getAllByRole('button')).toHaveLength(4));
    const buttons = within(today).getAllByRole('button');
    expect(buttons.map(b => b.textContent)).toEqual(['○구독 이번 달 ₩17,000다음 결제 D-2 · Netflix1개', '○Netflix 무료 끝남9.28 · ₩17,000부터 결제D-2', '□미분류 에셋1', '○피드백남은 항목 1개1']);
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
    await screen.findByRole('region', { name: '발매 캘린더' });
    expect(screen.queryByRole('button', { name: /새 게임/ })).toBeNull();
  });
  it('grids two weeks from this week\'s Monday across the month boundary and counts what comes after', async () => {
    gateway.releaseCalendar.wishlist.mockResolvedValue([title('today', '오늘 작품', 'game', '2026-09-26'), title('edge', '경계 작품', 'game', '2026-10-04'), title('late', '나중 작품', 'game', '2026-10-05'), title('later', '더 나중 작품', 'game', '2026-11-05')]);
    const { onNavigate } = renderHome();
    const region = await screen.findByRole('region', { name: '발매 캘린더' });
    // Saturday 9.26: the grid runs 9.21 - 10.4.
    expect(region.querySelector('[data-tense="today"] .home-cal__date')).toBeTruthy();
    expect(within(region).getByText('D-8')).toBeTruthy();
    expect(within(region).queryByText('나중 작품')).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: '10.5 이후 2개' }));
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'collections', typeFilter: 'game', showcase: false, releaseCalendar: true });
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
  it('opens one 확인 overview from a single row and returns to Home', async () => {
    const user = userEvent.setup();
    const { confirmSource } = renderHome({ characters: 2, candidates: [{targetId:'lara',targetName:'라라'}, {targetId:'lara',targetName:'라라'}] });
    await user.click(await screen.findByRole('button', {name:/확인2/}));
    expect(await screen.findByRole('button', {name:'홈으로 돌아가기'})).toBeTruthy();
    expect(await screen.findByRole('button', {name: /라라 확인 2건/})).toBeTruthy();
    await user.click(screen.getByRole('button', {name:'홈으로 돌아가기'}));
    expect(await screen.findByRole('button', {name:/확인2/})).toBeTruthy();
    expect(confirmSource.counts).toHaveBeenCalled();
    expect(confirmSource.tagger).toHaveBeenCalled();
    expect(screen.queryByRole('button', {name:/캐릭터\d/})).toBeNull();
  });
  it('counts each pair once: the Home row follows the exact 확인 count, not the sum of the tag and recognition counts', async () => {
    gateway.getHomeOverview.mockResolvedValue(overview({ total: 10, today: 1, week: 2 }, {}, { tagger: { total: 6, recommendation: 6, veto: 0 } }));
    renderHome({ characters: 7 });
    expect(await screen.findByRole('button', {name:/확인7/})).toBeTruthy();
  });
  it('counts only the tag pairs in lightweight mode, where the recognition lists are not read', async () => {
    workload.restricted = true;
    gateway.getHomeOverview.mockResolvedValue(overview({ total: 10, today: 1, week: 2 }, {}, { tagger: { total: 4, recommendation: 4, veto: 0 } }));
    const { confirmSource } = renderHome({ characters: 7 });
    expect(await screen.findByRole('button', {name:/확인4/})).toBeTruthy();
    expect(confirmSource.counts).not.toHaveBeenCalled();
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
    await within(screen.getByRole("region", {name: /발매 캘린더/})).findByText("Fresh release");
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

describe("Home server-owned release reads", () => {
  it("shows the saved wishlist at once, reads the server reply after the first load, and swaps it in", async () => {
    writeWishlistCache("fixture", [title("saved", "Saved release", "game", "2026-09-26")]);
    let finish!: (items: ReleaseWishlistItem[]) => void;
    gateway.releaseCalendar.wishlist.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { view } = renderHome();
    await within(await screen.findByRole("region", { name: /발매 캘린더/ })).findByText("Saved release");
    expect(view.container.querySelector(".home-pc-layout")?.getAttribute("aria-busy")).toBe("false");
    await waitFor(() => expect(gateway.releaseCalendar.wishlist).toHaveBeenCalledOnce());
    expect(screen.getByText("Saved release")).toBeVisible();
    await act(async () => { finish([title("saved", "Saved release", "game", "2026-09-26"), title("fresh", "Fresh release", "game", "2026-09-27")]); });
    await within(screen.getByRole("region", { name: /발매 캘린더/ })).findByText("Fresh release");
    expect(screen.getByText("Saved release")).toBeVisible();
    expect(readWishlistCache("fixture")?.map(item => item.id)).toEqual(["saved", "fresh"]);
  });
  it("saves the first server reply, an empty list included, for the next start", async () => {
    renderHome();
    await waitFor(() => expect(readWishlistCache("fixture")).toEqual([]));
  });
  it("waits for the server reply on the very first start, when nothing is saved", async () => {
    let finish!: (items: ReleaseWishlistItem[]) => void;
    gateway.releaseCalendar.wishlist.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { view } = renderHome();
    await act(async () => {});
    expect(view.container.querySelector(".home-pc-layout")?.getAttribute("aria-busy")).toBe("true");
    await act(async () => finish([]));
    await waitFor(() => expect(view.container.querySelector(".home-pc-layout")?.getAttribute("aria-busy")).toBe("false"));
  });
});

describe("Home server row", () => {
  const serverRow = () => screen.queryByRole("button", { name: /서버/ });
  it("follows the live connection state instead of the overview's startup reading", async () => {
    gateway.getHomeOverview.mockResolvedValue(overview({ total: 10, today: 0, week: 1 }, { live: false }));
    renderHome();
    await act(async () => {});
    await waitFor(() => expect(gateway.authoritySyncHealth).toHaveBeenCalled());
    await act(async () => {});
    expect(serverRow()).toBeNull();
  });
  it("shows the row while the live state reports an outage", async () => {
    gateway.authoritySyncHealth.mockResolvedValue({ ...healthy, authorityPassFailure: { code: "network", at: iso(14, 0) } as never });
    renderHome();
    expect(await screen.findByRole("button", { name: /서버.*연결 안 됨/ })).toBeVisible();
  });
});

describe("Home wishlist arrivals", () => {
  it("acknowledges the displayed release notices when Home opens a title", async () => {
    const watched = title("wish", "관심 영화", "movie", "2026-09-23", { released: true, unread: [{ id: "event", itemId: "wish", kind: "released", previousValue: null, currentValue: "2026-09-23", detectedAt: iso(12), readAt: null }] });
    gateway.releaseCalendar.wishlist.mockResolvedValue([watched]);
    gateway.releaseCalendar.acknowledge.mockResolvedValue(undefined);
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: /관심 영화/ }));
    await waitFor(() => expect(gateway.releaseCalendar.acknowledge).toHaveBeenCalledWith(["event"]));
  });
  it("reports a failed notice acknowledgement while keeping the title open", async () => {
    const watched = title("wish", "관심 영화", "movie", "2026-09-23", { released: true, unread: [{ id: "event", itemId: "wish", kind: "released", previousValue: null, currentValue: "2026-09-23", detectedAt: iso(12), readAt: null }] });
    gateway.releaseCalendar.wishlist.mockResolvedValue([watched]);
    gateway.releaseCalendar.acknowledge.mockRejectedValueOnce(new Error("offline"));
    renderHome();
    fireEvent.click(await screen.findByRole("button", { name: /관심 영화/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("발매 캘린더에서 다시 확인");
    expect(screen.getByRole("dialog", {name: "관심 영화"})).toBeTruthy();
  });
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

it('reads the startup overview once after initial app replies, then refreshes real changes, and never reads media', async () => {
  const props = { collections: [], collectionsReady: false, overviewReady: false, reviewCount: 0, unsortedCount: 0, trashCount: 0, notes: notesWith([]), onNavigate: vi.fn(), now: () => NOW };
  const home = (extra: Partial<HomeViewProps> = {}) => <PrivacyProvider privacyMode={false} setPrivacyMode={vi.fn()}><HomeView {...props} {...extra} /></PrivacyProvider>;
  const view = render(home());
  await act(async () => {});
  expect(gateway.getHomeOverview).not.toHaveBeenCalled();
  const collections = [{ id: 'a', updatedAt: '1' }, { id: 'b', updatedAt: '1' }] as HomeViewProps['collections'];
  view.rerender(home({ collections, collectionsReady: true }));
  await act(async () => {});
  expect(gateway.getHomeOverview).not.toHaveBeenCalled();
  view.rerender(home({ collections, collectionsReady: true, overviewReady: true, trashCount: 8 }));
  await waitFor(() => expect(gateway.getHomeOverview).toHaveBeenCalledTimes(1));
  view.rerender(home({ collections: [...collections].reverse(), collectionsReady: false, overviewReady: true, trashCount: 8 }));
  await act(async () => {});
  expect(gateway.getHomeOverview).toHaveBeenCalledTimes(1);
  view.rerender(home({ collections: [{ ...collections[0], updatedAt: '2' }, collections[1]], collectionsReady: true, overviewReady: true, trashCount: 9 }));
  await waitFor(() => expect(gateway.getHomeOverview).toHaveBeenCalledTimes(2));
  expect(gateway.getHomeMedia).not.toHaveBeenCalled();
  expect(gateway.getRevisitSlate).not.toHaveBeenCalled();
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
  gateway.getHomeOverview.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const splash = render(<LaunchSplash elapsed={() => 0} />);
  const first = renderHome();
  await act(async () => {});
  expect(screen.getByRole("status", { name: "Lakomics 여는 중" })).not.toHaveAttribute("data-state");
  expect(first.view.container.querySelector(".home-pc-layout")?.getAttribute("aria-busy")).toBe("true");
  await act(async () => finish(overview({ total: 1, today: 0, week: 0 })));
  await waitFor(() => expect(document.querySelector(".launch-splash")).toBeNull());
  // A later first load (e.g. after switching library) shows the usual skeleton, not the splash.
  first.view.unmount();
  gateway.getHomeOverview.mockReturnValueOnce(new Promise(() => undefined));
  const later = renderHome();
  await act(async () => {});
  expect(later.view.container.querySelector(".home-pc-layout")?.getAttribute("aria-busy")).toBe("true");
  expect(document.querySelector(".launch-splash")).toBeNull();
  splash.unmount();
});
