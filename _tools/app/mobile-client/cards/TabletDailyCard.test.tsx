import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {TabletDailyCard} from './TabletDailyCard';
import {operationId, saveResult, type CardState, type OpenResult, type ServerCard, type TabletCardsApi} from './cardsClient';

const serverCard = (changes: Partial<ServerCard> = {}): ServerCard => ({
  slot: 0, characterId: 'c1', characterName: '루나', seriesName: '별자리', tier: 'sr', artAssetId: 'a1', artWidth: 1000, artHeight: 1400,
  cutout: null, count: 1, level: 1, serial: null, isNew: true, firstDrawnAt: '2026-10-15T01:00:00Z', ...changes,
});
const state = (changes: Partial<CardState> = {}): CardState => ({
  version: 1, revision: 1, day: '2026-10-15', nextResetAt: '2026-10-15T20:00:00Z', unopened: [{id: 'd-20261015', kind: 'daily', day: '2026-10-15'}],
  pendingKeep: [], prefetch: [], savedToday: 0, bonusThreshold: 50, bonusGranted: false, cover: {day: '2026-10-15', assetIds: ['cover1']},
  albumSummary: {cards: 1, total: 3}, ...changes,
});
const result = (alreadyOpened = false): OpenResult => ({
  packId: 'd-20261015', openedAt: '2026-10-15T01:00:00Z', alreadyOpened,
  cards: Array.from({length: 5}, (_, slot) => serverCard({slot, tier: slot === 4 ? 'lr' : 'n', characterName: `서버 카드 ${slot}`, characterId: `c${slot}`, artAssetId: `art${slot}`})),
});
const decided = (slots: number[], packId = 'd-20261015'): OpenResult => ({
  ...result(true), packId, keptAt: '2026-10-15T02:00:00Z', alreadyKept: false,
  cards: result().cards.map(card => ({...card, kept: slots.includes(card.slot!)})),
});
function apiFixture(snapshot = state()) {
  const api: TabletCardsApi = {
    state: vi.fn(async () => snapshot), open: vi.fn(async () => result()),
    keep: vi.fn(async (packId: string, _operation: string, slots: number[]) => decided(slots, packId)),
    pack: vi.fn(async (packId: string) => ({...result(true), packId})),
    setTrashed: vi.fn(async () => ({})),
    album: vi.fn(async () => ({version: 1, revision: 1, cards: [serverCard()], nextCursor: null})),
    art: vi.fn(async id => `https://art.test/${id}.jpg`), cutout: vi.fn(async id => `https://cut.test/${id}.png`),
  };
  return api;
}
const settle = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T02:00:00Z')); localStorage.clear();
  vi.stubGlobal('matchMedia', vi.fn(() => ({matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()})));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const show = (api: TabletCardsApi, props: Partial<Parameters<typeof TabletDailyCard>[0]> = {}) =>
  render(<TabletDailyCard api={api} root="tablet" privacy={false} onOpenAlbum={vi.fn()} {...props}/>);
/** Opens the pending pack from Home, with the cards already dealt (reduced motion). */
async function openPack(api: TabletCardsApi) {
  show(api); await settle();
  fireEvent.click(screen.getByRole('button', {name: '뜯기'}));
  fireEvent.keyDown(screen.getByRole('button', {name: /팩 뜯기/}), {key: 'Enter'}); await settle(500);
}

it('shows the pack, remaining count, bonus note, reset time and the album total', async () => {
  const api = apiFixture(state({bonusGranted: true})), album = vi.fn();
  show(api, {onOpenAlbum: album}); await settle();
  expect(screen.getByRole('region', {name: '오늘의 카드'})).toBeTruthy();
  expect(screen.getByText('남은 팩 1')).toBeTruthy();
  expect(screen.getByText('오늘 50장 저장 · 보너스 팩')).toBeTruthy();
  expect(screen.getByText('05:00에 새 팩')).toBeTruthy();
  expect(api.art).toHaveBeenCalledWith('cover1');
  fireEvent.click(screen.getByRole('button', {name: '앨범 1/3'}));
  expect(album).toHaveBeenCalledOnce();
});

it('opens the full-screen pack opening without drawing until the pack is torn', async () => {
  const api = apiFixture();
  show(api); await settle();
  fireEvent.click(screen.getByRole('button', {name: '오늘의 카드 팩 열기'}));
  expect(screen.getByRole('dialog', {name: '오늘의 카드'}).classList.contains('ui-dialog--fullscreen')).toBe(true);
  expect(api.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', {name: '닫기'})); await settle(500);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('tears, draws once with a stored retry key, and reuses that key after a failed tear', async () => {
  const api = apiFixture(); vi.mocked(api.open).mockRejectedValueOnce(new Error('offline'));
  await openPack(api);
  expect(screen.getByRole('alert').textContent).toContain('팩을 열지 못했습니다');
  const firstId = vi.mocked(api.open).mock.calls[0][1];
  expect(firstId).toBe(operationId('tablet', 'd-20261015'));
  fireEvent.keyDown(screen.getByRole('button', {name: /팩 뜯기/}), {key: 'Enter'}); await settle(500);
  expect(vi.mocked(api.open).mock.calls[1][1]).toBe(firstId);
  expect(within(screen.getByRole('dialog')).getAllByRole('img', {name: /서버 카드/})).toHaveLength(5);
  expect(document.querySelector('.pack-opening')?.getAttribute('data-phase')).toBe('results');
});

it('starts the keep step with nothing selected; tapping a card marks it and keep sends only that slot', async () => {
  const api = apiFixture(); await openPack(api);
  const keepButton = screen.getByRole('button', {name: '앨범에 넣기 (0장)'});
  expect((keepButton as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryAllByRole('checkbox', {checked: true})).toHaveLength(0);
  const slots = [...document.querySelectorAll<HTMLElement>('.pack-opening__slot')];
  expect(slots).toHaveLength(5);
  fireEvent.click(slots[2]);
  expect(slots[2].getAttribute('data-selected')).toBe('true');
  fireEvent.click(slots[4]);
  fireEvent.click(slots[4]);
  expect(slots[4].getAttribute('data-selected')).toBe('false');
  fireEvent.click(screen.getByRole('button', {name: '앨범에 넣기 (1장)'})); await settle(1000);
  expect(api.keep).toHaveBeenCalledOnce();
  expect(vi.mocked(api.keep).mock.calls[0][0]).toBe('d-20261015');
  expect(vi.mocked(api.keep).mock.calls[0][2]).toEqual([2]);
  expect(screen.getByText('앨범에 1장을 넣었습니다')).toBeTruthy();
  expect(screen.queryByRole('button', {name: /앨범에 넣기/})).toBeNull();
});

it('leaves a pack undecided with 나중에 and lists it as waiting', async () => {
  const api = apiFixture(); await openPack(api);
  fireEvent.click(screen.getByRole('button', {name: '나중에'})); await settle(500);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.keep).not.toHaveBeenCalled();
});

it('keeps the keep step open with an error and the same key after a failed keep', async () => {
  const api = apiFixture(); vi.mocked(api.keep).mockRejectedValueOnce(new Error('offline'));
  await openPack(api);
  fireEvent.click(document.querySelectorAll<HTMLElement>('.pack-opening__slot')[1]);
  fireEvent.click(screen.getByRole('button', {name: '앨범에 넣기 (1장)'})); await settle(1000);
  expect(screen.getByRole('alert').textContent).toContain('앨범에 넣지 못했습니다');
  const firstKey = vi.mocked(api.keep).mock.calls[0][1];
  fireEvent.click(screen.getByRole('button', {name: '앨범에 넣기 (1장)'})); await settle(1000);
  expect(vi.mocked(api.keep).mock.calls[1][1]).toBe(firstKey);
  expect(screen.getByText('앨범에 1장을 넣었습니다')).toBeTruthy();
});

it('shows the stored result of the newest pack without any open request and replays it as results', async () => {
  saveResult('tablet', {...result(), packId: 'b-20261015'}); const api = apiFixture(state({unopened: [], bonusGranted: true, nextResetAt: new Date(2026, 9, 16, 7, 35).toISOString()}));
  show(api); await settle();
  expect(screen.queryByText('남은 팩 없음')).toBeNull();
  expect(screen.getByRole('img', {name: /LR 서버 카드 4/})).toBeTruthy();
  expect(screen.queryByText('LR · 서버 카드 4')).toBeNull();
  expect(screen.getByText('07:35 새 팩 증정')).toBeTruthy();
  expect(screen.queryByText('오늘 50장 저장 · 보너스 팩')).toBeNull();
  expect(screen.queryByText('05:00에 새 팩')).toBeNull();
  expect(screen.queryByRole('button', {name: '결과 보기'})).toBeNull();
  expect(within(screen.getByRole('region', {name: '오늘의 카드'})).getAllByRole('button')).toHaveLength(2);
  expect(api.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', {name: '오늘의 결과 보기'})); await settle();
  expect(document.querySelector('.pack-opening')?.getAttribute('data-phase')).toBe('results');
  expect(api.open).not.toHaveBeenCalled();
  expect(screen.queryByText('NEW')).toBeNull();
});

it('recovers a pack opened on another device and shows it as already opened', async () => {
  const api = apiFixture(state({unopened: []}));
  vi.mocked(api.open).mockResolvedValue(result(true));
  show(api); await settle();
  expect(screen.getByRole('img', {name: /LR 서버 카드 4/})).toBeTruthy();
  expect(api.open).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', {name: '오늘의 결과 보기'})); await settle();
  expect(document.querySelector('.pack-opening')?.getAttribute('data-phase')).toBe('results');
  expect(screen.queryByRole('button', {name: '카드 뒤집기'})).toBeNull();
});

it('lists packs waiting for a decision and reopens one at the keep step', async () => {
  const waiting = [{packId: 'd-20261014', openedAt: '2026-10-14T01:00:00Z', expiresAt: '2026-10-21T01:00:00Z'}];
  const api = apiFixture(state({pendingKeep: waiting}));
  vi.mocked(api.open).mockResolvedValue(result(true));
  show(api); await settle();
  fireEvent.click(screen.getByRole('button', {name: '정리 안 한 팩 1'})); await settle();
  expect(api.pack).toHaveBeenCalledWith('d-20261014');
  expect(document.querySelector('.pack-opening')?.getAttribute('data-phase')).toBe('results');
  expect((screen.getByRole('button', {name: '앨범에 넣기 (0장)'}) as HTMLButtonElement).disabled).toBe(true);
});

it('opens today’s undecided result by tapping the card when no packs remain', async () => {
  saveResult('tablet', result());
  const pendingKeep = [{packId: 'd-20261015', openedAt: '2026-10-15T01:00:00Z', expiresAt: '2026-10-22T01:00:00Z'}];
  const api = apiFixture(state({unopened: [], pendingKeep}));
  show(api); await settle();
  expect(screen.queryByRole('button', {name: '정리 안 한 팩 1'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: '오늘의 결과 보기'})); await settle();
  expect(screen.getAllByRole('checkbox')).toHaveLength(5);
  expect((screen.getByRole('button', {name: '앨범에 넣기 (0장)'}) as HTMLButtonElement).disabled).toBe(true);
  expect(api.open).not.toHaveBeenCalled();
});

it('says so when a waiting pack cannot be loaded, and retries', async () => {
  const waiting = [{packId: 'd-20261014', openedAt: '2026-10-14T01:00:00Z', expiresAt: '2026-10-21T01:00:00Z'}];
  const api = apiFixture(state({pendingKeep: waiting}));
  vi.mocked(api.open).mockResolvedValue(result(true));
  vi.mocked(api.pack).mockRejectedValueOnce(new Error('offline'));
  show(api); await settle();
  fireEvent.click(screen.getByRole('button', {name: '정리 안 한 팩 1'})); await settle();
  expect(screen.getByRole('alert').textContent).toContain('정리 안 한 팩을 불러오지 못했습니다');
  fireEvent.click(screen.getByRole('button', {name: '다시 시도'})); await settle();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(document.querySelector('.pack-opening')).toBeTruthy();
});

it('keeps the content on a failed refresh and retries; busy text waits 400 ms', async () => {
  const api = apiFixture(); show(api); await settle();
  let reject!: (reason: unknown) => void;
  vi.mocked(api.state).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  act(() => { window.dispatchEvent(new Event('lakomics-resume')); }); await settle(399);
  expect(screen.getByText('남은 팩 1')).toBeTruthy();
  expect(screen.queryByText('불러오는 중')).toBeNull();
  await act(async () => reject(new Error('offline')));
  expect(screen.getByRole('alert').textContent).toContain('카드를 불러오지 못했습니다');
  expect(screen.getByText('남은 팩 1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: '다시 시도'})); await settle();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('re-reads the state when the server card signal moves, once per move', async () => {
  const api = apiFixture(); show(api); await settle();
  const report = (cards: number) => act(() => { window.dispatchEvent(new CustomEvent('lakomics-sync-signals', {detail: {live: true, signals: {cards}}})); });
  report(1); await settle();
  expect(api.state).toHaveBeenCalledTimes(1);
  report(2); await settle();
  expect(api.state).toHaveBeenCalledTimes(2);
  report(2); await settle();
  expect(api.state).toHaveBeenCalledTimes(2);
});

it('refreshes once at the daily reset', async () => {
  const reset = new Date(Date.now() + 1000).toISOString(); const api = apiFixture(state({nextResetAt: reset}));
  show(api); await settle(); await settle(1000);
  expect(api.state).toHaveBeenCalledTimes(2);
  await settle(5000);
  expect(api.state).toHaveBeenCalledTimes(2);
});

it('does nothing while Home is out of sight', async () => {
  const api = apiFixture(); show(api, {active: false}); await settle(1000);
  expect(api.state).not.toHaveBeenCalled();
});

it('hides the pack cover and the cards in private mode', async () => {
  saveResult('tablet', result()); const api = apiFixture(state({unopened: []}));
  show(api, {privacy: true}); await settle();
  expect(document.querySelector('.trading-card .f-bg.privacy-mask')).toBeTruthy();
  expect(document.querySelector('.trading-card img.f-bg')).toBeNull();
});

it('lets Android Back close the pack opening before the app shell sees it', async () => {
  const shell = vi.fn(); window.addEventListener('lakomics-back', shell);
  try {
    const api = apiFixture(); show(api); await settle();
    window.dispatchEvent(new CustomEvent('lakomics-back'));
    expect(shell).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', {name: '오늘의 카드 팩 열기'}));
    expect(screen.getByRole('dialog')).toBeTruthy();
    shell.mockClear();
    window.dispatchEvent(new CustomEvent('lakomics-back')); await settle(500);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(shell).not.toHaveBeenCalled();
    window.dispatchEvent(new CustomEvent('lakomics-back'));
    expect(shell).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener('lakomics-back', shell); }
});
