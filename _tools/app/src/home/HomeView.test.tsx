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

/** A day cell of the month grid, and the day panel beside or under it. */
const cell = (date: string) => document.querySelector<HTMLElement>(`[data-day="${date}"]`)!;
const dayPanel = () => document.querySelector<HTMLElement>('.home-day')!;
const calendarRegion = () => screen.findByRole('region', { name: '달력' });
async function pickDay(date: string) {
  await waitFor(() => expect(cell(date)).toBeTruthy());
  fireEvent.click(cell(date));
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
  it('loads saved counts with the initial layout, keeps them through refresh, reuses the loaded ledger and hides only amounts in privacy mode', async () => {
    let finish!: (value: { date: string; count: number }[]) => void;
    gateway.listAssetDateBuckets.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const recurring = [{ id: 'netflix', name: '넷플릭스', amount: 13500, every: 1, unit: 'month' as const, start: '2026-01-26', until: null, trial: false, memo: '', order: 'a', remindDays: 1 }];
    const store = notesWith([note('ledger', { type: 'ledger', recurring })]);
    const load = vi.spyOn(store, 'load');
    const { view, onNavigate } = renderHome({ props: { notes: store }, privacy: true });
    await act(async () => {});
    expect(screen.queryByRole('region', { name: '달력' })).toBeNull();
    await act(async () => finish([{ date: '2026-09-26', count: 12 }]));
    const calendar = await calendarRegion();
    expect(cell('2026-09-26')).toHaveAccessibleName(/저장 12장/);
    expect(cell('2026-09-26').textContent).not.toMatch(/12장/);
    // The subscription charge stays visible by name; its amount is hidden everywhere, 오늘 할 것 included.
    expect(within(cell('2026-09-26')).getByText(/넷플릭스/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/13,500/);
    expect(within(dayPanel()).getAllByLabelText('금액 숨김').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /구독 이번 달 ••••/ })).toBeTruthy();
    expect(load).toHaveBeenCalledOnce();
    expect(gateway.listAssetDateBuckets).toHaveBeenCalledTimes(2);
    expect(gateway.listAssetDateBuckets.mock.calls[0]![0]).toMatchObject({ imagesOnly: true });
    expect(gateway.listAssetDateBuckets.mock.calls.flatMap(call => call[0].localDays ?? [])).toHaveLength(42);

    gateway.listAssetDateBuckets.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const props = { collections: [], reviewCount: 0, unsortedCount: 0, trashCount: 0, notes: store, now: () => NOW, onNavigate };
    view.rerender(<PrivacyProvider privacyMode setPrivacyMode={vi.fn()}><WorkspaceChromeProvider scope="home"><ChromeTarget name="navigation" />
      <HomeView {...props} refreshVersion={1} />
    </WorkspaceChromeProvider></PrivacyProvider>);
    await waitFor(() => expect(gateway.listAssetDateBuckets).toHaveBeenCalledTimes(4));
    expect(screen.getByRole('region', { name: '달력' })).toBe(calendar);
    expect(cell('2026-09-26')).toHaveAccessibleName(/저장 12장/);
    await act(async () => finish([{ date: '2026-09-26', count: 15 }]));
    expect(cell('2026-09-26')).toHaveAccessibleName(/저장 15장/);
    expect(load).toHaveBeenCalledOnce();
  });

  it('hides ledger names while the keyring is locked even if stale note data remains', async () => {
    const store = new NotesStore(async <T,>() => ({ unlocked: false, keyringLocked: true, lastSyncedAt: null,
      notes: [note('locked', { type: 'ledger', recurring: [{ id: 'r', name: '숨긴 결제명', amount: 1000, every: 1, unit: 'month', start: '2026-01-26', until: null, trial: false, memo: '', order: 'a' }] })] }) as T);
    renderHome({ props: { notes: store } });
    await calendarRegion();
    expect(document.querySelector('.home-month-layout')!.textContent).not.toMatch(/숨긴 결제명/);
  });

  it('finishes Home on a saved-count error and retries only that bounded read', async () => {
    gateway.listAssetDateBuckets.mockRejectedValueOnce(new Error('unavailable'));
    renderHome();
    await calendarRegion();
    const error = screen.getByText('저장한 이미지 수를 확인할 수 없습니다');
    const overviewReads = gateway.getHomeOverview.mock.calls.length;
    fireEvent.click(within(error).getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(gateway.listAssetDateBuckets).toHaveBeenCalledTimes(4));
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
  it('holds the first layout until the first reads arrive, then shows the month, the day panel, the tools in the right column and no 링크 보관, and opens the release calendar', async () => {
    let finish!: (value: HomeOverview) => void;
    gateway.getHomeOverview.mockReturnValueOnce(new Promise<HomeOverview>(resolve => { finish = resolve; }));
    gateway.releaseCalendar.wishlist.mockResolvedValue([title('a', '오늘 발매', 'game', '2026-09-26'), title('b', '내일 발매', 'game', '2026-09-27')]);
    const { view, onNavigate } = renderHome();
    await act(async () => {});
    expect(view.container.querySelector('.home-pc-layout')?.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('region', { name: '달력' })).toBeNull();
    await act(async () => finish(overview({ total: 1, today: 0, week: 0 })));
    const calendar = await calendarRegion();
    expect(view.container.querySelector('.home-pc-layout')?.getAttribute('aria-busy')).toBe('false');
    for (const name of ['전송', '빠른 메모', '오늘의 카드']) expect(screen.getByRole('region', { name })).toBeTruthy();
    expect(screen.getByRole('button', { name: '앨범' })).toBeTruthy();
    // 링크 보관 left Home; 더보기 and 찾기 open it.
    expect(screen.queryByRole('region', { name: '링크 보관' })).toBeNull();
    // Right column order: 오늘의 카드, 전송, 빠른 메모.
    const column = view.container.querySelector('.home-day-column')!;
    const order = [...column.querySelectorAll('section[aria-label]')].map(section => section.getAttribute('aria-label')).filter(name => ['오늘의 카드', '오늘 할 것', '전송', '빠른 메모'].includes(name!));
    expect(order).toEqual(['오늘의 카드', '전송', '빠른 메모']);
    // 지금 하는 중, 오늘의 그림 and 1년 전 오늘 are no longer on Home, and their reads are not made.
    for (const name of [/지금 하는 중/, /오늘의 그림/, /1년 전 오늘/]) expect(screen.queryByRole('region', { name })).toBeNull();
    expect(gateway.getHomeMedia).not.toHaveBeenCalled();
    expect(gateway.getRevisitSlate).not.toHaveBeenCalled();
    // The panel shows today first; tomorrow's release sits on its cell.
    expect(within(dayPanel()).getByText('오늘 발매')).toBeTruthy();
    expect(within(calendar).getByText('내일 발매')).toBeTruthy();
    fireEvent.click(within(calendar).getByRole('button', { name: /발매 캘린더/ }));
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
    for (const label of ['자산 현황', '작가', 'AV 배우', '상태', '이어지는 시리즈', '즐겨찾는 배우']) expect(screen.queryByRole('region', { name: label })).toBeNull();
    expect(gateway.listAvFavorites).not.toHaveBeenCalled();
  });
  it('hides an empty 오늘 할 것 and draws an empty month without a placeholder line', async () => {
    renderHome();
    await calendarRegion();
    expect(screen.queryByRole('region', { name: /오늘 할 것/ })).toBeNull();
    expect(document.querySelectorAll('.home-cal__day')).toHaveLength(42);
    expect(document.querySelectorAll('.home-cal__chip')).toHaveLength(0);
  });
  it('puts the monthly subscriptions and reminder before reviews and pinned text-body tasks', async () => {
    const subscription = { id: 'sub', name: 'Netflix', amount: 17000, every: 1, unit: 'month' as const, start: '2026-09-28', trial: true, until: null, remindDays: 3, memo: '', order: 'a' };
    const { onNavigate } = renderHome({ notes: [note('ledger', { type: 'ledger', pinned: false, recurring: [subscription] }), note('todo', { title: '피드백', type: 'text', body: '- [ ] 수정\n- [x] 완료' }), note('plain', { title: '글', body: '일반 글' })], props: { unsortedCount: 1 } });
    const today = await screen.findByRole('region', { name: '오늘 할 것' });
    await waitFor(() => expect(within(today).getAllByRole('button')).toHaveLength(4));
    const buttons = within(today).getAllByRole('button');
    expect(buttons.map(b => b.textContent)).toEqual(['□구독 이번 달 ₩17,000다음 결제 D-2 · Netflix1개', '□Netflix 무료 끝남9.28 · ₩17,000부터 결제D-2', '□미분류 에셋1', '□피드백남은 항목 1개1']);
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
  it('keeps NEW through refresh and a device revisit until opened, then leaves the release on its day without NEW', async () => {
    localStorage.setItem('lakomics.home.visit.v1:fixture', JSON.stringify({ lastVisit: '2026-09-24T00:00:00Z', pending: [], opened: [] }));
    gateway.releaseCalendar.wishlist.mockResolvedValue([title('game', '새 게임', 'game', '2026-09-25', { released: true })]);
    const { view, onNavigate } = renderHome();
    await calendarRegion();
    await waitFor(() => expect(cell('2026-09-25').querySelector('[data-new]')).toBeTruthy());
    await pickDay('2026-09-25');
    expect(within(within(dayPanel()).getByRole('button', { name: /새 게임/ })).getByText('NEW')).toBeTruthy();
    view.unmount();
    const next = renderHome();
    await waitFor(() => expect(cell('2026-09-25').querySelector('[data-new]')).toBeTruthy());
    await pickDay('2026-09-25');
    fireEvent.click(within(dayPanel()).getByRole('button', { name: /새 게임/ }));
    expect(await screen.findByRole('dialog', { name: '새 게임' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '발매 캘린더 열기' }));
    expect(next.onNavigate).toHaveBeenCalledWith({ kind: 'collections', typeFilter: 'game', showcase: false, releaseCalendar: true });
    // Past releases stay visible on their day; only the NEW mark ends.
    await waitFor(() => expect(cell('2026-09-25').querySelector('[data-new]')).toBeNull());
    expect(within(cell('2026-09-25')).getByText('새 게임')).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
    next.view.unmount(); renderHome();
    await calendarRegion();
    expect(cell('2026-09-25').querySelector('[data-new]')).toBeNull();
  });
  it('draws six Sunday-first weeks around the shown month, selects on click and pages months with the data of that month', async () => {
    gateway.releaseCalendar.wishlist.mockResolvedValue([title('today', '오늘 작품', 'game', '2026-09-26'), title('edge', '경계 작품', 'game', '2026-10-04'), title('later', '더 나중 작품', 'game', '2026-11-05')]);
    renderHome();
    const region = await calendarRegion();
    // Saturday 9.26: September's grid runs 8.30 - 10.10.
    const days = [...region.querySelectorAll<HTMLElement>('[data-day]')].map(item => item.dataset.day);
    expect(days).toHaveLength(42);
    expect(days[0]).toBe('2026-08-30');
    expect(days[41]).toBe('2026-10-10');
    expect(region.querySelector('[data-tense="today"] .home-cal__date')).toBeTruthy();
    expect(within(cell('2026-10-04')).queryByText('D-8')).toBeNull();
    expect(within(region).queryByText('더 나중 작품')).toBeNull();
    // Clicking a day of the next month only selects it.
    fireEvent.click(cell('2026-10-04'));
    expect(cell('2026-10-04')).toHaveAttribute('aria-selected', 'true');
    expect(within(region).getByRole('heading', { name: '9월' })).toBeTruthy();
    expect(within(dayPanel()).getByText('경계 작품')).toBeTruthy();
    expect(within(dayPanel()).getByText('D-8')).toBeTruthy();
    // Paging reads that month once and keeps the selected day in the panel.
    const reads = gateway.listAssetDateBuckets.mock.calls.length;
    fireEvent.click(within(region).getByRole('button', { name: '다음 달' }));
    expect(within(region).getByRole('heading', { name: '10월' })).toBeTruthy();
    expect(within(cell('2026-11-05')).getByText('더 나중 작품')).toBeTruthy();
    await waitFor(() => expect(gateway.listAssetDateBuckets).toHaveBeenCalledTimes(reads + 2));
    expect(cell('2026-10-04')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(region).getByRole('button', { name: '오늘' }));
    expect(within(region).getByRole('heading', { name: '9월' })).toBeTruthy();
    expect(cell('2026-09-26')).toHaveAttribute('aria-selected', 'true');
  });
  it('moves the selection with the arrow keys and pages the month when it leaves it', async () => {
    const user = userEvent.setup();
    renderHome();
    const region = await calendarRegion();
    cell('2026-09-26').focus();
    await user.keyboard('{ArrowDown}');
    expect(cell('2026-10-03')).toHaveAttribute('aria-selected', 'true');
    expect(within(region).getByRole('heading', { name: '10월' })).toBeTruthy();
    expect(cell('2026-10-03')).toHaveFocus();
    await user.keyboard('{ArrowLeft}{Home}');
    expect(cell('2026-09-26')).toHaveAttribute('aria-selected', 'true');
    expect(within(region).getByRole('heading', { name: '9월' })).toBeTruthy();
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
  it('does not hold the first load for the slow exact 확인 count: the saved total shows at once and the new one swaps in', async () => {
    localStorage.setItem('lakomics.home.confirm-total.v1:fixture', '5');
    gateway.getHomeOverview.mockResolvedValue(overview({ total: 10, today: 1, week: 2 }, {}, { tagger: { total: 2, recommendation: 2, veto: 0 } }));
    let resolve!: (value: { recognition: number; tag: number; recheck: number }) => void;
    const confirmSource = confirmSourceFor({ counts: { recognition: 7 } });
    confirmSource.counts.mockReturnValue(new Promise(r => { resolve = r; }));
    renderHome({ props: { confirmSource } });
    expect(await screen.findByRole('button', {name:/확인5/})).toBeTruthy();
    expect(document.querySelector('.home-media-waiting')).toBeNull();
    await waitFor(() => expect(confirmSource.counts).toHaveBeenCalled());
    await act(async () => resolve({ recognition: 7, tag: 0, recheck: 0 }));
    expect(await screen.findByRole('button', {name:/확인7/})).toBeTruthy();
    expect(localStorage.getItem('lakomics.home.confirm-total.v1:fixture')).toBe('7');
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
    await within(screen.getByRole("region", {name: "달력"})).findByText("Fresh release");
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
    await within(await screen.findByRole("region", { name: "달력" })).findByText("Saved release");
    expect(view.container.querySelector(".home-pc-layout")?.getAttribute("aria-busy")).toBe("false");
    await waitFor(() => expect(gateway.releaseCalendar.wishlist).toHaveBeenCalledOnce());
    expect(within(screen.getByRole("region", { name: "달력" })).getByText("Saved release")).toBeVisible();
    await act(async () => { finish([title("saved", "Saved release", "game", "2026-09-26"), title("fresh", "Fresh release", "game", "2026-09-27")]); });
    await within(screen.getByRole("region", { name: "달력" })).findByText("Fresh release");
    expect(within(screen.getByRole("region", { name: "달력" })).getByText("Saved release")).toBeVisible();
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
    await pickDay("2026-09-23");
    fireEvent.click(within(dayPanel()).getByRole("button", { name: /관심 영화/ }));
    await waitFor(() => expect(gateway.releaseCalendar.acknowledge).toHaveBeenCalledWith(["event"]));
  });
  it("reports a failed notice acknowledgement while keeping the title open", async () => {
    const watched = title("wish", "관심 영화", "movie", "2026-09-23", { released: true, unread: [{ id: "event", itemId: "wish", kind: "released", previousValue: null, currentValue: "2026-09-23", detectedAt: iso(12), readAt: null }] });
    gateway.releaseCalendar.wishlist.mockResolvedValue([watched]);
    gateway.releaseCalendar.acknowledge.mockRejectedValueOnce(new Error("offline"));
    renderHome();
    await pickDay("2026-09-23");
    fireEvent.click(within(dayPanel()).getByRole("button", { name: /관심 영화/ }));
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
    await pickDay("2026-09-23");
    const row = await within(dayPanel()).findByRole("button", { name: /관심 영화/ });
    expect(within(row).getByText("NEW")).toBeTruthy();
    expect(screen.queryByText("조용한 영화")).toBeNull();
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
  await pickDay('2026-09-25');
  const card=await within(dayPanel()).findByRole('button',{name:/늦게 읽은 게임/});
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

describe("Home day panel", () => {
  const ledgerNote = note("L", { type: "ledger", title: "가계부", pinned: true, recurring: [{ id: "claude", name: "클로드", amount: 159000, every: 1, unit: "month" as const, start: "2026-01-28", until: null, trial: false, memo: "", order: "a" }] });
  /** In-memory stand-in for the notes backend: saves store the draft; month notes are `m-YYYY-MM`. */
  async function liveStore(initial: Note[] = [ledgerNote]) {
    let notes = initial;
    const saves: Record<string, any>[] = [];
    const store = new NotesStore((async (op: string, input: Record<string, any>) => {
      if (op === "ledgerMonthId") return { id: `m-${input.month}` };
      if (op === "save") {
        const { expectedRevision, ...draft } = input;
        saves.push(draft);
        const saved = { ...(notes.find(n => n.id === draft.id) ?? {}), ...draft, localRevision: expectedRevision + 1, pending: true, deleted: false, createdAt: iso(1), updatedAt: iso(1), body: "", conflict: false } as Note;
        notes = [saved, ...notes.filter(n => n.id !== saved.id)];
        return saved;
      }
      return { unlocked: true, notes, lastSyncedAt: null };
    }) as never);
    await store.load();
    return { store, saves };
  }

  it("saves a day memo into a hidden month note and marks the day", async () => {
    const { store, saves } = await liveStore();
    renderHome({ props: { notes: store } });
    await calendarRegion();
    await pickDay("2026-09-24");
    const memo = within(dayPanel()).getByRole("textbox", { name: "9월 24일 메모" });
    fireEvent.change(memo, { target: { value: "서점 가기" } });
    expect(memo).toHaveValue("서점 가기");
    fireEvent.blur(memo);
    await waitFor(() => expect(saves.some(save => save.type === "checklist")).toBe(true));
    expect(saves.find(save => save.type === "checklist")).toMatchObject({ title: "달력 메모 2026-09", archived: true, items: [{ id: "2026-09-24", text: "서점 가기" }] });
    await waitFor(() => expect(cell("2026-09-24")).toHaveAccessibleName(/메모 있음/));
    // The text stays while the notes report it back, and the note stays out of the 오늘 할 것 list.
    expect(memo).toHaveValue("서점 가기");
    // Switching days swaps the panel content in one step; coming back shows the saved memo.
    await pickDay("2026-09-25");
    expect(within(dayPanel()).getByRole("textbox", { name: "9월 25일 메모" })).toHaveValue("");
    await pickDay("2026-09-24");
    expect(within(dayPanel()).getByRole("textbox", { name: "9월 24일 메모" })).toHaveValue("서점 가기");
  });

  it("adds, edits and deletes a ledger row of the chosen day with the 가계부's own quick entry", async () => {
    const user = userEvent.setup();
    const { store, saves } = await liveStore();
    renderHome({ props: { notes: store } });
    await calendarRegion();
    await pickDay("2026-09-25");
    const quick = within(dayPanel()).getByRole("textbox", { name: "이날 지출 빠른 입력" });
    await user.type(quick, "점심 8000{Enter}");
    const monthSave = () => { const list = saves.filter(save => save.type === "ledger-month"); return list[list.length - 1]; };
    await waitFor(() => expect(monthSave()?.entries).toHaveLength(1));
    expect(monthSave()).toMatchObject({ month: "2026-09", entries: [{ date: "2026-09-25", amount: 8000, name: "점심" }] });
    const row = await within(dayPanel()).findByRole("button", { name: /점심/ });
    expect(row).toHaveTextContent("₩8,000");
    await waitFor(() => expect(cell("2026-09-25")).toHaveAccessibleName(/지출 8,000원/));
    expect(within(document.querySelector(".home-month__totals")!).getByText("₩8,000")).toBeTruthy();

    await user.click(row);
    const form = within(dayPanel()).getByRole("group", { name: "기록 고치기" });
    const amount = within(form).getByRole("textbox", { name: "금액" });
    await user.clear(amount);
    await user.type(amount, "9500{Enter}");
    await waitFor(() => expect(monthSave()?.entries[0].amount).toBe(9500));

    await user.click(await within(dayPanel()).findByRole("button", { name: /점심/ }));
    await user.click(within(dayPanel()).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(monthSave()?.entries).toHaveLength(0));
    const undo = await screen.findByRole("button", { name: "되돌리기" });
    await user.click(undo);
    await waitFor(() => expect(monthSave()?.entries).toHaveLength(1));
    expect(monthSave()?.entries[0]).toMatchObject({ name: "점심", amount: 9500 });
  });

  it("lists unconfirmed subscription charges of the day read-only and counts them in the day total", async () => {
    const { store } = await liveStore();
    renderHome({ props: { notes: store } });
    await calendarRegion();
    await pickDay("2026-09-28");
    const charge = within(dayPanel()).getByRole("group", { name: "클로드 결제 예정" });
    expect(charge).toHaveTextContent("고정·구독 자동");
    expect(charge).toHaveTextContent("₩159,000");
    expect(within(dayPanel()).getByLabelText("하루 합계")).toHaveTextContent("₩159,000");
    expect(within(dayPanel()).queryByRole("button", { name: /클로드/ })).toBeNull();
    expect(within(document.querySelector(".home-month__totals")!).getByText("₩159,000")).toBeTruthy();
  });

  it("keeps privacy-mode rows read-only so the edit form never shows an amount", async () => {
    const entry = { id: "e1", date: "2026-09-26", amount: 8000, name: "점심", createdAt: iso(9) };
    const { store } = await liveStore([ledgerNote, note("m-2026-09", { type: "ledger-month", ledger: "L", month: "2026-09", entries: [entry], archived: true, pinned: false })]);
    renderHome({ props: { notes: store }, privacy: true });
    await calendarRegion();
    expect(within(dayPanel()).getByRole("group", { name: "점심" })).toBeTruthy();
    expect(within(dayPanel()).queryByRole("button", { name: /점심/ })).toBeNull();
    expect(dayPanel().textContent).not.toMatch(/8,000/);
    expect(cell("2026-09-26")).not.toHaveAccessibleName(/8,000/);
  });

  it("keeps kind icons in the day panel while the month chips show titles only", async () => {
    gateway.releaseCalendar.wishlist.mockResolvedValue([title("g", "새 게임", "game", "2026-09-28"), title("m", "새 영화", "movie", "2026-09-28")]);
    renderHome();
    await calendarRegion();
    await waitFor(() => expect(cell("2026-09-28").querySelector(".home-cal__chip")).toBeTruthy());
    expect(within(cell("2026-09-28")).queryByText("게임")).toBeNull();
    expect(cell("2026-09-28").querySelector(".home-cal__chip [aria-label]")).toBeNull();
    await pickDay("2026-09-28");
    const row = within(dayPanel()).getByRole("button", { name: /새 게임/ });
    expect(within(row).getByRole("img", { name: "게임" })).toBeTruthy();
    expect(within(row).queryByText("게임")).toBeNull();
    expect(within(within(dayPanel()).getByRole("button", { name: /새 영화/ })).getByRole("img", { name: "영화" })).toBeTruthy();
  });

  describe("모든 구독 and 사고 싶은 것", () => {
    const planned = [
      { id: "p1", name: "기계식 키보드", amount: 120000, month: null, memo: "", dropped: false, order: "a" },
      { id: "p2", name: "이미 산 것", amount: 5000, month: "2026-09", memo: "", dropped: false, order: "b" },
      { id: "p3", name: "안 사기로 한 것", amount: 9000, month: null, memo: "", dropped: true, order: "c" },
    ];
    const bought = { id: "e1", date: "2026-09-20", amount: 5000, name: "이미 산 것", planned: "p2", createdAt: iso(9) };
    const withLists = () => [note("L", { type: "ledger", title: "가계부", pinned: true, planned, recurring: ledgerNoteRecurring }), note("m-2026-09", { type: "ledger-month", ledger: "L", month: "2026-09", entries: [bought], archived: true, pinned: false })];
    const ledgerNoteRecurring = [{ id: "claude", name: "클로드", amount: 159000, every: 1, unit: "month" as const, start: "2026-01-28", until: null, trial: false, memo: "", order: "a" }];
    const fold = (name: string) => within(dayPanel()).getByRole("button", { name: new RegExp(name) });
    const rowsOf = (name: string) => within(dayPanel()).getByRole("region", { name }).querySelector<HTMLElement>(".home-fold")!;

    it("starts folded with counts, opens to the rows (bought and dropped things left out) and keeps the choice on this device", async () => {
      const first = renderHome({ notes: withLists() });
      await calendarRegion();
      await waitFor(() => expect(fold("모든 구독")).toBeTruthy());
      expect(fold("모든 구독")).toHaveAttribute("aria-expanded", "false");
      expect(fold("모든 구독")).toHaveTextContent("1");
      expect(fold("사고 싶은 것")).toHaveAttribute("aria-expanded", "false");
      expect(fold("사고 싶은 것")).toHaveTextContent("1");
      expect(rowsOf("모든 구독")).toHaveAttribute("inert");
      fireEvent.click(fold("모든 구독"));
      expect(fold("모든 구독")).toHaveAttribute("aria-expanded", "true");
      expect(rowsOf("모든 구독")).not.toHaveAttribute("inert");
      expect(within(rowsOf("모든 구독")).getByText("클로드")).toBeTruthy();
      expect(rowsOf("모든 구독")).toHaveTextContent("₩159,000");
      fireEvent.click(fold("사고 싶은 것"));
      expect(within(rowsOf("사고 싶은 것")).getByText("기계식 키보드")).toBeTruthy();
      expect(rowsOf("사고 싶은 것")).not.toHaveTextContent("이미 산 것");
      expect(rowsOf("사고 싶은 것")).not.toHaveTextContent("안 사기로 한 것");
      // Another day and another start both keep the two choices.
      await pickDay("2026-09-28");
      expect(fold("모든 구독")).toHaveAttribute("aria-expanded", "true");
      first.view.unmount();
      renderHome({ notes: withLists() });
      await calendarRegion();
      await waitFor(() => expect(fold("모든 구독")).toHaveAttribute("aria-expanded", "true"));
      fireEvent.click(fold("모든 구독"));
      expect(fold("모든 구독")).toHaveAttribute("aria-expanded", "false");
      expect(fold("사고 싶은 것")).toHaveAttribute("aria-expanded", "true");
    });

    it("adds a thing to buy right in the opened section: it shows at once, the count follows and the ledger note keeps it", async () => {
      localStorage.setItem("lakomics.home.dayFolds.v1", JSON.stringify({ subscriptions: false, wishes: true }));
      const user = userEvent.setup();
      const { store, saves } = await liveStore(withLists());
      renderHome({ props: { notes: store } });
      await calendarRegion();
      await waitFor(() => expect(fold("사고 싶은 것")).toBeTruthy());
      const quick = within(rowsOf("사고 싶은 것")).getByRole("textbox", { name: "사고 싶은 것 빠른 입력" });
      expect(quick).toHaveAttribute("placeholder", "예: 키보드 120000");
      expect(quick).not.toHaveFocus();
      await user.type(quick, "무선 마우스 45,000{Enter}");
      await waitFor(() => expect(within(rowsOf("사고 싶은 것")).getByText("무선 마우스")).toBeTruthy());
      expect(rowsOf("사고 싶은 것")).toHaveTextContent("₩45,000");
      expect(fold("사고 싶은 것")).toHaveTextContent("2");
      expect(quick).toHaveValue("");
      const ledgerSave = saves.filter(save => save.type === "ledger").pop();
      expect(ledgerSave?.planned).toHaveLength(4);
      expect(ledgerSave?.planned[3]).toMatchObject({ name: "무선 마우스", amount: 45000, month: null, dropped: false });
      // A name alone is kept without a price.
      await user.type(quick, "독서대{Enter}");
      await waitFor(() => expect(within(rowsOf("사고 싶은 것")).getByText("독서대")).toBeTruthy());
      expect(fold("사고 싶은 것")).toHaveTextContent("3");
      expect(within(rowsOf("사고 싶은 것")).getByText("독서대").closest(".ledger-entry__main")).not.toHaveTextContent("₩");
    });

    it("hides the amount of a thing added in privacy mode", async () => {
      localStorage.setItem("lakomics.home.dayFolds.v1", JSON.stringify({ subscriptions: false, wishes: true }));
      const user = userEvent.setup();
      const { store } = await liveStore(withLists());
      renderHome({ props: { notes: store }, privacy: true });
      await calendarRegion();
      await waitFor(() => expect(fold("사고 싶은 것")).toBeTruthy());
      await user.type(within(rowsOf("사고 싶은 것")).getByRole("textbox", { name: "사고 싶은 것 빠른 입력" }), "모니터 300000{Enter}");
      await waitFor(() => expect(within(rowsOf("사고 싶은 것")).getByText("모니터")).toBeTruthy());
      expect(rowsOf("사고 싶은 것").textContent).not.toMatch(/300,000/);
    });

    it("hides the amounts of both lists in privacy mode but keeps the names", async () => {
      localStorage.setItem("lakomics.home.dayFolds.v1", JSON.stringify({ subscriptions: true, wishes: true }));
      renderHome({ notes: withLists(), privacy: true });
      await calendarRegion();
      await waitFor(() => expect(fold("모든 구독")).toBeTruthy());
      expect(rowsOf("모든 구독")).toHaveTextContent("클로드");
      expect(rowsOf("사고 싶은 것")).toHaveTextContent("기계식 키보드");
      expect(rowsOf("모든 구독").textContent).not.toMatch(/159,000/);
      expect(rowsOf("사고 싶은 것").textContent).not.toMatch(/120,000/);
    });
  });

  it("opens 링크 보관 from a request of 더보기 or 찾기", async () => {
    const view = renderHome({ props: { linksRequest: {} } });
    expect(await screen.findByRole("textbox", { name: "URL 붙여넣기" })).toBeTruthy();
    view.view.unmount();
  });
});
