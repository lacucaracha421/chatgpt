import {beforeEach, expect, it, vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), ...mocks}));
import {ApiError} from './transport';
import {artworkCommands, providerPreview, providerImagePath, providerDetailPath, readProviderBinding} from './collectionProviderModel';
import {AUTHORITY_STATUS_PATH, COMMAND_PATH, enqueueCommand, enqueueCommands, flushCommands, providerApplyBody, readCommands, reconcileCommands, type AuthorityIdentity, type ProviderApply} from './collectionCommandOutbox';
import type {CollectionDetail} from './collectionModel';

const identity: AuthorityIdentity = {libraryId: 'e'.repeat(32), epoch: 7, contractVersion: 1};
const item: CollectionDetail = {id: 'work-1', name: '작품', type: 'movie', showcase: false, selectedWorkArtworkId: 'old', volumes: [], artworks: []};
const candidate = {kind: 'poster', path: '/a.jpg', previewUrl: '/v1/providers/image?provider=tmdb&path=%2Fa.jpg&size=w342', width: 500, height: 750};
const receipt = {provider: 'tmdb', providerImageId: '/a.jpg', original: {sha256: 'a'.repeat(64), sizeBytes: 123, contentType: 'image/jpeg'}, width: 500, height: 750};
const connection = 'https://test.example';
beforeEach(() => { localStorage.clear(); setOutboxConnection(connection); mocks.api.mockReset(); mocks.native.mockReset(); vi.restoreAllMocks(); });
const apply = (patch: Partial<ProviderApply> = {}) => enqueueCommand(identity, {commandType: 'providerApply', operation: 'create', workId: crypto.randomUUID(), provider: 'tmdb', externalId: 'tv:42', type: 'movie', ...patch});
const respond = () => mocks.api.mockImplementation(async (path, _signal, body) => {
  if (path === AUTHORITY_STATUS_PATH) return {...identity, active: true};
  if (path === '/v1/providers/apply') return {receipts: (body.operation === 'connect' ? ['bindProvider', 'applyProviderSnapshot'] : [body.operation === 'create' ? 'createWork' : 'applyProviderSnapshot'])
    .map((commandType, index) => ({...identity, commandType, operationId: `derived-${index}`, authorityCursor: 10 + index}))};
  return {...body};
});

it('persists apply IDs across crashes, retries the exact wire body and retains receipts in order', async () => {
  let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const intent = apply({operation: 'connect', type: undefined, workId: item.id});
  mocks.api.mockImplementation(async path => path === AUTHORITY_STATUS_PATH ? {...identity, active: true} : Promise.reject(new Error('offline')));
  await flushCommands();
  expect(readCommands()[0]).toMatchObject({state: 'pending', attempts: 1});
  const first = mocks.api.mock.calls.find(([path]) => path === '/v1/providers/apply')![2];
  expect(first).toEqual({commandId: intent.command.operationId, libraryId: identity.libraryId, epoch: 7, operation: 'connect', provider: 'tmdb', externalId: 'tv:42', workId: item.id});
  expect(first.commandId).toMatch(/^[a-f0-9-]{14}4[a-f0-9-]{21}$/);
  respond(); now = 6000; await flushCommands();
  expect(mocks.api.mock.calls.filter(([path]) => path === '/v1/providers/apply').at(-1)![2]).toEqual(first);
  expect(readCommands()[0].receipts?.map(row => row.commandType)).toEqual(['bindProvider', 'applyProviderSnapshot']);
  expect(readCommands()[0].state).toBe('accepted');
  reconcileCommands(identity, item, 'detail', 1000); expect(readCommands()).toHaveLength(1);
  reconcileCommands(identity, item, 'detail', 6001); expect(readCommands()).toEqual([]);
});

it('sends only S3 fields for create and refresh and no snapshot or internal envelope', async () => {
  const row = apply(); if (row.command.commandType !== 'providerApply') throw new Error();
  expect(providerApplyBody(row.command)).toEqual({commandId: row.command.operationId, libraryId: identity.libraryId, epoch: 7, operation: 'create', provider: 'tmdb', externalId: 'tv:42', workId: row.command.workId, type: 'movie'});
  const refresh = apply({operation: 'refresh', provider: 'igdb', externalId: '99', workId: item.id});
  respond(); await flushCommands();
  const body = mocks.api.mock.calls.find(([path, , body]) => path === '/v1/providers/apply' && body.commandId === refresh.command.operationId)![2];
  expect(Object.keys(body).sort()).toEqual(['commandId', 'epoch', 'externalId', 'libraryId', 'operation', 'provider', 'workId'].sort());
});

it.each(['create', 'connect', 'refresh'] as const)('accepts atomic gallery receipts for provider %s', async operation => {
  apply({operation, type: operation === 'create' ? 'movie' : undefined});
  const types = [...(operation === 'create' ? ['createWork'] : operation === 'connect' ? ['bindProvider'] : []),
    'addArtwork', 'addArtwork', 'applyProviderSnapshot'];
  const receipts = types.map((commandType, index) => ({...identity, commandType, operationId: `gallery-${index}`}));
  mocks.api.mockImplementation(async path => path === AUTHORITY_STATUS_PATH ? {...identity, active: true} : {receipts});
  await flushCommands();
  expect(readCommands()[0]).toMatchObject({state: 'accepted', receipts});
});

it.each([
  ['addArtwork', 'createWork', 'applyProviderSnapshot'],
  ['createWork', 'applyProviderSnapshot', 'addArtwork'],
  ['createWork', 'selectArtwork', 'applyProviderSnapshot'],
])('rejects misplaced or unexpected gallery receipts: %s', (...types) => {
  apply();
  const receipts = types.map((commandType, index) => ({...identity, commandType, operationId: `invalid-${index}`}));
  mocks.api.mockImplementation(async path => path === AUTHORITY_STATUS_PATH ? {...identity, active: true} : {receipts});
  return flushCommands().then(() => expect(readCommands()[0].state).toBe('pending'));
});

it('rejects out-of-order receipts, blocks dependent artwork and parks stale-epoch errors', async () => {
  apply({operation: 'connect', workId: item.id});
  enqueueCommand(identity, {commandType: 'selectArtwork', workId: item.id, slot: 'work', artworkId: null, expectedArtworkId: 'old'});
  mocks.api.mockImplementation(async path => path === AUTHORITY_STATUS_PATH ? {...identity, active: true} : {receipts: [{...identity, operationId: 'a', commandType: 'applyProviderSnapshot'}, {...identity, operationId: 'b', commandType: 'bindProvider'}]});
  await flushCommands(); expect(readCommands()[0].state).toBe('pending');
  expect(mocks.api.mock.calls.some(([path]) => path === COMMAND_PATH)).toBe(false);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000);
  mocks.api.mockImplementation(async path => path === AUTHORITY_STATUS_PATH ? {...identity, active: true} : Promise.reject(new ApiError('라이브러리 변경', 409, {detail: {code: 'authorityLibraryMismatch'}})));
  await flushCommands(); expect(readCommands()[0]).toMatchObject({state: 'conflict', conflict: {code: 'authorityLibraryMismatch'}});
});

it('uploads artwork first, then durably queues addArtwork/selectArtwork in order; keep is no-op and clear has no upload', async () => {
  mocks.api.mockResolvedValue(receipt);
  const commands = await artworkCommands(item, 'tmdb', {work: candidate, backdrop: 'clear'});
  expect(mocks.api.mock.calls).toEqual([['/v1/providers/artwork', undefined, {provider: 'tmdb', path: '/a.jpg', size: 'original'}, 'POST', false, connection]]);
  expect(commands.map(command => command.commandType)).toEqual(['addArtwork', 'selectArtwork', 'selectArtwork']);
  expect(commands[0]).toMatchObject({...receipt, commandType: 'addArtwork', workId: item.id, kind: 'cover', language: null, thumbnail: null});
  expect(commands[1]).toMatchObject({slot: 'work', expectedArtworkId: 'old', artworkId: (commands[0] as {artworkId: string}).artworkId});
  expect(commands[2]).toMatchObject({slot: 'backdrop', artworkId: null, expectedArtworkId: null});
  enqueueCommands(identity, commands); respond(); await flushCommands();
  expect(mocks.api.mock.calls.filter(([path]) => path === COMMAND_PATH).map(([, , body]) => body.commandType)).toEqual(['addArtwork', 'selectArtwork', 'selectArtwork']);
  mocks.api.mockClear(); expect(await artworkCommands(item, 'tmdb', {work: 'keep', backdrop: 'keep'})).toEqual([]); expect(mocks.api).not.toHaveBeenCalled();
});

it('never queues a partial artwork selection when an upload fails or the connection changes', async () => {
  mocks.api.mockResolvedValueOnce(receipt).mockRejectedValueOnce(new Error('offline'));
  await expect(artworkCommands(item, 'tmdb', {work: candidate, backdrop: {...candidate, kind: 'backdrop'}})).rejects.toThrow('offline');
  expect(readCommands()).toEqual([]);
  mocks.api.mockImplementation(async () => { setOutboxConnection('https://other.example'); return receipt; });
  await expect(artworkCommands(item, 'tmdb', {work: candidate})).rejects.toThrow('저장된 이미지를');
});

it('maps IGDB hero choices and scopes preview bytes to the configured API connection', async () => {
  mocks.api.mockResolvedValue({...receipt, provider: 'igdb', providerImageId: 'art1'});
  const commands = await artworkCommands({...item, type: 'game'}, 'igdb', {hero: {...candidate, kind: 'screenshot', path: 'art1'}});
  expect(commands[0]).toMatchObject({kind: 'hero', provider: 'igdb'});
  const signal = new AbortController().signal;
  mocks.native.mockResolvedValue({url: 'data:image/jpeg;base64,YQ=='});
  await providerPreview(candidate.previewUrl, signal);
  expect(mocks.native).toHaveBeenCalledWith('providerImage', {path: candidate.previewUrl, connection}, signal);
  for (const url of ['https://image.tmdb.org/x.jpg', '//evil/x', '/v1/providers/image?provider=tmdb&path=x&size=original']) expect(providerImagePath(url)).toBeNull();
  expect(providerDetailPath('tmdb', 'tv:42')).toBe('/v1/providers/tmdb/tv/42');
  expect(providerImagePath('/v1/providers/image?provider=igdb&path=art1&size=t_1080p')).not.toBeNull();
});

it('reads paginated binding identities from the existing authority baseline', async () => {
  mocks.api.mockImplementation(async path => {
    const params = new URL(path, connection).searchParams;
    if (!params.has('snapshot')) return {...identity, snapshotCursor: 20};
    return params.has('after') ? {...identity, items: [{workId: item.id, provider: 'tmdb', bound: true, externalId: 'tv:42'}], hasMore: false, nextAfter: null}
      : {...identity, items: [], hasMore: true, nextAfter: '["previous","tmdb"]'};
  });
  expect(await readProviderBinding(identity, item.id, 'tmdb', new AbortController().signal)).toBe('tv:42');
  expect(mocks.api).toHaveBeenCalledTimes(3);
});

it('sends provider previews a few at a time so a long candidate sheet never overflows the native lane', async () => {
  const pending: (() => void)[] = [];
  let running = 0, peak = 0;
  mocks.native.mockImplementation(() => new Promise(resolve => { running++; peak = Math.max(peak, running); pending.push(() => { running--; resolve({url: 'data:image/jpeg;base64,YQ=='}); }); }));
  const path = '/v1/providers/image?provider=tmdb&path=%2Fp.jpg&size=w342';
  const aborted = new AbortController();
  const all = Array.from({length: 60}, (_, index) => providerPreview(path, index === 59 ? aborted.signal : new AbortController().signal));
  aborted.abort();
  await expect(all[59]).rejects.toThrow();
  while (pending.length) { pending.shift()!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
  await Promise.all(all.slice(0, 59));
  expect(peak).toBeLessThanOrEqual(6);
  expect(mocks.native).toHaveBeenCalledTimes(59);
});
