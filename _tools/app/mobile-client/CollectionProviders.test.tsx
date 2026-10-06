import {useEffect, useState} from 'react';
import '@testing-library/jest-dom/vitest';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), ...mocks}));
import {ProviderArtworkSheet, ProviderSearchSheet, ProviderThumb, useProviderStatus} from './CollectionProviders';
import {WorkManage, type ManageSheet} from './CollectionWorkManage';
import {AUTHORITY_STATUS_PATH, COMMAND_PATH, readCommands} from './collectionCommandOutbox';
import {useCollectionAuthority} from './useCollectionAuthority';
import type {CollectionDetail} from './collectionModel';

const identity = {libraryId: 'e'.repeat(32), epoch: 7, contractVersion: 1 as const};
const item: CollectionDetail = {id: 'work-1', type: 'movie', name: '기존 영화', showcase: false, artworks: [], volumes: [], selectedWorkArtworkId: 'old'};
const poster = {kind: 'poster', path: '/poster.jpg', previewUrl: '/v1/providers/image?provider=tmdb&path=%2Fposter.jpg&size=w342', width: 500, height: 750};
const detail = {binding: {provider: 'tmdb', externalId: 'tv:42'}, metadata: {name: '선택한 영화', originalTitle: 'Original', year: 2025, overview: '줄거리'}, artwork: [poster, {...poster, kind: 'backdrop', path: '/back.jpg'}, {...poster, kind: 'season_poster', path: '/season.jpg', seasonNumber: 1}]};
let configured: boolean, offline: boolean, bound: boolean;
beforeEach(() => {
  localStorage.clear(); setOutboxConnection('https://test.example'); mocks.api.mockReset(); mocks.native.mockReset(); configured = true; offline = true; bound = true;
  mocks.native.mockResolvedValue({url: 'data:image/jpeg;base64,YQ=='});
  mocks.api.mockImplementation(async (path: string, _signal: unknown, body?: Record<string, unknown>) => {
    if (path === '/v1/providers/status') return {tmdb: configured, igdb: configured};
    if (path === AUTHORITY_STATUS_PATH) return {...identity, active: true};
    if (path.includes('/authority/baseline')) return path.includes('snapshot=')
      ? {...identity, items: bound ? [{workId: item.id, provider: 'tmdb', externalId: 'tv:42', bound: true}, {workId: 'game-1', provider: 'igdb', externalId: '99', bound: true}] : [], hasMore: false}
      : {...identity, snapshotCursor: 20};
    if (path.includes('/search?')) return {items: [{externalId: 'tv:42', name: '검색한 영화', originalTitle: 'Original', year: 2025, previewUrl: poster.previewUrl}]};
    if (path === '/v1/providers/tmdb/tv/42') return detail;
    if (path === '/v1/providers/igdb/99') return {...detail, binding: {provider: 'igdb', externalId: '99'}, artwork: [{...poster, kind: 'cover'}]};
    if (path === '/v1/providers/apply') {
      if (offline) throw new Error('offline');
      return {receipts: (body?.operation === 'connect' ? ['bindProvider', 'applyProviderSnapshot'] : [body?.operation === 'create' ? 'createWork' : 'applyProviderSnapshot'])
        .map((commandType, index) => ({...identity, commandType, operationId: `derived-${index}`}))};
    }
    if (path === '/v1/providers/artwork') return {provider: 'tmdb', providerImageId: body?.path, original: {sha256: 'a'.repeat(64), sizeBytes: 123, contentType: 'image/jpeg'},
      thumbnail: {sha256: 'b'.repeat(64), sizeBytes: 45, contentType: 'image/webp'}, width: 500, height: 750};
    if (path === COMMAND_PATH) return body;
    throw new Error(`Unexpected ${path}`);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function Harness({mode = 'actions', work = item, entityRevision = 3, onClose = () => {}, onForm = () => {}}: {mode?: 'connect' | 'actions' | 'artwork'; work?: CollectionDetail; entityRevision?: number | null; onClose?: () => void; onForm?: () => void}) {
  const authority = useCollectionAuthority(true, () => {}), status = useProviderStatus(true);
  const [sheet, setSheet] = useState<ManageSheet>('menu');
  useEffect(() => authority.observeLibrary(identity.libraryId), []);
  if (!authority.identity) return null;
  return mode === 'connect' ? <ProviderSearchSheet item={work} provider="tmdb" authority={authority} onClose={onClose}/>
    : mode === 'actions' ? <WorkManage item={work} authority={authority} status={status} active entityRevision={entityRevision} sheet={sheet} onSheet={setSheet} onForm={onForm} onDeleted={() => {}}/>
    : <ProviderArtworkSheet item={work} provider="tmdb" externalId="tv:42" authority={authority} onClose={onClose}/>;
}
const menu = () => screen.findByRole('dialog', {name: '작품 관리'});
const rowText = (row: HTMLElement) => row.textContent;

it('disables the provider rows with the server reason when the provider is not configured', async () => {
  configured = false; render(<Harness/>);
  const sheet = await menu();
  await within(sheet).findAllByText('서버에 TMDB 키가 설정되지 않았습니다');
  expect(within(sheet).getByRole('button', {name: /^TMDB에 연결/})).toBeDisabled();
  expect(within(sheet).getByRole('button', {name: /^포스터·배경 변경/})).toBeDisabled();
  expect(within(sheet).getByRole('button', {name: /^컬렉션 편집/})).toBeEnabled();
});

it.each([
  ['movie', ['편집', '외부 정보', '삭제'], ['컬렉션 편집', 'TMDB 새로고침', '포스터·배경 변경', '컬렉션 삭제']],
  ['game', ['편집', '외부 정보', '삭제'], ['컬렉션 편집', 'IGDB 새로고침', '표지·hero 변경', '컬렉션 삭제']],
  ['manga', ['편집', '삭제'], ['컬렉션 편집', '컬렉션 삭제']],
  ['av', ['편집', '삭제'], ['컬렉션 편집', '컬렉션 삭제']],
] as const)('groups the %s menu like the PC 작품 관리 menu', async (type, groups, rows) => {
  render(<Harness work={{...item, id: type === 'game' ? 'game-1' : item.id, type}}/>);
  const sheet = await menu();
  if (type === 'movie' || type === 'game') await waitFor(() => expect(within(sheet).getAllByRole('button')[1]).toBeEnabled());
  expect(within(sheet).getAllByRole('group').map(group => group.getAttribute('aria-label'))).toEqual(groups);
  expect(within(sheet).getAllByRole('group').flatMap(group => within(group).getAllByRole('button').map(button => button.querySelector('span > span')!.textContent))).toEqual(rows);
  expect(within(sheet).getByRole('button', {name: /^컬렉션 삭제/})).toHaveClass('is-danger');
});

it('offers connect while unbound and keeps artwork waiting for a binding', async () => {
  bound = false; render(<Harness/>);
  const sheet = await menu();
  const connect = await within(sheet).findByRole('button', {name: /^TMDB에 연결/});
  await waitFor(() => expect(connect).toBeEnabled());
  const artwork = within(sheet).getByRole('button', {name: /^포스터·배경 변경/});
  expect(artwork).toBeDisabled(); expect(rowText(artwork)).toContain('TMDB에 연결하면 이미지를 고를 수 있습니다.');
  fireEvent.click(connect);
  expect(await screen.findByRole('dialog', {name: 'TMDB에 연결'})).toBeTruthy();
  expect(screen.queryByRole('dialog', {name: '작품 관리'})).toBeNull();
});

it('opens the merged edit form from 컬렉션 편집 and blocks delete without the shown revision', async () => {
  const onForm = vi.fn(); render(<Harness entityRevision={null} onForm={onForm}/>);
  const sheet = await menu();
  const remove = within(sheet).getByRole('button', {name: /^컬렉션 삭제/});
  expect(remove).toBeDisabled(); expect(rowText(remove)).toContain('서버를 업데이트하면 삭제할 수 있습니다');
  fireEvent.click(within(sheet).getByRole('button', {name: /^컬렉션 편집/}));
  expect(onForm).toHaveBeenCalledWith({mode: 'edit', type: 'movie', item});
  await waitFor(() => expect(screen.queryByRole('dialog', {name: '작품 관리'})).toBeNull());
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

it('queues refresh for the stored binding from the menu and closes it', async () => {
  render(<Harness/>);
  const refresh = await within(await menu()).findByRole('button', {name: /^TMDB 새로고침/});
  await waitFor(() => expect(refresh).toBeEnabled()); fireEvent.click(refresh);
  await waitFor(() => expect(readCommands()).toHaveLength(1));
  expect(readCommands()[0].command).toMatchObject({operation: 'refresh', provider: 'tmdb', externalId: 'tv:42', workId: item.id});
  expect(readCommands()[0].command).not.toHaveProperty('type');
  await waitFor(() => expect(screen.queryByRole('dialog', {name: '작품 관리'})).toBeNull());
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
  // The relay's thumbnail travels with the artwork, so shelves have their small variant.
  expect(writes[1][2]).toMatchObject({thumbnail: {sha256: 'b'.repeat(64), sizeBytes: 45, contentType: 'image/webp'}});
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
