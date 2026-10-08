import {beforeEach, expect, it, vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const mocks = vi.hoisted(() => ({api: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), api: mocks.api}));
import {ApiError} from './transport';
import {AUTHORITY_STATUS_PATH, clearPersonNotice, confirmedPersonEntity, enqueueCommand, flushCommands, personNotice, personRevision, readCommands, rebasePersonCommand, reconcilePersonRevision, replaceCommand, type PersonRevisionCommand} from './collectionCommandOutbox';
const identity = {libraryId: 'e'.repeat(32), epoch: 1, contractVersion: 1 as const};
const profile: PersonRevisionCommand = {commandType: 'setPersonProfile', personId: 'p1', stashdbId: 's1', expectedRevision: 4};
const portrait: PersonRevisionCommand = {commandType: 'setPersonPortrait', personId: 'p1', portrait: null, expectedRevision: 4};
beforeEach(() => {
  localStorage.clear(); setOutboxConnection('https://test.example'); clearPersonNotice('p1'); mocks.api.mockReset();
  mocks.api.mockImplementation(async (path, _signal, body) => path === AUTHORITY_STATUS_PATH ? {...identity, active: true} : {...body, changed: true, person: {personId: 'p1', entityRevision: 5, stashdbId: 's1'}});
});
it('persists both new person commands and blocks revision composition until earlier intents are accepted', async () => {
  enqueueCommand(identity, profile); enqueueCommand(identity, portrait);
  expect(readCommands().map(row => row.command.commandType)).toEqual(['setPersonProfile', 'setPersonPortrait']);
  expect(personRevision('p1', 4, readCommands())).toBeNull();
  expect(personRevision('p2', 7, readCommands())).toBe(7);
  expect(personRevision('p1', undefined, [])).toBeNull();
  await flushCommands();
  expect(personRevision('p1', 4, readCommands())).toBe(5);
  expect(personRevision('p1', 8, readCommands())).toBe(8);
});
it('uses actual receipt revisions for memo changes and profile no-ops, never a guessed +1', async () => {
  enqueueCommand(identity, {commandType: 'setPerson', personId: 'p1', changes: {memo: 'new'}, expected: {memo: null}});
  expect(personRevision('p1', 4, readCommands())).toBeNull();
  await flushCommands(); expect(personRevision('p1', 4, readCommands())).toBe(5);
  mocks.api.mockImplementation(async (path, _signal, body) => path === AUTHORITY_STATUS_PATH ? {...identity, active: true} : {...body, changed: false, person: {personId: 'p1', entityRevision: 5}});
  enqueueCommand(identity, {...profile, expectedRevision: 5}); await flushCommands();
  expect(personRevision('p1', 4, readCommands())).toBe(5);
});
it.each([profile, portrait])('rebases $commandType using the current person revision and a fresh operation', async command => {
  mocks.api.mockImplementation(async (path) => { if (path === AUTHORITY_STATUS_PATH) return {...identity, active: true}; throw new ApiError('conflict', 409, {detail: {code: 'revisionConflict', current: {person: {entityRevision: 9}}}}); });
  const first = enqueueCommand(identity, command); await flushCommands();
  const row = readCommands()[0]; expect(row.state).toBe('conflict');
  const rebased = rebasePersonCommand(row); expect(rebased).toEqual({...command, expectedRevision: 9});
  const replacement = replaceCommand(first.command.operationId, rebased)!;
  expect(replacement.command.operationId).not.toBe(first.command.operationId);
  expect(rebasePersonCommand({...row, conflict: {code: 'artworkBlobUnconfirmed', current: {person: {entityRevision: 9}}}})).toBeNull();
});
it.each([profile, portrait])('drops all person intents on personNotFound for $commandType', async command => {
  mocks.api.mockImplementation(async path => { if (path === AUTHORITY_STATUS_PATH) return {...identity, active: true}; throw new ApiError('missing', 404, {detail: {code: 'personNotFound'}}); });
  enqueueCommand(identity, command, '미오'); enqueueCommand(identity, portrait);
  await flushCommands(); expect(readCommands()).toEqual([]); expect(personNotice('p1')).toContain('미오');
});
it('keeps later person wishes behind a rejected profile and exposes an old-server rejection', async () => {
  mocks.api.mockImplementation(async path => { if (path === AUTHORITY_STATUS_PATH) return {...identity, active: true}; throw new ApiError('old', 404, null); });
  enqueueCommand(identity, profile); enqueueCommand(identity, portrait); await flushCommands();
  expect(readCommands().map(row => row.state)).toEqual(['conflict', 'pending']);
});
it('receives full profile text only on acceptance and retires revision intents after a sufficiently new read', async () => {
  const person = {id: 'p1', memo: null, favorite: false, profile: null, portrait: null, entityRevision: 4};
  enqueueCommand(identity, profile); expect(confirmedPersonEntity(person, 'p1', readCommands())).toEqual(person);
  await flushCommands(); expect(confirmedPersonEntity(person, 'p1', readCommands())).toMatchObject({stashdbId: 's1', entityRevision: 5});
  reconcilePersonRevision(identity, 'p1', 4, Date.now() + 1); expect(readCommands()).toHaveLength(1);
  reconcilePersonRevision(identity, 'p1', 5, Date.now() + 1); expect(readCommands()).toEqual([]);
});
it('rejects invalid person revision, profile identity and unconfirmed-looking portrait manifests', () => {
  expect(() => enqueueCommand(identity, {...profile, expectedRevision: 0})).toThrow();
  expect(() => enqueueCommand(identity, {...profile, stashdbId: '../remote'})).toThrow();
  expect(() => enqueueCommand(identity, {...portrait, portrait: {kind: 'image'} as never})).toThrow();
});
it('ignores malformed persisted profile/portrait rows while retaining valid person and work rows', () => {
  enqueueCommand(identity, profile); enqueueCommand(identity, portrait);
  const key = 'lakomics.collections.commands.outbox.v1.' + encodeURIComponent('https://test.example');
  const rows = readCommands();
  localStorage.setItem(key, JSON.stringify([...rows, {...rows[0], command: {...rows[0].command, stashdbId: undefined}}, {...rows[1], command: {...rows[1].command, expectedRevision: 0}}]));
  expect(readCommands()).toHaveLength(2);
});
