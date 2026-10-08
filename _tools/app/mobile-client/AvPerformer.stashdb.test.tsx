import '@testing-library/jest-dom/vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
const mocks = vi.hoisted(() => ({api: vi.fn(), native: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), api: mocks.api, native: mocks.native}));
vi.mock('./media', () => ({mediaTicket: vi.fn()}));
import {AvPerformerScreen} from './AvPerformer';
import {useCollectionAuthority} from './useCollectionAuthority';
import {setOutboxConnection} from './outboxConnection';
import {AUTHORITY_STATUS_PATH, COMMAND_PATH, readCommands, type AuthorityCommand} from './collectionCommandOutbox';
import {resetPortraitMemory} from './collectionArtwork';
import type {CollectionPerson} from './collectionModel';
const identity = {libraryId: 'e'.repeat(32), epoch: 5, contractVersion: 1 as const};
const profile = {source: 'stashdb', name: 'Mio', aliases: [], birthDate: '2000-01-01', heightCm: 160, bandIn: null, waistIn: null, hipIn: null, cup: null, breastType: null, careerStart: null, careerEnd: null, urls: []};
const manifest = {original: {sha256: 'a'.repeat(64), sizeBytes: 123, contentType: 'image/jpeg'}, width: 600, height: 800, attribution: {source: 'stashdb', sourceUrl: null, license: null, author: null}};
const oldHash = 'b'.repeat(64);
const candidate = {stashdbId: 's1', name: 'Mio', aliases: [], birthDate: null, images: [{id: 'i1', url: '/v1/providers/stashdb/image?stashdbId=s1&imageId=i1', width: 600, height: 800}]};
let person: CollectionPerson, finishCommand: (reply: unknown) => void, finishTicket: (reply: unknown) => void;
function Harness({privacy = false}: {privacy?: boolean}) {
  const authority = useCollectionAuthority(true, () => {}, true);
  return <AvPerformerScreen personId="p1" currentId={null} active privacy={privacy} perRow={4} order="newest" authority={authority} onOpen={() => {}} onPerformer={() => {}} onSort={() => {}} onView={() => {}}/>;
}
beforeEach(() => {
  localStorage.clear(); setOutboxConnection('https://test.example'); resetPortraitMemory(); mocks.api.mockReset(); mocks.native.mockReset();
  vi.stubGlobal('Image', class {onload?: () => void; decode() {return Promise.resolve();} set src(_value: string) {queueMicrotask(() => this.onload?.());}});
  person = {id: 'p1', entityRevision: 4, stashdbId: 's1', memo: null, favorite: false, profile: null, portrait: null, portraitImage: {sha256: oldHash, sizeBytes: 100, contentType: 'image/jpeg', width: 600, height: 800}};
  mocks.native.mockImplementation(async (op, body) => {
    if (op === 'providerImage') return {url: 'data:image/jpeg;base64,YQ=='};
    if (op === 'homeCover') return body.sha256 === oldHash ? {url: 'data:image/jpeg;base64,b2xk'} : new Promise(resolve => {finishTicket = resolve;});
    throw new Error(`unexpected ${op}`);
  });
  mocks.api.mockImplementation(async (path: string, _signal: unknown, body: AuthorityCommand) => {
    if (path === AUTHORITY_STATUS_PATH) return {...identity, active: true};
    if (path.startsWith('/v1/collections/people/p1')) return {person: path.includes('authority=1') ? person : {...person, entityRevision: undefined, stashdbId: undefined, portraitImage: undefined}};
    if (path.startsWith('/v1/collections?')) return {ready: true, filterVersion: 1, revision: 'r1', items: [{id: 'w1', name: '작품', type: 'av', showcase: false, av: {genres: [], people: [{id: 'p1', name: '미오', role: 'performer', order: 0, portraitImage: person.portraitImage}]}}]};
    if (path === '/v1/providers/status') return {stashdb: true};
    if (path.startsWith('/v1/providers/stashdb/search?')) return {items: [candidate]};
    if (path.startsWith('/v1/providers/stashdb/performers/')) return candidate;
    if (path === '/v1/providers/stashdb/portrait') return manifest;
    if (path === COMMAND_PATH) return new Promise(resolve => {finishCommand = reply => resolve({...body, ...reply as object});});
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => {cleanup(); vi.unstubAllGlobals();});
it('uses the authority revision and shows profile text only after the receipt', async () => {
  render(<Harness/>); const entry = await screen.findByRole('button', {name: 'StashDB 프로필 선택'}); await waitFor(() => expect(entry).toBeEnabled());
  expect(mocks.api.mock.calls.some(([path]) => path === '/v1/collections/people/p1?authority=1')).toBe(true);
  fireEvent.click(entry); const search = await screen.findByRole('button', {name: '검색'}); await waitFor(() => expect(search).toBeEnabled()); fireEvent.click(search);
  fireEvent.click(await screen.findByRole('button', {name: /^Mio/}));
  expect(readCommands()[0].command).toMatchObject({expectedRevision: 4, commandType: 'setPersonProfile'});
  expect(screen.queryByText('160cm')).toBeNull();
  await waitFor(() => expect(finishCommand).toBeTypeOf('function'));
  person = {...person, entityRevision: 5, profile}; await act(async () => finishCommand({changed: true, person}));
  await waitFor(() => expect(document.querySelector('.tablet-performer__facts')?.textContent).toContain('160'));
  expect(screen.getByRole('button', {name: '사진 바꾸기'})).toBeEnabled();
  // 사진 바꾸기 sits on the portrait; the StashDB choice sits with the library line under the profile.
  expect(screen.getByRole('button', {name: '사진 바꾸기'}).closest('.tablet-performer__portrait')).not.toBeNull();
  expect(screen.getByRole('button', {name: 'StashDB 프로필 선택'}).closest('.tablet-performer__footer')?.querySelector('.av-performer-library-stats')).not.toBeNull();
});
it('shows the chosen preview immediately and keeps it while receipt and confirmed media arrive', async () => {
  render(<Harness/>); const entry = await screen.findByRole('button', {name: '사진 바꾸기'}); await waitFor(() => expect(entry).toBeEnabled()); fireEvent.click(entry);
  const pick = await screen.findByRole('button', {name: '사진 1 선택'}); await waitFor(() => expect(pick).toBeEnabled()); fireEvent.click(pick);
  await waitFor(() => expect(readCommands()).toHaveLength(1));
  const portraitSrc = () => document.querySelector('.tablet-performer__portrait img')?.getAttribute('src');
  expect(portraitSrc()).toBe('data:image/jpeg;base64,YQ==');
  await waitFor(() => expect(finishCommand).toBeTypeOf('function'));
  person = {...person, entityRevision: 5, portraitImage: {...manifest.original, width: 600, height: 800}, portraitSelection: {kind: 'image', ...manifest}};
  await act(async () => finishCommand({changed: true, person}));
  await waitFor(() => expect(finishTicket).toBeTypeOf('function'));
  expect(portraitSrc()).toBe('data:image/jpeg;base64,YQ==');
  await act(async () => finishTicket({url: 'data:image/jpeg;base64,bmV3'}));
  await waitFor(() => expect(portraitSrc()).toBe('data:image/jpeg;base64,bmV3'));
  expect(portraitSrc()).not.toBe('data:image/jpeg;base64,b2xk');
});
it('honors page privacy even when the shared privacy preference is off', async () => {
  render(<Harness privacy/>); const entry = await screen.findByRole('button', {name: '사진 바꾸기'}); await waitFor(() => expect(entry).toBeEnabled());
  expect(document.querySelector('.tablet-performer__portrait img')).toBeNull(); expect(mocks.native).not.toHaveBeenCalled();
  fireEvent.click(entry); await screen.findByText('프라이버시 모드에서는 사진을 표시하지 않습니다.');
  expect(mocks.native).not.toHaveBeenCalled();
});
