import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {MutableRefObject} from 'react';
import {Artists} from './Artists';
import {choseongOf, matchesArtist, matchedPositions, type LibraryArtist} from './artistsModel';

const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn(), loadThumbnail: vi.fn()}));
vi.mock('./transport', () => ({api: mocks.api, native: mocks.native}));
vi.mock('./media', () => ({loadThumbnail: mocks.loadThumbnail}));
vi.mock('./Gallery', () => ({Gallery: ({intro, items, onOpen}: {intro?: React.ReactNode; items: {id: string}[]; onOpen(index: number): void}) => <div aria-label="자산 목록">{intro}{items.map((item, index) => <button key={item.id} onClick={() => onOpen(index)}>asset-{item.id}</button>)}</div>}));

const artist = (id: string, label: string, overrides: Partial<LibraryArtist> = {}): LibraryArtist => ({
  id, label, displayName: label, sourceName: label, keys: [`@${id}`], assetCount: 74, recentCount: 2,
  firstSavedAt: '2025-03-02T00:00:00Z', lastSavedAt: '2026-09-22T00:00:00Z', lastOpenedAt: '2026-01-19T00:00:00Z',
  pinned: false, hidden: false, main: false, coverAssetIds: [`${id}-1`, `${id}-2`, `${id}-3`, `${id}-4`, `${id}-5`], ...overrides,
});
const primary = artist('haneul', '하늘빛', {main: true});
const other = artist('honoka', '호노카', {assetCount: 66, keys: ['@honoka_p'], coverAssetIds: ['honoka-1', 'honoka-2']});
const cat = artist('hannat', '한낮고양이', {assetCount: 29, recentCount: 0, keys: ['@hannat_cat']});
const reply = {version: 1, revision: 4, publishedAt: '2026-09-27T00:00:00Z', generatedAt: '2026-09-27T00:00:00Z', settings: {mainMinCount: 5, recentMinCount: 2, recentDays: 30}, unknown: {none: 0, source: 0}, artists: [primary, other, cat], assignments: [{assetId: 'haneul-1', artistId: 'haneul', source: 'source_url' as const}]};
const detail = {...primary};
let backRef: MutableRefObject<(() => boolean) | null>;

function renderArtists() {
  backRef = {current: null};
  return render(<Artists endpoint="https://example.invalid" backRef={backRef} onOpenViewer={vi.fn()} />);
}

beforeEach(() => {
  localStorage.clear(); mocks.api.mockReset(); mocks.native.mockReset(); mocks.loadThumbnail.mockReset();
  mocks.api.mockImplementation(async (path: string) => {
    if (path === '/v1/library/artists') return reply;
    if (path.startsWith('/v1/library/artists/')) return {version: 1, revision: 4, artist: detail, assignedAssetCount: 1};
    if (path.startsWith('/v1/library/revisit/creator/')) return {items: [{id: 'haneul-1', kind: 'image', width: 600, height: 800}], has_more: false, next_cursor: null};
    throw new Error(`unexpected path ${path}`);
  });
  mocks.native.mockResolvedValue({});
  mocks.loadThumbnail.mockImplementation(async (asset: {id: string}) => ({...asset, preview: `blob:${asset.id}`}));
});
afterEach(() => {cleanup(); vi.restoreAllMocks();});

describe('artist model', () => {
  it('matches Korean initials and underlines the matched syllables', () => {
    expect(choseongOf('하늘빛')).toBe('ㅎㄴㅂ');
    expect(matchesArtist(primary, 'ㅎㄴ')).toBe(true);
    expect(matchedPositions('하늘빛', 'ㅎㄴ')).toEqual(new Set([0, 1]));
  });
});

describe('Artists', () => {
  it('renders a fixture list with today picks and major artist tiles', async () => {
    renderArtists();
    expect(await screen.findByRole('region', {name: '오늘'})).toBeTruthy();
    expect(screen.getByRole('button', {name: /하늘빛, 74장/})).toBeTruthy();
    expect(screen.getByText('주요 작가 · 1명')).toBeTruthy();
  });

  it('uses the calm unpublished state for an empty or 404 publication', async () => {
    mocks.api.mockRejectedValueOnce({status: 404});
    renderArtists();
    expect(await screen.findByText('PC 앱이 작가 목록을 아직 보내지 않았습니다')).toBeTruthy();
  });

  it('searches by choseong and underlines matching name syllables', async () => {
    renderArtists();
    await screen.findByRole('region', {name: '오늘'});
    fireEvent.click(screen.getByRole('button', {name: '작가 검색'}));
    fireEvent.change(screen.getByRole('searchbox', {name: '작가 검색'}), {target: {value: 'ㅎㄴ'}});
    await waitFor(() => expect(screen.getByRole('button', {name: /하늘빛, 74장/})).toBeTruthy());
    expect(document.querySelectorAll('mark').length).toBeGreaterThanOrEqual(2);
  });

  it('opens detail and consumes Back before leaving the artist hub', async () => {
    renderArtists();
    await screen.findByRole('region', {name: '오늘'});
    fireEvent.click(screen.getByRole('button', {name: /하늘빛, 74장/}));
    expect(await screen.findByRole('heading', {level: 2, name: '하늘빛'})).toBeTruthy();
    expect(mocks.api).toHaveBeenCalledWith('/v1/library/artists/haneul', expect.anything());
    act(() => { expect(backRef.current?.()).toBe(true); });
    expect(await screen.findByRole('region', {name: '오늘'})).toBeTruthy();
  });

  it('keeps all artist artwork as neutral placeholders in privacy mode', async () => {
    localStorage.setItem('lakomics.mobile.privacyMode', '1');
    renderArtists();
    await screen.findByRole('region', {name: '오늘'});
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getAllByLabelText('비공개 모드로 이미지 숨김').length).toBeGreaterThan(0);
  });
});
