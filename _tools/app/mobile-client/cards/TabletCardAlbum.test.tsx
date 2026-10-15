import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {MutableRefObject} from 'react';
import {TabletCardAlbum, groupAlbum} from './TabletCardAlbum';
import type {AlbumPage, ServerCard, TabletCardsApi} from './cardsClient';

const serverCard = (changes: Partial<ServerCard> = {}): ServerCard => ({
  slot: null, characterId: 'c1', characterName: '루나', seriesName: '별자리', tier: 'sr', artAssetId: 'a1', artWidth: 1000, artHeight: 1400,
  cutout: null, count: 2, level: 3, serial: null, isNew: false, firstDrawnAt: '2026-10-15T01:00:00Z', ...changes,
});
const page = (cards: ServerCard[], nextCursor: string | null = null, revision = 1): AlbumPage => ({version: 1, revision, cards, nextCursor});
function apiFixture(pages: AlbumPage[]) {
  let call = 0;
  const api: TabletCardsApi = {
    state: vi.fn(), open: vi.fn(), keep: vi.fn(), pack: vi.fn(),
    album: vi.fn(async () => pages[Math.min(call++, pages.length - 1)]),
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

const luna = (tier: ServerCard['tier'], count = 1) => serverCard({tier, count, characterId: 'c1', characterName: '루나', artAssetId: `a-${tier}`});
const mika = serverCard({characterId: 'c2', characterName: '미카', seriesName: '가을', tier: 'n', artAssetId: 'a2'});

it('groups the album by series, then character, best tier first, and filters by tier', () => {
  const cards = ['n', 'ssr', 'r'].map(tier => ({id: `c1:${tier}`, characterId: 'c1', characterName: '루나', seriesName: '별자리', tier, artUrl: '', artWidth: 1, artHeight: 1, count: 1, level: 1} as never));
  const other = {id: 'c2:n', characterId: 'c2', characterName: '미카', seriesName: '', tier: 'n', artUrl: '', artWidth: 1, artHeight: 1, count: 1, level: 1} as never;
  const groups = groupAlbum([...cards, other]);
  expect(groups.map(([name]) => name)).toEqual(['별자리', '시리즈 없음']);
  expect(groups[0][1].get('c1')!.map(card => card.tier)).toEqual(['ssr', 'r', 'n']);
  expect(groupAlbum([...cards, other], 'r')[0][1].get('c1')).toHaveLength(1);
  expect(groupAlbum([...cards, other], 'lr')).toEqual([]);
});

it('shows one tile per character with the best tier and the owned tiers, and keeps touch targets in the chip rows', async () => {
  const api = apiFixture([page([luna('n'), luna('ssr', 3), mika])]);
  render(<TabletCardAlbum api={api} onClose={vi.fn()}/>); await settle(500);
  expect(api.album).toHaveBeenCalledWith(null, expect.anything());
  const tile = screen.getByRole('button', {name: '루나 · SSR'});
  expect(tile.textContent).toContain('×3');
  expect(within(tile).getByLabelText('보유 등급').querySelectorAll('[data-owned="true"]')).toHaveLength(2);
  expect(screen.getByRole('button', {name: '미카 · N'})).toBeTruthy();
  expect(screen.getByRole('heading', {name: /별자리/})).toBeTruthy();
  expect(screen.getByRole('group', {name: '시리즈'})).toBeTruthy();
});

it('filters by tier and series', async () => {
  const api = apiFixture([page([luna('n'), luna('ssr'), mika])]);
  render(<TabletCardAlbum api={api} onClose={vi.fn()}/>); await settle(500);
  fireEvent.click(within(screen.getByRole('group', {name: '카드 등급'})).getByRole('button', {name: 'N'}));
  expect(screen.getByRole('button', {name: '루나 · N'})).toBeTruthy();
  expect(screen.getByRole('button', {name: '미카 · N'})).toBeTruthy();
  fireEvent.click(within(screen.getByRole('group', {name: '시리즈'})).getByRole('button', {name: '가을 · 1명'}));
  expect(screen.queryByRole('button', {name: '루나 · N'})).toBeNull();
  expect(screen.getByRole('button', {name: '미카 · N'})).toBeTruthy();
  fireEvent.click(within(screen.getByRole('group', {name: '카드 등급'})).getByRole('button', {name: 'LR'}));
  expect(screen.getByText('이 등급의 카드가 없습니다')).toBeTruthy();
});

it('says the album is empty before the first card', async () => {
  render(<TabletCardAlbum api={apiFixture([page([])])} onClose={vi.fn()}/>); await settle(500);
  expect(screen.getByText('아직 모은 카드가 없습니다')).toBeTruthy();
});

it('loads the next page from its cursor with 더 보기 and merges it', async () => {
  const api = apiFixture([page([luna('n')], 'cursor-1'), page([mika], null)]);
  render(<TabletCardAlbum api={api} onClose={vi.fn()}/>); await settle(500);
  expect(screen.queryByRole('button', {name: '미카 · N'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: '더 보기'})); await settle(500);
  expect(vi.mocked(api.album).mock.calls[1][0]).toBe('cursor-1');
  expect(screen.getByRole('button', {name: '루나 · N'})).toBeTruthy();
  expect(screen.getByRole('button', {name: '미카 · N'})).toBeTruthy();
  expect(screen.queryByRole('button', {name: '더 보기'})).toBeNull();
});

it('pages by itself when the end of the list scrolls into view', async () => {
  const callbacks: ((entries: {isIntersecting: boolean}[]) => void)[] = [];
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: (entries: {isIntersecting: boolean}[]) => void) { callbacks.push(callback); } observe() {} disconnect() {} });
  const api = apiFixture([page([luna('n')], 'cursor-1'), page([mika], null)]);
  render(<TabletCardAlbum api={api} onClose={vi.fn()}/>); await settle(500);
  expect(api.album).toHaveBeenCalledTimes(1);
  act(() => callbacks.at(-1)!([{isIntersecting: true}])); await settle(500);
  expect(api.album).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', {name: '미카 · N'})).toBeTruthy();
});

it('refreshes the pages it already shows when the server card signal moves', async () => {
  const api = apiFixture([page([luna('n')], 'cursor-1'), page([mika], null), page([luna('n')], 'cursor-1', 2), page([mika, serverCard({characterId: 'c3', characterName: '하나', tier: 'r', artAssetId: 'a3'})], null, 2)]);
  render(<TabletCardAlbum api={api} onClose={vi.fn()}/>); await settle(500);
  fireEvent.click(screen.getByRole('button', {name: '더 보기'})); await settle(500);
  const report = (cards: number) => act(() => { window.dispatchEvent(new CustomEvent('lakomics-sync-signals', {detail: {live: true, signals: {cards}}})); });
  report(1); report(2); await settle(1000);
  expect(vi.mocked(api.album).mock.calls.slice(2).map(call => call[0])).toEqual([null, 'cursor-1']);
  expect(screen.getByRole('button', {name: '하나 · R'})).toBeTruthy();
});

it('shows an error without dropping the cards and retries', async () => {
  const api = apiFixture([page([luna('n')], 'cursor-1')]);
  render(<TabletCardAlbum api={api} onClose={vi.fn()}/>); await settle(500);
  vi.mocked(api.album).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', {name: '더 보기'})); await settle(500);
  expect(screen.getByRole('alert').textContent).toContain('카드 앨범을 불러오지 못했습니다');
  expect(screen.getByRole('button', {name: '루나 · N'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: '다시 시도'})); await settle(500);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('opens a character in a bottom sheet, switches tiers there, and closes with Back before leaving the album', async () => {
  const api = apiFixture([page([luna('n', 4), luna('ssr', 1), mika])]);
  const backRef: MutableRefObject<(() => boolean) | null> = {current: null}, onClose = vi.fn();
  render(<TabletCardAlbum api={api} backRef={backRef} onClose={onClose}/>); await settle(500);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: '루나 · SSR'}));
  const sheet = screen.getByRole('dialog', {name: '루나'});
  expect(within(sheet).getByRole('img', {name: /SSR 루나/})).toBeTruthy();
  expect(sheet.textContent).toContain('별자리');
  expect(sheet.textContent).toContain('Lv.3');
  fireEvent.click(within(sheet).getByRole('button', {name: 'N ×4'}));
  expect(within(screen.getByRole('dialog')).getByRole('img', {name: /N 루나/})).toBeTruthy();
  // No source folder or Asset route is wired, so no dead buttons.
  expect(within(sheet).queryByRole('button', {name: '원본 열기'})).toBeNull();
  expect(backRef.current!()).toBe(true);
  await settle(500);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(backRef.current!()).toBe(true);
  expect(onClose).toHaveBeenCalledOnce();
});

it('offers the source Asset and the character folder when the host wires them', async () => {
  const api = apiFixture([page([luna('ssr')])]);
  const asset = vi.fn(), character = vi.fn();
  render(<TabletCardAlbum api={api} onClose={vi.fn()} onOpenAsset={asset} onCharacter={character}/>); await settle(500);
  fireEvent.click(screen.getByRole('button', {name: '루나 · SSR'}));
  fireEvent.click(screen.getByRole('button', {name: '원본 열기'}));
  fireEvent.click(screen.getByRole('button', {name: '캐릭터 폴더'}));
  expect(asset).toHaveBeenCalledWith('a-ssr');
  expect(character).toHaveBeenCalledWith('c1');
});

it('goes back from the top bar', async () => {
  const onClose = vi.fn();
  render(<TabletCardAlbum api={apiFixture([page([])])} onClose={onClose}/>); await settle(500);
  fireEvent.click(screen.getByRole('button', {name: '홈으로'}));
  expect(onClose).toHaveBeenCalledOnce();
});
