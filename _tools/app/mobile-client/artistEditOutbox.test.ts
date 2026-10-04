import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {commitArtistEdit, flushArtistEdits, overlayArtistEdits, readArtistEdits, reconcileArtistEdits, resolveArtist} from './artistEditOutbox';
import {setOutboxConnection} from './outboxConnection';
import type {LibraryArtist} from './artistsModel';

const mocks = vi.hoisted(() => ({api: vi.fn()}));
vi.mock('./transport', () => ({api: mocks.api}));
const endpoint = 'https://one.invalid';
const artist: LibraryArtist = {id: 'alice', keys: ['alice'], label: 'Alice', sourceName: 'Alice', displayName: null,
  assetCount: 2, recentCount: 1, pinned: false, hidden: false, main: true, coverAssetIds: []};
const signal = () => new AbortController().signal;

beforeEach(() => {
  localStorage.clear(); setOutboxConnection(endpoint); mocks.api.mockReset();
  mocks.api.mockImplementation(async (_path, _signal, body) => ({operationId: body.operationId, sequence: 1, revision: 2}));
});
afterEach(() => vi.restoreAllMocks());

describe('artist edit outbox', () => {
  it('persists ordered edits and retries the same operation before later edits', async () => {
    commitArtistEdit(endpoint, artist, 'rename', '  새 이름  ', () => 'rename');
    commitArtistEdit(endpoint, artist, 'hide', null, () => 'hide');
    mocks.api.mockRejectedValueOnce(new Error('offline'));
    await expect(flushArtistEdits(endpoint, signal())).rejects.toThrow('offline');
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(readArtistEdits().map(row => row.operationId)).toEqual(['rename', 'hide']);
    await flushArtistEdits(endpoint, signal());
    expect(mocks.api.mock.calls.map(call => call[2].operationId)).toEqual(['rename', 'rename', 'hide']);
    expect(mocks.api.mock.calls[1]).toEqual(['/v1/library/artists/intents', expect.anything(),
      {version: 1, operationId: 'rename', artistId: 'alice', action: 'rename', displayName: '새 이름'}, 'POST', false, endpoint]);
    // POST acknowledgement alone never removes the visible overlay.
    expect(readArtistEdits()).toHaveLength(2);
    expect(overlayArtistEdits([artist], readArtistEdits())[0]).toMatchObject({label: '새 이름', hidden: true});
  });

  it('reconciles by operation or served revision, never by coincidentally equal state', async () => {
    const first = commitArtistEdit(endpoint, artist, 'hide', null, () => 'hide');
    reconcileArtistEdits(endpoint, {revision: 20, artists: [{...artist, hidden: true}], pending: []});
    expect(readArtistEdits()).toHaveLength(1);
    await flushArtistEdits(endpoint, signal());
    reconcileArtistEdits(endpoint, {revision: 1, pending: []});
    expect(readArtistEdits()).toHaveLength(1);
    reconcileArtistEdits(endpoint, {revision: 2, pending: [{...first, sequence: 1}]});
    expect(readArtistEdits()).toEqual([]);
    commitArtistEdit(endpoint, artist, 'pin', null, () => 'pin');
    await flushArtistEdits(endpoint, signal());
    // Another device's later accepted unpin wins; no stuck optimistic pin.
    reconcileArtistEdits(endpoint, {revision: 3, artists: [artist], pending: []});
    expect(overlayArtistEdits([artist], readArtistEdits())[0].pinned).toBe(false);
  });

  it('recovers a lost POST reply when GET includes the operation', async () => {
    const intent = commitArtistEdit(endpoint, artist, 'hide', null, () => 'lost');
    mocks.api.mockRejectedValueOnce(new Error('lost reply'));
    await expect(flushArtistEdits(endpoint, signal())).rejects.toThrow();
    reconcileArtistEdits(endpoint, {revision: 2, pending: [{...intent, sequence: 1}]});
    await flushArtistEdits(endpoint, signal());
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(readArtistEdits()).toHaveLength(0);
  });

  it('scopes persisted edits and in-flight receipts to the original connection', async () => {
    commitArtistEdit(endpoint, artist, 'hide');
    let finish!: (reply: unknown) => void;
    mocks.api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const flushing = flushArtistEdits(endpoint, signal());
    const original = readArtistEdits()[0];
    setOutboxConnection('https://two.invalid');
    expect(readArtistEdits()).toEqual([]);
    commitArtistEdit('https://two.invalid', artist, 'pin');
    finish({operationId: original.operationId, sequence: 1, revision: 2});
    await flushing;
    expect(readArtistEdits()[0].receipt).toBeUndefined();
    expect(readArtistEdits(endpoint)[0].receipt).toEqual({sequence: 1, revision: 2});
  });

  it('serializes simultaneous flushes and retains edits queued during a request', async () => {
    commitArtistEdit(endpoint, artist, 'hide', null, () => 'first');
    let finish!: (reply: unknown) => void;
    mocks.api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = flushArtistEdits(endpoint, signal());
    const second = flushArtistEdits(endpoint, signal());
    commitArtistEdit(endpoint, artist, 'unhide', null, () => 'second');
    expect(mocks.api).toHaveBeenCalledTimes(1);
    finish({operationId: 'first', sequence: 1, revision: 2});
    await Promise.all([first, second]);
    await flushArtistEdits(endpoint, signal());
    expect(mocks.api.mock.calls.map(call => call[2].operationId)).toEqual(['first', 'second']);
    expect(readArtistEdits()).toHaveLength(2);
  });

  it('keeps queued fields on a materialized artist and clears names to the source', () => {
    commitArtistEdit(endpoint, artist, 'rename', '새 이름');
    commitArtistEdit(endpoint, artist, 'pin');
    const materialized = {...artist, id: 'artist:uuid'};
    const rows = overlayArtistEdits([materialized], readArtistEdits());
    expect(rows).toHaveLength(1);
    expect(resolveArtist(rows, artist)).toMatchObject({id: 'artist:uuid', label: '새 이름', pinned: true});
    commitArtistEdit(endpoint, rows[0], 'rename', '  ');
    expect(overlayArtistEdits([materialized], readArtistEdits())[0]).toMatchObject({label: 'Alice', displayName: null});
    expect(overlayArtistEdits([], readArtistEdits())).toHaveLength(1);
  });

  it('rebinds an offline bare-key edit only after an explicit unknown-artist rejection', async () => {
    commitArtistEdit(endpoint, artist, 'hide', null, () => 'original');
    const materialized = {...artist, id: 'artist:uuid'};
    mocks.api.mockRejectedValueOnce({status: 409, details: {detail: {code: 'artistUnknown'}}});
    await flushArtistEdits(endpoint, signal(), [materialized]);
    expect(mocks.api.mock.calls[0][2]).toMatchObject({artistId: 'alice', operationId: 'original'});
    expect(mocks.api.mock.calls[1][2]).toMatchObject({artistId: 'artist:uuid', action: 'hide'});
    expect(readArtistEdits()[0].operationId).not.toBe('original');
    expect(readArtistEdits()[0].receipt).toEqual({sequence: 1, revision: 2});
  });

  it('rejects invalid names or failed storage without claiming the edit was queued', () => {
    expect(() => commitArtistEdit(endpoint, artist, 'rename', 'x'.repeat(121))).toThrow();
    expect(() => commitArtistEdit(endpoint, artist, 'rename', 'a\nb')).toThrow();
    expect(() => commitArtistEdit(endpoint, artist, 'pin', 'name')).toThrow();
    commitArtistEdit(endpoint, artist, 'rename', '😀'.repeat(120));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => commitArtistEdit(endpoint, artist, 'hide')).toThrow('보관하지 못했습니다');
    expect(readArtistEdits()).toHaveLength(1);
  });

  it('reports a malformed durable queue without overwriting it', () => {
    const key = `lakomics.artists.edits.outbox.v1.${encodeURIComponent(endpoint)}`;
    localStorage.setItem(key, '[{"operationId":"broken"}]');
    expect(() => readArtistEdits()).toThrow('대기열을 읽을 수 없습니다');
    expect(() => commitArtistEdit(endpoint, artist, 'hide')).toThrow();
    expect(localStorage.getItem(key)).toBe('[{"operationId":"broken"}]');
  });
});
