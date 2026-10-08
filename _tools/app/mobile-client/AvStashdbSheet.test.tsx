import '@testing-library/jest-dom/vitest';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), api: mocks.api, native: mocks.native}));
import {ApiError} from './transport';
import {AvStashdbSheet} from './AvStashdbSheet';
import {enqueueCommand, readCommands} from './collectionCommandOutbox';
import type {useCollectionAuthority} from './useCollectionAuthority';
import {stashdbImagePath, stashdbPreview, STASHDB_NOT_CONFIGURED, STASHDB_OLD_SERVER} from './stashdbModel';
const identity = {libraryId: 'e'.repeat(32), epoch: 1, contractVersion: 1 as const};
const photo = {id: 'i1', url: '/v1/providers/stashdb/image?stashdbId=s1&imageId=i1', width: 600, height: 800};
const candidate = {stashdbId: 's1', name: '미오', aliases: ['Mio'], birthDate: '2000-01-01', previewUrl: photo.url, images: [photo]};
const manifest = {original: {sha256: 'a'.repeat(64), sizeBytes: 123, contentType: 'image/jpeg'}, width: 600, height: 800, attribution: {source: 'stashdb', sourceUrl: null, license: null, author: null}};
const close = vi.fn(), portrait = vi.fn();
function open(mode: 'profile' | 'portrait' = 'profile', privacy = false) {
  const authority = {identity, rows: [], acknowledgements: [], enqueue: (command: Parameters<typeof enqueueCommand>[1], label: string) => enqueueCommand(identity, command, label)} as unknown as ReturnType<typeof useCollectionAuthority>;
  return render(<AvStashdbSheet mode={mode} person={{id: 'p1', entityRevision: 4, stashdbId: 's1', memo: null, favorite: false, profile: null, portrait: null}} name="하야세 미오" privacy={privacy} authority={authority} onClose={close} onPortrait={portrait}/>);
}
beforeEach(() => {
  localStorage.clear(); setOutboxConnection('https://test.example'); close.mockReset(); portrait.mockReset(); mocks.api.mockReset(); mocks.native.mockReset();
  vi.stubGlobal('Image', class {onload?: () => void; set src(_value: string) {queueMicrotask(() => this.onload?.());}});
  mocks.native.mockResolvedValue({url: 'data:image/jpeg;base64,YQ=='});
  mocks.api.mockImplementation(async path => {
    if (path === '/v1/providers/status') return {stashdb: true};
    if (path.startsWith('/v1/providers/stashdb/search?')) return {items: [candidate]};
    if (path.startsWith('/v1/providers/stashdb/performers/')) return candidate;
    if (path === '/v1/providers/stashdb/portrait') return manifest;
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('searches the editable default name, previews authenticated relay and enqueues the chosen profile', async () => {
  open(); expect(screen.getByLabelText('배우 이름')).toHaveValue('하야세 미오');
  await waitFor(() => expect(screen.getByRole('button', {name: '검색'})).toBeEnabled());
  fireEvent.change(screen.getByLabelText('배우 이름'), {target: {value: 'Mio'}}); fireEvent.click(screen.getByRole('button', {name: '검색'}));
  const pick = await screen.findByRole('button', {name: /미오 Mio/});
  await waitFor(() => expect(pick.querySelector('img')).toHaveAttribute('src', 'data:image/jpeg;base64,YQ=='));
  expect(mocks.native).toHaveBeenCalledWith('providerImage', {path: photo.url + '&size=preview', connection: 'https://test.example'}, expect.any(AbortSignal));
  expect(mocks.api.mock.calls.some(([path]) => path === '/v1/providers/stashdb/search?query=Mio')).toBe(true);
  fireEvent.click(pick); expect(readCommands()[0].command).toMatchObject({commandType: 'setPersonProfile', personId: 'p1', stashdbId: 's1', expectedRevision: 4}); expect(close).toHaveBeenCalled();
});
it('prepares a photo then queues the manifest and transfers existing preview bytes', async () => {
  open('portrait'); const pick = await screen.findByRole('button', {name: '사진 1 선택'});
  await waitFor(() => expect(pick).toBeEnabled()); fireEvent.click(pick);
  await waitFor(() => expect(readCommands()).toHaveLength(1));
  expect(mocks.api).toHaveBeenCalledWith('/v1/providers/stashdb/portrait', expect.any(AbortSignal), {stashdbId: 's1', imageId: 'i1'}, 'POST', false, 'https://test.example');
  expect(readCommands()[0].command).toMatchObject({commandType: 'setPersonPortrait', expectedRevision: 4, portrait: {kind: 'image', ...manifest}});
  expect(portrait).toHaveBeenCalledWith(expect.anything(), 'data:image/jpeg;base64,YQ==', expect.any(String));
});
it.each([{stashdb: false}, {}, '404'])('explains missing key or older status: %j', async status => {
  mocks.api.mockImplementation(async () => { if (status === '404') throw new ApiError('missing', 404, null); return status; }); open();
  expect(await screen.findByRole('alert')).toHaveTextContent(typeof status === 'object' && 'stashdb' in status ? STASHDB_NOT_CONFIGURED : STASHDB_OLD_SERVER);
  expect(screen.getByRole('button', {name: '검색'})).toBeDisabled(); expect(mocks.native).not.toHaveBeenCalled();
});
it('privacy hides photos and prevents detail/image requests, including candidate previews', async () => {
  const mounted = open('portrait', true); await screen.findByText('프라이버시 모드에서는 사진을 표시하지 않습니다.');
  await waitFor(() => expect(mocks.api).toHaveBeenCalled()); expect(mocks.api.mock.calls.every(([path]) => path === '/v1/providers/status')).toBe(true); expect(mocks.native).not.toHaveBeenCalled();
  mounted.unmount(); open('profile', true); await waitFor(() => expect(screen.getByRole('button', {name: '검색'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button', {name: '검색'})); await screen.findByRole('button', {name: /미오 Mio/});
  expect(document.querySelector('img')).toBeNull(); expect(mocks.native).not.toHaveBeenCalled();
});
it.each(['profile', 'portrait'] as const)('confirms destructive %s clearing', async mode => {
  open(mode); const label = mode === 'profile' ? '연결 해제' : '사진 지우기';
  await waitFor(() => expect(screen.getByRole('button', {name: label})).toBeEnabled()); fireEvent.click(screen.getByRole('button', {name: label}));
  expect(readCommands()).toEqual([]);
  const confirm = screen.getByRole('dialog', {name: mode === 'profile' ? 'StashDB 연결을 해제할까요?' : '사진을 지울까요?'});
  fireEvent.click(within(confirm).getByRole('button', {name: label})); expect(readCommands()[0].command).toMatchObject(mode === 'profile' ? {stashdbId: null} : {portrait: null});
});
it('refresh uses the same profile identity with a new operation', async () => {
  open(); await waitFor(() => expect(screen.getByRole('button', {name: '새로고침'})).toBeEnabled()); fireEvent.click(screen.getByRole('button', {name: '새로고침'}));
  expect(readCommands()[0].command).toMatchObject({commandType: 'setPersonProfile', stashdbId: 's1', expectedRevision: 4});
});
it('rechecks FIFO before composing behind an unresolved memo', async () => {
  enqueueCommand(identity, {commandType: 'setPerson', personId: 'p1', changes: {memo: 'new'}, expected: {memo: null}});
  open(); await waitFor(() => expect(screen.getByRole('button', {name: '새로고침'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button', {name: '새로고침'})); expect(await screen.findByRole('alert')).toHaveTextContent('앞선 배우 변경'); expect(readCommands()).toHaveLength(1);
});
it('validates relay paths and retries 429 politely in one lane', async () => {
  expect(() => stashdbImagePath('https://stashdb.org/images/a')).toThrow();
  expect(() => stashdbImagePath('/v1/providers/stashdb/image?stashdbId=s1&imageId=i1&extra=1')).toThrow();
  vi.useFakeTimers(); mocks.native.mockRejectedValueOnce(new ApiError('busy', 429, {detail: {code: 'providerBusy'}})).mockResolvedValue({url: 'data:image/jpeg;base64,YQ=='});
  const controller = new AbortController(); const one = stashdbPreview(photo.url, controller.signal), two = stashdbPreview(photo.url, controller.signal);
  await act(async () => { await vi.advanceTimersByTimeAsync(999); }); expect(mocks.native).toHaveBeenCalledTimes(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); await expect(one).resolves.toContain('data:image'); await expect(two).resolves.toContain('data:image'); expect(mocks.native).toHaveBeenCalledTimes(3);
});
it('loads photo previews in parallel and cancels preparation when the sheet closes', async () => {
  let releaseImage: (reply: unknown) => void = () => {};
  mocks.api.mockImplementation(async path => {
    if (path === '/v1/providers/status') return {stashdb: true};
    if (path.startsWith('/v1/providers/stashdb/performers/')) return {...candidate, images: [photo, {...photo, id: 'i2', url: photo.url.replace('i1', 'i2')}]};
    if (path === '/v1/providers/stashdb/portrait') return new Promise(() => {});
  });
  mocks.native.mockImplementationOnce(() => new Promise(resolve => {releaseImage = resolve;})).mockResolvedValue({url: 'data:image/jpeg;base64,YQ=='});
  const mounted = open('portrait'); await screen.findByRole('button', {name: '사진 1 선택'});
  // Both previews are requested without waiting for the first; photo 2 is ready while photo 1 still loads.
  await waitFor(() => expect(mocks.native).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByRole('button', {name: '사진 2 선택'})).toBeEnabled()); expect(screen.getByRole('button', {name: '사진 1 선택'})).toBeDisabled();
  await act(async () => releaseImage({url: 'data:image/jpeg;base64,YQ=='}));
  await waitFor(() => expect(screen.getByRole('button', {name: '사진 1 선택'})).toBeEnabled()); fireEvent.click(screen.getByRole('button', {name: '사진 1 선택'}));
  await waitFor(() => expect(mocks.api.mock.calls.some(([path]) => path === '/v1/providers/stashdb/portrait')).toBe(true));
  const signal = mocks.api.mock.calls.find(([path]) => path === '/v1/providers/stashdb/portrait')![1] as AbortSignal;
  mounted.unmount(); expect(signal.aborted).toBe(true); expect(readCommands()).toEqual([]);
});
