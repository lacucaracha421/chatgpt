import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ApiError} from './transport';
import {ReleaseCalendar} from './ReleaseCalendar';
import {groupReleaseEntries, releaseDateLabel, type ReleaseCalendarEntry} from './releaseCalendarModel';
import {setOutboxConnection} from './outboxConnection';

const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn()}));
vi.mock('./transport', async () => { const actual = await vi.importActual<typeof import('./transport')>('./transport'); return {...actual, api: mocks.api, native: mocks.native}; });

const entry = (id: string, kind: ReleaseCalendarEntry['kind'], date: string | null, precision: ReleaseCalendarEntry['precision'], extra: Partial<ReleaseCalendarEntry> & {events?: unknown[]} = {}): ReleaseCalendarEntry => ({
  id, kind, title: id, originalTitle: null, date, precision, region: kind === 'movie' ? 'korea' : null, platforms: kind === 'game' ? ['PC'] : [], releaseType: null, cover: {url: `https://img.example/${id}.jpg`}, unread: [], ...extra,
});

const movieEvent = {id: 'event-one', itemId: 'movie-one', kind: 'date_changed', previousValue: '2026-09-20', currentValue: '2026-10-01', detectedAt: '2026-09-28T00:00:00Z', readAt: null};

const reply = {
  version: 1,
  publishedAt: '2026-09-27T00:00:00Z',
  rangeStart: '2026-09-27',
  rangeEnd: '2027-03-27',
  entries: [entry('game-one', 'game', '2026-10-01', 'exact', {platforms: ['PC', 'PS5'], port: true}), entry('movie-one', 'movie', '2026-10-01', 'month'), entry('anime-one', 'anime', '2026-12-01', 'quarter'), entry('year-one', 'movie', '2027-01-01', 'year'), entry('unknown-one', 'game', null, 'tbd')],
  wishlist: [entry('movie-one', 'movie', '2026-10-01', 'month', {events: [movieEvent]})],
  pending: [],
};

beforeEach(() => {
  localStorage.clear();
  setOutboxConnection('https://example.invalid');
  mocks.api.mockReset(); mocks.native.mockReset();
  mocks.api.mockImplementation(async (path: string) => {
    if (path === '/v1/home/upcoming') return reply;
    if (path === '/v1/home/upcoming/wishlist') return {version: 1, operationId: 'op', sequence: 1, revision: 2};
    throw new Error(`unexpected path ${path}`);
  });
});

afterEach(() => { cleanup(); setOutboxConnection(null); delete window.LakomicsNative; });

describe('release calendar model', () => {
  it('keeps PC precision wording and groups exact dates inside month sections', () => {
    expect(releaseDateLabel('2026-10-01', 'exact', 2026)).toBe('10월 1일');
    expect(releaseDateLabel('2026-10-01', 'month', 2026)).toBe('10월 중');
    expect(releaseDateLabel('2026-10-01', 'quarter', 2026)).toBe('2026 Q4');
    expect(releaseDateLabel('2027-01-01', 'year', 2026)).toBe('2027년 중');
    expect(releaseDateLabel(null, 'tbd', 2026)).toBe('미정');
    const groups = groupReleaseEntries(reply.entries);
    expect(groups[0]).toMatchObject({label: '2026년 10월', items: 2});
    expect(groups[0]?.days.map(day => day.label)).toEqual(['10월 1일', '10월 중']);
    expect(groups.at(-1)?.label).toBe('미정');
  });
});

describe('ReleaseCalendar', () => {
  it('asks native for hashed Home covers when the Android bridge is available', async () => {
    const sha256 = 'b'.repeat(64);
    const hashed = {...reply, entries: reply.entries.map((row, index) => index === 0 ? {...row, cover: {sha256}} : row)};
    mocks.api.mockImplementation(async (path: string) => {
      if (path === '/v1/home/upcoming') return hashed;
      if (path === '/v1/home/upcoming/wishlist') return {version: 1, operationId: 'op', sequence: 1, revision: 2};
      throw new Error(`unexpected path ${path}`);
    });
    mocks.native.mockResolvedValue({url: 'https://app.lakomics.local/media-cache/1/hashed', expires_in: 240});
    window.LakomicsNative = {request: vi.fn(), cancel: vi.fn()};
    render(<ReleaseCalendar onClose={vi.fn()} />);
    await screen.findByText('game-one');
    await waitFor(() => expect(mocks.native).toHaveBeenCalledWith('homeCover', {sha256}, expect.any(AbortSignal)));
    expect(mocks.api.mock.calls.some(([path]) => path === `/v1/home/covers/${sha256}/media-ticket`)).toBe(false);
  });

  it('filters by kind and then by the counted interest list', async () => {
    render(<ReleaseCalendar onClose={vi.fn()} />);
    expect(await screen.findByRole('heading', {name: '2026년 10월'})).toBeTruthy();
    for (const name of ['전체 5', '게임 2', '영화 2', '애니 1']) expect(screen.getByRole('radio', {name})).toBeTruthy();
    const game = screen.getByText('game-one').closest('li')!;
    expect(within(game).getByRole('img', {name: 'PC'})).toBeTruthy();
    expect(within(game).getByRole('img', {name: 'PS5'})).toBeTruthy();
    expect(within(game).getByText('이식')).toBeTruthy();
    expect(screen.getAllByRole('img', {name: 'PC'}).length).toBe(2);
    expect(screen.queryByText('국내 개봉')).toBeNull();
    expect(screen.queryByText('일본 방영')).toBeNull();
    const movie = screen.getByText('movie-one').closest('li')!;
    expect(movie.querySelector('.release-calendar-kind')).toBeNull();
    expect(screen.getByText('발매일 변경 · 9월 20일 → 10월 1일')).toBeTruthy();
    expect(screen.getByText('NEW 1')).toBeTruthy();
    expect(screen.getAllByText('미정').length).toBe(2);
    fireEvent.click(screen.getByRole('radio', {name: /^게임/}));
    expect(screen.getByText('game-one')).toBeTruthy();
    expect(screen.queryByText('movie-one')).toBeNull();
    fireEvent.click(screen.getByRole('radio', {name: /^전체/}));
    fireEvent.click(screen.getByRole('button', {name: /^관심 목록/}));
    expect(screen.getByText('movie-one')).toBeTruthy();
    expect(screen.queryByText('game-one')).toBeNull();
    expect(screen.getByRole('button', {name: /^관심 목록/}).textContent).toContain('1');
  });

  it('writes an add intent and marks the title as pending immediately', async () => {
    render(<ReleaseCalendar onClose={vi.fn()} />);
    const card = await screen.findByText('game-one');
    const item = card.closest('li');
    expect(item).toBeTruthy();
    const bookmark = within(item!).getByRole('button', {name: /관심 목록에 추가/});
    expect(bookmark.closest('.release-calendar-cover')).toBeNull();
    expect(bookmark.closest('.release-calendar-date-row')).toBeTruthy();
    fireEvent.click(bookmark);
    expect(bookmark.getAttribute('aria-pressed')).toBe('true');
    expect(within(item!).getByText('동기화 대기')).toBeTruthy();
    const call = mocks.api.mock.calls.find(([path, , body]) => path === '/v1/home/upcoming/wishlist' && body);
    expect(call?.[2]).toMatchObject({version: 1, action: 'add', itemId: 'game-one'});
    expect(typeof (call?.[2] as {operationId?: unknown}).operationId).toBe('string');
  });

  it('acknowledges one unread calendar event without keeping the event line', async () => {
    render(<ReleaseCalendar onClose={vi.fn()} />);
    const movie = (await screen.findByText('movie-one')).closest('li')!;
    const eventLine = '발매일 변경 · 9월 20일 → 10월 1일';
    expect(within(movie).getByText(eventLine)).toBeTruthy();
    fireEvent.click(within(movie).getByRole('button', {name: 'movie-one 알림 확인'}));
    await waitFor(() => expect(mocks.api.mock.calls.some(([path, , body]) => path === '/v1/home/upcoming/wishlist' && (body as {action?: string})?.action === 'acknowledge')).toBe(true));
    const call = mocks.api.mock.calls.find(([path, , body]) => path === '/v1/home/upcoming/wishlist' && (body as {action?: string})?.action === 'acknowledge');
    expect(call?.[2]).toMatchObject({version: 1, action: 'acknowledge', itemId: 'movie-one', eventIds: ['event-one']});
    expect(screen.queryByText(eventLine)).toBeNull();
    expect(screen.queryByText('NEW 1')).toBeNull();
  });

  it('uses the calm unpublished message for an empty and a 404 snapshot', async () => {
    mocks.api.mockImplementationOnce(async (path: string) => { if (path === '/v1/home/upcoming') return {publishedAt: null, entries: [], wishlist: []}; return {}; });
    const first = render(<ReleaseCalendar onClose={vi.fn()} />);
    expect(await screen.findByText('6개월 안의 발매 정보 없음')).toBeTruthy();
    first.unmount();
    mocks.api.mockRejectedValueOnce(new ApiError('not found', 404, null));
    render(<ReleaseCalendar onClose={vi.fn()} />);
    expect(await screen.findByText('6개월 안의 발매 정보 없음')).toBeTruthy();
  });

  it('keeps covers neutral in privacy mode', async () => {
    localStorage.setItem('lakomics.mobile.privacyMode', '1');
    render(<ReleaseCalendar onClose={vi.fn()} />);
    await screen.findByText('game-one');
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getAllByLabelText('비공개 모드로 이미지 숨김').length).toBeGreaterThan(0);
  });
});
