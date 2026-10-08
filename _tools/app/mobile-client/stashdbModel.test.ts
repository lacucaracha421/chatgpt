import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), api: mocks.api, native: mocks.native}));
import {ApiError} from './transport';
import {stashdbImagePath, stashdbPreview, stashdbRead} from './stashdbModel';
const path = '/v1/providers/stashdb/image?stashdbId=s1&imageId=i1';
const image = {url: 'data:image/jpeg;base64,YQ=='};
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}
beforeEach(() => {setOutboxConnection('https://test.example'); mocks.api.mockReset(); mocks.native.mockReset();});
afterEach(() => vi.useRealTimers());
it('accepts exactly unique identity parameters and optional size=preview', () => {
  expect(stashdbImagePath(path)).toBe(path);
  expect(stashdbImagePath(path + '&size=preview')).toBe(path + '&size=preview');
  for (const value of [path + '&extra=1', path + '&size=full', path + '&size=', path + '&size=preview&size=preview', path + '&imageId=i2', path + '#fragment', path + '&stashdbId=s2', '/v1/providers/stashdb/image?stashdbId=s1&size=preview', path.replace('i1', 'bad%2Fid'), 'https://stashdb.org/images/a']) {
    expect(() => stashdbImagePath(value)).toThrow();
  }
});
it('keeps at most three previews in flight and fills each freed slot', async () => {
  const pending = Array.from({length: 5}, () => deferred<typeof image>());
  let active = 0, peak = 0, calls = 0;
  mocks.native.mockImplementation(() => {
    active++; peak = Math.max(peak, active);
    return pending[calls++].promise.finally(() => {active--;});
  });
  const signal = new AbortController().signal;
  const replies = pending.map((_, index) => stashdbPreview(path.replace('i1', `i${index}`), signal));
  await flush(); expect(calls).toBe(3);
  expect(mocks.native.mock.calls[0][1]).toEqual({path: path.replace('i1', 'i0') + '&size=preview', connection: 'https://test.example'});
  pending[1].resolve(image); await flush(); expect(calls).toBe(4);
  pending[0].resolve(image); await flush(); expect(calls).toBe(5);
  pending.forEach(entry => entry.resolve(image));
  await Promise.all(replies); expect(peak).toBe(3);
});
it('serializes reads and preparation independently of previews', async () => {
  const first = deferred<unknown>(), photo = deferred<typeof image>();
  mocks.api.mockReturnValueOnce(first.promise).mockResolvedValue('prepared');
  mocks.native.mockReturnValue(photo.promise);
  const signal = new AbortController().signal;
  const detail = stashdbRead('/v1/providers/stashdb/performers/s1', signal);
  const portrait = stashdbRead('/v1/providers/stashdb/portrait', signal, {stashdbId: 's1', imageId: 'i1'});
  const preview = stashdbPreview(path, signal);
  await flush(); expect(mocks.api).toHaveBeenCalledTimes(1); expect(mocks.native).toHaveBeenCalledTimes(1);
  first.resolve('detail'); await expect(detail).resolves.toBe('detail');
  await expect(portrait).resolves.toBe('prepared');
  expect(mocks.api.mock.calls[1][3]).toBe('POST');
  photo.resolve(image); await preview;
});
it('holds its slot through 429 back-off and caps retries', async () => {
  vi.useFakeTimers();
  mocks.native.mockRejectedValue(new ApiError('busy', 429, {detail: {code: 'providerBusy'}}));
  const reply = stashdbPreview(path, new AbortController().signal);
  const rejected = expect(reply).rejects.toMatchObject({status: 429});
  await flush(); expect(mocks.native).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(999); expect(mocks.native).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(mocks.native).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000); await rejected; expect(mocks.native).toHaveBeenCalledTimes(4);
  mocks.native.mockResolvedValue(image);
  await stashdbPreview(path + '&size=preview', new AbortController().signal);
  expect(mocks.native.mock.lastCall?.[1].path).toBe(path + '&size=preview');
});
it('does not start aborted or stale queued previews', async () => {
  const gate = deferred<typeof image>(); mocks.native.mockReturnValue(gate.promise);
  const live = new AbortController(), aborted = new AbortController();
  const replies = Array.from({length: 3}, () => stashdbPreview(path, live.signal));
  const cancelled = stashdbPreview(path, aborted.signal);
  const cancelledCheck = expect(cancelled).rejects.toMatchObject({name: 'AbortError'});
  const stale = stashdbPreview(path, live.signal);
  const staleCheck = expect(stale).rejects.toThrow('서버 연결이 바뀌었습니다.');
  const liveChecks = replies.map(reply => expect(reply).rejects.toThrow('서버 연결이 바뀌었습니다.'));
  await flush(); aborted.abort(); setOutboxConnection('https://other.example'); gate.resolve(image);
  await Promise.all([...liveChecks, cancelledCheck, staleCheck]); expect(mocks.native).toHaveBeenCalledTimes(3);
});
