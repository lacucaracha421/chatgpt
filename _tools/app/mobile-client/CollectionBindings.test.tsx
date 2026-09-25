import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {useState} from 'react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {CollectionDetail} from './collectionModel';

const mocks = vi.hoisted(() => ({api: vi.fn()}));
vi.mock('./transport', async () => {
  const actual = await vi.importActual<typeof import('./transport')>('./transport');
  return {...actual, api: mocks.api};
});
import {ApiError} from './transport';
import {CollectionBindings} from './CollectionBindings';
import type {BindProvider, BindRequest} from './collectionBindings';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const base: CollectionDetail = {id: 'w1', name: '밤의 도서관', type: 'manga', showcase: false, volumes: [], artworks: [],
  releaseWatch: {enabled: false, available: false}, releaseSchedule: {kakao: null, mangadex: null}};
const mangadexItems = [
  {mangaId: '5b1c1c6a-3f7e-4bd1-9d55-2d1b8f7a4a10', title: 'Yoru no Toshokan', alternateTitles: ['The Night Library', '夜の図書館'], author: '서유진', year: 2021, status: 'completed', primaryCoverFileName: 'c.jpg', coverUrl: 'https://uploads.mangadex.org/covers/5b1c1c6a-3f7e-4bd1-9d55-2d1b8f7a4a10/c.jpg.256.jpg'},
  {mangaId: '9c0a2f4e-7d1b-4c3a-8e6f-1a2b3c4d5e6f', title: 'Other', alternateTitles: [], author: null, year: null, status: null, coverUrl: null},
];
const kakaoItems = [
  {anchorItemId: 'k-anchor', groupFingerprint: 'f'.repeat(64), title: '밤의 도서관', author: '서유진', publisher: '대원씨아이', volumes: [], ignoredCount: 0, volumeCount: 12, firstVolume: 1, lastVolume: 12, knownItemIds: ['x'], thumbnailUrl: 'https://search1.kakaocdn.net/thumb/R120x174/?fname=x'},
];
type Reply = unknown | ((path: string, body?: Record<string, unknown>) => unknown);
let routes: {status: Reply; requests: Reply; mangadex: Reply; kakao: Reply; post: Reply};
const request = (patch: Partial<BindRequest>): BindRequest => ({requestId: 1, operationId: '00000000-0000-4000-8000-000000000001', collectionId: 'w1', provider: 'mangadex', choice: {mangaId: 'm', title: 'Picked title'}, expected: null, state: 'pending', reason: null, replaces: null, createdAt: '', updatedAt: '', resolvedAt: null, ...patch});
const answer = async (reply: Reply, path: string, body?: Record<string, unknown>) => {
  const value = typeof reply === 'function' ? (reply as (path: string, body?: Record<string, unknown>) => unknown)(path, body) : reply;
  if (value instanceof Error) throw value;
  return value;
};
const apiError = (status: number, code: string, extra = {}) => new ApiError('서버가 요청을 처리하지 못했습니다.', status, {detail: {code, message: '서버 메시지', ...extra}});
const calls = (fragment: string) => mocks.api.mock.calls.filter(([path]) => String(path).includes(fragment));
const posts = () => mocks.api.mock.calls.filter(([path, , , method]) => path === '/v1/collections/bindings/requests' && method === 'POST').map(([, , body]) => body as Record<string, unknown>);

beforeEach(() => {
  mocks.api.mockReset();
  routes = {
    status: {version: 1, mangadexSearch: true, kakaoSearch: true, bindRequests: true, publisherSeenAt: '2026-09-25T00:00:00Z'},
    requests: {version: 1, items: [], pending: {mangadex: null, kakao: null}},
    mangadex: (path: string) => ({version: 1, provider: 'mangadex', query: new URL(path, 'https://x').searchParams.get('query'), items: mangadexItems}),
    kakao: {version: 1, provider: 'kakao', query: '밤의 도서관', items: kakaoItems},
    post: (_path: string, body?: Record<string, unknown>) => ({version: 1, request: request({operationId: String(body!.operationId), provider: body!.provider as BindProvider, choice: body!.choice as Record<string, unknown>})}),
  };
  mocks.api.mockImplementation((path: string, _signal: unknown, body?: Record<string, unknown>) => {
    if (path === '/v1/collections/bindings/status') return answer(routes.status, path);
    if (path.startsWith('/v1/collections/bindings/search/mangadex')) return answer(routes.mangadex, path);
    if (path.startsWith('/v1/collections/bindings/search/kakao')) return answer(routes.kakao, path);
    if (path === '/v1/collections/bindings/requests') return answer(routes.post, path, body);
    if (path.startsWith('/v1/collections/bindings/requests?')) return answer(routes.requests, path);
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

function Harness({item}: {item: CollectionDetail}) {
  const [sheet, setSheet] = useState<BindProvider | null>(null);
  return <CollectionBindings item={item} active refreshKey="0" sheet={sheet} onSheet={setSheet}/>;
}
const area = () => screen.getByRole('region', {name: '연결'});
const row = (name: string) => within(area()).getByText(name, {selector: '.collection-personal-label'}).closest('.collection-binding-row') as HTMLElement;
async function renderArea(item: CollectionDetail = base) {
  render(<Harness item={item}/>);
  await waitFor(() => expect(calls('/requests?')).toHaveLength(1));
  await waitFor(() => expect(calls('/status')).toHaveLength(1));
}
async function openSheet(provider: 'MangaDex' | '카카오', verb = '연결') {
  fireEvent.click(within(area()).getByRole('button', {name: `${provider} ${verb}`}));
  return screen.findByRole('dialog', {name: `${provider} 연결`});
}

it('shows each connection from the published schedule and reads the requests for this Collection', async () => {
  await renderArea({...base, releaseWatch: {enabled: true, available: true}, releaseSchedule: {mangadex: {checkedAt: null, latestVolume: 3, volumes: []}, kakao: null}});
  expect(calls('/requests?')[0][0]).toBe('/v1/collections/bindings/requests?collectionId=w1&state=all&limit=20');
  expect(row('MangaDex').textContent).toContain('연결됨');
  expect(within(row('MangaDex')).getByRole('button', {name: 'MangaDex 다시 연결'})).toBeTruthy();
  // Release watch available without a Kakao schedule: only the retired Aladin binding.
  expect(row('카카오').textContent).toContain('알라딘 연결');
  expect(row('카카오').textContent).toContain('카카오로 다시 연결해 주세요.');
  expect(screen.queryByText('PC 앱을 업데이트해야 여기서 고른 연결이 적용돼요.')).toBeNull();
});

it('shows unconnected providers, and a note when no PC has read the bind requests yet', async () => {
  routes.status = {version: 1, mangadexSearch: true, kakaoSearch: true, bindRequests: true, publisherSeenAt: null};
  await renderArea();
  expect(row('MangaDex').textContent).toContain('연결 안 됨');
  expect(within(row('카카오')).getByRole('button', {name: '카카오 연결'})).toBeTruthy();
  expect(await screen.findByText('PC 앱을 업데이트해야 여기서 고른 연결이 적용돼요.')).toBeTruthy();
});

it('shows a pending request waiting for the PC and a failed one with its reason', async () => {
  const failed = request({requestId: 3, provider: 'kakao', state: 'failed', choice: {title: '밤의 도서관'}, reason: {code: 'groupNotFound', message: '카카오에서 같은 시리즈를 찾지 못했어요.'}});
  const pending = request({requestId: 4, provider: 'mangadex', choice: {mangaId: 'm', title: 'The Night Library'}});
  routes.requests = {version: 1, items: [pending, failed, request({requestId: 2, provider: 'kakao', state: 'superseded'})], pending: {mangadex: pending, kakao: null}};
  await renderArea();
  await waitFor(() => expect(row('MangaDex').textContent).toContain('연결 대기 · PC가 켜지면 적용'));
  expect(row('MangaDex').textContent).toContain('The Night Library');
  expect(row('카카오').textContent).toContain('연결 실패');
  expect(row('카카오').textContent).toContain('카카오에서 같은 시리즈를 찾지 못했어요.');
  expect(within(row('카카오')).getByRole('button', {name: '카카오 다시 연결'})).toBeTruthy();
});

it('hides the buttons on a server without bindings', async () => {
  routes.status = new ApiError('요청한 정보를 찾을 수 없습니다.', 404, {detail: 'Not Found'});
  routes.requests = new ApiError('요청한 정보를 찾을 수 없습니다.', 404, {detail: 'Not Found'});
  await renderArea();
  expect(await screen.findByText('서버를 업데이트하면 여기서 MangaDex와 카카오를 연결할 수 있어요.')).toBeTruthy();
  expect(within(area()).queryAllByRole('button')).toHaveLength(0);
});

it('searches MangaDex for the title, lists covers and details, and files the confirmed pick', async () => {
  await renderArea();
  const sheet = await openSheet('MangaDex');
  expect((within(sheet).getByRole('searchbox', {name: 'MangaDex 검색어'}) as HTMLInputElement).value).toBe('밤의 도서관');
  const results = await within(sheet).findByRole('list', {name: 'MangaDex 검색 결과'});
  expect(calls('/search/mangadex')[0][0]).toBe('/v1/collections/bindings/search/mangadex?query=%EB%B0%A4%EC%9D%98+%EB%8F%84%EC%84%9C%EA%B4%80');
  const first = within(results).getAllByRole('button')[0];
  expect(first.textContent).toContain('Yoru no Toshokan');
  expect(first.textContent).toContain('The Night Library · 夜の図書館');
  expect(first.textContent).toContain('서유진 · 2021 · 완결');
  const cover = first.querySelector('img')!;
  expect(cover.getAttribute('src')).toBe(mangadexItems[0].coverUrl);
  expect(cover.getAttribute('referrerpolicy')).toBe('no-referrer');
  // No cover URL: a placeholder instead of a broken image.
  expect(within(results).getAllByRole('button')[1].querySelector('img')).toBeNull();
  fireEvent.click(first);
  const confirm = await screen.findByRole('dialog', {name: '이 작품으로 연결할까요?'});
  fireEvent.click(within(confirm).getByRole('button', {name: '연결 요청'}));
  await waitFor(() => expect(posts()).toHaveLength(1));
  const body = posts()[0];
  expect(body.operationId).toMatch(UUID);
  expect(body).toEqual({version: 1, operationId: body.operationId, collectionId: 'w1', provider: 'mangadex',
    choice: {mangaId: mangadexItems[0].mangaId, title: 'Yoru no Toshokan', coverUrl: mangadexItems[0].coverUrl}, expected: {externalId: null}});
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(row('MangaDex').textContent).toContain('연결 대기 · PC가 켜지면 적용');
  expect(row('MangaDex').textContent).toContain('Yoru no Toshokan');
  // The list is read again after filing.
  await waitFor(() => expect(calls('/requests?').length).toBeGreaterThanOrEqual(2));
});

it('searches Kakao and sends back the normalized query with the exact group fields', async () => {
  routes.kakao = {version: 1, provider: 'kakao', query: '밤의 도서관 (normalized)', items: kakaoItems};
  await renderArea({...base, releaseWatch: {enabled: false, available: true}, releaseSchedule: {kakao: {editionIndex: 0, checkedAt: null, volumes: []}, mangadex: null}});
  const sheet = await openSheet('카카오', '다시 연결');
  const results = await within(sheet).findByRole('list', {name: '카카오 검색 결과'});
  const box = within(results).getByRole('checkbox', {name: '밤의 도서관 1–12권'}) as HTMLInputElement;
  const first = box.closest('li')!;
  expect(first.textContent).toContain('서유진 · 대원씨아이');
  expect(first.textContent).toContain('1–12권');
  expect(first.querySelector('img')!.getAttribute('src')).toBe(kakaoItems[0].thumbnailUrl);
  expect(within(sheet).getByText('같은 작품이 권수별로 나뉘어 있으면 여러 개를 함께 고르세요.')).toBeTruthy();
  const connect = within(sheet).getByRole('button', {name: '0개 묶음 연결'}) as HTMLButtonElement;
  expect(connect.disabled).toBe(true);
  fireEvent.click(box);
  fireEvent.click(within(sheet).getByRole('button', {name: '1개 묶음 연결'}));
  const confirm = await screen.findByRole('dialog', {name: '이 작품으로 연결할까요?'});
  expect(within(confirm).queryByRole('list', {name: '고른 묶음'})).toBeNull();
  expect(confirm.textContent).toContain('서유진 · 대원씨아이 · 1–12권');
  fireEvent.click(within(confirm).getByRole('button', {name: '연결 요청'}));
  await waitFor(() => expect(posts()).toHaveLength(1));
  // Already connected: the tablet does not know the current binding, so it sends no expectation.
  expect(posts()[0]).toEqual({version: 1, operationId: posts()[0].operationId, collectionId: 'w1', provider: 'kakao',
    choice: {query: '밤의 도서관 (normalized)', groups: [{anchorItemId: 'k-anchor', groupFingerprint: 'f'.repeat(64), title: '밤의 도서관', firstVolume: 1, lastVolume: 12, volumeCount: 12}],
      title: '밤의 도서관', author: '서유진', publisher: '대원씨아이', volumeCount: 12, thumbnailUrl: kakaoItems[0].thumbnailUrl}});
  await waitFor(() => expect(row('카카오').textContent).toContain('연결 대기 · PC가 켜지면 적용'));
});

const splitItems = [
  {...kakaoItems[0], anchorItemId: 'k-late', groupFingerprint: 'b'.repeat(64), title: '밤의 도서관', volumeCount: 5, firstVolume: 11, lastVolume: 15, thumbnailUrl: null},
  {...kakaoItems[0], anchorItemId: 'k-early', groupFingerprint: 'a'.repeat(64), title: '밤의 도서관', volumeCount: 10, firstVolume: 1, lastVolume: 10},
  {...kakaoItems[0], anchorItemId: 'k-other', groupFingerprint: 'c'.repeat(64), title: '밤의 도서관 애장판', publisher: '학산문화사', volumeCount: 6, firstVolume: 1, lastVolume: 6},
];

it('toggles several Kakao groups and joins them in volume order into one request', async () => {
  routes.kakao = {version: 1, provider: 'kakao', query: '밤의 도서관', items: splitItems};
  await renderArea();
  const sheet = await openSheet('카카오');
  const results = await within(sheet).findByRole('list', {name: '카카오 검색 결과'});
  const late = within(results).getByRole('checkbox', {name: '밤의 도서관 11–15권'}) as HTMLInputElement;
  const early = within(results).getByRole('checkbox', {name: '밤의 도서관 1–10권'}) as HTMLInputElement;
  const other = within(results).getByRole('checkbox', {name: '밤의 도서관 애장판 1–6권'}) as HTMLInputElement;
  // Tapping anywhere on the row toggles it.
  fireEvent.click(late.closest('label')!.querySelector('strong')!);
  expect(late.checked).toBe(true);
  fireEvent.click(other);
  fireEvent.click(early);
  expect(within(sheet).getByRole('button', {name: '3개 묶음 연결'})).toBeTruthy();
  fireEvent.click(other);
  expect(other.checked).toBe(false);
  expect(late.closest('label')!.classList.contains('is-selected')).toBe(true);
  fireEvent.click(within(sheet).getByRole('button', {name: '2개 묶음 연결'}));
  const confirm = await screen.findByRole('dialog', {name: '이 작품으로 연결할까요?'});
  const picked = within(confirm).getByRole('list', {name: '고른 묶음'});
  expect(within(picked).getAllByRole('listitem').map(item => item.textContent)).toEqual(['밤의 도서관1–10권', '밤의 도서관11–15권']);
  expect(confirm.textContent).toContain('1–10권 + 11–15권 → 1–15권');
  fireEvent.click(within(confirm).getByRole('button', {name: '연결 요청'}));
  await waitFor(() => expect(posts()).toHaveLength(1));
  expect(posts()[0]).toEqual({version: 1, operationId: posts()[0].operationId, collectionId: 'w1', provider: 'kakao', expected: {externalId: null},
    choice: {query: '밤의 도서관', groups: [
      {anchorItemId: 'k-early', groupFingerprint: 'a'.repeat(64), title: '밤의 도서관', firstVolume: 1, lastVolume: 10, volumeCount: 10},
      {anchorItemId: 'k-late', groupFingerprint: 'b'.repeat(64), title: '밤의 도서관', firstVolume: 11, lastVolume: 15, volumeCount: 5},
    ], title: '밤의 도서관', author: '서유진', publisher: '대원씨아이', volumeCount: 15, thumbnailUrl: kakaoItems[0].thumbnailUrl}});
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(row('카카오').textContent).toContain('연결 대기 · PC가 켜지면 적용');
  expect(row('카카오').textContent).toContain('밤의 도서관 · 1–15권 · 2개 묶음');
});

it('clears the Kakao selection on a new search', async () => {
  routes.kakao = {version: 1, provider: 'kakao', query: '밤의 도서관', items: splitItems};
  await renderArea();
  const sheet = await openSheet('카카오');
  const results = await within(sheet).findByRole('list', {name: '카카오 검색 결과'});
  fireEvent.click(within(results).getAllByRole('checkbox')[0]);
  expect(within(sheet).getByRole('button', {name: '1개 묶음 연결'})).toBeTruthy();
  fireEvent.submit(within(sheet).getByRole('searchbox', {name: '카카오 검색어'}).closest('form')!);
  await waitFor(() => expect(calls('/search/kakao')).toHaveLength(2));
  expect(await within(sheet).findByRole('button', {name: '0개 묶음 연결'})).toBeTruthy();
  expect(within(sheet).getAllByRole('checkbox').every(box => !(box as HTMLInputElement).checked)).toBe(true);
});

it('shows a pending Kakao request of several groups with the joined title and range', async () => {
  const pending = request({requestId: 5, provider: 'kakao', choice: {query: 'q', title: '밤의 도서관', groups: [
    {anchorItemId: 'a', groupFingerprint: 'a'.repeat(64), firstVolume: 1, lastVolume: 10, volumeCount: 10},
    {anchorItemId: 'b', groupFingerprint: 'b'.repeat(64), firstVolume: 11, lastVolume: 15, volumeCount: 5}]}});
  routes.requests = {version: 1, items: [pending], pending: {mangadex: null, kakao: pending}};
  await renderArea();
  await waitFor(() => expect(row('카카오').textContent).toContain('연결 대기 · PC가 켜지면 적용'));
  expect(row('카카오').textContent).toContain('밤의 도서관 · 1–15권 · 2개 묶음');
});

it('keeps MangaDex a single tap with no checkboxes', async () => {
  await renderArea();
  const sheet = await openSheet('MangaDex');
  const results = await within(sheet).findByRole('list', {name: 'MangaDex 검색 결과'});
  expect(within(results).queryAllByRole('checkbox')).toHaveLength(0);
  expect(within(sheet).queryByText('같은 작품이 권수별로 나뉘어 있으면 여러 개를 함께 고르세요.')).toBeNull();
  expect(within(sheet).queryByRole('button', {name: /묶음 연결/})).toBeNull();
  fireEvent.click(within(results).getAllByRole('button')[0]);
  expect(await screen.findByRole('dialog', {name: '이 작품으로 연결할까요?'})).toBeTruthy();
});

it('submits the search field value itself, not a stale draft', async () => {
  await renderArea();
  const sheet = await openSheet('MangaDex');
  await within(sheet).findByRole('list', {name: 'MangaDex 검색 결과'});
  const field = within(sheet).getByRole('searchbox', {name: 'MangaDex 검색어'}) as HTMLInputElement;
  field.value = '夜の図書館';
  fireEvent.submit(field.closest('form')!);
  await waitFor(() => expect(calls('/search/mangadex')).toHaveLength(2));
  expect(calls('/search/mangadex')[1][0]).toContain(encodeURIComponent('夜の図書館'));
});

it('says the server has no Kakao key, without searching', async () => {
  routes.status = {version: 1, mangadexSearch: true, kakaoSearch: false, bindRequests: true, publisherSeenAt: 'x'};
  await renderArea();
  const sheet = await openSheet('카카오');
  expect(within(sheet).getByRole('alert').textContent).toBe('서버에 카카오 키가 없어 검색할 수 없어요.');
  expect((within(sheet).getByRole('button', {name: '검색'}) as HTMLButtonElement).disabled).toBe(true);
  expect(calls('/search/kakao')).toHaveLength(0);
});

it('explains a Kakao search the server refuses for a missing key or a too broad title', async () => {
  routes.kakao = apiError(503, 'kakaoSearchUnavailable');
  await renderArea();
  let sheet = await openSheet('카카오');
  expect((await within(sheet).findByRole('alert')).textContent).toContain('서버에 카카오 키가 없어 검색할 수 없어요.');
  expect(within(sheet).queryByRole('button', {name: '다시 시도'})).toBeNull();
  fireEvent.click(within(sheet).getByRole('button', {name: '닫기'}));
  routes.kakao = apiError(422, 'kakaoSearchTooBroad');
  sheet = await openSheet('카카오');
  expect((await within(sheet).findByRole('alert')).textContent).toContain('검색어를 더 구체적으로 적어 주세요.');
});

it('waits out the search rate limit with a countdown', async () => {
  routes.mangadex = apiError(429, 'bindSearchRateLimited', {retryAfter: 12});
  await renderArea();
  const sheet = await openSheet('MangaDex');
  const alert = await within(sheet).findByRole('alert');
  expect(alert.textContent).toContain('12초 후에 다시 검색할 수 있어요.');
  expect((within(sheet).getByRole('button', {name: '검색'}) as HTMLButtonElement).disabled).toBe(true);
  vi.useFakeTimers({shouldAdvanceTime: true});
  await act(async () => { vi.advanceTimersByTime(13_000); });
  await waitFor(() => expect(within(sheet).getByRole('alert').textContent).toContain('이제 다시 검색할 수 있어요.'));
  expect((within(sheet).getByRole('button', {name: '검색'}) as HTMLButtonElement).disabled).toBe(false);
});

it('offers a retry after a timeout or upstream failure, then shows the results', async () => {
  let attempt = 0;
  routes.mangadex = (path: string) => ++attempt === 1 ? apiError(504, 'bindSearchTimedOut') : {version: 1, provider: 'mangadex', query: 'q', items: mangadexItems, path};
  await renderArea();
  const sheet = await openSheet('MangaDex');
  expect((await within(sheet).findByRole('alert')).textContent).toContain('MangaDex 응답이 늦어요.');
  fireEvent.click(within(sheet).getByRole('button', {name: '다시 시도'}));
  expect(await within(sheet).findByRole('list', {name: 'MangaDex 검색 결과'})).toBeTruthy();
  expect(calls('/search/mangadex')[1][0]).toBe(calls('/search/mangadex')[0][0]);
  expect(within(sheet).queryByRole('alert')).toBeNull();
});

it('shows empty results and the offline message', async () => {
  routes.mangadex = {version: 1, provider: 'mangadex', query: '밤의 도서관', items: []};
  await renderArea();
  let sheet = await openSheet('MangaDex');
  expect(await within(sheet).findByText('검색 결과가 없어요. 다른 제목으로 찾아 보세요.')).toBeTruthy();
  fireEvent.click(within(sheet).getByRole('button', {name: '닫기'}));
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  routes.mangadex = new Error('서버에 연결할 수 없습니다. 주소와 네트워크를 확인해 주세요.');
  sheet = await openSheet('MangaDex');
  expect((await within(sheet).findByRole('alert')).textContent).toContain('오프라인이에요.');
  expect(within(sheet).getByRole('button', {name: '다시 시도'})).toBeTruthy();
});

it('keeps the confirm open on a failed request and retries with the same operation id', async () => {
  let attempt = 0;
  const post = routes.post as (path: string, body?: Record<string, unknown>) => unknown;
  routes.post = (path: string, body?: Record<string, unknown>) => ++attempt === 1 ? new Error('연결 시간이 초과되었습니다. 다시 시도해 주세요.') : post(path, body);
  await renderArea();
  const sheet = await openSheet('MangaDex');
  fireEvent.click(within(await within(sheet).findByRole('list', {name: 'MangaDex 검색 결과'})).getAllByRole('button')[0]);
  const confirm = await screen.findByRole('dialog', {name: '이 작품으로 연결할까요?'});
  fireEvent.click(within(confirm).getByRole('button', {name: '연결 요청'}));
  expect((await within(confirm).findByRole('alert')).textContent).toContain('연결 시간이 초과되었습니다.');
  fireEvent.click(within(confirm).getByRole('button', {name: '다시 보내기'}));
  await waitFor(() => expect(posts()).toHaveLength(2));
  expect(posts()[1].operationId).toBe(posts()[0].operationId);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});
