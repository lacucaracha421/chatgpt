import {useEffect} from 'react';
import '@testing-library/jest-dom/vitest';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), ...mocks}));
import {CollectionProviderActions, ProviderAddAction, ProviderArtworkSheet, ProviderSearchSheet, ProviderThumb, useProviderStatus} from './CollectionProviders';
import {AUTHORITY_STATUS_PATH, COMMAND_PATH, readCommands} from './collectionCommandOutbox';
import {useCollectionAuthority} from './useCollectionAuthority';
import type {CollectionDetail} from './collectionModel';

const identity = {libraryId: 'e'.repeat(32), epoch: 7, contractVersion: 1 as const};
const item: CollectionDetail = {id: 'work-1', type: 'movie', name: '기존 영화', showcase: false, artworks: [], volumes: [], selectedWorkArtworkId: 'old'};
const poster = {kind: 'poster', path: '/poster.jpg', previewUrl: '/v1/providers/image?provider=tmdb&path=%2Fposter.jpg&size=w342', width: 500, height: 750};
const detail = {binding: {provider: 'tmdb', externalId: 'tv:42'}, metadata: {name: '선택한 영화', originalTitle: 'Original', year: 2025, overview: '줄거리'}, artwork: [poster, {...poster, kind: 'backdrop', path: '/back.jpg'}, {...poster, kind: 'season_poster', path: '/season.jpg', seasonNumber: 1}]};
let configured: boolean, offline: boolean;
beforeEach(() => {
  localStorage.clear(); setOutboxConnection('https://test.example'); mocks.api.mockReset(); mocks.native.mockReset(); configured = true; offline = true;
  mocks.native.mockResolvedValue({url: 'data:image/jpeg;base64,YQ=='});
  mocks.api.mockImplementation(async (path: string, _signal: unknown, body?: Record<string, unknown>) => {
    if (path === '/v1/providers/status') return {tmdb: configured, igdb: configured};
    if (path === AUTHORITY_STATUS_PATH) return {...identity, active: true};
    if (path.includes('/authority/baseline')) return path.includes('snapshot=')
      ? {...identity, items: [{workId: item.id, provider: 'tmdb', externalId: 'tv:42', bound: true}], hasMore: false}
      : {...identity, snapshotCursor: 20};
    if (path.includes('/search?')) return {items: [{externalId: 'tv:42', name: '검색한 영화', originalTitle: 'Original', year: 2025, previewUrl: poster.previewUrl}]};
    if (path === '/v1/providers/tmdb/tv/42') return detail;
    if (path === '/v1/providers/igdb/99') return {...detail, binding: {provider: 'igdb', externalId: '99'}, artwork: [{...poster, kind: 'cover'}]};
    if (path === '/v1/providers/apply') {
      if (offline) throw new Error('offline');
      return {receipts: (body?.operation === 'connect' ? ['bindProvider', 'applyProviderSnapshot'] : [body?.operation === 'create' ? 'createWork' : 'applyProviderSnapshot'])
        .map((commandType, index) => ({...identity, commandType, operationId: `derived-${index}`}))};
    }
    if (path === '/v1/providers/artwork') return {provider: 'tmdb', providerImageId: body?.path, original: {sha256: 'a'.repeat(64), sizeBytes: 123, contentType: 'image/jpeg'}, width: 500, height: 750};
    if (path === COMMAND_PATH) return body;
    throw new Error(`Unexpected ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function Harness({mode = 'add', type = 'movie', onClose = () => {}}: {mode?: 'add' | 'connect' | 'actions' | 'artwork'; type?: 'movie' | 'game'; onClose?: () => void}) {
  const authority = useCollectionAuthority(true, () => {}), status = useProviderStatus(true);
  useEffect(() => authority.observeLibrary(identity.libraryId), []);
  if (!authority.identity) return null;
  return mode === 'add' ? <ProviderAddAction type={type} authority={authority} status={status}/>
    : mode === 'connect' ? <ProviderSearchSheet item={item} provider="tmdb" authority={authority} onClose={onClose}/>
    : mode === 'actions' ? <CollectionProviderActions item={item} authority={authority} status={status} active/>
    : <ProviderArtworkSheet item={item} provider="tmdb" externalId="tv:42" authority={authority} onClose={onClose}/>;
}

it('gates add and detail actions on the server provider configuration', async () => {
  configured = false; render(<Harness/>);
  expect(await screen.findByRole('button', {name: 'TMDB에서 영화 추가'})).toBeDisabled();
  expect(screen.getByText('서버에 TMDB 키가 설정되지 않았습니다')).toBeTruthy();
  cleanup(); render(<Harness mode="actions"/>);
  fireEvent.click(await screen.findByRole('button', {name: '연결 · TMDB'}));
  expect(screen.getByRole('button', {name: 'TMDB에 연결'})).toBeDisabled();
  expect(screen.getByRole('button', {name: 'TMDB 새로고침'})).toBeDisabled();
  expect(screen.getByRole('button', {name: '포스터·배경 변경'})).toBeDisabled();
});

it('adds an IGDB game with a numeric external ID and the game create type', async () => {
  const previous = mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async (...args) => args[0].includes('/igdb/search?')
    ? {items: [{externalId: '99', name: '검색한 게임', year: 2025, previewUrl: null}]} : previous(...args));
  render(<Harness type="game"/>);
  const add = await screen.findByRole('button', {name: 'IGDB에서 게임 추가'});
  await waitFor(() => expect(add).not.toBeDisabled()); fireEvent.click(add);
  expect(screen.queryByRole('radio', {name: 'TV 시리즈'})).toBeNull();
  fireEvent.change(screen.getByLabelText('검색어'), {target: {value: '게임'}});
  fireEvent.click(screen.getByRole('button', {name: '검색'}));
  fireEvent.click(await screen.findByRole('button', {name: /검색한 게임/}));
  await screen.findByText('줄거리'); fireEvent.click(screen.getByRole('button', {name: '추가'}));
  await waitFor(() => expect(readCommands()).toHaveLength(1));
  expect(readCommands()[0].command).toMatchObject({operation: 'create', provider: 'igdb', externalId: '99', type: 'game'});
});

it('searches TV, previews metadata, and queues create with a stable UUID and the exact S3 body', async () => {
  render(<Harness/>);
  const add = await screen.findByRole('button', {name: 'TMDB에서 영화 추가'});
  await waitFor(() => expect(add).not.toBeDisabled()); fireEvent.click(add);
  fireEvent.change(screen.getByLabelText('검색어'), {target: {value: '검색'}});
  fireEvent.click(screen.getByRole('radio', {name: 'TV 시리즈'}));
  fireEvent.click(await screen.findByRole('button', {name: /검색한 영화/}));
  await screen.findByText('줄거리'); fireEvent.click(screen.getByRole('button', {name: '추가'}));
  await waitFor(() => expect(readCommands()).toHaveLength(1));
  const row = readCommands()[0], id = row.command.operationId;
  expect(row.command).toMatchObject({commandType: 'providerApply', operation: 'create', provider: 'tmdb', externalId: 'tv:42', type: 'movie'});
  expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  await waitFor(() => expect(mocks.api.mock.calls.some(([path]) => path === '/v1/providers/apply')).toBe(true));
  expect(mocks.api.mock.calls.find(([path]) => path === '/v1/providers/apply')![2]).toEqual({commandId: id, libraryId: identity.libraryId, epoch: 7, operation: 'create', provider: 'tmdb', externalId: 'tv:42', type: 'movie', workId: row.command.workId});
  expect(screen.getByText('대기')).toBeTruthy();
  expect(screen.getByRole('button', {name: '추가'})).toBeDisabled();
  expect(mocks.native).toHaveBeenCalledWith('providerImage', {path: poster.previewUrl, connection: 'https://test.example'}, expect.any(AbortSignal));
});

it('prefills connect from the work name and queues a connect without a create type', async () => {
  render(<Harness mode="connect"/>);
  expect((await screen.findByLabelText('검색어') as HTMLInputElement).value).toBe(item.name);
  fireEvent.click(await screen.findByRole('button', {name: /검색한 영화/}));
  await screen.findByText('줄거리'); fireEvent.click(screen.getByRole('button', {name: '연결'}));
  await waitFor(() => expect(readCommands()).toHaveLength(1));
  expect(readCommands()[0].command).toMatchObject({operation: 'connect', workId: item.id, provider: 'tmdb', externalId: 'tv:42'});
  expect(readCommands()[0].command).not.toHaveProperty('type');
});

it('queues refresh for the stored binding and exposes its pending state', async () => {
  render(<Harness mode="actions"/>); fireEvent.click(await screen.findByRole('button', {name: '연결 · TMDB'}));
  const refresh = screen.getByRole('button', {name: 'TMDB 새로고침'});
  await waitFor(() => expect(refresh).not.toBeDisabled()); fireEvent.click(refresh);
  await waitFor(() => expect(readCommands()).toHaveLength(1));
  expect(readCommands()[0].command).toMatchObject({operation: 'refresh', provider: 'tmdb', externalId: 'tv:42', workId: item.id});
  expect(readCommands()[0].command).not.toHaveProperty('type');
  expect(refresh).toBeDisabled();
});

it('keeps both artwork slots by default and shows season posters without cover selection', async () => {
  const close = vi.fn(); render(<Harness mode="artwork" onClose={close}/>);
  await screen.findByRole('button', {name: '포스터 1'});
  const season = screen.getByRole('region', {name: '시즌 포스터'});
  expect(within(season).queryByRole('button')).toBeNull();
  expect(screen.getAllByRole('button', {name: '유지'}).every(button => button.getAttribute('aria-pressed') === 'true')).toBe(true);
  fireEvent.click(screen.getByRole('button', {name: '저장'})); await waitFor(() => expect(close).toHaveBeenCalled());
  expect(mocks.api.mock.calls.some(([path]) => path === '/v1/providers/artwork' || path === COMMAND_PATH)).toBe(false);
});

it('uploads the selected poster, then queues add/select plus a clear for the backdrop', async () => {
  const close = vi.fn(); render(<Harness mode="artwork" onClose={close}/>);
  fireEvent.click(await screen.findByRole('button', {name: '포스터 1'}));
  fireEvent.click(within(screen.getByRole('region', {name: '배경'})).getByRole('button', {name: '비우기'}));
  fireEvent.click(screen.getByRole('button', {name: '저장'}));
  await waitFor(() => expect(close).toHaveBeenCalled());
  const writes = mocks.api.mock.calls.filter(([path]) => path === '/v1/providers/artwork' || path === COMMAND_PATH);
  expect(writes.map(([path, , body]) => path === COMMAND_PATH ? body.commandType : 'upload')).toEqual(['upload', 'addArtwork', 'selectArtwork', 'selectArtwork']);
  expect(writes.at(-1)![2]).toMatchObject({slot: 'backdrop', artworkId: null});
  await act(async () => {});
});

it('keeps the preview slot and fades in only after image load; errors restore the empty cover', async () => {
  const {container} = render(<ProviderThumb url={poster.previewUrl}/>);
  const slot = container.querySelector('.bind-thumb')!;
  expect(slot.querySelector('.bind-thumb-placeholder')).toBeTruthy();
  await waitFor(() => expect(slot.querySelector('img')).toBeTruthy());
  const image = slot.querySelector('img')!;
  expect(image).not.toHaveClass('is-loaded');
  fireEvent.load(image); expect(image).toHaveClass('is-loaded');
  fireEvent.error(image); expect(slot.querySelector('img')).toBeNull();
  expect(slot.querySelector('.bind-thumb-placeholder')).toBeTruthy();
});

it('discards a cancelled preview and ignores non-image bridge replies', async () => {
  let resolve!: (value: {url: string}) => void;
  mocks.native.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const {container, rerender} = render(<ProviderThumb url={poster.previewUrl}/>);
  const signal = mocks.native.mock.calls[0][2] as AbortSignal;
  mocks.native.mockResolvedValue({url: 'https://evil.example/image.jpg'});
  rerender(<ProviderThumb url={poster.previewUrl.replace('poster', 'next')}/>);
  expect(signal.aborted).toBe(true);
  await act(async () => resolve({url: 'data:image/jpeg;base64,YQ=='}));
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('.bind-thumb-placeholder')).toBeTruthy();
});

it('keeps an empty cover on preview transport failure', async () => {
  mocks.native.mockRejectedValue(new Error('offline'));
  const {container} = render(<ProviderThumb url={poster.previewUrl}/>);
  await act(async () => {});
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('.bind-thumb-placeholder')).toBeTruthy();
});
