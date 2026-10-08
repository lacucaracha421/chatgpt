import {beforeEach, describe, expect, it, vi} from 'vitest';
import {setOutboxConnection} from './outboxConnection';
const mocks = vi.hoisted(() => ({api: vi.fn()}));
vi.mock('./transport', async () => ({...await vi.importActual<typeof import('./transport')>('./transport'), api: mocks.api}));
import {ApiError} from './transport';
import {AUTHORITY_STATUS_PATH, COMMAND_PATH, clearPersonNotice, confirmedPerson, enqueueCommand, flushCommands, optimisticPerson, personCommand, personNotice,
  readCommands, rebasePersonCommand, reconcilePerson, replaceCommand, retryCommandNow, type AuthorityIdentity, type PersonCommand, type WorkCommand} from './collectionCommandOutbox';
import {AV_INPUT_ERROR, normalizePersonMemo, validatePersonFields} from './avEditModel';

const identity: AuthorityIdentity = {libraryId: 'e'.repeat(32), epoch: 7, contractVersion: 1};
const connection = 'https://a.example';
const KEY = `lakomics.collections.commands.outbox.v1.${encodeURIComponent(connection)}`;
const confirmed = {memo: '처음 메모', favorite: false};
function server(command: (body: PersonCommand) => unknown = () => ({})) {
  mocks.api.mockImplementation(async (path: string, _signal: unknown, body: PersonCommand) => {
    if (path === AUTHORITY_STATUS_PATH) return {...identity, active: true};
    const reply = command(body); if (reply instanceof Error) throw reply; return {...body, ...reply as object};
  });
}
const sent = () => mocks.api.mock.calls.filter(([path]) => path === COMMAND_PATH).map(([, , body]) => body as PersonCommand);
beforeEach(() => { localStorage.clear(); setOutboxConnection(connection); mocks.api.mockReset(); vi.restoreAllMocks(); clearPersonNotice('p1'); });

describe('setPerson composition', () => {
  it('trims the memo, sends a blank memo as null and queues nothing for an unchanged save', () => {
    expect(personCommand('p1', confirmed, [], {memo: '  새 메모  '})).toEqual({commandType: 'setPerson', personId: 'p1', changes: {memo: '새 메모'}, expected: {memo: '처음 메모'}});
    expect(personCommand('p1', confirmed, [], {memo: '   '})).toEqual({commandType: 'setPerson', personId: 'p1', changes: {memo: null}, expected: {memo: '처음 메모'}});
    expect(personCommand('p1', confirmed, [], {memo: ' 처음 메모\n'})).toBeNull();
    expect(personCommand('p1', confirmed, [], {favorite: false})).toBeNull();
    expect(personCommand('p1', {memo: null, favorite: true}, [], {memo: '', favorite: true})).toBeNull();
    expect(normalizePersonMemo('  ')).toBeNull();
  });
  it('expects the values after this person\'s earlier queued intents, in queue order', () => {
    const first = enqueueCommand(identity, personCommand('p1', confirmed, readCommands(), {favorite: true})!, '하야세 미오');
    enqueueCommand(identity, personCommand('p1', confirmed, readCommands(), {memo: '둘째'})!);
    // Another person's queue does not count.
    enqueueCommand(identity, personCommand('p2', confirmed, readCommands(), {memo: '다른 사람'})!);
    expect(personCommand('p1', confirmed, readCommands(), {favorite: false, memo: '셋째'})).toEqual({commandType: 'setPerson', personId: 'p1',
      changes: {memo: '셋째', favorite: false}, expected: {memo: '둘째', favorite: true}});
    expect(personCommand('p1', confirmed, readCommands(), {memo: '둘째', favorite: true})).toBeNull();
    expect(first).toMatchObject({label: '하야세 미오', command: {...identity, commandType: 'setPerson', personId: 'p1'}});
    expect(optimisticPerson(confirmed, 'p1', readCommands())).toEqual({memo: '둘째', favorite: true});
  });
  it('validates the fields and the matching change/expected keys before storing anything', () => {
    expect(() => validatePersonFields({memo: 'あ'.repeat(2001)})).toThrow(AV_INPUT_ERROR);
    expect(() => validatePersonFields({memo: 'あ'.repeat(2000)})).not.toThrow();
    expect(() => validatePersonFields({})).toThrow(AV_INPUT_ERROR);
    expect(() => validatePersonFields({favorite: 'yes' as never})).toThrow(AV_INPUT_ERROR);
    expect(() => enqueueCommand(identity, {commandType: 'setPerson', personId: 'p1', changes: {memo: 'x'}, expected: {favorite: false}})).toThrow(AV_INPUT_ERROR);
    expect(() => enqueueCommand(identity, {commandType: 'setPerson', personId: 'p1', changes: {memo: ' x '}, expected: {memo: null}})).toThrow(AV_INPUT_ERROR);
    expect(() => enqueueCommand(identity, {commandType: 'setPerson', personId: '../p', changes: {favorite: true}, expected: {favorite: false}})).toThrow(AV_INPUT_ERROR);
    expect(readCommands()).toEqual([]);
  });
});

describe('setPerson in the command outbox', () => {
  const favorite: PersonCommand = {commandType: 'setPerson', personId: 'p1', changes: {favorite: true}, expected: {favorite: false}};
  it('reads person rows next to existing work rows and skips malformed ones', () => {
    const work: WorkCommand = {commandType: 'setReleaseSubscription', workId: 'w1', enabled: true, expectedEnabled: false, expectedRevision: null};
    const base = {createdAt: 1, attempts: 0, nextAttemptAt: 0, state: 'pending'};
    localStorage.setItem(KEY, JSON.stringify([
      {...base, command: {...identity, ...work, operationId: 'a'}},
      {...base, label: '미오', command: {...identity, ...favorite, operationId: 'b'}},
      {...base, command: {...identity, commandType: 'setPerson', operationId: 'c'}},
      {...base, command: {...identity, commandType: 'updateWork', operationId: 'd'}},
    ]));
    expect(readCommands().map(row => row.command.operationId)).toEqual(['a', 'b']);
    expect(readCommands()[1]).toMatchObject({label: '미오', command: {personId: 'p1'}});
  });
  it('sends the authority envelope, accepts a checked receipt (changed or no-op) and retires it after a read', async () => {
    const row = enqueueCommand(identity, favorite, '미오'); server(); await flushCommands();
    expect(sent()[0]).toEqual({...identity, ...favorite, operationId: row.command.operationId});
    const accepted = readCommands();
    expect(accepted[0]).toMatchObject({state: 'accepted', receipts: [{commandType: 'setPerson', operationId: row.command.operationId}]});
    // A read that predates the acknowledgement still shows the change; a newer read retires it.
    expect(confirmedPerson(confirmed, 'p1', accepted)).toEqual({...confirmed, favorite: true});
    expect(confirmedPerson({...confirmed, favorite: false, memo: '다른 기기'}, 'p1', accepted).favorite).toBe(true);
    reconcilePerson(identity, 'p1', confirmed, (accepted[0].acceptedAt ?? 0) - 1); expect(readCommands()).toHaveLength(1);
    reconcilePerson(identity, 'p1', {...confirmed, favorite: true}); expect(readCommands()).toEqual([]);
    enqueueCommand(identity, favorite); await flushCommands();
    reconcilePerson(identity, 'p1', confirmed, Date.now() + 1); expect(readCommands()).toEqual([]);
  });
  it('blocks later edits of the same person behind a refused one, but not other people or works', async () => {
    enqueueCommand(identity, favorite);
    enqueueCommand(identity, {commandType: 'setPerson', personId: 'p1', changes: {memo: '나중'}, expected: {memo: '처음 메모'}});
    enqueueCommand(identity, {...favorite, personId: 'p2'});
    server(body => body.personId === 'p1' && body.changes.favorite
      ? new ApiError('충돌', 409, {detail: {code: 'revisionConflict', current: {person: {personId: 'p1', memo: '  다른 기기 메모 ', favorite: false, entityRevision: 4}}}}) : {});
    await flushCommands();
    expect(readCommands().map(row => row.state)).toEqual(['conflict', 'pending', 'accepted']);
    expect(sent().map(body => body.personId)).toEqual(['p1', 'p2']);
    const conflict = readCommands()[0];
    expect(conflict.conflict).toMatchObject({code: 'revisionConflict', current: {person: {favorite: false}}});
    // 덮어쓰기: the same wish over the server's current values, under a fresh operation ID.
    const rebased = rebasePersonCommand(conflict)!;
    expect(rebased).toEqual({...favorite, expected: {favorite: false}});
    expect(rebasePersonCommand({...conflict, conflict: {code: 'revisionConflict', current: {person: {memo: ' 서버 ', favorite: true}}},
      command: {...conflict.command, changes: {memo: 'x', favorite: false}, expected: {memo: null, favorite: true}} as typeof conflict.command}))
      .toMatchObject({expected: {memo: '서버', favorite: true}});
    const replaced = replaceCommand(conflict.command.operationId, rebased)!;
    expect(replaced.command.operationId).not.toBe(conflict.command.operationId);
    server(); await flushCommands();
    expect(readCommands().map(row => row.state)).toEqual(['accepted', 'accepted', 'accepted']);
  });
  it('drops every queued edit of a person the server does not have, with a note', async () => {
    enqueueCommand(identity, favorite, '하야세 미오');
    enqueueCommand(identity, {commandType: 'setPerson', personId: 'p1', changes: {memo: '나중'}, expected: {memo: null}}, '하야세 미오');
    enqueueCommand(identity, {...favorite, personId: 'p2'});
    server(body => body.personId === 'p1' ? new ApiError('없음', 404, {detail: {code: 'personNotFound', personId: 'p1'}}) : {});
    const events = vi.fn(); window.addEventListener('lakomics-collection-commands', events);
    await flushCommands();
    window.removeEventListener('lakomics-collection-commands', events);
    expect(readCommands().map(row => [row.command.commandType === 'setPerson' && row.command.personId, row.state])).toEqual([['p2', 'accepted']]);
    expect(personNotice('p1')).toBe('서버에 하야세 미오 배우 정보가 없어 변경을 보내지 못했습니다.');
    expect(events).toHaveBeenCalled();
    clearPersonNotice('p1'); expect(personNotice('p1')).toBeUndefined();
  });
  it('keeps a person edit with its operation ID across a network failure and sends it again', async () => {
    const row = enqueueCommand(identity, favorite);
    server(() => new ApiError('연결 실패', null, null)); await flushCommands();
    expect(readCommands()[0]).toMatchObject({state: 'pending', attempts: 1, lastError: expect.any(String)});
    retryCommandNow(row.command.operationId); server(); await flushCommands();
    expect(readCommands()[0]).toMatchObject({state: 'accepted'});
    expect(new Set(sent().map(body => (body as unknown as {operationId: string}).operationId))).toEqual(new Set([row.command.operationId]));
  });
});
