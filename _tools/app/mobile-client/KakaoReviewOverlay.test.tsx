import '@testing-library/jest-dom/vitest';
import {act, cleanup, fireEvent, render, renderHook, screen, waitFor} from '@testing-library/react';
import {useState} from 'react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {CollectionSummary} from './collectionModel';
import type {BindRequest} from './collectionBindingsModel';
import type {useCollectionAuthority} from './useCollectionAuthority';
import type {KakaoReview} from '../src/library/types';
const mocks = vi.hoisted(() => ({api: vi.fn(), enqueue: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), api: mocks.api}));
import {KakaoReviewOverlay, useKakaoReviewQueue} from './KakaoReviewOverlay';

const review = (id: string, patch: Partial<KakaoReview> = {}): KakaoReview => ({collectionId: id, query: '던전 밥', querySource: 'mangadex', bound: false, volumes: [], highestOwnedVolume: 14, ownedCount: 14, partialDismissed: false, groupFingerprints: [], minVolume: null, maxVolume: null, hideConnectionPrompt: false, ...patch});
const work = (id: string, patch: Partial<KakaoReview> = {}): CollectionSummary => ({id, name: `Dungeon ${id}`, type: 'manga', showcase: false, kakaoReview: review(id, patch)});
const pending: BindRequest = {requestId: 1, operationId: 'pick', collectionId: 'a', provider: 'kakao', choice: {}, expected: null, state: 'pending', reason: null, replaces: null, createdAt: '', updatedAt: '', resolvedAt: null};
const status = {version: 1 as const, mangadexSearch: true, kakaoSearch: true, bindRequests: true, publisherSeenAt: 'today'};
beforeEach(() => {
  mocks.api.mockReset(); mocks.enqueue.mockReset();
  mocks.api.mockImplementation(async (path: string) => {
    if (path.includes('/search/kakao')) return {version: 1, provider: 'kakao', query: '던전 밥', items: [{anchorItemId: 'book', groupFingerprint: 'fingerprint', title: '던전밥', author: '작가', publisher: '출판사', volumes: [], volumeCount: 14, firstVolume: 1, lastVolume: 14, ignoredCount: 0, knownItemIds: [], thumbnailUrl: null}]};
    if (path === '/v1/collections/bindings/requests') return {version: 1, request: pending};
    if (path.endsWith('/bindings/status')) return status;
    if (path.includes('/bindings/requests?')) return {version: 1, items: [], pending: null, nextCursor: null};
    if (path.startsWith('/v1/collections?')) return {ready: true, revision: 'r', items: [work('a')], nextCursor: null};
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => {cleanup(); vi.useRealTimers(); vi.unstubAllGlobals();});
function Harness({features = ['kakaoReview'], initialRequests = []}: {features?: string[]; initialRequests?: BindRequest[]} = {}) {
  const [items, setItems] = useState([work('a'), work('b'), work('c', {bound: true, volumes: Array.from({length: 12}, (_, i) => i + 1)})]);
  const [requests, setRequests] = useState<BindRequest[]>(initialRequests);
  const authority = {features, failure: '', work: (item: CollectionSummary) => item,
    enqueue: (command: {workId: string; commandType: string; dismissed?: boolean; hideConnectionPrompt?: boolean}) => {
      mocks.enqueue(command);
      setItems(current => current.map(item => item.id !== command.workId ? item : {...item, kakaoReview: {...item.kakaoReview!, ...(command.commandType === 'setKakaoPartialDismissed' ? {partialDismissed: command.dismissed!} : {hideConnectionPrompt: command.hideConnectionPrompt!})}}));
    },
  } as unknown as ReturnType<typeof useCollectionAuthority>;
  return <KakaoReviewOverlay open active onClose={vi.fn()} authority={authority} cover={() => <span/>}
    queue={{items, requests, ready: true, revision: 'r', status, error: '', refresh: vi.fn(), filed: request => setRequests([request])}}/>;
}
it('labels pinned server pending requests independently of old status and shows failed reasons inline', async () => {
  render(<Harness initialRequests={[{...pending, executor: 'server'}, {...pending, requestId: 2, collectionId: 'b', executor: 'server', state: 'failed', reason: {code: 'bindingChanged', message: '현재 연결을 확인하고 다시 선택해 주세요.'}}]}/>);
  expect(screen.getByText('서버에서 연결 처리 중 1')).toBeInTheDocument();
  expect(screen.queryByText('PC 적용 대기 1')).not.toBeInTheDocument();
  expect(screen.getByText('연결 실패 · 현재 연결을 확인하고 다시 선택해 주세요.')).toBeInTheDocument();
  expect(screen.getByRole('button', {name: 'Dungeon b 찾기'})).toBeInTheDocument();
});

it('retains the previous queue while rereading and a stale older request cannot replace a just-filed choice', async () => {
  const original = mocks.api.getMockImplementation()!;
  const {result} = renderHook(() => useKakaoReviewQueue(true, 0));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let finish!: (value: unknown) => void;
  mocks.api.mockImplementation((path: string, ...args: unknown[]) => path.includes('/bindings/requests?') ? new Promise(resolve => {finish = resolve;}) : original(path, ...args));
  act(() => result.current.refresh());
  await waitFor(() => expect(finish).toBeDefined());
  expect(result.current.items.map(item => item.id)).toEqual(['a']);
  const fresh = {...pending, requestId: 10, executor: 'server' as const};
  act(() => result.current.filed(fresh));
  await act(async () => finish({version: 1, items: [{...pending, requestId: 9}], nextCursor: null}));
  expect(result.current.requests).toEqual([fresh]);
  expect(result.current.items.map(item => item.id)).toEqual(['a']);
  expect(new URL(mocks.api.mock.calls.find(([path]) => String(path).includes('/bindings/requests?'))![0], 'https://fixture').searchParams.get('state')).toBe('all');
});
it('prefills the Korean title, checks an exact match and files one request directly into the waiting fold', async () => {
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', {name: 'Dungeon a 찾기'}));
  expect(await screen.findByRole('searchbox', {name: '카카오 검색어'})).toHaveValue('던전 밥');
  expect(await screen.findByRole('checkbox', {name: '던전밥 1–14권'})).toBeChecked();
  expect(screen.getByText('보유 14권', {selector: '.book-connect__work small'})).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name: '연결 요청'}));
  expect(await screen.findByText('PC 적용 대기 1')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('button', {name: 'Dungeon a 찾기'})).not.toBeInTheDocument());
  expect(screen.queryByRole('dialog', {name: '이 작품으로 연결할까요?'})).not.toBeInTheDocument();
  const post = mocks.api.mock.calls.find(([path]) => path === '/v1/collections/bindings/requests');
  expect(post?.[2]).toMatchObject({collectionId: 'a', provider: 'kakao', choice: {query: '던전 밥', groups: [{anchorItemId: 'book', groupFingerprint: 'fingerprint'}]}});
});
it('excludes a partial work through authority and supports undo', async () => {
  render(<Harness/>);
  fireEvent.click(screen.getByRole('radio', {name: '일부 권 1'}));
  await screen.findByText('13–14권 없음');
  fireEvent.click(screen.getByRole('button', {name: 'Dungeon c 더보기'}));
  fireEvent.click(await screen.findByRole('button', {name: '이대로 두기'}));
  await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledWith({commandType: 'setKakaoPartialDismissed', workId: 'c', dismissed: true, expectedVolumes: Array.from({length: 12}, (_, i) => i + 1)}));
  fireEvent.click(await screen.findByRole('button', {name: '되돌리기'}));
  await waitFor(() => expect(mocks.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({dismissed: false})));
});
it('undoes an unlinked exclusion against the range value that the first request will write', async () => {
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', {name: 'Dungeon a 더보기'}));
  fireEvent.click(await screen.findByRole('button', {name: '연결 안 함'}));
  expect(mocks.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({hideConnectionPrompt: true, expectedRange: {minVolume: null, maxVolume: null, hideConnectionPrompt: false}}));
  fireEvent.click(await screen.findByRole('button', {name: '되돌리기'}));
  expect(mocks.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({hideConnectionPrompt: false, expectedRange: {minVolume: null, maxVolume: null, hideConnectionPrompt: true}}));
});
it('reads every replica and pending-request page independent of the current shelf filters', async () => {
  mocks.api.mockImplementation(async (path: string) => {
    const url = new URL(path, 'https://fixture');
    if (path.endsWith('/bindings/status')) return status;
    if (path.includes('/bindings/requests?')) return url.searchParams.has('before') ? {items: [{...pending, requestId: 51, collectionId: 'b'}], nextCursor: null} : {items: [pending], nextCursor: 50};
    return {ready: true, revision: 'r', items: [work(url.searchParams.has('cursor') ? 'b' : 'a')], nextCursor: url.searchParams.has('cursor') ? null : 'next'};
  });
  const {result} = renderHook(() => useKakaoReviewQueue(true, 0));
  await waitFor(() => expect(result.current.items).toHaveLength(2));
  expect(result.current.requests).toHaveLength(2);
  const reads = mocks.api.mock.calls.filter(([path]) => String(path).startsWith('/v1/collections?'));
  expect(reads.every(([path]) => new URL(path, 'https://fixture').searchParams.get('q') === '')).toBe(true);
  expect(reads.every(([path]) => new URL(path, 'https://fixture').searchParams.get('showcase') === 'false')).toBe(true);
});

it('does not read or poll the full queue while the overlay is closed', async () => {
  vi.useFakeTimers();
  renderHook(() => useKakaoReviewQueue(false, 0));
  await act(async () => vi.advanceTimersByTime(120_000));
  expect(mocks.api).not.toHaveBeenCalled();
});

it('folds an exclusion, moves focus and unfolds undo', async () => {
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', {name: 'Dungeon a 더보기'}));
  fireEvent.click(await screen.findByRole('button', {name: '연결 안 함'}));
  expect(document.querySelector('[data-review-id="a"]')).toHaveClass('is-folding');
  await waitFor(() => expect(screen.queryByRole('button', {name: 'Dungeon a 찾기'})).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole('button', {name: 'Dungeon b 찾기'})).toHaveFocus());
  fireEvent.click(screen.getByRole('button', {name: '되돌리기'}));
  expect(document.querySelector('[data-review-id="a"]')).toHaveClass('is-entering');
  await waitFor(() => expect(screen.getByRole('button', {name: 'Dungeon a 찾기'})).toHaveFocus());
});

it('hides dismissal actions for an older server', async () => {
  render(<Harness features={[]}/>);
  fireEvent.click(screen.getByRole('radio', {name: '일부 권 1'}));
  await screen.findByRole('button', {name: 'Dungeon c 다시 연결'});
  expect(screen.queryByRole('button', {name: 'Dungeon c 더보기'})).not.toBeInTheDocument();
});

it('does not preselect multiple exact-match editions', async () => {
  const original = mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async (path: string, ...args: unknown[]) => {
    const reply = await original(path, ...args);
    return path.includes('/search/kakao') ? {...reply, items: [reply.items[0], {...reply.items[0], groupFingerprint: 'another'}]} : reply;
  });
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', {name: 'Dungeon a 찾기'}));
  const choices = await screen.findAllByRole('checkbox', {name: '던전밥 1–14권'});
  choices.forEach(choice => expect(choice).not.toBeChecked());
  expect(screen.getByRole('button', {name: '연결 요청'})).toBeDisabled();
});

it('folds undo after switching to excluded', async () => {
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', {name: 'Dungeon a 더보기'}));
  fireEvent.click(await screen.findByRole('button', {name: '연결 안 함'}));
  await waitFor(() => expect(screen.queryByRole('button', {name: 'Dungeon a 찾기'})).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('radio', {name: '제외 1'}));
  await screen.findByRole('button', {name: 'Dungeon a 다시 점검'});
  fireEvent.click(screen.getByRole('button', {name: '되돌리기'}));
  expect(document.querySelector('[data-review-id="a"]')).toHaveClass('is-folding');
  await waitFor(() => expect(screen.queryByRole('button', {name: 'Dungeon a 다시 점검'})).not.toBeInTheDocument());
});

it('removes exclusions without a motion delay when reduced motion is requested', async () => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn()}));
  render(<Harness/>);
  fireEvent.click(screen.getByRole('button', {name: 'Dungeon a 더보기'}));
  await act(async () => fireEvent.click(screen.getByRole('button', {name: '연결 안 함'})));
  await waitFor(() => expect(document.querySelector('[data-review-id="a"]')).toBeNull());
  await waitFor(() => expect(screen.getByRole('button', {name: 'Dungeon b 찾기'})).toHaveFocus());
});
